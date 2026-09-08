/**
 * Authority update proposal and frozen-contract invariant.
 *
 * R-018: Contract repair shall supersede, never rebind; evidence and Reviews
 * do not transfer across versions.
 *
 * An authority update changes the project-level delegated-authority schema
 * that governs *future* lead proposals.  It never mutates an existing
 * StepContract's bounds or digests — those are frozen at freeze time and can
 * only change through supersede().
 */

import type { Authority, StepContract } from "@agencyhq/contracts";
import { AuthoritySchema } from "@agencyhq/contracts";

import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** A single Zod validation issue (opaque; callers inspect `message`). */
export type ParseIssue = {
  readonly message: string;
  readonly [key: string]: unknown;
};

export type AuthorityUpdateError =
  | { readonly kind: "parse_error"; readonly issues: ParseIssue[] }
  | { readonly kind: "version_not_greater" };

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Parse the leading integer from a version string.
 *
 * Supports bare integers ("1", "2") and strings that start with digits
 * ("2.1.0", "v3").  Returns 0 for strings that do not start with a digit.
 */
function parseVersionNumber(version: string): number {
  const match = version.replace(/^v/i, "").match(/^(\d+)/);
  return match && match[1] !== undefined ? parseInt(match[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// proposeAuthorityUpdate
// ---------------------------------------------------------------------------

/**
 * Validates and accepts an authority update proposal.
 *
 * Returns Ok({ version, authority }) when:
 *   1. `next` parses successfully with AuthoritySchema.
 *   2. The numeric part of `next.version` is strictly greater than the
 *      numeric part of `current.version`.
 *
 * Returns Err on parse failure (kind: "parse_error") or when the version is
 * not greater (kind: "version_not_greater").
 *
 * The returned `version` is the `version` field from the parsed authority, so
 * the project's authorityVersion can be updated atomically with the authority
 * schema itself.
 */
export function proposeAuthorityUpdate(
  current: { readonly version: string; readonly authority: Authority },
  next: unknown,
): Result<{ version: string; authority: Authority }, AuthorityUpdateError> {
  const parsed = AuthoritySchema.safeParse(next);
  if (!parsed.success) {
    return err({ kind: "parse_error", issues: parsed.error.issues as unknown as ParseIssue[] });
  }

  const nextAuthority = parsed.data;
  const currentNum = parseVersionNumber(current.version);
  const nextNum = parseVersionNumber(nextAuthority.version);

  if (nextNum <= currentNum) {
    return err({ kind: "version_not_greater" });
  }

  return ok({ version: nextAuthority.version, authority: nextAuthority });
}

// ---------------------------------------------------------------------------
// frozenContractsUnaffected
// ---------------------------------------------------------------------------

/**
 * Returns `true` always.
 *
 * Documents the R-018 invariant: an authority update never mutates an existing
 * StepContract's bounds or digests.  The authority schema governs only *future*
 * lead proposals — specifically, what the Lead is allowed to propose in its
 * next call to `checkProposal`.  Once a contract is frozen via `freezeContract`,
 * its `bounds`, `criteriaDigest`, and `profileDigest` are immutable.  The only
 * path to a new version of those fields is `supersede()`, which creates a new
 * StepContract with an incremented version number.
 *
 * Callers can verify this invariant by comparing `contract.bounds` before and
 * after applying an authority update: they must be deep-equal.  The table test
 * in `authority.update.test.ts` exercises this property explicitly.
 */
export function frozenContractsUnaffected(_contract: StepContract, _newAuthority: Authority): true {
  return true;
}
