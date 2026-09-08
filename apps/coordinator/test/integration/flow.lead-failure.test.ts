/**
 * Integration tests: invalid lead.review / lead.accept / worker output handling.
 *
 * R-004: COMPLETED run with invalid output is an execution failure.
 * R-007: One bounded retry per failure class, then pending_human.
 * R-010: Replay of a malformed observation produces no second failure row.
 *
 * Script-timing note: FakeExecutionRuntime computes run output at trigger()
 * time, not at advance() time.  Therefore, to control a retry's output, the
 * script must be set BEFORE the handler (onReviewFinal / onAcceptFinal) calls
 * runtime.trigger() for the retry.
 *
 * Covered scenarios:
 * 1. review COMPLETED with malformed output → failures row, intent failed, retry
 *    dispatched; good retry → accept dispatched normally.
 * 2. Both review runs malformed → pending_human decision, no third intent.
 * 3. accept COMPLETED with malformed output → failures row, intent failed, retry
 *    dispatched; good retry → decision recorded.
 * 4. FAILED review run status → same failure path as malformed output.
 * 5. Replay of malformed observation → no second failure row (R-010).
 * 6. COMPLETED worker run with schema-invalid output → failure row, attempt failed,
 *    intent failed; new attempt dispatched when budget allows.
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
// Constants
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

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

// Malformed review output (fails ReviewOutputSchema)
const MALFORMED_REVIEW = { bad: "reviewOutput" };
// Malformed accept output (fails AcceptanceProposalSchema)
const MALFORMED_ACCEPT = { bad: "acceptOutput" };

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
// Setup helper: plan → worker → verify (stops before review trigger)
//
// The CALLER must script TASK_IDS.leadReview BEFORE calling this so that
// onVerifyFinal triggers the review run with the correct output.
// ---------------------------------------------------------------------------

async function setupThroughVerify(
  client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  deps: FlowDeps,
): Promise<{
  flow: BoundedRepairFlow;
  workItemId: string;
  reviewIntentId: string;
  reviewRunId: string;
  artifactRow: { revision: string; diff_digest: string };
  contractRow: { id: string; criteria_digest: string };
}> {
  const { workItemId } = await seedProjectAndWorkItem(client);
  const flow = new BoundedRepairFlow(deps);

  // --- Plan ---
  fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
  const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, ids.next("cmd"));
  fake.advance(planRunId);
  fake.advance(planRunId);

  // --- Worker ---
  fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
    const p = payload as { attemptId: string };
    return {
      status: "COMPLETED",
      output: workerCompletedOutput(p.attemptId, {
        commitId: "deadbeef1234567890deadbeef1234567890dead",
      }),
    };
  });
  await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), ids.next("cmd"));

  const { rows: workerIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  );
  const workerIntent = workerIntents[0] as { run_id: string };
  fake.advance(workerIntent.run_id);
  fake.advance(workerIntent.run_id);
  const workerObs = await fake.retrieve(workerIntent.run_id);

  // --- Verify ---
  fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
    const p = payload as {
      contractId: string;
      criteriaDigest: string;
      profileDigest: string;
      baseRevision: string;
      attemptRevision: string;
      diffDigest: string;
      attemptId: string;
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
  await flow.onWorkerFinal(workerObs, ids.next("cmd"));

  const { rows: verifyIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.verifyRun],
  );
  const verifyIntent = verifyIntents[0] as { run_id: string };
  fake.advance(verifyIntent.run_id);
  fake.advance(verifyIntent.run_id);
  const verifyObs = await fake.retrieve(verifyIntent.run_id);

  // NOTE: The caller MUST have scripted TASK_IDS.leadReview before this call.
  // onVerifyFinal calls runtime.trigger() for the review, which computes the
  // review run's output using the currently registered script.
  await flow.onVerifyFinal(verifyObs, ids.next("cmd"));

  const { rows: reviewIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.leadReview],
  );
  const reviewIntent = reviewIntents[0] as { id: string; run_id: string };

  const { rows: artifactRows } = await client.query("SELECT * FROM artifacts");
  const artifactRow = artifactRows[0] as { revision: string; diff_digest: string };

  const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
  const contractRow = contractRows[0] as { id: string; criteria_digest: string };

  return {
    flow,
    workItemId,
    reviewIntentId: reviewIntent.id,
    reviewRunId: reviewIntent.run_id,
    artifactRow,
    contractRow,
  };
}

// ---------------------------------------------------------------------------
// Test 1: review COMPLETED with malformed output → retry dispatched;
//         good retry → accept dispatched normally.
// ---------------------------------------------------------------------------

test("flow.lead-failure: malformed review output → failure row + retry; good retry → accept dispatched", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);

      // Script the first review run as malformed (BEFORE onVerifyFinal triggers it).
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: MALFORMED_REVIEW,
      }));

      const { flow, reviewIntentId, reviewRunId, artifactRow, contractRow } =
        await setupThroughVerify(client, pool, fake, deps);

      // Advance first review run to COMPLETED (output = malformed, computed at trigger time).
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);
      assert.equal(reviewObs.status, "COMPLETED");

      // Before calling onReviewFinal, change the review script to GOOD so that
      // when onReviewFinal triggers the retry, it gets good output.
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: goodReviewOutput({
          attemptRevision: artifactRow.revision,
          diffDigest: artifactRow.diff_digest,
          criteriaDigest: contractRow.criteria_digest,
          profileDigest: FAKE_PROFILE_DIGEST,
        }),
      }));

      const reviewCmdId = `cmd_obs_${reviewRunId}_1`;
      const result = await flow.onReviewFinal(reviewObs, reviewCmdId);
      assert.deepEqual(result, { ok: false }, "handler returns ok:false on bad output");

      // Verify failure row (class=execution, phase=review).
      const { rows: failureRows } = await client.query("SELECT * FROM failures");
      assert.equal(failureRows.length, 1, "one failure row");
      const failure = failureRows[0] as { class: string; phase: string; run_id: string };
      assert.equal(failure.class, "execution");
      assert.equal(failure.phase, "review");
      assert.equal(failure.run_id, reviewRunId);

      // Verify original review intent closed as 'failed'.
      const { rows: reviewIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE id = $1",
        [reviewIntentId],
      );
      assert.equal(reviewIntentRows[0].status, "failed", "original review intent is failed");

      // Verify retry intent created with :r1 key.
      const retryKey = `${reviewIntentId}:r1`;
      const { rows: retryIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE idempotency_key = $1",
        [retryKey],
      );
      assert.equal(retryIntentRows.length, 1, "retry intent created");
      const retryIntent = retryIntentRows[0] as {
        id: string;
        run_id: string;
        status: string;
        task: string;
      };
      assert.equal(retryIntent.task, TASK_IDS.leadReview);
      assert.equal(retryIntent.status, "triggered", "retry intent triggered");
      assert.ok(retryIntent.run_id, "retry run created");

      // Script accept for after the successful retry.
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED",
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      // Advance retry review run (output was computed at trigger time as GOOD).
      fake.advance(retryIntent.run_id);
      fake.advance(retryIntent.run_id);
      const retryObs = await fake.retrieve(retryIntent.run_id);
      assert.equal(retryObs.status, "COMPLETED");

      const retryCmdId = `cmd_obs_${retryIntent.run_id}_1`;
      const retryResult = await flow.onReviewFinal(retryObs, retryCmdId);
      assert.deepEqual(retryResult, { ok: true }, "retry succeeds with good output");

      // Verify accept intent dispatched.
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      assert.equal(acceptIntents.length, 1, "accept intent created after good retry");
      assert.ok(acceptIntents[0].run_id, "accept run triggered");

      // No pending_human decision.
      const { rows: decisions } = await client.query(
        "SELECT * FROM decisions WHERE outcome = 'pending_human'",
      );
      assert.equal(decisions.length, 0, "no pending_human decision on first retry success");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: both review runs malformed → pending_human decision, no third intent.
// ---------------------------------------------------------------------------

test("flow.lead-failure: both review runs malformed → pending_human decision, no third intent", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);

      // Script both review runs as malformed (do NOT change between calls).
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: MALFORMED_REVIEW,
      }));

      const { flow, reviewIntentId, reviewRunId } = await setupThroughVerify(
        client,
        pool,
        fake,
        deps,
      );

      // First review run.
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      // Keep malformed script active so retry is also malformed.
      const result1 = await flow.onReviewFinal(reviewObs, `cmd_obs_${reviewRunId}_1`);
      assert.deepEqual(result1, { ok: false });

      // Get retry intent.
      const retryKey = `${reviewIntentId}:r1`;
      const { rows: retryIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE idempotency_key = $1",
        [retryKey],
      );
      assert.equal(retryIntentRows.length, 1, "retry intent created");
      const retryIntent = retryIntentRows[0] as { id: string; run_id: string };
      assert.ok(retryIntent.run_id, "retry run triggered");

      // Retry review run — also malformed (script unchanged).
      fake.advance(retryIntent.run_id);
      fake.advance(retryIntent.run_id);
      const retryObs = await fake.retrieve(retryIntent.run_id);
      assert.equal(retryObs.status, "COMPLETED");

      const result2 = await flow.onReviewFinal(retryObs, `cmd_obs_${retryIntent.run_id}_1`);
      assert.deepEqual(result2, { ok: false }, "retry also returns ok:false on bad output");

      // pending_human decision recorded.
      const { rows: decisions } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'review' AND outcome = 'pending_human'",
      );
      assert.equal(decisions.length, 1, "pending_human decision recorded");
      assert.equal(decisions[0].causation_id, retryIntent.id, "causation is the retry intent");

      // No third review intent.
      const { rows: allReviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      assert.equal(allReviewIntents.length, 2, "exactly 2 review intents (original + retry)");

      // No accept intent.
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      assert.equal(acceptIntents.length, 0, "no accept intent created");

      // Two failure rows (one per malformed review run).
      const { rows: failureRows } = await client.query("SELECT * FROM failures");
      assert.equal(failureRows.length, 2, "two failure rows");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: accept COMPLETED with malformed output → retry; good retry → decision.
// ---------------------------------------------------------------------------

test("flow.lead-failure: malformed accept output → failure row + retry; good retry → decision", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);

      // Script review as GOOD so onVerifyFinal triggers a good review run.
      // We don't know the actual digests yet; use goodReviewOutput with defaults.
      // ReviewOutputSchema only validates structure, not digest-matching against DB,
      // so placeholder digests satisfy the schema.
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: goodReviewOutput(),
      }));

      // Script accept as malformed (BEFORE onReviewFinal triggers it).
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED",
        output: MALFORMED_ACCEPT,
      }));

      const { flow, reviewRunId, artifactRow } = await setupThroughVerify(client, pool, fake, deps);

      // Advance and process the good review run.
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);
      assert.equal(reviewObs.status, "COMPLETED");

      const reviewResult = await flow.onReviewFinal(reviewObs, `cmd_obs_${reviewRunId}_1`);
      assert.deepEqual(reviewResult, { ok: true }, "review succeeds with good output");

      // Get the accept intent (triggered inside onReviewFinal with malformed script).
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      assert.equal(acceptIntents.length, 1, "accept intent created");
      const acceptIntent = acceptIntents[0] as { id: string; run_id: string };

      // Advance accept run to COMPLETED with malformed output.
      fake.advance(acceptIntent.run_id);
      fake.advance(acceptIntent.run_id);
      const acceptObs = await fake.retrieve(acceptIntent.run_id);
      assert.equal(acceptObs.status, "COMPLETED");

      // Before calling onAcceptFinal, change accept script to GOOD so the retry
      // (triggered inside onAcceptFinal) gets good output.
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED",
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      const acceptResult = await flow.onAcceptFinal(acceptObs, `cmd_obs_${acceptIntent.run_id}_1`);
      assert.deepEqual(
        acceptResult,
        { ok: false },
        "handler returns ok:false on bad accept output",
      );

      // Verify failure row.
      const { rows: failureRows } = await client.query("SELECT * FROM failures");
      assert.equal(failureRows.length, 1, "one failure row");
      const failure = failureRows[0] as { class: string; phase: string };
      assert.equal(failure.class, "execution");
      assert.equal(failure.phase, "accept");

      // Original accept intent closed as 'failed'.
      const { rows: acceptIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE id = $1",
        [acceptIntent.id],
      );
      assert.equal(acceptIntentRows[0].status, "failed", "original accept intent is failed");

      // Retry accept intent created.
      const retryKey = `${acceptIntent.id}:r1`;
      const { rows: retryIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE idempotency_key = $1",
        [retryKey],
      );
      assert.equal(retryIntentRows.length, 1, "retry accept intent created");
      const retryIntent = retryIntentRows[0] as { run_id: string };
      assert.ok(retryIntent.run_id, "retry accept run triggered");

      // Advance retry run (output computed at trigger time as GOOD).
      fake.advance(retryIntent.run_id);
      fake.advance(retryIntent.run_id);
      const retryObs = await fake.retrieve(retryIntent.run_id);
      const retryResult = await flow.onAcceptFinal(retryObs, `cmd_obs_${retryIntent.run_id}_1`);
      assert.deepEqual(retryResult, { ok: true }, "retry accept succeeds");

      // Decision recorded, not pending_human.
      const { rows: decisions } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.ok(decisions.length >= 1, "accept decision recorded");
      const nonPendingHuman = (decisions as Array<{ outcome: string }>).some(
        (d) => d.outcome !== "pending_human",
      );
      assert.ok(nonPendingHuman, "at least one non-pending_human decision");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: FAILED review run status → same failure path as malformed output.
// ---------------------------------------------------------------------------

test("flow.lead-failure: FAILED review run status → failure row, intent failed, retry dispatched", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);

      // Script review (any — we use a synthetic FAILED obs, bypass the script output).
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: MALFORMED_REVIEW,
      }));

      const { flow, reviewIntentId, reviewRunId } = await setupThroughVerify(
        client,
        pool,
        fake,
        deps,
      );

      // Build a synthetic FAILED observation using the real run_id so that
      // loadIntentByRunAndTask finds the review intent in the DB.
      const failedObs = {
        runId: reviewRunId,
        status: "FAILED" as const,
        observedAt: new Date().toISOString(),
        error: { message: "model execution failed" },
      };

      const result = await flow.onReviewFinal(failedObs, `cmd_obs_${reviewRunId}_1`);
      assert.deepEqual(result, { ok: false }, "FAILED run returns ok:false");

      // Failure row created.
      const { rows: failureRows } = await client.query("SELECT * FROM failures");
      assert.equal(failureRows.length, 1, "failure row created");
      const failure = failureRows[0] as { class: string; phase: string; run_id: string };
      assert.equal(failure.class, "execution");
      assert.equal(failure.phase, "review");
      assert.equal(failure.run_id, reviewRunId);

      // Original intent closed as 'failed'.
      const { rows: intentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE id = $1",
        [reviewIntentId],
      );
      assert.equal(intentRows[0].status, "failed");

      // Retry intent created.
      const retryKey = `${reviewIntentId}:r1`;
      const { rows: retryIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE idempotency_key = $1",
        [retryKey],
      );
      assert.equal(retryIntentRows.length, 1, "retry intent created for FAILED run");
      assert.ok(retryIntentRows[0].run_id, "retry run triggered");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: Replay of malformed review observation → no second failure row (R-010).
// ---------------------------------------------------------------------------

test("flow.lead-failure: replay of malformed review observation → no second failure row", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);

      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: MALFORMED_REVIEW,
      }));

      const { flow, reviewRunId } = await setupThroughVerify(client, pool, fake, deps);

      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);

      const cmdId = `cmd_obs_${reviewRunId}_1`;

      // First call: processes the failure.
      const result1 = await flow.onReviewFinal(reviewObs, cmdId);
      assert.deepEqual(result1, { ok: false });

      const { rows: failures1 } = await client.query("SELECT * FROM failures");
      assert.equal(failures1.length, 1, "one failure row after first call");

      // Second call (same commandId = replay): must not insert another failure row.
      const result2 = await flow.onReviewFinal(reviewObs, cmdId);
      assert.deepEqual(result2, { ok: false }, "replay also returns ok:false");

      const { rows: failures2 } = await client.query("SELECT * FROM failures");
      assert.equal(failures2.length, 1, "still only one failure row after replay (R-010)");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: COMPLETED worker run with schema-invalid output → failure, budget retry.
//
// The output must have outcome: "completed" so classifyObservation returns
// attemptStatus: "completed" (entering the safeParse branch). The output
// then fails WorkerAttemptOutputSchema because opencode.denials[*].pattern
// must be string (not null) per z.string().optional() — null is rejected.
// ---------------------------------------------------------------------------

test("flow.lead-failure: COMPLETED worker with invalid schema output → failure row + new attempt", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);
      const { workItemId } = await seedProjectAndWorkItem(client);
      const flow = new BoundedRepairFlow(deps);

      // Script plan.
      fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(
        workItemId,
        ids.next("cmd"),
      );
      fake.advance(planRunId);
      fake.advance(planRunId);

      // Script worker: COMPLETED with outcome:"completed" but null pattern in
      // denials → fails WorkerAttemptOutputSchema (pattern must be string, not null).
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        const out = workerCompletedOutput(p.attemptId, {
          commitId: "deadbeef1234567890deadbeef1234567890dead",
        });
        // Inject a denial without a message — the schema requires a string
        // (a null `pattern` is accepted since 369f4aa, so use another field).
        (
          out.opencode as unknown as {
            denials: Array<{ tool: string; pattern: string; message: null }>;
          }
        ).denials = [{ tool: "edit", pattern: "src/x.ts", message: null }];
        return { status: "COMPLETED", output: out };
      });

      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), ids.next("cmd"));

      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerIntent = workerIntents[0] as { id: string; run_id: string };
      fake.advance(workerIntent.run_id);
      fake.advance(workerIntent.run_id);
      const workerObs = await fake.retrieve(workerIntent.run_id);
      assert.equal(workerObs.status, "COMPLETED");

      // Call onWorkerFinal with the invalid-output observation.
      await flow.onWorkerFinal(workerObs, ids.next("cmd"));

      // Failure row: class=execution, phase=final.
      const { rows: failureRows } = await client.query("SELECT * FROM failures");
      assert.equal(failureRows.length, 1, "failure row recorded");
      const failure = failureRows[0] as { class: string; phase: string; run_id: string };
      assert.equal(failure.class, "execution", "failure class is execution");
      assert.equal(failure.phase, "final", "failure phase is final");
      assert.equal(failure.run_id, workerObs.runId);

      // Original attempt is 'failed'.
      const { rows: attemptRows } = await client.query(
        "SELECT * FROM attempts ORDER BY created_at",
      );
      const firstAttempt = attemptRows[0] as { status: string };
      assert.equal(firstAttempt.status, "failed", "original attempt marked failed");

      // Original worker intent is 'failed'.
      const { rows: workerIntentRows } = await client.query(
        "SELECT * FROM dispatch_intents WHERE id = $1",
        [workerIntent.id],
      );
      assert.equal(workerIntentRows[0].status, "failed", "worker intent closed as failed");

      // New attempt dispatched (budget: maxAttempts=2, budget_remaining starts at 1 after
      // first attempt; the invalid-output path decrements further, so budget=1 > 0 → new attempt).
      const { rows: allAttempts } = await client.query(
        "SELECT * FROM attempts ORDER BY created_at",
      );
      assert.equal(allAttempts.length, 2, "new attempt created from budget");
      const newAttempt = allAttempts[1] as { status: string };
      assert.ok(
        newAttempt.status === "dispatched" || newAttempt.status === "admitted",
        `new attempt has status ${newAttempt.status}`,
      );

      // New worker intent triggered.
      const { rows: allWorkerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1 ORDER BY created_at",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(allWorkerIntents.length, 2, "two worker intents total");
      assert.ok(allWorkerIntents[1].run_id, "new worker run triggered");
    } finally {
      await pool.end();
    }
  });
});
