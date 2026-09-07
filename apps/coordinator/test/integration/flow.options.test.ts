/**
 * Integration tests: F-3 trigger options in BoundedRepairFlow.
 *
 * Verifies that runtime.trigger() is called with:
 * - maxDurationSeconds from contract bounds
 * - concurrencyKey = projectId
 * - tags containing project:, workItem:, contract:, attempt: labels
 *
 * Also verifies F-6: protectedPaths from profileResolver are passed to verify.
 * Also verifies F-8: reviewerModel stored from config.reviewerModel, not self-reported model.
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
  goodReviewOutput,
  passingVerificationResult,
  workerCompletedOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const PROTECTED_PATHS = ["package.json", "pnpm-lock.yaml", "test/**"];
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: PROTECTED_PATHS,
});

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

const REVIEWER_MODEL = "openai/gpt-5.6-sol";

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
      reviewerModel: REVIEWER_MODEL,
      verifierName: "agencyhq-verifier",
    },
    profileResolver: FAKE_PROFILE_RESOLVER,
  };
}

// ---------------------------------------------------------------------------
// Helpers to extract trigger call options
// ---------------------------------------------------------------------------

function triggerCallsForTask(fake: FakeExecutionRuntime, task: string) {
  return fake.calls
    .filter((c) => c.method === "trigger")
    .map((c) => c.args[0] as { task: string; options: Record<string, unknown> })
    .filter((a) => a.task === task);
}

// ---------------------------------------------------------------------------
// Test 1: worker trigger carries maxDurationSeconds, concurrencyKey, tags (F-3)
// ---------------------------------------------------------------------------

test("flow.options: worker trigger includes maxDurationSeconds, concurrencyKey, and tags", async (t) => {
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
      const { workItemId, projectId } = await seedProjectAndWorkItem(client);
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

      const workerCalls = triggerCallsForTask(fake, TASK_IDS.workerAttempt);
      assert.equal(workerCalls.length, 1, "worker triggered once");
      assert.ok(workerCalls[0], "worker call record exists");

      const opts = workerCalls[0].options;

      // F-3: maxDurationSeconds
      assert.ok(
        typeof opts.maxDurationSeconds === "number" && opts.maxDurationSeconds > 0,
        `maxDurationSeconds should be a positive number, got ${String(opts.maxDurationSeconds)}`,
      );

      // F-3: concurrencyKey = projectId
      assert.equal(opts.concurrencyKey, projectId, "concurrencyKey = projectId");

      // F-3: tags contain required labels
      const tags = opts.tags as string[];
      assert.ok(Array.isArray(tags), "tags is an array");
      assert.ok(
        tags.some((tag) => tag.startsWith("project:")),
        `tags missing project: label, got ${JSON.stringify(tags)}`,
      );
      assert.ok(
        tags.some((tag) => tag.startsWith("workItem:")),
        `tags missing workItem: label`,
      );
      assert.ok(
        tags.some((tag) => tag.startsWith("contract:")),
        `tags missing contract: label`,
      );
      assert.ok(
        tags.some((tag) => tag.startsWith("attempt:")),
        `tags missing attempt: label`,
      );
      assert.ok(
        tags.some((tag) => tag === `project:${projectId}`),
        `tags should include project:${projectId}`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: verify trigger includes maxDurationSeconds and tags (F-3 + F-6)
// ---------------------------------------------------------------------------

test("flow.options: verify trigger includes options and protectedPaths from resolver (F-3, F-6)", async (t) => {
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
      const { workItemId, projectId } = await seedProjectAndWorkItem(client);
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

      const workerObs = await fake.retrieve(workerRunId);
      await flow.onWorkerFinal(workerObs, `cmd_obs_${workerRunId}_1`);

      const verifyCalls = triggerCallsForTask(fake, TASK_IDS.verifyRun);
      assert.equal(verifyCalls.length, 1, "verify triggered once");
      assert.ok(verifyCalls[0], "verify call record exists");

      const opts = verifyCalls[0].options;

      // F-3: maxDurationSeconds on verify trigger
      assert.ok(
        typeof opts.maxDurationSeconds === "number" && opts.maxDurationSeconds > 0,
        `verify maxDurationSeconds should be positive, got ${String(opts.maxDurationSeconds)}`,
      );

      // F-3: concurrencyKey
      assert.equal(opts.concurrencyKey, projectId, "verify concurrencyKey = projectId");

      // F-3: tags
      const tags = opts.tags as string[];
      assert.ok(Array.isArray(tags) && tags.length > 0, "verify trigger has tags");
      assert.ok(
        tags.some((tag) => tag.startsWith("project:")),
        "verify tags has project:",
      );
      assert.ok(
        tags.some((tag) => tag.startsWith("attempt:")),
        "verify tags has attempt:",
      );

      // F-6: protectedPaths in verify payload
      const verifyCall = verifyCalls[0] as { task: string; payload: unknown; options: unknown };
      const payload = verifyCall.payload as Record<string, unknown>;
      assert.ok(Array.isArray(payload.protectedPaths), "verify payload has protectedPaths array");
      const pp = payload.protectedPaths as string[];
      for (const p of PROTECTED_PATHS) {
        assert.ok(pp.includes(p), `protectedPaths should include ${p}`);
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: F-8 review row stores config.reviewerModel, not self-reported model
// ---------------------------------------------------------------------------

test("flow.options: reviews.reviewer_model stores config.reviewerModel (F-8)", async (t) => {
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
        return {
          status: "COMPLETED",
          output: passingVerificationResult({
            verifierName: "agencyhq-verifier",
            stepContractId: p.stepContractId,
            attemptId: p.attemptId,
            criteriaDigest: p.criteriaDigest,
            profileDigest: p.profileDigest,
            baseRevision: p.baseRevision,
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
          }),
        };
      });
      // Reviewer reports a DIFFERENT model than config.reviewerModel
      const SELF_REPORTED_MODEL = "some-other-model/self-reported";
      fake.script(TASK_IDS.leadReview, (payload: unknown) => {
        const p = payload as {
          attemptId: string;
          diffDigest: string;
          criteriaDigest: string;
          profileDigest: string;
          attemptRevision: string;
        };
        return {
          status: "COMPLETED",
          output: {
            ...goodReviewOutput({
              attemptRevision: p.attemptRevision,
              diffDigest: p.diffDigest,
              criteriaDigest: p.criteriaDigest,
              profileDigest: p.profileDigest,
            }),
            reviewer: { model: SELF_REPORTED_MODEL }, // Self-reported model differs from config
          },
        };
      });
      fake.script(TASK_IDS.leadAccept, () => ({ status: "QUEUED" }));

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // Plan
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      // Worker
      const { rows: workerIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = workerIntentRows[0].run_id;
      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);
      await flow.onWorkerFinal(workerObs, `cmd_obs_${workerRunId}_1`);

      // Verify
      const { rows: verifyIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = verifyIntentRows[0].run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);
      await flow.onVerifyFinal(verifyObs, `cmd_obs_${verifyRunId}_1`);

      // Review
      const { rows: reviewIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      const reviewRunId = reviewIntentRows[0].run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);
      await flow.onReviewFinal(reviewObs, `cmd_obs_${reviewRunId}_1`);

      // F-8: Check that reviews.reviewer_model = config.reviewerModel, not self-reported
      const { rows: reviewRows } = await client.query("SELECT reviewer_model FROM reviews");
      assert.equal(reviewRows.length, 1, "one review row created");
      assert.equal(
        reviewRows[0].reviewer_model,
        REVIEWER_MODEL,
        `reviewer_model should be config.reviewerModel (${REVIEWER_MODEL}), not self-reported (${SELF_REPORTED_MODEL})`,
      );
      assert.notEqual(
        reviewRows[0].reviewer_model,
        SELF_REPORTED_MODEL,
        "reviewer_model must NOT be the self-reported model",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: review trigger carries concurrencyKey and tags (F-3)
// ---------------------------------------------------------------------------

test("flow.options: review trigger includes concurrencyKey and tags (F-3)", async (t) => {
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
      const { workItemId, projectId } = await seedProjectAndWorkItem(client);
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
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          attemptId: string;
          stepContractId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
        };
        return {
          status: "COMPLETED",
          output: passingVerificationResult({
            verifierName: "agencyhq-verifier",
            stepContractId: p.stepContractId,
            attemptId: p.attemptId,
            criteriaDigest: p.criteriaDigest,
            profileDigest: p.profileDigest,
            baseRevision: p.baseRevision,
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
          }),
        };
      });
      fake.script(TASK_IDS.leadReview, () => ({ status: "QUEUED" }));

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // Plan
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(
        workItemId,
        newId("cmd"),
      );
      fake.advance(planRunId);
      fake.advance(planRunId);
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      // Worker
      const { rows: wRows } = await client.query("SELECT * FROM dispatch_intents WHERE task = $1", [
        TASK_IDS.workerAttempt,
      ]);
      const workerRunId = wRows[0].run_id;
      fake.advance(workerRunId);
      fake.advance(workerRunId);
      await flow.onWorkerFinal(await fake.retrieve(workerRunId), `cmd_obs_${workerRunId}_1`);

      // Verify
      const { rows: vRows } = await client.query("SELECT * FROM dispatch_intents WHERE task = $1", [
        TASK_IDS.verifyRun,
      ]);
      const verifyRunId = vRows[0].run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      await flow.onVerifyFinal(await fake.retrieve(verifyRunId), `cmd_obs_${verifyRunId}_1`);

      const reviewCalls = triggerCallsForTask(fake, TASK_IDS.leadReview);
      assert.equal(reviewCalls.length, 1, "review triggered once");
      assert.ok(reviewCalls[0], "review call record exists");
      const opts = reviewCalls[0].options;

      assert.ok(
        typeof opts.maxDurationSeconds === "number" && opts.maxDurationSeconds > 0,
        "review trigger has maxDurationSeconds",
      );
      assert.equal(opts.concurrencyKey, projectId, "review concurrencyKey = projectId");

      const tags = opts.tags as string[];
      assert.ok(
        tags.some((tag) => tag.startsWith("project:")),
        "review tags has project:",
      );
      assert.ok(
        tags.some((tag) => tag.startsWith("attempt:")),
        "review tags has attempt:",
      );
    } finally {
      await pool.end();
    }
  });
});
