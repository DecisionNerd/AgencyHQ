/**
 * Failure classification for Trigger.dev run observations.
 *
 * Domain layer: pure, no Trigger/OpenCode/React/Postgres imports.
 * Trigger statuses are string literals; classification is NOT acceptance.
 *
 * R-004: Trigger.dev is trusted for run lifecycle; never for acceptance.
 * R-007: Execution / contract / process failures are classified separately;
 *        only execution failures create automatic new Attempts, within budget.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * The full set of Trigger.dev run statuses this domain recognises.
 * Identical to the union that ports.ts will export; named here so domain
 * code can stay self-contained during parallel slice-1 work.
 */
export type TriggerRunStatus =
  | "PENDING_VERSION"
  | "QUEUED"
  | "DEQUEUED"
  | "EXECUTING"
  | "WAITING"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED"
  | "TIMED_OUT"
  | "CRASHED"
  | "SYSTEM_FAILURE"
  | "EXPIRED"
  | "DELAYED";

/** A single observation of a Trigger run, recorded by the coordinator. */
export type RunObservation = {
  runId: string;
  status: TriggerRunStatus;
  output?: unknown;
  metadata?: Record<string, unknown>;
  error?: { message: string; name?: string };
  /** ISO-8601 timestamp. */
  observedAt: string;
};

/**
 * Context the coordinator supplies alongside an observation so classification
 * can be stateless (all needed state is passed in).
 */
export type ClassificationContext = {
  /** Current authority generation for this attempt. */
  generation: number;
  /** Generation stamped on this observation's run. */
  observedGeneration: number;
  /** Remaining step budget at classification time. */
  budgetRemaining: number;
  /** True when an operator or system has issued a stop request. */
  stopRequested: boolean;
};

/** Taxonomy of failures (EXECUTION_MODEL.md §Failure taxonomy). */
export type FailureClass = "execution" | "contract" | "process" | "none";

/** The full classification result. */
export type Classification = {
  class: FailureClass;
  phase: "queued" | "running" | "final";
  final: boolean;
  autoNewAttempt: boolean;
  attemptStatus:
    | "dispatched"
    | "running"
    | "completed"
    | "quarantined"
    | "failed"
    | "stopping"
    | "timed_out"
    | "uncertain";
  reason: string;
  /**
   * True when observedGeneration !== generation.
   * Callers MUST NOT apply a stale classification to state — it is history only.
   */
  stale: boolean;
};

// ---------------------------------------------------------------------------
// Classification table
// ---------------------------------------------------------------------------

/**
 * One row in the classification table.
 *
 * Fields used as discriminators during lookup:
 *   outcome        — only matched when status is COMPLETED (string key or "unknown")
 *   stopRequested  — only matched when set; for CANCELED and COMPLETED+cancelled
 *   errorType      — only matched when status is FAILED
 *
 * null in a discriminator means "not applicable; match any value for this status".
 */
export type ClassificationTableRow = {
  /** Trigger run status this row applies to. */
  status: TriggerRunStatus;
  /**
   * For COMPLETED rows: the value of output.outcome (or "unknown" when the
   * output is absent/unparseable).  null for all other statuses.
   */
  outcome: string | null;
  /**
   * When non-null, this row only matches observations where
   * ClassificationContext.stopRequested equals this value.
   */
  stopRequested: boolean | null;
  /**
   * For FAILED rows: "abort" when error.name is AbortTaskRunError or the
   * message matches the setup-contract pattern; "other" otherwise.
   * null for all other statuses.
   */
  errorType: "abort" | "other" | null;
  class: FailureClass;
  phase: "queued" | "running" | "final";
  final: boolean;
  attemptStatus: Classification["attemptStatus"];
  /**
   * If true, autoNewAttempt is set to (budgetRemaining > 0).
   * If false, autoNewAttempt is always false regardless of budget.
   */
  autoNewAttemptWhenBudget: boolean;
  reason: string;
};

/**
 * The canonical classification lookup table.
 *
 * Rules derived from EXECUTION_MODEL.md §Failure taxonomy and §Stop, cancel,
 * and replacement; and from the Slice 1 execution trial findings.
 *
 * Order matters: classifyObservation uses the first matching row.
 * More-specific rows (with stopRequested or errorType set) come first so they
 * win over catch-all rows for the same status.
 */
export const CLASSIFICATION_TABLE: readonly ClassificationTableRow[] = [
  // -------------------------------------------------------------------------
  // Queued phase — run not yet started; no failure class
  // -------------------------------------------------------------------------
  {
    status: "PENDING_VERSION",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "queued",
    final: false,
    attemptStatus: "dispatched",
    autoNewAttemptWhenBudget: false,
    reason: "run is pending version assignment",
  },
  {
    status: "QUEUED",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "queued",
    final: false,
    attemptStatus: "dispatched",
    autoNewAttemptWhenBudget: false,
    reason: "run is queued",
  },
  {
    status: "DELAYED",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "queued",
    final: false,
    attemptStatus: "dispatched",
    autoNewAttemptWhenBudget: false,
    reason: "run is delayed",
  },

  // -------------------------------------------------------------------------
  // Running phase
  // -------------------------------------------------------------------------
  {
    status: "DEQUEUED",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "running",
    final: false,
    attemptStatus: "running",
    autoNewAttemptWhenBudget: false,
    reason: "run is dequeued",
  },
  {
    status: "EXECUTING",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "running",
    final: false,
    attemptStatus: "running",
    autoNewAttemptWhenBudget: false,
    reason: "run is executing",
  },
  {
    status: "WAITING",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "running",
    final: false,
    attemptStatus: "running",
    autoNewAttemptWhenBudget: false,
    reason: "run is waiting",
  },

  // -------------------------------------------------------------------------
  // COMPLETED — outcome discriminates the classification
  // Note: COMPLETED with outcome "completed" is NOT acceptance.
  //       Acceptance requires approved criteria, VerificationResults, Review,
  //       and a recorded Decision (TESTING.md §Completion rule).
  // -------------------------------------------------------------------------
  {
    status: "COMPLETED",
    outcome: "completed",
    stopRequested: null,
    errorType: null,
    class: "none",
    phase: "final",
    final: true,
    attemptStatus: "completed",
    autoNewAttemptWhenBudget: false,
    reason:
      "run completed (execution observation only; acceptance requires criteria, verification, review, and Decision)",
  },
  {
    status: "COMPLETED",
    outcome: "path_violation",
    stopRequested: null,
    errorType: null,
    class: "contract",
    phase: "final",
    final: true,
    attemptStatus: "quarantined",
    autoNewAttemptWhenBudget: false,
    reason: "path violation detected: adapter quarantined the worktree",
  },
  {
    // Slice 1 trial finding: the adapter imposes a soft deadline (maxDuration − 15 s)
    // and returns outcome "timed_out" with run status COMPLETED, not TIMED_OUT.
    status: "COMPLETED",
    outcome: "timed_out",
    stopRequested: null,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "timed_out",
    autoNewAttemptWhenBudget: true,
    reason: "adapter soft deadline reached: run COMPLETED with outcome timed_out",
  },
  {
    // COMPLETED+cancelled where a stop was requested → expected; no failure class.
    status: "COMPLETED",
    outcome: "cancelled",
    stopRequested: true,
    errorType: null,
    class: "none",
    phase: "final",
    final: true,
    attemptStatus: "stopping",
    autoNewAttemptWhenBudget: false,
    reason: "run cancelled as requested by operator or system",
  },
  {
    // COMPLETED+cancelled with no stop request → unexpected cancel; execution failure.
    status: "COMPLETED",
    outcome: "cancelled",
    stopRequested: false,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "run cancelled without a stop request (unexpected cancel)",
  },
  {
    status: "COMPLETED",
    outcome: "opencode_error",
    stopRequested: null,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "OpenCode process error",
  },
  {
    // COMPLETED with absent or unparseable output: coordinator cannot compute
    // next state → process failure.  Sentinel "unknown" is set by classifyObservation
    // when output.outcome is missing or not a recognised string.
    status: "COMPLETED",
    outcome: "unknown",
    stopRequested: null,
    errorType: null,
    class: "process",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: false,
    reason: "COMPLETED with absent or unparseable output; coordinator cannot compute next state",
  },

  // -------------------------------------------------------------------------
  // CANCELED
  // Slice 1 finding: Trigger API reports CANCELED 22–38 ms after runs.cancel,
  // before adapter cleanup. stopRequested distinguishes requested from unexpected.
  // -------------------------------------------------------------------------
  {
    status: "CANCELED",
    outcome: null,
    stopRequested: true,
    errorType: null,
    class: "none",
    phase: "final",
    final: true,
    attemptStatus: "stopping",
    autoNewAttemptWhenBudget: false,
    reason: "run canceled as requested; awaiting adapter confirmation",
  },
  {
    status: "CANCELED",
    outcome: null,
    stopRequested: false,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "run canceled without a stop request (unexpected cancellation)",
  },

  // -------------------------------------------------------------------------
  // FAILED
  // AbortTaskRunError (or matching message) → setup contract failure → contract class.
  // All other FAILED → execution failure.
  // -------------------------------------------------------------------------
  {
    status: "FAILED",
    outcome: null,
    stopRequested: null,
    errorType: "abort",
    class: "contract",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: false,
    reason: "adapter setup contract failure (AbortTaskRunError or setup error)",
  },
  {
    status: "FAILED",
    outcome: null,
    stopRequested: null,
    errorType: "other",
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "run failed unexpectedly",
  },

  // -------------------------------------------------------------------------
  // Trigger-side infrastructure failures — all execution class
  // -------------------------------------------------------------------------
  {
    status: "TIMED_OUT",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "timed_out",
    autoNewAttemptWhenBudget: true,
    reason: "run timed out (Trigger maxDuration hard limit)",
  },
  {
    status: "CRASHED",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "run crashed",
  },
  {
    status: "SYSTEM_FAILURE",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "system failure reported by Trigger",
  },
  {
    status: "EXPIRED",
    outcome: null,
    stopRequested: null,
    errorType: null,
    class: "execution",
    phase: "final",
    final: true,
    attemptStatus: "failed",
    autoNewAttemptWhenBudget: true,
    reason: "run expired",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known WorkerAttemptOutput outcome values (from contracts/tasks/worker-attempt.ts). */
const KNOWN_OUTCOMES = new Set([
  "completed",
  "path_violation",
  "opencode_error",
  "cancelled",
  "timed_out",
]);

/**
 * Extract the outcome key from a COMPLETED observation's output.
 * Returns one of the five known outcomes, or "unknown" when the output is
 * absent or its outcome field is not a recognised string.
 */
function extractOutcomeKey(obs: RunObservation): string {
  const output = obs.output;
  if (output !== null && typeof output === "object" && "outcome" in output) {
    const oc = (output as Record<string, unknown>).outcome;
    if (typeof oc === "string" && KNOWN_OUTCOMES.has(oc)) {
      return oc;
    }
  }
  return "unknown";
}

/** Pattern that identifies adapter setup contract failures in error messages. */
const SETUP_ERROR_PATTERN = /worktree exists|missing required environment|setup/i;

/**
 * Classify a FAILED run's error as an adapter setup contract failure ("abort")
 * or a generic execution failure ("other").
 */
function extractErrorType(obs: RunObservation): "abort" | "other" {
  const err = obs.error;
  if (err === undefined) return "other";
  if (err.name === "AbortTaskRunError" || SETUP_ERROR_PATTERN.test(err.message)) {
    return "abort";
  }
  return "other";
}

/** Find the first matching row in CLASSIFICATION_TABLE. */
function findRow(
  obs: RunObservation,
  ctx: ClassificationContext,
): ClassificationTableRow | undefined {
  const derivedOutcome = obs.status === "COMPLETED" ? extractOutcomeKey(obs) : null;
  const derivedErrorType = obs.status === "FAILED" ? extractErrorType(obs) : null;

  for (const row of CLASSIFICATION_TABLE) {
    if (row.status !== obs.status) continue;
    if (row.outcome !== null && row.outcome !== derivedOutcome) continue;
    if (row.stopRequested !== null && row.stopRequested !== ctx.stopRequested) continue;
    if (row.errorType !== null && row.errorType !== derivedErrorType) continue;
    return row;
  }
  return undefined;
}

/** Return true for statuses that represent a final (terminal) run state. */
function isFinalStatus(status: TriggerRunStatus): boolean {
  switch (status) {
    case "COMPLETED":
    case "CANCELED":
    case "FAILED":
    case "TIMED_OUT":
    case "CRASHED":
    case "SYSTEM_FAILURE":
    case "EXPIRED":
      return true;
    default:
      return false;
  }
}

/** Derive a phase from a run status (used for stale observations). */
function phaseFromStatus(status: TriggerRunStatus): "queued" | "running" | "final" {
  switch (status) {
    case "PENDING_VERSION":
    case "QUEUED":
    case "DELAYED":
      return "queued";
    case "DEQUEUED":
    case "EXECUTING":
    case "WAITING":
      return "running";
    default:
      return "final";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single Trigger run observation.
 *
 * Stale observations (observedGeneration !== generation) return
 * `{ stale: true, class: "none", attemptStatus: "uncertain" }`.
 * Callers MUST NOT apply a stale classification to attempt state — it is
 * recorded as history only.
 *
 * Non-stale: the classification is derived by looking up CLASSIFICATION_TABLE.
 * An unmapped status/outcome combination is a process failure (coordinator bug).
 */
export function classifyObservation(
  obs: RunObservation,
  ctx: ClassificationContext,
): Classification {
  const stale = ctx.observedGeneration !== ctx.generation;

  if (stale) {
    return {
      class: "none",
      phase: phaseFromStatus(obs.status),
      final: isFinalStatus(obs.status),
      autoNewAttempt: false,
      attemptStatus: "uncertain",
      reason: `stale observation: observedGeneration ${ctx.observedGeneration.toString()} !== generation ${ctx.generation.toString()}`,
      stale: true,
    };
  }

  const row = findRow(obs, ctx);

  if (row === undefined) {
    // Defensive fallback: unknown status → process failure.
    return {
      class: "process",
      phase: "final",
      final: true,
      autoNewAttempt: false,
      attemptStatus: "failed",
      reason: `unrecognised run status "${obs.status}"; coordinator cannot compute next state`,
      stale: false,
    };
  }

  return {
    class: row.class,
    phase: row.phase,
    final: row.final,
    autoNewAttempt: row.autoNewAttemptWhenBudget && ctx.budgetRemaining > 0,
    attemptStatus: row.attemptStatus,
    reason: row.reason,
    stale: false,
  };
}
