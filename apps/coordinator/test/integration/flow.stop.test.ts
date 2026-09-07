/**
 * Integration tests: F-2 stop/confirmStop wiring in BoundedRepairFlow + Reconciler.
 *
 * The Reconciler intercepts CANCELED/TIMED_OUT worker observations when the attempt
 * is in `stopping` state and routes them to handleStoppingWorker (confirmStop)
 * rather than onWorkerFinal.  These tests verify:
 *
 * - CANCELED worker + no survivors → attempt.status = 'stopped', no replacement
 * - CANCELED worker + survivors → attempt.status = 'uncertain', work_item.condition = 'uncertain'
 * - COMPLETED worker (stale, generation bumped by stop) → reconciler routes to
 *   onWorkerFinal which classifies as stale → no verify dispatched
 * - Worker intent idempotency_key carries :g1 generation suffix (F-2)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { applyObservation, createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { stopAttempt } from "../../src/commands/stop.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import { Reconciler } from "../../src/flow/observe.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { goodPlanOutput, workerCompletedOutput } from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: ["package.json", "pnpm-lock.yaml"],
});

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

function makeFlowDeps(pool: ReturnType<typeof createPool>, fake: FakeExecutionRuntime): FlowDeps {
  return {
    pool,
    runtime: fake,
    clock,
    ids,
    profile: {
      id: "host",
      enforcement: {
        worktree: "before_action",
        fs_isolation: "advisory",
        cpu_memory: "advisory",
        duration: "before_action",
        capability: "before_action",
        output_paths: "on_output",
        push: "before_action",
        integrate: "before_action",
        termination: "trusted_observation",
        egress_spend: "advisory",
        nested_agents: "before_action",
      },
    },
    config: {
      worktreeBase: "/worktrees",
      workerModel: "openai/gpt-5.6-terra",
      leadModel: "openai/gpt-5.6-sol",
      reviewerModel: "openai/gpt-5.6-sol",
      verifierName: "agencyhq-verifier",
    },
    profileResolver: FAKE_PROFILE_RESOLVER,
  };
}

type DbClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

// ---------------------------------------------------------------------------
// Helper: run plan + onLeadPlanOutput, return worker run id + attempt id
// ---------------------------------------------------------------------------

async function setupWorkerRunning(
  deps: FlowDeps,
  flow: BoundedRepairFlow,
  fake: FakeExecutionRuntime,
  workItemId: string,
  client: DbClient,
): Promise<{ workerRunId: string; attemptId: string }> {
  const planCmdId = newId("cmd");
  const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
  fake.advance(planRunId);
  fake.advance(planRunId);

  await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

  const { rows: workerIntentRows } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  );
  const rows = workerIntentRows as { id: string; run_id: string; attempt_id: string }[];
  assert.equal(rows.length, 1, "worker intent created");
  assert.ok(rows[0], "worker intent row exists");
  const workerRunId = rows[0].run_id;
  assert.ok(workerRunId, "worker run triggered");

  const { rows: attemptRows } = await client.query("SELECT id FROM attempts");
  const arows = attemptRows as { id: string }[];
  assert.equal(arows.length, 1, "attempt created");
  assert.ok(arows[0], "attempt row exists");

  return { workerRunId, attemptId: arows[0].id };
}

// ---------------------------------------------------------------------------
// Test 1: CANCELED worker + no survivors → attempt.status = 'stopped'
// ---------------------------------------------------------------------------

test("flow.stop: CANCELED worker + no survivors → attempt stopped, no replacement", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      // Worker will be stopped externally; script keeps it EXECUTING until cancel
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      // Stop → revokeGeneration (gen 1→2, status→stopping) + cancel run
      await stopAttempt(
        { pool, runtime: fake, clock },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "user requested stop" },
      );

      const { rows: s } = await client.query(
        "SELECT status, generation FROM attempts WHERE id = $1",
        [attemptId],
      );
      const sr = s as { status: string; generation: number }[];
      assert.equal(sr[0]?.status, "stopping", "attempt is stopping");
      assert.equal(sr[0]?.generation, 2, "generation bumped");

      // Provide empty survivors evidence → confirmStop yields 'stopped'
      fake.setMetadata(workerRunId, { survivors: [] });

      // Reconciler: sees CANCELED + stopping → handleStoppingWorker → confirmStop
      await reconciler.pollOnce();

      const { rows: f } = await client.query("SELECT status FROM attempts WHERE id = $1", [
        attemptId,
      ]);
      const fr = f as { status: string }[];
      assert.equal(fr[0]?.status, "stopped", "attempt status is stopped");

      const { rows: allA } = await client.query("SELECT id FROM attempts");
      assert.equal(allA.length, 1, "no replacement attempt");

      const { rows: vIntents } = await client.query(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      assert.equal(vIntents.length, 0, "no verify intent dispatched");

      const { rows: wIntents } = await client.query(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const wr = wIntents as { status: string }[];
      assert.equal(wr[0]?.status, "observed", "worker intent closed");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: CANCELED worker + survivors → attempt.status = 'uncertain'
// ---------------------------------------------------------------------------

test("flow.stop: CANCELED worker + survivors → attempt uncertain, work_item uncertain", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "user requested stop" },
      );

      // Non-empty survivors → confirmStop yields 'uncertain'
      fake.setMetadata(workerRunId, { survivors: [{ pid: 42, name: "pnpm" }] });

      await reconciler.pollOnce();

      const { rows: f } = await client.query("SELECT status FROM attempts WHERE id = $1", [
        attemptId,
      ]);
      const fr = f as { status: string }[];
      assert.equal(fr[0]?.status, "uncertain", "attempt status is uncertain");

      const { rows: wi } = await client.query("SELECT condition FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      const wir = wi as { condition: string }[];
      assert.equal(wir[0]?.condition, "uncertain", "work item condition is uncertain");

      const { rows: allA } = await client.query("SELECT id FROM attempts");
      assert.equal(allA.length, 1, "no replacement attempt");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Worker COMPLETED → stop revokes generation → stale → no verify
// ---------------------------------------------------------------------------

test("flow.stop: worker COMPLETED then stop revokes gen → stale observation, no verify dispatched", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, {
            commitId: "deadbeef1234567890deadbeef1234567890dead",
          }),
        };
      });

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      // Worker completes BEFORE stop is called
      fake.advance(workerRunId); // EXECUTING
      fake.advance(workerRunId); // COMPLETED

      const obs = await fake.retrieve(workerRunId);
      assert.equal(obs.status, "COMPLETED", "worker completed");

      // Stop revokes generation (gen 1→2, status→stopping)
      // cancel() on already-COMPLETED run is a no-op in FakeRuntime
      await stopAttempt(
        { pool, runtime: fake, clock },
        {
          attemptId,
          commandId: newId("cmd"),
          actor: "human",
          reason: "user stop after completion race",
        },
      );

      // Reconciler: sees COMPLETED (not CANCELED) → routes to onWorkerFinal
      // onWorkerFinal: observedGeneration=1 (from :g1 key), currentGeneration=2 → stale
      await reconciler.pollOnce();

      // No verify intent (stale observation)
      const { rows: vIntents } = await client.query(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      assert.equal(vIntents.length, 0, "no verify intent dispatched (stale observation skipped)");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Worker intent idempotency_key encodes :g1 generation suffix (F-2)
// ---------------------------------------------------------------------------

test("flow.stop: worker dispatch_intent idempotency_key encodes generation (:g1)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, {
            commitId: "deadbeef1234567890deadbeef1234567890dead",
          }),
        };
      });

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      const { rows: workerIntentRows } = await client.query(
        "SELECT idempotency_key FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const rows = workerIntentRows as { idempotency_key: string }[];
      assert.equal(rows.length, 1);
      assert.ok(rows[0], "worker intent row exists");
      const key = rows[0].idempotency_key;

      assert.match(key, /:g1$/, `worker intent key should end with :g1, got ${key}`);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (i): CANCELED + checkpointCommit in metadata + empty survivors
//           → stopped, checkpoint_commit set, stale run_observations row
// ---------------------------------------------------------------------------

test("flow.stop: CANCELED with checkpointCommit in metadata + empty survivors → stopped, checkpoint_commit set, stale run_observations row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "stop test" },
      );

      // Metadata carries checkpointCommit and empty survivors (Trigger run final metadata)
      fake.setMetadata(workerRunId, { checkpointCommit: "9324b35abc", survivors: [] });

      await reconciler.pollOnce();

      // (a) attempt stopped with checkpointCommit recorded
      const { rows: ar } = await client.query<{ status: string; checkpoint_commit: string | null }>(
        "SELECT status, checkpoint_commit FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(ar[0]?.status, "stopped", "attempt is stopped");
      assert.equal(
        ar[0]?.checkpoint_commit,
        "9324b35abc",
        "checkpoint_commit recorded from metadata",
      );

      // (b) run_observations row exists for (workerRunId, dispatched generation=1) marked stale
      const { rows: obs } = await client.query<{ generation: number; stale: boolean }>(
        "SELECT generation, stale FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obs.length, 1, "exactly one run_observations row");
      assert.equal(obs[0]?.generation, 1, "dispatched generation = 1");
      assert.equal(obs[0]?.stale, true, "marked stale (generation revoked by stop)");

      // Intent closed as 'observed'
      const { rows: ir } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(ir[0]?.status, "observed", "worker intent closed as observed");

      // No replacement attempt
      const { rows: allA } = await client.query("SELECT id FROM attempts");
      assert.equal(allA.length, 1, "no replacement attempt");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (ii): Same observation delivered twice → duplicate no-op (R-010)
// ---------------------------------------------------------------------------

test("flow.stop: duplicate CANCELED observation (R-010) → second applyObservation is no-op, exactly one row, attempt still stopped", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "stop test" },
      );

      fake.setMetadata(workerRunId, { checkpointCommit: "9324b35abc", survivors: [] });

      // First delivery: reconciler records observation and calls confirmStop
      await reconciler.pollOnce();

      const { rows: ar1 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(ar1[0]?.status, "stopped", "attempt stopped after first poll");

      // Second delivery: same (runId, generation=1) via applyObservation directly — must be no-op
      const obs = await fake.retrieve(workerRunId);
      const dupResult = await applyObservation(client, {
        runId: workerRunId,
        generation: 1,
        attemptId,
        status: obs.status,
        payload: obs,
        observedAt: new Date(obs.observedAt),
      });
      assert.equal(dupResult, "duplicate", "second applyObservation is a duplicate no-op");

      // Still exactly one run_observations row
      const { rows: obsRows } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obsRows.length, 1, "still exactly one run_observations row");

      // Attempt still stopped
      const { rows: ar2 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(ar2[0]?.status, "stopped", "attempt still stopped after duplicate");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (iii): metadata survivors non-empty → uncertain, work_item uncertain (R-013)
// ---------------------------------------------------------------------------

test("flow.stop: CANCELED + metadata survivors non-empty (R-013) → attempt uncertain, work_item uncertain, run_observations row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "stop test" },
      );

      // Non-empty survivors → uncertain
      fake.setMetadata(workerRunId, { survivors: [{ pid: 999, name: "zombie" }] });

      await reconciler.pollOnce();

      // Attempt uncertain
      const { rows: ar } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(ar[0]?.status, "uncertain", "attempt is uncertain");

      // Work item condition uncertain
      const { rows: wi } = await client.query<{ condition: string }>(
        "SELECT condition FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wi[0]?.condition, "uncertain", "work_item condition is uncertain");

      // run_observations row exists (R-010 compliance)
      const { rows: obs } = await client.query<{ generation: number; stale: boolean }>(
        "SELECT generation, stale FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obs.length, 1, "run_observations row recorded");
      assert.equal(obs[0]?.generation, 1, "dispatched generation recorded");

      // No replacement attempt (R-013: no retry on uncertain)
      const { rows: allA } = await client.query("SELECT id FROM attempts");
      assert.equal(allA.length, 1, "no replacement attempt");
    } finally {
      await pool.end();
    }
  });
});
