/**
 * Integration test: proposal-only path.
 *
 * A widening proposal yields a Decision with outcome pending_human and
 * NO step_contract row and NO worker.attempt trigger (R-001/R-020).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { badPlanOutput, goodPlanOutput } from "../helpers/fake-lead.ts";
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

test("flow.proposal-only: widening proposal → pending_human, no worker dispatch", async (t) => {
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
        output: badPlanOutput(),
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

      // plan → dispatch lead.plan
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      assert.ok(planIntentId);

      // Advance to COMPLETED
      fake.advance(planRunId);
      fake.advance(planRunId);

      // onLeadPlanOutput with BAD proposal (widens scope)
      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, badPlanOutput(), planOutputCmdId);

      // No StepContract created
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 0, "no step_contract created (R-001)");

      // No worker.attempt trigger
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 0, "worker.attempt NOT triggered (R-020)");

      // Decision recorded with pending_human outcome
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'plan'",
      );
      assert.equal(decisionRows.length, 1, "plan decision recorded");
      assert.equal(decisionRows[0].outcome, "pending_human", "decision outcome = pending_human");

      // Idempotency: calling onLeadPlanOutput again does nothing (same commandId)
      await flow.onLeadPlanOutput(planIntentId, badPlanOutput(), planOutputCmdId);
      const { rows: decisionRows2 } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'plan'",
      );
      assert.equal(decisionRows2.length, 1, "idempotent: still only 1 decision");
    } finally {
      await pool.end();
    }
  });
});

test("flow.proposal-only: good proposal works (sanity check)", async (t) => {
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

      const planCmdId = newId("cmd");
      const { intentId: planIntentId } = await flow.plan(workItemId, planCmdId);

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);

      // Good proposal → StepContract created
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 1, "step_contract created");

      // Worker triggered
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 1, "worker.attempt triggered");
    } finally {
      await pool.end();
    }
  });
});
