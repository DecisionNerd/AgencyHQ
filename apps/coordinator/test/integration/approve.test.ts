/**
 * Integration tests for the approveWorkItem command.
 *
 * Tests i–v from PACKET I1.c:
 *  (i)   humanRequired contract → pending_human → approve matching version → completed
 *  (ii)  approve with wrong attemptRevision → APPROVAL_VERSION_MISMATCH, item stays pending
 *  (iii) replay same commandId → same result, replayed=true, exactly one approvals row
 *  (iv)  approve on work item with no pending decision → state_mismatch
 *  (v)   see api.test.ts (missing fields → 400, valid → 200)
 *
 * Tests v–vii from PACKET S4-fix-approve (R-006, R-015):
 *  (v)   merge-boundary humanRequired → pending_human → approve → integrations + intent
 *        committed before trigger, work item still active; integrate → completed
 *  (vi)  artifact-boundary approve still completes work item immediately (regression guard)
 *  (vii) replay of approve after (v) → no second intent dispatched
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Authority, LeadProposal } from "@agencyhq/contracts";
import { digestOf, HOST_TRIAL_AUTHORITY, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import type { ApproveDeps } from "../../src/commands/approve.ts";
import { approveWorkItem } from "../../src/commands/approve.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import { onIntegrateFinal } from "../../src/flow/integrate.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import {
  GOOD_PROPOSAL,
  goodAcceptanceProposal,
  goodReviewOutput,
  passingVerificationResult,
  workerCompletedOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Authority for merge-boundary + humanRequired tests (v–vii)
// Allows "merge" boundary AND requires human approval for merge.
// ---------------------------------------------------------------------------

const MERGE_HR_AUTHORITY: Authority = {
  ...HOST_TRIAL_AUTHORITY,
  boundaries: ["artifact", "merge"],
  humanRequired: {
    paths: ["src/parser/public-api.ts"],
    changeClasses: [],
    boundaries: ["merge"], // merge boundary always requires human approval
  },
};

// Merge proposal: uses safe paths, "merge" boundary → humanRequired via boundaries rule.
const MERGE_HR_PROPOSAL: LeadProposal = {
  ...GOOD_PROPOSAL,
  boundary: "merge",
  paths: {
    allow: ["src/parser/edge-cases.ts"],
    deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
  },
  rationale: "Fix parser edge cases — merge boundary requires human approval",
};

const MERGE_HR_COMMIT_ID = "deadbeef1234567890deadbeef1234567890dead";
const INTEGRATED_REVISION = "1111111111111111111111111111111111111111";

// ---------------------------------------------------------------------------
// Profile resolver stub
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
// Id generator / clock
// ---------------------------------------------------------------------------

const ids = {
  next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]),
};
const clock = { now: () => new Date().toISOString() };

// ---------------------------------------------------------------------------
// Human-required proposal
//
// Uses src/parser/public-api.ts, which intersects HOST_TRIAL_AUTHORITY
// .humanRequired.paths and therefore causes requiresApproval() to return
// required:true, which sets humanRequired=true on the frozen StepContract.
// ---------------------------------------------------------------------------

const HR_PROPOSAL: LeadProposal = {
  ...GOOD_PROPOSAL,
  paths: {
    allow: ["src/parser/public-api.ts"],
    deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
  },
  rationale: "Fix public API surface — requires human approval",
};

// Distinct commitId for the humanRequired test so we can verify it below.
const HR_COMMIT_ID = "cafebabe1234567890cafebabe1234567890cafe";

// ---------------------------------------------------------------------------
// Helper: drive full BoundedRepairFlow to onAcceptFinal and return context
// ---------------------------------------------------------------------------

async function driveToAcceptFinal(
  flow: BoundedRepairFlow,
  fake: FakeExecutionRuntime,
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
  workItemId: string,
): Promise<{
  acceptObs: Awaited<ReturnType<FakeExecutionRuntime["retrieve"]>>;
  acceptRunId: string;
  contractId: string;
  contractVersion: number;
  artifactRevision: string;
}> {
  // 1. plan — dispatch lead.plan
  fake.script(TASK_IDS.leadPlan, () => ({
    status: "COMPLETED",
    output: { kind: "proposal", proposal: HR_PROPOSAL },
  }));

  const planCmdId = newId("cmd");
  const { intentId: planIntentId } = await flow.plan(workItemId, planCmdId);

  // Script worker.attempt before onLeadPlanOutput triggers it.
  fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
    const p = payload as { attemptId: string };
    return {
      status: "COMPLETED",
      output: workerCompletedOutput(p.attemptId, {
        commitId: HR_COMMIT_ID,
        changedPaths: ["src/parser/public-api.ts"],
      }),
    };
  });

  await flow.onLeadPlanOutput(
    planIntentId,
    { kind: "proposal", proposal: HR_PROPOSAL },
    newId("cmd"),
  );

  // Get the contract (created in onLeadPlanOutput).
  const { rows: contractRows } = (await client.query(
    "SELECT * FROM step_contracts ORDER BY created_at",
  )) as { rows: Array<{ id: string; version: number; human_required: boolean }> };
  assert.equal(contractRows.length, 1, "step_contract created");
  const contractRow = contractRows[0];
  assert.ok(contractRow!.human_required, "contract is humanRequired");

  // 3. onWorkerFinal — creates artifact, dispatches verify
  const { rows: workerIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  )) as { rows: Array<{ run_id: string }> };
  const workerRunId = workerIntents[0]!.run_id;
  fake.advance(workerRunId);
  fake.advance(workerRunId);
  const workerObs = await fake.retrieve(workerRunId);

  // Script verify.run
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

  await flow.onWorkerFinal(workerObs, newId("cmd"));

  // Get artifact
  const { rows: artifactRows } = (await client.query("SELECT * FROM artifacts")) as {
    rows: Array<{ revision: string; diff_digest: string }>;
  };
  assert.equal(artifactRows.length, 1, "artifact created");
  const artifactRow = artifactRows[0]!;

  // 4. onVerifyFinal — stores VRs, dispatches lead.review
  const { rows: verifyIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.verifyRun],
  )) as { rows: Array<{ run_id: string }> };
  const verifyRunId = verifyIntents[0]!.run_id;
  fake.advance(verifyRunId);
  fake.advance(verifyRunId);
  const verifyObs = await fake.retrieve(verifyRunId);

  // Script lead.review
  fake.script(TASK_IDS.leadReview, () => ({
    status: "COMPLETED",
    output: goodReviewOutput({
      attemptRevision: artifactRow.revision,
      diffDigest: artifactRow.diff_digest,
      criteriaDigest: String(digestOf({ placeholder: "criteria" })),
      profileDigest: FAKE_PROFILE_DIGEST,
    }),
  }));

  await flow.onVerifyFinal(verifyObs, newId("cmd"));

  // 5. onReviewFinal — stores review, dispatches lead.accept
  const { rows: reviewIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.leadReview],
  )) as { rows: Array<{ run_id: string }> };
  const reviewRunId = reviewIntents[0]!.run_id;
  fake.advance(reviewRunId);
  fake.advance(reviewRunId);
  const reviewObs = await fake.retrieve(reviewRunId);

  // Script lead.accept — returns an accepting proposal
  const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
  fake.script(TASK_IDS.leadAccept, () => ({
    status: "COMPLETED",
    output: goodAcceptanceProposal(["c1"], [vrRef]),
  }));

  await flow.onReviewFinal(reviewObs, newId("cmd"));

  // 6. Get accept run
  const { rows: acceptIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.leadAccept],
  )) as { rows: Array<{ run_id: string }> };
  const acceptRunId = acceptIntents[0]!.run_id;
  fake.advance(acceptRunId);
  fake.advance(acceptRunId);
  const acceptObs = await fake.retrieve(acceptRunId);

  return {
    acceptObs,
    acceptRunId,
    contractId: contractRow!.id,
    contractVersion: contractRow!.version,
    artifactRevision: artifactRow.revision,
  };
}

// ---------------------------------------------------------------------------
// Helper: drive merge-boundary flow to onAcceptFinal (returns pending_human)
// ---------------------------------------------------------------------------

async function driveToAcceptFinalMerge(
  flow: BoundedRepairFlow,
  fake: FakeExecutionRuntime,
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
  workItemId: string,
): Promise<{
  acceptObs: Awaited<ReturnType<FakeExecutionRuntime["retrieve"]>>;
  acceptRunId: string;
  contractId: string;
  contractVersion: number;
  artifactRevision: string;
}> {
  // 1. plan — dispatch lead.plan
  fake.script(TASK_IDS.leadPlan, () => ({
    status: "COMPLETED",
    output: { kind: "proposal", proposal: MERGE_HR_PROPOSAL },
  }));

  const planCmdId = newId("cmd");
  const { intentId: planIntentId } = await flow.plan(workItemId, planCmdId);

  // Script worker.attempt before onLeadPlanOutput triggers it.
  fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
    const p = payload as { attemptId: string };
    return {
      status: "COMPLETED",
      output: workerCompletedOutput(p.attemptId, {
        commitId: MERGE_HR_COMMIT_ID,
        changedPaths: ["src/parser/edge-cases.ts"],
      }),
    };
  });

  await flow.onLeadPlanOutput(
    planIntentId,
    { kind: "proposal", proposal: MERGE_HR_PROPOSAL },
    newId("cmd"),
  );

  // Get the contract (created in onLeadPlanOutput).
  const { rows: contractRows } = (await client.query(
    "SELECT * FROM step_contracts ORDER BY created_at",
  )) as { rows: Array<{ id: string; version: number; human_required: boolean }> };
  assert.equal(contractRows.length, 1, "step_contract created");
  const contractRow = contractRows[0];
  assert.ok(contractRow!.human_required, "merge-boundary contract is humanRequired");

  // 3. onWorkerFinal — creates artifact, dispatches verify
  const { rows: workerIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  )) as { rows: Array<{ run_id: string }> };
  const workerRunId = workerIntents[0]!.run_id;
  fake.advance(workerRunId);
  fake.advance(workerRunId);
  const workerObs = await fake.retrieve(workerRunId);

  // Script verify.run
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

  await flow.onWorkerFinal(workerObs, newId("cmd"));

  // Get artifact
  const { rows: artifactRows } = (await client.query("SELECT * FROM artifacts")) as {
    rows: Array<{ revision: string; diff_digest: string }>;
  };
  assert.equal(artifactRows.length, 1, "artifact created");
  const artifactRow = artifactRows[0]!;

  // 4. onVerifyFinal — stores VRs, dispatches lead.review
  const { rows: verifyIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.verifyRun],
  )) as { rows: Array<{ run_id: string }> };
  const verifyRunId = verifyIntents[0]!.run_id;
  fake.advance(verifyRunId);
  fake.advance(verifyRunId);
  const verifyObs = await fake.retrieve(verifyRunId);

  // Script lead.review
  fake.script(TASK_IDS.leadReview, () => ({
    status: "COMPLETED",
    output: goodReviewOutput({
      attemptRevision: artifactRow.revision,
      diffDigest: artifactRow.diff_digest,
      criteriaDigest: String(digestOf({ placeholder: "criteria" })),
      profileDigest: FAKE_PROFILE_DIGEST,
    }),
  }));

  await flow.onVerifyFinal(verifyObs, newId("cmd"));

  // 5. onReviewFinal — stores review, dispatches lead.accept
  const { rows: reviewIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.leadReview],
  )) as { rows: Array<{ run_id: string }> };
  const reviewRunId = reviewIntents[0]!.run_id;
  fake.advance(reviewRunId);
  fake.advance(reviewRunId);
  const reviewObs = await fake.retrieve(reviewRunId);

  // Script lead.accept — returns an accepting proposal
  const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
  fake.script(TASK_IDS.leadAccept, () => ({
    status: "COMPLETED",
    output: goodAcceptanceProposal(["c1"], [vrRef]),
  }));

  await flow.onReviewFinal(reviewObs, newId("cmd"));

  // 6. Get accept run
  const { rows: acceptIntents } = (await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.leadAccept],
  )) as { rows: Array<{ run_id: string }> };
  const acceptRunId = acceptIntents[0]!.run_id;
  fake.advance(acceptRunId);
  fake.advance(acceptRunId);
  const acceptObs = await fake.retrieve(acceptRunId);

  return {
    acceptObs,
    acceptRunId,
    contractId: contractRow!.id,
    contractVersion: contractRow!.version,
    artifactRevision: artifactRow.revision,
  };
}

// ---------------------------------------------------------------------------
// (i) humanRequired → pending_human → approve → completed
// ---------------------------------------------------------------------------

test("approve(i): humanRequired contract → pending_human → approve with matching version → work item completed", async (t) => {
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

      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinal(flow, fake, client, workItemId);

      // Store the accept observation in run_observations so approveWorkItem can recover
      // the AcceptanceProposal (same as what the Reconciler does via applyObservation).
      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      // onAcceptFinal: humanRequired contract → APPROVAL_REQUIRED → pending_human decision
      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      // Verify pending_human decision exists
      const { rows: pendingRows } = await client.query<{ outcome: string; attempt_id: string }>(
        "SELECT outcome, attempt_id FROM decisions WHERE kind = 'accept' AND work_item_id = $1",
        [workItemId],
      );
      assert.equal(pendingRows.length, 1, "one accept decision");
      assert.equal(pendingRows[0]!.outcome, "pending_human", "decision is pending_human");

      // Work item should still be active (not completed yet).
      const { rows: wiRows1 } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.notEqual(
        wiRows1[0]!.lifecycle,
        "completed",
        "work item not yet completed before approve",
      );

      // Approve with matching contractId + contractVersion + attemptRevision
      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra" },
      };

      const result = await approveWorkItem(approveDeps, {
        commandId: `cmd-approve-${randomUUID()}`,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "alice",
      });

      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
      if (result.ok) {
        assert.ok(result.decisionId, "decisionId returned");
        assert.equal(result.artifactRevision, artifactRevision, "artifactRevision matches");
        assert.equal(result.replayed, undefined, "not a replay");
      }

      // Work item should now be completed at artifact boundary.
      const { rows: wiRows2 } = await client.query<{ lifecycle: string; boundary: string }>(
        "SELECT lifecycle, boundary FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows2[0]!.lifecycle, "completed", "work item completed");
      assert.equal(wiRows2[0]!.boundary, "artifact", "boundary = artifact");

      // Approved decision recorded.
      const { rows: approvedDecisions } = await client.query<{ outcome: string; actor: string }>(
        "SELECT outcome, actor FROM decisions WHERE kind = 'accept' AND outcome = 'approved' AND work_item_id = $1",
        [workItemId],
      );
      assert.equal(approvedDecisions.length, 1, "approved decision recorded");
      assert.equal(approvedDecisions[0]!.actor, "human", "actor = human");

      // Exactly one approvals row.
      const { rows: approvalRows } = await client.query<{ human_actor: string }>(
        "SELECT human_actor FROM approvals",
      );
      assert.equal(approvalRows.length, 1, "exactly one approvals row");
      assert.equal(approvalRows[0]!.human_actor, "alice", "human_actor = alice");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (ii) approve with wrong attemptRevision → APPROVAL_VERSION_MISMATCH
// ---------------------------------------------------------------------------

test("approve(ii): wrong attemptRevision → APPROVAL_VERSION_MISMATCH, work item stays active", async (t) => {
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

      const { acceptObs, acceptRunId, contractId, contractVersion } = await driveToAcceptFinal(
        flow,
        fake,
        client,
        workItemId,
      );

      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra" },
      };

      // Use a different (wrong) attemptRevision.
      const WRONG_REVISION = "0000000000000000000000000000000000000000";
      const result = await approveWorkItem(approveDeps, {
        commandId: `cmd-mismatch-${randomUUID()}`,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: WRONG_REVISION,
        actor: "bob",
      });

      assert.equal(result.ok, false, "should not be ok");
      if (!result.ok) {
        assert.equal(
          result.reason,
          "APPROVAL_VERSION_MISMATCH",
          "reason = APPROVAL_VERSION_MISMATCH",
        );
        assert.ok(
          Array.isArray(result.reasons) && result.reasons.length > 0,
          "reasons list non-empty",
        );
      }

      // Work item remains active.
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.notEqual(wiRows[0]!.lifecycle, "completed", "work item still not completed");

      // No approvals row.
      const { rows: approvalRows } = await client.query<{ id: string }>("SELECT id FROM approvals");
      assert.equal(approvalRows.length, 0, "no approvals row on mismatch");

      // An approval_mismatch decision recorded (T-4: not 'rejected', so pending remains open).
      const { rows: mismatchRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'accept' AND outcome = 'approval_mismatch'",
      );
      assert.equal(mismatchRows.length, 1, "approval_mismatch decision recorded");

      // The pending_human decision remains open (not resolved by mismatch — T-4).
      const { rows: pendingRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'accept' AND outcome = 'pending_human'",
      );
      assert.equal(pendingRows.length, 1, "pending_human decision still open after mismatch");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (iii) replay: same commandId → replayed=true, exactly one approvals row
// ---------------------------------------------------------------------------

test("approve(iii): replay same commandId → replayed=true, exactly one approvals row", async (t) => {
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

      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinal(flow, fake, client, workItemId);

      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra" },
      };

      const commandId = `cmd-replay-${randomUUID()}`;
      const approveInput = {
        commandId,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "charlie",
      };

      // First call
      const first = await approveWorkItem(approveDeps, approveInput);
      assert.ok(first.ok, `first call should succeed, got: ${JSON.stringify(first)}`);
      assert.equal(first.replayed, undefined, "first call not replayed");

      // Second call with same commandId
      const second = await approveWorkItem(approveDeps, approveInput);
      assert.ok(
        second.ok,
        `second call should also be ok (replayed), got: ${JSON.stringify(second)}`,
      );
      assert.equal(second.replayed, true, "second call is replayed");

      // Same decisionId and artifactRevision
      if (first.ok && second.ok) {
        assert.equal(second.decisionId, first.decisionId, "same decisionId on replay");
        assert.equal(
          second.artifactRevision,
          first.artifactRevision,
          "same artifactRevision on replay",
        );
      }

      // Exactly one approvals row (idempotent).
      const { rows: approvalRows } = await client.query<{ id: string }>("SELECT id FROM approvals");
      assert.equal(approvalRows.length, 1, "exactly one approvals row after replay");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (iv) approve on work item with no pending decision → state_mismatch
// ---------------------------------------------------------------------------

test("approve(iv): no pending_human decision → state_mismatch", async (t) => {
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

      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra" },
      };

      // Approve directly with no prior pending_human decision.
      const result = await approveWorkItem(approveDeps, {
        commandId: `cmd-nomatch-${randomUUID()}`,
        workItemId,
        contractId: "sc_doesnotexist",
        contractVersion: 1,
        attemptRevision: "0000000000000000000000000000000000000000",
        actor: "dave",
      });

      assert.equal(result.ok, false, "should not be ok");
      if (!result.ok) {
        assert.equal(result.reason, "state_mismatch", "reason = state_mismatch");
      }

      // Work item unchanged.
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows[0]!.lifecycle, "proposed", "work item still in initial lifecycle");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (v) merge-boundary humanRequired → pending_human → approve → integrations +
//     integrate.merge intent committed before trigger, work item still active;
//     then integrate run completes → work item completed  (R-006, R-015)
// ---------------------------------------------------------------------------

test("approve(v): merge-boundary humanRequired → approve → integrations + intent committed, work item active; integrate → completed", async (t) => {
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
      // Seed with merge boundary and MERGE_HR_AUTHORITY
      const { workItemId } = await seedProjectAndWorkItem(client, {
        boundary: "merge",
        authority: MERGE_HR_AUTHORITY,
      });
      const fake = new FakeExecutionRuntime();

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

      // Drive through flow → acceptObs parked as pending_human
      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinalMerge(flow, fake, client, workItemId);

      // Store the accept observation (Reconciler does this via applyObservation)
      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      // Script integrate.merge BEFORE onAcceptFinal so fake knows what to return
      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: "0000000000000000000000000000000000000000",
          evidence: ["Pushed successfully"],
        },
      }));

      // onAcceptFinal: humanRequired merge contract → APPROVAL_REQUIRED → pending_human
      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      // Verify pending_human decision exists
      const { rows: pendingRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'accept' AND work_item_id = $1",
        [workItemId],
      );
      assert.equal(pendingRows.length, 1, "one accept decision");
      assert.equal(pendingRows[0]!.outcome, "pending_human", "decision is pending_human");

      // Work item should still be active
      const { rows: wiRows0 } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.notEqual(wiRows0[0]!.lifecycle, "completed", "work item not completed before approve");

      // Approve with matching values
      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra", worktreeBase: "/worktrees" },
      };

      const commandId = `cmd-approve-merge-${randomUUID()}`;
      const result = await approveWorkItem(approveDeps, {
        commandId,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "alice",
      });

      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
      if (result.ok) {
        assert.ok(result.decisionId, "decisionId returned");
        assert.equal(result.artifactRevision, artifactRevision, "artifactRevision matches");
      }

      // Work item must STILL be active (merge boundary — integration pending)
      const { rows: wiRows1 } = await client.query<{ lifecycle: string; boundary: string }>(
        "SELECT lifecycle, boundary FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows1[0]!.lifecycle, "active", "work item still active after approve (merge)");

      // Approved decision recorded
      const { rows: approvedDecisions } = await client.query<{ outcome: string; actor: string }>(
        "SELECT outcome, actor FROM decisions WHERE kind = 'accept' AND outcome = 'approved' AND work_item_id = $1",
        [workItemId],
      );
      assert.equal(approvedDecisions.length, 1, "approved decision recorded");
      assert.equal(approvedDecisions[0]!.actor, "human", "actor = human");

      // Exactly one approvals row
      const { rows: approvalRows } = await client.query<{ human_actor: string }>(
        "SELECT human_actor FROM approvals",
      );
      assert.equal(approvalRows.length, 1, "exactly one approvals row");
      assert.equal(approvalRows[0]!.human_actor, "alice", "human_actor = alice");

      // integrations row must exist and be committed before trigger
      const { rows: integRows } = await client.query<{ outcome: string | null }>(
        "SELECT outcome FROM integrations WHERE attempt_id IN (SELECT id FROM attempts)",
      );
      assert.equal(integRows.length, 1, "integrations row exists after approve");
      assert.equal(integRows[0]!.outcome, null, "integrations outcome null (pending)");

      // dispatch_intent for integrate.merge must exist
      const { rows: mergeIntents } = await client.query<{ run_id: string | null; status: string }>(
        "SELECT run_id, status FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(mergeIntents.length, 1, "integrate.merge intent exists after approve");
      assert.ok(mergeIntents[0]!.run_id, "integrate.merge run triggered");

      // Now process the integrate.merge run → work item completed
      const mergeRunId = mergeIntents[0]!.run_id!;
      fake.advance(mergeRunId);
      fake.advance(mergeRunId);
      const mergeObs = await fake.retrieve(mergeRunId);

      await onIntegrateFinal(mergeObs, `cmd_obs_${mergeObs.runId}_1`, deps);

      // Work item completed at merge boundary
      const { rows: wiRows2 } = await client.query<{ lifecycle: string; boundary: string }>(
        "SELECT lifecycle, boundary FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows2[0]!.lifecycle, "completed", "work item completed after integrate");
      assert.equal(wiRows2[0]!.boundary, "merge", "boundary = merge");

      // integrations row finalized
      const { rows: integRows2 } = await client.query<{
        outcome: string;
        resulting_revision: string;
      }>(
        "SELECT outcome, resulting_revision FROM integrations WHERE attempt_id IN (SELECT id FROM attempts)",
      );
      assert.equal(integRows2[0]!.outcome, "integrated", "integrations.outcome = integrated");
      assert.equal(
        integRows2[0]!.resulting_revision,
        INTEGRATED_REVISION,
        "resulting_revision set",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (vi) artifact-boundary approve still completes work item immediately
//      (regression guard for R-006: artifact path unchanged by the fix)
// ---------------------------------------------------------------------------

test("approve(vi): artifact-boundary humanRequired → approve → work item completed immediately", async (t) => {
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

      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinal(flow, fake, client, workItemId);

      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra", worktreeBase: "/worktrees" },
      };

      const result = await approveWorkItem(approveDeps, {
        commandId: `cmd-approve-art-${randomUUID()}`,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "eve",
      });

      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);

      // Work item must be completed immediately (artifact boundary)
      const { rows: wiRows } = await client.query<{ lifecycle: string; boundary: string }>(
        "SELECT lifecycle, boundary FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows[0]!.lifecycle, "completed", "work item completed at artifact boundary");
      assert.equal(wiRows[0]!.boundary, "artifact", "boundary = artifact");

      // No integrate.merge intent dispatched
      const { rows: mergeIntents } = await client.query<{ id: string }>(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(mergeIntents.length, 0, "no integrate.merge intent for artifact boundary");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (vii) replay of approve after (v) → no second integrate.merge intent
// ---------------------------------------------------------------------------

test("approve(vii): replay of merge-boundary approve → no second integrate.merge intent", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, {
        boundary: "merge",
        authority: MERGE_HR_AUTHORITY,
      });
      const fake = new FakeExecutionRuntime();

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

      // Script integrate.merge for when approve triggers it
      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: "0000000000000000000000000000000000000000",
          evidence: ["Pushed successfully"],
        },
      }));

      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinalMerge(flow, fake, client, workItemId);

      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra", worktreeBase: "/worktrees" },
      };

      const commandId = `cmd-approve-replay-${randomUUID()}`;
      const approveInput = {
        commandId,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "frank",
      };

      // First call → success, triggers integrate.merge
      const first = await approveWorkItem(approveDeps, approveInput);
      assert.ok(first.ok, `first call should succeed, got: ${JSON.stringify(first)}`);
      assert.equal(first.replayed, undefined, "first call not replayed");

      // Count dispatch_intents for integrate.merge after first call
      const { rows: intents1 } = await client.query<{ id: string }>(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(intents1.length, 1, "exactly one integrate.merge intent after first approve");

      // Second call with same commandId → replayed, no second intent
      const second = await approveWorkItem(approveDeps, approveInput);
      assert.ok(
        second.ok,
        `second call should also be ok (replayed), got: ${JSON.stringify(second)}`,
      );
      assert.equal(second.replayed, true, "second call is replayed");

      // Still only one integrate.merge intent (idempotent)
      const { rows: intents2 } = await client.query<{ id: string }>(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(intents2.length, 1, "still exactly one integrate.merge intent after replay");

      // Exactly one approvals row
      const { rows: approvalRows } = await client.query<{ id: string }>("SELECT id FROM approvals");
      assert.equal(approvalRows.length, 1, "exactly one approvals row after replay");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// S-4 (approve path): R-002 ordering — integrations row and merge intent exist
//     before trigger when approve drives finalizeAcceptedAttempt
// ---------------------------------------------------------------------------

test("approve(S-4): R-002 ordering — integrations row and merge intent committed before trigger in approve path", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, {
        boundary: "merge",
        authority: MERGE_HR_AUTHORITY,
      });
      const fake = new FakeExecutionRuntime();

      let orderingPassed = false;

      // Wrap fake.trigger to assert ordering when integrate.merge is triggered
      const baseRuntime = fake;
      const instrumentedRuntime = {
        trigger: async (args: Parameters<typeof fake.trigger>[0]) => {
          if (args.task === TASK_IDS.integrateMerge) {
            const { rows: intRows } = await pool.query(
              "SELECT * FROM integrations WHERE attempt_id IN (SELECT id FROM attempts)",
            );
            assert.ok(
              intRows.length >= 1,
              "integrations row must exist BEFORE trigger (approve path)",
            );
            const { rows: intentRows } = await pool.query(
              "SELECT * FROM dispatch_intents WHERE task = $1",
              [TASK_IDS.integrateMerge],
            );
            assert.ok(
              intentRows.length >= 1,
              "integrate.merge intent must exist BEFORE trigger (approve path)",
            );
            orderingPassed = true;
          }
          return baseRuntime.trigger(args);
        },
        cancel: baseRuntime.cancel.bind(baseRuntime),
        retrieve: baseRuntime.retrieve.bind(baseRuntime),
        createPublicToken: baseRuntime.createPublicToken.bind(baseRuntime),
      };

      const deps: FlowDeps = {
        pool,
        runtime: instrumentedRuntime as FlowDeps["runtime"],
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

      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinalMerge(flow, fake, client, workItemId);

      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: "0000000000000000000000000000000000000000",
          evidence: [],
        },
      }));

      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      const approveDeps: ApproveDeps = {
        pool,
        runtime: instrumentedRuntime as FlowDeps["runtime"],
        clock,
        config: { workerModel: "openai/gpt-5.6-terra", worktreeBase: "/worktrees" },
      };

      const result = await approveWorkItem(approveDeps, {
        commandId: `cmd-approve-s4-ordering-${randomUUID()}`,
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "alice",
      });

      assert.ok(result.ok, `approve must succeed: ${JSON.stringify(result)}`);
      assert.ok(
        orderingPassed,
        "ordering check must have fired for integrate.merge trigger in approve path",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// S-16: second approve with a fresh commandId → state_mismatch
//        (pending decision already resolved; must not re-run finalizeAcceptedAttempt)
// ---------------------------------------------------------------------------

test("approve(S-16): second approve with fresh commandId → state_mismatch, one integrations row, one intent", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, {
        boundary: "merge",
        authority: MERGE_HR_AUTHORITY,
      });
      const fake = new FakeExecutionRuntime();

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

      const { acceptObs, acceptRunId, contractId, contractVersion, artifactRevision } =
        await driveToAcceptFinalMerge(flow, fake, client, workItemId);

      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
         VALUES ($1, 1, false, $2::jsonb, now())`,
        [acceptRunId, JSON.stringify(acceptObs)],
      );

      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: "0000000000000000000000000000000000000000",
          evidence: [],
        },
      }));

      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      const approveDeps: ApproveDeps = {
        pool,
        runtime: fake,
        clock,
        config: { workerModel: "openai/gpt-5.6-terra", worktreeBase: "/worktrees" },
      };

      const approveInput = {
        workItemId,
        contractId,
        contractVersion,
        attemptRevision: artifactRevision,
        actor: "alice",
      };

      // First approve — must succeed
      const first = await approveWorkItem(approveDeps, {
        commandId: `cmd-approve-s16-first-${randomUUID()}`,
        ...approveInput,
      });
      assert.ok(first.ok, `first approve must succeed: ${JSON.stringify(first)}`);

      // Second approve with a DIFFERENT commandId — must return state_mismatch
      const second = await approveWorkItem(approveDeps, {
        commandId: `cmd-approve-s16-second-${randomUUID()}`,
        ...approveInput,
      });
      assert.ok(!second.ok, "second approve must not be ok");
      if (!second.ok) {
        assert.equal(second.reason, "state_mismatch", "second approve reason = state_mismatch");
      }

      // Exactly one integrations row (finalizeAcceptedAttempt must not have run twice)
      const { rows: integRows } = await client.query<{ id: string }>(
        "SELECT id FROM integrations WHERE attempt_id IN (SELECT id FROM attempts)",
      );
      assert.equal(integRows.length, 1, "exactly one integrations row (no re-run)");

      // Exactly one integrate.merge intent
      const { rows: mergeIntents } = await client.query<{ id: string }>(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(mergeIntents.length, 1, "exactly one integrate.merge intent (no re-run)");

      // Exactly one approved decision
      const { rows: approvedDecisions } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'accept' AND outcome = 'approved' AND work_item_id = $1",
        [workItemId],
      );
      assert.equal(approvedDecisions.length, 1, "exactly one approved decision");
    } finally {
      await pool.end();
    }
  });
});
