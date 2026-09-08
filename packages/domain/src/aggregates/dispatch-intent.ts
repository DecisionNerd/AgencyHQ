/**
 * DispatchIntent aggregate.
 * Coordinator-recorded intent to trigger a task, keyed by intent id
 * (the Trigger idempotency key), with the resulting run id once known.
 */

import type { Digest } from "@agencyhq/contracts";
import type { AttemptId, DispatchIntentId } from "../ids.ts";

export type DispatchIntentStatus = "recorded" | "triggered";

export type DispatchIntent = {
  readonly id: DispatchIntentId;
  readonly task: string;
  readonly payloadDigest: Digest;
  readonly attemptId?: AttemptId;
  readonly status: DispatchIntentStatus;
  readonly runId?: string;
  readonly idempotencyKey: string;
};
