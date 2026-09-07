/**
 * Finding disposition logic.
 *
 * R-017: Findings shall receive an owned disposition without widening the
 * contract.  This function enforces that invariant structurally: it accepts
 * the contract digest as input and returns it unchanged in `contractDigestAfter`.
 * The caller verifies equality.
 *
 * See: docs/engineering/PROCESS_CATALOG.md §finding-dispositions,
 *      docs/REQUIREMENTS.md R-017.
 */

import type { Digest } from "@agencyhq/contracts";
import type { FindingLike } from "../evidence/types.ts";

// ---------------------------------------------------------------------------
// DispositionEvent discriminated union
// ---------------------------------------------------------------------------
export type DispositionEvent =
  | {
      type: "backlog_work_item_requested";
      subject: string;
      description: string;
    }
  | {
      type: "remediation_attempt_requested";
      findingId: string;
    }
  | {
      type: "scope_decision_requested";
      findingId: string;
    }
  | {
      type: "attempt_blocked";
      findingId: string;
    }
  | {
      type: "finding_dismissed";
      findingId: string;
      reason: string;
    };

// ---------------------------------------------------------------------------
// DispositionContext
// ---------------------------------------------------------------------------
export interface DispositionContext {
  /** Digest of the StepContract — must be returned unchanged (R-017). */
  contractDigest: Digest;
  /** WorkItem that owns this finding. */
  workItemId: string;
  /** ISO 8601 timestamp of the disposition action. */
  at: string;
}

// ---------------------------------------------------------------------------
// applyDisposition
// ---------------------------------------------------------------------------
export function applyDisposition(
  finding: FindingLike,
  disposition: "backlog" | "remediate" | "scope_decision" | "block" | "dismiss",
  ctx: DispositionContext,
): {
  finding: FindingLike;
  /** The contract digest is NEVER changed by disposition (R-017). */
  contractDigestAfter: Digest;
  events: DispositionEvent[];
} {
  const events: DispositionEvent[] = [];

  switch (disposition) {
    case "backlog":
      events.push({
        type: "backlog_work_item_requested",
        subject: finding.id,
        description: finding.description,
      });
      break;

    case "remediate":
      events.push({
        type: "remediation_attempt_requested",
        findingId: finding.id,
      });
      break;

    case "scope_decision":
      events.push({
        type: "scope_decision_requested",
        findingId: finding.id,
      });
      break;

    case "block":
      events.push({
        type: "attempt_blocked",
        findingId: finding.id,
      });
      break;

    case "dismiss":
      events.push({
        type: "finding_dismissed",
        findingId: finding.id,
        reason: finding.description,
      });
      break;
  }

  // contractDigestAfter is unconditionally the input contractDigest.
  // This is the structural enforcement of R-017: disposition never touches
  // the contract.
  return {
    finding,
    contractDigestAfter: ctx.contractDigest,
    events,
  };
}
