/**
 * Extended test schema helper for control-plane integration tests.
 *
 * Migration 0004 tables (campaigns, work_items.campaign_id, authority_versions)
 * are added here because migration 0004 is being created in a parallel packet.
 * This helper wraps withTestSchema and applies the additional DDL into the same
 * isolated schema so integration tests can exercise the new commands.
 *
 * Once migration 0004 lands in packages/db/migrations, this helper can be
 * deleted and tests can use withTestSchema directly.
 */

import type { TestContext } from "node:test";
import type { TestDbContext } from "@agencyhq/db";
import { withTestSchema } from "@agencyhq/db";
import pg from "pg";

// ---------------------------------------------------------------------------
// DDL for migration 0004 tables (added to test schema only — never to packages/db)
// ---------------------------------------------------------------------------

const MIGRATION_0004_DDL = `
-- campaigns table (migration 0004)
CREATE TABLE IF NOT EXISTS campaigns (
  id                       text primary key,
  name                     text not null,
  main_effort_work_item_id text references work_items(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Add campaign_id column to work_items (migration 0004)
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS campaign_id text references campaigns(id);

-- authority_versions table (migration 0004)
CREATE TABLE IF NOT EXISTS authority_versions (
  project_id  text not null references projects(id),
  version     text not null,
  authority   jsonb not null,
  actor       text not null,
  at          timestamptz not null default now(),
  primary key (project_id, version)
);
`;

// ---------------------------------------------------------------------------
// withControlPlaneSchema
// ---------------------------------------------------------------------------

/**
 * Run fn inside a fresh Postgres schema that includes both the base migrations
 * (via withTestSchema) and the migration-0004 DDL for campaigns and authority.
 *
 * Useful for testing reject, invalidate_acceptance, campaign, and authority commands.
 */
export async function withControlPlaneSchema(
  t: TestContext,
  fn: (ctx: TestDbContext) => Promise<void>,
): Promise<void> {
  await withTestSchema(t, async (ctx) => {
    // Apply migration 0004 DDL into the isolated schema
    await ctx.client.query(MIGRATION_0004_DDL);
    await fn(ctx);
  });
}
