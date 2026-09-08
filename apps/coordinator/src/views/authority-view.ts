/**
 * Authority view: current version + history from authority_versions.
 *
 * DESIGN.md: authority editor with version and confirmation.
 * R-017: disposition/authority changes never mutate an existing contract.
 *
 * Pure builder — no database access.
 */

import type { Authority } from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type AuthorityVersionLike = {
  version: string;
  authority: Authority;
  actor: string;
  at: string;
};

export type AuthorityViewInput = {
  projectId: string;
  currentVersion: string;
  currentAuthority: Authority;
  history: AuthorityVersionLike[];
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type AuthorityVersionEntry = {
  version: string;
  authority: Authority;
  actor: string;
  at: string;
};

export type AuthorityView = {
  projectId: string;
  currentVersion: string;
  authority: Authority;
  history: AuthorityVersionEntry[];
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the authority view for a single project.
 * Pure function — no side effects.
 */
export function buildAuthorityView(input: AuthorityViewInput): AuthorityView {
  return {
    projectId: input.projectId,
    currentVersion: input.currentVersion,
    authority: input.currentAuthority,
    history: input.history.map((h) => ({
      version: h.version,
      authority: h.authority,
      actor: h.actor,
      at: h.at,
    })),
  };
}
