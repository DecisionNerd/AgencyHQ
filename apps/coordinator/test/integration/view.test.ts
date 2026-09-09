/**
 * Integration test for GET /api/work-items/:id/view.
 *
 * Verifies that the /view endpoint:
 *   - Loads integration rows and reflects their state (integrated, pending, etc.)
 *   - Loads work_item_projects rows and reflects manifest progress
 *   - Passes boundary, integrations, and workItemProjects to buildReturnView
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestDbContext } from "@agencyhq/db";
import { withTestSchema } from "@agencyhq/db";
import pg from "pg";
import type { FlowLike, ReconcilerLike, RuntimeLike } from "../../src/app.ts";
import { createApp } from "../../src/app.ts";
import type { CoordinatorConfig } from "../../src/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date().toISOString();

// Minimal valid bounds that satisfies ContractBoundsSchema.
const VALID_BOUNDS = {
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
  boundary: "merge",
  budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
  review: "adversarial",
  changeClass: "behavior",
  models: { worker: "claude-sonnet-4", reviewer: "claude-sonnet-4" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchemaPool(databaseUrl: string, schema: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const origConnect = pool.connect.bind(pool);
  // biome-ignore lint/suspicious/noExplicitAny: wrapping pool.connect
  (pool as any).connect = async () => {
    const client = await origConnect();
    await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);
    return client;
  };
  return pool;
}

function makeFakeFlow(): FlowLike {
  return { plan: async () => ({ ok: true }) };
}

function makeFakeReconciler(): ReconcilerLike {
  return { freshness: () => ({ lastPollAt: NOW, stale: false }) };
}

function makeFakeRuntime(): RuntimeLike {
  return {
    createPublicToken: async () => "fake-token",
  };
}

function makeConfig(): CoordinatorConfig {
  return {
    databaseUrl: DATABASE_URL ?? "",
    triggerApiUrl: "https://trigger.example.com",
    triggerSecretKey: "secret",
    runtime: "fake",
    worktreeBase: "/tmp/worktrees",
    workerModel: "claude-sonnet-4",
    leadModel: "claude-opus-4",
    reviewerModel: "claude-sonnet-4",
    reconcileIntervalMs: 5000,
    freshnessStaleMs: 30000,
    uncertainAfterMs: 120000,
    port: 8787,
    bindHost: "127.0.0.1",
  };
}

/**
 * Seeds a merge-boundary work item with a single contract, attempt, integration
 * row, and optionally one work_item_projects row.
 *
 * Returns { workItemId, attemptId, projectId }.
 */
async function seedMergeItem(
  ctx: TestDbContext,
  opts: {
    integrationOutcome: string | null;
    integrationResultingRevision: string | null;
    withWorkItemProject: boolean;
  },
): Promise<{ workItemId: string; attemptId: string; projectId: string }> {
  const projectId = `prj-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const contractId = `sc-${randomUUID()}`;
  const attemptId = `att-${randomUUID()}`;

  const baseRevision = "0000000000000000000000000000000000000000";

  // Minimal valid authority to satisfy any schema checks.
  const authority = {
    boundaries: ["artifact", "merge"],
    humanRequired: null,
    criteria: [],
    profiles: [],
    stopConditions: [],
    maxGenerations: 5,
    leadModel: null,
    workerModel: null,
    reviewerModel: null,
    manifestDigest: null,
  };

  await ctx.client.query(
    `INSERT INTO projects
       (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
     VALUES ($1, NULL, '/repo', '/worktrees', $2::jsonb, $3::jsonb, '1', '["default"]'::jsonb)`,
    [projectId, JSON.stringify({ main: baseRevision }), JSON.stringify(authority)],
  );

  await ctx.client.query(
    `INSERT INTO work_items
       (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
     VALUES ($1, $2, 1, 'Test merge item', 'merge', 'completed', 'nominal', true, 1)`,
    [workItemId, projectId],
  );

  await ctx.client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, $4, '{}', '[]', 'cdigest', 'profile1', 'pdigest',
             $5::jsonb, '[]', false, 'active')`,
    [contractId, workItemId, projectId, baseRevision, JSON.stringify(VALID_BOUNDS)],
  );

  await ctx.client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
     VALUES ($1, $2, 1, 1, 'completed', 0)`,
    [attemptId, contractId],
  );

  await ctx.client.query(
    `INSERT INTO integrations
       (id, attempt_id, contract_id, contract_version, target_ref,
        expected_base_revision, resulting_revision, outcome)
     VALUES ($1, $2, $3, 1, 'main', $4, $5, $6)`,
    [
      `int-${randomUUID()}`,
      attemptId,
      contractId,
      baseRevision,
      opts.integrationResultingRevision,
      opts.integrationOutcome,
    ],
  );

  if (opts.withWorkItemProject) {
    // One row: resolved (result_revision set)
    await ctx.client.query(
      `INSERT INTO work_item_projects
         (work_item_id, project_id, position, target_ref, expected_base_revision, result_revision)
       VALUES ($1, $2, 0, 'main', $3, $4)`,
      [workItemId, projectId, baseRevision, opts.integrationResultingRevision],
    );
  }

  return { workItemId, attemptId, projectId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("GET /api/work-items/:id/view — integrated merge item shows integration.state=integrated", async (t) => {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL unset; skipping integration test");
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL, ctx.schema);
    try {
      const RESULT_REVISION = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
      const { workItemId } = await seedMergeItem(ctx, {
        integrationOutcome: "integrated",
        integrationResultingRevision: RESULT_REVISION,
        withWorkItemProject: true,
      });

      const app = createApp({
        pool,
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
        clock: () => NOW,
      });

      const res = await app.request(`/api/work-items/${encodeURIComponent(workItemId)}/view`);
      assert.equal(res.status, 200, "response should be 200");

      const body = (await res.json()) as {
        workItemId: string;
        lifecycle: string;
        condition: string;
        integration: {
          state: string;
          outcome: string | null;
          resultingRevision: string | null;
          at: string | null;
        } | null;
        manifest: { resolved: number; total: number } | null;
      };

      assert.equal(body.workItemId, workItemId);
      assert.equal(body.lifecycle, "completed", "lifecycle should be completed");
      assert.equal(body.condition, "nominal", "condition should be nominal");

      // Integration assertions (C1 fix — integrations loaded by /view endpoint)
      assert.ok(body.integration !== null, "integration should be present for merge boundary");
      assert.equal(
        body.integration?.state,
        "integrated",
        "integration.state should be 'integrated'",
      );
      assert.equal(
        body.integration?.resultingRevision,
        RESULT_REVISION,
        "resultingRevision should match seeded value",
      );
      assert.ok(body.integration?.at !== null, "integration.at should be non-null");

      // Manifest assertions (C1 fix — work_item_projects loaded by /view endpoint)
      assert.ok(body.manifest !== null, "manifest should be present");
      assert.equal(body.manifest?.total, 1, "manifest.total should be 1");
      assert.equal(
        body.manifest?.resolved,
        1,
        "manifest.resolved should be 1 (result_revision is set)",
      );
    } finally {
      await pool.end();
    }
  });
});

test("GET /api/work-items/:id/view — pending merge item shows integration.state=pending", async (t) => {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL unset; skipping integration test");
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL, ctx.schema);
    try {
      const { workItemId } = await seedMergeItem(ctx, {
        integrationOutcome: null,
        integrationResultingRevision: null,
        withWorkItemProject: false,
      });

      const app = createApp({
        pool,
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
        clock: () => NOW,
      });

      const res = await app.request(`/api/work-items/${encodeURIComponent(workItemId)}/view`);
      assert.equal(res.status, 200);

      const body = (await res.json()) as {
        integration: { state: string } | null;
        manifest: unknown;
      };

      assert.ok(body.integration !== null, "integration should be present");
      assert.equal(body.integration?.state, "pending", "integration.state should be 'pending'");
      assert.equal(body.manifest, null, "manifest should be null when no work_item_projects");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// U-4: after approve, /api/work-items/:id/view exposes openPendingDecisions: []
// ---------------------------------------------------------------------------

test("U-4: after approve /api/work-items/:id/view has openPendingDecisions: []", async (t) => {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL unset; skipping integration test");
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL, ctx.schema);
    try {
      const projectId = `prj-${randomUUID()}`;
      const workItemId = `wi-${randomUUID()}`;
      const contractId = `sc-${randomUUID()}`;
      const attemptId = `att-${randomUUID()}`;
      const baseRevision = "0000000000000000000000000000000000000000";

      await ctx.client.query(
        `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
         VALUES ($1, NULL, '/repo', '/worktrees', '{"main":"${baseRevision}"}'::jsonb, '{}'::jsonb, '1', '["default"]'::jsonb)`,
        [projectId],
      );
      await ctx.client.query(
        `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 1, 'test', 'artifact', 'completed', 'nominal', true, 1)`,
        [workItemId, projectId],
      );
      await ctx.client.query(
        `INSERT INTO step_contracts
           (id, work_item_id, project_id, version, base_revision, inputs, criteria,
            criteria_digest, profile_id, profile_digest, bounds, required_boundaries, human_required, status)
         VALUES ($1, $2, $3, 1, $4, '{}', '[]', 'cd', 'p', 'pd', '{"paths":{"allow":["src/**"],"deny":[]},"capabilities":{"bash":{"allow":[],"deny":[]},"tools":{"edit":true,"webfetch":false,"websearch":false,"task":false,"external_directory":false,"skill":false}},"boundary":"artifact","budget":{"maxAttempts":2,"maxDurationSeconds":300,"estimatedSpendUsd":2},"review":"adversarial","changeClass":"behavior","models":{"worker":"claude/claude-sonnet-4-5","reviewer":"claude/claude-sonnet-4-5"}}'::jsonb, '[]', false, 'active')`,
        [contractId, workItemId, projectId, baseRevision],
      );
      await ctx.client.query(
        `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
         VALUES ($1, $2, 1, 1, 'completed', 0)`,
        [attemptId, contractId],
      );

      // Seed a pending_human decision and an approved decision for the same attempt.
      // After approve, the pending should no longer be open.
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'accept', 'coordinator', $2, $3, 'pending_human', now() - interval '1 second')`,
        [`dec-pending-${randomUUID()}`, workItemId, attemptId],
      );
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'accept', 'human', $2, $3, 'approved', now())`,
        [`dec-approved-${randomUUID()}`, workItemId, attemptId],
      );

      const app = createApp({
        pool,
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
        clock: () => NOW,
      });

      const res = await app.request(`/api/work-items/${encodeURIComponent(workItemId)}/view`);
      assert.equal(res.status, 200, "view responds 200");

      const body = (await res.json()) as {
        openPendingDecisions: Array<{ id: string; kind: string | null; at: string }>;
      };

      assert.ok(
        Array.isArray(body.openPendingDecisions),
        "U-4: openPendingDecisions is an array in the response",
      );
      assert.equal(
        body.openPendingDecisions.length,
        0,
        "U-4: after approve, openPendingDecisions is empty",
      );
    } finally {
      await pool.end();
    }
  });
});
