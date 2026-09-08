/**
 * Integration test: BoundedRepairFlow happy path.
 *
 * plan → lead.plan → onLeadPlanOutput → worker.attempt → onWorkerFinal →
 * verify.run → onVerifyFinal → lead.review → onReviewFinal →
 * lead.accept → onAcceptFinal → WorkItem completed.
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
  goodAcceptanceProposal,
  goodPlanOutput,
  goodReviewOutput,
  passingVerificationResult,
  workerCompletedOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Profile resolver stub (no @agencyhq/verification dependency)
// ---------------------------------------------------------------------------

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [
    {
      id: "pnpm-test",
      version: "1.0.0",
      command: ["pnpm", "test"],
      timeoutSeconds: 60,
    },
  ],
  protectedPaths: ["package.json", "pnpm-lock.yaml"],
});

// ---------------------------------------------------------------------------
// Id generator
// ---------------------------------------------------------------------------

const ids = {
  next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]),
};

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

const clock = { now: () => new Date().toISOString() };

test("flow.happy-path: complete bounded repair flow", async (t) => {
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

      // Script lead.plan → returns good proposal
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));

      const deps: FlowDeps = {
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

      const flow = new BoundedRepairFlow(deps);

      // -----------------------------------------------------------------------
      // 1. plan() — dispatch lead.plan
      // -----------------------------------------------------------------------
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);

      assert.ok(planIntentId, "plan intent created");
      assert.ok(planRunId, "plan run created");

      // Verify intent committed BEFORE trigger call (R-002)
      const { rows: intentRows1 } = await client.query(
        "SELECT * FROM dispatch_intents WHERE id = $1",
        [planIntentId],
      );
      assert.equal(intentRows1.length, 1, "intent row exists");
      assert.equal(intentRows1[0].task, TASK_IDS.leadPlan);

      // Advance fake run to COMPLETED
      fake.advance(planRunId);
      fake.advance(planRunId);

      const planObs = await fake.retrieve(planRunId);
      assert.equal(planObs.status, "COMPLETED");

      // -----------------------------------------------------------------------
      // 2. onLeadPlanOutput — process proposal → freeze contract → dispatch worker
      // -----------------------------------------------------------------------

      // Script worker.attempt before it's triggered
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, {
            commitId: "deadbeef1234567890deadbeef1234567890dead",
          }),
        };
      });

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);

      // Verify StepContract created
      const { rows: contractRows } = await client.query(
        "SELECT * FROM step_contracts ORDER BY created_at",
      );
      assert.equal(contractRows.length, 1, "step_contract created");
      const contractRow = contractRows[0];

      // Verify Attempt created
      const { rows: attemptRows1 } = await client.query(
        "SELECT * FROM attempts ORDER BY created_at",
      );
      assert.ok(attemptRows1.length >= 1, "attempt created");
      const attemptRow = attemptRows1[0];

      // Verify worker intent created (in same tx as contract + attempt)
      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(workerIntents.length, 1, "worker intent created");
      const workerIntent = workerIntents[0];
      assert.ok(workerIntent.run_id, "worker run triggered");

      // -----------------------------------------------------------------------
      // 3. onWorkerFinal — process worker completion → insert Artifact → dispatch verify
      // -----------------------------------------------------------------------

      // Script verify.run
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          attemptId: string;
          stepContractId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
          contractId: string;
        };
        const result = passingVerificationResult({
          verifierName: "agencyhq-verifier",
          stepContractId: p.contractId,
          attemptId: p.attemptId,
          criteriaDigest: p.criteriaDigest,
          profileDigest: p.profileDigest,
          baseRevision: p.baseRevision,
          attemptRevision: p.attemptRevision,
          diffDigest: p.diffDigest,
          checkId: "pnpm-test",
        });
        return { status: "COMPLETED", output: { results: [result] } };
      });

      const workerRunId = workerIntent.run_id;
      fake.advance(workerRunId);
      fake.advance(workerRunId);

      const workerObs = await fake.retrieve(workerRunId);
      assert.equal(workerObs.status, "COMPLETED");

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      // Verify Artifact created
      const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
      assert.equal(artifactRows.length, 1, "artifact created");
      const artifactRow = artifactRows[0];
      assert.equal(artifactRow.attempt_id, attemptRow.id);

      // Verify verify.run intent created
      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      assert.equal(verifyIntents.length, 1, "verify intent created");
      assert.ok(verifyIntents[0].run_id, "verify run triggered");

      // -----------------------------------------------------------------------
      // 4. onVerifyFinal — store results → dispatch lead.review
      // -----------------------------------------------------------------------

      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: goodReviewOutput({
          attemptRevision: artifactRow.revision,
          diffDigest: artifactRow.diff_digest,
          criteriaDigest: contractRow.criteria_digest,
          profileDigest: FAKE_PROFILE_DIGEST,
        }),
      }));

      const verifyRunId = verifyIntents[0].run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);

      const verifyObs = await fake.retrieve(verifyRunId);
      assert.equal(verifyObs.status, "COMPLETED");

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      // Verify VerificationResults stored
      const { rows: vrRows } = await client.query("SELECT * FROM verification_results");
      assert.equal(vrRows.length, 1, "verification result stored");

      // Verify lead.review intent created
      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      assert.equal(reviewIntents.length, 1, "review intent created");
      assert.ok(reviewIntents[0].run_id, "review run triggered");

      // -----------------------------------------------------------------------
      // 5. onReviewFinal — store review → dispatch lead.accept
      // -----------------------------------------------------------------------

      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED",
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      const reviewRunId = reviewIntents[0].run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);

      const reviewObs = await fake.retrieve(reviewRunId);
      assert.equal(reviewObs.status, "COMPLETED");

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      // Verify Review stored
      const { rows: reviewRows } = await client.query("SELECT * FROM reviews");
      assert.equal(reviewRows.length, 1, "review stored");
      assert.equal(reviewRows[0].reviewer_model, "openai/gpt-5.6-sol");

      // Verify lead.accept intent created
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      assert.equal(acceptIntents.length, 1, "accept intent created");
      assert.ok(acceptIntents[0].run_id, "accept run triggered");

      // -----------------------------------------------------------------------
      // 6. onAcceptFinal — evaluate acceptance → complete WorkItem
      // -----------------------------------------------------------------------

      const acceptRunId = acceptIntents[0].run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);

      const acceptObs = await fake.retrieve(acceptRunId);
      assert.equal(acceptObs.status, "COMPLETED");

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      // Verify WorkItem completed
      const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(wiRows.length, 1);
      assert.equal(wiRows[0].lifecycle, "completed", "WorkItem lifecycle = completed");
      assert.equal(wiRows[0].boundary, "artifact", "WorkItem boundary = artifact");

      // Verify accept Decision recorded
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "accept decision recorded");
      assert.equal(decisionRows[0].outcome, "accepted");

      // Verify trigger call order: lead.plan → worker.attempt → verify.run → lead.review → lead.accept
      const triggerCalls = fake.calls.filter((c) => c.method === "trigger");
      assert.equal(triggerCalls.length, 5, "exactly 5 trigger calls");
      const tasks = triggerCalls.map((c) => (c.args[0] as { task: string }).task);
      assert.deepEqual(tasks, [
        TASK_IDS.leadPlan,
        TASK_IDS.workerAttempt,
        TASK_IDS.verifyRun,
        TASK_IDS.leadReview,
        TASK_IDS.leadAccept,
      ]);
    } finally {
      await pool.end();
    }
  });
});
