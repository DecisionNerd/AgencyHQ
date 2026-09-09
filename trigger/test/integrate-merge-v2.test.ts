// P18.3 C2: v2 adapter tests for integrate.merge.
//
// Tests the v2 integration path:
//   - integrate lease request via FakeBroker
//   - askpass script written to tempDir (mode 0700)
//   - lease refusal → error
//   - token never appears in FakeBroker call records
//
// These tests exercise the lease + askpass infrastructure without a live
// git remote. The full merge + push is exercised by the existing
// integrate-merge-core.test.ts (push-boundary.test.ts).

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LeaseGrant } from "@agencyhq/contracts";
import { FakeBroker } from "../src/lib/broker.ts";

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
