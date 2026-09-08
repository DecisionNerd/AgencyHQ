/**
 * Repository for the authority_versions table.
 * Authority versions are an append-only log of delegated-authority schema
 * versions per project. Inserts are idempotent on (project_id, version).
 */

import type pg from "pg";
import type { AuthorityVersionRow } from "../rows.ts";
import { AuthorityVersionRowSchema } from "../rows.ts";

export interface AuthorityVersionInsert {
  project_id: string;
  version: string;
  authority: unknown;
  actor: string;
  at?: Date;
}

/**
 * Insert an authority version row. Idempotent: if a row with the same
 * (project_id, version) already exists, it is returned as-is without
 * modification.
 *
 * Returns { status: "inserted" | "existing", row }.
 */
export async function insertAuthorityVersion(
  client: pg.PoolClient,
  row: AuthorityVersionInsert,
): Promise<{ status: "inserted" | "existing"; row: AuthorityVersionRow }> {
  const { rows } = await client.query<AuthorityVersionRow & { inserted: boolean }>(
    `INSERT INTO authority_versions (project_id, version, authority, actor, at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (project_id, version) DO NOTHING
     RETURNING *, true AS inserted`,
    [row.project_id, row.version, JSON.stringify(row.authority), row.actor, row.at ?? new Date()],
  );

  if (rows.length > 0 && rows[0]) {
    // Inserted successfully.
    return { status: "inserted", row: AuthorityVersionRowSchema.parse(rows[0]) };
  }

  // Already existed — fetch it.
  const { rows: existing } = await client.query<AuthorityVersionRow>(
    "SELECT * FROM authority_versions WHERE project_id = $1 AND version = $2",
    [row.project_id, row.version],
  );
  const first = existing[0];
  if (!first) throw new Error("insertAuthorityVersion: conflict but row missing");
  return { status: "existing", row: AuthorityVersionRowSchema.parse(first) };
}

/** List all authority versions for a project, ordered by at ascending. */
export async function listAuthorityVersions(
  client: pg.PoolClient,
  projectId: string,
): Promise<AuthorityVersionRow[]> {
  const { rows } = await client.query<AuthorityVersionRow>(
    "SELECT * FROM authority_versions WHERE project_id = $1 ORDER BY at",
    [projectId],
  );
  return rows.map((r) => AuthorityVersionRowSchema.parse(r));
}
