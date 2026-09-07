/**
 * WorkItem state transitions.
 * Pure (state, command) => Result<{workItem, events}, TransitionError>.
 * Table-driven; every illegal transition returns Err with code "illegal_transition".
 */

import type { Boundary } from "@agencyhq/contracts";
import type { WorkItem, WorkItemCondition, WorkItemLifecycle } from "../aggregates/work-item.ts";
import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Domain events (reuse shape from attempt transitions)
// ---------------------------------------------------------------------------
export type WorkItemEvent = {
  readonly type: string;
  readonly workItemId: string;
  readonly version: number;
  readonly at?: string;
  readonly detail?: unknown;
};

// ---------------------------------------------------------------------------
// TransitionError
// ---------------------------------------------------------------------------
export type WorkItemTransitionError =
  | {
      readonly code: "illegal_transition";
      readonly from: WorkItemLifecycle;
      readonly command: string;
    }
  | { readonly code: string; readonly reason?: string };

// ---------------------------------------------------------------------------
// WORK_ITEM_TRANSITIONS table
// Maps each lifecycle state to the set of commands allowed from it.
// ---------------------------------------------------------------------------
export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemLifecycle, ReadonlySet<string>>> = {
  proposed: new Set(["admit", "markCondition"]),
  admitted: new Set(["activate", "halt", "markCondition"]),
  active: new Set(["complete", "halt", "markCondition"]),
  completed: new Set([]),
  halted: new Set(["reopen", "markCondition"]),
  reopened: new Set(["activate", "halt", "complete", "markCondition"]),
};

function assertAllowed(workItem: WorkItem, command: string): Result<void, WorkItemTransitionError> {
  const allowed = WORK_ITEM_TRANSITIONS[workItem.lifecycle];
  if (!allowed.has(command)) {
    return err({ code: "illegal_transition", from: workItem.lifecycle, command });
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------
export function admit(
  workItem: WorkItem,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "admit");
  if (!check.ok) return check;

  const next: WorkItem = {
    ...workItem,
    lifecycle: "admitted",
    version: workItem.version + 1,
  };

  return ok({
    workItem: next,
    events: [
      {
        type: "work_item.admitted",
        workItemId: workItem.id,
        version: next.version,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------
export function activate(
  workItem: WorkItem,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "activate");
  if (!check.ok) return check;

  const next: WorkItem = {
    ...workItem,
    lifecycle: "active",
    version: workItem.version + 1,
  };

  return ok({
    workItem: next,
    events: [
      {
        type: "work_item.activated",
        workItemId: workItem.id,
        version: next.version,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------
export type CompleteCommand = {
  readonly boundary: Boundary;
  readonly revision: string;
};

export function complete(
  workItem: WorkItem,
  command: CompleteCommand,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "complete");
  if (!check.ok) return check;

  // artifact boundary requires an attempt revision
  if (command.boundary === "artifact" && !command.revision) {
    return err({ code: "missing_revision", reason: "artifact boundary requires attempt revision" });
  }

  const next: WorkItem = {
    ...workItem,
    lifecycle: "completed",
    boundary: command.boundary,
    version: workItem.version + 1,
  };

  return ok({
    workItem: next,
    events: [
      {
        type: "work_item.completed",
        workItemId: workItem.id,
        version: next.version,
        detail: { boundary: command.boundary, revision: command.revision },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// halt
// ---------------------------------------------------------------------------
export function halt(
  workItem: WorkItem,
  reason: string,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "halt");
  if (!check.ok) return check;

  const next: WorkItem = {
    ...workItem,
    lifecycle: "halted",
    condition: "blocked",
    version: workItem.version + 1,
  };

  return ok({
    workItem: next,
    events: [
      {
        type: "work_item.halted",
        workItemId: workItem.id,
        version: next.version,
        detail: { reason },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// reopen
// ---------------------------------------------------------------------------
export function reopen(
  workItem: WorkItem,
  reason: string,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "reopen");
  if (!check.ok) return check;

  const next: WorkItem = {
    ...workItem,
    lifecycle: "reopened",
    condition: "healthy",
    version: workItem.version + 1,
  };

  return ok({
    workItem: next,
    events: [
      {
        type: "work_item.reopened",
        workItemId: workItem.id,
        version: next.version,
        detail: { reason },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// markCondition
// ---------------------------------------------------------------------------
export function markCondition(
  workItem: WorkItem,
  condition: WorkItemCondition,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "markCondition");
  if (!check.ok) return check;

  const next: WorkItem = {
    ...workItem,
    condition,
    version: workItem.version + 1,
  };

  return ok({
    workItem: next,
    events: [
      {
        type: "work_item.condition_marked",
        workItemId: workItem.id,
        version: next.version,
        detail: { condition },
      },
    ],
  });
}
