/**
 * Artifact schemas for portable execution (v2 task payloads).
 *
 * ArtifactRef replaces host-path references (patchPath) in v2 payloads.
 * ArtifactUploadMeta describes a bundle uploaded by a worker container.
 * StopEvidenceUpload carries the stop-sequence evidence uploaded on graceful
 * shutdown.
 *
 * bundleRefFor: shared ref name for export bundles — both the worker and the
 * coordinator must use this constant so that `git fetch <bundle> <ref>:target`
 * resolves correctly across both sides.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bundle ref helpers (D5)
// ---------------------------------------------------------------------------

/**
 * Canonical ref name used when creating and fetching export bundles.
 *
 * The worker creates a bundle with this ref; the coordinator imports with the
 * same ref. Both sides must use this function to guarantee they agree on the
 * ref name.
 *
 * @param sha - 40-hex git SHA of the commit the bundle represents.
 */
export function bundleRefFor(sha: string): string {
  return `refs/agencyhq/export/${sha}`;
}

const Sha40Schema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-hex git sha");
const DigestRegex = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// ArtifactRef
// ---------------------------------------------------------------------------

/**
 * Portable reference to a worker artifact stored in the coordinator artifact
 * store. Replaces patchPath in v2 task payloads.
 */
export const ArtifactRefSchema = z.object({
  attemptId: z.string().min(1),
  /** Monotonically increasing per-attempt generation (min 0). */
  generation: z.number().int().min(0),
  /** 40-hex git SHA of the commit the artifact represents. */
  revision: Sha40Schema,
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ---------------------------------------------------------------------------
// ArtifactUploadMeta
// ---------------------------------------------------------------------------

/**
 * Metadata a worker container sends alongside an artifact bundle upload.
 * The coordinator validates this before persisting.
 */
export const ArtifactUploadMetaSchema = z.object({
  attemptId: z.string().min(1),
  generation: z.number().int().min(0),
  kind: z.enum(["attempt", "checkpoint"]),
  /** 40-hex git SHA of the commit produced by the worker. */
  commitId: Sha40Schema,
  /**
   * Digest of the diff (sha256:<hex>), matching the existing Digest type
   * used throughout the codebase.
   */
  diffDigest: z.string().regex(DigestRegex, "must be sha256:<64-hex>"),
  /** Relative paths changed by this attempt. */
  changedPaths: z.array(z.string()),
  /** Optional quarantine patch if path violations were detected. */
  quarantinePatch: z.string().optional(),
  /** 64-hex SHA-256 of the uploaded bundle bytes. */
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64-hex"),
  /** Byte length of the uploaded bundle. */
  bundleBytes: z.number().int().min(0),
});

export type ArtifactUploadMeta = z.infer<typeof ArtifactUploadMetaSchema>;

// ---------------------------------------------------------------------------
// StopEvidenceUpload
// ---------------------------------------------------------------------------

const StopEvidenceStepSchema = z.object({
  /** ISO 8601 timestamp of this step. */
  at: z.string().datetime({ message: "must be an ISO 8601 datetime" }),
  /**
   * Step name.
   *
   * The full vocabulary includes both the names the worker writes to stop.ndjson
   * and the canonical upload names. evidence.ts translates "checkpoint" →
   * "checkpoint_committed" before upload so either name is accepted here.
   *
   * Worker-written names: abort_signal, soft_deadline, on_cancel_entered,
   *   stop_start, signal_sent, process_exited, survivor_scan, killed,
   *   checkpoint, checkpoint_committed, checkpoint_failed, upload_done,
   *   stop_done, aborted.
   */
  step: z.enum([
    // canonical upload names (also worker-written in some cases)
    "signal_sent",
    "process_exited",
    "survivor_scan",
    "checkpoint_committed",
    "upload_done",
    "aborted",
    // additional worker-written names (D6)
    "abort_signal",
    "soft_deadline",
    "on_cancel_entered",
    "stop_start",
    "killed",
    "checkpoint",
    "checkpoint_failed",
    "stop_done",
  ]),
  /**
   * Optional free-text detail (≤ 2000 chars, single line).
   * Must not contain newline characters.
   */
  detail: z
    .string()
    .max(2000)
    .refine((s) => !s.includes("\n"), { message: "detail must not contain newlines" })
    .optional(),
  /**
   * Survivor PIDs from the post-kill scan (step: "stop_done").
   * Forwarded 1:1 from stop.ndjson by the evidence collector (E4).
   */
  survivors: z.array(z.number().int()).optional(),
  /**
   * Git SHA of the checkpoint commit (step: "checkpoint" / "checkpoint_committed").
   * Forwarded 1:1 from stop.ndjson by the evidence collector (E4).
   */
  checkpointCommit: z.string().optional(),
});

/**
 * Stop-sequence evidence uploaded by a worker container on graceful shutdown.
 */
export const StopEvidenceUploadSchema = z.object({
  attemptId: z.string().min(1),
  generation: z.number().int().min(0),
  /** Ordered list of stop-sequence steps. Non-empty; at most 200 steps. */
  steps: z.array(StopEvidenceStepSchema),
});

export type StopEvidenceUpload = z.infer<typeof StopEvidenceUploadSchema>;
