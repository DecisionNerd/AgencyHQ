/**
 * Phase runner for the AgencyHQ bootstrap.
 *
 * Extracted from cli.ts so the phase machine can be driven with fake deps in
 * unit tests without touching process.argv, process.env, or real external services.
 */

import type { SmtpSinkResult } from "./smtp-sink.ts";
import type { BootstrapState, PhaseState, StateManager } from "./state.ts";
import type { MagicLinkResult } from "./trigger-web.ts";
import type { DeploymentInfo } from "./verify.ts";

// Re-export the type so tests can import it from here.
export type { DeploymentInfo };

/** Internal cookie jar type (same as trigger-web.ts internal CookieJar). */
export type CookieJar = Map<string, string>;

/** Org + project identifiers returned by findOrCreateOrgProject. */
export type OrgProjectResult = {
  orgSlug: string;
  projectSlug: string;
  projectRef: string;
};

/** Minimal deploy record returned by runDeploy. */
export type DeployRecord = {
  externalId: string;
  webappIpUrl: string;
  platform: string;
  at: string;
  skipped?: boolean;
  version?: string;
  imageRef?: string;
};

/** Full options passed to the real runDeploy. */
export type DeployOptions = {
  workspaceRoot: string;
  stateDir: string;
  accessToken: string;
  webappIpUrl: string;
  projectRef: string;
  platform: string;
};

/**
 * All injectable dependencies for runAll.
 * Production code passes real implementations; tests inject fakes.
 */
export type RunDeps = {
  /** StateManager instance (holds stateDir and secretsDir). */
  sm: StateManager;

  // ── Configuration ──────────────────────────────────────────────────────────
  webappUrl: string;
  bootstrapEmail: string;
  orgName: string;
  projectName: string;
  tokenName: string;
  workspaceRoot: string;
  platform: string;
  smtpPort: number;
  magicLinkTimeoutMs: number;
  magicLinkThrottleMs: number;
  sessionFile: string;
  /** Secret file name for the Trigger prod key (e.g. "trigger-prod.key"). */
  secretProdKey: string;
  /** Secret file name for the PAT (e.g. "trigger-pat.key"). */
  secretPAT: string;
  /**
   * State directory path (same as AGENCYHQ_STATE_DIR).
   * Needed by deploymentIsCurrent and enrichDeployment.
   */
  stateDir: string;

  // ── Injectable functions ────────────────────────────────────────────────────
  waitForReadiness: (url: string, timeoutMs: number) => Promise<void>;
  startSmtpSink: (opts: {
    port: number;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<SmtpSinkResult>;
  requestMagicLink: (url: string, email: string, jar: CookieJar) => Promise<MagicLinkResult>;
  followMagicLink: (link: string, url: string, jar: CookieJar) => Promise<string>;
  confirmBasicDetailsIfNeeded: (
    url: string,
    email: string,
    jar: CookieJar,
    landingPath: string,
  ) => Promise<string>;
  hasValidSession: (url: string, jar: CookieJar) => Promise<boolean>;
  loadSession: (path: string) => CookieJar;
  saveSession: (jar: CookieJar, path: string) => void;
  deleteSession: (path: string) => void;
  findOrCreateOrgProject: (
    url: string,
    org: string,
    project: string,
    jar: CookieJar,
  ) => Promise<OrgProjectResult>;
  readProdSecretKey: (url: string, org: string, project: string, jar: CookieJar) => Promise<string>;
  mintPAT: (url: string, name: string, jar: CookieJar) => Promise<string>;
  resolveWebappIp: (url: string) => Promise<string>;
  runDeploy: (opts: DeployOptions) => Promise<DeployRecord>;
  verifyDeployment: (url: string, key: string) => Promise<DeploymentInfo>;
  deploymentIsCurrent: (workspaceRoot: string, stateDir: string) => boolean;
  enrichDeployment: (
    stateDir: string,
    fields: { version?: string; imageRef?: string; externalId?: string },
  ) => void;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
};

// ── Internal helper ──────────────────────────────────────────────────────────

async function enforceMagicLinkThrottle(
  state: BootstrapState,
  sm: StateManager,
  deps: Pick<RunDeps, "magicLinkThrottleMs" | "sleep" | "log">,
): Promise<void> {
  const lastReqAt = state.lastMagicLinkRequestAt
    ? new Date(state.lastMagicLinkRequestAt).getTime()
    : 0;
  const sinceLastReq = Date.now() - lastReqAt;
  if (sinceLastReq < deps.magicLinkThrottleMs) {
    const waitMs = deps.magicLinkThrottleMs - sinceLastReq;
    deps.log(`throttle: waiting ${Math.ceil(waitMs / 1000)}s before requesting a new magic link`);
    await deps.sleep(waitMs);
  }
  state.lastMagicLinkRequestAt = new Date().toISOString();
  sm.save(state);
}

// ── Phase runner ─────────────────────────────────────────────────────────────

/**
 * Run all bootstrap phases in order, resuming from the last completed phase.
 * Throws on any phase failure; the caller is responsible for backoff/exit.
 */
export async function runAll(deps: RunDeps): Promise<void> {
  const { sm } = deps;
  const state = sm.load();

  // ── Phase: wait_services ──────────────────────────────────────────────────
  if (!sm.isDone(state, "wait_services")) {
    sm.setRunning(state, "wait_services");
    deps.log("phase: wait_services — waiting for webapp");
    try {
      await deps.waitForReadiness(deps.webappUrl, 300_000);
      sm.setDone(state, "wait_services");
    } catch (err) {
      sm.setFailed(state, "wait_services", "services_unavailable", String(err));
      throw err;
    }
  } else {
    deps.log("phase: wait_services — already done");
  }

  // ── Phase: login ──────────────────────────────────────────────────────────
  const jar = deps.loadSession(deps.sessionFile);

  if (!sm.isDone(state, "login")) {
    sm.setRunning(state, "login");
    deps.log("phase: login — starting SMTP sink and requesting magic link");
    try {
      await enforceMagicLinkThrottle(state, sm, deps);
      const abort = new AbortController();
      const sinkPromise = deps.startSmtpSink({
        port: deps.smtpPort,
        timeoutMs: deps.magicLinkTimeoutMs,
        signal: abort.signal,
      });
      await deps.sleep(200);
      const mlResult = await deps.requestMagicLink(deps.webappUrl, deps.bootstrapEmail, jar);
      if (mlResult.kind === "rate_limited") {
        sinkPromise.catch(() => {});
        abort.abort();
        if (mlResult.resetAt !== null) {
          state.magicLinkRateLimitedUntil = new Date(mlResult.resetAt).toISOString();
          sm.save(state);
        }
        throw Object.assign(new Error("magic link rate limited by webapp"), {
          errorCategory: "login_rate_limited",
        });
      }
      const sinkResult = await sinkPromise;
      sinkResult.stop();
      deps.log("magic link captured from SMTP sink");
      const landingPath = await deps.followMagicLink(sinkResult.magicLink, deps.webappUrl, jar);
      await deps.confirmBasicDetailsIfNeeded(deps.webappUrl, deps.bootstrapEmail, jar, landingPath);
      deps.saveSession(jar, deps.sessionFile);
      sm.setDone(state, "login");
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "login_failed";
      sm.setFailed(state, "login", category, String(err));
      throw err;
    }
  } else {
    deps.log("phase: login — already done; checking session validity");
    const sessionValid = await deps.hasValidSession(deps.webappUrl, jar).catch(() => false);
    if (!sessionValid) {
      deps.log("session invalid — deleting stale file and obtaining fresh magic link");
      deps.deleteSession(deps.sessionFile);
      try {
        await enforceMagicLinkThrottle(state, sm, deps);
        const abort = new AbortController();
        const sinkPromise = deps.startSmtpSink({
          port: deps.smtpPort,
          timeoutMs: deps.magicLinkTimeoutMs,
          signal: abort.signal,
        });
        await deps.sleep(200);
        const mlResult = await deps.requestMagicLink(deps.webappUrl, deps.bootstrapEmail, jar);
        if (mlResult.kind === "rate_limited") {
          sinkPromise.catch(() => {});
          abort.abort();
          if (mlResult.resetAt !== null) {
            state.magicLinkRateLimitedUntil = new Date(mlResult.resetAt).toISOString();
            sm.save(state);
          }
          throw Object.assign(new Error("magic link rate limited by webapp"), {
            errorCategory: "login_rate_limited",
          });
        }
        const sinkResult = await sinkPromise;
        sinkResult.stop();
        const landingPath = await deps.followMagicLink(sinkResult.magicLink, deps.webappUrl, jar);
        await deps.confirmBasicDetailsIfNeeded(
          deps.webappUrl,
          deps.bootstrapEmail,
          jar,
          landingPath,
        );
        deps.saveSession(jar, deps.sessionFile);
      } catch (err) {
        const category = (err as { errorCategory?: string }).errorCategory;
        if (category === "login_rate_limited") {
          sm.setFailed(state, "login", "login_rate_limited", String(err));
          throw err;
        }
        const timeoutSec = Math.round(deps.magicLinkTimeoutMs / 1000);
        const msg =
          `Trigger webapp login could not be re-established (magic link not received within ` +
          `${timeoutSec}s); rerun \`docker compose up -d bootstrap\` after 60 s or run ` +
          `\`docker compose run --rm bootstrap dashboard-link\``;
        sm.setFailed(state, "login", "login_required", msg);
        throw Object.assign(new Error(msg), { errorCategory: "login_required" });
      }
    } else {
      deps.log("session valid — continuing without re-login");
    }
  }

  // ── Phase: org_project ────────────────────────────────────────────────────
  if (!sm.isDone(state, "org_project")) {
    sm.setRunning(state, "org_project");
    deps.log("phase: org_project");
    try {
      const { orgSlug, projectSlug, projectRef } = await deps.findOrCreateOrgProject(
        deps.webappUrl,
        deps.orgName,
        deps.projectName,
        jar,
      );
      sm.setDone(state, "org_project", { orgSlug, projectSlug, projectRef });
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "org_create_failed";
      sm.setFailed(state, "org_project", category, String(err));
      throw err;
    }
  } else {
    deps.log("phase: org_project — already done");
  }

  const orgSlug = state.phases.org_project?.orgSlug;
  const projectSlug = state.phases.org_project?.projectSlug;
  const projectRef = state.phases.org_project?.projectRef;

  if (!orgSlug || !projectSlug || !projectRef) {
    throw new Error("org_project phase metadata missing from state");
  }

  // ── Phase: credentials ────────────────────────────────────────────────────
  if (!sm.isDone(state, "credentials")) {
    sm.setRunning(state, "credentials");
    deps.log("phase: credentials");
    try {
      if (!sm.hasSecret(deps.secretProdKey)) {
        const key = await deps.readProdSecretKey(deps.webappUrl, orgSlug, projectSlug, jar);
        sm.writeSecret(deps.secretProdKey, key);
        deps.log("prod secret key stored");
      } else {
        deps.log("prod secret key already stored");
      }

      if (!sm.hasSecret(deps.secretPAT)) {
        const pat = await deps.mintPAT(deps.webappUrl, deps.tokenName, jar);
        sm.writeSecret(deps.secretPAT, pat);
        deps.log("PAT stored");
      } else {
        deps.log("PAT already stored — reusing (no new mint)");
      }

      sm.setDone(state, "credentials");
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "secret_key_missing";
      sm.setFailed(state, "credentials", category, String(err));
      throw err;
    }
  } else {
    deps.log("phase: credentials — already done");
  }

  // ── Phase: deploy ─────────────────────────────────────────────────────────
  if (sm.isDone(state, "deploy") && !deps.deploymentIsCurrent(deps.workspaceRoot, deps.stateDir)) {
    deps.log("phase: deploy — toolchain changed since the last deployment; redeploying");
    sm.reopen(state, ["deploy", "verify_deployment", "done"]);
  }
  if (!sm.isDone(state, "deploy")) {
    sm.setRunning(state, "deploy");
    deps.log("phase: deploy");
    try {
      const accessToken = sm.readSecret(deps.secretPAT);
      if (!accessToken) throw new Error("PAT not found in secrets");
      const webappIpUrl = await deps.resolveWebappIp(deps.webappUrl);
      const record = await deps.runDeploy({
        workspaceRoot: deps.workspaceRoot,
        stateDir: deps.stateDir,
        accessToken,
        webappIpUrl,
        projectRef,
        platform: deps.platform,
      });
      sm.setDone(state, "deploy", record.skipped ? { deploymentVersion: "skipped" } : {});
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "deploy_failed";
      sm.setFailed(state, "deploy", category, String(err));
      throw err;
    }
  } else {
    deps.log("phase: deploy — already done");
  }

  // ── Phase: verify_deployment ──────────────────────────────────────────────
  if (!sm.isDone(state, "verify_deployment")) {
    sm.setRunning(state, "verify_deployment");
    deps.log("phase: verify_deployment");
    try {
      const prodKey = sm.readSecret(deps.secretProdKey);
      if (!prodKey) throw new Error("prod secret key not found in secrets");
      const info = await deps.verifyDeployment(deps.webappUrl, prodKey);
      const doneMeta: Record<string, string> = {};
      if (info.version !== undefined) doneMeta.deploymentVersion = info.version;
      sm.setDone(state, "verify_deployment", doneMeta as Partial<PhaseState>);
      if (info.version !== undefined || info.imageRef !== undefined) {
        const enrichFields: { version?: string; imageRef?: string; externalId?: string } = {};
        if (info.version !== undefined) enrichFields.version = info.version;
        if (info.imageRef !== undefined) enrichFields.imageRef = info.imageRef;
        if (info.externalId !== undefined) enrichFields.externalId = info.externalId;
        deps.enrichDeployment(deps.stateDir, enrichFields);
      }
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "verify_failed";
      sm.setFailed(state, "verify_deployment", category, String(err));
      throw err;
    }
  } else {
    deps.log("phase: verify_deployment — already done");
  }

  // ── Phase: done ───────────────────────────────────────────────────────────
  if (!sm.isDone(state, "done")) {
    sm.setDone(state, "done");
    deps.log("bootstrap complete");
  } else {
    deps.log("bootstrap already complete");
  }
}
