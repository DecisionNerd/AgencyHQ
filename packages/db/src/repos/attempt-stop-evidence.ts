/**
 * Repository for the attempt_stop_evidence table (0008_container_runtime).
 *
 * Stop-sequence evidence is uploaded by worker containers on graceful shutdown.
 * Upsert is idempotent by (attempt_id, generation).
 */

import type pg from "pg";
import type { AttemptStopEvidenceRow } from "../rows.ts";
import { AttemptStopEvidenceRowSchema } from "../rows.ts";

export interface StopEvidenceStep {
  at: string;
  // D6 / W-8: extended vocabulary matching all worker-written step names.
  step:
    | "signal_sent"
    | "process_exited"
    | "survivor_scan"
    | "checkpoint_committed"
    | "upload_done"
    | "aborted"
    | "abort_signal"
    | "soft_deadline"
    | "on_cancel_entered"
    | "stop_start"
    | "killed"
    | "checkpoint"
    | "checkpoint_failed"
    | "stop_done";
  detail?: string;
}

export interface AttemptStopEvidenceInsert {
  id: string;
  attempt_id: string;
  generation: number;
  steps: StopEvidenceStep[];
}

/**
 * Upsert stop evidence for an (attempt_id, generation) pair.
 *
 * Idempotent: if evidence already exists for this (attempt_id, generation),
 * the steps are overwritten with the latest submission.
 * Returns the parsed row after upsert.
 */
export async function upsertAttemptStopEvidence(
  client: pg.PoolClient,
  row: AttemptStopEvidenceInsert,
): Promise<AttemptStopEvidenceRow> {
  const { rows } = await client.query<AttemptStopEvidenceRow>(
    `INSERT INTO attempt_stop_evidence (id, attempt_id, generation, steps)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (attempt_id, generation)
     DO UPDATE SET steps = EXCLUDED.steps, received_at = now()
     RETURNING *`,
    [row.id, row.attempt_id, row.generation, JSON.stringify(row.steps)],
  );
  const first = rows[0];
  if (!first) throw new Error("upsertAttemptStopEvidence: no row returned");
  return AttemptStopEvidenceRowSchema.parse(first);
}

/** List all stop evidence rows for an attempt, ordered by generation. */
export async function listStopEvidenceForAttempt(
  client: pg.PoolClient,
  attemptId: string,
): Promise<AttemptStopEvidenceRow[]> {
  const { rows } = await client.query<AttemptStopEvidenceRow>(
    `SELECT * FROM attempt_stop_evidence WHERE attempt_id = $1 ORDER BY generation`,
    [attemptId],
  );
  return rows.map((r) => AttemptStopEvidenceRowSchema.parse(r));
}
