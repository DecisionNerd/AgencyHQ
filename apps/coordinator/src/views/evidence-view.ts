/**
 * Work-item evidence view: artifacts, verification results, reviews, findings
 * with dispositions, decisions, approvals, integrations, manifest rows, and
 * attempts with run ids.
 *
 * R-011: contract, execution, verification, and acceptance states shown
 *        distinctly with source and timestamp.
 * DESIGN.md: evidence view joining attempt revisions/diffs, VerificationResults,
 *            Reviews, Findings, Decisions, and exact-version Approvals.
 *
 * Pure builder — no database access.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type EvidenceArtifactLike = {
  id: string;
  attemptId: string;
  revision: string;
  diffDigest: string;
  changedPaths?: unknown;
  updatedAt: string;
};

export type EvidenceVerificationResultLike = {
  id: string;
  attemptId: string;
  stepContractId: string;
  result: string;
  updatedAt: string;
};

export type EvidenceReviewLike = {
  id: string;
  attemptId: string;
  attemptRevision?: string | null;
  diffDigest?: string | null;
  updatedAt: string;
};

export type EvidenceFindingLike = {
  id: string;
  attemptId?: string | null;
  severity: string;
  kind: string;
  description?: string;
  evidence?: string | null;
  disposition?: string | null;
  updatedAt: string;
};

export type EvidenceDecisionLike = {
  id: string;
  kind: string;
  actor: string;
  outcome: string | null;
  reason?: string | null;
  contractVersion?: number | null;
  attemptId?: string | null;
  at: string;
};

export type EvidenceApprovalLike = {
  id: string;
  decisionId: string;
  contractId?: string | null;
  contractVersion?: number | null;
  attemptRevision?: string | null;
  humanActor?: string | null;
  at?: string | null;
};

export type EvidenceIntegrationLike = {
  id: string;
  attemptId: string;
  targetRef: string;
  outcome?: string | null;
  resultingRevision?: string | null;
  at: string;
};

export type EvidenceManifestRowLike = {
  workItemId: string;
  position: number;
  resultRevision?: string | null;
};

export type EvidenceAttemptLike = {
  id: string;
  contractId: string;
  status: string;
  runId?: string | null;
  checkpointCommit?: string | null;
  commitSha?: string | null;
  updatedAt: string;
};

export type EvidenceViewInput = {
  workItemId: string;
  artifacts: EvidenceArtifactLike[];
  verificationResults: EvidenceVerificationResultLike[];
  reviews: EvidenceReviewLike[];
  findings: EvidenceFindingLike[];
  decisions: EvidenceDecisionLike[];
  approvals: EvidenceApprovalLike[];
  integrations: EvidenceIntegrationLike[];
  manifestRows: EvidenceManifestRowLike[];
  attempts: EvidenceAttemptLike[];
};

// ---------------------------------------------------------------------------
// Output types (mirrors input shapes, mapped for camelCase consistency)
// ---------------------------------------------------------------------------

export type EvidenceView = {
  workItemId: string;
  artifacts: EvidenceArtifactLike[];
  verificationResults: EvidenceVerificationResultLike[];
  reviews: EvidenceReviewLike[];
  findings: EvidenceFindingLike[];
  decisions: EvidenceDecisionLike[];
  approvals: EvidenceApprovalLike[];
  integrations: EvidenceIntegrationLike[];
  manifestRows: EvidenceManifestRowLike[];
  attempts: EvidenceAttemptLike[];
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the evidence view for a single work item.
 * Pure function — no side effects.
 *
 * All input rows are expected to already be filtered to the given work item's
 * contracts/attempts. The builder assembles them into a stable structure.
 */
export function buildEvidenceView(input: EvidenceViewInput): EvidenceView {
  return {
    workItemId: input.workItemId,
    artifacts: input.artifacts,
    verificationResults: input.verificationResults,
    reviews: input.reviews,
    findings: input.findings,
    decisions: input.decisions,
    approvals: input.approvals,
    integrations: input.integrations,
    manifestRows: input.manifestRows,
    attempts: input.attempts,
  };
}
