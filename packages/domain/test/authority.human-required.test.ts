/**
 * Tests for human-approval determination (requiresApproval).
 *
 * See: packages/domain/src/authority/human-required.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBounds } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";

import { requiresApproval } from "../src/authority/human-required.ts";

// ---------------------------------------------------------------------------
// Base bounds — does NOT trigger humanRequired by default
// ---------------------------------------------------------------------------

const BASE_BOUNDS: ContractBounds = {
  paths: {
    allow: ["test/parser/**"],
    deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
  },
  capabilities: {
    bash: { allow: ["pnpm test*"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundary: "artifact",
  budget: { maxAttempts: 1, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
  review: "lead_inspection",
  changeClass: "editorial",
  models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
};

// ---------------------------------------------------------------------------
// Gate 1: path intersection — touching src/parser/public-api.ts
// HOST_TRIAL_AUTHORITY.humanRequired.paths = ["src/parser/public-api.ts"]
// ---------------------------------------------------------------------------

test("path intersection: src/parser/public-api.ts triggers humanRequired", () => {
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    paths: {
      allow: ["src/parser/public-api.ts"],
      deny: BASE_BOUNDS.paths.deny,
    },
  };
  const { required, reasons } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  assert.equal(required, true);
  assert.ok(reasons.length > 0, "Expected at least one reason");
  assert.ok(reasons.some((r) => r.includes("public-api.ts")));
});

test("path intersection: test/parser/** does not intersect src/parser/public-api.ts", () => {
  // test/parser/** and src/parser/public-api.ts share no common paths
  // (different top-level segment: test vs src)
  const bounds = BASE_BOUNDS;
  const { required } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  // test/parser/** does NOT intersect src/parser/public-api.ts (different root segment)
  assert.equal(required, false, "test/parser/** should not intersect src/parser/public-api.ts");
});

test("path intersection: src/parser/** triggers humanRequired (conservative overlap with public-api.ts)", () => {
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    paths: {
      allow: ["src/parser/**"],
      deny: BASE_BOUNDS.paths.deny,
    },
  };
  const { required } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  // src/parser/** ⊇ src/parser/public-api.ts, so it's conservative to require approval
  assert.equal(required, true);
});

// ---------------------------------------------------------------------------
// Gate 2: change class in humanRequired.changeClasses
// HOST_TRIAL_AUTHORITY.humanRequired.changeClasses = []
// ---------------------------------------------------------------------------

test("changeClass gate: empty changeClasses list — no trigger", () => {
  // HOST_TRIAL_AUTHORITY has empty changeClasses
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    changeClass: "behavior",
    review: "adversarial",
  };
  const { required } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  // Only the changeClass gate would trigger if "behavior" is in humanRequired.changeClasses
  // HOST_TRIAL_AUTHORITY.humanRequired.changeClasses is [], so no trigger from this gate
  assert.equal(required, false);
});

test("changeClass gate: shared_interface in humanRequired.changeClasses triggers approval", () => {
  const schema = {
    ...HOST_TRIAL_AUTHORITY,
    humanRequired: {
      ...HOST_TRIAL_AUTHORITY.humanRequired,
      changeClasses: ["shared_interface" as const],
    },
  };
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    changeClass: "shared_interface",
    review: "adversarial_distinct_model",
    paths: { allow: ["test/parser/**"], deny: BASE_BOUNDS.paths.deny },
  };
  const { required, reasons } = requiresApproval(schema, bounds);
  assert.equal(required, true);
  assert.ok(reasons.some((r) => r.includes("shared_interface")));
});

// ---------------------------------------------------------------------------
// Gate 3: boundary in humanRequired.boundaries
// HOST_TRIAL_AUTHORITY.humanRequired.boundaries = ["merge", "deploy"]
// ---------------------------------------------------------------------------

test("boundary gate: artifact boundary does not trigger humanRequired", () => {
  const bounds: ContractBounds = { ...BASE_BOUNDS, boundary: "artifact" };
  const { required } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  assert.equal(required, false);
});

test("boundary gate: merge boundary triggers humanRequired", () => {
  const bounds: ContractBounds = { ...BASE_BOUNDS, boundary: "merge" };
  const { required, reasons } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  assert.equal(required, true);
  assert.ok(reasons.some((r) => r.includes("merge")));
});

test("boundary gate: deploy boundary triggers humanRequired", () => {
  const bounds: ContractBounds = { ...BASE_BOUNDS, boundary: "deploy" };
  const { required, reasons } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  assert.equal(required, true);
  assert.ok(reasons.some((r) => r.includes("deploy")));
});

// ---------------------------------------------------------------------------
// Multiple gates: all reasons reported
// ---------------------------------------------------------------------------

test("multiple gates: both boundary and path intersection — multiple reasons", () => {
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    boundary: "merge",
    paths: {
      allow: ["src/parser/public-api.ts"],
      deny: BASE_BOUNDS.paths.deny,
    },
  };
  const { required, reasons } = requiresApproval(HOST_TRIAL_AUTHORITY, bounds);
  assert.equal(required, true);
  assert.ok(reasons.length >= 2, `Expected ≥2 reasons, got ${reasons.length}`);
});

// ---------------------------------------------------------------------------
// No humanRequired: nothing triggers
// ---------------------------------------------------------------------------

test("no gates fire: required=false, reasons=[]", () => {
  const { required, reasons } = requiresApproval(HOST_TRIAL_AUTHORITY, BASE_BOUNDS);
  assert.equal(required, false);
  assert.equal(reasons.length, 0);
});
