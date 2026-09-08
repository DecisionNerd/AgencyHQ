/**
 * WorkItem aggregate.
 * A ranked, scoped unit of intended change with lifecycle and condition tracking.
 */

import type { Boundary } from "@agencyhq/contracts";
import type { ProjectId, WorkItemId } from "../ids.ts";

export type WorkItemLifecycle =
  | "proposed"
  | "admitted"
  | "active"
  | "completed"
  | "halted"
  | "reopened";

export type WorkItemCondition = "healthy" | "blocked" | "uncertain";

export type WorkItem = {
  readonly id: WorkItemId;
  readonly projectId: ProjectId;
  /** Explicit rank; lower number = higher priority. */
  readonly rank: number;
  /** Operator intent describing what must be changed. */
  readonly intent: string;
  /** Optional observed defect or reproduction steps. */
  readonly defect?: string;
  /** Completion boundary for this work item. */
  readonly boundary: Boundary;
  readonly lifecycle: WorkItemLifecycle;
  readonly condition: WorkItemCondition;
  /** Whether this is the designated main effort. */
  readonly mainEffort: boolean;
  /** Monotonic version counter; incremented on every state change. */
  readonly version: number;
};
