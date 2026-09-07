/**
 * Authority-generation fencing, run-observation deduplication, and stop confirmation.
 *
 * All operations use compare-and-set SQL; no read-then-write in JS.
 * Functions accept a pg.PoolClient so callers control transaction scope.
 */

import type pg from "pg";

// ---------------------------------------------------------------------------
// revokeGeneration
// ---------------------------------------------------------------------------

export type RevokeGenerationResult =
  | { ok: true; generation: number }
  | { ok: false; reason: "stale_generation" | "not_found"; current?: number };

/**
 * Advance the attempt's authority generation (CAS) and transition status to
 * 'stopping'. Appends a transitions audit row on success.
 *
 * Returns:
 *  { ok: true, generation }          — generation advanced
 *  { ok: false, reason: "stale_generation", current? } — expectedGeneration is stale
 *  { ok: false, reason: "not_found" }                  — no such attempt
 */
export async function revokeGeneration(
  client: pg.PoolClient,
  attemptId: string,
  expectedGeneration: number,
): Promise<RevokeGenerationResult> {
  const { rows } = await client.query<{
    old_status: string | null;
    prev_generation: number | null;
    new_generation: number | null;
  }>(
    `WITH prev AS (
       SELECT id, status, generation FROM attempts WHERE id = $1 FOR UPDATE
     ),
     upd AS (
       UPDATE attempts
         SET generation  = attempts.generation + 1,
             status      = 'stopping',
             updated_at  = now()
         FROM prev
        WHERE attempts.id = prev.id
          AND prev.generation = $2
       RETURNING attempts.generation AS new_generation
     )
     SELECT prev.status        AS old_status,
            prev.generation    AS prev_generation,
            upd.new_generation
     FROM   prev
     LEFT JOIN upd ON true`,
    [attemptId, expectedGeneration],
  );

  if (rows.length === 0) {
    return { ok: false, reason: "not_found" };
  }

  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const row = rows[0]!;

  if (row.new_generation === null) {
    // CAS failed: generation did not match
    return row.prev_generation !== null
      ? { ok: false, reason: "stale_generation", current: row.prev_generation }
      : { ok: false, reason: "stale_generation" };
  }

  // Insert audit transition
  await client.query(
    `INSERT INTO transitions (aggregate, aggregate_id, from_state, to_state, actor, at)
     VALUES ('attempt', $1, $2, 'stopping', 'coordinator', now())`,
    [attemptId, row.old_status],
  );

  return { ok: true, generation: row.new_generation };
}

// ---------------------------------------------------------------------------
// applyObservation
// ---------------------------------------------------------------------------

export interface ObservationInput {
  runId: string;
  generation: number;
  attemptId: string;
  status: string;
  payload: unknown;
  observedAt: Date;
}

/**
 * Deduplicate and generation-fence a run observation.
 *
 * Returns:
 *  "applied"   — inserted and generation is current (caller may apply transition)
 *  "duplicate" — (runId, generation) already present; no action taken
 *  "stale"     — inserted but generation is behind current; row marked stale=true
 *
 * Never advances attempt state — that is the caller's responsibility.
 */
export async function applyObservation(
  client: pg.PoolClient,
  obs: ObservationInput,
): Promise<"applied" | "duplicate" | "stale"> {
  // Step 1: idempotent insert
  const { rows: inserted } = await client.query<{ run_id: string }>(
    `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
     VALUES ($1, $2, false, $3, $4)
     ON CONFLICT (run_id, generation) DO NOTHING
     RETURNING run_id`,
    [obs.runId, obs.generation, JSON.stringify(obs.payload), obs.observedAt],
  );

  if (inserted.length === 0) {
    return "duplicate";
  }

  // Step 2: read current attempt generation (lock to avoid races with revokeGeneration)
  const { rows: attemptRows } = await client.query<{ generation: number }>(
    `SELECT generation FROM attempts WHERE id = $1 FOR UPDATE`,
    [obs.attemptId],
  );

  if (attemptRows.length === 0) {
    // Attempt not found — observation is orphaned; treat as applied and let caller handle
    return "applied";
  }

  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const currentGeneration = attemptRows[0]!.generation;

  if (obs.generation < currentGeneration) {
    // Mark the freshly-inserted observation as history-only
    await client.query(
      `UPDATE run_observations SET stale = true WHERE run_id = $1 AND generation = $2`,
      [obs.runId, obs.generation],
    );
    return "stale";
  }

  return "applied";
}

// ---------------------------------------------------------------------------
// confirmStopped
// ---------------------------------------------------------------------------

export type ConfirmStoppedResult =
  | { ok: true; status: "stopped" | "uncertain" }
  | { ok: false; reason: "stale_generation" | "state_mismatch" };

export interface ConfirmStoppedInput {
  survivorsConfirmedGone: boolean;
  checkpointCommit?: string;
}

/**
 * CAS-transition an attempt from 'stopping' → 'stopped' or 'uncertain'.
 *
 * Returns:
 *  { ok: true, status }                      — transition applied
 *  { ok: false, reason: "stale_generation" } — generation mismatch
 *  { ok: false, reason: "state_mismatch" }   — attempt exists but status ≠ 'stopping'
 */
export async function confirmStopped(
  client: pg.PoolClient,
  attemptId: string,
  generation: number,
  input: ConfirmStoppedInput,
): Promise<ConfirmStoppedResult> {
  const newStatus: "stopped" | "uncertain" = input.survivorsConfirmedGone ? "stopped" : "uncertain";

  const { rows } = await client.query<{
    old_status: string | null;
    prev_generation: number | null;
    new_status: string | null;
  }>(
    `WITH prev AS (
       SELECT id, status, generation FROM attempts WHERE id = $1 FOR UPDATE
     ),
     upd AS (
       UPDATE attempts
         SET status            = $3,
             checkpoint_commit = $4,
             updated_at        = now()
         FROM prev
        WHERE attempts.id   = prev.id
          AND prev.generation = $2
          AND prev.status     = 'stopping'
       RETURNING attempts.status AS new_status
     )
     SELECT prev.status        AS old_status,
            prev.generation    AS prev_generation,
            upd.new_status
     FROM   prev
     LEFT JOIN upd ON true`,
    [attemptId, generation, newStatus, input.checkpointCommit ?? null],
  );

  if (rows.length === 0) {
    // No attempt row at all
    return { ok: false, reason: "state_mismatch" };
  }

  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const row = rows[0]!;

  if (row.new_status !== null) {
    // Transition succeeded — append audit row
    await client.query(
      `INSERT INTO transitions (aggregate, aggregate_id, from_state, to_state, actor, at)
       VALUES ('attempt', $1, 'stopping', $2, 'coordinator', now())`,
      [attemptId, newStatus],
    );
    return { ok: true, status: newStatus };
  }

  // CAS failed — determine why
  if (row.prev_generation !== generation) {
    return { ok: false, reason: "stale_generation" };
  }

  return { ok: false, reason: "state_mismatch" };
}
