import assert from "node:assert/strict";
import test from "node:test";
import type { LeadReviewPayload, VerificationResult } from "@agencyhq/contracts";
import { buildReviewPrompt } from "../src/opencode/review-prompt.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const _DIGEST_D = `sha256:${"d".repeat(64)}`;

const MINIMAL_RESULT: VerificationResult = {
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
  stderrTail: "some stderr output",
  artifactDigests: [],
  result: "pass",
};

const MINIMAL_PAYLOAD: LeadReviewPayload = {
  attemptId: "attempt-1",
  generation: 0,
  contractId: "contract-1",
  criteria: [
    { id: "C-001", text: "All tests pass", source: "operator" },
    { id: "C-002", text: "No linting errors", source: "repository", citation: "REQUIREMENTS.md" },
  ],
  criteriaDigest: DIGEST_A,
  profileDigest: DIGEST_B,
  attemptRevision: "def456",
  diffDigest: DIGEST_C,
  patchPath: "/tmp/attempt.patch",
  verificationResults: [MINIMAL_RESULT],
  model: "openai/gpt-5.6-terra",
  repoPath: "/srv/repo",
  worktreeBase: "/srv/agencyhq",
  baseRevision: "abc123",
};

const SAMPLE_PATCH = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcdef 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 export function hello() {
+  console.log("hello");
   return "hello";
 }`;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("buildReviewPrompt is deterministic: identical inputs produce identical outputs", () => {
  const first = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  const second = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.deepEqual(first, second);
});

test("buildReviewPrompt with different patches produces different userPrompts", () => {
  const a = buildReviewPrompt(MINIMAL_PAYLOAD, "patch A");
  const b = buildReviewPrompt(MINIMAL_PAYLOAD, "patch B");
  assert.notEqual(a.userPrompt, b.userPrompt);
  // systemContext is independent of the patch
  assert.equal(a.systemContext, b.systemContext);
});

// ---------------------------------------------------------------------------
// ADR-0006 independence: no worker session or transcript references
// ---------------------------------------------------------------------------

test("review prompt systemContext contains no 'session' text", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    !systemContext.toLowerCase().includes("session"),
    `systemContext must not mention 'session'; got: ${systemContext.slice(0, 200)}`,
  );
});

test("review prompt systemContext contains no 'transcript' text", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    !systemContext.toLowerCase().includes("transcript"),
    `systemContext must not mention 'transcript'; got: ${systemContext.slice(0, 200)}`,
  );
});

test("review prompt userPrompt contains no 'session' text", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    !userPrompt.toLowerCase().includes("session"),
    `userPrompt must not mention 'session'; got: ${userPrompt.slice(0, 200)}`,
  );
});

test("review prompt userPrompt contains no 'transcript' text", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    !userPrompt.toLowerCase().includes("transcript"),
    `userPrompt must not mention 'transcript'; got: ${userPrompt.slice(0, 200)}`,
  );
});

// ---------------------------------------------------------------------------
// Labels worker output as untrusted
// ---------------------------------------------------------------------------

test("review prompt labels the diff section as untrusted worker output", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(userPrompt.includes("untrusted"), "userPrompt must label the diff as untrusted");
  assert.ok(userPrompt.includes("DIFF"), "userPrompt must include a DIFF section header");
});

// ---------------------------------------------------------------------------
// Subject digests appear verbatim in the system prompt
// ---------------------------------------------------------------------------

test("review prompt systemContext includes the exact attemptRevision", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    systemContext.includes(MINIMAL_PAYLOAD.attemptRevision),
    "systemContext must contain attemptRevision",
  );
});

test("review prompt systemContext includes the exact diffDigest", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    systemContext.includes(MINIMAL_PAYLOAD.diffDigest),
    "systemContext must contain diffDigest",
  );
});

test("review prompt systemContext includes the exact criteriaDigest", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    systemContext.includes(MINIMAL_PAYLOAD.criteriaDigest),
    "systemContext must contain criteriaDigest",
  );
});

test("review prompt systemContext includes the exact profileDigest", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    systemContext.includes(MINIMAL_PAYLOAD.profileDigest),
    "systemContext must contain profileDigest",
  );
});

// ---------------------------------------------------------------------------
// Content checks
// ---------------------------------------------------------------------------

test("review prompt userPrompt includes VERIFICATION RESULTS section", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(userPrompt.includes("VERIFICATION RESULTS"), "must include verification results");
});

test("review prompt userPrompt includes criterion ids", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(userPrompt.includes("C-001"), "must include criterion C-001");
  assert.ok(userPrompt.includes("C-002"), "must include criterion C-002");
});

test("review prompt userPrompt includes verification result ref", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  const expectedRef = `pnpm-test:check-typecheck:def456`;
  assert.ok(
    userPrompt.includes(expectedRef),
    `must include verification result ref ${expectedRef}`,
  );
});

test("review prompt userPrompt includes the patch content", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(userPrompt.includes("src/index.ts"), "userPrompt must include diff file path");
});

test("review prompt with empty verification results does not throw", () => {
  const payload: LeadReviewPayload = { ...MINIMAL_PAYLOAD, verificationResults: [] };
  assert.doesNotThrow(() => buildReviewPrompt(payload, SAMPLE_PATCH));
  const { userPrompt } = buildReviewPrompt(payload, SAMPLE_PATCH);
  assert.ok(userPrompt.includes("VERIFICATION RESULTS"));
});

test("review prompt stderr tail is included in user prompt", () => {
  const { userPrompt } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    userPrompt.includes("some stderr output"),
    "must include stderr tail from verification result",
  );
});

test("review prompt stderr tail is bounded to 2048 bytes", () => {
  const longStderr = "x".repeat(10000);
  const result: VerificationResult = { ...MINIMAL_RESULT, stderrTail: longStderr };
  const payload: LeadReviewPayload = { ...MINIMAL_PAYLOAD, verificationResults: [result] };
  const { userPrompt } = buildReviewPrompt(payload, SAMPLE_PATCH);
  // The truncated version should appear, not the full 10000-char string.
  assert.ok(!userPrompt.includes("x".repeat(10000)), "full long stderr should not be in prompt");
  assert.ok(userPrompt.includes("truncated"), "should indicate truncation");
});

test("review prompt adversarial stance is expressed", () => {
  const { systemContext } = buildReviewPrompt(MINIMAL_PAYLOAD, SAMPLE_PATCH);
  assert.ok(
    systemContext.toLowerCase().includes("adversar") ||
      systemContext.toLowerCase().includes("what would make"),
    "system prompt must express adversarial stance",
  );
});
