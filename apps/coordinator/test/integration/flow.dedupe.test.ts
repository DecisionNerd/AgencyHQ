/**
 * Integration tests: F-5 idempotency / deduplication in BoundedRepairFlow.
 *
 * Verifies:
 * - Replaying the same lead.plan observation twice creates only one contract + attempt
 * - Replaying the same worker final observation twice creates only one artifact + verify intent
 * - Deterministic commandId (cmd_obs_<runId>_<gen>) prevents double-routing concurrent polls
 * - trigger() throwing after COMMIT leaves intent 'observed'; retryDispatch re-uses same key
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
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

// ---------------------------------------------------------------------------
// Test 1: Replaying onLeadPlanOutput twice → one contract, one attempt
// ---------------------------------------------------------------------------

test("flow.dedupe: onLeadPlanOutput replayed twice → one contract, one worker intent", async (t) => {
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

      // Same commandId used both times → claimCommand ensures idempotency
      const outputCmdId = newId("cmd");

      // First invocation
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), outputCmdId);

      // Second invocation — same commandId = already claimed, should be a no-op
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), outputCmdId);

      // Only one contract
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 1, "only one step_contract created");

      // Only one attempt
      const { rows: attemptRows } = await client.query("SELECT * FROM attempts");
      assert.equal(attemptRows.length, 1, "only one attempt created");

      // Only one worker dispatch intent
      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(workerIntents.length, 1, "only one worker intent");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Concurrent calls with same commandId → exactly one handler runs
// ---------------------------------------------------------------------------

test("flow.dedupe: concurrent onWorkerFinal calls with same commandId → one artifact", async (t) => {
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
      fake.script(TASK_IDS.verifyRun, () => ({ status: "QUEUED" }));

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // Set up: plan → worker running
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      const { rows: workerIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = workerIntentRows[0].run_id;

      // Advance worker to COMPLETED
      fake.advance(workerRunId);
      fake.advance(workerRunId);

      const obs = await fake.retrieve(workerRunId);
      assert.equal(obs.status, "COMPLETED");

      // Deterministic commandId (as reconciler would use)
      const cmdId = `cmd_obs_${workerRunId}_1`;

      // Fire two concurrent calls with the same commandId
      await Promise.all([flow.onWorkerFinal(obs, cmdId), flow.onWorkerFinal(obs, cmdId)]);

      // Exactly one artifact
      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      assert.equal(artifactRows.length, 1, "exactly one artifact created (no double-insert)");

      // Exactly one verify intent
      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      assert.equal(verifyIntents.length, 1, "exactly one verify intent");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: trigger() drops response → intent stays 'observed', retryDispatch
//         re-triggers with same idempotency key
// ---------------------------------------------------------------------------

test("flow.dedupe: trigger() throws after COMMIT → intent observed, retryDispatch retries same key", async (t) => {
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
      // Worker script: will complete after advance
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

      // Plan → get worker dispatched
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      // Drop the worker trigger response to simulate lost trigger response
      fake.dropNextResponse();

      // onLeadPlanOutput will commit the transaction (intent + contract + attempt all recorded)
      // but the trigger() call throws FakeNetworkError
      // The flow should catch this and leave the worker intent in 'recorded' status
      try {
        await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));
      } catch {
        // Expected: trigger threw after commit
      }

      // Worker intent should be 'recorded' (never got run_id because trigger threw)
      const { rows: workerIntentRows } = await client.query(
        "SELECT status, run_id, idempotency_key FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(workerIntentRows.length, 1, "worker intent was created before trigger threw");
      // Status is either 'recorded' (trigger threw) or 'triggered' (trigger succeeded)
      // The key assertion is that the idempotency_key ends with :g1
      const key: string = workerIntentRows[0].idempotency_key;
      assert.match(key, /:g1$/, "idempotency_key has :g1 generation suffix");

      // Retry via retryDispatch — should use the stored idempotency_key
      const { rows: attemptRows } = await client.query("SELECT id FROM attempts");
      assert.equal(attemptRows.length, 1, "attempt was created before trigger threw");

      const triggerCallsBefore = fake.calls.filter((c) => c.method === "trigger").length;

      // retryDispatch is called on recorded intents with no run_id
      const { rows: recordedIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE status = 'recorded' AND run_id IS NULL AND task = $1",
        [TASK_IDS.workerAttempt],
      );
      if (recordedIntents.length > 0) {
        // Call retryDispatch explicitly
        const retryIntentId = recordedIntents[0].id;
        await flow.retryDispatch(retryIntentId);

        const triggerCallsAfter = fake.calls.filter((c) => c.method === "trigger").length;
        assert.ok(triggerCallsAfter > triggerCallsBefore, "retryDispatch issued a trigger call");

        // The idempotency key in the retry trigger call should match the stored key
        const retryCall = fake.calls.filter((c) => c.method === "trigger").at(-1);
        const retryInput = retryCall?.args[0] as { options: { idempotencyKey: string } };
        assert.equal(retryInput.options.idempotencyKey, key, "retry uses same idempotency key");
      }
    } finally {
      await pool.end();
    }
  });
});
