/**
 * Integration tests: recordDecisionAndIntent unit of work.
 * Requires DATABASE_URL pointing to the test Postgres instance.
 *
 * R-002: decision, attempt, and DispatchIntent are committed before any trigger call.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import pg from "pg";
import { insertProject } from "../../src/repos/projects.ts";
import { insertStepContract } from "../../src/repos/step-contracts.ts";
import { insertWorkItem } from "../../src/repos/work-items.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";
import { recordDecisionAndIntent } from "../../src/unit-of-work.ts";

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const BOUNDS = {
  paths: { allow: ["src/**"], deny: [] },
  capabilities: {
    bash: { allow: ["pnpm test"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundary: "artifact" as const,
  budget: { maxAttempts: 2, maxDurationSeconds: 300, estimatedSpendUsd: 1 },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "test-worker", reviewer: "test-reviewer" },
};

const CRITERION = {
  id: "c1",
  text: "The code compiles",
  source: "operator" as const,
};

/**
 * Set up a minimal project + work_item + step_contract for a test scenario.
 */
async function setupChain(
  client: pg.PoolClient,
  prefix: string,
): Promise<{ projectId: string; workItemId: string; contractId: string }> {
  const projectId = `proj-${prefix}`;
  const workItemId = `wi-${prefix}`;
  const contractId = `sc-${prefix}`;

  await insertProject(client, {
    id: projectId,
    authority: HOST_TRIAL_AUTHORITY,
    authority_version: "1",
  });
  await insertWorkItem(client, {
    id: workItemId,
    project_id: projectId,
    rank: 1,
    intent: "Test work item",
    boundary: "artifact",
    lifecycle: "repair",
    condition: "open",
  });
  await insertStepContract(client, {
    id: contractId,
    work_item_id: workItemId,
    project_id: projectId,
    version: 1,
    base_revision: "abc1234",
    inputs: {},
    criteria: [CRITERION],
    criteria_digest: DIGEST,
    profile_id: "host-trial",
    profile_digest: DIGEST,
    bounds: BOUNDS,
    required_boundaries: ["artifact"],
    human_required: false,
    status: "active",
  });

  return { projectId, workItemId, contractId };
}

// ---------------------------------------------------------------------------
// (a) Happy path: decision + attempt + intent atomically, transitions written
// ---------------------------------------------------------------------------

test("unit-of-work: happy path inserts decision, attempt, intent atomically with transitions", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { workItemId, contractId } = await setupChain(client, "uow1");

    const result = await recordDecisionAndIntent(client, {
      decision: {
        id: "dec-uow1",
        kind: "admit",
        actor: "coordinator",
        work_item_id: workItemId,
        contract_id: contractId,
        contract_version: 1,
        outcome: "approved",
        at: new Date(),
      },
      attempt: {
        id: "att-uow1",
        contract_id: contractId,
        contract_version: 1,
        generation: 1,
        status: "admitted",
        budget_remaining: 100,
      },
      intent: {
        id: "di-uow1",
        task: "worker.attempt",
        payload_digest: DIGEST,
        attempt_id: "att-uow1",
        status: "pending",
        idempotency_key: "idem-uow1",
      },
      audit: {
        actor: "coordinator",
        commandId: "cmd-uow1",
      },
    });

    assert.equal(result.decisionId, "dec-uow1");
    assert.equal(result.attemptId, "att-uow1");
    assert.equal(result.intentId, "di-uow1");

    // Verify decision exists
    const { rows: decRows } = await client.query(
      "SELECT COUNT(*) AS c FROM decisions WHERE id = 'dec-uow1'",
    );
    assert.equal(Number(decRows[0]?.c ?? 0), 1);

    // Verify attempt exists
    const { rows: attRows } = await client.query(
      "SELECT COUNT(*) AS c FROM attempts WHERE id = 'att-uow1'",
    );
    assert.equal(Number(attRows[0]?.c ?? 0), 1);

    // Verify dispatch_intent exists
    const { rows: diRows } = await client.query(
      "SELECT COUNT(*) AS c FROM dispatch_intents WHERE id = 'di-uow1'",
    );
    assert.equal(Number(diRows[0]?.c ?? 0), 1);

    // Verify transitions were written (one for attempt, one for intent)
    const { rows: trRows } = await client.query("SELECT COUNT(*) AS c FROM transitions");
    assert.ok(Number(trRows[0]?.c ?? 0) >= 2, "At least 2 transition rows expected");

    // Verify attempt transition exists
    const { rows: attTr } = await client.query(
      "SELECT * FROM transitions WHERE aggregate = 'attempts' AND aggregate_id = 'att-uow1'",
    );
    assert.equal(attTr.length, 1);
    assert.equal(attTr[0]?.to_state, "admitted");

    // Verify intent transition exists
    const { rows: diTr } = await client.query(
      "SELECT * FROM transitions WHERE aggregate = 'dispatch_intents' AND aggregate_id = 'di-uow1'",
    );
    assert.equal(diTr.length, 1);
    assert.equal(diTr[0]?.to_state, "pending");

    // Verify command idempotency row was written
    const { rows: cmdRows } = await client.query(
      "SELECT * FROM commands WHERE command_id = 'cmd-uow1'",
    );
    assert.equal(cmdRows.length, 1);

    // Unused but suppresses "unused variable" warning
    void schema;
  });
});

// ---------------------------------------------------------------------------
// (b) Forced failure: duplicate idempotency_key leaves NO decision, NO attempt
// ---------------------------------------------------------------------------

test("unit-of-work: forced failure rolls back decision and attempt", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { workItemId, contractId } = await setupChain(client, "uow2");

    // Insert a dispatch_intent with the same idempotency_key first
    await client.query(
      `INSERT INTO dispatch_intents (id, task, payload_digest, status, idempotency_key)
       VALUES ('di-blocker', 'worker.attempt', $1, 'pending', 'idem-conflict')`,
      [DIGEST],
    );

    // The PoolClient path assumes the caller controls the transaction.
    // We BEGIN here so that the failed INSERT rolls back all preceding inserts.
    await client.query("BEGIN");

    let caught: unknown = null;
    try {
      await recordDecisionAndIntent(client, {
        decision: {
          id: "dec-uow2",
          kind: "admit",
          actor: "coordinator",
          work_item_id: workItemId,
          contract_id: contractId,
          contract_version: 1,
          at: new Date(),
        },
        attempt: {
          id: "att-uow2",
          contract_id: contractId,
          contract_version: 1,
          generation: 1,
          status: "admitted",
          budget_remaining: 100,
        },
        intent: {
          id: "di-uow2",
          task: "worker.attempt",
          payload_digest: DIGEST,
          attempt_id: "att-uow2",
          status: "pending",
          idempotency_key: "idem-conflict", // ← duplicate; violates unique constraint
        },
        audit: { actor: "coordinator" },
      });
    } catch (err) {
      caught = err;
      await client.query("ROLLBACK");
    }

    assert.ok(caught, "Expected an error to be thrown");

    // Verify decision was NOT persisted (rolled back with the transaction)
    const { rows: decRows } = await client.query(
      "SELECT COUNT(*) AS c FROM decisions WHERE id = 'dec-uow2'",
    );
    assert.equal(Number(decRows[0]?.c ?? 0), 0, "Decision should not exist after rollback");

    // Verify attempt was NOT persisted
    const { rows: attRows } = await client.query(
      "SELECT COUNT(*) AS c FROM attempts WHERE id = 'att-uow2'",
    );
    assert.equal(Number(attRows[0]?.c ?? 0), 0, "Attempt should not exist after rollback");
  });
});

// ---------------------------------------------------------------------------
// (b2) Pool path: forced failure rolls back atomically via pool transaction
// ---------------------------------------------------------------------------

test("unit-of-work (Pool): forced failure rolls back decision and attempt atomically", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { workItemId, contractId } = await setupChain(client, "uow3");

    // Insert conflicting idempotency_key
    await client.query(
      `INSERT INTO dispatch_intents (id, task, payload_digest, status, idempotency_key)
       VALUES ('di-blocker3', 'worker.attempt', $1, 'pending', 'idem-pool-conflict')`,
      [DIGEST],
    );

    const url = process.env.DATABASE_URL;
    if (!url) {
      t.skip("DATABASE_URL is not set");
      return;
    }

    // Create a pool that sets the search_path to match the test schema
    const pool = new pg.Pool({
      connectionString: url,
      max: 2,
    });

    // Set search_path on every new connection from this pool
    pool.on("connect", (poolClient) => {
      void poolClient.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);
    });

    let caught: unknown = null;
    try {
      await recordDecisionAndIntent(pool, {
        decision: {
          id: "dec-uow3",
          kind: "admit",
          actor: "coordinator",
          work_item_id: workItemId,
          contract_id: contractId,
          contract_version: 1,
          at: new Date(),
        },
        attempt: {
          id: "att-uow3",
          contract_id: contractId,
          contract_version: 1,
          generation: 1,
          status: "admitted",
          budget_remaining: 100,
        },
        intent: {
          id: "di-uow3",
          task: "worker.attempt",
          payload_digest: DIGEST,
          attempt_id: "att-uow3",
          status: "pending",
          idempotency_key: "idem-pool-conflict", // ← duplicate
        },
        audit: { actor: "coordinator" },
      });
    } catch (err) {
      caught = err;
    } finally {
      await pool.end();
    }

    assert.ok(caught, "Expected an error to be thrown");

    // Verify decision and attempt were rolled back
    const { rows: decRows } = await client.query(
      "SELECT COUNT(*) AS c FROM decisions WHERE id = 'dec-uow3'",
    );
    assert.equal(Number(decRows[0]?.c ?? 0), 0, "Decision should not exist after pool rollback");

    const { rows: attRows } = await client.query(
      "SELECT COUNT(*) AS c FROM attempts WHERE id = 'att-uow3'",
    );
    assert.equal(Number(attRows[0]?.c ?? 0), 0, "Attempt should not exist after pool rollback");
  });
});

// ---------------------------------------------------------------------------
// (c) Idempotency replay: same commandId returns same ids, inserts nothing new
// ---------------------------------------------------------------------------

test("unit-of-work: replaying the same commandId returns stored result unchanged", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { workItemId, contractId } = await setupChain(client, "uow4");

    const input = {
      decision: {
        id: "dec-uow4",
        kind: "admit",
        actor: "coordinator",
        work_item_id: workItemId,
        contract_id: contractId,
        contract_version: 1,
        at: new Date(),
      },
      attempt: {
        id: "att-uow4",
        contract_id: contractId,
        contract_version: 1,
        generation: 1,
        status: "admitted",
        budget_remaining: 100,
      },
      intent: {
        id: "di-uow4",
        task: "worker.attempt",
        payload_digest: DIGEST,
        attempt_id: "att-uow4",
        status: "pending",
        idempotency_key: "idem-uow4",
      },
      audit: {
        actor: "coordinator",
        commandId: "cmd-replay",
      },
    };

    // First call
    const first = await recordDecisionAndIntent(client, input);

    assert.equal(first.decisionId, "dec-uow4");
    assert.equal(first.attemptId, "att-uow4");
    assert.equal(first.intentId, "di-uow4");

    // Count rows before replay
    const { rows: decBefore } = await client.query("SELECT COUNT(*) AS c FROM decisions");
    const { rows: attBefore } = await client.query("SELECT COUNT(*) AS c FROM attempts");
    const { rows: diBefore } = await client.query("SELECT COUNT(*) AS c FROM dispatch_intents");
    const { rows: trBefore } = await client.query("SELECT COUNT(*) AS c FROM transitions");

    // Second call (replay) — same commandId
    const second = await recordDecisionAndIntent(client, input);

    // Same result returned
    assert.equal(second.decisionId, first.decisionId);
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(second.intentId, first.intentId);

    // No new rows inserted
    const { rows: decAfter } = await client.query("SELECT COUNT(*) AS c FROM decisions");
    const { rows: attAfter } = await client.query("SELECT COUNT(*) AS c FROM attempts");
    const { rows: diAfter } = await client.query("SELECT COUNT(*) AS c FROM dispatch_intents");
    const { rows: trAfter } = await client.query("SELECT COUNT(*) AS c FROM transitions");

    assert.equal(Number(decAfter[0]?.c ?? 0), Number(decBefore[0]?.c ?? 0), "No new decision rows");
    assert.equal(Number(attAfter[0]?.c ?? 0), Number(attBefore[0]?.c ?? 0), "No new attempt rows");
    assert.equal(
      Number(diAfter[0]?.c ?? 0),
      Number(diBefore[0]?.c ?? 0),
      "No new dispatch_intent rows",
    );
    assert.equal(Number(trAfter[0]?.c ?? 0), Number(trBefore[0]?.c ?? 0), "No new transition rows");
  });
});
