/**
 * Repository for the decisions table.
 * Decisions are immutable once written.
 */

import type pg from "pg";
import type { DecisionRow } from "../rows.ts";
import { DecisionRowSchema } from "../rows.ts";

export interface DecisionInsert {
  id: string;
  kind: string;
  actor: string;
  proposal_digest?: string | null;
  authority_version?: string | null;
  work_item_id?: string | null;
  contract_id?: string | null;
  contract_version?: number | null;
  attempt_id?: string | null;
  causation_id?: string | null;
  command_id?: string | null;
  outcome?: string | null;
  reason?: string | null;
  at: Date;
}

/** Insert a decision row. Returns the parsed row. */
export async function insertDecision(
  client: pg.PoolClient,
  row: DecisionInsert,
): Promise<DecisionRow> {
  const { rows } = await client.query<DecisionRow>(
    `INSERT INTO decisions
       (id, kind, actor, proposal_digest, authority_version, work_item_id,
        contract_id, contract_version, attempt_id, causation_id, command_id, outcome, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      row.id,
      row.kind,
      row.actor,
      row.proposal_digest ?? null,
      row.authority_version ?? null,
      row.work_item_id ?? null,
      row.contract_id ?? null,
      row.contract_version ?? null,
      row.attempt_id ?? null,
      row.causation_id ?? null,
      row.command_id ?? null,
      row.outcome ?? null,
      row.reason ?? null,
      row.at,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertDecision: no row returned");
  return DecisionRowSchema.parse(first);
}

/** Get a decision by id. Returns null if not found. */
export async function getDecision(client: pg.PoolClient, id: string): Promise<DecisionRow | null> {
  const { rows } = await client.query<DecisionRow>("SELECT * FROM decisions WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return DecisionRowSchema.parse(first);
}

/** List decisions for a work item. */
export async function listDecisionsByWorkItem(
  client: pg.PoolClient,
  workItemId: string,
): Promise<DecisionRow[]> {
  const { rows } = await client.query<DecisionRow>(
    "SELECT * FROM decisions WHERE work_item_id = $1 ORDER BY at",
    [workItemId],
  );
  return rows.map((r) => DecisionRowSchema.parse(r));
}
