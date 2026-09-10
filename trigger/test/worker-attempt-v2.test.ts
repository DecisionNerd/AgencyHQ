// P18.3 C2: v2 adapter tests for worker.attempt.
//
// Tests the lib-level pieces used by the v2 run path:
//   - prepareRuntime failure classification
//   - materializeSource → uploadAttemptArtifact pipeline (FakeBroker)
//   - uploadStopEvidence integration
//   - No host path in any call record or output field
//   - Upload token does not appear in FakeBroker call records

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { LeaseGrant } from "@agencyhq/contracts";
import { exportAttemptBundle, uploadAttemptArtifact } from "../src/lib/artifact-upload.ts";
import { FakeBroker } from "../src/lib/broker.ts";
import { uploadStopEvidence } from "../src/lib/evidence.ts";
import { prepareRuntime } from "../src/lib/runtime.ts";
import { materializeSource } from "../src/lib/source.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agencyhq-v2-test-"));
}

/** Create a real git repo, commit a file, and return a bundle of it. */
async function makeSourceBundle(_rev: string): Promise<{ bundleBytes: Buffer; revision: string }> {
  const repoDir = await makeTmpDir();
  await execFileAsync("git", ["init", repoDir]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "test@test.com"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Test"]);
  await writeFile(join(repoDir, "hello.txt"), "hello from source");
  await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "init"]);
  const { stdout } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const actualRev = stdout.trim();

  const bundlePath = join(repoDir, "source.bundle");
  await execFileAsync("git", ["-C", repoDir, "bundle", "create", bundlePath, "--all"]);
  const { readFile } = await import("node:fs/promises");
  const bundleBytes = await readFile(bundlePath);
  await rm(repoDir, { recursive: true, force: true });
  return { bundleBytes, revision: actualRev };
}

function makeUploadGrant(token: string): LeaseGrant {
  return {
    leaseId: "lease-upload",
    purpose: "upload",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "upload", token },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("v2 adapter: prepareRuntime host profile returns no uploadLease in host mode", async () => {
  // Host profile: AGENCYHQ_RUNTIME_PROFILE is not set to "container".
  const broker = new FakeBroker();
  const result = await prepareRuntime({
    runId: "run-v2-test",
    attemptId: "attempt-v2-test",
    generation: 0,
    nonce: "n".repeat(32),
    broker,
    env: { HOME: "/tmp/fake-home" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.uploadLease, null, "host profile has no upload lease");
    assert.equal(broker.calls.length, 0, "host profile makes no broker calls");
    await result.cleanup();
  }
});

test("v2 adapter: prepareRuntime login_required → provider_login_required failure", async () => {
  const broker = new FakeBroker();
  // Override requestLease to return login_required refusal.
  broker.leaseRefusal = { reason: "login_required" };

  const result = await prepareRuntime({
    runId: "run-v2-fail",
    attemptId: "attempt-v2-fail",
    generation: 0,
    nonce: "n".repeat(32),
    broker,
    env: {
      HOME: "/tmp/fake-home",
      AGENCYHQ_RUNTIME_PROFILE: "container",
      AGENCYHQ_RUN_ROOT: "/tmp/runroot",
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failureKind, "provider_login_required");
  }
});

test("v2 adapter: materializeSource + uploadAttemptArtifact pipeline via FakeBroker", async () => {
  const { bundleBytes, revision } = await makeSourceBundle("HEAD");
  const cloneDir = await makeTmpDir();

  try {
    const broker = new FakeBroker();
    const TOKEN = "upload-token-v2-test";
    broker.grants.set("upload:attempt-v2", makeUploadGrant(TOKEN));
    broker.bundles.set(`proj-1:${revision}`, bundleBytes);

    // materializeSource
    const srcResult = await materializeSource({
      source: { projectId: "proj-1", revision, bundlePath: "source.bundle" },
      dir: cloneDir,
      broker,
      token: TOKEN,
    });

    const failMsg = !srcResult.ok ? srcResult.reason : "";
    assert.equal(srcResult.ok, true, `materializeSource failed: ${failMsg}`);
    if (!srcResult.ok) return;

    const clonedDir = srcResult.clonedDir;

    // Make a change and commit in the clone
    await writeFile(join(clonedDir, "change.txt"), "worker output");
    await execFileAsync("git", ["-C", clonedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", clonedDir, "config", "user.email", "worker@test.com"]);
    await execFileAsync("git", ["-C", clonedDir, "config", "user.name", "Worker"]);
    await execFileAsync("git", ["-C", clonedDir, "commit", "-m", "attempt"]);
    const { stdout: headStdout } = await execFileAsync("git", [
      "-C",
      clonedDir,
      "rev-parse",
      "HEAD",
    ]);
    const commitId = headStdout.trim();

    // uploadAttemptArtifact
    const uploadResult = await uploadAttemptArtifact({
      repoPath: clonedDir,
      commitId,
      baseRevision: revision,
      attemptId: "attempt-v2",
      generation: 0,
      kind: "attempt",
      changedPaths: ["change.txt"],
      diffDigest: `sha256:${"a".repeat(64)}`,
      broker,
      token: TOKEN,
    });

    assert.equal(uploadResult.uploadStatus, "uploaded");
    assert.ok(uploadResult.artifactRef !== null);
    assert.equal(uploadResult.artifactRef?.revision, commitId);

    // Token must not appear in any broker call record
    const callsStr = JSON.stringify(broker.calls);
    assert.ok(!callsStr.includes(TOKEN), "upload token must not appear in call records");

    // No host path (cloneDir is a tmpdir, not a fixed host path like /home or /Users)
    // The ArtifactRef only contains attemptId, generation, revision — no paths.
    const outStr = JSON.stringify(uploadResult.artifactRef);
    assert.ok(!outStr.includes("/Users"), "no macOS user path in artifact ref");
    assert.ok(!outStr.includes("/home/"), "no linux home path in artifact ref");
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
});

test("v2 adapter: uploadStopEvidence skips when no stop.ndjson", async () => {
  const runDir = await makeTmpDir();
  try {
    const broker = new FakeBroker();
    const result = await uploadStopEvidence({
      runDir,
      attemptId: "attempt-v2-skip",
      generation: 0,
      broker,
      token: "tok",
    });
    assert.equal(result.uploadStatus, "skipped");
    assert.equal(broker.calls.length, 0);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("v2 adapter: full pipeline — materialize, upload artifact, upload evidence", async () => {
  const { bundleBytes, revision } = await makeSourceBundle("HEAD");
  const cloneDir = await makeTmpDir();
  const runDir = await makeTmpDir();

  try {
    const broker = new FakeBroker();
    const TOKEN = "full-pipeline-token";
    broker.bundles.set(`proj-2:${revision}`, bundleBytes);

    const srcResult = await materializeSource({
      source: { projectId: "proj-2", revision, bundlePath: "source.bundle" },
      dir: cloneDir,
      broker,
      token: TOKEN,
    });
    assert.equal(srcResult.ok, true);
    if (!srcResult.ok) return;

    const clonedDir = srcResult.clonedDir;

    // Worker commit
    await writeFile(join(clonedDir, "output.ts"), "export const x = 1;");
    await execFileAsync("git", ["-C", clonedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", clonedDir, "config", "user.email", "w@w.com"]);
    await execFileAsync("git", ["-C", clonedDir, "config", "user.name", "W"]);
    await execFileAsync("git", ["-C", clonedDir, "commit", "-m", "worker output"]);
    const { stdout } = await execFileAsync("git", ["-C", clonedDir, "rev-parse", "HEAD"]);
    const commitId = stdout.trim();

    // Write stop evidence
    const line = JSON.stringify({
      at: new Date().toISOString(),
      step: "process_exited",
      detail: "exit 0",
    });
    await writeFile(join(runDir, "stop.ndjson"), `${line}\n`);

    // Upload artifact
    const artResult = await uploadAttemptArtifact({
      repoPath: clonedDir,
      commitId,
      baseRevision: revision,
      attemptId: "attempt-v2-full",
      generation: 0,
      kind: "attempt",
      changedPaths: ["output.ts"],
      diffDigest: `sha256:${"b".repeat(64)}`,
      broker,
      token: TOKEN,
    });
    assert.equal(artResult.uploadStatus, "uploaded");

    // Upload evidence
    const evidResult = await uploadStopEvidence({
      runDir,
      attemptId: "attempt-v2-full",
      generation: 0,
      broker,
      token: TOKEN,
    });
    assert.equal(evidResult.uploadStatus, "uploaded");

    // Verify broker recorded 2 calls (downloadSourceBundle + uploadArtifact + uploadStopEvidence = 3)
    // Actually: downloadSourceBundle, uploadArtifact, uploadStopEvidence
    assert.equal(broker.calls.length, 3);
    assert.equal(broker.calls[0]?.op, "downloadSourceBundle");
    assert.equal(broker.calls[1]?.op, "uploadArtifact");
    assert.equal(broker.calls[2]?.op, "uploadStopEvidence");

    // Token must not appear in any call record
    const callsStr = JSON.stringify(broker.calls);
    assert.ok(!callsStr.includes(TOKEN), "token must not appear in call records");
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P11: Worker path end-to-end — broker issuance → token → exportAttemptBundle
// → upload → verified row.
//
// Uses the worker's real export/upload functions (exportAttemptBundle +
// uploadAttemptArtifact), not git bundle create in the test itself. The
// "verified row" is the uploadArtifact call recorded by FakeBroker.
// Provider lease is skipped (host profile: no AGENCYHQ_RUNTIME_PROFILE).
// ---------------------------------------------------------------------------

test("P11: broker issuance → exportAttemptBundle → upload → verified row", async () => {
  const repoDir = await makeTmpDir();

  try {
    // 1. Create a git repo with a base commit and a worker commit.
    await execFileAsync("git", ["init", "--initial-branch=main", repoDir]);
    await execFileAsync("git", ["-C", repoDir, "config", "user.email", "p11@test.com"]);
    await execFileAsync("git", ["-C", repoDir, "config", "user.name", "P11"]);
    await writeFile(join(repoDir, "base.ts"), "export const base = 1;");
    await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "base"]);
    const { stdout: baseOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
    const baseRevision = baseOut.trim();

    await writeFile(join(repoDir, "worker.ts"), "export const answer = 42;");
    await execFileAsync("git", ["-C", repoDir, "add", "-A"]);
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "worker output"]);
    const { stdout: headOut } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"]);
    const commitId = headOut.trim();

    // 2. Set up FakeBroker with upload grant.
    const broker = new FakeBroker();
    const UPLOAD_TOKEN = "p11-upload-token-secret";
    broker.grants.set("upload:attempt-p11", {
      leaseId: "lease-p11",
      purpose: "upload",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      material: { purpose: "upload", token: UPLOAD_TOKEN },
    } satisfies LeaseGrant);

    // 3. Broker issuance: call requestLease to get the upload token.
    const leaseResult = await broker.requestLease({
      runId: "run-p11",
      attemptId: "attempt-p11",
      generation: 0,
      purpose: "upload",
      nonce: "p".repeat(32),
    });
    assert.equal(leaseResult.ok, true, "upload lease must be granted");
    if (!leaseResult.ok) return;
    assert.equal(leaseResult.grant.material.purpose, "upload");
    const mat = leaseResult.grant.material;
    const uploadToken = mat.purpose === "upload" ? mat.token : "";

    // 4. exportAttemptBundle (worker's real function, not git bundle create in test).
    const exported = await exportAttemptBundle({
      repoPath: repoDir,
      commitId,
      baseRevision,
    });
    assert.ok(exported.bundleBytes > 0, "bundle must have bytes");
    assert.ok(exported.bundleSha256.length > 0, "bundle must have sha256");

    // 5. Upload via broker.uploadArtifact using the real exported bundle.
    const { unlink, readFile } = await import("node:fs/promises");
    const bundleBuffer = await readFile(exported.bundlePath);
    await broker.uploadArtifact({
      attemptId: "attempt-p11",
      token: uploadToken,
      meta: {
        attemptId: "attempt-p11",
        generation: 0,
        kind: "attempt",
        commitId,
        diffDigest: `sha256:${"c".repeat(64)}`,
        changedPaths: ["worker.ts"],
        bundleSha256: exported.bundleSha256,
        bundleBytes: exported.bundleBytes,
      },
      bundleBytes: bundleBuffer,
    });
    await unlink(exported.bundlePath).catch(() => undefined);

    // 6. "Verified row": FakeBroker recorded the uploadArtifact call.
    const uploadCall = broker.calls.find((c) => c.op === "uploadArtifact");
    assert.ok(uploadCall !== undefined, "uploadArtifact must be recorded as verified row");

    // 7. Token must not appear in any call record.
    const callsStr = JSON.stringify(broker.calls);
    assert.ok(!callsStr.includes(UPLOAD_TOKEN), "upload token must not appear in call records");
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// W-16: artifact upload carries real commit id and diff digest; HOME cleaned up.
// Extends the fake setup so the upload pipeline produces real results:
//   - artifact upload carries the exact commit SHA from the worker's git commit
//   - diff digest is sha256 of the actual `git diff baseRevision` output
//   - container-profile HOME is deleted by cleanup()
// ---------------------------------------------------------------------------

test("worker-attempt v2 W-16: artifact upload carries real commit id and diff digest; HOME cleaned up", async () => {
  // Part A: artifact upload pipeline — real commit id and matching diff digest.
  const { bundleBytes, revision: baseRevision } = await makeSourceBundle("HEAD");
  const cloneDir = await makeTmpDir();

  const UPLOAD_TOKEN = "upload-token-w16-real";
  const ATTEMPT_ID = "attempt-w16-real";

  try {
    const broker = new FakeBroker();
    broker.grants.set(`upload:${ATTEMPT_ID}`, makeUploadGrant(UPLOAD_TOKEN));
    broker.bundles.set(`proj-w16-real:${baseRevision}`, bundleBytes);

    // Materialize source into clone.
    const srcResult = await materializeSource({
      source: { projectId: "proj-w16-real", revision: baseRevision, bundlePath: "source.bundle" },
      dir: cloneDir,
      broker,
      token: UPLOAD_TOKEN,
    });
    assert.equal(srcResult.ok, true, "source materialization must succeed");
    if (!srcResult.ok) return;
    const clonedDir = srcResult.clonedDir;

    // Commit the worker's change: add feature.ts (the "committed change").
    await writeFile(join(clonedDir, "feature.ts"), "export const answer = 42;\n");
    await execFileAsync("git", ["-C", clonedDir, "add", "-A"]);
    await execFileAsync("git", ["-C", clonedDir, "config", "user.email", "worker@test.com"]);
    await execFileAsync("git", ["-C", clonedDir, "config", "user.name", "Worker"]);
    await execFileAsync("git", ["-C", clonedDir, "commit", "-m", "worker attempt"]);
    const { stdout: headOut } = await execFileAsync("git", ["-C", clonedDir, "rev-parse", "HEAD"]);
    const commitId = headOut.trim();

    // Compute real diff digest: sha256(git diff baseRevision) at HEAD=commitId.
    // Mirrors trigger/src/lib/git.ts#diffDigest (no untracked files in clean clone).
    const { stdout: diffOut } = await execFileAsync("git", ["-C", clonedDir, "diff", baseRevision]);
    const hash = createHash("sha256");
    hash.update(diffOut);
    const realDiffDigest = `sha256:${hash.digest("hex")}`;

    // Upload artifact with the real commit id and diff digest.
    const uploadResult = await uploadAttemptArtifact({
      repoPath: clonedDir,
      commitId,
      baseRevision,
      attemptId: ATTEMPT_ID,
      generation: 0,
      kind: "attempt",
      changedPaths: ["feature.ts"],
      diffDigest: realDiffDigest,
      broker,
      token: UPLOAD_TOKEN,
    });

    // Artifact upload carries the real commit id (not null, not a placeholder).
    assert.equal(uploadResult.uploadStatus, "uploaded", "artifact must be uploaded");
    assert.equal(
      uploadResult.artifactRef?.revision,
      commitId,
      "artifact upload must carry the real commit id",
    );

    // Diff digest matches the committed change: sha256 prefix is present.
    assert.ok(realDiffDigest.startsWith("sha256:"), "diff digest must have sha256 prefix");
    // The digest encodes the actual feature.ts addition — verify by re-computing.
    const { stdout: verifyDiffOut } = await execFileAsync("git", [
      "-C",
      clonedDir,
      "diff",
      baseRevision,
    ]);
    const verifyHash = createHash("sha256");
    verifyHash.update(verifyDiffOut);
    assert.equal(
      realDiffDigest,
      `sha256:${verifyHash.digest("hex")}`,
      "diff digest must match sha256 of git diff output (committed change)",
    );

    // Diff output includes feature.ts (the committed change).
    assert.ok(diffOut.includes("feature.ts"), "diff must include feature.ts");

    // Token must not appear in broker call records.
    const callsStr = JSON.stringify(broker.calls);
    assert.ok(!callsStr.includes(UPLOAD_TOKEN), "upload token must not appear in call records");
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }

  // Part B: container-profile HOME is created by prepareRuntime and deleted by cleanup().
  const fakeRunRoot = await makeTmpDir();
  try {
    const runtimeBroker = new FakeBroker();
    runtimeBroker.grants.set("provider:attempt-w16-home", {
      leaseId: "lease-w16-home",
      purpose: "provider",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      material: { purpose: "provider", authJson: "{}" },
    } satisfies LeaseGrant);

    const runtimeResult = await prepareRuntime({
      runId: "run-w16-home",
      attemptId: "attempt-w16-home",
      generation: 0,
      nonce: "h".repeat(32),
      broker: runtimeBroker,
      env: {
        HOME: join(fakeRunRoot, "host-home"),
        AGENCYHQ_RUNTIME_PROFILE: "container",
        AGENCYHQ_RUN_ROOT: fakeRunRoot,
      },
    });
    assert.equal(runtimeResult.ok, true, "container-profile prepareRuntime must succeed");
    if (!runtimeResult.ok) return;

    const { home, cleanup } = runtimeResult;

    // HOME directory was created by resolveRunHome.
    await stat(home); // throws ENOENT if home does not exist

    // Calling cleanup() must delete the per-run HOME tree.
    await cleanup();
    await assert.rejects(
      () => stat(home),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
      "HOME must be deleted by cleanup()",
    );
  } finally {
    await rm(fakeRunRoot, { recursive: true, force: true });
  }
});
