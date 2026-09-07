/**
 * Test helper: seed Project and WorkItem rows for integration tests.
 */

import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { newId } from "@agencyhq/domain";

/** Minimal interface for a DB client used in seeding. */
interface DbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SeedResult {
  projectId: string;
  workItemId: string;
}

/**
 * Insert a Project (using HOST_TRIAL_AUTHORITY) and a WorkItem into the test schema.
 * All IDs are freshly generated.
 */
export async function seedProjectAndWorkItem(
  client: DbClient,
  opts?: {
    intent?: string;
    defect?: string;
    boundary?: "artifact" | "merge" | "deploy";
  },
): Promise<SeedResult> {
  const projectId = newId("prj");
  const workItemId = newId("wi");

  const intent = opts?.intent ?? "Fix the parser to handle edge cases correctly";
  const boundary = opts?.boundary ?? "artifact";

  await client.query(
    `INSERT INTO projects
       (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
     VALUES ($1, NULL, '/repo', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
    [
      projectId,
      JSON.stringify({ main: "0000000000000000000000000000000000000000" }),
      JSON.stringify(HOST_TRIAL_AUTHORITY),
    ],
  );

  await client.query(
    `INSERT INTO work_items
       (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
     VALUES ($1, $2, 1, $3, $4, $5, 'proposed', 'healthy', true, 1)`,
    [workItemId, projectId, intent, opts?.defect ?? null, boundary],
  );

  return { projectId, workItemId };
}
