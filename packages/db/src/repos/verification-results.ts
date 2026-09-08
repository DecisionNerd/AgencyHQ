/**
 * Repository for the verification_results table.
 */

import type pg from "pg";
import type { VerificationResultRow } from "../rows.ts";
import { mapVerificationResultRow, VerificationResultRowSchema } from "../rows.ts";

export interface VerificationResultInsert {
  id: string;
  attempt_id: string;
  step_contract_id: string;
  record: unknown;
  result: string;
}

/** Insert a verification result row. Returns the parsed row. */
export async function insertVerificationResult(
  client: pg.PoolClient,
  row: VerificationResultInsert,
): Promise<ReturnType<typeof mapVerificationResultRow>> {
  const { rows } = await client.query<VerificationResultRow>(
    `INSERT INTO verification_results
       (id, attempt_id, step_contract_id, record, result)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING *`,
    [row.id, row.attempt_id, row.step_contract_id, JSON.stringify(row.record), row.result],
  );
  const first = rows[0];
  if (!first) throw new Error("insertVerificationResult: no row returned");
  return mapVerificationResultRow(VerificationResultRowSchema.parse(first));
}

/** Get a verification result by id. Returns null if not found. */
export async function getVerificationResult(
  client: pg.PoolClient,
  id: string,
): Promise<ReturnType<typeof mapVerificationResultRow> | null> {
  const { rows } = await client.query<VerificationResultRow>(
    "SELECT * FROM verification_results WHERE id = $1",
    [id],
  );
  const first = rows[0];
  if (!first) return null;
  return mapVerificationResultRow(VerificationResultRowSchema.parse(first));
}

/** List verification results for an attempt. */
export async function listVerificationResultsByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<Array<ReturnType<typeof mapVerificationResultRow>>> {
  const { rows } = await client.query<VerificationResultRow>(
    "SELECT * FROM verification_results WHERE attempt_id = $1 ORDER BY created_at",
    [attemptId],
  );
  return rows.map((r) => mapVerificationResultRow(VerificationResultRowSchema.parse(r)));
}
