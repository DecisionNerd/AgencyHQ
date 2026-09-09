/**
 * Bootstrap CLI entry point.
 *
 * Commands:
 *   bootstrap run              Run all phases (resumes from last completed phase).
 *   bootstrap status           Print bootstrap.json without secrets.
 *   bootstrap dashboard-link   Start SMTP sink, request a fresh magic link, print it to stdout.
 *
 * Environment variables read (never .env files):
 *   AGENCYHQ_STATE_DIR     Where to store bootstrap.json and deployment.json.
 *   AGENCYHQ_SECRETS_DIR   Where to store 0600 secret files.
 *   TRIGGER_WEBAPP_URL     Internal webapp URL (e.g. http://webapp:3000).
 *   BOOTSTRAP_EMAIL        Email address used for the magic link.
 *   AGENCYHQ_PLATFORM      Target platform (e.g. linux/arm64).
 */

import { join } from "node:path";
import { deploymentIsCurrent, enrichDeployment, runDeploy } from "./deploy.ts";
import { startSmtpSink } from "./smtp-sink.ts";
import type { BootstrapState } from "./state.ts";
import { StateManager } from "./state.ts";
import {
  confirmBasicDetailsIfNeeded,
  deleteSession,
  findOrCreateOrgProject,
  followMagicLink,
  hasValidSession,
  loadSession,
  mintPAT,
  readProdSecretKey,
  redact,
  requestMagicLink,
  resolveWebappIp,
  saveSession,
  waitForReadiness,
} from "./trigger-web.ts";
import { verifyDeployment } from "./verify.ts";

// ── Transient failure categories that trigger backoff before exit ─────────────

const TRANSIENT_CATEGORIES = new Set([
  "login_rate_limited",
  "magic_link_timeout",
  "smtp_aborted",
  "services_unavailable",
  "deploy_failed",
  "deploy_in_progress",
]);

/**
 * Compute the backoff sleep duration (ms) before exiting non-zero.
 *
 * If the rate-limit reset time is known (magicLinkRateLimitedUntil), sleep
 * until that time, capped at 15 minutes.
 *
 * Otherwise use exponential backoff: min(2^attempt × 15 s, 5 min),
 * where attempt is the persistent counter from bootstrap.json.
 */
function computeBackoffMs(state: BootstrapState, category: string): number {
  if (category === "login_rate_limited" && state.magicLinkRateLimitedUntil) {
    const resetMs = new Date(state.magicLinkRateLimitedUntil).getTime();
    const waitMs = resetMs - Date.now();
    const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000; // 15 minutes
    return Math.min(Math.max(waitMs, 0), MAX_RATE_LIMIT_WAIT_MS);
  }
  const attempt = state.attempt ?? 0;
  const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes
  return Math.min(2 ** attempt * 15_000, MAX_BACKOFF_MS);
}

// ── Config ───────────────────────────────────────────────────────────────────

const STATE_DIR = process.env["AGENCYHQ_STATE_DIR"] ?? "/var/agencyhq/state";
// Bootstrap-minted secret files (trigger-prod.key, trigger-pat.key) are written
// into the state directory — the same agencyhq-state volume the coordinator reads.
const SECRETS_DIR = process.env["AGENCYHQ_SECRETS_DIR"] ?? STATE_DIR;
const WEBAPP_URL = process.env["TRIGGER_WEBAPP_URL"] ?? "http://webapp:3000";
const BOOTSTRAP_EMAIL = process.env["BOOTSTRAP_EMAIL"] ?? "bootstrap@agencyhq.local";
const ORG_NAME = process.env["AGENCYHQ_ORG_NAME"] ?? "agencyhq";
const PROJECT_NAME = process.env["AGENCYHQ_PROJECT_NAME"] ?? "agencyhq";
const TOKEN_NAME = process.env["AGENCYHQ_TOKEN_NAME"] ?? "agencyhq-bootstrap";
const WORKSPACE_ROOT = process.env["AGENCYHQ_WORKSPACE_ROOT"] ?? "/app";
const PLATFORM = process.env["AGENCYHQ_PLATFORM"] ?? "linux/arm64";
const SMTP_PORT = Number(process.env["BOOTSTRAP_SMTP_PORT"] ?? "2525");

/**
 * How long to wait for the magic-link email to arrive in the SMTP sink (ms).
 * Configurable because the webapp throttles repeated magic links to the same
 * address; operators can increase this if the email consistently arrives late.
 */
const BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS = Number(
  process.env["BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS"] ?? "90000",
);

/** Minimum interval between magic-link requests to the same address (ms). */
const MAGIC_LINK_THROTTLE_MS = 60_000;

/**
 * Persisted session cookie file (0600).
 * Loaded on every run; deleted when the session is detected as invalid.
 * Stored in the state directory so it survives container restarts on the
 * same volume, but never included in bootstrap.json (which is non-secret).
 */
const SESSION_FILE = join(STATE_DIR, "webapp-session.json");

// File names for secrets written to the state volume (0600 files).
// Must match what the coordinator reads: apps/coordinator/src/config.ts readTriggerKeyFromState.
const SECRET_PROD_KEY = "trigger-prod.key";
const SECRET_PAT = "trigger-pat.key";

function log(msg: string): void {
  console.log(`[bootstrap] ${redact(msg)}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wait until at least MAGIC_LINK_THROTTLE_MS has elapsed since the last
 * magic-link request, then record the new request timestamp in the state.
 */
async function enforceMagicLinkThrottle(state: BootstrapState, sm: StateManager): Promise<void> {
  const lastReqAt = state.lastMagicLinkRequestAt
    ? new Date(state.lastMagicLinkRequestAt).getTime()
    : 0;
  const sinceLastReq = Date.now() - lastReqAt;
  if (sinceLastReq < MAGIC_LINK_THROTTLE_MS) {
    const waitMs = MAGIC_LINK_THROTTLE_MS - sinceLastReq;
    log(`throttle: waiting ${Math.ceil(waitMs / 1000)}s before requesting a new magic link`);
    await sleep(waitMs);
  }
  state.lastMagicLinkRequestAt = new Date().toISOString();
  sm.save(state);
}

// ── Phase runner ─────────────────────────────────────────────────────────────

async function runAll(sm: StateManager): Promise<void> {
  const state = sm.load();

  // ── Phase: wait_services ─────────────────────────────────────────────────
  if (!sm.isDone(state, "wait_services")) {
    sm.setRunning(state, "wait_services");
    log("phase: wait_services — waiting for webapp");
    try {
      await waitForReadiness(WEBAPP_URL, 300_000);
      sm.setDone(state, "wait_services");
    } catch (err) {
      sm.setFailed(state, "wait_services", "services_unavailable", String(err));
      throw err;
    }
  } else {
    log("phase: wait_services — already done");
  }

  // ── Phase: login ───────────────────────────────────────────────────────────
  // Load the persisted session cookie jar (empty if no file exists yet).
  const jar = loadSession(SESSION_FILE);

  if (!sm.isDone(state, "login")) {
    sm.setRunning(state, "login");
    log("phase: login — starting SMTP sink and requesting magic link");
    try {
      // Enforce throttle before sending the magic-link request.
      await enforceMagicLinkThrottle(state, sm);
      // Start SMTP sink early so it is listening before the webapp sends mail.
      // The AbortController lets us stop the sink immediately if the request fails.
      const abort = new AbortController();
      const sinkPromise = startSmtpSink({
        port: SMTP_PORT,
        timeoutMs: BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS,
        signal: abort.signal,
      });
      // Give the sink a moment to start before requesting the link.
      await sleep(200);
      const mlResult = await requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
      if (mlResult.kind === "rate_limited") {
        // Stop SMTP sink immediately — no email will arrive.
        abort.abort();
        if (mlResult.resetAt !== null) {
          state.magicLinkRateLimitedUntil = new Date(mlResult.resetAt).toISOString();
          sm.save(state);
        }
        throw Object.assign(new Error("magic link rate limited by webapp"), {
          errorCategory: "login_rate_limited",
        });
      }
      // mlResult.kind === "sent" — wait for the email to arrive in the SMTP sink.
      const sinkResult = await sinkPromise;
      sinkResult.stop();
      log("magic link captured from SMTP sink");
      const landingPath = await followMagicLink(sinkResult.magicLink, WEBAPP_URL, jar);
      await confirmBasicDetailsIfNeeded(WEBAPP_URL, BOOTSTRAP_EMAIL, jar, landingPath);
      // Persist the authenticated session so restarts do not need to re-login.
      saveSession(jar, SESSION_FILE);
      sm.setDone(state, "login");
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "login_failed";
      sm.setFailed(state, "login", category, String(err));
      throw err;
    }
  } else {
    log("phase: login — already done; checking session validity");
    // "done" means a valid session must exist now.
    // Verify by GET / — if we are redirected to /login the session is absent or expired.
    const sessionValid = await hasValidSession(WEBAPP_URL, jar).catch(() => false);
    if (!sessionValid) {
      log("session invalid — deleting stale file and obtaining fresh magic link");
      deleteSession(SESSION_FILE);
      // Fail hard if re-establishment fails — do not continue to later phases.
      try {
        await enforceMagicLinkThrottle(state, sm);
        const abort = new AbortController();
        const sinkPromise = startSmtpSink({
          port: SMTP_PORT,
          timeoutMs: BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS,
          signal: abort.signal,
        });
        await sleep(200);
        const mlResult = await requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
        if (mlResult.kind === "rate_limited") {
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
        const landingPath = await followMagicLink(sinkResult.magicLink, WEBAPP_URL, jar);
        await confirmBasicDetailsIfNeeded(WEBAPP_URL, BOOTSTRAP_EMAIL, jar, landingPath);
        saveSession(jar, SESSION_FILE);
      } catch (err) {
        const category = (err as { errorCategory?: string }).errorCategory;
        if (category === "login_rate_limited") {
          // Already recorded magicLinkRateLimitedUntil; propagate to trigger backoff.
          sm.setFailed(state, "login", "login_rate_limited", String(err));
          throw err;
        }
        const timeoutSec = Math.round(BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS / 1000);
        const msg =
          `Trigger webapp login could not be re-established (magic link not received within ` +
          `${timeoutSec}s); rerun \`docker compose up -d bootstrap\` after 60 s or run ` +
          `\`docker compose run --rm bootstrap dashboard-link\``;
        sm.setFailed(state, "login", "login_required", msg);
        throw Object.assign(new Error(msg), { errorCategory: "login_required" });
      }
    } else {
      log("session valid — continuing without re-login");
    }
  }

  // ── Phase: org_project ───────────────────────────────────────────────────
  if (!sm.isDone(state, "org_project")) {
    sm.setRunning(state, "org_project");
    log("phase: org_project");
    try {
      const { orgSlug, projectSlug, projectRef } = await findOrCreateOrgProject(
        WEBAPP_URL,
        ORG_NAME,
        PROJECT_NAME,
        jar,
      );
      sm.setDone(state, "org_project", { orgSlug, projectSlug, projectRef });
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "org_create_failed";
      sm.setFailed(state, "org_project", category, String(err));
      throw err;
    }
  } else {
    log("phase: org_project — already done");
  }

  const orgSlug = state.phases["org_project"]?.orgSlug;
  const projectSlug = state.phases["org_project"]?.projectSlug;
  const projectRef = state.phases["org_project"]?.projectRef;

  if (!orgSlug || !projectSlug || !projectRef) {
    throw new Error("org_project phase metadata missing from state");
  }

  // ── Phase: credentials ───────────────────────────────────────────────────
  if (!sm.isDone(state, "credentials")) {
    sm.setRunning(state, "credentials");
    log("phase: credentials");
    try {
      // Prod secret key
      if (!sm.hasSecret(SECRET_PROD_KEY)) {
        const key = await readProdSecretKey(WEBAPP_URL, orgSlug, projectSlug, jar);
        sm.writeSecret(SECRET_PROD_KEY, key);
        log("prod secret key stored");
      } else {
        log("prod secret key already stored");
      }

      // PAT — only mint if none is stored
      if (!sm.hasSecret(SECRET_PAT)) {
        const pat = await mintPAT(WEBAPP_URL, TOKEN_NAME, jar);
        sm.writeSecret(SECRET_PAT, pat);
        log("PAT stored");
      } else {
        log("PAT already stored — reusing (no new mint)");
      }

      sm.setDone(state, "credentials");
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "secret_key_missing";
      sm.setFailed(state, "credentials", category, String(err));
      throw err;
    }
  } else {
    log("phase: credentials — already done");
  }

  // ── Phase: deploy ────────────────────────────────────────────────────────
  // A completed deploy phase is only current while deployment.json carries the
  // external id of this toolchain; a changed trigger/ tree or lockfile reopens
  // deploy, verify_deployment and done.
  if (sm.isDone(state, "deploy") && !deploymentIsCurrent(WORKSPACE_ROOT, STATE_DIR)) {
    log("phase: deploy — toolchain changed since the last deployment; redeploying");
    sm.reopen(state, ["deploy", "verify_deployment", "done"]);
  }
  if (!sm.isDone(state, "deploy")) {
    sm.setRunning(state, "deploy");
    log("phase: deploy");
    try {
      const accessToken = sm.readSecret(SECRET_PAT);
      if (!accessToken) throw new Error("PAT not found in secrets");
      const webappIpUrl = await resolveWebappIp(WEBAPP_URL);
      const record = await runDeploy({
        workspaceRoot: WORKSPACE_ROOT,
        stateDir: STATE_DIR,
        accessToken,
        webappIpUrl,
        projectRef,
        platform: PLATFORM,
      });
      sm.setDone(state, "deploy", record.skipped ? { deploymentVersion: "skipped" } : {});
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "deploy_failed";
      sm.setFailed(state, "deploy", category, String(err));
      throw err;
    }
  } else {
    log("phase: deploy — already done");
  }

  // ── Phase: verify_deployment ─────────────────────────────────────────────
  if (!sm.isDone(state, "verify_deployment")) {
    sm.setRunning(state, "verify_deployment");
    log("phase: verify_deployment");
    try {
      const prodKey = sm.readSecret(SECRET_PROD_KEY);
      if (!prodKey) throw new Error("prod secret key not found in secrets");
      const info = await verifyDeployment(WEBAPP_URL, prodKey);
      const doneMeta: Record<string, string> = {};
      if (info.version !== undefined) doneMeta["deploymentVersion"] = info.version;
      sm.setDone(state, "verify_deployment", doneMeta as Partial<import("./state.ts").PhaseState>);
      // Enrich deployment.json with version and imageRef from the API response
      // so the coordinator readiness loader can surface them without re-reading the API.
      if (info.version !== undefined || info.imageRef !== undefined) {
        const enrichFields: { version?: string; imageRef?: string; externalId?: string } = {};
        if (info.version !== undefined) enrichFields.version = info.version;
        if (info.imageRef !== undefined) enrichFields.imageRef = info.imageRef;
        if (info.externalId !== undefined) enrichFields.externalId = info.externalId;
        enrichDeployment(STATE_DIR, enrichFields);
      }
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "verify_failed";
      sm.setFailed(state, "verify_deployment", category, String(err));
      throw err;
    }
  } else {
    log("phase: verify_deployment — already done");
  }

  // ── Phase: done ──────────────────────────────────────────────────────────
  if (!sm.isDone(state, "done")) {
    sm.setDone(state, "done");
    log("bootstrap complete");
  } else {
    log("bootstrap already complete");
  }
}

// ── Subcommands ───────────────────────────────────────────────────────────────

async function cmdRun(): Promise<void> {
  const sm = new StateManager(STATE_DIR, SECRETS_DIR);
  try {
    await runAll(sm);
    process.exit(0);
  } catch (err) {
    const category = (err as { errorCategory?: string }).errorCategory ?? "unknown";
    if (TRANSIENT_CATEGORIES.has(category)) {
      // Reload state to pick up any writes made during the failed phase
      // (e.g. magicLinkRateLimitedUntil).
      const state = sm.load();
      const sleepMs = computeBackoffMs(state, category);
      // Increment the attempt counter (incremented even if rate-limit reset time is known,
      // so fallback exponential backoff is accurate after the rate limit expires).
      state.attempt = (state.attempt ?? 0) + 1;
      const nextRetryAt = new Date(Date.now() + sleepMs).toISOString();
      state.nextRetryAt = nextRetryAt;
      sm.save(state);
      log(
        `backoff: sleeping ${Math.ceil(sleepMs / 1000)}s before exit` +
          ` (${category}; next retry ~${nextRetryAt})`,
      );
      await sleep(sleepMs);
    }
    console.error(`[bootstrap] FAILED: ${redact(String(err))}`);
    process.exit(1);
  }
}

function cmdStatus(): void {
  const sm = new StateManager(STATE_DIR, SECRETS_DIR);
  const state = sm.load();
  // Print state JSON; it never contains secrets by invariant.
  console.log(JSON.stringify(state, null, 2));
}

async function cmdDashboardLink(): Promise<void> {
  /**
   * Request a fresh magic link and print it to stdout for the operator.
   * This starts the SMTP sink, requests the link, captures it, stops the sink,
   * and prints the link (to stdout only — not to logs).
   */
  const sm = new StateManager(STATE_DIR, SECRETS_DIR);
  sm.load(); // Ensure state dir is accessible.

  const jar = loadSession(SESSION_FILE);
  const abort = new AbortController();
  const sinkPromise = startSmtpSink({ port: SMTP_PORT, timeoutMs: 60_000, signal: abort.signal });
  await sleep(200);
  const mlResult = await requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
  if (mlResult.kind !== "sent") {
    abort.abort();
    throw new Error(
      `magic link request failed (${mlResult.kind}); the webapp may be rate-limiting requests`,
    );
  }
  const sinkResult = await sinkPromise;
  sinkResult.stop();

  // Print to stdout only — not to logs (link is a one-time URL).
  process.stdout.write(sinkResult.magicLink + "\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
const _ = rest; // suppress unused variable warning

switch (cmd) {
  case "run":
    await cmdRun();
    break;
  case "status":
    cmdStatus();
    break;
  case "dashboard-link":
    await cmdDashboardLink();
    break;
  default:
    console.error(
      "Usage: bootstrap <run|status|dashboard-link>\n" +
        "  run              Run all bootstrap phases (resumable).\n" +
        "  status           Print bootstrap.json (no secrets).\n" +
        "  dashboard-link   Request a fresh magic link and print it to stdout.",
    );
    process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
