/**
 * Integration tests: merge boundary flow.
 *
 * Tests 1–7 per PACKET 4.2.a:
 * 1. Merge happy path: accept → integrations + intent committed before trigger
 *    → integrated → result_revision set, work item completed.
 * 2. base_moved → pending_human decision, integration_conflict finding, not completed.
 * 3. Crashed run + remote already contains attempt → completed without re-dispatch.
 * 4. Crashed run + remote unchanged → retry_cas; after AGENCYHQ_INTEGRATE_RETRIES → escalate.
 * 5. Replay of integrated observation → no second completion, one integrations row.
 * 6. Deploy proposal → pending_human with DEPLOY_NOT_SUPPORTED.
 * 7. Two-entry manifest: entry 0 integrates → lead.plan dispatched for entry 1.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, HOST_TRIAL_AUTHORITY, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";

import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import { onIntegrateFinal } from "../../src/flow/integrate.ts";
import type { FlowDeps, IsAncestorFn, LsRemoteFn } from "../../src/flow/types.ts";
import {
  goodAcceptanceProposal,
  goodReviewOutput,
  passingVerificationResult,
  workerCompletedOutput,
} from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const ATTEMPT_REVISION = "aabbccdd1234567890aabbccdd1234567890aabb";
const BASE_REVISION = "0000000000000000000000000000000000000000";
const INTEGRATED_REVISION = "1111111111111111111111111111111111111111";
const _TARGET_REF = "refs/heads/main";

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: [],
});

const HOST_PROFILE = {
  id: "host" as const,
  enforcement: {
    worktree: "before_action" as const,
    fs_isolation: "advisory" as const,
    cpu_memory: "advisory" as const,
    duration: "before_action" as const,
    capability: "before_action" as const,
    output_paths: "on_output" as const,
    push: "before_action" as const,
    integrate: "before_action" as const,
    termination: "trusted_observation" as const,
    egress_spend: "advisory" as const,
    nested_agents: "before_action" as const,
  },
};

const clock = { now: () => new Date().toISOString() };
const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };

// ---------------------------------------------------------------------------
// Helpers: run the full flow up to acceptance (plan → work → verify → review → accept)
// ---------------------------------------------------------------------------

async function runFullFlowToAccept(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  _pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  workItemId: string,
  deps: FlowDeps,
  opts?: { boundary?: "merge" | "artifact" },
): Promise<{
  contractRow: Record<string, unknown>;
  attemptRow: Record<string, unknown>;
  artifactRow: Record<string, unknown>;
}> {
  const flow = new BoundedRepairFlow(deps);
  const boundary = opts?.boundary ?? "merge";

  // Script lead.plan to return a merge boundary proposal.
  fake.script(TASK_IDS.leadPlan, () => ({
    status: "COMPLETED",
    output: {
      kind: "proposal",
      proposal: {
        criteria: [{ id: "c1", text: "Parser works", source: "operator", citation: "Test" }],
        profileId: "default",
        changeClass: "behavior",
        review: "adversarial",
        boundary,
        paths: {
          allow: ["src/parser/edge-cases.ts"],
          deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
        },
        capabilities: {
          bash: { allow: ["pnpm test*"], deny: [] },
          tools: {
            edit: true,
            webfetch: false,
            websearch: false,
            task: false,
            external_directory: false,
            skill: false,
          },
        },
        budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
        models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
        rationale: "Fix parser edge cases",
        sources: [{ criterionId: "c1", source: "operator", citation: "Test" }],
      },
    },
  }));

  // 1. plan
  const planCmdId = newId("cmd");
  const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
  fake.advance(planRunId);
  fake.advance(planRunId);
  const planObs = await fake.retrieve(planRunId);

  // 2. onLeadPlanOutput
  fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
    const p = payload as { attemptId: string };
    return {
      status: "COMPLETED",
      output: workerCompletedOutput(p.attemptId, { commitId: ATTEMPT_REVISION }),
    };
  });
  await flow.onLeadPlanOutput(planIntentId, planObs.output as never, newId("cmd"));

  // Load rows
  const { rows: contractRows } = await client.query(
    "SELECT * FROM step_contracts ORDER BY created_at",
  );
  const contractRow = contractRows[0] as Record<string, unknown>;

  const { rows: attemptRows } = await client.query("SELECT * FROM attempts ORDER BY created_at");
  const attemptRow = attemptRows[0] as Record<string, unknown>;

  const { rows: workerIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.workerAttempt],
  );
  const workerIntent = workerIntents[0] as Record<string, unknown>;
  const workerRunId = workerIntent.run_id as string;

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
    return {
      status: "COMPLETED",
      output: {
        results: [
          passingVerificationResult({
            verifierName: "agencyhq-verifier",
            stepContractId: p.contractId,
            attemptId: p.attemptId,
            criteriaDigest: p.criteriaDigest,
            profileDigest: p.profileDigest,
            baseRevision: p.baseRevision,
            attemptRevision: p.attemptRevision,
            diffDigest: p.diffDigest,
            checkId: "pnpm-test",
          }),
        ],
      },
    };
  });

  // 3. onWorkerFinal
  fake.advance(workerRunId);
  fake.advance(workerRunId);
  const workerObs = await fake.retrieve(workerRunId);
  await flow.onWorkerFinal(workerObs, newId("cmd"));

  // Load artifact
  const { rows: artifactRows } = await client.query("SELECT * FROM artifacts ORDER BY created_at");
  const artifactRow = artifactRows[0] as Record<string, unknown>;

  // Script lead.review
  fake.script(TASK_IDS.leadReview, () => ({
    status: "COMPLETED",
    output: goodReviewOutput({
      attemptRevision: artifactRow.revision as string,
      diffDigest: artifactRow.diff_digest as string,
      criteriaDigest: contractRow.criteria_digest as string,
      profileDigest: FAKE_PROFILE_DIGEST,
    }),
  }));

  // 4. onVerifyFinal
  const { rows: verifyIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.verifyRun],
  );
  const verifyRunId = (verifyIntents[0] as Record<string, unknown>).run_id as string;
  fake.advance(verifyRunId);
  fake.advance(verifyRunId);
  const verifyObs = await fake.retrieve(verifyRunId);
  await flow.onVerifyFinal(verifyObs, newId("cmd"));

  // Script lead.accept
  const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision as string}`;
  fake.script(TASK_IDS.leadAccept, () => ({
    status: "COMPLETED",
    output: goodAcceptanceProposal(["c1"], [vrRef]),
  }));

  // 5. onReviewFinal
  const { rows: reviewIntents } = await client.query(
    "SELECT * FROM dispatch_intents WHERE task = $1",
    [TASK_IDS.leadReview],
  );
  const reviewRunId = (reviewIntents[0] as Record<string, unknown>).run_id as string;
  fake.advance(reviewRunId);
  fake.advance(reviewRunId);
  const reviewObs = await fake.retrieve(reviewRunId);
  await flow.onReviewFinal(reviewObs, newId("cmd"));

  return { contractRow, attemptRow, artifactRow };
}

// ---------------------------------------------------------------------------
// Test 1: Merge happy path
// ---------------------------------------------------------------------------

test("flow.integrate (1): merge happy path — accept, integrate, complete", async (t) => {
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
      const { workItemId, projectId } = await seedProjectAndWorkItem(client, { boundary: "merge" });

      const fake = new FakeExecutionRuntime();

      // Script integrate.merge to return integrated
      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: BASE_REVISION,
          evidence: ["Pushed successfully"],
        },
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

      await runFullFlowToAccept(client, pool, fake, workItemId, deps, { boundary: "merge" });

      // After onLeadPlanOutput: work_item_projects row should exist (implicit manifest)
      const { rows: wipRows } = await client.query(
        "SELECT * FROM work_item_projects WHERE work_item_id = $1",
        [workItemId],
      );
      assert.equal(wipRows.length, 1, "work_item_projects row created at plan time");
      const wipRow = wipRows[0] as Record<string, unknown>;
      assert.equal(wipRow.position, 0, "position = 0");
      assert.equal(wipRow.target_ref, "refs/heads/main", "target_ref = refs/heads/main");

      // After onAcceptFinal: check integrations row and intent committed BEFORE trigger
      // (R-002: recorded before trigger)
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as Record<string, unknown>).run_id as string;

      // Run accept
      const flow = new BoundedRepairFlow(deps);
      // (flow already run during runFullFlowToAccept)
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);
      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      // Verify: integrations row exists (R-002: committed before trigger)
      const { rows: integRows } = await client.query(
        "SELECT * FROM integrations WHERE attempt_id IN (SELECT id FROM attempts)",
      );
      assert.equal(integRows.length, 1, "integrations row inserted at accept time");
      const integRow = integRows[0] as Record<string, unknown>;
      assert.equal(integRow.target_ref, "refs/heads/main", "target_ref matches");
      assert.equal(integRow.outcome, null, "outcome null (pending)");

      // Verify: dispatch intent for integrate.merge exists
      const { rows: mergeIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(mergeIntents.length, 1, "integrate.merge intent created");
      const mergeIntent = mergeIntents[0] as Record<string, unknown>;
      assert.ok(mergeIntent.run_id, "integrate.merge run triggered");

      // Verify: work item NOT yet completed (merge boundary — integration pending)
      const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows[0] as Record<string, unknown>).lifecycle,
        "active",
        "work item still active after accept",
      );

      // Now process the integrate.merge observation
      const mergeRunId = mergeIntent.run_id as string;
      fake.advance(mergeRunId);
      fake.advance(mergeRunId);
      const mergeObs = await fake.retrieve(mergeRunId);

      const commandId = `cmd_obs_${mergeObs.runId}_1`;
      await onIntegrateFinal(mergeObs, commandId, deps);

      // result_revision set
      const { rows: wipRows2 } = await client.query(
        "SELECT * FROM work_item_projects WHERE work_item_id = $1",
        [workItemId],
      );
      const wipRow2 = wipRows2[0] as Record<string, unknown>;
      assert.equal(wipRow2.result_revision, INTEGRATED_REVISION, "result_revision set");

      // integration row finalized
      const { rows: integRows2 } = await client.query("SELECT * FROM integrations WHERE id = $1", [
        integRow.id,
      ]);
      assert.equal(
        (integRows2[0] as Record<string, unknown>).outcome,
        "integrated",
        "outcome = integrated",
      );
      assert.equal(
        (integRows2[0] as Record<string, unknown>).resulting_revision,
        INTEGRATED_REVISION,
      );

      // Work item completed
      const { rows: wiRows2 } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows2[0] as Record<string, unknown>).lifecycle,
        "completed",
        "work item completed",
      );
      assert.equal((wiRows2[0] as Record<string, unknown>).boundary, "merge", "boundary = merge");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: base_moved → pending_human, integration_conflict finding
// ---------------------------------------------------------------------------

test("flow.integrate (2): base_moved → pending_human, integration_conflict finding", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, { boundary: "merge" });
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "base_moved",
          observedTargetRevision: INTEGRATED_REVISION,
          evidence: ["Remote has moved"],
        },
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

      await runFullFlowToAccept(client, pool, fake, workItemId, deps, { boundary: "merge" });

      const flow = new BoundedRepairFlow(deps);
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = (acceptIntents[0] as Record<string, unknown>).run_id as string;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      await flow.onAcceptFinal(await fake.retrieve(acceptRunId), newId("cmd"));

      const { rows: mergeIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      const mergeRunId = (mergeIntents[0] as Record<string, unknown>).run_id as string;
      fake.advance(mergeRunId);
      fake.advance(mergeRunId);
      const mergeObs = await fake.retrieve(mergeRunId);

      await onIntegrateFinal(mergeObs, `cmd_obs_${mergeObs.runId}_1`, deps);

      // Work item NOT completed
      const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows[0] as Record<string, unknown>).lifecycle,
        "active",
        "work item not completed on base_moved",
      );

      // pending_human decision
      const { rows: decRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'integrate'",
      );
      assert.equal(decRows.length, 1, "integrate decision recorded");
      assert.equal((decRows[0] as Record<string, unknown>).outcome, "pending_human");

      // integration_conflict finding
      const { rows: findRows } = await client.query(
        "SELECT * FROM findings WHERE kind = 'integration_conflict'",
      );
      assert.equal(findRows.length, 1, "integration_conflict finding recorded");
      assert.equal((findRows[0] as Record<string, unknown>).severity, "blocking");

      // No second integrate.merge intent (only the one from accept)
      const { rows: mergeIntents2 } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(mergeIntents2.length, 1, "no second integrate.merge intent");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Crashed run + remote already contains attempt → completed
// ---------------------------------------------------------------------------

test("flow.integrate (3): crashed run + remote contains attempt → completed", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, { boundary: "merge" });
      const fake = new FakeExecutionRuntime();

      // Script integrate.merge to FAIL (crash)
      fake.script(TASK_IDS.integrateMerge, () => ({ status: "FAILED" }));

      // Fake lsRemote: returns INTEGRATED_REVISION (remote has the result)
      const fakeLsRemote: LsRemoteFn = async () => INTEGRATED_REVISION;
      // Fake isAncestor: true (attempt revision is ancestor of remote)
      const fakeIsAncestor: IsAncestorFn = async () => true;

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
        lsRemote: fakeLsRemote,
        isAncestor: fakeIsAncestor,
      };

      await runFullFlowToAccept(client, pool, fake, workItemId, deps, { boundary: "merge" });

      const flow = new BoundedRepairFlow(deps);
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      fake.advance((acceptIntents[0] as Record<string, unknown>).run_id as string);
      fake.advance((acceptIntents[0] as Record<string, unknown>).run_id as string);
      await flow.onAcceptFinal(
        await fake.retrieve((acceptIntents[0] as Record<string, unknown>).run_id as string),
        newId("cmd"),
      );

      const { rows: mergeIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      const mergeRunId = (mergeIntents[0] as Record<string, unknown>).run_id as string;
      fake.advance(mergeRunId);
      fake.advance(mergeRunId);
      const mergeObs = await fake.retrieve(mergeRunId);
      assert.equal(mergeObs.status, "FAILED", "run status is FAILED");

      await onIntegrateFinal(mergeObs, `cmd_obs_${mergeObs.runId}_1`, deps);

      // Work item completed (remote already had the push)
      const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows[0] as Record<string, unknown>).lifecycle,
        "completed",
        "completed via observed path",
      );
      assert.equal((wiRows[0] as Record<string, unknown>).boundary, "merge");

      // No new dispatch intent beyond the original
      const { rows: mergeIntents2 } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      assert.equal(mergeIntents2.length, 1, "no re-dispatch when remote already has attempt");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Crashed run + remote unchanged → retry_cas; exhaust → escalate
// ---------------------------------------------------------------------------

test("flow.integrate (4): crashed + unchanged remote → retry_cas; exhaust → escalate", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, { boundary: "merge" });
      const fake = new FakeExecutionRuntime();

      // Script integrate.merge to CRASH
      fake.script(TASK_IDS.integrateMerge, () => ({ status: "CRASHED" }));

      // Fake: remote unchanged (returns BASE_REVISION = same as expected)
      const fakeLsRemote: LsRemoteFn = async () => BASE_REVISION;
      const fakeIsAncestor: IsAncestorFn = async () => false;

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
          integrateRetries: 2,
        },
        profileResolver: FAKE_PROFILE_RESOLVER,
        lsRemote: fakeLsRemote,
        isAncestor: fakeIsAncestor,
      };

      await runFullFlowToAccept(client, pool, fake, workItemId, deps, { boundary: "merge" });

      const flow = new BoundedRepairFlow(deps);
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      fake.advance((acceptIntents[0] as Record<string, unknown>).run_id as string);
      fake.advance((acceptIntents[0] as Record<string, unknown>).run_id as string);
      await flow.onAcceptFinal(
        await fake.retrieve((acceptIntents[0] as Record<string, unknown>).run_id as string),
        newId("cmd"),
      );

      // Process 3 integrate.merge crashes (original + 2 retries)
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { rows: mergeIntents } = await client.query(
          "SELECT * FROM dispatch_intents WHERE task = $1 ORDER BY created_at",
          [TASK_IDS.integrateMerge],
        );
        const latestIntent = mergeIntents[mergeIntents.length - 1] as Record<string, unknown>;
        // Wait for run_id to be set
        const latestRunId = latestIntent.run_id as string;
        if (!latestRunId) {
          // Re-script for the new intent
          fake.script(TASK_IDS.integrateMerge, () => ({ status: "CRASHED" }));
        }

        // Force a run_id if not present (for retried intents)
        const runId = latestRunId;
        if (!runId) {
          // This shouldn't happen but just in case
          break;
        }

        fake.advance(runId);
        fake.advance(runId);
        const mergeObs = await fake.retrieve(runId);
        assert.equal(mergeObs.status, "CRASHED");

        const cmdId = `cmd_obs_${mergeObs.runId}_1`;
        await onIntegrateFinal(mergeObs, cmdId, deps);

        const { rows: mergeIntentsAfter } = await client.query(
          "SELECT * FROM dispatch_intents WHERE task = $1",
          [TASK_IDS.integrateMerge],
        );
        if (attempt < 3) {
          // Retries 1 and 2: a new intent should be created
          assert.equal(
            mergeIntentsAfter.length,
            attempt + 1,
            `retry ${attempt}: new intent created`,
          );
          // Script the next crash
          fake.script(TASK_IDS.integrateMerge, () => ({ status: "CRASHED" }));
        } else {
          // After 2 retries (attempt 3 = exhausted): no new intent, escalate
          assert.equal(mergeIntentsAfter.length, 3, "no new intent after retries exhausted");
        }
      }

      // Work item NOT completed
      const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows[0] as Record<string, unknown>).lifecycle,
        "active",
        "work item not completed after escalation",
      );

      // Escalation: integration_conflict finding and pending_human decision
      const { rows: findRows } = await client.query(
        "SELECT * FROM findings WHERE kind = 'integration_conflict'",
      );
      assert.equal(findRows.length, 1, "integration_conflict finding on escalation");

      const { rows: decRows } = await client.query(
        "SELECT * FROM decisions WHERE kind = 'integrate'",
      );
      assert.equal(decRows.length, 1, "pending_human decision on escalation");
      assert.equal((decRows[0] as Record<string, unknown>).outcome, "pending_human");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: Replay of integrated observation → no second completion
// ---------------------------------------------------------------------------

test("flow.integrate (5): replay of integrated observation → idempotent", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, { boundary: "merge" });
      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: BASE_REVISION,
          evidence: [],
        },
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

      await runFullFlowToAccept(client, pool, fake, workItemId, deps, { boundary: "merge" });

      const flow = new BoundedRepairFlow(deps);
      const { rows: acceptIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      fake.advance((acceptIntents[0] as Record<string, unknown>).run_id as string);
      fake.advance((acceptIntents[0] as Record<string, unknown>).run_id as string);
      await flow.onAcceptFinal(
        await fake.retrieve((acceptIntents[0] as Record<string, unknown>).run_id as string),
        newId("cmd"),
      );

      const { rows: mergeIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.integrateMerge],
      );
      const mergeRunId = (mergeIntents[0] as Record<string, unknown>).run_id as string;
      fake.advance(mergeRunId);
      fake.advance(mergeRunId);
      const mergeObs = await fake.retrieve(mergeRunId);

      const commandId = `cmd_obs_${mergeObs.runId}_1`;

      // First call — should complete
      await onIntegrateFinal(mergeObs, commandId, deps);

      // Verify completed
      const { rows: wiRows1 } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal((wiRows1[0] as Record<string, unknown>).lifecycle, "completed");

      // Second call (replay) — should be idempotent (no-op via claimCommand)
      await onIntegrateFinal(mergeObs, commandId, deps);

      // Still only one integrations row
      const { rows: integRows } = await client.query("SELECT * FROM integrations");
      assert.equal(integRows.length, 1, "still only one integrations row after replay");

      // Work item version unchanged (no double-update)
      const { rows: wiRows2 } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows2[0] as Record<string, unknown>).version,
        (wiRows1[0] as Record<string, unknown>).version,
        "work item version unchanged on replay",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Deploy proposal → pending_human with DEPLOY_NOT_SUPPORTED
// ---------------------------------------------------------------------------

test("flow.integrate (6): deploy proposal → pending_human DEPLOY_NOT_SUPPORTED", async (t) => {
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
      const { workItemId } = await seedProjectAndWorkItem(client, { boundary: "deploy" });
      const fake = new FakeExecutionRuntime();

      // Script lead.plan to return a deploy boundary proposal
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: {
          kind: "proposal",
          proposal: {
            criteria: [{ id: "c1", text: "Deploy works", source: "operator", citation: "Test" }],
            profileId: "default",
            changeClass: "behavior",
            review: "adversarial",
            boundary: "deploy",
            paths: {
              allow: ["src/parser/edge-cases.ts"],
              deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
            },
            capabilities: {
              bash: { allow: ["pnpm test*"], deny: [] },
              tools: {
                edit: true,
                webfetch: false,
                websearch: false,
                task: false,
                external_directory: false,
                skill: false,
              },
            },
            budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
            models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
            rationale: "Deploy edge cases",
            sources: [{ criterionId: "c1", source: "operator", citation: "Test" }],
          },
        },
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

      // plan
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);
      const planObs = await fake.retrieve(planRunId);

      // onLeadPlanOutput with deploy proposal
      await flow.onLeadPlanOutput(planIntentId, planObs.output as never, newId("cmd"));

      // Should produce a pending_human decision with DEPLOY_NOT_SUPPORTED
      const { rows: decRows } = await client.query("SELECT * FROM decisions WHERE kind = 'plan'");
      assert.equal(decRows.length, 1, "plan decision recorded");
      assert.equal(
        (decRows[0] as Record<string, unknown>).outcome,
        "pending_human",
        "outcome = pending_human",
      );

      // No step_contracts created (deploy blocked)
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 0, "no step_contract created for deploy");

      // No work_item_projects rows
      const { rows: wipRows } = await client.query(
        "SELECT * FROM work_item_projects WHERE work_item_id = $1",
        [workItemId],
      );
      assert.equal(wipRows.length, 0, "no work_item_projects for deploy");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: Two-entry manifest: entry 0 integrates → lead.plan for entry 1
// ---------------------------------------------------------------------------

test("flow.integrate (7): two-entry manifest — entry 0 integrates → lead.plan for entry 1", async (t) => {
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
      // Seed two projects
      const projectAId = newId("prj");
      const projectBId = newId("prj");
      const workItemId = newId("wi");

      const ENTRY_1_BASE = "aaaa000000000000000000000000000000000000";

      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: BASE_REVISION }), JSON.stringify(HOST_TRIAL_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-b', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectBId, JSON.stringify({ main: ENTRY_1_BASE }), JSON.stringify(HOST_TRIAL_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Multi-repo fix', NULL, 'merge', 'proposed', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );

      // Manually create work_item_projects for both entries (simulating what 4.2.b would do)
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'refs/heads/main', $3), ($1, $4, 1, 'refs/heads/main', $5)`,
        [workItemId, projectAId, BASE_REVISION, projectBId, ENTRY_1_BASE],
      );

      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.integrateMerge, () => ({
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: BASE_REVISION,
          evidence: [],
        },
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

      // Manually create a contract, attempt, artifact, and integration setup for project A
      // (bypassing the full flow for brevity, focusing on what integrate.ts needs)
      const contractId = newId("sc");
      const attemptId = newId("att");
      const integId = `intg_${newId("di")}`;
      const mergeIntentId = newId("di");

      await client.query(
        `INSERT INTO step_contracts
           (id, work_item_id, project_id, version, base_revision, inputs, criteria,
            criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
            human_required, status, target_ref)
         VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, 'cd1', 'default', 'pd1',
                 $7::jsonb, '["merge"]'::jsonb, false, 'active', 'refs/heads/main')`,
        [
          contractId,
          workItemId,
          projectAId,
          BASE_REVISION,
          JSON.stringify({ intent: "Multi-repo fix" }),
          JSON.stringify([{ id: "c1", text: "Works", source: "operator", citation: "Test" }]),
          JSON.stringify({
            paths: { allow: ["src/**"], deny: [] },
            capabilities: {
              bash: { allow: [], deny: [] },
              tools: {
                edit: true,
                webfetch: false,
                websearch: false,
                task: false,
                external_directory: false,
                skill: false,
              },
            },
            boundary: "merge",
            budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 1 },
            review: "lead_inspection",
            changeClass: "behavior",
            models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
          }),
        ],
      );

      await client.query(
        `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining, commit_sha)
         VALUES ($1, $2, 1, 1, 'accepted', 2, $3)`,
        [attemptId, contractId, ATTEMPT_REVISION],
      );

      await client.query(
        `INSERT INTO integrations (id, attempt_id, contract_id, contract_version, target_ref, expected_base_revision)
         VALUES ($1, $2, $3, 1, 'refs/heads/main', $4)`,
        [integId, attemptId, contractId, BASE_REVISION],
      );

      // Create a fake integrate.merge run and intent
      const fakeRunId = `run_${String(Math.random()).slice(2)}`;
      await client.query(
        `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, 'pd1', $3, 'triggered', $4, $5)`,
        [mergeIntentId, TASK_IDS.integrateMerge, attemptId, fakeRunId, `${mergeIntentId}:g1`],
      );

      // Build a fake observation (RunObservation shape, passed directly to onIntegrateFinal)
      const fakeObs = {
        runId: fakeRunId,
        status: "COMPLETED" as const,
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_REVISION,
          observedTargetRevision: BASE_REVISION,
          evidence: [],
        },
        observedAt: new Date().toISOString(),
      };

      // Script lead.plan for entry 1 (project B)
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: { kind: "proposal", proposal: {} },
      }));

      const commandId = `cmd_obs_${fakeRunId}_1`;
      await onIntegrateFinal(fakeObs, commandId, deps);

      // result_revision set for entry 0
      const { rows: wipRows } = await client.query(
        "SELECT * FROM work_item_projects WHERE work_item_id = $1 ORDER BY position",
        [workItemId],
      );
      assert.equal(
        (wipRows[0] as Record<string, unknown>).result_revision,
        INTEGRATED_REVISION,
        "entry 0 result_revision set",
      );
      assert.equal(
        (wipRows[1] as Record<string, unknown>).result_revision,
        null,
        "entry 1 still pending",
      );

      // Work item NOT completed (entry 1 still pending)
      const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
        workItemId,
      ]);
      assert.equal(
        (wiRows[0] as Record<string, unknown>).lifecycle,
        "active",
        "work item not completed yet",
      );

      // lead.plan dispatched for entry 1
      const { rows: leadIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadPlan],
      );
      assert.equal(leadIntents.length, 1, "lead.plan intent dispatched for entry 1");
      const leadIntent = leadIntents[0] as Record<string, unknown>;
      assert.ok(leadIntent.idempotency_key, "lead.plan intent has idempotency key");
    } finally {
      await pool.end();
    }
  });
});
