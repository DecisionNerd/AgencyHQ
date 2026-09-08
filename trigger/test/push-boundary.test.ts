// Test 7 from packet 4.1.d: invariant that only integrate-merge* and lib/git.ts
// contain git push functionality in trigger/src.
//
// The only known exception is trigger/src/lib/env.ts which contains
// `assertPushBlocked` — a control function that verifies a push IS blocked
// using --dry-run.  That is a test/verification helper, not an actual push.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve trigger/src directory relative to this test file.
const triggerSrcDir = join(fileURLToPath(import.meta.url), "../../src");

test('no helper outside integrate-merge* and lib/git.ts contains "push" as a git subcommand', async () => {
  // Grep for the string literal "push" (the git subcommand) in all .ts files
  // under trigger/src.
  let grepOutput = "";
  try {
    const { stdout } = await execFileAsync("grep", ["-rln", '"push"', "."], { cwd: triggerSrcDir });
    grepOutput = stdout;
  } catch (err: unknown) {
    // grep exits with 1 when no matches — that's fine.
    const execErr = err as { code?: number | string };
    if (execErr.code === 1) {
      // No matches at all.
      return;
    }
    throw err;
  }

  const matchedFiles = grepOutput
    .trim()
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  // Files that are allowed to contain "push":
  const allowedPatterns = [
    // The integration task and its core — the only actual pusher.
    "integrate-merge",
    // The git helper library — pushForceWithLease lives here.
    "lib/git.ts",
    // Known exception: assertPushBlocked uses git push --dry-run as a
    // control check, not as an actual push.
    "lib/env.ts",
  ];

  const forbidden = matchedFiles.filter((file) => {
    const normalised = file.replace(/\\/g, "/");
    return !allowedPatterns.some((allowed) => normalised.includes(allowed));
  });

  assert.deepEqual(
    forbidden,
    [],
    `"push" command found in unexpected files under trigger/src: ${forbidden.join(", ")}`,
  );
});
