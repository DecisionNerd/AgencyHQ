/**
 * Tests for v2 task payloads (P18.1).
 *
 * C1: v1 payloads (no payloadVersion or payloadVersion: 1) still parse.
 * C2: v2 payloads with any repoPath/worktreeBase/patchPath/manifestRepoPaths key are rejected.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY } from "../src/index.ts";
import {
  IntegrateMergePayloadAnySchema,
  IntegrateMergePayloadSchema,
  IntegrateMergePayloadV1Schema,
  IntegrateMergePayloadV2Schema,
  isV2Payload as isV2IntegrateMergePayload,
} from "../src/tasks/integrate-merge.ts";
import {
  isV2Payload as isV2LeadAcceptPayload,
  LeadAcceptPayloadAnySchema,
  LeadAcceptPayloadSchema,
  LeadAcceptPayloadV1Schema,
  LeadAcceptPayloadV2Schema,
} from "../src/tasks/lead-accept.ts";
import {
  isV2Payload as isV2LeadPlanPayload,
  LeadPlanPayloadAnySchema,
  LeadPlanPayloadSchema,
  LeadPlanPayloadV1Schema,
  LeadPlanPayloadV2Schema,
} from "../src/tasks/lead-plan.ts";
import {
  isV2Payload as isV2LeadReviewPayload,
  LeadReviewPayloadAnySchema,
  LeadReviewPayloadSchema,
  LeadReviewPayloadV1Schema,
  LeadReviewPayloadV2Schema,
} from "../src/tasks/lead-review.ts";
import {
  isV2Payload as isV2VerifyRunPayload,
  VerifyRunPayloadAnySchema,
  VerifyRunPayloadSchema,
  VerifyRunPayloadV1Schema,
  VerifyRunPayloadV2Schema,
} from "../src/tasks/verify-run.ts";
import {
  isV2Payload as isV2WorkerAttemptPayload,
  WorkerAttemptPayloadAnySchema,
  WorkerAttemptPayloadSchema,
  WorkerAttemptPayloadV1Schema,
  WorkerAttemptPayloadV2Schema,
} from "../src/tasks/worker-attempt.ts";

const SHA40 = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

// Shared fixtures
const SOURCE_REF = {
  projectId: "proj-1",
  revision: SHA40,
  bundlePath: "/internal/source/proj-1?rev=" + SHA40,
};

const AUTHORITY = HOST_TRIAL_AUTHORITY;

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

const PERMISSION_RULES = {
  "*": "deny" as const,
  read: "allow" as const,
  glob: "allow" as const,
  grep: "allow" as const,
  list: "allow" as const,
  edit: {},
  bash: {},
  task: "deny" as const,
  webfetch: "deny" as const,
  websearch: "deny" as const,
  skill: "deny" as const,
  external_directory: "deny" as const,
  doom_loop: "deny" as const,
};

const CRITERION = { id: "c1", text: "Tests pass", source: "operator" as const };
const VERIFICATION_RESULT = {
  verifier: { name: "test", version: "0.0.1" },
  stepContractId: "sc-1",
  attemptId: "att-1",
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  repository: "github.com/org/repo",
  baseRevision: "abc",
  attemptRevision: "def",
  diffDigest: DIGEST,
  checkId: "check-1",
  environmentFingerprint: {},
  startedAt: "2026-09-09T10:00:00.000Z",
  endedAt: "2026-09-09T10:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "",
  stderrTail: "",
  artifactDigests: [],
  result: "pass" as const,
};
const REVIEW = {
  reviewer: { model: "claude-opus-4" },
  subject: {
    attemptRevision: SHA40,
    diffDigest: DIGEST,
    criteriaDigest: DIGEST,
    profileDigest: DIGEST,
  },
  findings: [],
};

// ---------------------------------------------------------------------------
// WorkerAttemptPayload
// ---------------------------------------------------------------------------

const workerV1 = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  contractVersion: "1",
  repoPath: "/repo",
  baseRev: SHA40,
  prompt: "do stuff",
  allowedPaths: [],
  bounds: BOUNDS,
  permissionRules: PERMISSION_RULES,
  model: "claude-opus-4",
};

const workerV2 = {
  payloadVersion: 2 as const,
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  contractVersion: "1",
  source: SOURCE_REF,
  baseRev: SHA40,
  prompt: "do stuff",
  allowedPaths: [],
  bounds: BOUNDS,
  permissionRules: PERMISSION_RULES,
  model: "claude-opus-4",
};

test("WorkerAttemptPayload v1: parses without payloadVersion", () => {
  assert.equal(WorkerAttemptPayloadSchema.safeParse(workerV1).success, true);
});

test("WorkerAttemptPayload v1: parses with payloadVersion: 1", () => {
  assert.equal(
    WorkerAttemptPayloadSchema.safeParse({ ...workerV1, payloadVersion: 1 }).success,
    true,
  );
});

test("WorkerAttemptPayload v2: parses with source (via AnySchema)", () => {
  assert.equal(WorkerAttemptPayloadAnySchema.safeParse(workerV2).success, true);
});

test("WorkerAttemptPayload v2: rejects repoPath", () => {
  assert.equal(
    WorkerAttemptPayloadV2Schema.safeParse({ ...workerV2, repoPath: "/repo" }).success,
    false,
  );
});

test("WorkerAttemptPayload v2: rejects worktreeBase", () => {
  assert.equal(
    WorkerAttemptPayloadV2Schema.safeParse({ ...workerV2, worktreeBase: "/wt" }).success,
    false,
  );
});

test("isV2WorkerAttemptPayload: returns false for v1", () => {
  const p = WorkerAttemptPayloadAnySchema.parse(workerV1);
  assert.equal(isV2WorkerAttemptPayload(p), false);
});

test("isV2WorkerAttemptPayload: returns true for v2", () => {
  const p = WorkerAttemptPayloadAnySchema.parse(workerV2);
  assert.equal(isV2WorkerAttemptPayload(p), true);
});

// ---------------------------------------------------------------------------
// LeadPlanPayload
// ---------------------------------------------------------------------------

const leadPlanV1 = {
  workItemId: "wi-1",
  projectId: "proj-1",
  repoPath: "/repo",
  baseRevision: SHA40,
  worktreeBase: "/wt",
  authority: AUTHORITY,
  operatorIntent: "fix bug",
  model: "claude-opus-4",
};

const leadPlanV2 = {
  payloadVersion: 2 as const,
  workItemId: "wi-1",
  projectId: "proj-1",
  source: SOURCE_REF,
  baseRevision: SHA40,
  authority: AUTHORITY,
  operatorIntent: "fix bug",
  model: "claude-opus-4",
};

test("LeadPlanPayload v1: parses without payloadVersion", () => {
  assert.equal(LeadPlanPayloadSchema.safeParse(leadPlanV1).success, true);
});

test("LeadPlanPayload v2: parses with source (via AnySchema)", () => {
  assert.equal(LeadPlanPayloadAnySchema.safeParse(leadPlanV2).success, true);
});

test("LeadPlanPayload v2: rejects repoPath", () => {
  assert.equal(
    LeadPlanPayloadV2Schema.safeParse({ ...leadPlanV2, repoPath: "/repo" }).success,
    false,
  );
});

test("LeadPlanPayload v2: rejects worktreeBase", () => {
  assert.equal(
    LeadPlanPayloadV2Schema.safeParse({ ...leadPlanV2, worktreeBase: "/wt" }).success,
    false,
  );
});

test("isV2LeadPlanPayload: returns false for v1", () => {
  const p = LeadPlanPayloadAnySchema.parse(leadPlanV1);
  assert.equal(isV2LeadPlanPayload(p), false);
});

test("isV2LeadPlanPayload: returns true for v2", () => {
  const p = LeadPlanPayloadAnySchema.parse(leadPlanV2);
  assert.equal(isV2LeadPlanPayload(p), true);
});

// ---------------------------------------------------------------------------
// VerifyRunPayload
// ---------------------------------------------------------------------------

const verifyV1 = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  profileId: "p1",
  profileDigest: DIGEST,
  criteriaDigest: DIGEST,
  repoPath: "/repo",
  worktreeBase: "/wt",
  baseRevision: SHA40,
  attemptRevision: SHA40,
  diffDigest: DIGEST,
  checks: [],
};

const verifyV2 = {
  payloadVersion: 2 as const,
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  profileId: "p1",
  profileDigest: DIGEST,
  criteriaDigest: DIGEST,
  source: SOURCE_REF,
  baseRevision: SHA40,
  attemptRevision: SHA40,
  diffDigest: DIGEST,
  checks: [],
};

test("VerifyRunPayload v1: parses without payloadVersion", () => {
  assert.equal(VerifyRunPayloadSchema.safeParse(verifyV1).success, true);
});

test("VerifyRunPayload v2: parses with source (via AnySchema)", () => {
  assert.equal(VerifyRunPayloadAnySchema.safeParse(verifyV2).success, true);
});

test("VerifyRunPayload v2: rejects repoPath", () => {
  assert.equal(
    VerifyRunPayloadV2Schema.safeParse({ ...verifyV2, repoPath: "/repo" }).success,
    false,
  );
});

test("VerifyRunPayload v2: rejects worktreeBase", () => {
  assert.equal(
    VerifyRunPayloadV2Schema.safeParse({ ...verifyV2, worktreeBase: "/wt" }).success,
    false,
  );
});

// ---------------------------------------------------------------------------
// LeadReviewPayload
// ---------------------------------------------------------------------------

const reviewV1 = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  criteria: [CRITERION],
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  attemptRevision: SHA40,
  diffDigest: DIGEST,
  patchPath: "/tmp/patch.diff",
  verificationResults: [],
  model: "claude-opus-4",
  repoPath: "/repo",
  worktreeBase: "/wt",
  baseRevision: SHA40,
};

const reviewV2 = {
  payloadVersion: 2 as const,
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  criteria: [CRITERION],
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  attemptRevision: SHA40,
  diffDigest: DIGEST,
  patch: { attemptId: "att-1", generation: 0, revision: SHA40 },
  verificationResults: [],
  model: "claude-opus-4",
  source: SOURCE_REF,
  baseRevision: SHA40,
};

test("LeadReviewPayload v1: parses without payloadVersion", () => {
  assert.equal(LeadReviewPayloadSchema.safeParse(reviewV1).success, true);
});

test("LeadReviewPayload v2: parses with source and patch (via AnySchema)", () => {
  assert.equal(LeadReviewPayloadAnySchema.safeParse(reviewV2).success, true);
});

test("LeadReviewPayload v2: rejects patchPath", () => {
  assert.equal(
    LeadReviewPayloadV2Schema.safeParse({ ...reviewV2, patchPath: "/tmp/p.diff" }).success,
    false,
  );
});

test("LeadReviewPayload v2: rejects repoPath", () => {
  assert.equal(
    LeadReviewPayloadV2Schema.safeParse({ ...reviewV2, repoPath: "/repo" }).success,
    false,
  );
});

test("LeadReviewPayload v2: rejects worktreeBase", () => {
  assert.equal(
    LeadReviewPayloadV2Schema.safeParse({ ...reviewV2, worktreeBase: "/wt" }).success,
    false,
  );
});

// ---------------------------------------------------------------------------
// LeadAcceptPayload
// ---------------------------------------------------------------------------

const acceptV1 = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  criteria: [CRITERION],
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  attemptRevision: SHA40,
  diffDigest: DIGEST,
  verificationResults: [VERIFICATION_RESULT],
  review: REVIEW,
  model: "claude-opus-4",
};

const acceptV2 = { ...acceptV1, payloadVersion: 2 as const };

test("LeadAcceptPayload v1: parses without payloadVersion", () => {
  assert.equal(LeadAcceptPayloadSchema.safeParse(acceptV1).success, true);
});

test("LeadAcceptPayload v2: parses with payloadVersion: 2 (via AnySchema)", () => {
  assert.equal(LeadAcceptPayloadAnySchema.safeParse(acceptV2).success, true);
});

test("LeadAcceptPayload v2: rejects extra fields (strict)", () => {
  assert.equal(
    LeadAcceptPayloadV2Schema.safeParse({ ...acceptV2, repoPath: "/repo" }).success,
    false,
  );
});

test("isV2LeadAcceptPayload: returns false for v1", () => {
  const p = LeadAcceptPayloadAnySchema.parse(acceptV1);
  assert.equal(isV2LeadAcceptPayload(p), false);
});

test("isV2LeadAcceptPayload: returns true for v2", () => {
  const p = LeadAcceptPayloadAnySchema.parse(acceptV2);
  assert.equal(isV2LeadAcceptPayload(p), true);
});

// ---------------------------------------------------------------------------
// IntegrateMergePayload
// ---------------------------------------------------------------------------

const integrateV1 = {
  attemptId: "att-1",
  generation: 1,
  contractId: "sc-1",
  contractVersion: 1,
  projectId: "proj-1",
  repoPath: "/repo",
  remote: "https://github.com/org/repo",
  targetRef: "refs/heads/main",
  expectedBaseRevision: SHA40,
  attemptRevision: SHA40,
  strategy: "fast_forward" as const,
};

const integrateV2 = {
  payloadVersion: 2 as const,
  attemptId: "att-1",
  generation: 1,
  contractId: "sc-1",
  contractVersion: 1,
  projectId: "proj-1",
  source: SOURCE_REF,
  remote: "https://github.com/org/repo",
  targetRef: "refs/heads/main",
  expectedBaseRevision: SHA40,
  attemptRevision: SHA40,
  strategy: "fast_forward" as const,
  integrateLease: { purpose: "integrate" as const },
};

test("IntegrateMergePayload v1: parses without payloadVersion", () => {
  assert.equal(IntegrateMergePayloadSchema.safeParse(integrateV1).success, true);
});

test("IntegrateMergePayload v2: parses with source and integrateLease (via AnySchema)", () => {
  assert.equal(IntegrateMergePayloadAnySchema.safeParse(integrateV2).success, true);
});

test("IntegrateMergePayload v2: rejects repoPath", () => {
  assert.equal(
    IntegrateMergePayloadV2Schema.safeParse({ ...integrateV2, repoPath: "/repo" }).success,
    false,
  );
});

test("isV2IntegrateMergePayload: returns false for v1", () => {
  const p = IntegrateMergePayloadAnySchema.parse(integrateV1);
  assert.equal(isV2IntegrateMergePayload(p), false);
});

test("isV2IntegrateMergePayload: returns true for v2", () => {
  const p = IntegrateMergePayloadAnySchema.parse(integrateV2);
  assert.equal(isV2IntegrateMergePayload(p), true);
});
