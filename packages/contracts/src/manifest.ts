/**
 * RevisionManifest schema for AgencyHQ.
 *
 * A revision manifest covers the full set of repositories touched by a
 * multi-repository WorkItem. Each entry records the planned target ref, the
 * expected base revision (the tip the coordinator will compare-and-set
 * against), and the result revision once integration completes.
 *
 * The manifest digest is computed from entries excluding resultRevision so
 * it identifies the plan rather than its progress. This digest is stable
 * throughout the WorkItem's lifecycle even as entries receive their result
 * revisions.
 *
 * See: docs/engineering/DOMAIN_MODEL.md (revision manifests, boundaries)
 * See: docs/REQUIREMENTS.md R-015 (integration compare-and-set)
 */

import { z } from "zod";

import { digestOf } from "./digest.ts";

// ---------------------------------------------------------------------------
// Hex revision helper (40 lower-case hex characters)
// ---------------------------------------------------------------------------
export const HexRevision40Schema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-hex git revision");

// ---------------------------------------------------------------------------
// ManifestEntrySchema
// ---------------------------------------------------------------------------
export const ManifestEntrySchema = z.object({
  /**
   * Zero-based position in the manifest; positions must form an unbroken
   * 0..n-1 sequence with no duplicates.
   */
  position: z.int().gte(0),
  projectId: z.string().min(1),
  /** Git ref to push to (e.g. "refs/heads/main"). */
  targetRef: z.string().min(1),
  /**
   * The commit SHA the coordinator expects at targetRef before pushing.
   * Integration is compare-and-set: if the ref has moved, the outcome is
   * base_moved.
   */
  expectedBaseRevision: HexRevision40Schema,
  /**
   * The commit SHA resulting from a successful integration, or null while
   * the entry is still pending. Excluded from the digest.
   */
  resultRevision: HexRevision40Schema.nullable(),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

// ---------------------------------------------------------------------------
// manifestDigest
// ---------------------------------------------------------------------------

/**
 * Compute the canonical digest that identifies a revision manifest's plan.
 *
 * The digest is computed over entries sorted by position with `resultRevision`
 * excluded. This makes the digest stable across integration progress: the same
 * plan always yields the same digest regardless of how many entries have been
 * integrated.
 *
 * The digest is order-sensitive with respect to position: swapping the
 * projectId/targetRef/expectedBaseRevision of two positions produces a
 * different digest.
 */
export function manifestDigest(entries: readonly ManifestEntry[]): `sha256:${string}` {
  const ordered = [...entries]
    .sort((a, b) => a.position - b.position)
    .map(({ position, projectId, targetRef, expectedBaseRevision }) => ({
      position,
      projectId,
      targetRef,
      expectedBaseRevision,
    }));
  return digestOf(ordered);
}

// ---------------------------------------------------------------------------
// RevisionManifestSchema
// ---------------------------------------------------------------------------

export const RevisionManifestSchema = z
  .object({
    entries: z.array(ManifestEntrySchema),
    /**
     * Canonical digest of the manifest plan (excludes resultRevision).
     * Must equal manifestDigest(entries).
     */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .refine(
    (data) => {
      // Positions must be exactly 0..n-1 with no duplicates
      const n = data.entries.length;
      const positions = new Set(data.entries.map((e) => e.position));
      if (positions.size !== n) return false;
      for (let i = 0; i < n; i++) {
        if (!positions.has(i)) return false;
      }
      return true;
    },
    { message: "Entry positions must be 0..n-1 with no duplicates" },
  )
  .refine((data) => data.digest === manifestDigest(data.entries), {
    message: "digest must equal manifestDigest(entries)",
  });

export type RevisionManifest = z.infer<typeof RevisionManifestSchema>;
