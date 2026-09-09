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

import { enrichDeployment, runDeploy } from "./deploy.ts";
import { startSmtpSink } from "./smtp-sink.ts";
import { StateManager } from "./state.ts";
import {
  confirmBasicDetailsIfNeeded,
  createJar,
  findOrCreateOrgProject,
  followMagicLink,
  mintPAT,
  readProdSecretKey,
  redact,
  requestMagicLink,
  resolveWebappIp,
  waitForReadiness,
} from "./trigger-web.ts";
import { verifyDeployment } from "./verify.ts";

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

// File names for secrets written to the state volume (0600 files).
// Must match what the coordinator reads: apps/coordinator/src/config.ts readTriggerKeyFromState.
const SECRET_PROD_KEY = "trigger-prod.key";
const SECRET_PAT = "trigger-pat.key";

function log(msg: string): void {
  console.log(`[bootstrap] ${redact(msg)}`);
}

// ── Phase runner ─────────────────────────────────────────────────────────────

async function runAll(): Promise<void> {
  const sm = new StateManager(STATE_DIR, SECRETS_DIR);
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

  // ── Phase: login ─────────────────────────────────────────────────────────
  const jar = createJar();
  if (!sm.isDone(state, "login")) {
    sm.setRunning(state, "login");
    log("phase: login — starting SMTP sink and requesting magic link");
    try {
      const [sinkResult, status] = await Promise.all([
        startSmtpSink({ port: SMTP_PORT, timeoutMs: 60_000 }),
        (async () => {
          // Give the sink a moment to start before requesting the link.
          await sleep(200);
          return requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
        })(),
      ]);
      if (status !== 200 && status !== 302) {
        throw Object.assign(
          new Error(`magic link request returned HTTP ${status} (expected 200 or 302)`),
          { errorCategory: "magic_link_timeout" },
        );
      }
      sinkResult.stop();
      log("magic link captured from SMTP sink");
      const landingPath = await followMagicLink(sinkResult.magicLink, WEBAPP_URL, jar);
      await confirmBasicDetailsIfNeeded(WEBAPP_URL, BOOTSTRAP_EMAIL, jar, landingPath);
      sm.setDone(state, "login");
    } catch (err) {
      const category = (err as { errorCategory?: string }).errorCategory ?? "login_failed";
      sm.setFailed(state, "login", category, String(err));
      throw err;
    }
  } else {
    log("phase: login — already done (session must be re-established)");
    // Re-establish session for subsequent phases by requesting a new magic link.
    try {
      const [sinkResult] = await Promise.all([
        startSmtpSink({ port: SMTP_PORT, timeoutMs: 60_000 }),
        (async () => {
          await sleep(200);
          await requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
        })(),
      ]);
      sinkResult.stop();
      const landingPath = await followMagicLink(sinkResult.magicLink, WEBAPP_URL, jar);
      await confirmBasicDetailsIfNeeded(WEBAPP_URL, BOOTSTRAP_EMAIL, jar, landingPath);
    } catch (err) {
      log(`session re-establishment failed: ${String(err)}; continuing anyway`);
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
      sm.setFailed(state, "deploy", "deploy_failed", String(err));
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
  try {
    await runAll();
    process.exit(0);
  } catch (err) {
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

  let sinkResult: { magicLink: string; stop(): void } | undefined;

  const jar = createJar();
  [sinkResult] = await Promise.all([
    startSmtpSink({ port: SMTP_PORT, timeoutMs: 60_000 }),
    (async () => {
      await sleep(200);
      await requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
    })(),
  ]);

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
