/**
 * Table tests for campaign-scoped dispatch ordering.
 *
 * Verifies that when mainEffortByCampaign is provided:
 *   1. The campaign's main effort is placed first within the campaign group.
 *   2. Other campaign members follow in (rank, createdAt, id) order.
 *   3. Items outside any campaign retain the existing global (rank, id) order.
 *   4. Campaign items interleave with non-campaign items by global rank.
 *   5. Missing mainEffortByCampaign falls back to existing behaviour.
 *   6. Items with no campaignId are not affected by campaign logic.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItemLike } from "../src/dispatch/select.ts";
import { selectDispatch } from "../src/dispatch/select.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(
  id: string,
  rank: number,
  repositoryId: string,
  overrides: Partial<WorkItemLike> = {},
): WorkItemLike {
  return {
    id,
    projectId: "proj-1",
    repositoryId,
    rank,
    lifecycle: "admitted",
    condition: "healthy",
    mainEffort: false,
    ...overrides,
  };
}

function campaignItem(
  id: string,
  rank: number,
  repositoryId: string,
  campaignId: string,
  createdAt = "2026-01-01T00:00:00Z",
  overrides: Partial<WorkItemLike> = {},
): WorkItemLike {
  return item(id, rank, repositoryId, { campaignId, createdAt, ...overrides });
}

// ---------------------------------------------------------------------------
// Campaign ordering tests
// ---------------------------------------------------------------------------

test("campaign main effort dispatched before other campaign members", () => {
  // Both items in the same campaign; main effort has higher rank (lower priority)
  // but should still be dispatched first.
  const items = [
    campaignItem("wi-main", 10, "repo-a", "camp-1"),
    campaignItem("wi-other", 5, "repo-b", "camp-1"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map([["camp-1", "wi-main"]]),
  });

  assert.deepEqual(result.dispatch[0], { workItemId: "wi-main", repositoryId: "repo-a" });
  assert.deepEqual(result.dispatch[1], { workItemId: "wi-other", repositoryId: "repo-b" });
});

test("campaign rank order within campaign after main effort", () => {
  const items = [
    campaignItem("wi-main", 10, "repo-a", "camp-1", "2026-01-01T00:00:00Z"),
    campaignItem("wi-z", 8, "repo-b", "camp-1", "2026-01-02T00:00:00Z"),
    campaignItem("wi-a", 5, "repo-c", "camp-1", "2026-01-03T00:00:00Z"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 3,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map([["camp-1", "wi-main"]]),
  });

  // wi-main first (designated main effort), then wi-a (rank 5), then wi-z (rank 8)
  assert.equal(result.dispatch[0]?.workItemId, "wi-main");
  assert.equal(result.dispatch[1]?.workItemId, "wi-a");
  assert.equal(result.dispatch[2]?.workItemId, "wi-z");
});

test("items outside campaign keep global rank order", () => {
  const items = [
    item("wi-global-2", 20, "repo-d"),
    item("wi-global-1", 1, "repo-e"),
    campaignItem("wi-main", 10, "repo-a", "camp-1"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 3,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map([["camp-1", "wi-main"]]),
  });

  // Non-campaign items sort by global rank; campaign main effort sorts within camp
  // wi-global-1 (rank 1) < wi-main (rank 10, campaign first) < wi-global-2 (rank 20)
  assert.equal(result.dispatch[0]?.workItemId, "wi-global-1");
  assert.equal(result.dispatch[1]?.workItemId, "wi-main");
  assert.equal(result.dispatch[2]?.workItemId, "wi-global-2");
});

test("without mainEffortByCampaign, campaign items sort by global rank", () => {
  const items = [
    campaignItem("wi-high-rank", 10, "repo-a", "camp-1"),
    campaignItem("wi-low-rank", 5, "repo-b", "camp-1"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
    // No mainEffortByCampaign
  });

  // Falls back to global rank: wi-low-rank (5) dispatched first
  assert.equal(result.dispatch[0]?.workItemId, "wi-low-rank");
  assert.equal(result.dispatch[1]?.workItemId, "wi-high-rank");
});

test("mainEffortByCampaign as plain Record works the same as Map", () => {
  const items = [
    campaignItem("wi-main", 10, "repo-a", "camp-1"),
    campaignItem("wi-other", 5, "repo-b", "camp-1"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
    mainEffortByCampaign: { "camp-1": "wi-main" },
  });

  assert.equal(result.dispatch[0]?.workItemId, "wi-main");
  assert.equal(result.dispatch[1]?.workItemId, "wi-other");
});

test("main effort still gets eligible skip reason when blocked", () => {
  const items = [
    campaignItem("wi-main", 10, "repo-a", "camp-1", "2026-01-01T00:00:00Z", {
      condition: "blocked",
    }),
    campaignItem("wi-other", 5, "repo-b", "camp-1"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map([["camp-1", "wi-main"]]),
  });

  // wi-main is blocked, so wi-other gets dispatched
  assert.equal(result.skipped[0]?.workItemId, "wi-main");
  assert.equal(result.skipped[0]?.reason, "blocked");
  assert.equal(result.dispatch[0]?.workItemId, "wi-other");
  // mainEffort output is null — main effort didn't pass eligibility
  assert.equal(result.mainEffort, "wi-other");
});

test("campaign items from different campaigns: each group anchored at main effort rank", () => {
  // camp-a main effort has rank 8; camp-b main effort has rank 6.
  // Campaign groups are anchored at their main effort's rank.
  // Within each group: main effort first, then other members by local rank.
  //
  // Sort keys:
  //   camp-b-main:  anchor=6, isNotMain=0, local=6  → (6, 0, 6)
  //   camp-b-other: anchor=6, isNotMain=1, local=2  → (6, 1, 2)
  //   camp-a-main:  anchor=8, isNotMain=0, local=8  → (8, 0, 8)
  //   camp-a-other: anchor=8, isNotMain=1, local=3  → (8, 1, 3)
  const items = [
    campaignItem("camp-a-main", 8, "repo-a", "camp-a"),
    campaignItem("camp-a-other", 3, "repo-b", "camp-a"),
    campaignItem("camp-b-main", 6, "repo-c", "camp-b"),
    campaignItem("camp-b-other", 2, "repo-d", "camp-b"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 4,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map([
      ["camp-a", "camp-a-main"],
      ["camp-b", "camp-b-main"],
    ]),
  });

  assert.equal(result.dispatch[0]?.workItemId, "camp-b-main"); // anchor 6, isNotMain 0
  assert.equal(result.dispatch[1]?.workItemId, "camp-b-other"); // anchor 6, isNotMain 1
  assert.equal(result.dispatch[2]?.workItemId, "camp-a-main"); // anchor 8, isNotMain 0
  assert.equal(result.dispatch[3]?.workItemId, "camp-a-other"); // anchor 8, isNotMain 1
});

test("same campaign: createdAt tie-break used after rank within campaign", () => {
  const items = [
    campaignItem("wi-late", 5, "repo-a", "camp-1", "2026-06-01T00:00:00Z"),
    campaignItem("wi-early", 5, "repo-b", "camp-1", "2026-01-01T00:00:00Z"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map(), // no main effort designated
  });

  // Neither is main effort; rank ties, so createdAt asc → wi-early first
  assert.equal(result.dispatch[0]?.workItemId, "wi-early");
  assert.equal(result.dispatch[1]?.workItemId, "wi-late");
});

test("campaign item not in mainEffortByCampaign key uses campaign rank order", () => {
  // campaignId "camp-x" is absent from the map — treated as no main effort
  const items = [
    campaignItem("wi-b", 10, "repo-a", "camp-x"),
    campaignItem("wi-a", 5, "repo-b", "camp-x"),
  ];
  const result = selectDispatch({
    workItems: items,
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
    mainEffortByCampaign: new Map([["camp-y", "other-wi"]]),
  });

  // camp-x has no designated main effort; falls back to (rank, id)
  assert.equal(result.dispatch[0]?.workItemId, "wi-a"); // rank 5
  assert.equal(result.dispatch[1]?.workItemId, "wi-b"); // rank 10
});
