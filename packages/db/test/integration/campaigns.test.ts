/**
 * Integration tests: campaigns, authority_versions, and work-item rank/campaign
 * functions (migration 0004).
 *
 * Requires DATABASE_URL pointing to the test Postgres instance.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import type pg from "pg";
import {
  insertAuthorityVersion,
  listAuthorityVersions,
} from "../../src/repos/authority-versions.ts";
import {
  assignWorkItemToCampaign,
  getCampaign,
  insertCampaign,
  listCampaigns,
  setMainEffort,
} from "../../src/repos/campaigns.ts";
import { insertDecision } from "../../src/repos/decisions.ts";
import { insertProject } from "../../src/repos/projects.ts";
import { insertWorkItem, setWorkItemRank } from "../../src/repos/work-items.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedProject(client: pg.PoolClient, id: string) {
  return insertProject(client, {
    id,
    remote: null,
    clone_path: null,
    worktree_base: null,
    allowed_refs: null,
    profile_catalog: null,
    authority: HOST_TRIAL_AUTHORITY,
    authority_version: "1",
  });
}

async function seedWorkItem(
  client: pg.PoolClient,
  id: string,
  projectId: string,
  opts?: { rank?: number; campaignId?: string },
) {
  const row = await insertWorkItem(client, {
    id,
    project_id: projectId,
    rank: opts?.rank ?? 1,
    intent: "test intent",
    boundary: "artifact",
    lifecycle: "active",
    condition: "open",
  });
  if (opts?.campaignId) {
    await assignWorkItemToCampaign(client, id, opts.campaignId);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Migration 0004: tables exist
// ---------------------------------------------------------------------------

test("migration 0004: campaigns and authority_versions tables exist", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    for (const table of ["campaigns", "authority_versions"]) {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      );
      assert.equal(rows.length, 1, `Expected table '${table}' to exist`);
    }
  });
});

test("migration 0004: work_items gains campaign_id column", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'work_items' AND column_name = 'campaign_id'`,
      [schema],
    );
    assert.equal(rows.length, 1, "work_items should have campaign_id column");
    assert.equal(rows[0]?.is_nullable, "YES", "campaign_id should be nullable");
  });
});

test("migration 0004: work_items_campaign_id_idx index exists", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'work_items' AND indexname = 'work_items_campaign_id_idx'`,
      [schema],
    );
    assert.equal(rows.length, 1, "Index work_items_campaign_id_idx should exist");
  });
});

test("migration 0004: idempotent — running migration SQL twice does not throw", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pgMod = await import("pg");
    const escapedSchema = pgMod.default.escapeIdentifier(schema);

    const migrationsDir = resolve(fileURLToPath(import.meta.url), "../../../migrations");
    const sql = await readFile(resolve(migrationsDir, "0004_campaigns.sql"), "utf8");

    await client.query(`SET search_path TO ${escapedSchema}, public`);
    await client.query(sql); // already applied; should be a no-op
  });
});

// ---------------------------------------------------------------------------
// campaigns repo
// ---------------------------------------------------------------------------

test("campaigns: insertCampaign round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const row = await insertCampaign(client, { id: "camp-1", name: "Campaign One" });
    assert.equal(row.id, "camp-1");
    assert.equal(row.name, "Campaign One");
    assert.equal(row.main_effort_work_item_id, null);
  });
});

test("campaigns: getCampaign returns null for unknown id", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const row = await getCampaign(client, "no-such-campaign");
    assert.equal(row, null);
  });
});

test("campaigns: listCampaigns returns all rows", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertCampaign(client, { id: "camp-list-1", name: "A" });
    await insertCampaign(client, { id: "camp-list-2", name: "B" });
    const rows = await listCampaigns(client);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("camp-list-1"));
    assert.ok(ids.includes("camp-list-2"));
  });
});

// ---------------------------------------------------------------------------
// setMainEffort
// ---------------------------------------------------------------------------

test("setMainEffort: sets main effort when work item belongs to campaign", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-me-1");
    await insertCampaign(client, { id: "camp-me-1", name: "Main Effort Test" });
    await seedWorkItem(client, "wi-me-1", "proj-me-1", { campaignId: "camp-me-1" });

    const result = await setMainEffort(client, "camp-me-1", "wi-me-1");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.row.main_effort_work_item_id, "wi-me-1");
    }
  });
});

test("setMainEffort: clears main effort when workItemId is null", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-me-clear-1");
    await insertCampaign(client, { id: "camp-me-clear-1", name: "Clear ME" });
    await seedWorkItem(client, "wi-me-clear-1", "proj-me-clear-1", {
      campaignId: "camp-me-clear-1",
    });
    await setMainEffort(client, "camp-me-clear-1", "wi-me-clear-1");

    const result = await setMainEffort(client, "camp-me-clear-1", null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.row.main_effort_work_item_id, null);
    }
  });
});

test("setMainEffort: rejects work item from another campaign", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-me-guard-1");
    await insertCampaign(client, { id: "camp-me-guard-a", name: "Campaign A" });
    await insertCampaign(client, { id: "camp-me-guard-b", name: "Campaign B" });
    // Assign wi to camp-a only
    await seedWorkItem(client, "wi-me-guard-1", "proj-me-guard-1", {
      campaignId: "camp-me-guard-a",
    });

    // Try to set as main effort of camp-b → should fail
    const result = await setMainEffort(client, "camp-me-guard-b", "wi-me-guard-1");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "work_item_not_in_campaign");
    }
  });
});

test("setMainEffort: rejects work item not assigned to any campaign", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-me-nocamp-1");
    await insertCampaign(client, { id: "camp-me-nocamp-1", name: "No Camp" });
    await seedWorkItem(client, "wi-me-nocamp-1", "proj-me-nocamp-1"); // no campaignId

    const result = await setMainEffort(client, "camp-me-nocamp-1", "wi-me-nocamp-1");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "work_item_not_in_campaign");
    }
  });
});

// ---------------------------------------------------------------------------
// assignWorkItemToCampaign
// ---------------------------------------------------------------------------

test("assignWorkItemToCampaign: sets campaign_id on work item", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-assign-1");
    await insertCampaign(client, { id: "camp-assign-1", name: "Assign Test" });
    await seedWorkItem(client, "wi-assign-1", "proj-assign-1");

    const updated = await assignWorkItemToCampaign(client, "wi-assign-1", "camp-assign-1");
    assert.ok(updated);
    assert.equal(updated?.campaign_id, "camp-assign-1");
  });
});

test("assignWorkItemToCampaign: returns null for unknown work item", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertCampaign(client, { id: "camp-assign-null-1", name: "X" });
    const result = await assignWorkItemToCampaign(client, "no-such-wi", "camp-assign-null-1");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// setWorkItemRank
// ---------------------------------------------------------------------------

test("setWorkItemRank: applied when version matches", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-rank-1");
    const wi = await insertWorkItem(client, {
      id: "wi-rank-1",
      project_id: "proj-rank-1",
      rank: 5,
      intent: "test",
      boundary: "artifact",
      lifecycle: "active",
      condition: "open",
      version: 1,
    });

    const result = await setWorkItemRank(client, "wi-rank-1", 10, wi.version);
    assert.equal(result, "applied");

    // Verify rank updated and version bumped.
    const { rows } = await client.query<{ rank: number; version: number }>(
      "SELECT rank, version FROM work_items WHERE id = $1",
      ["wi-rank-1"],
    );
    assert.equal(rows[0]?.rank, 10);
    assert.equal(rows[0]?.version, wi.version + 1);
  });
});

test("setWorkItemRank: stale when version does not match", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-rank-stale-1");
    await insertWorkItem(client, {
      id: "wi-rank-stale-1",
      project_id: "proj-rank-stale-1",
      rank: 1,
      intent: "test",
      boundary: "artifact",
      lifecycle: "active",
      condition: "open",
      version: 1,
    });

    // Pass wrong expectedVersion.
    const result = await setWorkItemRank(client, "wi-rank-stale-1", 99, 99);
    assert.equal(result, "stale");

    // Rank unchanged.
    const { rows } = await client.query<{ rank: number }>(
      "SELECT rank FROM work_items WHERE id = $1",
      ["wi-rank-stale-1"],
    );
    assert.equal(rows[0]?.rank, 1);
  });
});

// ---------------------------------------------------------------------------
// authority_versions repo
// ---------------------------------------------------------------------------

test("authority_versions: insertAuthorityVersion round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-av-1");

    const result = await insertAuthorityVersion(client, {
      project_id: "proj-av-1",
      version: "v1",
      authority: HOST_TRIAL_AUTHORITY,
      actor: "operator",
    });

    assert.equal(result.status, "inserted");
    assert.equal(result.row.project_id, "proj-av-1");
    assert.equal(result.row.version, "v1");
    assert.equal(result.row.actor, "operator");
  });
});

test("authority_versions: insertAuthorityVersion idempotent on (project_id, version)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-av-idem-1");

    await insertAuthorityVersion(client, {
      project_id: "proj-av-idem-1",
      version: "v1",
      authority: HOST_TRIAL_AUTHORITY,
      actor: "operator",
    });

    // Second insert with same (project_id, version) → existing
    const second = await insertAuthorityVersion(client, {
      project_id: "proj-av-idem-1",
      version: "v1",
      authority: { different: true },
      actor: "other",
    });

    assert.equal(second.status, "existing");
    // Original data preserved
    assert.equal(second.row.actor, "operator");
  });
});

test("authority_versions: listAuthorityVersions returns rows ordered by at", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-av-list-1");

    await insertAuthorityVersion(client, {
      project_id: "proj-av-list-1",
      version: "v1",
      authority: HOST_TRIAL_AUTHORITY,
      actor: "op1",
    });
    await insertAuthorityVersion(client, {
      project_id: "proj-av-list-1",
      version: "v2",
      authority: HOST_TRIAL_AUTHORITY,
      actor: "op2",
    });

    const rows = await listAuthorityVersions(client, "proj-av-list-1");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.version, "v1");
    assert.equal(rows[1]?.version, "v2");
  });
});

// ---------------------------------------------------------------------------
// decisions: new kinds insert successfully (free-text, no CHECK constraint)
// ---------------------------------------------------------------------------

test("decisions: insert with kind=authority_update succeeds", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const row = await insertDecision(client, {
      id: "dec-authority-update-1",
      kind: "authority_update",
      actor: "operator",
      at: new Date(),
    });
    assert.equal(row.kind, "authority_update");
  });
});

test("decisions: insert with kind=reject succeeds", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const row = await insertDecision(client, {
      id: "dec-reject-1",
      kind: "reject",
      actor: "coordinator",
      at: new Date(),
    });
    assert.equal(row.kind, "reject");
  });
});

test("decisions: insert with kind=invalidate succeeds", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const row = await insertDecision(client, {
      id: "dec-invalidate-1",
      kind: "invalidate",
      actor: "coordinator",
      at: new Date(),
    });
    assert.equal(row.kind, "invalidate");
  });
});

// ---------------------------------------------------------------------------
// migrate.test coverage: new tables appear in the expected-tables list
// ---------------------------------------------------------------------------

test("migration 0004: campaigns and authority_versions are in the schema", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema],
    );
    const names = rows.map((r) => r.table_name);
    assert.ok(names.includes("campaigns"), "campaigns table should exist");
    assert.ok(names.includes("authority_versions"), "authority_versions table should exist");
  });
});
