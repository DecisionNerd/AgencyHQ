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
  | "already_active";

export type SelectDispatchInput = {
  workItems: WorkItemLike[];
  activeAttempts: ActiveAttemptLike[];
  slots: number;
  /** Repository ids where no replacement run should be started (EXECUTION_MODEL). */
  uncertainRepositories: string[];
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
 * mainEffort is resolved before the per-slot gate (rules 1–2 only), so it is
 * stable even when the top item is blocked by a busy repository or slots.
 */
export function selectDispatch(input: SelectDispatchInput): SelectDispatchOutput {
  const { workItems, activeAttempts, slots, uncertainRepositories } = input;

  // Sort by rank ascending; break ties by id ascending (deterministic).
  const sorted = [...workItems].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

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
