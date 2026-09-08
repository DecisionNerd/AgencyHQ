/**
 * Integration tests: provider_capacity table and leadMetrics repo function.
 * Requires DATABASE_URL pointing at the test Postgres instance.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { insertAttempt } from "../../src/repos/attempts.ts";
import { insertDecision } from "../../src/repos/decisions.ts";
import { insertFinding } from "../../src/repos/findings.ts";
import { insertIntegration } from "../../src/repos/integrations.ts";
import { leadMetrics } from "../../src/repos/metrics.ts";
import { insertProject } from "../../src/repos/projects.ts";
import {
  latestCapacity,
  listCurrentCapacity,
  recordCapacity,
} from "../../src/repos/provider-capacity.ts";
import { insertReview } from "../../src/repos/reviews.ts";
import { insertStepContract } from "../../src/repos/step-contracts.ts";
import { insertWorkItem } from "../../src/repos/work-items.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOST_AUTH = HOST_TRIAL_AUTHORITY;

const DIGEST = "a".repeat(64);

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
  budget: {
    maxAttempts: 3,
    maxDurationSeconds: 300,
    estimatedSpendUsd: 1,
  },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "test-worker", reviewer: "test-reviewer" },
};

const CRITERION = { id: "c1", text: "The code compiles", source: "operator" as const };

async function seedProject(
  client: Parameters<Parameters<typeof withTestSchema>[1]>[0]["client"],
  id: string,
) {
  return insertProject(client, {
    id,
    authority: HOST_AUTH,
    authority_version: "1",
    remote: `https://github.com/test/${id}`,
  });
}

async function seedWorkItem(
  client: Parameters<Parameters<typeof withTestSchema>[1]>[0]["client"],
  id: string,
  project_id: string,
) {
  return insertWorkItem(client, {
    id,
    project_id,
    rank: 1,
    intent: "test intent",
    boundary: "artifact",
    lifecycle: "open",
    condition: "healthy",
  });
}

async function seedStepContract(
  client: Parameters<Parameters<typeof withTestSchema>[1]>[0]["client"],
  id: string,
  work_item_id: string,
  project_id: string,
) {
  return insertStepContract(client, {
    id,
    work_item_id,
    project_id,
    version: 1,
    base_revision: "abc1234",
    inputs: {},
    criteria: [CRITERION],
    criteria_digest: DIGEST,
    profile_id: "p1",
    profile_digest: DIGEST,
    bounds: BOUNDS,
    required_boundaries: ["artifact"],
    human_required: false,
    status: "active",
  });
}

async function seedAttempt(
  client: Parameters<Parameters<typeof withTestSchema>[1]>[0]["client"],
  id: string,
  contract_id: string,
) {
  return insertAttempt(client, {
    id,
    contract_id,
    contract_version: 1,
    generation: 1,
    status: "running",
    budget_remaining: 100,
  });
}

// ---------------------------------------------------------------------------
// provider_capacity: migration + idempotent insert
// ---------------------------------------------------------------------------

test("provider_capacity: migration creates table", async (t) => {
  await withTestSchema(t, async ({ client, schema }) => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'provider_capacity'`,
      [schema],
    );
    assert.equal(rows.length, 1, "provider_capacity table should exist after migration");
  });
});

test("provider_capacity: second runMigrations is a no-op (idempotent)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const { runMigrations } = await import("../../src/migrate.ts");
    const result = await runMigrations(client);
    assert.deepEqual(result.applied, [], "second run should apply nothing");
  });
});

test("provider_capacity: recordCapacity inserts a new row (result=inserted)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const observed = new Date("2026-01-01T12:00:00Z");
    const validUntil = new Date("2026-01-01T13:00:00Z");

    const { result, row } = await recordCapacity(client, {
      provider: "anthropic",
      model: "claude-opus-4-5",
      status: "ok",
      observed_at: observed,
      valid_until: validUntil,
      source: "adapter",
      run_id: "run-abc",
    });

    assert.equal(result, "inserted");
    assert.equal(row.provider, "anthropic");
    assert.equal(row.model, "claude-opus-4-5");
    assert.equal(row.status, "ok");
    assert.equal(row.source, "adapter");
    assert.equal(row.run_id, "run-abc");
  });
});

test("provider_capacity: recordCapacity on same PK returns existing", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const observed = new Date("2026-01-01T12:00:00Z");
    const validUntil = new Date("2026-01-01T13:00:00Z");

    await recordCapacity(client, {
      provider: "openai",
      model: "gpt-4",
      status: "ok",
      observed_at: observed,
      valid_until: validUntil,
      source: "adapter",
    });

    const { result, row } = await recordCapacity(client, {
      provider: "openai",
      model: "gpt-4",
      status: "limited", // different status — should be ignored
      observed_at: observed,
      valid_until: validUntil,
      source: "operator",
    });

    assert.equal(result, "existing");
    // Original row should be returned unchanged
    assert.equal(row.status, "ok");
    assert.equal(row.source, "adapter");
  });
});

// ---------------------------------------------------------------------------
// latestCapacity / listCurrentCapacity with two providers and stale rows
// ---------------------------------------------------------------------------

test("provider_capacity: latestCapacity returns most recent observation", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const t1 = new Date("2026-01-01T10:00:00Z");
    const t2 = new Date("2026-01-01T11:00:00Z");
    const t3 = new Date("2026-01-01T12:00:00Z");
    const validUntil = new Date("2026-01-01T13:00:00Z");

    await recordCapacity(client, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      status: "down",
      observed_at: t1,
      valid_until: validUntil,
      source: "adapter",
    });
    await recordCapacity(client, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      status: "limited",
      observed_at: t2,
      valid_until: validUntil,
      source: "adapter",
    });
    await recordCapacity(client, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      status: "ok",
      observed_at: t3,
      valid_until: validUntil,
      source: "operator",
    });

    const latest = await latestCapacity(client, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    assert.ok(latest, "should return a row");
    assert.equal(latest.status, "ok");
    assert.equal(latest.observed_at.toISOString(), t3.toISOString());
  });
});

test("provider_capacity: latestCapacity returns null for unknown provider/model", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const result = await latestCapacity(client, {
      provider: "nobody",
      model: "nothing",
    });
    assert.equal(result, null);
  });
});

test("provider_capacity: listCurrentCapacity returns one row per (provider,model)", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const now = new Date("2026-01-01T15:00:00Z");
    const past = new Date("2026-01-01T08:00:00Z");
    const recent = new Date("2026-01-01T14:00:00Z");
    // valid_until in the past — stale, but should still appear (domain decides)
    const expiredUntil = new Date("2026-01-01T09:00:00Z");
    const futureUntil = new Date("2026-01-01T20:00:00Z");

    // anthropic/claude-opus-4-5 — two observations
    await recordCapacity(client, {
      provider: "anthropic",
      model: "claude-opus-4-5",
      status: "ok",
      observed_at: past,
      valid_until: expiredUntil, // stale
      source: "adapter",
    });
    await recordCapacity(client, {
      provider: "anthropic",
      model: "claude-opus-4-5",
      status: "limited",
      observed_at: recent,
      valid_until: futureUntil,
      source: "adapter",
    });

    // openai/gpt-4 — one observation
    await recordCapacity(client, {
      provider: "openai",
      model: "gpt-4",
      status: "ok",
      observed_at: past,
      valid_until: expiredUntil, // stale
      source: "adapter",
    });

    const rows = await listCurrentCapacity(client, now);

    // Should have one row per (provider, model)
    assert.equal(rows.length, 2);

    const anthropicRow = rows.find(
      (r) => r.provider === "anthropic" && r.model === "claude-opus-4-5",
    );
    assert.ok(anthropicRow, "should have anthropic row");
    assert.equal(anthropicRow.status, "limited"); // most recent
    assert.equal(anthropicRow.observed_at.toISOString(), recent.toISOString());

    const openaiRow = rows.find((r) => r.provider === "openai" && r.model === "gpt-4");
    assert.ok(openaiRow, "should have openai row");
    // Stale row returned — domain decides what to do with it
    assert.equal(openaiRow.status, "ok");
  });
});

// ---------------------------------------------------------------------------
// leadMetrics: seeded ledger with known counts
// ---------------------------------------------------------------------------

test("leadMetrics: zero metrics for empty project", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await seedProject(client, "proj-empty");

    const metrics = await leadMetrics(client);
    const row = metrics.find((m) => m.project_id === "proj-empty");
    assert.ok(row, "should have row for project");

    assert.equal(row.plans_total, 0);
    assert.equal(row.plans_escalated, 0);
    assert.equal(row.escalation_rate, null);
    assert.equal(row.acceptances, 0);
    assert.equal(row.invalidations, 0);
    assert.equal(row.reversal_rate, null);
    assert.equal(row.reviews_total, 0);
    assert.equal(row.reviews_with_findings, 0);
    assert.equal(row.review_yield, null);
    assert.deepEqual(row.findings_by_disposition, {});
    assert.deepEqual(row.integrations_by_outcome, {});
  });
});

test("leadMetrics: exact numbers on seeded ledger", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    // -----------------------------------------------------------------------
    // Seed a project with:
    //  - 4 plan decisions (3 accepted, 1 pending_human)  → escalation_rate = 0.25
    //  - 2 accept decisions (accepted, approved)          → acceptances = 2
    //  - 1 invalidate decision                            → invalidations = 1
    //    → reversal_rate = 0.5
    //  - 3 reviews: 2 with findings, 1 without            → review_yield = 2/3
    //  - findings: 2 blocking, 1 accepted                 → findings_by_disposition
    //  - 2 integrations: integrated, conflict             → integrations_by_outcome
    // -----------------------------------------------------------------------

    const projectId = "proj-seeded";
    const wiId = "wi-seeded";
    const scId = "sc-seeded";
    const attId = "att-seeded";

    await seedProject(client, projectId);
    await seedWorkItem(client, wiId, projectId);
    await seedStepContract(client, scId, wiId, projectId);
    await seedAttempt(client, attId, scId);

    const at = new Date();

    // 4 plan decisions: 3 accepted, 1 pending_human
    await insertDecision(client, {
      id: "d-plan-1",
      kind: "plan",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "accepted",
      at,
    });
    await insertDecision(client, {
      id: "d-plan-2",
      kind: "plan",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "accepted",
      at,
    });
    await insertDecision(client, {
      id: "d-plan-3",
      kind: "plan",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "accepted",
      at,
    });
    await insertDecision(client, {
      id: "d-plan-4",
      kind: "plan",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "pending_human",
      at,
    });

    // 2 accept decisions: accepted + approved
    await insertDecision(client, {
      id: "d-accept-1",
      kind: "accept",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "accepted",
      at,
    });
    await insertDecision(client, {
      id: "d-accept-2",
      kind: "accept",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "approved",
      at,
    });

    // 1 invalidate decision
    await insertDecision(client, {
      id: "d-invalidate-1",
      kind: "invalidate",
      actor: "operator",
      work_item_id: wiId,
      outcome: null,
      at,
    });

    // 3 reviews: 2 with findings, 1 without
    await insertReview(client, {
      id: "rev-1",
      attempt_id: attId,
      reviewer_model: "claude-opus-4-5",
      profile: "adversarial",
      findings: [{ severity: "blocking", description: "Bad code" }],
    });
    await insertReview(client, {
      id: "rev-2",
      attempt_id: attId,
      reviewer_model: "claude-opus-4-5",
      profile: "adversarial",
      findings: [{ severity: "blocking", description: "Another issue" }],
    });
    await insertReview(client, {
      id: "rev-3",
      attempt_id: attId,
      reviewer_model: "claude-opus-4-5",
      profile: "adversarial",
      findings: [], // no findings
    });

    // 3 findings: 2 blocking (disposition=null → 'unset'), 1 accepted
    await insertFinding(client, {
      id: "fnd-1",
      attempt_id: attId,
      severity: "blocking",
      kind: "correctness",
      description: "Issue 1",
      disposition: null,
    });
    await insertFinding(client, {
      id: "fnd-2",
      attempt_id: attId,
      severity: "blocking",
      kind: "correctness",
      description: "Issue 2",
      disposition: null,
    });
    await insertFinding(client, {
      id: "fnd-3",
      attempt_id: attId,
      severity: "low",
      kind: "style",
      description: "Minor nit",
      disposition: "accepted",
    });

    // 2 integrations: integrated + conflict
    await insertIntegration(client, {
      id: "int-1",
      attempt_id: attId,
      contract_id: scId,
      contract_version: 1,
      target_ref: "refs/heads/main",
      expected_base_revision: "abc1234",
      resulting_revision: "def5678",
      outcome: "integrated",
    });
    await insertIntegration(client, {
      id: "int-2",
      attempt_id: attId,
      contract_id: scId,
      contract_version: 1,
      target_ref: "refs/heads/main",
      expected_base_revision: "def5678",
      resulting_revision: null,
      outcome: "conflict",
    });

    // -----------------------------------------------------------------------
    // Assert
    // -----------------------------------------------------------------------

    const metrics = await leadMetrics(client);
    const row = metrics.find((m) => m.project_id === projectId);
    assert.ok(row, "should have row for seeded project");

    // plans
    assert.equal(row.plans_total, 4, "plans_total");
    assert.equal(row.plans_escalated, 1, "plans_escalated");
    assert.ok(
      Math.abs((row.escalation_rate ?? 0) - 0.25) < 1e-9,
      `escalation_rate should be 0.25, got ${row.escalation_rate}`,
    );

    // accepts / invalidations
    assert.equal(row.acceptances, 2, "acceptances");
    assert.equal(row.invalidations, 1, "invalidations");
    assert.ok(
      Math.abs((row.reversal_rate ?? 0) - 0.5) < 1e-9,
      `reversal_rate should be 0.5, got ${row.reversal_rate}`,
    );

    // review yield
    assert.equal(row.reviews_total, 3, "reviews_total");
    assert.equal(row.reviews_with_findings, 2, "reviews_with_findings");
    assert.ok(
      Math.abs((row.review_yield ?? 0) - 2 / 3) < 1e-9,
      `review_yield should be ~0.667, got ${row.review_yield}`,
    );

    // findings by disposition
    assert.equal(
      row.findings_by_disposition["unset"],
      2,
      "findings_by_disposition.unset should be 2",
    );
    assert.equal(
      row.findings_by_disposition["accepted"],
      1,
      "findings_by_disposition.accepted should be 1",
    );

    // integrations by outcome
    assert.equal(
      row.integrations_by_outcome["integrated"],
      1,
      "integrations_by_outcome.integrated should be 1",
    );
    assert.equal(
      row.integrations_by_outcome["conflict"],
      1,
      "integrations_by_outcome.conflict should be 1",
    );
  });
});

test("leadMetrics: since filter excludes older records", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const projectId = "proj-filter";
    const wiId = "wi-filter";

    await seedProject(client, projectId);
    await seedWorkItem(client, wiId, projectId);

    const at = new Date("2025-01-01T00:00:00Z");

    // Insert one plan decision before the cutoff
    await insertDecision(client, {
      id: "d-old-plan",
      kind: "plan",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "accepted",
      at,
    });

    // Query with since = after the decision's created_at
    const cutoff = new Date("2099-01-01T00:00:00Z");
    const metrics = await leadMetrics(client, { since: cutoff });
    const row = metrics.find((m) => m.project_id === projectId);
    assert.ok(row, "project should still appear");
    // The decision was created before the cutoff, so it should be excluded
    assert.equal(row.plans_total, 0, "plans_total should be 0 after cutoff");
  });
});

test("leadMetrics: null since returns all records", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const projectId = "proj-null-since";
    const wiId = "wi-null-since";

    await seedProject(client, projectId);
    await seedWorkItem(client, wiId, projectId);

    const at = new Date();
    await insertDecision(client, {
      id: "d-plan-null",
      kind: "plan",
      actor: "coordinator",
      work_item_id: wiId,
      outcome: "accepted",
      at,
    });

    const metrics = await leadMetrics(client, { since: null });
    const row = metrics.find((m) => m.project_id === projectId);
    assert.ok(row);
    assert.equal(row.plans_total, 1, "plans_total should be 1 with null since");
  });
});
