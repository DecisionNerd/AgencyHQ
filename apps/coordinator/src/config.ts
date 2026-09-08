/**
 * Coordinator configuration loader.
 *
 * Reads environment variables and returns a validated config object.
 * Never logs secret values; validation errors list missing variable names only.
 */

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
  webDist?: string;
  port: number;
  bindHost: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  function required(name: string): string {
    const val = env[name];
    if (val === undefined || val === "") {
      missing.push(name);
      return "";
    }
    return val;
  }

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

  const databaseUrl = required("DATABASE_URL");

  // RUNTIME: "fake" | "real" (defaults to "real")
  const runtimeRaw = optional("RUNTIME") ?? optional("COORDINATOR_RUNTIME") ?? "real";
  let runtime: "real" | "fake";
  if (runtimeRaw === "real" || runtimeRaw === "fake") {
    runtime = runtimeRaw;
  } else {
    invalid.push("RUNTIME");
    runtime = "real";
  }

  // Trigger credentials: required for real runtime, optional for fake
  let triggerApiUrl: string;
  let triggerSecretKey: string;
  if (runtime === "real") {
    triggerApiUrl = required("TRIGGER_API_URL");
    triggerSecretKey = required("TRIGGER_SECRET_KEY");
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
  const webDist = optional("WEB_DIST");
  const port = portNum("PORT", 8787);
  const bindHost = optional("AGENCYHQ_BIND_HOST") ?? "127.0.0.1";

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
    port,
    bindHost,
  };

  if (webDist !== undefined) {
    return { ...base, webDist };
  }
  return base;
}
