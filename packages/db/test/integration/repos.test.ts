/**
 * Integration tests: repository round-trips.
 * Requires DATABASE_URL pointing to the test Postgres instance.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { getApproval, insertApproval } from "../../src/repos/approvals.ts";
import { getArtifact, insertArtifact } from "../../src/repos/artifacts.ts";
import {
  getAttempt,
  insertAttempt,
  listAttemptsByContract,
  updateAttemptStatus,
} from "../../src/repos/attempts.ts";
import { getDecision, insertDecision, listDecisionsByWorkItem } from "../../src/repos/decisions.ts";
import {
  getDispatchIntent,
  insertDispatchIntent,
  listOpenDispatchIntents,
  updateDispatchIntentStatus,
} from "../../src/repos/dispatch-intents.ts";
import { getFailure, insertFailure } from "../../src/repos/failures.ts";
import { getFinding, insertFinding } from "../../src/repos/findings.ts";
import { getProject, insertProject, listProjects } from "../../src/repos/projects.ts";
import { getReview, insertReview } from "../../src/repos/reviews.ts";
import {
  getStepContract,
  insertStepContract,
  listStepContractsByWorkItem,
  updateStepContractStatus,
} from "../../src/repos/step-contracts.ts";
import { insertTransition } from "../../src/repos/transitions.ts";
import {
  getVerificationResult,
  insertVerificationResult,
} from "../../src/repos/verification-results.ts";
import { getWorkItem, insertWorkItem, listWorkItemsByProject } from "../../src/repos/work-items.ts";
import { withTestSchema } from "../../src/testing/test-db.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
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
  budget: {
    maxAttempts: 2,
    maxDurationSeconds: 300,
    estimatedSpendUsd: 1,
  },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "test-worker", reviewer: "test-reviewer" },
};

const CRITERION = {
  id: "c1",
  text: "The code compiles without errors",
  source: "operator" as const,
};

const VERIFICATION_RECORD = {
  verifier: { name: "test-verifier", version: "0.0.1" },
  stepContractId: "sc-test",
  attemptId: "att-test",
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  repository: "test-repo",
  baseRevision: "abc1234",
  attemptRevision: "def5678",
  diffDigest: DIGEST,
  checkId: "check-1",
  environmentFingerprint: { node: "20.0.0" },
  startedAt: "2024-01-01T00:00:00.000Z",
  endedAt: "2024-01-01T00:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "",
  stderrTail: "",
  artifactDigests: [],
  result: "pass" as const,
};

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

test("projects: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const inserted = await insertProject(client, {
      id: "proj-1",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
      remote: "https://github.com/test/repo",
    });

    assert.equal(inserted.id, "proj-1");
    assert.equal(inserted.authority_version, "1");

    const got = await getProject(client, "proj-1");
    assert.ok(got, "getProject should return a value");
    assert.equal(got.id, "proj-1");
    assert.equal(got.authority.version, "1");

    const missing = await getProject(client, "no-such-project");
    assert.equal(missing, null);
  });
});

test("projects: listProjects returns all projects ordered by created_at", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-a",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertProject(client, {
      id: "proj-b",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    const list = await listProjects(client);
    assert.equal(list.length, 2);
  });
});

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

test("work_items: insert and get round-trip, list by project", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-wi",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });

    const inserted = await insertWorkItem(client, {
      id: "wi-1",
      project_id: "proj-wi",
      rank: 1,
      intent: "Fix the parser",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });

    assert.equal(inserted.id, "wi-1");
    assert.equal(inserted.boundary, "artifact");

    const got = await getWorkItem(client, "wi-1");
    assert.ok(got);
    assert.equal(got.intent, "Fix the parser");

    const missing = await getWorkItem(client, "no-wi");
    assert.equal(missing, null);

    const list = await listWorkItemsByProject(client, "proj-wi");
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, "wi-1");
  });
});

// ---------------------------------------------------------------------------
// step_contracts
// ---------------------------------------------------------------------------

test("step_contracts: insert and get round-trip, list by work item", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-sc",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-sc",
      project_id: "proj-sc",
      rank: 1,
      intent: "Test intent",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });

    const inserted = await insertStepContract(client, {
      id: "sc-1",
      work_item_id: "wi-sc",
      project_id: "proj-sc",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "host-trial",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });

    assert.equal(inserted.id, "sc-1");
    assert.equal(inserted.status, "active");
    assert.deepEqual(inserted.bounds.boundary, "artifact");

    const got = await getStepContract(client, "sc-1");
    assert.ok(got);
    assert.equal(got.version, 1);

    const missing = await getStepContract(client, "no-sc");
    assert.equal(missing, null);

    const list = await listStepContractsByWorkItem(client, "wi-sc");
    assert.equal(list.length, 1);
  });
});

test("step_contracts: updateStatus state mismatch returns { ok: false } and writes no transition", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-sc2",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-sc2",
      project_id: "proj-sc2",
      rank: 1,
      intent: "Test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertStepContract(client, {
      id: "sc-upd",
      work_item_id: "wi-sc2",
      project_id: "proj-sc2",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "host-trial",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });

    // State mismatch: current status is "active", not "superseded"
    const result = await updateStepContractStatus(client, "sc-upd", "superseded", "active", {
      actor: "test",
    });
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; reason: string }).reason, "state_mismatch");

    // Verify no transition row was written
    const { rows: trows } = await client.query(
      "SELECT COUNT(*) AS c FROM transitions WHERE aggregate = 'step_contracts' AND aggregate_id = 'sc-upd'",
    );
    assert.equal(Number(trows[0]?.c ?? 0), 0);

    // Successful update
    const ok = await updateStepContractStatus(client, "sc-upd", "active", "superseded", {
      actor: "test",
      causationId: "cause-1",
    });
    assert.equal(ok.ok, true);

    // Transition row should now exist
    const { rows: trows2 } = await client.query(
      "SELECT COUNT(*) AS c FROM transitions WHERE aggregate = 'step_contracts' AND aggregate_id = 'sc-upd'",
    );
    assert.equal(Number(trows2[0]?.c ?? 0), 1);
  });
});

// ---------------------------------------------------------------------------
// attempts
// ---------------------------------------------------------------------------

test("attempts: insert and get round-trip, list by contract", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-att",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-att",
      project_id: "proj-att",
      rank: 1,
      intent: "Attempt test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertStepContract(client, {
      id: "sc-att",
      work_item_id: "wi-att",
      project_id: "proj-att",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "host-trial",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });

    const inserted = await insertAttempt(client, {
      id: "att-1",
      contract_id: "sc-att",
      contract_version: 1,
      generation: 1,
      status: "admitted",
      budget_remaining: 100,
    });

    assert.equal(inserted.id, "att-1");
    assert.equal(inserted.status, "admitted");

    const got = await getAttempt(client, "att-1");
    assert.ok(got);
    assert.equal(got.generation, 1);

    const missing = await getAttempt(client, "no-att");
    assert.equal(missing, null);

    const list = await listAttemptsByContract(client, "sc-att");
    assert.equal(list.length, 1);
  });
});

test("attempts: updateStatus state mismatch returns { ok: false } and writes no transition", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-att2",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-att2",
      project_id: "proj-att2",
      rank: 1,
      intent: "Test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertStepContract(client, {
      id: "sc-att2",
      work_item_id: "wi-att2",
      project_id: "proj-att2",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "host-trial",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });
    await insertAttempt(client, {
      id: "att-upd",
      contract_id: "sc-att2",
      contract_version: 1,
      generation: 1,
      status: "admitted",
      budget_remaining: 100,
    });

    const result = await updateAttemptStatus(client, "att-upd", "running", "admitted", {
      actor: "test",
    });
    assert.equal(result.ok, false);

    const { rows } = await client.query(
      "SELECT COUNT(*) AS c FROM transitions WHERE aggregate = 'attempts' AND aggregate_id = 'att-upd'",
    );
    assert.equal(Number(rows[0]?.c ?? 0), 0);
  });
});

// ---------------------------------------------------------------------------
// dispatch_intents
// ---------------------------------------------------------------------------

test("dispatch_intents: insert and get round-trip, listOpen", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const inserted = await insertDispatchIntent(client, {
      id: "di-1",
      task: "worker.attempt",
      payload_digest: DIGEST,
      status: "pending",
      idempotency_key: "idem-1",
    });

    assert.equal(inserted.id, "di-1");
    assert.equal(inserted.status, "pending");

    const got = await getDispatchIntent(client, "di-1");
    assert.ok(got);
    assert.equal(got.task, "worker.attempt");

    const missing = await getDispatchIntent(client, "no-di");
    assert.equal(missing, null);

    // listOpen requires status = "triggered" and run_id IS NOT NULL
    const openBefore = await listOpenDispatchIntents(client);
    assert.equal(openBefore.length, 0);

    // Set status to triggered with a run_id
    await client.query(
      "UPDATE dispatch_intents SET status = 'triggered', run_id = 'run-1' WHERE id = 'di-1'",
    );
    const openAfter = await listOpenDispatchIntents(client);
    assert.equal(openAfter.length, 1);
    assert.equal(openAfter[0]?.id, "di-1");
  });
});

test("dispatch_intents: updateStatus state mismatch returns { ok: false } and writes no transition", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertDispatchIntent(client, {
      id: "di-upd",
      task: "worker.attempt",
      payload_digest: DIGEST,
      status: "pending",
      idempotency_key: "idem-upd",
    });

    const result = await updateDispatchIntentStatus(client, "di-upd", "triggered", "completed", {
      actor: "test",
    });
    assert.equal(result.ok, false);

    const { rows } = await client.query(
      "SELECT COUNT(*) AS c FROM transitions WHERE aggregate = 'dispatch_intents' AND aggregate_id = 'di-upd'",
    );
    assert.equal(Number(rows[0]?.c ?? 0), 0);

    // Successful update
    const ok = await updateDispatchIntentStatus(client, "di-upd", "pending", "triggered", {
      actor: "coordinator",
    });
    assert.equal(ok.ok, true);
  });
});

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

test("artifacts: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    // Setup chain
    await insertProject(client, {
      id: "proj-art",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-art",
      project_id: "proj-art",
      rank: 1,
      intent: "test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertStepContract(client, {
      id: "sc-art",
      work_item_id: "wi-art",
      project_id: "proj-art",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "p",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });
    await insertAttempt(client, {
      id: "att-art",
      contract_id: "sc-art",
      contract_version: 1,
      generation: 1,
      status: "admitted",
      budget_remaining: 100,
    });

    const inserted = await insertArtifact(client, {
      id: "art-1",
      attempt_id: "att-art",
      revision: "rev1",
      diff_digest: DIGEST,
      changed_paths: ["src/foo.ts"],
    });

    assert.equal(inserted.id, "art-1");

    const got = await getArtifact(client, "art-1");
    assert.ok(got);
    assert.equal(got.revision, "rev1");

    const missing = await getArtifact(client, "no-art");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// verification_results
// ---------------------------------------------------------------------------

test("verification_results: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-vr",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-vr",
      project_id: "proj-vr",
      rank: 1,
      intent: "test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertStepContract(client, {
      id: "sc-vr",
      work_item_id: "wi-vr",
      project_id: "proj-vr",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "p",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });
    await insertAttempt(client, {
      id: "att-vr",
      contract_id: "sc-vr",
      contract_version: 1,
      generation: 1,
      status: "admitted",
      budget_remaining: 100,
    });

    const record = { ...VERIFICATION_RECORD, stepContractId: "sc-vr", attemptId: "att-vr" };

    const inserted = await insertVerificationResult(client, {
      id: "vr-1",
      attempt_id: "att-vr",
      step_contract_id: "sc-vr",
      record,
      result: "pass",
    });

    assert.equal(inserted.id, "vr-1");
    assert.equal(inserted.result, "pass");
    assert.equal(inserted.record.result, "pass");

    const got = await getVerificationResult(client, "vr-1");
    assert.ok(got);
    assert.equal(got.record.verifier.name, "test-verifier");

    const missing = await getVerificationResult(client, "no-vr");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

test("reviews: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-rev",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-rev",
      project_id: "proj-rev",
      rank: 1,
      intent: "test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertStepContract(client, {
      id: "sc-rev",
      work_item_id: "wi-rev",
      project_id: "proj-rev",
      version: 1,
      base_revision: "abc1234",
      inputs: {},
      criteria: [CRITERION],
      criteria_digest: DIGEST,
      profile_id: "p",
      profile_digest: DIGEST,
      bounds: BOUNDS,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });
    await insertAttempt(client, {
      id: "att-rev",
      contract_id: "sc-rev",
      contract_version: 1,
      generation: 1,
      status: "admitted",
      budget_remaining: 100,
    });

    const inserted = await insertReview(client, {
      id: "rev-1",
      attempt_id: "att-rev",
      reviewer_model: "claude-opus-4-5",
      profile: "lead_inspection",
      findings: [{ severity: "low", description: "Minor nit" }],
    });

    assert.equal(inserted.id, "rev-1");

    const got = await getReview(client, "rev-1");
    assert.ok(got);
    assert.equal(got.attempt_id, "att-rev");

    const missing = await getReview(client, "no-rev");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

test("decisions: insert and get round-trip, list by work item", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-dec",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-dec",
      project_id: "proj-dec",
      rank: 1,
      intent: "test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });

    const inserted = await insertDecision(client, {
      id: "dec-1",
      kind: "admit",
      actor: "coordinator",
      work_item_id: "wi-dec",
      outcome: "approved",
      at: new Date("2024-01-01T00:00:00Z"),
    });

    assert.equal(inserted.id, "dec-1");
    assert.equal(inserted.kind, "admit");
    assert.equal(inserted.actor, "coordinator");

    const got = await getDecision(client, "dec-1");
    assert.ok(got);
    assert.equal(got.outcome, "approved");

    const missing = await getDecision(client, "no-dec");
    assert.equal(missing, null);

    const list = await listDecisionsByWorkItem(client, "wi-dec");
    assert.equal(list.length, 1);
  });
});

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

test("approvals: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    await insertProject(client, {
      id: "proj-appr",
      authority: HOST_TRIAL_AUTHORITY,
      authority_version: "1",
    });
    await insertWorkItem(client, {
      id: "wi-appr",
      project_id: "proj-appr",
      rank: 1,
      intent: "test",
      boundary: "artifact",
      lifecycle: "repair",
      condition: "open",
    });
    await insertDecision(client, {
      id: "dec-appr",
      kind: "human",
      actor: "human",
      at: new Date(),
    });

    const inserted = await insertApproval(client, {
      id: "appr-1",
      decision_id: "dec-appr",
      human_actor: "alice",
      at: new Date("2024-01-01T00:00:00Z"),
    });

    assert.equal(inserted.id, "appr-1");
    assert.equal(inserted.human_actor, "alice");

    const got = await getApproval(client, "appr-1");
    assert.ok(got);
    assert.equal(got.decision_id, "dec-appr");

    const missing = await getApproval(client, "no-appr");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

test("findings: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const inserted = await insertFinding(client, {
      id: "find-1",
      severity: "high",
      kind: "security",
      description: "Unsafe call",
      evidence: "line 42",
      disposition: "open",
    });

    assert.equal(inserted.id, "find-1");
    assert.equal(inserted.severity, "high");

    const got = await getFinding(client, "find-1");
    assert.ok(got);
    assert.equal(got.kind, "security");

    const missing = await getFinding(client, "no-find");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

test("failures: insert and get round-trip", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const inserted = await insertFailure(client, {
      id: "fail-1",
      class: "runtime",
      phase: "execute",
      cause: "OOM",
    });

    assert.equal(inserted.id, "fail-1");
    assert.equal(inserted.class, "runtime");

    const got = await getFailure(client, "fail-1");
    assert.ok(got);
    assert.equal(got.cause, "OOM");

    const missing = await getFailure(client, "no-fail");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// transitions (direct insert)
// ---------------------------------------------------------------------------

test("transitions: insertTransition writes an audit row", async (t) => {
  await withTestSchema(t, async ({ client }) => {
    const row = await insertTransition(client, {
      aggregate: "attempts",
      aggregate_id: "att-xyz",
      from_state: null,
      to_state: "admitted",
      actor: "coordinator",
    });

    assert.ok(row.id > 0);
    assert.equal(row.aggregate, "attempts");
    assert.equal(row.to_state, "admitted");
  });
});
