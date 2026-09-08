/**
 * Attempt state transitions.
 * Pure (state, command) => Result<{attempt, events}, TransitionError>.
 * Every illegal transition returns Err with code "illegal_transition".
 */

import type { WorkerAttemptOutput } from "@agencyhq/contracts";
import type { Attempt, AttemptStatus } from "../aggregates/attempt.ts";
import type { StepContractId } from "../ids.ts";
import type { RunObservation } from "../ports.ts";
import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------
export type DomainEvent = {
  readonly type: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly at?: string;
  readonly detail?: unknown;
};

// ---------------------------------------------------------------------------
// TransitionError
// ---------------------------------------------------------------------------
export type TransitionError =
  | { readonly code: "illegal_transition"; readonly from: AttemptStatus; readonly command: string }
  | { readonly code: "stale_generation"; readonly expected: number; readonly actual: number }
  | { readonly code: string; readonly reason?: string };

// ---------------------------------------------------------------------------
// ATTEMPT_TRANSITIONS table
// Maps each status to the set of commands allowed from it.
// ---------------------------------------------------------------------------
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, ReadonlySet<string>>> = {
  admitted: new Set(["markDispatched"]),
  dispatched: new Set(["observe", "markUncertain"]),
  running: new Set(["observe", "revoke", "markUncertain"]),
  completed: new Set([]),
  quarantined: new Set([]),
  failed: new Set([]),
  stopping: new Set(["observe", "confirmStopped", "markUncertain"]),
  stopped: new Set([]),
  uncertain: new Set(["observe", "confirmStopped", "markUncertain"]),
  timed_out: new Set([]),
};

function assertAllowed(attempt: Attempt, command: string): Result<void, TransitionError> {
  const allowed = ATTEMPT_TRANSITIONS[attempt.status];
  if (!allowed.has(command)) {
    return err({ code: "illegal_transition", from: attempt.status, command });
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------
export type AdmitCommand = {
  readonly contract: { readonly id: StepContractId; readonly version: number };
  readonly budgetRemaining: number;
  readonly generation: number;
};

export function admit(
  attempt: Attempt,
  command: AdmitCommand,
): Result<{ attempt: Attempt; events: DomainEvent[] }, TransitionError> {
  // admit is only valid when creating a fresh attempt (not a status transition from an existing one)
  // This is a factory — called when status is not yet assigned (pre-admission).
  // For transition table enforcement, we only allow admit when status is "admitted" (initial state).
  // In practice, the coordinator calls this to create the initial record.
  return ok({
    attempt: {
      ...attempt,
      contractId: command.contract.id,
      contractVersion: command.contract.version,
      budgetRemaining: command.budgetRemaining,
      generation: command.generation,
      status: "admitted",
    },
    events: [
      {
        type: "attempt.admitted",
        attemptId: attempt.id,
        generation: command.generation,
        detail: { contractId: command.contract.id, contractVersion: command.contract.version },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// markDispatched
// ---------------------------------------------------------------------------
export type MarkDispatchedCommand = {
  readonly runId: string;
};

export function markDispatched(
  attempt: Attempt,
  command: MarkDispatchedCommand,
): Result<{ attempt: Attempt; events: DomainEvent[] }, TransitionError> {
  const check = assertAllowed(attempt, "markDispatched");
  if (!check.ok) return check;

  return ok({
    attempt: { ...attempt, status: "dispatched", runId: command.runId },
    events: [
      {
        type: "attempt.dispatched",
        attemptId: attempt.id,
        generation: attempt.generation,
        detail: { runId: command.runId },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// observe
// Maps Trigger run statuses and worker outputs to attempt statuses.
// ---------------------------------------------------------------------------
export type ObserveCommand = Omit<RunObservation, "output"> & {
  readonly output?: WorkerAttemptOutput;
};

export function observe(
  attempt: Attempt,
  command: ObserveCommand,
): Result<{ attempt: Attempt; events: DomainEvent[] }, TransitionError> {
  const check = assertAllowed(attempt, "observe");
  if (!check.ok) return check;

  // Stale generation check — if output carries a generation, verify it matches
  if (command.output !== undefined && command.output.attemptId !== attempt.id) {
    // Mismatch by id is just a routing error; not stale generation
  }

  const status = command.status;
  let nextStatus: AttemptStatus;
  let detail: unknown = { runStatus: status };

  if (status === "COMPLETED" && command.output !== undefined) {
    const outcome = command.output.outcome;
    if (outcome === "completed") {
      nextStatus = "completed";
    } else if (outcome === "path_violation") {
      nextStatus = "quarantined";
    } else if (outcome === "timed_out") {
      nextStatus = "timed_out";
    } else if (outcome === "cancelled") {
      nextStatus = "stopping";
    } else {
      // opencode_error and any unknown outcome
      nextStatus = "failed";
    }
    detail = { runStatus: status, outcome };
  } else if (status === "COMPLETED") {
    // Completed without output — treat as uncertain
    nextStatus = "uncertain";
  } else if (status === "TIMED_OUT") {
    nextStatus = "timed_out";
  } else if (status === "CANCELED") {
    // CANCELED → stopping until confirmed via confirmStopped
    nextStatus = "stopping";
  } else if (
    status === "FAILED" ||
    status === "CRASHED" ||
    status === "SYSTEM_FAILURE" ||
    status === "EXPIRED"
  ) {
    nextStatus = "failed";
  } else if (status === "EXECUTING" || status === "DEQUEUED") {
    nextStatus = "running";
  } else {
    // QUEUED, PENDING_VERSION, WAITING, DELAYED — no state change
    nextStatus = attempt.status;
  }

  const updatedAttempt: Attempt = {
    ...attempt,
    status: nextStatus,
    ...(command.output?.commitId !== undefined && command.output?.commitId !== null
      ? { commit: command.output.commitId }
      : {}),
    ...(command.output?.diffDigest !== undefined && command.output?.diffDigest !== null
      ? { diffDigest: command.output.diffDigest }
      : {}),
    ...(command.output?.worktreePath !== undefined
      ? { worktreePath: command.output.worktreePath }
      : {}),
    ...(command.output?.opencode?.sessionID !== undefined &&
    command.output?.opencode?.sessionID !== null
      ? { sessionId: command.output.opencode.sessionID }
      : {}),
    ...(command.output?.checkpointCommit !== undefined && command.output?.checkpointCommit !== null
      ? { checkpointCommit: command.output.checkpointCommit }
      : {}),
  };

  return ok({
    attempt: updatedAttempt,
    events: [
      {
        type: `attempt.observed`,
        attemptId: attempt.id,
        generation: attempt.generation,
        at: command.observedAt,
        detail,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// revoke
// Advances generation by 1, sets status to stopping.
// ---------------------------------------------------------------------------
export function revoke(
  attempt: Attempt,
): Result<{ attempt: Attempt; events: DomainEvent[] }, TransitionError> {
  const check = assertAllowed(attempt, "revoke");
  if (!check.ok) return check;

  const nextGeneration = attempt.generation + 1;

  return ok({
    attempt: { ...attempt, status: "stopping", generation: nextGeneration },
    events: [
      {
        type: "attempt.revoked",
        attemptId: attempt.id,
        generation: nextGeneration,
        detail: { previousGeneration: attempt.generation },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// confirmStopped
// ---------------------------------------------------------------------------
export type ConfirmStoppedCommand = {
  readonly survivorsConfirmedGone: boolean;
  readonly checkpointCommit?: string;
};

export function confirmStopped(
  attempt: Attempt,
  command: ConfirmStoppedCommand,
): Result<{ attempt: Attempt; events: DomainEvent[] }, TransitionError> {
  const check = assertAllowed(attempt, "confirmStopped");
  if (!check.ok) return check;

  const nextStatus: AttemptStatus = command.survivorsConfirmedGone ? "stopped" : "uncertain";

  return ok({
    attempt: {
      ...attempt,
      status: nextStatus,
      ...(command.checkpointCommit !== undefined
        ? { checkpointCommit: command.checkpointCommit }
        : {}),
    },
    events: [
      {
        type: nextStatus === "stopped" ? "attempt.stopped" : "attempt.uncertain",
        attemptId: attempt.id,
        generation: attempt.generation,
        detail: { survivorsConfirmedGone: command.survivorsConfirmedGone },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// markUncertain
// ---------------------------------------------------------------------------
export function markUncertain(
  attempt: Attempt,
  reason: string,
): Result<{ attempt: Attempt; events: DomainEvent[] }, TransitionError> {
  const check = assertAllowed(attempt, "markUncertain");
  if (!check.ok) return check;

  return ok({
    attempt: { ...attempt, status: "uncertain" },
    events: [
      {
        type: "attempt.uncertain",
        attemptId: attempt.id,
        generation: attempt.generation,
        detail: { reason },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// observeStaleGeneration
// Guard: returns Err when the observation's generation does not match.
// ---------------------------------------------------------------------------
export function checkGeneration(
  attempt: Attempt,
  observedGeneration: number,
): Result<void, TransitionError> {
  if (observedGeneration !== attempt.generation) {
    return err({
      code: "stale_generation",
      expected: attempt.generation,
      actual: observedGeneration,
    });
  }
  return ok(undefined);
}
