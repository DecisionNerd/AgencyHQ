import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerAttemptOutput } from "@agencyhq/contracts";
import type { Attempt, AttemptStatus } from "../src/aggregates/attempt.ts";
import { newId } from "../src/ids.ts";
import type { TriggerRunStatus } from "../src/ports.ts";
import type { Result } from "../src/result.ts";
import {
  ATTEMPT_TRANSITIONS,
  checkGeneration,
  confirmStopped,
  markDispatched,
  markUncertain,
  type ObserveCommand,
  observe,
  revoke,
  type TransitionError,
} from "../src/transitions/attempt.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeAttempt(status: AttemptStatus, generation = 0): Attempt {
  return {
    id: newId("att"),
    contractId: newId("sc"),
    contractVersion: 1,
    generation,
    status,
    budgetRemaining: 3,
  };
}

function makeObservation(status: TriggerRunStatus): ObserveCommand;
function makeObservation(status: TriggerRunStatus, output: WorkerAttemptOutput): ObserveCommand;
function makeObservation(status: TriggerRunStatus, output?: WorkerAttemptOutput): ObserveCommand {
  if (output !== undefined) {
    return { runId: "run_test", status, observedAt: new Date().toISOString(), output };
  }
  return { runId: "run_test", status, observedAt: new Date().toISOString() };
}

function makeWorkerOutput(
  attemptId: string,
  outcome: WorkerAttemptOutput["outcome"],
): WorkerAttemptOutput {
  return {
    attemptId,
    sessionId: null,
    outcome,
    worktreePath: "/tmp/worktree",
    runDir: "/tmp/rundir",
    commitId: "a".repeat(40),
    diffDigest: null,
    changedPaths: [],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: {
      sessionID: null,
      exitCode: 0,
      denials: [],
      errors: [],
    },
    report: {
      attempted: "done",
      outputs: [],
      checksRun: [],
      unmetCriteria: [],
      limitations: [],
      findings: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Legal transitions
// ---------------------------------------------------------------------------

test("markDispatched: admitted → dispatched", () => {
  const attempt = makeAttempt("admitted");
  const result = markDispatched(attempt, { runId: "run_1" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.attempt.status, "dispatched");
    assert.equal(result.value.attempt.runId, "run_1");
    assert.equal(result.value.events[0]?.type, "attempt.dispatched");
  }
});

test("observe EXECUTING: dispatched → running", () => {
  const attempt = makeAttempt("dispatched");
  const result = observe(attempt, makeObservation("EXECUTING"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "running");
});

test("observe DEQUEUED: dispatched → running", () => {
  const attempt = makeAttempt("dispatched");
  const result = observe(attempt, makeObservation("DEQUEUED"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "running");
});

test("observe COMPLETED + completed outcome: running → completed", () => {
  const attempt = makeAttempt("running");
  const output = makeWorkerOutput(attempt.id, "completed");
  const result = observe(attempt, makeObservation("COMPLETED", output));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "completed");
});

test("observe COMPLETED + path_violation outcome: running → quarantined", () => {
  const attempt = makeAttempt("running");
  const output = makeWorkerOutput(attempt.id, "path_violation");
  const result = observe(attempt, makeObservation("COMPLETED", output));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "quarantined");
});

test("observe COMPLETED + timed_out outcome: running → timed_out", () => {
  const attempt = makeAttempt("running");
  const output = makeWorkerOutput(attempt.id, "timed_out");
  const result = observe(attempt, makeObservation("COMPLETED", output));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "timed_out");
});

test("observe COMPLETED + cancelled outcome: running → stopping", () => {
  const attempt = makeAttempt("running");
  const output = makeWorkerOutput(attempt.id, "cancelled");
  const result = observe(attempt, makeObservation("COMPLETED", output));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "stopping");
});

test("observe COMPLETED + opencode_error outcome: running → failed", () => {
  const attempt = makeAttempt("running");
  const output = makeWorkerOutput(attempt.id, "opencode_error");
  const result = observe(attempt, makeObservation("COMPLETED", output));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "failed");
});

test("observe TIMED_OUT: running → timed_out", () => {
  const attempt = makeAttempt("running");
  const result = observe(attempt, makeObservation("TIMED_OUT"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "timed_out");
});

test("observe CANCELED: running → stopping", () => {
  const attempt = makeAttempt("running");
  const result = observe(attempt, makeObservation("CANCELED"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "stopping");
});

test("observe FAILED: running → failed", () => {
  const attempt = makeAttempt("running");
  const result = observe(attempt, makeObservation("FAILED"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "failed");
});

test("observe CRASHED: running → failed", () => {
  const attempt = makeAttempt("running");
  const result = observe(attempt, makeObservation("CRASHED"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "failed");
});

test("observe SYSTEM_FAILURE: running → failed", () => {
  const attempt = makeAttempt("running");
  const result = observe(attempt, makeObservation("SYSTEM_FAILURE"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "failed");
});

test("observe EXPIRED: running → failed", () => {
  const attempt = makeAttempt("running");
  const result = observe(attempt, makeObservation("EXPIRED"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "failed");
});

test("revoke: running → stopping (generation +1)", () => {
  const attempt = makeAttempt("running", 3);
  const result = revoke(attempt);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.attempt.status, "stopping");
    assert.equal(result.value.attempt.generation, 4);
    assert.equal(result.value.events[0]?.type, "attempt.revoked");
    assert.equal(result.value.events[0]?.generation, 4);
  }
});

test("confirmStopped survivorsConfirmedGone=true → stopped", () => {
  const attempt = makeAttempt("stopping");
  const result = confirmStopped(attempt, { survivorsConfirmedGone: true });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "stopped");
});

test("confirmStopped survivorsConfirmedGone=false → uncertain", () => {
  const attempt = makeAttempt("stopping");
  const result = confirmStopped(attempt, { survivorsConfirmedGone: false });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "uncertain");
});

test("markUncertain: running → uncertain", () => {
  const attempt = makeAttempt("running");
  const result = markUncertain(attempt, "lost connection");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "uncertain");
});

test("markUncertain: dispatched → uncertain", () => {
  const attempt = makeAttempt("dispatched");
  const result = markUncertain(attempt, "timeout waiting");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "uncertain");
});

test("observe from uncertain: uncertain → failed (FAILED)", () => {
  const attempt = makeAttempt("uncertain");
  const result = observe(attempt, makeObservation("FAILED"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "failed");
});

test("confirmStopped from uncertain → stopped", () => {
  const attempt = makeAttempt("uncertain");
  const result = confirmStopped(attempt, { survivorsConfirmedGone: true });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.attempt.status, "stopped");
});

// ---------------------------------------------------------------------------
// Illegal transitions — programmatically generated from ATTEMPT_TRANSITIONS
// ---------------------------------------------------------------------------

const ALL_COMMANDS = [
  "admit",
  "markDispatched",
  "observe",
  "revoke",
  "confirmStopped",
  "markUncertain",
] as const;

for (const [status, allowedSet] of Object.entries(ATTEMPT_TRANSITIONS) as [
  AttemptStatus,
  ReadonlySet<string>,
][]) {
  for (const command of ALL_COMMANDS) {
    if (!allowedSet.has(command)) {
      test(`illegal_transition: ${status} × ${command} => Err`, () => {
        const attempt = makeAttempt(status);
        let result: Result<{ attempt: Attempt; events: unknown[] }, TransitionError>;
        if (command === "markDispatched") {
          result = markDispatched(attempt, { runId: "r" });
        } else if (command === "observe") {
          result = observe(attempt, makeObservation("QUEUED"));
        } else if (command === "revoke") {
          result = revoke(attempt);
        } else if (command === "confirmStopped") {
          result = confirmStopped(attempt, { survivorsConfirmedGone: true });
        } else if (command === "markUncertain") {
          result = markUncertain(attempt, "test");
        } else {
          // admit — not a status-transition command in the table; skip
          return;
        }
        assert.equal(result.ok, false, `Expected Err for ${status} × ${command}`);
        if (!result.ok) {
          assert.equal(result.error.code, "illegal_transition");
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Stale generation guard
// ---------------------------------------------------------------------------

test("checkGeneration returns ok when generations match", () => {
  const attempt = makeAttempt("running", 5);
  const result = checkGeneration(attempt, 5);
  assert.equal(result.ok, true);
});

test("checkGeneration returns Err for stale generation", () => {
  const attempt = makeAttempt("running", 5);
  const result = checkGeneration(attempt, 2);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "stale_generation");
  }
});

test("revoke bumps generation so old generation observation is stale", () => {
  const attempt = makeAttempt("running", 1);
  const revokeResult = revoke(attempt);
  assert.equal(revokeResult.ok, true);
  if (!revokeResult.ok) return;

  const revokedAttempt = revokeResult.value.attempt;
  assert.equal(revokedAttempt.generation, 2);

  // old generation (1) should now fail stale check
  const staleCheck = checkGeneration(revokedAttempt, 1);
  assert.equal(staleCheck.ok, false);
  if (!staleCheck.ok) assert.equal(staleCheck.error.code, "stale_generation");

  // new generation (2) should pass
  const freshCheck = checkGeneration(revokedAttempt, 2);
  assert.equal(freshCheck.ok, true);
});

// ---------------------------------------------------------------------------
// observe mapping for all 13 TriggerRunStatuses
// ---------------------------------------------------------------------------

const ALL_TRIGGER_STATUSES: TriggerRunStatus[] = [
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "TIMED_OUT",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "DELAYED",
];

for (const triggerStatus of ALL_TRIGGER_STATUSES) {
  test(`observe maps ${triggerStatus} to a valid attempt status from running`, () => {
    const attempt = makeAttempt("running");
    let obs: ObserveCommand;

    if (triggerStatus === "COMPLETED") {
      // Use completed outcome to get completed
      const output = makeWorkerOutput(attempt.id, "completed");
      obs = makeObservation("COMPLETED", output);
    } else {
      obs = makeObservation(triggerStatus);
    }

    const result = observe(attempt, obs);
    // All statuses should produce Ok (no illegal_transition from running)
    assert.equal(result.ok, true, `Expected Ok for ${triggerStatus}`);
  });
}
