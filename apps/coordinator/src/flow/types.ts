/**
 * FlowDeps — shared dependencies injected into all flow components.
 */

import type { RuntimeProfile } from "@agencyhq/contracts";
import type { createPool } from "@agencyhq/db";
import type { Clock, ExecutionRuntime, IdGen } from "@agencyhq/domain";

// ---------------------------------------------------------------------------
// ProfileResolver
// ---------------------------------------------------------------------------

/**
 * Resolves a verification profile by its id, returning the digest and checks.
 * Decouples flow/payloads.ts from @agencyhq/verification.
 */
export type ProfileResolver = (profileId: string) => Promise<{
  digest: string;
  checks: { id: string; version: string; command: string[]; timeoutSeconds: number }[];
  protectedPaths: string[];
}>;

// ---------------------------------------------------------------------------
// Integration helpers (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Reads the current SHA at the given ref on the remote.
 * Returns null when the ref does not exist or the call fails.
 *
 * @param remote    Git remote name or URL.
 * @param targetRef Git ref to inspect (e.g. "refs/heads/main").
 * @param repoPath  Absolute path to the local clone.
 */
export type LsRemoteFn = (
  remote: string,
  targetRef: string,
  repoPath: string,
) => Promise<string | null>;

/**
 * Returns true when `revision` is reachable from the tip of `targetRef` on
 * the remote.  May fetch before checking.
 *
 * @param revision  The commit SHA to test for ancestry.
 * @param remote    Git remote name or URL.
 * @param targetRef Git ref to fetch and test against.
 * @param repoPath  Absolute path to the local clone.
 */
export type IsAncestorFn = (
  revision: string,
  remote: string,
  targetRef: string,
  repoPath: string,
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// FlowConfig
// ---------------------------------------------------------------------------

export interface FlowConfig {
  worktreeBase: string;
  workerModel: string;
  leadModel: string;
  reviewerModel: string;
  verifierName: string;
  leadVariant?: string | undefined;
  /** Milliseconds before a stop without evidence is classified uncertain. */
  uncertainAfterMs?: number | undefined;
  /**
   * Maximum number of compare-and-set retry attempts for integrate.merge
   * when the remote base has not moved (retry_cas outcome).
   * Default: 2.
   */
  integrateRetries?: number | undefined;
  /**
   * Number of concurrent worker slots.  Admission in onLeadPlanOutput queues
   * the worker intent (status='queued') when all slots are occupied; the
   * scheduler dispatches queued intents when a slot becomes free.
   * Default: 1.
   */
  workerSlots?: number | undefined;
}

// ---------------------------------------------------------------------------
// FlowDeps
// ---------------------------------------------------------------------------

export interface FlowDeps {
  pool: ReturnType<typeof createPool>;
  runtime: ExecutionRuntime;
  clock: Clock;
  ids: IdGen;
  profile: RuntimeProfile;
  config: FlowConfig;
  profileResolver: ProfileResolver;
  /**
   * Injectable: reads the current SHA at a remote ref.
   * Defaults to the real git ls-remote implementation.
   */
  lsRemote?: LsRemoteFn | undefined;
  /**
   * Injectable: returns true when revision is an ancestor of the remote ref.
   * Defaults to the real git fetch + merge-base --is-ancestor implementation.
   */
  isAncestor?: IsAncestorFn | undefined;
}
