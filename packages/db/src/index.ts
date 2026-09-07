export const PACKAGE_NAME = "@agencyhq/db";

export { createPool, withSchema, withTransaction } from "./client.ts";
export type { MigrateOptions, MigrateResult } from "./migrate.ts";
export { runMigrations } from "./migrate.ts";
export * from "./rows.ts";
export type { TestDbContext } from "./testing/test-db.ts";
export { withTestSchema } from "./testing/test-db.ts";
