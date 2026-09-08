/**
 * In-memory deterministic ExecutionRuntime for tests.
 *
 * INVARIANT: this file must not import any trigger.dev SDK package.
 * The test suite asserts this by reading the source and checking for
 * import statements that reference the trigger.dev namespace.
 */

import type { ExecutionRuntime, RunObservation, TriggerRunStatus } from "./index.ts";
import { FAILURE_RUN_STATUSES, FINAL_RUN_STATUSES } from "./index.ts";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown by trigger() when dropNextResponse() was called. */
export class FakeNetworkError extends Error {
  override readonly name = "FakeNetworkError";

  constructor(message = "Simulated network error: lost trigger response") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Internal record types
// ---------------------------------------------------------------------------

type FakeRunStep = {
  status: TriggerRunStatus;
  output?: unknown;
  metadata?: Record<string, unknown>;
  error?: { message: string; name?: string };
};

type FakeRunRecord = {
  runId: string;
  task: string;
  payload: unknown;
  status: TriggerRunStatus;
  output?: unknown;
  metadata?: Record<string, unknown>;
  error?: { message: string; name?: string };
  cancelledAt?: string;
  /** Remaining scripted steps (consumed by advance()). */
  pendingSteps: FakeRunStep[];
};

/** Handler signature accepted by script(). */
export type FakeScriptHandler = (
  payload: unknown,
  run: Readonly<FakeRunRecord>,
) =>
  | {
      status: TriggerRunStatus;
      output?: unknown;
      metadata?: Record<string, unknown>;
      error?: { message: string; name?: string };
    }
  | Array<{
      status: TriggerRunStatus;
      output?: unknown;
      metadata?: Record<string, unknown>;
      error?: { message: string; name?: string };
    }>;

/** One entry in the calls log. */
export type FakeCallRecord = {
  method: "trigger" | "cancel" | "retrieve" | "createPublicToken";
  args: readonly unknown[];
};

// ---------------------------------------------------------------------------
// FakeExecutionRuntime
// ---------------------------------------------------------------------------

/**
 * Deterministic in-memory execution runtime.
 *
 * Usage in tests:
 *
 *   const fake = new FakeExecutionRuntime();
 *
 *   // Program the outcome of a task
 *   fake.script("worker.attempt", () => ({ status: "COMPLETED", output: { ok: true } }));
 *
 *   // Trigger and advance
 *   const { runId } = await fake.trigger({ intentId: "i1", task: "worker.attempt", payload: {}, options: { idempotencyKey: "k1" } });
 *   await fake.advance(runId);       // QUEUED → EXECUTING
 *   await fake.advance(runId);       // EXECUTING → COMPLETED
 *   const obs = await fake.retrieve(runId);
 *   assert.equal(obs.status, "COMPLETED");
 */
export class FakeExecutionRuntime implements ExecutionRuntime {
  // -------------------------------------------------------------------------
  // Public observable state
  // -------------------------------------------------------------------------

  /** Log of every method call in order. */
  public readonly calls: FakeCallRecord[] = [];

  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** All runs keyed by runId. */
  private readonly runs = new Map<string, FakeRunRecord>();

  /**
   * Idempotency table: key → runId.
   *
   * Keys are cleared on failure-class final statuses (FAILED, CRASHED,
   * SYSTEM_FAILURE, EXPIRED, TIMED_OUT) and kept on COMPLETED and CANCELED.
   */
  public readonly idempotency = new Map<string, string>();

  /** Per-task script handlers. */
  private readonly scripts = new Map<string, FakeScriptHandler>();

  /** When true, the next trigger() will register the run then throw. */
  private _dropNext = false;

  /** Monotonically increasing counter for deterministic run ids. */
  private _counter = 0;

  /** Injectable clock for observedAt timestamps. */
  private readonly _clock: () => string;

  constructor(clock?: () => string) {
    this._clock = clock ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // Configuration helpers
  // -------------------------------------------------------------------------

  /**
   * Register a script for a task.
   *
   * The handler is called at trigger time with the payload and the freshly
   * created (QUEUED) run record.  It returns either a single final step or an
   * array of steps that advance() will walk through after the built-in
   * QUEUED → EXECUTING transition.
   */
  script(task: string, handler: FakeScriptHandler): void {
    this.scripts.set(task, handler);
  }

  /**
   * Make the next trigger() call register the run internally (so idempotency
   * works) but throw a FakeNetworkError before returning the run handle.
   *
   * This simulates a "lost response": the caller does not learn the runId but
   * a retry with the same idempotency key returns the existing run.
   */
  dropNextResponse(): void {
    this._dropNext = true;
  }

  // -------------------------------------------------------------------------
  // ExecutionRuntime implementation
  // -------------------------------------------------------------------------

  async trigger(input: {
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
  }): Promise<{ runId: string }> {
    this.calls.push({ method: "trigger", args: [input] });

    const { task, payload, options } = input;
    const { idempotencyKey } = options;

    // --- Idempotency check ---
    const existingRunId = this.idempotency.get(idempotencyKey);
    if (existingRunId !== undefined) {
      // Key is live; return the existing run regardless of _dropNext.
      // (A real lost-response retry arrives here and gets the same runId.)
      if (this._dropNext) {
        this._dropNext = false;
        throw new FakeNetworkError();
      }
      return { runId: existingRunId };
    }

    // --- Create new run ---
    const runId = `run_fake_${++this._counter}`;
    const run: FakeRunRecord = {
      runId,
      task,
      payload,
      status: "QUEUED",
      pendingSteps: [],
    };

    // Build the advance queue.
    // The built-in QUEUED → EXECUTING transition is prepended automatically
    // only when the script's first step is not already EXECUTING (so that
    // a multi-step script starting with { status: "EXECUTING", metadata: … }
    // works as expected with the same number of advance() calls).
    const handler = this.scripts.get(task);
    if (handler !== undefined) {
      const handlerResult = handler(payload, run);
      const scriptedSteps = Array.isArray(handlerResult) ? handlerResult : [handlerResult];
      const firstStatus = scriptedSteps[0]?.status;
      run.pendingSteps =
        firstStatus === "EXECUTING"
          ? [...scriptedSteps]
          : [{ status: "EXECUTING" }, ...scriptedSteps];
    } else {
      run.pendingSteps = [{ status: "EXECUTING" }];
    }

    this.runs.set(runId, run);
    this.idempotency.set(idempotencyKey, runId);

    // --- Simulate lost response ---
    if (this._dropNext) {
      this._dropNext = false;
      // The run IS registered (idempotency key is live); we just don't
      // hand the caller the runId.
      throw new FakeNetworkError();
    }

    return { runId };
  }

  async cancel(runId: string): Promise<void> {
    this.calls.push({ method: "cancel", args: [runId] });

    const run = this._requireRun(runId);
    if (FINAL_RUN_STATUSES.has(run.status)) {
      // Already final; cancel is a no-op (mirrors observed API behaviour).
      return;
    }
    run.status = "CANCELED";
    run.cancelledAt = this._clock();
    run.pendingSteps = [];
    // CANCELED keeps the idempotency key (do not remove from this.idempotency).
  }

  async retrieve(runId: string): Promise<RunObservation> {
    this.calls.push({ method: "retrieve", args: [runId] });

    const run = this._requireRun(runId);
    return this._observe(run);
  }

  async createPublicToken(input: { tags: string[]; expiresIn: string }): Promise<string> {
    this.calls.push({ method: "createPublicToken", args: [input] });

    const tagStr = input.tags.slice().sort().join(",");
    return `public_token:tags=${tagStr}:expires=${input.expiresIn}`;
  }

  // -------------------------------------------------------------------------
  // Test-control helpers
  // -------------------------------------------------------------------------

  /**
   * Advance a single run by one step.
   *
   * The built-in progression is QUEUED → EXECUTING → scripted steps.
   * If the run is already in a final status or has no more steps, this is a
   * no-op.
   */
  advance(runId: string): void {
    const run = this._requireRun(runId);
    if (FINAL_RUN_STATUSES.has(run.status)) return;

    const next = run.pendingSteps.shift();
    if (next === undefined) return;

    run.status = next.status;
    if (next.output !== undefined) run.output = next.output;
    if (next.metadata !== undefined) run.metadata = { ...run.metadata, ...next.metadata };
    if (next.error !== undefined) run.error = next.error;

    // Clear the idempotency key on failure-class final statuses.
    if (FAILURE_RUN_STATUSES.has(run.status)) {
      for (const [key, rid] of this.idempotency.entries()) {
        if (rid === runId) {
          this.idempotency.delete(key);
          break;
        }
      }
    }
  }

  /** Advance all runs that are not yet in a final status. */
  advanceAll(): void {
    for (const runId of this.runs.keys()) {
      this.advance(runId);
    }
  }

  /**
   * Patch the metadata of a run without changing its status.
   *
   * Simulates adapter metadata (e.g. survivors) arriving after the run has
   * already reached its final status — mirrors setMetadata on the Trigger
   * SDK's RunMetadata API.
   */
  setMetadata(runId: string, patch: Record<string, unknown>): void {
    const run = this._requireRun(runId);
    run.metadata = { ...run.metadata, ...patch };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _requireRun(runId: string): FakeRunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`FakeExecutionRuntime: unknown runId "${runId}"`);
    return run;
  }

  private _observe(run: FakeRunRecord): RunObservation {
    const obs: RunObservation = {
      runId: run.runId,
      status: run.status,
      observedAt: this._clock(),
    };
    if (run.output !== undefined) obs.output = run.output;
    if (run.metadata !== undefined) obs.metadata = { ...run.metadata };
    if (run.error !== undefined) obs.error = run.error;
    return obs;
  }
}
