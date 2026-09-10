/**
 * Tests for source.ts, artifact.ts, lease.ts (P18.1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactRefSchema,
  ArtifactUploadMetaSchema,
  StopEvidenceUploadSchema,
} from "../src/artifact.ts";
import {
  LeaseGrantSchema,
  LeaseRefusalSchema,
  LeaseRequestSchema,
  redactLeaseGrant,
} from "../src/lease.ts";
import { SourceRefSchema } from "../src/source.ts";

const SHA40 = "a".repeat(40);
const SHA64 = "b".repeat(64);
const DIGEST = `sha256:${"c".repeat(64)}`;

// ---------------------------------------------------------------------------
// SourceRefSchema
// ---------------------------------------------------------------------------

test("SourceRefSchema: valid path", () => {
  const r = SourceRefSchema.safeParse({
    projectId: "proj-1",
    revision: SHA40,
    bundlePath: "/internal/source/proj-1?rev=" + SHA40,
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("SourceRefSchema: rejects full URL with scheme", () => {
  const r = SourceRefSchema.safeParse({
    projectId: "proj-1",
    revision: SHA40,
    bundlePath: "https://coordinator.internal/source/proj-1",
  });
  assert.equal(r.success, false);
});

test("SourceRefSchema: rejects URL with userinfo (@)", () => {
  const r = SourceRefSchema.safeParse({
    projectId: "proj-1",
    revision: SHA40,
    bundlePath: "user:pass@host/path",
  });
  assert.equal(r.success, false);
});

test("SourceRefSchema: rejects non-40-hex revision", () => {
  const r = SourceRefSchema.safeParse({
    projectId: "proj-1",
    revision: "short",
    bundlePath: "/internal/source/proj-1",
  });
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// ArtifactRefSchema
// ---------------------------------------------------------------------------

test("ArtifactRefSchema: valid", () => {
  const r = ArtifactRefSchema.safeParse({ attemptId: "att-1", generation: 0, revision: SHA40 });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("ArtifactRefSchema: rejects negative generation", () => {
  const r = ArtifactRefSchema.safeParse({ attemptId: "att-1", generation: -1, revision: SHA40 });
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// ArtifactUploadMetaSchema
// ---------------------------------------------------------------------------

const validUploadMeta = {
  attemptId: "att-1",
  generation: 0,
  kind: "attempt" as const,
  commitId: SHA40,
  diffDigest: DIGEST,
  changedPaths: ["src/foo.ts"],
  bundleSha256: SHA64,
  bundleBytes: 1024,
};

test("ArtifactUploadMetaSchema: valid attempt", () => {
  const r = ArtifactUploadMetaSchema.safeParse(validUploadMeta);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("ArtifactUploadMetaSchema: valid checkpoint", () => {
  const r = ArtifactUploadMetaSchema.safeParse({ ...validUploadMeta, kind: "checkpoint" });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("ArtifactUploadMetaSchema: rejects invalid kind", () => {
  const r = ArtifactUploadMetaSchema.safeParse({ ...validUploadMeta, kind: "other" });
  assert.equal(r.success, false);
});

test("ArtifactUploadMetaSchema: rejects negative bundleBytes", () => {
  const r = ArtifactUploadMetaSchema.safeParse({ ...validUploadMeta, bundleBytes: -1 });
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// StopEvidenceUploadSchema
// ---------------------------------------------------------------------------

test("StopEvidenceUploadSchema: valid single step", () => {
  const r = StopEvidenceUploadSchema.safeParse({
    attemptId: "att-1",
    generation: 1,
    steps: [{ at: "2026-09-09T10:00:00.000Z", step: "signal_sent" }],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("StopEvidenceUploadSchema: rejects newline in detail", () => {
  const r = StopEvidenceUploadSchema.safeParse({
    attemptId: "att-1",
    generation: 1,
    steps: [{ at: "2026-09-09T10:00:00.000Z", step: "signal_sent", detail: "line1\nline2" }],
  });
  assert.equal(r.success, false);
});

test("StopEvidenceUploadSchema: rejects detail > 2000 chars", () => {
  const r = StopEvidenceUploadSchema.safeParse({
    attemptId: "att-1",
    generation: 1,
    steps: [{ at: "2026-09-09T10:00:00.000Z", step: "signal_sent", detail: "x".repeat(2001) }],
  });
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// LeaseRequestSchema
// ---------------------------------------------------------------------------

test("LeaseRequestSchema: valid", () => {
  const r = LeaseRequestSchema.safeParse({
    runId: "run-1",
    attemptId: "att-1",
    generation: 0,
    purpose: "provider",
    nonce: "n".repeat(32),
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeaseRequestSchema: rejects nonce shorter than 32 chars", () => {
  const r = LeaseRequestSchema.safeParse({
    runId: "run-1",
    attemptId: "att-1",
    generation: 0,
    purpose: "upload",
    nonce: "short",
  });
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// LeaseGrantSchema + redactLeaseGrant
// ---------------------------------------------------------------------------

const providerGrant = {
  leaseId: "lease-1",
  purpose: "provider" as const,
  expiresAt: "2026-09-09T11:00:00.000Z",
  material: { purpose: "provider" as const, authJson: '{"access_token":"secret-token"}' },
};

const gitReadGrant = {
  leaseId: "lease-2",
  purpose: "git-read" as const,
  expiresAt: "2026-09-09T11:00:00.000Z",
  material: {
    purpose: "git-read" as const,
    remote: "https://github.com/org/repo",
    tokenRef: "token-ref-1",
    askpassToken: "secret-askpass-token",
  },
};

const uploadGrant = {
  leaseId: "lease-3",
  purpose: "upload" as const,
  expiresAt: "2026-09-09T11:00:00.000Z",
  material: { purpose: "upload" as const, token: "secret-upload-token" },
};

test("LeaseGrantSchema: valid provider grant", () => {
  const r = LeaseGrantSchema.safeParse(providerGrant);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeaseGrantSchema: valid git-read grant", () => {
  const r = LeaseGrantSchema.safeParse(gitReadGrant);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeaseGrantSchema: valid upload grant", () => {
  const r = LeaseGrantSchema.safeParse(uploadGrant);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeaseGrantSchema: rejects remote with userinfo (git-read)", () => {
  const r = LeaseGrantSchema.safeParse({
    ...gitReadGrant,
    material: {
      ...gitReadGrant.material,
      remote: "https://user:pass@github.com/org/repo",
    },
  });
  assert.equal(r.success, false);
});

test("redactLeaseGrant: provider — authJson is redacted", () => {
  const parsed = LeaseGrantSchema.parse(providerGrant);
  const redacted = redactLeaseGrant(parsed);
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes("secret-token"), "authJson secret must not appear in redacted JSON");
  assert.ok(json.includes("<redacted>"), "redacted marker must appear");
});

test("redactLeaseGrant: git-read — tokenRef and askpassToken are redacted", () => {
  const parsed = LeaseGrantSchema.parse(gitReadGrant);
  const redacted = redactLeaseGrant(parsed);
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes("token-ref-1"), "tokenRef must not appear");
  assert.ok(!json.includes("secret-askpass-token"), "askpassToken must not appear");
  // remote URL is NOT a secret and must be preserved
  assert.ok(json.includes("github.com/org/repo"), "remote URL must be preserved");
});

test("redactLeaseGrant: upload — token is redacted", () => {
  const parsed = LeaseGrantSchema.parse(uploadGrant);
  const redacted = redactLeaseGrant(parsed);
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes("secret-upload-token"), "token must not appear");
});

test("redactLeaseGrant: integrate — both tokenRef and askpassToken are redacted", () => {
  const integrateGrant = {
    leaseId: "lease-4",
    purpose: "integrate" as const,
    expiresAt: "2026-09-09T11:00:00.000Z",
    material: {
      purpose: "integrate" as const,
      remote: "https://github.com/org/repo",
      tokenRef: "integrate-token-ref",
      askpassToken: "integrate-secret-askpass",
    },
  };
  const parsed = LeaseGrantSchema.parse(integrateGrant);
  const redacted = redactLeaseGrant(parsed);
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes("integrate-token-ref"), "tokenRef must not appear");
  assert.ok(!json.includes("integrate-secret-askpass"), "askpassToken must not appear");
});

// ---------------------------------------------------------------------------
// LeaseRefusalSchema
// ---------------------------------------------------------------------------

test("LeaseRefusalSchema: valid refusal", () => {
  const r = LeaseRefusalSchema.safeParse({ purpose: "provider", reason: "login_required" });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("LeaseRefusalSchema: rejects unknown reason", () => {
  const r = LeaseRefusalSchema.safeParse({ purpose: "provider", reason: "bad_reason" });
  assert.equal(r.success, false);
});
