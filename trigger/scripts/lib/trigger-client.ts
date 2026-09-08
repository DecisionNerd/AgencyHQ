// Thin wrapper over the Trigger SDK calls the trial scripts need
// (trigger/scripts/trial.ts). Only the `worker.attempt` task's *type* is
// imported here (`import type`), so loading this module never runs
// trigger/src/tasks/worker-attempt.ts's top-level `task(...)` registration
// — it stays a plain script dependency, not a task file. No task logic
// lives here: this is dispatch/poll plumbing only.

import type { AnyRetrieveRunResult, RunMetadata, TriggerOptions } from "@trigger.dev/sdk";
import { configure, idempotencyKeys, runs, tasks } from "@trigger.dev/sdk";

import type { workerAttempt } from "../../src/tasks/worker-attempt.ts";
import type { WorkerAttemptPayload } from "../../src/types.ts";

/** Run statuses Trigger will never transition out of (echo.ts's list, used
 * consistently here so `waitFinal` and the trial's own polling agree on
 * what "final" means). */
export const FINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Reads `TRIGGER_API_URL`/`TRIGGER_SECRET_KEY` and configures the SDK's
 * default client. Call once before any other export here. */
export function configureFromEnv(): void {
  configure({
    baseURL: requireEnv("TRIGGER_API_URL"),
    secretKey: requireEnv("TRIGGER_SECRET_KEY"),
  });
}

export type TriggerAttemptOptions = {
  /** Key material for `idempotencyKeys.create(idempotencyKey, { scope:
   * "global" })` — pass the same value across concurrent/duplicate calls to
   * prove they collapse onto one run. */
  idempotencyKey: string;
  ttl?: string;
  maxDuration?: number;
  tags?: string[];
};

/** Triggers `worker.attempt` with a global-scope idempotency key derived
 * from `options.idempotencyKey`. Two concurrent calls with the same key
 * resolve to the same run id (trial item 1). */
export async function triggerAttempt(
  payload: WorkerAttemptPayload,
  options: TriggerAttemptOptions,
): Promise<{ id: string }> {
  const idempotencyKey = await idempotencyKeys.create(options.idempotencyKey, { scope: "global" });

  const triggerOptions: TriggerOptions = { idempotencyKey };
  if (options.ttl !== undefined) {
    triggerOptions.idempotencyKeyTTL = options.ttl;
  }
  if (options.maxDuration !== undefined) {
    triggerOptions.maxDuration = options.maxDuration;
  }
  if (options.tags !== undefined) {
    triggerOptions.tags = options.tags;
  }

  const handle = await tasks.trigger<typeof workerAttempt>(
    "worker.attempt",
    payload,
    triggerOptions,
  );
  return { id: handle.id };
}

/** Polls `runs.retrieve` every 2s until the run reaches a status in
 * `FINAL_STATUSES`, or throws after `timeoutMs`. */
export async function waitFinal(runId: string, timeoutMs: number): Promise<AnyRetrieveRunResult> {
  const pollIntervalMs = 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runs.retrieve(runId);
    if (FINAL_STATUSES.has(run.status)) {
      return run;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} did not reach a final status within ${timeoutMs}ms (last status: ${run.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function cancel(runId: string): Promise<void> {
  await runs.cancel(runId);
}

/** Current metadata for a run, or `{}` if the run has none. */
export async function metadataOf(runId: string): Promise<RunMetadata> {
  const run = await runs.retrieve(runId);
  return run.metadata ?? {};
}
