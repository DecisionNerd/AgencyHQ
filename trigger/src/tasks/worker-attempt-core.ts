// Pure/injectable pieces of the `worker.attempt` task (ADR-0007,
// docs/engineering/adrs/0007-worker-effect-model.md lines 18-63), factored
// out so they can be unit-tested without importing the Trigger SDK.
// No Trigger SDK usage; no direct `child_process`/`fs` calls except through
// injected dependencies.
import type {
  PermissionRuleset as ContractsPermissionRuleset,
  PermissionAction,
  PermissionPatternMap,
} from "@agencyhq/contracts";
import { WORKER_ALWAYS_DENY_BASH, WORKER_ALWAYS_DENY_PATHS } from "@agencyhq/contracts";
import type {
  EventDenial,
  WorkerAttemptOutput,
  WorkerAttemptPayload,
  WorkerReportLite,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Permission ruleset resolution — no Trigger SDK usage
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth: merge always-deny entries on top of a contract ruleset.
 * Ensures that task and external_directory are always denied, and that bash
 * patterns from WORKER_ALWAYS_DENY_BASH and file patterns from
 * WORKER_ALWAYS_DENY_PATHS are denied after any allows, even if the payload
 * ruleset explicitly allowed them. Last-match-wins is OpenCode's rule.
 */
export function enforceAlwaysDeny(ruleset: ContractsPermissionRuleset): ContractsPermissionRuleset {
  const bash: PermissionPatternMap = { ...ruleset.bash };
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    bash[pattern] = "deny";
  }

  const edit: PermissionPatternMap = { ...ruleset.edit };
  for (const glob of WORKER_ALWAYS_DENY_PATHS) {
    edit[glob] = "deny";
  }

  return {
    ...ruleset,
    bash,
    edit,
    task: "deny" as PermissionAction,
    external_directory: "deny" as PermissionAction,
  };
}

/**
 * Select the worker's permission ruleset from the payload, applying
 * always-deny entries for defense-in-depth. Throws a plain `Error` if
 * `permissionRules` is absent at runtime (the TypeScript type requires it, but
 * a malformed Trigger payload could bypass the type check); the task converts
 * this into an `AbortTaskRunError` before any spawn.
 *
 * @returns `{ ruleset, source: "contract" }` — the source is always
 *   "contract" because the spike fallback path has been removed.
 */
export function resolveWorkerRuleset(payload: Pick<WorkerAttemptPayload, "permissionRules">): {
  ruleset: ContractsPermissionRuleset;
  source: "contract";
} {
  // Runtime guard: the TypeScript type requires permissionRules, but a
  // malformed or JS-bypassed payload could omit it.
  if (payload.permissionRules === undefined || payload.permissionRules === null) {
    throw new Error(
      "worker.attempt setup error: permissionRules is required but was absent from the payload",
    );
  }
  const ruleset = enforceAlwaysDeny(payload.permissionRules);
  return { ruleset, source: "contract" };
}

// ---------------------------------------------------------------------------
// Model resolution — no Trigger SDK usage
// ---------------------------------------------------------------------------

/**
 * Resolve the worker's model string from payload or environment.
 *
 * Resolution order: payload.model → AGENCYHQ_OPENCODE_MODEL env var.
 * Throws a plain `Error` when neither is set; the task converts this into an
 * `AbortTaskRunError` (setup failure) before any spawn.
 */
export function resolveModel(args: {
  payloadModel: string | undefined | null;
  envModel: string | undefined;
}): string {
  const m = args.payloadModel ?? args.envModel;
  if (!m) {
    throw new Error(
      "worker.attempt setup error: no model configured — set payload.model or AGENCYHQ_OPENCODE_MODEL",
    );
  }
  return m;
}

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
  sessionId?: string;
  report?: WorkerReportLite;
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
  const sessionId = args.sessionId ?? args.opencode.sessionID ?? "unknown";
  const report: WorkerReportLite = args.report ?? {
    attempted: "",
    outputs: args.changedPaths,
    checksRun: [],
    unmetCriteria: [],
    limitations: [],
    findings: [],
  };
  return {
    attemptId: args.attemptId,
    sessionId,
    report,
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
  /** Run directory for local stop evidence (`stop.ndjson`); optional so
   * unit tests with fakes need not supply it. */
  runDir?: string;
  /** The in-flight stop sequence once claimed. A later caller awaits this
   * instead of returning early: observed 2026-09-07 (trial item 2) that when
   * `onCancel` returned immediately because the abort listener had already
   * claimed the run, Trigger terminated the task process before the kill
   * finished, orphaning OpenCode and its children. */
  stopPromise?: Promise<StopResult | null>;
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
  commitTree: (args: {
    worktreePath: string;
    message: string;
    allowEmpty?: boolean;
  }) => Promise<string | null>;
  updateRef: (args: { repoPath: string; ref: string; sha: string }) => Promise<void>;
  killTree: (args: { rootPid: number; pgid: number; graceMs?: number }) => Promise<KillTreeResult>;
  survivorScan: (attemptId: string) => Promise<number[]>;
  /** Optional local evidence sink: appended one JSON line per step so the
   * stop sequence is inspectable from disk even when the Trigger run is
   * already final and rejects metadata writes (observed 2026-09-07). */
  record?: (event: Record<string, unknown>) => Promise<void>;
};

/** Grace before SIGKILL on the abort path: Trigger gives roughly one second
 * between the abort signal and SIGTERM of the task process on maxDuration,
 * so the kill-first path cannot afford the default 3 s. */
const KILL_FIRST_GRACE_MS = 400;

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
  // `allowEmpty`: a checkpoint ref must exist after every stop, even when the
  // worker changed nothing, so the coordinator can always read it (ADR-0007
  // item 7) and the trial can assert on it deterministically.
  const commitId = await deps.commitTree({
    worktreePath: state.worktreePath,
    message: "agencyhq checkpoint",
    allowEmpty: true,
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

async function kill(
  state: RunState,
  deps: Pick<StopDeps, "killTree">,
  graceMs?: number,
): Promise<KillTreeResult> {
  return deps.killTree({
    rootPid: state.pid,
    pgid: state.pgid,
    ...(graceMs === undefined ? {} : { graceMs }),
  });
}

async function record(deps: Pick<StopDeps, "record">, event: Record<string, unknown>) {
  if (!deps.record) {
    return;
  }
  try {
    await deps.record({ at: new Date().toISOString(), ...event });
  } catch {
    // Evidence is best-effort; never let it block the kill.
  }
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
  if (!state) {
    return null;
  }
  if (state.cancelled) {
    // Another caller (the run()-scoped abort listener, or the separate
    // `onCancel` hook — whichever won the race) owns the sequence. Await it
    // so this caller's hook does not return before the kill has finished;
    // returning early lets Trigger terminate the task process mid-kill.
    return state.stopPromise ? await state.stopPromise : null;
  }
  // Claimed synchronously, before any await, so a concurrent caller sees
  // `cancelled === true` immediately rather than racing into its own run of
  // this routine.
  state.cancelled = true;
  state.stopPromise = runStopSequence(state, order, deps);
  return state.stopPromise;
}

async function runStopSequence(
  state: RunState,
  order: "kill-first" | "checkpoint-first",
  deps: StopDeps,
): Promise<StopResult> {
  await record(deps, { step: "stop_start", order, pid: state.pid, pgid: state.pgid });

  let checkpointCommit: string | null = null;
  let killResult: KillTreeResult = { terminated: [], killed: [], survivors: [] };

  if (order === "kill-first") {
    killResult = await kill(state, deps, KILL_FIRST_GRACE_MS);
    await record(deps, { step: "killed", ...killResult });
    try {
      checkpointCommit = await checkpoint(state, deps);
      await record(deps, { step: "checkpoint", checkpointCommit });
    } catch (error: unknown) {
      await record(deps, { step: "checkpoint_failed", error: String(error) });
    }
  } else {
    try {
      checkpointCommit = await checkpoint(state, deps);
      await record(deps, { step: "checkpoint", checkpointCommit });
    } catch (error: unknown) {
      // The kill must happen even when the checkpoint cannot be written.
      await record(deps, { step: "checkpoint_failed", error: String(error) });
    }
    killResult = await kill(state, deps);
    await record(deps, { step: "killed", ...killResult });
  }

  const survivors = await deps.survivorScan(state.attemptId);
  await record(deps, { step: "stop_done", survivors });

  return {
    checkpointCommit,
    survivors,
    killed: killResult.killed.length > 0,
  };
}
