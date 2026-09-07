/**
 * Evidence matching unit tests.
 * Tests each field mismatch individually.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { StepContract, VerificationResult } from "@agencyhq/contracts";
import {
  approvalMatches,
  reviewMatches,
  verificationMatches,
  verificationResultRef,
} from "../src/evidence/match.ts";
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

const CONTRACT = makeContract();
const ATTEMPT = makeAttempt();
const ARTIFACT = makeArtifact();
const RESULT = makeVerificationResult();
const REVIEW = makeReview();
const APPROVAL = makeApproval();

// ---------------------------------------------------------------------------
// verificationResultRef
// ---------------------------------------------------------------------------
test("verificationResultRef: stable ref format", () => {
  const ref = verificationResultRef(RESULT);
  assert.equal(ref, `pnpm-test:typecheck:${"b".repeat(40)}`);
});

// ---------------------------------------------------------------------------
// verificationMatches: happy path
// ---------------------------------------------------------------------------
test("verificationMatches: ok when all fields match", () => {
  const r = verificationMatches(RESULT, CONTRACT, ATTEMPT, ARTIFACT);
  assert.deepEqual(r, { ok: true });
});

// ---------------------------------------------------------------------------
// verificationMatches: individual field mismatches
// ---------------------------------------------------------------------------
test("verificationMatches: criteriaDigest mismatch", () => {
  const bad = makeVerificationResult({ criteriaDigest: ALT_DIGEST });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("criteriaDigest"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: profileDigest mismatch", () => {
  const bad = makeVerificationResult({ profileDigest: ALT_DIGEST });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("profileDigest"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: baseRevision mismatch", () => {
  const bad = makeVerificationResult({ baseRevision: "c".repeat(40) });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("baseRevision"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: attemptRevision mismatch", () => {
  const bad = makeVerificationResult({ attemptRevision: "c".repeat(40) });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("attemptRevision"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: diffDigest mismatch", () => {
  const bad = makeVerificationResult({ diffDigest: ALT_DIGEST });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("diffDigest"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: stepContractId mismatch", () => {
  const bad = makeVerificationResult({ stepContractId: "other-contract" });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("stepContractId"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: attemptId mismatch", () => {
  const bad = makeVerificationResult({ attemptId: "other-attempt" });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("attemptId"));
  assert.equal(r.mismatches.length, 1);
});

test("verificationMatches: multiple field mismatches reported together", () => {
  const bad = makeVerificationResult({ criteriaDigest: ALT_DIGEST, profileDigest: ALT_DIGEST });
  const r = verificationMatches(bad, CONTRACT, ATTEMPT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("criteriaDigest"));
  assert.ok(r.mismatches.includes("profileDigest"));
  assert.equal(r.mismatches.length, 2);
});

// ---------------------------------------------------------------------------
// reviewMatches: happy path
// ---------------------------------------------------------------------------
test("reviewMatches: ok when all fields match", () => {
  const r = reviewMatches(REVIEW, CONTRACT, ARTIFACT);
  assert.deepEqual(r, { ok: true });
});

// ---------------------------------------------------------------------------
// reviewMatches: individual field mismatches
// ---------------------------------------------------------------------------
test("reviewMatches: attemptRevision mismatch", () => {
  const bad: ReviewLike = { ...REVIEW, attemptRevision: "c".repeat(40) };
  const r = reviewMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("attemptRevision"));
  assert.equal(r.mismatches.length, 1);
});

test("reviewMatches: diffDigest mismatch", () => {
  const bad: ReviewLike = { ...REVIEW, diffDigest: ALT_DIGEST };
  const r = reviewMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("diffDigest"));
  assert.equal(r.mismatches.length, 1);
});

test("reviewMatches: criteriaDigest mismatch", () => {
  const bad: ReviewLike = { ...REVIEW, criteriaDigest: ALT_DIGEST };
  const r = reviewMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("criteriaDigest"));
  assert.equal(r.mismatches.length, 1);
});

test("reviewMatches: profileDigest mismatch", () => {
  const bad: ReviewLike = { ...REVIEW, profileDigest: ALT_DIGEST };
  const r = reviewMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("profileDigest"));
  assert.equal(r.mismatches.length, 1);
});

// ---------------------------------------------------------------------------
// approvalMatches: happy path
// ---------------------------------------------------------------------------
test("approvalMatches: ok when all fields match", () => {
  const r = approvalMatches(APPROVAL, CONTRACT, ARTIFACT);
  assert.deepEqual(r, { ok: true });
});

test("approvalMatches: ok when attemptRevision absent", () => {
  const noRev: ApprovalLike = { contractId: "contract-1", contractVersion: 1 };
  const r = approvalMatches(noRev, CONTRACT, ARTIFACT);
  assert.deepEqual(r, { ok: true });
});

// ---------------------------------------------------------------------------
// approvalMatches: individual field mismatches (R-018)
// ---------------------------------------------------------------------------
test("approvalMatches: contractId mismatch", () => {
  const bad: ApprovalLike = { ...APPROVAL, contractId: "other" };
  const r = approvalMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("contractId"));
  assert.equal(r.mismatches.length, 1);
});

test("approvalMatches: contractVersion mismatch (R-018)", () => {
  const bad: ApprovalLike = { ...APPROVAL, contractVersion: 2 };
  const r = approvalMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("contractVersion"));
  assert.equal(r.mismatches.length, 1);
});

test("approvalMatches: attemptRevision mismatch", () => {
  const bad: ApprovalLike = { ...APPROVAL, attemptRevision: "c".repeat(40) };
  const r = approvalMatches(bad, CONTRACT, ARTIFACT);
  assert.ok(!r.ok);
  assert.ok(r.mismatches.includes("attemptRevision"));
  assert.equal(r.mismatches.length, 1);
});
