/**
 * rejectWorkItem command — reject a pending_human decision.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. Load the pending decision (outcome = pending_human) for workItemId.
 *     If none → state_mismatch.
 *  3. In a transaction:
 *     a. Append a new decision (same kind, same attempt) with outcome "rejected"
 *        and the supplied reason (decisions are append-only history — R-017).
 *     b. Update work item lifecycle to "halted".
 *     c. Append a transition audit row.
 *  4. completeCommand with the result (decisionId = new appended decision's id).
 *
 * INVARIANTS: R-001 (coordinator is sole acceptance authority);
 *             R-010 (idempotent by commandId);
 *             R-017 (decisions append-only — the pending row is NOT updated).
 */

import { randomUUID } from "node:crypto";
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
  const { commandId, workItemId, decisionId, reason } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim command slot (idempotency)
    const claim = await claimCommand(client, commandId, "reject");
    if (!claim.claimed) {
      const stored = claim.result as RejectWorkItemResult;
      return { ...stored, replayed: true };
    }

    // 2. Load the pending decision for this work item (by id and outcome)
    const { rows: decisionRows } = await client.query<{
      id: string;
      kind: string | null;
      attempt_id: string | null;
      contract_id: string | null;
      contract_version: number | null;
    }>(
      `SELECT id, kind, attempt_id, contract_id, contract_version FROM decisions
       WHERE id = $1 AND work_item_id = $2 AND outcome = 'pending_human'
       LIMIT 1`,
      [decisionId, workItemId],
    );

    if (decisionRows.length === 0) {
      const result: RejectWorkItemResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const pendingDecision = decisionRows[0]!;
    const newDecisionId = randomUUID();
    const now = new Date();

    // 3. Transaction: append rejected decision + update work item lifecycle
    await client.query("BEGIN");
    try {
      // Append a new rejected decision (pending row remains as history — R-017)
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id,
            causation_id, command_id, outcome, reason, at)
         VALUES ($1, $2, 'coordinator', $3, $4, $5, $6, $7, $7, 'rejected', $8, $9)`,
        [
          newDecisionId,
          pendingDecision.kind ?? "accept",
          workItemId,
          pendingDecision.contract_id ?? null,
          pendingDecision.contract_version ?? null,
          pendingDecision.attempt_id ?? null,
          commandId,
          reason,
          now,
        ],
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
        ["work_item", workItemId, prevLifecycle, "halted", "coordinator", newDecisionId, commandId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: RejectWorkItemResult = { ok: true, decisionId: newDecisionId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
