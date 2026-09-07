/**
 * Repository functions for the commands idempotency table.
 */

import type pg from "pg";

export type ClaimCommandResult =
  | { claimed: true }
  | { claimed: false; result: unknown; inFlight?: true };

/**
 * Atomically claim a command slot by command_id.
 *
 * Returns { claimed: true } if this caller inserted the row (they own the work).
 * Returns { claimed: false, result } if the row already exists and a result was stored.
 * Returns { claimed: false, result: null, inFlight: true } if the row exists but no
 * result has been stored yet (the original is still running).
 */
export async function claimCommand(
  client: pg.PoolClient,
  commandId: string,
  kind: string,
): Promise<ClaimCommandResult> {
  const { rows } = await client.query<{ command_id: string }>(
    `INSERT INTO commands (command_id, kind, result, at)
     VALUES ($1, $2, NULL, now())
     ON CONFLICT DO NOTHING
     RETURNING command_id`,
    [commandId, kind],
  );

  if (rows.length > 0) {
    return { claimed: true };
  }

  // Row already exists — fetch current result
  const { rows: existing } = await client.query<{ result: unknown }>(
    `SELECT result FROM commands WHERE command_id = $1`,
    [commandId],
  );

  const stored = existing[0]?.result ?? null;
  if (stored === null) {
    return { claimed: false, result: null, inFlight: true };
  }
  return { claimed: false, result: stored };
}

/**
 * Record the result for a previously claimed command.
 * Idempotent: calling again with the same commandId overwrites result.
 */
export async function completeCommand(
  client: pg.PoolClient,
  commandId: string,
  result: unknown,
): Promise<void> {
  await client.query(`UPDATE commands SET result = $2, at = now() WHERE command_id = $1`, [
    commandId,
    JSON.stringify(result),
  ]);
}
