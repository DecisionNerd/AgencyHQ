/**
 * Overview view: campaigns with main effort, projects, and ranked work items
 * with lifecycle/condition/boundary/pending-decision count.
 *
 * R-019: returning operator sees changes, pending decisions, and continuing runs.
 * Pure builder — no database access. DB reads live in the route loader in app.ts.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

import { openPendingDecisions } from "./pending.ts";

export type OverviewCampaignLike = {
  id: string;
  name: string;
  mainEffortWorkItemId: string | null;
};

export type OverviewWorkItemLike = {
  id: string;
  projectId: string;
  intent: string;
  rank: number;
  mainEffort: boolean;
  lifecycle: string;
  condition: string;
  boundary: "artifact" | "merge" | "deploy";
  campaignId: string | null;
};

export type OverviewDecisionLike = {
  id?: string;
  workItemId: string | null;
  kind?: string | null;
  outcome: string | null;
  attemptId?: string | null;
  at?: string | null;
};

export type OverviewProjectLike = {
  id: string;
};

/**
 * Per-project count of active attempts (dispatched|running|stopping).
 * Injected by the app layer from a DB query.
 */
export type OverviewActiveAttempt = {
  projectId: string;
  count: number;
};

/**
 * Single-row capacity summary for the overview (one per provider/model pair).
 * The effectiveStatus is pre-computed by the app layer using effectiveCapacity().
 */
export type OverviewCapacitySummary = {
  provider: string;
  model: string;
  /** Raw recorded status (ok|limited|down). */
  status: "ok" | "limited" | "down";
  /** Effective status after staleness check (ok|limited|down|unknown). */
  effectiveStatus: "ok" | "limited" | "down" | "unknown";
  /** Maximum concurrency for this effective status (null = unbounded). */
  concurrency: number | null;
  observedAt: string;
  validUntil: string;
  source: "adapter" | "operator";
};

export type OverviewInput = {
  campaigns: OverviewCampaignLike[];
  projects: OverviewProjectLike[];
  workItems: OverviewWorkItemLike[];
  decisions: OverviewDecisionLike[];
  /** Active attempt counts per project (dispatched|running|stopping). */
  activeAttempts?: OverviewActiveAttempt[];
  /** Current provider capacity summary rows. */
  capacity?: OverviewCapacitySummary[];
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type OverviewWorkItemEntry = {
  id: string;
  intent: string;
  rank: number;
  mainEffort: boolean;
  lifecycle: string;
  condition: string;
  boundary: "artifact" | "merge" | "deploy";
  campaignId: string | null;
  pendingDecisionCount: number;
};

export type OverviewProjectEntry = {
  id: string;
  /** Count of active attempts (dispatched|running|stopping) for this project. */
  activeAttempts: number;
  workItems: OverviewWorkItemEntry[];
};

export type OverviewCampaignEntry = {
  id: string;
  name: string;
  mainEffortWorkItemId: string | null;
};

export type OverviewView = {
  campaigns: OverviewCampaignEntry[];
  projects: OverviewProjectEntry[];
  /** Per-provider/model capacity summary (empty when no observations exist). */
  capacity: OverviewCapacitySummary[];
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the overview view from plain data.
 * Pure function — no side effects.
 */
export function buildOverviewView(input: OverviewInput): OverviewView {
  const { campaigns, projects, workItems, decisions } = input;

  // Count pending_human decisions per work item
  const pendingCountByWorkItem = new Map<string, number>();
  const withIds = decisions.map((d, i) => ({ ...d, id: d.id ?? `idx-${i}` }));
  for (const d of openPendingDecisions(withIds)) {
    if (d.workItemId) {
      const prev = pendingCountByWorkItem.get(d.workItemId) ?? 0;
      pendingCountByWorkItem.set(d.workItemId, prev + 1);
    }
  }

  // Build active-attempts map
  const activeByProject = new Map<string, number>();
  for (const aa of input.activeAttempts ?? []) {
    activeByProject.set(aa.projectId, aa.count);
  }

  const projectEntries: OverviewProjectEntry[] = projects.map((p) => {
    const projectWorkItems = workItems
      .filter((wi) => wi.projectId === p.id)
      .sort((a, b) => a.rank - b.rank)
      .map(
        (wi): OverviewWorkItemEntry => ({
          id: wi.id,
          intent: wi.intent,
          rank: wi.rank,
          mainEffort: wi.mainEffort,
          lifecycle: wi.lifecycle,
          condition: wi.condition,
          boundary: wi.boundary,
          campaignId: wi.campaignId,
          pendingDecisionCount: pendingCountByWorkItem.get(wi.id) ?? 0,
        }),
      );

    return {
      id: p.id,
      activeAttempts: activeByProject.get(p.id) ?? 0,
      workItems: projectWorkItems,
    };
  });

  const campaignEntries: OverviewCampaignEntry[] = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    mainEffortWorkItemId: c.mainEffortWorkItemId,
  }));

  return {
    campaigns: campaignEntries,
    projects: projectEntries,
    capacity: input.capacity ?? [],
  };
}
