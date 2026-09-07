/**
 * Tests for runtime enforceability checks.
 *
 * See: packages/domain/src/authority/runtime.ts
 * See: docs/engineering/ARCHITECTURE.md lines 105-127
 * See: docs/REQUIREMENTS.md R-016
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ContractBounds } from "@agencyhq/contracts";
import { HOST_PROFILE, HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";

import { enforceable, requiredBoundariesFor } from "../src/authority/runtime.ts";

// ---------------------------------------------------------------------------
// Base bounds derived from HOST_TRIAL_AUTHORITY (no external network)
// ---------------------------------------------------------------------------

const BASE_BOUNDS: ContractBounds = {
  paths: {
    allow: ["src/parser/**"],
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
  budget: {
    maxAttempts: HOST_TRIAL_AUTHORITY.budget.maxAttempts,
    maxDurationSeconds: HOST_TRIAL_AUTHORITY.budget.maxDurationSeconds,
    estimatedSpendUsd: HOST_TRIAL_AUTHORITY.budget.estimatedSpendUsd,
  },
  review: "lead_inspection",
  changeClass: "editorial",
  models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
};

// ---------------------------------------------------------------------------
// requiredBoundariesFor
// ---------------------------------------------------------------------------

test("requiredBoundariesFor: always-required boundaries are present", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS);
  const always = [
    "worktree",
    "output_paths",
    "push",
    "termination",
    "capability",
    "duration",
  ] as const;
  for (const b of always) {
    assert.ok(required.includes(b), `Expected ${b} to be required`);
  }
});

test("requiredBoundariesFor: no external network — fs_isolation not required", () => {
  const required = requiredBoundariesFor(BASE_BOUNDS);
  assert.ok(
    !required.includes("fs_isolation"),
    "fs_isolation should not be required without external network",
  );
});

test("requiredBoundariesFor: webfetch enabled — fs_isolation required", () => {
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    capabilities: {
      ...BASE_BOUNDS.capabilities,
      tools: { ...BASE_BOUNDS.capabilities.tools, webfetch: true },
    },
  };
  const required = requiredBoundariesFor(bounds);
  assert.ok(
    required.includes("fs_isolation"),
    "fs_isolation must be required when webfetch is enabled",
  );
  assert.ok(
    required.includes("egress_spend"),
    "egress_spend must be required when webfetch is enabled",
  );
});

test("requiredBoundariesFor: websearch enabled — fs_isolation required", () => {
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    capabilities: {
      ...BASE_BOUNDS.capabilities,
      tools: { ...BASE_BOUNDS.capabilities.tools, websearch: true },
    },
  };
  const required = requiredBoundariesFor(bounds);
  assert.ok(
    required.includes("fs_isolation"),
    "fs_isolation must be required when websearch is enabled",
  );
  assert.ok(
    required.includes("egress_spend"),
    "egress_spend must be required when websearch is enabled",
  );
});

test("requiredBoundariesFor: spend ceiling > 0 without external network — egress_spend NOT required (advisory on host)", () => {
  const bounds: ContractBounds = {
    ...BASE_BOUNDS,
    budget: { ...BASE_BOUNDS.budget, estimatedSpendUsd: 5 },
  };
  const required = requiredBoundariesFor(bounds);
  assert.ok(
    !required.includes("egress_spend"),
    "a spend estimate alone must not require egress enforcement (host profile is advisory)",
  );
});

// ---------------------------------------------------------------------------
// R-016: HOST_PROFILE rejects contracts requiring fs_isolation
// HOST_PROFILE has fs_isolation: advisory
// ---------------------------------------------------------------------------

test("R-016: HOST_PROFILE rejects contract requiring fs_isolation", () => {
  const result = enforceable(HOST_PROFILE, ["fs_isolation"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.advisory.includes("fs_isolation"), "fs_isolation must be in advisory list");
  }
});

test("R-016: HOST_PROFILE rejects contract requiring egress_spend", () => {
  const result = enforceable(HOST_PROFILE, ["egress_spend"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.advisory.includes("egress_spend"));
  }
});

test("R-016: HOST_PROFILE accepts the trial bounds (no external network, spend estimate 5)", () => {
  // HOST_TRIAL_AUTHORITY has webfetch:false, websearch:false, estimatedSpendUsd:5.
  // A spend estimate is advisory on the host profile and must not be treated
  // as a required boundary, otherwise every host-profile dispatch would be
  // rejected under R-016.
  const required = requiredBoundariesFor(BASE_BOUNDS);
  assert.ok(!required.includes("fs_isolation"), "fs_isolation not required");
  assert.ok(!required.includes("egress_spend"), "egress_spend not required without network");
  const result = enforceable(HOST_PROFILE, required);
  assert.equal(result.ok, true, "HOST_PROFILE accepts the trial bounds");
});

test("R-016: enforceable returns advisory list for unenforced boundaries", () => {
  const result = enforceable(HOST_PROFILE, ["fs_isolation", "egress_spend", "worktree"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.advisory.includes("fs_isolation"));
    assert.ok(result.advisory.includes("egress_spend"));
    assert.ok(!result.advisory.includes("worktree"), "worktree is enforced (before_action)");
  }
});

// ---------------------------------------------------------------------------
// enforceable: always-required boundaries pass on HOST_PROFILE
// ---------------------------------------------------------------------------

test("always-required boundaries are all enforced by HOST_PROFILE", () => {
  const always = [
    "worktree",
    "output_paths",
    "push",
    "termination",
    "capability",
    "duration",
  ] as const;
  const result = enforceable(HOST_PROFILE, [...always]);
  assert.equal(result.ok, true, "All always-required boundaries should pass on HOST_PROFILE");
});

// ---------------------------------------------------------------------------
// Full dispatch simulation: trial bounds on HOST_PROFILE
// (spend estimate is advisory on the host profile → accepted; a contract that
// enables webfetch → egress_spend and fs_isolation required → rejected)
// ---------------------------------------------------------------------------

test("dispatch simulation: trial bounds with spend estimate accepted by HOST_PROFILE", () => {
  const trialBounds: ContractBounds = {
    ...BASE_BOUNDS,
    budget: { maxAttempts: 2, maxDurationSeconds: 1200, estimatedSpendUsd: 5 },
  };
  const required = requiredBoundariesFor(trialBounds);
  assert.ok(!required.includes("egress_spend"));
  assert.equal(enforceable(HOST_PROFILE, required).ok, true);
});

test("dispatch simulation: webfetch-enabled bounds rejected by HOST_PROFILE (R-016)", () => {
  const netBounds: ContractBounds = {
    ...BASE_BOUNDS,
    capabilities: {
      ...BASE_BOUNDS.capabilities,
      tools: { ...BASE_BOUNDS.capabilities.tools, webfetch: true },
    },
  };
  const required = requiredBoundariesFor(netBounds);
  assert.ok(required.includes("egress_spend"));
  assert.ok(required.includes("fs_isolation"));
  const result = enforceable(HOST_PROFILE, required);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.advisory.includes("egress_spend"));
    assert.ok(result.advisory.includes("fs_isolation"));
  }
});
