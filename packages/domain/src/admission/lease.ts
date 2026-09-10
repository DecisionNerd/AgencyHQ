/**
 * Lease request validator.
 *
 * validateLeaseRequest checks whether a worker container's lease request
 * should be granted or refused. Returns Ok(purpose) on success or
 * Err(reason) mapping to LeaseRefusalSchema reasons.
 *
 * Pure function — no I/O, no external dependencies beyond result.ts.
 */

import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeasePurpose = "provider" | "git-read" | "integrate" | "upload";

export type LeaseRefusalReason =
  | "login_required"
  | "expired"
  | "stale_generation"
  | "unknown_run"
  | "unknown_attempt"
  | "revoked"
  | "unavailable";

export type ProviderState = "ready" | "login_required" | "expired" | "unavailable";

export interface LeaseRequestInput {
  request: {
    runId: string;
    attemptId: string;
    generation: number;
    purpose: LeasePurpose;
    nonce: string;
  };
  /** Resolved attempt + intent context; null when the attempt is not found. */
  intent: {
    attemptId: string;
    generation: number;
    runId: string;
    status: string;
  } | null;
  /** Provider login state (relevant only for purpose === "provider"). */
  providerState: ProviderState;
  now: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// validateLeaseRequest
// ---------------------------------------------------------------------------

/**
 * Validate a lease request from a worker container.
 *
 * Decision order:
 * 1. unknown_attempt — intent not found for the requested attemptId
 * 2. unknown_run — intent.runId does not match request.runId
 * 3. stale_generation — request.generation < intent.generation
 * 4. For purpose === "provider": map providerState to refusal reason
 *
 * Returns Ok(purpose) when the request is grantable.
 */
export function validateLeaseRequest(
  input: LeaseRequestInput,
): Result<LeasePurpose, LeaseRefusalReason> {
  const { request, intent, providerState } = input;

  // 1. Attempt must exist
  if (!intent) return err("unknown_attempt");

  // 2. Run ID must match
  if (intent.runId !== request.runId) return err("unknown_run");

  // 3. Generation must not be stale
  if (request.generation < intent.generation) return err("stale_generation");

  // 4. Provider-specific checks
  if (request.purpose === "provider") {
    switch (providerState) {
      case "login_required":
        return err("login_required");
      case "expired":
        return err("expired");
      case "unavailable":
        return err("unavailable");
      case "ready":
        // fall through to grant
        break;
    }
  }

  return ok(request.purpose);
}
