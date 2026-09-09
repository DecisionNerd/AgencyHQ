/**
 * Stop-evidence admission validator.
 *
 * validateStopEvidenceAdmission checks all preconditions before the coordinator
 * accepts stop-sequence evidence uploaded by a worker container on graceful shutdown.
 *
 * Returns Ok(true) on success or Err(code) for the first failing condition.
 * Order-stable — deterministic first-failing-code semantics.
 *
 * Pure function — no I/O, no external dependencies beyond result.ts.
 */

import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export type StopEvidenceAdmissionCode =
  | "LEASE_MISSING"
  | "LEASE_REVOKED"
  | "LEASE_EXPIRED"
  | "LEASE_PURPOSE_MISMATCH"
  | "ATTEMPT_MISMATCH"
  | "GENERATION_MISMATCH"
  | "STEPS_EMPTY"
  | "STEPS_TOO_MANY";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface StopEvidenceLeaseInfo {
  purpose: string;
  attemptId: string;
  generation: number;
  expiresAt: string; // ISO 8601
  revokedAt?: string | null;
}

export interface StopEvidenceStep {
  at: string;
  step: string;
  detail?: string;
}

export interface StopEvidenceAttempt {
  id: string;
  currentGeneration: number;
}

export interface StopEvidenceAdmissionInput {
  attemptId: string;
  generation: number;
  steps: readonly StopEvidenceStep[];
  lease: StopEvidenceLeaseInfo | null;
  attempt: StopEvidenceAttempt;
  now: string; // ISO 8601
}

const MAX_STEPS = 200;

// ---------------------------------------------------------------------------
// validateStopEvidenceAdmission
// ---------------------------------------------------------------------------

/**
 * Validate a stop-evidence upload submission.
 *
 * Checks are ordered; the first failing code is returned (fail-fast, deterministic).
 */
export function validateStopEvidenceAdmission(
  input: StopEvidenceAdmissionInput,
): Result<true, StopEvidenceAdmissionCode> {
  const { attemptId, generation, steps, lease, attempt, now } = input;

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

  // 6. Generation must match exactly (not stale, not future)
  if (generation !== attempt.currentGeneration) return err("GENERATION_MISMATCH");

  // 7. Steps must not be empty
  if (steps.length === 0) return err("STEPS_EMPTY");

  // 8. Steps must not exceed maximum
  if (steps.length > MAX_STEPS) return err("STEPS_TOO_MANY");

  return ok(true as const);
}
