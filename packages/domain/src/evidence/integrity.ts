/**
 * Evidence integrity: verifier-tampering detection.
 *
 * Any change to an approved verifier or its configuration inside the diff
 * is a Review-blocking finding until the profile is re-versioned.
 * See: docs/engineering/TESTING.md §67-73.
 *
 * Protected paths cover verifier infrastructure only (package managers, CI
 * pipelines, TypeScript config, linter config, and test-runner configs).
 * Test source files (test/**, tests/**, *.test.*, *.spec.*) are NOT protected
 * here: weakened or removed tests are the adversarial reviewer's job and are
 * governed by the contract's paths.allow; they do not trigger tampering
 * findings.
 */

import { matchesPath, parsePathPattern } from "@agencyhq/contracts";
import type { FindingLike } from "./types.ts";

// ---------------------------------------------------------------------------
// DEFAULT_PROTECTED_PATHS
// Paths that, if changed by the worker, indicate potential verifier tampering.
// Test source files are intentionally absent — see module comment above.
// ---------------------------------------------------------------------------
export const DEFAULT_PROTECTED_PATHS: string[] = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig*.json",
  "biome.json",
  ".github/**",
  "**/vitest.config.*",
  "**/jest.config.*",
];

// ---------------------------------------------------------------------------
// detectVerifierTampering
// Returns one blocking FindingLike per changed path matching any protected
// pattern.  Multiple matches against the same path produce one finding per
// matching protected pattern (conservative — raises every violation).
// ---------------------------------------------------------------------------
export function detectVerifierTampering(
  changedPaths: string[],
  protectedPaths: string[] = DEFAULT_PROTECTED_PATHS,
): FindingLike[] {
  const findings: FindingLike[] = [];
  let findingIdx = 0;

  // Parse patterns once; skip any that fail validation.
  const patterns = protectedPaths.flatMap((p) => {
    try {
      return [parsePathPattern(p)];
    } catch {
      return [];
    }
  });

  for (const path of changedPaths) {
    for (const pattern of patterns) {
      if (matchesPath(pattern, path)) {
        findingIdx++;
        findings.push({
          id: `verifier-tamper-${findingIdx}`,
          severity: "blocking",
          kind: "verifier_tampered",
          description: `Changed path "${path}" matches protected pattern "${pattern}". Any change to an approved verifier or its configuration is Review-blocking until the profile is re-versioned.`,
          evidence: `path:${path} pattern:${pattern}`,
        });
        // One finding per matched pattern (conservative).
      }
    }
  }

  return findings;
}
