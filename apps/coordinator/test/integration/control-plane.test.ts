/**
 * Integration tests for slice-5 control-plane commands:
 *  - reject
 *  - invalidate_acceptance
 *  - create_campaign
 *  - assign_campaign
 *  - set_main_effort
 *  - set_rank (stale version check)
 *  - update_authority (version must increase, contracts untouched)
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import type { TestDbContext } from "@agencyhq/db";
import pg from "pg";
import {
  assignCampaign,
  createCampaign,
  invalidateAcceptance,
  rejectWorkItem,
  setMainEffort,
  setWorkItemRank,
  updateAuthority,
} from "../../src/commands/index.ts";
import { withControlPlaneSchema } from "../helpers/control-plane-schema.ts";

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

async function seedProject(
  ctx: TestDbContext,
  opts?: { authority?: unknown; authorityVersion?: string },
): Promise<string> {
  const projectId = `prj-${randomUUID()}`;
  const authority = opts?.authority ?? HOST_TRIAL_AUTHORITY;
  const authorityVersion = opts?.authorityVersion ?? "1";
  await ctx.client.query(
    `INSERT INTO projects (id, remote, clone_path, worktree_base, allowed_refs, authority, authority_version, profile_catalog)
     VALUES ($1, NULL, '/repo', '/worktrees', $2::jsonb, $3::jsonb, $4, '["default"]'::jsonb)`,
    [
      projectId,
      JSON.stringify({ main: "0000000000000000000000000000000000000000" }),
      JSON.stringify(authority),
      authorityVersion,
    ],
  );
  return projectId;
}

async function seedWorkItem(
  ctx: TestDbContext,
  projectId: string,
  opts?: { lifecycle?: string; rank?: number; version?: number },
): Promise<string> {
  const workItemId = `wi-${randomUUID()}`;
  await ctx.client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
     VALUES ($1, $2, $3, 'test intent', 'artifact', $4, 'healthy', true, $5)`,
    [workItemId, projectId, opts?.rank ?? 1, opts?.lifecycle ?? "proposed", opts?.version ?? 1],
  );
  return workItemId;
}

async function seedContract(
  ctx: TestDbContext,
  workItemId: string,
  projectId: string,
): Promise<string> {
  const contractId = `sc-${randomUUID()}`;
  await ctx.client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, 'abc123', '{}', '[]', 'cdigest', 'profile1', 'pdigest',
             '{}', '[]', false, 'active')`,
    [contractId, workItemId, projectId],
  );
  return contractId;
}

async function seedAttemptWithDecision(
  ctx: TestDbContext,
  contractId: string,
  workItemId: string,
  opts?: { decisionOutcome?: string; decisionKind?: string },
): Promise<{ attemptId: string; decisionId: string }> {
  const attemptId = `att-${randomUUID()}`;
  const decisionId = `dec-${randomUUID()}`;

  await ctx.client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
     VALUES ($1, $2, 1, 1, 'completed', 0)`,
    [attemptId, contractId],
  );

  await ctx.client.query(
    `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
     VALUES ($1, $2, 'coordinator', $3, $4, $5, now())`,
    [
      decisionId,
      opts?.decisionKind ?? "accept",
      workItemId,
      attemptId,
      opts?.decisionOutcome ?? "pending_human",
    ],
  );

  return { attemptId, decisionId };
}

// ---------------------------------------------------------------------------
// Tests: rejectWorkItem
// ---------------------------------------------------------------------------

test("reject: pending_human decision → rejected, work item lifecycle → halted", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { decisionId } = await seedAttemptWithDecision(ctx, contractId, workItemId, {
        decisionOutcome: "pending_human",
      });

      const result = await rejectWorkItem(
        { pool },
        { commandId: randomUUID(), workItemId, decisionId, reason: "Not acceptable" },
      );

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.decisionId, decisionId);
      }

      // Verify decision is now rejected
      const { rows: decRows } = (await ctx.client.query(
        `SELECT outcome FROM decisions WHERE id = $1`,
        [decisionId],
      )) as { rows: Array<{ outcome: string }> };
      assert.equal(decRows[0]?.outcome, "rejected");

      // Verify work item lifecycle is now halted
      const { rows: wiRows } = (await ctx.client.query(
        `SELECT lifecycle FROM work_items WHERE id = $1`,
        [workItemId],
      )) as { rows: Array<{ lifecycle: string }> };
      assert.equal(wiRows[0]?.lifecycle, "halted");
    } finally {
      await pool.end();
    }
  });
});

test("reject: state_mismatch when decision not pending_human", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { decisionId } = await seedAttemptWithDecision(ctx, contractId, workItemId, {
        decisionOutcome: "approved", // already resolved
      });

      const result = await rejectWorkItem(
        { pool },
        { commandId: randomUUID(), workItemId, decisionId, reason: "Not acceptable" },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "state_mismatch");
      }
    } finally {
      await pool.end();
    }
  });
});

test("reject: replay no-op on second call with same commandId", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { decisionId } = await seedAttemptWithDecision(ctx, contractId, workItemId, {
        decisionOutcome: "pending_human",
      });

      const commandId = randomUUID();
      const result1 = await rejectWorkItem(
        { pool },
        { commandId, workItemId, decisionId, reason: "r1" },
      );
      const result2 = await rejectWorkItem(
        { pool },
        { commandId, workItemId, decisionId, reason: "r1" },
      );

      assert.equal(result1.ok, true);
      assert.equal(result2.ok, true);
      assert.equal((result2 as { replayed?: boolean }).replayed, true);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: invalidateAcceptance
// ---------------------------------------------------------------------------

test("invalidate_acceptance: creates invalidation decision and reopens work item", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "completed" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { attemptId, decisionId: acceptDecisionId } = await seedAttemptWithDecision(
        ctx,
        contractId,
        workItemId,
        { decisionOutcome: "approved", decisionKind: "accept" },
      );

      const result = await invalidateAcceptance(
        { pool },
        { commandId: randomUUID(), workItemId, attemptId, reason: "Defect found" },
      );

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.invalidationDecisionId);
      }

      // Work item should be reopened
      const { rows: wiRows } = (await ctx.client.query(
        `SELECT lifecycle FROM work_items WHERE id = $1`,
        [workItemId],
      )) as { rows: Array<{ lifecycle: string }> };
      assert.equal(wiRows[0]?.lifecycle, "reopened");

      // Old accept decision should still exist unchanged
      const { rows: oldDecRows } = (await ctx.client.query(
        `SELECT id, outcome, kind FROM decisions WHERE id = $1`,
        [acceptDecisionId],
      )) as { rows: Array<{ id: string; outcome: string; kind: string }> };
      assert.equal(oldDecRows[0]?.outcome, "approved"); // historical row untouched
      assert.equal(oldDecRows[0]?.kind, "accept");

      // New invalidation decision should exist
      const { rows: newDecRows } = (await ctx.client.query(
        `SELECT kind, outcome, causation_id FROM decisions WHERE kind = 'invalidate' AND work_item_id = $1`,
        [workItemId],
      )) as { rows: Array<{ kind: string; outcome: string; causation_id: string }> };
      assert.equal(newDecRows.length, 1);
      assert.equal(newDecRows[0]?.kind, "invalidate");
      assert.equal(newDecRows[0]?.causation_id, acceptDecisionId);
    } finally {
      await pool.end();
    }
  });
});

test("invalidate_acceptance: no_accepted_decision when no approved decision exists", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { attemptId } = await seedAttemptWithDecision(ctx, contractId, workItemId, {
        decisionOutcome: "pending_human", // not approved
      });

      const result = await invalidateAcceptance(
        { pool },
        { commandId: randomUUID(), workItemId, attemptId, reason: "test" },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "no_accepted_decision");
      }
    } finally {
      await pool.end();
    }
  });
});

test("invalidate_acceptance: replay no-op on second call", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "completed" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { attemptId } = await seedAttemptWithDecision(ctx, contractId, workItemId, {
        decisionOutcome: "approved",
        decisionKind: "accept",
      });

      const commandId = randomUUID();
      const r1 = await invalidateAcceptance(
        { pool },
        { commandId, workItemId, attemptId, reason: "r" },
      );
      const r2 = await invalidateAcceptance(
        { pool },
        { commandId, workItemId, attemptId, reason: "r" },
      );

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal((r2 as { replayed?: boolean }).replayed, true);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: createCampaign
// ---------------------------------------------------------------------------

test("create_campaign: creates a campaign and returns ok", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const commandId = randomUUID();
      const result = await createCampaign({ pool }, { commandId, name: "MVP Sprint" });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.campaignId);
      }

      // Verify campaign exists in DB
      const { rows } = (await ctx.client.query(`SELECT name FROM campaigns WHERE id = $1`, [
        result.ok ? result.campaignId : "",
      ])) as { rows: Array<{ name: string }> };
      assert.equal(rows[0]?.name, "MVP Sprint");
    } finally {
      await pool.end();
    }
  });
});

test("create_campaign: replay no-op on second call", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const commandId = randomUUID();
      const r1 = await createCampaign({ pool }, { commandId, name: "Sprint 1" });
      const r2 = await createCampaign({ pool }, { commandId, name: "Sprint 1" });

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal((r2 as { replayed?: boolean }).replayed, true);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: assignCampaign
// ---------------------------------------------------------------------------

test("assign_campaign: assigns work item to campaign", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);

      // Create campaign first
      const campaignResult = await createCampaign(
        { pool },
        { commandId: randomUUID(), name: "Campaign A" },
      );
      assert.equal(campaignResult.ok, true);
      const campaignId = campaignResult.ok ? campaignResult.campaignId : "";

      // Assign
      const result = await assignCampaign(
        { pool },
        { commandId: randomUUID(), workItemId, campaignId },
      );

      assert.equal(result.ok, true);

      // Verify campaign_id is set on work_item
      const { rows } = (await ctx.client.query(`SELECT campaign_id FROM work_items WHERE id = $1`, [
        workItemId,
      ])) as { rows: Array<{ campaign_id: string | null }> };
      assert.equal(rows[0]?.campaign_id, campaignId);
    } finally {
      await pool.end();
    }
  });
});

test("assign_campaign: returns not_found for missing campaign", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);

      const result = await assignCampaign(
        { pool },
        { commandId: randomUUID(), workItemId, campaignId: "cmp-nonexistent" },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "not_found");
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: setMainEffort
// ---------------------------------------------------------------------------

test("set_main_effort: updates campaign main_effort_work_item_id", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);

      const campaignResult = await createCampaign(
        { pool },
        { commandId: randomUUID(), name: "Campaign B" },
      );
      assert.equal(campaignResult.ok, true);
      const campaignId = campaignResult.ok ? campaignResult.campaignId : "";

      const result = await setMainEffort(
        { pool },
        { commandId: randomUUID(), campaignId, workItemId },
      );

      assert.equal(result.ok, true);

      // Verify main_effort_work_item_id is set
      const { rows } = (await ctx.client.query(
        `SELECT main_effort_work_item_id FROM campaigns WHERE id = $1`,
        [campaignId],
      )) as { rows: Array<{ main_effort_work_item_id: string | null }> };
      assert.equal(rows[0]?.main_effort_work_item_id, workItemId);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: setWorkItemRank
// ---------------------------------------------------------------------------

test("set_rank: updates rank when version matches", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { rank: 1, version: 1 });

      const result = await setWorkItemRank(
        { pool },
        { commandId: randomUUID(), workItemId, rank: 3, expectedVersion: 1 },
      );

      assert.equal(result.ok, true);

      const { rows } = (await ctx.client.query(`SELECT rank FROM work_items WHERE id = $1`, [
        workItemId,
      ])) as { rows: Array<{ rank: number }> };
      assert.equal(rows[0]?.rank, 3);
    } finally {
      await pool.end();
    }
  });
});

test("set_rank: stale_version when expectedVersion does not match", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { version: 2 }); // current version = 2

      const result = await setWorkItemRank(
        { pool },
        { commandId: randomUUID(), workItemId, rank: 3, expectedVersion: 1 }, // expects version 1
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "stale_version");
      }
    } finally {
      await pool.end();
    }
  });
});

test("set_rank: replay no-op on second call", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { version: 1 });

      const commandId = randomUUID();
      const r1 = await setWorkItemRank(
        { pool },
        { commandId, workItemId, rank: 5, expectedVersion: 1 },
      );
      const r2 = await setWorkItemRank(
        { pool },
        { commandId, workItemId, rank: 5, expectedVersion: 1 },
      );

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal((r2 as { replayed?: boolean }).replayed, true);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: updateAuthority
// ---------------------------------------------------------------------------

test("update_authority: validates with AuthoritySchema and increments version", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx, {
        authority: HOST_TRIAL_AUTHORITY,
        authorityVersion: "1",
      });

      const newAuthority = { ...HOST_TRIAL_AUTHORITY, version: "2" };
      const result = await updateAuthority(
        { pool },
        { commandId: randomUUID(), projectId, authority: newAuthority, actor: "operator" },
      );

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.version, "2");
      }

      // Verify project has updated authority_version
      const { rows: projRows } = (await ctx.client.query(
        `SELECT authority_version FROM projects WHERE id = $1`,
        [projectId],
      )) as { rows: Array<{ authority_version: string }> };
      assert.equal(projRows[0]?.authority_version, "2");

      // Verify authority_versions table has the new entry
      const { rows: avRows } = (await ctx.client.query(
        `SELECT version, actor FROM authority_versions WHERE project_id = $1`,
        [projectId],
      )) as { rows: Array<{ version: string; actor: string }> };
      assert.equal(avRows.length, 1);
      assert.equal(avRows[0]?.version, "2");
      assert.equal(avRows[0]?.actor, "operator");

      // Verify a decision of kind authority_update was inserted
      const { rows: decRows } = (await ctx.client.query(
        `SELECT kind, outcome, authority_version FROM decisions WHERE command_id IN
         (SELECT command_id FROM commands WHERE kind = 'update_authority' LIMIT 1)`,
        [],
      )) as { rows: Array<{ kind: string; outcome: string; authority_version: string }> };
      assert.ok(decRows.some((d) => d.kind === "authority_update"));
    } finally {
      await pool.end();
    }
  });
});

test("update_authority: validation_failed on invalid authority", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);

      const result = await updateAuthority(
        { pool },
        { commandId: randomUUID(), projectId, authority: { invalid: true }, actor: "op" },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "validation_failed");
      }
    } finally {
      await pool.end();
    }
  });
});

test("update_authority: version_not_increasing when new version <= current", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx, {
        authority: HOST_TRIAL_AUTHORITY,
        authorityVersion: "5",
      });

      const newAuthority = { ...HOST_TRIAL_AUTHORITY, version: "3" }; // 3 <= 5
      const result = await updateAuthority(
        { pool },
        { commandId: randomUUID(), projectId, authority: newAuthority, actor: "op" },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "version_not_increasing");
      }
    } finally {
      await pool.end();
    }
  });
});

test("update_authority: frozen step_contracts are NOT modified", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx, {
        authority: HOST_TRIAL_AUTHORITY,
        authorityVersion: "1",
      });
      const workItemId = await seedWorkItem(ctx, projectId);
      const contractId = await seedContract(ctx, workItemId, projectId);

      // Record original contract state
      const { rows: beforeRows } = (await ctx.client.query(
        `SELECT id, version, criteria_digest, bounds FROM step_contracts WHERE id = $1`,
        [contractId],
      )) as {
        rows: Array<{ id: string; version: number; criteria_digest: string; bounds: unknown }>;
      };
      const before = beforeRows[0];
      assert.ok(before);

      // Update authority
      const newAuthority = { ...HOST_TRIAL_AUTHORITY, version: "2" };
      await updateAuthority(
        { pool },
        { commandId: randomUUID(), projectId, authority: newAuthority, actor: "op" },
      );

      // Verify contract row is unchanged
      const { rows: afterRows } = (await ctx.client.query(
        `SELECT id, version, criteria_digest FROM step_contracts WHERE id = $1`,
        [contractId],
      )) as { rows: Array<{ id: string; version: number; criteria_digest: string }> };
      const after = afterRows[0];
      assert.ok(after);
      assert.equal(after.id, before.id);
      assert.equal(after.version, before.version);
      assert.equal(after.criteria_digest, before.criteria_digest);
    } finally {
      await pool.end();
    }
  });
});

test("update_authority: replay no-op on second call", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx, {
        authority: HOST_TRIAL_AUTHORITY,
        authorityVersion: "1",
      });

      const commandId = randomUUID();
      const newAuthority = { ...HOST_TRIAL_AUTHORITY, version: "2" };
      const r1 = await updateAuthority(
        { pool },
        { commandId, projectId, authority: newAuthority, actor: "op" },
      );
      const r2 = await updateAuthority(
        { pool },
        { commandId, projectId, authority: newAuthority, actor: "op" },
      );

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal((r2 as { replayed?: boolean }).replayed, true);
    } finally {
      await pool.end();
    }
  });
});
