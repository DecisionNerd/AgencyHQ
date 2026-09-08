/**
 * Integration tests for multi-entry manifest: per-entry contract versions,
 * boundary requirement text, allowed_refs advance, and error recovery.
 *
 * PACKET S4-fix-manifest-next — R-015, R-018:
 *
 * (a) Two-entry manifest end-to-end: entry 0 integrated → manifest row 0
 *     resolved, projects.allowed_refs advanced for project 0, entry 1
 *     lead.plan dispatched with correct repo/base/text; entry 1 contract
 *     version = 2; entry 1 integrated → work item completed.
 * (b) Entry 1 artifact proposal → BOUNDARY_BELOW_REQUESTED pending_human
 *     (not a crash).
 * (c) DB error in contract insert (pre-inserted conflicting version) →
 *     failure row + pending_human plan decision, no unhandled throw.
 * (d) projects.allowed_refs not advanced when stored value differs from
 *     the integration's expected base (guard).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type Authority, digestOf, HOST_TRIAL_AUTHORITY, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import { onIntegrateFinal } from "../../src/flow/integrate.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { workerCompletedOutput } from "../helpers/fake-lead.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BASE_A = "aaaa000000000000000000000000000000000000";
const BASE_B = "bbbb000000000000000000000000000000000000";
const INTEGRATED_A = "1111111111111111111111111111111111111111";
const INTEGRATED_B = "2222222222222222222222222222222222222222";
const ATTEMPT_SHA = "cccc000000000000000000000000000000000000";

const MERGE_AUTHORITY: Authority = {
  ...HOST_TRIAL_AUTHORITY,
  boundaries: ["artifact", "merge"],
  // Widen paths so the merge proposal (allow: ["src/**"]) passes checkProposal.
  paths: { allow: ["src/**"], deny: [".github/**", "package.json"] },
  budget: { maxAttempts: 3, maxDurationSeconds: 1200, estimatedSpendUsd: 10 },
  humanRequired: { paths: [], changeClasses: [], boundaries: [] as const },
};

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: [] as string[],
});

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

const clock = { now: () => new Date().toISOString() };
const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };

function makeSchemaPool(databaseUrl: string, schema: string): ReturnType<typeof createPool> {
  const poolUrl = new URL(databaseUrl);
  poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
  return createPool(poolUrl.toString());
}

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

/** A valid merge-boundary proposal for the MERGE_AUTHORITY. */
function mergePlanOutput() {
  return {
    kind: "proposal" as const,
    proposal: {
      criteria: [{ id: "c1", text: "Tests pass", source: "operator" as const, citation: "" }],
      profileId: "default",
      changeClass: "behavior" as const,
      review: "adversarial" as const,
      boundary: "merge" as const,
      paths: { allow: ["src/**"], deny: [".github/**", "package.json"] },
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
      rationale: "Multi-repo merge fix",
      sources: [{ criterionId: "c1", source: "operator" as const, citation: "" }],
    },
  };
}

/** An artifact proposal — used to trigger BOUNDARY_BELOW_REQUESTED. */
function artifactPlanOutput() {
  return {
    kind: "proposal" as const,
    proposal: {
      ...mergePlanOutput().proposal,
      boundary: "artifact" as const,
    },
  };
}

/**
 * Manually insert the minimum rows needed for a completed integration of
 * entry 0 (proj A), so we can focus onIntegrateFinal behaviour.
 *
 * Returns a pre-built fake observation that represents a COMPLETED
 * integrate.merge run with outcome "integrated".
 */
async function seedEntry0Integration(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  opts: {
    workItemId: string;
    projectAId: string;
    projectBId: string;
    contractId: string;
    contractVersion: number;
  },
): Promise<{ fakeRunId: string; fakeObs: import("@agencyhq/domain").RunObservation }> {
  const { workItemId, projectAId, contractId, contractVersion } = opts;
  const attemptId = newId("att");
  const integId = `intg_${newId("di")}`;
  const mergeIntentId = newId("di");
  const fakeRunId = `run_${String(Math.random()).slice(2)}`;

  await client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status, target_ref)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'cd1', 'default', 'pd1',
             $8::jsonb, '["merge"]'::jsonb, false, 'active', 'refs/heads/main')`,
    [
      contractId,
      workItemId,
      projectAId,
      contractVersion,
      BASE_A,
      JSON.stringify({ intent: "Multi-repo fix" }),
      JSON.stringify([{ id: "c1", text: "Works", source: "operator", citation: "" }]),
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
     VALUES ($1, $2, $3, 1, 'accepted', 2, $4)`,
    [attemptId, contractId, contractVersion, ATTEMPT_SHA],
  );

  await client.query(
    `INSERT INTO integrations (id, attempt_id, contract_id, contract_version, target_ref, expected_base_revision)
     VALUES ($1, $2, $3, $4, 'refs/heads/main', $5)`,
    [integId, attemptId, contractId, contractVersion, BASE_A],
  );

  await client.query(
    `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
     VALUES ($1, $2, 'pd1', $3, 'triggered', $4, $5)`,
    [mergeIntentId, TASK_IDS.integrateMerge, attemptId, fakeRunId, `${mergeIntentId}:g1`],
  );

  const fakeObs: import("@agencyhq/domain").RunObservation = {
    runId: fakeRunId,
    status: "COMPLETED",
    output: {
      outcome: "integrated",
      resultingRevision: INTEGRATED_A,
      observedTargetRevision: BASE_A,
      evidence: [],
    },
    observedAt: new Date().toISOString(),
  };

  return { fakeRunId, fakeObs };
}

// ===========================================================================
// Test (a): two-entry manifest end-to-end
// ===========================================================================

test("manifest-next (a): two-entry manifest end-to-end — version advance, allowed_refs, and text", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();
    try {
      // ----------------------------------------------------------------
      // Seed two projects with allowed_refs and clone_path
      // ----------------------------------------------------------------
      const projectAId = newId("prj");
      const projectBId = newId("prj");
      const workItemId = newId("wi");

      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: BASE_A }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-b', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectBId, JSON.stringify({ main: BASE_B }), JSON.stringify(MERGE_AUTHORITY)],
      );

      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Multi-repo fix', 'merge', 'active', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'refs/heads/main', $3), ($1, $4, 1, 'refs/heads/main', $5)`,
        [workItemId, projectAId, BASE_A, projectBId, BASE_B],
      );

      const deps = makeDeps(pool, fake);

      // ----------------------------------------------------------------
      // Integrate entry 0 (project A)
      // ----------------------------------------------------------------
      const contractAId = newId("sc");
      const { fakeRunId: runA, fakeObs: obsA } = await seedEntry0Integration(client, {
        workItemId,
        projectAId,
        projectBId,
        contractId: contractAId,
        contractVersion: 1,
      });

      // Script lead.plan for entry 1 to capture payload
      let capturedLeadPlanPayload: unknown;
      fake.script(TASK_IDS.leadPlan, (payload) => {
        capturedLeadPlanPayload = payload;
        return { status: "COMPLETED", output: { kind: "proposal", proposal: {} } };
      });

      await onIntegrateFinal(obsA, `cmd_obs_${runA}_1`, deps);

      // ----------------------------------------------------------------
      // Check: manifest row 0 resolved, allowed_refs advanced for proj A
      // ----------------------------------------------------------------
      const { rows: wipRows } = await client.query<{
        position: number;
        result_revision: string | null;
      }>(
        "SELECT position, result_revision FROM work_item_projects WHERE work_item_id = $1 ORDER BY position",
        [workItemId],
      );
      assert.equal(wipRows.length, 2, "two manifest rows");
      assert.equal(
        wipRows[0]?.result_revision,
        INTEGRATED_A,
        "entry 0 result_revision = INTEGRATED_A",
      );
      assert.equal(wipRows[1]?.result_revision, null, "entry 1 still pending");

      // Check allowed_refs advanced for project A
      const { rows: projARows } = await client.query<{ allowed_refs: Record<string, string> }>(
        "SELECT allowed_refs FROM projects WHERE id = $1",
        [projectAId],
      );
      const allowedRefsA = projARows[0]?.allowed_refs ?? {};
      assert.equal(
        (allowedRefsA as Record<string, string>)["main"],
        INTEGRATED_A,
        "project A allowed_refs[main] advanced to INTEGRATED_A",
      );

      // Project B allowed_refs should be unchanged
      const { rows: projBRows } = await client.query<{ allowed_refs: Record<string, string> }>(
        "SELECT allowed_refs FROM projects WHERE id = $1",
        [projectBId],
      );
      const allowedRefsB = projBRows[0]?.allowed_refs ?? {};
      assert.equal(
        (allowedRefsB as Record<string, string>)["main"],
        BASE_B,
        "project B allowed_refs unchanged",
      );

      // ----------------------------------------------------------------
      // Check: entry 1 lead.plan dispatched with correct payload
      // ----------------------------------------------------------------
      assert.ok(capturedLeadPlanPayload !== undefined, "entry 1 lead.plan payload captured");
      const pp = capturedLeadPlanPayload as {
        projectId: string;
        repoPath: string;
        baseRevision: string;
        operatorIntent: string;
        manifest?: { entries: Array<{ position: number; projectId: string }> };
      };

      assert.equal(pp.projectId, projectBId, "lead.plan projectId = projectBId");
      assert.equal(pp.repoPath, "/repo-b", "lead.plan repoPath = /repo-b");
      assert.equal(pp.baseRevision, BASE_B, "lead.plan baseRevision = BASE_B (stored base for B)");

      // Payload text must name the entry and include the boundary requirement
      assert.ok(
        pp.operatorIntent.includes("Manifest entry 1 of 2"),
        `operatorIntent contains entry description: ${pp.operatorIntent}`,
      );
      assert.ok(
        pp.operatorIntent.includes("Integration requirement"),
        `operatorIntent contains boundary requirement: ${pp.operatorIntent}`,
      );
      assert.ok(
        pp.operatorIntent.includes("propose boundary merge"),
        `operatorIntent contains 'propose boundary merge': ${pp.operatorIntent}`,
      );
      assert.ok(
        pp.operatorIntent.includes(projectBId),
        `operatorIntent names the entry's project: ${pp.operatorIntent}`,
      );

      // Check manifest in payload
      assert.ok(pp.manifest, "lead.plan payload has manifest");
      assert.equal(pp.manifest?.entries.length, 2, "manifest has two entries");

      // ----------------------------------------------------------------
      // onLeadPlanOutput for entry 1 → contract version must be 2
      // ----------------------------------------------------------------
      const { rows: leadIntents } = await client.query<{ id: string; idempotency_key: string }>(
        "SELECT id, idempotency_key FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadPlan],
      );
      assert.equal(leadIntents.length, 1, "one lead.plan intent dispatched");
      const leadIntentId = leadIntents[0]!.id;

      // Script worker attempt
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, { commitId: ATTEMPT_SHA }),
        };
      });

      const flow = new BoundedRepairFlow(deps);
      await flow.onLeadPlanOutput(leadIntentId, mergePlanOutput(), newId("cmd"));

      // Entry 1 contract must have version = 2 (unique per work item)
      const { rows: contractRows } = await client.query<{ version: number; project_id: string }>(
        "SELECT version, project_id FROM step_contracts ORDER BY version",
      );
      assert.equal(contractRows.length, 2, "two step_contracts (entry 0 and entry 1)");
      const contractB = contractRows.find((r) => r.project_id === projectBId);
      assert.ok(contractB, "contract for project B exists");
      assert.equal(contractB?.version, 2, "entry 1 contract version = 2");

      // ----------------------------------------------------------------
      // Integrate entry 1 (project B) → work item completed
      // ----------------------------------------------------------------
      const contractBId = contractRows.find((r) => r.project_id === projectBId)
        ? contractRows.find((r) => r.project_id === projectBId)
        : null;

      // Find the attempt for entry 1
      const { rows: attemptRows } = await client.query<{ id: string; contract_id: string }>(
        "SELECT id, contract_id FROM attempts ORDER BY created_at",
      );
      const attemptB = attemptRows.find((a) => a.contract_id !== contractAId);
      assert.ok(attemptB, "attempt for entry 1 found");

      // Manually insert integration row for entry 1
      const integBId = `intg_${newId("di")}`;
      const mergeIntentBId = newId("di");
      const fakeRunB = `run_b_${String(Math.random()).slice(2)}`;

      // Update attempt to accepted with commit_sha
      await client.query("UPDATE attempts SET status = 'accepted', commit_sha = $2 WHERE id = $1", [
        attemptB.id,
        ATTEMPT_SHA,
      ]);

      await client.query(
        `INSERT INTO integrations (id, attempt_id, contract_id, contract_version, target_ref, expected_base_revision)
         VALUES ($1, $2, $3, 2, 'refs/heads/main', $4)`,
        [integBId, attemptB.id, attemptB.contract_id, BASE_B],
      );

      await client.query(
        `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, 'pd2', $3, 'triggered', $4, $5)`,
        [mergeIntentBId, TASK_IDS.integrateMerge, attemptB.id, fakeRunB, `${mergeIntentBId}:g1`],
      );

      const obsB: import("@agencyhq/domain").RunObservation = {
        runId: fakeRunB,
        status: "COMPLETED",
        output: {
          outcome: "integrated",
          resultingRevision: INTEGRATED_B,
          observedTargetRevision: BASE_B,
          evidence: [],
        },
        observedAt: new Date().toISOString(),
      };

      await onIntegrateFinal(obsB, `cmd_obs_${fakeRunB}_1`, deps);

      // Work item should be completed with both result revisions
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows[0]?.lifecycle, "completed", "work item completed");

      const { rows: wipRowsFinal } = await client.query<{
        position: number;
        result_revision: string | null;
      }>(
        "SELECT position, result_revision FROM work_item_projects WHERE work_item_id = $1 ORDER BY position",
        [workItemId],
      );
      assert.equal(wipRowsFinal[0]?.result_revision, INTEGRATED_A, "entry 0 result = INTEGRATED_A");
      assert.equal(wipRowsFinal[1]?.result_revision, INTEGRATED_B, "entry 1 result = INTEGRATED_B");
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// Test (b): artifact proposal for entry 1 → BOUNDARY_BELOW_REQUESTED
// ===========================================================================

test("manifest-next (b): entry 1 artifact proposal → BOUNDARY_BELOW_REQUESTED pending_human", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const projectAId = newId("prj");
      const projectBId = newId("prj");
      const workItemId = newId("wi");

      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: BASE_A }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-b', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectBId, JSON.stringify({ main: BASE_B }), JSON.stringify(MERGE_AUTHORITY)],
      );

      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Multi-repo fix', 'merge', 'active', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'refs/heads/main', $3), ($1, $4, 1, 'refs/heads/main', $5)`,
        [workItemId, projectAId, BASE_A, projectBId, BASE_B],
      );

      const deps = makeDeps(pool, fake);

      // Integrate entry 0 so entry 1 becomes the next unresolved entry
      const contractAId = newId("sc");
      const { fakeRunId: runA, fakeObs: obsA } = await seedEntry0Integration(client, {
        workItemId,
        projectAId,
        projectBId,
        contractId: contractAId,
        contractVersion: 1,
      });

      // Script lead.plan for entry 1 dispatch (result ignored for this test)
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: { kind: "proposal", proposal: {} },
      }));

      await onIntegrateFinal(obsA, `cmd_obs_${runA}_1`, deps);

      // Get the entry 1 lead.plan intent id
      const { rows: leadIntents } = await client.query<{ id: string }>(
        "SELECT id FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.leadPlan],
      );
      const leadIntentId = leadIntents[0]!.id;

      // Call onLeadPlanOutput with an artifact proposal for a manifest work item
      // → must produce BOUNDARY_BELOW_REQUESTED pending_human, NOT crash
      const flow = new BoundedRepairFlow(deps);
      await flow.onLeadPlanOutput(leadIntentId, artifactPlanOutput(), newId("cmd"));

      // Expect: pending_human decision, no step_contract created for entry 1
      const { rows: decRows } = await client.query<{ outcome: string; work_item_id: string }>(
        "SELECT outcome, work_item_id FROM decisions WHERE kind = 'plan' AND work_item_id = $1 ORDER BY at DESC LIMIT 1",
        [workItemId],
      );
      assert.equal(decRows.length, 1, "one plan decision recorded");
      assert.equal(decRows[0]?.outcome, "pending_human", "outcome = pending_human");

      // No step_contract for project B (artifact boundary rejected)
      const { rows: contractsB } = await client.query<{ id: string }>(
        "SELECT id FROM step_contracts WHERE work_item_id = $1 AND project_id = $2",
        [workItemId, projectBId],
      );
      assert.equal(contractsB.length, 0, "no step_contract created for project B");

      // Work item must still be active (not crashed / stranded)
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.equal(wiRows[0]?.lifecycle, "active", "work item still active");
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// Test (c): handler error in onLeadPlanOutput → failure row + pending_human
// ===========================================================================

test("manifest-next (c): handler error → failure row + pending_human, no throw", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();
    try {
      // Seed a single-project work item (no manifest entries needed —
      // a single-repo work item is simpler for triggering the error path).
      const projectAId = newId("prj");
      const workItemId = newId("wi");

      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: BASE_A }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Fix repo', 'merge', 'proposed', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );

      const deps = makeDeps(pool, fake);

      // Build a lead.plan intent for the work item.
      const leadIntentId = newId("di");
      const idempotencyKey = `leadplan:${workItemId}:${leadIntentId}`;
      await client.query(
        `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, 'pd-test', NULL, 'triggered', NULL, $3)`,
        [leadIntentId, TASK_IDS.leadPlan, idempotencyKey],
      );

      // Make the next runtime.trigger() call (for the workerAttempt after COMMIT)
      // throw a FakeNetworkError, simulating a transient error that leaves the
      // handler mid-way.  The Decision + StepContract + Attempt will be committed,
      // but runtime.trigger will throw — triggering the Defect 4 recovery path.
      fake.dropNextResponse();

      const flow = new BoundedRepairFlow(deps);
      const cmdId = newId("cmd");

      // Must NOT throw even though runtime.trigger fails after COMMIT.
      await assert.doesNotReject(
        flow.onLeadPlanOutput(leadIntentId, mergePlanOutput(), cmdId),
        "onLeadPlanOutput must not throw on runtime.trigger error",
      );

      // A failure row must be recorded.
      const { rows: failRows } = await client.query<{ class: string; phase: string }>(
        "SELECT class, phase FROM failures WHERE phase = 'plan'",
      );
      assert.equal(failRows.length, 1, "one failure row recorded");
      assert.equal(failRows[0]?.class, "execution", "failure class = execution");

      // A pending_human decision must be recorded.
      const { rows: decRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'plan' AND work_item_id = $1",
        [workItemId],
      );
      // There may also be an 'accepted' decision from the COMMIT — look for pending_human.
      const pendingDec = decRows.filter((d) => d.outcome === "pending_human");
      assert.equal(pendingDec.length, 1, "one pending_human plan decision recorded");

      // Work item must not be completed or halted.
      const { rows: wiRows } = await client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM work_items WHERE id = $1",
        [workItemId],
      );
      assert.notEqual(wiRows[0]?.lifecycle, "completed", "work item not completed");
      assert.notEqual(wiRows[0]?.lifecycle, "halted", "work item not halted");
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// Test (d): allowed_refs NOT advanced when stored value differs from expected
// ===========================================================================

test("manifest-next (d): allowed_refs guard — not advanced when stored != expected_base", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const projectAId = newId("prj");
      const projectBId = newId("prj");
      const workItemId = newId("wi");

      // Project A's allowed_refs already advanced beyond BASE_A (simulating
      // a concurrent integration that already moved the tip)
      const ALREADY_ADVANCED = "dddd000000000000000000000000000000000000";

      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: ALREADY_ADVANCED }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-b', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectBId, JSON.stringify({ main: BASE_B }), JSON.stringify(MERGE_AUTHORITY)],
      );

      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Multi-repo fix', 'merge', 'active', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'refs/heads/main', $3), ($1, $4, 1, 'refs/heads/main', $5)`,
        [workItemId, projectAId, BASE_A, projectBId, BASE_B],
      );

      const deps = makeDeps(pool, fake);

      // Set up entry 0 integration (expected_base = BASE_A, but stored = ALREADY_ADVANCED)
      const contractAId = newId("sc");
      const { fakeRunId: runA, fakeObs: obsA } = await seedEntry0Integration(client, {
        workItemId,
        projectAId,
        projectBId,
        contractId: contractAId,
        contractVersion: 1,
      });

      // Script lead.plan dispatch (result ignored)
      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: { kind: "proposal", proposal: {} },
      }));

      await onIntegrateFinal(obsA, `cmd_obs_${runA}_1`, deps);

      // The guard must prevent advancing allowed_refs when stored != expected_base
      const { rows: projARows } = await client.query<{ allowed_refs: Record<string, string> }>(
        "SELECT allowed_refs FROM projects WHERE id = $1",
        [projectAId],
      );
      const allowedRefsA = projARows[0]?.allowed_refs ?? {};
      // Should still be ALREADY_ADVANCED, NOT INTEGRATED_A
      assert.equal(
        (allowedRefsA as Record<string, string>)["main"],
        ALREADY_ADVANCED,
        "allowed_refs not advanced when stored value != expected_base",
      );
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// Test (e): S-6 — next-entry base refresh uses updated allowed_refs, not creation-time value
// ===========================================================================

test("manifest-next (e): S-6 — next-entry lead.plan baseRevision uses refreshed allowed_refs, not creation-time value", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const projectAId = newId("prj");
      const projectBId = newId("prj");
      const workItemId = newId("wi");

      // Entry 1's project B starts with BASE_B at creation time.
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: BASE_A }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-b', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectBId, JSON.stringify({ main: BASE_B }), JSON.stringify(MERGE_AUTHORITY)],
      );

      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Multi-repo fix', 'merge', 'active', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'refs/heads/main', $3), ($1, $4, 1, 'refs/heads/main', $5)`,
        [workItemId, projectAId, BASE_A, projectBId, BASE_B],
      );

      // S-6: Simulate that project B's allowed_refs advanced (externally) between
      // the time the work item was created and entry 0's integration.
      const ADVANCED_B = "bbbb999900000000000000000000000000000000";
      await client.query(`UPDATE projects SET allowed_refs = $1::jsonb WHERE id = $2`, [
        JSON.stringify({ main: ADVANCED_B }),
        projectBId,
      ]);

      const deps = makeDeps(pool, fake);

      // Integrate entry 0 (project A)
      const contractAId = newId("sc");
      const { fakeRunId: runA, fakeObs: obsA } = await seedEntry0Integration(client, {
        workItemId,
        projectAId,
        projectBId,
        contractId: contractAId,
        contractVersion: 1,
      });

      // Capture the lead.plan payload for entry 1
      let capturedLeadPlanPayload: unknown;
      fake.script(TASK_IDS.leadPlan, (payload) => {
        capturedLeadPlanPayload = payload;
        return { status: "COMPLETED", output: { kind: "proposal", proposal: {} } };
      });

      await onIntegrateFinal(obsA, `cmd_obs_${runA}_1`, deps);

      // Assert: lead.plan payload for entry 1 must use ADVANCED_B, not BASE_B
      assert.ok(capturedLeadPlanPayload !== undefined, "entry 1 lead.plan payload captured");
      const pp = capturedLeadPlanPayload as { baseRevision: string; projectId: string };
      assert.equal(pp.projectId, projectBId, "lead.plan projectId = projectBId");
      assert.equal(
        pp.baseRevision,
        ADVANCED_B,
        "lead.plan baseRevision must be the refreshed value (ADVANCED_B), not the creation-time BASE_B",
      );
      assert.notEqual(
        pp.baseRevision,
        BASE_B,
        "lead.plan baseRevision must NOT be the creation-time BASE_B",
      );
    } finally {
      await pool.end();
    }
  });
});

// ===========================================================================
// Test (f): S-12 — next-entry lead.plan trigger carries both project: and workItem: tags
// ===========================================================================

test("manifest-next (f): S-12 — next-entry lead.plan trigger includes project: and workItem: tags", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const projectAId = newId("prj");
      const projectBId = newId("prj");
      const workItemId = newId("wi");

      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-a', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectAId, JSON.stringify({ main: BASE_A }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo-b', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
        [projectBId, JSON.stringify({ main: BASE_B }), JSON.stringify(MERGE_AUTHORITY)],
      );
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Multi-repo fix', 'merge', 'active', 'healthy', true, 1)`,
        [workItemId, projectAId],
      );
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'refs/heads/main', $3), ($1, $4, 1, 'refs/heads/main', $5)`,
        [workItemId, projectAId, BASE_A, projectBId, BASE_B],
      );

      const deps = makeDeps(pool, fake);

      const contractAId = newId("sc");
      const { fakeRunId: runA, fakeObs: obsA } = await seedEntry0Integration(client, {
        workItemId,
        projectAId,
        projectBId,
        contractId: contractAId,
        contractVersion: 1,
      });

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: { kind: "proposal", proposal: {} },
      }));

      await onIntegrateFinal(obsA, `cmd_obs_${runA}_1`, deps);

      // Find the trigger call for the lead.plan task
      const leadPlanCalls = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task?: string })?.task === TASK_IDS.leadPlan,
      );
      assert.equal(leadPlanCalls.length, 1, "lead.plan triggered once for entry 1");

      const triggerArgs = leadPlanCalls[0]!.args[0] as {
        options?: { tags?: string[] };
      };
      const tags = triggerArgs.options?.tags ?? [];
      assert.ok(Array.isArray(tags), "trigger options has tags array");
      assert.ok(
        tags.some((tag) => tag === `project:${projectBId}`),
        `tags must include project:${projectBId}, got: ${JSON.stringify(tags)}`,
      );
      assert.ok(
        tags.some((tag) => tag === `workItem:${workItemId}`),
        `tags must include workItem:${workItemId}, got: ${JSON.stringify(tags)}`,
      );
    } finally {
      await pool.end();
    }
  });
});
