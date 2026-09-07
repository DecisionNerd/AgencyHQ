// Pure/injectable pieces of the `verify.run` task (ADR-0007 item 5,
// docs/engineering/adrs/0007-worker-effect-model.md lines 39-41), factored
// out so they can be unit-tested without importing `@trigger.dev/sdk`.
// No Trigger SDK usage; no direct child_process/fs calls except through
// injected dependencies.
//
// Evidence integrity invariants (TESTING.md §67-73):
//   - Verification worktree is created at attemptRevision.
//   - diffDigest is reproduced against baseRevision BEFORE any check runs.
//   - profileDigest and criteriaDigest are copied from the payload into every
//     result unchanged; they are never recomputed from the worktree.
//   - The task reads nothing from the worker's report; the worker's report of
//     checks run is context, not evidence.
//   - Protected-path tamper findings are reported in output but do NOT change
//     results; the coordinator maps them to Findings and the review blocks on them.

import type { VerificationResult, VerifyRunOutput, VerifyRunPayload } from "@agencyhq/contracts";
// Relative imports to the package sources (trigger has no @agencyhq/* deps).
import { VerificationResultSchema } from "@agencyhq/contracts";
import { DEFAULT_PROTECTED_PATHS, detectVerifierTampering } from "@agencyhq/domain";

// ---------------------------------------------------------------------------
// VerificationRunner
// ---------------------------------------------------------------------------
// Narrow interface injected so the core can be tested without the real
// @agencyhq/verification package.  The real implementation is wired in
// verify-run.ts via a dynamic import guarded by a local structural type.
export interface VerificationRunner {
  /** Run all checks in the given profile against cwd. */
  runProfile(input: RunProfileInput): Promise<VerificationResult[]>;
  /** Optional abort hook: called when the task's abort signal fires. */
  abort?(): void;
}

export interface RunProfileInput {
  checks: VerifyRunPayload["checks"];
  cwd: string;
  env: Record<string, string>;
  attemptId: string;
  contractId: string;
  profileId: string;
  profileDigest: string;
  criteriaDigest: string;
  baseRevision: string;
  attemptRevision: string;
  diffDigest: string;
  repoPath: string;
  now: () => string;
}

// ---------------------------------------------------------------------------
// VerifyRunDeps
// ---------------------------------------------------------------------------
export type VerifyRunDeps = {
  /** Add a git worktree at `worktreePath` for `rev` in `repoPath`. */
  worktreeAdd(args: { repoPath: string; worktreePath: string; rev: string }): Promise<void>;
  /** Remove a git worktree from `repoPath`. */
  worktreeRemove(args: { repoPath: string; worktreePath: string; force?: boolean }): Promise<void>;
  /** Compute sha256 digest of the diff between baseRev and the worktree. */
  diffDigest(args: { worktreePath: string; baseRev: string }): Promise<string>;
  /** List files changed relative to baseRev (tracked diff + untracked). */
  changedPaths(args: { worktreePath: string; baseRev: string }): Promise<string[]>;
  /** The verification runner. */
  runner: VerificationRunner;
  /** Optional: capture environment fingerprint (host toolchain versions etc.). */
  fingerprint?: () => Promise<Record<string, string>>;
  /** ISO 8601 timestamp factory. */
  now: () => string;
};

// ---------------------------------------------------------------------------
// RunVerificationOutput
// ---------------------------------------------------------------------------
export type RunVerificationOutput = VerifyRunOutput & {
  integrity: {
    diffDigestMatches: boolean;
    tamperedPaths: string[];
  };
};

/** Resolve the worktree path for a verification run. */
export function resolveVerifyWorktreePath(args: {
  worktreeBase: string;
  attemptId: string;
  generation: number;
}): string {
  return `${args.worktreeBase}/verify/${args.attemptId}-${args.generation}`;
}

/** Build a single error VerificationResult, satisfying VerificationResultSchema. */
function errorResult(args: {
  checkId: string;
  stderrMsg: string;
  payload: VerifyRunPayload;
  environmentFingerprint: Record<string, string>;
  now: () => string;
}): VerificationResult {
  const ts = args.now();
  return VerificationResultSchema.parse({
    verifier: { name: "agencyhq/verify.run", version: "0" },
    stepContractId: args.payload.contractId,
    attemptId: args.payload.attemptId,
    criteriaDigest: args.payload.criteriaDigest,
    profileDigest: args.payload.profileDigest,
    repository: args.payload.repoPath,
    baseRevision: args.payload.baseRevision,
    attemptRevision: args.payload.attemptRevision,
    diffDigest: args.payload.diffDigest,
    checkId: args.checkId,
    environmentFingerprint: args.environmentFingerprint,
    startedAt: ts,
    endedAt: ts,
    exitStatus: null,
    stdoutTail: "",
    stderrTail: args.stderrMsg.slice(0, 16_384),
    artifactDigests: [],
    result: "error",
  }) as VerificationResult;
}

export async function runVerification(
  payload: VerifyRunPayload,
  deps: VerifyRunDeps,
): Promise<RunVerificationOutput> {
  const worktreePath = resolveVerifyWorktreePath({
    worktreeBase: payload.worktreeBase,
    attemptId: payload.attemptId,
    generation: payload.generation,
  });

  const environmentFingerprint = deps.fingerprint ? await deps.fingerprint() : {};

  await deps.worktreeAdd({
    repoPath: payload.repoPath,
    worktreePath,
    rev: payload.attemptRevision,
  });

  try {
    // --- Integrity check: reproduce diffDigest before any check runs ---
    const computedDigest = await deps.diffDigest({
      worktreePath,
      baseRev: payload.baseRevision,
    });
    const diffDigestMatches = computedDigest === payload.diffDigest;

    if (!diffDigestMatches) {
      // Mismatch: return one error result per check; runner is NOT called.
      const msg = `integrity_mismatch: expected ${payload.diffDigest} got ${computedDigest}`;
      const results = payload.checks.map((check) =>
        errorResult({
          checkId: check.id,
          stderrMsg: msg,
          payload,
          environmentFingerprint,
          now: deps.now,
        }),
      );
      return {
        results,
        integrity: { diffDigestMatches: false, tamperedPaths: [] },
      };
    }

    // --- Tamper detection: report but do not change results ---
    const changed = await deps.changedPaths({
      worktreePath,
      baseRev: payload.baseRevision,
    });
    const tamperedFindings = detectVerifierTampering(changed, DEFAULT_PROTECTED_PATHS);
    const tamperedPaths = tamperedFindings
      .map((f) => {
        // Extract "path:X" from evidence field.
        const m = f.evidence.match(/path:([^\s]+)/);
        return m?.[1] ?? "";
      })
      .filter((p) => p.length > 0);

    // --- Run checks ---
    const results = await deps.runner.runProfile({
      checks: payload.checks,
      cwd: worktreePath,
      env: {},
      attemptId: payload.attemptId,
      contractId: payload.contractId,
      profileId: payload.profileId,
      profileDigest: payload.profileDigest,
      criteriaDigest: payload.criteriaDigest,
      baseRevision: payload.baseRevision,
      attemptRevision: payload.attemptRevision,
      diffDigest: payload.diffDigest,
      repoPath: payload.repoPath,
      now: deps.now,
    });

    // Validate all results parse with VerificationResultSchema and carry
    // the payload's frozen digests (profileDigest/criteriaDigest from payload,
    // not recomputed from the worktree).
    const validated = results.map(
      (r) =>
        VerificationResultSchema.parse({
          ...r,
          profileDigest: payload.profileDigest,
          criteriaDigest: payload.criteriaDigest,
        }) as VerificationResult,
    );

    return {
      results: validated,
      integrity: { diffDigestMatches: true, tamperedPaths },
    };
  } finally {
    // Verification worktrees are disposable; the attempt worktree is the
    // retained artifact (ADR-0007 item 5).
    await deps.worktreeRemove({ repoPath: payload.repoPath, worktreePath, force: true });
  }
}
