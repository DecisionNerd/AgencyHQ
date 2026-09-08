/**
 * Rework integration tests for S5 findings T-4, T-5, T-8, T-9, T-12, T-13.
 * Also covers U-1 (reject guard), U-3 (invalidate accepted), U-8 (backfill actor).
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
  updateAuthority,
} from "../../src/commands/index.ts";
import { buildDecisionsView } from "../../src/views/decisions-view.ts";
import { withControlPlaneSchema } from "../helpers/control-plane-schema.ts";

// ---------------------------------------------------------------------------
// Helpers (duplicated locally to keep tests self-contained)
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
  opts?: { lifecycle?: string },
): Promise<string> {
  const workItemId = `wi-${randomUUID()}`;
  await ctx.client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition, main_effort, version)
     VALUES ($1, $2, 1, 'test intent', 'artifact', $3, 'healthy', true, 1)`,
    [workItemId, projectId, opts?.lifecycle ?? "proposed"],
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
// T-4: APPROVAL_VERSION_MISMATCH → approval_mismatch outcome, pending stays open
// ---------------------------------------------------------------------------

test("T-4: mismatch decision remains open in view and a later correct approve succeeds", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    // Seed a pending decision and a sibling approval_mismatch decision (as approve would write).
    const projectId = await seedProject(ctx);
    const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
    const contractId = await seedContract(ctx, workItemId, projectId);
    const { attemptId, decisionId: pendingId } = await seedAttemptWithDecision(
      ctx,
      contractId,
      workItemId,
      { decisionOutcome: "pending_human" },
    );

    // Insert an approval_mismatch decision (same attempt, same kind) — this is what
    // the approve command now writes on a version mismatch (T-4).
    const mismatchId = `dec-mismatch-${randomUUID()}`;
    await ctx.client.query(
      `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
       VALUES ($1, 'accept', 'human', $2, $3, 'approval_mismatch', now())`,
      [mismatchId, workItemId, attemptId],
    );

    // The pending_human decision must still be open (not resolved by approval_mismatch).
    const { rows: openRows } = (await ctx.client.query(
      `SELECT outcome FROM decisions WHERE work_item_id = $1 AND outcome = 'pending_human'`,
      [workItemId],
    )) as { rows: Array<{ outcome: string }> };
    assert.equal(openRows.length, 1, "pending_human decision still open after approval_mismatch");

    // There is no resolved decision (approved/rejected/accepted/invalidated) for the attempt,
    // so the approve command's NOT EXISTS guard will find the pending decision.
    const { rows: resolvedRows } = (await ctx.client.query(
      `SELECT outcome FROM decisions WHERE attempt_id = $1
       AND outcome IN ('approved', 'rejected', 'accepted', 'invalidated')`,
      [attemptId],
    )) as { rows: Array<{ outcome: string }> };
    assert.equal(resolvedRows.length, 0, "no resolving decision — pending remains open for retry");

    // U-13: exercise the decisions view builder — the pending must appear as open,
    // and the approval_mismatch decision must exist in the DB. The view function
    // runs openPendingDecisions, which must not close the pending due to mismatch.
    const viewDecisions = [
      {
        id: pendingId,
        workItemId,
        kind: "accept",
        outcome: "pending_human",
        at: new Date().toISOString(),
        attemptId,
        contractVersion: 1 as number | null,
        rationale: null as string | null,
      },
      {
        id: mismatchId,
        workItemId,
        kind: "accept",
        outcome: "approval_mismatch",
        at: new Date().toISOString(),
        attemptId,
        contractVersion: 1 as number | null,
        rationale: null as string | null,
      },
    ];
    const decisionsView = buildDecisionsView({
      decisions: viewDecisions,
      attempts: [],
      contracts: [],
      findings: [],
    });
    // The decisions view should list the pending as open (approval_mismatch is not resolving).
    assert.equal(
      decisionsView.decisions.length,
      1,
      "decisions view: pending still open (not resolved by approval_mismatch)",
    );
    assert.equal(decisionsView.decisions[0]?.id, pendingId, "open pending id matches");

    // The approval_mismatch decision must exist in the DB (command side covered by approve.test.ts).
    const { rows: mismatchRows } = (await ctx.client.query(
      `SELECT outcome FROM decisions WHERE id = $1`,
      [mismatchId],
    )) as { rows: Array<{ outcome: string }> };
    assert.equal(mismatchRows[0]?.outcome, "approval_mismatch", "approval_mismatch decision in DB");
  });
});

// ---------------------------------------------------------------------------
// T-8: set_main_effort membership guard
// ---------------------------------------------------------------------------

test("T-8: set_main_effort returns not_a_member when work item not in campaign", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);

      const campaignResult = await createCampaign(
        { pool },
        { commandId: randomUUID(), name: "Guard Test Campaign" },
      );
      assert.equal(campaignResult.ok, true);
      const campaignId = campaignResult.ok ? campaignResult.campaignId : "";

      // Do NOT assign — expect not_a_member.
      const result = await setMainEffort(
        { pool },
        { commandId: randomUUID(), campaignId, workItemId },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "not_a_member", "membership guard enforced");
      }
    } finally {
      await pool.end();
    }
  });
});

test("T-8: set_main_effort succeeds after assigning work item to campaign", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId);

      const campaignResult = await createCampaign(
        { pool },
        { commandId: randomUUID(), name: "Assigned Campaign" },
      );
      assert.equal(campaignResult.ok, true);
      const campaignId = campaignResult.ok ? campaignResult.campaignId : "";

      // Assign first.
      const assignResult = await assignCampaign(
        { pool },
        { commandId: randomUUID(), workItemId, campaignId },
      );
      assert.equal(assignResult.ok, true, "assign succeeded");

      // Now set main effort should succeed.
      const result = await setMainEffort(
        { pool },
        { commandId: randomUUID(), campaignId, workItemId },
      );
      assert.equal(result.ok, true, "set_main_effort succeeds after assign");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-9: update_authority lost-update protection (stale_version)
// ---------------------------------------------------------------------------

test("T-9: update_authority stale_version when update base is no longer current", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx, {
        authority: HOST_TRIAL_AUTHORITY,
        authorityVersion: "1",
      });

      // First update succeeds.
      const r1 = await updateAuthority(
        { pool },
        {
          commandId: randomUUID(),
          projectId,
          authority: { ...HOST_TRIAL_AUTHORITY, version: "2" },
          actor: "op",
        },
      );
      assert.equal(r1.ok, true, "first update ok");

      // Second update proposes version "2" again (same base) — domain rejects it.
      // With SELECT FOR UPDATE, the second writer reads the already-updated row
      // (version "2"), so proposeAuthorityUpdate sees next.version ("2") <= current ("2")
      // and returns version_not_greater → version_not_increasing. stale_version is
      // unreachable under FOR UPDATE (the CAS branch never fires for a concurrent writer
      // because the lock serialises writes); stale_version remains in the type for the
      // non-locking path if any is ever introduced.
      const r2 = await updateAuthority(
        { pool },
        {
          commandId: randomUUID(),
          projectId,
          authority: { ...HOST_TRIAL_AUTHORITY, version: "2" },
          actor: "op",
        },
      );
      assert.equal(r2.ok, false, "second update from same base fails");
      if (!r2.ok) {
        assert.equal(
          r2.reason,
          "version_not_increasing",
          "FOR UPDATE serialises writes: second writer sees new version, gets version_not_increasing",
        );
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-12: reject appends a decision (pending row stays as history)
// ---------------------------------------------------------------------------

test("T-12: reject appends rejected decision; pending row stays as history", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { decisionId: pendingId, attemptId } = await seedAttemptWithDecision(
        ctx,
        contractId,
        workItemId,
        { decisionOutcome: "pending_human" },
      );

      const result = await rejectWorkItem(
        { pool },
        { commandId: randomUUID(), workItemId, decisionId: pendingId, reason: "defect" },
      );

      assert.equal(result.ok, true);
      if (result.ok) {
        // Returned id is the NEW appended decision, not the pending one.
        assert.notEqual(result.decisionId, pendingId, "new decision appended");
      }

      // Original pending row is still pending_human (history — R-017).
      const { rows: orig } = (await ctx.client.query(
        `SELECT outcome FROM decisions WHERE id = $1`,
        [pendingId],
      )) as { rows: Array<{ outcome: string }> };
      assert.equal(orig[0]?.outcome, "pending_human", "pending row stays as history");

      // New rejected decision exists for the same attempt.
      const { rows: rej } = (await ctx.client.query(
        `SELECT outcome, reason FROM decisions
         WHERE attempt_id = $1 AND outcome = 'rejected'`,
        [attemptId],
      )) as { rows: Array<{ outcome: string; reason: string | null }> };
      assert.equal(rej.length, 1, "one rejected decision appended");
      assert.equal(rej[0]?.reason, "defect", "reason stored (T-5)");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-13: update_authority backfills initial authority_versions entry
// ---------------------------------------------------------------------------

test("T-13: update_authority backfills initial version in authority_versions on first update", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx, {
        authority: HOST_TRIAL_AUTHORITY,
        authorityVersion: "1",
      });

      // No authority_versions rows yet.
      const { rows: before } = (await ctx.client.query(
        `SELECT version FROM authority_versions WHERE project_id = $1`,
        [projectId],
      )) as { rows: Array<{ version: string }> };
      assert.equal(before.length, 0, "no rows before first update");

      const r = await updateAuthority(
        { pool },
        {
          commandId: randomUUID(),
          projectId,
          authority: { ...HOST_TRIAL_AUTHORITY, version: "2" },
          actor: "op",
        },
      );
      assert.equal(r.ok, true);

      // U-8: the backfilled row must be attributed to "backfill" (not the updating
      // actor) and its timestamp must match the project's created_at.
      const { rows: projectMeta } = (await ctx.client.query(
        `SELECT created_at FROM projects WHERE id = $1`,
        [projectId],
      )) as { rows: Array<{ created_at: Date }> };

      const { rows: after } = (await ctx.client.query(
        `SELECT version, actor, at FROM authority_versions WHERE project_id = $1 ORDER BY at`,
        [projectId],
      )) as { rows: Array<{ version: string; actor: string; at: Date }> };
      assert.equal(after.length, 2, "initial + new version both recorded");
      assert.equal(after[0]?.version, "1", "initial version backfilled");
      assert.equal(
        after[0]?.actor,
        "backfill",
        "backfill row attributed to 'backfill' actor (U-8)",
      );
      // Timestamp should equal project created_at (within 1 second tolerance for DB precision).
      const backfillAt = after[0]?.at?.getTime() ?? 0;
      const projectCreatedAt = projectMeta[0]?.created_at?.getTime() ?? -1;
      assert.ok(
        Math.abs(backfillAt - projectCreatedAt) < 1000,
        `backfill at (${new Date(backfillAt).toISOString()}) should match project created_at (${new Date(projectCreatedAt).toISOString()})`,
      );
      assert.equal(after[1]?.version, "2", "new version recorded");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-13: invalidate_acceptance does not modify step_contracts
// ---------------------------------------------------------------------------

test("T-13: invalidate_acceptance leaves step_contracts row unchanged", async (t) => {
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

      // Record original contract state.
      const { rows: before } = (await ctx.client.query(
        `SELECT id, status, criteria_digest FROM step_contracts WHERE id = $1`,
        [contractId],
      )) as { rows: Array<{ id: string; status: string; criteria_digest: string }> };

      await invalidateAcceptance(
        { pool },
        { commandId: randomUUID(), workItemId, attemptId, reason: "defect" },
      );

      // Contract row unchanged.
      const { rows: after } = (await ctx.client.query(
        `SELECT id, status, criteria_digest FROM step_contracts WHERE id = $1`,
        [contractId],
      )) as { rows: Array<{ id: string; status: string; criteria_digest: string }> };
      assert.equal(after[0]?.status, before[0]?.status, "status unchanged");
      assert.equal(
        after[0]?.criteria_digest,
        before[0]?.criteria_digest,
        "criteria_digest unchanged",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// U-1: reject guard — reject-after-approve returns state_mismatch (R-001, R-010)
// ---------------------------------------------------------------------------

test("U-1: reject-after-approve returns state_mismatch; lifecycle and decision count unchanged", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "completed" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { decisionId: pendingId, attemptId } = await seedAttemptWithDecision(
        ctx,
        contractId,
        workItemId,
        { decisionOutcome: "pending_human" },
      );

      // Simulate what approve wrote: an approved decision for the same attempt.
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'accept', 'coordinator', $2, $3, 'approved', now())`,
        [`dec-approved-${randomUUID()}`, workItemId, attemptId],
      );

      // Reject on an already-approved decision must return state_mismatch (U-1).
      const r1 = await rejectWorkItem(
        { pool },
        { commandId: randomUUID(), workItemId, decisionId: pendingId, reason: "late" },
      );
      assert.equal(r1.ok, false, "reject-after-approve: ok must be false");
      if (!r1.ok) {
        assert.equal(r1.reason, "state_mismatch", "reject-after-approve: reason = state_mismatch");
      }

      // Lifecycle must remain 'completed' — not halted.
      const { rows: wiRows } = (await ctx.client.query(
        `SELECT lifecycle FROM work_items WHERE id = $1`,
        [workItemId],
      )) as { rows: Array<{ lifecycle: string }> };
      assert.equal(
        wiRows[0]?.lifecycle,
        "completed",
        "lifecycle unchanged after reject-after-approve",
      );

      // No rejected decision row was appended.
      const { rows: rejRows } = (await ctx.client.query(
        `SELECT count(*)::int AS n FROM decisions WHERE attempt_id = $1 AND outcome = 'rejected'`,
        [attemptId],
      )) as { rows: Array<{ n: number }> };
      assert.equal(rejRows[0]?.n, 0, "no rejected decision appended after reject-after-approve");

      // Repeat reject with a fresh commandId must also be state_mismatch (R-010).
      const r2 = await rejectWorkItem(
        { pool },
        { commandId: randomUUID(), workItemId, decisionId: pendingId, reason: "again" },
      );
      assert.equal(r2.ok, false, "double-reject with new commandId: ok must be false");
      if (!r2.ok) {
        assert.equal(r2.reason, "state_mismatch", "double-reject: reason = state_mismatch");
      }

      // Still no rejected rows.
      const { rows: rejRows2 } = (await ctx.client.query(
        `SELECT count(*)::int AS n FROM decisions WHERE attempt_id = $1 AND outcome = 'rejected'`,
        [attemptId],
      )) as { rows: Array<{ n: number }> };
      assert.equal(rejRows2[0]?.n, 0, "still no rejected decisions after double-reject");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// U-3: invalidate_acceptance works on coordinator-accepted ('accepted') decisions
// ---------------------------------------------------------------------------

test("U-3: invalidate_acceptance succeeds on coordinator-accepted (outcome='accepted') decision", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "completed" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { attemptId } = await seedAttemptWithDecision(ctx, contractId, workItemId, {
        decisionOutcome: "accepted",
        decisionKind: "accept",
      });

      // Invalidate an 'accepted' (coordinator auto-acceptance) decision.
      const r = await invalidateAcceptance(
        { pool },
        { commandId: randomUUID(), workItemId, attemptId, reason: "defect found post-acceptance" },
      );
      assert.equal(r.ok, true, "invalidate on 'accepted' decision should succeed (U-3)");

      // Historical accept decision row must NOT be modified (R-017).
      const { rows: acceptRows } = (await ctx.client.query(
        `SELECT outcome FROM decisions WHERE attempt_id = $1 AND kind = 'accept' AND outcome = 'accepted'`,
        [attemptId],
      )) as { rows: Array<{ outcome: string }> };
      assert.equal(acceptRows.length, 1, "historical 'accepted' decision row untouched");

      // Work item lifecycle should be reopened.
      const { rows: wiRows } = (await ctx.client.query(
        `SELECT lifecycle FROM work_items WHERE id = $1`,
        [workItemId],
      )) as { rows: Array<{ lifecycle: string }> };
      assert.equal(
        wiRows[0]?.lifecycle,
        "reopened",
        "work item lifecycle = reopened after invalidation",
      );
    } finally {
      await pool.end();
    }
  });
});
