import assert from "node:assert/strict";
import test from "node:test";
import type { Authority, Digest, LeadProposal } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import { freezeContract, supersede } from "../src/aggregates/step-contract.ts";
import type { ProjectId, StepContractId } from "../src/ids.ts";
import { newId } from "../src/ids.ts";

/** Create a well-typed Digest for testing. */
function testDigest(char: string): Digest {
  return `sha256:${char.repeat(64)}` as Digest;
}

// ---------------------------------------------------------------------------
// Helper: minimal valid proposal narrower than HOST_TRIAL_AUTHORITY
// ---------------------------------------------------------------------------
function makeNarrowProposal(): LeadProposal {
  return {
    criteria: [
      {
        id: "c1",
        text: "The parser must reject invalid input X.",
        source: "operator",
        citation: "operator-intent",
      },
    ],
    profileId: "default",
    changeClass: "behavior",
    review: "adversarial",
    boundary: "artifact",
    paths: {
      // narrower: only src/parser/core.ts — a strict subset of HOST_TRIAL_AUTHORITY paths
      allow: ["src/parser/core.ts"],
      deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
    },
    capabilities: {
      bash: {
        allow: ["pnpm test*"],
        deny: [],
      },
      tools: {
        edit: true,
        webfetch: false,
        websearch: false,
        task: false,
        external_directory: false,
        skill: false,
      },
    },
    budget: {
      // narrower: 1 attempt instead of 2 in HOST_TRIAL_AUTHORITY
      maxAttempts: 1,
      maxDurationSeconds: 600,
      estimatedSpendUsd: 2,
    },
    models: {
      worker: "openai/gpt-5.6-terra",
      reviewer: "openai/gpt-5.6-sol",
    },
    rationale: "Narrow scope to parser core only.",
    sources: [
      {
        criterionId: "c1",
        source: "operator",
        citation: "operator-intent",
      },
    ],
  };
}

const HOST_AUTHORITY: Authority = HOST_TRIAL_AUTHORITY;

function makeWorkItem() {
  return {
    id: newId("wi"),
    projectId: newId("prj"),
    intent: "Fix invalid input acceptance",
    defect: "Parser accepts X which must be rejected",
  };
}

function makeProject(id: ProjectId) {
  return { id };
}

test("freezeContract copies proposal bounds (not authority schema bounds)", () => {
  const proposal = makeNarrowProposal();
  const workItem = makeWorkItem();
  const project = makeProject(workItem.projectId);
  const contractId = newId("sc");
  const decisionId = newId("dec");

  const contract = freezeContract({
    proposal,
    decisionId,
    workItem,
    project,
    baseRevision: "a".repeat(40),
    profileDigest: testDigest("a"),
    criteriaDigest: testDigest("b"),
    requiredBoundaries: ["worktree", "output_paths"],
    humanRequired: false,
    version: 1,
    id: contractId,
  });

  // Bounds should come from the proposal, not from HOST_TRIAL_AUTHORITY
  assert.deepEqual(contract.bounds.paths.allow, proposal.paths.allow);
  assert.notDeepEqual(contract.bounds.paths.allow, HOST_AUTHORITY.paths.allow);

  // Budget from proposal (maxAttempts: 1), not from authority (maxAttempts: 2)
  assert.equal(contract.bounds.budget.maxAttempts, 1);
  assert.notEqual(contract.bounds.budget.maxAttempts, HOST_AUTHORITY.budget.maxAttempts);

  // Criteria preserved
  assert.equal(contract.criteria.length, 1);
  assert.equal(contract.criteria[0]?.id, "c1");

  // Status is active
  assert.equal(contract.status, "active");
  assert.equal(contract.version, 1);
});

test("freezeContract sets required fields from inputs", () => {
  const proposal = makeNarrowProposal();
  const workItem = makeWorkItem();
  const project = makeProject(workItem.projectId);
  const contractId = newId("sc");
  const decisionId = newId("dec");
  const baseRevision = "f".repeat(40);

  const contract = freezeContract({
    proposal,
    decisionId,
    workItem,
    project,
    baseRevision,
    profileDigest: testDigest("c"),
    criteriaDigest: testDigest("d"),
    requiredBoundaries: [],
    humanRequired: true,
    version: 1,
    id: contractId,
  });

  assert.equal(contract.id, contractId);
  assert.equal(contract.workItemId, workItem.id);
  assert.equal(contract.projectId, workItem.projectId);
  assert.equal(contract.baseRevision, baseRevision);
  assert.equal(contract.humanRequired, true);
  assert.equal(contract.inputs.intent, workItem.intent);
  assert.equal(contract.inputs.defect, workItem.defect);
});

test("supersede marks old as superseded with supersededBy and next has version+1", () => {
  const proposal = makeNarrowProposal();
  const workItem = makeWorkItem();
  const project = makeProject(workItem.projectId);
  const contractId = newId("sc");
  const decisionId = newId("dec");

  const original = freezeContract({
    proposal,
    decisionId,
    workItem,
    project,
    baseRevision: "a".repeat(40),
    profileDigest: testDigest("a"),
    criteriaDigest: testDigest("b"),
    requiredBoundaries: [],
    humanRequired: false,
    version: 1,
    id: contractId,
  });

  // A different proposal for the replacement (must pass replacement fields explicitly)
  const replacementProposal: LeadProposal = {
    ...makeNarrowProposal(),
    criteria: [
      {
        id: "c2",
        text: "Updated criterion.",
        source: "lead",
        citation: "lead-analysis",
      },
    ],
  };

  const nextId = newId("sc") as StepContractId;
  const newBaseRevision = "b".repeat(40);
  const newProfileDigest = testDigest("e");
  const newCriteriaDigest = testDigest("f");

  const { old, next } = supersede(original, {
    nextId,
    proposal: replacementProposal,
    baseRevision: newBaseRevision,
    profileDigest: newProfileDigest,
    criteriaDigest: newCriteriaDigest,
    requiredBoundaries: ["output_paths"],
    humanRequired: false,
  });

  // Old contract should be marked superseded
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, nextId);
  assert.equal(old.version, 1);

  // Next contract should have version+1
  assert.equal(next.status, "active");
  assert.equal(next.version, 2);
  assert.equal(next.id, nextId);

  // Next contract should use the replacement proposal's criteria and digests
  assert.equal(next.criteria.length, 1);
  assert.equal(next.criteria[0]?.id, "c2");
  assert.equal(next.criteriaDigest, newCriteriaDigest);
  assert.equal(next.profileDigest, newProfileDigest);
  assert.equal(next.baseRevision, newBaseRevision);
});

test("supersede does not silently carry over old criteria digest", () => {
  const proposal = makeNarrowProposal();
  const workItem = makeWorkItem();
  const project = makeProject(workItem.projectId);
  const contractId = newId("sc");
  const decisionId = newId("dec");
  const originalCriteriaDigest = testDigest("b");

  const original = freezeContract({
    proposal,
    decisionId,
    workItem,
    project,
    baseRevision: "a".repeat(40),
    profileDigest: `sha256:${"a".repeat(64)}`,
    criteriaDigest: originalCriteriaDigest,
    requiredBoundaries: [],
    humanRequired: false,
    version: 1,
    id: contractId,
  });

  const nextId = newId("sc") as StepContractId;
  const newCriteriaDigest = testDigest("9");

  const { next } = supersede(original, {
    nextId,
    proposal: makeNarrowProposal(),
    baseRevision: "c".repeat(40),
    profileDigest: testDigest("a"),
    criteriaDigest: newCriteriaDigest,
    requiredBoundaries: [],
    humanRequired: false,
  });

  // Must use the explicitly provided digest, not the old one
  assert.equal(next.criteriaDigest, newCriteriaDigest);
  assert.notEqual(next.criteriaDigest, originalCriteriaDigest);
});
