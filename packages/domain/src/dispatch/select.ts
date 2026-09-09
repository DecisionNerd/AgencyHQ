/**
 * Pure, deterministic dispatch selection: given a set of work items and
 * active attempts, return the items to dispatch and the reasons for skipping
 * the rest.
 *
 * R-008: Dispatch shall follow explicit rank, preserve the main effort's
 * identity when blocked, serialize attempts per repository, and record every
 * exception.
 */

/** Minimal work-item shape needed for dispatch selection. */
export type WorkItemLike = {
  id: string;
  projectId: string;
  repositoryId: string;
  /** Explicit rank: lower number = higher priority. */
  rank: number;
  lifecycle: "proposed" | "admitted" | "active" | "completed" | "halted" | "reopened";
  condition: "healthy" | "blocked" | "uncertain";
  mainEffort: boolean;
  /**
   * Optional: true when this work item has an open integrate intent (i.e.
   * integration is in flight for one of its repositories).  When true the
   * item is skipped with reason "integration_pending".  Absent or false
   * preserves existing dispatch behaviour unchanged.
   */
  hasOpenIntegrateIntent?: boolean;
  /**
   * Optional campaign membership.  When set, the item participates in
   * campaign-scoped ordering: the campaign's designated main effort is placed
   * first within the campaign group, then items are ordered by (rank asc,
   * createdAt asc, id asc).  Items without a campaignId use the existing
   * global (rank, id) order and are not affected by campaign logic.
   */
  campaignId?: string;
  /**
   * Optional ISO 8601 creation timestamp.  Used as a tie-breaker within a
   * campaign (rank asc, createdAt asc, id asc).  Absent items sort last on
   * this key within a campaign group.
   */
  createdAt?: string;
};

/** Minimal active-attempt shape needed to detect busy repositories. */
export type ActiveAttemptLike = {
  workItemId: string;
  repositoryId: string;
  status: string;
};

export type SkipReason =
  | "not_admitted"
  | "blocked"
  | "uncertain"
  | "repository_busy"
  | "repository_uncertain"
  | "no_slot"
  | "already_active"
  | "integration_pending";

/**
 * Design note — `not_main_effort_slot`:
 *
 * No new skip reason is introduced for campaign dispatch.  The campaign's main
 * effort is handled entirely through *ordering*: it is sorted to the front of
 * its campaign group, so it competes for a slot before any other campaign
 * member.  If the main effort is itself blocked, uncertain, or in an
 * unavailable repository, it still receives the appropriate existing skip
 * reason.  A dedicated `not_main_effort_slot` reason would only be needed if
 * we wanted to *reserve* a slot exclusively for the main effort when it cannot
 * run yet; that policy is not required here.
 */

export type SelectDispatchInput = {
  workItems: WorkItemLike[];
  activeAttempts: ActiveAttemptLike[];
  slots: number;
  /** Repository ids where no replacement run should be started (EXECUTION_MODEL). */
  uncertainRepositories: string[];
  /**
   * Optional map from campaignId → work-item id of that campaign's designated
   * main effort.  When provided, items whose campaignId matches a key are
   * sorted with the main effort first within the campaign, followed by the
   * campaign rank order (rank asc, createdAt asc, id asc).
   *
   * Items whose campaignId is absent from the map, or items with no campaignId,
   * use the existing global (rank asc, id asc) order.
   */
  mainEffortByCampaign?: Map<string, string> | Record<string, string>;
};

export type SelectDispatchOutput = {
  /** Work items to dispatch in this pass, in rank order. */
  dispatch: { workItemId: string; repositoryId: string }[];
  /** Items not dispatched and the reason why. */
  skipped: { workItemId: string; reason: SkipReason }[];
  /**
   * The id of the highest-ranked eligible work item (lifecycle
   * admitted|active|reopened AND condition healthy), whether or not it was
   * dispatched in this pass.  This is the single "main effort" the UI shows.
   * Null only when there are no eligible work items at all.
   */
  mainEffort: string | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise mainEffortByCampaign to a plain Map regardless of whether the
 * caller passed a Map or a Record.
 */
function toMap(
  input: Map<string, string> | Record<string, string> | undefined,
): Map<string, string> {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  return new Map(Object.entries(input));
}

/**
 * Precomputed sort key for one work item.
 *
 * Campaign ordering is implemented as a stable total order using an "anchor
 * rank" strategy so that the comparator is always transitive:
 *
 *   anchorRank  — for campaign items: the rank of that campaign's designated
 *                 main effort (all campaign members cluster at that rank).
 *                 For non-campaign items: the item's own rank.
 *   isNotMain   — 0 when the item IS the campaign's main effort (sorts first
 *                 within the cluster); 1 otherwise.
 *   localRank   — the item's own rank (tie-break within the cluster).
 *   createdAt   — ISO string tie-break after localRank.
 *   id          — final stable tie-break.
 *
 * Items outside any campaign (no campaignId, or campaignId not in the map)
 * sort purely by their own rank, which preserves the existing global rank
 * behaviour unchanged.
 */
type SortKey = {
  anchorRank: number;
  isNotMain: 0 | 1;
  localRank: number;
  createdAt: string;
  id: string;
};

function buildSortKey(
  item: WorkItemLike,
  mainEffortMap: Map<string, string>,
  mainEffortRankMap: Map<string, number>,
): SortKey {
  if (item.campaignId) {
    const mainEffortId = mainEffortMap.get(item.campaignId);
    if (mainEffortId !== undefined) {
      const anchorRank = mainEffortRankMap.get(item.campaignId) ?? item.rank;
      const isMain = mainEffortId === item.id;
      return {
        anchorRank,
        isNotMain: isMain ? 0 : 1,
        localRank: item.rank,
        createdAt: item.createdAt ?? "",
        id: item.id,
      };
    }
  }
  // Non-campaign item: sort by its own rank (existing behaviour).
  return {
    anchorRank: item.rank,
    isNotMain: 0,
    localRank: item.rank,
    createdAt: item.createdAt ?? "",
    id: item.id,
  };
}

function compareSortKeys(a: SortKey, b: SortKey): number {
  if (a.anchorRank !== b.anchorRank) return a.anchorRank - b.anchorRank;
  if (a.isNotMain !== b.isNotMain) return a.isNotMain - b.isNotMain;
  if (a.localRank !== b.localRank) return a.localRank - b.localRank;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// selectDispatch
// ---------------------------------------------------------------------------

/**
 * Select which work items to dispatch.
 *
 * Eligibility rules (applied in order):
 * 1. lifecycle must be admitted, active, or reopened; else → not_admitted
 * 2. condition must be healthy; blocked → blocked, uncertain → uncertain
 * 3. The work item must not already have an active attempt → already_active
 * 4. The item's repository must not be in uncertainRepositories → repository_uncertain
 * 5. The item's repository must not already have an active attempt or an
 *    earlier selection in this pass → repository_busy
 * 6. There must be remaining slot capacity → no_slot
 *
 * Campaign ordering (when mainEffortByCampaign is provided):
 *   Within a campaign the designated main effort is placed first; remaining
 *   campaign members follow in (rank asc, createdAt asc, id asc) order.
 *   Items without a campaignId retain the existing global (rank, id) order.
 *
 * mainEffort is resolved before the per-slot gate (rules 1–2 only), so it is
 * stable even when the top item is blocked by a busy repository or slots.
 */
export function selectDispatch(input: SelectDispatchInput): SelectDispatchOutput {
  const { workItems, activeAttempts, slots, uncertainRepositories } = input;
  const mainEffortMap = toMap(input.mainEffortByCampaign);

  // Pre-compute the anchor rank for each campaign (rank of its main effort).
  // This is needed to build sort keys before sorting.
  const mainEffortRankMap = new Map<string, number>();
  for (const [campaignId, mainEffortId] of mainEffortMap) {
    const mainEffortItem = workItems.find((w) => w.id === mainEffortId);
    if (mainEffortItem) {
      mainEffortRankMap.set(campaignId, mainEffortItem.rank);
    }
  }

  // Build sort keys once per item, then sort — ensures the comparator is
  // always transitive (pure numeric/string comparison on precomputed values).
  const withKeys = workItems.map((item) => ({
    item,
    key: buildSortKey(item, mainEffortMap, mainEffortRankMap),
  }));
  withKeys.sort(({ key: a }, { key: b }) => compareSortKeys(a, b));
  const sorted = withKeys.map(({ item }) => item);

  const uncertainRepoSet = new Set(uncertainRepositories);

  // Repositories that already have a running attempt (before this pass).
  const busyRepos = new Set(activeAttempts.map((a) => a.repositoryId));

  // Work items that already have a running attempt.
  const activeWorkItemIds = new Set(activeAttempts.map((a) => a.workItemId));

  // Repositories claimed by earlier selections in this pass.
  const selectedRepos = new Set<string>();

  const dispatch: { workItemId: string; repositoryId: string }[] = [];
  const skipped: { workItemId: string; reason: SkipReason }[] = [];
  let mainEffort: string | null = null;
  let slotsUsed = 0;

  for (const item of sorted) {
    // Rule 1: lifecycle gate.
    const lifecycleEligible =
      item.lifecycle === "admitted" || item.lifecycle === "active" || item.lifecycle === "reopened";
    if (!lifecycleEligible) {
      skipped.push({ workItemId: item.id, reason: "not_admitted" });
      continue;
    }

    // Rule 2: condition gate.
    if (item.condition !== "healthy") {
      skipped.push({
        workItemId: item.id,
        reason: item.condition === "blocked" ? "blocked" : "uncertain",
      });
      continue;
    }

    // mainEffort is determined from the first item that passes rules 1–2,
    // before any slot or repository checks.
    if (mainEffort === null) {
      mainEffort = item.id;
    }

    // Rule 2.5: integration is pending for this work item.
    // An open integrate intent means integration is in flight; dispatching a
    // new attempt would race with the integrator. Skipped regardless of repo
    // or slot state.
    if (item.hasOpenIntegrateIntent === true) {
      skipped.push({ workItemId: item.id, reason: "integration_pending" });
      continue;
    }

    // Rule 3: already has a running attempt.
    if (activeWorkItemIds.has(item.id)) {
      skipped.push({ workItemId: item.id, reason: "already_active" });
      continue;
    }

    // Rule 4: repository is uncertain.
    if (uncertainRepoSet.has(item.repositoryId)) {
      skipped.push({ workItemId: item.id, reason: "repository_uncertain" });
      continue;
    }

    // Rule 5: repository is busy (pre-existing or from this pass).
    if (busyRepos.has(item.repositoryId) || selectedRepos.has(item.repositoryId)) {
      skipped.push({ workItemId: item.id, reason: "repository_busy" });
      continue;
    }

    // Rule 6: slots exhausted.
    if (slotsUsed >= slots) {
      skipped.push({ workItemId: item.id, reason: "no_slot" });
      continue;
    }

    // Dispatch.
    dispatch.push({ workItemId: item.id, repositoryId: item.repositoryId });
    selectedRepos.add(item.repositoryId);
    slotsUsed++;
  }

  return { dispatch, skipped, mainEffort };
}
