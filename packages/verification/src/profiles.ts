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
