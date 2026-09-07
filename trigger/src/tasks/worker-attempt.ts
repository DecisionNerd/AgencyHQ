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
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";

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
  outcomeFromViolations,
  registerRunState,
  resolveRunDir,
  resolveWorktreePath,
} from "./worker-attempt-core.ts";

const DEFAULT_MODEL = "openai/gpt-5.6-terra";

// Shared between the run()-scoped abort listener and the onCancel hook so
// both can find the same in-flight run's process/worktree details and so
// `checkpointAndKill` (see worker-attempt-core.ts) can guard against doing
// the kill-and-checkpoint sequence twice.
const RUN_STATES = new Map<string, RunState>();

const STOP_DEPS: StopDeps = { commitTree, updateRef, killTree, survivorScan };

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
    const ruleset = buildPermissionRuleset({ allowedPaths: payload.allowedPaths, worktreePath });
    await mkdir(runDir, { recursive: true });
    await writeRunConfig({ runDir, model, ruleset });

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
    });

    metadata.set("phase", "opencode_running");
    metadata.set("pid", pid);
    metadata.set("pgid", pgid);
    watchForSessionId(child.stdout, (sessionID) => metadata.set("sessionID", sessionID));

    // An object (not a bare `let`) so the abort listener's assignment is a
    // property write, not a closure-captured local — TypeScript would
    // otherwise narrow the read below to the variable's initial `null`.
    const abortState: { stopPromise: ReturnType<typeof checkpointAndKill> | null } = {
      stopPromise: null,
    };
    const onAbort = () => {
      // Kill immediately (no await on git first); the checkpoint commit
      // happens only after the process group is already being torn down.
      // Not awaited here — the listener itself must return synchronously —
      // but `run()` awaits `abortState.stopPromise` below before it returns.
      abortState.stopPromise = checkpointAndKill(RUN_STATES, ctx.run.id, "kill-first", STOP_DEPS);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // "close" (not "exit"): "exit" can fire before the piped stdout/stderr
    // streams have finished flushing to events.ndjson/stderr.log, which
    // would make the diffing phase below read a truncated event stream.
    // "close" fires once the child's stdio streams are done.
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    signal.removeEventListener("abort", onAbort);

    if (signal.aborted) {
      const stopResult = abortState.stopPromise
        ? await abortState.stopPromise.catch(() => null)
        : null;
      if (stopResult) {
        metadata.set("checkpointCommit", stopResult.checkpointCommit);
        metadata.set("survivors", stopResult.survivors);
        metadata.set("killed", stopResult.killed);
      }
      return buildOutput({
        attemptId: payload.attemptId,
        outcome: "cancelled",
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
    try {
      const eventsText = await readFile(`${runDir}/events.ndjson`, "utf8").catch(() => "");
      const events = parseEvents(eventsText);
      const summary = summarize(events);
      sessionID = summary.sessionID ?? null;
      denials = summary.denials;
      errors = summary.errors;
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
    const { violations } = classifyPaths({ changed, allowed: payload.allowedPaths });

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
      const stopResult = await checkpointAndKill(
        RUN_STATES,
        ctx.run.id,
        "checkpoint-first",
        STOP_DEPS,
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
