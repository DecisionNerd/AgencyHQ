/**
 * Reconciler — polls open DispatchIntents and routes final observations
 * to the appropriate BoundedRepairFlow handlers.
 *
 * Trial finding: for CANCELED/TIMED_OUT worker runs, wait for adapter
 * confirmation (metadata.survivors present OR output present) before
 * treating the observation as final.
 */

import type { LeadPlanOutput } from "@agencyhq/contracts";
import { LeadPlanOutputSchema, TASK_IDS } from "@agencyhq/contracts";
import { listOpenDispatchIntents } from "@agencyhq/db";
import type { CommandId, RunObservation } from "@agencyhq/domain";
import { FINAL_RUN_STATUSES } from "@agencyhq/domain";

import type { BoundedRepairFlow } from "./bounded-repair.ts";
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
    try {
      const { pool, ids } = this.deps;
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

        // Route by task
        const commandId = ids.next("cmd") as CommandId;
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
          await this.closeIntent(intent.id, "observed");
        } catch (error: unknown) {
          console.error("[reconciler] handler failed", intent.task, intent.id, error);
        }
      }

      this._pollHealthy = true;
    } catch {
      this._pollHealthy = false;
    } finally {
      this._lastPollAt = new Date().toISOString();
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
