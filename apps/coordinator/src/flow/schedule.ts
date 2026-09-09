/**
 * scheduleQueuedIntents — standalone scheduling pass.
 *
 * Loads queued worker intents, applies all gates (provider capacity,
 * repository busy, slot count) via selectDispatch, triggers chosen intents
 * via retryDispatch, and records skip_reason on the rest.
 *
 * Called from BoundedRepairFlow after admission (so gates apply at admission
 * time too — R-008) and from Reconciler.scheduleOnce() (thin wrapper) on
 * every poll and wake-up.
 */

import {
  listActiveAttemptsForScheduling,
  listCurrentCapacity,
  listQueuedWorkerIntents,
} from "@agencyhq/db";
import { selectDispatch, type WorkItemLike } from "@agencyhq/domain";

import type { FlowDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// scheduleQueuedIntents
// ---------------------------------------------------------------------------

/**
 * @param deps          Shared flow dependencies (pool, config.workerSlots, …).
 * @param retryDispatch Called for each intent the scheduler elects to dispatch.
 */
export async function scheduleQueuedIntents(
  deps: FlowDeps,
  retryDispatch: (intentId: string) => Promise<unknown>,
): Promise<void> {
  const { pool } = deps;
  const client = await pool.connect();
  try {
    // 1. Load queued intents with their work item data.
    const queuedIntents = await listQueuedWorkerIntents(client);
    if (queuedIntents.length === 0) return;

    // 2. Load active attempts for slot + repo counting.
    //    An attempt is active only when a worker process is or may be running:
    //    status='stopping' (always), or status IN ('dispatched','running') with
    //    an open worker.attempt intent (status='triggered').  Attempts whose only
    //    open intents are verify/review/accept runs are NOT counted — no worker
    //    process exists and holding slots/busyRepos for them blocks legitimate work.
    //    Terminal work item lifecycles (halted, completed, done) are also excluded.
    const activeRows = await listActiveAttemptsForScheduling(client);

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
      const item: WorkItemLike = {
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
      slots: deps.config.workerSlots ?? 1,
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
    // Try each item; collect errors so we attempt all before re-throwing.
    // Re-throwing lets callers that need error propagation (e.g. the admission
    // path in onLeadPlanOutput → Defect-4 recovery) see the failure.
    // Callers that want resilience (e.g. Reconciler.scheduleOnce) wrap with catch.
    let firstDispatchError: unknown = undefined;
    for (const item of result.dispatch) {
      const intentId = intentByWorkItem.get(item.workItemId);
      if (!intentId) continue;
      try {
        await retryDispatch(intentId);
      } catch (err) {
        console.error("[scheduler] retryDispatch failed", intentId, err);
        if (firstDispatchError === undefined) firstDispatchError = err;
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

    // Re-throw the first dispatch error after all items have been attempted.
    if (firstDispatchError !== undefined) throw firstDispatchError;
  } finally {
    client.release();
  }
}
