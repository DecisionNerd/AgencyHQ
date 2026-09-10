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
  // w1 is busy (its repo has an existing attempt); it should still be mainEffort.
  // slots=2 so the one active attempt occupies one slot and w2 can be dispatched.
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a"), item("w2", 2, "repo-b")],
    activeAttempts: [attempt("w1", "repo-a")],
    slots: 2,
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
  // slots=2: one slot consumed by the pre-existing active attempt on repo-t,
  // one remaining slot consumed by active-a.  no-slot then has no slot left.
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
    slots: 2,
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

// ---------------------------------------------------------------------------
// Slot accounting: active attempts count against the slot limit
// ---------------------------------------------------------------------------

test("slot accounting (a): slots=1, one active attempt on another repo → queued item skipped no_slot", () => {
  // The active attempt occupies the single slot even though it is on a different
  // repository.  The queued item is eligible (healthy, admitted, distinct repo)
  // but must receive no_slot because slotsUsed starts at activeAttempts.length.
  const result = selectDispatch({
    workItems: [item("w2", 1, "repo-b")],
    activeAttempts: [attempt("w1", "repo-a")],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.workItemId, "w2");
  assert.equal(result.skipped[0]?.reason, "no_slot");
  assert.equal(result.mainEffort, "w2");
});

test("slot accounting (b): slots=2, one active attempt, two queued items on two other repos → first dispatched, second no_slot", () => {
  // One active attempt → slotsUsed=1 before this pass.  Only one additional
  // selection can be made (slots 2 − 1 already used = 1 remaining).
  const result = selectDispatch({
    workItems: [item("w2", 1, "repo-b"), item("w3", 2, "repo-c")],
    activeAttempts: [attempt("w1", "repo-a")],
    slots: 2,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w2", repositoryId: "repo-b" }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.workItemId, "w3");
  assert.equal(result.skipped[0]?.reason, "no_slot");
});

test("slot accounting (c): slots=2, zero active, two queued on two repos → both dispatched", () => {
  // Baseline: with no active attempts slotsUsed=0 and both items dispatch.
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a"), item("w2", 2, "repo-b")],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
  });
  assert.equal(result.dispatch.length, 2);
  assert.equal(result.skipped.length, 0);
});

test("slot accounting (d): dispatched.length + activeAttempts.length <= slots for arbitrary eligible inputs", () => {
  // Property: the total of pre-existing active attempts plus newly dispatched
  // selections never exceeds the slot limit.
  const repos = ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"];
  for (const slots of [0, 1, 2, 3]) {
    for (let activeCount = 0; activeCount <= slots; activeCount++) {
      const activeAttempts: ActiveAttemptLike[] = repos
        .slice(0, activeCount)
        .map((r, i) => attempt(`active-${i}`, r));
      // Queued items on the remaining repos (those not busy).
      const freeRepos = repos.slice(activeCount);
      const workItems: WorkItemLike[] = freeRepos.map((r, i) => item(`queued-${i}`, i + 1, r));
      const result = selectDispatch({
        workItems,
        activeAttempts,
        slots,
        uncertainRepositories: [],
      });
      assert.ok(
        result.dispatch.length + activeAttempts.length <= slots,
        `slots=${slots} active=${activeCount} dispatched=${result.dispatch.length}: total exceeds slot limit`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// intentSeq tie-break tests (deflake admission-N2)
// ---------------------------------------------------------------------------

test("intentSeq breaks ties when rank and createdAt compare equal", () => {
  // Same rank, same createdAt.  Ids chosen so that "w-z" > "w-a" lexicographically
  // — without intentSeq the id comparison would dispatch w-a first.  With intentSeq,
  // w-z (seq=1) sorts before w-a (seq=2) because intentSeq precedes id in the sort.
  const TS = "2026-01-01T00:00:00.000Z";
  const result = selectDispatch({
    workItems: [
      item("w-a", 1, "repo-a", { createdAt: TS, intentSeq: 2 }),
      item("w-z", 1, "repo-z", { createdAt: TS, intentSeq: 1 }),
    ],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w-z", repositoryId: "repo-z" }]);
  assert.equal(result.skipped[0]?.workItemId, "w-a");
  assert.equal(result.skipped[0]?.reason, "no_slot");
});

test("intentSeq absent items sort after items that carry an intentSeq", () => {
  // w-z: intentSeq=1 (lower seq → higher priority).  w-a: no intentSeq (MAX_SAFE_INTEGER).
  // Same rank, same createdAt.  Without intentSeq, id comparison dispatches w-a first
  // ("w-a" < "w-z").  With intentSeq before id in the sort, w-z is dispatched first.
  const TS = "2026-01-01T00:00:00.000Z";
  const result = selectDispatch({
    workItems: [
      item("w-a", 1, "repo-a", { createdAt: TS }),
      item("w-z", 1, "repo-z", { createdAt: TS, intentSeq: 1 }),
    ],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w-z", repositoryId: "repo-z" }]);
  assert.equal(result.skipped[0]?.workItemId, "w-a");
  assert.equal(result.skipped[0]?.reason, "no_slot");
});
