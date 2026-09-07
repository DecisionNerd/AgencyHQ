/**
 * Acceptance evaluation for the domain gate.
 *
 * Evaluates ALL acceptance conditions and collects every failure reason
 * before returning.  A caller may inspect the full list of reasons rather
 * than seeing only the first failure.
 *
 * INVARIANT (R-014): The worker's report of what it executed is never an
 * input to acceptance.  The WorkerReport's run summary is context, not
 * evidence.  The parameter list is structured to make supplying it impossible:
 * only VerificationResults from verify.run are accepted.
 *
 * See: docs/engineering/TESTING.md §43-49 (completion rule), §51-65 (review
 * ladder), docs/REQUIREMENTS.md R-006, R-014, R-018.
 */

import type { AcceptanceProposal, StepContract, VerificationResult } from "@agencyhq/contracts";
import { reviewProfileAtLeast } from "@agencyhq/contracts";
import {
  approvalMatches,
  reviewMatches,
  verificationMatches,
  verificationResultRef,
} from "./match.ts";
import type { ApprovalLike, ArtifactLike, AttemptLike, ReviewLike } from "./types.ts";

// ---------------------------------------------------------------------------
// AcceptanceReason
// ---------------------------------------------------------------------------
export type AcceptanceReason =
  | "CRITERION_UNCITED"
  | "CITED_RESULT_NOT_PASSING"
  | "CITED_RESULT_MISSING"
  | "RESULT_VERSION_MISMATCH"
  | "REVIEW_MISSING"
  | "REVIEW_VERSION_MISMATCH"
  | "REVIEW_BLOCKING"
  | "REVIEW_BELOW_REQUIRED"
  | "REVIEWER_NOT_DISTINCT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_VERSION_MISMATCH"
  | "PROPOSAL_REJECTS"
  | "CRITERION_UNSATISFIED";

export interface AcceptanceFailureReason {
  code: AcceptanceReason;
  detail: string;
}

// ---------------------------------------------------------------------------
// evaluateAcceptance input
// NOTE: WorkerReport run summaries are intentionally absent from this input —
// acceptance is governed solely by VerificationResults from verify.run, not
// by anything the worker claims about its own execution.
// ---------------------------------------------------------------------------
export interface EvaluateAcceptanceInput {
  contract: StepContract;
  attempt: AttemptLike;
  artifact: ArtifactLike;
  results: VerificationResult[];
  review?: ReviewLike | undefined;
  proposal: AcceptanceProposal;
  approval?: ApprovalLike | undefined;
  /** Whether the reviewer must be a different session/model than the worker. */
  reviewerMustDiffer: boolean;
  /** Model identifier used by the worker. */
  workerModel: string;
}

// ---------------------------------------------------------------------------
// evaluateAcceptance
// ---------------------------------------------------------------------------
export function evaluateAcceptance(
  input: EvaluateAcceptanceInput,
): { ok: true } | { ok: false; reasons: AcceptanceFailureReason[] } {
  const {
    contract,
    attempt,
    artifact,
    results,
    review,
    proposal,
    approval,
    reviewerMustDiffer,
    workerModel,
  } = input;

  const reasons: AcceptanceFailureReason[] = [];

  // 1. Proposal-level: accept must be true.
  if (!proposal.accept) {
    reasons.push({ code: "PROPOSAL_REJECTS", detail: "Proposal.accept is false." });
  }

  // Build a lookup map from ref → VerificationResult for O(1) access.
  const resultByRef = new Map<string, VerificationResult>();
  for (const r of results) {
    resultByRef.set(verificationResultRef(r), r);
  }

  // Build a lookup map from criterionId → proposal criterion entry.
  const proposalCriteriaById = new Map<string, (typeof proposal.criteria)[number]>();
  for (const pc of proposal.criteria) {
    proposalCriteriaById.set(pc.criterionId, pc);
  }

  // 2. Every contract criterion must appear in the proposal.
  for (const criterion of contract.criteria) {
    const pc = proposalCriteriaById.get(criterion.id);

    if (pc === undefined) {
      reasons.push({
        code: "CRITERION_UNCITED",
        detail: `Criterion "${criterion.id}" is not cited in the proposal.`,
      });
      continue;
    }

    if (!pc.satisfied) {
      reasons.push({
        code: "CRITERION_UNSATISFIED",
        detail: `Criterion "${criterion.id}" is marked not satisfied.`,
      });
    }

    // 3. Validate each evidence reference.
    for (const ev of pc.evidence) {
      if (ev.kind !== "verification_result") continue;

      const ref = ev.ref;
      const r = resultByRef.get(ref);

      if (r === undefined) {
        reasons.push({
          code: "CITED_RESULT_MISSING",
          detail: `Evidence ref "${ref}" for criterion "${criterion.id}" does not match any VerificationResult.`,
        });
        continue;
      }

      const match = verificationMatches(r, contract, attempt, artifact);
      if (!match.ok) {
        reasons.push({
          code: "RESULT_VERSION_MISMATCH",
          detail: `VerificationResult "${ref}" for criterion "${criterion.id}" has version mismatches: ${match.mismatches.join(", ")}.`,
        });
        // Still check pass/fail so we surface both problems.
      }

      if (r.result !== "pass") {
        reasons.push({
          code: "CITED_RESULT_NOT_PASSING",
          detail: `VerificationResult "${ref}" for criterion "${criterion.id}" has result "${r.result}", expected "pass".`,
        });
      }
    }
  }

  // 4. Review checks.
  const reviewRequired = contract.bounds.review !== "none";
  if (reviewRequired) {
    if (review === undefined) {
      reasons.push({
        code: "REVIEW_MISSING",
        detail: `Contract requires review profile "${contract.bounds.review}" but no Review was supplied.`,
      });
    } else {
      // Version match.
      const rm = reviewMatches(review, contract, artifact);
      if (!rm.ok) {
        reasons.push({
          code: "REVIEW_VERSION_MISMATCH",
          detail: `Review has version mismatches: ${rm.mismatches.join(", ")}.`,
        });
      }

      // Blocking findings block regardless of disposition.
      const blockingFindings = review.findings.filter((f) => f.severity === "blocking");
      if (blockingFindings.length > 0) {
        reasons.push({
          code: "REVIEW_BLOCKING",
          detail: `Review has ${blockingFindings.length} blocking finding(s): ${blockingFindings.map((f) => f.id).join(", ")}.`,
        });
      }

      // Profile must meet the contract minimum.
      if (!reviewProfileAtLeast(review.profile, contract.bounds.review)) {
        reasons.push({
          code: "REVIEW_BELOW_REQUIRED",
          detail: `Review profile "${review.profile}" is below required "${contract.bounds.review}".`,
        });
      }

      // Reviewer must differ from worker when required.
      const mustDiffer =
        reviewerMustDiffer || contract.bounds.review === "adversarial_distinct_model";
      if (mustDiffer && review.reviewerModel === workerModel) {
        reasons.push({
          code: "REVIEWER_NOT_DISTINCT",
          detail: `Reviewer model "${review.reviewerModel}" must differ from worker model "${workerModel}".`,
        });
      }
    }
  }

  // 5. Human approval gate (R-006).
  if (contract.humanRequired) {
    if (approval === undefined) {
      reasons.push({
        code: "APPROVAL_REQUIRED",
        detail: "Contract requires humanRequired Approval but none was supplied.",
      });
    } else {
      const am = approvalMatches(approval, contract, artifact);
      if (!am.ok) {
        reasons.push({
          code: "APPROVAL_VERSION_MISMATCH",
          detail: `Approval has version mismatches: ${am.mismatches.join(", ")}.`,
        });
      }
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true };
}
