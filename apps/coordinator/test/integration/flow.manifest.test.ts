/**
 * Integration tests for multi-repository manifest support (PACKET 4.2.b).
 *
 * C2: Two-entry manifest create_work_item, plan payload, verify.run payload.
 *
 * Test cases:
 * 1. create_work_item with manifest inserts work_item_projects rows in position order
 *    with base revisions from allowed_refs; invalid targetRef is rejected.
 * 2. plan() sends lead.plan with manifest in payload; step_contract freezes
 *    manifest_digest and target_ref.
 * 3. onWorkerFinal() produces verify.run payload carrying manifest,
 *    manifestProjectId, and manifestRepoPaths.
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { digestOf, HOST_TRIAL_AUTHORITY, manifestDigest, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import { createWorkItem } from "../../src/commands/create-work-item.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { goodPlanOutput, workerCompletedOutput } from "../helpers/fake-lead.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));

/** Authority allowing both artifact and merge boundaries, used for multi-repo manifest tests. */
const MERGE_AUTHORITY = {
  ...HOST_TRIAL_AUTHORITY,
  boundaries: ["artifact", "merge"] as const,
  paths: { allow: ["src/**"], deny: [".github/**"] },
  budget: { maxAttempts: 3, maxDurationSeconds: 1200, estimatedSpendUsd: 10 },
  humanRequired: { paths: [], changeClasses: [], boundaries: [] as const },
};

/** A plan output proposing merge boundary, for tests that need target_ref set on step_contracts. */
function mergePlanOutput() {
  return {
    kind: "proposal" as const,
    proposal: {
      criteria: [{ id: "c1", text: "Tests pass", source: "operator" as const, citation: "" }],
      profileId: "default",
      changeClass: "behavior" as const,
      review: "adversarial" as const,
      boundary: "merge" as const,
      paths: { allow: ["src/**"], deny: [".github/**"] },
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

function makeSchemaPool(databaseUrl: string, schema: string): ReturnType<typeof createPool> {
  const poolUrl = new URL(databaseUrl);
  poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
  return createPool(poolUrl.toString());
}

// ---------------------------------------------------------------------------
// Test 1: create_work_item with manifest inserts rows in position order
// ---------------------------------------------------------------------------

test("manifest: create_work_item inserts work_item_projects in position order", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    try {
      // Seed two projects with allowed_refs
      const proj1 = `prj-${randomUUID()}`;
      const proj2 = `prj-${randomUUID()}`;
      const sha1 = "aaaa000000000000000000000000000000000000";
      const sha2 = "bbbb000000000000000000000000000000000000";

      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs)
         VALUES ($1, '{}', '1', $2::jsonb)`,
        [proj1, JSON.stringify({ main: sha1, "refs/heads/feature": sha1 })],
      );
      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs)
         VALUES ($1, '{}', '1', $2::jsonb)`,
        [proj2, JSON.stringify({ main: sha2 })],
      );

      const deps = {
        pool: schemaPool,
        runtime: new FakeExecutionRuntime(),
        clock,
      };

      // createWorkItem with two-entry manifest
      const result = await createWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        projectId: proj1,
        intent: "Multi-repo manifest test",
        boundary: "merge",
        rank: 1,
        manifest: {
          entries: [
            { projectId: proj1, targetRef: "main" },
            { projectId: proj2, targetRef: "main" },
          ],
        },
      });

      assert.ok(result.ok, `createWorkItem failed: ${result.ok ? "" : result.reason}`);

      if (!result.ok) return;
      const { workItemId } = result;

      // Check work_item_projects rows
      const { rows } = await client.query<{
        work_item_id: string;
        project_id: string;
        position: number;
        target_ref: string;
        expected_base_revision: string;
      }>(
        `SELECT work_item_id, project_id, position, target_ref, expected_base_revision
         FROM work_item_projects WHERE work_item_id = $1 ORDER BY position`,
        [workItemId],
      );

      assert.equal(rows.length, 2, "two manifest rows inserted");
      assert.equal(rows[0]?.position, 0);
      assert.equal(rows[0]?.project_id, proj1);
      assert.equal(rows[0]?.target_ref, "main");
      assert.equal(rows[0]?.expected_base_revision, sha1);
      assert.equal(rows[1]?.position, 1);
      assert.equal(rows[1]?.project_id, proj2);
      assert.equal(rows[1]?.target_ref, "main");
      assert.equal(rows[1]?.expected_base_revision, sha2);
    } finally {
      await schemaPool.end();
    }
  });
});

test("manifest: create_work_item rejects invalid targetRef", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    try {
      const proj1 = `prj-${randomUUID()}`;
      const sha1 = "aaaa000000000000000000000000000000000000";

      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs)
         VALUES ($1, '{}', '1', $2::jsonb)`,
        [proj1, JSON.stringify({ main: sha1 })],
      );

      const deps = {
        pool: schemaPool,
        runtime: new FakeExecutionRuntime(),
        clock,
      };

      // targetRef "feature" is not in allowed_refs for proj1
      const result = await createWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        projectId: proj1,
        intent: "Multi-repo manifest test",
        boundary: "merge",
        rank: 1,
        manifest: {
          entries: [{ projectId: proj1, targetRef: "feature" }],
        },
      });

      assert.equal(result.ok, false, "should fail with invalid targetRef");
      if (!result.ok) {
        assert.match(result.reason, /targetRef/, "reason mentions targetRef");
      }
    } finally {
      await schemaPool.end();
    }
  });
});

test("manifest: create_work_item rejects without boundary=merge", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    try {
      const proj1 = `prj-${randomUUID()}`;
      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs)
         VALUES ($1, '{}', '1', '{"main":"aaaa000000000000000000000000000000000000"}'::jsonb)`,
        [proj1],
      );

      const deps = {
        pool: schemaPool,
        runtime: new FakeExecutionRuntime(),
        clock,
      };

      const result = await createWorkItem(deps, {
        commandId: `cmd-${randomUUID()}`,
        projectId: proj1,
        intent: "Multi-repo manifest test",
        boundary: "artifact",
        rank: 1,
        manifest: {
          entries: [{ projectId: proj1, targetRef: "main" }],
        },
      });

      assert.equal(result.ok, false, "should fail without merge boundary");
      if (!result.ok) {
        assert.match(result.reason, /merge/, "reason mentions merge");
      }
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: plan() sends manifest in lead.plan payload; step_contract freezes
// manifest_digest and target_ref.
// ---------------------------------------------------------------------------

test("manifest: plan() sends manifest in lead.plan payload", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      // Seed two projects with allowed_refs and clone_path
      const proj1 = `prj-${randomUUID()}`;
      const proj2 = `prj-${randomUUID()}`;
      const sha1 = "aaaa000000000000000000000000000000000000";
      const sha2 = "bbbb000000000000000000000000000000000000";
      const authority = MERGE_AUTHORITY;

      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
         VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj1, JSON.stringify(authority), JSON.stringify({ main: sha1 }), "/repo/proj1"],
      );
      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
         VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj2, JSON.stringify(authority), JSON.stringify({ main: sha2 }), "/repo/proj2"],
      );

      // Seed work item with merge boundary
      const workItemId = `wi-${randomUUID()}`;
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Fix both repos', 'merge', 'proposed', 'healthy', true, 1)`,
        [workItemId, proj1],
      );

      // Seed manifest rows
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'main', $3), ($1, $4, 1, 'main', $5)`,
        [workItemId, proj1, sha1, proj2, sha2],
      );

      // Script lead.plan to return a plan output
      let capturedLeadPlanPayload: unknown;
      fake.script(TASK_IDS.leadPlan, (payload) => {
        capturedLeadPlanPayload = payload;
        return { status: "COMPLETED", output: goodPlanOutput() };
      });

      const flow = new BoundedRepairFlow(makeDeps(schemaPool, fake));
      const planCmdId = newId("cmd");
      await flow.plan(workItemId, planCmdId);

      assert.ok(capturedLeadPlanPayload !== undefined, "lead.plan payload captured");
      const pp = capturedLeadPlanPayload as {
        manifest?: {
          entries: Array<{
            position: number;
            projectId: string;
            targetRef: string;
            expectedBaseRevision: string;
            resultRevision: string | null;
          }>;
          digest: string;
        };
      };

      assert.ok(pp.manifest, "lead.plan payload has manifest");
      assert.equal(pp.manifest.entries.length, 2, "manifest has two entries");

      const e0 = pp.manifest.entries.find((e) => e.position === 0);
      const e1 = pp.manifest.entries.find((e) => e.position === 1);
      assert.ok(e0, "entry at position 0 exists");
      assert.ok(e1, "entry at position 1 exists");
      assert.equal(e0.projectId, proj1);
      assert.equal(e0.targetRef, "main");
      assert.equal(e0.expectedBaseRevision, sha1);
      assert.equal(e1.projectId, proj2);
      assert.equal(e1.targetRef, "main");
      assert.equal(e1.expectedBaseRevision, sha2);

      // digest must equal manifestDigest(entries)
      const expectedDigest = manifestDigest(pp.manifest.entries);
      assert.equal(pp.manifest.digest, expectedDigest, "manifest digest correct");
    } finally {
      await schemaPool.end();
    }
  });
});

test("manifest: step_contract freezes manifest_digest and target_ref on plan output", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const proj1 = `prj-${randomUUID()}`;
      const proj2 = `prj-${randomUUID()}`;
      const sha1 = "aaaa000000000000000000000000000000000000";
      const sha2 = "bbbb000000000000000000000000000000000000";
      const authority = MERGE_AUTHORITY;

      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
         VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj1, JSON.stringify(authority), JSON.stringify({ main: sha1 }), "/repo/proj1"],
      );
      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
         VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj2, JSON.stringify(authority), JSON.stringify({ main: sha2 }), "/repo/proj2"],
      );

      const workItemId = `wi-${randomUUID()}`;
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Fix both repos', 'merge', 'proposed', 'healthy', true, 1)`,
        [workItemId, proj1],
      );

      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'main', $3), ($1, $4, 1, 'main', $5)`,
        [workItemId, proj1, sha1, proj2, sha2],
      );

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: mergePlanOutput(),
      }));
      fake.script(TASK_IDS.workerAttempt, () => ({
        status: "COMPLETED",
        output: workerCompletedOutput("placeholder", {
          commitId: "deadbeef1234567890deadbeef1234567890dead",
          changedPaths: ["src/edge-cases.ts"],
        }),
      }));

      const flow = new BoundedRepairFlow(makeDeps(schemaPool, fake));

      // plan() + advance lead.plan
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);

      // onLeadPlanOutput() — freezes step_contract with manifest_digest and target_ref
      const planOutputCmdId = newId("cmd");
      await flow.onLeadPlanOutput(planIntentId, mergePlanOutput(), planOutputCmdId);

      // Check step_contract has manifest_digest and target_ref
      const { rows: contractRows } = await client.query<{
        manifest_digest: string | null;
        target_ref: string | null;
      }>("SELECT manifest_digest, target_ref FROM step_contracts");

      assert.equal(contractRows.length, 1, "one step_contract row");
      const cr = contractRows[0];
      assert.ok(cr?.manifest_digest, "manifest_digest is set");
      assert.ok(cr?.target_ref, "target_ref is set");

      // manifest_digest must match the expected value
      const expectedDigest = manifestDigest([
        {
          position: 0,
          projectId: proj1,
          targetRef: "main",
          expectedBaseRevision: sha1,
          resultRevision: null,
        },
        {
          position: 1,
          projectId: proj2,
          targetRef: "main",
          expectedBaseRevision: sha2,
          resultRevision: null,
        },
      ]);
      assert.equal(cr?.manifest_digest, expectedDigest, "manifest_digest correct");
      assert.equal(cr?.target_ref, "main", "target_ref is main");
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: onWorkerFinal() produces verify.run payload with manifest ext fields
// ---------------------------------------------------------------------------

test("manifest: onWorkerFinal includes manifest, manifestProjectId, manifestRepoPaths in verify.run payload", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const proj1 = `prj-${randomUUID()}`;
      const proj2 = `prj-${randomUUID()}`;
      const sha1 = "aaaa000000000000000000000000000000000000";
      const sha2 = "bbbb000000000000000000000000000000000000";
      const authority = MERGE_AUTHORITY;

      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
         VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj1, JSON.stringify(authority), JSON.stringify({ main: sha1 }), "/repo/proj1"],
      );
      await client.query(
        `INSERT INTO projects (id, authority, authority_version, allowed_refs, clone_path, worktree_base, profile_catalog)
         VALUES ($1, $2::jsonb, '1', $3::jsonb, $4, '/worktrees', '["default"]'::jsonb)`,
        [proj2, JSON.stringify(authority), JSON.stringify({ main: sha2 }), "/repo/proj2"],
      );

      const workItemId = `wi-${randomUUID()}`;
      await client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'Fix both repos', 'merge', 'proposed', 'healthy', true, 1)`,
        [workItemId, proj1],
      );
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, 0, 'main', $3), ($1, $4, 1, 'main', $5)`,
        [workItemId, proj1, sha1, proj2, sha2],
      );

      fake.script(TASK_IDS.leadPlan, () => ({
        status: "COMPLETED",
        output: goodPlanOutput(),
      }));
      fake.script(TASK_IDS.workerAttempt, () => ({
        status: "COMPLETED",
        output: workerCompletedOutput("placeholder", {
          commitId: "deadbeef1234567890deadbeef1234567890dead",
          changedPaths: ["src/edge-cases.ts"],
        }),
      }));

      const flow = new BoundedRepairFlow(makeDeps(schemaPool, fake));

      // plan → advance → onLeadPlanOutput → worker advance → onWorkerFinal
      const planCmdId = newId("cmd");
      const { intentId: planIntentId, runId: planRunId } = await flow.plan(workItemId, planCmdId);
      fake.advance(planRunId);
      fake.advance(planRunId);
      await flow.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));

      const { rows: workerIntents } = await client.query(
        "SELECT * FROM dispatch_intents WHERE task = $1",
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = (workerIntents[0] as { run_id: string }).run_id;
      fake.advance(workerRunId);
      fake.advance(workerRunId);
      const workerObs = await fake.retrieve(workerRunId);

      // Capture verify.run trigger call
      let capturedVerifyPayload: unknown;
      fake.script(TASK_IDS.verifyRun, (payload) => {
        capturedVerifyPayload = payload;
        return {
          status: "COMPLETED",
          output: {
            results: [
              {
                verifier: { name: "agencyhq-verifier", version: "1.0.0" },
                stepContractId: "x",
                attemptId: "x",
                criteriaDigest: "sha256:" + "a".repeat(64),
                profileDigest: "sha256:" + "b".repeat(64),
                repository: "/repo/proj1",
                baseRevision: sha1,
                attemptRevision: "deadbeef1234567890deadbeef1234567890dead",
                diffDigest: "sha256:" + "c".repeat(64),
                checkId: "pnpm-test",
                environmentFingerprint: { node: "20.0.0" },
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                exitStatus: 0,
                stdoutTail: "ok",
                stderrTail: "",
                artifactDigests: [],
                result: "pass",
              },
            ],
          },
        };
      });

      await flow.onWorkerFinal(workerObs, newId("cmd"));

      assert.ok(capturedVerifyPayload !== undefined, "verify.run payload captured");
      const vp = capturedVerifyPayload as {
        manifest?: { entries: unknown[]; digest: string };
        manifestProjectId?: string;
        manifestRepoPaths?: Record<string, string>;
      };

      assert.ok(vp.manifest, "verify.run payload has manifest");
      assert.equal(vp.manifest.entries.length, 2, "manifest has two entries");

      assert.equal(vp.manifestProjectId, proj1, "manifestProjectId is the active project");
      assert.ok(vp.manifestRepoPaths, "manifestRepoPaths present");
      // proj2 is the sibling; proj1 is the active project
      assert.equal(vp.manifestRepoPaths[proj2], "/repo/proj2", "sibling clone_path for proj2");
    } finally {
      await schemaPool.end();
    }
  });
});
