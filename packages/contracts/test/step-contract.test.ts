import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractBoundsSchema,
  CriterionSchema,
  CriterionSourceSchema,
  criteriaDigestInput,
  DigestSchema,
  StepContractSchema,
} from "../src/step-contract.ts";

// ---------------------------------------------------------------------------
// CriterionSourceSchema
// ---------------------------------------------------------------------------
test("CriterionSourceSchema: accepts all valid sources", () => {
  for (const src of ["operator", "repository", "lead"] as const) {
    assert.equal(CriterionSourceSchema.safeParse(src).success, true);
  }
});

test("CriterionSourceSchema: rejects unknown source", () => {
  assert.equal(CriterionSourceSchema.safeParse("human").success, false);
});

// ---------------------------------------------------------------------------
// CriterionSchema
// ---------------------------------------------------------------------------
const validCriterion = {
  id: "c1",
  text: "Parser must reject invalid input",
  source: "operator" as const,
};

test("CriterionSchema: parses a valid criterion without citation", () => {
  const result = CriterionSchema.safeParse(validCriterion);
  assert.equal(result.success, true);
});

test("CriterionSchema: parses a valid criterion with citation", () => {
  const result = CriterionSchema.safeParse({ ...validCriterion, citation: "issue #42" });
  assert.equal(result.success, true);
});

test("CriterionSchema: rejects missing id", () => {
  const { id: _id, ...noId } = validCriterion;
  assert.equal(CriterionSchema.safeParse(noId).success, false);
});

test("CriterionSchema: rejects empty text", () => {
  assert.equal(CriterionSchema.safeParse({ ...validCriterion, text: "" }).success, false);
});

test("CriterionSchema: rejects invalid source", () => {
  assert.equal(CriterionSchema.safeParse({ ...validCriterion, source: "ai" }).success, false);
});

// ---------------------------------------------------------------------------
// ContractBoundsSchema
// ---------------------------------------------------------------------------
const validBounds = {
  paths: { allow: ["src/**"], deny: [".github/**"] },
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
  budget: { maxAttempts: 2, maxDurationSeconds: 300, estimatedSpendUsd: 2 },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "openai/gpt-4", reviewer: "openai/gpt-4-other" },
};

test("ContractBoundsSchema: parses a valid bounds object", () => {
  assert.equal(ContractBoundsSchema.safeParse(validBounds).success, true);
});

test("ContractBoundsSchema: rejects missing boundary field", () => {
  const { boundary: _b, ...noBoundary } = validBounds;
  assert.equal(ContractBoundsSchema.safeParse(noBoundary).success, false);
});

test("ContractBoundsSchema: rejects negative budget estimatedSpendUsd", () => {
  const bad = { ...validBounds, budget: { ...validBounds.budget, estimatedSpendUsd: -0.01 } };
  assert.equal(ContractBoundsSchema.safeParse(bad).success, false);
});

test("ContractBoundsSchema: rejects invalid review profile", () => {
  const bad = { ...validBounds, review: "mega_review" };
  assert.equal(ContractBoundsSchema.safeParse(bad).success, false);
});

// ---------------------------------------------------------------------------
// StepContractSchema
// ---------------------------------------------------------------------------
const validDigest = `sha256:${"a".repeat(64)}`;

const validStepContract = {
  id: "sc-1",
  workItemId: "wi-1",
  projectId: "proj-1",
  version: 1,
  baseRevision: "a".repeat(40),
  inputs: { intent: "Fix parser accepting invalid input" },
  criteria: [validCriterion],
  criteriaDigest: validDigest,
  profileId: "default-v1",
  profileDigest: validDigest,
  bounds: validBounds,
  requiredBoundaries: ["worktree", "duration"],
  humanRequired: false,
  status: "active" as const,
};

test("StepContractSchema: parses a valid step contract", () => {
  const result = StepContractSchema.safeParse(validStepContract);
  assert.equal(result.success, true);
});

test("StepContractSchema: parses a superseded contract with supersededBy", () => {
  const superseded = { ...validStepContract, status: "superseded" as const, supersededBy: "sc-2" };
  assert.equal(StepContractSchema.safeParse(superseded).success, true);
});

test("StepContractSchema: rejects empty criteria array", () => {
  const bad = { ...validStepContract, criteria: [] };
  assert.equal(StepContractSchema.safeParse(bad).success, false);
});

test("StepContractSchema: rejects malformed baseRevision (non-hex)", () => {
  const bad = { ...validStepContract, baseRevision: "z".repeat(40) };
  assert.equal(StepContractSchema.safeParse(bad).success, false);
});

test("StepContractSchema: rejects baseRevision with wrong length", () => {
  const bad = { ...validStepContract, baseRevision: "a".repeat(39) };
  assert.equal(StepContractSchema.safeParse(bad).success, false);
});

test("StepContractSchema: rejects version < 1", () => {
  const bad = { ...validStepContract, version: 0 };
  assert.equal(StepContractSchema.safeParse(bad).success, false);
});

test("StepContractSchema: rejects malformed criteriaDigest", () => {
  const bad = { ...validStepContract, criteriaDigest: "not-a-digest" };
  assert.equal(StepContractSchema.safeParse(bad).success, false);
});

test("StepContractSchema: rejects invalid status value", () => {
  const bad = { ...validStepContract, status: "pending" };
  assert.equal(StepContractSchema.safeParse(bad).success, false);
});

test("StepContractSchema: contract with defect input parses correctly", () => {
  const withDefect = {
    ...validStepContract,
    inputs: { intent: "Fix bug", defect: "Crashes on empty input" },
  };
  assert.equal(StepContractSchema.safeParse(withDefect).success, true);
});

// ---------------------------------------------------------------------------
// criteriaDigestInput
// ---------------------------------------------------------------------------
test("criteriaDigestInput: returns only id, text, source fields", () => {
  const criterion = { id: "c1", text: "Must pass", source: "operator" as const, citation: "ref" };
  const result = criteriaDigestInput([criterion]);
  assert.deepEqual(result, [{ id: "c1", text: "Must pass", source: "operator" }]);
  // citation must NOT be present
  assert.equal("citation" in (result[0] ?? {}), false);
});

test("criteriaDigestInput: preserves order of criteria", () => {
  const criteria = [
    { id: "c1", text: "First", source: "operator" as const },
    { id: "c2", text: "Second", source: "lead" as const },
  ];
  const result = criteriaDigestInput(criteria);
  assert.equal(result[0]?.id, "c1");
  assert.equal(result[1]?.id, "c2");
});

// ---------------------------------------------------------------------------
// DigestSchema re-exported from step-contract
// ---------------------------------------------------------------------------
test("DigestSchema: parses a valid sha256 digest (re-export check)", () => {
  const valid = `sha256:${"b".repeat(64)}`;
  assert.equal(DigestSchema.parse(valid), valid);
});
