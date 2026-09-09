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
 * Read and parse <stateDir>/bootstrap.json.
 * Returns null if the file is missing, unreadable, or not valid JSON with the
 * expected shape.  Never throws; never logs file contents.
 */
export function readBootstrapJson(stateDir: string | undefined): BootstrapJson | null {
  if (!stateDir) return null;
  try {
    const raw = readFileSync(join(stateDir, "bootstrap.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("phase" in parsed) ||
      !("status" in parsed) ||
      !("at" in parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
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
 * Returns null if the file is missing, unreadable, or not valid JSON.
 * Never throws; never logs file contents.
 */
export function readDeploymentJson(stateDir: string | undefined): DeploymentJson | null {
  if (!stateDir) return null;
  try {
    const raw = readFileSync(join(stateDir, "deployment.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("platform" in parsed) ||
      !("at" in parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.version !== "string" ||
      typeof obj.platform !== "string" ||
      typeof obj.at !== "string"
    ) {
      return null;
    }
    const result: DeploymentJson = {
      version: obj.version,
      platform: obj.platform,
      at: obj.at,
    };
    if (typeof obj.digest === "string") {
      result.digest = obj.digest;
    }
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
