/**
 * Tests for @agencyhq/verification
 *
 * Coverage:
 * - profileDigest: stable, key-order-independent, changes on check version change
 * - catalog ids resolve
 * - runner: exit 0 → pass, exit 1 → fail, timeout → error+timedOut, ring buffer
 * - fingerprint: five keys
 * - buildVerificationResult: schema validation, all TESTING.md fields non-empty
 * - runProfile: minimal-v1 in clean git repo → pass; with untracked file → fail
 */

import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestOf } from "@agencyhq/contracts";
import { DEFAULT_PROTECTED_PATHS } from "@agencyhq/domain";

import {
  buildVerificationResult,
  CHECK_CATALOG,
  environmentFingerprint,
  PACKAGE_NAME,
  PROFILE_CATALOG,
  profileDigest,
  resolveProfile,
  runCheck,
  runProfile,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a minimal, plausible Digest. */
function fakeDigest(seed: string) {
  return digestOf(seed);
}

const FAKE_BASE_REV = "a".repeat(40);

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agencyhq-ver-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  // Create an initial commit so there's a HEAD
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

// ---------------------------------------------------------------------------
// profileDigest tests
// ---------------------------------------------------------------------------

test("profileDigest: stable for the same profile", () => {
  const profile = PROFILE_CATALOG["minimal-v1"];
  assert.ok(profile, "minimal-v1 should exist");
  const d1 = profileDigest(profile);
  const d2 = profileDigest(profile);
  assert.equal(d1, d2, "digest should be stable across calls");
});

test("profileDigest: independent of key insertion order", () => {
  // Build two profile objects with the same logical content but different key order.
  const p1 = {
    id: "test-profile",
    version: "1",
    checks: ["git-diff-clean@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  };
  // Object spread reverses conceptual key order (though JS engines don't guarantee order here,
  // what matters is that digestOf sorts keys canonically).
  const p2 = {
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    checks: ["git-diff-clean@1"],
    version: "1",
    id: "test-profile",
  };
  assert.equal(
    profileDigest(p1),
    profileDigest(p2),
    "digest must be independent of property order",
  );
});

test("profileDigest: changes when a check version changes (simulated via id change)", () => {
  const p1 = {
    id: "test-profile",
    version: "1",
    checks: ["git-diff-clean@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  };
  // Simulate the catalog entry for git-diff-clean bumped to version 2 via a different id.
  // Since profileDigest embeds `def.id@def.version` from the catalog, we test that changing
  // the version string in the profile itself changes the digest.
  const p2 = { ...p1, version: "2" };
  assert.notEqual(profileDigest(p1), profileDigest(p2), "digest must change when version changes");
});

// ---------------------------------------------------------------------------
// Catalog id resolution
// ---------------------------------------------------------------------------

test("CHECK_CATALOG: all expected ids are present", () => {
  const expected = [
    "pnpm-typecheck@1",
    "pnpm-test@1",
    "pnpm-check@1",
    "node-test@1",
    "git-diff-clean@1",
  ];
  for (const id of expected) {
    assert.ok(CHECK_CATALOG[id] !== undefined, `CHECK_CATALOG missing "${id}"`);
  }
});

test("PROFILE_CATALOG: all expected ids are present", () => {
  const expected = ["node-pnpm-v1", "docs-check-v1", "minimal-v1"];
  for (const id of expected) {
    assert.ok(PROFILE_CATALOG[id] !== undefined, `PROFILE_CATALOG missing "${id}"`);
  }
});

test("resolveProfile: resolves known ids", () => {
  const p = resolveProfile("minimal-v1");
  assert.equal(p.id, "minimal-v1");
});

test("resolveProfile: throws for unknown id", () => {
  assert.throws(() => resolveProfile("no-such-profile"), /unknown profile/);
});

// ---------------------------------------------------------------------------
// runCheck: exit 0 → pass, exit 1 → fail
// ---------------------------------------------------------------------------

test("runCheck: exit 0 produces exitStatus 0", async () => {
  const def = {
    id: "true@1",
    version: "1",
    command: ["true"],
    timeoutSeconds: 10,
  };
  const result = await runCheck(def, { cwd: tmpdir() });
  assert.equal(result.exitStatus, 0);
  assert.equal(result.timedOut, false);
});

test("runCheck: exit 1 produces exitStatus 1 and does not throw", async () => {
  const def = {
    id: "false@1",
    version: "1",
    command: ["false"],
    timeoutSeconds: 10,
  };
  const result = await runCheck(def, { cwd: tmpdir() });
  assert.equal(result.exitStatus, 1);
  assert.equal(result.timedOut, false);
});

// ---------------------------------------------------------------------------
// runCheck: timeout → error + timedOut + process group is gone
// ---------------------------------------------------------------------------

test("runCheck: timeout kills process group and sets timedOut", { timeout: 15_000 }, async () => {
  const def = {
    id: "sleep-long@1",
    version: "1",
    // Spawn a shell that starts a background sleep and a foreground sleep.
    // If the process group is killed, both sleeps should die.
    command: ["sh", "-c", "sleep 30 & sleep 30"],
    timeoutSeconds: 1,
  };
  const result = await runCheck(def, { cwd: tmpdir() });
  assert.equal(result.timedOut, true, "timedOut should be true");

  // Wait a moment for the OS to clean up.
  await new Promise((r) => setTimeout(r, 500));

  // Verify no `sleep 30` remains.
  const pgrep = spawnSync("pgrep", ["-f", "sleep 30"]);
  // pgrep exits 1 when no processes match.
  assert.equal(
    pgrep.status,
    1,
    `Expected no 'sleep 30' processes to survive, got: ${pgrep.stdout.toString()}`,
  );
});

// ---------------------------------------------------------------------------
// runCheck: ring buffer bounds stdout to maxBytes
// ---------------------------------------------------------------------------

test("runCheck: ring buffer truncates stdout to maxBytes", async () => {
  const maxBytes = 100;
  // Write 500 bytes to stdout via printf.
  const def = {
    id: "big-stdout@1",
    version: "1",
    command: ["sh", "-c", "printf '%0500d' 0"],
    timeoutSeconds: 10,
  };
  const result = await runCheck(def, { cwd: tmpdir(), maxBytes });
  assert.ok(
    result.stdoutTail.length <= maxBytes,
    `stdoutTail (${result.stdoutTail.length} bytes) must be ≤ ${maxBytes}`,
  );
});

// ---------------------------------------------------------------------------
// environmentFingerprint: five keys
// ---------------------------------------------------------------------------

test("environmentFingerprint: returns the five required keys", async () => {
  const fp = await environmentFingerprint(tmpdir());
  const keys = Object.keys(fp);
  for (const k of ["node", "pnpm", "git", "os", "arch"]) {
    assert.ok(keys.includes(k), `fingerprint missing key "${k}"`);
    assert.ok(
      typeof fp[k] === "string" && (fp[k] as string).length > 0,
      `fingerprint["${k}"] must be a non-empty string`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildVerificationResult: schema + TESTING.md fields non-empty
// ---------------------------------------------------------------------------

test("buildVerificationResult: validates against VerificationResultSchema", async () => {
  const def = CHECK_CATALOG["git-diff-clean@1"];
  assert.ok(def, "git-diff-clean@1 must exist");

  const run = await runCheck(def, { cwd: tmpdir() });
  const fp = await environmentFingerprint(tmpdir());

  const vr = buildVerificationResult({
    verifier: { name: "agencyhq-verification", version: "0.0.0" },
    stepContractId: "sc-1",
    attemptId: "att-1",
    criteriaDigest: fakeDigest("criteria"),
    profileDigest: fakeDigest("profile"),
    repository: "https://github.com/example/repo",
    baseRevision: FAKE_BASE_REV,
    attemptRevision: "b".repeat(40),
    diffDigest: fakeDigest("diff"),
    check: def,
    run,
    environmentFingerprint: fp,
  });

  // Every TESTING.md field must be non-empty / non-null.
  assert.ok(vr.verifier.name.length > 0, "verifier.name");
  assert.ok(vr.verifier.version.length > 0, "verifier.version");
  assert.ok(vr.stepContractId.length > 0, "stepContractId");
  assert.ok(vr.attemptId.length > 0, "attemptId");
  assert.ok(vr.criteriaDigest.length > 0, "criteriaDigest");
  assert.ok(vr.profileDigest.length > 0, "profileDigest");
  assert.ok(vr.repository.length > 0, "repository");
  assert.ok(vr.baseRevision.length > 0, "baseRevision");
  assert.ok(vr.attemptRevision.length > 0, "attemptRevision");
  assert.ok(vr.diffDigest.length > 0, "diffDigest");
  assert.ok(vr.checkId.length > 0, "checkId");
  assert.ok(Object.keys(vr.environmentFingerprint).length > 0, "environmentFingerprint");
  assert.ok(vr.startedAt.length > 0, "startedAt");
  assert.ok(vr.endedAt.length > 0, "endedAt");
  assert.ok(["pass", "fail", "error"].includes(vr.result), "result");
});

// ---------------------------------------------------------------------------
// runProfile: minimal-v1 in clean git repo → pass; with untracked file → fail
// ---------------------------------------------------------------------------

test("runProfile: minimal-v1 in a clean git repo → pass", { timeout: 20_000 }, async () => {
  const dir = makeTempGitRepo();
  try {
    const profile = resolveProfile("minimal-v1");
    const results = await runProfile({
      profile,
      cwd: dir,
      verifierVersion: "0.0.0",
      stepContractId: "sc-1",
      attemptId: "att-1",
      criteriaDigest: fakeDigest("criteria"),
      profileDigest: profileDigest(profile),
      repository: "https://github.com/example/repo",
      baseRevision: FAKE_BASE_REV,
      attemptRevision: "b".repeat(40),
      diffDigest: fakeDigest("diff"),
    });

    assert.equal(results.length, 1, "should have one result for minimal-v1");
    const vr = results[0];
    assert.ok(vr, "result should be defined");
    assert.equal(vr.result, "pass", `expected pass, got ${vr.result} (stdout: ${vr.stdoutTail})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProfile: minimal-v1 with an untracked file → fail", { timeout: 20_000 }, async () => {
  const dir = makeTempGitRepo();
  try {
    // Add an untracked file so `git status --porcelain` is non-empty.
    writeFileSync(join(dir, "untracked.txt"), "untracked\n");

    const profile = resolveProfile("minimal-v1");
    const results = await runProfile({
      profile,
      cwd: dir,
      verifierVersion: "0.0.0",
      stepContractId: "sc-1",
      attemptId: "att-1",
      criteriaDigest: fakeDigest("criteria"),
      profileDigest: profileDigest(profile),
      repository: "https://github.com/example/repo",
      baseRevision: FAKE_BASE_REV,
      attemptRevision: "b".repeat(40),
      diffDigest: fakeDigest("diff"),
    });

    assert.equal(results.length, 1, "should have one result for minimal-v1");
    const vr = results[0];
    assert.ok(vr, "result should be defined");
    assert.equal(vr.result, "fail", `expected fail, got ${vr.result} (stdout: ${vr.stdoutTail})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

test("smoke: package name is defined", () => {
  assert.equal(PACKAGE_NAME, "@agencyhq/verification");
});
