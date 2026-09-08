/**
 * rejectWorkItem command — reject a pending_human decision.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. Load the pending decision (outcome = pending_human) for workItemId.
 *     If none → state_mismatch.
 *  3. In a transaction:
 *     a. Update the decision outcome to "rejected".
 *     b. Update work item lifecycle to "halted" with the reason in a transition.
 *  4. completeCommand with the result.
 *
 * INVARIANTS: R-001 (coordinator is sole acceptance authority);
 *             R-010 (idempotent by commandId).
 */

import { claimCommand, completeCommand } from "@agencyhq/db";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RejectDeps = {
  pool: pg.Pool;
};

export type RejectWorkItemInput = {
  commandId: string;
  workItemId: string;
  decisionId: string;
  reason: string;
};

export type RejectWorkItemResult =
  | { ok: true; decisionId: string; replayed?: boolean }
  | { ok: false; reason: "state_mismatch"; replayed?: boolean };

// ---------------------------------------------------------------------------
// rejectWorkItem
// ---------------------------------------------------------------------------

export async function rejectWorkItem(
  deps: RejectDeps,
  input: RejectWorkItemInput,
): Promise<RejectWorkItemResult> {
  const { commandId, workItemId, decisionId } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim command slot (idempotency)
    const claim = await claimCommand(client, commandId, "reject");
    if (!claim.claimed) {
      const stored = claim.result as RejectWorkItemResult;
      return { ...stored, replayed: true };
    }

    // 2. Load the pending decision for this work item
    const { rows: decisionRows } = await client.query<{ id: string; outcome: string | null }>(
      `SELECT id, outcome FROM decisions
       WHERE id = $1 AND work_item_id = $2 AND outcome = 'pending_human'
       LIMIT 1`,
      [decisionId, workItemId],
    );

    if (decisionRows.length === 0) {
      const result: RejectWorkItemResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }

    // 3. Transaction: update decision + work item lifecycle
    await client.query("BEGIN");
    try {
      // Update decision outcome to rejected
      await client.query(
        `UPDATE decisions SET outcome = 'rejected', updated_at = now() WHERE id = $1`,
        [decisionId],
      );

      // Update work item lifecycle to halted
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        `SELECT lifecycle FROM work_items WHERE id = $1`,
        [workItemId],
      );
      const prevLifecycle = wiRows[0]?.lifecycle ?? null;

      await client.query(
        `UPDATE work_items SET lifecycle = 'halted', updated_at = now() WHERE id = $1`,
        [workItemId],
      );

      // Append a transition audit row
      await client.query(
        `INSERT INTO transitions
           (aggregate, aggregate_id, from_state, to_state, actor, causation_id, command_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["work_item", workItemId, prevLifecycle, "halted", "coordinator", decisionId, commandId],
      );

      // Record the rejection reason in another transition note
      await client.query(
        `INSERT INTO transitions
           (aggregate, aggregate_id, from_state, to_state, actor, causation_id, command_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["decision", decisionId, "pending_human", "rejected", "coordinator", null, commandId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: RejectWorkItemResult = { ok: true, decisionId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
