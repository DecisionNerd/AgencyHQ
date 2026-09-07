/**
 * CLI entry point for running migrations.
 * Usage: node --env-file=../../.env src/migrate-cli.ts
 */
import pg from "pg";
import { runMigrations } from "./migrate.ts";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL environment variable is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const result = await runMigrations(client);
  if (result.applied.length === 0) {
    console.log("No new migrations to apply.");
  } else {
    for (const name of result.applied) {
      console.log(`Applied: ${name}`);
    }
  }
} finally {
  await client.end();
}
