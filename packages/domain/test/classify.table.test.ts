/**
 * Exhaustive classification table tests (R-004, R-007).
 *
 * For every TriggerRunStatus × outcome × stopRequested × budgetRemaining ×
 * stale combination, assert that classifyObservation returns without throwing
 * and that key invariants hold.
 *
 * Hand-written expectations are in EXPECTED_BY_STATUS (outcome=undefined) and
 * EXPECTED_COMPLETED_OUTCOMES.  These are intentionally derived independently
 * of CLASSIFICATION_TABLE so the test is not circular.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASSIFICATION_TABLE,
  type Classification,
  type ClassificationContext,
  classifyObservation,
  type RunObservation,
  type TriggerRunStatus,
} from "../src/failure/classify.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObs(status: TriggerRunStatus, extra?: Partial<RunObservation>): RunObservation {
  return {
    runId: "r-test",
    status,
    observedAt: "2026-09-07T00:00:00.000Z",
    ...extra,
  };
}

function makeCtx(override?: Partial<ClassificationContext>): ClassificationContext {
  return {
    generation: 1,
    observedGeneration: 1,
    budgetRemaining: 1,
    stopRequested: false,
    ...override,
  };
}

function staleCtx(override?: Partial<ClassificationContext>): ClassificationContext {
  return makeCtx({ ...override, observedGeneration: 0, generation: 1 });
}

const ALL_STATUSES: TriggerRunStatus[] = [
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "TIMED_OUT",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "DELAYED",
];

const ALL_OUTCOMES = [
  "completed",
  "path_violation",
  "timed_out",
  "cancelled",
  "opencode_error",
  undefined,
] as const;

// ---------------------------------------------------------------------------
// Hand-written expectations (independent of CLASSIFICATION_TABLE)
// These should NOT be computed from the table under test.
// ---------------------------------------------------------------------------

/**
 * Expected classifications for every status with output=undefined (no outcome).
 * budgetRemaining=1, stopRequested=false, stale=false.
 */
const EXPECTED_BY_STATUS: Record<
  TriggerRunStatus,
  Pick<Classification, "class" | "phase" | "final" | "attemptStatus"> & {
    autoNewAttemptWhenBudget1: boolean;
  }
> = {
  PENDING_VERSION: {
    class: "none",
    phase: "queued",
    final: false,
    attemptStatus: "dispatched",
    autoNewAttemptWhenBudget1: false,
  },
  QUEUED: {
    class: "none",
    phase: "queued",
    final: false,
    attemptStatus: "dispatched",
    autoNewAttemptWhenBudget1: false,
  },
  DELAYED: {
    class: "none",
    phase: "queued",
    final: false,
    attemptStatus: "dispatched",
    autoNewAttemptWhenBudget1: false,
  },
  DEQUEUED: {
    class: "none",
    phase: "running",
    final: false,
    attemptStatus: "running",
    autoNewAttemptWhenBudget1: false,
  },
  EXECUTING: {
    class: "none",
    phase: "running",
    final: false,
    attemptStatus: "running",
    autoNewAttemptWhenBudget1: false,
  },
  WAITING: {
    class: "none",
    phase: "running",
    final: false,
    attemptStatus: "running",
    autoNewAttemptWhenBudget1: false,
  },
  // COMPLETED with no output → unparseable → process failure
  COMPLETED: {
    class: "process",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget1: false,
  },
  // CANCELED without stopRequested → unexpected → execution
  CANCELED: {
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget1: true,
  },
  // FAILED without AbortTaskRunError (no error field) → execution
  FAILED: {
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget1: true,
  },
  TIMED_OUT: {
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "timed_out",
    autoNewAttemptWhenBudget1: true,
  },
  CRASHED: {
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget1: true,
  },
  SYSTEM_FAILURE: {
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget1: true,
  },
  EXPIRED: {
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget1: true,
  },
};

/**
 * Expected for COMPLETED with each known outcome.
 * stopRequested=false, budgetRemaining=1.
 */
const EXPECTED_COMPLETED_OUTCOMES: Record<
  string,
  Pick<Classification, "class" | "attemptStatus"> & { autoNewAttemptWhenBudget1: boolean }
> = {
  completed: { class: "none", attemptStatus: "completed", autoNewAttemptWhenBudget1: false },
  path_violation: {
    class: "contract",
    attemptStatus: "quarantined",
    autoNewAttemptWhenBudget1: false,
  },
  timed_out: { class: "execution", attemptStatus: "timed_out", autoNewAttemptWhenBudget1: true },
  cancelled: { class: "execution", attemptStatus: "failed", autoNewAttemptWhenBudget1: true }, // stopRequested=false
  opencode_error: { class: "execution", attemptStatus: "failed", autoNewAttemptWhenBudget1: true },
  // no outcome / unknown → process
  unknown: { class: "process", attemptStatus: "failed", autoNewAttemptWhenBudget1: false },
};

// ---------------------------------------------------------------------------
// Test 1: CLASSIFICATION_TABLE covers all 13 statuses
// ---------------------------------------------------------------------------

test("CLASSIFICATION_TABLE covers all 13 statuses", () => {
  const statusesInTable = new Set(CLASSIFICATION_TABLE.map((r) => r.status));
  for (const s of ALL_STATUSES) {
    assert.ok(statusesInTable.has(s), `Missing status in table: ${s}`);
  }
  assert.equal(statusesInTable.size, 13);
});

// ---------------------------------------------------------------------------
// Tests 2-14: Per-status expectations (outcome=undefined, no error, budget=1)
// ---------------------------------------------------------------------------

for (const status of ALL_STATUSES) {
  test(`${status} with no output/error, budget=1, stopRequested=false`, () => {
    const obs = makeObs(status);
    const ctx = makeCtx({ budgetRemaining: 1, stopRequested: false });
    const result = classifyObservation(obs, ctx);
    const expected = EXPECTED_BY_STATUS[status];

    assert.equal(result.stale, false, "should not be stale");
    assert.equal(result.class, expected.class, "class");
    assert.equal(result.phase, expected.phase, "phase");
    assert.equal(result.final, expected.final, "final");
    assert.equal(result.attemptStatus, expected.attemptStatus, "attemptStatus");
    assert.equal(
      result.autoNewAttempt,
      expected.autoNewAttemptWhenBudget1,
      "autoNewAttempt (budget=1)",
    );
  });
}

// ---------------------------------------------------------------------------
// Tests 15-20: COMPLETED with each known outcome (stopRequested=false, budget=1)
// ---------------------------------------------------------------------------

test("COMPLETED + outcome=completed: not acceptance, not contract, not execution", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "completed" } });
  const ctx = makeCtx({ budgetRemaining: 1, stopRequested: false });
  const result = classifyObservation(obs, ctx);

  assert.equal(
    result.class,
    "none",
    "completed outcome must not yield contract or execution class",
  );
  assert.equal(result.attemptStatus, "completed", "attemptStatus");
  assert.equal(result.autoNewAttempt, false, "completed: no auto-retry");
  assert.equal(result.final, true, "final");
  // Verify the test name claim: not acceptance
  // (acceptance requires criteria, verification, Review, Decision — not just COMPLETED)
  assert.notEqual(result.class, "contract");
  assert.notEqual(result.class, "execution");
});

test("COMPLETED + outcome=path_violation: contract class, quarantined, no auto-retry", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "path_violation" } });
  const ctx = makeCtx({ budgetRemaining: 1, stopRequested: false });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "contract");
  assert.equal(result.attemptStatus, "quarantined");
  assert.equal(result.autoNewAttempt, false);
});

test("COMPLETED + outcome=timed_out: execution class, budget=1 → autoNewAttempt=true", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "timed_out" } });
  const ctx = makeCtx({ budgetRemaining: 1, stopRequested: false });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "execution");
  assert.equal(result.attemptStatus, "timed_out");
  assert.equal(result.autoNewAttempt, true);
});

test("COMPLETED + outcome=timed_out: execution class, budget=0 → autoNewAttempt=false", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "timed_out" } });
  const ctx = makeCtx({ budgetRemaining: 0, stopRequested: false });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "execution");
  assert.equal(result.autoNewAttempt, false);
});

test("COMPLETED + outcome=opencode_error: execution class, budget=1 → autoNewAttempt=true", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "opencode_error" } });
  const ctx = makeCtx({ budgetRemaining: 1, stopRequested: false });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "execution");
  assert.equal(result.attemptStatus, "failed");
  assert.equal(result.autoNewAttempt, true);
});

test("COMPLETED + no output (absent): process class, no auto-retry", () => {
  const obs = makeObs("COMPLETED");
  const ctx = makeCtx({ budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "process");
  assert.equal(result.attemptStatus, "failed");
  assert.equal(result.autoNewAttempt, false);
});

// ---------------------------------------------------------------------------
// Tests 21-22: COMPLETED + cancelled with stopRequested true/false
// ---------------------------------------------------------------------------

test("COMPLETED + outcome=cancelled + stopRequested=true: none class, stopping", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "cancelled" } });
  const ctx = makeCtx({ stopRequested: true, budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "none");
  assert.equal(result.attemptStatus, "stopping");
  assert.equal(result.autoNewAttempt, false);
});

test("COMPLETED + outcome=cancelled + stopRequested=false: execution class, failed", () => {
  const obs = makeObs("COMPLETED", { output: { outcome: "cancelled" } });
  const ctx = makeCtx({ stopRequested: false, budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "execution");
  assert.equal(result.attemptStatus, "failed");
  assert.equal(result.autoNewAttempt, true);
});

// ---------------------------------------------------------------------------
// Tests 23-24: CANCELED with stopRequested true/false
// ---------------------------------------------------------------------------

test("CANCELED + stopRequested=true: none class, stopping (requested cancel)", () => {
  const obs = makeObs("CANCELED");
  const ctx = makeCtx({ stopRequested: true, budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "none");
  assert.equal(result.attemptStatus, "stopping");
  assert.equal(result.autoNewAttempt, false);
});

test("CANCELED + stopRequested=false: execution class, failed, budget=1 → autoNewAttempt=true", () => {
  const obs = makeObs("CANCELED");
  const ctx = makeCtx({ stopRequested: false, budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "execution");
  assert.equal(result.attemptStatus, "failed");
  assert.equal(result.autoNewAttempt, true);
});

// ---------------------------------------------------------------------------
// Tests 25-27: FAILED error type discrimination
// ---------------------------------------------------------------------------

test("FAILED + AbortTaskRunError → contract class, no auto-retry", () => {
  const obs = makeObs("FAILED", {
    error: { name: "AbortTaskRunError", message: "task aborted" },
  });
  const ctx = makeCtx({ budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "contract");
  assert.equal(result.attemptStatus, "failed");
  assert.equal(result.autoNewAttempt, false);
});

test("FAILED + message matching /worktree exists/ → contract class, no auto-retry", () => {
  const obs = makeObs("FAILED", {
    error: { message: "worktree exists at path /tmp/wt" },
  });
  const ctx = makeCtx({ budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "contract");
  assert.equal(result.autoNewAttempt, false);
});

test("FAILED + message matching /setup/ → contract class, no auto-retry", () => {
  const obs = makeObs("FAILED", {
    error: { message: "setup step failed" },
  });
  const ctx = makeCtx({ budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "contract");
  assert.equal(result.autoNewAttempt, false);
});

test("FAILED + generic error → execution class, budget=1 → autoNewAttempt=true", () => {
  const obs = makeObs("FAILED", {
    error: { name: "Error", message: "unexpected crash" },
  });
  const ctx = makeCtx({ budgetRemaining: 1 });
  const result = classifyObservation(obs, ctx);

  assert.equal(result.class, "execution");
  assert.equal(result.attemptStatus, "failed");
  assert.equal(result.autoNewAttempt, true);
});

// ---------------------------------------------------------------------------
// Tests 28-29: Stale observations
// ---------------------------------------------------------------------------

test("stale observation (final status): class=none, stale=true, final=true, attemptStatus=uncertain", () => {
  const obs = makeObs("FAILED", { error: { message: "crash" } });
  const ctx = staleCtx();
  const result = classifyObservation(obs, ctx);

  assert.equal(result.stale, true);
  assert.equal(result.class, "none");
  assert.equal(result.final, true);
  assert.equal(result.autoNewAttempt, false);
  assert.equal(result.attemptStatus, "uncertain");
});

test("stale observation (non-final status): class=none, stale=true, final=false", () => {
  const obs = makeObs("EXECUTING");
  const ctx = staleCtx();
  const result = classifyObservation(obs, ctx);

  assert.equal(result.stale, true);
  assert.equal(result.class, "none");
  assert.equal(result.final, false);
  assert.equal(result.attemptStatus, "uncertain");
});

// ---------------------------------------------------------------------------
// Test 30: Execution class final rows — autoNewAttempt respects budget
// ---------------------------------------------------------------------------

test("all execution-class final rows: autoNewAttempt === (budgetRemaining > 0)", () => {
  const executionFinalRows = CLASSIFICATION_TABLE.filter((r) => r.class === "execution" && r.final);
  assert.ok(executionFinalRows.length > 0, "should have execution-final rows");

  for (const row of executionFinalRows) {
    // Construct a minimal observation that will match this row
    let output: unknown;
    if (row.status === "COMPLETED" && row.outcome !== null) {
      output = { outcome: row.outcome };
    }
    const errorPart: Partial<RunObservation> =
      row.status === "FAILED"
        ? {
            error:
              row.errorType === "abort"
                ? { name: "AbortTaskRunError", message: "aborted" }
                : { message: "unexpected failure" },
          }
        : {};
    const obs = makeObs(row.status, { output, ...errorPart });
    const stopRequested = row.stopRequested ?? false;

    const ctxBudget1 = makeCtx({ budgetRemaining: 1, stopRequested });
    const ctxBudget0 = makeCtx({ budgetRemaining: 0, stopRequested });

    const r1 = classifyObservation(obs, ctxBudget1);
    const r0 = classifyObservation(obs, ctxBudget0);

    assert.equal(r1.class, "execution", `row ${row.status}/${row.outcome ?? ""}: class`);
    assert.equal(
      r1.autoNewAttempt,
      true,
      `row ${row.status}/${row.outcome ?? ""}: autoNewAttempt with budget=1`,
    );
    assert.equal(
      r0.autoNewAttempt,
      false,
      `row ${row.status}/${row.outcome ?? ""}: autoNewAttempt with budget=0`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 31: Contract class rows never auto-retry
// ---------------------------------------------------------------------------

test("contract-class rows never auto-retry regardless of budget", () => {
  const contractRows = CLASSIFICATION_TABLE.filter((r) => r.class === "contract");
  assert.ok(contractRows.length > 0, "should have contract rows");

  for (const row of contractRows) {
    let output: unknown;
    if (row.status === "COMPLETED" && row.outcome !== null) {
      output = { outcome: row.outcome };
    }
    const errorPart2: Partial<RunObservation> =
      row.status === "FAILED" && row.errorType === "abort"
        ? { error: { name: "AbortTaskRunError", message: "aborted" } }
        : {};
    const obs = makeObs(row.status, { output, ...errorPart2 });
    const stopRequested = row.stopRequested ?? false;

    for (const budgetRemaining of [0, 1]) {
      const result = classifyObservation(obs, makeCtx({ budgetRemaining, stopRequested }));
      assert.equal(result.class, "contract");
      assert.equal(
        result.autoNewAttempt,
        false,
        `contract row ${row.status}/${row.outcome ?? ""} must not auto-retry (budget=${budgetRemaining})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test 32: Process class rows never auto-retry
// ---------------------------------------------------------------------------

test("process-class rows never auto-retry regardless of budget", () => {
  const processRows = CLASSIFICATION_TABLE.filter((r) => r.class === "process");
  assert.ok(processRows.length > 0, "should have process rows");

  for (const row of processRows) {
    const obs = makeObs(row.status); // no output → process fallback for COMPLETED
    for (const budgetRemaining of [0, 1]) {
      const result = classifyObservation(obs, makeCtx({ budgetRemaining }));
      assert.equal(result.class, "process");
      assert.equal(
        result.autoNewAttempt,
        false,
        `process row ${row.status}: must not auto-retry (budget=${budgetRemaining})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test 33: Table auto-retry flag consistency
// ---------------------------------------------------------------------------

test("every execution-class table row has autoNewAttemptWhenBudget=true", () => {
  for (const row of CLASSIFICATION_TABLE) {
    if (row.class === "execution") {
      assert.equal(
        row.autoNewAttemptWhenBudget,
        true,
        `execution row ${row.status}/${row.outcome ?? ""} must have autoNewAttemptWhenBudget=true`,
      );
    }
  }
});

test("contract and process table rows have autoNewAttemptWhenBudget=false", () => {
  for (const row of CLASSIFICATION_TABLE) {
    if (row.class === "contract" || row.class === "process") {
      assert.equal(
        row.autoNewAttemptWhenBudget,
        false,
        `${row.class} row ${row.status}/${row.outcome ?? ""} must have autoNewAttemptWhenBudget=false`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test 35: Exhaustive — no throw for any input combination
// ---------------------------------------------------------------------------

test("classifyObservation never throws for any status × outcome × stopRequested × budget × stale", () => {
  let count = 0;
  for (const status of ALL_STATUSES) {
    for (const outcomeVal of ALL_OUTCOMES) {
      const output = outcomeVal !== undefined ? { outcome: outcomeVal } : undefined;
      for (const stopRequested of [true, false] as const) {
        for (const budgetRemaining of [0, 1] as const) {
          for (const stale of [false, true] as const) {
            const obs = makeObs(status, { output });
            const ctx: ClassificationContext = {
              generation: 1,
              observedGeneration: stale ? 0 : 1,
              budgetRemaining,
              stopRequested,
            };
            let result: Classification | undefined;
            assert.doesNotThrow(
              () => {
                result = classifyObservation(obs, ctx);
              },
              `should not throw for status=${status} outcome=${String(outcomeVal)} stopRequested=${String(stopRequested)} budget=${budgetRemaining} stale=${String(stale)}`,
            );
            assert.ok(result !== undefined, "result should be defined");
            assert.equal(result?.stale, stale, "stale flag must match");
            if (stale) {
              assert.equal(result?.class, "none", "stale must be class none");
              assert.equal(result?.attemptStatus, "uncertain");
            }
            count++;
          }
        }
      }
    }
  }
  // 13 × 6 × 2 × 2 × 2 = 624 combinations
  assert.equal(count, 624);
});

// ---------------------------------------------------------------------------
// Test 36: Hand-written expectations for status=COMPLETED, each outcome
// ---------------------------------------------------------------------------

test("COMPLETED outcome expectations match hand-written table", () => {
  const outcomeKeys = ["completed", "path_violation", "timed_out", "opencode_error"] as const;
  for (const oc of outcomeKeys) {
    const obs = makeObs("COMPLETED", { output: { outcome: oc } });
    const ctx = makeCtx({ budgetRemaining: 1, stopRequested: false });
    const result = classifyObservation(obs, ctx);
    const expected = EXPECTED_COMPLETED_OUTCOMES[oc];
    assert.ok(expected !== undefined, `missing expectation for outcome ${oc}`);

    assert.equal(result.class, expected.class, `COMPLETED+${oc}: class`);
    assert.equal(result.attemptStatus, expected.attemptStatus, `COMPLETED+${oc}: attemptStatus`);
    assert.equal(
      result.autoNewAttempt,
      expected.autoNewAttemptWhenBudget1,
      `COMPLETED+${oc}: autoNewAttempt (budget=1)`,
    );
  }

  // COMPLETED + no output → process
  {
    const obs = makeObs("COMPLETED");
    const ctx = makeCtx({ budgetRemaining: 1 });
    const result = classifyObservation(obs, ctx);
    const expected = EXPECTED_COMPLETED_OUTCOMES.unknown!;
    assert.equal(result.class, expected.class, "COMPLETED+unknown: class");
    assert.equal(result.autoNewAttempt, expected.autoNewAttemptWhenBudget1);
  }
});

// ---------------------------------------------------------------------------
// Test 37: COMPLETED+completed is never contract/execution (not acceptance)
// ---------------------------------------------------------------------------

test("COMPLETED+completed: class is never contract or execution for any budget/stopRequested", () => {
  for (const stopRequested of [true, false] as const) {
    for (const budgetRemaining of [0, 1] as const) {
      const obs = makeObs("COMPLETED", { output: { outcome: "completed" } });
      const ctx = makeCtx({ stopRequested, budgetRemaining });
      const result = classifyObservation(obs, ctx);
      assert.notEqual(result.class, "contract");
      assert.notEqual(result.class, "execution");
    }
  }
});
