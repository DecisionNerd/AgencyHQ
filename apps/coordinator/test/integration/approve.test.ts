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
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { LeadProposal } from "@agencyhq/contracts";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import type { ApproveDeps } from "../../src/commands/approve.ts";
import { approveWorkItem } from "../../src/commands/approve.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
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

      // A rejected decision recorded.
      const { rows: rejectedRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'accept' AND outcome = 'rejected'",
      );
      assert.equal(rejectedRows.length, 1, "rejected decision recorded");
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
