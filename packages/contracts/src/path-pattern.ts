/**
 * Path-pattern grammar and subset checks for the delegated-authority model.
 *
 * Grammar (POSIX, repo-relative):
 *   pattern  = segment ("/" segment)*
 *   segment  = "**"                         -- whole-segment double-star
 *             | [A-Za-z0-9._\-*?]+           -- chars, single-star, question-mark
 *
 * Semantics match trigger/src/lib/paths.ts globToRegExp:
 *   "*"  →  [^/]*   (any sequence of non-slash chars)
 *   "**" →  .*      (any sequence including slashes)
 *   "?"  →  [^/]    (one non-slash char)
 *   else →  literal (regex-escaped)
 *
 * Rejected: absolute paths, ".." segments, empty segments, backslashes, "./" prefix,
 *           trailing "/".
 */

// Nominal branding so PathPattern is not assignable from plain string.
declare const __pathPattern: unique symbol;
/**
 * A validated, repo-relative POSIX glob pattern.
 * Obtain one via `parsePathPattern`; do not cast arbitrarily.
 */
export type PathPattern = string & { readonly [__pathPattern]: true };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SEGMENT_RE = /^[A-Za-z0-9._\-*?]+$/;

/**
 * Parse and validate `s` as a `PathPattern`.
 * Throws on any structural violation.
 */
export function parsePathPattern(s: string): PathPattern {
  if (s === "") throw new Error("pattern must not be empty");
  if (s.includes("\\")) throw new Error("backslashes are not allowed in patterns");
  if (s.startsWith("/")) throw new Error("pattern must not be an absolute path");
  if (s.startsWith("./")) throw new Error('pattern must not start with "./"');
  if (s.endsWith("/")) throw new Error('pattern must not have a trailing "/"');

  const segs = s.split("/");
  for (const seg of segs) {
    if (seg === "") throw new Error("pattern must not contain empty segments");
    if (seg === "..") throw new Error('pattern must not contain ".." segments');
    if (seg === "**") continue; // whole-segment double-star is valid
    if (!SEGMENT_RE.test(seg)) {
      throw new Error(`invalid segment "${seg}": only [A-Za-z0-9._\\-*?] are allowed`);
    }
  }

  return s as PathPattern;
}

// ---------------------------------------------------------------------------
// Matching  (same semantics as trigger/src/lib/paths.ts globToRegExp)
// ---------------------------------------------------------------------------

function patternToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      // Escape regex metacharacters in the literal character.
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Returns `true` iff `path` matches `pattern`. */
export function matchesPath(pattern: PathPattern, path: string): boolean {
  return patternToRegex(pattern).test(path);
}

// ---------------------------------------------------------------------------
// Subset checks
// ---------------------------------------------------------------------------

/**
 * Compile a *non-`**`* segment pattern into an anchored RegExp for literal
 * matching: used only to check whether a pure-literal segment string satisfies
 * a segment wildcard pattern.
 */
function segToRegex(seg: string): RegExp {
  let source = "";
  for (const ch of seg) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Returns `true` iff every concrete (non-slash) string matched by the *segment*
 * pattern `nSeg` is also matched by the *segment* pattern `wSeg`.
 *
 * Coverage table (spec §path-pattern.ts, following ADR-0006):
 *   literal → literal (equal)  ✓
 *   literal → `*`              ✓
 *   literal → `?`              ✓ iff literal.length === 1
 *   literal → mixed pattern    ✓ iff literal matches pattern
 *   `?`     → `?`              ✓
 *   `?`     → `*`              ✓
 *   `*`     → `*`              ✓
 *   anything→ `*`              ✓  (caught first)
 *   (other cases)              conservative false — no false positives
 *
 * `**` is never passed here; it is handled at the sequence level.
 */
function segmentCoveredBy(nSeg: string, wSeg: string): boolean {
  if (nSeg === wSeg) return true;
  if (wSeg === "*") return true; // * matches any non-slash string

  const nHasWild = /[*?]/.test(nSeg);

  if (!nHasWild) {
    // nSeg is a pure literal; the only string it "matches" is itself.
    if (wSeg === "?") return nSeg.length === 1;
    // wSeg has wildcards — check if the literal satisfies the pattern.
    return segToRegex(wSeg).test(nSeg);
  }

  // nSeg has wildcards.  Only exact match (handled above) or wSeg === "*"
  // (handled above) are safe to confirm.  Being conservative avoids false
  // positives; being wrong here is acceptable per spec (brute-force check
  // catches any actual failure).
  return false;
}

/**
 * Recursive segment-sequence subset check with backtracking on `**`.
 *
 * Invariant: returns `true` iff every concrete path produced by expanding
 * `ns[ni..]` is also produced by expanding `ws[wi..]`.
 *
 * When `wSeg === "**"` we try consuming 0, 1, …, remaining narrow segments
 * with this single wide `**` and recurse on the rest; the first branch that
 * succeeds for ALL continuations is taken.  (Narrow `**` segments are skipped
 * as part of the count because wide's `**` absorbs them too.)
 *
 * When `nSeg === "**"` but `wSeg !== "**"` we return `false` immediately:
 * no literal-or-single-star segment can cover an unbounded `**`.
 */
function subsetSegs(ns: string[], ni: number, ws: string[], wi: number): boolean {
  if (ni === ns.length && wi === ws.length) return true;
  if (wi === ws.length) return false; // wide exhausted, narrow is not

  const wSeg = ws[wi] ?? "";

  if (wSeg === "**") {
    // Try consuming 0, 1, 2, … of narrow's remaining segments with wide's **,
    // including narrow ** segments (which also match arbitrarily many path levels).
    for (let count = 0; ni + count <= ns.length; count++) {
      if (subsetSegs(ns, ni + count, ws, wi + 1)) return true;
    }
    return false;
  }

  // wSeg is a regular (non-**) segment.
  if (ni === ns.length) return false; // narrow exhausted, wide still has segments

  const nSeg = ns[ni] ?? "";

  // narrow ** cannot be covered by a non-** wide segment.
  if (nSeg === "**") return false;

  if (!segmentCoveredBy(nSeg, wSeg)) return false;

  return subsetSegs(ns, ni + 1, ws, wi + 1);
}

/**
 * Returns `true` iff every path matched by `narrow` is also matched by `wide`.
 *
 * Implemented decidably for the restricted grammar via segment-wise structural
 * analysis with backtracking on `**`.  The algorithm is sound (never returns
 * `true` when the answer is `false`) and complete for the common patterns in
 * the authority model; conservative cases are documented in `segmentCoveredBy`.
 */
export function patternSubset(narrow: PathPattern, wide: PathPattern): boolean {
  return subsetSegs(narrow.split("/"), 0, wide.split("/"), 0);
}

/**
 * Returns `true` iff every pattern in `narrow` is a subset of at least one
 * pattern in `wide`.
 *
 * **Conservative**: this is a pattern-level check, not a union-level check.
 * A narrow set that is covered only by the *union* of several wide patterns —
 * but by no single wide pattern — will return `false`.  This is intentional:
 * the safe direction for authority narrowing is to require each narrow pattern
 * to be explicitly covered by a single wide pattern.
 */
export function pathSetSubset(narrow: PathPattern[], wide: PathPattern[]): boolean {
  return narrow.every((np) => wide.some((wp) => patternSubset(np, wp)));
}

/**
 * Returns `true` iff every wide deny pattern is covered by at least one narrow
 * deny pattern — i.e. the inner (narrow) deny set denies at least everything
 * the outer (wide) deny set denies.
 *
 * Authority narrowing requires deny sets to *grow*: the inner principal must
 * deny at least everything the outer principal denies.
 */
export function denySetCovers(narrowDeny: PathPattern[], wideDeny: PathPattern[]): boolean {
  return wideDeny.every((wp) => narrowDeny.some((np) => patternSubset(wp, np)));
}
