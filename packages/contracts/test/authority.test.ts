import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorityNarrowingSchema,
  AuthoritySchema,
  DigestSchema,
  HOST_TRIAL_AUTHORITY,
  REVIEW_PROFILE_ORDER,
  reviewProfileAtLeast,
} from "../src/authority.ts";

// ---------------------------------------------------------------------------
// ReviewProfile ordering
// ---------------------------------------------------------------------------
test("REVIEW_PROFILE_ORDER has exactly 4 entries in least-to-most order", () => {
  assert.deepEqual(REVIEW_PROFILE_ORDER, [
    "none",
    "lead_inspection",
    "adversarial",
    "adversarial_distinct_model",
  ]);
});

test("reviewProfileAtLeast: identity comparisons are always true", () => {
  assert.equal(reviewProfileAtLeast("none", "none"), true);
  assert.equal(reviewProfileAtLeast("lead_inspection", "lead_inspection"), true);
  assert.equal(reviewProfileAtLeast("adversarial", "adversarial"), true);
  assert.equal(
    reviewProfileAtLeast("adversarial_distinct_model", "adversarial_distinct_model"),
    true,
  );
});

test("reviewProfileAtLeast: stronger profiles satisfy weaker requirements", () => {
  assert.equal(reviewProfileAtLeast("adversarial_distinct_model", "none"), true);
  assert.equal(reviewProfileAtLeast("adversarial_distinct_model", "lead_inspection"), true);
  assert.equal(reviewProfileAtLeast("adversarial_distinct_model", "adversarial"), true);
  assert.equal(reviewProfileAtLeast("adversarial", "none"), true);
  assert.equal(reviewProfileAtLeast("adversarial", "lead_inspection"), true);
  assert.equal(reviewProfileAtLeast("lead_inspection", "none"), true);
});

test("reviewProfileAtLeast: weaker profiles do NOT satisfy stronger requirements", () => {
  assert.equal(reviewProfileAtLeast("none", "lead_inspection"), false);
  assert.equal(reviewProfileAtLeast("none", "adversarial"), false);
  assert.equal(reviewProfileAtLeast("none", "adversarial_distinct_model"), false);
  assert.equal(reviewProfileAtLeast("lead_inspection", "adversarial"), false);
  assert.equal(reviewProfileAtLeast("lead_inspection", "adversarial_distinct_model"), false);
  assert.equal(reviewProfileAtLeast("adversarial", "adversarial_distinct_model"), false);
});

// ---------------------------------------------------------------------------
// DigestSchema
// ---------------------------------------------------------------------------
test("DigestSchema: accepts valid sha256 digest", () => {
  const valid = `sha256:${"a".repeat(64)}`;
  assert.equal(DigestSchema.parse(valid), valid);
});

test("DigestSchema: rejects digest with wrong prefix", () => {
  assert.throws(() => DigestSchema.parse(`md5:${"a".repeat(64)}`));
});

test("DigestSchema: rejects digest with wrong length", () => {
  assert.throws(() => DigestSchema.parse(`sha256:${"a".repeat(63)}`));
});

// ---------------------------------------------------------------------------
// AuthoritySchema valid parse
// ---------------------------------------------------------------------------
const validAuthority = {
  version: "1",
  paths: { allow: ["src/**"], deny: [".github/**"] },
  capabilities: {
    bash: { allow: ["pnpm test"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundaries: ["artifact"],
  budget: { maxAttempts: 1, maxDurationSeconds: 60, estimatedSpendUsd: 0 },
  review: {
    minimum: {
      editorial: "none",
      behavior: "adversarial",
      shared_interface: "adversarial_distinct_model",
    },
  },
  models: {
    worker: ["gpt-4"],
    lead: ["gpt-4"],
    reviewer: ["gpt-4-other"],
    reviewerMustDiffer: true,
  },
  humanRequired: { paths: [], changeClasses: [], boundaries: ["merge"] },
};

test("AuthoritySchema: parses a valid authority object", () => {
  const result = AuthoritySchema.safeParse(validAuthority);
  assert.equal(result.success, true);
});

test("AuthoritySchema: rejects missing version field", () => {
  const { version: _v, ...noVersion } = validAuthority;
  assert.equal(AuthoritySchema.safeParse(noVersion).success, false);
});

test("AuthoritySchema: rejects negative estimatedSpendUsd", () => {
  const bad = { ...validAuthority, budget: { ...validAuthority.budget, estimatedSpendUsd: -1 } };
  assert.equal(AuthoritySchema.safeParse(bad).success, false);
});

test("AuthoritySchema: rejects maxAttempts < 1", () => {
  const bad = { ...validAuthority, budget: { ...validAuthority.budget, maxAttempts: 0 } };
  assert.equal(AuthoritySchema.safeParse(bad).success, false);
});

test("AuthoritySchema: rejects maxDurationSeconds < 5", () => {
  const bad = { ...validAuthority, budget: { ...validAuthority.budget, maxDurationSeconds: 4 } };
  assert.equal(AuthoritySchema.safeParse(bad).success, false);
});

test("AuthoritySchema: rejects invalid boundary value", () => {
  const bad = { ...validAuthority, boundaries: ["artifact", "badvalue"] };
  assert.equal(AuthoritySchema.safeParse(bad).success, false);
});

test("AuthoritySchema: rejects invalid ReviewProfile in review.minimum", () => {
  const bad = { ...validAuthority, review: { minimum: { editorial: "super_review" } } };
  assert.equal(AuthoritySchema.safeParse(bad).success, false);
});

// ---------------------------------------------------------------------------
// AuthorityNarrowingSchema
// ---------------------------------------------------------------------------
test("AuthorityNarrowingSchema: accepts empty object (all optional)", () => {
  assert.equal(AuthorityNarrowingSchema.safeParse({}).success, true);
});

test("AuthorityNarrowingSchema: accepts partial authority", () => {
  const partial = { version: "1", boundaries: ["artifact"] };
  assert.equal(AuthorityNarrowingSchema.safeParse(partial).success, true);
});

// ---------------------------------------------------------------------------
// HOST_TRIAL_AUTHORITY constant
// ---------------------------------------------------------------------------
test("HOST_TRIAL_AUTHORITY: parses successfully via AuthoritySchema", () => {
  const result = AuthoritySchema.safeParse(HOST_TRIAL_AUTHORITY);
  assert.equal(result.success, true);
});

test("HOST_TRIAL_AUTHORITY: has expected paths", () => {
  assert.deepEqual(HOST_TRIAL_AUTHORITY.paths.allow, ["src/parser/**", "test/parser/**"]);
  assert.deepEqual(HOST_TRIAL_AUTHORITY.paths.deny, [
    ".github/**",
    "package.json",
    "opencode.json*",
    ".opencode/**",
  ]);
});

test("HOST_TRIAL_AUTHORITY: has edit-only tool access", () => {
  const tools = HOST_TRIAL_AUTHORITY.capabilities.tools;
  assert.equal(tools.edit, true);
  assert.equal(tools.webfetch, false);
  assert.equal(tools.websearch, false);
  assert.equal(tools.task, false);
  assert.equal(tools.external_directory, false);
  assert.equal(tools.skill, false);
});

test("HOST_TRIAL_AUTHORITY: has correct budget", () => {
  assert.equal(HOST_TRIAL_AUTHORITY.budget.maxAttempts, 2);
  assert.equal(HOST_TRIAL_AUTHORITY.budget.maxDurationSeconds, 1200);
  assert.equal(HOST_TRIAL_AUTHORITY.budget.estimatedSpendUsd, 5);
});

test("HOST_TRIAL_AUTHORITY: humanRequired has merge and deploy boundaries", () => {
  assert.deepEqual(HOST_TRIAL_AUTHORITY.humanRequired.boundaries, ["merge", "deploy"]);
});

test("HOST_TRIAL_AUTHORITY: review.minimum uses correct profiles", () => {
  assert.equal(HOST_TRIAL_AUTHORITY.review.minimum.editorial, "lead_inspection");
  assert.equal(HOST_TRIAL_AUTHORITY.review.minimum.behavior, "adversarial");
  assert.equal(HOST_TRIAL_AUTHORITY.review.minimum.shared_interface, "adversarial_distinct_model");
});
