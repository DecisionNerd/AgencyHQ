/**
 * WorkItem state transitions.
 * Pure (state, command) => Result<{workItem, events}, TransitionError>.
 * Table-driven; every illegal transition returns Err with code "illegal_transition".
 */

import type { WorkItem, WorkItemCondition, WorkItemLifecycle } from "../aggregates/work-item.ts";
import type { ManifestEntry } from "../integration/manifest.ts";
import { allResolved } from "../integration/manifest.ts";
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

/**
 * CompleteCommand is a discriminated union on boundary:
 *
 *   - "artifact": requires the attempt revision (commit SHA).
 *   - "merge": requires a fully-resolved RevisionManifest and its pre-computed
 *     digest.  The completion revision is taken from the last entry (highest
 *     position) in the manifest.  Returns Err when any entry is unresolved.
 *   - "deploy": always returns Err (DEPLOY_NOT_SUPPORTED) — deploy boundary
 *     completion is not yet implemented.
 */
export type CompleteCommand =
  | {
      readonly boundary: "artifact";
      readonly revision: string;
    }
  | {
      readonly boundary: "merge";
      /** Fully-resolved revision manifest (all entries must have resultRevision set). */
      readonly manifest: ManifestEntry[];
      /** Pre-computed digest of the manifest (from manifestDigestInput). */
      readonly manifestDigest: string;
    }
  | {
      readonly boundary: "deploy";
    };

export function complete(
  workItem: WorkItem,
  command: CompleteCommand,
): Result<{ workItem: WorkItem; events: WorkItemEvent[] }, WorkItemTransitionError> {
  const check = assertAllowed(workItem, "complete");
  if (!check.ok) return check;

  if (command.boundary === "artifact") {
    // artifact boundary requires an attempt revision
    if (!command.revision) {
      return err({
        code: "missing_revision",
        reason: "artifact boundary requires attempt revision",
      });
    }

    const next: WorkItem = {
      ...workItem,
      lifecycle: "completed",
      boundary: "artifact",
      version: workItem.version + 1,
    };

    return ok({
      workItem: next,
      events: [
        {
          type: "work_item.completed",
          workItemId: workItem.id,
          version: next.version,
          detail: { boundary: "artifact", revision: command.revision },
        },
      ],
    });
  }

  if (command.boundary === "merge") {
    // merge boundary requires all manifest entries to be resolved
    if (!allResolved(command.manifest)) {
      return err({
        code: "manifest_unresolved",
        reason: "all manifest entries must have resultRevision before completing merge boundary",
      });
    }

    // Completion revision = last entry's resultRevision (highest position)
    const sorted = [...command.manifest].sort((a, b) => a.position - b.position);
    const lastEntry = sorted[sorted.length - 1];
    // Safe: allResolved guarantees resultRevision is non-null on every entry
    const revision = lastEntry!.resultRevision as string;

    const next: WorkItem = {
      ...workItem,
      lifecycle: "completed",
      boundary: "merge",
      version: workItem.version + 1,
    };

    return ok({
      workItem: next,
      events: [
        {
          type: "work_item.completed",
          workItemId: workItem.id,
          version: next.version,
          detail: {
            boundary: "merge",
            revision,
            manifestDigest: command.manifestDigest,
          },
        },
      ],
    });
  }

  // boundary === "deploy"
  return err({
    code: "deploy_not_supported",
    reason: "deploy boundary completion is not yet implemented",
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
