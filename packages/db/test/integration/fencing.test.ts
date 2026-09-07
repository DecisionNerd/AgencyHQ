/**
 * Integration tests for fencing.ts — revokeGeneration and confirmStopped.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type pg from "pg";
import { confirmStopped, revokeGeneration } from "../../src/fencing.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

async function seedAttempt(
  client: pg.PoolClient,
  opts: { status?: string; generation?: number } = {},
): Promise<string> {
  const projectId = `proj-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const contractId = `sc-${randomUUID()}`;
  const attemptId = `att-${randomUUID()}`;

  await client.query(
    `INSERT INTO projects (id, authority, authority_version) VALUES ($1, '{}', '1')`,
    [projectId],
  );
  await client.query(
    `INSERT INTO work_items (id, project_id, rank, intent, boundary, lifecycle, condition)
     VALUES ($1, $2, 1, 'test intent', 'artifact', 'open', 'pending')`,
    [workItemId, projectId],
  );
  await client.query(
    `INSERT INTO step_contracts
       (id, work_item_id, project_id, version, base_revision, inputs, criteria,
        criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
        human_required, status)
     VALUES ($1, $2, $3, 1, 'abc123', '{}', '[]', 'cdigest', 'profile1', 'pdigest',
             '{}', '[]', false, 'active')`,
    [contractId, workItemId, projectId],
  );
  await client.query(
    `INSERT INTO attempts (id, contract_id, contract_version, generation, status, budget_remaining)
     VALUES ($1, $2, 1, $3, $4, 100)`,
    [attemptId, contractId, opts.generation ?? 1, opts.status ?? "running"],
  );

  return attemptId;
}

// ---------------------------------------------------------------------------
// revokeGeneration tests
// ---------------------------------------------------------------------------

test("revokeGeneration: bumps generation once and appends transition", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const attemptId = await seedAttempt(client, { status: "running", generation: 1 });

    const result = await revokeGeneration(client, attemptId, 1);
    assert.ok(result.ok, "Expected ok: true");
    assert.equal(result.generation, 2);

    // Confirm the DB row was updated
    const { rows } = await client.query<{ generation: number; status: string }>(
      `SELECT generation, status FROM attempts WHERE id = $1`,
      [attemptId],
    );
    assert.equal(rows.at(0)?.generation, 2);
    assert.equal(rows.at(0)?.status, "stopping");

    // Transition row should exist
    const { rows: trows } = await client.query<{ from_state: string; to_state: string }>(
      `SELECT from_state, to_state FROM transitions WHERE aggregate = 'attempt' AND aggregate_id = $1`,
      [attemptId],
    );
    assert.equal(trows.length, 1);
    assert.equal(trows.at(0)?.from_state, "running");
    assert.equal(trows.at(0)?.to_state, "stopping");
  });
});

test("revokeGeneration: second revoke with old expectedGeneration returns stale_generation", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const attemptId = await seedAttempt(client, { status: "running", generation: 1 });

    const first = await revokeGeneration(client, attemptId, 1);
    assert.ok(first.ok, "First revoke should succeed");

    // Retry with the original expected generation (now stale)
    const second = await revokeGeneration(client, attemptId, 1);
    assert.ok(!second.ok, "Second revoke should fail");
    if (!second.ok) {
      assert.equal(second.reason, "stale_generation");
      assert.equal(second.current, 2);
    }
  });
});

test("revokeGeneration: not_found for unknown attemptId", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const result = await revokeGeneration(client, "nonexistent-attempt-id", 1);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.reason, "not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// confirmStopped tests
// ---------------------------------------------------------------------------

test("confirmStopped: survivorsConfirmedGone=true → stopped", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const attemptId = await seedAttempt(client, { status: "stopping", generation: 2 });

    const result = await confirmStopped(client, attemptId, 2, {
      survivorsConfirmedGone: true,
      checkpointCommit: "sha-abc",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.status, "stopped");
    }

    // Verify DB state
    const { rows } = await client.query<{ status: string; checkpoint_commit: string }>(
      `SELECT status, checkpoint_commit FROM attempts WHERE id = $1`,
      [attemptId],
    );
    assert.equal(rows.at(0)?.status, "stopped");
    assert.equal(rows.at(0)?.checkpoint_commit, "sha-abc");
  });
});

test("confirmStopped: survivorsConfirmedGone=false → uncertain", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const attemptId = await seedAttempt(client, { status: "stopping", generation: 1 });

    const result = await confirmStopped(client, attemptId, 1, {
      survivorsConfirmedGone: false,
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.status, "uncertain");
    }
  });
});

test("confirmStopped: stale generation → stale_generation", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const attemptId = await seedAttempt(client, { status: "stopping", generation: 3 });

    const result = await confirmStopped(client, attemptId, 2, {
      survivorsConfirmedGone: true,
    });
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.reason, "stale_generation");
    }
  });
});

test("confirmStopped: non-stopping status → state_mismatch", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const attemptId = await seedAttempt(client, { status: "running", generation: 1 });

    const result = await confirmStopped(client, attemptId, 1, {
      survivorsConfirmedGone: true,
    });
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.reason, "state_mismatch");
    }
  });
});
