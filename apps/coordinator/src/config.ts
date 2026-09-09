/**
 * Coordinator configuration loader.
 *
 * Reads environment variables and returns a validated config object.
 * Never logs secret values; validation errors list missing variable names only.
 *
 * Secret resolution precedence (env wins):
 *   1. Environment variable (always highest priority)
 *   2. <AGENCYHQ_SECRETS_DIR>/<NAME>.env — single-line file in `NAME=value` format
 *   3. <AGENCYHQ_SECRETS_DIR>/<NAME> — raw file (trimmed)
 *   4. Existing default / required behaviour
 *
 * TRIGGER_SECRET_KEY and TRIGGER_API_URL additionally fall back to
 * <AGENCYHQ_STATE_DIR>/trigger-prod.key (and trigger-api-url respectively)
 * which are written by the bootstrap after it completes.  These are read at
 * config-load time; the readiness loader re-reads them on every poll so the
 * app can start before the bootstrap finishes without requiring a restart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CoordinatorConfig = {
  databaseUrl: string;
  triggerApiUrl: string;
  triggerSecretKey: string;
  runtime: "real" | "fake";
  worktreeBase: string;
  workerModel: string;
  leadModel: string;
  reviewerModel: string;
  leadVariant?: string | undefined;
  reconcileIntervalMs: number;
  freshnessStaleMs: number;
  uncertainAfterMs: number;
  /**
   * Maximum compare-and-set retries for integrate.merge on retry_cas outcome.
   * Default: 2.
   */
  integrateRetries?: number | undefined;
  /**
   * Number of concurrent worker slots.  Admission queues when all slots are
   * occupied; the scheduler dispatches queued intents when a slot becomes free.
   * Default: 1.
   */
  workerSlots?: number | undefined;
  /**
   * When true, the reconciler subscribes to the runtime push feed (subscribe
   * port) and wakes up on any run observation rather than waiting for the next
   * polling interval.  Default: false.
   */
  realtimeWakeup?: boolean | undefined;
  webDist?: string;
  port: number;
  bindHost: string;
  /** Bearer token for /api/* authentication. Absent when binding to loopback only. */
  apiToken?: string;
  /**
   * Directory for durable state files written by the bootstrap
   * (bootstrap.json, deployment.json, trigger-prod.key).
   * Corresponds to the agencyhq-state volume mount point.
   */
  stateDir?: string;
  /**
   * Directory for secrets files mounted from the secrets volume.
   * Used to resolve DATABASE_URL, TRIGGER_SECRET_KEY, and AGENCYHQ_API_TOKEN
   * when the corresponding environment variable is not set.
   */
  secretsDir?: string;
};

export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`Missing: ${missing.join(", ")}`);
    if (invalid.length > 0) parts.push(`Invalid: ${invalid.join(", ")}`);
    super(`Config error. ${parts.join(". ")}`);
    this.name = "ConfigError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

/**
 * Reads a secret value from the secrets directory.
 * Tries <dir>/<name>.env (NAME=value format) then <dir>/<name> (raw).
 * Returns undefined if the directory is not set or neither file exists.
 * Never throws; read errors are silently ignored.
 * Never logs the value.
 */
export function readSecretFile(name: string, dir: string | undefined): string | undefined {
  if (!dir) return undefined;

  // Try <name>.env — single line `NAME=value` format (as written by secrets-init)
  try {
    const envContent = readFileSync(join(dir, `${name}.env`), "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIdx);
      if (key !== name) continue;
      const raw = trimmed.slice(eqIdx + 1);
      // Strip single quotes (secrets-init writes NAME='value'; unescape '\'' → ')
      const val =
        raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
      if (val.length > 0) return val;
    }
  } catch {
    // File missing or unreadable — try next source
  }

  // Try raw file <name>
  try {
    const raw = readFileSync(join(dir, name), "utf-8").trim();
    if (raw.length > 0) return raw;
  } catch {
    // File missing or unreadable — fall through
  }

  return undefined;
}

/**
 * Reads the Trigger production secret key from the bootstrap state directory.
 * Returns undefined if the file does not yet exist (bootstrap still running).
 * Never throws; never logs the value.
 */
export function readTriggerKeyFromState(stateDir: string | undefined): string | undefined {
  if (!stateDir) return undefined;
  try {
    const raw = readFileSync(join(stateDir, "trigger-prod.key"), "utf-8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  function optional(name: string): string | undefined {
    const val = env[name];
    return val !== undefined && val !== "" ? val : undefined;
  }

  function integer(name: string, defaultValue: number): number {
    const val = env[name];
    if (val === undefined || val === "") return defaultValue;
    const n = Number(val);
    if (!Number.isInteger(n) || n <= 0) {
      invalid.push(name);
      return defaultValue;
    }
    return n;
  }

  function portNum(name: string, defaultValue: number): number {
    const val = env[name];
    if (val === undefined || val === "") return defaultValue;
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      invalid.push(name);
      return defaultValue;
    }
    return n;
  }

  // Resolve the two directory sources first — they are used for secret lookups below.
  const stateDir = optional("AGENCYHQ_STATE_DIR");
  const secretsDir = optional("AGENCYHQ_SECRETS_DIR");

  /**
   * Secret resolution: env → secrets dir → required/optional fallback.
   * Never logs the value.
   */
  function secretRequired(name: string): string {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromFile = readSecretFile(name, secretsDir);
    if (fromFile !== undefined) return fromFile;
    missing.push(name);
    return "";
  }

  function secretOptional(name: string): string | undefined {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    return readSecretFile(name, secretsDir);
  }

  const databaseUrl = secretRequired("DATABASE_URL");

  // RUNTIME: "fake" | "real" (defaults to "real")
  const runtimeRaw = optional("RUNTIME") ?? optional("COORDINATOR_RUNTIME") ?? "real";
  let runtime: "real" | "fake";
  if (runtimeRaw === "real" || runtimeRaw === "fake") {
    runtime = runtimeRaw;
  } else {
    invalid.push("RUNTIME");
    runtime = "real";
  }

  // Trigger credentials: env wins, then secrets dir, then state dir (lazy — bootstrap
  // writes trigger-prod.key after startup; app starts with empty key and readiness
  // reflects "unconfigured" until the key appears).
  let triggerApiUrl: string;
  let triggerSecretKey: string;
  if (runtime === "real") {
    // Try env → secrets dir → state dir; do NOT require — bootstrap may not have run yet.
    triggerApiUrl =
      optional("TRIGGER_API_URL") ?? readSecretFile("TRIGGER_API_URL", secretsDir) ?? "";
    triggerSecretKey =
      optional("TRIGGER_SECRET_KEY") ??
      readSecretFile("TRIGGER_SECRET_KEY", secretsDir) ??
      readTriggerKeyFromState(stateDir) ??
      "";
  } else {
    triggerApiUrl = optional("TRIGGER_API_URL") ?? "";
    triggerSecretKey = optional("TRIGGER_SECRET_KEY") ?? "";
  }

  // Support both legacy and new env var names
  const requiredWithFallback = (primary: string, fallback: string): string => {
    const value = optional(primary) ?? optional(fallback);
    if (value === undefined) {
      missing.push(primary);
      return "";
    }
    return value;
  };
  const worktreeBase = requiredWithFallback("AGENCYHQ_WORKTREE_BASE", "WORKTREE_BASE");
  const workerModel = requiredWithFallback("AGENCYHQ_WORKER_MODEL", "WORKER_MODEL");
  const leadModel = requiredWithFallback("AGENCYHQ_LEAD_MODEL", "LEAD_MODEL");
  const reviewerModel = requiredWithFallback("AGENCYHQ_REVIEWER_MODEL", "REVIEWER_MODEL");

  const leadVariant = optional("AGENCYHQ_LEAD_VARIANT");

  const reconcileIntervalMs = integer("RECONCILE_INTERVAL_MS", 5000);
  const freshnessStaleMs = integer("FRESHNESS_STALE_MS", 30000);
  const uncertainAfterMs = integer("AGENCYHQ_UNCERTAIN_AFTER_MS", 120_000);
  const integrateRetries = integer("AGENCYHQ_INTEGRATE_RETRIES", 2);
  const workerSlots = integer("AGENCYHQ_WORKER_SLOTS", 1);
  const realtimeWakeupRaw = optional("AGENCYHQ_REALTIME_WAKEUP");
  const realtimeWakeup = realtimeWakeupRaw === "true" || realtimeWakeupRaw === "1";
  const webDist = optional("WEB_DIST");
  const port = portNum("PORT", 8787);
  const bindHost = optional("AGENCYHQ_BIND_HOST") ?? "127.0.0.1";

  // Bearer token: env wins, then secrets dir; optional when binding to loopback; required otherwise.
  const apiToken = secretOptional("AGENCYHQ_API_TOKEN");
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (apiToken === undefined && !loopbackHosts.has(bindHost)) {
    missing.push("AGENCYHQ_API_TOKEN");
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new ConfigError(missing, invalid);
  }

  const base: CoordinatorConfig = {
    databaseUrl,
    triggerApiUrl,
    triggerSecretKey,
    runtime,
    worktreeBase,
    workerModel,
    leadModel,
    reviewerModel,
    leadVariant,
    reconcileIntervalMs,
    freshnessStaleMs,
    uncertainAfterMs,
    integrateRetries,
    workerSlots: workerSlots,
    realtimeWakeup: realtimeWakeup,
    port,
    bindHost,
  };

  let result: CoordinatorConfig = base;
  if (webDist !== undefined) {
    result = { ...result, webDist };
  }
  if (apiToken !== undefined) {
    result = { ...result, apiToken };
  }
  if (stateDir !== undefined) {
    result = { ...result, stateDir };
  }
  if (secretsDir !== undefined) {
    result = { ...result, secretsDir };
  }
  return result;
}
