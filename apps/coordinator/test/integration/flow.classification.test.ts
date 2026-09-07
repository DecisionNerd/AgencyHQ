/**
 * Integration test: observation classification.
 *
 * 1. timed_out with budget 2 → second Attempt created and triggered (auto-retry)
 * 2. path_violation → quarantined, Finding recorded, no retry
 * 3. duplicate observation → no second Artifact
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import {
  goodPlanOutput,
  workerCompletedOutput,
  workerPathViolationOutput,
  workerTimedOutOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: ["package.json"],
});

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

const HOST_PROFILE: FlowDeps["profile"] = {
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
};

function makeDeps(pool: ReturnType<typeof createPool>, fake: FakeExecutionRuntime): FlowDeps {
  return {
    pool,
    runtime: fake,
    clock,
    ids,
    profile: HOST_PROFILE,
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

// ---------------------------------------------------------------------------
// Test 1: timed_out → auto-retry with budget 2
// ---------------------------------------------------------------------------

test("flow.classification: timed_out with budget 2 → second attempt created (auto-retry)", async (t) => {
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

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));

      // First worker: TIMED_OUT with output (adapter confirmed)
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "TIMED_OUT",
          output: workerTimedOutOutput(p.attemptId),
          metadata: { survivors: [] },
        };
      });

      const deps = makeDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // plan
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      // Script second worker attempt before plan output (it'll be triggered later)
      // We need to re-script after first worker runs
      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);

      const { rows: workerIntents1 } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1 ORDER BY created_at",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(workerIntents1.length, 1, "one worker intent");
      const firstWorkerRunId = workerIntents1[0].run_id;

      // Advance first worker to TIMED_OUT
      fake.advance(firstWorkerRunId);
      fake.advance(firstWorkerRunId);

      const timedOutObs = await fake.retrieve(firstWorkerRunId);
      assert.equal(timedOutObs.status, "TIMED_OUT");

      // Script second worker (new attempt)
      fake.script(TASK_IDS.workerAttempt, () => ({ status: "QUEUED" }));

      // onWorkerFinal for timed_out → should create new attempt
      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(timedOutObs, workerFinalCmdId);

      // Two attempts now
      const { rows: attemptRows } = await client.query(
        "SELECT * FROM attempts ORDER BY created_at",
      );
      assert.equal(attemptRows.length, 2, "two attempts created");
      assert.equal(attemptRows[0].status, "failed", "first attempt failed");
      // Second attempt should be admitted/dispatched
      assert.ok(
        ["admitted", "dispatched"].includes(attemptRows[1].status),
        `second attempt in expected status (got: ${attemptRows[1].status})`,
      );

      // Two worker.attempt triggers
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 2, "worker.attempt triggered twice");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: path_violation → quarantined, Finding recorded, no retry
// ---------------------------------------------------------------------------

test("flow.classification: path_violation → quarantined, Finding recorded, no retry", async (t) => {
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

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));

      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerPathViolationOutput(p.attemptId),
        };
      });

      const deps = makeDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);

      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = workerIntents[0].run_id;

      fake.advance(workerRunId);
      fake.advance(workerRunId);

      const pathViolObs = await fake.retrieve(workerRunId);
      assert.equal(pathViolObs.status, "COMPLETED");

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(pathViolObs, workerFinalCmdId);

      // Attempt quarantined
      const { rows: attemptRows } = await client.query("SELECT * FROM attempts");
      assert.equal(attemptRows.length, 1, "only one attempt");
      assert.equal(attemptRows[0].status, "quarantined", "attempt quarantined");

      // Finding recorded
      const { rows: findingRows } = await client.query("SELECT * FROM findings");
      assert.ok(findingRows.length >= 1, "finding(s) recorded");
      const pathViolFinding = findingRows.find(
        (f: { kind: string }) => f.kind === "scope_violation",
      );
      assert.ok(pathViolFinding, "scope_violation finding");

      // No new attempt (no retry for contract failure)
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 1, "only one worker.attempt trigger (no retry)");

      // No verify.run triggered
      const verifyTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.verifyRun,
      );
      assert.equal(verifyTriggers.length, 0, "no verify.run triggered");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: duplicate observation → no second Artifact
// ---------------------------------------------------------------------------

test("flow.classification: duplicate observation → no second Artifact", async (t) => {
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

      const commitId = "aabbccdd1234567890aabbccdd1234567890aabb";

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));

      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, { commitId }),
        };
      });

      fake.script(TASK_IDS.verifyRun, () => ({
        status: "QUEUED",
      }));

      const deps = makeDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);

      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = workerIntents[0].run_id;

      fake.advance(workerRunId);
      fake.advance(workerRunId);

      const workerObs = await fake.retrieve(workerRunId);

      // First observation
      const cmd1 = newId("cmd");
      await flow.onWorkerFinal(workerObs, cmd1);

      // One artifact
      const { rows: artifacts1 } = await client.query("SELECT * FROM artifacts");
      assert.equal(artifacts1.length, 1, "one artifact after first observation");

      // Second (duplicate) observation — same runId, same generation
      const cmd2 = newId("cmd");
      await flow.onWorkerFinal(workerObs, cmd2);

      // Still one artifact
      const { rows: artifacts2 } = await client.query("SELECT * FROM artifacts");
      assert.equal(artifacts2.length, 1, "still one artifact after duplicate observation");

      // Same verify.run trigger count (dedup at observation level)
      const verifyTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.verifyRun,
      );
      assert.equal(verifyTriggers.length, 1, "verify.run triggered only once");
    } finally {
      await pool.end();
    }
  });
});
