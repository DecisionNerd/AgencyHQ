/**
 * Repository for the work_item_projects table.
 * Tracks the per-project revision manifest for a multi-repository WorkItem.
 */

import type pg from "pg";
import type { WorkItemProjectRow } from "../rows.ts";
import { WorkItemProjectRowSchema } from "../rows.ts";

export interface WorkItemProjectEntry {
  project_id: string;
  position: number;
  target_ref: string;
  expected_base_revision: string;
}

export type SetResultRevisionResult = "applied" | "already_set";

/**
 * Insert one or more work_item_projects rows for the given work item.
 * The entries array maps to the rows; caller supplies all required fields.
 */
export async function insertWorkItemProjects(
  client: pg.PoolClient,
  workItemId: string,
  entries: WorkItemProjectEntry[],
): Promise<WorkItemProjectRow[]> {
  if (entries.length === 0) return [];

  const results: WorkItemProjectRow[] = [];
  for (const entry of entries) {
    const { rows } = await client.query<WorkItemProjectRow>(
      `INSERT INTO work_item_projects
         (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        workItemId,
        entry.project_id,
        entry.position,
        entry.target_ref,
        entry.expected_base_revision,
      ],
    );
    const first = rows[0];
    if (!first) throw new Error("insertWorkItemProjects: no row returned");
    results.push(WorkItemProjectRowSchema.parse(first));
  }
  return results;
}

/**
 * List work_item_projects for a work item ordered by position ascending.
 */
export async function listWorkItemProjects(
  client: pg.PoolClient,
  workItemId: string,
): Promise<WorkItemProjectRow[]> {
  const { rows } = await client.query<WorkItemProjectRow>(
    `SELECT * FROM work_item_projects
     WHERE work_item_id = $1
     ORDER BY position`,
    [workItemId],
  );
  return rows.map((r) => WorkItemProjectRowSchema.parse(r));
}

/**
 * Set result_revision for a specific (work_item_id, position) row.
 * Guard: only updates when result_revision IS NULL.
 * Returns "applied" when the update was written, "already_set" when the guard
 * prevented the write (result_revision was already non-null).
 */
export async function setResultRevision(
  client: pg.PoolClient,
  workItemId: string,
  position: number,
  resultRevision: string,
): Promise<SetResultRevisionResult> {
  const { rowCount } = await client.query(
    `UPDATE work_item_projects
     SET result_revision = $3, updated_at = now()
     WHERE work_item_id = $1
       AND position = $2
       AND result_revision IS NULL`,
    [workItemId, position, resultRevision],
  );

  if (!rowCount || rowCount === 0) {
    return "already_set";
  }
  return "applied";
}
