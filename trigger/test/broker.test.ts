// Tests for FakeBroker (lib/broker.ts).
// Verifies call recording, redaction of secret material, and default behaviours.
// No live network calls.

import assert from "node:assert/strict";
import test from "node:test";

import type { LeaseGrant, LeaseRequest } from "@agencyhq/contracts";

import { FakeBroker } from "../src/lib/broker.ts";

function makeUploadGrant(token: string): LeaseGrant {
  return {
    leaseId: "lease-1",
    purpose: "upload",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "upload", token },
  };
}

function makeRequest(overrides: Partial<LeaseRequest> = {}): LeaseRequest {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    generation: 0,
    purpose: "upload",
    nonce: "a".repeat(32),
    ...overrides,
  };
}

test("FakeBroker: requestLease records the call with redacted material", async () => {
  const broker = new FakeBroker();
  broker.grants.set("upload:attempt-1", makeUploadGrant("secret-token-value"));

  const result = await broker.requestLease(makeRequest());

  assert.equal(result.ok, true);
  assert.equal(broker.calls.length, 1);
  const call = broker.calls[0];
  if (!call) {
    assert.fail("expected a recorded call");
    return;
  }
  assert.equal(call.op, "requestLease");
  // The nonce must NOT appear in any recorded call field
  const callStr = JSON.stringify(call);
  assert.ok(!callStr.includes("a".repeat(32)), "nonce must not appear in call record");
  // The token must NOT appear in any recorded call field
  assert.ok(!callStr.includes("secret-token-value"), "token must not appear in call record");
});

test("FakeBroker: requestLease returns unavailable refusal when no grant is set", async () => {
  const broker = new FakeBroker();
  const result = await broker.requestLease(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.refusal.reason, "unavailable");
  }
});

test("FakeBroker: downloadSourceBundle records the call and returns bundle bytes", async () => {
  const broker = new FakeBroker();
  const fakeBundle = Buffer.from("fake-bundle-data");
  broker.bundles.set("proj-1:deadbeef01234567890123456789012345678901", fakeBundle);

  const result = await broker.downloadSourceBundle({
    projectId: "proj-1",
    rev: "deadbeef01234567890123456789012345678901",
    token: "secret-upload-token",
  });

  assert.deepEqual(result.bundleBytes, fakeBundle);
  assert.equal(broker.calls.length, 1);
  const call = broker.calls[0];
  if (!call) {
    assert.fail("expected a recorded call");
    return;
  }
  assert.equal(call.op, "downloadSourceBundle");
  // Token must NOT appear in recorded call
  const callStr = JSON.stringify(call);
  assert.ok(!callStr.includes("secret-upload-token"), "token must not appear in call record");
});

test("FakeBroker: uploadArtifact records the call with redacted token", async () => {
  const broker = new FakeBroker();
  const meta = {
    attemptId: "attempt-1",
    generation: 0,
    kind: "attempt" as const,
    commitId: "a".repeat(40),
    diffDigest: `sha256:${"b".repeat(64)}`,
    changedPaths: ["src/foo.ts"],
    bundleSha256: "c".repeat(64),
    bundleBytes: 1024,
  };

  const result = await broker.uploadArtifact({
    attemptId: "attempt-1",
    token: "super-secret-upload-token",
    meta,
    bundleBytes: Buffer.from("bundle"),
  });

  assert.equal(result.status, "accepted");
  assert.equal(broker.calls.length, 1);
  const call = broker.calls[0];
  if (!call) {
    assert.fail("expected a recorded call");
    return;
  }
  assert.equal(call.op, "uploadArtifact");
  const callStr = JSON.stringify(call);
  assert.ok(!callStr.includes("super-secret-upload-token"), "token must not appear in call record");
});

test("FakeBroker: uploadCheckpoint records with kind=checkpoint", async () => {
  const broker = new FakeBroker();
  const meta = {
    attemptId: "attempt-1",
    generation: 0,
    kind: "checkpoint" as const,
    commitId: "a".repeat(40),
    diffDigest: `sha256:${"b".repeat(64)}`,
    changedPaths: [],
    bundleSha256: "c".repeat(64),
    bundleBytes: 512,
  };

  await broker.uploadCheckpoint({
    attemptId: "attempt-1",
    token: "secret",
    meta,
    bundleBytes: Buffer.from("ck"),
  });

  assert.equal(broker.calls.length, 1);
  const call = broker.calls[0];
  if (!call) {
    assert.fail("expected a recorded call");
    return;
  }
  assert.equal(call.op, "uploadCheckpoint");
  if (call.op === "uploadCheckpoint") {
    assert.equal(call.metaKind, "checkpoint");
  }
});

test("FakeBroker: uploadStopEvidence records step count", async () => {
  const broker = new FakeBroker();
  const evidence = {
    attemptId: "attempt-1",
    generation: 0,
    steps: [
      { at: new Date().toISOString(), step: "signal_sent" as const },
      { at: new Date().toISOString(), step: "process_exited" as const, detail: "exit 0" },
    ],
  };

  await broker.uploadStopEvidence({
    attemptId: "attempt-1",
    token: "secret",
    evidence,
  });

  assert.equal(broker.calls.length, 1);
  const call = broker.calls[0];
  if (!call) {
    assert.fail("expected a recorded call");
    return;
  }
  assert.equal(call.op, "uploadStopEvidence");
  if (call.op === "uploadStopEvidence") {
    assert.equal(call.stepCount, 2);
  }
});

test("FakeBroker: leaseError causes requestLease to throw", async () => {
  const broker = new FakeBroker();
  broker.leaseError = new Error("coordinator unreachable");

  await assert.rejects(() => broker.requestLease(makeRequest()), /coordinator unreachable/);
});

test("FakeBroker: no raw secret values appear in any call records", async () => {
  const SECRET = "super-secret-value-that-must-not-leak";
  const broker = new FakeBroker();

  const grant: LeaseGrant = {
    leaseId: "lease-1",
    purpose: "provider",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    material: { purpose: "provider", authJson: SECRET },
  };
  broker.grants.set("provider:attempt-1", grant);

  await broker.requestLease({ ...makeRequest(), purpose: "provider" });

  const callsStr = JSON.stringify(broker.calls);
  assert.ok(!callsStr.includes(SECRET), "secret must not appear in any recorded call");
});
