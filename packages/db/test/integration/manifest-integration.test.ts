/**
 * Integration tests: work_item_projects and integrations repos (migration 0003).
 * Requires DATABASE_URL pointing to the test Postgres instance.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import type pg from "pg";
import { insertAttempt } from "../../src/repos/attempts.ts";
import {
  finalizeIntegration,
  getIntegrationByAttempt,
  insertIntegration,
  listIntegrationsByAttempt,
} from "../../src/repos/integrations.ts";
import { insertProject } from "../../src/repos/projects.ts";
import { insertStepContract } from "../../src/repos/step-contracts.ts";
import {
  insertWorkItemProjects,
  listWorkItemProjects,
  setResultRevision,
} from "../../src/repos/work-item-projects.ts";
import { insertWorkItem } from "../../src/repos/work-items.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const BOUNDS = {
  paths: { allow: ["src/**"], deny: [] },
  capabilities: {
    bash: { allow: ["pnpm test"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundary: "artifact" as const,
  budget: { maxAttempts: 2, maxDurationSeconds: 300, estimatedSpendUsd: 1 },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "test-worker", reviewer: "test-reviewer" },
};

const CRITERION = { id: "c1", text: "compiles", source: "operator" as const };

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

async function seedWorkItem(client: pg.PoolClient, id: string, projectId: string) {
  return insertWorkItem(client, {
    id,
    project_id: projectId,
    rank: 1,
    intent: "test intent",
    boundary: "artifact",
    lifecycle: "active",
    condition: "open",
  });
}

async function seedContract(
  client: pg.PoolClient,
  id: string,
  workItemId: string,
  projectId: string,
) {
  return insertStepContract(client, {
    id,
    work_item_id: workItemId,
    project_id: projectId,
    version: 1,
    base_revision: "abc1234",
    inputs: {},
    criteria: [CRITERION],
    criteria_digest: DIGEST,
    profile_id: "p1",
    profile_digest: DIGEST,
    bounds: BOUNDS,
    required_boundaries: [],
    human_required: false,
    status: "active",
  });
}

async function seedAttempt(client: pg.PoolClient, id: string, contractId: string) {
  return insertAttempt(client, {
    id,
    contract_id: contractId,
    contract_version: 1,
    generation: 1,
    status: "admitted",
    budget_remaining: 2,
  });
}

// ---------------------------------------------------------------------------
// migration 0003: new tables exist
// ---------------------------------------------------------------------------

test("migration 0003: work_item_projects and integrations tables exist", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    for (const table of ["work_item_projects", "integrations"]) {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      );
      assert.equal(rows.length, 1, `Expected table '${table}' to exist`);
    }
  });
});

test("migration 0003: step_contracts gains target_ref and manifest_digest columns", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    for (const col of ["target_ref", "manifest_digest"]) {
      const { rows } = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'step_contracts' AND column_name = $2`,
        [schema, col],
      );
      assert.equal(rows.length, 1, `step_contracts should have column '${col}'`);
      assert.equal(rows[0]?.is_nullable, "YES", `${col} should be nullable`);
    }
  });
});

test("migration 0003: idempotent — running migration SQL twice does not throw", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const pgMod = await import("pg");
    const escapedSchema = pgMod.default.escapeIdentifier(schema);

    const migrationsDir = resolve(fileURLToPath(import.meta.url), "../../../migrations");
    const sql = await readFile(resolve(migrationsDir, "0003_manifest_integration.sql"), "utf8");

    // Already applied by withTestSchema; re-applying should be a no-op.
    await client.query(`SET search_path TO ${escapedSchema}, public`);
    await client.query(sql);
  });
});

// ---------------------------------------------------------------------------
// work_item_projects
// ---------------------------------------------------------------------------

test("work_item_projects: insertWorkItemProjects returns rows in insertion order", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-wip-1");
    await seedWorkItem(client, "wi-wip-1", "proj-wip-1");

    const entries = [
      { project_id: "proj-wip-1", position: 0, target_ref: "main", expected_base_revision: "rev0" },
    ];
    const rows = await insertWorkItemProjects(client, "wi-wip-1", entries);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.work_item_id, "wi-wip-1");
    assert.equal(rows[0]?.position, 0);
    assert.equal(rows[0]?.target_ref, "main");
    assert.equal(rows[0]?.result_revision, null);
  });
});

test("work_item_projects: listWorkItemProjects returns rows ordered by position", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-wip-order-1");
    await seedProject(client, "proj-wip-order-2");
    await seedWorkItem(client, "wi-order-1", "proj-wip-order-1");

    // Insert out-of-order so we can verify sorting.
    await client.query(
      `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)`,
      ["wi-order-1", "proj-wip-order-2", 2, "main", "rev2"],
    );
    await client.query(
      `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)`,
      ["wi-order-1", "proj-wip-order-1", 1, "main", "rev1"],
    );

    const rows = await listWorkItemProjects(client, "wi-order-1");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.position, 1);
    assert.equal(rows[1]?.position, 2);
  });
});

test("work_item_projects: unique (work_item_id, project_id) constraint is enforced", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-uniq-1");
    await seedWorkItem(client, "wi-uniq-1", "proj-uniq-1");

    await client.query(
      `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)`,
      ["wi-uniq-1", "proj-uniq-1", 1, "main", "rev1"],
    );

    try {
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, $3, $4, $5)`,
        ["wi-uniq-1", "proj-uniq-1", 2, "main", "rev1"],
      );
      assert.fail("Expected unique violation (23505)");
    } catch (err) {
      const pgErr = err as { code?: string };
      assert.equal(pgErr.code, "23505", `Expected 23505 but got: ${pgErr.code}`);
    }
  });
});

test("work_item_projects: primary key (work_item_id, position) constraint is enforced", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-pk-1");
    await seedProject(client, "proj-pk-2");
    await seedWorkItem(client, "wi-pk-1", "proj-pk-1");

    await client.query(
      `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)`,
      ["wi-pk-1", "proj-pk-1", 1, "main", "rev1"],
    );

    try {
      await client.query(
        `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
         VALUES ($1, $2, $3, $4, $5)`,
        ["wi-pk-1", "proj-pk-2", 1, "main", "rev2"],
      );
      assert.fail("Expected primary key violation (23505)");
    } catch (err) {
      const pgErr = err as { code?: string };
      assert.equal(pgErr.code, "23505", `Expected 23505 but got: ${pgErr.code}`);
    }
  });
});

test("work_item_projects: setResultRevision first call returns applied", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-srr-1");
    await seedWorkItem(client, "wi-srr-1", "proj-srr-1");
    await client.query(
      `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)`,
      ["wi-srr-1", "proj-srr-1", 1, "main", "rev1"],
    );

    const result = await setResultRevision(client, "wi-srr-1", 1, "rev-merged");
    assert.equal(result, "applied");

    const rows = await listWorkItemProjects(client, "wi-srr-1");
    assert.equal(rows[0]?.result_revision, "rev-merged");
  });
});

test("work_item_projects: setResultRevision second call returns already_set", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-srr2-1");
    await seedWorkItem(client, "wi-srr2-1", "proj-srr2-1");
    await client.query(
      `INSERT INTO work_item_projects (work_item_id, project_id, position, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5)`,
      ["wi-srr2-1", "proj-srr2-1", 1, "main", "rev1"],
    );

    await setResultRevision(client, "wi-srr2-1", 1, "rev-merged");
    const second = await setResultRevision(client, "wi-srr2-1", 1, "rev-other");
    assert.equal(second, "already_set");

    // Value unchanged.
    const rows = await listWorkItemProjects(client, "wi-srr2-1");
    assert.equal(rows[0]?.result_revision, "rev-merged");
  });
});

test("work_item_projects: empty entries array returns empty result", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-empty-1");
    await seedWorkItem(client, "wi-empty-1", "proj-empty-1");

    const rows = await insertWorkItemProjects(client, "wi-empty-1", []);
    assert.equal(rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// integrations
// ---------------------------------------------------------------------------

test("integrations: insertIntegration round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-int-1");
    await seedWorkItem(client, "wi-int-1", "proj-int-1");
    await seedContract(client, "sc-int-1", "wi-int-1", "proj-int-1");
    await seedAttempt(client, "att-int-1", "sc-int-1");

    const result = await insertIntegration(client, {
      id: "intg-1",
      attempt_id: "att-int-1",
      contract_id: "sc-int-1",
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: "rev-base",
    });

    assert.equal(result.status, "inserted");
    assert.equal(result.row.id, "intg-1");
    assert.equal(result.row.target_ref, "main");
    assert.equal(result.row.outcome, null);
    assert.equal(result.row.resulting_revision, null);
  });
});

test("integrations: insertIntegration twice returns existing on second call", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-int-dup-1");
    await seedWorkItem(client, "wi-int-dup-1", "proj-int-dup-1");
    await seedContract(client, "sc-int-dup-1", "wi-int-dup-1", "proj-int-dup-1");
    await seedAttempt(client, "att-int-dup-1", "sc-int-dup-1");

    await insertIntegration(client, {
      id: "intg-dup-1",
      attempt_id: "att-int-dup-1",
      contract_id: "sc-int-dup-1",
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: "rev-base",
    });

    const second = await insertIntegration(client, {
      id: "intg-dup-2", // different id
      attempt_id: "att-int-dup-1",
      contract_id: "sc-int-dup-1",
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: "rev-base",
    });

    assert.equal(second.status, "existing");
    assert.equal(second.row.id, "intg-dup-1"); // original id preserved

    // Exactly one row in the DB.
    const { rows: dbRows } = await client.query(
      `SELECT * FROM integrations WHERE attempt_id = $1`,
      ["att-int-dup-1"],
    );
    assert.equal(dbRows.length, 1);
  });
});

test("integrations: unique (attempt_id, target_ref, expected_base_revision) constraint", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-int-uniq-1");
    await seedWorkItem(client, "wi-int-uniq-1", "proj-int-uniq-1");
    await seedContract(client, "sc-int-uniq-1", "wi-int-uniq-1", "proj-int-uniq-1");
    await seedAttempt(client, "att-int-uniq-1", "sc-int-uniq-1");

    await client.query(
      `INSERT INTO integrations (id, attempt_id, contract_id, contract_version, target_ref, expected_base_revision)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["intg-u1", "att-int-uniq-1", "sc-int-uniq-1", 1, "main", "revX"],
    );

    try {
      await client.query(
        `INSERT INTO integrations (id, attempt_id, contract_id, contract_version, target_ref, expected_base_revision)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["intg-u2", "att-int-uniq-1", "sc-int-uniq-1", 1, "main", "revX"],
      );
      assert.fail("Expected unique violation (23505)");
    } catch (err) {
      const pgErr = err as { code?: string };
      assert.equal(pgErr.code, "23505", `Expected 23505 but got: ${pgErr.code}`);
    }
  });
});

test("integrations: finalizeIntegration first call returns applied", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-fin-1");
    await seedWorkItem(client, "wi-fin-1", "proj-fin-1");
    await seedContract(client, "sc-fin-1", "wi-fin-1", "proj-fin-1");
    await seedAttempt(client, "att-fin-1", "sc-fin-1");

    await insertIntegration(client, {
      id: "intg-fin-1",
      attempt_id: "att-fin-1",
      contract_id: "sc-fin-1",
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: "rev-base",
    });

    const result = await finalizeIntegration(client, "intg-fin-1", {
      outcome: "success",
      resultingRevision: "rev-merged",
      runId: "run-abc",
    });
    assert.equal(result, "applied");

    // Verify fields persisted.
    const got = await getIntegrationByAttempt(client, "att-fin-1");
    assert.ok(got);
    assert.equal(got.outcome, "success");
    assert.equal(got.resulting_revision, "rev-merged");
    assert.equal(got.run_id, "run-abc");
  });
});

test("integrations: finalizeIntegration second call returns already_set (no-op)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-fin2-1");
    await seedWorkItem(client, "wi-fin2-1", "proj-fin2-1");
    await seedContract(client, "sc-fin2-1", "wi-fin2-1", "proj-fin2-1");
    await seedAttempt(client, "att-fin2-1", "sc-fin2-1");

    await insertIntegration(client, {
      id: "intg-fin2-1",
      attempt_id: "att-fin2-1",
      contract_id: "sc-fin2-1",
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: "rev-base",
    });

    await finalizeIntegration(client, "intg-fin2-1", {
      outcome: "success",
      resultingRevision: "rev-merged",
    });

    const second = await finalizeIntegration(client, "intg-fin2-1", {
      outcome: "failure",
      resultingRevision: "rev-other",
    });
    assert.equal(second, "already_set");

    // Outcome unchanged.
    const got = await getIntegrationByAttempt(client, "att-fin2-1");
    assert.ok(got);
    assert.equal(got.outcome, "success");
    assert.equal(got.resulting_revision, "rev-merged");
  });
});

test("integrations: getIntegrationByAttempt returns null for unknown attempt", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const got = await getIntegrationByAttempt(client, "no-such-attempt");
    assert.equal(got, null);
  });
});

test("integrations: listIntegrationsByAttempt returns all rows ordered by at", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-list-int-1");
    await seedWorkItem(client, "wi-list-int-1", "proj-list-int-1");
    await seedContract(client, "sc-list-int-1", "wi-list-int-1", "proj-list-int-1");
    await seedAttempt(client, "att-list-int-1", "sc-list-int-1");

    await insertIntegration(client, {
      id: "intg-list-1",
      attempt_id: "att-list-int-1",
      contract_id: "sc-list-int-1",
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: "revA",
    });
    await insertIntegration(client, {
      id: "intg-list-2",
      attempt_id: "att-list-int-1",
      contract_id: "sc-list-int-1",
      contract_version: 1,
      target_ref: "feature",
      expected_base_revision: "revB",
    });

    const list = await listIntegrationsByAttempt(client, "att-list-int-1");
    assert.equal(list.length, 2);
    // Both rows belong to the same attempt.
    assert.ok(list.every((r) => r.attempt_id === "att-list-int-1"));
  });
});
