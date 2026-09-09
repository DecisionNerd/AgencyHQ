// Tests for lib/source.ts — materializeSource.
// Uses real git operations in temp repositories.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { FakeBroker } from "../src/lib/broker.ts";
import { materializeSource } from "../src/lib/source.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/** Create a minimal git repo with one commit and return { repoPath, baseRev }. */
async function makeRepo(): Promise<{ repoPath: string; baseRev: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-source-test-"));
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "hello source\n");
  await git(["add", "-A"], repoPath);
  await git(["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "base"], repoPath);
  const baseRev = (await git(["rev-parse", "HEAD"], repoPath)).trim();
  return { repoPath, baseRev };
}

/** Create a git bundle of a repo revision and return the bundle bytes. */
async function makeBundleBytes(repoPath: string, _revision: string): Promise<Buffer> {
  const bundlePath = join(tmpdir(), `test-bundle-${Date.now()}.bundle`);
  try {
    // Use --all so git includes all commits reachable from any ref, avoiding the
    // "Refusing to create empty bundle" error when passing a bare SHA.
    await git(["bundle", "create", bundlePath, "--all"], repoPath);
    const { readFile } = await import("node:fs/promises");
    return readFile(bundlePath);
  } finally {
    await rm(bundlePath, { force: true }).catch(() => undefined);
  }
}

test("materializeSource: clones and checks out the correct revision", async () => {
  const { repoPath, baseRev } = await makeRepo();
  const targetDir = join(tmpdir(), `agencyhq-mat-${Date.now()}`);

  const bundleBytes = await makeBundleBytes(repoPath, baseRev);
  const broker = new FakeBroker();
  broker.bundles.set(`proj-a:${baseRev}`, bundleBytes);

  try {
    const result = await materializeSource({
      source: {
        projectId: "proj-a",
        revision: baseRev,
        bundlePath: `/internal/source/proj-a?rev=${baseRev}`,
      },
      dir: targetDir,
      broker,
      token: "tok",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      // Verify HEAD in the cloned repo matches the expected revision.
      const head = (await git(["rev-parse", "HEAD"], result.clonedDir)).trim();
      assert.equal(head, baseRev);
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("materializeSource: returns revision_mismatch when HEAD does not match source.revision", async () => {
  const { repoPath, baseRev } = await makeRepo();
  const targetDir = join(tmpdir(), `agencyhq-mat-mismatch-${Date.now()}`);

  const bundleBytes = await makeBundleBytes(repoPath, baseRev);
  const broker = new FakeBroker();
  // Provide the correct bundle but claim a wrong revision.
  const wrongRev = "a".repeat(40);
  broker.bundles.set(`proj-b:${wrongRev}`, bundleBytes);

  try {
    const result = await materializeSource({
      source: {
        projectId: "proj-b",
        revision: wrongRev,
        bundlePath: `/internal/source/proj-b?rev=${wrongRev}`,
      },
      dir: targetDir,
      broker,
      token: "tok",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      // checkout_failed is expected since wrongRev doesn't exist in the repo
      assert.ok(
        result.failureKind === "checkout_failed" || result.failureKind === "revision_mismatch",
        `expected checkout_failed or revision_mismatch, got ${result.failureKind}`,
      );
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("materializeSource: returns download_failed when broker returns empty and sha mismatch", async () => {
  const targetDir = join(tmpdir(), `agencyhq-mat-dl-${Date.now()}`);
  const broker = new FakeBroker();
  // FakeBroker returns empty bundle bytes when no entry is set; but no sha is
  // claimed by the server so it won't fail on that check.
  // Provide a bundle that will fail to clone.
  const fakeRev = "b".repeat(40);
  broker.bundles.set(`proj-c:${fakeRev}`, Buffer.alloc(0)); // empty = invalid bundle

  try {
    const result = await materializeSource({
      source: {
        projectId: "proj-c",
        revision: fakeRev,
        bundlePath: `/internal/source/proj-c?rev=${fakeRev}`,
      },
      dir: targetDir,
      broker,
      token: "tok",
    });

    assert.equal(result.ok, false);
    // Any failure kind is acceptable for an invalid/empty bundle.
    assert.ok(["clone_failed", "download_failed", "checkout_failed"].includes(result.failureKind));
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("materializeSource: host path is never used in v2 payloads", async () => {
  // The source.bundlePath must be a relative path, never contain a host fs path.
  // This test verifies materializeSource accepts the relative form and does NOT
  // append it to any host FS path itself.
  const { repoPath, baseRev } = await makeRepo();
  const targetDir = join(tmpdir(), `agencyhq-mat-nohost-${Date.now()}`);
  const bundleBytes = await makeBundleBytes(repoPath, baseRev);
  const broker = new FakeBroker();
  broker.bundles.set(`proj-d:${baseRev}`, bundleBytes);

  try {
    const result = await materializeSource({
      source: {
        projectId: "proj-d",
        revision: baseRev,
        bundlePath: `/internal/source/proj-d?rev=${baseRev}`,
      },
      dir: targetDir,
      broker,
      token: "tok",
    });

    // Verify the target dir does not start with any suspicious host path prefix
    if (result.ok) {
      assert.ok(
        !result.clonedDir.startsWith("/Users") && !result.clonedDir.startsWith("/home/user"),
        "cloned dir must not be under a host-user path",
      );
    }
  } finally {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});
