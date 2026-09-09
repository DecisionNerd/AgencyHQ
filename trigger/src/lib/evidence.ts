// Stop-sequence evidence collection and upload (epic #14, P18.3).
//
// On the container profile, the stop sequence is uploaded to the coordinator
// via the /internal/attempts/:id/stop-evidence route alongside (or instead of)
// writing stop.ndjson to disk. On the host profile, stop.ndjson is still written.
//
// collectStopEvidence: reads the local stop.ndjson file and converts each
//   JSON-line entry into a StopEvidenceUpload step. Lines that don't match the
//   known step names are silently dropped (best-effort).
//
// uploadStopEvidence: calls collectStopEvidence then posts to the coordinator.
//   Never throws; returns an upload status string.
//
// No Trigger SDK usage.

import { readFile } from "node:fs/promises";

import type { StopEvidenceUpload } from "@agencyhq/contracts";

import type { Broker } from "./broker.ts";

// ---------------------------------------------------------------------------
// Known stop step names (from StopEvidenceUploadSchema)
// ---------------------------------------------------------------------------

const KNOWN_STEPS = new Set([
  "signal_sent",
  "process_exited",
  "survivor_scan",
  "checkpoint_committed",
  "upload_done",
  "aborted",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StopStep = {
  at: string;
  step:
    | "signal_sent"
    | "process_exited"
    | "survivor_scan"
    | "checkpoint_committed"
    | "upload_done"
    | "aborted";
  detail?: string;
};

export type CollectStopEvidenceResult = {
  steps: StopStep[];
};

// ---------------------------------------------------------------------------
// collectStopEvidence
// ---------------------------------------------------------------------------

/**
 * Read stop.ndjson from the run directory and convert to structured steps.
 *
 * Each line is expected to be a JSON object with at least `{ at: string, step: string }`.
 * Lines with unrecognised step names are dropped (best-effort sink).
 * If the file does not exist or cannot be read, returns an empty step list.
 *
 * The schema requires at least 1 step; callers must decide whether to upload
 * when the result is empty.
 */
export async function collectStopEvidence(runDir: string): Promise<CollectStopEvidenceResult> {
  const filePath = `${runDir}/stop.ndjson`;
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { steps: [] };
  }

  const steps: StopStep[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const obj = parsed as Record<string, unknown>;
    const at = typeof obj.at === "string" ? obj.at : new Date().toISOString();
    const stepName = typeof obj.step === "string" ? obj.step : "";

    if (!KNOWN_STEPS.has(stepName)) {
      continue;
    }

    const step = stepName as StopStep["step"];
    const rawDetail = typeof obj.detail === "string" ? obj.detail : undefined;
    // detail must be ≤ 2000 chars and contain no newlines.
    const detail =
      rawDetail !== undefined ? rawDetail.replace(/\n/g, " ").slice(0, 2000) : undefined;

    if (detail !== undefined) {
      steps.push({ at, step, detail });
    } else {
      steps.push({ at, step });
    }
  }

  return { steps };
}

// ---------------------------------------------------------------------------
// uploadStopEvidence
// ---------------------------------------------------------------------------

export type UploadStopEvidenceResult = {
  uploadStatus: "uploaded" | "skipped" | "failed";
  failureReason?: string;
};

/**
 * Collect stop evidence from stop.ndjson and upload it to the coordinator.
 *
 * Returns { uploadStatus: "skipped" } when no recognised steps are found.
 * Returns { uploadStatus: "failed", failureReason } on network errors.
 * Never throws.
 */
export async function uploadStopEvidence(args: {
  runDir: string;
  attemptId: string;
  generation: number;
  broker: Broker;
  token: string;
}): Promise<UploadStopEvidenceResult> {
  const { steps } = await collectStopEvidence(args.runDir);

  if (steps.length === 0) {
    return { uploadStatus: "skipped" };
  }

  const evidence: StopEvidenceUpload = {
    attemptId: args.attemptId,
    generation: args.generation,
    steps,
  };

  try {
    await args.broker.uploadStopEvidence({
      attemptId: args.attemptId,
      token: args.token,
      evidence,
    });
    return { uploadStatus: "uploaded" };
  } catch (err) {
    return {
      uploadStatus: "failed",
      failureReason: (err as Error).message,
    };
  }
}
