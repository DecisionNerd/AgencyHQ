/**
 * Artifact admission validator.
 *
 * validateArtifactAdmission checks all preconditions before the coordinator
 * accepts and persists a worker-submitted artifact bundle.
 *
 * Returns Ok(true) on success or Err(code) for the first failing condition
 * (order-stable — the first failing code in the enumerated list is returned).
 *
 * Pure function — no I/O, no external dependencies beyond result.ts and paths.ts.
 */

import type { ArtifactUploadMeta } from "@agencyhq/contracts";
import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";
import { validateChangedPaths } from "./paths.ts";

// ---------------------------------------------------------------------------
// Reason codes (ordered: first failing code in this list is returned)
// ---------------------------------------------------------------------------

export type ArtifactAdmissionCode =
  | "LEASE_MISSING"
  | "LEASE_REVOKED"
  | "LEASE_EXPIRED"
  | "LEASE_PURPOSE_MISMATCH"
  | "ATTEMPT_MISMATCH"
  | "LEASE_GENERATION_MISMATCH"
  | "STALE_GENERATION"
  | "FUTURE_GENERATION"
  | "ATTEMPT_TERMINAL"
  | "BUNDLE_TOO_LARGE"
  | "PATH_UNSAFE"
  | "COMMIT_NOT_IN_MIRROR"
  | "DIGEST_MISMATCH";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ArtifactLease {
  purpose: string;
  attemptId: string;
  generation: number;
  expiresAt: string; // ISO 8601
  revokedAt?: string | null;
}

export interface ArtifactAttempt {
  id: string;
  projectId: string;
  currentGeneration: number;
  status: string;
}

export interface ArtifactMirror {
  /** Whether the mirror/coordinator has the commit identified by sha. */
  hasCommit(sha: string): boolean;
  /**
   * The recomputed diff digest for the claimed commit, or null if the commit
   * is not in the mirror (and hasCommit already returned false).
   */
  recomputedDiffDigest: string | null;
}

export interface ArtifactAdmissionInput {
  claimed: ArtifactUploadMeta;
  lease: ArtifactLease | null;
  attempt: ArtifactAttempt;
  now: string; // ISO 8601
  mirror: ArtifactMirror;
  limits: { maxBundleBytes: number };
}

// ---------------------------------------------------------------------------
// Terminal attempt statuses
// ---------------------------------------------------------------------------

/** Strictly terminal statuses: reject all uploads (attempt and checkpoint). */
const STRICTLY_TERMINAL_STATUSES = new Set(["completed", "quarantined", "failed"]);

/**
 * Stopping/uncertain statuses: accept only checkpoint and stop-evidence uploads.
 * A final "attempt" artifact from a fenced generation must not advance the
 * attempt while it is shutting down.
 */
const STOPPING_STATUSES = new Set(["stopping", "stopped", "uncertain"]);

// ---------------------------------------------------------------------------
// validateArtifactAdmission
// ---------------------------------------------------------------------------

/**
 * Validate an artifact upload submission.
 *
 * Checks are ordered; the first failing code is returned (fail-fast, deterministic).
 */
export function validateArtifactAdmission(
  input: ArtifactAdmissionInput,
): Result<true, ArtifactAdmissionCode> {
  const { claimed, lease, attempt, now, mirror, limits } = input;

  // 1. Lease must exist
  if (!lease) return err("LEASE_MISSING");

  // 2. Lease must not be revoked
  if (lease.revokedAt != null && lease.revokedAt <= now) return err("LEASE_REVOKED");

  // 3. Lease must not be expired
  if (lease.expiresAt <= now) return err("LEASE_EXPIRED");

  // 4. Lease purpose must be "upload"
  if (lease.purpose !== "upload") return err("LEASE_PURPOSE_MISMATCH");

  // 5. Lease must reference the same attempt
  if (lease.attemptId !== attempt.id) return err("ATTEMPT_MISMATCH");

  // 6–8. Generation and status checks (X3-1):
  //
  //  "attempt" (final) artifacts: require lease.generation === claimed.generation
  //  === attempt.currentGeneration. A container must not promote a final artifact
  //  for a generation other than the one its lease was issued for.
  //
  //  "checkpoint" artifacts and stop evidence: require lease.generation ===
  //  claimed.generation (so an old token cannot poison a future generation) and
  //  claimed.generation <= attempt.currentGeneration (allow superseded checkpoints
  //  from a container still uploading after a stop-induced generation advance).
  if (claimed.kind === "attempt") {
    // 6a. Lease must be for the same generation the container claims.
    if (claimed.generation !== lease.generation) return err("LEASE_GENERATION_MISMATCH");
    // 6b–7. Claimed generation must equal the attempt's current generation.
    if (claimed.generation < attempt.currentGeneration) return err("STALE_GENERATION");
    if (claimed.generation > attempt.currentGeneration) return err("FUTURE_GENERATION");
  } else {
    // 6a. Checkpoint: claimed generation must match the lease's generation.
    if (claimed.generation !== lease.generation) return err("STALE_GENERATION");
    // 6b. Checkpoint generation must not exceed the attempt's current generation.
    if (claimed.generation > attempt.currentGeneration) return err("FUTURE_GENERATION");
  }

  // 8. Attempt must not be in a strictly terminal state (completed/quarantined/failed).
  if (STRICTLY_TERMINAL_STATUSES.has(attempt.status)) return err("ATTEMPT_TERMINAL");

  // 8b. Attempts in stopping/stopped/uncertain accept only checkpoint uploads,
  //     not final "attempt" artifacts (those would advance the generation record).
  if (STOPPING_STATUSES.has(attempt.status) && claimed.kind === "attempt") {
    return err("ATTEMPT_TERMINAL");
  }

  // 9. Bundle size must not exceed limit
  if (claimed.bundleBytes > limits.maxBundleBytes) return err("BUNDLE_TOO_LARGE");

  // 10. Changed paths must be safe
  // Checkpoints may have zero changed paths (D3: a zero-change checkpoint is valid).
  const pathResult = validateChangedPaths(claimed.changedPaths, {
    allowEmpty: claimed.kind === "checkpoint",
  });
  if (!pathResult.ok) return err("PATH_UNSAFE");

  // 11. Commit must be present in the mirror
  if (!mirror.hasCommit(claimed.commitId)) return err("COMMIT_NOT_IN_MIRROR");

  // 12. Recomputed digest must match claimed digest
  if (mirror.recomputedDiffDigest === null || mirror.recomputedDiffDigest !== claimed.diffDigest) {
    return err("DIGEST_MISMATCH");
  }

  return ok(true as const);
}
