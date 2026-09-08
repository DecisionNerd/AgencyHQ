import assert from "node:assert/strict";
import test from "node:test";
import { TASK_IDS } from "../src/index.ts";
import { manifestDigest, RevisionManifestSchema } from "../src/manifest.ts";
import { jsonSchemaFor } from "../src/opencode/json-schema.ts";
import {
  IntegrateMergeOutputSchema,
  IntegrateMergePayloadSchema,
} from "../src/tasks/integrate-merge.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REV_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REV_C = "cccccccccccccccccccccccccccccccccccccccc";

/** Build a single-entry manifest with the correct digest. */
function singleEntryManifest(resultRevision: string | null = null) {
  const entries = [
    {
      position: 0,
      projectId: "proj-1",
      targetRef: "refs/heads/main",
      expectedBaseRevision: REV_A,
      resultRevision,
    },
  ];
  return { entries, digest: manifestDigest(entries) };
}

/** Build a two-entry manifest with the correct digest. */
function twoEntryManifest() {
  const entries = [
    {
      position: 0,
      projectId: "proj-1",
      targetRef: "refs/heads/main",
      expectedBaseRevision: REV_A,
      resultRevision: null,
    },
    {
      position: 1,
      projectId: "proj-2",
      targetRef: "refs/heads/main",
      expectedBaseRevision: REV_B,
      resultRevision: null,
    },
  ];
  return { entries, digest: manifestDigest(entries) };
}

// ---------------------------------------------------------------------------
// RevisionManifestSchema
// ---------------------------------------------------------------------------

test("RevisionManifestSchema: parses a valid single-entry manifest", () => {
  const r = RevisionManifestSchema.safeParse(singleEntryManifest());
  assert.equal(r.success, true, JSON.stringify(r));
});

test("RevisionManifestSchema: parses a valid two-entry manifest", () => {
  const r = RevisionManifestSchema.safeParse(twoEntryManifest());
  assert.equal(r.success, true, JSON.stringify(r));
});

test("RevisionManifestSchema: parses a manifest with resultRevision set", () => {
  const r = RevisionManifestSchema.safeParse(singleEntryManifest(REV_C));
  assert.equal(r.success, true, JSON.stringify(r));
});

test("RevisionManifestSchema: rejects bad expectedBaseRevision (not 40 hex)", () => {
  const base = singleEntryManifest();
  const bad = {
    entries: [{ ...base.entries[0], expectedBaseRevision: "notahex" }],
    digest: base.digest, // digest is now wrong too, but we test hex first
  };
  const r = RevisionManifestSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject non-hex expectedBaseRevision");
});

test("RevisionManifestSchema: rejects bad resultRevision (not 40 hex)", () => {
  const bad = {
    entries: [
      {
        position: 0,
        projectId: "proj-1",
        targetRef: "refs/heads/main",
        expectedBaseRevision: REV_A,
        resultRevision: "tooshort", // invalid: not 40 hex chars
      },
    ],
    // Digest doesn't matter here — schema rejects on resultRevision first.
    digest: `sha256:${"a".repeat(64)}`,
  };
  const r = RevisionManifestSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject non-hex resultRevision");
});

test("RevisionManifestSchema: rejects duplicate positions", () => {
  const e0a = {
    position: 0,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_A,
    resultRevision: null,
  };
  const e0b = {
    position: 0, // duplicate!
    projectId: "proj-2",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_B,
    resultRevision: null,
  };
  const entries = [e0a, e0b];
  const bad = { entries, digest: manifestDigest(entries) };
  const r = RevisionManifestSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject duplicate positions");
});

test("RevisionManifestSchema: rejects non-contiguous positions (0, 2 — missing 1)", () => {
  const entries = [
    {
      position: 0,
      projectId: "proj-1",
      targetRef: "refs/heads/main",
      expectedBaseRevision: REV_A,
      resultRevision: null,
    },
    {
      position: 2, // gap: position 1 missing
      projectId: "proj-2",
      targetRef: "refs/heads/main",
      expectedBaseRevision: REV_B,
      resultRevision: null,
    },
  ];
  const bad = { entries, digest: manifestDigest(entries) };
  const r = RevisionManifestSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject non-contiguous positions");
});

test("RevisionManifestSchema: rejects digest mismatch", () => {
  const base = singleEntryManifest();
  const bad = { ...base, digest: `sha256:${"0".repeat(64)}` };
  const r = RevisionManifestSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject incorrect digest");
});

test("RevisionManifestSchema: rejects malformed digest (not sha256: prefix)", () => {
  const base = singleEntryManifest();
  const bad = { ...base, digest: "md5:abc123" };
  const r = RevisionManifestSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject non-sha256 digest prefix");
});

// ---------------------------------------------------------------------------
// manifestDigest helper
// ---------------------------------------------------------------------------

test("manifestDigest: is stable — same entries same digest", () => {
  const entries = singleEntryManifest().entries;
  assert.equal(manifestDigest(entries), manifestDigest(entries));
});

test("manifestDigest: ignores resultRevision", () => {
  const withNull = singleEntryManifest(null).entries;
  const withResult = singleEntryManifest(REV_C).entries;
  assert.equal(
    manifestDigest(withNull),
    manifestDigest(withResult),
    "digest must not change when resultRevision changes",
  );
});

test("manifestDigest: is insensitive to input array order (sorted by position)", () => {
  const e0 = {
    position: 0,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_A,
    resultRevision: null,
  };
  const e1 = {
    position: 1,
    projectId: "proj-2",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_B,
    resultRevision: null,
  };
  assert.equal(
    manifestDigest([e0, e1]),
    manifestDigest([e1, e0]),
    "digest must be the same regardless of input array order",
  );
});

test("manifestDigest: is order-sensitive by position — swapping position values changes the digest", () => {
  const e0 = {
    position: 0,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_A,
    resultRevision: null,
  };
  const e1 = {
    position: 1,
    projectId: "proj-2",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_B,
    resultRevision: null,
  };
  // Swap the positions so proj-1 is now at position 1 and proj-2 at position 0
  const e0swapped = { ...e0, position: 1 };
  const e1swapped = { ...e1, position: 0 };
  assert.notEqual(
    manifestDigest([e0, e1]),
    manifestDigest([e0swapped, e1swapped]),
    "swapping positions must produce a different digest",
  );
});

test("manifestDigest: changes when expectedBaseRevision changes", () => {
  const e = {
    position: 0,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: REV_A,
    resultRevision: null,
  };
  const eChanged = { ...e, expectedBaseRevision: REV_B };
  assert.notEqual(manifestDigest([e]), manifestDigest([eChanged]));
});

// ---------------------------------------------------------------------------
// IntegrateMergePayloadSchema
// ---------------------------------------------------------------------------

const validPayload = {
  attemptId: "att-1",
  generation: 1,
  contractId: "sc-1",
  contractVersion: 1,
  projectId: "proj-1",
  repoPath: "/repos/proj-1",
  remote: "origin",
  targetRef: "refs/heads/main",
  expectedBaseRevision: REV_A,
  attemptRevision: REV_B,
  strategy: "merge_commit" as const,
};

test("IntegrateMergePayloadSchema: parses a valid merge_commit payload", () => {
  const r = IntegrateMergePayloadSchema.safeParse(validPayload);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergePayloadSchema: parses a valid fast_forward payload", () => {
  const r = IntegrateMergePayloadSchema.safeParse({
    ...validPayload,
    strategy: "fast_forward",
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergePayloadSchema: rejects bad expectedBaseRevision (39 hex chars)", () => {
  const bad = { ...validPayload, expectedBaseRevision: "a".repeat(39) };
  const r = IntegrateMergePayloadSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject 39-char hex");
});

test("IntegrateMergePayloadSchema: rejects bad attemptRevision (upper-case hex)", () => {
  const bad = { ...validPayload, attemptRevision: "A".repeat(40) };
  const r = IntegrateMergePayloadSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject upper-case hex");
});

test("IntegrateMergePayloadSchema: rejects unknown strategy", () => {
  const bad = { ...validPayload, strategy: "squash" };
  const r = IntegrateMergePayloadSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject unknown strategy");
});

test("IntegrateMergePayloadSchema: rejects generation < 1", () => {
  const bad = { ...validPayload, generation: 0 };
  const r = IntegrateMergePayloadSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject generation 0");
});

test("IntegrateMergePayloadSchema: rejects contractVersion < 1", () => {
  const bad = { ...validPayload, contractVersion: 0 };
  const r = IntegrateMergePayloadSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject contractVersion 0");
});

test("IntegrateMergePayloadSchema: rejects missing projectId", () => {
  const { projectId: _omit, ...bad } = validPayload;
  const r = IntegrateMergePayloadSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// IntegrateMergeOutputSchema
// ---------------------------------------------------------------------------

const validOutput = {
  outcome: "integrated" as const,
  resultingRevision: REV_C,
  observedTargetRevision: REV_A,
  evidence: ["Merged abc into main", "Pushed to origin/main"],
};

test("IntegrateMergeOutputSchema: parses a valid integrated output", () => {
  const r = IntegrateMergeOutputSchema.safeParse(validOutput);
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergeOutputSchema: parses a valid already_integrated output", () => {
  const r = IntegrateMergeOutputSchema.safeParse({
    outcome: "already_integrated",
    observedTargetRevision: REV_A,
    evidence: ["Attempt revision is an ancestor of refs/heads/main"],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergeOutputSchema: parses a valid base_moved output", () => {
  const r = IntegrateMergeOutputSchema.safeParse({
    outcome: "base_moved",
    observedTargetRevision: REV_B,
    evidence: [`refs/heads/main advanced beyond expected base ${REV_A}`],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergeOutputSchema: parses a valid conflict output with conflictingPaths", () => {
  const r = IntegrateMergeOutputSchema.safeParse({
    outcome: "conflict",
    observedTargetRevision: REV_A,
    evidence: ["Merge conflict in src/parser.ts"],
    conflictingPaths: ["src/parser.ts", "src/lexer.ts"],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergeOutputSchema: parses a valid push_rejected output", () => {
  const r = IntegrateMergeOutputSchema.safeParse({
    outcome: "push_rejected",
    observedTargetRevision: REV_A,
    evidence: ["Remote rejected push: protected branch policy"],
  });
  assert.equal(r.success, true, JSON.stringify(r));
});

test("IntegrateMergeOutputSchema: rejects unknown outcome", () => {
  const bad = { ...validOutput, outcome: "force_pushed" };
  const r = IntegrateMergeOutputSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject unknown outcome");
});

test("IntegrateMergeOutputSchema: rejects bad observedTargetRevision", () => {
  const bad = { ...validOutput, observedTargetRevision: "not-a-rev" };
  const r = IntegrateMergeOutputSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject non-hex observedTargetRevision");
});

test("IntegrateMergeOutputSchema: rejects bad resultingRevision", () => {
  const bad = { ...validOutput, resultingRevision: "short" };
  const r = IntegrateMergeOutputSchema.safeParse(bad);
  assert.equal(r.success, false, "should reject non-hex resultingRevision");
});

test("IntegrateMergeOutputSchema: resultingRevision is optional", () => {
  const { resultingRevision: _omit, ...noResult } = validOutput;
  const r = IntegrateMergeOutputSchema.safeParse(noResult);
  assert.equal(r.success, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// JSON Schema conversion
// ---------------------------------------------------------------------------

test("jsonSchemaFor: converts IntegrateMergeOutputSchema without throwing", () => {
  const schema = jsonSchemaFor(IntegrateMergeOutputSchema);
  assert.ok(typeof schema === "object" && schema !== null);
  const s = JSON.stringify(schema);
  assert.ok(s.includes("outcome"), "JSON schema should reference 'outcome' field");
  assert.ok(s.includes("integrated"), "JSON schema should include 'integrated' enum value");
  assert.ok(
    s.includes("observedTargetRevision"),
    "JSON schema should reference 'observedTargetRevision'",
  );
});

// ---------------------------------------------------------------------------
// TASK_IDS
// ---------------------------------------------------------------------------

test("TASK_IDS.integrateMerge: equals integrate.merge", () => {
  assert.equal(TASK_IDS.integrateMerge, "integrate.merge");
});
