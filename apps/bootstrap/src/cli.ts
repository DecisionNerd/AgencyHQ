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
import type { RunDeps } from "./run.ts";
import { runAll } from "./run.ts";
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

const STATE_DIR = process.env.AGENCYHQ_STATE_DIR ?? "/var/agencyhq/state";
// Bootstrap-minted secret files (trigger-prod.key, trigger-pat.key) are written
// into the state directory — the same agencyhq-state volume the coordinator reads.
const SECRETS_DIR = process.env.AGENCYHQ_SECRETS_DIR ?? STATE_DIR;
const WEBAPP_URL = process.env.TRIGGER_WEBAPP_URL ?? "http://webapp:3000";
const BOOTSTRAP_EMAIL = process.env.BOOTSTRAP_EMAIL ?? "bootstrap@agencyhq.local";
const ORG_NAME = process.env.AGENCYHQ_ORG_NAME ?? "agencyhq";
const PROJECT_NAME = process.env.AGENCYHQ_PROJECT_NAME ?? "agencyhq";
const TOKEN_NAME = process.env.AGENCYHQ_TOKEN_NAME ?? "agencyhq-bootstrap";
const WORKSPACE_ROOT = process.env.AGENCYHQ_WORKSPACE_ROOT ?? "/app";
const PLATFORM = process.env.AGENCYHQ_PLATFORM ?? "linux/arm64";
const SMTP_PORT = Number(process.env.BOOTSTRAP_SMTP_PORT ?? "2525");

/**
 * How long to wait for the magic-link email to arrive in the SMTP sink (ms).
 * Configurable because the webapp throttles repeated magic links to the same
 * address; operators can increase this if the email consistently arrives late.
 */
const BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS = Number(
  process.env.BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS ?? "90000",
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

// ── Subcommands ───────────────────────────────────────────────────────────────

async function cmdRun(): Promise<void> {
  const sm = new StateManager(STATE_DIR, SECRETS_DIR);
  const deps: RunDeps = {
    sm,
    webappUrl: WEBAPP_URL,
    bootstrapEmail: BOOTSTRAP_EMAIL,
    orgName: ORG_NAME,
    projectName: PROJECT_NAME,
    tokenName: TOKEN_NAME,
    workspaceRoot: WORKSPACE_ROOT,
    platform: PLATFORM,
    smtpPort: SMTP_PORT,
    magicLinkTimeoutMs: BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS,
    magicLinkThrottleMs: MAGIC_LINK_THROTTLE_MS,
    sessionFile: SESSION_FILE,
    secretProdKey: SECRET_PROD_KEY,
    secretPAT: SECRET_PAT,
    stateDir: STATE_DIR,
    waitForReadiness,
    startSmtpSink,
    requestMagicLink,
    followMagicLink,
    confirmBasicDetailsIfNeeded,
    hasValidSession,
    loadSession,
    saveSession,
    deleteSession,
    findOrCreateOrgProject,
    readProdSecretKey,
    mintPAT,
    resolveWebappIp,
    runDeploy,
    verifyDeployment,
    deploymentIsCurrent,
    enrichDeployment,
    sleep,
    log,
  };
  try {
    await runAll(deps);
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
   * Start the SMTP sink, request a fresh magic link, capture it, stop the sink,
   * print ONLY the URL to stdout. Never follows the link.
   * On rate limit: print the reset time to stderr and exit 1.
   */
  const sm = new StateManager(STATE_DIR, SECRETS_DIR);
  sm.load(); // Ensure state dir is accessible.

  const jar = loadSession(SESSION_FILE);
  const abort = new AbortController();
  const sinkPromise = startSmtpSink({ port: SMTP_PORT, timeoutMs: 60_000, signal: abort.signal });
  await sleep(200);
  const mlResult = await requestMagicLink(WEBAPP_URL, BOOTSTRAP_EMAIL, jar);
  if (mlResult.kind === "rate_limited") {
    sinkPromise.catch(() => {});
    abort.abort();
    const resetMsg =
      mlResult.resetAt !== null
        ? `rate limit resets at ${new Date(mlResult.resetAt).toISOString()}`
        : "rate limit reset time unknown";
    process.stderr.write(`[bootstrap] dashboard-link: magic link rate limited; ${resetMsg}\n`);
    process.exit(1);
  }
  const sinkResult = await sinkPromise;
  sinkResult.stop();

  // Print to stdout only — not to logs (link is a one-time URL).
  process.stdout.write(`${sinkResult.magicLink}\n`);
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
