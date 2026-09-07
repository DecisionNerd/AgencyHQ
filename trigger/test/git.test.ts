import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  changedPaths,
  commitTree,
  diffDigest,
  revertPaths,
  updateRef,
  worktreeAdd,
  worktreeRemove,
} from "../src/lib/git.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function makeBaseRepo(): Promise<{ repoPath: string; baseRev: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-git-test-"));
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "hello\n");
  await git(["add", "-A"], repoPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"],
    repoPath,
  );
  const baseRev = (await git(["rev-parse", "HEAD"], repoPath)).trim();
  return { repoPath, baseRev };
}

test("worktreeAdd creates a worktree checked out at the given rev", async () => {
  const { repoPath, baseRev } = await makeBaseRepo();
  const worktreePath = join(tmpdir(), `agencyhq-wt-${Date.now()}`);
  try {
    await worktreeAdd({ repoPath, worktreePath, rev: baseRev });
    const headRev = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
    assert.equal(headRev, baseRev);
  } finally {
    await worktreeRemove({ repoPath, worktreePath, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("changedPaths includes untracked files", async () => {
  const { repoPath, baseRev } = await makeBaseRepo();
  const worktreePath = join(tmpdir(), `agencyhq-wt-${Date.now()}-changed`);
  try {
    await worktreeAdd({ repoPath, worktreePath, rev: baseRev });
    await writeFile(join(worktreePath, "README.md"), "hello\nmodified\n");
    await writeFile(join(worktreePath, "new-file.txt"), "new\n");
    const paths = await changedPaths({ worktreePath, baseRev });
    assert.deepEqual(paths, ["README.md", "new-file.txt"]);
  } finally {
    await worktreeRemove({ repoPath, worktreePath, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("commitTree commits staged changes and updateRef makes them visible", async () => {
  const { repoPath, baseRev } = await makeBaseRepo();
  const worktreePath = join(tmpdir(), `agencyhq-wt-${Date.now()}-commit`);
  try {
    await worktreeAdd({ repoPath, worktreePath, rev: baseRev });
    await writeFile(join(worktreePath, "output.txt"), "attempt output\n");
    const sha = await commitTree({ worktreePath, message: "attempt commit" });
    assert.ok(sha, "expected a commit sha");
    assert.notEqual(sha, baseRev);

    await updateRef({ repoPath, ref: "refs/heads/agencyhq/attempts/test-1", sha: sha as string });
    const resolved = (
      await git(["rev-parse", "refs/heads/agencyhq/attempts/test-1"], repoPath)
    ).trim();
    assert.equal(resolved, sha);
  } finally {
    await worktreeRemove({ repoPath, worktreePath, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("commitTree returns null when there is nothing to commit", async () => {
  const { repoPath, baseRev } = await makeBaseRepo();
  const worktreePath = join(tmpdir(), `agencyhq-wt-${Date.now()}-empty`);
  try {
    await worktreeAdd({ repoPath, worktreePath, rev: baseRev });
    const sha = await commitTree({ worktreePath, message: "no changes" });
    assert.equal(sha, null);
  } finally {
    await worktreeRemove({ repoPath, worktreePath, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("diffDigest is stable across calls and changes with content", async () => {
  const { repoPath, baseRev } = await makeBaseRepo();
  const worktreePath = join(tmpdir(), `agencyhq-wt-${Date.now()}-digest`);
  try {
    await worktreeAdd({ repoPath, worktreePath, rev: baseRev });
    await writeFile(join(worktreePath, "a.txt"), "one\n");

    const digest1 = await diffDigest({ worktreePath, baseRev });
    const digest2 = await diffDigest({ worktreePath, baseRev });
    assert.equal(digest1, digest2);

    await writeFile(join(worktreePath, "a.txt"), "two\n");
    const digest3 = await diffDigest({ worktreePath, baseRev });
    assert.notEqual(digest1, digest3);
  } finally {
    await worktreeRemove({ repoPath, worktreePath, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  }
});

test("revertPaths restores tracked files and deletes untracked ones", async () => {
  const { repoPath, baseRev } = await makeBaseRepo();
  const worktreePath = join(tmpdir(), `agencyhq-wt-${Date.now()}-revert`);
  try {
    await worktreeAdd({ repoPath, worktreePath, rev: baseRev });
    await writeFile(join(worktreePath, "README.md"), "modified\n");
    await writeFile(join(worktreePath, "secrets.txt"), "leaked\n");

    await revertPaths({
      worktreePath,
      paths: ["README.md", "secrets.txt"],
      baseRev,
    });

    const readmeContent = await readFile(join(worktreePath, "README.md"), "utf8");
    assert.equal(readmeContent, "hello\n");

    const secretsExists = await readFile(join(worktreePath, "secrets.txt"), "utf8").then(
      () => true,
      () => false,
    );
    assert.equal(secretsExists, false);
  } finally {
    await worktreeRemove({ repoPath, worktreePath, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreePath, { recursive: true, force: true });
  }
});
