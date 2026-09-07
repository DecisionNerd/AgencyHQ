import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItem, WorkItemLifecycle } from "../src/aggregates/work-item.ts";
import { newId } from "../src/ids.ts";
import type { Result } from "../src/result.ts";
import {
  activate,
  admit,
  complete,
  halt,
  markCondition,
  reopen,
  WORK_ITEM_TRANSITIONS,
  type WorkItemEvent,
  type WorkItemTransitionError,
} from "../src/transitions/work-item.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeWorkItem(lifecycle: WorkItemLifecycle): WorkItem {
  return {
    id: newId("wi"),
    projectId: newId("prj"),
    rank: 1,
    intent: "Fix parser bug",
    boundary: "artifact",
    lifecycle,
    condition: "healthy",
    mainEffort: true,
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Legal transitions
// ---------------------------------------------------------------------------

test("admit: proposed → admitted", () => {
  const wi = makeWorkItem("proposed");
  const result = admit(wi);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.lifecycle, "admitted");
    assert.equal(result.value.workItem.version, 2);
    assert.equal(result.value.events[0]?.type, "work_item.admitted");
  }
});

test("activate: admitted → active", () => {
  const wi = makeWorkItem("admitted");
  const result = activate(wi);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.lifecycle, "active");
    assert.equal(result.value.workItem.version, 2);
  }
});

test("activate: reopened → active", () => {
  const wi = makeWorkItem("reopened");
  const result = activate(wi);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.workItem.lifecycle, "active");
});

test("complete: active → completed with artifact boundary and revision", () => {
  const wi = makeWorkItem("active");
  const result = complete(wi, { boundary: "artifact", revision: "a".repeat(40) });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.lifecycle, "completed");
    assert.equal(result.value.workItem.boundary, "artifact");
    assert.equal(result.value.events[0]?.type, "work_item.completed");
  }
});

test("complete: reopened → completed", () => {
  const wi = makeWorkItem("reopened");
  const result = complete(wi, { boundary: "artifact", revision: "b".repeat(40) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.workItem.lifecycle, "completed");
});

test("halt: admitted → halted with condition blocked", () => {
  const wi = makeWorkItem("admitted");
  const result = halt(wi, "blocked on human decision");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.lifecycle, "halted");
    assert.equal(result.value.workItem.condition, "blocked");
  }
});

test("halt: active → halted", () => {
  const wi = makeWorkItem("active");
  const result = halt(wi, "process failure");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.workItem.lifecycle, "halted");
});

test("halt: reopened → halted", () => {
  const wi = makeWorkItem("reopened");
  const result = halt(wi, "blocked again");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.workItem.lifecycle, "halted");
});

test("reopen: halted → reopened with condition healthy", () => {
  const wi = makeWorkItem("halted");
  const result = reopen(wi, "condition cleared");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.lifecycle, "reopened");
    assert.equal(result.value.workItem.condition, "healthy");
  }
});

test("markCondition: proposed → condition updated", () => {
  const wi = makeWorkItem("proposed");
  const result = markCondition(wi, "blocked");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.workItem.condition, "blocked");
});

test("markCondition: active → uncertain", () => {
  const wi = makeWorkItem("active");
  const result = markCondition(wi, "uncertain");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.condition, "uncertain");
    assert.equal(result.value.workItem.version, 2);
  }
});

test("version increments on every transition", () => {
  let wi = makeWorkItem("proposed");
  assert.equal(wi.version, 1);

  const r1 = admit(wi);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  wi = r1.value.workItem;
  assert.equal(wi.version, 2);

  const r2 = activate(wi);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  wi = r2.value.workItem;
  assert.equal(wi.version, 3);

  const r3 = complete(wi, { boundary: "artifact", revision: "a".repeat(40) });
  assert.equal(r3.ok, true);
  if (!r3.ok) return;
  wi = r3.value.workItem;
  assert.equal(wi.version, 4);
});

// ---------------------------------------------------------------------------
// Illegal transitions — programmatically generated from WORK_ITEM_TRANSITIONS
// ---------------------------------------------------------------------------

const ALL_WI_COMMANDS = [
  "admit",
  "activate",
  "complete",
  "halt",
  "reopen",
  "markCondition",
] as const;

for (const [lifecycle, allowedSet] of Object.entries(WORK_ITEM_TRANSITIONS) as [
  WorkItemLifecycle,
  ReadonlySet<string>,
][]) {
  for (const command of ALL_WI_COMMANDS) {
    if (!allowedSet.has(command)) {
      test(`illegal_transition: ${lifecycle} × ${command} => Err`, () => {
        const wi = makeWorkItem(lifecycle);
        let result: Result<
          { workItem: WorkItem; events: WorkItemEvent[] },
          WorkItemTransitionError
        >;
        if (command === "admit") {
          result = admit(wi);
        } else if (command === "activate") {
          result = activate(wi);
        } else if (command === "complete") {
          result = complete(wi, { boundary: "artifact", revision: "a".repeat(40) });
        } else if (command === "halt") {
          result = halt(wi, "reason");
        } else if (command === "reopen") {
          result = reopen(wi, "reason");
        } else {
          result = markCondition(wi, "healthy");
        }
        assert.equal(result.ok, false, `Expected Err for ${lifecycle} × ${command}`);
        if (!result.ok) {
          assert.equal(result.error.code, "illegal_transition");
        }
      });
    }
  }
}
