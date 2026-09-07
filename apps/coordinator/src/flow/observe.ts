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
            // Parse output and route
            if (obs.output !== undefined && obs.output !== null) {
              const parsed = parseLeadPlanOutput(obs.output);
              if (parsed) {
                await this.flow.onLeadPlanOutput(intent.id, parsed, commandId);
              }
            }
          }
        } catch {
          // Handler failure — log but don't stop polling
        }
      }

      this._pollHealthy = true;
    } catch {
      this._pollHealthy = false;
    } finally {
      this._lastPollAt = new Date().toISOString();
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
