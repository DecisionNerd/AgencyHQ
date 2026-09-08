/**
 * Repository for the integrations table.
 * Records compare-and-set integration events; idempotent by
 * (attempt_id, target_ref, expected_base_revision).
 */

import type pg from "pg";
import type { IntegrationRow } from "../rows.ts";
import { IntegrationRowSchema } from "../rows.ts";

export interface IntegrationInsert {
  id: string;
  attempt_id: string;
  contract_id: string;
  contract_version: number;
  target_ref: string;
  expected_base_revision: string;
  resulting_revision?: string | null;
  outcome?: string | null;
  run_id?: string | null;
}

export type InsertIntegrationResult =
  | { status: "inserted"; row: IntegrationRow }
  | { status: "existing"; row: IntegrationRow };

export type FinalizeIntegrationResult = "applied" | "already_set";

/**
 * Insert an integration row.
 * Idempotent on (attempt_id, target_ref, expected_base_revision): if the row
 * already exists the existing row is returned with status "existing".
 */
export async function insertIntegration(
  client: pg.PoolClient,
  row: IntegrationInsert,
): Promise<InsertIntegrationResult> {
  const { rows } = await client.query<IntegrationRow>(
    `INSERT INTO integrations
       (id, attempt_id, contract_id, contract_version, target_ref,
        expected_base_revision, resulting_revision, outcome, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (attempt_id, target_ref, expected_base_revision)
       DO NOTHING
     RETURNING *`,
    [
      row.id,
      row.attempt_id,
      row.contract_id,
      row.contract_version,
      row.target_ref,
      row.expected_base_revision,
      row.resulting_revision ?? null,
      row.outcome ?? null,
      row.run_id ?? null,
    ],
  );

  if (rows[0]) {
    return { status: "inserted", row: IntegrationRowSchema.parse(rows[0]) };
  }

  // Conflict: fetch the existing row.
  const { rows: existing } = await client.query<IntegrationRow>(
    `SELECT * FROM integrations
     WHERE attempt_id = $1
       AND target_ref = $2
       AND expected_base_revision = $3`,
    [row.attempt_id, row.target_ref, row.expected_base_revision],
  );
  const first = existing[0];
  if (!first) throw new Error("insertIntegration: conflict but no existing row found");
  return { status: "existing", row: IntegrationRowSchema.parse(first) };
}

/**
 * Finalize an integration by recording outcome, resulting_revision, and
 * optional run_id.
 * Guard: only writes when outcome IS NULL.
 * Returns "applied" on success, "already_set" when the guard prevented the
 * write (outcome was already set).
 */
export async function finalizeIntegration(
  client: pg.PoolClient,
  id: string,
  fields: { outcome: string; resultingRevision?: string | null; runId?: string | null },
): Promise<FinalizeIntegrationResult> {
  const { rowCount } = await client.query(
    `UPDATE integrations
     SET outcome            = $2,
         resulting_revision = $3,
         run_id             = $4,
         updated_at         = now()
     WHERE id = $1
       AND outcome IS NULL`,
    [id, fields.outcome, fields.resultingRevision ?? null, fields.runId ?? null],
  );

  if (!rowCount || rowCount === 0) {
    return "already_set";
  }
  return "applied";
}

/**
 * Get the integration row for a given attempt id.
 * Returns null if no matching row exists.
 * When multiple rows exist for an attempt (multiple target refs), returns the
 * first by insertion order (at asc).
 */
export async function getIntegrationByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<IntegrationRow | null> {
  const { rows } = await client.query<IntegrationRow>(
    `SELECT * FROM integrations WHERE attempt_id = $1 ORDER BY at LIMIT 1`,
    [attemptId],
  );
  const first = rows[0];
  if (!first) return null;
  return IntegrationRowSchema.parse(first);
}

/**
 * List all integration rows for a given attempt id, ordered by at asc.
 */
export async function listIntegrationsByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<IntegrationRow[]> {
  const { rows } = await client.query<IntegrationRow>(
    `SELECT * FROM integrations WHERE attempt_id = $1 ORDER BY at`,
    [attemptId],
  );
  return rows.map((r) => IntegrationRowSchema.parse(r));
}
