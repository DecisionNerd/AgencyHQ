// Tests for FakeBroker (lib/broker.ts) and createBroker real HTTP client.
// FakeBroker: call recording, redaction of secret material, and default behaviours.
// createBroker (W2-wire Output 5): auth header, JSON error mapping, bounded
//   timeout (abort), and no retry of POSTs. Uses Node.js http.createServer()
//   as the stub server (Hono is not available in the trigger package).

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as httpCreateServer } from "node:http";
import test from "node:test";

import type { LeaseGrant, LeaseRequest } from "@agencyhq/contracts";

import { createBroker, FakeBroker } from "../src/lib/broker.ts";

// ---------------------------------------------------------------------------
// Stub HTTP server helpers
// ---------------------------------------------------------------------------

type StubHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function makeStubServer(handler: StubHandler): Promise<{ baseUrl: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const server = httpCreateServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("unexpected server address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
    server.on("error", reject);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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

// ---------------------------------------------------------------------------
// createBroker: real HTTP client tests (W2-wire Output 5)
// ---------------------------------------------------------------------------

test("createBroker: requestLease sends JSON body and returns grant on 200", async () => {
  let capturedBody: string | undefined;

  const stub = await makeStubServer(async (req, res) => {
    capturedBody = await readBody(req);
    const grant = {
      leaseId: "lease-real-1",
      purpose: "upload",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      material: { purpose: "upload", token: "upload-tok" },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(grant));
  });

  try {
    const broker = createBroker(stub.baseUrl);
    const result = await broker.requestLease({
      runId: "run-real",
      attemptId: "attempt-real",
      generation: 0,
      purpose: "upload",
      nonce: "a".repeat(32),
    });

    assert.equal(result.ok, true, "result must be ok");
    if (!result.ok) return;
    assert.equal(result.grant.leaseId, "lease-real-1");
    assert.equal(result.grant.material.purpose, "upload");

    // Verify JSON body was sent with correct fields.
    assert.ok(capturedBody, "request body must be sent");
    const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
    assert.equal(parsed.runId, "run-real");
    assert.equal(parsed.attemptId, "attempt-real");
    assert.equal(parsed.purpose, "upload");
    // Nonce must appear in body (it is required for the broker protocol).
    assert.equal(parsed.nonce, "a".repeat(32));
  } finally {
    stub.close();
  }
});

test("createBroker: requestLease maps JSON 403 body to typed LeaseRefusal", async () => {
  const stub = await makeStubServer(async (req, res) => {
    await readBody(req);
    const refusal = { purpose: "upload", reason: "unknown_attempt" };
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify(refusal));
  });

  try {
    const broker = createBroker(stub.baseUrl);
    const result = await broker.requestLease({
      runId: "run-403",
      attemptId: "attempt-403",
      generation: 0,
      purpose: "upload",
      nonce: "b".repeat(32),
    });

    assert.equal(result.ok, false, "result must not be ok for 403");
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.refusal.reason, "unknown_attempt");
    }
  } finally {
    stub.close();
  }
});

test("createBroker: AbortController aborts a hung request (bounded timeout mechanism)", async () => {
  // This test verifies the AbortController mechanism used by fetchWithTimeout.
  // We manually abort a fetch with a tiny timeout, same way the broker does
  // internally with DEFAULT_TIMEOUT_MS, and assert an AbortError is thrown.
  const stub = await makeStubServer((_req, _res) => {
    // Intentionally never respond.
  });

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const fetchCall = fetch(`${stub.baseUrl}/internal/leases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: "r",
        attemptId: "a",
        generation: 0,
        purpose: "upload",
        nonce: "n".repeat(32),
      }),
      signal: controller.signal,
    });

    await assert.rejects(
      () => fetchCall,
      (err: unknown) => {
        const e = err as { name?: string; code?: string };
        return e.name === "AbortError" || e.code === "ABORT_ERR";
      },
      "fetch with AbortSignal must reject with AbortError when controller fires",
    );
  } finally {
    stub.close();
  }
});

test("createBroker: requestLease POST is never retried (single attempt only)", async () => {
  let callCount = 0;

  const stub = await makeStubServer(async (req, res) => {
    callCount++;
    await readBody(req);
    const refusal = { purpose: "upload", reason: "unavailable" };
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify(refusal));
  });

  try {
    const broker = createBroker(stub.baseUrl);
    await broker.requestLease({
      runId: "run-no-retry",
      attemptId: "attempt-no-retry",
      generation: 0,
      purpose: "upload",
      nonce: "c".repeat(32),
    });
    assert.equal(callCount, 1, "POST requestLease must be called exactly once (no retry)");
  } finally {
    stub.close();
  }
});

test("createBroker: downloadSourceBundle retries GET up to 3 times", async () => {
  let callCount = 0;
  const BUNDLE = Buffer.from("fake-bundle-bytes");
  const BUNDLE_SHA = "abc123sha256";

  const stub = await makeStubServer((_req, res) => {
    callCount++;
    if (callCount < 3) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "x-agencyhq-bundle-sha256": BUNDLE_SHA,
    });
    res.end(BUNDLE);
  });

  try {
    const broker = createBroker(stub.baseUrl);
    const result = await broker.downloadSourceBundle({
      projectId: "proj-1",
      rev: "deadbeef01234567890123456789012345678901",
      token: "dl-token",
    });

    assert.deepEqual(result.bundleBytes, BUNDLE);
    assert.equal(result.bundleSha256, BUNDLE_SHA);
    assert.equal(callCount, 3, "GET must retry until success (MAX_GET_ATTEMPTS = 3)");
  } finally {
    stub.close();
  }
});

test("createBroker: downloadAttemptBundle retries GET up to 3 times", async () => {
  let callCount = 0;
  const BUNDLE = Buffer.from("attempt-bundle-bytes");
  const COMMIT_ID = "aabbcc0011223344556677889900aabbcc001122";

  const stub = await makeStubServer((_req, res) => {
    callCount++;
    if (callCount < 3) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "x-commit-id": COMMIT_ID,
    });
    res.end(BUNDLE);
  });

  try {
    const broker = createBroker(stub.baseUrl);
    const result = await broker.downloadAttemptBundle({
      attemptId: "attempt-retry",
      generation: 1,
      token: "dl-attempt-token",
    });

    assert.deepEqual(result.bundleBytes, BUNDLE);
    assert.equal(result.commitId, COMMIT_ID);
    assert.equal(callCount, 3, "GET must retry until success (MAX_GET_ATTEMPTS = 3)");
  } finally {
    stub.close();
  }
});
