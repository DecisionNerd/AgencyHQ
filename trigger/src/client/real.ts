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

  constructor(
    opts: { apiUrl: string; secretKey: string; taskIds?: Record<string, string> },
    /** Inject a fake SDK surface in unit tests; defaults to the real SDK. */
    sdk?: SdkSurface,
  ) {
    this._sdk = sdk ?? { configure, idempotencyKeys, tasks, runs, auth };
    this._taskIds = opts.taskIds ?? {};

    // configure() is called once during construction and sets the global SDK
    // default client; subsequent calls are no-ops if the configuration is
    // unchanged.  This matches the spike usage in trigger/scripts/lib/trigger-client.ts.
    this._sdk.configure({
      baseURL: opts.apiUrl,
      secretKey: opts.secretKey,
    });
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
      if (options.concurrencyKey !== undefined)
        triggerOpts["concurrencyKey"] = options.concurrencyKey;
      if (options.tags !== undefined) triggerOpts["tags"] = options.tags;
      if (options.maxDurationSeconds !== undefined)
        triggerOpts["maxDuration"] = options.maxDurationSeconds;

      const handle = await this._sdk.tasks.trigger(taskId, payload as never, triggerOpts as never);

      return { runId: handle.id };
    } catch (err) {
      throw new RuntimeError(err);
    }
  }

  async cancel(runId: string): Promise<void> {
    try {
      await this._sdk.runs.cancel(runId);
    } catch (err) {
      throw new RuntimeError(err);
    }
  }

  async retrieve(runId: string): Promise<RunObservation> {
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
    try {
      return await this._sdk.auth.createPublicToken({
        scopes: { read: { tags: input.tags } },
        expirationTime: input.expiresIn,
      });
    } catch (err) {
      throw new RuntimeError(err);
    }
  }
}
