/**
 * Readiness loader — reads state files and probes services.
 *
 * All I/O lives here; buildReadiness is kept pure for unit testing.
 * No secret values are returned.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTriggerKeyFromState } from "../config.ts";
import type { BootstrapJson, DeploymentJson, ReadinessInputs, TriggerStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// File readers (return null on any error — file may not exist yet)
// ---------------------------------------------------------------------------

/**
 * Phase order matching apps/bootstrap/src/state.ts PHASES constant.
 * Used to derive the "current" phase when reading BootstrapState format.
 */
const BOOTSTRAP_PHASE_ORDER = [
  "wait_services",
  "login",
  "org_project",
  "credentials",
  "deploy",
  "verify_deployment",
  "done",
] as const;

/**
 * Translate a BootstrapState (new format written by StateManager) into the
 * BootstrapJson shape used by the coordinator readiness subsystem.
 *
 * Rules:
 *   1. If phases.done.status === "done" → { phase: "done", status: "done" }
 *   2. If any phase has status "failed" → { phase: <that phase>, status: "failed", error: errorCategory }
 *   3. If any phase has status "running" → { phase: <that phase>, status: "running" }
 *   4. Otherwise: next after last "done" (or first phase) → { status: "running" }
 */
function translateBootstrapState(
  phases: Record<string, Record<string, unknown>>,
  at: string,
): BootstrapJson | null {
  // Rule 1: fully done
  if (phases.done?.status === "done") {
    return { phase: "done", status: "done", at };
  }
  // Rule 2: any failed phase (iterate in order; last failed wins)
  let failedPhase: string | null = null;
  let failedError: string | undefined;
  for (const name of BOOTSTRAP_PHASE_ORDER) {
    const p = phases[name];
    if (p?.status === "failed") {
      failedPhase = name;
      failedError = typeof p.errorCategory === "string" ? p.errorCategory : undefined;
    }
  }
  if (failedPhase !== null) {
    const result: BootstrapJson = { phase: failedPhase, status: "failed", at };
    if (failedError !== undefined) result.error = failedError;
    return result;
  }
  // Rule 3: running phase
  for (const name of BOOTSTRAP_PHASE_ORDER) {
    const p = phases[name];
    if (p?.status === "running") {
      return { phase: name, status: "running", at };
    }
  }
  // Rule 4: next after last done (phases object exists but nothing is running/failed)
  let lastDoneIdx = -1;
  for (let i = 0; i < BOOTSTRAP_PHASE_ORDER.length; i++) {
    const name = BOOTSTRAP_PHASE_ORDER[i];
    if (name !== undefined && phases[name]?.status === "done") lastDoneIdx = i;
  }
  const currentIdx = Math.min(lastDoneIdx + 1, BOOTSTRAP_PHASE_ORDER.length - 1);
  const currentPhase = BOOTSTRAP_PHASE_ORDER[currentIdx] ?? BOOTSTRAP_PHASE_ORDER[0];
  return { phase: currentPhase, status: "running", at };
}

/**
 * Read and parse <stateDir>/bootstrap.json.
 *
 * Handles two formats:
 *  - BootstrapState (new): { version: 1, phases: {...}, updatedAt: string }
 *    Written by apps/bootstrap/src/state.ts StateManager.
 *  - Legacy: { phase: string, status: string, at: string }
 *
 * Returns null if the file is missing, unreadable, or not valid JSON with the
 * expected shape.  Never throws; never logs file contents.
 */
export function readBootstrapJson(stateDir: string | undefined): BootstrapJson | null {
  if (!stateDir) return null;
  try {
    const raw = readFileSync(join(stateDir, "bootstrap.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    // ── New format: BootstrapState ──────────────────────────────────────────
    if ("phases" in obj && typeof obj.phases === "object" && obj.phases !== null) {
      const at = typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString();
      const phases = obj.phases as Record<string, Record<string, unknown>>;
      const result = translateBootstrapState(phases, at);
      // Surface the backoff timestamp so the coordinator nextAction can say when
      // bootstrap will retry (e.g. after login_rate_limited).
      if (result !== null && typeof obj.nextRetryAt === "string") {
        result.nextRetryAt = obj.nextRetryAt;
      }
      return result;
    }

    // ── Legacy format: { phase, status, at } ────────────────────────────────
    if (!("phase" in obj) || !("status" in obj) || !("at" in obj)) return null;
    if (
      typeof obj.phase !== "string" ||
      (obj.status !== "running" && obj.status !== "done" && obj.status !== "failed") ||
      typeof obj.at !== "string"
    ) {
      return null;
    }
    const result: BootstrapJson = {
      phase: obj.phase,
      status: obj.status,
      at: obj.at,
    };
    if (typeof obj.error === "string") {
      result.error = obj.error;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Read and parse <stateDir>/deployment.json.
 *
 * Handles two formats:
 *  - DeploymentRecord (new): { externalId, webappIpUrl, platform, at, version?, imageRef?, digest? }
 *    Written by apps/bootstrap/src/deploy.ts runDeploy / enrichDeployment.
 *  - Legacy: { version, platform, at, digest? }
 *
 * Only `at` is required; all other fields are optional (version/platform may
 * appear only after the verify phase enriches the record).
 *
 * Returns null if the file is missing, unreadable, or lacks `at`.
 * Never throws; never logs file contents.
 */
export function readDeploymentJson(stateDir: string | undefined): DeploymentJson | null {
  if (!stateDir) return null;
  try {
    const raw = readFileSync(join(stateDir, "deployment.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("at" in parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.at !== "string") return null;

    const result: DeploymentJson = { at: obj.at };
    if (typeof obj.version === "string") result.version = obj.version;
    if (typeof obj.platform === "string") result.platform = obj.platform;
    if (typeof obj.imageRef === "string") result.imageRef = obj.imageRef;
    if (typeof obj.digest === "string") result.digest = obj.digest;
    if (typeof obj.externalId === "string") result.externalId = obj.externalId;
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service probes (structural interfaces to allow injection in tests)
// ---------------------------------------------------------------------------

/**
 * Minimal database probe interface.
 */
export type DatabaseProbeFn = () => Promise<"ok" | "down">;

/**
 * Minimal Trigger probe interface.
 */
export type TriggerProbeFn = (apiUrl: string, secretKey: string) => Promise<TriggerStatus>;

/**
 * Probe database reachability by running a trivial query.
 * Returns "ok" on success, "down" on any error.
 */
export async function probeDatabase(pool: {
  connect: () => Promise<{
    query: (sql: string) => Promise<unknown>;
    release: () => void;
  }>;
}): Promise<"ok" | "down"> {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return "ok";
    } finally {
      client.release();
    }
  } catch {
    return "down";
  }
}

/**
 * Probe Trigger API reachability.
 * Returns "unconfigured" if the key is absent, "ok" or "down" based on
 * whether the health endpoint responds.
 * Never logs credentials.
 */
export async function probeTrigger(apiUrl: string, secretKey: string): Promise<TriggerStatus> {
  if (!apiUrl || !secretKey) return "unconfigured";
  try {
    const url = `${apiUrl.replace(/\/$/, "")}/api/v1/whoami`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(5000),
    });
    // Any HTTP response (even 401) means the service is reachable.
    return res.status < 500 ? "ok" : "down";
  } catch {
    return "down";
  }
}

// ---------------------------------------------------------------------------
// High-level loader
// ---------------------------------------------------------------------------

export type LoadReadinessOptions = {
  /** Pool for database probe. */
  pool: {
    connect: () => Promise<{
      query: (sql: string) => Promise<unknown>;
      release: () => void;
    }>;
  };
  /** Current Trigger API URL (may be empty if not yet configured). */
  triggerApiUrl: string;
  /** Current Trigger secret key (may be empty if bootstrap not yet done). */
  triggerSecretKey: string;
  /** State directory to re-read on each call (lazy — bootstrap writes files here). */
  stateDir: string | undefined;
};

/**
 * Load readiness inputs by probing services and reading state files.
 * Each call re-reads the state directory so the app picks up new files
 * without restarting.
 *
 * If stateDir is configured and trigger-prod.key exists there but the
 * injected triggerSecretKey is empty, the key is read from the file so
 * the Trigger probe uses the correct key once bootstrap completes.
 */
export async function loadReadinessInputs(options: LoadReadinessOptions): Promise<ReadinessInputs> {
  const { pool, triggerApiUrl, stateDir } = options;

  // Re-read the trigger key from the state file on every call (lazy / no restart needed).
  const triggerSecretKey = options.triggerSecretKey || readTriggerKeyFromState(stateDir) || "";

  const [database, trigger] = await Promise.all([
    probeDatabase(pool),
    probeTrigger(triggerApiUrl, triggerSecretKey),
  ]);

  return {
    database,
    trigger,
    bootstrapJson: readBootstrapJson(stateDir),
    deploymentJson: readDeploymentJson(stateDir),
  };
}
