// Pure/injectable pieces of the `integrate.merge` task (R-015, R-010,
// docs/engineering/ARCHITECTURE.md lines 85-110: only integrate.merge may push;
// adapters commit locally).
//
// No Trigger SDK import. No direct child_process or fs calls except through
// injected dependencies. Deps are injected so the logic can be unit-tested
// without a live Trigger instance or real git remote.

import { scrubCredentials } from "../lib/git.ts";
import type { IntegrateMergeOutput, IntegrateMergePayload } from "../types.ts";

// ---------------------------------------------------------------------------
// IntegrateMergeDeps
// ---------------------------------------------------------------------------

/** Injected dependencies for runIntegrateMerge. All git I/O goes through these. */
export type IntegrateMergeDeps = {
  /** Fetch targetRef from remote; return the observed SHA (FETCH_HEAD). */
  fetchRef(args: { repoPath: string; remote: string; ref: string }): Promise<string>;
  /** Query a remote ref; return SHA or null when not found. */
  lsRemote(args: { repoPath: string; remote: string; ref: string }): Promise<string | null>;
  /** True if ancestorRev is an ancestor of (or equal to) descendantRev in repoPath. */
  isAncestor(args: {
    repoPath: string;
    ancestorRev: string;
    descendantRev: string;
  }): Promise<boolean>;
  /** Add a detached git worktree at worktreePath checked out at rev. */
  worktreeAdd(args: { repoPath: string; worktreePath: string; rev: string }): Promise<void>;
  /** Remove a git worktree (force removes even if dirty). */
  worktreeRemove(args: { repoPath: string; worktreePath: string; force?: boolean }): Promise<void>;
  /**
   * Merge sha into the worktree.
   * Returns { ok: true, mergeSha } on success.
   * Returns { ok: false, conflictingPaths } on conflict or strategy failure.
   */
  mergeInWorktree(args: {
    worktreePath: string;
    sha: string;
    strategy: "merge_commit" | "fast_forward";
  }): Promise<{ ok: boolean; mergeSha?: string; conflictingPaths?: string[] }>;
  /**
   * Push sha to refs/heads/targetRef on remote with --force-with-lease
   * guarded by expectedBaseSha.  Never throws on non-zero git exit; returns
   * a structured failure with kind and scrubbed stderr instead.
   */
  pushForceWithLease(args: {
    repoPath: string;
    remote: string;
    sha: string;
    targetRef: string;
    expectedBaseSha: string;
  }): Promise<
    | { ok: true }
    | { ok: false; kind: "lease_broken" | "auth" | "network" | "other"; stderr: string }
  >;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve the temp merge worktree path under a run directory. */
export function resolveMergeWorktreePath(runDir: string): string {
  return `${runDir}/merge-wt`;
}

// ---------------------------------------------------------------------------
// runIntegrateMerge
// ---------------------------------------------------------------------------

/**
 * Core integration logic for `integrate.merge`.
 *
 * Algorithm (ARCHITECTURE.md lines 85-110):
 *   1. Fetch targetRef from remote → observedTargetRevision.
 *   2. If attemptRevision is ancestor of observed → already_integrated.
 *   3. If observed !== expectedBaseRevision → base_moved (nothing pushed).
 *   4. Create temp worktree at observed; merge attemptRevision with strategy.
 *   5. On conflict → conflict + conflictingPaths; worktree removed.
 *   6. Push mergeSha:refs/heads/targetRef --force-with-lease=...:expectedBaseRevision.
 *   7. On push failure → push_rejected; re-read remote ref → observedTargetRevision.
 *   8. On success → integrated + resultingRevision.
 *   Worktree is always removed in finally (errors during removal are swallowed).
 *
 * @param payload   Validated IntegrateMergePayload.
 * @param deps      Injected git operations.
 * @param runDir    Directory under which the temp merge worktree is created.
 */
export async function runIntegrateMerge(
  payload: IntegrateMergePayload,
  deps: IntegrateMergeDeps,
  runDir: string,
): Promise<IntegrateMergeOutput> {
  // Target refs may arrive as "main" or "refs/heads/main" (the coordinator
  // froze the long form for single-repo contracts; manifests use the short
  // form). Every helper below prefixes refs/heads/ itself, so normalize once.
  // Observed 2026-09-08: the long form produced a lease on
  // refs/heads/refs/heads/main and git rejected the push with "stale info".
  payload = { ...payload, targetRef: normalizeTargetRef(payload.targetRef) };

  const evidence: string[] = [];
  const mergeWtPath = resolveMergeWorktreePath(runDir);

  // Step 1 — fetch the remote ref.
  let observedTargetRevision: string;
  try {
    observedTargetRevision = await deps.fetchRef({
      repoPath: payload.repoPath,
      remote: payload.remote,
      ref: payload.targetRef,
    });
    evidence.push(
      `git fetch ${payload.remote} ${payload.targetRef}: exit 0, observed=${observedTargetRevision}`,
    );
  } catch (err) {
    const execError = err as { code?: number | string; stderr?: string };
    const code = execError.code ?? "?";
    const stderr = scrubCredentials(execError.stderr ?? "").slice(0, 500);
    evidence.push(
      `git fetch ${payload.remote} ${payload.targetRef}: exit ${code}, stderr: ${stderr}`,
    );
    throw err;
  }

  // Step 2 — check if the attempt is already integrated.
  const alreadyIntegrated = await deps.isAncestor({
    repoPath: payload.repoPath,
    ancestorRev: payload.attemptRevision,
    descendantRev: observedTargetRevision,
  });
  evidence.push(
    `git merge-base --is-ancestor ${payload.attemptRevision} ${observedTargetRevision}: ` +
      (alreadyIntegrated ? "exit 0 (ancestor)" : "exit 1 (not ancestor)"),
  );

  if (alreadyIntegrated) {
    return {
      outcome: "already_integrated",
      resultingRevision: observedTargetRevision,
      observedTargetRevision,
      evidence,
    };
  }

  // Step 3 — check if the base has moved.
  if (observedTargetRevision !== payload.expectedBaseRevision) {
    return {
      outcome: "base_moved",
      observedTargetRevision,
      evidence,
    };
  }

  // Step 4 — create a temp worktree at the observed revision and merge.
  await deps.worktreeAdd({
    repoPath: payload.repoPath,
    worktreePath: mergeWtPath,
    rev: observedTargetRevision,
  });
  evidence.push(`git worktree add ${mergeWtPath} ${observedTargetRevision}: exit 0`);

  try {
    const mergeResult = await deps.mergeInWorktree({
      worktreePath: mergeWtPath,
      sha: payload.attemptRevision,
      strategy: payload.strategy,
    });

    // Step 5 — conflict.
    if (!mergeResult.ok) {
      evidence.push(`git merge (${payload.strategy}) ${payload.attemptRevision}: conflict`);
      return {
        outcome: "conflict",
        observedTargetRevision,
        evidence,
        ...(mergeResult.conflictingPaths !== undefined
          ? { conflictingPaths: mergeResult.conflictingPaths }
          : {}),
      };
    }

    const mergeSha = mergeResult.mergeSha as string;
    evidence.push(
      `git merge (${payload.strategy}) ${payload.attemptRevision}: exit 0, sha=${mergeSha}`,
    );

    // Step 6 — push with force-with-lease.
    const pushResult = await deps.pushForceWithLease({
      repoPath: payload.repoPath,
      remote: payload.remote,
      sha: mergeSha,
      targetRef: payload.targetRef,
      expectedBaseSha: payload.expectedBaseRevision,
    });

    // Step 7 — push rejected; re-read the remote.
    if (!pushResult.ok) {
      evidence.push(
        `git push --force-with-lease ${payload.remote} ${payload.targetRef}: rejected (${pushResult.kind}) — ${pushResult.stderr}`,
      );
      let newObserved: string | null = null;
      try {
        newObserved = await deps.lsRemote({
          repoPath: payload.repoPath,
          remote: payload.remote,
          ref: payload.targetRef,
        });
        if (newObserved !== null) {
          evidence.push(`git ls-remote ${payload.remote} ${payload.targetRef}: ${newObserved}`);
        }
      } catch (lsErr) {
        const execError = lsErr as { code?: number | string; stderr?: string };
        const code = execError.code ?? "?";
        const stderr = scrubCredentials(execError.stderr ?? "").slice(0, 500);
        evidence.push(
          `git ls-remote ${payload.remote} ${payload.targetRef}: exit ${code}, stderr: ${stderr}`,
        );
      }
      return {
        outcome: "push_rejected",
        observedTargetRevision: newObserved ?? observedTargetRevision,
        evidence,
      };
    }

    // Step 8 — success.
    evidence.push(`git push --force-with-lease ${payload.remote} ${payload.targetRef}: exit 0`);
    return {
      outcome: "integrated",
      resultingRevision: mergeSha,
      observedTargetRevision,
      evidence,
    };
  } finally {
    // Always remove the temp worktree; errors are swallowed so they do not
    // mask the primary outcome.
    await deps
      .worktreeRemove({ repoPath: payload.repoPath, worktreePath: mergeWtPath, force: true })
      .catch(() => undefined);
  }
}

/** "refs/heads/main" and "main" both mean the branch main. */
export function normalizeTargetRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
