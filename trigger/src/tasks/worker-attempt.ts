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
import { join } from "node:path";
import type { WorkerAttemptPayloadV2 } from "@agencyhq/contracts";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import { uploadAttemptArtifact } from "../lib/artifact-upload.ts";
import type { Broker } from "../lib/broker.ts";
import { createBroker } from "../lib/broker.ts";
import { classifyCapacity, providerFromModel } from "../lib/capacity.ts";
import { scrubbedChildEnv } from "../lib/env.ts";
import { uploadStopEvidence } from "../lib/evidence.ts";
import {
  changedPaths,
  commitChangedPaths,
  commitDiffDigest,
  commitTree,
  diffDigest,
  revertPaths,
  updateRef,
  worktreeAdd,
} from "../lib/git.ts";
import { parseEvents, spawnOpenCode, summarize, writeRunConfig } from "../lib/opencode.ts";
import { classifyPaths, quarantinePatch } from "../lib/paths.ts";
import { killTree, survivorScan } from "../lib/procs.ts";
import { prepareRuntime } from "../lib/runtime.ts";
import { materializeSource } from "../lib/source.ts";
import type { WorkerAttemptOutput, WorkerAttemptPayload } from "../types.ts";
import { TASK_IDS } from "../types.ts";
import type { RunState, StopDeps } from "./worker-attempt-core.ts";
import {
  buildOutput,
  checkpointAndKill,
  getRunState,
  outcomeFromViolations,
  registerRunState,
  resolveModel,
  resolveRunDir,
  resolveWorkerRuleset,
  resolveWorktreePath,
} from "./worker-attempt-core.ts";

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
  // medium-1x: coding attempts need 2 GB for git, opencode, and the model
  // client. MachinePresetName verified from schemas/common.d.ts (read 2026-09-09):
  //   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
  //   node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/common.d.ts
  // machine field on task verified from types/tasks.d.ts (read 2026-09-09).
  machine: "medium-1x",
  maxDuration: 600,
  queue: { name: "worker", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (
    payload: WorkerAttemptPayload | WorkerAttemptPayloadV2,
    { ctx, signal },
  ): Promise<WorkerAttemptOutput> => {
    // v2 payload: portable execution — materialize source from coordinator bundle.
    // Discriminant: v2 has `source: SourceRef`; v1 has `repoPath: string`.
    if ("source" in payload) {
      return runV2(payload as WorkerAttemptPayloadV2, { ctx, signal });
    }

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

    // Resolve the model — payload.model takes priority, then AGENCYHQ_OPENCODE_MODEL;
    // neither being set is a setup failure (AbortTaskRunError, no retry).
    let model: string;
    try {
      model = resolveModel({
        payloadModel: payload.model,
        envModel: process.env.AGENCYHQ_OPENCODE_MODEL,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AbortTaskRunError(message);
    }

    // Use the contract's permission ruleset (always required; always-deny entries
    // are merged on top for defense-in-depth so a malformed payload cannot widen
    // permissions). Throws AbortTaskRunError if permissionRules is absent.
    let ruleset: ReturnType<typeof resolveWorkerRuleset>["ruleset"];
    let permissionSource: ReturnType<typeof resolveWorkerRuleset>["source"];
    try {
      const resolved = resolveWorkerRuleset(payload);
      ruleset = resolved.ruleset;
      permissionSource = resolved.source;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AbortTaskRunError(message);
    }

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

      // Classify provider capacity from error events and publish as metadata.
      // metadata.set is a best-effort write; failure here must not abort the run.
      const capacity = classifyCapacity(events, {
        provider: providerFromModel(model),
        model,
        now: new Date(),
      });
      if (capacity !== null) {
        metadata.set("capacity", capacity);
      }
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

// ---------------------------------------------------------------------------
// v2 run path: portable execution via coordinator source bundles
// ---------------------------------------------------------------------------

/**
 * Run a worker attempt from a v2 payload (portable execution).
 *
 * Differences from v1:
 *  - No host repoPath/worktreeBase; source is materialized from a coordinator bundle.
 *  - prepareRuntime manages per-run HOME (provider auth.json) in container profile.
 *  - After commit, the attempt bundle is uploaded via uploadAttemptArtifact.
 *  - Stop evidence is uploaded via uploadStopEvidence.
 *  - cleanup() deletes the per-run HOME tree in container profile.
 *
 * Security invariants:
 *  - Tokens never appear in metadata, outputs, or thrown error messages.
 *  - HOME is deleted in finally (even on error).
 *  - Worker never pushes; only artifact upload is performed.
 */
// biome-ignore lint/suspicious/noExplicitAny: ctx shape is opaque from Trigger SDK
async function runV2(payload: WorkerAttemptPayloadV2, params: any): Promise<WorkerAttemptOutput> {
  const ctx = params.ctx as { run: { id: string; maxDuration?: number | null } };
  const signal = params.signal as AbortSignal;
  const coordinatorUrl = requireEnv("AGENCYHQ_COORDINATOR_INTERNAL_URL");
  // D1 / W-6: the nonce travels in the payload (generated by the coordinator at
  // dispatch); there is no environment fallback.
  const nonce = payload.leaseNonce;
  if (nonce === undefined) {
    throw new AbortTaskRunError("v2 payload without leaseNonce: dispatch did not record a nonce");
  }
  const runRoot = requireEnv("AGENCYHQ_RUN_ROOT");

  const broker = createBroker(coordinatorUrl);
  return runWorkerAttemptV2WithBroker(payload, ctx.run.id, signal, broker, runRoot, nonce);
}

/**
 * runWorkerAttemptV2WithBroker — broker-injectable entry point for the v2
 * worker path (W-16). Accepts an injected broker so tests can run with
 * FakeBroker without needing coordinator env vars.
 * No Trigger SDK metadata calls — testable in isolation.
 */
export async function runWorkerAttemptV2WithBroker(
  payload: WorkerAttemptPayloadV2,
  runId: string,
  signal: AbortSignal,
  broker: Broker,
  runRoot: string,
  nonceOverride?: string,
): Promise<WorkerAttemptOutput> {
  const nonce = nonceOverride ?? payload.leaseNonce;
  if (nonce === undefined) {
    throw new AbortTaskRunError("v2 payload without leaseNonce: dispatch did not record a nonce");
  }

  // Step 1: prepareRuntime — provider auth + per-run HOME
  const runtimeResult = await prepareRuntime({
    runId,
    attemptId: payload.attemptId,
    generation: payload.generation,
    nonce,
    broker,
    env: process.env as Record<string, string>,
  });

  if (!runtimeResult.ok) {
    // Classified execution failure — surface through AbortTaskRunError so
    // the coordinator's capacity rows see the kind.
    throw new AbortTaskRunError(`provider auth failed: ${runtimeResult.failureKind}`);
  }

  const { home, envAdditions, uploadLease, cleanup } = runtimeResult;
  const uploadToken =
    uploadLease && "token" in (uploadLease.material as object)
      ? (uploadLease.material as { purpose: "upload"; token: string }).token
      : "";

  const runDir = join(runRoot, "runs", runId);
  const cloneDir = join(runDir, "src");

  try {
    await mkdir(runDir, { recursive: true });

    // Step 2: materialize source bundle into clone dir
    const sourceResult = await materializeSource({
      source: payload.source,
      dir: cloneDir,
      broker,
      token: uploadToken,
    });

    if (!sourceResult.ok) {
      throw new AbortTaskRunError(`source materialization failed: ${sourceResult.failureKind}`);
    }

    const clonedDir = sourceResult.clonedDir;
    metadata.set("phase", "worktree_ready");

    // Step 3: model + ruleset
    let model: string;
    try {
      model = resolveModel({
        payloadModel: payload.model,
        envModel: process.env.AGENCYHQ_OPENCODE_MODEL,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AbortTaskRunError(message);
    }

    let ruleset: ReturnType<typeof resolveWorkerRuleset>["ruleset"];
    let permissionSource: ReturnType<typeof resolveWorkerRuleset>["source"];
    try {
      // v2 payload has the same permissionRules shape; cast for type compat.
      const resolved = resolveWorkerRuleset(payload as unknown as WorkerAttemptPayload);
      ruleset = resolved.ruleset;
      permissionSource = resolved.source;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AbortTaskRunError(message);
    }

    await writeRunConfig({ runDir, model, ruleset });
    metadata.set("permissionSource", permissionSource);

    // Step 4: spawn OpenCode in clone dir with per-run HOME
    const baseEnv = scrubbedChildEnv({ attemptId: payload.attemptId });
    const childEnv: Record<string, string> = { ...baseEnv, HOME: home, ...envAdditions };

    const { child, pid, pgid } = await spawnOpenCode({
      worktreePath: clonedDir,
      runDir,
      prompt: payload.prompt,
      model,
      env: childEnv,
    });

    // For v2, repoPath === clonedDir (clone is the standalone repo; no host repo).
    registerRunState(RUN_STATES, runId, {
      pid,
      pgid,
      worktreePath: clonedDir,
      repoPath: clonedDir,
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

    const abortState: {
      stopPromise: ReturnType<typeof checkpointAndKill> | null;
      softTimedOut: boolean;
    } = { stopPromise: null, softTimedOut: false };

    const onAbort = () => {
      void stopEvidence(runDir)({ at: new Date().toISOString(), step: "abort_signal" });
      abortState.stopPromise = checkpointAndKill(RUN_STATES, runId, "kill-first", stopDeps);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const maxDurationSeconds = 600;
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
      abortState.stopPromise = checkpointAndKill(RUN_STATES, runId, "kill-first", stopDeps);
    }, softDeadlineMs);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    signal.removeEventListener("abort", onAbort);
    clearTimeout(softTimer);

    if (signal.aborted || abortState.softTimedOut) {
      const stopResult = abortState.stopPromise
        ? await abortState.stopPromise.catch(() => null)
        : null;

      // Upload checkpoint bundle if checkpoint commit exists.
      let checkpointUploadStatus: "uploaded" | "failed" | "skipped" = "skipped";
      if (stopResult?.checkpointCommit && uploadToken) {
        // E6 / W-9: compute real diff digest and changed paths for the checkpoint.
        const [ckDiffDigest, ckChangedPaths] = await Promise.all([
          commitDiffDigest(clonedDir, payload.source.revision, stopResult.checkpointCommit),
          commitChangedPaths(clonedDir, payload.source.revision, stopResult.checkpointCommit),
        ]);
        const ckResult = await uploadAttemptArtifact({
          repoPath: clonedDir,
          commitId: stopResult.checkpointCommit,
          baseRevision: payload.source.revision,
          attemptId: payload.attemptId,
          generation: payload.generation,
          kind: "checkpoint",
          changedPaths: ckChangedPaths,
          diffDigest: ckDiffDigest,
          broker,
          token: uploadToken,
        });
        checkpointUploadStatus = ckResult.uploadStatus;
      }

      const evidenceResult = await uploadStopEvidence({
        runDir,
        attemptId: payload.attemptId,
        generation: payload.generation,
        broker,
        token: uploadToken,
      });

      metadata.set("phase", abortState.softTimedOut ? "timed_out" : "cancelled");
      return buildOutput({
        attemptId: payload.attemptId,
        outcome: abortState.softTimedOut ? "timed_out" : "cancelled",
        worktreePath: clonedDir,
        runDir,
        commitId: null,
        diffDigest: null,
        changedPaths: [],
        pathViolations: [],
        checkpointCommit: stopResult?.checkpointCommit ?? null,
        survivors: stopResult?.survivors ?? [],
        opencode: { sessionID: null, exitCode, denials: [], errors: [] },
        artifact: null,
        uploads: {
          artifact: "skipped",
          checkpoint: checkpointUploadStatus,
          stopEvidence: evidenceResult.uploadStatus,
        },
      });
    }

    metadata.set("phase", "diffing");

    // Step 5: summarize OpenCode events
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

      const capacity = classifyCapacity(events, {
        provider: providerFromModel(model),
        model,
        now: new Date(),
      });
      if (capacity !== null) {
        metadata.set("capacity", capacity);
      }
    } catch (error: unknown) {
      metadata.set("phase", "opencode_error");
      const message = error instanceof Error ? error.message : String(error);
      return buildOutput({
        attemptId: payload.attemptId,
        outcome: "opencode_error",
        worktreePath: clonedDir,
        runDir,
        commitId: null,
        diffDigest: null,
        changedPaths: [],
        pathViolations: [],
        checkpointCommit: null,
        survivors: [],
        opencode: { sessionID: null, exitCode, denials: [], errors: [message] },
        artifact: null,
        uploads: { artifact: "skipped", checkpoint: "skipped", stopEvidence: "skipped" },
      });
    }

    // Step 6: classify, quarantine, commit
    const baseRev = payload.source.revision;
    const changed = await changedPaths({ worktreePath: clonedDir, baseRev });
    const { violations } = classifyPaths({
      changed,
      allowed: payload.allowedPaths,
      denied: payload.bounds?.paths.deny ?? [],
    });

    if (violations.length > 0) {
      const patch = await quarantinePatch({
        worktreePath: clonedDir,
        baseRev,
        paths: violations,
      });
      await writeFile(`${runDir}/quarantine.patch`, patch);
      await revertPaths({ worktreePath: clonedDir, paths: violations, baseRev });
    }

    const commitId = await commitTree({
      worktreePath: clonedDir,
      message: `agencyhq attempt ${payload.attemptId}`,
    });
    // v2: no host updateRef; artifact bundle upload takes its place below.

    const digest = await diffDigest({ worktreePath: clonedDir, baseRev });
    const outcome = outcomeFromViolations(violations);

    // Step 7: upload artifact bundle
    let artifactUploadStatus: "uploaded" | "failed" | "skipped" = "skipped";
    let artifactRef = null;
    if (commitId && uploadToken) {
      const uploadResult = await uploadAttemptArtifact({
        repoPath: clonedDir,
        commitId,
        baseRevision: baseRev,
        attemptId: payload.attemptId,
        generation: payload.generation,
        kind: "attempt",
        changedPaths: changed,
        diffDigest: digest,
        broker,
        token: uploadToken,
      });
      artifactUploadStatus = uploadResult.uploadStatus;
      artifactRef = uploadResult.artifactRef;
    }

    // Step 8: upload stop evidence
    const evidenceResult = await uploadStopEvidence({
      runDir,
      attemptId: payload.attemptId,
      generation: payload.generation,
      broker,
      token: uploadToken,
    });

    metadata.set("phase", outcome === "path_violation" ? "path_violation" : "committed");

    return buildOutput({
      attemptId: payload.attemptId,
      sessionId: sessionID ?? "unknown",
      report: {
        attempted: textTail.slice(0, 4000),
        outputs: changed,
        checksRun: [],
        unmetCriteria: [],
        limitations: violations.length > 0 ? [`quarantined: ${violations.join(", ")}`] : [],
        findings: [],
      },
      outcome,
      worktreePath: clonedDir,
      runDir,
      commitId,
      diffDigest: digest,
      changedPaths: changed,
      pathViolations: violations,
      checkpointCommit: null,
      survivors: [],
      opencode: { sessionID, exitCode, denials, errors },
      artifact: artifactRef,
      uploads: {
        artifact: artifactUploadStatus,
        checkpoint: "skipped",
        stopEvidence: evidenceResult.uploadStatus,
      },
    });
  } finally {
    await cleanup();
  }
}
