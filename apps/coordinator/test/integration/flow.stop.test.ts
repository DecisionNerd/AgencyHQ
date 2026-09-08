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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// RW-4b tests (i)-(iv): uncertain stop outcome, stop.ndjson fallback, G-6
// ---------------------------------------------------------------------------

// Shared helper: make FlowDeps with injectable clock and optional worktreeBase
function makeFlowDepsWithClock(
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  clock2: { now: () => string },
  worktreeBase = "/worktrees",
): FlowDeps {
  return {
    pool,
    runtime: fake,
    clock: clock2,
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
      worktreeBase,
      workerModel: "openai/gpt-5.6-terra",
      leadModel: "openai/gpt-5.6-sol",
      reviewerModel: "openai/gpt-5.6-sol",
      verifierName: "agencyhq-verifier",
    },
    profileResolver: FAKE_PROFILE_RESOLVER,
  };
}

// ---------------------------------------------------------------------------
// RW-4b test (i): stop → CANCELED no evidence → pending → clock → uncertain
// ---------------------------------------------------------------------------

test("flow.stop (rw4b-i): stop + CANCELED no evidence → pending poll 1; past deadline → uncertain poll 2 (R-010)", async (t) => {
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

      let nowMs = Date.now();
      const clock2 = { now: () => new Date(nowMs).toISOString() };
      const fake = new FakeExecutionRuntime(() => new Date(nowMs).toISOString());
      const uncertainAfterMs = 500;

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDepsWithClock(pool, fake, clock2);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { uncertainAfterMs });

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock: clock2 },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "rw4b-i" },
      );

      // CANCELED with no output, no metadata → no evidence

      // Poll 1: within deadline → pending_confirmation; intent stays triggered
      await reconciler.pollOnce();

      const { rows: a1 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(a1[0]?.status, "stopping", "(rw4b-i) attempt still stopping after poll 1");

      const { rows: i1 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(i1[0]?.status, "triggered", "(rw4b-i) intent still triggered after poll 1");

      const { rows: o1 } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(o1.length, 1, "(rw4b-i) exactly one run_observations row after poll 1");

      // Advance clock past deadline
      nowMs += uncertainAfterMs + 200;

      // Poll 2: past deadline → uncertain
      await reconciler.pollOnce();

      const { rows: a2 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(a2[0]?.status, "uncertain", "(rw4b-i) attempt uncertain after poll 2");

      const { rows: wi } = await client.query<{ condition: string }>(
        "SELECT condition FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wi[0]?.condition, "uncertain", "(rw4b-i) work_item condition uncertain");

      const { rows: i2 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(i2[0]?.status, "observed", "(rw4b-i) intent closed after poll 2");

      const { rows: o2 } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(o2.length, 1, "(rw4b-i) still exactly one run_observations row (R-010)");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// RW-4b test (ii): stop.ndjson survivors [] → stopped, checkpoint from file (G-7)
// ---------------------------------------------------------------------------

test("flow.stop (rw4b-ii): stop.ndjson stop_done survivors [] → stopped, checkpoint_commit from file (G-7)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    const worktreeBase = join(tmpdir(), `agencyhq-rw4b-ii-${process.pid}-${Date.now()}`);

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const clock2 = { now: () => new Date().toISOString() };
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDepsWithClock(pool, fake, clock2, worktreeBase);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { uncertainAfterMs: 120_000 });

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock: clock2 },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "rw4b-ii" },
      );

      // Write stop.ndjson with empty survivors and a checkpoint commit (real adapter format)
      const runDir = join(worktreeBase, "runs", attemptId);
      await mkdir(runDir, { recursive: true });
      const lines = [
        JSON.stringify({ at: "2026-09-07T18:40:26.081Z", step: "abort_signal" }),
        JSON.stringify({
          at: "2026-09-07T18:40:26.081Z",
          step: "stop_start",
          order: "kill-first",
          pid: 34936,
          pgid: 34936,
        }),
        JSON.stringify({
          at: "2026-09-07T18:40:26.199Z",
          step: "killed",
          terminated: [34936],
          killed: [],
          survivors: [],
        }),
        JSON.stringify({
          at: "2026-09-07T18:40:26.264Z",
          step: "checkpoint",
          checkpointCommit: "filecommit99",
        }),
        JSON.stringify({ at: "2026-09-07T18:40:26.316Z", step: "stop_done", survivors: [] }),
      ].join("\n");
      await writeFile(join(runDir, "stop.ndjson"), lines, "utf-8");

      // No metadata on the run — file is the only evidence source

      await reconciler.pollOnce();

      const { rows: ar } = await client.query<{ status: string; checkpoint_commit: string | null }>(
        "SELECT status, checkpoint_commit FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(ar[0]?.status, "stopped", "(rw4b-ii) attempt stopped from stop.ndjson");
      assert.equal(ar[0]?.checkpoint_commit, "filecommit99", "(rw4b-ii) checkpoint from file");

      const { rows: ir } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(ir[0]?.status, "observed", "(rw4b-ii) intent closed");

      const { rows: allA } = await client.query("SELECT id FROM attempts");
      assert.equal(allA.length, 1, "(rw4b-ii) no replacement attempt");

      const { rows: obs } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obs.length, 1, "(rw4b-ii) one run_observations row");
    } finally {
      await pool.end();
      await rm(worktreeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// RW-4b test (iii): stop.ndjson survivors [123] → uncertain (G-7)
// ---------------------------------------------------------------------------

test("flow.stop (rw4b-iii): stop.ndjson survivors [123] → attempt uncertain, work_item uncertain (G-7)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPool(poolUrl.toString());

    const worktreeBase = join(tmpdir(), `agencyhq-rw4b-iii-${process.pid}-${Date.now()}`);

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);
      const clock2 = { now: () => new Date().toISOString() };
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDepsWithClock(pool, fake, clock2, worktreeBase);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { uncertainAfterMs: 120_000 });

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      await stopAttempt(
        { pool, runtime: fake, clock: clock2 },
        { attemptId, commandId: newId("cmd"), actor: "human", reason: "rw4b-iii" },
      );

      // Write stop.ndjson with non-empty survivors (real adapter format)
      const runDir = join(worktreeBase, "runs", attemptId);
      await mkdir(runDir, { recursive: true });
      const survivors123Lines = [
        JSON.stringify({ at: "2026-09-07T18:40:26.081Z", step: "abort_signal" }),
        JSON.stringify({
          at: "2026-09-07T18:40:26.081Z",
          step: "stop_start",
          order: "kill-first",
          pid: 34936,
          pgid: 34936,
        }),
        JSON.stringify({
          at: "2026-09-07T18:40:26.199Z",
          step: "killed",
          terminated: [],
          killed: [],
          survivors: [123],
        }),
        JSON.stringify({ at: "2026-09-07T18:40:26.316Z", step: "stop_done", survivors: [123] }),
      ].join("\n");
      await writeFile(join(runDir, "stop.ndjson"), survivors123Lines, "utf-8");

      await reconciler.pollOnce();

      const { rows: ar } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(
        ar[0]?.status,
        "uncertain",
        "(rw4b-iii) attempt uncertain from stop.ndjson survivors",
      );

      const { rows: wi } = await client.query<{ condition: string }>(
        "SELECT condition FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wi[0]?.condition, "uncertain", "(rw4b-iii) work_item condition uncertain");

      const { rows: ir } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(ir[0]?.status, "observed", "(rw4b-iii) intent closed");

      const { rows: obs } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obs.length, 1, "(rw4b-iii) one run_observations row");
    } finally {
      await pool.end();
      await rm(worktreeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// RW-4b test (iv): TIMED_OUT dispatched → auto-stop (coordinator) → uncertain (G-6)
// ---------------------------------------------------------------------------

test("flow.stop (rw4b-iv): TIMED_OUT dispatched attempt → auto-stop (actor coordinator), then uncertain; no replacement (G-6)", async (t) => {
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

      let nowMs = Date.now();
      const clock2 = { now: () => new Date(nowMs).toISOString() };
      const fake = new FakeExecutionRuntime(() => new Date(nowMs).toISOString());
      const uncertainAfterMs = 500;

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }, { status: "TIMED_OUT" }]);

      const deps = makeFlowDepsWithClock(pool, fake, clock2);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { uncertainAfterMs });

      const { workerRunId, attemptId } = await setupWorkerRunning(
        deps,
        flow,
        fake,
        workItemId,
        client,
      );

      // No stop command — run times out externally
      fake.advance(workerRunId); // QUEUED→EXECUTING
      fake.advance(workerRunId); // EXECUTING→TIMED_OUT

      const timedOutObs = await fake.retrieve(workerRunId);
      assert.equal(timedOutObs.status, "TIMED_OUT", "(rw4b-iv) run is TIMED_OUT");

      const { rows: pre } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(pre[0]?.status, "dispatched", "(rw4b-iv) attempt dispatched before poll");

      // Poll 1: reconciler auto-stops the attempt (actor coordinator), then pending
      await reconciler.pollOnce();

      const { rows: a1 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(
        a1[0]?.status,
        "stopping",
        "(rw4b-iv) attempt stopping after poll 1 (auto-stop)",
      );

      // Verify a transition row was inserted with actor=coordinator
      const { rows: tr } = await client.query<{ actor: string; to_state: string }>(
        "SELECT actor, to_state FROM transitions WHERE aggregate = 'attempt' AND aggregate_id = $1",
        [attemptId],
      );
      assert.ok(
        tr.some((r) => r.actor === "coordinator" && r.to_state === "stopping"),
        "(rw4b-iv) transition row with actor=coordinator, to_state=stopping",
      );

      const { rows: i1 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(i1[0]?.status, "triggered", "(rw4b-iv) intent still triggered after poll 1");

      const { rows: o1 } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(o1.length, 1, "(rw4b-iv) one run_observations row after poll 1");

      const { rows: allA1 } = await client.query("SELECT id FROM attempts");
      assert.equal(allA1.length, 1, "(rw4b-iv) no replacement attempt after poll 1");

      // Advance clock past deadline
      nowMs += uncertainAfterMs + 200;

      // Poll 2: past deadline → uncertain
      await reconciler.pollOnce();

      const { rows: a2 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(a2[0]?.status, "uncertain", "(rw4b-iv) attempt uncertain after poll 2");

      const { rows: wi } = await client.query<{ condition: string }>(
        "SELECT condition FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wi[0]?.condition, "uncertain", "(rw4b-iv) work_item condition uncertain");

      const { rows: i2 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(i2[0]?.status, "observed", "(rw4b-iv) intent closed after poll 2");

      const { rows: o2 } = await client.query<{ generation: number }>(
        "SELECT generation FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(o2.length, 1, "(rw4b-iv) still one run_observations row (R-010)");

      const { rows: allA2 } = await client.query("SELECT id FROM attempts");
      assert.equal(allA2.length, 1, "(rw4b-iv) no replacement attempt after poll 2");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// CR-2a: COMPLETED run race → stale_status guard fires → reconciler-route
// deadline → uncertain.
//
// The stop is injected inside onWorkerFinal's transaction via a pool/client
// wrapper (same technique as the scratchpad cr2.test.ts test B).  Asserts:
//   - command result = {skipped:"stale_status"}
//   - attempt = stopping gen 2
//   - no artifact, no verify.run trigger
//   - worker intent still open (J-1 fix keeps it triggered)
//   - after reconciler poll past uncertainAfterMs deadline → attempt uncertain
// ---------------------------------------------------------------------------

test("flow.stop (CR-2a): COMPLETED run race → stale_status; reconciler poll past deadline → uncertain", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const rawPool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);

      const commitId = "aabbccdd1234567890aabbccdd1234567890aabb";
      let nowMs = Date.now();
      const clock2 = { now: () => new Date(nowMs).toISOString() };
      const fake = new FakeExecutionRuntime(() => new Date(nowMs).toISOString());
      const uncertainAfterMs = 300;

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return { status: "COMPLETED", output: workerCompletedOutput(p.attemptId, { commitId }) };
      });

      // Pool wrapper: inject stop inside onWorkerFinal after INSERT INTO artifacts
      let injected = false;
      let attemptIdRef = "";
      // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
      const wrapClient = (c: any) =>
        // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
        new Proxy(c, {
          // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
          get(target: any, prop: string | symbol) {
            if (prop === "query") {
              // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
              return async (...args: any[]) => {
                const sql =
                  typeof args[0] === "string"
                    ? args[0]
                    : ((args[0] as { text?: string })?.text ?? "");
                if (!injected && sql.includes("INSERT INTO artifacts")) {
                  injected = true;
                  await stopAttempt(
                    { pool: rawPool, runtime: fake, clock: clock2 },
                    {
                      attemptId: attemptIdRef,
                      commandId: newId("cmd"),
                      actor: "human",
                      reason: "CR-2a race",
                    },
                  );
                }
                return target.query(...args);
              };
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      const wrappedPool = {
        query: (...a: Parameters<typeof rawPool.query>) => rawPool.query(...a),
        connect: async () => wrapClient(await rawPool.connect()),
        end: () => rawPool.end(),
      } as unknown as typeof rawPool;

      const deps = makeFlowDepsWithClock(wrappedPool, fake, clock2);
      const depsWithUncertain: FlowDeps = { ...deps, config: { ...deps.config, uncertainAfterMs } };
      const flow = new BoundedRepairFlow(depsWithUncertain);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        depsWithUncertain,
        flow,
        fake,
        workItemId,
        client,
      );
      attemptIdRef = attemptId;

      // Advance worker run to COMPLETED
      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const completedObs = await fake.retrieve(workerRunId);
      assert.equal(completedObs.status, "COMPLETED", "(CR-2a) obs is COMPLETED");

      // Direct call — stop is injected inside → stale_status
      const directCmd = newId("cmd");
      await flow.onWorkerFinal(completedObs, directCmd);

      assert.equal(injected, true, "(CR-2a) stop was injected inside onWorkerFinal");

      // Command result must be stale_status
      const { rows: cmdRows } = await client.query<{ result: unknown }>(
        "SELECT result FROM commands WHERE command_id = $1",
        [directCmd],
      );
      assert.deepEqual(
        cmdRows[0]?.result,
        { skipped: "stale_status" },
        "(CR-2a) command = stale_status",
      );

      // Attempt must be stopping gen 2
      const { rows: aRows } = await client.query<{ status: string; generation: number }>(
        "SELECT status, generation FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(aRows[0]?.status, "stopping", "(CR-2a) attempt stopping");
      assert.equal(aRows[0]?.generation, 2, "(CR-2a) gen 2");

      // No artifact
      const { rows: artRows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM artifacts",
      );
      assert.equal(artRows[0]?.n, 0, "(CR-2a) no artifact");

      // No verify.run trigger
      const verifyTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.verifyRun,
      );
      assert.equal(verifyTriggers.length, 0, "(CR-2a) no verify.run triggered");

      // Worker intent still open (J-1 fix: stale_status does not close intent)
      const { rows: iRows } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(iRows[0]?.status, "triggered", "(CR-2a) intent still triggered");

      // Reconciler poll 1: within deadline → pending (no evidence)
      const recDeps = makeFlowDepsWithClock(rawPool, fake, clock2);
      const recFlow = new BoundedRepairFlow({
        ...recDeps,
        config: { ...recDeps.config, uncertainAfterMs },
      });
      const rec = new Reconciler(
        { ...recDeps, config: { ...recDeps.config, uncertainAfterMs } },
        recFlow,
        { uncertainAfterMs },
      );

      await rec.pollOnce();
      const { rows: i2 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      // Still within deadline — intent stays triggered
      assert.equal(i2[0]?.status, "triggered", "(CR-2a) intent still triggered after poll 1");

      // Advance clock past uncertainAfterMs deadline
      nowMs += uncertainAfterMs + 100;

      // Reconciler poll 2: past deadline → uncertain
      await rec.pollOnce();
      const { rows: a3 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(a3[0]?.status, "uncertain", "(CR-2a) attempt uncertain after deadline");

      const { rows: wi } = await client.query<{ condition: string }>(
        "SELECT condition FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wi[0]?.condition, "uncertain", "(CR-2a) work_item condition uncertain");

      const { rows: i3 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(i3[0]?.status, "observed", "(CR-2a) intent closed after poll 2");

      // Only one run_observations row (R-010 dedup invariant)
      const { rows: obsRows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obsRows[0]?.n, 1, "(CR-2a) exactly one run_observations row");
    } finally {
      await rawPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// CR-2b: COMPLETED run race → stale_status; reconciler poll with survivors=[]
// metadata → attempt stopped.
// ---------------------------------------------------------------------------

test("flow.stop (CR-2b): COMPLETED run race → stale_status; reconciler poll with empty survivors → stopped", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);

    const poolUrl = new URL(DATABASE_URL!);
    poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const rawPool = createPool(poolUrl.toString());

    try {
      const { workItemId } = await seedProjectAndWorkItem(client);

      const commitId = "aabbccdd1234567890aabbccdd1234567890aabb";
      const clock2 = { now: () => new Date().toISOString() };
      const fake = new FakeExecutionRuntime();
      const uncertainAfterMs = 30_000; // large — evidence resolves before deadline

      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return { status: "COMPLETED", output: workerCompletedOutput(p.attemptId, { commitId }) };
      });

      // Pool wrapper: inject stop inside onWorkerFinal after INSERT INTO artifacts
      let injected = false;
      let attemptIdRef = "";
      // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
      const wrapClient = (c: any) =>
        // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
        new Proxy(c, {
          // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
          get(target: any, prop: string | symbol) {
            if (prop === "query") {
              // biome-ignore lint/suspicious/noExplicitAny: wrapper intentionally untyped
              return async (...args: any[]) => {
                const sql =
                  typeof args[0] === "string"
                    ? args[0]
                    : ((args[0] as { text?: string })?.text ?? "");
                if (!injected && sql.includes("INSERT INTO artifacts")) {
                  injected = true;
                  await stopAttempt(
                    { pool: rawPool, runtime: fake, clock: clock2 },
                    {
                      attemptId: attemptIdRef,
                      commandId: newId("cmd"),
                      actor: "human",
                      reason: "CR-2b race",
                    },
                  );
                }
                return target.query(...args);
              };
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      const wrappedPool = {
        query: (...a: Parameters<typeof rawPool.query>) => rawPool.query(...a),
        connect: async () => wrapClient(await rawPool.connect()),
        end: () => rawPool.end(),
      } as unknown as typeof rawPool;

      const deps = makeFlowDepsWithClock(wrappedPool, fake, clock2);
      const depsWithUncertain: FlowDeps = { ...deps, config: { ...deps.config, uncertainAfterMs } };
      const flow = new BoundedRepairFlow(depsWithUncertain);

      const { workerRunId, attemptId } = await setupWorkerRunning(
        depsWithUncertain,
        flow,
        fake,
        workItemId,
        client,
      );
      attemptIdRef = attemptId;

      // Advance worker run to COMPLETED and set survivors=[] metadata for evidence
      fake.advance(workerRunId);
      fake.advance(workerRunId);
      // Set metadata BEFORE retrieve so the observation carries survivors: []
      fake.setMetadata(workerRunId, { survivors: [] });
      const completedObs = await fake.retrieve(workerRunId);
      assert.equal(completedObs.status, "COMPLETED", "(CR-2b) obs is COMPLETED");

      // Direct call — stop is injected inside → stale_status
      const directCmd = newId("cmd");
      await flow.onWorkerFinal(completedObs, directCmd);

      assert.equal(injected, true, "(CR-2b) stop was injected inside onWorkerFinal");

      // Command result must be stale_status
      const { rows: cmdRows } = await client.query<{ result: unknown }>(
        "SELECT result FROM commands WHERE command_id = $1",
        [directCmd],
      );
      assert.deepEqual(
        cmdRows[0]?.result,
        { skipped: "stale_status" },
        "(CR-2b) command = stale_status",
      );

      // Attempt must be stopping gen 2
      const { rows: aRows } = await client.query<{ status: string; generation: number }>(
        "SELECT status, generation FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(aRows[0]?.status, "stopping", "(CR-2b) attempt stopping");
      assert.equal(aRows[0]?.generation, 2, "(CR-2b) gen 2");

      // No artifact, no verify.run trigger
      const { rows: artRows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM artifacts",
      );
      assert.equal(artRows[0]?.n, 0, "(CR-2b) no artifact");
      const verifyTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.verifyRun,
      );
      assert.equal(verifyTriggers.length, 0, "(CR-2b) no verify.run triggered");

      // Intent still open
      const { rows: iRows } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(iRows[0]?.status, "triggered", "(CR-2b) intent still triggered");

      // Reconciler poll: evidence present (survivors=[]) → stopped immediately
      const recDeps = makeFlowDepsWithClock(rawPool, fake, clock2);
      const recFlow = new BoundedRepairFlow({
        ...recDeps,
        config: { ...recDeps.config, uncertainAfterMs },
      });
      const rec = new Reconciler(
        { ...recDeps, config: { ...recDeps.config, uncertainAfterMs } },
        recFlow,
        { uncertainAfterMs },
      );

      await rec.pollOnce();

      const { rows: a2 } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(a2[0]?.status, "stopped", "(CR-2b) attempt stopped with empty survivors");

      const { rows: i2 } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(i2[0]?.status, "observed", "(CR-2b) intent closed after poll");

      // Exactly one run_observations row (R-010)
      const { rows: obsRows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      assert.equal(obsRows[0]?.n, 1, "(CR-2b) exactly one run_observations row");
    } finally {
      await rawPool.end();
    }
  });
});
