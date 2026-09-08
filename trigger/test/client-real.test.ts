/**
 * Unit tests for RealExecutionRuntime.
 *
 * All tests inject a fake SDK surface so no live Trigger.dev connection is
 * required.  A single skipped live test (`TRIGGER_LIVE=1`) exercises the
 * real API end-to-end.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SdkSurface } from "../src/client/real.ts";
import { RealExecutionRuntime, RuntimeError } from "../src/client/real.ts";

// ---------------------------------------------------------------------------
// Fake SDK surface
// ---------------------------------------------------------------------------

/** Minimal shape returned by tasks.trigger */
type FakeTriggerResult = { id: string };

/** Minimal shape returned by runs.retrieve */
type FakeRunResult = {
  id: string;
  status: string;
  output?: unknown;
  metadata?: Record<string, unknown>;
  error?: { message: string; name?: string };
};

function makeFakeSdk(
  overrides: {
    triggerResult?: FakeTriggerResult;
    retrieveResult?: FakeRunResult;
    cancelError?: Error;
    createPublicTokenResult?: string;
    triggerError?: Error;
    retrieveError?: Error;
  } = {},
): SdkSurface & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];

  const sdk: SdkSurface & { calls: typeof calls } = {
    calls,
    configure: (_opts) => {
      calls.push({ method: "configure", args: [_opts] });
    },
    idempotencyKeys: {
      create: async (key: string | string[], opts?: { scope?: string }) => {
        calls.push({ method: "idempotencyKeys.create", args: [key, opts] });
        // Return the key as a branded string (the real SDK does hashing;
        // for tests we just pass it through as the IdempotencyKey shape)
        return key as unknown as Awaited<ReturnType<SdkSurface["idempotencyKeys"]["create"]>>;
      },
      reset: async () => {
        throw new Error("not implemented in fake");
      },
    } as unknown as SdkSurface["idempotencyKeys"],
    tasks: {
      trigger: async (id: string, payload: unknown, opts: unknown) => {
        calls.push({ method: "tasks.trigger", args: [id, payload, opts] });
        if (overrides.triggerError) throw overrides.triggerError;
        return overrides.triggerResult ?? { id: "run_real_1" };
      },
    } as unknown as SdkSurface["tasks"],
    runs: {
      retrieve: async (runId: string) => {
        calls.push({ method: "runs.retrieve", args: [runId] });
        if (overrides.retrieveError) throw overrides.retrieveError;
        return overrides.retrieveResult ?? { id: runId, status: "COMPLETED" };
      },
      cancel: async (runId: string) => {
        calls.push({ method: "runs.cancel", args: [runId] });
        if (overrides.cancelError) throw overrides.cancelError;
        return {} as Awaited<ReturnType<SdkSurface["runs"]["cancel"]>>;
      },
    } as unknown as SdkSurface["runs"],
    auth: {
      createPublicToken: async (opts: unknown) => {
        calls.push({ method: "auth.createPublicToken", args: [opts] });
        return overrides.createPublicTokenResult ?? "pub_token_fake";
      },
    } as unknown as SdkSurface["auth"],
  };

  return sdk;
}

function makeRuntime(sdkOverrides?: Parameters<typeof makeFakeSdk>[0]) {
  const sdk = makeFakeSdk(sdkOverrides);
  const rt = new RealExecutionRuntime(
    { apiUrl: "https://api.trigger.dev", secretKey: "tr_test_secret" },
    sdk,
  );
  return { rt, sdk };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("constructor calls configure with baseURL and secretKey", () => {
  const { sdk } = makeRuntime();
  const configureCall = sdk.calls.find((c) => c.method === "configure");
  assert.ok(configureCall, "configure should be called");
  const opts = configureCall?.args[0] as { baseURL: string; secretKey: string };
  assert.equal(opts.baseURL, "https://api.trigger.dev");
  assert.equal(opts.secretKey, "tr_test_secret");
});

// ---------------------------------------------------------------------------
// trigger()
// ---------------------------------------------------------------------------

test("trigger() creates idempotency key with global scope", async () => {
  const { rt, sdk } = makeRuntime();
  await rt.trigger({
    intentId: "intent-1",
    task: "worker.attempt",
    payload: { foo: "bar" },
    options: { idempotencyKey: "idem-key-1" },
  });

  const createCall = sdk.calls.find((c) => c.method === "idempotencyKeys.create");
  assert.ok(createCall, "idempotencyKeys.create should be called");
  assert.equal(createCall?.args[0], "idem-key-1");
  const opts = createCall?.args[1] as { scope: string };
  assert.equal(opts.scope, "global");
});

test("trigger() passes idempotencyKeyTTL default '24h'", async () => {
  const { rt, sdk } = makeRuntime();
  await rt.trigger({
    intentId: "intent-1",
    task: "worker.attempt",
    payload: {},
    options: { idempotencyKey: "k1" },
  });

  const triggerCall = sdk.calls.find((c) => c.method === "tasks.trigger");
  assert.ok(triggerCall);
  const opts = triggerCall?.args[2] as { idempotencyKeyTTL: string };
  assert.equal(opts.idempotencyKeyTTL, "24h");
});

test("trigger() uses caller-specified idempotencyKeyTtl when given", async () => {
  const { rt, sdk } = makeRuntime();
  await rt.trigger({
    intentId: "intent-1",
    task: "worker.attempt",
    payload: {},
    options: { idempotencyKey: "k1", idempotencyKeyTtl: "48h" },
  });

  const triggerCall = sdk.calls.find((c) => c.method === "tasks.trigger");
  const opts = triggerCall?.args[2] as { idempotencyKeyTTL: string };
  assert.equal(opts.idempotencyKeyTTL, "48h");
});

test("trigger() passes concurrencyKey and tags", async () => {
  const { rt, sdk } = makeRuntime();
  await rt.trigger({
    intentId: "i",
    task: "worker.attempt",
    payload: {},
    options: {
      idempotencyKey: "k2",
      concurrencyKey: "repo:abc",
      tags: ["attempt:x", "repo:abc"],
    },
  });

  const triggerCall = sdk.calls.find((c) => c.method === "tasks.trigger");
  const opts = triggerCall?.args[2] as { concurrencyKey: string; tags: string[] };
  assert.equal(opts.concurrencyKey, "repo:abc");
  assert.deepEqual(opts.tags, ["attempt:x", "repo:abc"]);
});

test("trigger() passes maxDurationSeconds as maxDuration", async () => {
  const { rt, sdk } = makeRuntime();
  await rt.trigger({
    intentId: "i",
    task: "worker.attempt",
    payload: {},
    options: { idempotencyKey: "k3", maxDurationSeconds: 300 },
  });

  const triggerCall = sdk.calls.find((c) => c.method === "tasks.trigger");
  const opts = triggerCall?.args[2] as { maxDuration: number };
  assert.equal(opts.maxDuration, 300);
});

test("trigger() returns runId from handle.id", async () => {
  const { rt } = makeRuntime({ triggerResult: { id: "run_real_99" } });
  const result = await rt.trigger({
    intentId: "i",
    task: "worker.attempt",
    payload: {},
    options: { idempotencyKey: "k4" },
  });
  assert.equal(result.runId, "run_real_99");
});

test("trigger() wraps SDK error into RuntimeError", async () => {
  const { rt } = makeRuntime({ triggerError: new Error("network timeout") });
  await assert.rejects(
    () =>
      rt.trigger({
        intentId: "i",
        task: "worker.attempt",
        payload: {},
        options: { idempotencyKey: "k5" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      assert.equal(err.name, "RuntimeError");
      assert.ok(err.message.includes("network timeout"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// retrieve() — mapping
// ---------------------------------------------------------------------------

test("retrieve() maps id → runId", async () => {
  const { rt } = makeRuntime({ retrieveResult: { id: "run_abc", status: "COMPLETED" } });
  const obs = await rt.retrieve("run_abc");
  assert.equal(obs.runId, "run_abc");
});

test("retrieve() passes through status string", async () => {
  const { rt } = makeRuntime({ retrieveResult: { id: "r1", status: "EXECUTING" } });
  const obs = await rt.retrieve("r1");
  assert.equal(obs.status, "EXECUTING");
});

test("retrieve() includes output when present", async () => {
  const { rt } = makeRuntime({
    retrieveResult: { id: "r1", status: "COMPLETED", output: { result: 42 } },
  });
  const obs = await rt.retrieve("r1");
  assert.deepEqual(obs.output, { result: 42 });
});

test("retrieve() omits output when absent", async () => {
  const { rt } = makeRuntime({ retrieveResult: { id: "r1", status: "COMPLETED" } });
  const obs = await rt.retrieve("r1");
  assert.equal(obs.output, undefined);
});

test("retrieve() maps metadata", async () => {
  const { rt } = makeRuntime({
    retrieveResult: { id: "r1", status: "EXECUTING", metadata: { phase: "diffing" } },
  });
  const obs = await rt.retrieve("r1");
  assert.deepEqual(obs.metadata, { phase: "diffing" });
});

test("retrieve() maps error message and name", async () => {
  const { rt } = makeRuntime({
    retrieveResult: {
      id: "r1",
      status: "FAILED",
      error: { message: "something broke", name: "AbortTaskRunError" },
    },
  });
  const obs = await rt.retrieve("r1");
  assert.ok(obs.error);
  assert.equal(obs.error.message, "something broke");
  assert.equal(obs.error.name, "AbortTaskRunError");
});

test("retrieve() omits error when absent", async () => {
  const { rt } = makeRuntime({ retrieveResult: { id: "r1", status: "COMPLETED" } });
  const obs = await rt.retrieve("r1");
  assert.equal(obs.error, undefined);
});

test("retrieve() sets observedAt to an ISO-8601 string", async () => {
  const { rt } = makeRuntime({ retrieveResult: { id: "r1", status: "COMPLETED" } });
  const before = new Date().toISOString();
  const obs = await rt.retrieve("r1");
  const after = new Date().toISOString();
  assert.ok(obs.observedAt >= before, "observedAt should be >= before");
  assert.ok(obs.observedAt <= after, "observedAt should be <= after");
});

test("retrieve() wraps SDK error into RuntimeError", async () => {
  const { rt } = makeRuntime({ retrieveError: new Error("503") });
  await assert.rejects(
    () => rt.retrieve("run_x"),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// cancel()
// ---------------------------------------------------------------------------

test("cancel() calls runs.cancel with runId", async () => {
  const { rt, sdk } = makeRuntime();
  await rt.cancel("run_to_cancel");
  const cancelCall = sdk.calls.find((c) => c.method === "runs.cancel");
  assert.ok(cancelCall);
  assert.equal(cancelCall?.args[0], "run_to_cancel");
});

test("cancel() wraps SDK error into RuntimeError", async () => {
  const { rt } = makeRuntime({ cancelError: new Error("not found") });
  await assert.rejects(
    () => rt.cancel("run_x"),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// createPublicToken()
// ---------------------------------------------------------------------------

test("createPublicToken() passes tags as scopes.read.tags", async () => {
  const { rt, sdk } = makeRuntime({ createPublicTokenResult: "tok_abc" });
  const token = await rt.createPublicToken({ tags: ["attempt:1"], expiresIn: "5m" });
  assert.equal(token, "tok_abc");

  const call = sdk.calls.find((c) => c.method === "auth.createPublicToken");
  assert.ok(call);
  const opts = call?.args[0] as {
    scopes: { read: { tags: string[] } };
    expirationTime: string;
  };
  assert.deepEqual(opts.scopes.read.tags, ["attempt:1"]);
  assert.equal(opts.expirationTime, "5m");
});

// ---------------------------------------------------------------------------
// Live test (skipped unless TRIGGER_LIVE=1)
// ---------------------------------------------------------------------------

test("live trigger roundtrip", { skip: !process.env.TRIGGER_LIVE }, async () => {
  // This test requires TRIGGER_LIVE=1 plus TRIGGER_API_URL and
  // TRIGGER_SECRET_KEY set in the environment.  It triggers the
  // `spike.echo` task (registered in trigger/src/tasks/) and waits for
  // a non-QUEUED status.  Do not run it in CI.
  const { RealExecutionRuntime: RT } = await import("../src/client/real.ts");

  const apiUrl = process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
  const secretKey = process.env.TRIGGER_SECRET_KEY ?? "";
  if (!secretKey) throw new Error("TRIGGER_SECRET_KEY must be set for live test");

  const rt = new RT({ apiUrl, secretKey });

  const { runId } = await rt.trigger({
    intentId: "live-test-intent",
    task: "spike.echo",
    payload: { msg: "hello" },
    options: { idempotencyKey: `live-test-${Date.now()}` },
  });
  assert.ok(runId, "should have a runId");

  // Poll until non-QUEUED (up to 30s)
  const deadline = Date.now() + 30_000;
  let obs = await rt.retrieve(runId);
  while (
    (obs.status === "QUEUED" || obs.status === "DEQUEUED" || obs.status === "PENDING_VERSION") &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 2_000));
    obs = await rt.retrieve(runId);
  }

  assert.ok(obs.status !== "QUEUED", `run should have advanced past QUEUED (got ${obs.status})`);
});
