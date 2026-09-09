/**
 * Integration tests: Slice 6 capacity and scheduling features (R-008, R-010).
 *
 * (a) Worker slots: two items, slots=2 → both dispatched; slots=1 → second queued,
 *     dispatched after scheduler pass once first completes.
 * (b) Same project, two items → second gets repository_busy skip_reason.
 * (c) Provider capacity: limited caps concurrency; down → provider_down;
 *     stale validUntil → treated as unknown (concurrency=1).
 * (d) Queued→triggered path: R-002 preserved (intent exists before trigger);
 *     idempotent (second scheduler pass triggers nothing new).
 * (e) Wake-up: fake subscribe emits two observations for the same run; pollOnce
 *     runs once per wake-up; observation applied exactly once through
 *     applyObservation (exactly one run_observations row); no duplicate row on
 *     a third explicit pollOnce (R-010).
 * (f) API tests: GET /api/metrics/lead, GET /api/capacity, set_capacity replay.
 * (h) skip_reason cleared on dispatch: intent skipped repository_busy on pass 1, dispatched on
 *     pass 2 → skip_reason IS NULL and status='triggered' (R-010).
 * (g) Halted/completed items do not hold the repository — their dispatched attempt
 *     is excluded from activeAttempts so the project does not appear in busyRepos.
 *
 * Admission gate tests (F2 rework — all gates apply at admission via scheduleOnce):
 * (admission-a) provider down, slots=2, nothing running → admitted intent stays queued
 *               with skip_reason=provider_down (no raw-COUNT bypass).
 * (admission-b) slots=2, one worker EXECUTING on project A → second item on project A
 *               is queued with repository_busy after admission.
 * (admission-c) slots=2, nothing running, capacity table empty → admission dispatches
 *               immediately through scheduleOnce (intent triggered, run_id set).
 * (admission-d) replaying the same plan observation does not create a second intent.
 * (admission-N1) own worker trigger fails at admission (lost-response) → failure row,
 *               item pending_human, lead.plan intent failed, own worker intent `failed`,
 *               and a subsequent scheduleOnce() does NOT dispatch the parked intent.
 * (admission-N2) a different queued item B's dispatch fails during C's admission → C's
 *               worker is triggered normally, C not parked (no failure row, no pending_human),
 *               B stays queued and is dispatched on the next scheduleOnce() when the fake
 *               stops failing.
 *
 * Active-attempt definition fix (S6-fix-active-attempts):
 * (i) Dispatched attempt with no triggered worker.attempt intent (only lead.review/accept,
 *     or no open intent at all) does not occupy a slot or make the project busy: a queued
 *     item on a different project is dispatched (not no_slot), and a queued item on the
 *     same project is dispatched on the next pass (not repository_busy).
 * (ii) Dispatched attempt WITH a triggered worker.attempt intent still blocks (no_slot /
 *     repository_busy) — covered by existing tests (b) and slot-regression.
 * (iii) Stopping attempt counts as active regardless of whether it has an open intent.
 *
 * Wake-up subscription refresh tests (Design 3):
 * (wakeup-tags) wakeupTags() returns tags for non-terminal work items and open intents.
 * (wakeup-a) Startup with no open work → no subscribe; after pollOnce with open work → subscribed.
 * (wakeup-b) Tag set grows → old subscription aborted, new subscription covers both projects.
 * (wakeup-c) subscribe() rejection is logged; poller keeps polling and retries on next pollOnce.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { digestOf, TASK_IDS } from "@agencyhq/contracts";
import { createPool, withTestSchema } from "@agencyhq/db";
import type { ExecutionRuntime } from "@agencyhq/domain";
import { newId } from "@agencyhq/domain";
import pg from "pg";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import type { FlowLike, ReconcilerLike, RuntimeLike } from "../../src/app.ts";
import { createApp } from "../../src/app.ts";
import type { CoordinatorConfig } from "../../src/config.ts";
import { BoundedRepairFlow } from "../../src/flow/bounded-repair.ts";
import { Reconciler, wakeupTags } from "../../src/flow/observe.ts";
import type { FlowDeps } from "../../src/flow/types.ts";
import { goodPlanOutput, workerCompletedOutput } from "../helpers/fake-lead.ts";
import { seedProjectAndWorkItem } from "../helpers/seed.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const FAKE_PROFILE_DIGEST = String(digestOf({ id: "default", version: "1.0.0" }));
const FAKE_PROFILE_RESOLVER = async (_profileId: string) => ({
  digest: FAKE_PROFILE_DIGEST,
  checks: [{ id: "pnpm-test", version: "1.0.0", command: ["pnpm", "test"], timeoutSeconds: 60 }],
  protectedPaths: ["package.json", "pnpm-lock.yaml"],
});

const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };
const clock = { now: () => new Date().toISOString() };

function makeFlowDeps(
  pool: ReturnType<typeof createPool>,
  fake: FakeExecutionRuntime,
  overrides?: { workerSlots?: number },
): FlowDeps {
  return {
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
      ...(overrides?.workerSlots !== undefined ? { workerSlots: overrides.workerSlots } : {}),
    },
    profileResolver: FAKE_PROFILE_RESOLVER,
  };
}

/** Script lead.plan to return a good proposal, advance to COMPLETED. */
function scriptLeadPlan(fake: FakeExecutionRuntime): void {
  fake.script(TASK_IDS.leadPlan, () => ({ status: "COMPLETED", output: goodPlanOutput() }));
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

function makeConfig(): CoordinatorConfig {
  return {
    databaseUrl: DATABASE_URL ?? "",
    triggerApiUrl: "https://trigger.example.com",
    triggerSecretKey: "secret",
    runtime: "fake",
    worktreeBase: "/tmp/worktrees",
    workerModel: "openai/gpt-5.6-terra",
    leadModel: "openai/gpt-5.6-sol",
    reviewerModel: "openai/gpt-5.6-sol",
    reconcileIntervalMs: 5000,
    freshnessStaleMs: 30000,
    uncertainAfterMs: 120000,
    port: 8787,
    bindHost: "127.0.0.1",
  };
}

function makeFakeFlow(): FlowLike {
  return { plan: async () => ({ ok: true }) };
}

function makeFakeReconciler(): ReconcilerLike {
  return { freshness: () => ({ lastPollAt: new Date().toISOString(), stale: false }) };
}

function makeFakeRuntime(): RuntimeLike {
  return { createPublicToken: async () => "fake-token" };
}

/** Minimal CommandsLike stub for tests that need set_capacity (in the commands block). */
function makeFakeCommands(): import("../../src/app.ts").CommandsLike {
  const noop = async () => ({ ok: true });
  return {
    stop: noop,
    pause: noop,
    resume: noop,
    createWorkItem: noop,
    disposition: noop,
    ackVisit: noop,
    approve: noop,
    lastAckAt: async () => null,
    reject: noop,
    invalidateAcceptance: noop,
    createCampaign: noop,
    assignCampaign: noop,
    setMainEffort: noop,
    setWorkItemRank: noop,
    updateAuthority: noop,
  };
}

// ---------------------------------------------------------------------------
// (a) Worker slots: two items on two projects, slots=2 → both dispatched;
//     slots=1 → second queued with skip_reason no_slot, dispatched after
//     first completes and scheduler runs.
// ---------------------------------------------------------------------------

test("scheduling(a): slots=2 dispatches both work items immediately", async (t) => {
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
      const { workItemId: wi1 } = await seedProjectAndWorkItem(client);
      const { workItemId: wi2 } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Script worker to stay EXECUTING (so slots stay occupied for second item admission)
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });
      // Plan and admit both items; with 2 slots both should dispatch immediately.
      const planCmd1 = newId("cmd");
      const { intentId: planIntent1, runId: planRun1 } = await flow.plan(wi1, planCmd1);
      fake.advance(planRun1);
      fake.advance(planRun1);
      await flow.onLeadPlanOutput(planIntent1, goodPlanOutput(), newId("cmd"));

      const planCmd2 = newId("cmd");
      const { intentId: planIntent2, runId: planRun2 } = await flow.plan(wi2, planCmd2);
      fake.advance(planRun2);
      fake.advance(planRun2);
      await flow.onLeadPlanOutput(planIntent2, goodPlanOutput(), newId("cmd"));

      // Both worker intents should be triggered (not queued).
      const { rows } = await client.query(
        `SELECT status FROM dispatch_intents WHERE task = $1 ORDER BY created_at`,
        [TASK_IDS.workerAttempt],
      );
      const statuses = (rows as { status: string }[]).map((r) => r.status);
      assert.equal(statuses.length, 2, "two worker intents created");
      assert.ok(
        statuses.every((s) => s === "triggered"),
        `both should be triggered, got: ${statuses.join(",")}`,
      );
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(a): slots=1 → second item queued with skip_reason=no_slot, dispatched by scheduler after first completes", async (t) => {
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
      const { workItemId: wi1 } = await seedProjectAndWorkItem(client);
      const { workItemId: wi2 } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // First worker completes; second stays queued initially.
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return {
          status: "COMPLETED",
          output: workerCompletedOutput(p.attemptId, {
            commitId: "deadbeef1234567890deadbeef1234567890dead",
          }),
        };
      });

      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });
      // Admit wi1 — should dispatch immediately (slot free).
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Admit wi2 — slot occupied; should be queued.
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Verify wi2's worker intent is queued.
      const { rows: allIntents } = await client.query(
        `SELECT di.status, di.skip_reason, sc.work_item_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1
         ORDER BY di.created_at`,
        [TASK_IDS.workerAttempt],
      );
      const workerIntents = allIntents as {
        status: string;
        skip_reason: string | null;
        work_item_id: string;
      }[];
      assert.equal(workerIntents.length, 2, "two worker intents");
      assert.equal(workerIntents[0]!.status, "triggered", "first worker triggered");
      assert.equal(workerIntents[1]!.status, "queued", "second worker queued");

      // Advance first worker to COMPLETED, then poll — reconciler closes wi1's
      // attempt and scheduleOnce should dispatch wi2.
      const { rows: runRows } = await client.query(
        `SELECT di.run_id FROM dispatch_intents di WHERE di.task = $1 AND di.status = 'triggered'`,
        [TASK_IDS.workerAttempt],
      );
      const firstRunId = (runRows as { run_id: string }[])[0]!.run_id;
      fake.advance(firstRunId); // QUEUED→EXECUTING
      fake.advance(firstRunId); // EXECUTING→COMPLETED

      // Poll 1: reconciler processes first worker completion (scheduleOnce runs
      // before observation routing, so wi1's attempt is still active when the
      // scheduler runs — wi2 gets no_slot; observation then closes wi1's attempt).
      await reconciler.pollOnce();

      // Poll 2: now wi1's attempt is closed; scheduleOnce sees no active
      // attempts and dispatches wi2.
      await reconciler.pollOnce();

      // After poll 2, wi2 should be dispatched.
      const { rows: afterIntents } = await client.query(
        `SELECT di.status, sc.work_item_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1
         ORDER BY di.created_at`,
        [TASK_IDS.workerAttempt],
      );
      const after = afterIntents as { status: string; work_item_id: string }[];
      const secondIntent = after[1];
      assert.ok(
        secondIntent?.status === "triggered" || secondIntent?.status === "observed",
        `second worker intent should be triggered or observed after scheduler pass, got: ${secondIntent?.status}`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Same project, two items → serialized (repository_busy)
// ---------------------------------------------------------------------------

test("scheduling(b): two items on same project → second gets repository_busy skip_reason", async (t) => {
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
      // Seed two work items on the SAME project.
      const { workItemId: wi1, projectId } = await seedProjectAndWorkItem(client);
      const wi2 = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 2, 'Fix another issue', NULL, 'artifact', 'proposed', 'healthy', false, 1)`,
        [wi2, projectId],
      );

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Workers stay executing so slots stay occupied.
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // Use slots=1: wi1 occupies the single slot, wi2 is queued.
      // scheduleQueuedIntents sees wi1's project as busyRepos → repository_busy for wi2.
      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });

      // Admit wi1 — dispatched immediately (slot free).
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Admit wi2 (same project) — slot occupied → queued.
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Verify wi2 is queued before calling scheduleOnce.
      const { rows: preRows } = await client.query(
        `SELECT di.status FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      assert.equal(
        (preRows as { status: string }[])[0]?.status,
        "queued",
        "wi2 queued before scheduler",
      );

      // Run scheduler: wi1's project is in busyRepos → repository_busy for wi2.
      await reconciler.scheduleOnce();

      const { rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const second = (rows as { status: string; skip_reason: string | null }[])[0]!;
      assert.equal(second.status, "queued", "second worker stays queued (repo busy)");
      assert.equal(second.skip_reason, "repository_busy", "skip_reason is repository_busy");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (g) Halted work item does not block repository — dispatched attempt excluded
// ---------------------------------------------------------------------------

test("scheduling(g): halted work item does not hold the repository — second item on same project is dispatched", async (t) => {
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
      // Seed two work items on the SAME project.
      const { workItemId: wi1, projectId } = await seedProjectAndWorkItem(client);
      const wi2 = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 2, 'Fix another issue', NULL, 'artifact', 'proposed', 'healthy', false, 1)`,
        [wi2, projectId],
      );

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Workers stay executing so wi1's attempt stays dispatched.
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });

      // Admit wi1 — dispatched immediately (slot free).
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Halt wi1: simulates the Lead-failure → pending_human → reject path.
      // The attempt is left in status='dispatched' (bounded-repair sets it there
      // on verify/review/accept runs and reject never updates it).
      await client.query(
        "UPDATE work_items SET lifecycle = 'halted', version = version + 1, updated_at = now() WHERE id = $1",
        [wi1],
      );

      // Admit wi2 (same project). wi1 is halted, so listActiveAttemptsForScheduling
      // excludes wi1's attempt → slot free → scheduleQueuedIntents dispatches wi2.
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // scheduleQueuedIntents already ran at admission; a second call is a no-op (wi2 triggered).
      await reconciler.scheduleOnce();

      const { rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const second = (rows as { status: string; skip_reason: string | null }[])[0]!;
      assert.equal(
        second.status,
        "triggered",
        `halted wi1 must not block repo — wi2 should be triggered, got: ${second.status} (skip_reason: ${second.skip_reason})`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Provider capacity: limited caps to 1; down → provider_down;
//     stale validUntil → unknown (concurrency=1)
// ---------------------------------------------------------------------------

test("scheduling(c): provider_down → queued item gets provider_down skip_reason", async (t) => {
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

      // Record provider_capacity with status='down' for openai (the worker model provider).
      const validUntil = new Date(Date.now() + 3600_000); // 1 hour from now
      await client.query(
        `INSERT INTO provider_capacity (provider, model, status, observed_at, valid_until, source)
         VALUES ($1, $2, 'down', now(), $3, 'operator')
         ON CONFLICT (provider, model, observed_at) DO UPDATE SET status = 'down', valid_until = $3`,
        ["openai", "gpt-5.6-terra", validUntil.toISOString()],
      );

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // Use slots=1: one slot occupied by wi2 (different project), so workItemId is queued.
      // provider_down wins before no_slot in selectDispatch ordering.
      const deps1 = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow1 = new BoundedRepairFlow(deps1);
      const reconciler1 = new Reconciler(deps1, flow1, { workerSlots: 1 });

      // Use a second project to hold a running slot so the test item is queued.
      const { workItemId: wi2 } = await seedProjectAndWorkItem(client);
      const { intentId: pi2, runId: pr2 } = await flow1.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow1.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Now admit the test item — slot=1 occupied + provider down → provider_down.
      const { intentId: pi1, runId: pr1 } = await flow1.plan(workItemId, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow1.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Confirm the test item is queued.
      const { rows: preRows } = await client.query(
        `SELECT di.status, sc.work_item_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      const preIntents = preRows as { status: string }[];
      assert.equal(preIntents[0]?.status, "queued", "test item queued before scheduler");

      // Run scheduleOnce: provider is down → skip with provider_down.
      // (The slot=1 is occupied by wi2's attempt which is dispatched.)
      await reconciler1.pollOnce();

      const { rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      const intent = (rows as { status: string; skip_reason: string | null }[])[0];
      // provider_down wins before no_slot in selectDispatch ordering.
      assert.equal(intent?.skip_reason, "provider_down", "skip_reason is provider_down");
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(c): stale provider capacity → treated as unknown (concurrency=1, gives provider_unknown)", async (t) => {
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
      // Two items on different projects, both using openai.
      // wi1 dispatched (1 active openai attempt); wi2 queued (no slot).
      // Stale capacity row: validUntil in the past → effectiveCapacity='unknown' → concurrencyFor=1.
      // scheduleOnce: wi2 not repository_busy, not already_active, but
      // activeByProvider['openai']=1 >= concurrencyFor(unknown)=1 → provider_unknown.
      const staleUntil = new Date(Date.now() - 3600_000); // 1 hour ago (stale)
      await client.query(
        `INSERT INTO provider_capacity (provider, model, status, observed_at, valid_until, source)
         VALUES ($1, $2, 'ok', now() - interval '2 hours', $3, 'operator')
         ON CONFLICT (provider, model, observed_at) DO UPDATE SET valid_until = $3`,
        ["openai", "gpt-5.6-terra", staleUntil.toISOString()],
      );

      const { workItemId: wi1 } = await seedProjectAndWorkItem(client);
      const { workItemId: wi2 } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // Use slots=1: wi1 dispatched (occupies slot), wi2 queued (no slot).
      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });

      // Admit wi1 → dispatched (1 openai attempt active).
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Admit wi2 → queued (no slot, attempt stays 'admitted').
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Verify wi2 is queued.
      const { rows: preRows } = await client.query(
        `SELECT di.status FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      assert.equal(
        (preRows as { status: string }[])[0]?.status,
        "queued",
        "wi2 queued before scheduler",
      );

      // scheduleOnce: stale openai → unknown → concurrencyFor=1.
      // activeByProvider['openai'] = 1 (wi1 is dispatched openai attempt).
      // currentCount = 1 >= 1 → provider_unknown.
      await reconciler.scheduleOnce();

      const { rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const intent = (rows as { status: string; skip_reason: string | null }[])[0];
      assert.equal(
        intent?.skip_reason,
        "provider_unknown",
        `stale capacity treated as unknown → provider_unknown, got: ${intent?.skip_reason}`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Queued→triggered path: R-002 (intent exists before trigger);
//     idempotent (second scheduler pass triggers nothing new).
// ---------------------------------------------------------------------------

test("scheduling(d): R-002 preserved — intent row exists before trigger; idempotent second pass", async (t) => {
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
      const { workItemId: wi1 } = await seedProjectAndWorkItem(client);
      const { workItemId: wi2 } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });

      // Admit wi1 → dispatched (slot occupied).
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Admit wi2 → queued (no slot).
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Verify wi2's intent exists in DB (R-002: committed before trigger).
      const { rows: preDispatch } = await client.query(
        `SELECT di.id, di.status
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const queued = (preDispatch as { id: string; status: string }[])[0];
      assert.ok(queued, "wi2 intent exists before trigger (R-002)");
      assert.equal(queued!.status, "queued", "wi2 intent is queued");
      const queuedIntentId = queued!.id;

      // Now advance wi1 to COMPLETED so the slot opens up.
      const { rows: wi1RunRows } = await client.query(
        `SELECT di.run_id FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi1],
      );
      const wi1RunId = (wi1RunRows as { run_id: string }[])[0]!.run_id;
      // Advance through EXECUTING steps to COMPLETED
      fake.advance(wi1RunId);

      // Mark wi1's attempt as completed in DB to free the slot for scheduleOnce.
      await client.query(
        `UPDATE attempts SET status = 'completed', updated_at = now()
         WHERE id IN (
           SELECT a.id FROM attempts a
           JOIN step_contracts sc ON sc.id = a.contract_id
           WHERE sc.work_item_id = $1
         )`,
        [wi1],
      );

      // First scheduler pass: should dispatch wi2.
      await reconciler.scheduleOnce();

      const { rows: afterFirst } = await client.query(
        "SELECT status, run_id FROM dispatch_intents WHERE id = $1",
        [queuedIntentId],
      );
      const afterFirstRow = (afterFirst as { status: string; run_id: string | null }[])[0];
      assert.equal(afterFirstRow?.status, "triggered", "wi2 dispatched after first scheduler pass");
      const triggeredRunId = afterFirstRow!.run_id;
      assert.ok(triggeredRunId, "run_id recorded after trigger");

      // Count trigger calls for wi2 before second pass.
      const triggerCallsBefore = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      ).length;

      // Second scheduler pass: wi2 is already triggered, so scheduleOnce should not
      // dispatch it again (listQueuedWorkerIntents only returns status='queued' rows).
      await reconciler.scheduleOnce();

      const triggerCallsAfter = fake.calls.filter(
        (c) =>
          c.method === "trigger" && (c.args[0] as { task: string }).task === TASK_IDS.workerAttempt,
      ).length;

      assert.equal(
        triggerCallsAfter,
        triggerCallsBefore,
        "second scheduler pass makes no new trigger calls (idempotent)",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Wake-up: fake subscribe emits two observations for the same run (one
//     EXECUTING wake-up, one COMPLETED wake-up); pollOnce runs once per
//     wake-up; observation applied through applyObservation exactly once
//     (exactly one run_observations row, not "0 or 1"); third explicit
//     pollOnce produces no second row (R-010).
// ---------------------------------------------------------------------------

test("scheduling(e): two wake-ups for same run → pollOnce once per wake-up; applyObservation dedup keeps exactly one run_observations row (R-010)", async (t) => {
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
      scriptLeadPlan(fake);
      // Script the worker with TWO steps: EXECUTING then COMPLETED.
      // advance #1 → EXECUTING (wake-up #1, not final, no observation row)
      // advance #2 → COMPLETED (wake-up #2, final, applyObservation creates one row)
      fake.script(TASK_IDS.workerAttempt, (payload: unknown) => {
        const p = payload as { attemptId: string };
        return [
          { status: "EXECUTING" },
          {
            status: "COMPLETED",
            output: workerCompletedOutput(p.attemptId, {
              commitId: "deadbeef1234567890deadbeef1234567890dead",
            }),
          },
        ];
      });

      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      // Enable realtimeWakeup; admission calls scheduleQueuedIntents directly which
      // dispatches the worker intent immediately (slot free, no gates block).
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1, realtimeWakeup: true });

      // Admit the work item — scheduleQueuedIntents fires and dispatches the worker
      // intent immediately (slot free, no gates block), setting run_id.
      const { intentId: pi, runId: pr } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(pr);
      fake.advance(pr);
      await flow.onLeadPlanOutput(pi, goodPlanOutput(), newId("cmd"));

      // Get the worker run id (set by scheduleOnce dispatch during admission).
      const { rows: diRows } = await client.query(
        `SELECT di.run_id FROM dispatch_intents di WHERE di.task = $1`,
        [TASK_IDS.workerAttempt],
      );
      const workerRunId = (diRows as { run_id: string }[])[0]!.run_id;
      assert.ok(
        workerRunId,
        "worker run id must be set (scheduleQueuedIntents dispatched at admission)",
      );

      // Start wake-up (subscribes to project tags of open intents).
      const wakeupPromise = reconciler.startWakeup();

      // Wait for subscribe to register.
      await waitFor(() => fake.calls.some((c) => c.method === "subscribe"), 2000);
      assert.equal(
        fake.calls.filter((c) => c.method === "subscribe").length,
        1,
        "subscribe called once after startWakeup",
      );

      // Baseline: count retrieve calls for the worker run before any advances.
      const retrievesBefore = fake.calls.filter(
        (c) => c.method === "retrieve" && (c.args as string[])[0] === workerRunId,
      ).length;

      // Wake-up #1: advance run → EXECUTING.
      // Subscriber fires → void this.pollOnce() called.
      // pollOnce #1 calls retrieve → EXECUTING (not final) → no run_observations row.
      fake.advance(workerRunId);

      // Wait until pollOnce #1 has called retrieve (it's in the observation-routing phase).
      await waitFor(
        () =>
          fake.calls.filter(
            (c) => c.method === "retrieve" && (c.args as string[])[0] === workerRunId,
          ).length > retrievesBefore,
        2000,
      );
      // Tiny extra wait for _polling to flip back to false before the next advance.
      await new Promise((r) => setTimeout(r, 20));

      // Wake-up #2: advance run → COMPLETED.
      // Subscriber fires → void this.pollOnce() called.
      // pollOnce #2 calls retrieve → COMPLETED (final) → applyObservation → 1 row.
      fake.advance(workerRunId);

      // Wait until pollOnce #2 has called retrieve.
      await waitFor(
        () =>
          fake.calls.filter(
            (c) => c.method === "retrieve" && (c.args as string[])[0] === workerRunId,
          ).length >
          retrievesBefore + 1,
        2000,
      );
      // Allow pollOnce #2 to complete its DB work (applyObservation + transition).
      await new Promise((r) => setTimeout(r, 100));

      // Stop wake-up.
      reconciler.stopWakeup();
      await wakeupPromise;

      // Assert: retrieve called exactly twice for this run — once per wake-up.
      const retrieveCount =
        fake.calls.filter((c) => c.method === "retrieve" && (c.args as string[])[0] === workerRunId)
          .length - retrievesBefore;
      assert.equal(
        retrieveCount,
        2,
        `retrieve called exactly once per wake-up (got ${retrieveCount})`,
      );

      // Assert: exactly one run_observations row — applyObservation applied once
      // (not "0 or 1" — the R-010 path must be taken, not bypassed).
      const { rows: obsRows } = await client.query(
        "SELECT count(*)::int AS n FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      const obsCount = (obsRows as { n: number }[])[0]!.n;
      assert.equal(obsCount, 1, `exactly one run_observations row, got ${obsCount}`);

      // Third explicit pollOnce: no second row (applyObservation dedup / intent closure).
      await reconciler.pollOnce();

      const { rows: obsRows2 } = await client.query(
        "SELECT count(*)::int AS n FROM run_observations WHERE run_id = $1",
        [workerRunId],
      );
      const obsCount2 = (obsRows2 as { n: number }[])[0]!.n;
      assert.equal(obsCount2, 1, `still exactly one row after third pollOnce, got ${obsCount2}`);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (f) API tests: GET /api/metrics/lead, GET /api/capacity, set_capacity replay.
// ---------------------------------------------------------------------------

test("scheduling(f): GET /api/metrics/lead returns array (empty when no rows)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL!, ctx.schema);
    try {
      const app = createApp({
        pool: pool as unknown as Parameters<typeof createApp>[0]["pool"],
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
      });

      const res = await app.fetch(new Request("http://localhost/api/metrics/lead"));
      assert.equal(res.status, 200, "GET /api/metrics/lead returns 200");
      const body = (await res.json()) as { since: string | null; projects: unknown[] };
      assert.ok("since" in body, "response carries since");
      assert.ok(Array.isArray(body.projects), "projects is an array");
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(f): GET /api/metrics/lead?since= with invalid param returns 400", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL!, ctx.schema);
    try {
      const app = createApp({
        pool: pool as unknown as Parameters<typeof createApp>[0]["pool"],
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
      });

      const res = await app.fetch(
        new Request("http://localhost/api/metrics/lead?since=not-a-date"),
      );
      assert.equal(res.status, 400, "invalid since param returns 400");
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(f): GET /api/capacity returns empty array when no capacity rows", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL!, ctx.schema);
    try {
      const app = createApp({
        pool: pool as unknown as Parameters<typeof createApp>[0]["pool"],
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
      });

      const res = await app.fetch(new Request("http://localhost/api/capacity"));
      assert.equal(res.status, 200, "GET /api/capacity returns 200");
      const body = (await res.json()) as { now: string; providers: unknown[] };
      assert.equal(typeof body.now, "string", "response carries now");
      assert.ok(Array.isArray(body.providers), "providers is an array");
      assert.equal(body.providers.length, 0, "no capacity rows initially");
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(f): POST /api/commands set_capacity inserts row and is idempotent", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL!, ctx.schema);
    try {
      const app = createApp({
        pool: pool as unknown as Parameters<typeof createApp>[0]["pool"],
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
        commands: makeFakeCommands(),
      });

      const commandId = newId("cmd");
      const validUntil = new Date(Date.now() + 3600_000).toISOString();
      const body = {
        commandId,
        kind: "set_capacity",
        provider: "openai",
        model: "gpt-5.6-terra",
        status: "limited",
        validUntil,
      };

      // First call — should insert.
      const res1 = await app.fetch(
        new Request("http://localhost/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      assert.equal(res1.status, 200, "first set_capacity call returns 200");
      const data1 = (await res1.json()) as {
        commandId: string;
        replayed: boolean;
        result: unknown;
      };
      assert.equal(data1.commandId, commandId, "commandId echoed");
      assert.equal(data1.replayed, false, "first call is not a replay");
      assert.ok(data1.result, "result present");

      // Verify GET /api/capacity returns the row.
      const capRes = await app.fetch(new Request("http://localhost/api/capacity"));
      assert.equal(capRes.status, 200);
      const { providers: capBody } = (await capRes.json()) as {
        providers: Array<{
          provider: string;
          model: string;
          status: string;
          effective: string;
          concurrency: number | null;
          source: string;
        }>;
      };
      assert.equal(capBody.length, 1, "one capacity row");
      const row = capBody[0]!;
      assert.equal(row.provider, "openai");
      assert.equal(row.model, "gpt-5.6-terra");
      assert.equal(row.status, "limited");
      assert.equal(row.source, "operator");
      assert.ok(row.effective !== undefined, "effective present");
      assert.ok(row.concurrency !== undefined, "concurrency present");

      // Second call with same commandId — should replay.
      const res2 = await app.fetch(
        new Request("http://localhost/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      assert.equal(res2.status, 200, "second set_capacity call returns 200");
      const data2 = (await res2.json()) as { commandId: string; replayed: boolean };
      assert.equal(data2.replayed, true, "second call is a replay");
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(f): GET /api/capacity returns correct effective and concurrency for limited", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async (ctx) => {
    const pool = makeSchemaPool(DATABASE_URL!, ctx.schema);
    try {
      const app = createApp({
        pool: pool as unknown as Parameters<typeof createApp>[0]["pool"],
        flow: makeFakeFlow(),
        reconciler: makeFakeReconciler(),
        runtime: makeFakeRuntime(),
        config: makeConfig(),
        commands: makeFakeCommands(),
      });

      // Insert a non-stale 'limited' row via set_capacity.
      const validUntil = new Date(Date.now() + 3600_000).toISOString();
      await app.fetch(
        new Request("http://localhost/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: newId("cmd"),
            kind: "set_capacity",
            provider: "anthropic",
            model: "claude-opus-4",
            status: "limited",
            validUntil,
          }),
        }),
      );

      const res = await app.fetch(new Request("http://localhost/api/capacity"));
      const { providers: rows } = (await res.json()) as {
        providers: Array<{
          effective: string;
          concurrency: number | null;
          status: string;
        }>;
      };
      const row = rows.find((r) => r.status === "limited");
      assert.ok(row, "limited row present");
      assert.equal(row!.effective, "limited", "effective=limited for non-stale limited row");
      assert.ok(
        row!.concurrency !== null && row!.concurrency > 0,
        "concurrency is positive number for limited",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (g) skip_reason cleared on dispatch (R-010)
// ---------------------------------------------------------------------------

test("scheduling(h): intent skipped repository_busy on pass 1, dispatched on pass 2 → skip_reason IS NULL and status='triggered'", async (t) => {
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
      // Two work items on the SAME project so wi2 gets repository_busy on pass 1.
      const { workItemId: wi1, projectId } = await seedProjectAndWorkItem(client);
      const wi2 = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 2, 'Fix another issue', NULL, 'artifact', 'proposed', 'healthy', false, 1)`,
        [wi2, projectId],
      );

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Workers stay executing so wi1 holds the slot and the project.
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // slots=1: wi1 occupies the slot; wi2 queued with repository_busy.
      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });

      // Admit wi1 → dispatched immediately.
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Admit wi2 (same project) → queued (no slot + repository_busy).
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Pass 1: scheduleOnce records repository_busy for wi2.
      await reconciler.scheduleOnce();

      // Verify wi2 has skip_reason=repository_busy and status=queued after pass 1.
      const { rows: pass1Rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const pass1 = (pass1Rows as { status: string; skip_reason: string | null }[])[0]!;
      assert.equal(pass1.status, "queued", "wi2 queued after pass 1");
      assert.equal(
        pass1.skip_reason,
        "repository_busy",
        "skip_reason=repository_busy after pass 1",
      );

      // Free the slot: mark wi1's attempt completed so wi2 can be dispatched.
      await client.query(
        `UPDATE attempts SET status = 'completed', updated_at = now()
         WHERE id IN (
           SELECT a.id FROM attempts a
           JOIN step_contracts sc ON sc.id = a.contract_id
           WHERE sc.work_item_id = $1
         )`,
        [wi1],
      );

      // Pass 2: scheduleOnce dispatches wi2.
      await reconciler.scheduleOnce();

      // After pass 2: skip_reason must be NULL and status must be 'triggered'.
      const { rows: pass2Rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const pass2 = (pass2Rows as { status: string; skip_reason: string | null }[])[0]!;
      assert.equal(pass2.status, "triggered", "wi2 dispatched on pass 2 (status=triggered)");
      assert.equal(pass2.skip_reason, null, "skip_reason cleared to NULL after dispatch (R-010)");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (wakeup-tags) wakeupTags() unit: returns correct project tags
/** Poll until `pred()` is true or `ms` elapsed (the wake-up subscription is
 * established asynchronously after startWakeup(): a DB query then subscribe()). */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

// ---------------------------------------------------------------------------

test("scheduling(wakeup-tags): wakeupTags returns tags for non-terminal work items and open intents", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const pool = makeSchemaPool(DATABASE_URL!, schema);

    try {
      const poolClient = await pool.connect();

      // No work → empty
      try {
        const tags0 = await wakeupTags(poolClient);
        assert.deepEqual(tags0, [], "no tags when no open work");
      } finally {
        poolClient.release();
      }

      // Proposed lifecycle → NOT included (never admitted)
      await seedProjectAndWorkItem(client, { lifecycle: "proposed" });
      const poolClient2 = await pool.connect();
      try {
        const tags1 = await wakeupTags(poolClient2);
        assert.deepEqual(tags1, [], "proposed lifecycle not included");
      } finally {
        poolClient2.release();
      }

      // Admitted lifecycle → included
      const { projectId } = await seedProjectAndWorkItem(client, { lifecycle: "admitted" });
      const poolClient3 = await pool.connect();
      try {
        const tags2 = await wakeupTags(poolClient3);
        assert.ok(tags2.includes(`project:${projectId}`), "admitted lifecycle included in tags");
      } finally {
        poolClient3.release();
      }
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (wakeup-a) Startup with no open work → no subscribe; pollOnce → subscribed
// ---------------------------------------------------------------------------

test("scheduling(wakeup-a): startWakeup with no open work does not subscribe; pollOnce after work item created subscribes", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1, realtimeWakeup: true });

      // Start wake-up with no open work — must not subscribe.
      const wakeupPromise = reconciler.startWakeup();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(
        fake.calls.filter((c) => c.method === "subscribe").length,
        0,
        "no subscribe when no open work at startup",
      );

      // Seed an admitted work item so wakeupTags() returns a non-empty set.
      const { projectId } = await seedProjectAndWorkItem(client, { lifecycle: "admitted" });

      // pollOnce → refresh at end → subscribe should be called.
      await reconciler.pollOnce();

      const subCalls = fake.calls.filter((c) => c.method === "subscribe");
      assert.equal(subCalls.length, 1, "subscribed after pollOnce detects open work");
      const args = subCalls[0]!.args[0] as { tags: string[] };
      assert.ok(
        args.tags.includes(`project:${projectId}`),
        "subscription covers the new project's tag",
      );

      reconciler.stopWakeup();
      await wakeupPromise;
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (wakeup-b) Tag set grows → old subscription aborted, new covers both projects
// ---------------------------------------------------------------------------

test("scheduling(wakeup-b): tag set change causes resubscription; old subscription aborted", async (t) => {
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
      const fake = new FakeExecutionRuntime();
      const deps = makeFlowDeps(pool, fake);
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1, realtimeWakeup: true });

      // Seed project A with an admitted work item.
      const { projectId: projectA } = await seedProjectAndWorkItem(client, {
        lifecycle: "admitted",
      });

      // Start wake-up → subscribes to project A (asynchronously: query, then subscribe).
      const wakeupPromise = reconciler.startWakeup();
      await waitFor(() => fake.calls.some((c) => c.method === "subscribe"));

      const subCallsInitial = fake.calls.filter((c) => c.method === "subscribe");
      assert.equal(subCallsInitial.length, 1, "initial subscription to project A");
      const firstArgs = subCallsInitial[0]!.args[0] as {
        tags: string[];
        signal: AbortSignal;
      };
      assert.ok(firstArgs.tags.includes(`project:${projectA}`), "initial sub covers project A");
      assert.ok(!firstArgs.signal.aborted, "first subscription initially active");

      // Add project B.
      const { projectId: projectB } = await seedProjectAndWorkItem(client, {
        lifecycle: "admitted",
      });

      // pollOnce → refresh detects added project → resubscribes.
      await reconciler.pollOnce();

      const subCallsAfter = fake.calls.filter((c) => c.method === "subscribe");
      assert.equal(subCallsAfter.length, 2, "resubscribed after project B admitted");
      assert.ok(firstArgs.signal.aborted, "first subscription was aborted on resubscription");
      const secondArgs = subCallsAfter[1]!.args[0] as { tags: string[]; signal: AbortSignal };
      assert.ok(secondArgs.tags.includes(`project:${projectA}`), "new sub covers project A");
      assert.ok(secondArgs.tags.includes(`project:${projectB}`), "new sub covers project B");

      reconciler.stopWakeup();
      await wakeupPromise;
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (wakeup-c) subscribe() rejection → logged; poller keeps polling, retried
// ---------------------------------------------------------------------------

test("scheduling(wakeup-c): subscribe rejection is logged and poller continues polling", async (t) => {
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
      const fake = new FakeExecutionRuntime();

      // Runtime whose subscribe() always rejects (simulates network failure).
      const subscribeAttempts: number[] = [];
      const rejectingRuntime: ExecutionRuntime = {
        trigger: (i) => fake.trigger(i),
        cancel: (r) => fake.cancel(r),
        retrieve: (r) => fake.retrieve(r),
        createPublicToken: (i) => fake.createPublicToken(i),
        subscribe: async (_input, _cb): Promise<void> => {
          subscribeAttempts.push(Date.now());
          throw new Error("subscribe network error");
        },
      };

      const deps: FlowDeps = {
        ...makeFlowDeps(pool, fake),
        runtime: rejectingRuntime,
      };
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1, realtimeWakeup: true });

      // Seed an admitted work item so subscribe() will be attempted.
      await seedProjectAndWorkItem(client, { lifecycle: "admitted" });

      // startWakeup: subscribe() will fail.
      const wakeupPromise = reconciler.startWakeup();
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(subscribeAttempts.length >= 1, "subscribe was attempted at startup");

      // pollOnce must succeed despite the subscribe failure.
      await reconciler.pollOnce();
      assert.ok(reconciler.healthy, "reconciler still healthy after subscribe rejection");

      // subscribe retried on pollOnce (since _subscribeError=true flags a retry).
      assert.ok(subscribeAttempts.length >= 2, "subscribe retried on next pollOnce refresh");

      reconciler.stopWakeup();
      await wakeupPromise;
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Slot-counting regression: active attempts must block scheduler dispatch
// ---------------------------------------------------------------------------

test("scheduling(slot-regression): slots=1, one attempt dispatched on project A → scheduleOnce records no_slot for project B", async (t) => {
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
      const { workItemId: wi1 } = await seedProjectAndWorkItem(client);
      const { workItemId: wi2 } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Workers stay EXECUTING — wi1's attempt remains dispatched/running.
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 1 });

      // Admit wi1 — slot free, dispatched immediately.
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Admit wi2 on a different project — slot occupied → scheduleOnce sees no_slot → queued.
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      // Verify wi2 is queued before calling scheduleOnce.
      const { rows: preRows } = await client.query(
        `SELECT di.status FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      assert.equal(
        (preRows as { status: string }[])[0]?.status,
        "queued",
        "wi2 queued before scheduler",
      );

      // Run the scheduler while wi1's attempt is still active.
      // With the fix, slotsUsed starts at 1 (activeAttempts.length) → no_slot for wi2.
      await reconciler.scheduleOnce();

      const { rows: afterRows } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const after = (afterRows as { status: string; skip_reason: string | null }[])[0]!;
      assert.equal(after.status, "queued", "wi2 must stay queued (slot taken by wi1)");
      assert.equal(after.skip_reason, "no_slot", "skip_reason must be no_slot");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (i) Dispatched attempt with no triggered worker.attempt intent does not block
// ---------------------------------------------------------------------------

test("scheduling(i): dispatched attempt with no triggered worker.attempt intent does not occupy slot or make repo busy", async (t) => {
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
      // Seed project A (wi1_A + wi_A2) and project B (wi_B).
      const { workItemId: wi1_A, projectId: projectA } = await seedProjectAndWorkItem(client);
      // wi_A2: second item on project A.
      const wi_A2 = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 2, 'Fix a second issue on project A', NULL, 'artifact', 'proposed', 'healthy', false, 1)`,
        [wi_A2, projectA],
      );
      // wi_B: item on a different project.
      const { workItemId: wi_B } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Workers stay EXECUTING — we control slot state via direct DB updates.
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // Use a large workerSlots count when admitting wi1_A so scheduleQueuedIntents
      // dispatches it immediately — we need attempt1 in 'dispatched' state.
      const depsAdmit = makeFlowDeps(pool, fake, { workerSlots: 99 });
      const flowAdmit = new BoundedRepairFlow(depsAdmit);

      // Admit wi1_A — creates attempt1 (dispatched) + triggered worker.attempt intent.
      const { intentId: pi1, runId: pr1 } = await flowAdmit.plan(wi1_A, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flowAdmit.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Simulate the scenario where the worker run already finished and bounded-repair
      // moved on to a review/accept run: mark wi1_A's worker.attempt intent as 'observed'.
      // Attempt1 now has status='dispatched' but NO triggered worker.attempt intent.
      await client.query(
        `UPDATE dispatch_intents
         SET status = 'observed', updated_at = now()
         WHERE task = $1
           AND attempt_id IN (
             SELECT a.id FROM attempts a
             JOIN step_contracts sc ON sc.id = a.contract_id
             WHERE sc.work_item_id = $2
           )`,
        [TASK_IDS.workerAttempt, wi1_A],
      );

      // Now admit wi_A2 and wi_B with slots=1. With attempt1's worker.attempt intent
      // marked 'observed', attempt1 is not active → slot free → wi_A2 dispatches at
      // admission. wi_B is then blocked by no_slot (wi_A2 occupies the single slot).
      const deps1 = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow1 = new BoundedRepairFlow(deps1);
      const reconciler = new Reconciler(deps1, flow1, { workerSlots: 1 });

      const { intentId: pi_A2, runId: pr_A2 } = await flow1.plan(wi_A2, newId("cmd"));
      fake.advance(pr_A2);
      fake.advance(pr_A2);
      await flow1.onLeadPlanOutput(pi_A2, goodPlanOutput(), newId("cmd"));

      const { intentId: pi_B, runId: pr_B } = await flow1.plan(wi_B, newId("cmd"));
      fake.advance(pr_B);
      fake.advance(pr_B);
      await flow1.onLeadPlanOutput(pi_B, goodPlanOutput(), newId("cmd"));

      // wi_A2 is dispatched immediately at admission (attempt1 not active → slot free).
      // wi_B is still queued (wi_A2 now occupies the single slot).
      const { rows: preA2 } = await client.query(
        `SELECT di.status FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_A2],
      );
      assert.equal(
        (preA2 as { status: string }[])[0]?.status,
        "triggered",
        "wi_A2 triggered at admission (attempt1 not active → slot free)",
      );
      const { rows: preB } = await client.query(
        `SELECT di.status FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_B],
      );
      assert.equal(
        (preB as { status: string }[])[0]?.status,
        "queued",
        "wi_B queued before scheduler",
      );

      // Pass 1: scheduleOnce with slots=1.
      // attempt1 has no triggered worker.attempt intent → NOT active (0 active attempts).
      // The scheduler should dispatch one item (whichever ranks first) and skip the
      // other with no_slot (not repository_busy from attempt1 on project A).
      await reconciler.scheduleOnce();

      const { rows: pass1A2 } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_A2],
      );
      const { rows: pass1B } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_B],
      );
      const p1A2 = (pass1A2 as { status: string; skip_reason: string | null }[])[0]!;
      const p1B = (pass1B as { status: string; skip_reason: string | null }[])[0]!;

      // Critically: neither should have repository_busy (attempt1 must NOT be active).
      assert.ok(
        p1A2.skip_reason !== "repository_busy",
        `wi_A2 must not be repository_busy on pass 1 (attempt1 not active): got ${p1A2.skip_reason}`,
      );
      assert.ok(
        p1B.skip_reason !== "repository_busy",
        `wi_B must not be repository_busy on pass 1 (attempt1 not active): got ${p1B.skip_reason}`,
      );

      // At least one item should be dispatched (slot was free).
      const oneTriggered = p1A2.status === "triggered" || p1B.status === "triggered";
      assert.ok(
        oneTriggered,
        `at least one of wi_A2/wi_B should be triggered on pass 1 (slot was free), got: A2=${p1A2.status} B=${p1B.status}`,
      );

      // wi_B (different project from attempt1's project A) must be triggered or no_slot
      // (never repository_busy from attempt1 on project A).
      assert.ok(
        p1B.status === "triggered" || p1B.skip_reason === "no_slot",
        `wi_B must be triggered or no_slot, not repository_busy from attempt1; got: status=${p1B.status} skip_reason=${p1B.skip_reason}`,
      );

      // Pass 2: close whichever intent was triggered (free the slot) and mark its
      // attempt completed, then run scheduleOnce again — the remaining item should
      // dispatch. wi_A2 (same project as attempt1) must NOT be repository_busy.
      await client.query(
        `UPDATE dispatch_intents SET status = 'observed', updated_at = now()
         WHERE task = $1 AND status = 'triggered'
           AND attempt_id IN (
             SELECT a.id FROM attempts a
             JOIN step_contracts sc ON sc.id = a.contract_id
             WHERE sc.work_item_id IN ($2, $3)
           )`,
        [TASK_IDS.workerAttempt, wi_A2, wi_B],
      );
      await client.query(
        `UPDATE attempts SET status = 'completed', updated_at = now()
         WHERE id IN (
           SELECT a.id FROM attempts a
           JOIN step_contracts sc ON sc.id = a.contract_id
           WHERE sc.work_item_id IN ($1, $2)
         ) AND status = 'dispatched'`,
        [wi_A2, wi_B],
      );

      await reconciler.scheduleOnce();

      const { rows: pass2A2 } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_A2],
      );
      const { rows: pass2B } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_B],
      );
      const p2A2 = (pass2A2 as { status: string; skip_reason: string | null }[])[0]!;
      const p2B = (pass2B as { status: string; skip_reason: string | null }[])[0]!;

      // After pass 2 both should be triggered (dispatched) or already observed.
      const bothDone =
        (p2A2.status === "triggered" || p2A2.status === "observed") &&
        (p2B.status === "triggered" || p2B.status === "observed");
      assert.ok(
        bothDone,
        `both wi_A2 and wi_B should be triggered/observed after pass 2; got A2=${p2A2.status} B=${p2B.status}`,
      );

      // The key assertion: wi_A2 (same project as attempt1) must never have been
      // blocked by repository_busy from attempt1.
      assert.ok(
        p2A2.skip_reason !== "repository_busy",
        `wi_A2 (same project as attempt1) must never get repository_busy: got ${p2A2.skip_reason}`,
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// (iii) Stopping attempt counts as active regardless of open intents
// ---------------------------------------------------------------------------

test("scheduling(iii): stopping attempt is always active — blocks slot and makes project busy even with no open worker.attempt intent", async (t) => {
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
      // Seed project A (wi1_A + wi_A2) and project B (wi_B).
      const { workItemId: wi1_A, projectId: projectA } = await seedProjectAndWorkItem(client);
      const wi_A2 = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 2, 'Fix a second issue on project A (iii)', NULL, 'artifact', 'proposed', 'healthy', false, 1)`,
        [wi_A2, projectA],
      );
      const { workItemId: wi_B } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // Admit wi1_A with a large slots value so scheduleQueuedIntents dispatches it immediately.
      const depsAdmit = makeFlowDeps(pool, fake, { workerSlots: 99 });
      const flowAdmit = new BoundedRepairFlow(depsAdmit);

      const { intentId: pi1, runId: pr1 } = await flowAdmit.plan(wi1_A, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flowAdmit.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Transition attempt1 to 'stopping' (worker being shut down) and also
      // mark its worker.attempt intent as 'observed' — so there is NO triggered
      // worker.attempt intent. A stopping attempt must STILL be counted as active.
      await client.query(
        `UPDATE attempts SET status = 'stopping', updated_at = now()
         WHERE id IN (
           SELECT a.id FROM attempts a
           JOIN step_contracts sc ON sc.id = a.contract_id
           WHERE sc.work_item_id = $1
         )`,
        [wi1_A],
      );
      await client.query(
        `UPDATE dispatch_intents SET status = 'observed', updated_at = now()
         WHERE task = $1
           AND attempt_id IN (
             SELECT a.id FROM attempts a
             JOIN step_contracts sc ON sc.id = a.contract_id
             WHERE sc.work_item_id = $2
           )`,
        [TASK_IDS.workerAttempt, wi1_A],
      );

      // Admit wi_A2 and wi_B with slots=1.
      const deps1 = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow1 = new BoundedRepairFlow(deps1);
      const reconciler = new Reconciler(deps1, flow1, { workerSlots: 1 });

      const { intentId: pi_A2, runId: pr_A2 } = await flow1.plan(wi_A2, newId("cmd"));
      fake.advance(pr_A2);
      fake.advance(pr_A2);
      await flow1.onLeadPlanOutput(pi_A2, goodPlanOutput(), newId("cmd"));

      const { intentId: pi_B, runId: pr_B } = await flow1.plan(wi_B, newId("cmd"));
      fake.advance(pr_B);
      fake.advance(pr_B);
      await flow1.onLeadPlanOutput(pi_B, goodPlanOutput(), newId("cmd"));

      // Run scheduler: attempt1 is 'stopping' → counted as active despite no open
      // worker.attempt intent → slot occupied → both wi_A2 and wi_B must be skipped.
      await reconciler.scheduleOnce();

      const { rows: rowsA2 } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_A2],
      );
      const { rows: rowsB } = await client.query(
        `SELECT di.status, di.skip_reason FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi_B],
      );
      const rA2 = (rowsA2 as { status: string; skip_reason: string | null }[])[0]!;
      const rB = (rowsB as { status: string; skip_reason: string | null }[])[0]!;

      // wi_B (different project) must be no_slot — stopping attempt occupies the slot.
      assert.equal(rB.status, "queued", "wi_B must stay queued (stopping attempt occupies slot)");
      assert.equal(
        rB.skip_reason,
        "no_slot",
        "wi_B must get no_slot (stopping attempt1 counts as active)",
      );

      // wi_A2 (same project) must be repository_busy — stopping attempt makes project A busy.
      assert.equal(
        rA2.status,
        "queued",
        "wi_A2 must stay queued (same project as stopping attempt)",
      );
      assert.equal(
        rA2.skip_reason,
        "repository_busy",
        "wi_A2 must get repository_busy (stopping attempt1 makes project A busy)",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Admission gate tests (F2 rework): all gates apply at admission via
// scheduleOnce — the old raw COUNT bypass is gone.
// ---------------------------------------------------------------------------

test("scheduling(admission-a): provider down, slots=2, nothing running → admission leaves intent queued with skip_reason=provider_down", async (t) => {
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
      // Insert a provider_capacity row with status='down' for the worker model provider.
      // The worker model is 'openai/gpt-5.6-terra' (from makeFlowDeps), so provider='openai'.
      const validUntil = new Date(Date.now() + 3600_000); // 1 hour from now
      await client.query(
        `INSERT INTO provider_capacity (provider, model, status, observed_at, valid_until, source)
         VALUES ($1, $2, 'down', now(), $3, 'operator')
         ON CONFLICT (provider, model, observed_at) DO UPDATE SET status = 'down', valid_until = $3`,
        ["openai", "gpt-5.6-terra", validUntil.toISOString()],
      );

      const { workItemId } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // slots=2, nothing running — without the F2 fix the old raw COUNT (0 < 2) would have
      // bypassed all gates and triggered the worker. Now scheduleQueuedIntents applies
      // provider gate first → provider_down.
      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });

      // Admit the work item. scheduleQueuedIntents runs at admission → provider is down → queued.
      const { intentId: pi, runId: pr } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(pr);
      fake.advance(pr);
      await flow.onLeadPlanOutput(pi, goodPlanOutput(), newId("cmd"));

      // The worker intent must be queued (not triggered) and have skip_reason=provider_down.
      const { rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      const intent = (rows as { status: string; skip_reason: string | null }[])[0];
      assert.ok(intent, "worker intent must exist");
      assert.equal(
        intent.status,
        "queued",
        "intent must be queued (provider down blocked dispatch)",
      );
      assert.equal(
        intent.skip_reason,
        "provider_down",
        `skip_reason must be provider_down, got: ${intent.skip_reason}`,
      );
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(admission-b): second item on same project admitted while first is running → queued with repository_busy", async (t) => {
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
      // Two work items on the SAME project (repository_busy applies within a project).
      const { workItemId: wi1, projectId } = await seedProjectAndWorkItem(client);
      const wi2 = newId("wi");
      await client.query(
        `INSERT INTO work_items
           (id, project_id, rank, intent, defect, boundary, lifecycle, condition, main_effort, version)
         VALUES ($1, $2, 2, 'Second fix on same project', NULL, 'artifact', 'proposed', 'healthy', false, 1)`,
        [wi2, projectId],
      );

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      // Workers stay EXECUTING so slots remain occupied.
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // slots=2 (enough for two workers) so the slot gate does not block.
      // The repository_busy gate fires because wi1 has an active worker on the same project.
      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });

      // Admit wi1 — dispatches immediately (slot free, no busy constraint).
      const { intentId: pi1, runId: pr1 } = await flow.plan(wi1, newId("cmd"));
      fake.advance(pr1);
      fake.advance(pr1);
      await flow.onLeadPlanOutput(pi1, goodPlanOutput(), newId("cmd"));

      // Verify wi1 was dispatched (triggered).
      const { rows: wi1Rows } = await client.query(
        `SELECT di.status FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi1],
      );
      assert.equal(
        (wi1Rows as { status: string }[])[0]?.status,
        "triggered",
        "wi1 must be triggered (dispatched at admission)",
      );

      // Admit wi2 (same project). scheduleQueuedIntents runs at admission → wi1's attempt
      // is active on project → repository_busy for wi2.
      const { intentId: pi2, runId: pr2 } = await flow.plan(wi2, newId("cmd"));
      fake.advance(pr2);
      fake.advance(pr2);
      await flow.onLeadPlanOutput(pi2, goodPlanOutput(), newId("cmd"));

      const { rows } = await client.query(
        `SELECT di.status, di.skip_reason
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wi2],
      );
      const intent = (rows as { status: string; skip_reason: string | null }[])[0];
      assert.ok(intent, "wi2 worker intent must exist");
      assert.equal(intent.status, "queued", "wi2 must be queued (same project as running wi1)");
      assert.equal(
        intent.skip_reason,
        "repository_busy",
        `skip_reason must be repository_busy, got: ${intent.skip_reason}`,
      );
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(admission-c): empty capacity table, slots=2, nothing running → admission dispatches immediately (no poll latency)", async (t) => {
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
      // No provider_capacity rows (capacity table empty).
      // slots=2, nothing running → all gates pass → scheduleOnce dispatches immediately.
      const { workItemId } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });

      // Admit the work item. scheduleQueuedIntents runs at admission → no gates block → dispatches.
      const { intentId: pi, runId: pr } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(pr);
      fake.advance(pr);
      await flow.onLeadPlanOutput(pi, goodPlanOutput(), newId("cmd"));

      // The worker intent must be triggered (dispatched) with a run_id set —
      // this proves dispatch happened at admission without waiting for a poll interval.
      const { rows } = await client.query(
        `SELECT di.status, di.run_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      const intent = (rows as { status: string; run_id: string | null }[])[0];
      assert.ok(intent, "worker intent must exist");
      assert.equal(
        intent.status,
        "triggered",
        "intent must be triggered (admission dispatched immediately via scheduleOnce)",
      );
      assert.ok(intent.run_id, "run_id must be set (worker was triggered, not just queued)");
    } finally {
      await pool.end();
    }
  });
});

test("scheduling(admission-d): replaying the same plan observation does not create a second intent", async (t) => {
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
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });

      // First admission — plan the work item.
      const { intentId: pi, runId: pr } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(pr);
      fake.advance(pr);

      // Use a fixed commandId so the replay uses the same key.
      const admitCmdId = newId("cmd");
      await flow.onLeadPlanOutput(pi, goodPlanOutput(), admitCmdId);

      // Verify exactly one worker intent exists after first admission.
      const { rows: rows1 } = await client.query(
        `SELECT count(*)::int AS n FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      assert.equal(
        (rows1 as { n: number }[])[0]!.n,
        1,
        "exactly one worker intent after first admission",
      );

      // Replay the same plan observation with the same commandId.
      // claimCommand sees the commandId already recorded → returns immediately (no-op).
      await flow.onLeadPlanOutput(pi, goodPlanOutput(), admitCmdId);

      // Still exactly one worker intent — no duplicate created.
      const { rows: rows2 } = await client.query(
        `SELECT count(*)::int AS n FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      assert.equal(
        (rows2 as { n: number }[])[0]!.n,
        1,
        "still exactly one worker intent after replay (idempotent admission)",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// N1: own worker trigger fails at admission → recovery parks item, intent failed
// ---------------------------------------------------------------------------

test("scheduling(admission-N1): own worker trigger fails at admission → failure row, pending_human, intents failed, next scheduleOnce does not dispatch", async (t) => {
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
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });

      // Plan the work item.
      const { intentId: pi, runId: pr } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(pr);
      fake.advance(pr);

      // The next trigger() call is the worker.attempt trigger from the admission
      // scheduling pass. Simulate a lost response.
      fake.dropNextResponse();

      // Admission must NOT throw even though the worker trigger fails.
      await assert.doesNotReject(
        flow.onLeadPlanOutput(pi, goodPlanOutput(), newId("cmd")),
        "onLeadPlanOutput must not throw when own worker dispatch fails",
      );

      // A failure row must be recorded.
      const { rows: failRows } = await client.query<{ class: string; phase: string }>(
        "SELECT class, phase FROM failures WHERE phase = 'plan'",
      );
      assert.equal(failRows.length, 1, "one failure row recorded");
      assert.equal(failRows[0]?.class, "execution", "failure class = execution");

      // A pending_human decision must be recorded for the work item.
      const { rows: phRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'plan' AND work_item_id = $1",
        [workItemId],
      );
      const pending = phRows.filter((r) => r.outcome === "pending_human");
      assert.equal(pending.length, 1, "one pending_human plan decision recorded");

      // The lead.plan intent must be marked failed.
      const { rows: lpRows } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE id = $1",
        [pi],
      );
      assert.equal(lpRows[0]?.status, "failed", "lead.plan intent must be failed");

      // The own worker intent must be marked failed (not left queued).
      const { rows: workerRows } = await client.query<{ status: string; run_id: string | null }>(
        `SELECT di.status, di.run_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      assert.equal(workerRows[0]?.status, "failed", "own worker intent must be failed, not queued");

      // A subsequent scheduleOnce() must NOT dispatch the failed intent.
      await reconciler.scheduleOnce();
      const { rows: afterPoll } = await client.query<{ status: string }>(
        `SELECT di.status
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      assert.equal(
        afterPoll[0]?.status,
        "failed",
        "worker intent must still be failed after scheduleOnce — not re-dispatched while parked",
      );
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// N2: another queued item B's dispatch fails during C's admission → C is not affected
// ---------------------------------------------------------------------------

test("scheduling(admission-N2): another queued item B fails dispatch during C's admission → C dispatched normally, C not parked, B retried on next poll", async (t) => {
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
      // Seed three work items on separate projects.
      const { workItemId: wiA } = await seedProjectAndWorkItem(client);
      const { workItemId: wiB } = await seedProjectAndWorkItem(client);
      const { workItemId: wiC } = await seedProjectAndWorkItem(client);

      const fake = new FakeExecutionRuntime();
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      // slots=1: admit A (dispatched) and B (queued — no_slot).
      const deps1 = makeFlowDeps(pool, fake, { workerSlots: 1 });
      const flow1 = new BoundedRepairFlow(deps1);

      for (const wi of [wiA, wiB]) {
        const { intentId: planIntentId, runId: planRunId } = await flow1.plan(wi, newId("cmd"));
        fake.advance(planRunId);
        fake.advance(planRunId);
        await flow1.onLeadPlanOutput(planIntentId, goodPlanOutput(), newId("cmd"));
      }

      // Verify setup: A triggered, B queued.
      const { rows: aSetup } = await client.query<{ status: string; run_id: string | null }>(
        `SELECT di.status, di.run_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wiA],
      );
      assert.equal(aSetup[0]?.status, "triggered", "A must be triggered after setup");

      const { rows: bSetup } = await client.query<{ status: string }>(
        `SELECT di.status
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wiB],
      );
      assert.equal(bSetup[0]?.status, "queued", "B must be queued after setup");

      // Free A's slot: mark A's intent observed and attempt completed.
      await client.query("UPDATE dispatch_intents SET status = 'observed' WHERE run_id = $1", [
        aSetup[0]!.run_id,
      ]);
      await client.query("UPDATE attempts SET status = 'completed' WHERE run_id = $1", [
        aSetup[0]!.run_id,
      ]);

      // slots=2: admit C while B is still queued. B (older) is selected first by
      // the scheduling pass. Make the next trigger() call fail — that is B's dispatch.
      const deps2 = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow2 = new BoundedRepairFlow(deps2);
      const reconciler = new Reconciler(deps2, flow2, { workerSlots: 2 });

      const { intentId: piC, runId: prC } = await flow2.plan(wiC, newId("cmd"));
      fake.advance(prC);
      fake.advance(prC);

      // Drop the next trigger() — B's worker.attempt is dispatched first (older rank).
      fake.dropNextResponse();

      // Admission must NOT throw and must NOT park C.
      await assert.doesNotReject(
        flow2.onLeadPlanOutput(piC, goodPlanOutput(), newId("cmd")),
        "onLeadPlanOutput must not throw when another item's dispatch fails",
      );

      // C's worker intent must be triggered (its own dispatch succeeded).
      const { rows: cRows } = await client.query<{ status: string; run_id: string | null }>(
        `SELECT di.status, di.run_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wiC],
      );
      assert.equal(cRows[0]?.status, "triggered", "C's worker intent must be triggered");
      assert.ok(cRows[0]?.run_id, "C's worker intent must have a run_id");

      // No failure row — recovery must NOT have fired for C.
      const { rows: failRows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM failures",
      );
      assert.equal((failRows[0] as { n: number }).n, 0, "no failure row — C was not affected");

      // No pending_human decision for C.
      const { rows: phC } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM decisions WHERE work_item_id = $1 AND outcome = 'pending_human'",
        [wiC],
      );
      assert.equal((phC[0] as { n: number }).n, 0, "no pending_human for C");

      // B's intent must still be queued (failed trigger left it queued for retry).
      const { rows: bMid } = await client.query<{ status: string }>(
        `SELECT di.status
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wiB],
      );
      assert.equal(bMid[0]?.status, "queued", "B's intent must still be queued");

      // Next scheduleOnce() (no fake failure) must dispatch B.
      await reconciler.scheduleOnce();
      const { rows: bAfter } = await client.query<{ status: string }>(
        `SELECT di.status
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, wiB],
      );
      assert.equal(bAfter[0]?.status, "triggered", "B must be dispatched on the next scheduleOnce");
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// R1: non-dispatch error (pool.connect rejection) inside the admission
//     scheduling pass → outer catch recovery parks item AND marks worker intent
//     failed so the next scheduleOnce() does not re-dispatch it.
// ---------------------------------------------------------------------------

test("scheduling(admission-R1): non-dispatch error inside scheduling pass → failure row, pending_human, intents failed, next scheduleOnce does not dispatch", async (t) => {
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
      scriptLeadPlan(fake);
      fake.script(TASK_IDS.workerAttempt, () => [{ status: "EXECUTING" }]);

      const deps = makeFlowDeps(pool, fake, { workerSlots: 2 });
      const flow = new BoundedRepairFlow(deps);
      const reconciler = new Reconciler(deps, flow, { workerSlots: 2 });

      // Plan the work item.
      const { intentId: pi, runId: pr } = await flow.plan(workItemId, newId("cmd"));
      fake.advance(pr);
      fake.advance(pr);

      // Intercept the 2nd promise-style pool.connect() call — the one that
      // scheduleQueuedIntents makes when loading the queue. Callback-style
      // calls (pg internals) are passed through unmodified.
      const origConnect = pool.connect.bind(pool);
      let connectCount = 0;
      (pool as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
        if (args.length > 0) {
          // Callback-style: delegate to original.
          return (origConnect as (...a: unknown[]) => unknown)(...args);
        }
        connectCount += 1;
        if (connectCount === 2) {
          return Promise.reject(new Error("simulated pool.connect failure (scheduling pass)"));
        }
        return origConnect();
      };

      // Admission must NOT throw even though the scheduling pass fails.
      await assert.doesNotReject(
        flow.onLeadPlanOutput(pi, goodPlanOutput(), newId("cmd")),
        "onLeadPlanOutput must not throw when scheduleQueuedIntents fails with a non-dispatch error",
      );

      // Restore pool.connect immediately after the call.
      (pool as unknown as { connect: unknown }).connect = origConnect;

      // A failure row must be recorded.
      const { rows: failRows } = await client.query<{ class: string; phase: string }>(
        "SELECT class, phase FROM failures WHERE phase = 'plan'",
      );
      assert.equal(failRows.length, 1, "one failure row recorded");
      assert.equal(failRows[0]?.class, "execution", "failure class = execution");

      // A pending_human decision must be recorded for the work item.
      const { rows: phRows } = await client.query<{ outcome: string }>(
        "SELECT outcome FROM decisions WHERE kind = 'plan' AND work_item_id = $1",
        [workItemId],
      );
      const pending = phRows.filter((r) => r.outcome === "pending_human");
      assert.equal(pending.length, 1, "one pending_human plan decision recorded");

      // The lead.plan intent must be marked failed.
      const { rows: lpRows } = await client.query<{ status: string }>(
        "SELECT status FROM dispatch_intents WHERE id = $1",
        [pi],
      );
      assert.equal(lpRows[0]?.status, "failed", "lead.plan intent must be failed");

      // The own worker intent must be marked failed — not left queued/recorded
      // (this was the R1 bug: non-dispatch errors bypassed the worker-intent failure).
      const { rows: workerRows } = await client.query<{ status: string; run_id: string | null }>(
        `SELECT di.status, di.run_id
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      assert.equal(
        workerRows[0]?.status,
        "failed",
        "own worker intent must be failed (not queued) after non-dispatch error",
      );

      // A subsequent scheduleOnce() must NOT dispatch the failed intent.
      await reconciler.scheduleOnce();
      const { rows: afterPoll } = await client.query<{ status: string }>(
        `SELECT di.status
         FROM dispatch_intents di
         JOIN attempts a ON a.id = di.attempt_id
         JOIN step_contracts sc ON sc.id = a.contract_id
         WHERE di.task = $1 AND sc.work_item_id = $2`,
        [TASK_IDS.workerAttempt, workItemId],
      );
      assert.equal(
        afterPoll[0]?.status,
        "failed",
        "worker intent must still be failed after scheduleOnce — not re-dispatched while parked pending_human",
      );
    } finally {
      await pool.end();
    }
  });
});
