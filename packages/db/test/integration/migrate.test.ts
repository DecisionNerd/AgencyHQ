import assert from "node:assert/strict";
import test from "node:test";
import { runMigrations } from "../../src/migrate.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

test("migrations apply into a fresh schema", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    // Migrations already ran inside withTestSchema.
    // Verify all expected tables exist.
    const expectedTables = [
      "projects",
      "work_items",
      "step_contracts",
      "attempts",
      "dispatch_intents",
      "artifacts",
      "verification_results",
      "reviews",
      "decisions",
      "approvals",
      "findings",
      "failures",
      "transitions",
      "commands",
      "run_observations",
      "schema_migrations",
    ];

    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema],
    );

    const tableNames = rows.map((r) => r.table_name).sort();

    for (const expected of expectedTables) {
      assert.ok(
        tableNames.includes(expected),
        `Expected table '${expected}' to exist in schema '${schema}'. Found: ${tableNames.join(", ")}`,
      );
    }
  });
});

test("second runMigrations call applies nothing (idempotent)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    // Run migrations again — should be a no-op
    const result = await runMigrations(client);
    assert.deepEqual(result.applied, []);
  });
});

test("duplicate (run_id, generation) insert into run_observations violates primary key", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const runId = "run-test-1";
    const generation = 1;

    await client.query(
      `INSERT INTO run_observations (run_id, generation, stale, payload)
       VALUES ($1, $2, false, '{}')`,
      [runId, generation],
    );

    try {
      await client.query(
        `INSERT INTO run_observations (run_id, generation, stale, payload)
         VALUES ($1, $2, false, '{}')`,
        [runId, generation],
      );
      assert.fail("Expected a primary key violation error (23505)");
    } catch (err) {
      const pgErr = err as { code?: string };
      assert.equal(pgErr.code, "23505", `Expected error code 23505 but got: ${pgErr.code}`);
    }
  });
});
