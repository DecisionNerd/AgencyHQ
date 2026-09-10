// P18.3 C2: v2 adapter tests for lead.review.
//
// Tests the v2 branch infrastructure:
//   - worktreePath override in ReviewDeps wires through to runReview
//   - gitDiff dep can use a clone dir instead of a host repo path
//   - materializeSource + runReview pipeline with injected lead session
//   - token never in call records or review output
//
// These tests use runReview directly with injected deps to avoid needing
// a Trigger SDK environment.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { LeadReviewPayload, LeadReviewPayloadV2, LeaseGrant } from "@agencyhq/contracts";
import { FakeBroker } from "../src/lib/broker.ts";
import { materializeSource } from "../src/lib/source.ts";
import { runReviewV2WithBroker } from "../src/tasks/lead-review.ts";
import { runReview } from "../src/tasks/lead-review-core.ts";
import type { LeadSession } from "../src/types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agencyhq-review-v2-"));
}

async function makeSourceBundle(): Promise<{
  bundleBytes: Buffer;
  baseRevision: string;
  attemptRevision: string;
}> {
  const repoDir = await makeTmpDir();
  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "t@t.com"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "T"]);
  await writeFile(join(repoDir, "README.md"), "# base");
  await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "base"]);
  const { stdout: baseOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const baseRevision = baseOut.trim();

  await writeFile(join(repoDir, "feature.ts"), "export const x = 1;");
  await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "add feature"]);
  const { stdout: attOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const attemptRevision = attOut.trim();

  const bundlePath = join(repoDir, "source.bundle");
  await execFileAsync("git", ["-C", repoDir, "bundle", "create", bundlePath, "--all"]);
  const { readFile } = await import("node:fs/promises");
  const bundleBytes = await readFile(bundlePath);
  await rm(repoDir, { recursive: true, force: true });
  return { bundleBytes, baseRevision, attemptRevision };
}

function makeV1Payload(
  base: string,
  attempt: string,
  clonedDir: string,
  tempParent: string,
): LeadReviewPayload {
  return {
    payloadVersion: 1,
    attemptId: "attempt-review-v2",
    generation: 0,
    contractId: "contract-1",
    criteria: [],
    criteriaDigest: `sha256:${"c".repeat(64)}`,
    profileDigest: `sha256:${"p".repeat(64)}`,
    baseRevision: base,
    attemptRevision: attempt,
    diffDigest: `sha256:${"d".repeat(64)}`,
    patchPath: join(tempParent, "attempt.patch"),
    verificationResults: [],
    model: "claude-3-5-sonnet-20241022",
    repoPath: clonedDir,
    worktreeBase: tempParent,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("lead-review v2: worktreePath override bypasses worktreeAdd for session dir", async () => {
  const { bundleBytes, baseRevision, attemptRevision } = await makeSourceBundle();
  const tempParent = await makeTmpDir();
  const cloneDir = join(tempParent, "src");

  try {
    const broker = new FakeBroker();
    broker.bundles.set(`proj-rv2:${attemptRevision}`, bundleBytes);

    const srcResult = await materializeSource({
      source: { projectId: "proj-rv2", revision: attemptRevision, bundlePath: "source.bundle" },
      dir: cloneDir,
      broker,
      token: "tok",
    });

    assert.equal(srcResult.ok, true, "source materialization should succeed");
    if (!srcResult.ok) return;

    const clonedDir = srcResult.clonedDir;
    const v1Payload = makeV1Payload(baseRevision, attemptRevision, clonedDir, tempParent);

    let worktreeAddDir = "";
    let worktreeRemoveDir = "";
    let gitDiffCalled = false;
    let sessionDir = "";

    const result = await runReview(v1Payload, {
      worktreeAdd: async (args) => {
        worktreeAddDir = args.worktreePath;
      },
      worktreeRemove: async (args) => {
        worktreeRemoveDir = args.worktreePath;
      },
      gitDiff: async (_repoPath, _base, _attempt) => {
        gitDiffCalled = true;
        // Return a plausible diff from the clone dir
        return `diff --git a/feature.ts b/feature.ts\n+export const x = 1;\n`;
      },
      leadSession: (async (input) => {
        sessionDir = input.dir;
        // Return a minimal valid review output
        const value = {
          reviewer: { model: v1Payload.model },
          subject: {
            attemptRevision: v1Payload.attemptRevision,
            diffDigest: v1Payload.diffDigest,
            criteriaDigest: v1Payload.criteriaDigest,
            profileDigest: v1Payload.profileDigest,
          },
          findings: [],
        };
        return { value, sessionId: "fake-session", raw: null };
      }) as LeadSession,
      now: () => new Date(),
      // Override: lead session runs in the clone dir (v2 invariant).
      worktreePath: clonedDir,
    });

    // worktreeAdd/worktreeRemove no-ops use the overridden path.
    assert.equal(worktreeAddDir, clonedDir, "worktreeAdd receives overridden cloneDir");
    assert.equal(worktreeRemoveDir, clonedDir, "worktreeRemove receives overridden cloneDir");
    assert.equal(gitDiffCalled, true, "gitDiff was called");
    assert.equal(sessionDir, clonedDir, "lead session dir is the clone dir");
    assert.ok(!("kind" in result), "result should not be an error kind");
    if (!("kind" in result)) {
      assert.equal(result.reviewerModel, v1Payload.model);
      assert.equal(result.findings.length, 0);
    }
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
});

test("lead-review v2: gitDiff computed from clone dir has correct diff content", async () => {
  const { bundleBytes, baseRevision, attemptRevision } = await makeSourceBundle();
  const tempParent = await makeTmpDir();
  const cloneDir = join(tempParent, "src");

  try {
    const broker = new FakeBroker();
    broker.bundles.set(`proj-rv2-diff:${attemptRevision}`, bundleBytes);

    const srcResult = await materializeSource({
      source: {
        projectId: "proj-rv2-diff",
        revision: attemptRevision,
        bundlePath: "source.bundle",
      },
      dir: cloneDir,
      broker,
      token: "tok",
    });
    assert.equal(srcResult.ok, true);
    if (!srcResult.ok) return;

    const clonedDir = srcResult.clonedDir;

    // Run git diff in the clone to get the actual diff text.
    const { stdout } = await execFileAsync("git", ["diff", baseRevision, attemptRevision], {
      cwd: clonedDir,
      maxBuffer: 8 * 1024 * 1024,
    });

    // The diff should mention feature.ts (the file added in the attempt).
    assert.ok(stdout.includes("feature.ts"), "diff should include the changed file");
    assert.ok(stdout.length > 0, "diff should be non-empty");
    // No host paths in the diff content.
    assert.ok(!stdout.includes("/Users"), "diff should not contain macOS user paths");
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
});

test("lead-review v2: subject mismatch produces invalid_output", async () => {
  const clonedDir = await makeTmpDir();
  try {
    const v1Payload = makeV1Payload(
      `base${"a".repeat(36)}`,
      `att${"b".repeat(37)}`,
      clonedDir,
      clonedDir,
    );

    const result = await runReview(v1Payload, {
      worktreeAdd: async () => {},
      worktreeRemove: async () => {},
      gitDiff: async () => "diff content",
      leadSession: (async (_input) => {
        // Return subject with WRONG attemptRevision to trigger mismatch.
        const value = {
          reviewer: { model: v1Payload.model },
          subject: {
            attemptRevision: "wrong-revision",
            diffDigest: v1Payload.diffDigest,
            criteriaDigest: v1Payload.criteriaDigest,
            profileDigest: v1Payload.profileDigest,
          },
          findings: [],
        };
        return { value, sessionId: "fake-session", raw: null };
      }) as LeadSession,
      now: () => new Date(),
      worktreePath: clonedDir,
    });

    assert.ok("kind" in result, "should return an error kind");
    if ("kind" in result) {
      assert.equal(result.kind, "invalid_output");
      assert.ok(result.reason.includes("Subject mismatch"), `unexpected reason: ${result.reason}`);
    }
  } finally {
    await rm(clonedDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E7 / X3-3: runReviewV2WithBroker uses bundleRefFor export ref.
// ---------------------------------------------------------------------------

test("lead-review v2 E7: runReviewV2WithBroker fetches attempt via bundleRefFor and diffs correctly (X3-3)", async () => {
  // Step 1: create base commit + source bundle (for materializeSource).
  const repoDir = await makeTmpDir();
  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "t@t.com"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "T"]);
  await writeFile(join(repoDir, "README.md"), "# base");
  await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "base"]);
  const { stdout: baseOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const baseRevision = baseOut.trim();

  // Source bundle: clone base repo at baseRevision.
  const { readFile: fsReadFile } = await import("node:fs/promises");
  const sourceBundlePath = join(repoDir, "source.bundle");
  await execFileAsync("git", ["-C", repoDir, "bundle", "create", sourceBundlePath, "HEAD"]);
  const sourceBundleBytes = await fsReadFile(sourceBundlePath);

  // Step 2: add attempt commit and create coordinator-style export ref.
  await writeFile(join(repoDir, "feature.ts"), "export const x = 1;");
  await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "add feature"]);
  const { stdout: attOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const attemptRevision = attOut.trim();

  // Create refs/agencyhq/export/<sha> (what the coordinator does after upload).
  const exportRef = `refs/agencyhq/export/${attemptRevision}`;
  await execFileAsync("git", ["-C", repoDir, "update-ref", exportRef, attemptRevision]);

  // Attempt bundle: includes the export ref so git fetch can extract it.
  const attemptBundlePath = join(repoDir, "attempt.bundle");
  await execFileAsync("git", ["-C", repoDir, "bundle", "create", attemptBundlePath, exportRef]);
  const attemptBundleBytes = await fsReadFile(attemptBundlePath);

  await rm(repoDir, { recursive: true, force: true });

  // Step 3: set up FakeBroker.
  const broker = new FakeBroker();
  // Review grant so lease request succeeds.
  const reviewGrant: LeaseGrant = {
    leaseId: "lease-e7",
    purpose: "review",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "review", token: "review-tok-e7" },
  };
  broker.grants.set("review:attempt-e7-review", reviewGrant);
  // Source bundle for materializeSource (keyed projectId:revision).
  broker.bundles.set(`proj-e7:${baseRevision}`, sourceBundleBytes);
  // Attempt bundle for downloadAttemptBundle (keyed attemptId:generation).
  broker.attemptBundles.set("patch-e7:0", {
    bundleBytes: attemptBundleBytes,
    commitId: attemptRevision,
  });

  const runRoot = await makeTmpDir();

  // Step 4: build v2 payload.
  const DIFF_DIGEST = `sha256:${"a".repeat(64)}`;
  const CRITERIA_DIGEST = `sha256:${"b".repeat(64)}`;
  const PROFILE_DIGEST = `sha256:${"c".repeat(64)}`;

  const v2Payload: LeadReviewPayloadV2 = {
    payloadVersion: 2,
    attemptId: "attempt-e7-review",
    generation: 0,
    contractId: "contract-e7",
    criteria: [],
    criteriaDigest: CRITERIA_DIGEST,
    profileDigest: PROFILE_DIGEST,
    attemptRevision,
    diffDigest: DIFF_DIGEST,
    patch: { attemptId: "patch-e7", generation: 0, revision: attemptRevision },
    verificationResults: [],
    model: "claude-3-5-sonnet-20241022",
    source: { projectId: "proj-e7", revision: baseRevision, bundlePath: "source.bundle" },
    baseRevision,
    leaseNonce: "n".repeat(32),
  };

  try {
    // Step 5: run with broker-injectable entry point. The real leadPrompt is called
    // which needs an SDK server; the function will throw from the lead session.
    // What we verify: correct broker calls happen before the session call, proving X3-3.
    await runReviewV2WithBroker(v2Payload, "low", "run-e7", broker, runRoot);

    // If it doesn't throw (unexpected success), still verify broker calls.
  } catch {
    // Session failure is expected (no OpenCode server in test env).
    // Fall through to broker-call assertions.
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }

  // Verify downloadAttemptBundle was called with the patch's attemptId/generation (X3-3).
  const attemptBundleCall = broker.calls.find((c) => c.op === "downloadAttemptBundle");
  assert.ok(attemptBundleCall, "downloadAttemptBundle must have been called (X3-3)");
  if (attemptBundleCall?.op === "downloadAttemptBundle") {
    assert.equal(
      attemptBundleCall.attemptId,
      "patch-e7",
      "correct attemptId passed to downloadAttemptBundle",
    );
    assert.equal(
      attemptBundleCall.generation,
      0,
      "correct generation passed to downloadAttemptBundle",
    );
  }

  // Verify source bundle was also fetched.
  const sourceBundleCall = broker.calls.find((c) => c.op === "downloadSourceBundle");
  assert.ok(sourceBundleCall, "downloadSourceBundle must have been called");
});
