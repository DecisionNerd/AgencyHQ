/**
 * Integration tests for command idempotency across all operator commands.
 *
 * Every command is idempotent by commandId: a replay returns the stored
 * result without re-running the side-effectful work.
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestDbContext } from "@agencyhq/db";
import { withTestSchema } from "@agencyhq/db";
import type { ExecutionRuntime } from "@agencyhq/trigger/client";
import pg from "pg";
import { ackVisit } from "../../src/commands/ack-visit.ts";
import { createWorkItem } from "../../src/commands/create-work-item.ts";
import { pauseWorkItem, resumeWorkItem } from "../../src/commands/pause.ts";
import type { CommandDeps } from "../../src/commands/stop.ts";
import { stopAttempt } from "../../src/commands/stop.ts";

// ---------------------------------------------------------------------------
// Minimal in-test fake runtime with call tracking
// ---------------------------------------------------------------------------

class FakeRuntime implements ExecutionRuntime {
  cancelCalls = 0;

  async trigger(): Promise<{ runId: string }> {
    return { runId: `run-fake-${Date.now()}` };
  }

  async cancel(): Promise<void> {
    this.cancelCalls++;
  }

  async retrieve(runId: string) {
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

async function seedProject(ctx: TestDbContext): Promise<string> {
  const projectId = `proj-${randomUUID()}`;
  await ctx.client.query(
    `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '1')`,
    [projectId],
  );
  return projectId;
}

async function seedAttempt(
  ctx: TestDbContext,
  opts: { status?: string; generation?: number } = {},
): Promise<string> {
  const projectId = `proj-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const contractId = `sc-${randomUUID()}`;
  const attemptId = `att-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;

  await ctx.client.query(
    `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '1')`,
    [projectId],
  );
  await ctx.client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 1, 'test intent', 'artifact', 'admitted', 'healthy')`,
    [workItemId, projectId],
  );
  await ctx.client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, 'abc123', '{}', '[]', 'cdigest', 'profile1', 'pdigest',
             '{}', '[]', false, 'active')`,
    [contractId, workItemId, projectId],
  );
  await ctx.client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, run_id, budget_remaining)
     VALUES ($1, $2, 1, $3, $4, $5, 100)`,
    [attemptId, contractId, opts.generation ?? 1, opts.status ?? "running", runId],
  );

  return attemptId;
}

async function seedWorkItem(ctx: TestDbContext, projectId: string): Promise<string> {
  const workItemId = `wi-${randomUUID()}`;
  await ctx.client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 1, 'test intent', 'artifact', 'admitted', 'healthy')`,
    [workItemId, projectId],
  );
  return workItemId;
}

function makeDeps(pool: pg.Pool, runtime: FakeRuntime = new FakeRuntime()): CommandDeps {
  return {
    pool,
    runtime,
    clock: { now: () => new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// stopAttempt idempotency
// ---------------------------------------------------------------------------

test("idempotency: stopAttempt same commandId → cancel called exactly once", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    const runtime = new FakeRuntime();
    try {
      const attemptId = await seedAttempt(ctx, { status: "running", generation: 1 });
      const deps = makeDeps(pool, runtime);
      const commandId = `cmd-${randomUUID()}`;

      const first = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(first.ok);

      const second = await stopAttempt(deps, {
        commandId,
        attemptId,
        actor: "human",
        reason: "test",
      });
      assert.ok(second.ok);
      if (first.ok && second.ok) {
        assert.equal(second.generation, first.generation);
        assert.equal(second.runId, first.runId);
      }

      assert.equal(runtime.cancelCalls, 1, "cancel called exactly once");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// pauseWorkItem idempotency
// ---------------------------------------------------------------------------

test("idempotency: pauseWorkItem same commandId → condition set once", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);
      const deps = makeDeps(pool);
      const commandId = `cmd-${randomUUID()}`;

      const first = await pauseWorkItem(deps, { commandId, workItemId, reason: "test" });
      assert.ok(first.ok);

      const second = await pauseWorkItem(deps, { commandId, workItemId, reason: "test" });
      assert.ok(second.ok);

      // Only one version bump should have occurred
      const { rows } = await ctx.client.query<{ version: number; condition: string }>(
        `SELECT version, condition FROM work_items WHERE id = $1`,
        [workItemId],
      );
      // Version should be 2 (initial 1 + one bump from pause)
      assert.equal(rows[0]?.version, 2, "Only one version bump");
      assert.equal(rows[0]?.condition, "blocked");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// resumeWorkItem idempotency
// ---------------------------------------------------------------------------

test("idempotency: resumeWorkItem same commandId → condition set once", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);

      // First pause
      await ctx.client.query(
        `UPDATE work_items SET condition = 'blocked', version = 2 WHERE id = $1`,
        [workItemId],
      );

      const deps = makeDeps(pool);
      const commandId = `cmd-${randomUUID()}`;

      await resumeWorkItem(deps, { commandId, workItemId });
      await resumeWorkItem(deps, { commandId, workItemId }); // replay

      const { rows } = await ctx.client.query<{ version: number; condition: string }>(
        `SELECT version, condition FROM work_items WHERE id = $1`,
        [workItemId],
      );
      // Version should be 3 (was 2 + one bump from resume)
      assert.equal(rows[0]?.version, 3, "Only one version bump");
      assert.equal(rows[0]?.condition, "healthy");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// createWorkItem idempotency
// ---------------------------------------------------------------------------

test("idempotency: createWorkItem same commandId → same workItemId", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const deps = makeDeps(pool);
      const commandId = `cmd-${randomUUID()}`;

      const first = await createWorkItem(deps, {
        commandId,
        projectId,
        intent: "Idempotent work item",
        boundary: "artifact",
        rank: 1,
      });

      const second = await createWorkItem(deps, {
        commandId,
        projectId,
        intent: "Idempotent work item",
        boundary: "artifact",
        rank: 1,
      });

      assert.ok(second.ok, "second call should succeed");
      assert.ok(first.ok, "first call should succeed");
      assert.equal(
        (second as { ok: true; workItemId: string }).workItemId,
        (first as { ok: true; workItemId: string }).workItemId,
      );

      const { rows } = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM work_items WHERE project_id = $1`,
        [projectId],
      );
      assert.equal(rows[0]?.count, "1");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// ackVisit idempotency
// ---------------------------------------------------------------------------

test("idempotency: ackVisit same commandId → same result", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const deps = makeDeps(pool);
      const commandId = `cmd-${randomUUID()}`;
      const at = "2026-09-07T10:00:00.000Z";

      const first = await ackVisit(deps, { commandId, at });
      assert.ok(first.ok);
      assert.equal(first.at, at);

      const second = await ackVisit(deps, { commandId, at });
      assert.ok(second.ok);
      assert.equal(second.at, at);

      // Only one command row
      const { rows } = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM commands WHERE command_id = $1`,
        [commandId],
      );
      assert.equal(rows[0]?.count, "1");
    } finally {
      await pool.end();
    }
  });
});
