import assert from "node:assert/strict";
import test from "node:test";
import type { KillTreeResult, RunState, StopDeps } from "../src/tasks/worker-attempt-core.ts";
import {
  buildOutput,
  checkpointAndKill,
  getRunState,
  outcomeFromViolations,
  registerRunState,
  resolveRunDir,
  resolveWorktreePath,
} from "../src/tasks/worker-attempt-core.ts";

test("resolveWorktreePath joins worktreeBase, attempts, and the attempt id", () => {
  assert.equal(
    resolveWorktreePath({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
    "/srv/agencyhq/attempts/a-1",
  );
});

test("resolveRunDir joins worktreeBase, runs, and the attempt id (outside the worktree)", () => {
  assert.equal(
    resolveRunDir({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
    "/srv/agencyhq/runs/a-1",
  );
  assert.notEqual(
    resolveRunDir({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
    resolveWorktreePath({ worktreeBase: "/srv/agencyhq", attemptId: "a-1" }),
  );
});

test("outcomeFromViolations maps an empty violation list to completed", () => {
  assert.equal(outcomeFromViolations([]), "completed");
});

test("outcomeFromViolations maps any violation to path_violation", () => {
  assert.equal(outcomeFromViolations(["secrets/leak.txt"]), "path_violation");
});

test("buildOutput returns the fields it was given plus sessionId and a default report", () => {
  const output = buildOutput({
    attemptId: "a-1",
    outcome: "completed",
    worktreePath: "/srv/agencyhq/attempts/a-1",
    runDir: "/srv/agencyhq/runs/a-1",
    commitId: "deadbeef",
    diffDigest: "digest",
    changedPaths: ["src/hello.ts"],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: { sessionID: "s-1", exitCode: 0, denials: [], errors: [] },
  });

  assert.deepEqual(output, {
    attemptId: "a-1",
    sessionId: "s-1",
    report: {
      attempted: "",
      outputs: ["src/hello.ts"],
      checksRun: [],
      unmetCriteria: [],
      limitations: [],
      findings: [],
    },
    outcome: "completed",
    worktreePath: "/srv/agencyhq/attempts/a-1",
    runDir: "/srv/agencyhq/runs/a-1",
    commitId: "deadbeef",
    diffDigest: "digest",
    changedPaths: ["src/hello.ts"],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: { sessionID: "s-1", exitCode: 0, denials: [], errors: [] },
  });
});

function fakeState(overrides: Partial<RunState> = {}): RunState {
  return {
    pid: 111,
    pgid: 111,
    worktreePath: "/srv/agencyhq/attempts/a-1",
    repoPath: "/srv/agencyhq/repo",
    attemptId: "a-1",
    cancelled: false,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<StopDeps> = {}): { deps: StopDeps; calls: string[] } {
  const calls: string[] = [];
  const killResult: KillTreeResult = { terminated: [111], killed: [], survivors: [] };
  const deps: StopDeps = {
    commitTree: async () => {
      calls.push("commitTree");
      return "checkpointsha";
    },
    updateRef: async () => {
      calls.push("updateRef");
    },
    killTree: async () => {
      calls.push("killTree");
      return killResult;
    },
    survivorScan: async () => {
      calls.push("survivorScan");
      return [];
    },
    ...overrides,
  };
  return { deps, calls };
}

test("checkpointAndKill returns null when no state is registered for the run id", async () => {
  const states = new Map<string, RunState>();
  const { deps } = fakeDeps();
  const result = await checkpointAndKill(states, "missing-run", "kill-first", deps);
  assert.equal(result, null);
});

test("checkpointAndKill runs kill before checkpoint for the kill-first order", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps();

  const result = await checkpointAndKill(states, "run-1", "kill-first", deps);

  assert.deepEqual(calls, ["killTree", "commitTree", "updateRef", "survivorScan"]);
  assert.deepEqual(result, { checkpointCommit: "checkpointsha", survivors: [], killed: false });
});

test("checkpointAndKill runs checkpoint before kill for the checkpoint-first order", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps();

  await checkpointAndKill(states, "run-1", "checkpoint-first", deps);

  assert.deepEqual(calls, ["commitTree", "updateRef", "killTree", "survivorScan"]);
});

test("checkpointAndKill does not call updateRef when commitTree has nothing to commit", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps({
    commitTree: async () => {
      calls.push("commitTree");
      return null;
    },
  });

  const result = await checkpointAndKill(states, "run-1", "checkpoint-first", deps);

  assert.deepEqual(calls, ["commitTree", "killTree", "survivorScan"]);
  assert.equal(result?.checkpointCommit, null);
});

test("checkpointAndKill is idempotent: a second call returns the first call's result", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());
  const { deps, calls } = fakeDeps();

  const first = await checkpointAndKill(states, "run-1", "kill-first", deps);
  const second = await checkpointAndKill(states, "run-1", "checkpoint-first", deps);

  assert.notEqual(first, null);
  // The late caller gets the same completed result rather than null, so a
  // hook that arrives second still waits for the kill to finish.
  assert.deepEqual(second, first);
  // Only the first call's steps ran; the second did not repeat the kill or
  // the commit.
  assert.deepEqual(calls, ["killTree", "commitTree", "updateRef", "survivorScan"]);
  assert.equal(getRunState(states, "run-1")?.cancelled, true);
});

test("checkpointAndKill is idempotent under concurrent callers racing on the same run id", async () => {
  const states = new Map<string, RunState>();
  registerRunState(states, "run-1", fakeState());

  let killCalls = 0;
  let commitCalls = 0;
  const deps: StopDeps = {
    commitTree: async () => {
      commitCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "checkpointsha";
    },
    updateRef: async () => {},
    killTree: async () => {
      killCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { terminated: [], killed: [], survivors: [] };
    },
    survivorScan: async () => [],
  };

  // Both the run()-scoped abort listener (kill-first) and the onCancel hook
  // (checkpoint-first) can reach this in the same tick; only one may
  // actually run the sequence.
  const [fromAbortListener, fromOnCancel] = await Promise.all([
    checkpointAndKill(states, "run-1", "kill-first", deps),
    checkpointAndKill(states, "run-1", "checkpoint-first", deps),
  ]);

  // Both callers observe the single completed sequence: the loser awaits the
  // winner's promise instead of returning early (trial item 2, 2026-09-07:
  // an early-returning onCancel let Trigger kill the task process mid-kill).
  assert.notEqual(fromAbortListener, null);
  assert.deepEqual(fromOnCancel, fromAbortListener);
  assert.equal(killCalls, 1);
  assert.equal(commitCalls, 1);
});
