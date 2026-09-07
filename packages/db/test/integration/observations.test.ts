/**
 * Integration tests for applyObservation and observation repo functions.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type pg from "pg";
import { applyObservation } from "../../src/fencing.ts";
import { latestObservation, listObservations } from "../../src/repos/observations.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

async function seedAttempt(
  client: pg.PoolClient,
  opts: { status?: string; generation?: number } = {},
): Promise<{ attemptId: string; runId: string }> {
  const projectId = `proj-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const contractId = `sc-${randomUUID()}`;
  const attemptId = `att-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;

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

  return { attemptId, runId };
}

// ---------------------------------------------------------------------------
// applyObservation tests
// ---------------------------------------------------------------------------

test("applyObservation: first delivery returns applied", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { attemptId, runId } = await seedAttempt(client, { generation: 1 });

    const result = await applyObservation(client, {
      runId,
      generation: 1,
      attemptId,
      status: "completed",
      payload: { outcome: "success" },
      observedAt: new Date(),
    });

    assert.equal(result, "applied");
  });
});

test("applyObservation: same (runId, generation) twice → applied then duplicate", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { attemptId, runId } = await seedAttempt(client, { generation: 1 });

    const obs = {
      runId,
      generation: 1,
      attemptId,
      status: "completed",
      payload: { outcome: "success" },
      observedAt: new Date(),
    };

    const first = await applyObservation(client, obs);
    assert.equal(first, "applied");

    const second = await applyObservation(client, obs);
    assert.equal(second, "duplicate");
  });
});

test("applyObservation: observation carrying old generation after revoke → stale; row marked stale=true", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { attemptId, runId } = await seedAttempt(client, { generation: 2 });

    // Apply an observation with generation 1 (old) when attempt is at generation 2
    const result = await applyObservation(client, {
      runId,
      generation: 1,
      attemptId,
      status: "completed",
      payload: { outcome: "stale" },
      observedAt: new Date(),
    });

    assert.equal(result, "stale");

    // Verify the DB row is marked stale
    const { rows } = await client.query<{ stale: boolean }>(
      `SELECT stale FROM run_observations WHERE run_id = $1 AND generation = 1`,
      [runId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows.at(0)?.stale, true);
  });
});

test("applyObservation: new-generation observation after revoke → applied", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { attemptId, runId } = await seedAttempt(client, { generation: 2 });

    const result = await applyObservation(client, {
      runId,
      generation: 2,
      attemptId,
      status: "completed",
      payload: { outcome: "success" },
      observedAt: new Date(),
    });

    assert.equal(result, "applied");

    // Verify the row is NOT stale
    const { rows } = await client.query<{ stale: boolean }>(
      `SELECT stale FROM run_observations WHERE run_id = $1 AND generation = 2`,
      [runId],
    );
    assert.equal(rows.at(0)?.stale, false);
  });
});

// ---------------------------------------------------------------------------
// Repo function tests
// ---------------------------------------------------------------------------

test("listObservations: returns all observations ordered by generation", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { runId } = await seedAttempt(client, { generation: 3 });

    // Insert a few observations manually
    for (const gen of [1, 2, 3]) {
      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload)
         VALUES ($1, $2, $3, '{}')`,
        [runId, gen, gen < 3],
      );
    }

    const observations = await listObservations(client, runId);
    assert.equal(observations.length, 3);
    assert.equal(observations.at(0)?.generation, 1);
    assert.equal(observations.at(1)?.generation, 2);
    assert.equal(observations.at(2)?.generation, 3);
    assert.equal(observations.at(0)?.stale, true);
    assert.equal(observations.at(2)?.stale, false);
  });
});

test("latestObservation: returns specific observation by generation", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { runId } = await seedAttempt(client);

    await client.query(
      `INSERT INTO run_observations (run_id, generation, stale, payload)
       VALUES ($1, 1, false, '{"status": "done"}')`,
      [runId],
    );

    const obs = await latestObservation(client, runId, 1);
    assert.ok(obs !== null);
    assert.equal(obs.run_id, runId);
    assert.equal(obs.generation, 1);
    assert.equal(obs.stale, false);
  });
});

test("latestObservation: returns null when not found", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const obs = await latestObservation(client, "nonexistent-run", 1);
    assert.equal(obs, null);
  });
});
