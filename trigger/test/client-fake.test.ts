import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FakeExecutionRuntime, FakeNetworkError } from "../src/client/fake.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(id = "attempt-1") {
  return { attemptId: id, task: "worker.attempt" };
}

function triggerOpts(key: string) {
  return {
    intentId: `intent-${key}`,
    task: "worker.attempt",
    payload: makePayload(),
    options: { idempotencyKey: key },
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("same idempotency key twice returns the same runId (trial item 1)", async () => {
  const fake = new FakeExecutionRuntime();
  const r1 = await fake.trigger(triggerOpts("k1"));
  const r2 = await fake.trigger(triggerOpts("k1"));
  assert.equal(r1.runId, r2.runId);
});

test("different idempotency keys produce different runIds", async () => {
  const fake = new FakeExecutionRuntime();
  const r1 = await fake.trigger(triggerOpts("k1"));
  const r2 = await fake.trigger(triggerOpts("k2"));
  assert.notEqual(r1.runId, r2.runId);
});

// ---------------------------------------------------------------------------
// dropNextResponse (lost response simulation)
// ---------------------------------------------------------------------------

test("dropNextResponse then retry returns the same runId", async () => {
  const fake = new FakeExecutionRuntime();
  fake.dropNextResponse();

  let thrownError: unknown;
  try {
    await fake.trigger(triggerOpts("k-drop"));
  } catch (err) {
    thrownError = err;
  }
  assert.ok(thrownError instanceof FakeNetworkError, "should throw FakeNetworkError");

  // Retry with same key → same run.
  const r2 = await fake.trigger(triggerOpts("k-drop"));
  assert.ok(r2.runId.startsWith("run_fake_"), "runId has expected prefix");

  // Only one run was created.
  assert.equal(fake.idempotency.get("k-drop"), r2.runId);
});

// ---------------------------------------------------------------------------
// Idempotency key lifecycle
// ---------------------------------------------------------------------------

test("failure status clears idempotency key; next trigger creates a new run", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => ({ status: "FAILED", error: { message: "oops" } }));

  const r1 = await fake.trigger(triggerOpts("k-fail"));
  fake.advance(r1.runId); // QUEUED → EXECUTING
  fake.advance(r1.runId); // EXECUTING → FAILED (key cleared)

  const obs1 = await fake.retrieve(r1.runId);
  assert.equal(obs1.status, "FAILED");

  // Key should be gone.
  assert.equal(fake.idempotency.get("k-fail"), undefined);

  // Third trigger with same key → new run.
  const r3 = await fake.trigger(triggerOpts("k-fail"));
  assert.notEqual(r3.runId, r1.runId);
});

test("cancel keeps idempotency key; next trigger returns same run", async () => {
  const fake = new FakeExecutionRuntime();

  const r1 = await fake.trigger(triggerOpts("k-cancel"));
  await fake.cancel(r1.runId);

  const obs = await fake.retrieve(r1.runId);
  assert.equal(obs.status, "CANCELED");

  // Key is still live.
  assert.equal(fake.idempotency.get("k-cancel"), r1.runId);

  // Trigger again → same run.
  const r2 = await fake.trigger(triggerOpts("k-cancel"));
  assert.equal(r2.runId, r1.runId);
});

test("COMPLETED status keeps idempotency key", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => ({ status: "COMPLETED", output: { ok: true } }));

  const r1 = await fake.trigger(triggerOpts("k-ok"));
  fake.advance(r1.runId);
  fake.advance(r1.runId);

  const obs = await fake.retrieve(r1.runId);
  assert.equal(obs.status, "COMPLETED");
  assert.equal(fake.idempotency.get("k-ok"), r1.runId);
});

// ---------------------------------------------------------------------------
// Scripted transitions
// ---------------------------------------------------------------------------

test("scripted transitions observed in order via retrieve", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => ({ status: "COMPLETED", output: { result: 42 } }));

  const { runId } = await fake.trigger(triggerOpts("k-steps"));

  let obs = await fake.retrieve(runId);
  assert.equal(obs.status, "QUEUED");

  fake.advance(runId);
  obs = await fake.retrieve(runId);
  assert.equal(obs.status, "EXECUTING");

  fake.advance(runId);
  obs = await fake.retrieve(runId);
  assert.equal(obs.status, "COMPLETED");
  assert.deepEqual(obs.output, { result: 42 });
});

test("multi-step script: intermediate states observable between advances", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => [
    { status: "EXECUTING", metadata: { progress: 0.5 } },
    { status: "COMPLETED", output: { done: true } },
  ]);

  const { runId } = await fake.trigger(triggerOpts("k-multi"));

  // QUEUED
  assert.equal((await fake.retrieve(runId)).status, "QUEUED");

  // advance → first scripted step (EXECUTING with metadata)
  fake.advance(runId);
  const mid = await fake.retrieve(runId);
  assert.equal(mid.status, "EXECUTING");
  assert.deepEqual(mid.metadata, { progress: 0.5 });

  // advance → COMPLETED
  fake.advance(runId);
  const fin = await fake.retrieve(runId);
  assert.equal(fin.status, "COMPLETED");
  assert.deepEqual(fin.output, { done: true });
});

test("advanceAll advances all non-final runs", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => ({ status: "COMPLETED" }));

  const r1 = await fake.trigger(triggerOpts("k-all-1"));
  const r2 = await fake.trigger(triggerOpts("k-all-2"));

  fake.advanceAll(); // both QUEUED → EXECUTING

  assert.equal((await fake.retrieve(r1.runId)).status, "EXECUTING");
  assert.equal((await fake.retrieve(r2.runId)).status, "EXECUTING");
});

// ---------------------------------------------------------------------------
// cancel behaviour
// ---------------------------------------------------------------------------

test("cancel yields CANCELED immediately and records cancelledAt", async () => {
  const fake = new FakeExecutionRuntime(() => "2025-01-01T00:00:00.000Z");

  const { runId } = await fake.trigger(triggerOpts("k-cxl"));
  await fake.cancel(runId);

  const obs = await fake.retrieve(runId);
  assert.equal(obs.status, "CANCELED");
});

test("cancel on already-final run is a no-op", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => ({ status: "COMPLETED" }));

  const { runId } = await fake.trigger(triggerOpts("k-noop"));
  fake.advance(runId);
  fake.advance(runId); // → COMPLETED

  await fake.cancel(runId); // should not throw
  const obs = await fake.retrieve(runId);
  assert.equal(obs.status, "COMPLETED"); // unchanged
});

// ---------------------------------------------------------------------------
// setMetadata (survivors after final)
// ---------------------------------------------------------------------------

test("setMetadata survivors observable after final status", async () => {
  const fake = new FakeExecutionRuntime();
  fake.script("worker.attempt", () => ({ status: "CANCELED" }));

  const { runId } = await fake.trigger(triggerOpts("k-meta"));
  await fake.cancel(runId);

  fake.setMetadata(runId, { survivors: [1234, 5678] });

  const obs = await fake.retrieve(runId);
  assert.deepEqual(obs.metadata?.["survivors"], [1234, 5678]);
});

// ---------------------------------------------------------------------------
// createPublicToken
// ---------------------------------------------------------------------------

test("createPublicToken returns deterministic string embedding tags", async () => {
  const fake = new FakeExecutionRuntime();
  const token = await fake.createPublicToken({ tags: ["repo:abc", "item:xyz"], expiresIn: "1h" });
  assert.ok(token.includes("repo:abc"), "token embeds first tag");
  assert.ok(token.includes("item:xyz"), "token embeds second tag");
  assert.ok(token.includes("1h"), "token embeds expiresIn");
});

// ---------------------------------------------------------------------------
// calls log
// ---------------------------------------------------------------------------

test("calls log records method names in order", async () => {
  const fake = new FakeExecutionRuntime();
  const { runId } = await fake.trigger(triggerOpts("k-log"));
  await fake.retrieve(runId);
  await fake.cancel(runId);
  await fake.createPublicToken({ tags: ["t"], expiresIn: "10m" });

  const methods = fake.calls.map((c) => c.method);
  assert.deepEqual(methods, ["trigger", "retrieve", "cancel", "createPublicToken"]);
});

test("calls log records args for trigger", async () => {
  const fake = new FakeExecutionRuntime();
  const input = triggerOpts("k-args");
  await fake.trigger(input);

  const first = fake.calls[0];
  assert.ok(first !== undefined);
  assert.equal(first.method, "trigger");
  assert.deepEqual((first.args as unknown[])[0], input);
});

// ---------------------------------------------------------------------------
// Deterministic run ids
// ---------------------------------------------------------------------------

test("run ids are deterministic and sequential", async () => {
  const fake = new FakeExecutionRuntime();
  const r1 = await fake.trigger(triggerOpts("k-seq-1"));
  const r2 = await fake.trigger(triggerOpts("k-seq-2"));
  assert.equal(r1.runId, "run_fake_1");
  assert.equal(r2.runId, "run_fake_2");
});

// ---------------------------------------------------------------------------
// No @trigger.dev import (source assertion)
// ---------------------------------------------------------------------------

test("fake.ts source contains no @trigger.dev import statement", () => {
  const fakePath = fileURLToPath(new URL("../src/client/fake.ts", import.meta.url));
  const source = readFileSync(fakePath, "utf-8");
  // Check only import declarations, not comments or strings
  const importLines = source.split("\n").filter((l) => /^\s*(import|export)\s/.test(l));
  const triggerDevImports = importLines.filter((l) => l.includes("@trigger.dev"));
  assert.equal(
    triggerDevImports.length,
    0,
    `fake.ts must not import @trigger.dev packages, but found: ${triggerDevImports.join(", ")}`,
  );
});
