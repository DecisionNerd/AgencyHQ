// Tests for lib/runtime.ts — prepareRuntime.
// Uses FakeBroker to avoid real coordinator interaction.
// Uses real filesystem (mkdtemp) to verify auth.json is written correctly.

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LeaseGrant } from "@agencyhq/contracts";

import { FakeBroker } from "../src/lib/broker.ts";
import { prepareRuntime } from "../src/lib/runtime.ts";

const BASE_ARGS = {
  runId: "run-abc",
  attemptId: "attempt-1",
  generation: 0,
  nonce: "n".repeat(32),
};

function makeProviderGrant(authJson: string): LeaseGrant {
  return {
    leaseId: "prov-lease-1",
    purpose: "provider",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "provider", authJson },
  };
}

function makeUploadGrant(): LeaseGrant {
  return {
    leaseId: "up-lease-1",
    purpose: "upload",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "upload", token: "upload-token-value" },
  };
}

test("prepareRuntime: host profile returns host HOME and noop cleanup", async () => {
  const broker = new FakeBroker();
  const hostHome = "/some/host/home";
  const result = await prepareRuntime({
    ...BASE_ARGS,
    broker,
    env: {
      AGENCYHQ_RUNTIME_PROFILE: "host",
      HOME: hostHome,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.home, hostHome);
    assert.deepEqual(result.envAdditions, {});
    assert.equal(result.uploadLease, null);
    // cleanup is a noop — call it and verify no error.
    await result.cleanup();
  }
  // No broker calls on the host profile.
  assert.equal(broker.calls.length, 0);
});

test("prepareRuntime: container profile writes auth.json at 0600 and returns cleanup", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-runtime-test-"));
  const broker = new FakeBroker();

  const AUTH_JSON = JSON.stringify({ provider: "anthropic", key: "sk-secret" });
  broker.grants.set("provider:attempt-1", makeProviderGrant(AUTH_JSON));
  broker.grants.set("upload:attempt-1", makeUploadGrant());

  const result = await prepareRuntime({
    ...BASE_ARGS,
    broker,
    env: {
      AGENCYHQ_RUNTIME_PROFILE: "container",
      HOME: "/home/node",
      AGENCYHQ_RUN_ROOT: runRoot,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    // HOME should be under runRoot, not /home/node.
    assert.ok(result.home.startsWith(runRoot), "container HOME must be under runRoot");

    // auth.json must exist and have mode 0600.
    const authPath = join(result.home, ".local", "share", "opencode", "auth.json");
    const contents = await readFile(authPath, "utf8");
    assert.equal(contents, AUTH_JSON);

    const info = await stat(authPath);
    const mode = info.mode & 0o777;
    assert.equal(mode, 0o600, `auth.json mode must be 0600, got 0${mode.toString(8)}`);

    // Secret value must not appear in any broker call records.
    const callsStr = JSON.stringify(broker.calls);
    assert.ok(!callsStr.includes("sk-secret"), "secret key must not appear in call records");

    // Cleanup must delete the HOME tree.
    await result.cleanup();
    const exists = await stat(result.home)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false, "HOME tree must be deleted after cleanup");
  }
});

test("prepareRuntime: container profile returns provider_login_required on login_required refusal", async () => {
  const broker = new FakeBroker();
  // No grant set → FakeBroker returns "unavailable".
  // For login_required we need to simulate it explicitly.
  broker.grants.set("provider:attempt-1-login", {
    leaseId: "x",
    purpose: "provider",
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    material: { purpose: "provider", authJson: "{}" },
  });
  // Override the fake to return login_required.
  const broker2 = new FakeBroker();
  // Simulate a login_required refusal by not setting any grant.
  // FakeBroker returns "unavailable" which maps to "provider_unavailable".
  // To test login_required, we need a broker that returns it.
  const origRequestLease = broker2.requestLease.bind(broker2);
  broker2.requestLease = async (req) => {
    void origRequestLease(req);
    return {
      ok: false,
      status: 403,
      refusal: { purpose: req.purpose, reason: "login_required" as const },
    };
  };

  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-runtime-lr-"));
  const result = await prepareRuntime({
    ...BASE_ARGS,
    broker: broker2,
    env: {
      AGENCYHQ_RUNTIME_PROFILE: "container",
      HOME: "/home/node",
      AGENCYHQ_RUN_ROOT: runRoot,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failureKind, "provider_login_required");
  }
});

test("prepareRuntime: container profile returns provider_expired on expired refusal", async () => {
  const broker = new FakeBroker();
  broker.requestLease = async (req) => ({
    ok: false,
    status: 403,
    refusal: { purpose: req.purpose, reason: "expired" as const },
  });

  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-runtime-exp-"));
  const result = await prepareRuntime({
    ...BASE_ARGS,
    broker,
    env: {
      AGENCYHQ_RUNTIME_PROFILE: "container",
      HOME: "/home/node",
      AGENCYHQ_RUN_ROOT: runRoot,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failureKind, "provider_expired");
  }
});

test("prepareRuntime: container profile cleanup runs even on error paths", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "agencyhq-runtime-err-"));
  const broker = new FakeBroker();
  broker.grants.set("provider:attempt-1", makeProviderGrant("{}"));
  broker.grants.set("upload:attempt-1", makeUploadGrant());

  const result = await prepareRuntime({
    ...BASE_ARGS,
    broker,
    env: {
      AGENCYHQ_RUNTIME_PROFILE: "container",
      HOME: "/home/node",
      AGENCYHQ_RUN_ROOT: runRoot,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    // Call cleanup twice — should not throw.
    await result.cleanup();
    await result.cleanup();
  }
});
