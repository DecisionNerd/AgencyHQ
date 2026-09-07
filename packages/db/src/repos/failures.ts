/**
 * Repository for the failures table.
 */

import type pg from "pg";
import type { FailureRow } from "../rows.ts";
import { FailureRowSchema } from "../rows.ts";

export interface FailureInsert {
  id: string;
  class?: string | null;
  phase?: string | null;
  attempt_id?: string | null;
  run_id?: string | null;
  cause?: string | null;
  evidence?: string | null;
}

/** Insert a failure row. Returns the parsed row. */
export async function insertFailure(
  client: pg.PoolClient,
  row: FailureInsert,
): Promise<FailureRow> {
  const { rows } = await client.query<FailureRow>(
    `INSERT INTO failures
       (id, class, phase, attempt_id, run_id, cause, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.id,
      row.class ?? null,
      row.phase ?? null,
      row.attempt_id ?? null,
      row.run_id ?? null,
      row.cause ?? null,
      row.evidence ?? null,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertFailure: no row returned");
  return FailureRowSchema.parse(first);
}

/** Get a failure by id. Returns null if not found. */
export async function getFailure(client: pg.PoolClient, id: string): Promise<FailureRow | null> {
  const { rows } = await client.query<FailureRow>("SELECT * FROM failures WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return FailureRowSchema.parse(first);
}

/** List failures for an attempt. */
export async function listFailuresByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<FailureRow[]> {
  const { rows } = await client.query<FailureRow>(
    "SELECT * FROM failures WHERE attempt_id = $1 ORDER BY created_at",
    [attemptId],
  );
  return rows.map((r) => FailureRowSchema.parse(r));
}
