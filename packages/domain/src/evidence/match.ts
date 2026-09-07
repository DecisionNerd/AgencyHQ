/**
 * Evidence matching functions for the domain acceptance gate.
 *
 * Every field is compared with exact (===) equality.  A mismatch on any field
 * is collected and returned; the caller can inspect each independently.
 *
 * R-018: An Approval or Review recorded against a different contract version
 * can never match the current version, because the digests that identify the
 * criteria and profile are version-specific.
 */

import type { StepContract, VerificationResult } from "@agencyhq/contracts";
import type { ApprovalLike, ArtifactLike, AttemptLike, ReviewLike } from "./types.ts";

// ---------------------------------------------------------------------------
// verificationResultRef
// Stable string identifier for a VerificationResult.  Used as the ref value
// when an AcceptanceProposal cites a verification-result evidence entry.
// ---------------------------------------------------------------------------
export function verificationResultRef(r: VerificationResult): string {
  return `${r.verifier.name}:${r.checkId}:${r.attemptRevision}`;
}

// ---------------------------------------------------------------------------
// verificationMatches
// ---------------------------------------------------------------------------
export type VerificationMismatchField =
  | "criteriaDigest"
  | "profileDigest"
  | "baseRevision"
  | "attemptRevision"
  | "diffDigest"
  | "stepContractId"
  | "attemptId";

export function verificationMatches(
  result: VerificationResult,
  contract: StepContract,
  attempt: AttemptLike,
  artifact: ArtifactLike,
): { ok: true } | { ok: false; mismatches: VerificationMismatchField[] } {
  const mismatches: VerificationMismatchField[] = [];

  if (result.criteriaDigest !== contract.criteriaDigest) mismatches.push("criteriaDigest");
  if (result.profileDigest !== contract.profileDigest) mismatches.push("profileDigest");
  if (result.baseRevision !== contract.baseRevision) mismatches.push("baseRevision");
  if (result.attemptRevision !== artifact.revision) mismatches.push("attemptRevision");
  if (result.diffDigest !== artifact.diffDigest) mismatches.push("diffDigest");
  if (result.stepContractId !== contract.id) mismatches.push("stepContractId");
  if (result.attemptId !== attempt.id) mismatches.push("attemptId");

  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// reviewMatches
// ---------------------------------------------------------------------------
export type ReviewMismatchField =
  | "attemptRevision"
  | "diffDigest"
  | "criteriaDigest"
  | "profileDigest";

export function reviewMatches(
  review: ReviewLike,
  contract: StepContract,
  artifact: ArtifactLike,
): { ok: true } | { ok: false; mismatches: ReviewMismatchField[] } {
  const mismatches: ReviewMismatchField[] = [];

  if (review.attemptRevision !== artifact.revision) mismatches.push("attemptRevision");
  if (review.diffDigest !== artifact.diffDigest) mismatches.push("diffDigest");
  if (review.criteriaDigest !== contract.criteriaDigest) mismatches.push("criteriaDigest");
  if (review.profileDigest !== contract.profileDigest) mismatches.push("profileDigest");

  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// approvalMatches
// R-018: An Approval is bound to the exact contractId + contractVersion.
// If the approval carries attemptRevision it must also match artifact.revision.
// ---------------------------------------------------------------------------
export type ApprovalMismatchField = "contractId" | "contractVersion" | "attemptRevision";

export function approvalMatches(
  approval: ApprovalLike,
  contract: StepContract,
  artifact: ArtifactLike,
): { ok: true } | { ok: false; mismatches: ApprovalMismatchField[] } {
  const mismatches: ApprovalMismatchField[] = [];

  if (approval.contractId !== contract.id) mismatches.push("contractId");
  if (approval.contractVersion !== contract.version) mismatches.push("contractVersion");
  if (approval.attemptRevision !== undefined && approval.attemptRevision !== artifact.revision) {
    mismatches.push("attemptRevision");
  }

  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true };
}
