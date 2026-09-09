/**
 * Campaign aggregate.
 *
 * A Campaign groups work items under a shared identity, designates one of them
 * as the "main effort" (the primary priority within the campaign), and defines
 * a total order over campaign members for dispatch.
 *
 * R-008: Dispatch shall follow explicit rank, preserve the main effort's
 * identity when blocked, serialize attempts per repository, and record every
 * exception.
 */

import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Campaign type
// ---------------------------------------------------------------------------

export type Campaign = {
  readonly id: string;
  readonly name: string;
  /**
   * The work-item id designated as the campaign's main effort, or null when
   * none has been designated yet.
   */
  readonly mainEffortWorkItemId: string | null;
};

// ---------------------------------------------------------------------------
// CampaignWorkItemLike
// Minimal shape required for campaignRankOrder.
// ---------------------------------------------------------------------------

export type CampaignWorkItemLike = {
  readonly id: string;
  readonly campaignId: string;
  readonly rank: number;
  /** ISO 8601 datetime string. Used as a tie-breaker after rank. */
  readonly createdAt: string;
};

// ---------------------------------------------------------------------------
// setMainEffort
// ---------------------------------------------------------------------------

/**
 * Designates `workItem` as the main effort of `campaign`.
 *
 * Returns Err("work_item_not_in_campaign") when the work item's campaignId
 * does not match the campaign's id.  The work item must belong to the campaign
 * before it can be designated as main effort — a cross-campaign designation is
 * a domain error.
 */
export function setMainEffort(
  campaign: Campaign,
  workItem: { readonly id: string; readonly campaignId: string },
): Result<Campaign, "work_item_not_in_campaign"> {
  if (workItem.campaignId !== campaign.id) {
    return err("work_item_not_in_campaign" as const);
  }
  return ok({ ...campaign, mainEffortWorkItemId: workItem.id });
}

// ---------------------------------------------------------------------------
// campaignRankOrder
// ---------------------------------------------------------------------------

/**
 * Returns a new array containing the same items sorted by the campaign total
 * order: (rank asc, createdAt asc, id asc).
 *
 * This is a **total** order — no two distinct items compare equal.  The `id`
 * tie-breaker ensures stability even when rank and createdAt are identical.
 *
 * Items from different campaigns may be mixed in the input; the sort key does
 * not filter by campaign.  Callers that want a per-campaign order should pass
 * only the items for a single campaign.
 */
export function campaignRankOrder<T extends CampaignWorkItemLike>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}
