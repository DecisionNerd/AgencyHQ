/**
 * Integration tests: boundary enforcement in BoundedRepairFlow.
 *
 * Verifies fixes for S4-fix-boundary (R-001, R-015, R-018):
 *
 * (a) merge work item + artifact proposal → pending_human / BOUNDARY_BELOW_REQUESTED, no contract
 * (b) merge work item + merge proposal → admitted, contract boundary = merge
 * (c) artifact work item + artifact proposal → unchanged behavior (admitted)
 * (d) after artifact completion the work item's boundary column is still what it was created with
 * (e) lead.plan payload for a merge item carries integration requirement in operatorIntent
 *     and the manifest (flow.options-style assertion on the fake runtime call)
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Authority, LeadProposal } from "@agencyhq/contracts";
import { digestOf, HOST_TRIAL_AUTHORITY, TASK_IDS } from "@agencyhq/contracts";
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
// Profile resolver stub
// ---------------------------------------------------------------------------

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: ["package.json"],
});

// ---------------------------------------------------------------------------
// Id generator / clock
// ---------------------------------------------------------------------------

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

// ---------------------------------------------------------------------------
// Authority that allows merge boundary without human approval
// ---------------------------------------------------------------------------

const MERGE_AUTHORITY: Authority = {
  ...HOST_TRIAL_AUTHORITY,
  boundaries: ["artifact", "merge"],
  humanRequired: {
    paths: ["src/parser/public-api.ts"],
    changeClasses: [],
    boundaries: [],
  },
};

// ---------------------------------------------------------------------------
// Host profile (same across all tests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Proposal fixtures
// ---------------------------------------------------------------------------

/** A merge-boundary proposal admitted by MERGE_AUTHORITY. */
const MERGE_PROPOSAL: LeadProposal = {
  criteria: [{ id: "c1", text: "Tests pass", source: "operator", citation: "Test" }],
  profileId: "default",
  changeClass: "behavior",
  review: "adversarial",
  boundary: "merge",
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
  rationale: "Narrow fix to parser edge cases — merge boundary",
  sources: [{ criterionId: "c1", source: "operator", citation: "Test" }],
};

// ---------------------------------------------------------------------------
// Helper: make FlowDeps
// ---------------------------------------------------------------------------

function makeFlowDeps(pool: ReturnType<typeof createPool>, fake: FakeExecutionRuntime): FlowDeps {
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
// (a) merge work item + artifact proposal → pending_human / BOUNDARY_BELOW_REQUESTED
// ---------------------------------------------------------------------------

test("flow.boundary (a): merge work item + artifact proposal → pending_human BOUNDARY_BELOW_REQUESTED, no contract", async (t) => {
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
      // Merge work item
      const { workItemId } = await seedProjectAndWorkItem(client, {
        boundary: "merge",
        authority: MERGE_AUTHORITY,
      });

      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(), // artifact proposal — below merge boundary
      }));

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      const outputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(
        planIntentId,
        goodPlanOutput(), // artifact proposal
        outputCmdId,
      );

      // No StepContract created
      const { rows: contractRows } = await client.query("SELECT * FROM step_contracts");
      assert.equal(contractRows.length, 0, "no contract created for boundary-below proposal");

      // No worker.attempt dispatched
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 0, "worker.attempt NOT dispatched");

      // Decision recorded with pending_human
      const { rows: decisionRows } = await client.query<{
        outcome: string;
        work_item_id: string;
      }>("SELECT outcome, work_item_id FROM decisions WHERE kind = 'plan'");
      assert.equal(decisionRows.length, 1, "one plan decision recorded");
      assert.equal(decisionRows[0]!.outcome, "pending_human", "outcome = pending_human");
      assert.equal(decisionRows[0]!.work_item_id, workItemId, "decision references work item");

      // Command result contains BOUNDARY_BELOW_REQUESTED violation
      const { rows: cmdRows } = await client.query<{ result: unknown }>(
        "SELECT result FROM commands WHERE command_id = $1",
        [outputCmdId],
      );
      assert.equal(cmdRows.length, 1, "command result stored");
      const cmdResult = cmdRows[0]!.result as {
        violations?: Array<{ code: string; path: string }>;
      };
      assert.ok(Array.isArray(cmdResult.violations), "violations array in result");
      const codes = (cmdResult.violations ?? []).map((v) => v.code);
      assert.ok(
        codes.includes("BOUNDARY_BELOW_REQUESTED"),
        `BOUNDARY_BELOW_REQUESTED in violations, got ${JSON.stringify(codes)}`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) merge work item + merge proposal → admitted, contract boundary = merge
// ---------------------------------------------------------------------------

test("flow.boundary (b): merge work item + merge proposal → admitted, contract boundary = merge", async (t) => {
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
        authority: MERGE_AUTHORITY,
      });

      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: { kind: "proposal", proposal: MERGE_PROPOSAL },
      }));
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

      await flow.onLeadPlanOutput(
        planIntentId,
        { kind: "proposal", proposal: MERGE_PROPOSAL },
        newId("cmd"),
      );

      // StepContract created with boundary = merge
      const { rows: contractRows } = await client.query<{
        id: string;
        bounds: { boundary: string };
      }>("SELECT id, bounds FROM step_contracts");
      assert.equal(contractRows.length, 1, "one step_contract created");
      const contractBounds = contractRows[0]!.bounds as { boundary: string };
      assert.equal(contractBounds.boundary, "merge", "contract boundary = merge");

      // Decision accepted (not pending_human)
      const { rows: decisionRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'plan'",
      );
      assert.equal(decisionRows.length, 1, "one plan decision recorded");
      assert.equal(decisionRows[0]!.outcome, "accepted", "decision outcome = accepted");

      // Worker dispatched
      const workerTriggers = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      );
      assert.equal(workerTriggers.length, 1, "worker.attempt dispatched");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) artifact work item + artifact proposal → unchanged behavior (admitted)
// ---------------------------------------------------------------------------

test("flow.boundary (c): artifact work item + artifact proposal → admitted unchanged", async (t) => {
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
      // Default artifact boundary
      const { workItemId } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId),
        };
      });

      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      // Contract created with boundary = artifact
      const { rows: contractRows } = await client.query<{
        bounds: { boundary: string };
      }>("SELECT bounds FROM step_contracts");
      assert.equal(contractRows.length, 1, "step_contract created");
      const bounds = contractRows[0]!.bounds as { boundary: string };
      assert.equal(bounds.boundary, "artifact", "contract boundary = artifact");

      // Decision accepted
      const { rows: decisionRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'plan'",
      );
      assert.equal(decisionRows.length, 1, "plan decision recorded");
      assert.equal(decisionRows[0]!.outcome, "accepted", "decision accepted for artifact proposal");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) artifact completion preserves work item boundary column
// ---------------------------------------------------------------------------

test("flow.boundary (d): artifact completion does not rewrite work_items.boundary column", async (t) => {
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
      // Artifact work item (default)
      const { workItemId } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));
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

      // Plan
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(
        workItemId,
        newId("cmd"),
      );
      fake.advance(planRunId);
      fake.advance(planRunId);

      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, {
            commitId: "deadbeef1234567890deadbeef1234567890dead",
          }),
        };
      });

      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      // Worker
      const { rows: workerIntents } = await client.query<{ run_id: string }>(
        "SELECT run_id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = workerIntents[0]!.run_id;
      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      // Script verify
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

      await flow.onWorkerFinal(workerObs, newId("cmd"));

      // Artifact row
      const { rows: artifactRows } = await client.query<{
        revision: string;
        diff_digest: string;
      }>("SELECT revision, diff_digest FROM artifacts");
      assert.equal(artifactRows.length, 1, "artifact created");
      const artifactRow = artifactRows[0]!;

      // Script review
      fake.script(TASK_IDS.leadReview, () => ({
        status: "COMPLETED",
        output: goodReviewOutput({
          attemptRevision: artifactRow.revision,
          diffDigest: artifactRow.diff_digest,
          criteriaDigest: String(digestOf({ placeholder: "criteria" })),
          profileDigest: FAKE_PROFILE_DIGEST,
        }),
      }));

      // Verify
      const { rows: verifyIntents } = await client.query<{ run_id: string }>(
        "SELECT run_id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.verifyRun],
      );
      const verifyRunId = verifyIntents[0]!.run_id;
      fake.advance(verifyRunId);
      fake.advance(verifyRunId);
      const verifyObs = await fake.retrieve(verifyRunId);
      await flow.onVerifyFinal(verifyObs, newId("cmd"));

      // Script accept
      const vrRef = `agencyhq-verifier:pnpm-test:${artifactRow.revision}`;
      fake.script(TASK_IDS.leadAccept, () => ({
        status: "COMPLETED",
        output: goodAcceptanceProposal(["c1"], [vrRef]),
      }));

      // Review
      const { rows: reviewIntents } = await client.query<{ run_id: string }>(
        "SELECT run_id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadReview],
      );
      const reviewRunId = reviewIntents[0]!.run_id;
      fake.advance(reviewRunId);
      fake.advance(reviewRunId);
      const reviewObs = await fake.retrieve(reviewRunId);
      await flow.onReviewFinal(reviewObs, newId("cmd"));

      // Accept
      const { rows: acceptIntents } = await client.query<{ run_id: string }>(
        "SELECT run_id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadAccept],
      );
      const acceptRunId = acceptIntents[0]!.run_id;
      fake.advance(acceptRunId);
      fake.advance(acceptRunId);
      const acceptObs = await fake.retrieve(acceptRunId);
      await flow.onAcceptFinal(acceptObs, newId("cmd"));

      // Work item must be completed and boundary must still be "artifact"
      const { rows: wiRows } = await client.query<{
        lifecycle: string;
        boundary: string;
      }>("SELECT lifecycle, boundary FROM work_items WHERE id = $1", [workItemId]);
      assert.equal(wiRows.length, 1, "work item exists");
      assert.equal(wiRows[0]!.lifecycle, "completed", "work item completed");
      assert.equal(
        wiRows[0]!.boundary,
        "artifact",
        "boundary column unchanged after artifact completion (Fix 3)",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (e) lead.plan payload for merge item carries integration requirement + manifest
// ---------------------------------------------------------------------------

test("flow.boundary (e): lead.plan payload for merge item carries integration requirement in operatorIntent and manifest", async (t) => {
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
      // Two projects for the manifest
      const proj1 = newId("prj");
      const proj2 = newId("prj");
      const sha1 = "aaaa000000000000000000000000000000000001";
      const sha2 = "bbbb000000000000000000000000000000000002";

      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
           VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj1, JSON.stringify(MERGE_AUTHORITY), JSON.stringify({ main: sha1 }), "/repo/proj1"],
      );
      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
           VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj2, JSON.stringify(MERGE_AUTHORITY), JSON.stringify({ main: sha2 }), "/repo/proj2"],
      );

      // Manifest merge work item
      const workItemId = newId("wi");
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
           VALUES ($1, $2, 1, 'Fix both repos', 'merge', 'proposed', 'healthy', true, 1)`,
        [workItemId, proj1],
      );

      // work_item_projects rows (manifest)
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
           VALUES ($1, $2, 0, 'main', $3), ($1, $4, 1, 'main', $5)`,
        [workItemId, proj1, sha1, proj2, sha2],
      );

      const fake = new FakeExecutionRuntime();

      // Script lead.plan — capture the payload
      let capturedLeadPlanPayload: unknown;
      fake.script(TASK_IDS.leadPlan, (payload) => {
        capturedLeadPlanPayload = payload;
        return {
          status: "COMPLETED",
          output: { kind: "proposal", proposal: MERGE_PROPOSAL },
        };
      });

      const schemaPool = createPool(poolUrl.toString());
      const deps = makeFlowDeps(schemaPool, fake);
      const flow = new BoundedRepairFlow(deps);

      const planCmdId = newId("cmd");
      await flow.plan(workItemId, planCmdId);

      // Assert the trigger call payload
      assert.ok(capturedLeadPlanPayload !== undefined, "lead.plan payload was captured");

      const pp = capturedLeadPlanPayload as {
        operatorIntent: string;
        manifest?: {
          entries: Array<{
            position: number;
            projectId: string;
            targetRef: string;
          }>;
          digest: string;
        };
      };

      // Fix 1: operatorIntent carries integration requirement for merge item
      assert.ok(
        pp.operatorIntent.toLowerCase().includes("merge"),
        `operatorIntent must mention 'merge' requirement, got: ${pp.operatorIntent}`,
      );

      // Manifest is included in payload (two entries)
      assert.ok(pp.manifest, "manifest field present in lead.plan payload");
      assert.equal(pp.manifest.entries.length, 2, "manifest has two entries");

      const e0 = pp.manifest.entries.find((e) => e.position === 0);
      const e1 = pp.manifest.entries.find((e) => e.position === 1);
      assert.ok(e0, "entry at position 0 exists");
      assert.ok(e1, "entry at position 1 exists");
      assert.equal(e0!.projectId, proj1, "entry 0 references proj1");
      assert.equal(e1!.projectId, proj2, "entry 1 references proj2");
      assert.equal(e0!.targetRef, "main", "entry 0 targetRef = main");
      assert.equal(e1!.targetRef, "main", "entry 1 targetRef = main");

      await schemaPool.end();
    } finally {
      await pool.end();
    }
  });
});
