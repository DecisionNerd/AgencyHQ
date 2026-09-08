// Pure helpers for combined verification across revision manifest entries.
// No Trigger SDK usage; no direct child_process/fs calls.
//
// Used by verify-run-core.ts to identify sibling entries and build the
// environment variable map that the manifest-consumer check protocol requires.
//
// See: docs/REQUIREMENTS.md R-006 (combined verification)
// See: docs/engineering/DOMAIN_MODEL.md (revision manifests)

import type { ManifestEntry } from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// siblingEntries
// ---------------------------------------------------------------------------

/**
 * Return all manifest entries except the one belonging to the given projectId.
 *
 * In combined verification the entry being verified is the current project;
 * its siblings are all other entries. The coordinator supplies this function's
 * result as the set of repos to materialize.
 *
 * @param entries  All entries from a RevisionManifest.
 * @param projectId  The projectId of the project currently under verification.
 */
export function siblingEntries(
  entries: readonly ManifestEntry[],
  projectId: string,
): ManifestEntry[] {
  return entries.filter((e) => e.projectId !== projectId);
}

// ---------------------------------------------------------------------------
// manifestEnv
// ---------------------------------------------------------------------------

/**
 * Build the environment variable map for combined verification.
 *
 * Each sibling entry at position N produces:
 *   AGENCYHQ_MANIFEST_<N> = <absolute path to its materialized worktree>
 *
 * Plus:
 *   AGENCYHQ_MANIFEST_DIGEST = <manifest plan digest>
 *
 * The check receives these variables in its environment so it can locate
 * every sibling repo at its committed revision.
 *
 * @param entries   Sibling manifest entries (already filtered to exclude the current project).
 * @param paths     Map from position (integer key) to the absolute worktree path
 *                  materialized for that sibling.
 * @param digest    The manifest plan digest (RevisionManifest.digest).
 */
export function manifestEnv(
  entries: readonly ManifestEntry[],
  paths: Record<number, string>,
  digest: string,
): Record<string, string> {
  const env: Record<string, string> = {
    AGENCYHQ_MANIFEST_DIGEST: digest,
  };
  for (const entry of entries) {
    const p = paths[entry.position];
    if (p !== undefined) {
      env[`AGENCYHQ_MANIFEST_${entry.position}`] = p;
    }
  }
  return env;
}
