/**
 * Reconciler — polls open DispatchIntents and routes final observations
 * to the appropriate BoundedRepairFlow handlers.
 *
 * F-2: For CANCELED/TIMED_OUT worker runs, the reconciler always routes to
 * handleStoppingWorker:
 *   - If the attempt is already `stopping`, call confirmStop directly.
 *   - If the attempt is `dispatched`/`running` (G-6: externally cancelled or
 *     hard-timed-out), call stopAttempt(actor: "coordinator") first to
 *     transition it to `stopping`, then call confirmStop.
 *   - The skip-on-no-evidence block is removed; stop.ndjson is the fallback
 *     evidence source (G-7).
 * F-5: Deterministic command ids prevent double-routing on concurrent polls;
 * in-flight guard prevents overlapping poll executions.
 */

import type { LeadPlanOutput } from "@agencyhq/contracts";
import { LeadPlanOutputSchema, TASK_IDS } from "@agencyhq/contracts";
import {
  applyObservation,
  listCurrentCapacity,
  listOpenDispatchIntents,
  listQueuedWorkerIntents,
  recordCapacity,
} from "@agencyhq/db";
import type { CommandId, RunObservation } from "@agencyhq/domain";
import {
  effectiveCapacity,
  FINAL_RUN_STATUSES,
  selectDispatch,
  type SkipReason,
} from "@agencyhq/domain";

import { confirmStop, readStopEvidence } from "../commands/confirm-stop.ts";
import { stopAttempt } from "../commands/stop.ts";
import type { BoundedRepairFlow, LeadHandlerResult } from "./bounded-repair.ts";
import { generationOfIntent as getIntentGen } from "./bounded-repair.ts";
import { onIntegrateFinal } from "./integrate.ts";
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
  /** Passed to confirmStop as config.uncertainAfterMs. */
  private readonly _uncertainAfterMs: number | undefined;
  /** Worker slot count for the scheduler (Design 1). */
  private readonly _workerSlots: number;
  /** Whether realtime wake-up is enabled (Design 3). */
  private readonly _realtimeWakeup: boolean;
  /** AbortController for the wake-up subscription (Design 3). */
  private _wakeupAbort: AbortController | null = null;

  constructor(
    deps: FlowDeps,
    flow: BoundedRepairFlow,
    options?: { uncertainAfterMs?: number; workerSlots?: number; realtimeWakeup?: boolean },
  ) {
    this.deps = deps;
    this.flow = flow;
    this._uncertainAfterMs = options?.uncertainAfterMs;
    this._workerSlots = options?.workerSlots ?? deps.config.workerSlots ?? 1;
    this._realtimeWakeup = options?.realtimeWakeup ?? false;
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
   * Single poll: runs the scheduler pass then lists open DispatchIntents,
   * retrieves each run, routes final observations to flow handlers.
   *
   * Failures mark freshness stale but do NOT throw (so the caller's
   * setInterval loop is not broken).
   */
  async pollOnce(): Promise<void> {
    // F-5: in-flight guard — skip if a previous poll is still executing.
    if (this._polling) return;
    this._polling = true;
    try {
      // Design 1: scheduler pass first, then observation routing.
      await this.scheduleOnce();

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

        // F-2 / G-6: For CANCELED/TIMED_OUT worker runs — never skip, always
        // route to handleStoppingWorker.  If the attempt is dispatched/running
        // (externally cancelled or hard-timed-out), transition it to stopping
        // first (actor: coordinator), then confirm.  If the attempt is already
        // stopping, confirm directly.  The intent is only closed when the
        // result is definitive (stopped/uncertain); pending_confirmation leaves
        // the intent open so the next poll re-examines with updated elapsed time.
        if (
          intent.task === TASK_IDS.workerAttempt &&
          (obs.status === "CANCELED" || obs.status === "TIMED_OUT") &&
          intent.attempt_id
        ) {
          try {
            const attemptStatus = await this.loadAttemptStatus(intent.attempt_id);

            if (attemptStatus === "dispatched" || attemptStatus === "running") {
              // G-6: Externally cancelled or hard-timed-out run.
              // Transition to stopping with actor coordinator (deterministic
              // commandId so this is idempotent across polls).
              const autoStopCmdId = `auto_stop_${intent.attempt_id}` as CommandId;
              await stopAttempt(
                {
                  pool: this.deps.pool,
                  runtime: this.deps.runtime,
                  clock: this.deps.clock,
                },
                {
                  commandId: autoStopCmdId,
                  attemptId: intent.attempt_id,
                  actor: "coordinator",
                  reason: "externally cancelled or hard-timed-out run",
                },
              );
            }

            if (
              attemptStatus === "stopping" ||
              attemptStatus === "dispatched" ||
              attemptStatus === "running"
            ) {
              const result = await this.handleStoppingWorker(obs, intent);
              if (result !== "pending") {
                await this.closeIntent(intent.id, "observed");
              }
              // pending → intent stays triggered; next poll re-examines.
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

        // R-010: every final observation is recorded, not only worker runs.
        // worker.attempt and integrate.merge record theirs inside their own
        // transaction (their handlers act on the "applied" result), so only
        // the Lead and verify runs are recorded here. Duplicates are no-ops.
        // Observed 2026-09-08 (Slice 4 live session): the approve command
        // reads the lead.accept proposal from run_observations, which was
        // empty for every non-worker task.
        if (intent.task !== TASK_IDS.workerAttempt && intent.task !== TASK_IDS.integrateMerge) {
          await this.recordFinalObservation(obs, intent, dispatchedGen);
        }

        // Design 2: if the observation metadata carries provider capacity info,
        // record it (source: adapter). Done before routing so the capacity store
        // is updated even if routing fails later.
        if (obs.metadata?.capacity && isFinalStatus(obs.status)) {
          await this.recordCapacityFromRun(obs, intent.run_id ?? "");
        }

        try {
          if (intent.task === TASK_IDS.workerAttempt) {
            await this.flow.onWorkerFinal(obs, commandId);
            // J-1: COMPLETED run stop-race follow-through.
            // If a stop landed during onWorkerFinal (between applyObservation and
            // the attempt status UPDATE), the attempt is now `stopping` but the
            // intent was not closed (transaction rolled back).  Detect this and
            // route to handleStoppingWorker so the intent is resolved rather than
            // closed as `observed` while the attempt is still in `stopping`.
            if (obs.status === "COMPLETED" && intent.attempt_id) {
              const attemptStatus = await this.loadAttemptStatus(intent.attempt_id);
              if (attemptStatus === "stopping") {
                const result = await this.handleStoppingWorker(obs, intent);
                if (result !== "pending") {
                  await this.closeIntent(intent.id, "observed");
                }
                continue;
              }
            }
          } else if (intent.task === TASK_IDS.verifyRun) {
            await this.flow.onVerifyFinal(obs, commandId);
          } else if (intent.task === TASK_IDS.leadReview) {
            const reviewResult: LeadHandlerResult = await this.flow.onReviewFinal(obs, commandId);
            if (!reviewResult.ok) {
              // Handler already recorded failure, closed intent as 'failed', and
              // dispatched a retry or pending_human decision (R-004, R-007, R-010).
              continue;
            }
          } else if (intent.task === TASK_IDS.leadAccept) {
            const acceptResult: LeadHandlerResult = await this.flow.onAcceptFinal(obs, commandId);
            if (!acceptResult.ok) {
              // Same failure-path handling as leadReview above.
              continue;
            }
          } else if (intent.task === TASK_IDS.integrateMerge) {
            await onIntegrateFinal(obs, commandId, this.deps);
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

  // ---------------------------------------------------------------------------
  // Design 1: Scheduler
  // ---------------------------------------------------------------------------

  /**
   * Scheduler pass: loads queued worker intents, selects which to dispatch via
   * the domain's selectDispatch, triggers the chosen ones via retryDispatch,
   * and records skip_reason on the rest.
   *
   * Called at the top of pollOnce() (so it runs on every poll and on wake-up).
   * Protected by the pollOnce() in-flight guard — never concurrent.
   */
  async scheduleOnce(): Promise<void> {
    const { pool } = this.deps;
    const client = await pool.connect();
    try {
      // 1. Load queued intents with their work item data.
      const queuedIntents = await listQueuedWorkerIntents(client);
      if (queuedIntents.length === 0) return;

      // 2. Load active attempts (dispatched|running|stopping) for slot + repo counting.
      const { rows: activeRows } = await client.query<{
        work_item_id: string;
        project_id: string;
        status: string;
        bounds: Record<string, unknown>;
      }>(
        `SELECT a.status, sc.work_item_id, sc.project_id, sc.bounds
         FROM attempts a
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE a.status IN ('dispatched', 'running', 'stopping')`,
      );

      // 3. Load current provider capacity.
      const capacityRows = await listCurrentCapacity(client, new Date());

      // 4. Load campaigns for main-effort ordering.
      const { rows: campaignRows } = await client.query<{
        id: string;
        main_effort_work_item_id: string | null;
      }>(`SELECT id, main_effort_work_item_id FROM campaigns`);
      const mainEffortByCampaign: Record<string, string> = {};
      for (const c of campaignRows) {
        if (c.main_effort_work_item_id) {
          mainEffortByCampaign[c.id] = c.main_effort_work_item_id;
        }
      }

      // 5. Derive uncertain repositories from work items with condition='uncertain'.
      const { rows: uncertainRows } = await client.query<{ project_id: string }>(
        `SELECT DISTINCT sc.project_id FROM work_items wi
         JOIN step_contracts sc ON sc.work_item_id = wi.id
         WHERE wi.condition = 'uncertain'`,
      );
      const uncertainRepositories = uncertainRows.map((r) => r.project_id);

      // 6. Build WorkItemLike[] from queued intents.
      const workItems = queuedIntents.map((row) => {
        const bounds = row.bounds as {
          models?: { worker?: string };
        };
        const workerModel = bounds.models?.worker;
        let provider: string | undefined;
        let model: string | undefined;
        if (workerModel && workerModel.includes("/")) {
          const slashIdx = workerModel.indexOf("/");
          provider = workerModel.slice(0, slashIdx);
          model = workerModel.slice(slashIdx + 1);
        }
        const item: import("@agencyhq/domain").WorkItemLike = {
          id: row.work_item_id,
          projectId: row.project_id,
          repositoryId: row.project_id,
          rank: row.wi_rank,
          lifecycle: row.wi_lifecycle as
            | "proposed"
            | "admitted"
            | "active"
            | "completed"
            | "halted"
            | "reopened",
          condition: row.wi_condition as "healthy" | "blocked" | "uncertain",
          mainEffort: row.wi_main_effort,
          hasOpenIntegrateIntent: row.has_open_integrate_intent,
        };
        if (row.wi_campaign_id !== null) item.campaignId = row.wi_campaign_id;
        if (row.wi_created_at instanceof Date) item.createdAt = row.wi_created_at.toISOString();
        if (provider !== undefined) item.provider = provider;
        if (model !== undefined) item.model = model;
        return item;
      });

      // 7. Build ActiveAttemptLike[] and activeByProvider from active rows.
      const activeAttempts = activeRows.map((r) => ({
        workItemId: r.work_item_id,
        repositoryId: r.project_id,
        status: r.status,
      }));
      const activeByProvider: Record<string, number> = {};
      for (const a of activeRows) {
        const bds = a.bounds as { models?: { worker?: string } };
        const wm = bds.models?.worker;
        if (wm && wm.includes("/")) {
          const p = wm.slice(0, wm.indexOf("/"));
          activeByProvider[p] = (activeByProvider[p] ?? 0) + 1;
        }
      }

      // 8. Convert capacity rows to domain format.
      const providerCapacity = capacityRows.map((r) => ({
        provider: r.provider,
        model: r.model,
        status: r.status,
        observedAt: r.observed_at.toISOString(),
        validUntil: r.valid_until.toISOString(),
        source: r.source,
      }));

      // 9. Run selectDispatch.
      const now = new Date().toISOString();
      const result = selectDispatch({
        workItems,
        activeAttempts,
        slots: this._workerSlots,
        uncertainRepositories,
        mainEffortByCampaign,
        providerCapacity,
        now,
        activeByProvider,
      });

      // Build map from workItemId → queued intent id.
      const intentByWorkItem = new Map<string, string>();
      for (const row of queuedIntents) {
        intentByWorkItem.set(row.work_item_id, row.intent_id);
      }

      // 10. Dispatch chosen items.
      for (const item of result.dispatch) {
        const intentId = intentByWorkItem.get(item.workItemId);
        if (!intentId) continue;
        try {
          await this.flow.retryDispatch(intentId);
        } catch (err) {
          console.error("[scheduler] retryDispatch failed", intentId, err);
        }
      }

      // 11. Record skip_reason for skipped items.
      for (const skipped of result.skipped) {
        const intentId = intentByWorkItem.get(skipped.workItemId);
        if (!intentId) continue;
        // Only update if still queued (avoid overwriting a concurrent dispatch).
        await client.query(
          `UPDATE dispatch_intents
           SET skip_reason = $2, updated_at = now()
           WHERE id = $1 AND status = 'queued'`,
          [intentId, skipped.reason],
        );
      }
    } catch (err) {
      console.error("[scheduler] scheduleOnce failed", err);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Design 2: Capacity recording from run metadata
  // ---------------------------------------------------------------------------

  /**
   * When a final run observation carries metadata.capacity, record it in the
   * provider_capacity table (source: adapter).  Idempotent via the table's
   * primary key (provider, model, observed_at).
   */
  private async recordCapacityFromRun(obs: RunObservation, runId: string): Promise<void> {
    const raw = obs.metadata?.capacity;
    if (!raw || typeof raw !== "object") return;
    const cap = raw as {
      provider?: unknown;
      model?: unknown;
      status?: unknown;
      observedAt?: unknown;
      validUntil?: unknown;
    };
    if (
      typeof cap.provider !== "string" ||
      typeof cap.model !== "string" ||
      (cap.status !== "ok" && cap.status !== "limited" && cap.status !== "down") ||
      typeof cap.observedAt !== "string" ||
      typeof cap.validUntil !== "string"
    ) {
      return;
    }
    const client = await this.deps.pool.connect();
    try {
      await recordCapacity(client, {
        provider: cap.provider,
        model: cap.model,
        status: cap.status,
        observed_at: new Date(cap.observedAt),
        valid_until: new Date(cap.validUntil),
        source: "adapter",
        run_id: runId || null,
      });
    } catch (err) {
      console.error("[reconciler] recordCapacity failed", err);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Design 3: Wake-up subscription
  // ---------------------------------------------------------------------------

  /**
   * Start a realtime wake-up subscription.
   *
   * Subscribes to the tags of all currently-open intents' work items.  When
   * a run observation arrives, schedules a debounced pollOnce() call (respects
   * the in-flight guard — no duplicate polls).
   *
   * Called only when AGENCYHQ_REALTIME_WAKEUP=true and the runtime implements
   * subscribe().  Resolves when the subscription ends (signal aborted).
   */
  async startWakeup(): Promise<void> {
    if (!this._realtimeWakeup || !this.deps.runtime.subscribe) return;

    this._wakeupAbort = new AbortController();
    const signal = this._wakeupAbort.signal;

    // Collect project tags from all open intents as wake-up tags.
    const { pool } = this.deps;
    const client = await pool.connect();
    let tags: string[];
    try {
      const { rows } = await client.query<{ project_id: string }>(
        `SELECT DISTINCT sc.project_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.status = 'triggered'`,
      );
      tags = rows.map((r) => `project:${r.project_id}`);
    } finally {
      client.release();
    }

    if (tags.length === 0 || signal.aborted) return;

    // Subscribe and call pollOnce on each observation.
    // The in-flight guard in pollOnce prevents concurrent polls.
    await this.deps.runtime.subscribe(
      { tags, signal },
      (_obs: RunObservation) => {
        // Wake-up hint: kick off a poll. The observation itself is NOT applied
        // here — it goes through the normal applyObservation path (R-010).
        void this.pollOnce();
      },
    );
  }

  /**
   * Stop the realtime wake-up subscription.
   */
  stopWakeup(): void {
    if (this._wakeupAbort) {
      this._wakeupAbort.abort();
      this._wakeupAbort = null;
    }
  }

  /**
   * F-2 / G-6 / G-7: Handle a CANCELED/TIMED_OUT worker observation, routing
   * it through confirmStop.
   *
   * Evidence priority:
   *  1. Run metadata (`survivors`, `checkpointCommit`) from the observation.
   *  2. stop.ndjson in the attempt's run directory (G-7).
   *  3. No evidence → pending_confirmation until uncertainAfterMs deadline.
   *
   * finalObservedAt is read from run_observations.observed_at so repeated polls
   * see the same anchor time and the deadline eventually fires (design pt 3).
   *
   * Returns:
   *  "pending" — within deadline, intent must stay open for next poll.
   *  "done"    — stopped/uncertain/stale; intent may be closed.
   */
  private async handleStoppingWorker(
    obs: RunObservation,
    intent: Awaited<ReturnType<typeof listOpenDispatchIntents>>[number],
  ): Promise<"pending" | "done"> {
    if (!intent.attempt_id) return "done";

    const { pool, clock } = this.deps;
    const client = await pool.connect();
    try {
      // Load the current attempt generation for the confirmStop CAS.
      const { rows } = await client.query<{ generation: number }>(
        "SELECT generation FROM attempts WHERE id = $1",
        [intent.attempt_id],
      );
      const generation = rows[0]?.generation;
      if (generation === undefined) return "done";

      // R-010: Record the observation before calling confirmStop.
      // Use the dispatched generation from the intent's idempotency key (may be
      // behind the current generation after revokeGeneration bumped it — that is
      // expected and will be marked stale).  Duplicate calls are no-ops.
      const dispatchedGen = getIntentGen(intent);
      await applyObservation(client, {
        runId: obs.runId,
        generation: dispatchedGen,
        attemptId: intent.attempt_id,
        status: obs.status,
        payload: obs,
        observedAt: new Date(obs.observedAt),
      });

      // Design pt 3: finalObservedAt = observed_at from run_observations row
      // (whether newly inserted or already present from a prior poll).
      // This ensures the deadline is anchored to the first observation time,
      // not the current poll time.
      const { rows: obsRows } = await client.query<{ observed_at: Date }>(
        "SELECT observed_at FROM run_observations WHERE run_id = $1 AND generation = $2",
        [obs.runId, dispatchedGen],
      );
      const finalObservedAt = obsRows[0]?.observed_at?.toISOString() ?? obs.observedAt;

      // G-7: Evidence order — metadata first; fall back to stop.ndjson.
      let stopEvidence: { survivors: number[]; checkpointCommit?: string } | undefined;
      const hasMetadataSurvivors = obs.metadata !== undefined && "survivors" in obs.metadata;
      if (!hasMetadataSurvivors && this.deps.config.worktreeBase) {
        const runDir = `${this.deps.config.worktreeBase}/runs/${intent.attempt_id}`;
        const fileEvidence = await readStopEvidence(runDir);
        if (fileEvidence !== null) {
          stopEvidence = fileEvidence;
        }
      }

      const commandDeps = {
        pool,
        runtime: this.deps.runtime,
        clock,
        ...(this._uncertainAfterMs !== undefined
          ? { config: { uncertainAfterMs: this._uncertainAfterMs } }
          : {}),
      };
      const csResult = await confirmStop(commandDeps, client, {
        attemptId: intent.attempt_id,
        generation,
        observation: obs,
        ...(stopEvidence !== undefined ? { stopEvidence } : {}),
        finalObservedAt,
      });

      if (csResult.status === "pending_confirmation") {
        // Within the uncertainty deadline — leave intent open for next poll.
        return "pending";
      }

      if (csResult.status === "uncertain") {
        // Survivors remain — mark work item condition uncertain so selectDispatch skips it.
        await client.query(
          `UPDATE work_items
           SET condition = 'uncertain', version = version + 1, updated_at = now()
           WHERE id = (
             SELECT sc.work_item_id FROM step_contracts sc
             JOIN attempts a ON a.contract_id = sc.id WHERE a.id = $1
           )`,
          [intent.attempt_id],
        );
      }

      return "done";
    } finally {
      client.release();
    }
  }

  /** Record a final observation for a task whose handler does not record it
   * itself (lead.plan, verify.run, lead.review, lead.accept). Never throws:
   * recording is history, routing must still happen. */
  private async recordFinalObservation(
    obs: RunObservation,
    intent: Awaited<ReturnType<typeof listOpenDispatchIntents>>[number],
    generation: number,
  ): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await applyObservation(client, {
        runId: obs.runId,
        generation,
        attemptId: intent.attempt_id ?? "",
        status: obs.status,
        payload: obs,
        observedAt: new Date(obs.observedAt),
      });
    } catch (err) {
      console.error("[reconciler] record observation failed", intent.id, err);
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
   * When AGENCYHQ_REALTIME_WAKEUP is true and the runtime supports subscribe(),
   * also starts the wake-up subscription.
   */
  start(intervalMs: number): void {
    if (this._timer !== null) return;
    this._timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    if (this._realtimeWakeup && this.deps.runtime.subscribe) {
      void this.startWakeup();
    }
  }

  /**
   * Stop polling and any wake-up subscription.
   */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.stopWakeup();
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
