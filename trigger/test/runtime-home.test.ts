import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRuntimeProfile, resolveRunHome } from "../src/lib/runtime-home.ts";

test("resolveRunHome container: creates home at <runRoot>/runs/<runId>/home", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-rh-test-"));
  const runId = "run-abc123";
  const result = resolveRunHome({
    profile: "container",
    runRoot,
    runId,
    hostHome: "/home/irrelevant",
  });

  assert.equal(result.home, join(runRoot, "runs", runId, "home"));
  assert.equal(result.created, true);

  // Verify the directory exists
  const s = await stat(result.home);
  assert.ok(s.isDirectory());
});

test("resolveRunHome container: home mode is 0o700 on POSIX", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-rh-test-"));
  const runId = "run-perms";
  const result = resolveRunHome({
    profile: "container",
    runRoot,
    runId,
    hostHome: "/home/irrelevant",
  });

  const s = await stat(result.home);
  // On POSIX the mode is available; skip the check on Windows
  if (process.platform !== "win32") {
    const mode = s.mode & 0o777;
    assert.equal(mode, 0o700, `Expected mode 0700, got ${mode.toString(8)}`);
  }
});

test("resolveRunHome container: creates .local/share/opencode at 0o700", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-rh-test-"));
  const runId = "run-opencode-share";
  const result = resolveRunHome({
    profile: "container",
    runRoot,
    runId,
    hostHome: "/home/irrelevant",
  });

  const opencodeShare = join(result.home, ".local", "share", "opencode");
  const s = await stat(opencodeShare);
  assert.ok(s.isDirectory());

  if (process.platform !== "win32") {
    const mode = s.mode & 0o777;
    assert.equal(mode, 0o700, `Expected mode 0700, got ${mode.toString(8)}`);
  }
});

test("resolveRunHome host: returns hostHome unchanged and creates nothing", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-rh-test-"));
  const hostHome = "/home/myuser";
  const result = resolveRunHome({
    profile: "host",
    runRoot,
    runId: "run-host",
    hostHome,
  });

  assert.equal(result.home, hostHome);
  assert.equal(result.created, false);

  // The runs directory should NOT have been created
  let exists = false;
  try {
    await stat(join(runRoot, "runs"));
    exists = true;
  } catch {
    // expected
  }
  assert.equal(exists, false, "runs/ should not be created on host profile");
});

test("resolveRunHome: invalid runId rejected", () => {
  const badIds = [
    "",
    "run with spaces",
    "run/slash",
    "run..dotdot",
    "run@symbol",
    "a".repeat(129),
    "../escape",
  ];
  for (const runId of badIds) {
    assert.throws(
      () =>
        resolveRunHome({
          profile: "container",
          runRoot: "/tmp",
          runId,
          hostHome: "/home/node",
        }),
      /Invalid runId/,
      `Expected error for runId: ${JSON.stringify(runId)}`,
    );
  }
});

test("resolveRunHome: valid runId variants accepted", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-rh-test-"));
  const validIds = ["a", "abc", "run-123", "run_456", "ABC", "a".repeat(128)];
  for (const runId of validIds) {
    const result = resolveRunHome({
      profile: "container",
      runRoot,
      runId,
      hostHome: "/home/node",
    });
    assert.ok(result.home.endsWith(`${runId}/home`), `runId: ${runId}`);
  }
});

test("resolveRunHome container: idempotent second call returns created: false", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-rh-test-"));
  const args = {
    profile: "container" as const,
    runRoot,
    runId: "run-idempotent",
    hostHome: "/home/node",
  };

  const first = resolveRunHome(args);
  assert.equal(first.created, true);

  const second = resolveRunHome(args);
  assert.equal(second.created, false);
  assert.equal(second.home, first.home);
});

test("readRuntimeProfile: returns 'container' only for exact match", () => {
  assert.equal(readRuntimeProfile({ AGENCYHQ_RUNTIME_PROFILE: "container" }), "container");
  assert.equal(readRuntimeProfile({ AGENCYHQ_RUNTIME_PROFILE: "host" }), "host");
  assert.equal(readRuntimeProfile({ AGENCYHQ_RUNTIME_PROFILE: "Container" }), "host");
  assert.equal(readRuntimeProfile({ AGENCYHQ_RUNTIME_PROFILE: "" }), "host");
  assert.equal(readRuntimeProfile({}), "host");
  assert.equal(readRuntimeProfile({ AGENCYHQ_RUNTIME_PROFILE: undefined }), "host");
});
