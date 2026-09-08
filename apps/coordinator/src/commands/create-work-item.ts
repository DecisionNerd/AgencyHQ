/**
 * createWorkItem command.
 *
 * Inserts a WorkItem with lifecycle "admitted" and condition "healthy".
 * Idempotent by commandId: replaying the same command returns the original
 * workItemId without inserting a duplicate.
 *
 * When `manifest` is supplied the boundary must be "merge". Each entry's
 * expectedBaseRevision is resolved from the project's stored allowed_refs
 * (`allowed_refs.main` SHA); positions follow array order.
 */

import { randomUUID } from "node:crypto";
import {
  claimCommand,
  completeCommand,
  insertDecision,
  insertWorkItem,
  insertWorkItemProjects,
} from "@agencyhq/db";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ManifestEntryInput = {
  projectId: string;
  targetRef: string;
};

export type CreateWorkItemInput = {
  commandId: string;
  projectId: string;
  intent: string;
  defect?: string;
  boundary: "artifact" | "merge";
  rank: number;
  /** Optional revision manifest for multi-repository work items. */
  manifest?: { entries: ManifestEntryInput[] };
};

export type CreateWorkItemResult = { ok: true; workItemId: string } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a base revision for a specific targetRef from a project's stored
 * `allowed_refs` object.  Returns the SHA stored under `targetRef` (or its
 * short form without the `refs/heads/` prefix), or null when the ref is absent.
 *
 * S-7: each entry's expectedBaseRevision must come from `allowed_refs[entry.targetRef]`,
 * not from a fixed "main" key, so manifests targeting other refs freeze the
 * correct base and unknown refs are rejected.
 */
function baseRevisionFromAllowedRefs(allowedRefs: unknown, targetRef: string): string | null {
  if (!allowedRefs || typeof allowedRefs !== "object") return null;
  const refs = allowedRefs as Record<string, unknown>;
  // Try both the full ref and the short name (e.g. "refs/heads/main" and "main").
  const shortRef = targetRef.replace(/^refs\/heads\//, "");
  const v = refs[targetRef] ?? refs[shortRef];
  if (typeof v === "string" && /^[0-9a-f]{40}$/.test(v)) {
    return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// createWorkItem
// ---------------------------------------------------------------------------

export async function createWorkItem(
  deps: CommandDeps,
  input: CreateWorkItemInput,
): Promise<CreateWorkItemResult> {
  const { commandId, projectId, intent, boundary, rank } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "create_work_item");
    if (!claim.claimed) {
      return claim.result as CreateWorkItemResult;
    }

    // Validate manifest constraints before beginning the transaction
    if (input.manifest) {
      if (boundary !== "merge") {
        const result: CreateWorkItemResult = {
          ok: false,
          reason: "boundary must be 'merge' when manifest is provided",
        };
        await completeCommand(client, commandId, result);
        return result;
      }

      // Validate each manifest entry: project must exist and targetRef must be in allowed_refs
      for (const entry of input.manifest.entries) {
        const { rows } = await client.query("SELECT id, allowed_refs FROM projects WHERE id = $1", [
          entry.projectId,
        ]);
        const projectRow = rows[0] as { id: string; allowed_refs: unknown } | undefined;
        if (!projectRow) {
          const result: CreateWorkItemResult = {
            ok: false,
            reason: `Project ${entry.projectId} not found`,
          };
          await completeCommand(client, commandId, result);
          return result;
        }
        // Check targetRef is in allowed_refs
        const allowedRefs = projectRow.allowed_refs as Record<string, unknown> | undefined;
        const allowedKeys = allowedRefs ? Object.keys(allowedRefs) : [];
        if (!allowedKeys.includes(entry.targetRef)) {
          const result: CreateWorkItemResult = {
            ok: false,
            reason: `targetRef '${entry.targetRef}' is not in allowed_refs for project ${entry.projectId}`,
          };
          await completeCommand(client, commandId, result);
          return result;
        }
      }
    }

    await client.query("BEGIN");
    let workItemId: string;
    try {
      workItemId = randomUUID();

      await insertWorkItem(client, {
        id: workItemId,
        project_id: projectId,
        rank,
        intent,
        defect: input.defect ?? null,
        boundary: boundary as "artifact" | "merge" | "deploy",
        lifecycle: "admitted",
        condition: "healthy",
        main_effort: false,
        version: 1,
      });

      // Insert manifest entries if provided
      if (input.manifest && input.manifest.entries.length > 0) {
        const entries: import("@agencyhq/db").WorkItemProjectEntry[] = [];
        for (let i = 0; i < input.manifest.entries.length; i++) {
          // biome-ignore lint/style/noNonNullAssertion: loop index always in bounds
          const entry = input.manifest.entries[i]!;
          // Load project to get allowed_refs for base revision
          const { rows } = await client.query(
            "SELECT id, allowed_refs FROM projects WHERE id = $1",
            [entry.projectId],
          );
          const projectRow = rows[0] as { id: string; allowed_refs: unknown } | undefined;
          if (!projectRow) {
            throw new Error(`Project ${entry.projectId} not found during manifest insert`);
          }
          const expectedBaseRevision = baseRevisionFromAllowedRefs(
            projectRow.allowed_refs,
            entry.targetRef,
          );
          if (!expectedBaseRevision) {
            throw new Error(
              `targetRef '${entry.targetRef}' has no stored revision in allowed_refs for project ${entry.projectId}`,
            );
          }
          entries.push({
            project_id: entry.projectId,
            position: i,
            target_ref: entry.targetRef,
            expected_base_revision: expectedBaseRevision,
          });
        }
        await insertWorkItemProjects(client, workItemId, entries);
      }

      // Record a decision capturing the create action
      await insertDecision(client, {
        id: randomUUID(),
        kind: "create",
        actor: "human",
        work_item_id: workItemId,
        causation_id: commandId,
        command_id: commandId,
        at: new Date(),
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: CreateWorkItemResult = { ok: true, workItemId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
