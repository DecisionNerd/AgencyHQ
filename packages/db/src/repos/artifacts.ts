/**
 * Repository for the artifacts table.
 */

import type pg from "pg";
import type { ArtifactRow } from "../rows.ts";
import { ArtifactRowSchema } from "../rows.ts";

export interface ArtifactInsert {
  id: string;
  attempt_id: string;
  revision: string;
  diff_digest: string;
  changed_paths: unknown;
}

/** Insert an artifact row. Returns the parsed row. */
export async function insertArtifact(
  client: pg.PoolClient,
  row: ArtifactInsert,
): Promise<ArtifactRow> {
  const { rows } = await client.query<ArtifactRow>(
    `INSERT INTO artifacts
       (id, attempt_id, revision, diff_digest, changed_paths)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [row.id, row.attempt_id, row.revision, row.diff_digest, JSON.stringify(row.changed_paths)],
  );
  const first = rows[0];
  if (!first) throw new Error("insertArtifact: no row returned");
  return ArtifactRowSchema.parse(first);
}

/** Get an artifact by id. Returns null if not found. */
export async function getArtifact(client: pg.PoolClient, id: string): Promise<ArtifactRow | null> {
  const { rows } = await client.query<ArtifactRow>("SELECT * FROM artifacts WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return ArtifactRowSchema.parse(first);
}

/** List artifacts for an attempt. */
export async function listArtifactsByAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<ArtifactRow[]> {
  const { rows } = await client.query<ArtifactRow>(
    "SELECT * FROM artifacts WHERE attempt_id = $1 ORDER BY created_at",
    [attemptId],
  );
  return rows.map((r) => ArtifactRowSchema.parse(r));
}
