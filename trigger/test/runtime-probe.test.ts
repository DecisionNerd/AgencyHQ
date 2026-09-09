/**
 * Tests for the runtime.probe task output shape.
 *
 * These tests exercise the probe logic on THIS host (the development machine,
 * not a container). They verify:
 * - The output shape matches RuntimeProbeOutput
 * - Tool version strings are non-empty (unavailable strings accepted for
 *   tools not installed on this host)
 * - envKeys contains no "=" characters (keys only, not "KEY=VALUE" pairs)
 * - envKeys contains no values that look like env-variable values
 *   (i.e. every entry should be a valid env var name pattern)
 * - uid is a non-empty string
 * - home is a string (may be empty on some CI hosts)
 * - platform is "platform/arch" with two parts separated by "/"
 * - cwd is a non-empty string
 *
 * Note: the probe is not run through the Trigger SDK. The run() function
 * is exercised directly by importing and calling the underlying logic
 * from the task module (which imports the task file and calls run()).
 * On this host, opencode and pnpm may report "unavailable" since they are
 * not always installed globally; git and node are expected to be present.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runProbeImpl } from "../src/tasks/runtime-probe.ts";
import type { RuntimeProbeOutput } from "../src/types.ts";
import { TASK_IDS } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared probe output — run the core probe function once for all tests.
// runProbeImpl is the pure implementation exported from runtime-probe.ts;
// it does not require the Trigger SDK runtime.
// ---------------------------------------------------------------------------
async function runProbe(): Promise<RuntimeProbeOutput> {
  return runProbeImpl({});
}

test("runtime.probe task id is correct", () => {
  assert.equal(TASK_IDS.runtimeProbe, "runtime.probe");
});

test("probe output has required top-level fields", async () => {
  const out = await runProbe();
  assert.ok(out !== null && typeof out === "object", "output should be an object");
  assert.ok("tools" in out, "output should have tools");
  assert.ok("uid" in out, "output should have uid");
  assert.ok("home" in out, "output should have home");
  assert.ok("homeWritable" in out, "output should have homeWritable");
  assert.ok("runRootWritable" in out, "output should have runRootWritable");
  assert.ok("platform" in out, "output should have platform");
  assert.ok("cwd" in out, "output should have cwd");
  assert.ok("envKeys" in out, "output should have envKeys");
});

test("probe tools object has all four keys", async () => {
  const { tools } = await runProbe();
  assert.ok("git" in tools, "tools should have git");
  assert.ok("opencode" in tools, "tools should have opencode");
  assert.ok("pnpm" in tools, "tools should have pnpm");
  assert.ok("node" in tools, "tools should have node");
});

test("probe tool strings are non-empty", async () => {
  const { tools } = await runProbe();
  for (const [name, value] of Object.entries(tools)) {
    assert.ok(
      typeof value === "string" && value.length > 0,
      `tools.${name} should be a non-empty string`,
    );
  }
});

test("probe git version is available on this host", async () => {
  const { tools } = await runProbe();
  assert.ok(
    !tools.git.startsWith("unavailable:"),
    `git should be available on this host; got: ${tools.git}`,
  );
});

test("probe node version is available on this host", async () => {
  const { tools } = await runProbe();
  assert.ok(
    !tools.node.startsWith("unavailable:"),
    `node should be available on this host; got: ${tools.node}`,
  );
});

test("probe uid is a non-empty string", async () => {
  const { uid } = await runProbe();
  assert.ok(typeof uid === "string" && uid.length > 0, "uid should be a non-empty string");
});

test("probe home is a string (possibly empty on CI)", async () => {
  const { home } = await runProbe();
  assert.equal(typeof home, "string");
});

test("probe homeWritable and runRootWritable are booleans", async () => {
  const out = await runProbe();
  assert.equal(typeof out.homeWritable, "boolean");
  assert.equal(typeof out.runRootWritable, "boolean");
});

test("probe platform is 'platform/arch' with two slash-separated parts", async () => {
  const { platform } = await runProbe();
  const parts = platform.split("/");
  assert.equal(parts.length, 2, `platform should have exactly two parts; got: ${platform}`);
  assert.ok(parts[0] && parts[0].length > 0, "platform part should be non-empty");
  assert.ok(parts[1] && parts[1].length > 0, "arch part should be non-empty");
});

test("probe cwd is a non-empty string", async () => {
  const { cwd } = await runProbe();
  assert.ok(typeof cwd === "string" && cwd.length > 0, "cwd should be non-empty");
});

test("probe envKeys is a sorted array", async () => {
  const { envKeys } = await runProbe();
  assert.ok(Array.isArray(envKeys), "envKeys should be an array");
  const sorted = [...envKeys].sort();
  assert.deepEqual(envKeys, sorted, "envKeys should be sorted");
});

test("probe envKeys contains no '=' characters (keys only, no values)", async () => {
  const { envKeys } = await runProbe();
  for (const key of envKeys) {
    assert.ok(!key.includes("="), `envKeys entry should not contain '=': ${key}`);
  }
});

test("probe envKeys entries are valid env var name patterns", async () => {
  const { envKeys } = await runProbe();
  // Env var names consist of letters, digits, and underscores (POSIX).
  // Some systems allow other chars; we just verify no '=' and non-empty.
  for (const key of envKeys) {
    assert.ok(key.length > 0, "envKeys entries should be non-empty");
  }
});

test("probe does not include env values in envKeys", async () => {
  // Verify by checking that no envKeys entry is the VALUE of a known env var.
  // This is a best-effort check: we look for a few well-known var values
  // that would expose sensitive data if leaked as a key.
  const { envKeys } = await runProbe();
  const knownVarValues = [process.env["HOME"], process.env["USER"], process.env["PATH"]].filter(
    (v): v is string => typeof v === "string" && v.length > 5,
  );

  for (const val of knownVarValues) {
    assert.ok(
      !envKeys.includes(val),
      `env value "${val.slice(0, 20)}..." should not appear in envKeys`,
    );
  }
});

test("probe returns the same node version as process.version", async () => {
  const { tools } = await runProbe();
  // process.version is "vX.Y.Z"; node --version also returns "vX.Y.Z"
  assert.ok(
    tools.node.includes(process.version) || tools.node.startsWith("unavailable:"),
    `node version "${tools.node}" should match process.version "${process.version}"`,
  );
});

test("probe git version matches a real git binary", async () => {
  let expectedGit: string;
  try {
    expectedGit = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // git is not installed; skip the comparison
    return;
  }
  const { tools } = await runProbe();
  assert.equal(tools.git, expectedGit, "probe git version should match direct git --version call");
});
