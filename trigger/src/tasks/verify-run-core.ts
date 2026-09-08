// Pure/injectable pieces of the `verify.run` task (ADR-0007 item 5,
// docs/engineering/adrs/0007-worker-effect-model.md lines 39-41), factored
// out so they can be unit-tested in isolation from the Trigger SDK.
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

import type {
  ManifestEntry,
  VerificationResult,
  VerifyRunOutput,
  VerifyRunPayload,
} from "@agencyhq/contracts";
// Relative imports to the package sources (trigger has no @agencyhq/* deps).
import { VerificationResultSchema } from "@agencyhq/contracts";
import { DEFAULT_PROTECTED_PATHS, detectVerifierTampering } from "@agencyhq/domain";
import { manifestEnv, siblingEntries } from "../lib/manifest.ts";

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
  // ---- Combined manifest verification (Packet 4.2.c, R-006) ----
  /**
   * ProjectId of the project currently under verification.
   * Required when `payload.manifest` is present; used to exclude the current
   * entry and identify siblings to materialize.
   * Coordinator-supplied; extracted from the raw payload alongside the schema.
   */
  manifestProjectId?: string;
  /**
   * Absolute paths to coordinator-owned clones of sibling repositories, keyed
   * by projectId. Only sibling entries (not the current project) appear here.
   * Required when `payload.manifest` is present.
   * Coordinator-supplied; extracted from the raw payload alongside the schema.
   */
  manifestRepoPaths?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// RunVerificationOutput
// ---------------------------------------------------------------------------

/** Manifest materialization record included in the output when combined
 * verification was performed (payload.manifest present + sibling repos supplied). */
export type ManifestRecord = {
  /** The stable manifest plan digest used for this run. */
  digest: string;
  /** One entry per sibling worktree that was materialized. */
  materializedSiblings: { position: number; projectId: string; revision: string }[];
};

export type RunVerificationOutput = VerifyRunOutput & {
  integrity: {
    diffDigestMatches: boolean;
    tamperedPaths: string[];
    /**
     * Which source supplied the protected-paths list used for tamper detection.
     * - "payload": the coordinator sent an explicit `protectedPaths` field (the
     *   normal production path, ADR H-6).
     * - "default": the coordinator did not send `protectedPaths` (older payload;
     *   the domain `DEFAULT_PROTECTED_PATHS` list was used as a fallback).
     *
     * Recorded so the coordinator's evidence is explicit about which list
     * governed tamper detection for this verification run.
     */
    protectedPathsSource: "payload" | "default";
  };
  /**
   * Combined manifest verification record.
   * Present when payload.manifest was supplied and sibling worktrees were
   * materialized. Includes the plan digest and per-sibling revision info.
   * Absent when no manifest was present (single-repo WorkItem).
   */
  manifest?: ManifestRecord;
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

/** Resolve the base directory for manifest sibling worktrees within a run. */
export function resolveManifestWorktreeDir(args: {
  worktreeBase: string;
  attemptId: string;
  generation: number;
}): string {
  return `${args.worktreeBase}/manifest-${args.attemptId}-${args.generation}`;
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

  // ---- Combined manifest verification setup (Packet 4.2.c, R-006) ----
  // Materialized sibling worktrees are tracked here so the finally block can
  // clean them up regardless of outcome.
  const materializedSiblings: {
    position: number;
    projectId: string;
    revision: string;
    worktreePath: string;
    repoPath: string;
  }[] = [];
  let manifestCheckEnv: Record<string, string> = {};
  let manifestRecord: ManifestRecord | undefined;

  try {
    // --- Manifest sibling materialization (only when manifest + deps are present) ---
    if (
      payload.manifest !== undefined &&
      deps.manifestProjectId !== undefined &&
      deps.manifestRepoPaths !== undefined
    ) {
      const manifest = payload.manifest;
      const repoPaths = deps.manifestRepoPaths;
      const siblings: ManifestEntry[] = siblingEntries(manifest.entries, deps.manifestProjectId);
      const manifestDir = resolveManifestWorktreeDir({
        worktreeBase: payload.worktreeBase,
        attemptId: payload.attemptId,
        generation: payload.generation,
      });

      const worktreePaths: Record<number, string> = {};

      for (const sibling of siblings) {
        const siblingRepoPath = repoPaths[sibling.projectId];
        if (siblingRepoPath === undefined) {
          // Coordinator did not supply this sibling's path; skip materialization.
          continue;
        }
        const rev = sibling.resultRevision ?? sibling.expectedBaseRevision;
        const siblingWt = `${manifestDir}/${sibling.position}`;

        await deps.worktreeAdd({
          repoPath: siblingRepoPath,
          worktreePath: siblingWt,
          rev,
        });

        materializedSiblings.push({
          position: sibling.position,
          projectId: sibling.projectId,
          revision: rev,
          worktreePath: siblingWt,
          repoPath: siblingRepoPath,
        });
        worktreePaths[sibling.position] = siblingWt;
      }

      // Build env vars for the check environment.
      manifestCheckEnv = manifestEnv(siblings, worktreePaths, manifest.digest);

      // Record for the output.
      manifestRecord = {
        digest: manifest.digest,
        materializedSiblings: materializedSiblings.map(({ position, projectId, revision }) => ({
          position,
          projectId,
          revision,
        })),
      };
    }

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
        // protectedPathsSource is not meaningful on a digest-mismatch path since
        // tamper detection is skipped; use "default" as a safe sentinel.
        integrity: { diffDigestMatches: false, tamperedPaths: [], protectedPathsSource: "default" },
        ...(manifestRecord !== undefined ? { manifest: manifestRecord } : {}),
      };
    }

    // --- Tamper detection: report but do not change results ---
    const changed = await deps.changedPaths({
      worktreePath,
      baseRev: payload.baseRevision,
    });
    // H-6: use the payload's frozen protectedPaths (from the profile, set by the
    // coordinator) as the single source of truth. Fall back to the domain default
    // only when the coordinator did not supply the field (older payloads).
    // Record which source was used in the output so the coordinator's evidence
    // is explicit about which list governed tamper detection.
    const protectedPathsSource: "payload" | "default" =
      payload.protectedPaths !== undefined ? "payload" : "default";
    const tamperedFindings = detectVerifierTampering(
      changed,
      payload.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
    );
    const tamperedPaths = tamperedFindings
      .map((f) => {
        // Extract "path:X" from evidence field.
        const m = f.evidence.match(/path:([^\s]+)/);
        return m?.[1] ?? "";
      })
      .filter((p) => p.length > 0);

    // --- Run checks (with manifest env vars injected when present) ---
    const results = await deps.runner.runProfile({
      checks: payload.checks,
      cwd: worktreePath,
      env: manifestCheckEnv,
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
      integrity: { diffDigestMatches: true, tamperedPaths, protectedPathsSource },
      ...(manifestRecord !== undefined ? { manifest: manifestRecord } : {}),
    };
  } finally {
    // Remove manifest sibling worktrees before removing the main verify worktree.
    // Errors are swallowed so they do not mask the primary outcome.
    for (const sibling of materializedSiblings) {
      await deps
        .worktreeRemove({
          repoPath: sibling.repoPath,
          worktreePath: sibling.worktreePath,
          force: true,
        })
        .catch(() => undefined);
    }
    // Verification worktrees are disposable; the attempt worktree is the
    // retained artifact (ADR-0007 item 5).
    await deps.worktreeRemove({ repoPath: payload.repoPath, worktreePath, force: true });
  }
}
