/**
 * Repository functions for run_observations.
 */

import type pg from "pg";
import { type RunObservationRow, RunObservationRowSchema } from "../rows.ts";

/**
 * Return all observations for a run, ordered by generation ascending.
 */
export async function listObservations(
  client: pg.PoolClient,
  runId: string,
): Promise<RunObservationRow[]> {
  const { rows } = await client.query<RunObservationRow>(
    `SELECT run_id, generation, stale, payload, observed_at
       FROM run_observations
      WHERE run_id = $1
      ORDER BY generation`,
    [runId],
  );
  return rows.map((r) => RunObservationRowSchema.parse(r));
}

/**
 * Return the single observation for (runId, generation), or null if absent.
 */
export async function latestObservation(
  client: pg.PoolClient,
  runId: string,
  generation: number,
): Promise<RunObservationRow | null> {
  const { rows } = await client.query<RunObservationRow>(
    `SELECT run_id, generation, stale, payload, observed_at
       FROM run_observations
      WHERE run_id = $1
        AND generation = $2`,
    [runId, generation],
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  return RunObservationRowSchema.parse(rows[0]!);
}
