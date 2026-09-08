/**
 * Integration test: parking paths — null-commit (F-14) and humanRequired (R-006).
 *
 * (a) Worker output with commitId: null → contract failure, no artifact, no verify dispatch,
 *     attempt status = failed, failure row class = contract.
 *
 * (b) humanRequired contract (derived via authority/proposal) → full flow through verify
 *     and review → lead.accept proposes acceptance → onAcceptFinal with no Approval →
 *     pending_human decision, work item lifecycle not completed, replay is a no-op.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { LeadPlanOutput } from "@agencyhq/contracts";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import publicApiFixture from "../fixtures/injection/proposal.class-editorial-touching-public-api.json" with {
  type: "json",
};
import {
  goodAcceptanceProposal,
  goodPlanOutput,
  goodReviewOutput,
  passingVerificationResult,
  workerCompletedOutput,
  workerNullCommitOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared test infrastructure (mirrors happy-path / false-success tests)
// ---------------------------------------------------------------------------

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
// Test (a): null-commit → contract failure
// ---------------------------------------------------------------------------

test("flow.parking (a): commitId=null → contract failure row, attempt failed, no artifact, no verify dispatch", async (t) => {
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

      // Script lead.plan → good proposal (narrow, no humanRequired)
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));

      const deps = makeDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // 1. plan() — dispatch lead.plan
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      // 2. Script worker to return null-commit completed output, then onLeadPlanOutput
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerNullCommitOutput(p.attemptId),
        };
      });

      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), planOutputCmdId);

      // Retrieve attempt and worker intent rows
      const { rows: attemptRowsBefore } = await client.query(
        "SELECT * FROM attempts ORDER BY created_at",
      );
      assert.equal(attemptRowsBefore.length, 1, "one attempt created");
      const attemptId = (attemptRowsBefore[0] as { id: string }).id;

      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(workerIntents.length, 1, "worker intent created");
      const workerRunId = (workerIntents[0] as { run_id: string }).run_id;

      // 3. Advance fake worker, retrieve obs, call onWorkerFinal
      fake.advance(workerRunId);
      fake.advance(workerRunId);

      const workerObs = await fake.retrieve(workerRunId);
      assert.equal(workerObs.status, "COMPLETED", "worker obs status = COMPLETED");

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      // ---- Assertions ----

      // (a1) No artifacts row for the attempt
      const { rows: artifactRows } = await client.query(
        "SELECT * FROM artifacts WHERE attempt_id = $1",
        [attemptId],
      );
      assert.equal(artifactRows.length, 0, "no artifact row created for null-commit attempt");

      // (a2) One failures row with class='contract', phase='final', linked to the attempt
      const { rows: failureRows } = await client.query(
        "SELECT * FROM failures WHERE attempt_id = $1",
        [attemptId],
      );
      assert.equal(failureRows.length, 1, "one failure row created");
      const failureRow = failureRows[0] as {
        id: string;
        class: string;
        phase: string;
        attempt_id: string;
        run_id: string;
        cause: string;
      };
      assert.equal(failureRow.class, "contract", "failure.class = contract");
      assert.equal(failureRow.phase, "final", "failure.phase = final");
      assert.equal(failureRow.attempt_id, attemptId, "failure linked to attempt by attempt_id");
      assert.equal(failureRow.run_id, workerRunId, "failure linked by run_id");
      assert.ok(
        failureRow.cause.includes("null commitId"),
        `failure.cause mentions null commitId; got: ${failureRow.cause}`,
      );

      // (a3) Attempt status = 'failed', failure_id set to failure row
      const { rows: updatedAttemptRows } = await client.query(
        "SELECT id, status, failure_id FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(updatedAttemptRows.length, 1);
      const updatedAttempt = updatedAttemptRows[0] as {
        status: string;
        failure_id: string | null;
      };
      assert.equal(updatedAttempt.status, "failed", "attempt.status = failed");
      assert.equal(updatedAttempt.failure_id, failureRow.id, "attempt.failure_id = failure row id");

      // (a4) No verify.run dispatch intent
      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      assert.equal(verifyIntents.length, 0, "no verify.run dispatch intent after null-commit");

      // (a5) Work item NOT completed
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.ok(wiRows.length === 1);
      assert.notEqual(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "completed",
        "work item lifecycle != completed after null-commit",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test (b): humanRequired → pending_human decision, work item stays active
// ---------------------------------------------------------------------------

test("flow.parking (b): humanRequired contract → pending_human at accept, work item stays active, replay is no-op", async (t) => {
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

      // The public-api fixture touches src/parser/public-api.ts which is in
      // HOST_TRIAL_AUTHORITY's humanRequired.paths, so requiresApproval()
      // returns true → contract.human_required = true.
      const planOutput = publicApiFixture as LeadPlanOutput;

      // Script lead.plan → public-api fixture (causes humanRequired=true)
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: planOutput,
      }));

      const deps = makeDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      // ------------------------------------------------------------------
      // 1. plan() — dispatch lead.plan
      // ------------------------------------------------------------------
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      // Script worker to complete with a real commitId
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, {
            commitId: "deadbeef1234567890deadbeef1234567890dead",
            changedPaths: ["src/parser/public-api.ts"],
          }),
        };
      });

      // ------------------------------------------------------------------
      // 2. onLeadPlanOutput — freeze contract (human_required=true), dispatch worker
      // ------------------------------------------------------------------
      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, planOutput, planOutputCmdId);

      // Verify contract has human_required=true (derived from authority/proposal)
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 1, "step_contract created");
      const contractRow = contractRows[0] as {
        id: string;
        human_required: boolean;
        criteria_digest: string;
        work_item_id: string;
      };
      assert.equal(
        contractRow.human_required,
        true,
        "contract.human_required = true (derived from authority paths)",
      );

      const { rows: attemptRowsAfterPlan } = await client.query(
        "SELECT * FROM attempts ORDER BY created_at",
      );
      assert.equal(attemptRowsAfterPlan.length, 1, "one attempt created");
      const attemptId = (attemptRowsAfterPlan[0] as { id: string }).id;

      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      assert.equal(
        workerIntents.length,
        1,
        "worker intent created (humanRequired does not block dispatch)",
      );
      const workerRunId = (workerIntents[0] as { run_id: string }).run_id;

      // ------------------------------------------------------------------
      // 3. onWorkerFinal — worker completes, dispatch verify.run
      // ------------------------------------------------------------------
      fake.script(TASK_IDS.verifyRun, (payload: unknown) => {
        const p = payload as {
          attemptId: string;
          contractId: string;
          criteriaDigest: string;
          profileDigest: string;
          baseRevision: string;
          attemptRevision: string;
          diffDigest: string;
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

      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);
      assert.equal(workerObs.status, "COMPLETED");

      const workerFinalCmdId = newId("cmd");
      await flow.onWorkerFinal(workerObs, workerFinalCmdId);

      // Artifact should be created (non-null commitId)
      const { rows: artifactRows } = await client.query(
        "SELECT * FROM artifacts WHERE attempt_id = $1",
        [attemptId],
      );
      assert.equal(artifactRows.length, 1, "artifact created");
      const artifactRow = artifactRows[0] as {
        revision: string;
        diff_digest: string;
      };

      const { rows: verifyIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      assert.equal(verifyIntents.length, 1, "verify.run dispatch created");
      const verifyRunId = (verifyIntents[0] as { run_id: string }).run_id;

      // ------------------------------------------------------------------
      // 4. onVerifyFinal — store results, dispatch lead.review
      // ------------------------------------------------------------------
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: goodReviewOutput({
          attemptRevision: artifactRow.revision,
          diffDigest: artifactRow.diff_digest,
          criteriaDigest: contractRow.criteria_digest,
          profileDigest: FAKE_PROFILE_DIGEST,
        }),
      }));

      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);
      assert.equal(verifyObs.status, "COMPLETED");

      const verifyFinalCmdId = newId("cmd");
      await flow.onVerifyFinal(verifyObs, verifyFinalCmdId);

      const { rows: reviewIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      assert.equal(reviewIntents.length, 1, "lead.review dispatch created");
      const reviewRunId = (reviewIntents[0] as { run_id: string }).run_id;

      // ------------------------------------------------------------------
      // 5. onReviewFinal — store review, dispatch lead.accept
      // ------------------------------------------------------------------
      // The c1 criterion comes from the public-api fixture.
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED",
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);
      assert.equal(reviewObs.status, "COMPLETED");

      const reviewFinalCmdId = newId("cmd");
      await flow.onReviewFinal(reviewObs, reviewFinalCmdId);

      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      assert.equal(acceptIntents.length, 1, "lead.accept dispatch created");
      const acceptRunId = (acceptIntents[0] as { run_id: string }).run_id;

      // ------------------------------------------------------------------
      // 6. onAcceptFinal — no Approval supplied → APPROVAL_REQUIRED →
      //    pending_human decision, work item stays active
      // ------------------------------------------------------------------
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);
      assert.equal(acceptObs.status, "COMPLETED");

      const acceptFinalCmdId = newId("cmd");
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);

      // ---- Assertions ----

      // (b1) Decision row: kind='accept', outcome='pending_human'
      const { rows: decisionRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(decisionRows.length, 1, "one accept decision");
      const decisionRow = decisionRows[0] as {
        kind: string;
        outcome: string;
        actor: string;
        work_item_id: string;
        contract_id: string;
        contract_version: number;
        attempt_id: string;
      };
      assert.equal(decisionRow.kind, "accept", "decision.kind = accept");
      assert.equal(decisionRow.outcome, "pending_human", "decision.outcome = pending_human");
      assert.equal(decisionRow.actor, "coordinator", "decision.actor = coordinator");
      assert.equal(decisionRow.work_item_id, workItemId, "decision linked to work item");
      assert.equal(decisionRow.contract_id, contractRow.id, "decision linked to contract");
      assert.equal(decisionRow.attempt_id, attemptId, "decision linked to attempt");

      // (b2) Work item lifecycle NOT 'completed'
      const { rows: wiRows } = await client.query(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.ok(wiRows.length === 1);
      assert.notEqual(
        (wiRows[0] as { lifecycle: string }).lifecycle,
        "completed",
        "work item lifecycle != completed after pending_human",
      );

      // (b3) No Approval row exists
      const { rows: approvalRows } = await client.query(
        "SELECT * FROM approvals WHERE contract_id = $1",
        [contractRow.id],
      );
      assert.equal(approvalRows.length, 0, "no approval row for this contract");

      // (b4) Replay: same acceptObs + same commandId → claimCommand idempotency →
      //      still exactly 1 decision (no duplicate)
      await flow.onAcceptFinal(acceptObs, acceptFinalCmdId);
      const { rows: decisionRowsAfterReplay } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'accept'",
      );
      assert.equal(
        decisionRowsAfterReplay.length,
        1,
        "replay is a no-op: still exactly 1 accept decision",
      );
    } finally {
      await pool.end();
    }
  });
});
