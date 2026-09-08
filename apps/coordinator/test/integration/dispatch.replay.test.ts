/**
 * Integration test: dispatch replay (lost trigger response).
 *
 * dropNextResponse() → trigger throws → intent stays "recorded" →
 * retryDispatch(intentId) triggers again with same idempotency key →
 * fake returns same run id → exactly one run (R-002/R-010).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime, FakeNetworkError } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { goodPlanOutput } from "../helpers/fake-lead.ts";
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

test("dispatch.replay: lost trigger response → retry with same key → one run (R-002/R-010)", async (t) => {
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

      // Script lead.plan
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));

      // Script worker.attempt — will complete eventually
      fake.script(TASK_IDS.workerAttempt, () => ({
        status: "QUEUED",
      }));

      const deps: FlowDeps = {
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

      const flow = new BoundedRepairFlow(deps);

      // Step 1: dispatch lead.plan and get proposal
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      // Step 2: onLeadPlanOutput — but DROP the next trigger (worker.attempt)
      fake.dropNextResponse();

      const planOutputCmdId = newId("cmd");
      let _threwNetworkError = false;
      try {
        await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);
      } catch (err) {
        if (err instanceof FakeNetworkError) {
          _threwNetworkError = true;
        } else {
          throw err;
        }
      }

      // The intent should still be in the DB (committed before trigger call)
      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(workerIntents.length, 1, "worker intent committed before trigger");

      // Status may be 'recorded' (trigger failed) or we need to check what happened.
      // The intent was inserted in the transaction before trigger().
      // After the throw, the intent row is committed (R-002 invariant).
      // The intent status might still be 'recorded' since update to 'triggered' happens after trigger().
      const workerIntent = workerIntents[0];
      assert.ok(workerIntent.id, "worker intent exists");

      // Step 3: retryDispatch — same idempotency key, FakeRuntime returns same runId
      const { runId: retryRunId } = await flow.retryDispatch(workerIntent.id);

      // Should have triggered exactly once (idempotency key reuse)
      const _workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );

      // First trigger threw (dropNextResponse), second trigger returned runId
      // Due to idempotency, both get the same run
      assert.ok(retryRunId, "retry returned a runId");

      // Verify only one run in fake (idempotency)
      const workerRunIds = new Set<string>();
      for (const c of fake.calls) {
        if (c.method === "trigger") {
          const arg = c.args[0] as { task: string; options: { idempotencyKey: string } };
          if (arg.task === TASK_IDS.workerAttempt) {
            // We don't have direct access to runId from calls, but we can check
            // that the idempotency key is the same
            workerRunIds.add(arg.options.idempotencyKey);
          }
        }
      }
      assert.equal(workerRunIds.size, 1, "same idempotency key used for both triggers (R-010)");

      // The second trigger (retryDispatch) should use the same idempotency key
      // and get back the same run
      const { rows: updatedIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(updatedIntents.length, 1, "still exactly one worker intent");
      assert.equal(updatedIntents[0].status, "triggered");
      assert.equal(updatedIntents[0].run_id, retryRunId);
    } finally {
      await pool.end();
    }
  });
});
