import assert from "node:assert/strict";
import test from "node:test";

import type { Freshness, Item, State, Stop } from "../src/api.ts";
import { formatState, isStale, orderItems, stopBadge } from "../src/view-helpers.ts";

// ---- formatState -----------------------------------------------------------

test("formatState: renders label, source, and timestamp", () => {
  const state: State = {
    label: "Running",
    source: "runtime",
    at: "2026-09-07T10:00:00.000Z",
  };
  const result = formatState(state);
  assert.ok(result.includes("Running"), "should include label");
  assert.ok(result.includes("runtime"), "should include source");
});

test("formatState: renders 'no timestamp' when at is null", () => {
  const state: State = { label: "Pending", source: "ledger", at: null };
  const result = formatState(state);
  assert.ok(result.includes("no timestamp"), "should say no timestamp");
});

test("formatState: renders stale state unchanged (stale flag does not affect text)", () => {
  const state: State = {
    label: "Stale run",
    source: "adapter",
    at: "2026-09-07T09:00:00.000Z",
    stale: true,
  };
  const result = formatState(state);
  assert.ok(result.includes("Stale run"), "should include label even when stale");
});

// ---- stopBadge -------------------------------------------------------------

test("stopBadge: stopping state without checkpoint", () => {
  const stop: Stop = { attemptId: "a1", state: "stopping", at: "2026-09-07T10:00:00.000Z" };
  assert.equal(stopBadge(stop), "[stopping]");
});

test("stopBadge: stopped state without checkpoint", () => {
  const stop: Stop = { attemptId: "a2", state: "stopped", at: "2026-09-07T10:00:00.000Z" };
  assert.equal(stopBadge(stop), "[stopped]");
});

test("stopBadge: uncertain state without checkpoint", () => {
  const stop: Stop = { attemptId: "a3", state: "uncertain", at: "2026-09-07T10:00:00.000Z" };
  assert.equal(stopBadge(stop), "[uncertain]");
});

test("stopBadge: includes truncated checkpoint commit when present", () => {
  const stop: Stop = {
    attemptId: "a4",
    state: "stopped",
    checkpointCommit: "abcdef1234567890",
    at: "2026-09-07T10:00:00.000Z",
  };
  const result = stopBadge(stop);
  assert.ok(result.includes("[stopped]"), "should include state");
  assert.ok(result.includes("abcdef12"), "should include first 8 chars of commit");
});

// ---- isStale ---------------------------------------------------------------

test("isStale: returns true when freshness.stale is true regardless of poll time", () => {
  const freshness: Freshness = {
    lastPollAt: new Date().toISOString(),
    stale: true,
  };
  assert.equal(isStale(freshness, new Date(), 5 * 60 * 1000), true);
});

test("isStale: returns true when lastPollAt is null", () => {
  const freshness: Freshness = { lastPollAt: null, stale: false };
  assert.equal(isStale(freshness, new Date(), 5 * 60 * 1000), true);
});

test("isStale: returns false when poll is recent and stale is false", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");
  const freshness: Freshness = {
    lastPollAt: "2026-09-07T09:58:00.000Z", // 2 minutes ago
    stale: false,
  };
  assert.equal(isStale(freshness, now, 5 * 60 * 1000), false);
});

test("isStale: returns true when poll exceeded threshold", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");
  const freshness: Freshness = {
    lastPollAt: "2026-09-07T09:50:00.000Z", // 10 minutes ago
    stale: false,
  };
  assert.equal(isStale(freshness, now, 5 * 60 * 1000), true);
});

// ---- orderItems ------------------------------------------------------------

function makeItem(id: string): Item {
  const s: State = { label: "ok", source: "ledger", at: null };
  return {
    workItemId: id,
    intent: `intent for ${id}`,
    contract: s,
    execution: s,
    verification: s,
    acceptance: s,
  };
}

test("orderItems: returns all items when no mainEffortId", () => {
  const changed = [makeItem("a"), makeItem("b")];
  const cont = [makeItem("c")];
  const result = orderItems(changed, cont, null);
  assert.deepEqual(
    result.map((i) => i.workItemId),
    ["a", "b", "c"],
  );
});

test("orderItems: mainEffort item floated to front", () => {
  const changed = [makeItem("a"), makeItem("b")];
  const cont = [makeItem("c")];
  const result = orderItems(changed, cont, "b");
  assert.equal(result[0]?.workItemId, "b");
});

test("orderItems: mainEffort already first stays at position 0", () => {
  const changed = [makeItem("x"), makeItem("y")];
  const result = orderItems(changed, [], "x");
  assert.equal(result[0]?.workItemId, "x");
});

test("orderItems: mainEffort not found returns original order", () => {
  const changed = [makeItem("a"), makeItem("b")];
  const result = orderItems(changed, [], "z");
  assert.deepEqual(
    result.map((i) => i.workItemId),
    ["a", "b"],
  );
});
