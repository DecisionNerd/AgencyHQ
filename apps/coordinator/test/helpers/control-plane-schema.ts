/**
 * Thin wrapper over withTestSchema for control-plane integration tests.
 *
 * Migration 0004 (campaigns, work_items.campaign_id, authority_versions) is
 * now part of the packages/db migration set, so withTestSchema runs it via
 * runMigrations. This file is kept as a named re-export so existing test
 * imports require no changes.
 */

export type { TestDbContext } from "@agencyhq/db";
export { withTestSchema as withControlPlaneSchema } from "@agencyhq/db";
