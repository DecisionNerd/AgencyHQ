// The `integrate.merge` Trigger task: integrates an attempt commit into the
// coordinator-owned clone and pushes to the remote (R-015, R-010,
// ARCHITECTURE.md lines 85-110).  This is the ONLY task that may push;
// worker tasks commit locally only (ADR-0007).
//
// Design invariants:
//   - Runs with the task's own host environment so the git credential helper
//     works (NOT the scrubbed worker env from env.ts).
//   - AbortTaskRunError is thrown only for setup failures (bad payload,
//     missing repo).  All other outcomes are returned as structured output.
//   - concurrencyLimit: 1 on the "integrate" queue serialises pushes per
//     Trigger project; callers are responsible for per-repository serialisation
//     via concurrencyKey when triggering.
//   - retries: 0 — the task is idempotent via already_integrated but
//     retry-on-failure would mask coordinator bugs.

import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortTaskRunError, metadata, task } from "@trigger.dev/sdk";
import {
  fetchRef,
  isAncestor,
  lsRemote,
  mergeInWorktree,
  pushForceWithLease,
  worktreeAdd,
  worktreeRemove,
} from "../lib/git.ts";
import type { IntegrateMergeOutput, IntegrateMergePayload } from "../types.ts";
import type { IntegrateMergeDeps } from "./integrate-merge-core.ts";
import { runIntegrateMerge } from "./integrate-merge-core.ts";

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function parsePayload(raw: unknown): IntegrateMergePayload {
  if (typeof raw !== "object" || raw === null) {
    throw new AbortTaskRunError("integrate.merge: invalid payload: not an object");
  }
  const p = raw as Record<string, unknown>;
  const requiredStrings: (keyof IntegrateMergePayload)[] = [
    "attemptId",
    "contractId",
    "contractVersion",
    "projectId",
    "repoPath",
    "remote",
    "targetRef",
    "expectedBaseRevision",
    "attemptRevision",
  ];
  for (const key of requiredStrings) {
    if (typeof p[key] !== "string" || !(p[key] as string).trim()) {
      throw new AbortTaskRunError(
        `integrate.merge: invalid payload: missing or empty field "${key}"`,
      );
    }
  }
  if (typeof p.generation !== "number") {
    throw new AbortTaskRunError(
      'integrate.merge: invalid payload: field "generation" must be a number',
    );
  }
  if (p.strategy !== "merge_commit" && p.strategy !== "fast_forward") {
    throw new AbortTaskRunError(
      'integrate.merge: invalid payload: strategy must be "merge_commit" or "fast_forward"',
    );
  }
  return p as unknown as IntegrateMergePayload;
}

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

export const integrateMerge = task({
  id: "integrate.merge",
  maxDuration: 300,
  queue: { name: "integrate", concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },

  run: async (rawPayload: unknown): Promise<IntegrateMergeOutput> => {
    metadata.set("phase", "validating");

    // Validate payload; AbortTaskRunError on failure (never retried).
    const payload = parsePayload(rawPayload);

    // Ensure the coordinator repo exists before doing any git work.
    await stat(payload.repoPath).catch(() => {
      throw new AbortTaskRunError(
        `integrate.merge: coordinator repo not found: ${payload.repoPath}`,
      );
    });

    metadata.set("phase", "setup");

    // Use the task's own host environment so the credential helper for pushes
    // is available.  GIT_TERMINAL_PROMPT=0 prevents any interactive prompt.
    const hostEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

    // Create a run-local temp directory for the merge worktree.
    const runDir = await mkdir(join(tmpdir(), `agencyhq-integrate-${payload.attemptId}-`), {
      recursive: true,
    })
      .then(() => join(tmpdir(), `agencyhq-integrate-${payload.attemptId}-`))
      .catch(async () => {
        // If the fixed-name dir already exists, fall back to mkdtemp.
        const { mkdtemp } = await import("node:fs/promises");
        return mkdtemp(join(tmpdir(), `agencyhq-integrate-${payload.attemptId}-`));
      });

    // Wire up the real git deps with the host environment.
    const deps: IntegrateMergeDeps = {
      fetchRef: (args) => fetchRef({ ...args, env: hostEnv }),
      lsRemote: (args) => lsRemote({ ...args, env: hostEnv }),
      isAncestor: (args) => isAncestor({ ...args, env: hostEnv }),
      worktreeAdd,
      worktreeRemove,
      mergeInWorktree: (args) => mergeInWorktree({ ...args, env: hostEnv }),
      pushForceWithLease: (args) => pushForceWithLease({ ...args, env: hostEnv }),
    };

    metadata.set("phase", "integrating");
    metadata.set("attemptId", payload.attemptId);
    metadata.set("strategy", payload.strategy);

    let output: IntegrateMergeOutput;
    try {
      output = await runIntegrateMerge(payload, deps, runDir);
    } finally {
      // Clean up the run dir (best-effort; merge worktree is removed inside core).
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }

    metadata.set("phase", "done");
    metadata.set("outcome", output.outcome);

    return output;
  },
});
