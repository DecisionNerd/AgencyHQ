/**
 * Integration tests for finding disposition (disposition command, PACKET 4.2.b).
 *
 * C3: disposition command tests.
 *
 * Test cases:
 * 1. blocking finding → disposition remediate → failure row + new attempt + intent
 *    in one transaction before trigger; contract row unchanged (R-017).
 * 2. Replay (same commandId) → no second attempt created (idempotency, R-010).
 * 3. Budget exhausted → disposition remediate → pending_human decision.
 * 4. disposition block → pending_human decision.
 * 5. Contract row not mutated before or after remediate (R-017).
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 * DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, withTestSchema } from "@agencyhq/db";
import { FakeExecutionRuntime } from "../../../../trigger/src/client/fake.ts";
import { dispositionFinding } from "../../src/commands/disposition.ts";

const DATABASE_URL = process.env.DATABASE_URL;

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
  boundary: "artifact",
  budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
  review: "adversarial",
  changeClass: "behavior",
  models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
};

function makeSchemaPool(databaseUrl: string, schema: string): ReturnType<typeof createPool> {
  const poolUrl = new URL(databaseUrl);
  poolUrl.searchParams.set("options", `-c search_path=${schema},public`);
  return createPool(poolUrl.toString());
}

/**
 * Seed a full stack: project → work_item → step_contract → attempt → finding.
 * Returns { projectId, workItemId, contractId, attemptId, findingId }.
 */
async function seedFindingStack(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  opts: { budgetRemaining?: number } = {},
): Promise<{
  projectId: string;
  workItemId: string;
  contractId: string;
  attemptId: string;
  findingId: string;
}> {
  const projectId = `prj-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const contractId = `sc-${randomUUID()}`;
  const attemptId = `att-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const findingId = `fnd-${randomUUID()}`;

  await client.query(
    `INSERT INTO projects (id, authority, authority_version, clone_path)
     VALUES ($1, '{}', '1', '/repo/proj')`,
    [projectId],
  );
  await client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 1, 'Fix the bug', 'artifact', 'active', 'healthy')`,
    [workItemId, projectId],
  );
  await client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, 'abc1234567890123456789012345678901234567', $4::jsonb, '[]',
             'cdigest', 'default', 'pdigest', $5::jsonb, '[]', false, 'active')`,
    [
      contractId,
      workItemId,
      projectId,
      JSON.stringify({ intent: "Fix the bug" }),
      JSON.stringify(VALID_BOUNDS),
    ],
  );
  await client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, run_id, budget_remaining)
     VALUES ($1, $2, 1, 1, 'running', $3, $4)`,
    [attemptId, contractId, runId, opts.budgetRemaining ?? 2],
  );
  await client.query(
    `INSERT INTO findings (id, attempt_id, severity, kind, description)
     VALUES ($1, $2, 'blocking', 'test_failure', 'Tests did not pass')`,
    [findingId, attemptId],
  );

  return { projectId, workItemId, contractId, attemptId, findingId };
}

// ---------------------------------------------------------------------------
// Test 1: remediate → failure + new attempt + intent, contract unchanged
// ---------------------------------------------------------------------------

test("disposition remediate: creates failure + new attempt + intent atomically", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const { contractId, attemptId, findingId } = await seedFindingStack(client);

      // Capture contract state before
      const { rows: contractBefore } = await client.query<{
        id: string;
        criteria_digest: string;
        profile_digest: string;
        version: number;
      }>("SELECT id, criteria_digest, profile_digest, version FROM step_contracts WHERE id = $1", [
        contractId,
      ]);
      const contractSnap = contractBefore[0];
      assert.ok(contractSnap, "contract exists before");

      const result = await dispositionFinding(
        { pool: schemaPool, runtime: fake, config: { workerModel: "openai/gpt-5.6-terra" } },
        {
          commandId: `cmd-${randomUUID()}`,
          findingId,
          disposition: "remediate",
          reason: "please try again",
          actor: "human",
        },
      );

      assert.ok(result.ok, `dispositionFinding failed: ${result.ok ? "" : result.reason}`);
      if (!result.ok) return;
      assert.equal(result.outcome, "remediate");

      // New attempt must exist
      const { rows: newAttempts } = await client.query<{ id: string; generation: number }>(
        "SELECT id, generation FROM attempts WHERE id = $1",
        [result.newAttemptId],
      );
      assert.equal(newAttempts.length, 1, "new attempt row exists");
      assert.equal(newAttempts[0]?.generation, 1);

      // Failure row for old attempt must exist
      const { rows: failures } = await client.query<{ attempt_id: string; cause: string }>(
        "SELECT attempt_id, cause FROM failures WHERE attempt_id = $1",
        [attemptId],
      );
      assert.equal(failures.length, 1, "failure row for old attempt exists");
      assert.match(String(failures[0]?.cause), /disposition:remediate/, "cause records remediate");

      // Dispatch intent for new attempt
      const { rows: intents } = await client.query(
        "SELECT id FROM dispatch_intents WHERE id = $1",
        [result.newIntentId],
      );
      assert.equal(intents.length, 1, "dispatch_intent row exists");

      // Old attempt must be failed
      const { rows: oldAttempt } = await client.query<{ status: string }>(
        "SELECT status FROM attempts WHERE id = $1",
        [attemptId],
      );
      assert.equal(oldAttempt[0]?.status, "failed", "old attempt marked failed");

      // Finding disposition updated
      const { rows: findingRows } = await client.query<{ disposition: string }>(
        "SELECT disposition FROM findings WHERE id = $1",
        [findingId],
      );
      assert.equal(findingRows[0]?.disposition, "remediate", "finding disposition = remediate");

      // Contract NOT mutated (R-017)
      const { rows: contractAfter } = await client.query<{
        criteria_digest: string;
        profile_digest: string;
        version: number;
      }>("SELECT criteria_digest, profile_digest, version FROM step_contracts WHERE id = $1", [
        contractId,
      ]);
      const ca = contractAfter[0];
      assert.equal(ca?.criteria_digest, contractSnap.criteria_digest, "criteria_digest unchanged");
      assert.equal(ca?.profile_digest, contractSnap.profile_digest, "profile_digest unchanged");
      assert.equal(ca?.version, contractSnap.version, "version unchanged");
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: replay → no second attempt (idempotency, R-010)
// ---------------------------------------------------------------------------

test("disposition remediate idempotency: replay does not create second attempt", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const { findingId } = await seedFindingStack(client);
      const commandId = `cmd-${randomUUID()}`;

      const first = await dispositionFinding(
        { pool: schemaPool, runtime: fake, config: { workerModel: "openai/gpt-5.6-terra" } },
        { commandId, findingId, disposition: "remediate", reason: "try again", actor: "human" },
      );
      assert.ok(first.ok && first.outcome === "remediate", "first call succeeded");

      const second = await dispositionFinding(
        { pool: schemaPool, runtime: fake, config: { workerModel: "openai/gpt-5.6-terra" } },
        { commandId, findingId, disposition: "remediate", reason: "try again", actor: "human" },
      );
      assert.ok(second.ok && second.outcome === "remediate", "second call succeeded (replay)");
      if (
        first.ok &&
        first.outcome === "remediate" &&
        second.ok &&
        second.outcome === "remediate"
      ) {
        assert.equal(second.newAttemptId, first.newAttemptId, "same attemptId on replay");
        assert.equal(second.newRunId, first.newRunId, "same runId on replay");
      }

      // Only one failure row for the original attempt
      const { rows: allAttempts } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM attempts WHERE status = 'admitted' OR status = 'dispatched'",
      );
      // The new attempt is admitted/dispatched; there should be exactly 1 new attempt
      assert.equal(allAttempts[0]?.count, "1", "exactly one new attempt exists");
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: budget exhausted → pending_human
// ---------------------------------------------------------------------------

test("disposition remediate: budget=0 → pending_human", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const { findingId } = await seedFindingStack(client, { budgetRemaining: 0 });

      const result = await dispositionFinding(
        { pool: schemaPool, runtime: fake },
        {
          commandId: `cmd-${randomUUID()}`,
          findingId,
          disposition: "remediate",
          reason: "try again",
          actor: "human",
        },
      );

      assert.ok(result.ok, `dispositionFinding failed: ${result.ok ? "" : result.reason}`);
      if (!result.ok) return;
      assert.equal(result.outcome, "pending_human", "budget=0 → pending_human");

      // No new attempt should have been created
      const { rows: attempts } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM attempts WHERE status NOT IN ('running', 'failed')",
      );
      assert.equal(attempts[0]?.count, "0", "no new attempt created");
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: disposition block → pending_human
// ---------------------------------------------------------------------------

test("disposition block: sets finding to block and records pending_human decision", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const { contractId, findingId } = await seedFindingStack(client);

      const result = await dispositionFinding(
        { pool: schemaPool, runtime: fake },
        {
          commandId: `cmd-${randomUUID()}`,
          findingId,
          disposition: "block",
          reason: "security issue",
          actor: "human",
        },
      );

      assert.ok(result.ok, `dispositionFinding failed: ${result.ok ? "" : result.reason}`);
      if (!result.ok) return;
      assert.equal(result.outcome, "pending_human");

      // Decision recorded with outcome=pending_human
      const { rows: decisions } = await client.query<{ outcome: string; kind: string }>(
        "SELECT outcome, kind FROM decisions WHERE contract_id = $1",
        [contractId],
      );
      assert.equal(decisions.length, 1, "one decision row");
      assert.equal(decisions[0]?.outcome, "pending_human");
      assert.equal(decisions[0]?.kind, "disposition");

      // Finding disposition set to 'block'
      const { rows: findingRows } = await client.query<{ disposition: string }>(
        "SELECT disposition FROM findings WHERE id = $1",
        [findingId],
      );
      assert.equal(findingRows[0]?.disposition, "block");

      // Trigger never called
      const triggerCalls = fake.calls.filter((c) => c.method === "trigger");
      assert.equal(triggerCalls.length, 0, "trigger not called for block disposition");
    } finally {
      await schemaPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: contract row not mutated by remediate (R-017)
// ---------------------------------------------------------------------------

test("disposition remediate: contract row columns unchanged after remediate (R-017)", async (t) => {
  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  await withTestSchema(t, async ({ client, schema }) => {
    await client.query(`SET search_path TO "${schema}", public`);
    const schemaPool = makeSchemaPool(DATABASE_URL, schema);
    const fake = new FakeExecutionRuntime();
    try {
      const { contractId, findingId } = await seedFindingStack(client);

      // Snapshot ALL contract columns
      const { rows: beforeRows } = await client.query(
        "SELECT * FROM step_contracts WHERE id = $1",
        [contractId],
      );
      const before = beforeRows[0] as Record<string, unknown>;

      await dispositionFinding(
        { pool: schemaPool, runtime: fake, config: { workerModel: "openai/gpt-5.6-terra" } },
        {
          commandId: `cmd-${randomUUID()}`,
          findingId,
          disposition: "remediate",
          reason: "try again",
          actor: "human",
        },
      );

      const { rows: afterRows } = await client.query("SELECT * FROM step_contracts WHERE id = $1", [
        contractId,
      ]);
      const after = afterRows[0] as Record<string, unknown>;

      // Every column except updated_at must be unchanged
      for (const key of Object.keys(before)) {
        if (key === "updated_at") continue;
        assert.deepEqual(after[key], before[key], `column ${key} must not change`);
      }
    } finally {
      await schemaPool.end();
    }
  });
});
