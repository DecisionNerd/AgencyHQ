/**
 * RealExecutionRuntime: production Trigger.dev v4 adapter.
 *
 * SDK surface verified against @trigger.dev/sdk@4.5.16 /
 * @trigger.dev/core@4.5.16 type declarations read 2026-09-07:
 *
 * - `configure({ baseURL, secretKey })` — ApiClientConfiguration in
 *   node_modules/.pnpm/@trigger.dev+core@4.5.16_.../apiClientManager/types.d.ts;
 *   `secretKey` is deprecated in favour of `accessToken` but still accepted.
 * - `idempotencyKeys.create(key, { scope: "global" })` →
 *   createIdempotencyKey in .../idempotencyKeys.d.ts, returns `IdempotencyKey`.
 * - `tasks.trigger(id, payload, options)` — TriggerOptions in
 *   .../types/tasks.d.ts: `idempotencyKey`, `idempotencyKeyTTL`, `concurrencyKey`,
 *   `tags`, `maxDuration`; returns `RunHandle` with `.id`.
 * - `runs.cancel(runId)` — runs.d.ts: `cancelRun(runId)`.
 * - `runs.retrieve(runId)` — runs.d.ts: `retrieveRun(runId)`;
 *   result shape from RetrieveRunResponse in .../schemas/api.d.ts:
 *   `{ id, status, output?, metadata?, error?{ message, name? } }`.
 * - `auth.createPublicToken({ scopes: { read: { tags } }, expirationTime })` —
 *   CreatePublicTokenOptions in .../auth.d.ts.
 */

import { auth, configure, idempotencyKeys, runs, tasks } from "@trigger.dev/sdk";

import type { ExecutionRuntime, RunObservation, TriggerRunStatus } from "./index.ts";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Wraps any SDK error without swallowing it. */
export class RuntimeError extends Error {
  override readonly name = "RuntimeError";
  readonly cause: unknown;

  constructor(cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : `Trigger.dev SDK error: ${String(cause)}`;
    super(message);
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// SDK surface type (injectable for tests)
// ---------------------------------------------------------------------------

/** The subset of the @trigger.dev/sdk surface RealExecutionRuntime uses.
 * Matches the real exports exactly so the default (no sdk arg) compiles. */
export type SdkSurface = {
  configure: typeof configure;
  idempotencyKeys: typeof idempotencyKeys;
  tasks: typeof tasks;
  runs: typeof runs;
  auth: typeof auth;
};

// ---------------------------------------------------------------------------
// RealExecutionRuntime
// ---------------------------------------------------------------------------

export class RealExecutionRuntime implements ExecutionRuntime {
  private readonly _sdk: SdkSurface;
  private readonly _taskIds: Record<string, string>;
  private readonly _apiUrl: string;
  private readonly _secretKeyProvider: () => string;
  private _configuredKey = "";

  constructor(
    opts: {
      apiUrl: string;
      /** Plain string or a provider function (called lazily on each operation). */
      secretKey: string | (() => string);
      taskIds?: Record<string, string>;
    },
    /** Inject a fake SDK surface in unit tests; defaults to the real SDK. */
    sdk?: SdkSurface,
  ) {
    this._sdk = sdk ?? { configure, idempotencyKeys, tasks, runs, auth };
    this._taskIds = opts.taskIds ?? {};
    this._apiUrl = opts.apiUrl;
    this._secretKeyProvider =
      typeof opts.secretKey === "function" ? opts.secretKey : () => opts.secretKey as string;

    // Configure immediately if a non-empty key is available at construction.
    const initialKey = this._secretKeyProvider();
    if (initialKey.length > 0) {
      this._sdk.configure({ baseURL: this._apiUrl, secretKey: initialKey });
      this._configuredKey = initialKey;
    }
  }

  /** Re-configure the SDK if the key has changed or was not yet set. */
  private _ensureConfigured(): void {
    const key = this._secretKeyProvider();
    if (key.length > 0 && key !== this._configuredKey) {
      this._sdk.configure({ baseURL: this._apiUrl, secretKey: key });
      this._configuredKey = key;
    }
  }

  // -------------------------------------------------------------------------
  // ExecutionRuntime
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
    this._ensureConfigured();
    try {
      const { task, payload, options } = input;
      const taskId = this._taskIds[task] ?? task;

      const idempotencyKey = await this._sdk.idempotencyKeys.create(options.idempotencyKey, {
        scope: "global",
      });

      const triggerOpts: Record<string, unknown> = {
        idempotencyKey,
        idempotencyKeyTTL: options.idempotencyKeyTtl ?? "24h",
      };
      if (options.concurrencyKey !== undefined) triggerOpts.concurrencyKey = options.concurrencyKey;
      if (options.tags !== undefined) triggerOpts.tags = options.tags;
      if (options.maxDurationSeconds !== undefined)
        triggerOpts.maxDuration = options.maxDurationSeconds;

      const handle = await this._sdk.tasks.trigger(taskId, payload as never, triggerOpts as never);

      return { runId: handle.id };
    } catch (err) {
      throw new RuntimeError(err);
    }
  }

  async cancel(runId: string): Promise<void> {
    this._ensureConfigured();
    try {
      await this._sdk.runs.cancel(runId);
    } catch (err) {
      throw new RuntimeError(err);
    }
  }

  async retrieve(runId: string): Promise<RunObservation> {
    this._ensureConfigured();
    try {
      const run = await this._sdk.runs.retrieve(runId);
      const obs: RunObservation = {
        runId: run.id,
        // The SDK's status enum matches TriggerRunStatus exactly (verified in
        // RetrieveRunResponse schema: same 13 values).
        status: run.status as TriggerRunStatus,
        observedAt: new Date().toISOString(),
      };
      if (run.output !== undefined) obs.output = run.output;
      if (run.metadata !== undefined) obs.metadata = run.metadata as Record<string, unknown>;
      if (run.error !== undefined) {
        obs.error =
          run.error.name !== undefined
            ? { message: run.error.message, name: run.error.name }
            : { message: run.error.message };
      }
      return obs;
    } catch (err) {
      throw new RuntimeError(err);
    }
  }

  async createPublicToken(input: { tags: string[]; expiresIn: string }): Promise<string> {
    this._ensureConfigured();
    try {
      return await this._sdk.auth.createPublicToken({
        scopes: { read: { tags: input.tags } },
        expirationTime: input.expiresIn,
      });
    } catch (err) {
      throw new RuntimeError(err);
    }
  }

  /**
   * Subscribe to real-time run updates for runs carrying any of `input.tags`.
   *
   * Uses `runs.subscribeToRunsWithTag(tag)` for each tag (SDK 4.5.16 async
   * iterator).  All per-tag subscriptions run concurrently; an error in any
   * one of them is logged and aborts the rest (the caller falls back to
   * polling).  The returned promise resolves once all iterators have ended
   * (either because the signal was aborted or because of the error path).
   *
   * This is a wake-up hint — polling via `retrieve` remains the path of record.
   */
  async subscribe(
    input: { tags: string[]; signal: AbortSignal },
    onObservation: (obs: RunObservation) => void,
  ): Promise<void> {
    this._ensureConfigured();
    // Internal controller: aborted when input.signal fires OR when any tag
    // subscription errors, so all iterators stop together.
    const ac = new AbortController();
    const onSignalAbort = () => ac.abort();
    input.signal.addEventListener("abort", onSignalAbort, { once: true });

    const tagPromises = input.tags.map(async (tag) => {
      try {
        // subscribeToRunsWithTag is part of `typeof runs` (SDK 4.5.16).
        // Casting to unknown → AsyncIterable because TypeScript's structural
        // check on the generic RunSubscription type requires a concrete task
        // type; we only need the shape below.
        const sub = this._sdk.runs.subscribeToRunsWithTag(tag, undefined, {
          signal: ac.signal,
        }) as unknown as AsyncIterable<{
          id: string;
          status: string;
          output?: unknown;
          metadata?: Record<string, unknown>;
          error?: { message: string; name?: string };
        }>;
        for await (const run of sub) {
          if (ac.signal.aborted) break;
          const obs: RunObservation = {
            runId: run.id,
            status: run.status as TriggerRunStatus,
            observedAt: new Date().toISOString(),
          };
          if (run.output !== undefined) obs.output = run.output;
          if (run.metadata !== undefined) obs.metadata = run.metadata;
          if (run.error !== undefined) {
            obs.error =
              run.error.name !== undefined
                ? { message: run.error.message, name: run.error.name }
                : { message: run.error.message };
          }
          onObservation(obs);
        }
      } catch (err: unknown) {
        if (!ac.signal.aborted) {
          console.error(`[RealExecutionRuntime] subscribe: tag "${tag}" error, ending:`, err);
          ac.abort();
        }
      }
    });

    try {
      await Promise.all(tagPromises);
    } finally {
      input.signal.removeEventListener("abort", onSignalAbort);
    }
  }
}
