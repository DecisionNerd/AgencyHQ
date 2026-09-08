/**
 * Revision manifest helpers for multi-repository work items.
 *
 * A RevisionManifest is an ordered list of integration targets; each entry
 * records one repository's expected base revision, the target ref, and the
 * result revision once integration is complete.
 *
 * These structural types mirror the field names that the parallel contracts
 * packet defines in RevisionManifestSchema / IntegrateMergeOutputSchema.
 * When that packet lands, import from @agencyhq/contracts and remove these
 * local definitions — they are shape-compatible by design so the merge
 * requires no edits.
 *
 * NOTE: `manifestDigestInput` and the contracts package's digest helper MUST
 * produce the same JSON string for the same entries.  The canonical form is:
 * entries sorted ascending by `position`, serialised without `resultRevision`,
 * stable JSON (no trailing whitespace, keys in insertion order).
 *
 * See: docs/REQUIREMENTS.md R-015
 */

// ---------------------------------------------------------------------------
// Local structural types (shape-compatible with contracts RevisionManifestSchema)
// ---------------------------------------------------------------------------

/**
 * One entry in the revision manifest.
 *
 * @field position            — 0-based ordinal; lower = integrated first.
 * @field projectId           — owning project.
 * @field targetRef           — the git ref to push the result to.
 * @field expectedBaseRevision — the SHA the coordinator expects before integration.
 * @field resultRevision      — null until the integration for this entry completes.
 */
export type ManifestEntry = {
  readonly position: number;
  readonly projectId: string;
  readonly targetRef: string;
  readonly expectedBaseRevision: string;
  readonly resultRevision: string | null;
};

/**
 * Possible outcomes from a single integration attempt.
 * Shape-compatible with contracts IntegrateMergeOutputSchema's outcome enum.
 */
export type IntegrateOutcome =
  | "integrated"
  | "already_integrated"
  | "base_moved"
  | "conflict"
  | "push_rejected";

// ---------------------------------------------------------------------------
// nextEntry
//
// Returns the next entry that needs integration: the entry with the lowest
// `position` where `resultRevision === null`.  Returns `undefined` when all
// entries are resolved.
// ---------------------------------------------------------------------------

export function nextEntry(entries: ManifestEntry[]): ManifestEntry | undefined {
  let result: ManifestEntry | undefined;
  for (const entry of entries) {
    if (entry.resultRevision !== null) continue;
    if (result === undefined || entry.position < result.position) {
      result = entry;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// allResolved
//
// Returns true when every entry in the manifest has a non-null resultRevision.
// An empty manifest is considered resolved (vacuously true).
// ---------------------------------------------------------------------------

export function allResolved(entries: ManifestEntry[]): boolean {
  return entries.every((e) => e.resultRevision !== null);
}

// ---------------------------------------------------------------------------
// manifestDigestInput
//
// Produces the canonical JSON string that both this package and the contracts
// package digest to produce the manifest fingerprint.
//
// Canonical form:
//   - Entries sorted ascending by `position`.
//   - Each entry serialised with only { position, projectId, targetRef,
//     expectedBaseRevision } — resultRevision is deliberately excluded so the
//     digest is stable across the integration lifecycle.
//   - JSON.stringify with no replacer and no spacing (compact, key insertion
//     order).
//
// The contracts package MUST produce the same string from the same entries.
// ---------------------------------------------------------------------------

export function manifestDigestInput(entries: ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  const forDigest = sorted.map(({ position, projectId, targetRef, expectedBaseRevision }) => ({
    position,
    projectId,
    targetRef,
    expectedBaseRevision,
  }));
  return JSON.stringify(forDigest);
}
