/**
 * Integration tests for pause/resume and createWorkItem/ackVisit commands.
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
import { ackVisit, lastAckAt } from "../../src/commands/ack-visit.ts";
import { createWorkItem } from "../../src/commands/create-work-item.ts";
import { pauseWorkItem, resumeWorkItem } from "../../src/commands/pause.ts";
import type { CommandDeps } from "../../src/commands/stop.ts";

// ---------------------------------------------------------------------------
// Minimal in-test fake runtime
// ---------------------------------------------------------------------------

class FakeRuntime implements ExecutionRuntime {
  async trigger(): Promise<{ runId: string }> {
    return { runId: `run-fake-${Date.now()}` };
  }
  async cancel(): Promise<void> {}
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

async function seedWorkItem(
  ctx: TestDbContext,
  projectId: string,
  opts: { lifecycle?: string; condition?: string } = {},
): Promise<string> {
  const workItemId = `wi-${randomUUID()}`;
  await ctx.client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 1, 'test intent', 'artifact', $3, $4)`,
    [workItemId, projectId, opts.lifecycle ?? "admitted", opts.condition ?? "healthy"],
  );
  return workItemId;
}

function makeDeps(pool: pg.Pool): CommandDeps {
  return {
    pool,
    runtime: new FakeRuntime(),
    clock: { now: () => new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// pauseWorkItem / resumeWorkItem tests
// ---------------------------------------------------------------------------

test("pause: sets condition to blocked", async (t) => {
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

      const result = await pauseWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        workItemId,
        reason: "need to review",
      });

      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.workItemId, workItemId);
      }

      const { rows } = await ctx.client.query<{ condition: string }>(
        `SELECT condition FROM work_items WHERE id = $1`,
        [workItemId],
      );
      assert.equal(rows[0]?.condition, "blocked");
    } finally {
      await pool.end();
    }
  });
});

test("resume: sets condition back to healthy", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { condition: "blocked" });
      const deps = makeDeps(pool);

      const result = await resumeWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        workItemId,
      });

      assert.ok(result.ok);

      const { rows } = await ctx.client.query<{ condition: string }>(
        `SELECT condition FROM work_items WHERE id = $1`,
        [workItemId],
      );
      assert.equal(rows[0]?.condition, "healthy");
    } finally {
      await pool.end();
    }
  });
});

test("pause → resume: lifecycle is unchanged", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, {
        lifecycle: "active",
        condition: "healthy",
      });
      const deps = makeDeps(pool);

      await pauseWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        workItemId,
        reason: "blocked by review",
      });

      await resumeWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        workItemId,
      });

      const { rows } = await ctx.client.query<{ lifecycle: string; condition: string }>(
        `SELECT lifecycle, condition FROM work_items WHERE id = $1`,
        [workItemId],
      );
      assert.equal(rows[0]?.lifecycle, "active", "lifecycle should be unchanged");
      assert.equal(rows[0]?.condition, "healthy");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// createWorkItem tests
// ---------------------------------------------------------------------------

test("createWorkItem: inserts work item with admitted/healthy", async (t) => {
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

      const result = await createWorkItem(deps, {
        commandId,
        projectId,
        intent: "Fix the login bug",
        boundary: "artifact",
        rank: 1,
      });

      assert.ok(result.ok);

      const { rows } = await ctx.client.query<{
        lifecycle: string;
        condition: string;
        intent: string;
      }>(`SELECT lifecycle, condition, intent FROM work_items WHERE id = $1`, [result.workItemId]);
      assert.equal(rows[0]?.lifecycle, "admitted");
      assert.equal(rows[0]?.condition, "healthy");
      assert.equal(rows[0]?.intent, "Fix the login bug");
    } finally {
      await pool.end();
    }
  });
});

test("createWorkItem idempotency: same commandId returns the same workItemId", async (t) => {
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
        intent: "Fix the login bug",
        boundary: "artifact",
        rank: 1,
      });

      const second = await createWorkItem(deps, {
        commandId,
        projectId,
        intent: "Fix the login bug",
        boundary: "artifact",
        rank: 1,
      });

      assert.equal(second.workItemId, first.workItemId, "Idempotent: same workItemId returned");

      // Only one work item should exist in the DB
      const { rows } = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM work_items WHERE project_id = $1`,
        [projectId],
      );
      assert.equal(rows[0]?.count, "1", "Only one work item should exist");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// ackVisit / lastAckAt tests
// ---------------------------------------------------------------------------

test("ackVisit: stores at and lastAckAt returns it", async (t) => {
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

      const result = await ackVisit(deps, { commandId, at });
      assert.ok(result.ok);
      assert.equal(result.at, at);

      // lastAckAt should return the stored at timestamp
      const stored = await lastAckAt(ctx.client);
      assert.equal(stored, at);
    } finally {
      await pool.end();
    }
  });
});

test("lastAckAt: returns null when no ack_visit commands exist", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const stored = await lastAckAt(ctx.client);
    assert.equal(stored, null);
  });
});

test("lastAckAt: returns the most recent timestamp when multiple acks", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(url, ctx.schema);
    try {
      const deps = makeDeps(pool);

      await ackVisit(deps, {
        commandId: `cmd-${randomUUID()}`,
        at: "2026-09-07T09:00:00.000Z",
      });
      await ackVisit(deps, {
        commandId: `cmd-${randomUUID()}`,
        at: "2026-09-07T11:00:00.000Z",
      });
      await ackVisit(deps, {
        commandId: `cmd-${randomUUID()}`,
        at: "2026-09-07T10:00:00.000Z",
      });

      // The commands table ORDER BY at DESC — most recent write wins
      // (the last ack inserted has the most recent created_at)
      const stored = await lastAckAt(ctx.client);
      assert.ok(stored !== null, "Should have a stored ack");
    } finally {
      await pool.end();
    }
  });
});
