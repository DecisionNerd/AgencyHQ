/**
 * Acceptance evaluation tests.
 *
 * Each reason code is triggered individually (where possible) so that each
 * failure mode is verified independently.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptanceProposal, StepContract, VerificationResult } from "@agencyhq/contracts";
import { evaluateAcceptance } from "../src/evidence/acceptance.ts";
import { verificationResultRef } from "../src/evidence/match.ts";
import type { ApprovalLike, ArtifactLike, AttemptLike, ReviewLike } from "../src/evidence/types.ts";

// ---------------------------------------------------------------------------
// Inline fixture helpers
// ---------------------------------------------------------------------------
const CRITERIA_DIGEST: `sha256:${string}` = `sha256:${"c".repeat(64)}`;
const PROFILE_DIGEST: `sha256:${string}` = `sha256:${"d".repeat(64)}`;
const DIFF_DIGEST: `sha256:${string}` = `sha256:${"e".repeat(64)}`;
const ALT_DIGEST: `sha256:${string}` = `sha256:${"f".repeat(64)}`;

const ALL_TOOLS_FALSE = {
  edit: false,
  webfetch: false,
  websearch: false,
  task: false,
  external_directory: false,
  skill: false,
} as const;

function makeContract(overrides: Partial<StepContract> = {}): StepContract {
  return {
    id: "contract-1",
    workItemId: "wi-1",
    projectId: "proj-1",
    version: 1,
    baseRevision: "a".repeat(40),
    inputs: { intent: "fix parser" },
    criteria: [{ id: "c1", text: "rejects invalid input", source: "operator" }],
    criteriaDigest: CRITERIA_DIGEST,
    profileId: "profile-1",
    profileDigest: PROFILE_DIGEST,
    bounds: {
      paths: { allow: ["src/**"], deny: [] },
      capabilities: { bash: { allow: [], deny: [] }, tools: ALL_TOOLS_FALSE },
      boundary: "artifact",
      budget: { maxAttempts: 2, maxDurationSeconds: 1200, estimatedSpendUsd: 0 },
      review: "adversarial",
      changeClass: "behavior",
      models: { worker: "claude-opus", reviewer: "claude-sonnet" },
    },
    requiredBoundaries: [],
    humanRequired: false,
    status: "active",
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptLike> = {}): AttemptLike {
  return {
    id: "attempt-1",
    contractId: "contract-1",
    contractVersion: 1,
    generation: 0,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<ArtifactLike> = {}): ArtifactLike {
  return {
    revision: "b".repeat(40),
    diffDigest: DIFF_DIGEST,
    changedPaths: ["src/parser.ts"],
    ...overrides,
  };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    verifier: { name: "pnpm-test", version: "1.0" },
    stepContractId: "contract-1",
    attemptId: "attempt-1",
    criteriaDigest: CRITERIA_DIGEST,
    profileDigest: PROFILE_DIGEST,
    repository: "org/repo",
    baseRevision: "a".repeat(40),
    attemptRevision: "b".repeat(40),
    diffDigest: DIFF_DIGEST,
    checkId: "typecheck",
    environmentFingerprint: { node: "22.0.0" },
    startedAt: "2024-01-01T00:00:00Z",
    endedAt: "2024-01-01T00:01:00Z",
    exitStatus: 0,
    stdoutTail: "",
    stderrTail: "",
    artifactDigests: [],
    result: "pass",
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewLike> = {}): ReviewLike {
  return {
    attemptRevision: "b".repeat(40),
    diffDigest: DIFF_DIGEST,
    criteriaDigest: CRITERIA_DIGEST,
    profileDigest: PROFILE_DIGEST,
    reviewerModel: "claude-sonnet",
    profile: "adversarial",
    findings: [],
    ...overrides,
  };
}

function makeApproval(overrides: Partial<ApprovalLike> = {}): ApprovalLike {
  return {
    contractId: "contract-1",
    contractVersion: 1,
    attemptRevision: "b".repeat(40),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const CONTRACT = makeContract({
  criteria: [
    { id: "c1", text: "rejects invalid input", source: "operator" },
    { id: "c2", text: "accepts valid input", source: "operator" },
  ],
});

const ATTEMPT = makeAttempt();
const ARTIFACT = makeArtifact();

const R1 = makeVerificationResult({ checkId: "check-c1" });
const R2 = makeVerificationResult({ checkId: "check-c2" });

const r1Ref = verificationResultRef(R1);
const r2Ref = verificationResultRef(R2);

const PROPOSAL: AcceptanceProposal = {
  accept: true,
  criteria: [
    { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref: r1Ref }] },
    { criterionId: "c2", satisfied: true, evidence: [{ kind: "verification_result", ref: r2Ref }] },
  ],
  findingDispositions: [],
  rationale: "All checks pass.",
};

const REVIEW = makeReview();

function baseInput(): Parameters<typeof evaluateAcceptance>[0] {
  return {
    contract: CONTRACT,
    attempt: ATTEMPT,
    artifact: ARTIFACT,
    results: [R1, R2],
    review: REVIEW,
    proposal: PROPOSAL,
    approval: undefined,
    reviewerMustDiffer: false,
    workerModel: "claude-opus",
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test("acceptance: happy path returns ok:true", () => {
  const r = evaluateAcceptance(baseInput());
  assert.ok(r.ok, `Expected ok but got: ${JSON.stringify(!r.ok && r)}`);
});

// ---------------------------------------------------------------------------
// PROPOSAL_REJECTS
// ---------------------------------------------------------------------------
test("acceptance: PROPOSAL_REJECTS when accept is false", () => {
  const input = baseInput();
  input.proposal = { ...PROPOSAL, accept: false };
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("PROPOSAL_REJECTS"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// CRITERION_UNCITED
// ---------------------------------------------------------------------------
test("acceptance: CRITERION_UNCITED when criterion missing from proposal", () => {
  const input = baseInput();
  const first = PROPOSAL.criteria[0];
  assert.ok(first !== undefined);
  input.proposal = { ...PROPOSAL, criteria: [first] };
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CRITERION_UNCITED"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// CRITERION_UNSATISFIED
// ---------------------------------------------------------------------------
test("acceptance: CRITERION_UNSATISFIED when satisfied is false", () => {
  const input = baseInput();
  const second = PROPOSAL.criteria[1];
  assert.ok(second !== undefined);
  input.proposal = {
    ...PROPOSAL,
    criteria: [{ criterionId: "c1", satisfied: false, evidence: [] }, second],
  };
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CRITERION_UNSATISFIED"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// CITED_RESULT_MISSING
// ---------------------------------------------------------------------------
test("acceptance: CITED_RESULT_MISSING when ref not in results", () => {
  const input = baseInput();
  const second = PROPOSAL.criteria[1];
  assert.ok(second !== undefined);
  input.proposal = {
    ...PROPOSAL,
    criteria: [
      {
        criterionId: "c1",
        satisfied: true,
        evidence: [{ kind: "verification_result", ref: "nonexistent-ref" }],
      },
      second,
    ],
  };
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CITED_RESULT_MISSING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// RESULT_VERSION_MISMATCH
// ---------------------------------------------------------------------------
test("acceptance: RESULT_VERSION_MISMATCH when result has wrong profileDigest", () => {
  const staleResult = makeVerificationResult({ checkId: "check-c1", profileDigest: ALT_DIGEST });
  const ref = verificationResultRef(staleResult);
  const input = baseInput();
  input.results = [staleResult, R2];
  const second = PROPOSAL.criteria[1];
  assert.ok(second !== undefined);
  input.proposal = {
    ...PROPOSAL,
    criteria: [
      { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref }] },
      second,
    ],
  };
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("RESULT_VERSION_MISMATCH"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// CITED_RESULT_NOT_PASSING
// ---------------------------------------------------------------------------
test("acceptance: CITED_RESULT_NOT_PASSING when result is fail", () => {
  const failResult = makeVerificationResult({ checkId: "check-c1", result: "fail", exitStatus: 1 });
  const ref = verificationResultRef(failResult);
  const input = baseInput();
  input.results = [failResult, R2];
  const second = PROPOSAL.criteria[1];
  assert.ok(second !== undefined);
  input.proposal = {
    ...PROPOSAL,
    criteria: [
      { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref }] },
      second,
    ],
  };
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CITED_RESULT_NOT_PASSING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// REVIEW_MISSING
// ---------------------------------------------------------------------------
test("acceptance: REVIEW_MISSING when review is absent", () => {
  const input = baseInput();
  input.review = undefined;
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEW_MISSING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// REVIEW_VERSION_MISMATCH
// ---------------------------------------------------------------------------
test("acceptance: REVIEW_VERSION_MISMATCH when review has wrong criteriaDigest", () => {
  const input = baseInput();
  input.review = makeReview({ criteriaDigest: ALT_DIGEST });
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEW_VERSION_MISMATCH"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// REVIEW_BLOCKING
// ---------------------------------------------------------------------------
test("acceptance: REVIEW_BLOCKING when review has blocking finding", () => {
  const input = baseInput();
  input.review = makeReview({
    findings: [
      {
        id: "f1",
        severity: "blocking",
        kind: "unmet_criterion",
        description: "c1 not met",
        evidence: "line 42",
      },
    ],
  });
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEW_BLOCKING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// REVIEW_BELOW_REQUIRED
// ---------------------------------------------------------------------------
test("acceptance: REVIEW_BELOW_REQUIRED when profile is weaker than required", () => {
  const input = baseInput();
  input.review = makeReview({ profile: "lead_inspection" });
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEW_BELOW_REQUIRED"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// REVIEWER_NOT_DISTINCT (via reviewerMustDiffer flag)
// ---------------------------------------------------------------------------
test("acceptance: REVIEWER_NOT_DISTINCT when reviewer model equals worker model and reviewerMustDiffer", () => {
  const input = baseInput();
  input.workerModel = "claude-opus";
  input.review = makeReview({ reviewerModel: "claude-opus" });
  input.reviewerMustDiffer = true;
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEWER_NOT_DISTINCT"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// REVIEWER_NOT_DISTINCT (via contract.bounds.review === "adversarial_distinct_model")
// ---------------------------------------------------------------------------
test("acceptance: REVIEWER_NOT_DISTINCT when contract requires adversarial_distinct_model", () => {
  const input = baseInput();
  input.contract = makeContract({
    criteria: CONTRACT.criteria,
    bounds: { ...CONTRACT.bounds, review: "adversarial_distinct_model" },
  });
  input.workerModel = "claude-opus";
  input.review = makeReview({
    reviewerModel: "claude-opus",
    profile: "adversarial_distinct_model",
  });
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEWER_NOT_DISTINCT"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// APPROVAL_REQUIRED
// ---------------------------------------------------------------------------
test("acceptance: APPROVAL_REQUIRED when humanRequired and no approval", () => {
  const input = baseInput();
  input.contract = makeContract({ criteria: CONTRACT.criteria, humanRequired: true });
  input.approval = undefined;
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("APPROVAL_REQUIRED"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// APPROVAL_VERSION_MISMATCH (R-018)
// ---------------------------------------------------------------------------
test("acceptance: APPROVAL_VERSION_MISMATCH when approval is for wrong version", () => {
  const input = baseInput();
  input.contract = makeContract({ criteria: CONTRACT.criteria, humanRequired: true });
  const wrongVersion: ApprovalLike = {
    contractId: "contract-1",
    contractVersion: 2,
    attemptRevision: "b".repeat(40),
  };
  input.approval = wrongVersion;
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("APPROVAL_VERSION_MISMATCH"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// Multiple reasons collected simultaneously
// ---------------------------------------------------------------------------
test("acceptance: collects multiple reasons simultaneously", () => {
  const input = baseInput();
  input.proposal = { ...PROPOSAL, accept: false };
  input.review = undefined;
  const r = evaluateAcceptance(input);
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("PROPOSAL_REJECTS"), `codes: ${codes}`);
  assert.ok(codes.includes("REVIEW_MISSING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// Contract with review=none: no REVIEW_MISSING even without review
// ---------------------------------------------------------------------------
test("acceptance: no REVIEW_MISSING when contract.bounds.review is none", () => {
  const contractNoReview: StepContract = makeContract({
    criteria: CONTRACT.criteria,
    bounds: { ...CONTRACT.bounds, review: "none" },
  });
  const input = baseInput();
  input.contract = contractNoReview;
  input.review = undefined;
  const r = evaluateAcceptance(input);
  assert.ok(r.ok, `Expected ok but got: ${JSON.stringify(!r.ok && r)}`);
});

// ---------------------------------------------------------------------------
// Approval happy path (humanRequired with matching approval)
// ---------------------------------------------------------------------------
test("acceptance: ok with humanRequired and matching approval", () => {
  const input = baseInput();
  input.contract = makeContract({ criteria: CONTRACT.criteria, humanRequired: true });
  input.approval = makeApproval();
  const r = evaluateAcceptance(input);
  assert.ok(r.ok, `Expected ok but got: ${JSON.stringify(!r.ok && r)}`);
});
