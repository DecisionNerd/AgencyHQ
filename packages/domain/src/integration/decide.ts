/**
 * Pure decision function for integration outcome resolution.
 *
 * The coordinator calls this function in two situations:
 *
 * 1. `kind: "output"` — the integration Trigger task completed (COMPLETED
 *    status) and returned a structured output.  The output's `outcome` field
 *    drives the decision.
 *
 * 2. `kind: "observed"` — the Trigger task ended in a non-COMPLETED state
 *    (cancelled, failed, timed-out, etc.).  The coordinator has read the
 *    target ref's current revision from the remote and determined whether the
 *    revision produced by the attempt is reachable from it.
 *
 * Decision rules
 * ──────────────
 * Output path (kind = "output"):
 *   • outcome = "integrated" | "already_integrated"  → completed
 *   • outcome = "base_moved" | "conflict" | "push_rejected"  → escalate
 *
 * Observed path (kind = "observed"):
 *   • containsAttempt = true  → completed (integration succeeded despite
 *     the abnormal Trigger status)
 *   • observedTargetRevision === expectedBaseRevision  → retry_cas (nothing
 *     changed on the remote; safe to retry the compare-and-set)
 *   • otherwise (remote moved to a different revision)  → escalate base_moved
 *
 * Property: retry_cas is NEVER returned when observedTargetRevision ≠
 * expectedBaseRevision.
 *
 * See: docs/engineering/EXECUTION_MODEL.md — "unknown integration outcome"
 * See: docs/REQUIREMENTS.md R-015
 */

import type { IntegrateOutcome } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Local structural type (shape-compatible with contracts IntegrateMergeOutputSchema)
//
// When the contracts packet lands, replace this with an import and remove the
// local definition — field names match by design.
// ---------------------------------------------------------------------------

/**
 * Output produced by a completed integration Trigger task.
 * Shape-compatible with contracts IntegrateMergeOutputSchema.
 */
export type IntegrateMergeOutput = {
  readonly outcome: IntegrateOutcome;
  /**
   * The revision that resulted from integration.
   * Non-null when outcome is "integrated" or "already_integrated"; null for
   * failure outcomes.
   */
  readonly resultRevision: string | null;
};

// ---------------------------------------------------------------------------
// Input discriminated union
// ---------------------------------------------------------------------------

export type DecideIntegrationInput =
  | {
      readonly kind: "output";
      /** Structured output from a COMPLETED integration task. */
      readonly output: IntegrateMergeOutput;
    }
  | {
      readonly kind: "observed";
      /**
       * The revision the coordinator observed on the target ref after the
       * integration task ended in a non-COMPLETED state.
       */
      readonly observedTargetRevision: string;
      /**
       * The revision the coordinator expected to find on the target ref before
       * the integration attempt started (the compare-and-set base).
       */
      readonly expectedBaseRevision: string;
      /** The revision produced by the integration attempt. */
      readonly attemptRevision: string;
      /**
       * True when `observedTargetRevision` contains (is reachable from)
       * `attemptRevision`, i.e. the push succeeded despite the abnormal status.
       */
      readonly containsAttempt: boolean;
    };

// ---------------------------------------------------------------------------
// Output discriminated union
// ---------------------------------------------------------------------------

export type DecideIntegrationResult =
  | {
      readonly decision: "completed";
      /** The revision that now represents the integrated state of the target ref. */
      readonly resultingRevision: string;
    }
  | {
      readonly decision: "retry_cas";
    }
  | {
      readonly decision: "escalate";
      /**
       * Machine-readable escalation reason.  Mirrors IntegrateOutcome values
       * for the failure cases.
       */
      readonly reason: "base_moved" | "conflict" | "push_rejected";
    };

// ---------------------------------------------------------------------------
// decideIntegrationOutcome
// ---------------------------------------------------------------------------

/**
 * Deterministic, pure decision function for integration outcome resolution.
 *
 * See module-level docstring for the full rule set.
 */
export function decideIntegrationOutcome(input: DecideIntegrationInput): DecideIntegrationResult {
  if (input.kind === "output") {
    const { outcome, resultRevision } = input.output;

    switch (outcome) {
      case "integrated":
      case "already_integrated":
        return {
          decision: "completed",
          resultingRevision: resultRevision as string,
        };

      case "base_moved":
        return { decision: "escalate", reason: "base_moved" };

      case "conflict":
        return { decision: "escalate", reason: "conflict" };

      case "push_rejected":
        return { decision: "escalate", reason: "push_rejected" };
    }
  }

  // kind === "observed"
  const { observedTargetRevision, expectedBaseRevision, containsAttempt } = input;

  if (containsAttempt) {
    return { decision: "completed", resultingRevision: observedTargetRevision };
  }

  if (observedTargetRevision === expectedBaseRevision) {
    return { decision: "retry_cas" };
  }

  // Target moved to something other than the expected base and does not
  // contain the attempt revision — concurrent push by someone else.
  return { decision: "escalate", reason: "base_moved" };
}
