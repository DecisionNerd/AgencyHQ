/**
 * approveWorkItem command — human approval for a humanRequired contract.
 *
 * Sequence:
 *  1. Claim the command slot (idempotency).
 *  2. Load the pending accept decision (outcome=pending_human) for workItemId.
 *     If none → state_mismatch.
 *  3. Load the stored AcceptanceProposal from the lead.accept run observation.
 *  4. Re-run acceptance via evaluateAcceptanceForAttempt (shared with onAcceptFinal)
 *     supplying the human Approval.
 *  5a. On ok: commit approvals row + decisions(approved) + work_item completed
 *      + transition audit in one transaction.
 *  5b. On APPROVAL_VERSION_MISMATCH: commit decisions(rejected) + transition,
 *      leave work item pending_human.
 *  6. completeCommand with the result.
 *
 * INVARIANTS: R-001 (acceptance evaluated by domain), R-010 (idempotent by commandId).
 */

import { randomUUID } from "node:crypto";

import { AcceptanceProposalSchema, TASK_IDS } from "@agencyhq/contracts";
import { claimCommand, completeCommand, insertApproval, insertTransition } from "@agencyhq/db";
import type { AcceptanceFailureReason, ApprovalLike } from "@agencyhq/domain";

import type { AcceptanceEvalContext } from "../flow/bounded-repair.ts";
import { evaluateAcceptanceForAttempt } from "../flow/bounded-repair.ts";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Extended deps: CommandDeps with optional workerModel for evaluateAcceptanceForAttempt.
 * When workerModel is absent (e.g. in unit tests that do not exercise approve) it
 * falls back to "" which is safe for humanRequired re-evaluation because the review
 * checks already passed before the item reached pending_human.
 */
export type ApproveDeps = Omit<CommandDeps, "config"> & {
  config?: { workerModel?: string; uncertainAfterMs?: number };
};

export type ApproveWorkItemInput = {
  commandId: string;
  workItemId: string;
  contractId: string;
  contractVersion: number;
  attemptRevision: string;
  actor: string;
};

export type ApproveWorkItemResult =
  | { ok: true; decisionId: string; artifactRevision: string; replayed?: boolean }
  | { ok: false; reason: "state_mismatch"; replayed?: boolean }
  | {
      ok: false;
      reason: "APPROVAL_VERSION_MISMATCH";
      reasons: AcceptanceFailureReason[];
      replayed?: boolean;
    };

// ---------------------------------------------------------------------------
// approveWorkItem
// ---------------------------------------------------------------------------

export async function approveWorkItem(
  deps: ApproveDeps,
  input: ApproveWorkItemInput,
): Promise<ApproveWorkItemResult> {
  const { commandId, workItemId, contractId, contractVersion, attemptRevision, actor } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim command slot (idempotency).
    const claim = await claimCommand(client, commandId, "approve");
    if (!claim.claimed) {
      const stored = claim.result as ApproveWorkItemResult;
      return { ...stored, replayed: true };
    }

    // 2. Load the pending accept decision for this work item.
    const { rows: decisionRows } = await client.query<{ id: string; attempt_id: string | null }>(
      `SELECT id, attempt_id FROM decisions
       WHERE work_item_id = $1 AND kind = 'accept' AND outcome = 'pending_human'
       ORDER BY at DESC LIMIT 1`,
      [workItemId],
    );

    const pendingDecision = decisionRows[0];
    if (!pendingDecision?.attempt_id) {
      const result: ApproveWorkItemResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const attemptId = pendingDecision.attempt_id;

    // 3. Load the stored AcceptanceProposal from the lead.accept run observation.
    const { rows: intentRows } = await client.query<{ run_id: string | null }>(
      `SELECT run_id FROM dispatch_intents
       WHERE attempt_id = $1 AND task = $2
       ORDER BY created_at DESC LIMIT 1`,
      [attemptId, TASK_IDS.leadAccept],
    );

    const intentRow = intentRows[0];
    if (!intentRow?.run_id) {
      // No lead.accept run found — cannot recover the proposal.
      const result: ApproveWorkItemResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const { rows: obsRows } = await client.query<{ payload: unknown }>(
      `SELECT payload FROM run_observations
       WHERE run_id = $1 AND stale = false
       ORDER BY generation DESC LIMIT 1`,
      [intentRow.run_id],
    );

    // run_observations.payload is the full RunObservation JSON; output is inside it.
    let obsPayload = obsRows[0]?.payload as { output?: unknown } | undefined;
    if (obsPayload === undefined) {
      // Ledger has no row for this run (observed 2026-09-08 on a ledger
      // written before the reconciler recorded Lead observations): read the
      // run's final output from the runtime instead. The acceptance rule
      // still decides; this only recovers the proposal text.
      try {
        const live = await deps.runtime.retrieve(intentRow.run_id);
        obsPayload = { output: live.output };
      } catch {
        obsPayload = undefined;
      }
    }
    const proposalResult = AcceptanceProposalSchema.safeParse(obsPayload?.output);
    if (!proposalResult.success) {
      // Stored observation missing a valid proposal.
      const result: ApproveWorkItemResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }
    const proposal = proposalResult.data;

    // 4. Re-run acceptance with the supplied human Approval.
    const approval: ApprovalLike = { contractId, contractVersion, attemptRevision };
    // workerModel defaults to "" when not configured; safe for pending_human items
    // (review checks already passed before the item was parked).
    const evalConfig = { workerModel: deps.config?.workerModel ?? "" };
    let ctx: AcceptanceEvalContext;
    try {
      ctx = await evaluateAcceptanceForAttempt(
        deps.pool,
        evalConfig,
        attemptId,
        proposal,
        approval,
      );
    } catch (_evalErr) {
      // If we cannot evaluate (e.g. missing data), treat as state_mismatch.
      const result: ApproveWorkItemResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const at = new Date();

    if (ctx.acceptResult.ok) {
      // 5a. Success: commit approvals + decision(approved) + complete work item + transition.
      const decisionId = randomUUID();
      const approvalId = randomUUID();

      await client.query("BEGIN");
      try {
        // Insert the approved decision (kind=accept, actor=human, outcome=approved).
        await client.query(
          `INSERT INTO decisions
             (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id,
              causation_id, command_id, outcome, at)
           VALUES ($1, 'accept', 'human', $2, $3, $4, $5, $6, $6, 'approved', $7)`,
          [
            decisionId,
            ctx.workItemId,
            ctx.contractId,
            ctx.contractVersion,
            ctx.attemptId,
            commandId,
            at,
          ],
        );

        // Insert the approval row linking to the approved decision.
        await insertApproval(client, {
          id: approvalId,
          decision_id: decisionId,
          contract_id: ctx.contractId,
          contract_version: ctx.contractVersion,
          attempt_revision: attemptRevision,
          human_actor: actor,
          at,
        });

        // Complete the work item at the artifact boundary (same as non-humanRequired path).
        await client.query(
          `UPDATE work_items
           SET lifecycle = 'completed', boundary = 'artifact',
               version = version + 1, updated_at = now()
           WHERE id = $1`,
          [ctx.workItemId],
        );

        // Transition audit row.
        await insertTransition(client, {
          aggregate: "work_item",
          aggregate_id: ctx.workItemId,
          from_state: "active",
          to_state: "completed",
          actor: "human",
          causation_id: commandId,
          command_id: commandId,
        });

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      const result: ApproveWorkItemResult = {
        ok: true,
        decisionId,
        artifactRevision: ctx.artifactRevision,
      };
      await completeCommand(client, commandId, result);
      return result;
    } else {
      // 5b. Approval mismatch: record rejection, leave item pending_human.
      const decisionId = randomUUID();
      const reasons = ctx.acceptResult.reasons;

      await client.query("BEGIN");
      try {
        // Insert rejection decision (outcome=rejected).
        await client.query(
          `INSERT INTO decisions
             (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id,
              causation_id, command_id, outcome, at)
           VALUES ($1, 'accept', 'human', $2, $3, $4, $5, $6, $6, 'rejected', $7)`,
          [
            decisionId,
            ctx.workItemId,
            ctx.contractId,
            ctx.contractVersion,
            ctx.attemptId,
            commandId,
            at,
          ],
        );

        // Transition audit row (item stays in active/pending_human).
        await insertTransition(client, {
          aggregate: "work_item",
          aggregate_id: ctx.workItemId,
          from_state: "active",
          to_state: "active",
          actor: "human",
          causation_id: commandId,
          command_id: commandId,
        });

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      const result: ApproveWorkItemResult = {
        ok: false,
        reason: "APPROVAL_VERSION_MISMATCH",
        reasons,
      };
      await completeCommand(client, commandId, result);
      return result;
    }
  } finally {
    client.release();
  }
}
