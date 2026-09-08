/**
 * pauseWorkItem / resumeWorkItem commands.
 *
 * pauseWorkItem: sets work_item.condition → "blocked" and records a
 * Decision of kind "disposition" with outcome "pause".  Paused items are
 * skipped by selectDispatch (condition ≠ "healthy").
 *
 * resumeWorkItem: sets work_item.condition → "healthy".
 */

import { randomUUID } from "node:crypto";
import { claimCommand, completeCommand, getWorkItem, insertDecision } from "@agencyhq/db";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// pauseWorkItem
// ---------------------------------------------------------------------------

export type PauseWorkItemInput = {
  commandId: string;
  workItemId: string;
  reason: string;
};

export type PauseWorkItemResult =
  | { ok: true; workItemId: string }
  | { ok: false; reason: "not_found" };

export async function pauseWorkItem(
  deps: CommandDeps,
  input: PauseWorkItemInput,
): Promise<PauseWorkItemResult> {
  const { commandId, workItemId, reason } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "pause");
    if (!claim.claimed) {
      return claim.result as PauseWorkItemResult;
    }

    const wi = await getWorkItem(client, workItemId);
    if (!wi) {
      const result: PauseWorkItemResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    await client.query("BEGIN");
    try {
      // Update condition to blocked
      await client.query(
        `UPDATE work_items
         SET condition = 'blocked', version = version + 1, updated_at = now()
         WHERE id = $1`,
        [workItemId],
      );

      // Record a disposition decision
      await insertDecision(client, {
        id: randomUUID(),
        kind: "disposition",
        actor: "human",
        work_item_id: workItemId,
        causation_id: commandId,
        command_id: commandId,
        outcome: JSON.stringify({ pause: true, reason }),
        at: new Date(),
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: PauseWorkItemResult = { ok: true, workItemId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// resumeWorkItem
// ---------------------------------------------------------------------------

export type ResumeWorkItemInput = {
  commandId: string;
  workItemId: string;
};

export type ResumeWorkItemResult =
  | { ok: true; workItemId: string }
  | { ok: false; reason: "not_found" };

export async function resumeWorkItem(
  deps: CommandDeps,
  input: ResumeWorkItemInput,
): Promise<ResumeWorkItemResult> {
  const { commandId, workItemId } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "resume");
    if (!claim.claimed) {
      return claim.result as ResumeWorkItemResult;
    }

    const wi = await getWorkItem(client, workItemId);
    if (!wi) {
      const result: ResumeWorkItemResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    await client.query("BEGIN");
    try {
      // Update condition to healthy
      await client.query(
        `UPDATE work_items
         SET condition = 'healthy', version = version + 1, updated_at = now()
         WHERE id = $1`,
        [workItemId],
      );

      // Record a disposition decision
      await insertDecision(client, {
        id: randomUUID(),
        kind: "disposition",
        actor: "human",
        work_item_id: workItemId,
        causation_id: commandId,
        command_id: commandId,
        outcome: JSON.stringify({ pause: false }),
        at: new Date(),
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const result: ResumeWorkItemResult = { ok: true, workItemId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
