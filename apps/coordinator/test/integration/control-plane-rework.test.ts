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
import { HOST_TRIAL_AUTHORITY, TASK_IDS } from "@agencyhq/contracts";
import type { TestDbContext } from "@agencyhq/db";
import { createPool } from "@agencyhq/db";
import pg from "pg";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import type { FlowLike, ReconcilerLike, RuntimeLike } from "../../src/app.ts";
import { createApp } from "../../src/app.ts";
import type { ApproveDeps } from "../../src/commands/approve.ts";
import { approveWorkItem } from "../../src/commands/approve.ts";
import {
  assignCampaign,
  createCampaign,
  invalidateAcceptance,
  rejectWorkItem,
  setMainEffort,
  updateAuthority,
} from "../../src/commands/index.ts";
import type { CoordinatorConfig } from "../../src/config.ts";
import { buildDecisionsView } from "../../src/views/decisions-view.ts";
import { withControlPlaneSchema } from "../helpers/control-plane-schema.ts";

// ---------------------------------------------------------------------------
// Helpers (duplicated locally to keep tests self-contained)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const NOW_ISO = new Date().toISOString();

function makeFakeFlow(): FlowLike {
  return { plan: async () => ({ ok: true }) };
}

function makeFakeReconciler(): ReconcilerLike {
  return { freshness: () => ({ lastPollAt: NOW_ISO, stale: false }) };
}

function makeFakeRuntime(): RuntimeLike {
  return { createPublicToken: async () => "fake-token" };
}

function makeAppConfig(): CoordinatorConfig {
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

test("T-4: approveWorkItem with mismatched revision writes approval_mismatch; pending stays open in decisions view", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    // Use createPool with search_path in URL options so pool.query() (used by
    // bounded-repair.ts / evaluateAcceptanceForAttempt) sees the isolated schema.
    // makeSchemaPool only overrides pool.connect(), missing direct pool.query() calls.
    const poolUrl = new URL(process.env.DATABASE_URL ?? "");
    poolUrl.searchParams.set("options", `-c search_path=${ctx.schema},public`);
    const pool = createPool(poolUrl.toString());
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
      const contractId = await seedContract(ctx, workItemId, projectId);
      const { attemptId, decisionId: pendingId } = await seedAttemptWithDecision(
        ctx,
        contractId,
        workItemId,
        { decisionOutcome: "pending_human" },
      );

      // Seed artifact for the attempt (needed by evaluateAcceptanceForAttempt).
      const artifactRevision = "abc123-known-revision-000000000000000000000";
      await ctx.client.query(
        `INSERT INTO artifacts (id, attempt_id, revision, diff_digest, changed_paths)
         VALUES ($1, $2, $3, 'dd-test', '[]'::jsonb)`,
        [`art-${randomUUID()}`, attemptId, artifactRevision],
      );

      // Seed dispatch_intents and run_observations so approveWorkItem can load
      // the AcceptanceProposal from the lead.accept run (approve.ts step 3).
      const runId = `run-accept-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO dispatch_intents (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, 'pd-test', $3, 'completed', $4, $5)`,
        [
          `di-${randomUUID()}`,
          TASK_IDS.leadAccept,
          attemptId,
          runId,
          `accept-ikey-${randomUUID()}`,
        ],
      );
      const acceptanceProposal = {
        accept: true,
        criteria: [],
        findingDispositions: [],
        rationale: "T-4 rework test — mismatched revision triggers APPROVAL_VERSION_MISMATCH",
      };
      await ctx.client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload)
         VALUES ($1, 1, false, $2::jsonb)`,
        [runId, JSON.stringify({ output: acceptanceProposal })],
      );

      // Call approveWorkItem with a WRONG attemptRevision (not hand-inserting the row — T-4).
      const WRONG_REVISION = "0000000000000000000000000000000000000000";
      const approveDeps: ApproveDeps = {
        pool,
        runtime: new FakeExecutionRuntime(),
        clock: { now: () => new Date().toISOString() },
      };
      const result = await approveWorkItem(approveDeps, {
        commandId: `cmd-t4-${randomUUID()}`,
        workItemId,
        contractId,
        contractVersion: 1,
        attemptRevision: WRONG_REVISION,
        actor: "test-human",
      });

      assert.equal(result.ok, false, "approveWorkItem with wrong revision must not be ok");
      if (!result.ok) {
        assert.equal(
          result.reason,
          "APPROVAL_VERSION_MISMATCH",
          "reason = APPROVAL_VERSION_MISMATCH",
        );
      }

      // Build decisions view from actual DB decisions — the pending must still appear as open.
      // U-13: openPendingDecisions must not close the pending due to approval_mismatch.
      const { rows: dbDecisions } = (await ctx.client.query(
        `SELECT id, work_item_id, kind, outcome, at, attempt_id, contract_version
         FROM decisions WHERE work_item_id = $1 ORDER BY at`,
        [workItemId],
      )) as {
        rows: Array<{
          id: string;
          work_item_id: string;
          kind: string;
          outcome: string;
          at: Date;
          attempt_id: string | null;
          contract_version: number | null;
        }>;
      };

      const decisionsView = buildDecisionsView({
        decisions: dbDecisions.map((d) => ({
          id: d.id,
          workItemId: d.work_item_id,
          kind: d.kind,
          outcome: d.outcome,
          at: d.at.toISOString(),
          attemptId: d.attempt_id,
          contractVersion: d.contract_version,
        })),
        attempts: [],
        contracts: [],
        findings: [],
      });

      // The decisions view must list the pending as open (approval_mismatch is not resolving).
      assert.equal(
        decisionsView.decisions.length,
        1,
        "decisions view: pending still open (not resolved by approval_mismatch)",
      );
      assert.equal(decisionsView.decisions[0]?.id, pendingId, "open pending id matches");

      // The approval_mismatch decision must now exist in the DB (written by approveWorkItem, not hand-inserted).
      const { rows: mismatchRows } = (await ctx.client.query(
        `SELECT outcome FROM decisions WHERE work_item_id = $1 AND outcome = 'approval_mismatch'`,
        [workItemId],
      )) as { rows: Array<{ outcome: string }> };
      assert.equal(
        mismatchRows.length,
        1,
        "approval_mismatch decision written to DB by approveWorkItem (T-4)",
      );
    } finally {
      await pool.end();
    }
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

// ---------------------------------------------------------------------------
// V-2: no-attempt pending time bound — second plan pending stays open after
// first was rejected (reject.ts NOT EXISTS guard: AND d2.at >= d.at).
// ---------------------------------------------------------------------------

test("V-2: second no-attempt pending is open after first rejected; re-reject of first returns state_mismatch", async (t) => {
  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(process.env.DATABASE_URL ?? "", ctx.schema);
    try {
      const projectId = await seedProject(ctx);
      const workItemId = await seedWorkItem(ctx, projectId, { lifecycle: "active" });

      // Insert pending_1: attempt-less plan decision at T0 (older timestamp).
      const pending1Id = `dec-v2-p1-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'plan', 'coordinator', $2, NULL, 'pending_human', now() - interval '10 seconds')`,
        [pending1Id, workItemId],
      );

      // Reject pending_1 — the command writes rejected_1 at approximately now() (T1 > T0).
      const r1 = await rejectWorkItem(
        { pool },
        {
          commandId: `cmd-v2-r1-${randomUUID()}`,
          workItemId,
          decisionId: pending1Id,
          reason: "first plan rejected",
        },
      );
      assert.equal(r1.ok, true, "reject of first pending must succeed");

      // Insert pending_2: attempt-less plan decision at the DB clock's current time.
      // The reject command above stamped rejected_1 slightly before this insert,
      // so the DB's now() here is >= rejected_1.at — pending_2 sorts after rejected_1,
      // which is what the time-bound guard (AND d2.at >= d.at) checks.
      // Using a real timestamp (no future-dating) models the realistic "plan again"
      // sequence without relying on clock skew.
      const pending2Id = `dec-v2-p2-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'plan', 'coordinator', $2, NULL, 'pending_human', now())`,
        [pending2Id, workItemId],
      );

      // Build the decisions view from the actual DB rows — pending_2 must appear as open.
      const { rows: dbDecisions } = (await ctx.client.query(
        `SELECT id, work_item_id, kind, outcome, at, attempt_id, contract_version
         FROM decisions WHERE work_item_id = $1 ORDER BY at`,
        [workItemId],
      )) as {
        rows: Array<{
          id: string;
          work_item_id: string;
          kind: string;
          outcome: string;
          at: Date;
          attempt_id: string | null;
          contract_version: number | null;
        }>;
      };

      const decisionsView = buildDecisionsView({
        decisions: dbDecisions.map((d) => ({
          id: d.id,
          workItemId: d.work_item_id,
          kind: d.kind,
          outcome: d.outcome,
          at: d.at.toISOString(),
          attemptId: d.attempt_id,
          contractVersion: d.contract_version,
        })),
        attempts: [],
        contracts: [],
        findings: [],
      });

      assert.equal(
        decisionsView.decisions.length,
        1,
        "decisions view: second pending open after first rejected (V-2)",
      );
      assert.equal(
        decisionsView.decisions[0]?.id,
        pending2Id,
        "open decision is the second pending (V-2)",
      );

      // Reject pending_2 — must succeed because rejected_1.at < pending_2.at (V-2 fix).
      const r2 = await rejectWorkItem(
        { pool },
        {
          commandId: `cmd-v2-r2-${randomUUID()}`,
          workItemId,
          decisionId: pending2Id,
          reason: "second plan rejected",
        },
      );
      assert.equal(
        r2.ok,
        true,
        "reject of second pending must succeed (V-2: time bound lets it through)",
      );

      // Re-reject pending_1 with a new commandId — must return state_mismatch because
      // rejected_1.at >= pending_1.at (the original resolution stands).
      const r3 = await rejectWorkItem(
        { pool },
        {
          commandId: `cmd-v2-r3-${randomUUID()}`,
          workItemId,
          decisionId: pending1Id,
          reason: "late reject attempt",
        },
      );
      assert.equal(
        r3.ok,
        false,
        "re-reject of first (already resolved) pending must return state_mismatch (V-2)",
      );
      if (!r3.ok) {
        assert.equal(
          r3.reason,
          "state_mismatch",
          "reason = state_mismatch for already-rejected pending (V-2)",
        );
      }
    } finally {
      await pool.end();
    }
  });
});

// Minimal valid ContractBounds JSON for the U-11 test.
// The HTTP decisions endpoint parses bounds via ContractBoundsSchema; empty '{}' fails.
const U11_VALID_BOUNDS = JSON.stringify({
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
  boundary: "artifact",
  budget: { maxAttempts: 1, maxDurationSeconds: 60, estimatedSpendUsd: 0.5 },
  review: "none",
  changeClass: "editorial",
  models: { worker: "claude-sonnet-4", reviewer: "claude-sonnet-4" },
});

// ---------------------------------------------------------------------------
// U-11: GET /api/decisions — rationale batch-loaded from lead.plan observation
// ---------------------------------------------------------------------------

test("U-11: GET /api/decisions returns rationale for decision with lead.plan observation; null for decision without one", async (t) => {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL unset; skipping integration test");
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withControlPlaneSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL, ctx.schema);
    try {
      const projectId = await seedProject(ctx);

      // Helper: seed a contract with valid bounds so the HTTP endpoint can parse it.
      async function seedContractWithBounds(workItemId: string): Promise<string> {
        const contractId = `sc-u11-${randomUUID()}`;
        await ctx.client.query(
          `INSERT INTO step_contracts
             (id, work_item_id, project_id, version, base_revision, inputs, criteria,
              criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
              human_required, status)
           VALUES ($1, $2, $3, 1, 'abc123', '{}', '[]', 'cdigest', 'profile1', 'pdigest',
                   $4::jsonb, '[]', false, 'active')`,
          [contractId, workItemId, projectId, U11_VALID_BOUNDS],
        );
        return contractId;
      }

      // --- Decision WITH rationale ---
      const workItemId1 = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
      const contractId1 = await seedContractWithBounds(workItemId1);

      const attemptId1 = `att-u11a-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
         VALUES ($1, $2, 1, 1, 'running', 0)`,
        [attemptId1, contractId1],
      );

      // Insert the plan decision (pending_human) linked to the attempt.
      const decisionId1 = `dec-u11a-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'plan', 'coordinator', $2, $3, 'pending_human', now())`,
        [decisionId1, workItemId1, attemptId1],
      );

      // Seed a dispatch_intent for lead.plan so the batch query finds it.
      const runId1 = `run-u11a-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, 'pd-u11a', $3, 'completed', $4, $5)`,
        [
          `di-u11a-${randomUUID()}`,
          TASK_IDS.leadPlan,
          attemptId1,
          runId1,
          `ikey-u11a-${randomUUID()}`,
        ],
      );

      // Seed a run_observation whose payload contains a valid LeadPlanOutput.
      const EXPECTED_RATIONALE = "U-11 test rationale: the plan is sound";
      const planPayload = {
        output: {
          kind: "proposal",
          proposal: {
            criteria: [{ id: "c1", text: "The change is correct", source: "operator" }],
            profileId: "default",
            changeClass: "editorial",
            review: "none",
            boundary: "artifact",
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
            budget: { maxAttempts: 1, maxDurationSeconds: 60, estimatedSpendUsd: 0.5 },
            models: { worker: "claude-sonnet-4", reviewer: "claude-sonnet-4" },
            rationale: EXPECTED_RATIONALE,
            sources: [{ criterionId: "c1", source: "operator", citation: "PRD §1" }],
          },
        },
      };
      await ctx.client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload)
         VALUES ($1, 1, false, $2::jsonb)`,
        [runId1, JSON.stringify(planPayload)],
      );

      // --- Decision WITHOUT rationale (no dispatch_intent / observation) ---
      const workItemId2 = await seedWorkItem(ctx, projectId, { lifecycle: "active" });
      const contractId2 = await seedContractWithBounds(workItemId2);

      const attemptId2 = `att-u11b-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
         VALUES ($1, $2, 1, 1, 'running', 0)`,
        [attemptId2, contractId2],
      );

      const decisionId2 = `dec-u11b-${randomUUID()}`;
      await ctx.client.query(
        `INSERT INTO decisions (id, kind, actor, work_item_id, attempt_id, outcome, at)
         VALUES ($1, 'plan', 'coordinator', $2, $3, 'pending_human', now())`,
        [decisionId2, workItemId2, attemptId2],
      );

      // Hit the actual HTTP endpoint (no API token configured → no auth required).
      const app = createApp({
        pool,
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeAppConfig(),
        clock: () => NOW_ISO,
      });

      const res = await app.request("/api/decisions");
      assert.equal(res.status, 200, "GET /api/decisions should return 200");

      const body = (await res.json()) as {
        decisions: Array<{ id: string; recommendation: string | null }>;
      };
      assert.ok(Array.isArray(body.decisions), "response body should have decisions array");

      const entry1 = body.decisions.find((d) => d.id === decisionId1);
      assert.ok(entry1, "decision with rationale should appear in response");
      assert.equal(
        entry1?.recommendation,
        EXPECTED_RATIONALE,
        "U-11: rationale from lead.plan observation should be the recommendation",
      );

      const entry2 = body.decisions.find((d) => d.id === decisionId2);
      assert.ok(entry2, "decision without observation should appear in response");
      assert.equal(
        entry2?.recommendation,
        null,
        "U-11: decision without lead.plan observation should have null recommendation",
      );
    } finally {
      await pool.end();
    }
  });
});
