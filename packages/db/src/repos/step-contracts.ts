/**
 * Repository for the step_contracts table.
 */

import type pg from "pg";
import type { StepContractRow } from "../rows.ts";
import { mapStepContractRow, StepContractRowSchema } from "../rows.ts";
import { insertTransition } from "./transitions.ts";

export interface StepContractInsert {
  id: string;
  work_item_id: string;
  project_id: string;
  version: number;
  base_revision: string;
  inputs: unknown;
  criteria: unknown;
  criteria_digest: string;
  profile_id: string;
  profile_digest: string;
  bounds: unknown;
  required_boundaries: unknown;
  human_required: boolean;
  status: string;
  superseded_by?: string | null;
}

export interface StatusAudit {
  actor: string;
  causationId?: string;
  commandId?: string;
}

export type UpdateStatusResult = { ok: true } | { ok: false; reason: "state_mismatch" };

/** Insert a step contract row. Returns the parsed row. */
export async function insertStepContract(
  client: pg.PoolClient,
  row: StepContractInsert,
): Promise<ReturnType<typeof mapStepContractRow>> {
  const { rows } = await client.query<StepContractRow>(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status, superseded_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15)
     RETURNING *`,
    [
      row.id,
      row.work_item_id,
      row.project_id,
      row.version,
      row.base_revision,
      JSON.stringify(row.inputs),
      JSON.stringify(row.criteria),
      row.criteria_digest,
      row.profile_id,
      row.profile_digest,
      JSON.stringify(row.bounds),
      JSON.stringify(row.required_boundaries),
      row.human_required,
      row.status,
      row.superseded_by ?? null,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertStepContract: no row returned");
  return mapStepContractRow(StepContractRowSchema.parse(first));
}

/** Get a step contract by id. Returns null if not found. */
export async function getStepContract(
  client: pg.PoolClient,
  id: string,
): Promise<ReturnType<typeof mapStepContractRow> | null> {
  const { rows } = await client.query<StepContractRow>(
    "SELECT * FROM step_contracts WHERE id = $1",
    [id],
  );
  const first = rows[0];
  if (!first) return null;
  return mapStepContractRow(StepContractRowSchema.parse(first));
}

/** List step contracts for a work item. */
export async function listStepContractsByWorkItem(
  client: pg.PoolClient,
  workItemId: string,
): Promise<Array<ReturnType<typeof mapStepContractRow>>> {
  const { rows } = await client.query<StepContractRow>(
    "SELECT * FROM step_contracts WHERE work_item_id = $1 ORDER BY version",
    [workItemId],
  );
  return rows.map((r) => mapStepContractRow(StepContractRowSchema.parse(r)));
}

/**
 * Transition a step contract's status.
 * Uses optimistic concurrency: WHERE id = $1 AND status = $2.
 * On 0 rows updated returns { ok: false, reason: "state_mismatch" }.
 * On success appends a transitions audit row.
 */
export async function updateStepContractStatus(
  client: pg.PoolClient,
  id: string,
  from: string,
  to: string,
  audit: StatusAudit,
): Promise<UpdateStatusResult> {
  const { rowCount } = await client.query(
    `UPDATE step_contracts
     SET status = $3, updated_at = now()
     WHERE id = $1 AND status = $2`,
    [id, from, to],
  );

  if (!rowCount || rowCount === 0) {
    return { ok: false, reason: "state_mismatch" };
  }

  await insertTransition(client, {
    aggregate: "step_contracts",
    aggregate_id: id,
    from_state: from,
    to_state: to,
    actor: audit.actor,
    causation_id: audit.causationId ?? null,
    command_id: audit.commandId ?? null,
  });

  return { ok: true };
}
