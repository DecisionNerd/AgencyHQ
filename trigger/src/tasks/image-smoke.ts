/**
 * image.smoke task — clones a public fixture repository inside the task
 * container and runs the `fixture-node-v1` verification profile's checks
 * using the scrubbed child environment.
 *
 * Purpose: prove that the deployed AgencyHQ task image contains a working
 * Node/pnpm/git toolchain that can install dependencies, typecheck, and test
 * a real public repository — without any host checkout or installed tools.
 *
 * This task is only dispatched by the image smoke script
 * (trigger/scripts/image-smoke.ts) during L1 qualification (#16 BDD 2).
 * It is never dispatched as part of the production work flow.
 *
 * machine: "small-2x" — 2 vCPU / 1 GB; clone + pnpm install + typecheck + test
 * for a small fixture repo fits comfortably in this preset.
 * MachinePresetName "small-2x" verified from @trigger.dev/core@4.5.16
 * schemas/common.d.ts (read 2026-09-09).
 */

import { execFile as execFileCb } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CheckDef, RunCheckResult } from "@agencyhq/verification";
import { CHECK_CATALOG, resolveProfile, runCheck } from "@agencyhq/verification";
import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import { scrubbedChildEnv } from "../lib/env.ts";
import type { ImageSmokeCheckResult, ImageSmokeOutput, ImageSmokePayload } from "../types.ts";
import { TASK_IDS } from "../types.ts";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Git clone helper (real implementation)
// ---------------------------------------------------------------------------

/**
 * Shallow-clone a public remote at a specific revision into `dir`.
 *
 * Strategy:
 * 1. Try `git clone --depth 1 --branch <revision>` (works for branch/tag names).
 * 2. If that fails (revision is a commit SHA, not a named ref), fall back to
 *    a shallow clone of the default branch followed by a targeted fetch+checkout.
 */
async function gitCloneAtRevision(remote: string, revision: string, dir: string): Promise<void> {
  const commonGitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  };

  try {
    // Fast path: revision is a named ref (branch, tag).
    await execFile("git", ["clone", "--depth", "1", "--branch", revision, remote, dir], {
      timeout: 180_000,
      env: commonGitEnv,
    });
    return;
  } catch {
    // revision may be a commit SHA — fall through to the two-step fetch.
  }

  // Slow path: clone default branch, then fetch the specific commit.
  await execFile("git", ["clone", "--depth", "1", remote, dir], {
    timeout: 180_000,
    env: commonGitEnv,
  });
  // git fetch --depth 1 origin <sha> works on modern git for public remotes.
  await execFile("git", ["-C", dir, "fetch", "--depth", "1", "origin", revision], {
    timeout: 60_000,
    env: commonGitEnv,
  });
  await execFile("git", ["-C", dir, "checkout", "FETCH_HEAD"], {
    timeout: 30_000,
    env: commonGitEnv,
  });
}

// ---------------------------------------------------------------------------
// Pass predicate (mirrors verify-run-core.ts logic for simple checks)
// ---------------------------------------------------------------------------

function isPassed(def: CheckDef, result: RunCheckResult): boolean {
  if (result.timedOut) return false;
  if (def.passWhen !== undefined) {
    return def.passWhen({
      exitStatus: result.exitStatus,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    });
  }
  return result.exitStatus === 0;
}

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

export type ImageSmokeDeps = {
  /** Clone the fixture remote at the given revision into dir. */
  clone: (remote: string, revision: string, dir: string) => Promise<void>;
  /**
   * Run a single check. Same signature as @agencyhq/verification runCheck.
   * Injected for testability; production uses the real runCheck.
   */
  runCheckFn: typeof runCheck;
  /**
   * Called with the clone directory path immediately after it is computed and
   * before any checks run. Allows the caller to record the path for cleanup
   * even when subsequent operations throw.
   */
  onCloneDir?: (dir: string) => void;
};

/**
 * Core smoke logic, exported for unit tests. The Trigger task wrapper calls
 * this function; tests call it directly without needing the Trigger runtime.
 *
 * Does NOT clean up `cloneDir` — cleanup is the caller's responsibility
 * (the task wrapper does it in a finally block).
 */
export async function runImageSmoke(
  payload: ImageSmokePayload,
  deps: ImageSmokeDeps,
): Promise<ImageSmokeOutput> {
  const runRoot = process.env.AGENCYHQ_RUN_ROOT ?? "/tmp/agencyhq";
  const cloneDir = join(runRoot, `smoke-${Date.now()}`);

  // Notify caller of the clone directory before any operations so cleanup
  // can happen even if clone or a check throws.
  deps.onCloneDir?.(cloneDir);

  // Validate the profile before cloning to fail fast on a bad profileId.
  const profile = resolveProfile(payload.profileId);

  // Scrubbed env mirrors what verify.run uses for check processes.
  const env = scrubbedChildEnv({ attemptId: "image.smoke" });

  await deps.clone(payload.fixtureRemote, payload.fixtureRevision, cloneDir);

  const results: ImageSmokeCheckResult[] = [];
  for (const checkId of profile.checks) {
    const def = CHECK_CATALOG[checkId];
    if (def === undefined) {
      throw new Error(`image.smoke: unknown check "${checkId}" in profile "${profile.id}"`);
    }
    const run = await deps.runCheckFn(def, { cwd: cloneDir, env });
    results.push({
      checkId,
      passed: isPassed(def, run),
      exitStatus: run.exitStatus,
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
      timedOut: run.timedOut,
    });
  }

  return { cloneDir, results };
}

// ---------------------------------------------------------------------------
// Trigger task wrapper
// ---------------------------------------------------------------------------

export const imageSmoke = task({
  id: TASK_IDS.imageSmoke,
  // small-2x: clone + pnpm install + typecheck + test for a small fixture repo.
  // MachinePresetName "small-2x" verified from schemas/common.d.ts (read 2026-09-09).
  machine: "small-2x",
  maxDuration: 600,
  retry: { maxAttempts: 1 },

  run: async (payload: ImageSmokePayload): Promise<ImageSmokeOutput> => {
    // Validate payload early.
    if (!payload.fixtureRemote) {
      throw new AbortTaskRunError("image.smoke: fixtureRemote is required");
    }
    if (!payload.fixtureRevision) {
      throw new AbortTaskRunError("image.smoke: fixtureRevision is required");
    }
    if (!payload.profileId) {
      throw new AbortTaskRunError("image.smoke: profileId is required");
    }

    let result: ImageSmokeOutput | undefined;
    let cloneDir: string | undefined;

    try {
      result = await runImageSmoke(payload, {
        clone: gitCloneAtRevision,
        runCheckFn: runCheck,
        // Capture the clone dir before checks run so cleanup happens even on failure.
        onCloneDir: (dir) => {
          cloneDir = dir;
        },
      });
      return result;
    } finally {
      // Best-effort cleanup of the clone directory.
      if (cloneDir !== undefined) {
        await rm(cloneDir, { recursive: true, force: true }).catch(() => {
          // Ignore cleanup errors — the run root is ephemeral.
        });
      }
    }
  },
});
