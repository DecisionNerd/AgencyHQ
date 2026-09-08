/**
 * Table tests and property tests for integration/decide.ts.
 *
 * Tests:
 *   - Output path: integrated/already_integrated → completed
 *   - Output path: base_moved/conflict/push_rejected → escalate
 *   - Observed path: containsAttempt=true → completed
 *   - Observed path: observed === expectedBase → retry_cas
 *   - Observed path: observed !== expectedBase, !containsAttempt → escalate base_moved
 *   - Property: retry_cas is NEVER returned when observed ≠ expectedBase
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fc from "fast-check";

import type { DecideIntegrationInput, IntegrateMergeOutput } from "../src/integration/decide.ts";
import { decideIntegrationOutcome } from "../src/integration/decide.ts";
import type { IntegrateOutcome } from "../src/integration/manifest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outputInput(
  outcome: IntegrateOutcome,
  resultRevision: string | null = null,
): DecideIntegrationInput {
  const output: IntegrateMergeOutput = { outcome, resultRevision };
  return { kind: "output", output };
}

function observedInput(opts: {
  observedTargetRevision: string;
  expectedBaseRevision: string;
  attemptRevision?: string;
  containsAttempt: boolean;
}): DecideIntegrationInput {
  return {
    kind: "observed",
    observedTargetRevision: opts.observedTargetRevision,
    expectedBaseRevision: opts.expectedBaseRevision,
    attemptRevision: opts.attemptRevision ?? "attempt-sha",
    containsAttempt: opts.containsAttempt,
  };
}

// ---------------------------------------------------------------------------
// Output path — success outcomes
// ---------------------------------------------------------------------------

test("output integrated → completed with resultingRevision", () => {
  const result = decideIntegrationOutcome(outputInput("integrated", "new-sha"));
  assert.equal(result.decision, "completed");
  if (result.decision === "completed") {
    assert.equal(result.resultingRevision, "new-sha");
  }
});

test("output already_integrated → completed with resultingRevision", () => {
  const result = decideIntegrationOutcome(outputInput("already_integrated", "existing-sha"));
  assert.equal(result.decision, "completed");
  if (result.decision === "completed") {
    assert.equal(result.resultingRevision, "existing-sha");
  }
});

// ---------------------------------------------------------------------------
// Output path — failure outcomes
// ---------------------------------------------------------------------------

test("output base_moved → escalate with reason base_moved", () => {
  const result = decideIntegrationOutcome(outputInput("base_moved"));
  assert.equal(result.decision, "escalate");
  if (result.decision === "escalate") {
    assert.equal(result.reason, "base_moved");
  }
});

test("output conflict → escalate with reason conflict", () => {
  const result = decideIntegrationOutcome(outputInput("conflict"));
  assert.equal(result.decision, "escalate");
  if (result.decision === "escalate") {
    assert.equal(result.reason, "conflict");
  }
});

test("output push_rejected → escalate with reason push_rejected", () => {
  const result = decideIntegrationOutcome(outputInput("push_rejected"));
  assert.equal(result.decision, "escalate");
  if (result.decision === "escalate") {
    assert.equal(result.reason, "push_rejected");
  }
});

// ---------------------------------------------------------------------------
// Observed path — containsAttempt = true
// ---------------------------------------------------------------------------

test("observed containsAttempt=true → completed with observedTargetRevision", () => {
  const result = decideIntegrationOutcome(
    observedInput({
      observedTargetRevision: "observed-sha",
      expectedBaseRevision: "base-sha",
      containsAttempt: true,
    }),
  );
  assert.equal(result.decision, "completed");
  if (result.decision === "completed") {
    assert.equal(result.resultingRevision, "observed-sha");
  }
});

test("observed containsAttempt=true and observed === base → completed (containsAttempt wins)", () => {
  // Even when the observed equals the base, if containsAttempt is true the
  // attempt was merged — return completed, not retry_cas.
  const result = decideIntegrationOutcome(
    observedInput({
      observedTargetRevision: "base-sha",
      expectedBaseRevision: "base-sha",
      containsAttempt: true,
    }),
  );
  assert.equal(result.decision, "completed");
});

// ---------------------------------------------------------------------------
// Observed path — nothing changed (retry_cas)
// ---------------------------------------------------------------------------

test("observed !containsAttempt observed === expectedBase → retry_cas", () => {
  const result = decideIntegrationOutcome(
    observedInput({
      observedTargetRevision: "base-sha",
      expectedBaseRevision: "base-sha",
      containsAttempt: false,
    }),
  );
  assert.equal(result.decision, "retry_cas");
});

// ---------------------------------------------------------------------------
// Observed path — concurrent push (escalate)
// ---------------------------------------------------------------------------

test("observed !containsAttempt observed !== expectedBase → escalate base_moved", () => {
  const result = decideIntegrationOutcome(
    observedInput({
      observedTargetRevision: "someone-elses-sha",
      expectedBaseRevision: "base-sha",
      containsAttempt: false,
    }),
  );
  assert.equal(result.decision, "escalate");
  if (result.decision === "escalate") {
    assert.equal(result.reason, "base_moved");
  }
});

// ---------------------------------------------------------------------------
// Exhaustive output outcome table
// ---------------------------------------------------------------------------

const OUTPUT_OUTCOME_TABLE: Array<{
  outcome: IntegrateOutcome;
  expectedDecision: "completed" | "escalate";
  expectedReason?: "base_moved" | "conflict" | "push_rejected";
}> = [
  { outcome: "integrated", expectedDecision: "completed" },
  { outcome: "already_integrated", expectedDecision: "completed" },
  { outcome: "base_moved", expectedDecision: "escalate", expectedReason: "base_moved" },
  { outcome: "conflict", expectedDecision: "escalate", expectedReason: "conflict" },
  { outcome: "push_rejected", expectedDecision: "escalate", expectedReason: "push_rejected" },
];

for (const row of OUTPUT_OUTCOME_TABLE) {
  test(`output outcome table: ${row.outcome} → ${row.expectedDecision}`, () => {
    const result = decideIntegrationOutcome(outputInput(row.outcome, "some-sha"));
    assert.equal(result.decision, row.expectedDecision);
    if (row.expectedReason && result.decision === "escalate") {
      assert.equal(result.reason, row.expectedReason);
    }
  });
}

// ---------------------------------------------------------------------------
// Property: retry_cas never returned when observed ≠ expectedBase
// ---------------------------------------------------------------------------

const arbitrarySha = fc.string({ minLength: 1, maxLength: 40 });

test("property: retry_cas is never returned when observedTargetRevision !== expectedBaseRevision", () => {
  fc.assert(
    fc.property(
      fc.tuple(arbitrarySha, arbitrarySha, arbitrarySha, fc.boolean()),
      ([observed, base, attempt, containsAttempt]: [string, string, string, boolean]) => {
        // Ensure observed and base are different
        const differentBase = observed === base ? `${base}-x` : base;

        const result = decideIntegrationOutcome({
          kind: "observed",
          observedTargetRevision: observed,
          expectedBaseRevision: differentBase,
          attemptRevision: attempt,
          containsAttempt,
        });

        // retry_cas must never be returned when they differ
        assert.notEqual(
          result.decision,
          "retry_cas",
          `retry_cas must not be returned when observed(${observed}) !== base(${differentBase})`,
        );
      },
    ),
    { numRuns: 500 },
  );
});

test("property: completed always carries a non-empty resultingRevision (output path)", () => {
  fc.assert(
    fc.property(
      fc.tuple(
        fc.oneof(fc.constant("integrated" as const), fc.constant("already_integrated" as const)),
        arbitrarySha,
      ),
      ([outcome, rev]: ["integrated" | "already_integrated", string]) => {
        const result = decideIntegrationOutcome({
          kind: "output",
          output: { outcome, resultRevision: rev },
        });
        assert.equal(result.decision, "completed");
        if (result.decision === "completed") {
          assert.ok(
            typeof result.resultingRevision === "string" && result.resultingRevision.length > 0,
            "resultingRevision must be a non-empty string",
          );
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("property: completed carries the observed revision when containsAttempt=true", () => {
  fc.assert(
    fc.property(
      fc.tuple(arbitrarySha, arbitrarySha, arbitrarySha),
      ([observed, base, attempt]: [string, string, string]) => {
        const result = decideIntegrationOutcome({
          kind: "observed",
          observedTargetRevision: observed,
          expectedBaseRevision: base,
          attemptRevision: attempt,
          containsAttempt: true,
        });
        assert.equal(result.decision, "completed");
        if (result.decision === "completed") {
          assert.equal(result.resultingRevision, observed);
        }
      },
    ),
    { numRuns: 200 },
  );
});
