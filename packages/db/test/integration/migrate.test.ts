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

    // Verify that 0002_ledger_not_null.sql was applied and its NOT NULL
    // constraints are in place.
    const notNullChecks: Array<[string, string]> = [
      ["findings", "severity"],
      ["findings", "kind"],
      ["findings", "description"],
      ["decisions", "kind"],
      ["decisions", "actor"],
      ["failures", "class"],
      ["failures", "phase"],
      ["failures", "cause"],
      ["reviews", "reviewer_model"],
      ["reviews", "profile"],
      ["commands", "kind"],
    ];

    for (const [table, column] of notNullChecks) {
      const { rows: colRows } = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, table, column],
      );
      assert.equal(
        colRows[0]?.is_nullable,
        "NO",
        `Expected ${table}.${column} to be NOT NULL after migration 0002`,
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

test("0002 migration SQL is safe to re-execute (idempotent DO blocks)", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    // Re-apply the 0002 migration SQL directly — the DO blocks should skip
    // the ALTER TABLE statements because the columns are already NOT NULL.
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pgMod = await import("pg");
    const escapedSchema = pgMod.default.escapeIdentifier(schema);

    const migrationsDir = resolve(
      fileURLToPath(import.meta.url),
      "../../../migrations",
    );
    const sql = await readFile(resolve(migrationsDir, "0002_ledger_not_null.sql"), "utf8");

    // Should not throw — DO blocks check is_nullable before altering.
    await client.query(`SET search_path TO ${escapedSchema}, public`);
    await client.query(sql);
  });
});

test("insert into findings without kind is rejected (not-null violation)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    try {
      // Omit kind — should violate the NOT NULL constraint added by 0002.
      await client.query(
        `INSERT INTO findings (id, severity, description) VALUES ($1, $2, $3)`,
        ["fnd-no-kind", "blocking", "test finding without kind"],
      );
      assert.fail("Expected a not-null violation (23502) for findings.kind");
    } catch (err) {
      const pgErr = err as { code?: string };
      assert.equal(
        pgErr.code,
        "23502",
        `Expected error code 23502 (not_null_violation) but got: ${pgErr.code}`,
      );
    }
  });
});

test("insert into decisions without actor is rejected (not-null violation)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    try {
      // Omit actor — should violate the NOT NULL constraint added by 0002.
      await client.query(
        `INSERT INTO decisions (id, kind, at) VALUES ($1, $2, $3)`,
        ["dec-no-actor", "plan", new Date()],
      );
      assert.fail("Expected a not-null violation (23502) for decisions.actor");
    } catch (err) {
      const pgErr = err as { code?: string };
      assert.equal(
        pgErr.code,
        "23502",
        `Expected error code 23502 (not_null_violation) but got: ${pgErr.code}`,
      );
    }
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
