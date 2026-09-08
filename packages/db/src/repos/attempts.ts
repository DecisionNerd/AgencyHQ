/**
 * Repository for the attempts table.
 */

import type pg from "pg";
import type { AttemptRow } from "../rows.ts";
import { AttemptRowSchema } from "../rows.ts";
import type { StatusAudit, UpdateStatusResult } from "./step-contracts.ts";
import { insertTransition } from "./transitions.ts";

export interface AttemptInsert {
  id: string;
  contract_id: string;
  contract_version: number;
  generation: number;
  status: string;
  run_id?: string | null;
  worktree_path?: string | null;
  session_id?: string | null;
  commit_sha?: string | null;
  diff_digest?: string | null;
  checkpoint_commit?: string | null;
  failure_id?: string | null;
  budget_remaining: number;
}

/** Insert an attempt row. Returns the parsed row. */
export async function insertAttempt(
  client: pg.PoolClient,
  row: AttemptInsert,
): Promise<AttemptRow> {
  const { rows } = await client.query<AttemptRow>(
    `INSERT INTO attempts
       (id, contract_id, contract_version, generation, status, run_id,
        worktree_path, session_id, commit_sha, diff_digest, checkpoint_commit,
        failure_id, budget_remaining)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      row.id,
      row.contract_id,
      row.contract_version,
      row.generation,
      row.status,
      row.run_id ?? null,
      row.worktree_path ?? null,
      row.session_id ?? null,
      row.commit_sha ?? null,
      row.diff_digest ?? null,
      row.checkpoint_commit ?? null,
      row.failure_id ?? null,
      row.budget_remaining,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertAttempt: no row returned");
  return AttemptRowSchema.parse(first);
}

/** Get an attempt by id. Returns null if not found. */
export async function getAttempt(client: pg.PoolClient, id: string): Promise<AttemptRow | null> {
  const { rows } = await client.query<AttemptRow>("SELECT * FROM attempts WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return AttemptRowSchema.parse(first);
}

/** List attempts for a step contract. */
export async function listAttemptsByContract(
  client: pg.PoolClient,
  contractId: string,
): Promise<AttemptRow[]> {
  const { rows } = await client.query<AttemptRow>(
    "SELECT * FROM attempts WHERE contract_id = $1 ORDER BY generation",
    [contractId],
  );
  return rows.map((r) => AttemptRowSchema.parse(r));
}

/**
 * Transition an attempt's status.
 * Uses optimistic concurrency: WHERE id = $1 AND status = $2.
 * On 0 rows updated returns { ok: false, reason: "state_mismatch" }.
 * On success appends a transitions audit row.
 */
export async function updateAttemptStatus(
  client: pg.PoolClient,
  id: string,
  from: string,
  to: string,
  audit: StatusAudit,
): Promise<UpdateStatusResult> {
  const { rowCount } = await client.query(
    `UPDATE attempts
     SET status = $3, updated_at = now()
     WHERE id = $1 AND status = $2`,
    [id, from, to],
  );

  if (!rowCount || rowCount === 0) {
    return { ok: false, reason: "state_mismatch" };
  }

  await insertTransition(client, {
    aggregate: "attempts",
    aggregate_id: id,
    from_state: from,
    to_state: to,
    actor: audit.actor,
    causation_id: audit.causationId ?? null,
    command_id: audit.commandId ?? null,
  });

  return { ok: true };
}
