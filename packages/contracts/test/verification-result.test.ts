import assert from "node:assert/strict";
import test from "node:test";

import { VerificationResultSchema } from "../src/verification-result.ts";

const DIGEST = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

const validResult = {
  verifier: { name: "agencyhq-verifier", version: "0.1.0" },
  stepContractId: "contract-001",
  attemptId: "attempt-001",
  criteriaDigest: DIGEST,
  profileDigest: DIGEST,
  repository: "github.com/org/repo",
  baseRevision: "abc123",
  attemptRevision: "def456",
  diffDigest: DIGEST,
  checkId: "typecheck-v1",
  environmentFingerprint: { node: "24.0.0", pnpm: "11.0.0" },
  startedAt: "2026-09-07T10:00:00.000Z",
  endedAt: "2026-09-07T10:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "",
  stderrTail: "",
  artifactDigests: [],
  result: "pass" as const,
};

/**
 * Documented VerificationResult fields (TESTING.md §89-94).
 * This list is the authoritative record; any mismatch fails the test.
 */
const DOCUMENTED_FIELDS = [
  "verifier",
  "stepContractId",
  "attemptId",
  "criteriaDigest",
  "profileDigest",
  "repository",
  "baseRevision",
  "attemptRevision",
  "diffDigest",
  "checkId",
  "environmentFingerprint",
  "startedAt",
  "endedAt",
  "exitStatus",
  "stdoutTail",
  "stderrTail",
  "artifactDigests",
  "result",
] as const;

test("VerificationResultSchema: parses a valid result", () => {
  const r = VerificationResultSchema.safeParse(validResult);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("VerificationResultSchema: keys match documented list", () => {
  const schemaKeys = Object.keys(VerificationResultSchema.shape).sort();
  const documentedKeys = [...DOCUMENTED_FIELDS].sort();
  assert.deepEqual(schemaKeys, documentedKeys);
});

test("VerificationResultSchema: accepts null exitStatus", () => {
  const r = VerificationResultSchema.safeParse({ ...validResult, exitStatus: null });
  assert.equal(r.success, true);
});

test("VerificationResultSchema: rejects invalid digest format", () => {
  const bad = { ...validResult, criteriaDigest: "not-a-digest" };
  const r = VerificationResultSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("VerificationResultSchema: rejects invalid result value", () => {
  const bad = { ...validResult, result: "unknown" };
  const r = VerificationResultSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("VerificationResultSchema: rejects stdoutTail exceeding 16 KiB", () => {
  const bad = { ...validResult, stdoutTail: "x".repeat(16_385) };
  const r = VerificationResultSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("VerificationResultSchema: accepts stdoutTail exactly at 16 KiB", () => {
  const ok = { ...validResult, stdoutTail: "x".repeat(16_384) };
  const r = VerificationResultSchema.safeParse(ok);
  assert.equal(r.success, true);
});
