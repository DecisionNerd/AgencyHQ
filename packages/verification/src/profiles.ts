/**
 * Verification profile catalog for @agencyhq/verification.
 *
 * Profiles are frozen into the StepContract by digest before dispatch.
 * The profileDigest is stable regardless of property insertion order
 * because digestOf uses canonicalJson (sorted keys).
 */

import type { Digest } from "@agencyhq/contracts";
import { digestOf } from "@agencyhq/contracts";

import { DEFAULT_PROTECTED_PATHS } from "@agencyhq/domain";

import { CHECK_CATALOG } from "./checks.ts";

export type VerificationProfile = {
  /** Unique identifier for this profile. */
  id: string;
  /** Version string; increment when checks or protectedPaths change. */
  version: string;
  /**
   * Ordered list of catalog check ids (e.g. "pnpm-typecheck@1").
   * runProfile executes them in order.
   */
  checks: string[];
  /**
   * Path-pattern globs.  Any worker diff touching these paths is a
   * Review-blocking finding.  Defaults to DEFAULT_PROTECTED_PATHS.
   */
  protectedPaths: string[];
};

// ---------------------------------------------------------------------------
// PROFILE_CATALOG
// ---------------------------------------------------------------------------

export const PROFILE_CATALOG: Record<string, VerificationProfile> = {
  "node-pnpm-v1": {
    id: "node-pnpm-v1",
    version: "2",
    checks: ["pnpm-typecheck@1", "pnpm-test@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },
  "docs-check-v1": {
    id: "docs-check-v1",
    version: "2",
    checks: ["pnpm-check@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },
  "minimal-v1": {
    id: "minimal-v1",
    version: "2",
    checks: ["git-diff-clean@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },
  /**
   * multi-repo-v1: verifies that a multi-repository WorkItem is complete.
   *
   * Runs pnpm typecheck first, then manifest-consumer@1 which:
   * 1. Asserts at least one AGENCYHQ_MANIFEST_<N> env var is set and points
   *    to an existing directory (fails with manifest_missing otherwise).
   * 2. Runs the project's pnpm test.
   *
   * Use this profile when the coordinator has assembled a manifest of sibling
   * worktrees so the check environment can assert cross-repo consistency.
   *
   * R-006, R-014.
   *
   * FROZEN: v1 digests are recorded in StepContracts already dispatched.
   * Add pnpm-install@1 to multi-repo-v2 instead.
   */
  "multi-repo-v1": {
    id: "multi-repo-v1",
    version: "1",
    checks: ["pnpm-typecheck@1", "manifest-consumer@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },
  // ---------------------------------------------------------------------------
  // v2 profiles — introduced 2026-09-08
  //
  // v1 profiles are frozen: existing StepContracts reference their digests and
  // must continue to resolve without change.  v2 adds pnpm-install@1 as the
  // first check so that fresh git worktrees (which have no node_modules) always
  // install dependencies explicitly before typecheck or test runs.  Without this
  // explicit install, the verification task relied on pnpm's implicit
  // auto-install, which is unreliable inside the task process and caused live
  // failures with TS2688 ("Cannot find type definition file for 'node'").
  // ---------------------------------------------------------------------------

  /**
   * node-pnpm-v2: standard Node/pnpm profile with explicit dependency install.
   *
   * Checks (in order):
   * 1. pnpm-install@1  — installs from lockfile; fails if lockfile is stale.
   * 2. pnpm-typecheck@1 — TypeScript type check.
   * 3. pnpm-test@1     — unit test suite.
   *
   * Supersedes node-pnpm-v1.  Use for new StepContracts on Node/pnpm repos.
   */
  "node-pnpm-v2": {
    id: "node-pnpm-v2",
    version: "1",
    checks: ["pnpm-install@1", "pnpm-typecheck@1", "pnpm-test@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },

  /**
   * multi-repo-v2: multi-repository profile with explicit dependency install.
   *
   * Checks (in order):
   * 1. pnpm-install@1      — installs from lockfile; fails if lockfile is stale.
   * 2. pnpm-typecheck@1    — TypeScript type check.
   * 3. manifest-consumer@1 — asserts manifest env vars and runs pnpm test.
   *
   * Supersedes multi-repo-v1.  Use for new StepContracts when the coordinator
   * has assembled a manifest of sibling worktrees.  R-006, R-014.
   */
  "multi-repo-v2": {
    id: "multi-repo-v2",
    version: "1",
    checks: ["pnpm-install@1", "pnpm-typecheck@1", "manifest-consumer@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },

  /**
   * fixture-node-v1: proves the task image toolchain against a public fixture
   * repository.
   *
   * This profile is used exclusively by the `image.smoke` task (introduced in
   * P16.2) to verify that the deployed task container image contains a working
   * Node/pnpm/git toolchain.  It is NOT used for production StepContracts.
   *
   * The smoke task clones a public fixture repository inside the container,
   * then runs this profile's checks in the cloned directory.  A passing run
   * proves that:
   *  - pnpm is on PATH and can install from a lockfile (pnpm-install@1)
   *  - TypeScript type-checking works (pnpm-typecheck@1)
   *  - The test suite runs successfully (pnpm-test@1)
   *
   * Checks (in order):
   * 1. pnpm-install@1  — installs from lockfile; fails if lockfile is stale.
   * 2. pnpm-typecheck@1 — TypeScript type check.
   * 3. pnpm-test@1     — unit test suite.
   *
   * Same checks and protectedPaths as node-pnpm-v2 so the image smoke
   * exercises the same toolchain gates as production verification.
   * #16 BDD 2 — container integration test.
   */
  "fixture-node-v1": {
    id: "fixture-node-v1",
    version: "1",
    checks: ["pnpm-install@1", "pnpm-typecheck@1", "pnpm-test@1"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  },
};

// ---------------------------------------------------------------------------
// profileDigest
// ---------------------------------------------------------------------------

/**
 * Return a deterministic digest for `profile`.
 *
 * The digest is computed over a canonical object that includes the resolved
 * check versions from the catalog, so it changes whenever a check is bumped
 * even if only the catalog entry changes.
 *
 * Property key order is irrelevant: digestOf uses canonicalJson (sorted keys).
 */
export function profileDigest(profile: VerificationProfile): Digest {
  const checksWithVersions = profile.checks.map((checkId) => {
    const def = CHECK_CATALOG[checkId];
    if (def === undefined) {
      throw new Error(`profileDigest: unknown check id "${checkId}"`);
    }
    return `${def.id}@${def.version}`;
  });

  return digestOf({
    id: profile.id,
    version: profile.version,
    checks: checksWithVersions,
    protectedPaths: profile.protectedPaths,
  });
}

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

/**
 * Look up a profile by id.
 * Throws if the id is not in the catalog.
 */
export function resolveProfile(id: string): VerificationProfile {
  const profile = PROFILE_CATALOG[id];
  if (profile === undefined) {
    throw new Error(`resolveProfile: unknown profile id "${id}"`);
  }
  return profile;
}
