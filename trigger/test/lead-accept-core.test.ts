import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  AcceptanceProposal,
  LeadAcceptPayload,
  ReviewOutput,
  VerificationResult,
} from "@agencyhq/contracts";
import type { AcceptDeps } from "../src/tasks/lead-accept-core.ts";
import { findUnknownRef, runAccept } from "../src/tasks/lead-accept-core.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const _DIGEST_D = `sha256:${"d".repeat(64)}`;

const SAMPLE_RESULT: VerificationResult = {
  verifier: { name: "pnpm-test", version: "1.0.0" },
  stepContractId: "contract-1",
  attemptId: "attempt-1",
  criteriaDigest: DIGEST_A,
  profileDigest: DIGEST_B,
  repository: "github.com/example/repo",
  baseRevision: "abc123",
  attemptRevision: "def456",
  diffDigest: DIGEST_C,
  checkId: "check-typecheck",
  environmentFingerprint: { node: "24.0.0" },
  startedAt: "2026-09-07T10:00:00.000Z",
  endedAt: "2026-09-07T10:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "",
  stderrTail: "",
  artifactDigests: [],
  result: "pass",
};

const VALID_REVIEW: ReviewOutput = {
  reviewer: { model: "openai/gpt-5.6-terra" },
  subject: {
    attemptRevision: "def456",
    diffDigest: DIGEST_C,
    criteriaDigest: DIGEST_A,
    profileDigest: DIGEST_B,
  },
  findings: [],
};

/** Stable ref string for the SAMPLE_RESULT (mirrors verificationResultRef). */
const SAMPLE_REF = "pnpm-test:check-typecheck:def456";

function makePayload(overrides: Partial<LeadAcceptPayload> = {}): LeadAcceptPayload {
  return {
    attemptId: "attempt-1",
    generation: 0,
    contractId: "contract-1",
    criteria: [{ id: "C-001", text: "All tests pass", source: "operator" }],
    criteriaDigest: DIGEST_A,
    profileDigest: DIGEST_B,
    attemptRevision: "def456",
    diffDigest: DIGEST_C,
    verificationResults: [SAMPLE_RESULT],
    review: VALID_REVIEW,
    model: "openai/gpt-5.6-terra",
    ...overrides,
  };
}

function makeValidProposal(): AcceptanceProposal {
  return {
    accept: true,
    criteria: [
      {
        criterionId: "C-001",
        satisfied: true,
        evidence: [{ kind: "verification_result", ref: SAMPLE_REF }],
      },
    ],
    findingDispositions: [],
    rationale: "All criteria are satisfied by passing verification results.",
  };
}

function makeFakeDeps(proposalOrError: AcceptanceProposal | Error): AcceptDeps {
  return {
    leadSession: async <T>(input: { parse: (raw: unknown) => T }) => {
      if (proposalOrError instanceof Error) {
        throw proposalOrError;
      }
      return {
        sessionId: "session-123",
        raw: proposalOrError,
        value: input.parse(proposalOrError),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// findUnknownRef
// ---------------------------------------------------------------------------

test("findUnknownRef returns undefined when all refs are known", () => {
  const known = new Set([SAMPLE_REF]);
  const proposal = makeValidProposal();
  assert.equal(findUnknownRef(proposal, known), undefined);
});

test("findUnknownRef returns the unknown ref string when a ref is not in the set", () => {
  const known = new Set([SAMPLE_REF]);
  const proposal: AcceptanceProposal = {
    ...makeValidProposal(),
    criteria: [
      {
        criterionId: "C-001",
        satisfied: true,
        evidence: [{ kind: "verification_result", ref: "unknown-verifier:check-x:rev999" }],
      },
    ],
  };
  assert.equal(findUnknownRef(proposal, known), "unknown-verifier:check-x:rev999");
});

test("findUnknownRef ignores non-verification_result evidence kinds", () => {
  const known = new Set<string>(); // empty - but no verification_result refs
  const proposal: AcceptanceProposal = {
    ...makeValidProposal(),
    criteria: [
      {
        criterionId: "C-001",
        satisfied: true,
        evidence: [
          { kind: "diff", ref: "some-diff-ref" },
          { kind: "review_finding", ref: "F001" },
        ],
      },
    ],
  };
  assert.equal(findUnknownRef(proposal, known), undefined);
});

// ---------------------------------------------------------------------------
// runAccept: valid proposal citing existing refs → returned
// ---------------------------------------------------------------------------

test("runAccept returns a valid AcceptanceProposal for a clean proposal", async () => {
  const payload = makePayload();
  const proposal = makeValidProposal();
  const deps = makeFakeDeps(proposal);

  const result = await runAccept(payload, deps);

  assert.ok(!("kind" in result), "valid proposal should not have kind: invalid_output");
  const accepted = result as AcceptanceProposal;
  assert.equal(accepted.accept, true);
  assert.equal(accepted.criteria.length, 1);
  assert.equal(accepted.criteria[0]?.criterionId, "C-001");
});

test("runAccept returns the proposal unchanged (pass-through)", async () => {
  const payload = makePayload();
  const proposal = makeValidProposal();
  const deps = makeFakeDeps(proposal);

  const result = await runAccept(payload, deps);

  const accepted = result as AcceptanceProposal;
  assert.deepEqual(accepted.findingDispositions, []);
  assert.equal(accepted.rationale, proposal.rationale);
});

// ---------------------------------------------------------------------------
// runAccept: unknown ref → invalid_output
// ---------------------------------------------------------------------------

test("runAccept returns invalid_output when proposal cites an unknown verification_result ref", async () => {
  const payload = makePayload();
  const badProposal: AcceptanceProposal = {
    ...makeValidProposal(),
    criteria: [
      {
        criterionId: "C-001",
        satisfied: true,
        evidence: [{ kind: "verification_result", ref: "ghost-verifier:check-x:rev999" }],
      },
    ],
  };
  const deps = makeFakeDeps(badProposal);

  const result = await runAccept(payload, deps);

  assert.ok("kind" in result, "unknown ref should produce invalid_output");
  assert.equal(result.kind, "invalid_output");
  assert.ok(
    result.reason.includes("ghost-verifier:check-x:rev999"),
    "reason should include the unknown ref",
  );
});

test("runAccept returns invalid_output when session throws", async () => {
  const payload = makePayload();
  const deps = makeFakeDeps(new Error("model timeout"));

  const result = await runAccept(payload, deps);

  assert.ok("kind" in result, "session error should produce invalid_output");
  assert.equal(result.kind, "invalid_output");
  assert.ok(result.reason.includes("model timeout"), "reason should include error message");
});

test("runAccept returns invalid_output when session output fails schema parse", async () => {
  const payload = makePayload();
  const deps: AcceptDeps = {
    leadSession: async <T>(input: { parse: (raw: unknown) => T }) => {
      const garbage = { not_a: "valid_proposal" };
      return {
        sessionId: "s-1",
        raw: garbage,
        value: input.parse(garbage), // ZodError
      };
    },
  };

  const result = await runAccept(payload, deps);

  assert.ok("kind" in result, "garbage output should produce invalid_output");
  assert.equal(result.kind, "invalid_output");
});

// ---------------------------------------------------------------------------
// runAccept: multiple refs, some unknown
// ---------------------------------------------------------------------------

test("runAccept accepts a proposal that cites multiple known refs", async () => {
  const secondResult: VerificationResult = {
    ...SAMPLE_RESULT,
    checkId: "check-lint",
  };
  const payload = makePayload({ verificationResults: [SAMPLE_RESULT, secondResult] });
  const multiProposal: AcceptanceProposal = {
    accept: true,
    criteria: [
      {
        criterionId: "C-001",
        satisfied: true,
        evidence: [
          { kind: "verification_result", ref: SAMPLE_REF },
          { kind: "verification_result", ref: "pnpm-test:check-lint:def456" },
        ],
      },
    ],
    findingDispositions: [],
    rationale: "Two passing results.",
  };
  const deps = makeFakeDeps(multiProposal);

  const result = await runAccept(payload, deps);

  assert.ok(!("kind" in result), "should not be invalid_output with known refs");
});

// ---------------------------------------------------------------------------
// runAccept: proposal with non-blocking findings gets dispositions
// ---------------------------------------------------------------------------

test("runAccept passes through finding dispositions unchanged", async () => {
  const reviewWithFindings: ReviewOutput = {
    ...VALID_REVIEW,
    findings: [
      {
        id: "F001",
        severity: "non_blocking",
        kind: "style",
        description: "Extra blank line",
        evidence: "src/index.ts:42",
      },
    ],
  };
  const payload = makePayload({ review: reviewWithFindings });
  const proposal: AcceptanceProposal = {
    ...makeValidProposal(),
    findingDispositions: [{ findingId: "F001", disposition: "backlog", reason: "minor style nit" }],
  };
  const deps = makeFakeDeps(proposal);

  const result = await runAccept(payload, deps);

  assert.ok(!("kind" in result), "proposal with dispositions should be valid");
  const accepted = result as AcceptanceProposal;
  assert.equal(accepted.findingDispositions.length, 1);
  assert.equal(accepted.findingDispositions[0]?.findingId, "F001");
});

// ---------------------------------------------------------------------------
// Source-grep tests: independence from @agencyhq/domain
// ---------------------------------------------------------------------------

test("lead-accept-core.ts does not import from @agencyhq/domain acceptance module", () => {
  const src = readFileSync(new URL("../src/tasks/lead-accept-core.ts", import.meta.url), "utf8");
  assert.ok(
    !src.includes("@agencyhq/domain"),
    "lead-accept-core must not import from @agencyhq/domain",
  );
  assert.ok(
    !src.includes("/domain/src/evidence/acceptance"),
    "lead-accept-core must not import from acceptance module",
  );
});

test("lead-accept-core.ts does not reference checkProposal or evaluateAcceptance", () => {
  const src = readFileSync(new URL("../src/tasks/lead-accept-core.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("checkProposal"), "must not reference checkProposal");
  assert.ok(!src.includes("evaluateAcceptance"), "must not reference evaluateAcceptance");
});
