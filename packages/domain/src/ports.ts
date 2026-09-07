/**
 * Port interfaces for the domain.
 * These are implemented by adapters (infrastructure); the domain itself
 * only declares the shape.
 */

import type { DispatchIntentId } from "./ids.ts";

// ---------------------------------------------------------------------------
// TriggerRunStatus
// All Trigger v4 run statuses.
// ---------------------------------------------------------------------------
export type TriggerRunStatus =
  | "PENDING_VERSION"
  | "QUEUED"
  | "DEQUEUED"
  | "EXECUTING"
  | "WAITING"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED"
  | "TIMED_OUT"
  | "CRASHED"
  | "SYSTEM_FAILURE"
  | "EXPIRED"
  | "DELAYED";

/** Statuses from which a run will not progress further. */
export const FINAL_RUN_STATUSES: ReadonlySet<TriggerRunStatus> = new Set<TriggerRunStatus>([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "TIMED_OUT",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
]);

// ---------------------------------------------------------------------------
// RunObservation
// ---------------------------------------------------------------------------
export type RunObservation = {
  readonly runId: string;
  readonly status: TriggerRunStatus;
  readonly output?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly error?: { readonly message: string; readonly name?: string };
  readonly observedAt: string;
};

// ---------------------------------------------------------------------------
// ExecutionRuntime port
// ---------------------------------------------------------------------------
export interface ExecutionRuntime {
  trigger(input: {
    intentId: DispatchIntentId;
    task: string;
    payload: unknown;
    options: {
      idempotencyKey: string;
      idempotencyKeyTtl?: string;
      concurrencyKey?: string;
      tags?: string[];
      maxDurationSeconds?: number;
    };
  }): Promise<{ runId: string }>;

  cancel(runId: string): Promise<void>;

  retrieve(runId: string): Promise<RunObservation>;

  createPublicToken(input: { tags: string[]; expiresIn: string }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Clock port
// ---------------------------------------------------------------------------
export interface Clock {
  now(): string;
}

// ---------------------------------------------------------------------------
// IdGen port
// ---------------------------------------------------------------------------
export interface IdGen {
  next(prefix: string): string;
}
