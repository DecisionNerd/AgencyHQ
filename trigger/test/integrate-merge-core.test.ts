// Unit tests for integrate-merge-core.ts (R-015, R-010).
// Uses a bare git repo as the remote and a clone as the coordinator repo.
// All git operations go through the real git helpers from lib/git.ts.
// Tests 1–6 from the packet spec.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { IntegrateMergeOutputSchema } from "@agencyhq/contracts";
import {
  fetchRef as gitFetchRef,
  isAncestor as gitIsAncestor,
  lsRemote as gitLsRemote,
  mergeInWorktree as gitMergeInWorktree,
  pushForceWithLease as gitPushForceWithLease,
  worktreeAdd,
  worktreeRemove,
} from "../src/lib/git.ts";
import type { IntegrateMergeDeps } from "../src/tasks/integrate-merge-core.ts";
import { runIntegrateMerge } from "../src/tasks/integrate-merge-core.ts";
import type { IntegrateMergePayload } from "../src/types.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type IntegrateMergeFixture = {
  remotePath: string;
  repoPath: string;
  baseRevision: string;
  attemptRevision: string;
  targetRef: string;
  runDir: string;
  cleanup(): Promise<void>;
};

/**
 * Standard fixture:
 *   - Bare remote at remotePath
 *   - Coordinator clone at repoPath (remote "origin" → remotePath)
 *   - Base commit A on remote main
 *   - Attempt commit B in repoPath (based on A, adds src.ts)
 */
async function makeFixture(): Promise<IntegrateMergeFixture> {
  const remotePath = await mkdtemp(join(tmpdir(), "agencyhq-im-remote-"));
  const runDir = await mkdtemp(join(tmpdir(), "agencyhq-im-rundir-"));

  // Bare remote.
  await git(["init", "--bare", "--initial-branch=main"], remotePath);

  // Init repo: base commit, then push to remote.
  const initPath = await mkdtemp(join(tmpdir(), "agencyhq-im-init-"));
  await git(["init", "--initial-branch=main"], initPath);
  await writeFile(join(initPath, "README.md"), "base\n");
  await git(["add", "-A"], initPath);
  await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "base"], initPath);
  await git(["remote", "add", "origin", remotePath], initPath);
  await git(["push", "origin", "main"], initPath);
  const baseRevision = (await git(["rev-parse", "HEAD"], initPath)).trim();
  await rm(initPath, { recursive: true, force: true });

  // Clone as coordinator repo.
  const repoPath = join(
    tmpdir(),
    `agencyhq-im-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await execFileAsync("git", ["clone", remotePath, repoPath], { cwd: tmpdir() });

  // Attempt commit: add src.ts (based on base = A).
  await writeFile(join(repoPath, "src.ts"), "export const x = 1;\n");
  await git(["add", "-A"], repoPath);
  await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "attempt"], repoPath);
  const attemptRevision = (await git(["rev-parse", "HEAD"], repoPath)).trim();

  const cleanup = async () => {
    await rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return {
    remotePath,
    repoPath,
    baseRevision,
    attemptRevision,
    targetRef: "main",
    runDir,
    cleanup,
  };
}

/**
 * Conflict fixture:
 *   - Common ancestor X: file.txt = "original"
 *   - Remote main A: modifies file.txt → "main version" (expectedBaseRevision)
 *   - Attempt B: branched from X (not A), modifies file.txt → "attempt version"
 * Merging B into A produces a content conflict on file.txt.
 */
async function makeConflictFixture(): Promise<IntegrateMergeFixture> {
  const remotePath = await mkdtemp(join(tmpdir(), "agencyhq-im-remote-"));
  const runDir = await mkdtemp(join(tmpdir(), "agencyhq-im-rundir-"));

  await git(["init", "--bare", "--initial-branch=main"], remotePath);

  const initPath = await mkdtemp(join(tmpdir(), "agencyhq-im-init-"));
  await git(["init", "--initial-branch=main"], initPath);

  // Common ancestor X.
  await writeFile(join(initPath, "file.txt"), "original\n");
  await git(["add", "-A"], initPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "ancestor"],
    initPath,
  );
  const ancestorRev = (await git(["rev-parse", "HEAD"], initPath)).trim();

  // Commit A (main): changes file.txt → "main version".
  await writeFile(join(initPath, "file.txt"), "main version\n");
  await git(["add", "-A"], initPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "main change"],
    initPath,
  );
  await git(["remote", "add", "origin", remotePath], initPath);
  await git(["push", "origin", "main"], initPath);
  const baseRevision = (await git(["rev-parse", "HEAD"], initPath)).trim();
  await rm(initPath, { recursive: true, force: true });

  // Clone as coordinator repo.
  const repoPath = join(
    tmpdir(),
    `agencyhq-im-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await execFileAsync("git", ["clone", remotePath, repoPath], { cwd: tmpdir() });

  // Attempt B: detached from ancestor X, changes file.txt → "attempt version".
  await git(["checkout", "--detach", ancestorRev], repoPath);
  await writeFile(join(repoPath, "file.txt"), "attempt version\n");
  await git(["add", "-A"], repoPath);
  await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "attempt"], repoPath);
  const attemptRevision = (await git(["rev-parse", "HEAD"], repoPath)).trim();

  const cleanup = async () => {
    await rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return {
    remotePath,
    repoPath,
    baseRevision,
    attemptRevision,
    targetRef: "main",
    runDir,
    cleanup,
  };
}

/** Build a base payload from a fixture. */
function makePayload(
  fixture: IntegrateMergeFixture,
  overrides: Partial<IntegrateMergePayload> = {},
): IntegrateMergePayload {
  return {
    attemptId: "attempt-test-1",
    generation: 1,
    contractId: "contract-1",
    contractVersion: 1,
    projectId: "project-1",
    repoPath: fixture.repoPath,
    remote: "origin",
    targetRef: fixture.targetRef,
    expectedBaseRevision: fixture.baseRevision,
    attemptRevision: fixture.attemptRevision,
    strategy: "merge_commit",
    ...overrides,
  };
}

/** Build a real-deps object for a fixture. No env override (inherits process.env). */
function makeDeps(_fixture: IntegrateMergeFixture): IntegrateMergeDeps {
  return {
    fetchRef: (args) => gitFetchRef(args),
    lsRemote: (args) => gitLsRemote(args),
    isAncestor: (args) => gitIsAncestor(args),
    worktreeAdd,
    worktreeRemove,
    mergeInWorktree: (args) => gitMergeInWorktree(args),
    pushForceWithLease: (args) => gitPushForceWithLease(args),
  };
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: merge_commit → integrated
// ---------------------------------------------------------------------------

test("merge_commit happy path: integrated, remote advanced, merge commit has two parents", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture, { strategy: "merge_commit" });
    const deps = makeDeps(fixture);

    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "integrated");
    assert.ok(output.resultingRevision, "resultingRevision must be set");
    assert.equal(output.observedTargetRevision, fixture.baseRevision);
    assert.ok(output.evidence.length > 0, "evidence must not be empty");

    // Remote ref must point to the merge commit.
    const _remoteHead = (await git(["rev-parse", "FETCH_HEAD"], fixture.repoPath)).trim();
    // Refetch to get latest remote HEAD.
    await git(["fetch", "origin", "main"], fixture.repoPath);
    const remoteMain = (
      await git(["rev-parse", "refs/remotes/origin/main"], fixture.repoPath)
    ).trim();
    assert.equal(remoteMain, output.resultingRevision);

    // Merge commit must have exactly two parents (A and B).
    const parents = (
      await git(["log", "--pretty=%P", "-1", output.resultingRevision], fixture.repoPath)
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    assert.equal(parents.length, 2, "merge commit must have two parents");
    const parentSet = new Set(parents);
    assert.ok(parentSet.has(fixture.baseRevision), "one parent must be the base");
    assert.ok(parentSet.has(fixture.attemptRevision), "one parent must be the attempt");
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 2 — happy path: fast_forward → integrated
// ---------------------------------------------------------------------------

test("fast_forward happy path: integrated, remote advanced to attempt sha", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture, { strategy: "fast_forward" });
    const deps = makeDeps(fixture);

    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "integrated");
    assert.equal(output.resultingRevision, fixture.attemptRevision);
    assert.equal(output.observedTargetRevision, fixture.baseRevision);

    // Remote ref must now point to the attempt revision (FF = no merge commit).
    await git(["fetch", "origin", "main"], fixture.repoPath);
    const remoteMain = (
      await git(["rev-parse", "refs/remotes/origin/main"], fixture.repoPath)
    ).trim();
    assert.equal(remoteMain, fixture.attemptRevision);
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 3 — base moved
// ---------------------------------------------------------------------------

test("base_moved: remote advanced by a concurrent push before run", async () => {
  const fixture = await makeFixture();
  try {
    // Advance the remote from a second clone BEFORE running the core.
    const clone2 = join(
      tmpdir(),
      `agencyhq-im-clone2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await execFileAsync("git", ["clone", fixture.remotePath, clone2], { cwd: tmpdir() });
    await writeFile(join(clone2, "concurrent.txt"), "concurrent\n");
    await git(["add", "-A"], clone2);
    await git(
      ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "concurrent"],
      clone2,
    );
    await git(["push", "origin", "main"], clone2);
    const newRemoteSha = (await git(["rev-parse", "HEAD"], clone2)).trim();
    await rm(clone2, { recursive: true, force: true }).catch(() => undefined);

    const payload = makePayload(fixture);
    const deps = makeDeps(fixture);

    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "base_moved");
    assert.equal(output.observedTargetRevision, newRemoteSha);
    assert.equal(output.resultingRevision, undefined);
    assert.ok(output.evidence.some((e) => e.includes("observed=")));
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 4 — conflict
// ---------------------------------------------------------------------------

test("conflict: conflicting merge, path listed, worktree removed", async () => {
  const fixture = await makeConflictFixture();
  try {
    const payload = makePayload(fixture, { strategy: "merge_commit" });
    const deps = makeDeps(fixture);

    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "conflict");
    assert.ok(
      Array.isArray(output.conflictingPaths) && output.conflictingPaths.length > 0,
      "conflictingPaths must be non-empty",
    );
    assert.ok(
      output.conflictingPaths?.includes("file.txt"),
      `conflictingPaths must include file.txt, got ${JSON.stringify(output.conflictingPaths)}`,
    );
    assert.equal(output.resultingRevision, undefined);

    // Nothing was pushed: remote must still be at baseRevision.
    const remoteMain = await gitLsRemote({
      repoPath: fixture.repoPath,
      remote: "origin",
      ref: "main",
    });
    assert.equal(remoteMain, fixture.baseRevision, "remote must be unchanged after conflict");

    // Merge worktree must have been removed (runDir should not have merge-wt).
    const { stat } = await import("node:fs/promises");
    const wtExists = await stat(`${fixture.runDir}/merge-wt`)
      .then(() => true)
      .catch(() => false);
    assert.equal(wtExists, false, "merge worktree must be removed after conflict");
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 5 — already integrated (replay)
// ---------------------------------------------------------------------------

test("already_integrated: second run with same payload returns already_integrated", async () => {
  const fixture = await makeFixture();
  const runDir2 = await mkdtemp(join(tmpdir(), "agencyhq-im-rundir2-"));
  try {
    const payload = makePayload(fixture, { strategy: "merge_commit" });
    const deps = makeDeps(fixture);

    // First run: integrate.
    const first = await runIntegrateMerge(payload, deps, fixture.runDir);
    assert.equal(first.outcome, "integrated");

    // Second run with same payload.
    const second = await runIntegrateMerge(payload, deps, runDir2);
    assert.equal(second.outcome, "already_integrated");
    // resultingRevision should equal the merge sha (remote main now).
    assert.equal(second.resultingRevision, first.resultingRevision);
    // Remote unchanged.
    const remoteMain = await gitLsRemote({
      repoPath: fixture.repoPath,
      remote: "origin",
      ref: "main",
    });
    assert.equal(remoteMain, first.resultingRevision);
  } finally {
    await fixture.cleanup();
    await rm(runDir2, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Test 6 — push_rejected (lease broken by concurrent push)
// ---------------------------------------------------------------------------

test("push_rejected: remote advances between fetch and push, observedTargetRevision updated", async () => {
  const fixture = await makeFixture();
  // A second clone to advance the remote after fetchRef is called.
  const clone2 = join(
    tmpdir(),
    `agencyhq-im-clone2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await execFileAsync("git", ["clone", fixture.remotePath, clone2], { cwd: tmpdir() });
  await writeFile(join(clone2, "racing.txt"), "race\n");
  await git(["add", "-A"], clone2);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "racing commit"],
    clone2,
  );
  const racingSha = (await git(["rev-parse", "HEAD"], clone2)).trim();

  try {
    const realDeps = makeDeps(fixture);

    // Inject: after fetchRef returns the original sha, push from clone2 to the
    // remote so the lease will be broken when we try to push our merge sha.
    const deps: IntegrateMergeDeps = {
      ...realDeps,
      fetchRef: async (args) => {
        const sha = await realDeps.fetchRef(args);
        // Advance the remote (breaks our force-with-lease).
        await git(["push", "origin", "main"], clone2);
        // Return the original sha so the core believes expected === observed.
        return sha;
      },
    };

    const payload = makePayload(fixture, { strategy: "merge_commit" });
    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "push_rejected");
    // observedTargetRevision must equal the racing commit (re-read after rejection).
    assert.equal(
      output.observedTargetRevision,
      racingSha,
      "observedTargetRevision must equal the new remote sha after rejection",
    );
    // The remote must be at racingSha, NOT at our merge sha.
    const remoteMain = await gitLsRemote({
      repoPath: fixture.repoPath,
      remote: "origin",
      ref: "main",
    });
    assert.equal(remoteMain, racingSha, "remote must be at the racing commit, not our merge sha");
  } finally {
    await fixture.cleanup();
    await rm(clone2, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Packet 4.2.c: IntegrateMergeOutputSchema conformance — each outcome parses
// ---------------------------------------------------------------------------

// IM-7: integrated outcome parses with IntegrateMergeOutputSchema
test("IntegrateMergeOutputSchema: integrated outcome parses", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture);
    const deps = makeDeps(fixture);
    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "integrated", "expected integrated outcome");
    const parsed = IntegrateMergeOutputSchema.safeParse(output);
    assert.equal(
      parsed.success,
      true,
      `IntegrateMergeOutputSchema failed for integrated: ${JSON.stringify(parsed)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

// IM-8: already_integrated outcome parses with IntegrateMergeOutputSchema
test("IntegrateMergeOutputSchema: already_integrated outcome parses", async () => {
  const fixture = await makeFixture();
  try {
    const deps = makeDeps(fixture);
    // First integration succeeds.
    await runIntegrateMerge(makePayload(fixture), deps, fixture.runDir);
    // Second integration with same attemptRevision is idempotent: already_integrated.
    const runDir2 = await mkdtemp(join(tmpdir(), "agencyhq-im-rundir2-"));
    try {
      const output = await runIntegrateMerge(makePayload(fixture), deps, runDir2);
      assert.equal(output.outcome, "already_integrated", "expected already_integrated outcome");
      const parsed = IntegrateMergeOutputSchema.safeParse(output);
      assert.equal(
        parsed.success,
        true,
        `IntegrateMergeOutputSchema failed for already_integrated: ${JSON.stringify(parsed)}`,
      );
    } finally {
      await rm(runDir2, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await fixture.cleanup();
  }
});

// IM-9: base_moved outcome parses with IntegrateMergeOutputSchema
test("IntegrateMergeOutputSchema: base_moved outcome parses", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture, {
      expectedBaseRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const deps = makeDeps(fixture);
    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "base_moved", "expected base_moved outcome");
    const parsed = IntegrateMergeOutputSchema.safeParse(output);
    assert.equal(
      parsed.success,
      true,
      `IntegrateMergeOutputSchema failed for base_moved: ${JSON.stringify(parsed)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

// IM-10: conflict outcome parses with IntegrateMergeOutputSchema
test("IntegrateMergeOutputSchema: conflict outcome parses", async () => {
  const fixture = await makeConflictFixture();
  try {
    const payload = makePayload(fixture, { strategy: "merge_commit" });
    const deps = makeDeps(fixture);
    const output = await runIntegrateMerge(payload, deps, fixture.runDir);

    assert.equal(output.outcome, "conflict", "expected conflict outcome");
    const parsed = IntegrateMergeOutputSchema.safeParse(output);
    assert.equal(
      parsed.success,
      true,
      `IntegrateMergeOutputSchema failed for conflict: ${JSON.stringify(parsed)}`,
    );
  } finally {
    await fixture.cleanup();
  }
});
