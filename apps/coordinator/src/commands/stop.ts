/**
 * stopAttempt command — operator-initiated stop of a running attempt.
 *
 * Sequence (EXECUTION_MODEL.md §Stop, cancel, and replacement):
 *  1. Claim the command slot (idempotency).
 *  2. Load the attempt; must be dispatched|running.
 *  3. In a transaction: revokeGeneration (bumps generation, transitions to stopping)
 *     then insert a Decision row.
 *  4. COMMIT — revokeGeneration is durable before any runtime call.
 *  5. Call runtime.cancel(runId) — idempotent on the runtime side.
 *  6. completeCommand with the result.
 */

import { randomUUID } from "node:crypto";
import {
  claimCommand,
  completeCommand,
  getAttempt,
  insertDecision,
  revokeGeneration,
} from "@agencyhq/db";
import type { ExecutionRuntime } from "@agencyhq/trigger/client";
import type pg from "pg";

// ---------------------------------------------------------------------------
// CommandDeps — shared across all commands
// ---------------------------------------------------------------------------

export type CommandDeps = {
  pool: pg.Pool;
  runtime: ExecutionRuntime;
  clock: { now(): string };
  config?: { uncertainAfterMs?: number };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopAttemptInput = {
  commandId: string;
  attemptId: string;
  actor: "human" | "coordinator";
  reason: string;
};

export type StopAttemptResult =
  | { ok: true; generation: number; runId: string | null; replayed?: boolean }
  | { ok: false; reason: "state_mismatch" | "stale_generation"; replayed?: boolean };

// ---------------------------------------------------------------------------
// stopAttempt
// ---------------------------------------------------------------------------

export async function stopAttempt(
  deps: CommandDeps,
  input: StopAttemptInput,
): Promise<StopAttemptResult> {
  const { commandId, attemptId, actor } = input;
  const client = await deps.pool.connect();

  try {
    // 1. Claim command slot (idempotency table)
    const claim = await claimCommand(client, commandId, "stop");
    if (!claim.claimed) {
      const stored = claim.result as StopAttemptResult;
      return { ...stored, replayed: true };
    }

    // 2. Load attempt — must be dispatched|running
    const attempt = await getAttempt(client, attemptId);
    if (!attempt || (attempt.status !== "dispatched" && attempt.status !== "running")) {
      const result: StopAttemptResult = { ok: false, reason: "state_mismatch" };
      await completeCommand(client, commandId, result);
      return result;
    }

    // 3. Transaction: revokeGeneration + insertDecision
    await client.query("BEGIN");
    let newGeneration: number;
    try {
      const revoke = await revokeGeneration(client, attemptId, attempt.generation);
      if (!revoke.ok) {
        await client.query("ROLLBACK");
        const result: StopAttemptResult = { ok: false, reason: "stale_generation" };
        await completeCommand(client, commandId, result);
        return result;
      }
      newGeneration = revoke.generation;

      // Insert a Decision row recording the stop
      await insertDecision(client, {
        id: randomUUID(),
        kind: "stop",
        actor,
        attempt_id: attemptId,
        causation_id: commandId,
        command_id: commandId,
        at: new Date(),
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    // 4. Call runtime.cancel AFTER the transaction is committed
    const runId = attempt.run_id ?? null;
    const cancelledAt = deps.clock.now();
    if (runId !== null) {
      await deps.runtime.cancel(runId);
    }

    // 5. Complete command with result
    const result: StopAttemptResult = { ok: true, generation: newGeneration, runId };
    const commandResult = { ...result, cancelledAt };
    await completeCommand(client, commandId, commandResult);
    return result;
  } finally {
    client.release();
  }
}
