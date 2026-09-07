/**
 * Structural input types for the evidence subsystem.
 *
 * Contracts types (StepContract, VerificationResult, ReviewOutput,
 * AcceptanceProposal, Criterion, Digest, ReviewProfile) are re-exported
 * from @agencyhq/contracts.  Only minimal local shapes are defined here.
 */

import type { Digest, ReviewProfile } from "@agencyhq/contracts";

// Re-export contracts types used across the evidence module.
export type {
  AcceptanceProposal,
  Criterion,
  Digest,
  ReviewOutput,
  ReviewProfile,
  StepContract,
  VerificationResult,
} from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// ArtifactLike
// Minimal representation of an artifact from a completed worker attempt.
// ---------------------------------------------------------------------------
export interface ArtifactLike {
  /** The git revision (commit sha) produced by the attempt. */
  revision: string;
  /** SHA-256 digest of the diff relative to the base revision. */
  diffDigest: Digest;
  /** Repo-relative paths changed in the diff. */
  changedPaths: string[];
}

// ---------------------------------------------------------------------------
// AttemptLike
// Minimal representation of a worker attempt.
// ---------------------------------------------------------------------------
export interface AttemptLike {
  /** Stable attempt identifier. */
  id: string;
  /** Contract this attempt executes under. */
  contractId: string;
  /** Version of the contract at dispatch time. */
  contractVersion: number;
  /** Monotonic generation counter (incremented on stop/revoke). */
  generation: number;
}

// ---------------------------------------------------------------------------
// ApprovalLike
// Minimal representation of a human Approval decision.
// R-018: an Approval on another version never matches.
// ---------------------------------------------------------------------------
export interface ApprovalLike {
  /** Contract the approval was recorded against. */
  contractId: string;
  /** Version of the contract the approval was recorded against. */
  contractVersion: number;
  /** Attempt revision the approval is bound to, when present. */
  attemptRevision?: string | undefined;
}

// ---------------------------------------------------------------------------
// FindingLike
// Minimal representation of a review or integrity finding.
// ---------------------------------------------------------------------------
export interface FindingLike {
  id: string;
  severity: "blocking" | "non_blocking";
  kind: string;
  description: string;
  evidence: string;
  disposition?: string | undefined;
}

// ---------------------------------------------------------------------------
// ReviewLike
// Minimal representation of a completed review.
// ---------------------------------------------------------------------------
export interface ReviewLike {
  attemptRevision: string;
  diffDigest: Digest;
  criteriaDigest: Digest;
  profileDigest: Digest;
  /** Model identifier used by the reviewer. */
  reviewerModel: string;
  profile: ReviewProfile;
  findings: FindingLike[];
}
