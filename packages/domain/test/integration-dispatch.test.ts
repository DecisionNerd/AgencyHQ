/**
 * Tests for the integration_pending skip reason in dispatch/select.ts.
 *
 * See: packages/domain/src/dispatch/select.ts
 * See: docs/REQUIREMENTS.md R-008
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

// ---------------------------------------------------------------------------
// integration_pending skip reason
// ---------------------------------------------------------------------------

test("integration_pending: item with hasOpenIntegrateIntent=true is skipped", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { hasOpenIntegrateIntent: true })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.reason, "integration_pending");
  assert.equal(result.skipped[0]?.workItemId, "w1");
});

test("integration_pending: mainEffort is still set even when top item has pending integration", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { hasOpenIntegrateIntent: true }), item("w2", 2, "repo-b")],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  // w1 is skipped integration_pending; w2 is dispatched
  assert.equal(result.mainEffort, "w1");
  assert.deepEqual(result.dispatch, [{ workItemId: "w2", repositoryId: "repo-b" }]);
  assert.equal(result.skipped[0]?.reason, "integration_pending");
  assert.equal(result.skipped[0]?.workItemId, "w1");
});

test("integration_pending: item without field behaves as before (dispatched normally)", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a")], // no hasOpenIntegrateIntent
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.deepEqual(result.skipped, []);
});

test("integration_pending: item with hasOpenIntegrateIntent=false behaves as normal", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { hasOpenIntegrateIntent: false })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.deepEqual(result.skipped, []);
});

test("integration_pending: only the item with pending integration is skipped", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { hasOpenIntegrateIntent: true }),
      item("w2", 2, "repo-b", { hasOpenIntegrateIntent: true }),
      item("w3", 3, "repo-c"),
    ],
    activeAttempts: [],
    slots: 3,
    uncertainRepositories: [],
  });
  assert.equal(result.dispatch.length, 1);
  assert.equal(result.dispatch[0]?.workItemId, "w3");
  assert.equal(result.skipped.filter((s) => s.reason === "integration_pending").length, 2);
});

test("integration_pending: skipped before repo/slot checks (repo is not claimed)", () => {
  // w1 has open integrate intent; w2 is in the same repo.
  // Because w1 is skipped for integration_pending, w2's repo should not be
  // marked busy by w1's selection (it was never selected).
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { hasOpenIntegrateIntent: true }), item("w2", 2, "repo-a")],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
  });
  // w1 skipped for integration_pending; w2 can still be dispatched
  assert.deepEqual(result.dispatch, [{ workItemId: "w2", repositoryId: "repo-a" }]);
  assert.equal(result.skipped[0]?.reason, "integration_pending");
  assert.equal(result.skipped[0]?.workItemId, "w1");
});

test("integration_pending: full skipped-reasons table still works with integration_pending added", () => {
  const result = selectDispatch({
    workItems: [
      item("proposed", 1, "repo-p", { lifecycle: "proposed" }),
      item("blocked", 2, "repo-q", { condition: "blocked" }),
      item("integrating", 3, "repo-r", { hasOpenIntegrateIntent: true }),
      item("eligible", 4, "repo-s"),
    ],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });

  const reasons = Object.fromEntries(result.skipped.map((s) => [s.workItemId, s.reason]));
  assert.equal(reasons.proposed, "not_admitted");
  assert.equal(reasons.blocked, "blocked");
  assert.equal(reasons.integrating, "integration_pending");
  assert.equal(reasons["no-slot"], undefined); // eligible was dispatched
  assert.deepEqual(result.dispatch, [{ workItemId: "eligible", repositoryId: "repo-s" }]);
});
