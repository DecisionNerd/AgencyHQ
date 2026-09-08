// Unit tests for trigger/src/lib/manifest.ts — pure helpers for combined
// verification across revision manifest entries. No Trigger SDK usage.
// Tests: siblingEntries, manifestEnv.

import assert from "node:assert/strict";
import test from "node:test";
import type { ManifestEntry } from "@agencyhq/contracts";
import { manifestEnv, siblingEntries } from "../src/lib/manifest.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEntry(
  position: number,
  projectId: string,
  opts: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    position,
    projectId,
    targetRef: "refs/heads/main",
    expectedBaseRevision: "a".repeat(40),
    resultRevision: null,
    ...opts,
  };
}

const PRODUCER = makeEntry(0, "producer", {
  expectedBaseRevision: "b".repeat(40),
  resultRevision: "c".repeat(40),
});
const CONSUMER = makeEntry(1, "consumer", {
  expectedBaseRevision: "d".repeat(40),
  resultRevision: null,
});
const THIRD = makeEntry(2, "third-repo", {
  expectedBaseRevision: "e".repeat(40),
  resultRevision: null,
});

const ALL_ENTRIES = [PRODUCER, CONSUMER, THIRD];

// ---------------------------------------------------------------------------
// siblingEntries
// ---------------------------------------------------------------------------

test("siblingEntries: excludes only the entry with matching projectId", () => {
  const siblings = siblingEntries(ALL_ENTRIES, "consumer");
  assert.equal(siblings.length, 2, "expected 2 siblings when consumer is excluded");
  assert.ok(
    siblings.every((e) => e.projectId !== "consumer"),
    "consumer must not appear in siblings",
  );
  const positions = siblings.map((e) => e.position).sort();
  assert.deepEqual(positions, [0, 2], "positions must be producer (0) and third-repo (2)");
});

test("siblingEntries: empty list when single entry matches", () => {
  const single = [makeEntry(0, "only-project")];
  const siblings = siblingEntries(single, "only-project");
  assert.equal(siblings.length, 0, "no siblings when the only entry is the current project");
});

test("siblingEntries: all entries returned when no entry matches projectId", () => {
  const siblings = siblingEntries(ALL_ENTRIES, "nonexistent");
  assert.equal(siblings.length, ALL_ENTRIES.length, "all entries returned for unknown projectId");
});

test("siblingEntries: preserves entry order", () => {
  const siblings = siblingEntries(ALL_ENTRIES, "producer");
  assert.deepEqual(
    siblings.map((e) => e.projectId),
    ["consumer", "third-repo"],
    "order must be preserved",
  );
});

test("siblingEntries: does not mutate input array", () => {
  const entries = [...ALL_ENTRIES];
  siblingEntries(entries, "consumer");
  assert.equal(entries.length, ALL_ENTRIES.length, "input array must not be mutated");
});

// ---------------------------------------------------------------------------
// manifestEnv
// ---------------------------------------------------------------------------

test("manifestEnv: builds correct AGENCYHQ_MANIFEST_<N> vars for each entry", () => {
  const siblings = siblingEntries(ALL_ENTRIES, "consumer");
  const paths: Record<number, string> = {
    0: "/repos/producer-wt",
    2: "/repos/third-wt",
  };
  const digest = `sha256:${"f".repeat(64)}`;

  const env = manifestEnv(siblings, paths, digest);

  assert.equal(env.AGENCYHQ_MANIFEST_DIGEST, digest, "digest must be set");
  assert.equal(env.AGENCYHQ_MANIFEST_0, "/repos/producer-wt", "position 0 must map to producer-wt");
  assert.equal(env.AGENCYHQ_MANIFEST_2, "/repos/third-wt", "position 2 must map to third-wt");
  assert.equal(Object.keys(env).length, 3, "exactly 3 keys: digest + 2 position vars");
});

test("manifestEnv: skips entries with no path in the map", () => {
  const siblings = siblingEntries(ALL_ENTRIES, "consumer");
  // Only provide path for position 0, not for position 2.
  const paths: Record<number, string> = { 0: "/repos/producer-wt" };
  const digest = `sha256:${"a".repeat(64)}`;

  const env = manifestEnv(siblings, paths, digest);

  assert.equal(env.AGENCYHQ_MANIFEST_0, "/repos/producer-wt");
  assert.equal(env.AGENCYHQ_MANIFEST_2, undefined, "missing position must not produce a key");
  assert.equal(Object.keys(env).length, 2, "digest + 1 position var");
});

test("manifestEnv: empty entries produces only digest var", () => {
  const env = manifestEnv([], {}, `sha256:${"0".repeat(64)}`);
  assert.deepEqual(Object.keys(env), ["AGENCYHQ_MANIFEST_DIGEST"]);
});

test("manifestEnv: does not include AGENCYHQ_MANIFEST_DIGEST in position vars", () => {
  const env = manifestEnv([PRODUCER], { 0: "/wt" }, `sha256:${"1".repeat(64)}`);
  const keys = Object.keys(env);
  assert.ok(keys.includes("AGENCYHQ_MANIFEST_DIGEST"), "digest key must be present");
  assert.ok(keys.includes("AGENCYHQ_MANIFEST_0"), "position key must be present");
  // No accidental extra keys.
  assert.equal(keys.length, 2);
});
