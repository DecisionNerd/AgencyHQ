/**
 * Attempt aggregate.
 * One execution of a StepContract: Trigger run id, authority generation,
 * worktree path, OpenCode session id, attempt commit, checkpoint commit,
 * failure record.
 */

import type { AttemptId, FailureId, StepContractId } from "../ids.ts";

export type AttemptStatus =
  | "admitted"
  | "dispatched"
  | "running"
  | "completed"
  | "quarantined"
  | "failed"
  | "stopping"
  | "stopped"
  | "uncertain"
  | "timed_out";

export type Attempt = {
  readonly id: AttemptId;
  readonly contractId: StepContractId;
  readonly contractVersion: number;
  /** Monotonically increasing per-attempt authority generation; guards stale replays. */
  readonly generation: number;
  readonly status: AttemptStatus;
  readonly runId?: string;
  readonly worktreePath?: string;
  readonly sessionId?: string;
  readonly commit?: string;
  readonly diffDigest?: string;
  readonly checkpointCommit?: string;
  readonly failureId?: FailureId;
  /** Remaining attempt budget at the time this attempt was created. */
  readonly budgetRemaining: number;
};
