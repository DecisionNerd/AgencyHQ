/**
 * Tests for packages/domain/src/admission/*.ts (P18.1).
 *
 * C5: table tests per code; fast-check properties for paths.
 * All pure functions — no I/O, no DB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fc from "fast-check";
import type { ArtifactAdmissionInput } from "../src/admission/artifact.ts";
import { validateArtifactAdmission } from "../src/admission/artifact.ts";
import type { StopEvidenceAdmissionInput } from "../src/admission/evidence.ts";
import { validateStopEvidenceAdmission } from "../src/admission/evidence.ts";
import type { LeaseRequestInput } from "../src/admission/lease.ts";
import { validateLeaseRequest } from "../src/admission/lease.ts";
import { isSafePath, validateChangedPaths } from "../src/admission/paths.ts";

const SHA40 = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const NOW = "2026-09-09T10:00:00.000Z";
const FUTURE = "2026-09-09T11:00:00.000Z";
const PAST = "2026-09-09T09:00:00.000Z";

// ---------------------------------------------------------------------------
// validateChangedPaths
// ---------------------------------------------------------------------------

test("validateChangedPaths: rejects empty list", () => {
  const r = validateChangedPaths([]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "PATH_UNSAFE");
});

test("validateChangedPaths: valid single file", () => {
  const r = validateChangedPaths(["src/foo.ts"]);
  assert.equal(r.ok, true);
});

test("validateChangedPaths: valid multiple files", () => {
  const r = validateChangedPaths(["src/foo.ts", "tests/bar.test.ts", "README.md"]);
  assert.equal(r.ok, true);
});

test("validateChangedPaths: rejects absolute path", () => {
  const r = validateChangedPaths(["/etc/passwd"]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "PATH_UNSAFE");
});

test("validateChangedPaths: rejects .. segment", () => {
  const r = validateChangedPaths(["a/../b/c"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects leading ../ segment", () => {
  const r = validateChangedPaths(["../escape"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects backslash", () => {
  const r = validateChangedPaths(["src\\foo.ts"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects NUL byte", () => {
  const r = validateChangedPaths(["src/foo\0bar.ts"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects leading ./", () => {
  const r = validateChangedPaths(["./src/foo.ts"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects trailing /", () => {
  const r = validateChangedPaths(["src/"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects .git/ prefix", () => {
  const r = validateChangedPaths([".git/config"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects bare .git", () => {
  const r = validateChangedPaths([".git"]);
  assert.equal(r.ok, false);
});

test("validateChangedPaths: rejects empty string in list", () => {
  const r = validateChangedPaths([""]);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// isSafePath — fast-check properties
// ---------------------------------------------------------------------------

/**
 * Generates safe path segments.
 * Must start with an alphanumeric, underscore, or hyphen to avoid bare "." or ".."
 * segments (which isSafePath rejects as current-dir / parent-dir references).
 */
const safeSegmentArb = fc.stringMatching(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,19}$/);

/** Generates a safe path from 1-5 safe segments. */
const safePathArb = fc
  .array(safeSegmentArb, { minLength: 1, maxLength: 5 })
  .map((segs) => segs.join("/"));

test("property: any path built from safe segments passes isSafePath", () => {
  fc.assert(
    fc.property(safePathArb, (p) => {
      return isSafePath(p) === true;
    }),
  );
});

test("property: any path with a .. segment fails isSafePath", () => {
  const withDotDot = fc.oneof(
    fc.constant(".."),
    fc.constant("../foo"),
    fc.constant("foo/.."),
    fc.constant("foo/../bar"),
    safePathArb.map((p) => `${p}/..`),
    safePathArb.map((p) => `../..${p}`),
  );
  fc.assert(
    fc.property(withDotDot, (p) => {
      return isSafePath(p) === false;
    }),
  );
});

test("property: any path starting with / fails isSafePath", () => {
  fc.assert(
    fc.property(safePathArb, (p) => {
      return isSafePath("/" + p) === false;
    }),
  );
});

// ---------------------------------------------------------------------------
// validateArtifactAdmission — table tests per code
// ---------------------------------------------------------------------------

const validUploadMeta = {
  attemptId: "att-1",
  generation: 1,
  kind: "attempt" as const,
  commitId: SHA40,
  diffDigest: DIGEST,
  changedPaths: ["src/foo.ts"],
  bundleSha256: "c".repeat(64),
  bundleBytes: 1024,
};

const validLease = {
  purpose: "upload" as const,
  attemptId: "att-1",
  generation: 1,
  expiresAt: FUTURE,
  revokedAt: null,
};

const validAttempt = {
  id: "att-1",
  projectId: "proj-1",
  currentGeneration: 1,
  status: "running",
};

const validMirror = {
  hasCommit: (_sha: string) => true,
  recomputedDiffDigest: DIGEST,
};

const validLimits = { maxBundleBytes: 100_000_000 };

function baseInput(overrides: Partial<ArtifactAdmissionInput> = {}): ArtifactAdmissionInput {
  return {
    claimed: validUploadMeta,
    lease: validLease,
    attempt: validAttempt,
    now: NOW,
    mirror: validMirror,
    limits: validLimits,
    ...overrides,
  };
}

test("validateArtifactAdmission: accepts valid input", () => {
  const r = validateArtifactAdmission(baseInput());
  assert.equal(r.ok, true);
});

test("validateArtifactAdmission: LEASE_MISSING when no lease", () => {
  const r = validateArtifactAdmission(baseInput({ lease: null }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_MISSING");
});

test("validateArtifactAdmission: LEASE_REVOKED when revoked_at is set", () => {
  const r = validateArtifactAdmission(baseInput({ lease: { ...validLease, revokedAt: PAST } }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_REVOKED");
});

test("validateArtifactAdmission: LEASE_EXPIRED when expiresAt <= now", () => {
  const r = validateArtifactAdmission(baseInput({ lease: { ...validLease, expiresAt: PAST } }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_EXPIRED");
});

test("validateArtifactAdmission: LEASE_PURPOSE_MISMATCH when purpose != upload", () => {
  const r = validateArtifactAdmission(
    baseInput({ lease: { ...validLease, purpose: "provider" as any } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_PURPOSE_MISMATCH");
});

test("validateArtifactAdmission: ATTEMPT_MISMATCH when lease.attemptId != attempt.id", () => {
  const r = validateArtifactAdmission(
    baseInput({ lease: { ...validLease, attemptId: "other-att" } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_MISMATCH");
});

test("validateArtifactAdmission: STALE_GENERATION when claimed.generation < currentGeneration", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, generation: 0 },
      lease: { ...validLease, generation: 0 }, // lease matches claimed, attempt is ahead
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "STALE_GENERATION");
});

test("validateArtifactAdmission: FUTURE_GENERATION when claimed.generation > currentGeneration", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, generation: 5 },
      lease: { ...validLease, generation: 5 }, // lease matches claimed, attempt is behind
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "FUTURE_GENERATION");
});

test("validateArtifactAdmission: ATTEMPT_TERMINAL for completed status", () => {
  const r = validateArtifactAdmission(
    baseInput({ attempt: { ...validAttempt, status: "completed" } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_TERMINAL");
});

test("validateArtifactAdmission: ATTEMPT_TERMINAL for quarantined status", () => {
  const r = validateArtifactAdmission(
    baseInput({ attempt: { ...validAttempt, status: "quarantined" } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_TERMINAL");
});

test("validateArtifactAdmission: BUNDLE_TOO_LARGE when bundleBytes > limit", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, bundleBytes: 200_000_000 },
      limits: { maxBundleBytes: 100_000_000 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "BUNDLE_TOO_LARGE");
});

test("validateArtifactAdmission: PATH_UNSAFE for absolute path in changedPaths", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, changedPaths: ["/etc/passwd"] },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "PATH_UNSAFE");
});

test("validateArtifactAdmission: COMMIT_NOT_IN_MIRROR when hasCommit returns false", () => {
  const r = validateArtifactAdmission(
    baseInput({ mirror: { hasCommit: () => false, recomputedDiffDigest: null } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "COMMIT_NOT_IN_MIRROR");
});

test("validateArtifactAdmission: DIGEST_MISMATCH when recomputedDiffDigest differs", () => {
  const r = validateArtifactAdmission(
    baseInput({
      mirror: { hasCommit: () => true, recomputedDiffDigest: `sha256:${"0".repeat(64)}` },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "DIGEST_MISMATCH");
});

test("validateArtifactAdmission: DIGEST_MISMATCH when recomputedDiffDigest is null", () => {
  const r = validateArtifactAdmission(
    baseInput({
      mirror: { hasCommit: () => true, recomputedDiffDigest: null },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "DIGEST_MISMATCH");
});

// Order-stability: LEASE_MISSING before everything else
test("validateArtifactAdmission: LEASE_MISSING is returned before ATTEMPT_TERMINAL", () => {
  const r = validateArtifactAdmission(
    baseInput({
      lease: null,
      attempt: { ...validAttempt, status: "completed" },
    }),
  );
  assert.equal(!r.ok && r.error, "LEASE_MISSING");
});

// ---------------------------------------------------------------------------
// validateStopEvidenceAdmission — table tests per code
// ---------------------------------------------------------------------------

const validStep = { at: NOW, step: "signal_sent" as const };

function baseStopInput(
  overrides: Partial<StopEvidenceAdmissionInput> = {},
): StopEvidenceAdmissionInput {
  return {
    attemptId: "att-1",
    generation: 1,
    steps: [validStep],
    lease: {
      purpose: "upload",
      attemptId: "att-1",
      generation: 1,
      expiresAt: FUTURE,
      revokedAt: null,
    },
    attempt: { id: "att-1", currentGeneration: 1 },
    now: NOW,
    ...overrides,
  };
}

test("validateStopEvidenceAdmission: accepts valid input", () => {
  const r = validateStopEvidenceAdmission(baseStopInput());
  assert.equal(r.ok, true);
});

test("validateStopEvidenceAdmission: LEASE_MISSING when no lease", () => {
  const r = validateStopEvidenceAdmission(baseStopInput({ lease: null }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_MISSING");
});

test("validateStopEvidenceAdmission: LEASE_REVOKED", () => {
  const r = validateStopEvidenceAdmission(
    baseStopInput({ lease: { ...baseStopInput().lease!, revokedAt: PAST } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_REVOKED");
});

test("validateStopEvidenceAdmission: LEASE_EXPIRED", () => {
  const r = validateStopEvidenceAdmission(
    baseStopInput({ lease: { ...baseStopInput().lease!, expiresAt: PAST } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_EXPIRED");
});

test("validateStopEvidenceAdmission: LEASE_PURPOSE_MISMATCH", () => {
  const r = validateStopEvidenceAdmission(
    baseStopInput({ lease: { ...baseStopInput().lease!, purpose: "provider" as any } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_PURPOSE_MISMATCH");
});

test("validateStopEvidenceAdmission: ATTEMPT_MISMATCH", () => {
  const r = validateStopEvidenceAdmission(
    baseStopInput({ lease: { ...baseStopInput().lease!, attemptId: "other" } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_MISMATCH");
});

test("validateStopEvidenceAdmission: GENERATION_MISMATCH when generation differs from current", () => {
  const r = validateStopEvidenceAdmission(
    baseStopInput({ generation: 0, attempt: { id: "att-1", currentGeneration: 1 } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "GENERATION_MISMATCH");
});

test("validateStopEvidenceAdmission: STEPS_EMPTY when no steps", () => {
  const r = validateStopEvidenceAdmission(baseStopInput({ steps: [] }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "STEPS_EMPTY");
});

test("validateStopEvidenceAdmission: STEPS_TOO_MANY when > 200 steps", () => {
  const manySteps = Array.from({ length: 201 }, () => ({ at: NOW, step: "signal_sent" as const }));
  const r = validateStopEvidenceAdmission(baseStopInput({ steps: manySteps }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "STEPS_TOO_MANY");
});

// ---------------------------------------------------------------------------
// validateLeaseRequest — table tests per code
// ---------------------------------------------------------------------------

const validIntent = {
  attemptId: "att-1",
  generation: 1,
  runId: "run-1",
  status: "running",
};

function baseLeaseInput(overrides: Partial<LeaseRequestInput> = {}): LeaseRequestInput {
  return {
    request: {
      runId: "run-1",
      attemptId: "att-1",
      generation: 1,
      purpose: "upload" as const,
      nonce: "n".repeat(32),
    },
    intent: validIntent,
    providerState: "ready",
    now: NOW,
    ...overrides,
  };
}

test("validateLeaseRequest: returns Ok(purpose) for valid upload request", () => {
  const r = validateLeaseRequest(baseLeaseInput());
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, "upload");
});

test("validateLeaseRequest: unknown_attempt when intent is null", () => {
  const r = validateLeaseRequest(baseLeaseInput({ intent: null }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "unknown_attempt");
});

test("validateLeaseRequest: unknown_run when runId doesn't match", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({ intent: { ...validIntent, runId: "different-run" } }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "unknown_run");
});

test("validateLeaseRequest: stale_generation when request.generation < intent.generation", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      request: { ...baseLeaseInput().request, generation: 0 },
      intent: { ...validIntent, generation: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "stale_generation");
});

test("validateLeaseRequest: login_required for provider with login_required state", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      request: { ...baseLeaseInput().request, purpose: "provider" as const },
      providerState: "login_required",
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "login_required");
});

test("validateLeaseRequest: expired for provider with expired state", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      request: { ...baseLeaseInput().request, purpose: "provider" as const },
      providerState: "expired",
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "expired");
});

test("validateLeaseRequest: unavailable for provider with unavailable state", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      request: { ...baseLeaseInput().request, purpose: "provider" as const },
      providerState: "unavailable",
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "unavailable");
});

test("validateLeaseRequest: returns Ok for provider when state is ready", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      request: { ...baseLeaseInput().request, purpose: "provider" as const },
      providerState: "ready",
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, "provider");
});

test("validateLeaseRequest: returns Ok for git-read with ready state", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      request: { ...baseLeaseInput().request, purpose: "git-read" as const },
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, "git-read");
});

// Order-stability: unknown_attempt before unknown_run
test("validateLeaseRequest: unknown_attempt returned before stale_generation", () => {
  const r = validateLeaseRequest(
    baseLeaseInput({
      intent: null,
      request: { ...baseLeaseInput().request, generation: 0 },
    }),
  );
  assert.equal(!r.ok && r.error, "unknown_attempt");
});

// ---------------------------------------------------------------------------
// X3-1: Kind-aware generation checks
// ---------------------------------------------------------------------------

// attempt kind: lease.generation must equal claimed.generation
test("validateArtifactAdmission: LEASE_GENERATION_MISMATCH when claimed.generation !== lease.generation for attempt kind", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, kind: "attempt", generation: 1 },
      lease: { ...validLease, generation: 0 }, // lease gen 0, claimed gen 1
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_GENERATION_MISMATCH");
});

// attempt kind: valid when all three match
test("validateArtifactAdmission: accepts attempt when lease.generation === claimed.generation === currentGeneration", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, kind: "attempt", generation: 1 },
      lease: { ...validLease, generation: 1 },
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

// attempt kind: fenced — lease gen N, attempt bumped to N+1, container claims N+1 => LEASE_GENERATION_MISMATCH
test("validateArtifactAdmission: fenced generation: attempt kind with old lease token refused (LEASE_GENERATION_MISMATCH)", () => {
  // Lease was issued for generation 0; attempt has been stopped and bumped to generation 1.
  // Container (holding gen-0 token) claims generation 1: must be refused.
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, kind: "attempt", generation: 1 },
      lease: { ...validLease, generation: 0 }, // old gen-0 lease
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "LEASE_GENERATION_MISMATCH");
});

// checkpoint kind: superseded checkpoint accepted (claimed.generation < currentGeneration)
test("validateArtifactAdmission: superseded checkpoint accepted (claimed gen < currentGen, matches lease gen)", () => {
  // Lease was issued for generation 0; attempt advanced to gen 1; container uploads gen-0 checkpoint.
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, kind: "checkpoint", generation: 0, changedPaths: [] },
      lease: { ...validLease, generation: 0 },
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, true);
});

// checkpoint kind: future generation rejected
test("validateArtifactAdmission: FUTURE_GENERATION when checkpoint.generation > currentGeneration", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, kind: "checkpoint", generation: 2, changedPaths: [] },
      lease: { ...validLease, generation: 2 },
      attempt: { ...validAttempt, currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "FUTURE_GENERATION");
});

// stopping status: attempt kind rejected
test("validateArtifactAdmission: ATTEMPT_TERMINAL when status is stopping and kind is attempt", () => {
  const r = validateArtifactAdmission(
    baseInput({
      attempt: { ...validAttempt, status: "stopping" },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_TERMINAL");
});

// uncertain status: attempt kind rejected
test("validateArtifactAdmission: ATTEMPT_TERMINAL when status is uncertain and kind is attempt", () => {
  const r = validateArtifactAdmission(
    baseInput({
      attempt: { ...validAttempt, status: "uncertain" },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_TERMINAL");
});

// stopped status: attempt kind rejected
test("validateArtifactAdmission: ATTEMPT_TERMINAL when status is stopped and kind is attempt", () => {
  const r = validateArtifactAdmission(
    baseInput({
      attempt: { ...validAttempt, status: "stopped" },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "ATTEMPT_TERMINAL");
});

// stopping status: checkpoint kind accepted
test("validateArtifactAdmission: checkpoint accepted when status is stopping", () => {
  const r = validateArtifactAdmission(
    baseInput({
      claimed: { ...validUploadMeta, kind: "checkpoint", generation: 1, changedPaths: [] },
      lease: { ...validLease, generation: 1 },
      attempt: { ...validAttempt, status: "stopping", currentGeneration: 1 },
    }),
  );
  assert.equal(r.ok, true);
});
