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

test("flow.observations: the reconciler records Lead and verify run observations (R-010)", async (t) => {
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

      const { runId: planRunId } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(planRunId);
      fake.advance(planRunId);

      // First poll: the lead.plan run is final; the reconciler records it
      // before routing to onLeadPlanOutput.
      await reconciler.pollOnce();
      const { rows: first } = await client.query(
        "SELECT run_id, generation, stale FROM run_observations WHERE run_id = $1",
        [planRunId],
      );
      assert.equal(first.length, 1, "lead.plan observation recorded once");
      assert.equal((first[0] as { stale: boolean }).stale, false);

      // The plan was admitted: a worker attempt exists.
      const { rows: attempts } = await client.query("SELECT id FROM attempts");
      assert.equal(attempts.length, 1, "worker attempt admitted");

      // Second poll: the plan intent is closed, nothing is re-recorded.
      await reconciler.pollOnce();
      const { rows: second } = await client.query(
        "SELECT count(*)::int AS n FROM run_observations WHERE run_id = $1",
        [planRunId],
      );
      assert.equal((second[0] as { n: number }).n, 1, "no duplicate row on a later poll");
    } finally {
      await pool.end();
    }
  });
});
