import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthoritySchema,
  ContractBoundsSchema,
  CriterionSchema,
  VerificationResultSchema,
} from "@agencyhq/contracts";
import {
  mapProjectRow,
  mapStepContractRow,
  mapVerificationResultRow,
  ProjectRowSchema,
  RunObservationRowSchema,
  StepContractRowSchema,
  TransitionRowSchema,
  VerificationResultRowSchema,
} from "../../src/rows.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const authorityFixture = {
  version: "1",
  paths: {
    allow: ["src/**"],
    deny: [".github/**"],
  },
  capabilities: {
    bash: { allow: ["pnpm test*"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundaries: ["artifact"],
  budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 3 },
  review: {
    minimum: {
      editorial: "lead_inspection",
      behavior: "adversarial",
      shared_interface: "adversarial_distinct_model",
    },
  },
  models: {
    worker: ["claude-sonnet-4-5"],
    lead: ["claude-sonnet-4-5"],
    reviewer: ["claude-opus-4-5"],
    reviewerMustDiffer: false,
  },
  humanRequired: { paths: [], changeClasses: [], boundaries: [] },
};

const boundsFixture = {
  paths: { allow: ["src/**"], deny: [] },
  capabilities: {
    bash: { allow: ["pnpm test*"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundary: "artifact",
  budget: {
    maxAttempts: 1,
    maxDurationSeconds: 300,
    estimatedSpendUsd: 1,
  },
  review: "lead_inspection",
  changeClass: "editorial",
  models: { worker: "claude-sonnet-4-5", reviewer: "claude-opus-4-5" },
};

const criteriaFixture = [{ id: "c1", text: "All tests pass", source: "operator" }];

const verificationResultFixture = {
  verifier: { name: "vitest", version: "1.0.0" },
  stepContractId: "sc-1",
  attemptId: "a-1",
  criteriaDigest: `sha256:${"a".repeat(64)}`,
  profileDigest: `sha256:${"b".repeat(64)}`,
  repository: "https://github.com/org/repo",
  baseRevision: "abc123",
  attemptRevision: "def456",
  diffDigest: `sha256:${"c".repeat(64)}`,
  checkId: "check-1",
  environmentFingerprint: { node: "22.0.0" },
  startedAt: "2025-01-01T00:00:00.000Z",
  endedAt: "2025-01-01T00:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "All tests passed",
  stderrTail: "",
  artifactDigests: [],
  result: "pass" as const,
};

// ---------------------------------------------------------------------------
// ProjectRow
// ---------------------------------------------------------------------------

test("ProjectRowSchema parses a valid project row", () => {
  const raw = {
    id: "proj-1",
    remote: "https://github.com/org/repo.git",
    clone_path: "/clones/repo",
    worktree_base: "/worktrees",
    allowed_refs: ["main"],
    profile_catalog: null,
    authority: authorityFixture,
    authority_version: "1",
    created_at: new Date(),
    updated_at: new Date(),
  };
  const row = ProjectRowSchema.parse(raw);
  assert.equal(row.id, "proj-1");
  assert.equal(row.authority_version, "1");
});

test("mapProjectRow parses authority jsonb into AuthoritySchema", () => {
  const raw = {
    id: "proj-1",
    remote: null,
    clone_path: null,
    worktree_base: null,
    allowed_refs: null,
    profile_catalog: null,
    authority: authorityFixture,
    authority_version: "1",
    created_at: new Date(),
    updated_at: new Date(),
  };
  const row = ProjectRowSchema.parse(raw);
  const mapped = mapProjectRow(row);
  // Should parse without throwing
  const parsed = AuthoritySchema.parse(mapped.authority);
  assert.equal(parsed.version, "1");
});

// ---------------------------------------------------------------------------
// StepContractRow
// ---------------------------------------------------------------------------

test("StepContractRowSchema parses a valid step_contract row", () => {
  const raw = {
    id: "sc-1",
    work_item_id: "wi-1",
    project_id: "proj-1",
    version: 1,
    base_revision: "abc123",
    inputs: { prompt: "Do the thing" },
    criteria: criteriaFixture,
    criteria_digest: `sha256:${"a".repeat(64)}`,
    profile_id: "default",
    profile_digest: `sha256:${"b".repeat(64)}`,
    bounds: boundsFixture,
    required_boundaries: ["artifact"],
    human_required: false,
    status: "active",
    superseded_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const row = StepContractRowSchema.parse(raw);
  assert.equal(row.id, "sc-1");
  assert.equal(row.version, 1);
});

test("mapStepContractRow round-trips bounds and criteria through contracts types", () => {
  const raw = {
    id: "sc-1",
    work_item_id: "wi-1",
    project_id: "proj-1",
    version: 1,
    base_revision: "abc123",
    inputs: {},
    criteria: criteriaFixture,
    criteria_digest: `sha256:${"a".repeat(64)}`,
    profile_id: "default",
    profile_digest: `sha256:${"b".repeat(64)}`,
    bounds: boundsFixture,
    required_boundaries: ["artifact"],
    human_required: false,
    status: "active",
    superseded_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const row = StepContractRowSchema.parse(raw);
  const mapped = mapStepContractRow(row);
  // Verify bounds parses
  const bounds = ContractBoundsSchema.parse(mapped.bounds);
  assert.equal(bounds.boundary, "artifact");
  // Verify criteria parses
  const criteria = mapped.criteria;
  assert.equal(criteria.length, 1);
  const crit = CriterionSchema.parse(criteria[0]);
  assert.equal(crit.id, "c1");
});

// ---------------------------------------------------------------------------
// VerificationResultRow
// ---------------------------------------------------------------------------

test("mapVerificationResultRow parses record jsonb into VerificationResultSchema", () => {
  const raw = {
    id: "vr-1",
    attempt_id: "a-1",
    step_contract_id: "sc-1",
    record: verificationResultFixture,
    result: "pass",
    created_at: new Date(),
    updated_at: new Date(),
  };
  const row = VerificationResultRowSchema.parse(raw);
  const mapped = mapVerificationResultRow(row);
  const vr = VerificationResultSchema.parse(mapped.record);
  assert.equal(vr.result, "pass");
  assert.equal(vr.stepContractId, "sc-1");
});

// ---------------------------------------------------------------------------
// TransitionRow (bigserial returns as number)
// ---------------------------------------------------------------------------

test("TransitionRowSchema parses a transition row with numeric id", () => {
  const raw = {
    id: 42,
    aggregate: "attempt",
    aggregate_id: "a-1",
    from_state: "pending",
    to_state: "running",
    actor: "coordinator",
    causation_id: null,
    command_id: null,
    at: new Date(),
  };
  const row = TransitionRowSchema.parse(raw);
  assert.equal(row.id, 42);
});

// ---------------------------------------------------------------------------
// RunObservationRow
// ---------------------------------------------------------------------------

test("RunObservationRowSchema parses a run_observation row", () => {
  const raw = {
    run_id: "run-1",
    generation: 1,
    stale: false,
    payload: { type: "completed" },
    observed_at: new Date(),
  };
  const row = RunObservationRowSchema.parse(raw);
  assert.equal(row.run_id, "run-1");
  assert.equal(row.generation, 1);
  assert.equal(row.stale, false);
});
