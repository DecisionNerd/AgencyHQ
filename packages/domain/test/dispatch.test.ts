import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveAttemptLike, WorkItemLike } from "../src/dispatch/select.ts";
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

function attempt(workItemId: string, repositoryId: string): ActiveAttemptLike {
  return { workItemId, repositoryId, status: "EXECUTING" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("dispatches nothing when workItems is empty", () => {
  const result = selectDispatch({
    workItems: [],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.mainEffort, null);
});

test("dispatches the single eligible item", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a")],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.mainEffort, "w1");
});

test("rank ordering: lower rank number dispatched first", () => {
  const result = selectDispatch({
    workItems: [item("w2", 2, "repo-b"), item("w1", 1, "repo-a")],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.equal(result.skipped[0]?.reason, "no_slot");
  assert.equal(result.mainEffort, "w1");
});

test("rank tie broken by id ascending", () => {
  const result = selectDispatch({
    workItems: [item("w-b", 1, "repo-b"), item("w-a", 1, "repo-a")],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w-a", repositoryId: "repo-a" }]);
  assert.equal(result.skipped[0]?.workItemId, "w-b");
  assert.equal(result.skipped[0]?.reason, "no_slot");
});

test("one-per-repo: second item in same repo is skipped repository_busy", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a"), item("w2", 2, "repo-a")],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.equal(result.skipped[0]?.workItemId, "w2");
  assert.equal(result.skipped[0]?.reason, "repository_busy");
});

test("existing active attempt makes repo busy (repository_busy)", () => {
  const result = selectDispatch({
    workItems: [item("w2", 1, "repo-a")],
    activeAttempts: [attempt("w1", "repo-a")],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.reason, "repository_busy");
});

test("uncertain repository skipped (repository_uncertain)", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a")],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: ["repo-a"],
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.reason, "repository_uncertain");
  // mainEffort is still set — eligibility test ignores repo uncertainty
  assert.equal(result.mainEffort, "w1");
});

test("slots limit: only `slots` items dispatched", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a"), item("w2", 2, "repo-b"), item("w3", 3, "repo-c")],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
  });
  assert.equal(result.dispatch.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "no_slot");
});

test("mainEffort is chosen even when the top item is busy", () => {
  // w1 is busy (its repo has an existing attempt); it should still be mainEffort
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a"), item("w2", 2, "repo-b")],
    activeAttempts: [attempt("w1", "repo-a")],
    slots: 1,
    uncertainRepositories: [],
  });
  // w1 is skipped already_active; w2 dispatches
  assert.equal(result.mainEffort, "w1");
  assert.deepEqual(result.dispatch, [{ workItemId: "w2", repositoryId: "repo-b" }]);
  assert.equal(result.skipped[0]?.reason, "already_active");
});

test("mainEffort is chosen even when top item is no_slot", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a"), item("w2", 2, "repo-b")],
    activeAttempts: [],
    slots: 0,
    uncertainRepositories: [],
  });
  assert.equal(result.mainEffort, "w1");
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.reason, "no_slot");
});

test("not_admitted lifecycle skipped with not_admitted", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { lifecycle: "proposed" })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.equal(result.skipped[0]?.reason, "not_admitted");
  assert.equal(result.mainEffort, null);
});

test("blocked condition skipped with blocked", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { condition: "blocked" })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.equal(result.skipped[0]?.reason, "blocked");
  assert.equal(result.mainEffort, null);
});

test("uncertain condition skipped with uncertain", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { condition: "uncertain" })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.equal(result.skipped[0]?.reason, "uncertain");
  assert.equal(result.mainEffort, null);
});

test("already_active: work item with existing attempt skipped", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a")],
    activeAttempts: [attempt("w1", "repo-a")],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.equal(result.skipped[0]?.reason, "already_active");
  // mainEffort is still set — already_active does not affect eligibility
  assert.equal(result.mainEffort, "w1");
});

test("full skipped-reasons table: each reason appears correctly", () => {
  const result = selectDispatch({
    workItems: [
      item("proposed", 1, "repo-p", { lifecycle: "proposed" }),
      item("blocked", 2, "repo-q", { condition: "blocked" }),
      item("uncertain", 3, "repo-r", { condition: "uncertain" }),
      item("active-a", 4, "repo-s"), // healthy eligible
      item("active-dupe", 5, "repo-s"), // same repo → busy
      item("already", 6, "repo-t"), // has existing attempt
      item("repo-unc", 7, "repo-u"), // uncertain repo
      item("no-slot", 8, "repo-v"), // slot used by active-a
    ],
    activeAttempts: [attempt("already", "repo-t")],
    slots: 1,
    uncertainRepositories: ["repo-u"],
  });

  const reasons = Object.fromEntries(result.skipped.map((s) => [s.workItemId, s.reason]));
  assert.equal(reasons.proposed, "not_admitted");
  assert.equal(reasons.blocked, "blocked");
  assert.equal(reasons.uncertain, "uncertain");
  assert.equal(reasons["active-dupe"], "repository_busy");
  assert.equal(reasons.already, "already_active");
  assert.equal(reasons["repo-unc"], "repository_uncertain");
  assert.equal(reasons["no-slot"], "no_slot");

  assert.deepEqual(result.dispatch, [{ workItemId: "active-a", repositoryId: "repo-s" }]);
  assert.equal(result.mainEffort, "active-a");
});

test("reopened and active lifecycles are eligible", () => {
  const result = selectDispatch({
    workItems: [
      item("w-reopened", 1, "repo-a", { lifecycle: "reopened" }),
      item("w-active", 2, "repo-b", { lifecycle: "active" }),
    ],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
  });
  assert.equal(result.dispatch.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.mainEffort, "w-reopened");
});

test("completed and halted lifecycles are not eligible", () => {
  const result = selectDispatch({
    workItems: [
      item("w-comp", 1, "repo-a", { lifecycle: "completed" }),
      item("w-halt", 2, "repo-b", { lifecycle: "halted" }),
    ],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
  });
  assert.equal(result.dispatch.length, 0);
  assert.equal(result.mainEffort, null);
});
