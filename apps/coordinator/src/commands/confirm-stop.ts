/**
 * confirmStop command — transitions an attempt from stopping → stopped|uncertain.
 *
 * Derives survivorsConfirmedGone from the run observation's metadata or from
 * explicit stop evidence (survivors array from the run dir's stop.ndjson).
 *
 * Outcomes:
 *  - stopped:              survivors array is present and empty
 *  - uncertain:            survivors are non-empty, OR deadline has passed
 *  - pending_confirmation: final status observed but no evidence yet,
 *                          within the uncertainAfterMs window
 */

import { readFile } from "node:fs/promises";
import { confirmStopped, listStopEvidenceForAttempt } from "@agencyhq/db";
import type { RunObservation } from "@agencyhq/trigger/client";
import { FINAL_RUN_STATUSES } from "@agencyhq/trigger/client";
import type pg from "pg";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// Stop evidence parsed from <runDir>/stop.ndjson
// ---------------------------------------------------------------------------

export type StopFileEvidence = {
  survivors: number[];
  checkpointCommit?: string;
};

/**
 * Read stop evidence DB-first (for mirror-mode projects), then fall back to
 * file-based evidence (for host_clone projects).
 *
 * For mirror projects: reads from attempt_stop_evidence (uploaded by the worker
 * container via POST /internal/attempts/:id/stop-evidence) for the current
 * generation. If no DB row exists, returns null (no fallback to file).
 *
 * For host_clone projects: reads from the run directory's stop.ndjson file
 * (legacy behavior).
 *
 * @param client  - DB pool client (used only for mirror-mode lookup)
 * @param attemptId - The attempt ID
 * @param generation - The current generation
 * @param sourceMode - 'mirror' or 'host_clone'
 * @param runDir - The run directory path (used only for host_clone fallback)
 */
export async function readStopEvidenceDbFirst(
  client: pg.PoolClient,
  attemptId: string,
  generation: number,
  sourceMode: "mirror" | "host_clone",
  runDir?: string | undefined,
): Promise<StopFileEvidence | null> {
  if (sourceMode === "mirror") {
    // DB-first: query attempt_stop_evidence for this (attemptId, generation)
    const rows = await listStopEvidenceForAttempt(client, attemptId);
    const row = rows.find((r) => r.generation === generation);
    if (!row) return null;

    // Parse steps to extract survivors and checkpointCommit
    const steps = Array.isArray(row.steps)
      ? (row.steps as Array<{ step: string; detail?: string }>)
      : [];
    const uploadDone = steps.some((s) => s.step === "upload_done");
    const aborted = steps.some((s) => s.step === "aborted");
    const processDied = steps.some(
      (s) => s.step === "process_exited" || s.step === "survivor_scan",
    );

    // survivors = [] means clean stop; non-empty means survivors present
    // We derive from the presence of 'aborted' or 'survivor_scan' steps
    const survivors: number[] = aborted ? [1] : [];

    // Look for checkpointCommit in checkpoint_committed step detail
    const cpStep = steps.find((s) => s.step === "checkpoint_committed");
    const checkpointCommit = cpStep?.detail;

    if (!uploadDone && !aborted && !processDied) return null;

    const result: StopFileEvidence = { survivors };
    if (checkpointCommit) {
      result.checkpointCommit = checkpointCommit;
    }
    return result;
  }

  // host_clone: fall back to file-based evidence
  if (!runDir) return null;
  return readStopEvidence(runDir);
}

/**
 * Parse stop evidence from a run directory's stop.ndjson file.
 * Returns null if the file does not exist or has no stop_done line.
 */
export async function readStopEvidence(runDir: string): Promise<StopFileEvidence | null> {
  const filePath = `${runDir}/stop.ndjson`;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let stopDone: { survivors?: number[] } | null = null;
  let checkpointCommit: string | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;

    const record = parsed as Record<string, unknown>;
    // Accept `step` (adapter format) or legacy `event` key.
    const eventKey = typeof record.step === "string" ? record.step : record.event;
    if (eventKey === "stop_done" && Array.isArray(record.survivors)) {
      stopDone = { survivors: record.survivors as number[] };
    }
    if (eventKey === "checkpoint") {
      // Accept `checkpointCommit` (adapter format) or legacy `commit` key.
      const commit =
        typeof record.checkpointCommit === "string"
          ? record.checkpointCommit
          : typeof record.commit === "string"
            ? record.commit
            : undefined;
      if (commit !== undefined) {
        checkpointCommit = commit;
      }
    }
  }

  if (stopDone === null) return null;

  const result: StopFileEvidence = { survivors: stopDone.survivors ?? [] };
  if (checkpointCommit !== undefined) {
    result.checkpointCommit = checkpointCommit;
  }
  return result;
}

// ---------------------------------------------------------------------------
// confirmStop input / output
// ---------------------------------------------------------------------------

export type ConfirmStopInput = {
  attemptId: string;
  generation: number;
  observation: RunObservation;
  stopEvidence?: { survivors: number[]; checkpointCommit?: string | null };
  /** ISO timestamp of when the final status was first observed (for deadline). */
  finalObservedAt?: string;
};

export type ConfirmStopOutput =
  | { status: "stopped"; checkpointCommit?: string }
  | { status: "uncertain" }
  | { status: "pending_confirmation" }
  | { status: "stale_generation" }
  | { status: "state_mismatch" };

const DEFAULT_UNCERTAIN_AFTER_MS = 120_000;

// ---------------------------------------------------------------------------
// confirmStop
// ---------------------------------------------------------------------------

/**
 * Confirm that a stopped attempt has no survivors, transitioning it to
 * stopped or uncertain.
 *
 * Does NOT require a commandId — called by the reconciler, not via the
 * idempotency table.
 */
export async function confirmStop(
  deps: CommandDeps,
  client: pg.PoolClient,
  input: ConfirmStopInput,
): Promise<ConfirmStopOutput> {
  const { attemptId, generation, observation, stopEvidence, finalObservedAt } = input;
  const uncertainAfterMs = deps.config?.uncertainAfterMs ?? DEFAULT_UNCERTAIN_AFTER_MS;

  // Derive survivorsConfirmedGone from observation metadata or explicit evidence
  const metadataSurvivors = observation.metadata?.survivors;
  const evidenceSurvivors = stopEvidence?.survivors;

  let survivorsConfirmedGone: boolean | null = null;
  let checkpointCommit: string | undefined;

  if (Array.isArray(metadataSurvivors) && metadataSurvivors.length === 0) {
    survivorsConfirmedGone = true;
  } else if (Array.isArray(metadataSurvivors) && metadataSurvivors.length > 0) {
    survivorsConfirmedGone = false;
  }

  if (survivorsConfirmedGone === null && evidenceSurvivors !== undefined) {
    survivorsConfirmedGone = evidenceSurvivors.length === 0;
  }

  if (stopEvidence?.checkpointCommit != null) {
    checkpointCommit = stopEvidence.checkpointCommit;
  } else if (typeof observation.metadata?.checkpointCommit === "string") {
    checkpointCommit = observation.metadata.checkpointCommit;
  }

  const isFinal = FINAL_RUN_STATUSES.has(observation.status);

  // If observation is final but we have no evidence yet
  if (isFinal && survivorsConfirmedGone === null) {
    // Check whether we've passed the uncertainty deadline
    const now = Date.parse(deps.clock.now());
    const observedAt = finalObservedAt ? Date.parse(finalObservedAt) : now;
    const elapsed = now - observedAt;

    if (elapsed >= uncertainAfterMs) {
      // Deadline passed → mark uncertain
      const res = await confirmStopped(client, attemptId, generation, {
        survivorsConfirmedGone: false,
      });
      if (!res.ok) {
        return { status: res.reason };
      }
      return { status: "uncertain" };
    }

    // Within deadline → pending
    return { status: "pending_confirmation" };
  }

  // We have a definitive answer
  if (survivorsConfirmedGone === null) {
    // Observation is not final yet — pending
    return { status: "pending_confirmation" };
  }

  const confirmInput =
    checkpointCommit !== undefined
      ? { survivorsConfirmedGone, checkpointCommit }
      : { survivorsConfirmedGone };
  const res = await confirmStopped(client, attemptId, generation, confirmInput);
  if (!res.ok) {
    return { status: res.reason };
  }

  if (res.status === "stopped") {
    if (checkpointCommit !== undefined) {
      return { status: "stopped", checkpointCommit };
    }
    return { status: "stopped" };
  }
  return { status: "uncertain" };
}
