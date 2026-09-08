/**
 * Repository for the findings table.
 */

import type pg from "pg";
import type { FindingRow } from "../rows.ts";
import { FindingRowSchema } from "../rows.ts";

export interface FindingInsert {
  id: string;
  attempt_id?: string | null;
  severity: string;
  kind: string;
  description: string;
  evidence?: string | null;
  disposition?: string | null;
}

/** Insert a finding row. Returns the parsed row. */
export async function insertFinding(
  client: pg.PoolClient,
  row: FindingInsert,
): Promise<FindingRow> {
  const { rows } = await client.query<FindingRow>(
    `INSERT INTO findings
       (id, attempt_id, severity, kind, description, evidence, disposition)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.id,
      row.attempt_id ?? null,
      row.severity,
      row.kind,
      row.description,
      row.evidence ?? null,
      row.disposition ?? null,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertFinding: no row returned");
  return FindingRowSchema.parse(first);
}

/** Get a finding by id. Returns null if not found. */
export async function getFinding(client: pg.PoolClient, id: string): Promise<FindingRow | null> {
  const { rows } = await client.query<FindingRow>("SELECT * FROM findings WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return FindingRowSchema.parse(first);
}

/** List findings for an attempt. */
export async function listFindingsByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<FindingRow[]> {
  const { rows } = await client.query<FindingRow>(
    "SELECT * FROM findings WHERE attempt_id = $1 ORDER BY created_at",
    [attemptId],
  );
  return rows.map((r) => FindingRowSchema.parse(r));
}
