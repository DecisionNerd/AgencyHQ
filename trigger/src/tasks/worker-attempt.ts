// The `worker.attempt` Trigger task: worktree-scrub-run-diff-commit and the
// checkpoint-and-kill stop sequence from ADR-0007
// (docs/engineering/adrs/0007-worker-effect-model.md lines 18-63) and
// docs/engineering/EXECUTION_MODEL.md lines 7-41, 68-86. Options and
// lifecycle hook shapes verified against the installed
// `@trigger.dev/sdk@4.5.16` / `@trigger.dev/core@4.5.16` type declarations
// (node_modules/.pnpm/@trigger.dev+core@4.5.16.../v3/types/tasks.d.ts and
// .../lifecycleHooks/types.d.ts), read 2026-09-07:
//
// - `onCancel` is a per-task option (not a separate registration), called as
//   `onCancel({ ctx, payload, task, runPromise, init, signal })` with up to a
//   ~30s bounded grace period.
// - `signal` (in both `run`'s params and `onCancel`'s params) aborts on
//   cancellation AND on `maxDuration`; on a `maxDuration` abort there is NO
//   `onCancel` call, only the signal, and roughly 1s before SIGTERM reaches
//   the task process itself. That is why the fast path below (the abort
//   listener registered inside `run`) does not wait on `onCancel` to ever
//   fire, and why it kills before it commits.
// - `ctx.run.id` is the Trigger run id, stable for the run's lifetime and
//   shared between `run`'s `ctx` and `onCancel`'s `ctx` — used as the key
//   into the module-level run-state map so both paths can find the same
//   registered `{ pid, pgid, worktreePath, repoPath, attemptId }`.
//
// The `opencode_error` outcome below is deliberately narrow: it fires only
// when the OpenCode process/event-stream itself could not be read (spawn
// failure or malformed NDJSON), never on the semantic content of an event.
// Everything past that point is mechanical: diff, classify paths, quarantine
// violations, commit the remainder. No other policy lives in this file.
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";

import type {
  PermissionAction,
  PermissionPatternMap,
  PermissionRuleset as ContractsPermissionRuleset,
} from "@agencyhq/contracts";
import { WORKER_ALWAYS_DENY_BASH, WORKER_ALWAYS_DENY_PATHS } from "@agencyhq/contracts";

import { scrubbedChildEnv } from "../lib/env.ts";
import {
  changedPaths,
  commitTree,
  diffDigest,
  revertPaths,
  updateRef,
  worktreeAdd,
} from "../lib/git.ts";
import {
  buildPermissionRuleset,
  parseEvents,
  spawnOpenCode,
  summarize,
  writeRunConfig,
} from "../lib/opencode.ts";
import { classifyPaths, quarantinePatch } from "../lib/paths.ts";
import { killTree, survivorScan } from "../lib/procs.ts";
import type { WorkerAttemptOutput, WorkerAttemptPayload } from "../types.ts";
import { TASK_IDS } from "../types.ts";
import type { RunState, StopDeps } from "./worker-attempt-core.ts";
import {
  buildOutput,
  checkpointAndKill,
  getRunState,
  outcomeFromViolations,
  registerRunState,
  resolveRunDir,
  resolveWorktreePath,
} from "./worker-attempt-core.ts";

const DEFAULT_MODEL = "openai/gpt-5.6-terra";

/**
 * Defense-in-depth: merge always-deny entries on top of a contract ruleset.
 * Ensures that task and external_directory are always denied, and that bash
 * patterns from WORKER_ALWAYS_DENY_BASH and file patterns from
 * WORKER_ALWAYS_DENY_PATHS are denied after any allows, even if the payload
 * ruleset explicitly allowed them. Last-match-wins is OpenCode's rule.
 */
function enforceAlwaysDeny(ruleset: ContractsPermissionRuleset): ContractsPermissionRuleset {
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

/** Adapter soft deadline before Trigger's hard maxDuration. Observed
 * 2026-09-07 (trial item 3, trigger.dev 4.5.16 dev): on maxDuration the
 * worker sends MAX_DURATION_EXCEEDED, aborts the signal, and the CLI SIGTERMs
 * the task process at once; a Node process without a SIGTERM handler exits
 * immediately, so the abort listener gets no usable time. The adapter
 * therefore stops the worker itself this many seconds early and reports
 * outcome "timed_out"; the hard maxDuration remains the backstop. */
const SOFT_DEADLINE_MARGIN_SECONDS = 15;
const SOFT_DEADLINE_MIN_SECONDS = 5;

/** SIGTERM hold: with a handler registered Node no longer exits on SIGTERM,
 * so the in-flight stop sequences get the CLI's graceful-termination window
 * (about one second) before its SIGKILL. Registered once per task process. */
let sigtermHoldInstalled = false;
function installSigtermHold(states: Map<string, RunState>): void {
  if (sigtermHoldInstalled) {
    return;
  }
  sigtermHoldInstalled = true;
  process.on("SIGTERM", () => {
    const pending: Promise<unknown>[] = [];
    for (const [runId, state] of states) {
      if (!state.cancelled) {
        pending.push(
          checkpointAndKill(states, runId, "kill-first", stopDepsFor(state.runDir)).catch(
            () => null,
          ),
        );
      } else if (state.stopPromise) {
        pending.push(state.stopPromise.catch(() => null));
      }
    }
    const cap = new Promise((resolve) => setTimeout(resolve, 800));
    void Promise.race([Promise.all(pending), cap]).then(() => process.exit(143));
  });
}

// Shared between the run()-scoped abort listener and the onCancel hook so
// both can find the same in-flight run's process/worktree details and so
// `checkpointAndKill` (see worker-attempt-core.ts) can guard against doing
// the kill-and-checkpoint sequence twice.
const RUN_STATES = new Map<string, RunState>();

/** Local stop evidence: one JSON line per step in `<runDir>/stop.ndjson`.
 * Written from disk-side code because a cancelled Trigger run is already
 * final at the API and rejects metadata writes (observed 2026-09-07). */
function stopEvidence(runDir: string) {
  return async (event: Record<string, unknown>) => {
    await appendFile(`${runDir}/stop.ndjson`, `${JSON.stringify(event)}\n`);
  };
}

function stopDepsFor(runDir: string | undefined): StopDeps {
  return {
    commitTree,
    updateRef,
    killTree,
    survivorScan,
    ...(runDir ? { record: stopEvidence(runDir) } : {}),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AbortTaskRunError(`missing required environment variable: ${name}`);
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort watch of the OpenCode child's stdout for the first line that
 * carries a `sessionID`, so it can be published to run metadata as soon as
 * it is known. Not a substitute for `summarize()`'s reduction of the full
 * event stream after exit; this only ever reports the first sessionID seen.
 */
function watchForSessionId(
  stdout: NodeJS.ReadableStream | null,
  onFound: (sessionID: string) => void,
): void {
  if (!stdout) {
    return;
  }
  let buffer = "";
  let found = false;
  stdout.on("data", (chunk: Buffer | string) => {
    if (found) {
      return;
    }
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1 && !found) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as { sessionID?: unknown };
          if (typeof parsed.sessionID === "string") {
            found = true;
            onFound(parsed.sessionID);
          }
        } catch {
          // Not a JSON line (or a partial one split across chunks): this
          // watcher is best-effort only, so it is simply ignored.
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

export const workerAttempt = task({
  id: TASK_IDS.workerAttempt,
  maxDuration: 600,
  queue: { name: "worker", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (payload: WorkerAttemptPayload, { ctx, signal }): Promise<WorkerAttemptOutput> => {
    const worktreeBase = payload.worktreeBase ?? requireEnv("AGENCYHQ_WORKTREE_BASE");
    const worktreePath = resolveWorktreePath({ worktreeBase, attemptId: payload.attemptId });
    const runDir = resolveRunDir({ worktreeBase, attemptId: payload.attemptId });

    if (await pathExists(worktreePath)) {
      // A worktree that already exists at this path is a setup contract
      // failure (worktrees are never reused, ADR-0007 #2): fail without
      // retry rather than add to or clobber it.
      throw new AbortTaskRunError(`worktree exists: ${worktreePath}`);
    }

    await worktreeAdd({ repoPath: payload.repoPath, worktreePath, rev: payload.baseRev });
    metadata.set("phase", "worktree_ready");

    const model = payload.model ?? process.env.AGENCYHQ_OPENCODE_MODEL ?? DEFAULT_MODEL;

    // F-1: Use the contract's permission ruleset when present (coordinator path);
    // fall back to the spike's buildPermissionRuleset when absent.
    // Defense-in-depth: always-deny entries are merged on top of the contract
    // ruleset regardless, so a malformed payload cannot widen permissions.
    const permissionSource: "contract" | "fallback" = payload.permissionRules
      ? "contract"
      : "fallback";
    const ruleset =
      payload.permissionRules !== undefined
        ? enforceAlwaysDeny(payload.permissionRules)
        : buildPermissionRuleset({
            allowedPaths: payload.allowedPaths,
            worktreePath,
            deniedPaths: payload.bounds?.paths.deny ?? [],
          });

    await mkdir(runDir, { recursive: true });
    await writeRunConfig({ runDir, model, ruleset });
    metadata.set("permissionSource", permissionSource);

    const env = scrubbedChildEnv({ attemptId: payload.attemptId });
    const { child, pid, pgid } = await spawnOpenCode({
      worktreePath,
      runDir,
      prompt: payload.prompt,
      model,
      env,
    });

    registerRunState(RUN_STATES, ctx.run.id, {
      pid,
      pgid,
      worktreePath,
      repoPath: payload.repoPath,
      attemptId: payload.attemptId,
      cancelled: false,
      runDir,
    });
    const stopDeps = stopDepsFor(runDir);
    installSigtermHold(RUN_STATES);

    metadata.set("phase", "opencode_running");
    metadata.set("pid", pid);
    metadata.set("pgid", pgid);
    watchForSessionId(child.stdout, (sessionID) => metadata.set("sessionID", sessionID));

    // An object (not a bare `let`) so the abort listener's assignment is a
    // property write, not a closure-captured local — TypeScript would
    // otherwise narrow the read below to the variable's initial `null`.
    const abortState: {
      stopPromise: ReturnType<typeof checkpointAndKill> | null;
      softTimedOut: boolean;
    } = { stopPromise: null, softTimedOut: false };
    const onAbort = () => {
      // Kill immediately (no await on git first); the checkpoint commit
      // happens only after the process group is already being torn down.
      // Not awaited here — the listener itself must return synchronously —
      // but `run()` awaits `abortState.stopPromise` below before it returns.
      void stopEvidence(runDir)({ at: new Date().toISOString(), step: "abort_signal" });
      abortState.stopPromise = checkpointAndKill(RUN_STATES, ctx.run.id, "kill-first", stopDeps);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const maxDurationSeconds = ctx.run.maxDuration ?? 600;
    const softDeadlineMs =
      Math.max(SOFT_DEADLINE_MIN_SECONDS, maxDurationSeconds - SOFT_DEADLINE_MARGIN_SECONDS) * 1000;
    const softTimer = setTimeout(() => {
      abortState.softTimedOut = true;
      void stopEvidence(runDir)({
        at: new Date().toISOString(),
        step: "soft_deadline",
        maxDurationSeconds,
        softDeadlineMs,
      });
      abortState.stopPromise = checkpointAndKill(RUN_STATES, ctx.run.id, "kill-first", stopDeps);
    }, softDeadlineMs);

    // "close" (not "exit"): "exit" can fire before the piped stdout/stderr
    // streams have finished flushing to events.ndjson/stderr.log, which
    // would make the diffing phase below read a truncated event stream.
    // "close" fires once the child's stdio streams are done.
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    signal.removeEventListener("abort", onAbort);
    clearTimeout(softTimer);

    if (signal.aborted || abortState.softTimedOut) {
      const stopResult = abortState.stopPromise
        ? await abortState.stopPromise.catch(() => null)
        : null;
      if (stopResult) {
        metadata.set("checkpointCommit", stopResult.checkpointCommit);
        metadata.set("survivors", stopResult.survivors);
        metadata.set("killed", stopResult.killed);
      }
      metadata.set("phase", abortState.softTimedOut ? "timed_out" : "cancelled");
      return buildOutput({
        attemptId: payload.attemptId,
        outcome: abortState.softTimedOut ? "timed_out" : "cancelled",
        worktreePath,
        runDir,
        commitId: null,
        diffDigest: null,
        changedPaths: [],
        pathViolations: [],
        checkpointCommit: stopResult?.checkpointCommit ?? null,
        survivors: stopResult?.survivors ?? [],
        opencode: { sessionID: null, exitCode, denials: [], errors: [] },
      });
    }

    metadata.set("phase", "diffing");

    let sessionID: string | null = null;
    let denials: WorkerAttemptOutput["opencode"]["denials"] = [];
    let errors: string[] = [];
    let textTail = "";
    try {
      const eventsText = await readFile(`${runDir}/events.ndjson`, "utf8").catch(() => "");
      const events = parseEvents(eventsText);
      const summary = summarize(events);
      sessionID = summary.sessionID ?? null;
      denials = summary.denials;
      errors = summary.errors;
      textTail = summary.textTail;
    } catch (error: unknown) {
      metadata.set("phase", "opencode_error");
      const message = error instanceof Error ? error.message : String(error);
      return buildOutput({
        attemptId: payload.attemptId,
        outcome: "opencode_error",
        worktreePath,
        runDir,
        commitId: null,
        diffDigest: null,
        changedPaths: [],
        pathViolations: [],
        checkpointCommit: null,
        survivors: [],
        opencode: { sessionID: null, exitCode, denials: [], errors: [message] },
      });
    }

    const changed = await changedPaths({ worktreePath, baseRev: payload.baseRev });
    // F-4: pass denied paths so the on-output classification matches the
    // before-action permission ruleset's deny layer (last-match-wins).
    const { violations } = classifyPaths({
      changed,
      allowed: payload.allowedPaths,
      denied: payload.bounds?.paths.deny ?? [],
    });

    if (violations.length > 0) {
      const patch = await quarantinePatch({
        worktreePath,
        baseRev: payload.baseRev,
        paths: violations,
      });
      await writeFile(`${runDir}/quarantine.patch`, patch);
      await revertPaths({ worktreePath, paths: violations, baseRev: payload.baseRev });
    }

    const commitId = await commitTree({
      worktreePath,
      message: `agencyhq attempt ${payload.attemptId}`,
    });
    if (commitId) {
      // Fully-qualified (see the matching comment in worker-attempt-core.ts's
      // checkpoint() helper): a real `refs/heads/...` branch, not a loose
      // ref file outside the `refs/` hierarchy.
      await updateRef({
        repoPath: payload.repoPath,
        ref: `refs/heads/agencyhq/attempts/${payload.attemptId}`,
        sha: commitId,
      });
    }

    const digest = await diffDigest({ worktreePath, baseRev: payload.baseRev });
    const outcome = outcomeFromViolations(violations);
    metadata.set("phase", outcome === "path_violation" ? "path_violation" : "committed");

    return buildOutput({
      attemptId: payload.attemptId,
      sessionId: sessionID ?? "unknown",
      // The worker's own account (its final message and the paths it touched)
      // travels as context for the Lead; acceptance never reads it.
      report: {
        attempted: textTail.slice(0, 4000),
        outputs: changed,
        checksRun: [],
        unmetCriteria: [],
        limitations: violations.length > 0 ? [`quarantined: ${violations.join(", ")}`] : [],
        findings: [],
      },
      outcome,
      worktreePath,
      runDir,
      commitId,
      diffDigest: digest,
      changedPaths: changed,
      pathViolations: violations,
      checkpointCommit: null,
      survivors: [],
      opencode: { sessionID, exitCode, denials, errors },
    });
  },

  onCancel: async ({ ctx }) => {
    try {
      const runDir = getRunState(RUN_STATES, ctx.run.id)?.runDir;
      if (runDir) {
        await stopEvidence(runDir)({ at: new Date().toISOString(), step: "on_cancel_entered" });
      }
      const stopResult = await checkpointAndKill(
        RUN_STATES,
        ctx.run.id,
        "checkpoint-first",
        stopDepsFor(runDir),
      );
      if (stopResult) {
        metadata.set("checkpointCommit", stopResult.checkpointCommit);
        metadata.set("survivors", stopResult.survivors);
        metadata.set("killed", stopResult.killed);
      }
    } catch {
      // Never throw from onCancel: a throw here would not help the run
      // reach a final status any faster and could mask the real one.
    }
  },
});
