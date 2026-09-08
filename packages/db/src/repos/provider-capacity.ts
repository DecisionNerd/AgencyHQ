/**
 * Repository for the provider_capacity table.
 * Records adapter- or operator-sourced capacity observations per provider/model.
 * Validity is computed by the domain — this repo does not filter by valid_until.
 */

import type pg from "pg";
import type { ProviderCapacityRow } from "../rows.ts";
import { ProviderCapacityRowSchema } from "../rows.ts";

export interface ProviderCapacityInsert {
  provider: string;
  model: string;
  status: "ok" | "limited" | "down";
  observed_at: Date;
  valid_until: Date;
  source: "adapter" | "operator";
  run_id?: string | null;
}

export type RecordCapacityResult = "inserted" | "existing";

/**
 * Insert a capacity observation. Idempotent on the primary key
 * (provider, model, observed_at): if a row with that key already exists,
 * no write is performed and "existing" is returned.
 */
export async function recordCapacity(
  client: pg.PoolClient,
  row: ProviderCapacityInsert,
): Promise<{ result: RecordCapacityResult; row: ProviderCapacityRow }> {
  const { rows } = await client.query<ProviderCapacityRow>(
    `INSERT INTO provider_capacity
       (provider, model, status, observed_at, valid_until, source, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, model, observed_at) DO NOTHING
     RETURNING *`,
    [
      row.provider,
      row.model,
      row.status,
      row.observed_at,
      row.valid_until,
      row.source,
      row.run_id ?? null,
    ],
  );

  if (rows[0]) {
    return { result: "inserted", row: ProviderCapacityRowSchema.parse(rows[0]) };
  }

  // Row already existed — fetch it
  const { rows: existing } = await client.query<ProviderCapacityRow>(
    `SELECT * FROM provider_capacity
     WHERE provider = $1 AND model = $2 AND observed_at = $3`,
    [row.provider, row.model, row.observed_at],
  );
  const first = existing[0];
  if (!first) throw new Error("recordCapacity: conflict row not found after DO NOTHING");
  return { result: "existing", row: ProviderCapacityRowSchema.parse(first) };
}

/**
 * Return the most recent capacity observation for a given provider/model.
 * Returns null if no observations exist.
 */
export async function latestCapacity(
  client: pg.PoolClient,
  opts: { provider: string; model: string },
): Promise<ProviderCapacityRow | null> {
  const { rows } = await client.query<ProviderCapacityRow>(
    `SELECT * FROM provider_capacity
     WHERE provider = $1 AND model = $2
     ORDER BY observed_at DESC
     LIMIT 1`,
    [opts.provider, opts.model],
  );
  const first = rows[0];
  if (!first) return null;
  return ProviderCapacityRowSchema.parse(first);
}

/**
 * Return the latest observation for every (provider, model) pair seen,
 * regardless of whether the observation is still within valid_until.
 * The domain is responsible for stale-handling.
 *
 * @param now - used only as documentation parameter; filtering by valid_until
 *              is intentionally left to the caller / domain layer.
 */
export async function listCurrentCapacity(
  client: pg.PoolClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _now: Date,
): Promise<ProviderCapacityRow[]> {
  const { rows } = await client.query<ProviderCapacityRow>(
    `SELECT DISTINCT ON (provider, model) *
     FROM provider_capacity
     ORDER BY provider, model, observed_at DESC`,
  );
  return rows.map((r) => ProviderCapacityRowSchema.parse(r));
}
