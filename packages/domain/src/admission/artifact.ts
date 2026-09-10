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

const TERMINAL_STATUSES = new Set(["completed", "quarantined", "failed", "stopped"]);

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

  // 6–7. Generation check (E1 / X2-1):
  //  - "attempt" (final) artifacts: generation must equal attempt.currentGeneration.
  //  - "checkpoint" artifacts: generation must equal the lease's generation so
  //    that a container can still upload a checkpoint after an operator stop bumped
  //    the generation and revoked provider/integrate leases (upload leases are kept).
  if (claimed.kind === "attempt") {
    if (claimed.generation < attempt.currentGeneration) return err("STALE_GENERATION");
    if (claimed.generation > attempt.currentGeneration) return err("FUTURE_GENERATION");
  } else {
    // checkpoint: must match the lease generation (the lease was issued for that gen)
    if (claimed.generation !== lease.generation) return err("STALE_GENERATION");
  }

  // 8. Attempt must not be in a terminal state
  if (TERMINAL_STATUSES.has(attempt.status)) return err("ATTEMPT_TERMINAL");

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
