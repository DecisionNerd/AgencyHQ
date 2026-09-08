/**
 * Supersede-evidence tests (R-018).
 *
 * VerificationResults, Reviews, and Approvals that match contract v1 must
 * NOT match a v2 contract with the same ids but different digests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { StepContract, VerificationResult } from "@agencyhq/contracts";
import { approvalMatches, reviewMatches, verificationMatches } from "../src/evidence/match.ts";
import type { ApprovalLike, ArtifactLike, AttemptLike, ReviewLike } from "../src/evidence/types.ts";

// ---------------------------------------------------------------------------
// Inline fixture helpers
// ---------------------------------------------------------------------------
const ALL_TOOLS_FALSE = {
  edit: false,
  webfetch: false,
  websearch: false,
  task: false,
  external_directory: false,
  skill: false,
} as const;

function sha256Digest(hex: string): `sha256:${string}` {
  return `sha256:${hex.padEnd(64, hex.slice(-1))}` as `sha256:${string}`;
}

function makeContract(overrides: Partial<StepContract> = {}): StepContract {
  return {
    id: "contract-sup",
    workItemId: "wi-sup",
    projectId: "proj-sup",
    version: 1,
    baseRevision: "a".repeat(40),
    inputs: { intent: "initial" },
    criteria: [{ id: "c1", text: "old criterion", source: "operator" }],
    criteriaDigest: sha256Digest("c".repeat(64)),
    profileId: "profile-1",
    profileDigest: sha256Digest("d".repeat(64)),
    bounds: {
      paths: { allow: ["src/**"], deny: [] },
      capabilities: { bash: { allow: [], deny: [] }, tools: ALL_TOOLS_FALSE },
      boundary: "artifact",
      budget: { maxAttempts: 2, maxDurationSeconds: 600, estimatedSpendUsd: 0 },
      review: "adversarial",
      changeClass: "behavior",
      models: { worker: "claude-opus", reviewer: "claude-sonnet" },
    },
    requiredBoundaries: [],
    humanRequired: false,
    status: "superseded",
    supersededBy: "contract-sup-v2",
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptLike> = {}): AttemptLike {
  return {
    id: "attempt-v1",
    contractId: "contract-sup",
    contractVersion: 1,
    generation: 0,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<ArtifactLike> = {}): ArtifactLike {
  return {
    revision: "b".repeat(40),
    diffDigest: sha256Digest("e".repeat(64)),
    changedPaths: ["src/output.ts"],
    ...overrides,
  };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    verifier: { name: "pnpm-test", version: "1.0" },
    stepContractId: "contract-sup",
    attemptId: "attempt-v1",
    criteriaDigest: sha256Digest("c".repeat(64)),
    profileDigest: sha256Digest("d".repeat(64)),
    repository: "org/repo",
    baseRevision: "a".repeat(40),
    attemptRevision: "b".repeat(40),
    diffDigest: sha256Digest("e".repeat(64)),
    checkId: "check-c1",
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
    diffDigest: sha256Digest("e".repeat(64)),
    criteriaDigest: sha256Digest("c".repeat(64)),
    profileDigest: sha256Digest("d".repeat(64)),
    reviewerModel: "claude-sonnet",
    profile: "adversarial",
    findings: [],
    ...overrides,
  };
}

function makeApproval(overrides: Partial<ApprovalLike> = {}): ApprovalLike {
  return {
    contractId: "contract-sup",
    contractVersion: 1,
    attemptRevision: "b".repeat(40),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract v1
// ---------------------------------------------------------------------------
const CONTRACT_V1 = makeContract();

// ---------------------------------------------------------------------------
// Contract v2 — same id, incremented version, DIFFERENT digests
// ---------------------------------------------------------------------------
const CONTRACT_V2 = makeContract({
  version: 2,
  criteria: [
    { id: "c1", text: "new criterion text", source: "operator" },
    { id: "c2", text: "additional criterion", source: "lead" },
  ],
  criteriaDigest: sha256Digest("9".repeat(64)), // different!
  profileId: "profile-2",
  profileDigest: sha256Digest("8".repeat(64)), // different!
  status: "active",
  supersededBy: undefined,
});

const ATTEMPT_V1 = makeAttempt();
const ARTIFACT_V1 = makeArtifact();
const RESULT_V1 = makeVerificationResult();
const REVIEW_V1: ReviewLike = makeReview();
const APPROVAL_V1: ApprovalLike = makeApproval();

// ---------------------------------------------------------------------------
// Evidence from v1 matches v1
// ---------------------------------------------------------------------------
test("supersede (R-018): VerificationResult from v1 matches contract v1", () => {
  const r = verificationMatches(RESULT_V1, CONTRACT_V1, ATTEMPT_V1, ARTIFACT_V1);
  assert.ok(r.ok, `Expected match with v1 but got mismatches: ${JSON.stringify(!r.ok && r)}`);
});

test("supersede (R-018): Review from v1 matches contract v1", () => {
  const r = reviewMatches(REVIEW_V1, CONTRACT_V1, ARTIFACT_V1);
  assert.ok(r.ok, `Expected match with v1 but got mismatches: ${JSON.stringify(!r.ok && r)}`);
});

test("supersede (R-018): Approval bound to v1 matches contract v1", () => {
  const r = approvalMatches(APPROVAL_V1, CONTRACT_V1, ARTIFACT_V1);
  assert.ok(r.ok, `Expected match with v1 but got mismatches: ${JSON.stringify(!r.ok && r)}`);
});

// ---------------------------------------------------------------------------
// Evidence from v1 does NOT match v2 (R-018)
// ---------------------------------------------------------------------------
test("supersede (R-018): VerificationResult from v1 does not match contract v2", () => {
  const r = verificationMatches(RESULT_V1, CONTRACT_V2, ATTEMPT_V1, ARTIFACT_V1);
  assert.ok(!r.ok, "Expected mismatch: v1 evidence must not match v2 contract");
  assert.ok(
    r.mismatches.includes("criteriaDigest") || r.mismatches.includes("profileDigest"),
    `Expected digest mismatch, got: ${r.mismatches}`,
  );
});

test("supersede (R-018): Review from v1 does not match contract v2", () => {
  const r = reviewMatches(REVIEW_V1, CONTRACT_V2, ARTIFACT_V1);
  assert.ok(!r.ok, "Expected mismatch: v1 review must not match v2 contract");
  assert.ok(
    r.mismatches.includes("criteriaDigest") || r.mismatches.includes("profileDigest"),
    `Expected digest mismatch, got: ${r.mismatches}`,
  );
});

test("supersede (R-018): Approval bound to v1 does not match contract v2", () => {
  const r = approvalMatches(APPROVAL_V1, CONTRACT_V2, ARTIFACT_V1);
  assert.ok(!r.ok, "Expected mismatch: v1 approval must not match v2 contract");
  assert.ok(
    r.mismatches.includes("contractVersion"),
    `Expected contractVersion mismatch, got: ${r.mismatches}`,
  );
});

// ---------------------------------------------------------------------------
// V2 evidence matches v2
// ---------------------------------------------------------------------------
const ATTEMPT_V2 = makeAttempt({
  id: "attempt-v2",
  contractVersion: 2,
});

const ARTIFACT_V2 = makeArtifact({
  revision: "f".repeat(40),
  diffDigest: sha256Digest("7".repeat(64)),
  changedPaths: ["src/output.ts", "src/parser.ts"],
});

const RESULT_V2 = makeVerificationResult({
  attemptId: "attempt-v2",
  criteriaDigest: sha256Digest("9".repeat(64)),
  profileDigest: sha256Digest("8".repeat(64)),
  attemptRevision: "f".repeat(40),
  diffDigest: sha256Digest("7".repeat(64)),
});

test("supersede (R-018): VerificationResult from v2 matches contract v2", () => {
  const r = verificationMatches(RESULT_V2, CONTRACT_V2, ATTEMPT_V2, ARTIFACT_V2);
  assert.ok(r.ok, `Expected match with v2 but got mismatches: ${JSON.stringify(!r.ok && r)}`);
});
