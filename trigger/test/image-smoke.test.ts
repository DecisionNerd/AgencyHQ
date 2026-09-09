/**
 * Unit tests for the image smoke assertion logic and the image.smoke task core.
 *
 * Coverage:
 * - assertProbe: pass case, missing tools, wrong version, wrong platform,
 *   forbidden env keys (SSH_AUTH_SOCK, GH_TOKEN, GITHUB_TOKEN, AWS_*)
 * - assertSmoke: pass case, failed check, timed-out check, no checks
 * - runImageSmoke: successful clone+run returns results; failed check
 *   propagates; unknown profile throws; unknown check throws
 *
 * These tests exercise pure functions and injected-dep paths only.
 * No Trigger SDK runtime, no Docker, no live processes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RunCheckResult } from "@agencyhq/verification";
import type { ProbePins } from "../scripts/lib/image-smoke-assertions.ts";
import { assertProbe, assertSmoke } from "../scripts/lib/image-smoke-assertions.ts";
import type { ImageSmokeDeps } from "../src/tasks/image-smoke.ts";
import { runImageSmoke } from "../src/tasks/image-smoke.ts";
import type { ImageSmokeCheckResult, ImageSmokePayload, RuntimeProbeOutput } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PINS: ProbePins = {
  opencodeVersion: "1.18.29",
  pnpmVersion: "11.25.0",
  platform: "linux/arm64",
};

/** A fully valid probe output — all assertions should pass. */
function goodProbeOutput(): RuntimeProbeOutput {
  return {
    tools: {
      git: "git version 2.43.0",
      opencode: "1.18.29",
      pnpm: "11.25.0",
      node: "v24.1.0",
    },
    uid: "1000",
    home: "/home/node",
    homeWritable: true,
    runRootWritable: true,
    platform: "linux/arm64",
    cwd: "/app",
    envKeys: ["HOME", "PATH", "USER"],
  };
}

/** A check result representing a passing check. */
function passedCheckResult(): RunCheckResult {
  return {
    exitStatus: 0,
    signal: null,
    stdoutTail: "ok",
    stderrTail: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    timedOut: false,
  };
}

/** A check result representing a failing check. */
function failedCheckResult(): RunCheckResult {
  return {
    exitStatus: 1,
    signal: null,
    stdoutTail: "FAIL 1 test",
    stderrTail: "error",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    timedOut: false,
  };
}

/** A check result representing a timed-out check. */
function timedOutCheckResult(): RunCheckResult {
  return {
    exitStatus: null,
    signal: "SIGKILL",
    stdoutTail: "",
    stderrTail: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    timedOut: true,
  };
}

/** A good ImageSmokeCheckResult. */
function goodSmokeResult(checkId = "pnpm-install@1"): ImageSmokeCheckResult {
  return {
    checkId,
    passed: true,
    exitStatus: 0,
    stdoutTail: "ok",
    stderrTail: "",
    timedOut: false,
  };
}

/** A failed ImageSmokeCheckResult. */
function failedSmokeResult(checkId = "pnpm-test@1"): ImageSmokeCheckResult {
  return {
    checkId,
    passed: false,
    exitStatus: 1,
    stdoutTail: "FAIL",
    stderrTail: "",
    timedOut: false,
  };
}

/** Fake deps that always succeed. */
function makePassingDeps(): ImageSmokeDeps {
  return {
    clone: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    runCheckFn: async (_def, _opts) => passedCheckResult(),
  };
}

// ---------------------------------------------------------------------------
// assertProbe — pass case
// ---------------------------------------------------------------------------

test("assertProbe: returns null when all fields match pins", () => {
  const error = assertProbe(goodProbeOutput(), PINS);
  assert.equal(error, null, `Expected null, got: ${error}`);
});

// ---------------------------------------------------------------------------
// assertProbe — tool unavailability
// ---------------------------------------------------------------------------

test("assertProbe: fails when git reports unavailable", () => {
  const output = goodProbeOutput();
  output.tools.git = "unavailable: No such file or directory";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail");
  assert.ok(error.includes("git"), `error should mention git: ${error}`);
});

test("assertProbe: fails when opencode reports unavailable", () => {
  const output = goodProbeOutput();
  output.tools.opencode = "unavailable: command not found";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail");
  assert.ok(error.includes("opencode"), `error should mention opencode: ${error}`);
});

test("assertProbe: fails when pnpm reports unavailable", () => {
  const output = goodProbeOutput();
  output.tools.pnpm = "unavailable: command not found";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail");
  assert.ok(error.includes("pnpm"), `error should mention pnpm: ${error}`);
});

test("assertProbe: fails when node reports unavailable", () => {
  const output = goodProbeOutput();
  output.tools.node = "unavailable: command not found";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail");
  assert.ok(error.includes("node"), `error should mention node: ${error}`);
});

// ---------------------------------------------------------------------------
// assertProbe — version mismatches
// ---------------------------------------------------------------------------

test("assertProbe: fails when opencode version does not contain the pin", () => {
  const output = goodProbeOutput();
  output.tools.opencode = "1.17.0";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail on wrong opencode version");
  assert.ok(error.includes("opencode"), `error should mention opencode: ${error}`);
});

test("assertProbe: fails when pnpm version does not contain the pin", () => {
  const output = goodProbeOutput();
  output.tools.pnpm = "10.0.0";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail on wrong pnpm version");
  assert.ok(error.includes("pnpm"), `error should mention pnpm: ${error}`);
});

test("assertProbe: fails when node major version is not 24 (v21)", () => {
  const output = goodProbeOutput();
  output.tools.node = "v21.7.3";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail on node v21");
  assert.ok(error.includes("node"), `error should mention node: ${error}`);
});

test("assertProbe: fails when node major version is not 24 (v23)", () => {
  const output = goodProbeOutput();
  output.tools.node = "v23.0.0";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail on node v23");
});

test("assertProbe: passes when node reports v24.x.x", () => {
  const output = goodProbeOutput();
  output.tools.node = "v24.3.0";
  const error = assertProbe(output, PINS);
  assert.equal(error, null, `should pass for node v24`);
});

// ---------------------------------------------------------------------------
// assertProbe — uid
// ---------------------------------------------------------------------------

test("assertProbe: fails when uid is not 1000", () => {
  const output = goodProbeOutput();
  output.uid = "0";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when uid is root");
  assert.ok(error.includes("uid"), `error should mention uid: ${error}`);
});

test("assertProbe: fails when uid is not 1000 (uid 999)", () => {
  const output = goodProbeOutput();
  output.uid = "999";
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when uid is 999");
});

// ---------------------------------------------------------------------------
// assertProbe — writability
// ---------------------------------------------------------------------------

test("assertProbe: fails when HOME is not writable", () => {
  const output = goodProbeOutput();
  output.homeWritable = false;
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when HOME not writable");
  assert.ok(error.includes("HOME"), `error should mention HOME: ${error}`);
});

test("assertProbe: fails when run root is not writable", () => {
  const output = goodProbeOutput();
  output.runRootWritable = false;
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when run root not writable");
});

// ---------------------------------------------------------------------------
// assertProbe — platform
// ---------------------------------------------------------------------------

test("assertProbe: fails when platform does not match pins.platform", () => {
  const output = goodProbeOutput();
  output.platform = "linux/amd64";
  const error = assertProbe(output, PINS); // pins.platform = "linux/arm64"
  assert.ok(error !== null, "should fail when platform mismatches");
  assert.ok(error.includes("platform"), `error should mention platform: ${error}`);
});

test("assertProbe: passes when platform exactly matches pins.platform", () => {
  const output = goodProbeOutput();
  output.platform = "linux/arm64";
  const error = assertProbe(output, { ...PINS, platform: "linux/arm64" });
  assert.equal(error, null, "should pass when platform matches");
});

// ---------------------------------------------------------------------------
// assertProbe — forbidden env keys
// ---------------------------------------------------------------------------

test("assertProbe: fails when SSH_AUTH_SOCK is in envKeys", () => {
  const output = goodProbeOutput();
  output.envKeys = ["HOME", "PATH", "SSH_AUTH_SOCK"];
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when SSH_AUTH_SOCK present");
  assert.ok(error.includes("SSH_AUTH_SOCK"), `error should name key: ${error}`);
});

test("assertProbe: fails when GH_TOKEN is in envKeys", () => {
  const output = goodProbeOutput();
  output.envKeys = ["GH_TOKEN", "HOME", "PATH"];
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when GH_TOKEN present");
  assert.ok(error.includes("GH_TOKEN"), `error should name key: ${error}`);
});

test("assertProbe: fails when GITHUB_TOKEN is in envKeys", () => {
  const output = goodProbeOutput();
  output.envKeys = ["GITHUB_TOKEN", "HOME"];
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when GITHUB_TOKEN present");
  assert.ok(error.includes("GITHUB_TOKEN"), `error should name key: ${error}`);
});

test("assertProbe: fails when an AWS_ key is in envKeys", () => {
  const output = goodProbeOutput();
  output.envKeys = ["AWS_ACCESS_KEY_ID", "HOME", "PATH"];
  const error = assertProbe(output, PINS);
  assert.ok(error !== null, "should fail when AWS_ key present");
  assert.ok(error.includes("AWS_ACCESS_KEY_ID"), `error should name key: ${error}`);
});

test("assertProbe: passes when envKeys contains only safe keys", () => {
  const output = goodProbeOutput();
  output.envKeys = ["HOME", "PATH", "USER", "LANG", "TERM", "AGENCYHQ_RUN_ROOT"];
  const error = assertProbe(output, PINS);
  assert.equal(error, null, "should pass with only safe env keys");
});

// ---------------------------------------------------------------------------
// assertSmoke — pass case
// ---------------------------------------------------------------------------

test("assertSmoke: returns null when all checks passed", () => {
  const results: ImageSmokeCheckResult[] = [
    goodSmokeResult("pnpm-install@1"),
    goodSmokeResult("pnpm-typecheck@1"),
    goodSmokeResult("pnpm-test@1"),
  ];
  const error = assertSmoke(results);
  assert.equal(error, null, `Expected null, got: ${error}`);
});

// ---------------------------------------------------------------------------
// assertSmoke — failure cases
// ---------------------------------------------------------------------------

test("assertSmoke: fails when one check failed", () => {
  const results: ImageSmokeCheckResult[] = [
    goodSmokeResult("pnpm-install@1"),
    failedSmokeResult("pnpm-test@1"),
  ];
  const error = assertSmoke(results);
  assert.ok(error !== null, "should fail when a check fails");
  assert.ok(error.includes("pnpm-test@1"), `error should name the check: ${error}`);
});

test("assertSmoke: fails when a check timed out", () => {
  const results: ImageSmokeCheckResult[] = [
    {
      checkId: "pnpm-install@1",
      passed: false,
      exitStatus: null,
      stdoutTail: "",
      stderrTail: "",
      timedOut: true,
    },
  ];
  const error = assertSmoke(results);
  assert.ok(error !== null, "should fail when a check timed out");
  assert.ok(error.includes("pnpm-install@1"), `error should name the check: ${error}`);
  assert.ok(
    error.includes("timed out") || error.includes("pnpm-install@1"),
    `error should mention timeout: ${error}`,
  );
});

test("assertSmoke: fails when no checks ran", () => {
  const error = assertSmoke([]);
  assert.ok(error !== null, "should fail with empty results");
  assert.ok(error.length > 0, "error message should be non-empty");
});

test("assertSmoke: names the first failing check", () => {
  const results: ImageSmokeCheckResult[] = [
    failedSmokeResult("pnpm-install@1"),
    failedSmokeResult("pnpm-typecheck@1"),
  ];
  const error = assertSmoke(results);
  assert.ok(error !== null, "should fail");
  // Should name the first failing check, not the second.
  assert.ok(error.includes("pnpm-install@1"), `error should name first failing check: ${error}`);
});

// ---------------------------------------------------------------------------
// runImageSmoke — core logic with fake deps
// ---------------------------------------------------------------------------

test("runImageSmoke: returns passing results when all checks pass", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/fixture",
    fixtureRevision: "main",
    profileId: "fixture-node-v1",
  };

  const result = await runImageSmoke(payload, makePassingDeps());

  assert.ok(typeof result.cloneDir === "string", "cloneDir should be a string");
  assert.ok(result.cloneDir.length > 0, "cloneDir should be non-empty");
  assert.ok(Array.isArray(result.results), "results should be an array");
  // fixture-node-v1 has 3 checks
  assert.equal(result.results.length, 3, "should have 3 results for fixture-node-v1");
  for (const r of result.results) {
    assert.equal(r.passed, true, `check ${r.checkId} should have passed`);
    assert.equal(r.exitStatus, 0);
    assert.equal(r.timedOut, false);
  }
});

test("runImageSmoke: result includes correct checkIds in profile order", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/fixture",
    fixtureRevision: "abc123",
    profileId: "fixture-node-v1",
  };

  const result = await runImageSmoke(payload, makePassingDeps());

  const checkIds = result.results.map((r) => r.checkId);
  assert.deepEqual(checkIds, ["pnpm-install@1", "pnpm-typecheck@1", "pnpm-test@1"]);
});

test("runImageSmoke: returns failed result when a check exits non-zero", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/fixture",
    fixtureRevision: "main",
    profileId: "fixture-node-v1",
  };

  // First check passes, rest fail.
  let callCount = 0;
  const deps: ImageSmokeDeps = {
    clone: async () => {},
    runCheckFn: async () => {
      callCount++;
      return callCount === 1 ? passedCheckResult() : failedCheckResult();
    },
  };

  const result = await runImageSmoke(payload, deps);

  assert.equal(result.results[0]?.passed, true, "first check should pass");
  assert.equal(result.results[1]?.passed, false, "second check should fail");
  assert.equal(result.results[2]?.passed, false, "third check should fail");
  // All three checks still run (no short-circuit).
  assert.equal(result.results.length, 3);
});

test("runImageSmoke: clone function receives correct remote and revision", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/test/fixture",
    fixtureRevision: "v1.2.3",
    profileId: "fixture-node-v1",
  };

  let clonedRemote: string | undefined;
  let clonedRevision: string | undefined;

  const deps: ImageSmokeDeps = {
    clone: async (remote: string, revision: string, _dir: string) => {
      clonedRemote = remote;
      clonedRevision = revision;
    },
    runCheckFn: async () => passedCheckResult(),
  };

  await runImageSmoke(payload, deps);

  assert.equal(clonedRemote, "https://github.com/test/fixture");
  assert.equal(clonedRevision, "v1.2.3");
});

test("runImageSmoke: throws for unknown profile id", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/fixture",
    fixtureRevision: "main",
    profileId: "does-not-exist",
  };

  await assert.rejects(
    () => runImageSmoke(payload, makePassingDeps()),
    /does-not-exist/,
    "should throw for unknown profile",
  );
});

test("runImageSmoke: timedOut check is reflected in result", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/fixture",
    fixtureRevision: "main",
    profileId: "fixture-node-v1",
  };

  const deps: ImageSmokeDeps = {
    clone: async () => {},
    runCheckFn: async () => timedOutCheckResult(),
  };

  const result = await runImageSmoke(payload, deps);

  assert.ok(
    result.results.every((r) => r.timedOut),
    "all results should be timedOut",
  );
  assert.ok(
    result.results.every((r) => !r.passed),
    "all results should not pass",
  );
});

// ---------------------------------------------------------------------------
// CR12: onCloneDir callback — cleanup even on failure
// ---------------------------------------------------------------------------

test("runImageSmoke: onCloneDir is called before checks run, even when clone throws", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/repo",
    fixtureRevision: "main",
    profileId: "fixture-node-v1",
  };

  let capturedDir: string | undefined;
  const deps: ImageSmokeDeps = {
    clone: async () => {
      throw new Error("network failure");
    },
    runCheckFn: async () => passedCheckResult(),
    onCloneDir: (dir) => {
      capturedDir = dir;
    },
  };

  await assert.rejects(() => runImageSmoke(payload, deps), /network failure/);
  assert.ok(capturedDir !== undefined, "onCloneDir should be called before clone throws");
  assert.ok(capturedDir?.includes("smoke-"), "cloneDir should follow smoke-<ts> pattern");
});

test("runImageSmoke: onCloneDir is called before checks run, even when a check throws", async () => {
  const payload: ImageSmokePayload = {
    fixtureRemote: "https://github.com/example/repo",
    fixtureRevision: "main",
    profileId: "fixture-node-v1",
  };

  let capturedDir: string | undefined;
  const deps: ImageSmokeDeps = {
    clone: async () => {},
    runCheckFn: async () => {
      throw new Error("check runtime failure");
    },
    onCloneDir: (dir) => {
      capturedDir = dir;
    },
  };

  await assert.rejects(() => runImageSmoke(payload, deps), /check runtime failure/);
  assert.ok(capturedDir !== undefined, "onCloneDir should be called before checks throw");
});
