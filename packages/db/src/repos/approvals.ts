/**
 * Repository for the approvals table.
 */

import type pg from "pg";
import type { ApprovalRow } from "../rows.ts";
import { ApprovalRowSchema } from "../rows.ts";

export interface ApprovalInsert {
  id: string;
  decision_id: string;
  contract_id?: string | null;
  contract_version?: number | null;
  attempt_revision?: string | null;
  human_actor?: string | null;
  at?: Date | null;
}

/** Insert an approval row. Returns the parsed row. */
export async function insertApproval(
  client: pg.PoolClient,
  row: ApprovalInsert,
): Promise<ApprovalRow> {
  const { rows } = await client.query<ApprovalRow>(
    `INSERT INTO approvals
       (id, decision_id, contract_id, contract_version, attempt_revision, human_actor, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.id,
      row.decision_id,
      row.contract_id ?? null,
      row.contract_version ?? null,
      row.attempt_revision ?? null,
      row.human_actor ?? null,
      row.at ?? null,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertApproval: no row returned");
  return ApprovalRowSchema.parse(first);
}

/** Get an approval by id. Returns null if not found. */
export async function getApproval(client: pg.PoolClient, id: string): Promise<ApprovalRow | null> {
  const { rows } = await client.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return ApprovalRowSchema.parse(first);
}

/** List approvals for a decision. */
export async function listApprovalsByDecision(
  client: pg.PoolClient,
  decisionId: string,
): Promise<ApprovalRow[]> {
  const { rows } = await client.query<ApprovalRow>(
    "SELECT * FROM approvals WHERE decision_id = $1 ORDER BY created_at",
    [decisionId],
  );
  return rows.map((r) => ApprovalRowSchema.parse(r));
}
