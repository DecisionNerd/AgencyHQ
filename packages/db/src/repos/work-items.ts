/**
 * Repository for the work_items table.
 */

import type pg from "pg";
import type { WorkItemRow } from "../rows.ts";
import { WorkItemRowSchema } from "../rows.ts";

export interface WorkItemInsert {
  id: string;
  project_id: string;
  rank: number;
  intent: string;
  defect?: string | null;
  boundary: "artifact" | "merge" | "deploy";
  lifecycle: string;
  condition: string;
  main_effort?: boolean;
  version?: number;
}

/** Insert a work item row. Returns the parsed row. */
export async function insertWorkItem(
  client: pg.PoolClient,
  row: WorkItemInsert,
): Promise<WorkItemRow> {
  const { rows } = await client.query<WorkItemRow>(
    `INSERT INTO work_items
       (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      row.id,
      row.project_id,
      row.rank,
      row.intent,
      row.defect ?? null,
      row.boundary,
      row.lifecycle,
      row.condition,
      row.main_effort ?? false,
      row.version ?? 1,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertWorkItem: no row returned");
  return WorkItemRowSchema.parse(first);
}

/** Get a work item by id. Returns null if not found. */
export async function getWorkItem(client: pg.PoolClient, id: string): Promise<WorkItemRow | null> {
  const { rows } = await client.query<WorkItemRow>("SELECT * FROM work_items WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return WorkItemRowSchema.parse(first);
}

/** List work items for a project, ordered by rank. */
export async function listWorkItemsByProject(
  client: pg.PoolClient,
  projectId: string,
): Promise<WorkItemRow[]> {
  const { rows } = await client.query<WorkItemRow>(
    "SELECT * FROM work_items WHERE project_id = $1 ORDER BY rank",
    [projectId],
  );
  return rows.map((r) => WorkItemRowSchema.parse(r));
}

/**
 * Update a work item's rank with optimistic concurrency (CAS on version).
 *
 * Bumps work_items.version by 1. Returns "applied" when the row was updated,
 * or "stale" when expectedVersion does not match the current row version
 * (another writer updated it first).
 */
export async function setWorkItemRank(
  client: pg.PoolClient,
  workItemId: string,
  rank: number,
  expectedVersion: number,
): Promise<"applied" | "stale"> {
  const { rowCount } = await client.query(
    `UPDATE work_items
        SET rank       = $3,
            version    = version + 1,
            updated_at = now()
      WHERE id = $1
        AND version = $2`,
    [workItemId, expectedVersion, rank],
  );
  return (rowCount ?? 0) > 0 ? "applied" : "stale";
}
