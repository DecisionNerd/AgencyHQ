/**
 * Worktree retention policy.
 *
 * This module is pure policy (retentionCandidates) plus a thin git-effect
 * wrapper (removeRetained).  No @trigger.dev/sdk imports here.
 *
 * Design: docs/engineering/adrs/0007-worker-effect-model.md lines 56-63 and
 * docs/engineering/EXECUTION_MODEL.md lines 78-86.
 */

import { worktreeRemove } from "./lib/git.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetentionAttempt = {
  id: string;
  status: string;
  worktreePath: string;
  /** SHA of the final attempt commit on refs/heads/agencyhq/attempts/<id>, or null. */
  attemptCommit: string | null;
  /** SHA of the checkpoint commit on refs/heads/agencyhq/checkpoints/<id>, or null. */
  checkpointCommit: string | null;
  /** ISO-8601 timestamp when the attempt reached a final status, or null. */
  finalAt: string | null;
};

export type RetentionInput = {
  attempts: RetentionAttempt[];
  /** ISO-8601 current time. */
  now: string;
  /** How long (ms) after finalAt to retain a worktree before removing it. */
  keepFinalForMs: number;
  /** Attempt ids that must never be removed (active window, debugging). */
  protectedAttemptIds: string[];
};

export type RemoveCandidate = {
  attemptId: string;
  worktreePath: string;
  /** The commit SHA that should be reachable in the repo before removal. */
  commit: string;
  reason: string;
};

export type RetentionResult = {
  remove: RemoveCandidate[];
  keep: { attemptId: string; reason: string }[];
};

// Statuses that indicate an attempt has reached a final domain state
// (mirrors the "completed / quarantined / failed / stopped / timed_out"
// language in ADR-0007 which maps to these Trigger.dev-independent strings).
const REMOVABLE_STATUSES = new Set(["completed", "quarantined", "failed", "stopped", "timed_out"]);

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

/**
 * Compute which worktrees should be removed and which should be kept.
 *
 * Rules (all must hold for removal):
 * 1. status ∈ { completed, quarantined, failed, stopped, timed_out }
 * 2. finalAt is non-null and older than keepFinalForMs
 * 3. not in protectedAttemptIds
 * 4. (attemptCommit ?? checkpointCommit) is non-null — the commits are
 *    retained in the repository; a worktree with no commit is kept for inspection
 *
 * Statuses "uncertain" and "stopping" are never removed.
 */
export function retentionCandidates(input: RetentionInput): RetentionResult {
  const { attempts, now, keepFinalForMs, protectedAttemptIds } = input;
  const nowMs = new Date(now).getTime();
  const protectedSet = new Set(protectedAttemptIds);

  const remove: RemoveCandidate[] = [];
  const keep: { attemptId: string; reason: string }[] = [];

  for (const attempt of attempts) {
    const commit = attempt.attemptCommit ?? attempt.checkpointCommit;

    if (!REMOVABLE_STATUSES.has(attempt.status)) {
      keep.push({ attemptId: attempt.id, reason: `status "${attempt.status}" is not removable` });
      continue;
    }

    if (protectedSet.has(attempt.id)) {
      keep.push({ attemptId: attempt.id, reason: "protected" });
      continue;
    }

    if (attempt.finalAt === null) {
      keep.push({ attemptId: attempt.id, reason: "finalAt is null" });
      continue;
    }

    const finalMs = new Date(attempt.finalAt).getTime();
    if (nowMs - finalMs < keepFinalForMs) {
      keep.push({
        attemptId: attempt.id,
        reason: `finalAt too recent (${nowMs - finalMs}ms < ${keepFinalForMs}ms)`,
      });
      continue;
    }

    if (commit === null) {
      keep.push({ attemptId: attempt.id, reason: "no commit retained in repository" });
      continue;
    }

    remove.push({
      attemptId: attempt.id,
      worktreePath: attempt.worktreePath,
      commit,
      reason: `status="${attempt.status}" finalAt=${attempt.finalAt} commit=${commit}`,
    });
  }

  return { remove, keep };
}

// ---------------------------------------------------------------------------
// Git effect
// ---------------------------------------------------------------------------

type RefExistsFn = (repoPath: string, sha: string) => Promise<boolean>;
type WorktreeRemoveFn = typeof worktreeRemove;

export type RemoveRetainedDeps = {
  worktreeRemove: WorktreeRemoveFn;
  refExists: RefExistsFn;
};

export type RemoveRetainedResult = {
  removed: { attemptId: string; worktreePath: string }[];
  skipped: { attemptId: string; reason: string }[];
};

/**
 * For each candidate, verify the commit is reachable in the repo
 * (`git cat-file -e <sha>^{commit}`) before removing the worktree.
 *
 * A candidate whose commit is not (yet) reachable is skipped — the worktree
 * is kept for inspection, consistent with the retention policy invariant.
 *
 * @param repoPath  Path to the bare/main git repository.
 * @param candidates  List from retentionCandidates().remove.
 * @param deps  Injectable for testing: worktreeRemove and refExists.
 */
export async function removeRetained(
  repoPath: string,
  candidates: RemoveCandidate[],
  deps: RemoveRetainedDeps = {
    worktreeRemove,
    refExists: defaultRefExists,
  },
): Promise<RemoveRetainedResult> {
  const removed: { attemptId: string; worktreePath: string }[] = [];
  const skipped: { attemptId: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const reachable = await deps.refExists(repoPath, candidate.commit);
    if (!reachable) {
      skipped.push({
        attemptId: candidate.attemptId,
        reason: `commit ${candidate.commit} not reachable in ${repoPath}`,
      });
      continue;
    }

    try {
      await deps.worktreeRemove({ repoPath, worktreePath: candidate.worktreePath, force: true });
      removed.push({ attemptId: candidate.attemptId, worktreePath: candidate.worktreePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({
        attemptId: candidate.attemptId,
        reason: `worktree remove failed: ${message}`,
      });
    }
  }

  return { removed, skipped };
}

// ---------------------------------------------------------------------------
// Default refExists implementation
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Returns true if `sha^{commit}` is reachable in the git repository at
 * `repoPath` (i.e. `git cat-file -e <sha>^{commit}` exits 0).
 */
async function defaultRefExists(repoPath: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}
