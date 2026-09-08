import assert from "node:assert/strict";
import test from "node:test";
import { HOST_TRIAL_AUTHORITY, TASK_IDS } from "../src/index.ts";
import { AcceptanceProposalSchema, LeadAcceptPayloadSchema } from "../src/tasks/lead-accept.ts";
import { LeadPlanPayloadSchema } from "../src/tasks/lead-plan.ts";
import { LeadReviewPayloadSchema, ReviewOutputSchema } from "../src/tasks/lead-review.ts";
import { VerifyRunOutputSchema, VerifyRunPayloadSchema } from "../src/tasks/verify-run.ts";
import {
  WorkerAttemptOutputSchema,
  WorkerAttemptPayloadSchema,
} from "../src/tasks/worker-attempt.ts";

const DIGEST = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

const validCriterion = {
  id: "c-1",
  text: "Parser rejects invalid input.",
  source: "operator" as const,
};

const validVerificationResult = {
  verifier: { name: "v", version: "0.1" },
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
  startedAt: "2026-09-07T10:00:00.000Z",
  endedAt: "2026-09-07T10:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "",
  stderrTail: "",
  artifactDigests: [],
  result: "pass" as const,
};

// --- LeadPlanPayload ---

test("LeadPlanPayloadSchema: parses a valid payload", () => {
  const payload = {
    workItemId: "wi-1",
    projectId: "proj-1",
    repoPath: "/repo",
    baseRevision: "abc",
    worktreeBase: "/worktrees",
    authority: HOST_TRIAL_AUTHORITY,
    operatorIntent: "Fix the parser bug.",
    model: "claude-opus-4",
  };
  const r = LeadPlanPayloadSchema.safeParse(payload);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeadPlanPayloadSchema: rejects missing workItemId", () => {
  const bad = {
    projectId: "proj-1",
    repoPath: "/repo",
    baseRevision: "abc",
    worktreeBase: "/worktrees",
    authority: {},
    operatorIntent: "Fix bug",
    model: "claude-opus-4",
  };
  const r = LeadPlanPayloadSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// --- WorkerAttemptPayload ---

const validContractBounds = {
  paths: { allow: ["src/parser/**"], deny: [] },
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
  boundary: "artifact" as const,
  budget: { maxAttempts: 2, maxDurationSeconds: 1200, estimatedSpendUsd: 5 },
  review: "adversarial" as const,
  changeClass: "behavior" as const,
  models: { worker: "claude-opus-4", reviewer: "claude-sonnet-4" },
};

const validPermissionRuleset = {
  "*": "deny" as const,
  read: "allow" as const,
  glob: "allow" as const,
  grep: "allow" as const,
  list: "allow" as const,
  edit: { "*": "deny", "src/parser/**": "allow" },
  bash: { "*": "deny", "pnpm test*": "allow", "*git push*": "deny" },
  task: "deny" as const,
  webfetch: "deny" as const,
  websearch: "deny" as const,
  skill: "deny" as const,
  external_directory: "deny" as const,
  doom_loop: "deny" as const,
};

const validWorkerPayload = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  contractVersion: "v1",
  repoPath: "/repo",
  baseRev: "abc",
  prompt: "Fix the parser bug described in c-1.",
  allowedPaths: ["src/parser/**"],
  bounds: validContractBounds,
  permissionRules: validPermissionRuleset,
  model: "claude-opus-4",
};

test("WorkerAttemptPayloadSchema: parses a valid payload", () => {
  const r = WorkerAttemptPayloadSchema.safeParse(validWorkerPayload);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("WorkerAttemptPayloadSchema: rejects missing generation", () => {
  const { generation: _omit, ...bad } = validWorkerPayload;
  const r = WorkerAttemptPayloadSchema.safeParse(bad);
  assert.equal(r.success, false);
});

const validWorkerOutput = {
  attemptId: "att-1",
  sessionId: null,
  outcome: "completed" as const,
  worktreePath: "/worktrees/att-1",
  runDir: "/run/att-1",
  commitId: "def456",
  diffDigest: DIGEST,
  changedPaths: ["src/parser.ts"],
  pathViolations: [],
  checkpointCommit: null,
  survivors: [],
  opencode: { sessionID: "sess-1", exitCode: 0, denials: [], errors: [] },
  report: {
    attempted: "Fixed parser",
    outputs: ["src/parser.ts"],
    checksRun: [],
    unmetCriteria: [],
    limitations: [],
    findings: [],
  },
};

test("WorkerAttemptOutputSchema: parses a valid output", () => {
  const r = WorkerAttemptOutputSchema.safeParse(validWorkerOutput);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("WorkerAttemptOutputSchema: rejects invalid outcome", () => {
  const bad = { ...validWorkerOutput, outcome: "exploded" };
  const r = WorkerAttemptOutputSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// --- VerifyRunPayload ---

const validVerifyPayload = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  profileId: "profile-v1",
  profileDigest: DIGEST,
  criteriaDigest: DIGEST,
  repoPath: "/repo",
  worktreeBase: "/worktrees",
  baseRevision: "abc",
  attemptRevision: "def",
  diffDigest: DIGEST,
  checks: [{ id: "typecheck", version: "1", command: ["pnpm", "typecheck"], timeoutSeconds: 60 }],
};

test("VerifyRunPayloadSchema: parses a valid payload", () => {
  const r = VerifyRunPayloadSchema.safeParse(validVerifyPayload);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("VerifyRunPayloadSchema: rejects invalid digest", () => {
  const bad = { ...validVerifyPayload, profileDigest: "not-sha256" };
  const r = VerifyRunPayloadSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("VerifyRunOutputSchema: parses a valid output", () => {
  const r = VerifyRunOutputSchema.safeParse({ results: [validVerificationResult] });
  assert.equal(r.success, true, JSON.stringify(r));
});

// --- LeadReviewPayload (independence invariant) ---

test("LeadReviewPayloadSchema: has no sessionId/transcript/conversation key", () => {
  const keys = Object.keys(LeadReviewPayloadSchema.shape);
  const forbidden = keys.filter((k) => /session|transcript|conversation/i.test(k));
  assert.deepEqual(
    forbidden,
    [],
    `Independence violation: LeadReviewPayloadSchema contains forbidden keys: ${forbidden.join(", ")}`,
  );
});

const validReviewPayload = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  criteria: [validCriterion],
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  attemptRevision: "def",
  diffDigest: DIGEST,
  patchPath: "/patches/att-1.patch",
  verificationResults: [validVerificationResult],
  model: "claude-sonnet-4",
  repoPath: "/repo",
  worktreeBase: "/worktrees",
  baseRevision: "abc",
};

test("LeadReviewPayloadSchema: parses a valid payload", () => {
  const r = LeadReviewPayloadSchema.safeParse(validReviewPayload);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeadReviewPayloadSchema: rejects missing patchPath", () => {
  const { patchPath: _omit, ...bad } = validReviewPayload;
  const r = LeadReviewPayloadSchema.safeParse(bad);
  assert.equal(r.success, false);
});

const validReviewOutput = {
  reviewer: { model: "claude-sonnet-4" },
  subject: {
    attemptRevision: "def",
    diffDigest: DIGEST,
    criteriaDigest: DIGEST,
    profileDigest: DIGEST,
  },
  findings: [
    {
      id: "f-1",
      severity: "non_blocking" as const,
      kind: "style" as const,
      description: "Nit: inconsistent spacing.",
      evidence: "line 42",
    },
  ],
};

test("ReviewOutputSchema: parses a valid review output", () => {
  const r = ReviewOutputSchema.safeParse(validReviewOutput);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("ReviewOutputSchema: rejects unknown severity", () => {
  const bad = {
    ...validReviewOutput,
    findings: [{ ...validReviewOutput.findings[0], severity: "critical" }],
  };
  const r = ReviewOutputSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// --- LeadAcceptPayload ---

const validAcceptPayload = {
  attemptId: "att-1",
  generation: 0,
  contractId: "sc-1",
  criteria: [validCriterion],
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  attemptRevision: "def",
  diffDigest: DIGEST,
  verificationResults: [validVerificationResult],
  review: validReviewOutput,
  model: "claude-opus-4",
};

test("LeadAcceptPayloadSchema: parses a valid payload", () => {
  const r = LeadAcceptPayloadSchema.safeParse(validAcceptPayload);
  assert.equal(r.success, true, JSON.stringify(r));
});

const validAcceptanceProposal = {
  accept: true,
  criteria: [
    {
      criterionId: "c-1",
      satisfied: true,
      evidence: [{ kind: "verification_result" as const, ref: "vr-1" }],
    },
  ],
  findingDispositions: [
    { findingId: "f-1", disposition: "backlog" as const, reason: "Unrelated improvement." },
  ],
  rationale: "All criteria met; no blocking findings.",
};

test("AcceptanceProposalSchema: parses a valid proposal", () => {
  const r = AcceptanceProposalSchema.safeParse(validAcceptanceProposal);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("AcceptanceProposalSchema: rejects invalid evidence kind", () => {
  const bad = {
    ...validAcceptanceProposal,
    criteria: [{ criterionId: "c-1", satisfied: true, evidence: [{ kind: "log_file", ref: "x" }] }],
  };
  const r = AcceptanceProposalSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("AcceptanceProposalSchema: rejects invalid disposition", () => {
  const bad = {
    ...validAcceptanceProposal,
    findingDispositions: [{ findingId: "f-1", disposition: "ignore", reason: "meh" }],
  };
  const r = AcceptanceProposalSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// --- TASK_IDS ---

test("TASK_IDS: contains all five task identifiers", () => {
  assert.equal(TASK_IDS.leadPlan, "lead.plan");
  assert.equal(TASK_IDS.workerAttempt, "worker.attempt");
  assert.equal(TASK_IDS.verifyRun, "verify.run");
  assert.equal(TASK_IDS.leadReview, "lead.review");
  assert.equal(TASK_IDS.leadAccept, "lead.accept");
});
