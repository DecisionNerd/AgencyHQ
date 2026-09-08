/**
 * ExecutionRuntime interface and related types.
 *
 * This file defines the interface that both the real Trigger.dev client and
 * the in-memory FakeExecutionRuntime implement.  It has no @trigger.dev
 * imports so it can be imported freely from domain and test code.
 */

/** The 13 Trigger.dev v4 run statuses. */
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

/**
 * Statuses a Trigger run will never leave.
 *
 * Idempotency key behaviour (EXECUTION_MODEL.md):
 * - Keys are cleared when the run reaches a failure status (FAILED, CRASHED,
 *   SYSTEM_FAILURE, EXPIRED, TIMED_OUT).
 * - Keys are kept when the run reaches COMPLETED or CANCELED.
 */
export const FINAL_RUN_STATUSES: ReadonlySet<TriggerRunStatus> = new Set<TriggerRunStatus>([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "TIMED_OUT",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
]);

/** Failure-class final statuses: idempotency keys are cleared on these. */
export const FAILURE_RUN_STATUSES: ReadonlySet<TriggerRunStatus> = new Set<TriggerRunStatus>([
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

/** A snapshot of a run, as observed by the coordinator. */
export type RunObservation = {
  runId: string;
  status: TriggerRunStatus;
  output?: unknown;
  metadata?: Record<string, unknown>;
  error?: { message: string; name?: string };
  /** ISO-8601 timestamp of when this observation was taken. */
  observedAt: string;
};

/**
 * The interface every execution-runtime adapter must satisfy.
 *
 * Identical to what packages/domain/src/ports.ts will define.  Copied here
 * so trigger/ can implement it without creating a circular workspace
 * dependency.
 */
export interface ExecutionRuntime {
  /**
   * Trigger a task run.
   *
   * - `idempotencyKey`: global-scope key; the same key within its TTL window
   *   always resolves to the same run id.
   * - `concurrencyKey`: serializes attempts per repository.
   * - `tags`: used for coordinator subscriptions and filtering.
   */
  trigger(input: {
    intentId: string;
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

  /** Cancel an in-flight run.  Resolves even if the run is already final. */
  cancel(runId: string): Promise<void>;

  /** Retrieve the current state of a run. */
  retrieve(runId: string): Promise<RunObservation>;

  /** Create a short-lived public access token filtered to the given tags. */
  createPublicToken(input: { tags: string[]; expiresIn: string }): Promise<string>;

  /**
   * Subscribe to real-time run updates for runs carrying any of the given tags.
   *
   * This is a **wake-up hint** — the coordinator still polls as the authoritative
   * path; subscribe just accelerates delivery of state changes.  The returned
   * promise resolves when the signal is aborted or an error ends the subscription.
   * On error the subscription ends silently; the caller falls back to polling.
   *
   * `onObservation` is called with the same `RunObservation` shape as `retrieve`.
   *
   * Optional: implementations that do not support real-time delivery may omit this
   * method.  The coordinator checks for its presence before calling.
   */
  subscribe?(
    input: { tags: string[]; signal: AbortSignal },
    onObservation: (obs: RunObservation) => void,
  ): Promise<void>;
}

export * from "./fake.ts";
// Re-export the real runtime and its error type.
export type { SdkSurface } from "./real.ts";
export { RealExecutionRuntime, RuntimeError } from "./real.ts";
