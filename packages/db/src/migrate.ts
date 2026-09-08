import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DEFAULT_MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), "../../migrations");

export interface MigrateOptions {
  /** Postgres schema to run migrations in (defaults to search_path). */
  schema?: string;
  /** Directory containing *.sql migration files. */
  dir?: string;
}

export interface MigrateResult {
  applied: string[];
}

/**
 * Run all unapplied migrations from the given directory.
 *
 * - Acquires pg_advisory_lock so concurrent runners don't race.
 * - Ensures schema_migrations table exists.
 * - Reads *.sql files sorted lexicographically, applies each unapplied one in its own transaction.
 * - Idempotent: safe to call multiple times.
 */
export async function runMigrations(
  client: pg.PoolClient | pg.Client,
  opts?: MigrateOptions,
): Promise<MigrateResult> {
  const dir = opts?.dir ?? DEFAULT_MIGRATIONS_DIR;
  const schema = opts?.schema;

  // Advisory lock scoped to 'agencyhq_migrations'
  await client.query("SELECT pg_advisory_lock(hashtext('agencyhq_migrations'))");

  try {
    // Set search_path if schema provided
    if (schema) {
      await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);
    }

    // Ensure the schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    // Load already-applied migrations
    const { rows: appliedRows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    const applied = new Set(appliedRows.map((r) => r.name));

    // Read migration files sorted
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const sql = await readFile(join(dir, file), "utf8");

      // Each migration runs in its own transaction
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        newlyApplied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    return { applied: newlyApplied };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('agencyhq_migrations'))");
  }
}
