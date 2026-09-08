/**
 * invalidateAcceptance command — invalidate a historical acceptance decision
 * and reopen the work item.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. Verify the attempt belongs to the work item and has an accepted decision.
 *     If none → state_mismatch.
 *  3. In a transaction:
 *     a. Insert a new decision of kind "invalidate" referencing the accept decision.
 *     b. Update work item lifecycle to "reopened" (no historical rows touched).
 *     c. Append a transition audit row.
 *  4. completeCommand with the result.
 *
 * INVARIANTS:
 *  - Historical accept decision row is NOT modified (R-017).
 *  - Contract row is NOT modified (R-017).
 *  - A new plan is allowed after reopening.
 *  - TESTING.md §WorkItem completion: keep the historical Decision.
 */

import { randomUUID } from "node:crypto";
import { claimCommand, completeCommand, insertDecision } from "@agencyhq/db";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvalidateAcceptanceDeps = {
  pool: pg.Pool;
};

export type InvalidateAcceptanceInput = {
  commandId: string;
  workItemId: string;
  attemptId: string;
  reason: string;
};

export type InvalidateAcceptanceResult =
  | { ok: true; invalidationDecisionId: string; replayed?: boolean }
  | { ok: false; reason: "state_mismatch" | "no_accepted_decision"; replayed?: boolean };

// ---------------------------------------------------------------------------
// invalidateAcceptance
// ---------------------------------------------------------------------------

export async function invalidateAcceptance(
  deps: InvalidateAcceptanceDeps,
  input: InvalidateAcceptanceInput,
): Promise<InvalidateAcceptanceResult> {
  const { commandId, workItemId, attemptId, reason } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim command slot (idempotency)
    const claim = await claimCommand(client, commandId, "invalidate_acceptance");
    if (!claim.claimed) {
      const stored = claim.result as InvalidateAcceptanceResult;
      return { ...stored, replayed: true };
    }

    // 2. Find the accepted decision for this attempt
    const { rows: decisionRows } = await client.query<{
      id: string;
      outcome: string | null;
      work_item_id: string | null;
    }>(
      `SELECT d.id, d.outcome, d.work_item_id
       FROM decisions d
       WHERE d.attempt_id = $1
         AND d.kind = 'accept'
         AND d.outcome IN ('approved', 'completed')
         AND d.work_item_id = $2
       ORDER BY d.at DESC
       LIMIT 1`,
      [attemptId, workItemId],
    );

    if (decisionRows.length === 0) {
      const result: InvalidateAcceptanceResult = { ok: false, reason: "no_accepted_decision" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const acceptDecision = decisionRows[0];
    if (!acceptDecision) {
      const result: InvalidateAcceptanceResult = { ok: false, reason: "no_accepted_decision" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const historicAcceptDecisionId = acceptDecision.id;
    const invalidationDecisionId = randomUUID();
    const now = new Date();

    // 3. Transaction: insert invalidation decision + update work item lifecycle
    await client.query("BEGIN");
    try {
      // Insert new invalidation decision (kind = "invalidate", references historic accept)
      await insertDecision(client, {
        id: invalidationDecisionId,
        kind: "invalidate",
        actor: "coordinator",
        work_item_id: workItemId,
        attempt_id: attemptId,
        causation_id: historicAcceptDecisionId, // references historic accept decision
        command_id: commandId,
        outcome: "invalidated",
        reason,
        at: now,
      });

      // Update work item lifecycle to reopened
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        `SELECT lifecycle FROM work_items WHERE id = $1`,
        [workItemId],
      );
      const prevLifecycle = wiRows[0]?.lifecycle ?? null;

      await client.query(
        `UPDATE work_items SET lifecycle = 'reopened', updated_at = now() WHERE id = $1`,
        [workItemId],
      );

      // Append a transition audit row
      await client.query(
        `INSERT INTO transitions
           (aggregate, aggregate_id, from_state, to_state, actor, causation_id, command_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "work_item",
          workItemId,
          prevLifecycle,
          "reopened",
          "coordinator",
          invalidationDecisionId,
          commandId,
        ],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: InvalidateAcceptanceResult = {
      ok: true,
      invalidationDecisionId,
    };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
