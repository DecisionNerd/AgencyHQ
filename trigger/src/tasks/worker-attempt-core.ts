// Pure/injectable pieces of the `worker.attempt` task (ADR-0007,
// docs/engineering/adrs/0007-worker-effect-model.md lines 18-63), factored
// out so they can be unit-tested without importing `@trigger.dev/sdk`.
// No Trigger SDK usage; no direct `child_process`/`fs` calls except through
// injected dependencies.
import type { EventDenial, WorkerAttemptOutput } from "../types.ts";

/** Where an attempt's worktree lives: `<worktreeBase>/attempts/<attemptId>`. */
export function resolveWorktreePath(args: { worktreeBase: string; attemptId: string }): string {
  return `${args.worktreeBase}/attempts/${args.attemptId}`;
}

/** Where an attempt's run directory (config/events/logs) lives, deliberately
 * outside the worktree: `<worktreeBase>/runs/<attemptId>`. */
export function resolveRunDir(args: { worktreeBase: string; attemptId: string }): string {
  return `${args.worktreeBase}/runs/${args.attemptId}`;
}

/** The mechanical outcome from path classification alone: a task body may
 * add nothing beyond this (see worker-attempt.ts's `opencode_error` branch,
 * which is a technical failure, not a policy judgement). */
export function outcomeFromViolations(violations: string[]): "completed" | "path_violation" {
  return violations.length > 0 ? "path_violation" : "completed";
}

export function buildOutput(args: {
  attemptId: string;
  outcome: WorkerAttemptOutput["outcome"];
  worktreePath: string;
  runDir: string;
  commitId: string | null;
  diffDigest: string | null;
  changedPaths: string[];
  pathViolations: string[];
  checkpointCommit: string | null;
  survivors: number[];
  opencode: {
    sessionID: string | null;
    exitCode: number | null;
    denials: EventDenial[];
    errors: string[];
  };
}): WorkerAttemptOutput {
  return {
    attemptId: args.attemptId,
    outcome: args.outcome,
    worktreePath: args.worktreePath,
    runDir: args.runDir,
    commitId: args.commitId,
    diffDigest: args.diffDigest,
    changedPaths: args.changedPaths,
    pathViolations: args.pathViolations,
    checkpointCommit: args.checkpointCommit,
    survivors: args.survivors,
    opencode: args.opencode,
  };
}

/** Per-run bookkeeping registered when the OpenCode child starts, looked up
 * by Trigger run id from both the run()-scoped abort listener and the
 * separate `onCancel` hook. `cancelled` makes the checkpoint-and-kill
 * routine below idempotent no matter which caller reaches it first: it is
 * claimed synchronously (before any await) by whichever caller arrives
 * first, so the loser's call is a no-op (`checkpointAndKill` returns
 * `null`) rather than repeating the kill or the commit. The winner already
 * reports the result through `metadata.set` itself, so nothing needs to be
 * cached here for the loser to read. */
export type RunState = {
  pid: number;
  pgid: number;
  worktreePath: string;
  repoPath: string;
  attemptId: string;
  cancelled: boolean;
};

export type StopResult = {
  checkpointCommit: string | null;
  survivors: number[];
  killed: boolean;
};

export type KillTreeResult = { terminated: number[]; killed: number[]; survivors: number[] };

/** Dependencies the checkpoint-and-kill routine needs from the git/procs
 * libraries, injected so the routine is unit-testable with fakes. */
export type StopDeps = {
  commitTree: (args: { worktreePath: string; message: string }) => Promise<string | null>;
  updateRef: (args: { repoPath: string; ref: string; sha: string }) => Promise<void>;
  killTree: (args: { rootPid: number; pgid: number }) => Promise<KillTreeResult>;
  survivorScan: (attemptId: string) => Promise<number[]>;
};

export function registerRunState(
  states: Map<string, RunState>,
  runId: string,
  state: RunState,
): void {
  states.set(runId, state);
}

export function getRunState(states: Map<string, RunState>, runId: string): RunState | undefined {
  return states.get(runId);
}

async function checkpoint(
  state: RunState,
  deps: Pick<StopDeps, "commitTree" | "updateRef">,
): Promise<string | null> {
  const commitId = await deps.commitTree({
    worktreePath: state.worktreePath,
    message: "agencyhq checkpoint",
  });
  if (commitId) {
    // Fully-qualified so this is a real branch ref (`git for-each-ref`,
    // `git branch --list` etc. all expect the `refs/` prefix; a bare
    // "agencyhq/checkpoints/<id>" would land as a loose file outside the
    // `refs/` hierarchy instead), matching git.test.ts's own convention.
    await deps.updateRef({
      repoPath: state.repoPath,
      ref: `refs/heads/agencyhq/checkpoints/${state.attemptId}`,
      sha: commitId,
    });
  }
  return commitId;
}

async function kill(state: RunState, deps: Pick<StopDeps, "killTree">): Promise<KillTreeResult> {
  return deps.killTree({ rootPid: state.pid, pgid: state.pgid });
}

/**
 * Runs the checkpoint-and-kill sequence exactly once per run id, regardless
 * of which caller (the run()-scoped abort listener, or the separate
 * `onCancel` hook) reaches it first, and regardless of which order that
 * first caller asked for:
 *
 * - `"kill-first"`: the abort listener's fast reaction — kill immediately
 *   (no await on git first), then best-effort checkpoint. Used because on a
 *   `maxDuration` abort there is no `onCancel` and only ~1s before SIGTERM.
 * - `"checkpoint-first"`: `onCancel`'s bounded (~30s) grace period — commit
 *   the checkpoint first, then kill, matching ADR-0007 #7.
 *
 * A second call for the same run id (from whichever path loses the race)
 * is a no-op returning `null`: the winner already reported the result
 * through `metadata.set`, so there is nothing left to compute or repeat.
 * Also returns `null` if no state is registered for the run id.
 */
export async function checkpointAndKill(
  states: Map<string, RunState>,
  runId: string,
  order: "kill-first" | "checkpoint-first",
  deps: StopDeps,
): Promise<StopResult | null> {
  const state = states.get(runId);
  if (!state || state.cancelled) {
    // Either there is no such run, or another caller (the run()-scoped
    // abort listener, or the separate `onCancel` hook — whichever wins the
    // race) already claimed and is handling/has handled it.
    return null;
  }
  // Claimed synchronously, before any await, so a concurrent caller sees
  // `cancelled === true` immediately rather than racing into its own run of
  // this routine.
  state.cancelled = true;

  let checkpointCommit: string | null = null;
  let killResult: KillTreeResult = { terminated: [], killed: [], survivors: [] };

  if (order === "kill-first") {
    killResult = await kill(state, deps);
    checkpointCommit = await checkpoint(state, deps);
  } else {
    checkpointCommit = await checkpoint(state, deps);
    killResult = await kill(state, deps);
  }

  const survivors = await deps.survivorScan(state.attemptId);

  return {
    checkpointCommit,
    survivors,
    killed: killResult.killed.length > 0,
  };
}
