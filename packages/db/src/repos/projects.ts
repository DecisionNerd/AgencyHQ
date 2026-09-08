/**
 * Repository for the projects table.
 */

import type pg from "pg";
import type { ProjectRow } from "../rows.ts";
import { mapProjectRow, ProjectRowSchema } from "../rows.ts";

export interface ProjectInsert {
  id: string;
  remote?: string | null;
  clone_path?: string | null;
  worktree_base?: string | null;
  allowed_refs?: unknown | null;
  profile_catalog?: unknown | null;
  authority: unknown;
  authority_version: string;
}

/** Insert a project row. Returns the parsed row. */
export async function insertProject(
  client: pg.PoolClient,
  row: ProjectInsert,
): Promise<ProjectRow> {
  const { rows } = await client.query<ProjectRow>(
    `INSERT INTO projects
       (id, remote, clone_path, worktree_base, allowed_refs, profile_catalog, authority, authority_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [
      row.id,
      row.remote ?? null,
      row.clone_path ?? null,
      row.worktree_base ?? null,
      row.allowed_refs != null ? JSON.stringify(row.allowed_refs) : null,
      row.profile_catalog != null ? JSON.stringify(row.profile_catalog) : null,
      JSON.stringify(row.authority),
      row.authority_version,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertProject: no row returned");
  return ProjectRowSchema.parse(first);
}

/** Get a project by id. Returns null if not found. */
export async function getProject(
  client: pg.PoolClient,
  id: string,
): Promise<ReturnType<typeof mapProjectRow> | null> {
  const { rows } = await client.query<ProjectRow>("SELECT * FROM projects WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return mapProjectRow(ProjectRowSchema.parse(first));
}

/** List all projects. */
export async function listProjects(
  client: pg.PoolClient,
): Promise<Array<ReturnType<typeof mapProjectRow>>> {
  const { rows } = await client.query<ProjectRow>("SELECT * FROM projects ORDER BY created_at");
  return rows.map((r) => mapProjectRow(ProjectRowSchema.parse(r)));
}
