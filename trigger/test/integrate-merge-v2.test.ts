// P18.3 C2: v2 adapter tests for integrate.merge.
//
// Tests the v2 integration path:
//   - integrate lease request via FakeBroker
//   - askpass script written to tempDir (mode 0700) and deleted in finally (P10)
//   - lease refusal → error
//   - token never appears in FakeBroker call records
//
// P10 uses runIntegrateMergeV2WithBroker (the exported entry point) with a
// FakeBroker and a local bare git remote. The test asserts the askpass file
// is gone after the function returns without the test deleting it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { IntegrateMergePayloadV2, LeaseGrant } from "@agencyhq/contracts";
import { FakeBroker } from "../src/lib/broker.ts";
import { runIntegrateMergeV2WithBroker } from "../src/tasks/integrate-merge.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agencyhq-integrate-v2-"));
}

function makeIntegrateGrant(askpassToken: string): LeaseGrant {
  return {
    leaseId: "lease-integrate",
    purpose: "integrate",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: {
      purpose: "integrate",
      remote: "https://github.com/example/repo.git",
      tokenRef: "ref-placeholder",
      askpassToken,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("integrate v2: FakeBroker records integrate lease request without token", async () => {
  const broker = new FakeBroker();
  const TOKEN = "integrate-secret-token";
  broker.grants.set("integrate:attempt-int-v2", makeIntegrateGrant(TOKEN));

  const result = await broker.requestLease({
    runId: "run-int-v2",
    attemptId: "attempt-int-v2",
    generation: 1,
    purpose: "integrate",
    nonce: "n".repeat(32),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.grant.material.purpose, "integrate");
  // Token must not appear in the recorded call
  const callsStr = JSON.stringify(broker.calls);
  assert.ok(!callsStr.includes(TOKEN), "token must not appear in call records");
  // Grant returns the token (in memory only, not logged)
  if (result.grant.material.purpose === "integrate") {
    assert.equal(result.grant.material.askpassToken, TOKEN);
  }
});

test("integrate v2: lease refusal → FakeBroker returns ok:false", async () => {
  const broker = new FakeBroker();
  broker.leaseRefusal = { reason: "login_required" };

  const result = await broker.requestLease({
    runId: "run-int-fail",
    attemptId: "attempt-int-fail",
    generation: 1,
    purpose: "integrate",
    nonce: "n".repeat(32),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.refusal.reason, "login_required");
    assert.equal(result.refusal.purpose, "integrate");
  }
});

test("integrate v2: askpass script format — token single-quoted correctly", async () => {
  const tempDir = await makeTmpDir();
  try {
    // Simulate what runIntegrateMergeV2 does: write the askpass script.
    const TOKEN = "ghp_abc123XYZ";
    const { writeFile, chmod } = await import("node:fs/promises");
    const askpassPath = join(tempDir, "git-askpass.sh");
    const safeToken = TOKEN.replace(/'/g, "'\\''");
    const script = `#!/bin/sh\ncase "$1" in\n  Password*) printf '%s\\n' '${safeToken}' ;;\n  *) printf '\\n' ;;\nesac\n`;

    await writeFile(askpassPath, script, { mode: 0o700, encoding: "utf8" });
    await chmod(askpassPath, 0o700);

    // Verify file exists and has correct mode (0700)
    const s = await stat(askpassPath);
    // On macOS/Linux, mode includes file type bits; mask with 0o777
    const mode = s.mode & 0o777;
    assert.equal(mode, 0o700, `expected mode 0700, got ${mode.toString(8)}`);

    // Verify script content has the token embedded (in the file only)
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(askpassPath, "utf8");
    assert.ok(content.includes(TOKEN), "askpass script must contain the token");
    assert.ok(content.startsWith("#!/bin/sh"), "askpass script must be a shell script");
    assert.ok(content.includes("Password*"), "askpass script must handle Password prompt");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("integrate v2: askpass token with single quote escapes correctly", async () => {
  const tempDir = await makeTmpDir();
  try {
    const TOKEN = "tok'with'quotes";
    const { writeFile } = await import("node:fs/promises");
    const askpassPath = join(tempDir, "git-askpass.sh");
    const safeToken = TOKEN.replace(/'/g, "'\\''");
    const script = `#!/bin/sh\ncase "$1" in\n  Password*) printf '%s\\n' '${safeToken}' ;;\n  *) printf '\\n' ;;\nesac\n`;

    await writeFile(askpassPath, script, { mode: 0o700, encoding: "utf8" });

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(askpassPath, "utf8");
    // The escaped form should include the escaped quotes
    assert.ok(content.includes("'\\''"), "single quotes should be escaped in askpass script");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("integrate v2: FakeBroker records integrate + upload lease calls without tokens", async () => {
  const broker = new FakeBroker();
  const INT_TOKEN = "integrate-tok";
  const UPL_TOKEN = "upload-tok";
  broker.grants.set("integrate:attempt-multi", makeIntegrateGrant(INT_TOKEN));
  broker.grants.set("upload:attempt-multi", {
    leaseId: "lease-upload",
    purpose: "upload",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "upload", token: UPL_TOKEN },
  });

  await broker.requestLease({
    runId: "run-multi",
    attemptId: "attempt-multi",
    generation: 1,
    purpose: "integrate",
    nonce: "n".repeat(32),
  });
  await broker.requestLease({
    runId: "run-multi",
    attemptId: "attempt-multi",
    generation: 1,
    purpose: "upload",
    nonce: "n".repeat(32),
  });

  assert.equal(broker.calls.length, 2);
  assert.equal(broker.calls[0]?.op, "requestLease");
  assert.equal(broker.calls[1]?.op, "requestLease");

  // Neither token must appear in call records
  const callsStr = JSON.stringify(broker.calls);
  assert.ok(!callsStr.includes(INT_TOKEN), "integrate token must not appear in calls");
  assert.ok(!callsStr.includes(UPL_TOKEN), "upload token must not appear in calls");
});

// ---------------------------------------------------------------------------
// P10: runIntegrateMergeV2WithBroker — askpass file written and removed.
//
// Calls the exported v2 entry point with a FakeBroker and a local bare
// remote. After the function returns the askpass file must be gone; the test
// does NOT delete it — the function's finally block must remove it.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function gitCmd(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("P10: runIntegrateMergeV2WithBroker — askpass removed by finally block", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-p10-runroot-"));
  const srcDir = await mkdtemp(join(tmpdir(), "agencyhq-p10-src-"));
  const remoteDir = await mkdtemp(join(tmpdir(), "agencyhq-p10-remote-"));

  try {
    // 1. Create source repo: base commit + attempt commit.
    await execFileAsync("git", ["init", "--initial-branch=main", srcDir]);
    await execFileAsync("git", ["-C", srcDir, "config", "user.email", "t@t.com"]);
    await execFileAsync("git", ["-C", srcDir, "config", "user.name", "T"]);
    await writeFile(join(srcDir, "base.txt"), "base");
    await execFileAsync("git", ["-C", srcDir, "add", "-A"]);
    await execFileAsync("git", ["-C", srcDir, "commit", "-m", "base"]);
    const baseRevision = await gitCmd(["rev-parse", "HEAD"], srcDir);

    await writeFile(join(srcDir, "attempt.txt"), "attempt");
    await execFileAsync("git", ["-C", srcDir, "add", "-A"]);
    await execFileAsync("git", ["-C", srcDir, "commit", "-m", "attempt"]);
    const attemptRevision = await gitCmd(["rev-parse", "HEAD"], srcDir);

    // 2. Create source bundle (contains both commits).
    const bundlePath = join(srcDir, "src.bundle");
    await execFileAsync("git", ["-C", srcDir, "bundle", "create", bundlePath, "--all"]);
    const bundleBytes = await readFile(bundlePath);

    // 3. Create bare remote initialized with base commit on main.
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remoteDir]);
    // Push base commit to bare remote's main branch.
    await execFileAsync("git", ["-C", srcDir, "remote", "add", "bare", remoteDir]);
    await execFileAsync("git", ["-C", srcDir, "push", "bare", `${baseRevision}:refs/heads/main`]);

    // 4. Set up FakeBroker with integrate grant and source bundle.
    const broker = new FakeBroker();
    const INTEGRATE_TOKEN = "p10-integrate-tok";
    const ATTEMPT_ID = "attempt-p10";
    // The source download authenticates with a review-purpose lease token (E7/E10).
    broker.grants.set(`review:${ATTEMPT_ID}`, {
      leaseId: "lease-review-p10",
      purpose: "review",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      material: { purpose: "review", token: "review-token-p10" },
    });
    broker.grants.set(`integrate:${ATTEMPT_ID}`, {
      leaseId: "lease-p10",
      purpose: "integrate",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      material: {
        purpose: "integrate",
        remote: remoteDir,
        tokenRef: "ref-p10",
        askpassToken: INTEGRATE_TOKEN,
      },
    } satisfies LeaseGrant);
    // FakeBroker serves source bundle keyed by "projectId:revision".
    broker.bundles.set(`proj-p10:${attemptRevision}`, bundleBytes);

    // 5. Build v2 payload.
    const payload: IntegrateMergePayloadV2 & { leaseNonce: string } = {
      payloadVersion: 2 as const,
      attemptId: ATTEMPT_ID,
      generation: 0,
      contractId: "ctr-p10",
      contractVersion: 1,
      projectId: "proj-p10",
      source: { projectId: "proj-p10", revision: attemptRevision, bundlePath: "src.bundle" },
      remote: remoteDir,
      targetRef: "main",
      expectedBaseRevision: baseRevision,
      attemptRevision,
      strategy: "fast_forward",
      integrateLease: { purpose: "integrate" },
      leaseNonce: "n".repeat(32),
    };

    // 6. Call the exported v2 entry point.
    const output = await runIntegrateMergeV2WithBroker(payload, "run-p10", broker, runRoot);

    // 7. Verify outcome (fast-forward push to local bare remote must succeed).
    assert.ok(
      output.outcome === "integrated" || output.outcome === "already_integrated",
      `expected integrated or already_integrated, got: ${output.outcome}`,
    );

    // 8. Askpass file must be gone — the function's finally block removed it.
    // Do NOT call rm() here; if the assertion passes the function cleaned it up.
    const tempDir = join(runRoot, "runs", `integrate-${ATTEMPT_ID}-run-p10`);
    const askpassPath = join(tempDir, "git-askpass.sh");
    await assert.rejects(
      () => access(askpassPath),
      "askpass file must be gone after runIntegrateMergeV2WithBroker returns",
    );

    // 9. Token must not appear in any broker call record.
    const callsStr = JSON.stringify(broker.calls);
    assert.ok(!callsStr.includes(INTEGRATE_TOKEN), "askpassToken must not appear in call records");
  } finally {
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(srcDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(remoteDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
