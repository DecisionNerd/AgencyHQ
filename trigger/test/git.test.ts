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
  pushForceWithLease,
  revertPaths,
  scrubCredentials,
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

// ---------------------------------------------------------------------------
// pushForceWithLease structured failure tests (S4-fix-push-evidence)
// ---------------------------------------------------------------------------

test("pushForceWithLease: returns kind=lease_broken when remote has advanced", async () => {
  const remotePath = await mkdtemp(join(tmpdir(), "agencyhq-push-remote-"));
  const initPath = await mkdtemp(join(tmpdir(), "agencyhq-push-init-"));
  let repoPath: string | undefined;
  let clone2: string | undefined;
  try {
    await git(["init", "--bare", "--initial-branch=main"], remotePath);
    await git(["init", "--initial-branch=main"], initPath);
    await writeFile(join(initPath, "README.md"), "base\n");
    await git(["add", "-A"], initPath);
    await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "base"], initPath);
    await git(["remote", "add", "origin", remotePath], initPath);
    await git(["push", "origin", "main"], initPath);
    const baseRev = (await git(["rev-parse", "HEAD"], initPath)).trim();

    // Clone as coordinator repo.
    repoPath = join(
      tmpdir(),
      `agencyhq-push-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await execFileAsync("git", ["clone", remotePath, repoPath], { cwd: tmpdir() });

    // Make a new commit to attempt to push.
    await writeFile(join(repoPath, "new.txt"), "new\n");
    await git(["add", "-A"], repoPath);
    await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "new"], repoPath);
    const newSha = (await git(["rev-parse", "HEAD"], repoPath)).trim();

    // Advance the remote via a second clone (breaks the lease).
    clone2 = join(
      tmpdir(),
      `agencyhq-push-clone2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await execFileAsync("git", ["clone", remotePath, clone2], { cwd: tmpdir() });
    await writeFile(join(clone2, "racing.txt"), "race\n");
    await git(["add", "-A"], clone2);
    await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "race"], clone2);
    await git(["push", "origin", "main"], clone2);

    const result = await pushForceWithLease({
      repoPath,
      remote: "origin",
      sha: newSha,
      targetRef: "main",
      expectedBaseSha: baseRev, // now stale
    });

    assert.equal(result.ok, false, "push must fail");
    if (!result.ok) {
      assert.equal(
        result.kind,
        "lease_broken",
        `expected lease_broken, got ${result.kind}: ${result.stderr}`,
      );
      assert.ok(typeof result.stderr === "string", "stderr must be a string");
    }
  } finally {
    await rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(initPath, { recursive: true, force: true }).catch(() => undefined);
    if (repoPath) await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
    if (clone2) await rm(clone2, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pushForceWithLease: returns kind=network for unreachable remote host", {
  timeout: 30000,
}, async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-push-net-"));
  try {
    await git(["init", "--initial-branch=main"], repoPath);
    await writeFile(join(repoPath, "README.md"), "base\n");
    await git(["add", "-A"], repoPath);
    await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "base"], repoPath);
    const sha = (await git(["rev-parse", "HEAD"], repoPath)).trim();

    const result = await pushForceWithLease({
      repoPath,
      remote: "https://nonexistent.invalid/x.git",
      sha,
      targetRef: "main",
      expectedBaseSha: sha,
    });

    assert.equal(result.ok, false, "push to unreachable host must fail");
    if (!result.ok) {
      assert.equal(
        result.kind,
        "network",
        `expected network, got ${result.kind}: ${result.stderr}`,
      );
      assert.ok(result.stderr.length > 0, "stderr must be non-empty");
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("scrubCredentials removes https://user:token@ credentials from stderr", () => {
  const raw =
    "fatal: unable to access 'https://myuser:supersecret@github.com/org/repo.git/': " +
    "The requested URL returned error: 403";
  const scrubbed = scrubCredentials(raw);
  assert.ok(!scrubbed.includes("supersecret"), "scrubbed output must not contain the token");
  assert.ok(!scrubbed.includes("myuser:"), "scrubbed output must not contain user:token pattern");
  assert.ok(scrubbed.includes("[REDACTED]"), "scrubbed output must include [REDACTED]");
  assert.ok(scrubbed.includes("github.com"), "scrubbed output must preserve the host");
});

test("scrubCredentials removes Authorization header values", () => {
  const raw = "Authorization: Bearer ghp_supersecrettoken123\nfatal: auth failed";
  const scrubbed = scrubCredentials(raw);
  assert.ok(
    !scrubbed.includes("ghp_supersecrettoken123"),
    "scrubbed output must not contain the token",
  );
  assert.ok(scrubbed.includes("[REDACTED]"), "scrubbed output must include [REDACTED]");
});
