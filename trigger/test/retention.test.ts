/**
 * Tests for the worktree retention policy and git effect.
 *
 * retention.test.ts covers:
 *   - Pure policy table: each rule that makes an attempt removable or kept.
 *   - Effect test: temp git repo with two worktrees; one with a reachable
 *     commit is removed, one without is skipped.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  type RemoveCandidate,
  type RetentionInput,
  removeRetained,
  retentionCandidates,
} from "../src/retention.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-01-01T12:00:00.000Z";
const KEEP_MS = 60_000; // 1 min

function makeAttempt(
  overrides: Partial<{
    id: string;
    status: string;
    worktreePath: string;
    attemptCommit: string | null;
    checkpointCommit: string | null;
    finalAt: string | null;
  }> = {},
) {
  return {
    id: "attempt-1",
    status: "completed",
    worktreePath: "/tmp/wt/attempt-1",
    attemptCommit: "abc1234",
    checkpointCommit: null,
    finalAt: "2026-01-01T11:00:00.000Z", // 1h before NOW
    ...overrides,
  };
}

function makeInput(attempts: ReturnType<typeof makeAttempt>[]): RetentionInput {
  return {
    attempts,
    now: NOW,
    keepFinalForMs: KEEP_MS,
    protectedAttemptIds: [],
  };
}

// ---------------------------------------------------------------------------
// Pure policy tests
// ---------------------------------------------------------------------------

test("removes completed attempt with reachable commit and old finalAt", () => {
  const result = retentionCandidates(makeInput([makeAttempt()]));
  assert.equal(result.remove.length, 1);
  assert.equal(result.remove[0]?.attemptId, "attempt-1");
  assert.equal(result.keep.length, 0);
});

test("keeps attempt with non-removable status (executing)", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "executing" })]));
  assert.equal(result.remove.length, 0);
  assert.equal(result.keep.length, 1);
  assert.ok(result.keep[0]?.reason.includes("executing"));
});

test("keeps attempt with status 'uncertain'", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "uncertain" })]));
  assert.equal(result.remove.length, 0);
  assert.equal(result.keep[0]?.reason.includes("uncertain"), true);
});

test("keeps attempt with status 'stopping'", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "stopping" })]));
  assert.equal(result.remove.length, 0);
  assert.equal(result.keep[0]?.reason.includes("stopping"), true);
});

test("keeps attempt in protectedAttemptIds even if otherwise removable", () => {
  const input: RetentionInput = {
    ...makeInput([makeAttempt({ id: "protected-1" })]),
    protectedAttemptIds: ["protected-1"],
  };
  const result = retentionCandidates(input);
  assert.equal(result.remove.length, 0);
  assert.equal(result.keep[0]?.reason, "protected");
});

test("keeps attempt whose finalAt is null", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ finalAt: null })]));
  assert.equal(result.remove.length, 0);
  assert.equal(result.keep[0]?.reason, "finalAt is null");
});

test("keeps attempt whose finalAt is within keepFinalForMs", () => {
  // 30 seconds before NOW — within KEEP_MS (60s)
  const result = retentionCandidates(
    makeInput([makeAttempt({ finalAt: "2026-01-01T11:59:30.000Z" })]),
  );
  assert.equal(result.remove.length, 0);
  assert.ok(result.keep[0]?.reason.includes("too recent"));
});

test("removes attempt exactly at keepFinalForMs boundary (60s ago)", () => {
  // Exactly 60s before NOW: nowMs - finalMs === keepFinalForMs is NOT < KEEP_MS → remove
  const result = retentionCandidates(
    makeInput([makeAttempt({ finalAt: "2026-01-01T11:59:00.000Z" })]),
  );
  assert.equal(result.remove.length, 1);
});

test("keeps attempt with no commit (attemptCommit and checkpointCommit both null)", () => {
  const result = retentionCandidates(
    makeInput([makeAttempt({ attemptCommit: null, checkpointCommit: null })]),
  );
  assert.equal(result.remove.length, 0);
  assert.equal(result.keep[0]?.reason, "no commit retained in repository");
});

test("removes attempt using checkpointCommit when attemptCommit is null", () => {
  const result = retentionCandidates(
    makeInput([makeAttempt({ attemptCommit: null, checkpointCommit: "chk5678" })]),
  );
  assert.equal(result.remove.length, 1);
  assert.equal(result.remove[0]?.commit, "chk5678");
});

test("removes 'quarantined' status attempt", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "quarantined" })]));
  assert.equal(result.remove.length, 1);
});

test("removes 'failed' status attempt", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "failed" })]));
  assert.equal(result.remove.length, 1);
});

test("removes 'stopped' status attempt", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "stopped" })]));
  assert.equal(result.remove.length, 1);
});

test("removes 'timed_out' status attempt", () => {
  const result = retentionCandidates(makeInput([makeAttempt({ status: "timed_out" })]));
  assert.equal(result.remove.length, 1);
});

test("handles mixed batch: one remove, two keep", () => {
  const result = retentionCandidates(
    makeInput([
      makeAttempt({ id: "a1" }),
      makeAttempt({ id: "a2", status: "uncertain" }),
      makeAttempt({ id: "a3", attemptCommit: null, checkpointCommit: null }),
    ]),
  );
  assert.equal(result.remove.length, 1);
  assert.equal(result.remove[0]?.attemptId, "a1");
  assert.equal(result.keep.length, 2);
  const keepIds = result.keep.map((k) => k.attemptId);
  assert.ok(keepIds.includes("a2"));
  assert.ok(keepIds.includes("a3"));
});

// ---------------------------------------------------------------------------
// Effect test: temp git repo with real worktrees
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function makeTestRepo(): Promise<{ repoPath: string; commitSha: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-retention-test-"));
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "hello\n");
  await git(["add", "-A"], repoPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"],
    repoPath,
  );
  const commitSha = (await git(["rev-parse", "HEAD"], repoPath)).trim();
  return { repoPath, commitSha };
}

test("removeRetained: removes committed worktree, skips uncommitted one", async () => {
  const { repoPath, commitSha } = await makeTestRepo();

  // Create two actual worktrees
  const wt1 = join(tmpdir(), `agencyhq-wt1-${Date.now()}`);
  const wt2 = join(tmpdir(), `agencyhq-wt2-${Date.now()}`);

  try {
    // Both worktrees start detached at the base commit
    await git(["worktree", "add", "--detach", wt1, commitSha], repoPath);
    await git(["worktree", "add", "--detach", wt2, commitSha], repoPath);

    // Candidate 1: reachable commit → should be removed
    const c1: RemoveCandidate = {
      attemptId: "a1",
      worktreePath: wt1,
      commit: commitSha,
      reason: "test",
    };

    // Candidate 2: non-existent commit → should be skipped
    const fakeCommit = "0000000000000000000000000000000000000000";
    const c2: RemoveCandidate = {
      attemptId: "a2",
      worktreePath: wt2,
      commit: fakeCommit,
      reason: "test",
    };

    const { removed, skipped } = await removeRetained(repoPath, [c1, c2]);

    assert.equal(removed.length, 1, "one worktree should be removed");
    assert.equal(removed[0]?.attemptId, "a1");

    assert.equal(skipped.length, 1, "one worktree should be skipped");
    assert.equal(skipped[0]?.attemptId, "a2");
    assert.ok(skipped[0]?.reason.includes("not reachable"));
  } finally {
    // Clean up wt2 (wt1 was removed by removeRetained)
    await git(["worktree", "remove", "--force", wt2], repoPath).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(wt1, { recursive: true, force: true }).catch(() => undefined);
    await rm(wt2, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("removeRetained: skips when worktreeRemove throws", async () => {
  // Use a fake dep to simulate a worktreeRemove failure
  const fakeDeps = {
    worktreeRemove: async (_args: unknown) => {
      throw new Error("worktree remove: not a git worktree");
    },
    refExists: async (_repoPath: string, _sha: string) => true,
  };

  const candidates: RemoveCandidate[] = [
    {
      attemptId: "failing-attempt",
      worktreePath: "/no/such/path",
      commit: "abc123",
      reason: "test",
    },
  ];

  const { removed, skipped } = await removeRetained("/fake/repo", candidates, fakeDeps);
  assert.equal(removed.length, 0);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0]?.reason.includes("worktree remove failed"));
});
