/**
 * Tests for runtime.ts additions in slice 4:
 *   - requiredBoundariesFor adds "integrate" for merge/deploy boundaries
 *   - checkBoundarySupport returns DEPLOY_NOT_SUPPORTED for deploy boundary
 *   - checkBoundarySupport returns null for artifact and merge boundaries
 *
 * See: packages/domain/src/authority/runtime.ts
 * See: docs/REQUIREMENTS.md R-015, R-016
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBounds } from "@agencyhq/contracts";
import { HOST_PROFILE, HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";

import {
  checkBoundarySupport,
  enforceable,
  requiredBoundariesFor,
} from "../src/authority/runtime.ts";

// ---------------------------------------------------------------------------
// Base bounds derived from HOST_TRIAL_AUTHORITY
// ---------------------------------------------------------------------------

const BASE_BOUNDS_ARTIFACT: ContractBounds = {
  paths: {
    allow: ["src/**"],
    deny: [".github/**", "package.json"],
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
  budget: {
    maxAttempts: HOST_TRIAL_AUTHORITY.budget.maxAttempts,
    maxDurationSeconds: HOST_TRIAL_AUTHORITY.budget.maxDurationSeconds,
    estimatedSpendUsd: HOST_TRIAL_AUTHORITY.budget.estimatedSpendUsd,
  },
  review: "lead_inspection",
  changeClass: "editorial",
  models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
};

const BASE_BOUNDS_MERGE: ContractBounds = { ...BASE_BOUNDS_ARTIFACT, boundary: "merge" };
const BASE_BOUNDS_DEPLOY: ContractBounds = { ...BASE_BOUNDS_ARTIFACT, boundary: "deploy" };

// ---------------------------------------------------------------------------
// requiredBoundariesFor: integrate boundary
// ---------------------------------------------------------------------------

test("requiredBoundariesFor: artifact boundary does NOT require integrate", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS_ARTIFACT);
  assert.ok(
    !required.includes("integrate"),
    "integrate should not be required for artifact boundary",
  );
});

test("requiredBoundariesFor: merge boundary requires integrate", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS_MERGE);
  assert.ok(required.includes("integrate"), "integrate must be required for merge boundary");
});

test("requiredBoundariesFor: deploy boundary requires integrate", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS_DEPLOY);
  assert.ok(required.includes("integrate"), "integrate must be required for deploy boundary");
});

test("requiredBoundariesFor: merge boundary still has all always-required boundaries", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS_MERGE);
  const always = [
    "worktree",
    "output_paths",
    "push",
    "termination",
    "capability",
    "duration",
  ] as const;
  for (const b of always) {
    assert.ok(required.includes(b), `Expected ${b} to be in required list for merge boundary`);
  }
});

test("requiredBoundariesFor: HOST_PROFILE enforces integrate (before_action), so merge passes enforceable", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS_MERGE);
  assert.ok(required.includes("integrate"));
  // HOST_PROFILE has integrate: before_action (not advisory)
  const result = enforceable(HOST_PROFILE, required);
  assert.equal(result.ok, true, "HOST_PROFILE can enforce integrate for merge boundary");
});

// ---------------------------------------------------------------------------
// checkBoundarySupport
// ---------------------------------------------------------------------------

test("checkBoundarySupport: artifact boundary returns null (supported)", () => {
  const result = checkBoundarySupport(BASE_BOUNDS_ARTIFACT);
  assert.equal(result, null);
});

test("checkBoundarySupport: merge boundary returns null (supported)", () => {
  const result = checkBoundarySupport(BASE_BOUNDS_MERGE);
  assert.equal(result, null);
});

test("checkBoundarySupport: deploy boundary returns DEPLOY_NOT_SUPPORTED", () => {
  const result = checkBoundarySupport(BASE_BOUNDS_DEPLOY);
  assert.notEqual(result, null);
  assert.equal(result?.code, "DEPLOY_NOT_SUPPORTED");
});

test("checkBoundarySupport: deploy violation has a non-empty reason", () => {
  const result = checkBoundarySupport(BASE_BOUNDS_DEPLOY);
  assert.ok(
    typeof result?.reason === "string" && result.reason.length > 0,
    "DEPLOY_NOT_SUPPORTED must have a non-empty reason",
  );
});
