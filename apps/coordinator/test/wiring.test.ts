/**
 * Wiring test: createApp with real commandHandlers and BoundedRepairFlow
 * over FakeExecutionRuntime and a Postgres test schema.
 *
 * C4 criterion: ensures the HTTP → flow → command handler wiring is correct.
 * Skips without DATABASE_URL.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { digestOf, HOST_PROFILE, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { CHECK_CATALOG, profileDigest, resolveProfile } from "@agencyhq/verification";
import pg from "pg";
import { FakeExecutionRuntime } from "../../../trigger/src/client/fake.ts";

import { createApp } from "../src/app.ts";
import { commandHandlers } from "../src/commands/index.ts";
import { BoundedRepairFlow } from "../src/flow/bounded-repair.ts";
import { Reconciler } from "../src/flow/observe.ts";
import type { FlowDeps } from "../src/flow/types.ts";
import { seedProjectAndWorkItem } from "./helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a schema-aware pool that always sets the search_path. */
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

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

function makeProfileResolver() {
  return (profileId: string) => {
    const profile = resolveProfile(profileId);
    const digest = String(profileDigest(profile));
    const checks = profile.checks.map((checkId) => {
      const def = CHECK_CATALOG[checkId];
      if (!def) throw new Error(`Unknown check: ${checkId}`);
      return {
        id: def.id,
        version: def.version,
        command: def.command,
        timeoutSeconds: def.timeoutSeconds,
      };
    });
    return Promise.resolve({ digest, checks, protectedPaths: profile.protectedPaths });
  };
}

function makeConfig() {
  return {
    databaseUrl: DATABASE_URL ?? "",
    triggerApiUrl: "",
    triggerSecretKey: "",
    runtime: "fake" as const,
    worktreeBase: "/tmp/agencyhq-wiring-test",
    workerModel: "openai/gpt-5.6-terra",
    leadModel: "openai/gpt-5.6-sol",
    reviewerModel: "openai/gpt-5.6-sol",
    reconcileIntervalMs: 60000,
    freshnessStaleMs: 30000,
    uncertainAfterMs: 120000,
    port: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("wiring: POST /api/commands kind=unknown → 400", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();

    const flowDeps: FlowDeps = {
      pool,
      runtime: fake,
      clock,
      ids,
      profile: HOST_PROFILE,
      config: {
        worktreeBase: "/tmp/agencyhq-wiring-test",
        workerModel: "openai/gpt-5.6-terra",
        leadModel: "openai/gpt-5.6-sol",
        reviewerModel: "openai/gpt-5.6-sol",
        verifierName: "agencyhq/verify.run",
      },
      profileResolver: makeProfileResolver(),
    };

    const flow = new BoundedRepairFlow(flowDeps);
    const reconciler = new Reconciler(flowDeps, flow);
    const commands = commandHandlers({ pool, runtime: fake, clock });

    const app = createApp({
      pool,
      flow,
      reconciler: {
        freshness: () => ({ lastPollAt: clock.now(), stale: false }),
      },
      runtime: fake,
      config: makeConfig(),
      commands,
    });

    try {
      const res = await app.request("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: randomUUID(), kind: "not_a_real_kind" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /unknown/i);
    } finally {
      reconciler.stop();
      await pool.end();
    }
  });
});

test("wiring: POST /api/commands kind=create_work_item → row exists", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();

    const flowDeps: FlowDeps = {
      pool,
      runtime: fake,
      clock,
      ids,
      profile: HOST_PROFILE,
      config: {
        worktreeBase: "/tmp/agencyhq-wiring-test",
        workerModel: "openai/gpt-5.6-terra",
        leadModel: "openai/gpt-5.6-sol",
        reviewerModel: "openai/gpt-5.6-sol",
        verifierName: "agencyhq/verify.run",
      },
      profileResolver: makeProfileResolver(),
    };

    const flow = new BoundedRepairFlow(flowDeps);
    const reconciler = new Reconciler(flowDeps, flow);
    const commands = commandHandlers({ pool, runtime: fake, clock });

    const app = createApp({
      pool,
      flow,
      reconciler: {
        freshness: () => ({ lastPollAt: clock.now(), stale: false }),
      },
      runtime: fake,
      config: makeConfig(),
      commands,
    });

    // Seed a project to get a projectId
    const { projectId } = await seedProjectAndWorkItem(client);

    try {
      const commandId = randomUUID();
      const res = await app.request("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandId,
          kind: "create_work_item",
          projectId,
          intent: "Wiring test work item",
          boundary: "artifact",
          rank: 2,
        }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { result: { ok: boolean; workItemId: string } };
      assert.equal(body.result.ok, true);
      assert.ok(body.result.workItemId, "workItemId present");

      // Verify the row exists in the DB
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM work_items WHERE id = $1",
        [body.result.workItemId],
      );
      assert.equal(rows.length, 1, "work item row exists");
    } finally {
      reconciler.stop();
      await pool.end();
    }
  });
});

test("wiring: POST /api/commands kind=plan → lead.plan trigger recorded", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();

    // Script lead.plan to immediately complete
    fake.script(TASK_IDS.leadPlan, () => ({
      status: "QUEUED" as const,
    }));

    const flowDeps: FlowDeps = {
      pool,
      runtime: fake,
      clock,
      ids,
      profile: HOST_PROFILE,
      config: {
        worktreeBase: "/tmp/agencyhq-wiring-test",
        workerModel: "openai/gpt-5.6-terra",
        leadModel: "openai/gpt-5.6-sol",
        reviewerModel: "openai/gpt-5.6-sol",
        verifierName: "agencyhq/verify.run",
      },
      profileResolver: makeProfileResolver(),
    };

    const flow = new BoundedRepairFlow(flowDeps);
    const reconciler = new Reconciler(flowDeps, flow);
    const commands = commandHandlers({ pool, runtime: fake, clock });

    const app = createApp({
      pool,
      flow,
      reconciler: {
        freshness: () => ({ lastPollAt: clock.now(), stale: false }),
      },
      runtime: fake,
      config: makeConfig(),
      commands,
    });

    // Seed a project and work item
    const { workItemId } = await seedProjectAndWorkItem(client);

    try {
      const commandId = newId("cmd");
      const res = await app.request("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId, kind: "plan", workItemId }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      // Verify a lead.plan trigger call was recorded on the fake
      const triggerCalls = fake.calls.filter(
        (c) =>
          c.method === "trigger" &&
          typeof c.args[0] === "object" &&
          c.args[0] !== null &&
          (c.args[0] as { task: string }).task === TASK_IDS.leadPlan,
      );
      assert.ok(triggerCalls.length > 0, "lead.plan trigger call recorded");
    } finally {
      reconciler.stop();
      await pool.end();
    }
  });
});

test("wiring: POST /api/commands kind=stop → fake cancel called", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();

    const flowDeps: FlowDeps = {
      pool,
      runtime: fake,
      clock,
      ids,
      profile: HOST_PROFILE,
      config: {
        worktreeBase: "/tmp/agencyhq-wiring-test",
        workerModel: "openai/gpt-5.6-terra",
        leadModel: "openai/gpt-5.6-sol",
        reviewerModel: "openai/gpt-5.6-sol",
        verifierName: "agencyhq/verify.run",
      },
      profileResolver: makeProfileResolver(),
    };

    const flow = new BoundedRepairFlow(flowDeps);
    const reconciler = new Reconciler(flowDeps, flow);
    const commands = commandHandlers({ pool, runtime: fake, clock });

    const app = createApp({
      pool,
      flow,
      reconciler: {
        freshness: () => ({ lastPollAt: clock.now(), stale: false }),
      },
      runtime: fake,
      config: makeConfig(),
      commands,
    });

    // Seed the tables for a dispatched attempt (using raw SQL like stop.test.ts)
    const projectId = `prj-${randomUUID()}`;
    const workItemId = `wi-${randomUUID()}`;
    const contractId = `sc-${randomUUID()}`;
    const attemptId = `att-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;

    await client.query(
      `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '1')`,
      [projectId],
    );
    await client.query(
      `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
       VALUES ($1, $2, 1, 'stop test', 'artifact', 'admitted', 'healthy')`,
      [workItemId, projectId],
    );
    await client.query(
      `INSERT INTO step_contracts
         (id, work_item_id, project_id, version, base_revision, inputs, criteria,
          criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
          human_required, status)
       VALUES ($1, $2, $3, 1, 'abc123', '{}', '[]', 'cdigest', 'node-pnpm-v1', 'pdigest',
               '{}', '[]', false, 'active')`,
      [contractId, workItemId, projectId],
    );
    await client.query(
      `INSERT INTO attempts (id, contract_id, contract_version, generation, status, run_id, budget_remaining)
       VALUES ($1, $2, 1, 1, 'running', $3, 100)`,
      [attemptId, contractId, runId],
    );

    // Register the run_id in the fake so cancel works
    fake.script(TASK_IDS.workerAttempt, () => ({ status: "EXECUTING" as const }));

    try {
      const commandId = randomUUID();
      const res = await app.request("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandId,
          kind: "stop",
          attemptId,
          actor: "human",
          reason: "wiring test stop",
        }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      // Verify fake.cancel was called
      const cancelCalls = fake.calls.filter((c) => c.method === "cancel");
      assert.ok(cancelCalls.length > 0, "cancel was called on the fake runtime");
    } finally {
      reconciler.stop();
      await pool.end();
    }
  });
});

test("wiring: GET /api/return-view returns 200 with seeded work item", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();

    const flowDeps: FlowDeps = {
      pool,
      runtime: fake,
      clock,
      ids,
      profile: HOST_PROFILE,
      config: {
        worktreeBase: "/tmp/agencyhq-wiring-test",
        workerModel: "openai/gpt-5.6-terra",
        leadModel: "openai/gpt-5.6-sol",
        reviewerModel: "openai/gpt-5.6-sol",
        verifierName: "agencyhq/verify.run",
      },
      profileResolver: makeProfileResolver(),
    };

    const flow = new BoundedRepairFlow(flowDeps);
    const reconciler = new Reconciler(flowDeps, flow);
    const commands = commandHandlers({ pool, runtime: fake, clock });

    const app = createApp({
      pool,
      flow,
      reconciler: {
        freshness: () => ({ lastPollAt: clock.now(), stale: false }),
      },
      runtime: fake,
      config: makeConfig(),
      commands,
    });

    // Seed a project and work item
    const { workItemId } = await seedProjectAndWorkItem(client, {
      intent: "wiring return-view test",
      boundary: "artifact",
    });

    try {
      const res = await app.request("/api/return-view");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        mainEffort: string | null;
        continuing: unknown[];
        changedSinceLastVisit: unknown[];
      };
      // The seeded work item should appear somewhere in the return view
      const allIds = [
        body.mainEffort,
        ...(Array.isArray(body.continuing)
          ? body.continuing.map((item: unknown) => (item as { id?: string }).id)
          : []),
        ...(Array.isArray(body.changedSinceLastVisit)
          ? body.changedSinceLastVisit.map((item: unknown) => (item as { id?: string }).id)
          : []),
      ];
      assert.ok(
        allIds.some((id) => id === workItemId),
        `work item ${workItemId} not found in return view`,
      );
    } finally {
      reconciler.stop();
      await pool.end();
    }
  });
});
