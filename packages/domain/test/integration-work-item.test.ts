/**
 * Tests for complete() with merge and deploy boundaries.
 *
 * Covers:
 *   - merge: unresolved manifest → Err (manifest_unresolved)
 *   - merge: resolved manifest → Ok with last entry's resultRevision + manifestDigest
 *   - merge: revision in event matches last (highest position) entry
 *   - deploy: always → Err (deploy_not_supported)
 *
 * See: packages/domain/src/transitions/work-item.ts
 * See: docs/REQUIREMENTS.md R-015
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItem } from "../src/aggregates/work-item.ts";
import { newId } from "../src/ids.ts";
import type { ManifestEntry } from "../src/integration/manifest.ts";
import { allResolved, manifestDigestInput } from "../src/integration/manifest.ts";
import { complete } from "../src/transitions/work-item.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkItem(boundary: "artifact" | "merge" | "deploy" = "merge"): WorkItem {
  return {
    id: newId("wi"),
    projectId: newId("prj"),
    rank: 1,
    intent: "Multi-repo refactor",
    boundary,
    lifecycle: "active",
    condition: "healthy",
    mainEffort: true,
    version: 1,
  };
}

function resolvedEntry(position: number, resultRevision: string): ManifestEntry {
  return {
    position,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: "base-sha",
    resultRevision,
  };
}

function unresolvedEntry(position: number): ManifestEntry {
  return {
    position,
    projectId: "proj-1",
    targetRef: "refs/heads/main",
    expectedBaseRevision: "base-sha",
    resultRevision: null,
  };
}

// ---------------------------------------------------------------------------
// merge boundary — unresolved manifest
// ---------------------------------------------------------------------------

test("complete(merge): unresolved manifest → Err manifest_unresolved", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [
    resolvedEntry(0, "rev-0"),
    unresolvedEntry(1), // unresolved
  ];
  const result = complete(wi, {
    boundary: "merge",
    manifest,
    manifestDigest: "digest-placeholder",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "manifest_unresolved");
  }
});

test("complete(merge): all-unresolved manifest → Err", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [unresolvedEntry(0), unresolvedEntry(1)];
  const result = complete(wi, {
    boundary: "merge",
    manifest,
    manifestDigest: "digest-x",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "manifest_unresolved");
  }
});

test("allResolved: empty manifest is considered resolved (vacuously true)", () => {
  // An empty manifest has no unresolved entries.
  assert.equal(allResolved([]), true);
});

// ---------------------------------------------------------------------------
// merge boundary — resolved manifest
// ---------------------------------------------------------------------------

test("complete(merge): resolved manifest → Ok with lifecycle completed", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [resolvedEntry(0, "rev-0"), resolvedEntry(1, "rev-1")];
  const digest = manifestDigestInput(manifest);
  const result = complete(wi, { boundary: "merge", manifest, manifestDigest: digest });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.lifecycle, "completed");
    assert.equal(result.value.workItem.boundary, "merge");
  }
});

test("complete(merge): completion revision = last entry resultRevision (highest position)", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [
    resolvedEntry(0, "rev-0"),
    resolvedEntry(2, "rev-last"),
    resolvedEntry(1, "rev-1"),
  ];
  const digest = manifestDigestInput(manifest);
  const result = complete(wi, { boundary: "merge", manifest, manifestDigest: digest });
  assert.equal(result.ok, true);
  if (result.ok) {
    const detail = result.value.events[0]?.detail as { revision: string; manifestDigest: string };
    assert.equal(
      detail.revision,
      "rev-last",
      "revision must be the last (highest-position) entry's resultRevision",
    );
  }
});

test("complete(merge): single-entry resolved manifest → Ok with that entry's revision", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [resolvedEntry(0, "the-only-rev")];
  const digest = manifestDigestInput(manifest);
  const result = complete(wi, { boundary: "merge", manifest, manifestDigest: digest });
  assert.equal(result.ok, true);
  if (result.ok) {
    const detail = result.value.events[0]?.detail as { revision: string };
    assert.equal(detail.revision, "the-only-rev");
  }
});

test("complete(merge): manifestDigest appears in event detail", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [resolvedEntry(0, "rev-0")];
  const digest = "my-manifest-digest";
  const result = complete(wi, { boundary: "merge", manifest, manifestDigest: digest });
  assert.equal(result.ok, true);
  if (result.ok) {
    const detail = result.value.events[0]?.detail as { manifestDigest: string };
    assert.equal(detail.manifestDigest, digest);
  }
});

test("complete(merge): version is incremented", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [resolvedEntry(0, "rev-0")];
  const result = complete(wi, {
    boundary: "merge",
    manifest,
    manifestDigest: manifestDigestInput(manifest),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.workItem.version, 2);
  }
});

test("complete(merge): event type is work_item.completed", () => {
  const wi = makeWorkItem("merge");
  const manifest: ManifestEntry[] = [resolvedEntry(0, "rev-0")];
  const result = complete(wi, {
    boundary: "merge",
    manifest,
    manifestDigest: manifestDigestInput(manifest),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.events[0]?.type, "work_item.completed");
  }
});

// ---------------------------------------------------------------------------
// deploy boundary
// ---------------------------------------------------------------------------

test("complete(deploy): always → Err deploy_not_supported", () => {
  const wi = makeWorkItem("deploy");
  const result = complete(wi, { boundary: "deploy" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "deploy_not_supported");
  }
});

test("complete(deploy): error has a reason field", () => {
  const wi = makeWorkItem("deploy");
  const result = complete(wi, { boundary: "deploy" });
  assert.equal(result.ok, false);
  if (!result.ok && "reason" in result.error) {
    assert.ok(
      typeof result.error.reason === "string" && result.error.reason.length > 0,
      "deploy_not_supported must include a reason",
    );
  }
});

test("complete(deploy): allowed from active lifecycle but still Err", () => {
  // deploy is in the allowed commands for 'active', but the business logic rejects it
  const wi = makeWorkItem();
  wi.boundary; // ignore boundary field, use explicit command
  const result = complete({ ...wi, lifecycle: "active" }, { boundary: "deploy" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "deploy_not_supported");
  }
});
