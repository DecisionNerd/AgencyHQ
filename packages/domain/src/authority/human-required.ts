/**
 * Human-approval determination for AgencyHQ authority model.
 *
 * Computed from the ASSEMBLED BOUNDS (ContractBounds), never from the
 * proposal's claimed class alone. This ensures that authority checks
 * run before approval gates are evaluated.
 *
 * See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
 * See: docs/engineering/TESTING.md humanRequired
 */

import type { Authority, ContractBounds } from "@agencyhq/contracts";
import { parsePathPattern, patternSubset } from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// patternIntersects
//
// Returns true iff patterns `a` and `b` could match at least one common
// concrete path. The implementation is conservative — may return true when
// the true intersection is empty, but never returns false when an intersection
// exists.
//
// Strategy (in order):
//   1. a ⊆ b (patternSubset): every path matching a also matches b → intersect.
//   2. b ⊆ a (patternSubset): every path matching b also matches a → intersect.
//   3. Shared literal prefix: if both patterns share the same leading literal
//      segments (no wildcards) they can match a common path. Conservative: any
//      shared literal prefix is treated as a potential intersection.
//
// Rationale: false positives (extra human-approval gates) are acceptable;
// false negatives (missing required gates) are not.
// ---------------------------------------------------------------------------

function patternIntersects(a: string, b: string): boolean {
  let pa: ReturnType<typeof parsePathPattern>;
  let pb: ReturnType<typeof parsePathPattern>;
  try {
    pa = parsePathPattern(a);
    pb = parsePathPattern(b);
  } catch {
    // Unparseable pattern — treat as potentially intersecting (conservative).
    return true;
  }

  if (patternSubset(pa, pb)) return true;
  if (patternSubset(pb, pa)) return true;

  // Shared literal-prefix check: compare segment-by-segment until one hits
  // a wildcard or a mismatch.
  const segsA = a.split("/");
  const segsB = b.split("/");
  const minLen = Math.min(segsA.length, segsB.length);
  for (let i = 0; i < minLen; i++) {
    const sa = segsA[i] ?? "";
    const sb = segsB[i] ?? "";
    if (sa === "**" || sb === "**") {
      // Double-star absorbs everything — definitely intersects.
      return true;
    }
    const aWild = /[*?]/.test(sa);
    const bWild = /[*?]/.test(sb);
    if (!aWild && !bWild) {
      // Both literal segments: they must be equal to share a path.
      if (sa !== sb) return false;
    } else {
      // At least one wildcard segment — conservative: treat as intersecting.
      return true;
    }
  }
  // Exhausted the shorter pattern's segments; if the longer continues, both
  // can still match a concrete path if the shorter was a prefix — conservative true.
  return true;
}

// ---------------------------------------------------------------------------
// requiresApproval
//
// Determines whether a contract requires a human Approval before completion.
// Returns required:true and a non-empty reasons list when any gate fires.
//
// Gates (from Authority.humanRequired schema):
//   1. Path intersection: any allow pattern in bounds intersects any pattern in
//      humanRequired.paths — computed conservatively by patternIntersects.
//   2. Change class: bounds.changeClass is in humanRequired.changeClasses.
//   3. Boundary: bounds.boundary is in humanRequired.boundaries.
//
// Note: computed from BOUNDS, not from the proposal's claimed class alone.
// ---------------------------------------------------------------------------

export function requiresApproval(
  schema: Authority,
  bounds: ContractBounds,
): { required: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Gate 1: path intersection
  for (const allowPattern of bounds.paths.allow) {
    for (const humanPath of schema.humanRequired.paths) {
      if (patternIntersects(allowPattern, humanPath)) {
        reasons.push(
          `Allow pattern "${allowPattern}" intersects human-required path pattern "${humanPath}"`,
        );
        break; // one intersection per allow pattern is enough
      }
    }
  }

  // Gate 2: change class
  if (schema.humanRequired.changeClasses.includes(bounds.changeClass)) {
    reasons.push(`Change class "${bounds.changeClass}" requires human approval`);
  }

  // Gate 3: boundary
  if (schema.humanRequired.boundaries.includes(bounds.boundary)) {
    reasons.push(`Boundary "${bounds.boundary}" requires human approval`);
  }

  return { required: reasons.length > 0, reasons };
}
