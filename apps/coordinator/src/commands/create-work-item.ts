/**
 * createWorkItem command.
 *
 * Inserts a WorkItem with lifecycle "admitted" and condition "healthy".
 * Idempotent by commandId: replaying the same command returns the original
 * workItemId without inserting a duplicate.
 */

import { randomUUID } from "node:crypto";
import { claimCommand, completeCommand, insertDecision, insertWorkItem } from "@agencyhq/db";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateWorkItemInput = {
  commandId: string;
  projectId: string;
  intent: string;
  defect?: string;
  boundary: "artifact";
  rank: number;
};

export type CreateWorkItemResult = {
  ok: true;
  workItemId: string;
};

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
        boundary,
        lifecycle: "admitted",
        condition: "healthy",
        main_effort: false,
        version: 1,
      });

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
