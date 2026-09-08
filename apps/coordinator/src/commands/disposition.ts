/**
 * disposition command (R-017).
 *
 * Operator-driven disposition of a finding:
 *  - remediate:       create a new Attempt under the same contract if budget allows;
 *                     budget exhausted → pending_human decision.
 *  - scope_decision:  pending_human decision; finding noted.
 *  - block:           pending_human decision; finding noted.
 *  - backlog:         backlog decision; finding noted.
 *
 * INVARIANTS:
 *  - Decision + intent committed before trigger (R-002).
 *  - Idempotent by commandId (R-010).
 *  - Contract never mutated (R-017).
 */

import { randomUUID } from "node:crypto";
import {
  digestOf,
  permissionRulesFor,
  TASK_IDS,
  WorkerAttemptPayloadSchema,
} from "@agencyhq/contracts";
import { claimCommand, completeCommand, type createPool } from "@agencyhq/db";
import type { DispatchIntentId, FailureId } from "@agencyhq/domain";
import { newId } from "@agencyhq/domain";

type Pool = ReturnType<typeof createPool>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DispositionValue = "remediate" | "scope_decision" | "block" | "backlog";

export type DispositionInput = {
  commandId: string;
  findingId: string;
  disposition: DispositionValue;
  reason: string;
  actor: string;
};

export type DispositionResult =
  | { ok: true; outcome: "remediate"; newAttemptId: string; newIntentId: string; newRunId: string }
  | { ok: true; outcome: "pending_human"; reason: string }
  | { ok: true; outcome: "backlog" }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Minimal interfaces
// ---------------------------------------------------------------------------

interface FindingRow {
  id: string;
  attempt_id: string | null;
  severity: string;
  kind: string;
  description: string;
  disposition: string | null;
}

interface AttemptRow {
  id: string;
  contract_id: string;
  contract_version: number;
  generation: number;
  status: string;
  budget_remaining: number;
}

interface ContractRow {
  id: string;
  work_item_id: string;
  project_id: string;
  version: number;
  base_revision: string;
  bounds: import("@agencyhq/contracts").ContractBounds;
  inputs: { intent: string };
  status: string;
}

interface ProjectRow {
  id: string;
  clone_path: string | null;
}

export type DispositionDeps = {
  pool: Pool;
  runtime: {
    trigger(input: {
      intentId: string;
      task: string;
      payload: unknown;
      options: {
        idempotencyKey: string;
        maxDurationSeconds?: number;
        concurrencyKey?: string;
        tags?: string[];
      };
    }): Promise<{ runId: string }>;
  };
  /** Configuration required for remediation attempts. Optional for testing. */
  config?: {
    worktreeBase?: string;
    workerModel?: string;
  };
};

// ---------------------------------------------------------------------------
// dispositionFinding
// ---------------------------------------------------------------------------

export async function dispositionFinding(
  deps: DispositionDeps,
  input: DispositionInput,
): Promise<DispositionResult> {
  const { pool, runtime } = deps;
  const worktreeBase = deps.config?.worktreeBase ?? "/worktrees";
  const workerModel = deps.config?.workerModel ?? "";
  const { commandId, findingId, disposition, reason, actor } = input;

  const client = await pool.connect();
  try {
    const claim = await claimCommand(client, commandId, "disposition");
    if (!claim.claimed) {
      return claim.result as DispositionResult;
    }

    // Load finding
    const { rows: findingRows } = await client.query<FindingRow>(
      "SELECT * FROM findings WHERE id = $1",
      [findingId],
    );
    const findingRow = findingRows[0];
    if (!findingRow) {
      const result: DispositionResult = { ok: false, reason: `Finding ${findingId} not found` };
      await completeCommand(client, commandId, result);
      return result;
    }

    if (!findingRow.attempt_id) {
      const result: DispositionResult = {
        ok: false,
        reason: `Finding ${findingId} has no attempt_id; cannot remediate`,
      };
      await completeCommand(client, commandId, result);
      return result;
    }

    // Load attempt
    const { rows: attemptRows } = await client.query<AttemptRow>(
      "SELECT * FROM attempts WHERE id = $1",
      [findingRow.attempt_id],
    );
    const attemptRow = attemptRows[0];
    if (!attemptRow) {
      const result: DispositionResult = {
        ok: false,
        reason: `Attempt ${findingRow.attempt_id} not found`,
      };
      await completeCommand(client, commandId, result);
      return result;
    }

    // Load contract
    const { rows: contractRows } = await client.query<ContractRow>(
      "SELECT * FROM step_contracts WHERE id = $1",
      [attemptRow.contract_id],
    );
    const contractRow = contractRows[0];
    if (!contractRow) {
      const result: DispositionResult = {
        ok: false,
        reason: `Contract ${attemptRow.contract_id} not found`,
      };
      await completeCommand(client, commandId, result);
      return result;
    }

    // Load project
    const { rows: projectRows } = await client.query<ProjectRow>(
      "SELECT id, clone_path FROM projects WHERE id = $1",
      [contractRow.project_id],
    );
    const projectRow = projectRows[0];
    if (!projectRow) {
      const result: DispositionResult = {
        ok: false,
        reason: `Project ${contractRow.project_id} not found`,
      };
      await completeCommand(client, commandId, result);
      return result;
    }

    const at = new Date();

    // ---------------------------------------------------------------------------
    // backlog: record decision, update finding
    // ---------------------------------------------------------------------------
    if (disposition === "backlog") {
      await client.query("BEGIN");
      const decisionId = randomUUID();
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id, causation_id, command_id, outcome, at)
         VALUES ($1, 'disposition', $2, $3, $4, $5, $6, $7, $7, 'backlog', $8)`,
        [
          decisionId,
          actor,
          contractRow.work_item_id,
          contractRow.id,
          contractRow.version,
          attemptRow.id,
          commandId,
          at,
        ],
      );
      await client.query("UPDATE findings SET disposition = $2, updated_at = now() WHERE id = $1", [
        findingId,
        "backlog",
      ]);
      await client.query("COMMIT");
      const result: DispositionResult = { ok: true, outcome: "backlog" };
      await completeCommand(client, commandId, result);
      return result;
    }

    // ---------------------------------------------------------------------------
    // scope_decision | block: pending_human decision
    // ---------------------------------------------------------------------------
    if (disposition === "scope_decision" || disposition === "block") {
      await client.query("BEGIN");
      const decisionId = randomUUID();
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id, causation_id, command_id, outcome, at)
         VALUES ($1, 'disposition', $2, $3, $4, $5, $6, $7, $7, 'pending_human', $8)`,
        [
          decisionId,
          actor,
          contractRow.work_item_id,
          contractRow.id,
          contractRow.version,
          attemptRow.id,
          commandId,
          at,
        ],
      );
      await client.query("UPDATE findings SET disposition = $2, updated_at = now() WHERE id = $1", [
        findingId,
        disposition,
      ]);
      await client.query("COMMIT");
      const result: DispositionResult = { ok: true, outcome: "pending_human", reason };
      await completeCommand(client, commandId, result);
      return result;
    }

    // ---------------------------------------------------------------------------
    // remediate
    // ---------------------------------------------------------------------------

    // Budget check: budget_remaining > 0 allows one more attempt.
    if (attemptRow.budget_remaining <= 0) {
      // Budget exhausted → pending_human
      await client.query("BEGIN");
      const decisionId = randomUUID();
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id, causation_id, command_id, outcome, at)
         VALUES ($1, 'disposition', $2, $3, $4, $5, $6, $7, $7, 'pending_human', $8)`,
        [
          decisionId,
          actor,
          contractRow.work_item_id,
          contractRow.id,
          contractRow.version,
          attemptRow.id,
          commandId,
          at,
        ],
      );
      await client.query("UPDATE findings SET disposition = $2, updated_at = now() WHERE id = $1", [
        findingId,
        "remediate",
      ]);
      await client.query("COMMIT");
      const result: DispositionResult = {
        ok: true,
        outcome: "pending_human",
        reason: "budget exhausted",
      };
      await completeCommand(client, commandId, result);
      return result;
    }

    // Budget allows another attempt — build new worker payload.
    const newAttemptId = newId("att") as string;
    const newBudget = attemptRow.budget_remaining - 1;
    const worktreePath = `${worktreeBase}/${newAttemptId}`;

    const newWorkerPayload = WorkerAttemptPayloadSchema.parse({
      attemptId: newAttemptId,
      generation: 1,
      contractId: contractRow.id,
      contractVersion: String(contractRow.version),
      repoPath: projectRow.clone_path ?? worktreeBase,
      baseRev: contractRow.base_revision,
      prompt: contractRow.inputs?.intent ?? "",
      allowedPaths: contractRow.bounds.paths.allow,
      bounds: contractRow.bounds,
      permissionRules: permissionRulesFor(contractRow.bounds, { worktreePath }),
      model: workerModel,
      worktreeBase,
    });

    const newIntentId = newId("di") as DispatchIntentId;
    const newIntentKey = `${String(newIntentId)}:g1`;
    const remediateFailureId = newId("fail") as FailureId;
    const decisionId = randomUUID();

    // Atomic: failure row + new attempt + intent + decision + finding disposition (R-002)
    await client.query("BEGIN");

    // Record failure row for the superseded attempt (class=contract, cause=finding_id)
    await client.query(
      `INSERT INTO failures (id, class, phase, attempt_id, run_id, cause)
       VALUES ($1, 'contract', 'final', $2, NULL, $3)`,
      [String(remediateFailureId), attemptRow.id, `disposition:remediate:${findingId}`],
    );

    // Try to mark old attempt failed (guard allows non-terminal states only)
    await client.query(
      "UPDATE attempts SET status = 'failed', failure_id = $2, updated_at = now() WHERE id = $1 AND status IN ('admitted','dispatched','running')",
      [attemptRow.id, String(remediateFailureId)],
    );

    // Admit new attempt
    await client.query(
      `INSERT INTO attempts
         (id, contract_id, contract_version, generation, status, budget_remaining)
       VALUES ($1, $2, $3, 1, 'admitted', $4)`,
      [newAttemptId, contractRow.id, contractRow.version, newBudget],
    );

    // Record dispatch intent for new attempt
    await client.query(
      `INSERT INTO dispatch_intents
         (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
       VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
      [
        String(newIntentId),
        TASK_IDS.workerAttempt,
        String(digestOf(newWorkerPayload)),
        newAttemptId,
        newIntentKey,
      ],
    );

    // Record disposition decision
    await client.query(
      `INSERT INTO decisions
         (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id, causation_id, command_id, outcome, at)
       VALUES ($1, 'disposition', $2, $3, $4, $5, $6, $7, $7, 'remediate', $8)`,
      [
        decisionId,
        actor,
        contractRow.work_item_id,
        contractRow.id,
        contractRow.version,
        newAttemptId,
        commandId,
        at,
      ],
    );

    // Update finding disposition
    await client.query(
      "UPDATE findings SET disposition = 'remediate', updated_at = now() WHERE id = $1",
      [findingId],
    );

    await client.query("COMMIT");

    // Trigger AFTER commit (R-002)
    const { runId: newRunId } = await runtime.trigger({
      intentId: String(newIntentId),
      task: TASK_IDS.workerAttempt,
      payload: newWorkerPayload,
      options: {
        idempotencyKey: newIntentKey,
        maxDurationSeconds: contractRow.bounds.budget.maxDurationSeconds,
        concurrencyKey: contractRow.project_id,
        tags: [
          `project:${contractRow.project_id}`,
          `workItem:${contractRow.work_item_id}`,
          `contract:${contractRow.id}:${contractRow.version}`,
          `attempt:${newAttemptId}`,
        ],
      },
    });

    // Record runId after trigger
    await pool.query(
      "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
      [String(newIntentId), newRunId],
    );
    await pool.query(
      "UPDATE attempts SET run_id = $2, status = 'dispatched', updated_at = now() WHERE id = $1",
      [newAttemptId, newRunId],
    );

    const result: DispositionResult = {
      ok: true,
      outcome: "remediate",
      newAttemptId,
      newIntentId: String(newIntentId),
      newRunId,
    };
    await completeCommand(client, commandId, result);
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
}
