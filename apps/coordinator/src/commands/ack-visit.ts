/**
 * ackVisit command — operator acknowledges the return view.
 *
 * Stores the ack timestamp in commands.result.  lastAckAt() reads back
 * the most-recent ack so the return-view can compute "new since last visit".
 */

import { claimCommand, completeCommand } from "@agencyhq/db";
import type pg from "pg";
import type { CommandDeps } from "./stop.ts";

// ---------------------------------------------------------------------------
// ackVisit
// ---------------------------------------------------------------------------

export type AckVisitInput = {
  commandId: string;
  at: string; // ISO timestamp
};

export type AckVisitResult = { ok: true; at: string };

export async function ackVisit(deps: CommandDeps, input: AckVisitInput): Promise<AckVisitResult> {
  const { commandId, at } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "ack_visit");
    if (!claim.claimed) {
      return claim.result as AckVisitResult;
    }

    const result: AckVisitResult = { ok: true, at };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// lastAckAt — reads the most-recent ack timestamp from commands
// ---------------------------------------------------------------------------

/**
 * Returns the ISO timestamp from the most-recent ack_visit command, or null
 * if no ack has been recorded.
 */
export async function lastAckAt(client: pg.PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ at: string | null }>(
    `SELECT result->>'at' AS at
     FROM commands
     WHERE kind = 'ack_visit'
       AND result IS NOT NULL
     ORDER BY at DESC
     LIMIT 1`,
  );
  return rows[0]?.at ?? null;
}
