export const PACKAGE_NAME = "@agencyhq/db";

export { createPool, withSchema, withTransaction } from "./client.ts";
// Repositories, fencing, and the decision-then-dispatch unit of work (wave 2.3)
export * from "./fencing.ts";
export type { MigrateOptions, MigrateResult } from "./migrate.ts";
export { runMigrations } from "./migrate.ts";
export * from "./repos/index.ts";
export * from "./rows.ts";
export type { TestDbContext } from "./testing/test-db.ts";
export { withTestSchema } from "./testing/test-db.ts";
export * from "./unit-of-work.ts";
