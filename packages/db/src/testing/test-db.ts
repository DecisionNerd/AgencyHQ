/**
 * Per-test schema helper for integration tests.
 * Creates an isolated Postgres schema for each test and drops it afterwards.
 */
import type { TestContext } from "node:test";
import pg from "pg";
import { runMigrations } from "../migrate.ts";

let counter = 0;

export interface TestDbContext {
  client: pg.PoolClient;
  schema: string;
}

/**
 * Run fn inside a fresh Postgres schema.
 *
 * - If DATABASE_URL is unset, logs a warning and calls t.skip().
 * - Creates schema `agencyhq_t_<pid>_<n>`, runs migrations into it.
 * - Drops the schema (cascade) in finally, so the DB stays clean.
 */
export async function withTestSchema(
  t: TestContext,
  fn: (ctx: TestDbContext) => Promise<void>,
): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.warn("[db] DATABASE_URL unset; skipping integration test");
    t.skip("DATABASE_URL is not set");
    return;
  }

  const schema = `agencyhq_t_${process.pid}_${++counter}`;
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    // Create the schema
    await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);

    // Run migrations into the isolated schema
    await runMigrations(client, { schema });

    await fn({ client, schema });
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
    } catch {
      // best-effort cleanup
    }
    client.release();
    await pool.end();
  }
}
