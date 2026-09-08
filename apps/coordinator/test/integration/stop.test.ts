/**
 * Integration tests for stopAttempt command.
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestDbContext } from "@agencyhq/db";
import { applyObservation, withTestSchema } from "@agencyhq/db";
import type { ExecutionRuntime } from "@agencyhq/trigger/client";
import pg from "pg";
import { confirmStop } from "../../src/commands/confirm-stop.ts";
import type { CommandDeps } from "../../src/commands/stop.ts";
import { stopAttempt } from "../../src/commands/stop.ts";

// ---------------------------------------------------------------------------
// Minimal in-test fake runtime
// ---------------------------------------------------------------------------

type CallRecord = { method: string; args: readonly unknown[] };

class FakeRuntime implements ExecutionRuntime {
  readonly calls: CallRecord[] = [];

  async trigger(): Promise<{ runId: string }> {
    this.calls.push({ method: "trigger", args: [] });
    return { runId: `run-fake-${Date.now()}` };
  }

  async cancel(runId: string): Promise<void> {
    this.calls.push({ method: "cancel", args: [runId] });
  }

  async retrieve(runId: string) {
    this.calls.push({ method: "retrieve", args: [runId] });
    return {
      runId,
      status: "CANCELED" as const,
      observedAt: new Date().toISOString(),
    };
  }

  async createPublicToken(): Promise<string> {
    return "fake-token";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a schema-aware pg.Pool: every client automatically gets the
 * test schema set as its search_path.
 */
function makeSchemaPool(databaseUrl: string, schema: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const origConnect = pool.connect.bind(pool);
  // biome-ignore lint/suspicious/noExplicitAny: wrapping pool.connect
  (pool as any).connect = async () => {
    const client = await origConnect();
    await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);
    return client;
  };
  return pool;
}

async function seedAttempt(
  ctx: TestDbContext,
  opts: { status?: string; generation?: number; runId?: string } = {},
): Promise<{ attemptId: string; contractId: string; projectId: string; workItemId: string }> {
  const { client } = ctx;
  const projectId = `proj-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const contractId = `sc-${randomUUID()}`;
  const attemptId = `att-${randomUUID()}`;
  const runId = opts.runId ?? `run-${randomUUID()}`;

  await client.query(
    `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '1')`,
    [projectId],
  );
  await client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 1, 'test intent', 'artifact', 'admitted', 'healthy')`,
    [workItemId, projectId],
  );
  await client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, 'abc123', '{}', '[]', 'cdigest', 'profile1', 'pdigest',
             '{}', '[]', false, 'active')`,
    [contractId, workItemId, projectId],
  );
  await client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, run_id, budget_remaining)
     VALUES ($1, $2, 1, $3, $4, $5, 100)`,
    [attemptId, contractId, opts.generation ?? 1, opts.status ?? "running", runId],
  );

  return { attemptId, contractId, projectId, workItemId };
}

function makeDeps(pool: pg.Pool, runtime: FakeRuntime): CommandDeps {
  return {
    pool,
    runtime,
    clock: { now: () => new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Tests: stopAttempt
// ---------------------------------------------------------------------------

test("stop: revokeGeneration is committed before runtime.cancel is called", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const { attemptId } = await seedAttempt(ctx, { status: "running", generation: 1 });

      // Wrap runtime so cancel() reads the DB generation before returning
      let generationAtCancelTime: number | null = null;
      const baseRuntime = new FakeRuntime();
      const wrappedRuntime: typeof baseRuntime = {
        ...baseRuntime,
        calls: baseRuntime.calls,
        cancel: async (runId: string) => {
          // Query the DB to see the generation at the time cancel is called
          const { rows } = await ctx.client.query<{ generation: number }>(
            `SELECT generation FROM attempts WHERE id = $1`,
            [attemptId],
          );
          generationAtCancelTime = rows[0]?.generation ?? null;
          return baseRuntime.cancel(runId);
        },
        trigger: baseRuntime.trigger.bind(baseRuntime),
        retrieve: baseRuntime.retrieve.bind(baseRuntime),
        createPublicToken: baseRuntime.createPublicToken.bind(baseRuntime),
      };

      const deps = makeDeps(pool, wrappedRuntime as unknown as FakeRuntime);
      const commandId = `cmd-${randomUUID()}`;
      const result = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });

      assert.ok(result.ok, `Expected ok=true, got: ${JSON.stringify(result)}`);
      if (result.ok) {
        assert.equal(result.generation, 2, "Generation should be 2 after revoke");
      }

      // The generation seen by cancel() must already be 2 (committed)
      assert.equal(generationAtCancelTime, 2, "revokeGeneration must be committed before cancel");
    } finally {
      await pool.end();
    }
  });
});

test("stop: stale observation after stop → applyObservation returns stale", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const runId = `run-${randomUUID()}`;
      const { attemptId } = await seedAttempt(ctx, {
        status: "running",
        generation: 1,
        runId,
      });

      const runtime = new FakeRuntime();
      const deps = makeDeps(pool, runtime);

      // Stop the attempt (generation → 2, status → stopping)
      const stopResult = await stopAttempt(deps, {
        commandId: `cmd-${randomUUID()}`,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(stopResult.ok);

      // Apply an observation with the OLD generation (1) — should be stale
      const obsResult = await applyObservation(ctx.client, {
        runId,
        generation: 1,
        attemptId,
        status: "COMPLETED",
        payload: {},
        observedAt: new Date(),
      });
      assert.equal(obsResult, "stale", "Old-generation observation should be stale");

      // Attempt status should not have changed from stopping
      const { rows } = await ctx.client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1`,
        [attemptId],
      );
      assert.equal(rows[0]?.status, "stopping", "Attempt status should remain stopping");
    } finally {
      await pool.end();
    }
  });
});

test("stop: attempt in completed state → state_mismatch", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const { attemptId } = await seedAttempt(ctx, { status: "completed", generation: 1 });

      const runtime = new FakeRuntime();
      const deps = makeDeps(pool, runtime);

      const result = await stopAttempt(deps, {
        commandId: `cmd-${randomUUID()}`,
        attemptId,
        actor: "human",
        reason: "test",
      });

      assert.ok(!result.ok);
      if (!result.ok) {
        assert.equal(result.reason, "state_mismatch");
      }

      // No cancel call should have been made
      const cancelCalls = runtime.calls.filter((c) => c.method === "cancel");
      assert.equal(cancelCalls.length, 0, "cancel should not be called on state_mismatch");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: confirmStop
// ---------------------------------------------------------------------------

test("confirmStop: survivors [] → stopped with checkpointCommit", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const runId = `run-${randomUUID()}`;
      const { attemptId } = await seedAttempt(ctx, {
        status: "stopping",
        generation: 2,
        runId,
      });

      const runtime = new FakeRuntime();
      const deps = makeDeps(pool, runtime);

      const result = await confirmStop(deps, ctx.client, {
        attemptId,
        generation: 2,
        observation: {
          runId,
          status: "CANCELED",
          metadata: { survivors: [] },
          observedAt: new Date().toISOString(),
        },
        stopEvidence: { survivors: [], checkpointCommit: "abc123" },
      });

      assert.equal(result.status, "stopped");
      if (result.status === "stopped") {
        assert.equal(result.checkpointCommit, "abc123");
      }

      // DB should reflect stopped status
      const { rows } = await ctx.client.query<{ status: string; checkpoint_commit: string | null }>(
        `SELECT status, checkpoint_commit FROM attempts WHERE id = $1`,
        [attemptId],
      );
      assert.equal(rows[0]?.status, "stopped");
      assert.equal(rows[0]?.checkpoint_commit, "abc123");
    } finally {
      await pool.end();
    }
  });
});

test("confirmStop: survivors non-empty → uncertain", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const runId = `run-${randomUUID()}`;
      const { attemptId } = await seedAttempt(ctx, {
        status: "stopping",
        generation: 2,
        runId,
      });

      const runtime = new FakeRuntime();
      const deps = makeDeps(pool, runtime);

      const result = await confirmStop(deps, ctx.client, {
        attemptId,
        generation: 2,
        observation: {
          runId,
          status: "CANCELED",
          metadata: { survivors: [123] },
          observedAt: new Date().toISOString(),
        },
        stopEvidence: { survivors: [123] },
      });

      assert.equal(result.status, "uncertain");

      const { rows } = await ctx.client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1`,
        [attemptId],
      );
      assert.equal(rows[0]?.status, "uncertain");
    } finally {
      await pool.end();
    }
  });
});

test("confirmStop: no evidence before deadline → pending_confirmation", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const runId = `run-${randomUUID()}`;
      const { attemptId } = await seedAttempt(ctx, {
        status: "stopping",
        generation: 2,
        runId,
      });

      const runtime = new FakeRuntime();
      const now = new Date().toISOString();
      const deps: CommandDeps = {
        pool,
        runtime,
        clock: { now: () => now },
        config: { uncertainAfterMs: 120_000 },
      };

      // No metadata survivors, no stop evidence, not past deadline
      const result = await confirmStop(deps, ctx.client, {
        attemptId,
        generation: 2,
        observation: {
          runId,
          status: "CANCELED",
          observedAt: now,
        },
        finalObservedAt: now, // finalObservedAt = now, deadline not reached
      });

      assert.equal(result.status, "pending_confirmation");

      // Attempt status should remain stopping
      const { rows } = await ctx.client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1`,
        [attemptId],
      );
      assert.equal(rows[0]?.status, "stopping");
    } finally {
      await pool.end();
    }
  });
});

test("confirmStop: no evidence after deadline → uncertain", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const runId = `run-${randomUUID()}`;
      const { attemptId } = await seedAttempt(ctx, {
        status: "stopping",
        generation: 2,
        runId,
      });

      const runtime = new FakeRuntime();
      // finalObservedAt is 200s ago, uncertainAfterMs = 120s
      const pastTime = new Date(Date.now() - 200_000).toISOString();
      const deps: CommandDeps = {
        pool,
        runtime,
        clock: { now: () => new Date().toISOString() },
        config: { uncertainAfterMs: 120_000 },
      };

      const result = await confirmStop(deps, ctx.client, {
        attemptId,
        generation: 2,
        observation: {
          runId,
          status: "CANCELED",
          observedAt: pastTime,
        },
        finalObservedAt: pastTime,
      });

      assert.equal(result.status, "uncertain");

      const { rows } = await ctx.client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1`,
        [attemptId],
      );
      assert.equal(rows[0]?.status, "uncertain");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency: same commandId twice
// ---------------------------------------------------------------------------

test("stop idempotency: same commandId → second call returns stored result, cancel called once", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const { attemptId } = await seedAttempt(ctx, { status: "running", generation: 1 });

      const runtime = new FakeRuntime();
      const deps = makeDeps(pool, runtime);
      const commandId = `cmd-${randomUUID()}`;

      const first = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(first.ok);

      // Replay
      const second = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(second.ok);
      if (first.ok && second.ok) {
        assert.equal(second.generation, first.generation, "Idempotent: same generation returned");
      }

      // cancel should have been called exactly once
      const cancelCalls = runtime.calls.filter((c) => c.method === "cancel");
      assert.equal(cancelCalls.length, 1, "cancel should be called only once");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (iv): stop command replay → replayed: true
// ---------------------------------------------------------------------------

test("stop: command replay returns stored result with replayed: true", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const { attemptId } = await seedAttempt(ctx, { status: "running", generation: 1 });

      const runtime = new FakeRuntime();
      const deps = makeDeps(pool, runtime);
      const commandId = `cmd-${randomUUID()}`;

      // First call: fresh execution
      const first = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(first.ok, "first call succeeds");
      assert.ok(!first.replayed, "first call is NOT replayed");

      // Second call: same commandId → replay
      const second = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(second.ok, "replay result is ok");
      assert.equal(second.replayed, true, "replay call has replayed: true");

      // Result content matches first call
      if (first.ok && second.ok) {
        assert.equal(second.generation, first.generation, "replay: same generation");
        assert.equal(second.runId, first.runId, "replay: same runId");
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// H-5: runtime.cancel throws → attempt still gets stopping status, command
// completed with cancelSkipped:true
// ---------------------------------------------------------------------------

test("stop (H-5): runtime.cancel throws → generation revoked, attempt stopping, command cancelSkipped", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const { attemptId } = await seedAttempt(ctx, { status: "running", generation: 1 });

      const cancelError = new Error("run already finalized");
      const throwingRuntime: FakeRuntime = {
        ...new FakeRuntime(),
        calls: [],
        cancel: async (_runId: string) => {
          throw cancelError;
        },
        trigger: new FakeRuntime().trigger.bind(new FakeRuntime()),
        retrieve: new FakeRuntime().retrieve.bind(new FakeRuntime()),
        createPublicToken: new FakeRuntime().createPublicToken.bind(new FakeRuntime()),
      };

      const deps = makeDeps(pool, throwingRuntime);
      const commandId = `cmd-h5-${randomUUID()}`;

      const result = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "coordinator",
        reason: "H-5 cancel-throws test",
      });

      // Return value must be ok:true (generation was revoked before cancel)
      assert.ok(result.ok, `Expected ok=true; got: ${JSON.stringify(result)}`);

      // Attempt must be stopping (generation revoked before cancel threw)
      const { rows: attemptRows } = await ctx.client.query<{ status: string; generation: number }>(
        "SELECT status, generation FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(attemptRows[0]?.status, "stopping", "(H-5) attempt status is stopping");
      assert.equal(attemptRows[0]?.generation, 2, "(H-5) generation bumped to 2");

      // Command row must be completed with cancelSkipped:true
      const { rows: cmdRows } = await ctx.client.query<{ result: Record<string, unknown> }>(
        "SELECT result FROM commands WHERE command_id = $1",
        [commandId],
      );
      assert.ok(cmdRows.length > 0, "(H-5) command row exists");
      const stored = cmdRows[0]?.result ?? {};
      assert.equal(stored["cancelSkipped"], true, "(H-5) cancelSkipped:true in command result");
      assert.ok(typeof stored["reason"] === "string", "(H-5) reason string present");
    } finally {
      await pool.end();
    }
  });
});

test("stop (H-5): cancel-throws result is replayed correctly on second call", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const { attemptId } = await seedAttempt(ctx, { status: "running", generation: 1 });

      const throwingRuntime: FakeRuntime = {
        ...new FakeRuntime(),
        calls: [],
        cancel: async (_runId: string) => {
          throw new Error("always fails");
        },
        trigger: new FakeRuntime().trigger.bind(new FakeRuntime()),
        retrieve: new FakeRuntime().retrieve.bind(new FakeRuntime()),
        createPublicToken: new FakeRuntime().createPublicToken.bind(new FakeRuntime()),
      };

      const deps = makeDeps(pool, throwingRuntime);
      const commandId = `cmd-h5-replay-${randomUUID()}`;

      // First call → cancel throws, command completed with cancelSkipped
      const first = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "coordinator",
        reason: "H-5 replay test",
      });
      assert.ok(first.ok, "first call ok:true");

      // Second call with same commandId → replayed from stored result
      const second = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "coordinator",
        reason: "H-5 replay test",
      });
      assert.ok(second.ok, "replay ok:true");
      assert.equal(second.replayed, true, "(H-5) second call replayed:true");
    } finally {
      await pool.end();
    }
  });
});
