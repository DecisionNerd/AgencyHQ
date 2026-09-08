/**
 * Failure aggregate.
 * Domain record of a classified failure with class, phase, attempt, run id,
 * cause, and evidence.
 */

import type { AttemptId, FailureId } from "../ids.ts";

export type FailureClass = "execution" | "contract" | "process";

export type Failure = {
  readonly id: FailureId;
  readonly class: FailureClass;
  readonly phase: string;
  readonly attemptId?: AttemptId;
  readonly runId?: string;
  readonly cause: string;
  readonly evidence: string;
};
