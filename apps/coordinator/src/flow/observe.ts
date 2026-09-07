/**
 * Reconciler — polls open DispatchIntents and routes final observations
 * to the appropriate BoundedRepairFlow handlers.
 *
 * Trial finding: for CANCELED/TIMED_OUT worker runs, wait for adapter
 * confirmation (metadata.survivors present OR output present) before
 * treating the observation as final.
 *
 * F-2: For CANCELED/TIMED_OUT worker runs when the attempt is stopping,
 * call confirmStop before routing (no replacement is dispatched on that path).
 * F-5: Deterministic command ids prevent double-routing on concurrent polls;
 * in-flight guard prevents overlapping poll executions.
 */

import type { LeadPlanOutput } from "@agencyhq/contracts";
import { LeadPlanOutputSchema, TASK_IDS } from "@agencyhq/contracts";
import { listOpenDispatchIntents } from "@agencyhq/db";
import type { CommandId, RunObservation } from "@agencyhq/domain";
import { FINAL_RUN_STATUSES } from "@agencyhq/domain";

import { confirmStop } from "../commands/confirm-stop.ts";
import type { BoundedRepairFlow } from "./bounded-repair.ts";
import { generationOfIntent as getIntentGen } from "./bounded-repair.ts";
import type { FlowDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export class Reconciler {
  private readonly deps: FlowDeps;
  private readonly flow: BoundedRepairFlow;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastPollAt: string | null = null;
  private _pollHealthy = true;
  /** F-5: prevent concurrent poll executions overlapping. */
  private _polling = false;

  constructor(deps: FlowDeps, flow: BoundedRepairFlow) {
    this.deps = deps;
    this.flow = flow;
  }

  /**
   * True when the last poll completed without error.
   * False when the last poll threw; polling continues but freshness is stale.
   */
  get healthy(): boolean {
    return this._pollHealthy;
  }

  /** ISO timestamp of the last completed (or attempted) poll. */
  get freshness(): string | null {
    return this._lastPollAt;
  }

  /**
   * Single poll: lists open DispatchIntents, retrieves each run, routes
   * final observations to flow handlers.
   *
   * Failures mark freshness stale but do NOT throw (so the caller's
   * setInterval loop is not broken).
   */
  async pollOnce(): Promise<void> {
    // F-5: in-flight guard — skip if a previous poll is still executing.
    if (this._polling) return;
    this._polling = true;
    try {
      const { pool } = this.deps;
      const client = await pool.connect();
      let intents: Awaited<ReturnType<typeof listOpenDispatchIntents>>;
      try {
        intents = await listOpenDispatchIntents(client);
      } finally {
        client.release();
      }

      for (const intent of intents) {
        const runId = intent.run_id;
        if (!runId) continue;

        let obs: RunObservation;
        try {
          obs = await this.deps.runtime.retrieve(runId);
        } catch {
          // Transient retrieve failure — skip this intent this poll cycle.
          continue;
        }

        if (!isFinalStatus(obs.status)) continue;

        // Trial finding: for cancelled/timed_out worker runs, require adapter
        // confirmation (survivors present OR output present) before routing.
        if (
          intent.task === TASK_IDS.workerAttempt &&
          (obs.status === "CANCELED" || obs.status === "TIMED_OUT")
        ) {
          const hasOutput = obs.output !== undefined && obs.output !== null;
          const hasSurvivors = obs.metadata !== undefined && "survivors" in obs.metadata;
          if (!hasOutput && !hasSurvivors) {
            // Not yet confirmed — skip
            continue;
          }
        }

        // F-2: For CANCELED/TIMED_OUT worker runs when the attempt is stopping,
        // call confirmStop instead of routing to onWorkerFinal.
        if (
          intent.task === TASK_IDS.workerAttempt &&
          (obs.status === "CANCELED" || obs.status === "TIMED_OUT") &&
          intent.attempt_id
        ) {
          try {
            const attemptStatus = await this.loadAttemptStatus(intent.attempt_id);
            if (attemptStatus === "stopping") {
              await this.handleStoppingWorker(obs, intent);
              // Close the intent (best-effort; onWorkerFinal may also close it
              // via the deterministic commandId path if called for other reasons).
              await this.closeIntent(intent.id, "observed");
              continue;
            }
          } catch (err) {
            console.error("[reconciler] confirmStop routing failed", intent.id, err);
            continue;
          }
        }

        // F-5: Deterministic command id = cmd_obs_<runId>_<dispatchedGeneration>.
        // claimCommand acts as the idempotency fence — a replay of the same
        // observation returns immediately without re-running the handler.
        const dispatchedGen = getIntentGen(intent);
        const commandId = `cmd_obs_${runId}_${dispatchedGen}` as CommandId;

        try {
          if (intent.task === TASK_IDS.workerAttempt) {
            await this.flow.onWorkerFinal(obs, commandId);
          } else if (intent.task === TASK_IDS.verifyRun) {
            await this.flow.onVerifyFinal(obs, commandId);
          } else if (intent.task === TASK_IDS.leadReview) {
            await this.flow.onReviewFinal(obs, commandId);
          } else if (intent.task === TASK_IDS.leadAccept) {
            await this.flow.onAcceptFinal(obs, commandId);
          } else if (intent.task === TASK_IDS.leadPlan) {
            const parsed =
              obs.status === "COMPLETED" && obs.output !== undefined && obs.output !== null
                ? parseLeadPlanOutput(obs.output)
                : null;
            if (parsed) {
              await this.flow.onLeadPlanOutput(intent.id, parsed, commandId);
            } else {
              // A Lead run that failed or produced no parseable output is an
              // execution failure of the plan step: record it and close the
              // intent so the reconciler stops re-polling it (observed
              // 2026-09-07: a FAILED lead.plan run stayed "triggered" forever).
              await this.recordIntentFailure(intent.id, "plan", obs);
              continue;
            }
          }
          // closeIntent is a no-op for handlers that already closed the intent
          // inside their transaction (F-5b); the WHERE status='triggered' guard
          // prevents double-updates.
          await this.closeIntent(intent.id, "observed");
        } catch (error: unknown) {
          console.error("[reconciler] handler failed", intent.task, intent.id, error);
        }
      }

      this._pollHealthy = true;
    } catch {
      this._pollHealthy = false;
    } finally {
      this._polling = false;
      this._lastPollAt = new Date().toISOString();
    }
  }

  /**
   * F-2: Handle a CANCELED/TIMED_OUT worker observation when the attempt is
   * already in the `stopping` state.  Calls confirmStop and, if the result is
   * `uncertain`, marks the work item condition accordingly.  Does NOT dispatch
   * a replacement attempt.
   */
  private async handleStoppingWorker(
    obs: RunObservation,
    intent: Awaited<ReturnType<typeof listOpenDispatchIntents>>[number],
  ): Promise<void> {
    if (!intent.attempt_id) return;

    const { pool, clock } = this.deps;
    const client = await pool.connect();
    try {
      // Load the current attempt generation for the confirmStop CAS.
      const { rows } = await client.query<{ generation: number }>(
        "SELECT generation FROM attempts WHERE id = $1",
        [intent.attempt_id],
      );
      const generation = rows[0]?.generation;
      if (generation === undefined) return;

      const commandDeps = { pool, runtime: this.deps.runtime, clock };
      const csResult = await confirmStop(commandDeps, client, {
        attemptId: intent.attempt_id,
        generation,
        observation: obs,
      });

      if (csResult.status === "pending_confirmation") {
        // Evidence not yet available; leave intent open for next poll.
        return;
      }

      if (csResult.status === "uncertain") {
        // Survivors remain — mark work item condition uncertain so selectDispatch skips it.
        await pool.query(
          `UPDATE work_items
           SET condition = 'uncertain', version = version + 1, updated_at = now()
           WHERE id = (
             SELECT sc.work_item_id FROM step_contracts sc
             JOIN attempts a ON a.contract_id = sc.id WHERE a.id = $1
           )`,
          [intent.attempt_id],
        );
      }
    } finally {
      client.release();
    }
  }

  /** Load an attempt's status by id. */
  private async loadAttemptStatus(attemptId: string): Promise<string | null> {
    const client = await this.deps.pool.connect();
    try {
      const { rows } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      return rows[0]?.status ?? null;
    } finally {
      client.release();
    }
  }

  /** Mark an intent no longer open once its final observation was routed. */
  private async closeIntent(intentId: string, status: "observed" | "failed"): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query(
        "UPDATE dispatch_intents SET status = $2, updated_at = now() WHERE id = $1 AND status = 'triggered'",
        [intentId, status],
      );
    } finally {
      client.release();
    }
  }

  /** Record an execution failure for a task run that ended without usable output. */
  private async recordIntentFailure(
    intentId: string,
    phase: string,
    obs: RunObservation,
  ): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query(
        `INSERT INTO failures (id, class, phase, run_id, cause, evidence)
         VALUES ($1, 'execution', $2, $3, $4, $5)`,
        [
          this.deps.ids.next("fl"),
          phase,
          obs.runId,
          obs.error?.message?.slice(0, 500) ?? `run ${obs.status} without output`,
          JSON.stringify({ status: obs.status, observedAt: obs.observedAt }),
        ],
      );
      await client.query(
        "UPDATE dispatch_intents SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
        [intentId],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Start polling on the given interval (milliseconds).
   */
  start(intervalMs: number): void {
    if (this._timer !== null) return;
    this._timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFinalStatus(status: string): boolean {
  return (FINAL_RUN_STATUSES as ReadonlySet<string>).has(status);
}

function parseLeadPlanOutput(output: unknown): LeadPlanOutput | null {
  const result = LeadPlanOutputSchema.safeParse(output);
  if (result.success) return result.data;
  return null;
}
