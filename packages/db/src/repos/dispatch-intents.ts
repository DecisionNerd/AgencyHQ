/**
 * Repository for the dispatch_intents table.
 */

import type pg from "pg";
import type { DispatchIntentRow } from "../rows.ts";
import { DispatchIntentRowSchema } from "../rows.ts";
import type { StatusAudit, UpdateStatusResult } from "./step-contracts.ts";
import { insertTransition } from "./transitions.ts";

export interface DispatchIntentInsert {
  id: string;
  task: string;
  payload_digest: string;
  attempt_id?: string | null;
  status: string;
  run_id?: string | null;
  idempotency_key: string;
}

/** Insert a dispatch intent row. Returns the parsed row. */
export async function insertDispatchIntent(
  client: pg.PoolClient,
  row: DispatchIntentInsert,
): Promise<DispatchIntentRow> {
  const { rows } = await client.query<DispatchIntentRow>(
    `INSERT INTO dispatch_intents
       (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.id,
      row.task,
      row.payload_digest,
      row.attempt_id ?? null,
      row.status,
      row.run_id ?? null,
      row.idempotency_key,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertDispatchIntent: no row returned");
  return DispatchIntentRowSchema.parse(first);
}

/** Get a dispatch intent by id. Returns null if not found. */
export async function getDispatchIntent(
  client: pg.PoolClient,
  id: string,
): Promise<DispatchIntentRow | null> {
  const { rows } = await client.query<DispatchIntentRow>(
    "SELECT * FROM dispatch_intents WHERE id = $1",
    [id],
  );
  const first = rows[0];
  if (!first) return null;
  return DispatchIntentRowSchema.parse(first);
}

/**
 * List open dispatch intents: status = 'triggered' AND run_id IS NOT NULL.
 */
export async function listOpenDispatchIntents(client: pg.PoolClient): Promise<DispatchIntentRow[]> {
  const { rows } = await client.query<DispatchIntentRow>(
    `SELECT * FROM dispatch_intents
     WHERE status = 'triggered' AND run_id IS NOT NULL
     ORDER BY created_at`,
  );
  return rows.map((r) => DispatchIntentRowSchema.parse(r));
}

// ---------------------------------------------------------------------------
// Queued worker intents (scheduler)
// ---------------------------------------------------------------------------

/**
 * Queued worker intent with joined work item + project data for the scheduler.
 * Returned by listQueuedWorkerIntents so scheduleOnce() can call selectDispatch.
 */
export type QueuedWorkerIntentRow = {
  intent_id: string;
  idempotency_key: string;
  attempt_id: string;
  attempt_generation: number;
  work_item_id: string;
  project_id: string;
  wi_rank: number;
  wi_main_effort: boolean;
  wi_lifecycle: string;
  wi_condition: string;
  wi_campaign_id: string | null;
  wi_created_at: Date | null;
  bounds: Record<string, unknown>;
  has_open_integrate_intent: boolean;
};

/**
 * Load all queued worker dispatch intents with the associated work item and
 * step contract data needed for selectDispatch.
 *
 * "Queued" = status = 'queued', task = 'worker.attempt'.
 * Includes a flag indicating whether the same work item has an open
 * integrate.merge intent (for hasOpenIntegrateIntent).
 */
export async function listQueuedWorkerIntents(
  client: pg.PoolClient,
): Promise<QueuedWorkerIntentRow[]> {
  const { rows } = await client.query<{
    intent_id: string;
    idempotency_key: string;
    attempt_id: string;
    attempt_generation: number;
    work_item_id: string;
    project_id: string;
    wi_rank: number;
    wi_main_effort: boolean;
    wi_lifecycle: string;
    wi_condition: string;
    wi_campaign_id: string | null;
    wi_created_at: Date | null;
    bounds: Record<string, unknown>;
    has_open_integrate_intent: boolean;
  }>(`
    SELECT
      di.id                            AS intent_id,
      di.idempotency_key,
      a.id                             AS attempt_id,
      a.generation                     AS attempt_generation,
      sc.work_item_id,
      sc.project_id,
      wi.rank                          AS wi_rank,
      wi.main_effort                   AS wi_main_effort,
      wi.lifecycle                     AS wi_lifecycle,
      wi.condition                     AS wi_condition,
      wi.campaign_id                   AS wi_campaign_id,
      wi.created_at                    AS wi_created_at,
      sc.bounds,
      EXISTS (
        SELECT 1
        FROM dispatch_intents di2
        JOIN attempts a2       ON a2.id  = di2.attempt_id
        JOIN step_contracts s2 ON s2.id  = a2.contract_id
        WHERE s2.work_item_id = sc.work_item_id
          AND di2.task        = 'integrate.merge'
          AND di2.status      = 'triggered'
      )                                AS has_open_integrate_intent
    FROM dispatch_intents di
    JOIN attempts       a  ON a.id  = di.attempt_id
    JOIN step_contracts sc ON sc.id = a.contract_id
    JOIN work_items     wi ON wi.id = sc.work_item_id
    WHERE di.status = 'queued'
      AND di.task   = 'worker.attempt'
    ORDER BY di.created_at
  `);
  return rows as QueuedWorkerIntentRow[];
}

/**
 * Transition a dispatch intent's status.
 * Uses optimistic concurrency: WHERE id = $1 AND status = $2.
 * On 0 rows updated returns { ok: false, reason: "state_mismatch" }.
 * On success appends a transitions audit row.
 */
export async function updateDispatchIntentStatus(
  client: pg.PoolClient,
  id: string,
  from: string,
  to: string,
  audit: StatusAudit,
): Promise<UpdateStatusResult> {
  const { rowCount } = await client.query(
    `UPDATE dispatch_intents
     SET status = $3, updated_at = now()
     WHERE id = $1 AND status = $2`,
    [id, from, to],
  );

  if (!rowCount || rowCount === 0) {
    return { ok: false, reason: "state_mismatch" };
  }

  await insertTransition(client, {
    aggregate: "dispatch_intents",
    aggregate_id: id,
    from_state: from,
    to_state: to,
    actor: audit.actor,
    causation_id: audit.causationId ?? null,
    command_id: audit.commandId ?? null,
  });

  return { ok: true };
}
