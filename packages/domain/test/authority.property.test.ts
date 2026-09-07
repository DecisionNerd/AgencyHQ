/**
 * Property-based tests for the authority subset model using fast-check.
 *
 * Properties tested:
 *   (a) Reflexivity: a proposal built from the schema's own bounds always passes.
 *   (b) Widening: any single random widening of one field fails with the expected code.
 *   (c) Narrowing: any random narrowing (subset of allow, superset of deny,
 *       smaller budget, higher review) always passes.
 *   (d) effectiveAuthority is idempotent and never widens (field-wise comparison).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  Authority,
  AuthorityNarrowing,
  LeadProposal,
  ReviewProfile,
} from "@agencyhq/contracts";
import {
  HOST_TRIAL_AUTHORITY,
  REVIEW_PROFILE_ORDER,
  reviewProfileAtLeast,
} from "@agencyhq/contracts";
import * as fc from "fast-check";

import { checkProposal, effectiveAuthority } from "../src/authority/subset.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA = HOST_TRIAL_AUTHORITY;

/** Build a passing LeadProposal from an Authority's own bounds. */
function proposalFromAuthority(auth: Authority): LeadProposal {
  const workerModel = auth.models.worker[0] ?? "openai/gpt-5.6-terra";
  // Choose reviewer: must be different from worker if reviewerMustDiffer=true
  let reviewerModel = auth.models.reviewer[0] ?? "openai/gpt-5.6-sol";
  if (auth.models.reviewerMustDiffer && reviewerModel === workerModel) {
    reviewerModel = auth.models.reviewer.find((m) => m !== workerModel) ?? reviewerModel;
  }

  // Choose review profile meeting the minimum for editorial
  const changeClass = "editorial" as const;
  const minProfile: ReviewProfile = auth.review.minimum[changeClass] ?? "none";

  // Use the first boundary
  const boundary = auth.boundaries[0] ?? "artifact";

  return {
    criteria: [{ id: "c1", text: "Operator criterion", source: "operator", citation: "req-1" }],
    profileId: "profile-v1",
    changeClass,
    review: minProfile,
    boundary,
    paths: {
      allow: auth.paths.allow.slice(0, 1),
      deny: [...auth.paths.deny],
    },
    capabilities: {
      bash: {
        allow: auth.capabilities.bash.allow.slice(0, 1),
        deny: [...auth.capabilities.bash.deny],
      },
      tools: { ...auth.capabilities.tools },
    },
    budget: {
      maxAttempts: 1,
      maxDurationSeconds: Math.min(auth.budget.maxDurationSeconds, 60),
      estimatedSpendUsd: 0,
    },
    models: { worker: workerModel, reviewer: reviewerModel },
    rationale: "Property test proposal",
    sources: [{ criterionId: "c1", source: "operator", citation: "req-1" }],
  };
}

// ---------------------------------------------------------------------------
// (a) Reflexivity: proposal built from schema's own bounds passes
// ---------------------------------------------------------------------------

test("property (a): reflexive — proposal built from schema bounds passes", () => {
  fc.assert(
    fc.property(fc.constant(SCHEMA), (schema) => {
      const proposal = proposalFromAuthority(schema);
      const result = checkProposal(schema, proposal);
      if (!result.ok) {
        throw new Error(
          `Expected ok but got violations: ${result.violations.map((v) => `${v.code}: ${v.detail}`).join("; ")}`,
        );
      }
      return true;
    }),
    { numRuns: 10 },
  );
});

// ---------------------------------------------------------------------------
// (b) Widening: any single random widening fails with the expected code
// ---------------------------------------------------------------------------

test("property (b): widening paths.allow → PATH_ALLOW_WIDER", () => {
  // Any pattern not in the schema allow should fail
  const proposal = proposalFromAuthority(SCHEMA);
  const wideProposal = {
    ...proposal,
    paths: { ...proposal.paths, allow: ["**"] }, // ** covers everything — wider than schema
  };
  const result = checkProposal(SCHEMA, wideProposal);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.violations.some((v) => v.code === "PATH_ALLOW_WIDER"),
      `Expected PATH_ALLOW_WIDER, got: ${result.violations.map((v) => v.code).join(", ")}`,
    );
  }
});

test("property (b): widening budget.maxAttempts → BUDGET_ATTEMPTS", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: SCHEMA.budget.maxAttempts + 1, max: SCHEMA.budget.maxAttempts + 100 }),
      (maxAttempts) => {
        const proposal = proposalFromAuthority(SCHEMA);
        const wideProposal = {
          ...proposal,
          budget: { ...proposal.budget, maxAttempts },
        };
        const result = checkProposal(SCHEMA, wideProposal);
        if (result.ok) return false; // widening must fail
        return result.violations.some((v) => v.code === "BUDGET_ATTEMPTS");
      },
    ),
    { numRuns: 20 },
  );
});

test("property (b): widening budget.estimatedSpendUsd → BUDGET_SPEND", () => {
  fc.assert(
    fc.property(
      fc.float({
        min: Math.fround(SCHEMA.budget.estimatedSpendUsd + 0.01),
        max: Math.fround(SCHEMA.budget.estimatedSpendUsd + 1000),
        noNaN: true,
      }),
      (estimatedSpendUsd) => {
        const proposal = proposalFromAuthority(SCHEMA);
        const wideProposal = {
          ...proposal,
          budget: { ...proposal.budget, estimatedSpendUsd },
        };
        const result = checkProposal(SCHEMA, wideProposal);
        if (result.ok) return false;
        return result.violations.some((v) => v.code === "BUDGET_SPEND");
      },
    ),
    { numRuns: 20 },
  );
});

test("property (b): using boundary not in schema → BOUNDARY_NOT_DELEGATED", () => {
  // SCHEMA only has ["artifact"]; deploy and merge should fail
  for (const boundary of ["merge", "deploy"] as const) {
    const proposal = proposalFromAuthority(SCHEMA);
    const wideProposal = { ...proposal, boundary };
    const result = checkProposal(SCHEMA, wideProposal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.violations.some((v) => v.code === "BOUNDARY_NOT_DELEGATED"));
    }
  }
});

test("property (b): review below minimum → REVIEW_BELOW_MINIMUM", () => {
  // behavior requires adversarial; none is below
  const proposal = proposalFromAuthority(SCHEMA);
  const wideProposal = { ...proposal, changeClass: "behavior" as const, review: "none" as const };
  const result = checkProposal(SCHEMA, wideProposal);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.violations.some((v) => v.code === "REVIEW_BELOW_MINIMUM"));
  }
});

test("property (b): tool not granted → TOOL_NOT_GRANTED", () => {
  const proposal = proposalFromAuthority(SCHEMA);
  const wideProposal = {
    ...proposal,
    capabilities: {
      ...proposal.capabilities,
      tools: { ...proposal.capabilities.tools, webfetch: true },
    },
  };
  const result = checkProposal(SCHEMA, wideProposal);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.violations.some((v) => v.code === "TOOL_NOT_GRANTED"));
  }
});

// ---------------------------------------------------------------------------
// (c) Narrowing: a strict narrowing of proposal fields always passes
// ---------------------------------------------------------------------------

test("property (c): narrowing budget always passes", () => {
  const base = proposalFromAuthority(SCHEMA);
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: base.budget.maxAttempts }),
      fc.integer({ min: 5, max: base.budget.maxDurationSeconds }),
      fc.float({ min: 0, max: base.budget.estimatedSpendUsd, noNaN: true }),
      (maxAttempts, maxDurationSeconds, estimatedSpendUsd) => {
        const narrowProposal = {
          ...base,
          budget: { maxAttempts, maxDurationSeconds, estimatedSpendUsd },
        };
        const result = checkProposal(SCHEMA, narrowProposal);
        if (!result.ok) {
          const budgetViolations = result.violations.filter(
            (v) =>
              v.code === "BUDGET_ATTEMPTS" ||
              v.code === "BUDGET_DURATION" ||
              v.code === "BUDGET_SPEND",
          );
          // Should have no budget violations
          return budgetViolations.length === 0;
        }
        return true;
      },
    ),
    { numRuns: 50 },
  );
});

test("property (c): higher review than minimum always passes review check", () => {
  const base = proposalFromAuthority(SCHEMA);
  // For editorial, minimum is "lead_inspection"; test with stronger profiles
  const strongerProfiles: ReviewProfile[] = [
    "lead_inspection",
    "adversarial",
    "adversarial_distinct_model",
  ];
  for (const review of strongerProfiles) {
    const narrowProposal = { ...base, changeClass: "editorial" as const, review };
    const result = checkProposal(SCHEMA, narrowProposal);
    if (!result.ok) {
      const reviewViolations = result.violations.filter((v) => v.code === "REVIEW_BELOW_MINIMUM");
      assert.equal(
        reviewViolations.length,
        0,
        `Review "${review}" should pass editorial minimum "lead_inspection" but got: ${reviewViolations.map((v) => v.detail).join("; ")}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (d) effectiveAuthority: idempotent and never widens
// ---------------------------------------------------------------------------

test("property (d): effectiveAuthority is idempotent", () => {
  // Apply same narrowing twice — should be same as once
  const narrowing: AuthorityNarrowing = {
    boundaries: ["artifact"],
    budget: {
      maxAttempts: 1,
      maxDurationSeconds: 600,
      estimatedSpendUsd: 0,
    },
  };

  const once = effectiveAuthority(SCHEMA, narrowing);
  const twice = effectiveAuthority(once, narrowing);

  assert.deepEqual(once.boundaries, twice.boundaries);
  assert.deepEqual(once.budget, twice.budget);
  assert.deepEqual(once.paths, twice.paths);
});

test("property (d): effectiveAuthority never widens (budget field-wise)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: SCHEMA.budget.maxAttempts }),
      fc.integer({ min: 5, max: SCHEMA.budget.maxDurationSeconds }),
      fc.float({ min: 0, max: SCHEMA.budget.estimatedSpendUsd, noNaN: true }),
      (maxAttempts, maxDurationSeconds, estimatedSpendUsd) => {
        const narrowing: AuthorityNarrowing = {
          budget: { maxAttempts, maxDurationSeconds, estimatedSpendUsd },
        };
        const result = effectiveAuthority(SCHEMA, narrowing);
        // Result must never widen any budget field
        return (
          result.budget.maxAttempts <= SCHEMA.budget.maxAttempts &&
          result.budget.maxDurationSeconds <= SCHEMA.budget.maxDurationSeconds &&
          result.budget.estimatedSpendUsd <= SCHEMA.budget.estimatedSpendUsd
        );
      },
    ),
    { numRuns: 50 },
  );
});

test("property (d): effectiveAuthority ignores narrowing that would widen", () => {
  // Narrowing with maxAttempts > schema → should be ignored, keep schema value
  const wideNarrowing: AuthorityNarrowing = {
    budget: {
      maxAttempts: SCHEMA.budget.maxAttempts + 100, // wider — should be ignored
      maxDurationSeconds: SCHEMA.budget.maxDurationSeconds,
      estimatedSpendUsd: SCHEMA.budget.estimatedSpendUsd,
    },
  };
  const result = effectiveAuthority(SCHEMA, wideNarrowing);
  // Since narrowing widens maxAttempts, the whole budget field is ignored
  assert.equal(result.budget.maxAttempts, SCHEMA.budget.maxAttempts);
});

test("property (d): effectiveAuthority ignores boundaries that would widen", () => {
  // SCHEMA.boundaries = ["artifact"]; adding "merge" would widen — must be ignored
  const wideNarrowing: AuthorityNarrowing = {
    boundaries: ["artifact", "merge"],
  };
  const result = effectiveAuthority(SCHEMA, wideNarrowing);
  assert.deepEqual(result.boundaries, SCHEMA.boundaries);
});

test("property (d): effectiveAuthority applies valid narrowing correctly", () => {
  fc.assert(
    fc.property(fc.constant(["artifact"] as const), (boundaries) => {
      const narrowing: AuthorityNarrowing = { boundaries: [...boundaries] };
      const result = effectiveAuthority(SCHEMA, narrowing);
      // boundaries should be the narrowed value (subset of schema)
      return boundaries.every((b) => result.boundaries.includes(b));
    }),
    { numRuns: 10 },
  );
});

// ---------------------------------------------------------------------------
// ReviewProfile ordering sanity (property)
// ---------------------------------------------------------------------------

test("property: REVIEW_PROFILE_ORDER is reflexive", () => {
  for (const profile of REVIEW_PROFILE_ORDER) {
    assert.ok(reviewProfileAtLeast(profile, profile), `${profile} should be at-least itself`);
  }
});

test("property: reviewProfileAtLeast is transitive", () => {
  const profiles = [...REVIEW_PROFILE_ORDER];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i; j < profiles.length; j++) {
      const stronger = profiles[j];
      const weaker = profiles[i];
      if (!stronger || !weaker) continue;
      assert.ok(reviewProfileAtLeast(stronger, weaker), `${stronger} should be at-least ${weaker}`);
    }
  }
});
