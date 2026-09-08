/**
 * Table tests for authority update proposal and frozen-contract invariant.
 *
 * Covers:
 *   - proposeAuthorityUpdate: valid authority with greater version → Ok
 *   - proposeAuthorityUpdate: same or lower version → Err version_not_greater
 *   - proposeAuthorityUpdate: invalid schema → Err parse_error
 *   - frozenContractsUnaffected: always returns true; contract bounds unchanged
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Authority } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";

import type { StepContract } from "../src/aggregates/step-contract.ts";
import { freezeContract } from "../src/aggregates/step-contract.ts";
import { frozenContractsUnaffected, proposeAuthorityUpdate } from "../src/authority/update.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_AUTHORITY: Authority = {
  ...HOST_TRIAL_AUTHORITY,
  version: "1",
};

function makeAuthority(version: string, overrides: Partial<Authority> = {}): Authority {
  return { ...BASE_AUTHORITY, ...overrides, version };
}

const currentState = { version: "1", authority: BASE_AUTHORITY };

// ---------------------------------------------------------------------------
// proposeAuthorityUpdate — valid updates
// ---------------------------------------------------------------------------

test("proposeAuthorityUpdate: version 2 > 1 → Ok", () => {
  const next = makeAuthority("2");
  const result = proposeAuthorityUpdate(currentState, next);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.version, "2");
    assert.deepEqual(result.value.authority, next);
  }
});

test("proposeAuthorityUpdate: version 10 > 1 → Ok (large jump)", () => {
  const next = makeAuthority("10");
  const result = proposeAuthorityUpdate(currentState, next);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.version, "10");
  }
});

test("proposeAuthorityUpdate: v-prefixed version parsed correctly", () => {
  const current = { version: "2", authority: makeAuthority("2") };
  const next = makeAuthority("v3");
  const result = proposeAuthorityUpdate(current, next);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.version, "v3");
  }
});

test("proposeAuthorityUpdate: version in next authority returned as version field", () => {
  const next = makeAuthority("5");
  const result = proposeAuthorityUpdate(currentState, next);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.version, next.version);
  }
});

// ---------------------------------------------------------------------------
// proposeAuthorityUpdate — version not greater
// ---------------------------------------------------------------------------

test("proposeAuthorityUpdate: same version → Err version_not_greater", () => {
  const next = makeAuthority("1");
  const result = proposeAuthorityUpdate(currentState, next);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "version_not_greater");
  }
});

test("proposeAuthorityUpdate: lower version → Err version_not_greater", () => {
  const current = { version: "5", authority: makeAuthority("5") };
  const next = makeAuthority("3");
  const result = proposeAuthorityUpdate(current, next);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "version_not_greater");
  }
});

test("proposeAuthorityUpdate: version 0 when current is 1 → Err version_not_greater", () => {
  const next = makeAuthority("0");
  const result = proposeAuthorityUpdate(currentState, next);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "version_not_greater");
  }
});

// ---------------------------------------------------------------------------
// proposeAuthorityUpdate — parse errors
// ---------------------------------------------------------------------------

test("proposeAuthorityUpdate: null → Err parse_error", () => {
  const result = proposeAuthorityUpdate(currentState, null);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "parse_error");
    assert.ok(Array.isArray((result.error as { kind: string; issues: unknown[] }).issues));
    assert.ok((result.error as { kind: string; issues: unknown[] }).issues.length > 0);
  }
});

test("proposeAuthorityUpdate: missing required fields → Err parse_error", () => {
  const result = proposeAuthorityUpdate(currentState, { version: "2" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "parse_error");
  }
});

test("proposeAuthorityUpdate: wrong type for budget.maxAttempts → Err parse_error", () => {
  const invalid = makeAuthority("2");
  const result = proposeAuthorityUpdate(currentState, {
    ...invalid,
    budget: { ...invalid.budget, maxAttempts: "not-a-number" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "parse_error");
  }
});

test("proposeAuthorityUpdate: empty string version in next → Err parse_error", () => {
  const result = proposeAuthorityUpdate(currentState, makeAuthority("" as string));
  assert.equal(result.ok, false);
  // Zod rejects empty version string (z.string().min(1))
  if (!result.ok) {
    assert.equal(result.error.kind, "parse_error");
  }
});

// ---------------------------------------------------------------------------
// frozenContractsUnaffected — always true; contract bounds unchanged
// ---------------------------------------------------------------------------

/**
 * Build a minimal StepContract using freezeContract so bounds are realistic.
 */
function makeContract(): StepContract {
  return freezeContract({
    id: "sc-1" as import("../src/ids.ts").StepContractId,
    proposal: {
      criteria: [{ id: "c1", text: "criterion", source: "operator", citation: "req-1" }],
      profileId: "p1",
      changeClass: "editorial",
      review: "lead_inspection",
      boundary: "artifact",
      paths: {
        allow: ["src/**"],
        deny: [".github/**"],
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
      budget: { maxAttempts: 1, maxDurationSeconds: 600, estimatedSpendUsd: 2 },
      models: { worker: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol" },
      rationale: "test",
      sources: [{ criterionId: "c1", source: "operator", citation: "req-1" }],
    },
    decisionId: "dec-1" as import("../src/ids.ts").DecisionId,
    workItem: {
      id: "wi-1" as import("../src/ids.ts").WorkItemId,
      projectId: "proj-1" as import("../src/ids.ts").ProjectId,
      intent: "Fix the bug",
    },
    project: { id: "proj-1" as import("../src/ids.ts").ProjectId },
    baseRevision: "abc123",
    profileDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as import("@agencyhq/contracts").Digest,
    criteriaDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as import("@agencyhq/contracts").Digest,
    requiredBoundaries: [],
    humanRequired: false,
    version: 1,
  });
}

test("frozenContractsUnaffected: always returns true", () => {
  const contract = makeContract();
  const newAuthority = makeAuthority("2");
  const result = frozenContractsUnaffected(contract, newAuthority);
  assert.equal(result, true);
});

test("frozenContractsUnaffected: contract bounds deep-equal before and after update", () => {
  const contract = makeContract();
  const boundsBeforeUpdate = JSON.parse(JSON.stringify(contract.bounds));

  // Simulate applying an authority update — the contract is not touched.
  const next = makeAuthority("2");
  proposeAuthorityUpdate(currentState, next);

  // Contract bounds must be identical.
  assert.deepEqual(contract.bounds, boundsBeforeUpdate);
});

test("frozenContractsUnaffected: contract digests unchanged after authority update", () => {
  const contract = makeContract();
  const criteriaDigestBefore = contract.criteriaDigest;
  const profileDigestBefore = contract.profileDigest;

  proposeAuthorityUpdate(currentState, makeAuthority("2"));

  assert.equal(contract.criteriaDigest, criteriaDigestBefore);
  assert.equal(contract.profileDigest, profileDigestBefore);
});

test("frozenContractsUnaffected: works with any authority (not just updated one)", () => {
  const contract = makeContract();
  const sameVersionAuthority = makeAuthority("1");
  assert.equal(frozenContractsUnaffected(contract, sameVersionAuthority), true);
});
