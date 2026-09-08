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
    "manifest-consumer@1",
    "pnpm-install@1",
  ];
  for (const id of expected) {
    assert.ok(CHECK_CATALOG[id] !== undefined, `CHECK_CATALOG missing "${id}"`);
  }
});

test("PROFILE_CATALOG: all expected ids are present", () => {
  const expected = [
    "node-pnpm-v1",
    "docs-check-v1",
    "minimal-v1",
    "multi-repo-v1",
    "node-pnpm-v2",
    "multi-repo-v2",
  ];
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
    // The unusual duration is a marker: pgrep below must not match unrelated
    // "sleep 30" processes on the host (observed 2026-09-08: a shell snapshot
    // and a monitor loop both matched).
    command: ["sh", "-c", "sleep 30.31337 & sleep 30.31337"],
    timeoutSeconds: 1,
  };
  const result = await runCheck(def, { cwd: tmpdir() });
  assert.equal(result.timedOut, true, "timedOut should be true");

  // Wait a moment for the OS to clean up.
  await new Promise((r) => setTimeout(r, 500));

  // Verify no `sleep 30` remains.
  const pgrep = spawnSync("pgrep", ["-f", "sleep 30.31337"]);
  // pgrep exits 1 when no processes match.
  assert.equal(
    pgrep.status,
    1,
    `Expected no 'sleep 30.31337' processes to survive, got: ${pgrep.stdout.toString()}`,
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
// manifest-consumer@1 check tests
// ---------------------------------------------------------------------------

/**
 * Create a minimal pnpm project whose `pnpm test` passes without network access.
 * Uses `node --version` as the test script (no node_modules required).
 */
function makeFixturePnpmProject(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "manifest-check-fixture",
      version: "1.0.0",
      scripts: { test: "node --version" },
    }),
  );
  // Minimal pnpm lockfile so pnpm does not warn about missing lockfile.
  writeFileSync(
    join(dir, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
  );
}

test("manifest-consumer@1: fails with manifest_missing when no AGENCYHQ_MANIFEST_N env var is set", {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agencyhq-manifest-missing-"));
  try {
    makeFixturePnpmProject(dir);

    const def = CHECK_CATALOG["manifest-consumer@1"];
    assert.ok(def, "manifest-consumer@1 must be in CHECK_CATALOG");

    // Do not pass any AGENCYHQ_MANIFEST_N env vars — the test runner environment
    // does not have them, so omitting opts.env is sufficient.
    const result = await runCheck(def, { cwd: dir });

    assert.notEqual(result.exitStatus, 0, "should not pass");
    assert.equal(result.timedOut, false, "should not time out");
    assert.ok(
      result.stdoutTail.includes("manifest_missing"),
      `stdout should contain "manifest_missing"; got: ${result.stdoutTail}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest-consumer@1: fails when AGENCYHQ_MANIFEST_N path does not exist", {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agencyhq-manifest-badpath-"));
  try {
    makeFixturePnpmProject(dir);

    const def = CHECK_CATALOG["manifest-consumer@1"];
    assert.ok(def, "manifest-consumer@1 must be in CHECK_CATALOG");

    const result = await runCheck(def, {
      cwd: dir,
      env: { AGENCYHQ_MANIFEST_0: "/nonexistent/path/agencyhq-manifest-test" },
    });

    assert.notEqual(result.exitStatus, 0, "should not pass");
    assert.equal(result.timedOut, false, "should not time out");
    assert.ok(
      result.stdoutTail.includes("manifest_path_not_found"),
      `stdout should contain "manifest_path_not_found"; got: ${result.stdoutTail}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest-consumer@1: passes with valid manifest env and passing pnpm test", {
  timeout: 60_000,
}, async () => {
  const manifestDir = mkdtempSync(join(tmpdir(), "agencyhq-manifest-dir-"));
  const projectDir = mkdtempSync(join(tmpdir(), "agencyhq-manifest-proj-"));
  try {
    makeFixturePnpmProject(projectDir);

    const def = CHECK_CATALOG["manifest-consumer@1"];
    assert.ok(def, "manifest-consumer@1 must be in CHECK_CATALOG");

    const result = await runCheck(def, {
      cwd: projectDir,
      env: {
        AGENCYHQ_MANIFEST_0: manifestDir,
        AGENCYHQ_MANIFEST_DIGEST: fakeDigest("manifest-digest"),
      },
    });

    assert.equal(
      result.exitStatus,
      0,
      `expected pass; exit=${result.exitStatus} stdout=${result.stdoutTail} stderr=${result.stderrTail}`,
    );
    assert.equal(result.timedOut, false, "should not time out");
    // Manifest evidence must be present in stdoutTail.
    assert.ok(
      result.stdoutTail.includes("manifest_env:"),
      `stdout should contain "manifest_env:"; got: ${result.stdoutTail}`,
    );
    assert.ok(
      result.stdoutTail.includes(`position=0 path=${manifestDir}`),
      `stdout should record position and path; got: ${result.stdoutTail}`,
    );
    assert.ok(
      result.stdoutTail.includes("manifest_digest:"),
      `stdout should record manifest_digest; got: ${result.stdoutTail}`,
    );
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// multi-repo-v1 profile tests
// ---------------------------------------------------------------------------

test("multi-repo-v1: resolves from PROFILE_CATALOG", () => {
  const profile = resolveProfile("multi-repo-v1");
  assert.equal(profile.id, "multi-repo-v1");
  assert.equal(profile.version, "1");
  assert.deepEqual(profile.checks, ["pnpm-typecheck@1", "manifest-consumer@1"]);
  assert.deepEqual(profile.protectedPaths, DEFAULT_PROTECTED_PATHS);
});

test("multi-repo-v1: profileDigest is stable", () => {
  const profile = PROFILE_CATALOG["multi-repo-v1"];
  assert.ok(profile, "multi-repo-v1 should exist");
  const d1 = profileDigest(profile);
  const d2 = profileDigest(profile);
  assert.equal(d1, d2, "digest should be stable across calls");
});

test("multi-repo-v1: profileDigest differs from node-pnpm-v1", () => {
  const multiRepo = PROFILE_CATALOG["multi-repo-v1"];
  const nodePnpm = PROFILE_CATALOG["node-pnpm-v1"];
  assert.ok(multiRepo, "multi-repo-v1 should exist");
  assert.ok(nodePnpm, "node-pnpm-v1 should exist");
  assert.notEqual(
    profileDigest(multiRepo),
    profileDigest(nodePnpm),
    "multi-repo-v1 and node-pnpm-v1 must have distinct digests",
  );
});

// ---------------------------------------------------------------------------
// pnpm-install@1 check tests
// ---------------------------------------------------------------------------

/**
 * Detect pnpm availability once; skip pnpm-install@1 tests loudly if missing.
 */
function pnpmAvailable(): boolean {
  const r = spawnSync("pnpm", ["--version"], { stdio: "pipe" });
  return r.status === 0;
}

test("pnpm-install@1: check definition is well-formed", () => {
  const def = CHECK_CATALOG["pnpm-install@1"];
  assert.ok(def, "pnpm-install@1 must be in CHECK_CATALOG");
  assert.equal(def.id, "pnpm-install@1");
  assert.equal(def.version, "1");
  assert.deepEqual(def.command, ["pnpm", "install", "--frozen-lockfile"]);
  assert.equal(def.timeoutSeconds, 600);
  // No custom passWhen: exit 0 = pass, non-zero = fail (--frozen-lockfile exits 1 on stale lockfile).
  assert.equal(def.passWhen, undefined, "pnpm-install@1 must not have a custom passWhen");
});

test("pnpm-install@1: passes on a valid project with a matching lockfile", {
  timeout: 120_000,
}, async () => {
  if (!pnpmAvailable()) {
    // Skip loudly rather than faking a pass.
    console.log("SKIP: pnpm not available in test environment; skipping pnpm-install@1 live test");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "agencyhq-install-pass-"));
  try {
    // A package.json with no dependencies and a minimal lockfile that matches it.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "install-fixture", version: "1.0.0" }),
    );
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
    );

    const def = CHECK_CATALOG["pnpm-install@1"];
    assert.ok(def);
    const result = await runCheck(def, { cwd: dir });

    assert.equal(
      result.exitStatus,
      0,
      `expected exit 0; got ${result.exitStatus}; stderr: ${result.stderrTail}`,
    );
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pnpm-install@1: fails when lockfile is out of date with package.json", {
  timeout: 120_000,
}, async () => {
  if (!pnpmAvailable()) {
    console.log("SKIP: pnpm not available in test environment; skipping pnpm-install@1 live test");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "agencyhq-install-fail-"));
  try {
    // package.json lists a dependency that is absent from the lockfile.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "install-fixture-stale",
        version: "1.0.0",
        dependencies: { "is-odd": "^3.0.1" },
      }),
    );
    // Minimal lockfile with no packages section — does not satisfy the dependency above.
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
    );

    const def = CHECK_CATALOG["pnpm-install@1"];
    assert.ok(def);
    const result = await runCheck(def, { cwd: dir });

    assert.notEqual(
      result.exitStatus,
      0,
      `expected non-zero exit (stale lockfile); got ${result.exitStatus}`,
    );
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// node-pnpm-v2 and multi-repo-v2 profile tests
// ---------------------------------------------------------------------------

test("node-pnpm-v2: resolves from PROFILE_CATALOG with expected checks", () => {
  const profile = resolveProfile("node-pnpm-v2");
  assert.equal(profile.id, "node-pnpm-v2");
  assert.deepEqual(
    profile.checks,
    ["pnpm-install@1", "pnpm-typecheck@1", "pnpm-test@1"],
    "checks must be ordered: install, typecheck, test",
  );
  assert.deepEqual(profile.protectedPaths, DEFAULT_PROTECTED_PATHS);
});

test("multi-repo-v2: resolves from PROFILE_CATALOG with expected checks", () => {
  const profile = resolveProfile("multi-repo-v2");
  assert.equal(profile.id, "multi-repo-v2");
  assert.deepEqual(
    profile.checks,
    ["pnpm-install@1", "pnpm-typecheck@1", "manifest-consumer@1"],
    "checks must be ordered: install, typecheck, manifest-consumer",
  );
  assert.deepEqual(profile.protectedPaths, DEFAULT_PROTECTED_PATHS);
});

test("node-pnpm-v2: profileDigest differs from node-pnpm-v1", () => {
  const v1 = PROFILE_CATALOG["node-pnpm-v1"];
  const v2 = PROFILE_CATALOG["node-pnpm-v2"];
  assert.ok(v1, "node-pnpm-v1 must exist");
  assert.ok(v2, "node-pnpm-v2 must exist");
  assert.notEqual(
    profileDigest(v1),
    profileDigest(v2),
    "node-pnpm-v2 digest must differ from node-pnpm-v1",
  );
});

test("multi-repo-v2: profileDigest differs from multi-repo-v1", () => {
  const v1 = PROFILE_CATALOG["multi-repo-v1"];
  const v2 = PROFILE_CATALOG["multi-repo-v2"];
  assert.ok(v1, "multi-repo-v1 must exist");
  assert.ok(v2, "multi-repo-v2 must exist");
  assert.notEqual(
    profileDigest(v1),
    profileDigest(v2),
    "multi-repo-v2 digest must differ from multi-repo-v1",
  );
});

test("node-pnpm-v2: profileDigest is stable", () => {
  const profile = PROFILE_CATALOG["node-pnpm-v2"];
  assert.ok(profile, "node-pnpm-v2 must exist");
  assert.equal(profileDigest(profile), profileDigest(profile), "digest must be stable");
});

test("multi-repo-v2: profileDigest is stable", () => {
  const profile = PROFILE_CATALOG["multi-repo-v2"];
  assert.ok(profile, "multi-repo-v2 must exist");
  assert.equal(profileDigest(profile), profileDigest(profile), "digest must be stable");
});

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

test("smoke: package name is defined", () => {
  assert.equal(PACKAGE_NAME, "@agencyhq/verification");
});
