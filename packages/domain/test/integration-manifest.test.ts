/**
 * Table tests and property tests for integration/manifest.ts.
 *
 * Tests:
 *   - nextEntry: selects the unresolved entry with the lowest position
 *   - allResolved: returns true iff every entry has a non-null resultRevision
 *   - manifestDigestInput: stable JSON, sorted by position, without resultRevision
 *   - fast-check: nextEntry always returns the minimum-position unresolved entry
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fc from "fast-check";

import type { ManifestEntry } from "../src/integration/manifest.ts";
import { allResolved, manifestDigestInput, nextEntry } from "../src/integration/manifest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(
  position: number,
  resultRevision: string | null = null,
  overrides: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    position,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: "a".repeat(40),
    resultRevision,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// nextEntry
// ---------------------------------------------------------------------------

test("nextEntry: empty list returns undefined", () => {
  assert.equal(nextEntry([]), undefined);
});

test("nextEntry: all resolved returns undefined", () => {
  const entries = [entry(0, "rev-0"), entry(1, "rev-1"), entry(2, "rev-2")];
  assert.equal(nextEntry(entries), undefined);
});

test("nextEntry: single unresolved entry is returned", () => {
  const e = entry(0);
  assert.deepEqual(nextEntry([e]), e);
});

test("nextEntry: returns the lowest-position unresolved entry", () => {
  const entries = [entry(2, "rev-2"), entry(0), entry(1, "rev-1")];
  const result = nextEntry(entries);
  assert.equal(result?.position, 0);
});

test("nextEntry: skips resolved entries and returns first unresolved", () => {
  const entries = [entry(0, "rev-0"), entry(1), entry(2)];
  const result = nextEntry(entries);
  assert.equal(result?.position, 1);
});

test("nextEntry: tie-breaking by position when multiple unresolved", () => {
  // position 3 comes first in array but position 1 is lower
  const entries = [entry(3), entry(1), entry(2)];
  const result = nextEntry(entries);
  assert.equal(result?.position, 1);
});

test("nextEntry: returns correct entry object (not just position)", () => {
  const target = entry(5, null, { projectId: "proj-target" });
  const entries = [entry(10, null, { projectId: "proj-other" }), target];
  const result = nextEntry(entries);
  assert.equal(result?.projectId, "proj-target");
  assert.equal(result?.position, 5);
});

test("nextEntry: works with single-element unresolved list", () => {
  const e = entry(42, null, { targetRef: "refs/heads/feature" });
  assert.deepEqual(nextEntry([e]), e);
});

// ---------------------------------------------------------------------------
// allResolved
// ---------------------------------------------------------------------------

test("allResolved: empty list is resolved (vacuously true)", () => {
  assert.equal(allResolved([]), true);
});

test("allResolved: all entries resolved returns true", () => {
  const entries = [entry(0, "rev-a"), entry(1, "rev-b"), entry(2, "rev-c")];
  assert.equal(allResolved(entries), true);
});

test("allResolved: one unresolved entry returns false", () => {
  const entries = [entry(0, "rev-a"), entry(1), entry(2, "rev-c")];
  assert.equal(allResolved(entries), false);
});

test("allResolved: all unresolved returns false", () => {
  const entries = [entry(0), entry(1), entry(2)];
  assert.equal(allResolved(entries), false);
});

test("allResolved: single resolved entry returns true", () => {
  assert.equal(allResolved([entry(0, "sha")]), true);
});

test("allResolved: single unresolved entry returns false", () => {
  assert.equal(allResolved([entry(0)]), false);
});

// ---------------------------------------------------------------------------
// manifestDigestInput
// ---------------------------------------------------------------------------

test("manifestDigestInput: empty list produces empty JSON array", () => {
  assert.equal(manifestDigestInput([]), "[]");
});

test("manifestDigestInput: excludes resultRevision from serialised form", () => {
  const entries = [entry(0, "some-rev")];
  const json = manifestDigestInput(entries);
  assert.ok(!json.includes("resultRevision"), "resultRevision must not appear in digest input");
  assert.ok(!json.includes("some-rev"), "result revision value must not appear in digest input");
});

test("manifestDigestInput: includes position, projectId, targetRef, expectedBaseRevision", () => {
  const e = entry(0, "rev", {
    projectId: "proj-x",
    targetRef: "refs/heads/main",
    expectedBaseRevision: "base-sha",
  });
  const json = manifestDigestInput([e]);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].position, 0);
  assert.equal(parsed[0].projectId, "proj-x");
  assert.equal(parsed[0].targetRef, "refs/heads/main");
  assert.equal(parsed[0].expectedBaseRevision, "base-sha");
});

test("manifestDigestInput: entries are sorted by position ascending", () => {
  const entries = [entry(2), entry(0), entry(1)];
  const json = manifestDigestInput(entries);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].position, 0);
  assert.equal(parsed[1].position, 1);
  assert.equal(parsed[2].position, 2);
});

test("manifestDigestInput: output is stable (same result for same input in different order)", () => {
  const entries1 = [entry(0), entry(1), entry(2)];
  const entries2 = [entry(2), entry(0), entry(1)];
  assert.equal(manifestDigestInput(entries1), manifestDigestInput(entries2));
});

test("manifestDigestInput: resultRevision null vs non-null does not change digest", () => {
  const e1 = entry(0, null);
  const e2 = entry(0, "some-result-sha");
  assert.equal(manifestDigestInput([e1]), manifestDigestInput([e2]));
});

test("manifestDigestInput: different positions produce different digests", () => {
  const e1 = entry(0);
  const e2 = entry(1);
  assert.notEqual(manifestDigestInput([e1]), manifestDigestInput([e2]));
});

test("manifestDigestInput: different projectIds produce different digests", () => {
  const e1 = entry(0, null, { projectId: "proj-a" });
  const e2 = entry(0, null, { projectId: "proj-b" });
  assert.notEqual(manifestDigestInput([e1]), manifestDigestInput([e2]));
});

test("manifestDigestInput: valid JSON output", () => {
  const entries = [entry(0), entry(1)];
  assert.doesNotThrow(() => JSON.parse(manifestDigestInput(entries)));
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

/** Arbitrary for a non-null result revision string. */
const arbitraryRevision = fc.string({ minLength: 8, maxLength: 40 });

/** Arbitrary for a ManifestEntry with a random position and optional result. */
const arbitraryEntry = fc
  .tuple(
    fc.integer({ min: 0, max: 100 }),
    fc.oneof(fc.constant(null as string | null), arbitraryRevision),
  )
  .map(([position, resultRevision]) =>
    entry(position, resultRevision, { projectId: `proj-${position}` }),
  );

test("property: nextEntry always returns the minimum-position unresolved entry", () => {
  fc.assert(
    fc.property(fc.array(arbitraryEntry, { minLength: 1, maxLength: 20 }), (entries) => {
      const result = nextEntry(entries);
      const unresolved = entries.filter((e) => e.resultRevision === null);

      if (unresolved.length === 0) {
        // allResolved: nextEntry returns undefined
        assert.equal(result, undefined);
        return;
      }

      assert.notEqual(result, undefined);
      const minPosition = Math.min(...unresolved.map((e) => e.position));
      assert.equal(result!.position, minPosition);
    }),
    { numRuns: 200 },
  );
});

test("property: manifestDigestInput is stable under permutation", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .integer({ min: 0, max: 20 })
          .map((pos) => entry(pos, null, { projectId: `proj-${pos}` })),
        { minLength: 0, maxLength: 10 },
      ),
      (entries) => {
        // Shuffle entries
        const shuffled = [...entries].sort(() => 0.5 - Math.random());
        assert.equal(manifestDigestInput(entries), manifestDigestInput(shuffled));
      },
    ),
    { numRuns: 100 },
  );
});
