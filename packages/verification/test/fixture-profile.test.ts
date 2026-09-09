/**
 * Tests for the `fixture-node-v1` verification profile.
 *
 * Coverage:
 * - Catalog membership (profile exists and resolves)
 * - Digest stability (same digest every call)
 * - Key-order independence (digest uses canonicalJson)
 * - Checks match node-pnpm-v2 (same toolchain gates)
 * - protectedPaths match DEFAULT_PROTECTED_PATHS
 * - Digest differs from node-pnpm-v2 (distinct id → distinct digest)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROTECTED_PATHS } from "@agencyhq/domain";

import { PROFILE_CATALOG, profileDigest, resolveProfile } from "../src/index.ts";

// ---------------------------------------------------------------------------
// fixture-node-v1 catalog membership
// ---------------------------------------------------------------------------

test("fixture-node-v1: is present in PROFILE_CATALOG", () => {
  assert.ok(
    PROFILE_CATALOG["fixture-node-v1"] !== undefined,
    "fixture-node-v1 must exist in PROFILE_CATALOG",
  );
});

test("fixture-node-v1: resolves via resolveProfile without throwing", () => {
  const profile = resolveProfile("fixture-node-v1");
  assert.equal(profile.id, "fixture-node-v1");
});

// ---------------------------------------------------------------------------
// fixture-node-v1 shape
// ---------------------------------------------------------------------------

test("fixture-node-v1: has the correct checks (pnpm-install@1, pnpm-typecheck@1, pnpm-test@1)", () => {
  const profile = resolveProfile("fixture-node-v1");
  assert.deepEqual(profile.checks, ["pnpm-install@1", "pnpm-typecheck@1", "pnpm-test@1"]);
});

test("fixture-node-v1: protectedPaths equals DEFAULT_PROTECTED_PATHS", () => {
  const profile = resolveProfile("fixture-node-v1");
  assert.deepEqual(profile.protectedPaths, DEFAULT_PROTECTED_PATHS);
});

test("fixture-node-v1: version is a non-empty string", () => {
  const profile = resolveProfile("fixture-node-v1");
  assert.ok(typeof profile.version === "string" && profile.version.length > 0);
});

// ---------------------------------------------------------------------------
// fixture-node-v1 digest stability
// ---------------------------------------------------------------------------

test("fixture-node-v1: profileDigest is stable across two calls", () => {
  const profile = resolveProfile("fixture-node-v1");
  const d1 = profileDigest(profile);
  const d2 = profileDigest(profile);
  assert.equal(d1, d2, "digest must be stable across calls");
});

test("fixture-node-v1: profileDigest is independent of property insertion order", () => {
  // Build two logically identical profile objects with different key construction order.
  const profile = resolveProfile("fixture-node-v1");

  // Forward key order.
  const p1 = {
    id: profile.id,
    version: profile.version,
    checks: [...profile.checks],
    protectedPaths: [...profile.protectedPaths],
  };

  // Reverse key order — digestOf must sort keys canonically.
  const p2 = {
    protectedPaths: [...profile.protectedPaths],
    checks: [...profile.checks],
    version: profile.version,
    id: profile.id,
  };

  assert.equal(
    profileDigest(p1),
    profileDigest(p2),
    "digest must be independent of key insertion order",
  );
});

// ---------------------------------------------------------------------------
// fixture-node-v1 digest distinctness
// ---------------------------------------------------------------------------

test("fixture-node-v1: profileDigest differs from node-pnpm-v2 (same checks, different id)", () => {
  const fixtureProfile = resolveProfile("fixture-node-v1");
  const v2Profile = PROFILE_CATALOG["node-pnpm-v2"];
  assert.ok(v2Profile, "node-pnpm-v2 must exist");

  // Both have the same checks list but different ids, so their digests must differ.
  assert.notEqual(
    profileDigest(fixtureProfile),
    profileDigest(v2Profile),
    "fixture-node-v1 and node-pnpm-v2 must have distinct digests (different id field)",
  );
});

test("fixture-node-v1: same checks as node-pnpm-v2 (fixture exercises same toolchain gates)", () => {
  const fixtureProfile = resolveProfile("fixture-node-v1");
  const v2Profile = PROFILE_CATALOG["node-pnpm-v2"];
  assert.ok(v2Profile, "node-pnpm-v2 must exist");
  assert.deepEqual(
    fixtureProfile.checks,
    v2Profile.checks,
    "fixture-node-v1 and node-pnpm-v2 must have the same checks",
  );
});
