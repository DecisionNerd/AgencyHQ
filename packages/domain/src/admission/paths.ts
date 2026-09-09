/**
 * Path admission validator.
 *
 * validateChangedPaths checks that all paths in a worker-submitted changed-path
 * list are safe to process: no traversal, no absolute paths, no control chars,
 * no ambiguous prefixes.
 *
 * Returns Ok(true) on success or Err("PATH_UNSAFE") on the first failing path.
 * Order-stable: the first path that fails determines the error; subsequent
 * paths are not evaluated (fail-fast).
 *
 * Pure function — no I/O, no imports beyond result.ts.
 */

import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

export type PathUnsafeCode = "PATH_UNSAFE";

/**
 * Validate a list of changed paths submitted by a worker container.
 *
 * A path is rejected if it:
 * - is empty
 * - is absolute (starts with /)
 * - contains .. as a path segment
 * - contains backslashes (Windows path separator)
 * - contains a NUL byte
 * - starts with ./ (redundant current-dir prefix)
 * - ends with / (looks like a directory)
 * - has .git/ as a prefix (guard the git directory itself)
 *
 * The entire list is rejected if it is empty — UNLESS `allowEmpty` is true.
 * Pass `allowEmpty: true` for checkpoint artifacts (D3: a zero-change checkpoint
 * is valid; the empty-diff digest is the sha256 of the empty string).
 */
export function validateChangedPaths(
  paths: readonly string[],
  opts?: { allowEmpty?: boolean },
): Result<true, PathUnsafeCode> {
  if (paths.length === 0) {
    if (opts?.allowEmpty) return ok(true as const);
    return err("PATH_UNSAFE");
  }

  for (const p of paths) {
    if (!isSafePath(p)) {
      return err("PATH_UNSAFE");
    }
  }

  return ok(true as const);
}

/**
 * Returns true iff `p` is a safe relative path.
 * Exported for property-based tests.
 */
export function isSafePath(p: string): boolean {
  // Must be non-empty
  if (p.length === 0) return false;
  // No NUL bytes
  if (p.includes("\0")) return false;
  // No backslashes
  if (p.includes("\\")) return false;
  // Must not be absolute
  if (p.startsWith("/")) return false;
  // Must not start with ./
  if (p.startsWith("./")) return false;
  // Must not end with /
  if (p.endsWith("/")) return false;
  // Must not start with .git/
  if (p.startsWith(".git/") || p === ".git") return false;
  // No .. as a segment
  const segments = p.split("/");
  for (const seg of segments) {
    // Reject bare .. (parent dir) and bare . (current dir)
    if (seg === ".." || seg === ".") return false;
  }
  return true;
}
