/**
 * False-success fixture tests.
 *
 * (a) worker claims pass but verify result is fail → CITED_RESULT_NOT_PASSING,
 *     PLUS source-level assertion that acceptance.ts does not reference "checksRun".
 * (b) changedPaths include package.json → tampering finding blocking.
 * (c) blocking review finding → REVIEW_BLOCKING.
 * (d) passing result with stale profileDigest → RESULT_VERSION_MISMATCH.
 * (e) proposal cites a nonexistent ref → CITED_RESULT_MISSING;
 *     proposal omits a criterion → CRITERION_UNCITED.
 * (f) unrelated finding → backlog disposition event with contract digest unchanged.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AcceptanceProposal, StepContract, VerificationResult } from "@agencyhq/contracts";
import { evaluateAcceptance } from "../src/evidence/acceptance.ts";
import { detectVerifierTampering } from "../src/evidence/integrity.ts";
import { verificationResultRef } from "../src/evidence/match.ts";
import type { ArtifactLike, AttemptLike, FindingLike, ReviewLike } from "../src/evidence/types.ts";
import { applyDisposition } from "../src/findings/disposition.ts";

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
    inputs: { intent: "false-success test" },
    criteria: [{ id: "c1", text: "output correct", source: "operator" }],
    criteriaDigest: CRITERIA_DIGEST,
    profileId: "profile-1",
    profileDigest: PROFILE_DIGEST,
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
    changedPaths: ["src/output.ts"],
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
    diffDigest: DIFF_DIGEST,
    criteriaDigest: CRITERIA_DIGEST,
    profileDigest: PROFILE_DIGEST,
    reviewerModel: "claude-sonnet",
    profile: "adversarial",
    findings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const CONTRACT = makeContract();
const ATTEMPT = makeAttempt();
const ARTIFACT = makeArtifact();
const REVIEW = makeReview();

// ---------------------------------------------------------------------------
// (a) Worker claims pass but verify result is fail → CITED_RESULT_NOT_PASSING
// ---------------------------------------------------------------------------
test("false-success (a): fail result yields CITED_RESULT_NOT_PASSING", () => {
  const failResult = makeVerificationResult({ result: "fail", exitStatus: 1 });
  const ref = verificationResultRef(failResult);
  const proposal: AcceptanceProposal = {
    accept: true,
    criteria: [
      { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref }] },
    ],
    findingDispositions: [],
    rationale: "Worker claims pass.",
  };
  const r = evaluateAcceptance({
    contract: CONTRACT,
    attempt: ATTEMPT,
    artifact: ARTIFACT,
    results: [failResult],
    review: REVIEW,
    proposal,
    approval: undefined,
    reviewerMustDiffer: false,
    workerModel: "claude-opus",
  });
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CITED_RESULT_NOT_PASSING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// (a) Source-level assertion: acceptance.ts must not reference "checksRun"
// ---------------------------------------------------------------------------
test("false-success (a): acceptance.ts source does not contain 'checksRun'", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const srcPath = resolve(testDir, "../src/evidence/acceptance.ts");
  const src = readFileSync(srcPath, "utf-8");
  const occurrences = (src.match(/checksRun/g) ?? []).length;
  assert.equal(
    occurrences,
    0,
    `acceptance.ts must not reference 'checksRun' (found ${occurrences} occurrence(s))`,
  );
});

// ---------------------------------------------------------------------------
// (b) changedPaths include package.json → tamper finding, severity blocking
// ---------------------------------------------------------------------------
test("false-success (b): package.json in changedPaths produces blocking tamper finding", () => {
  const findings = detectVerifierTampering(["src/output.ts", "package.json"]);
  const tampered = findings.filter((f) => f.kind === "verifier_tampered");
  assert.ok(tampered.length > 0, "expected at least one tamper finding");
  assert.ok(
    tampered.every((f) => f.severity === "blocking"),
    "all tamper findings must be blocking",
  );
  const pkgFindings = tampered.filter((f) => f.evidence.includes("package.json"));
  assert.ok(pkgFindings.length > 0, "expected a tamper finding for package.json");
});

// ---------------------------------------------------------------------------
// (c) Blocking review finding → REVIEW_BLOCKING
// ---------------------------------------------------------------------------
test("false-success (c): blocking review finding yields REVIEW_BLOCKING", () => {
  const blockingReview = makeReview({
    findings: [
      {
        id: "f1",
        severity: "blocking",
        kind: "unmet_criterion",
        description: "criterion not met",
        evidence: "diff line 10",
      },
    ],
  });
  const passResult = makeVerificationResult();
  const ref = verificationResultRef(passResult);
  const proposal: AcceptanceProposal = {
    accept: true,
    criteria: [
      { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref }] },
    ],
    findingDispositions: [],
    rationale: "Pass.",
  };
  const r = evaluateAcceptance({
    contract: CONTRACT,
    attempt: ATTEMPT,
    artifact: ARTIFACT,
    results: [passResult],
    review: blockingReview,
    proposal,
    approval: undefined,
    reviewerMustDiffer: false,
    workerModel: "claude-opus",
  });
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("REVIEW_BLOCKING"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// (d) Passing result with stale profileDigest → RESULT_VERSION_MISMATCH
// ---------------------------------------------------------------------------
test("false-success (d): stale profileDigest in result yields RESULT_VERSION_MISMATCH", () => {
  const staleResult = makeVerificationResult({ profileDigest: ALT_DIGEST });
  const ref = verificationResultRef(staleResult);
  const proposal: AcceptanceProposal = {
    accept: true,
    criteria: [
      { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref }] },
    ],
    findingDispositions: [],
    rationale: "Pass.",
  };
  const r = evaluateAcceptance({
    contract: CONTRACT,
    attempt: ATTEMPT,
    artifact: ARTIFACT,
    results: [staleResult],
    review: REVIEW,
    proposal,
    approval: undefined,
    reviewerMustDiffer: false,
    workerModel: "claude-opus",
  });
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("RESULT_VERSION_MISMATCH"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// (e) Proposal cites nonexistent ref → CITED_RESULT_MISSING
//     Proposal omits a criterion → CRITERION_UNCITED
// ---------------------------------------------------------------------------
test("false-success (e): nonexistent ref yields CITED_RESULT_MISSING", () => {
  const proposal: AcceptanceProposal = {
    accept: true,
    criteria: [
      {
        criterionId: "c1",
        satisfied: true,
        evidence: [{ kind: "verification_result", ref: "nonexistent:check:rev" }],
      },
    ],
    findingDispositions: [],
    rationale: "Pass.",
  };
  const r = evaluateAcceptance({
    contract: CONTRACT,
    attempt: ATTEMPT,
    artifact: ARTIFACT,
    results: [makeVerificationResult()],
    review: REVIEW,
    proposal,
    approval: undefined,
    reviewerMustDiffer: false,
    workerModel: "claude-opus",
  });
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CITED_RESULT_MISSING"), `codes: ${codes}`);
});

test("false-success (e): omitted criterion yields CRITERION_UNCITED", () => {
  const contract2 = makeContract({
    criteria: [
      { id: "c1", text: "check one", source: "operator" },
      { id: "c2", text: "check two", source: "operator" },
    ],
  });
  const passResult = makeVerificationResult();
  const ref = verificationResultRef(passResult);
  const proposal: AcceptanceProposal = {
    accept: true,
    criteria: [
      { criterionId: "c1", satisfied: true, evidence: [{ kind: "verification_result", ref }] },
    ],
    findingDispositions: [],
    rationale: "Only c1 cited.",
  };
  const r = evaluateAcceptance({
    contract: contract2,
    attempt: ATTEMPT,
    artifact: ARTIFACT,
    results: [passResult],
    review: REVIEW,
    proposal,
    approval: undefined,
    reviewerMustDiffer: false,
    workerModel: "claude-opus",
  });
  assert.ok(!r.ok);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("CRITERION_UNCITED"), `codes: ${codes}`);
});

// ---------------------------------------------------------------------------
// (f) Unrelated finding → backlog disposition event; contract digest unchanged
// ---------------------------------------------------------------------------
test("false-success (f): unrelated finding backlog disposition produces event and unchanged contract", () => {
  const contractDigest = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
  const finding: FindingLike = {
    id: "f-unrelated",
    severity: "non_blocking",
    kind: "unrelated",
    description: "unrelated diagnostic improvement",
    evidence: "src/parser.ts:42",
  };
  const result = applyDisposition(finding, "backlog", {
    contractDigest,
    workItemId: "wi-1",
    at: "2024-01-01T00:00:00Z",
  });
  assert.equal(result.contractDigestAfter, contractDigest);
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.ok(ev !== undefined);
  assert.equal(ev.type, "backlog_work_item_requested");
  if (ev.type === "backlog_work_item_requested") {
    assert.equal(ev.subject, finding.id);
    assert.equal(ev.description, finding.description);
  }
});
