/**
 * Repository for the attempt_artifacts table (0008_container_runtime).
 *
 * Worker containers upload artifact bundles; the coordinator validates and
 * persists metadata here. ON CONFLICT DO NOTHING is the insertion contract;
 * callers detect duplicates via the inserted|duplicate discriminant.
 */

import type pg from "pg";
import type { AttemptArtifactRow } from "../rows.ts";
import { AttemptArtifactRowSchema } from "../rows.ts";

export interface AttemptArtifactInsert {
  id: string;
  attempt_id: string;
  generation: number;
  kind: "attempt" | "checkpoint";
  commit_id: string;
  diff_digest: string;
  changed_paths: string[];
  quarantine_patch?: string | null;
  bundle_sha256: string;
  bundle_bytes: number;
}

export type InsertArtifactResult =
  | { outcome: "inserted"; row: AttemptArtifactRow }
  | { outcome: "duplicate" };

/**
 * Insert an artifact row. Returns { outcome: "inserted", row } on success or
 * { outcome: "duplicate" } when the unique constraint fires (idempotent upload).
 */
export async function insertAttemptArtifact(
  client: pg.PoolClient,
  row: AttemptArtifactInsert,
): Promise<InsertArtifactResult> {
  const { rows } = await client.query<AttemptArtifactRow>(
    `INSERT INTO attempt_artifacts
       (id, attempt_id, generation, kind, commit_id, diff_digest,
        changed_paths, quarantine_patch, bundle_sha256, bundle_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (attempt_id, generation, kind, commit_id) DO NOTHING
     RETURNING *`,
    [
      row.id,
      row.attempt_id,
      row.generation,
      row.kind,
      row.commit_id,
      row.diff_digest,
      JSON.stringify(row.changed_paths),
      row.quarantine_patch ?? null,
      row.bundle_sha256,
      row.bundle_bytes,
    ],
  );
  const first = rows[0];
  if (!first) return { outcome: "duplicate" };
  return { outcome: "inserted", row: AttemptArtifactRowSchema.parse(first) };
}

/** List all artifact rows for an attempt, ordered by received_at. */
export async function listArtifactsForAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<AttemptArtifactRow[]> {
  const { rows } = await client.query<AttemptArtifactRow>(
    `SELECT * FROM attempt_artifacts WHERE attempt_id = $1 ORDER BY received_at`,
    [attemptId],
  );
  return rows.map((r) => AttemptArtifactRowSchema.parse(r));
}

/**
 * Mark an artifact as verified (set verified = true).
 * Returns the updated row or null if not found.
 */
export async function markArtifactVerified(
  client: pg.PoolClient,
  artifactId: string,
): Promise<AttemptArtifactRow | null> {
  const { rows } = await client.query<AttemptArtifactRow>(
    `UPDATE attempt_artifacts SET verified = true WHERE id = $1 RETURNING *`,
    [artifactId],
  );
  const first = rows[0];
  if (!first) return null;
  return AttemptArtifactRowSchema.parse(first);
}
