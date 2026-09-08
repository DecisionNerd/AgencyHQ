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
  /**
   * Arbitrary adapter metadata attached to the observation.  Adapters that
   * report provider capacity information MUST include a `capacity` key with
   * the shape:
   *
   *   capacity: {
   *     provider: string;    // e.g. "anthropic"
   *     model: string;       // e.g. "claude-opus-4"
   *     status: "ok" | "limited" | "down";
   *     observedAt: string;  // ISO 8601
   *     validUntil: string;  // ISO 8601
   *   }
   *
   * The coordinator reads this field to update the ProviderCapacity store
   * after processing the observation through the normal dedupe path (R-010).
   */
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

  /**
   * Optional push-based observation subscription.
   *
   * When implemented, the adapter calls `onObservation` each time a run
   * matching the provided tags produces a new observation.  This is a
   * **wake-up hint only**: the coordinator MUST still poll via `retrieve` and
   * apply observations through the dedupe path (R-010) — it must not bypass
   * polling or skip the idempotency check based on a push event alone.
   *
   * The subscription must resolve (i.e. the adapter must clean up) when
   * `signal` is aborted.
   *
   * Adapters that do not support push-based observation may omit this method;
   * the coordinator falls back to polling-only mode.
   */
  subscribe?(
    input: { tags: string[]; signal: AbortSignal },
    onObservation: (obs: RunObservation) => void,
  ): Promise<void>;
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
