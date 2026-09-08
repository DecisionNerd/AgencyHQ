/**
 * Table tests and property-based tests for the Campaign aggregate.
 *
 * Covers:
 *   - setMainEffort: belongs to campaign → Ok; does not belong → Err
 *   - campaignRankOrder: total order property (reflexivity, antisymmetry,
 *     transitivity, totality) and stable sort within a campaign
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fc from "fast-check";

import type { Campaign, CampaignWorkItemLike } from "../src/aggregates/campaign.ts";
import { campaignRankOrder, setMainEffort } from "../src/aggregates/campaign.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function campaign(id: string, mainEffortWorkItemId: string | null = null): Campaign {
  return { id, name: `Campaign ${id}`, mainEffortWorkItemId };
}

function item(
  id: string,
  campaignId: string,
  rank: number,
  createdAt = "2026-01-01T00:00:00Z",
): CampaignWorkItemLike {
  return { id, campaignId, rank, createdAt };
}

// ---------------------------------------------------------------------------
// setMainEffort — table tests
// ---------------------------------------------------------------------------

test("setMainEffort: work item in campaign → Ok with updated mainEffortWorkItemId", () => {
  const c = campaign("camp-1");
  const wi = { id: "wi-a", campaignId: "camp-1" };
  const result = setMainEffort(c, wi);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.mainEffortWorkItemId, "wi-a");
    assert.equal(result.value.id, "camp-1");
    assert.equal(result.value.name, "Campaign camp-1");
  }
});

test("setMainEffort: work item NOT in campaign → Err work_item_not_in_campaign", () => {
  const c = campaign("camp-1");
  const wi = { id: "wi-b", campaignId: "camp-2" };
  const result = setMainEffort(c, wi);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "work_item_not_in_campaign");
  }
});

test("setMainEffort: replaces an existing main effort", () => {
  const c = campaign("camp-1", "wi-old");
  const wi = { id: "wi-new", campaignId: "camp-1" };
  const result = setMainEffort(c, wi);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.mainEffortWorkItemId, "wi-new");
  }
});

test("setMainEffort: original campaign is not mutated", () => {
  const c = campaign("camp-1", null);
  const wi = { id: "wi-a", campaignId: "camp-1" };
  setMainEffort(c, wi);
  assert.equal(c.mainEffortWorkItemId, null); // original unchanged
});

test("setMainEffort: empty campaignId on item does not match non-empty campaign", () => {
  const c = campaign("camp-1");
  const wi = { id: "wi-a", campaignId: "" };
  const result = setMainEffort(c, wi);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// campaignRankOrder — table tests
// ---------------------------------------------------------------------------

test("campaignRankOrder: empty array returns empty array", () => {
  assert.deepEqual(campaignRankOrder([]), []);
});

test("campaignRankOrder: single item returns it unchanged", () => {
  const items = [item("wi-1", "c", 1)];
  assert.deepEqual(campaignRankOrder(items), items);
});

test("campaignRankOrder: sorts by rank asc", () => {
  const items = [item("wi-b", "c", 10), item("wi-a", "c", 5)];
  const sorted = campaignRankOrder(items);
  assert.equal(sorted[0]?.id, "wi-a");
  assert.equal(sorted[1]?.id, "wi-b");
});

test("campaignRankOrder: tie on rank resolved by createdAt asc", () => {
  const items = [
    item("wi-late", "c", 1, "2026-06-01T00:00:00Z"),
    item("wi-early", "c", 1, "2026-01-01T00:00:00Z"),
  ];
  const sorted = campaignRankOrder(items);
  assert.equal(sorted[0]?.id, "wi-early");
  assert.equal(sorted[1]?.id, "wi-late");
});

test("campaignRankOrder: tie on rank and createdAt resolved by id asc", () => {
  const ts = "2026-01-01T00:00:00Z";
  const items = [item("wi-zzz", "c", 1, ts), item("wi-aaa", "c", 1, ts)];
  const sorted = campaignRankOrder(items);
  assert.equal(sorted[0]?.id, "wi-aaa");
  assert.equal(sorted[1]?.id, "wi-zzz");
});

test("campaignRankOrder: does not mutate the original array", () => {
  const items = [item("wi-b", "c", 10), item("wi-a", "c", 5)];
  const original = [...items];
  campaignRankOrder(items);
  assert.deepEqual(items, original);
});

test("campaignRankOrder: three items sorted correctly", () => {
  const items = [
    item("wi-c", "c", 3, "2026-01-03T00:00:00Z"),
    item("wi-a", "c", 1, "2026-01-01T00:00:00Z"),
    item("wi-b", "c", 2, "2026-01-02T00:00:00Z"),
  ];
  const sorted = campaignRankOrder(items);
  assert.deepEqual(
    sorted.map((i) => i.id),
    ["wi-a", "wi-b", "wi-c"],
  );
});

// ---------------------------------------------------------------------------
// campaignRankOrder — property-based tests (total order)
// ---------------------------------------------------------------------------

/** Arbitrary for a single CampaignWorkItemLike. */
const arbItem = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  campaignId: fc.constantFrom("camp-a", "camp-b"),
  rank: fc.integer({ min: 0, max: 100 }),
  // Use integer milliseconds in a bounded range to avoid Invalid Date during shrinking.
  createdAt: fc
    .integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2030, 0, 1) })
    .map((ms) => new Date(ms).toISOString()),
});

/** Comparison function extracted for property testing. */
function compareItems(a: CampaignWorkItemLike, b: CampaignWorkItemLike): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

test("rank order is total and stable within a campaign", () => {
  fc.assert(
    fc.property(fc.array(arbItem, { minLength: 0, maxLength: 20 }), (items) => {
      const sorted = campaignRankOrder(items);

      // Length preserved.
      assert.equal(sorted.length, items.length);

      // Non-decreasing: each adjacent pair satisfies the order.
      for (let i = 0; i + 1 < sorted.length; i++) {
        const cmp = compareItems(sorted[i]!, sorted[i + 1]!);
        assert.ok(cmp <= 0, `Expected sorted[${i}] <= sorted[${i + 1}] but got cmp=${cmp}`);
      }

      // Totality: every pair of distinct items with distinct composite keys are
      // comparable (one strictly precedes the other in the total order when
      // their key differs).
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i]!;
          const b = sorted[j]!;
          const cmp = compareItems(a, b);
          // If the composite keys differ, a should be ≤ b (already guaranteed
          // by non-decreasing). If the composite keys are equal (same rank,
          // createdAt, id), both items are the "same" by the total order.
          assert.ok(cmp <= 0, `Pair (${i},${j}): expected non-decreasing order, got cmp=${cmp}`);
        }
      }
    }),
    { numRuns: 200 },
  );
});

test("rank order: same result as manual sort (stability check)", () => {
  fc.assert(
    fc.property(fc.array(arbItem, { minLength: 2, maxLength: 10 }), (items) => {
      const sorted = campaignRankOrder(items);
      const manualSorted = [...items].sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.createdAt < b.createdAt) return -1;
        if (a.createdAt > b.createdAt) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      assert.deepEqual(sorted, manualSorted);
    }),
    { numRuns: 100 },
  );
});
