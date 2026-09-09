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

// P18.3 push-boundary extension: v2 adapters (broker, runtime, source,
// artifact-upload, evidence) must contain no git push code paths.
test("P18.3 v2 lib modules contain no git push code paths", async () => {
  const V2_MODULES = [
    "lib/broker.ts",
    "lib/runtime.ts",
    "lib/source.ts",
    "lib/artifact-upload.ts",
    "lib/evidence.ts",
  ];

  let grepOutput = "";
  try {
    const { stdout } = await execFileAsync("grep", ["-rln", '"push"', "."], { cwd: triggerSrcDir });
    grepOutput = stdout;
  } catch (err: unknown) {
    const execErr = err as { code?: number | string };
    if (execErr.code === 1) {
      return; // no matches at all
    }
    throw err;
  }

  const matchedFiles = grepOutput
    .trim()
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const v2Violations = matchedFiles.filter((file) => {
    const normalised = file.replace(/\\/g, "/");
    return V2_MODULES.some((mod) => normalised.includes(mod));
  });

  assert.deepEqual(
    v2Violations,
    [],
    `"push" found in v2 lib modules (must never push): ${v2Violations.join(", ")}`,
  );
});

// Integrate adapter must refuse to push without an integrate lease.
// This is enforced structurally: pushForceWithLease in lib/git.ts is only
// called from integrate-merge.ts, and that file checks for an integrate lease
// before calling it. The test above (no "push" outside allowed files) already
// enforces this at the source level. Here we add an explicit note that:
//   - worker-attempt (host and v2) has no push code path
//   - verify-run (host and v2) has no push code path
//   - lead-review (host and v2) has no push code path
//   - lead-accept has no push code path
test("worker/verify/review/accept adapters have no push code paths (source-level invariant)", async () => {
  const NON_PUSH_ADAPTERS = ["worker-attempt", "verify-run", "lead-review", "lead-accept"];

  let grepOutput = "";
  try {
    const { stdout } = await execFileAsync("grep", ["-rln", '"push"', "."], { cwd: triggerSrcDir });
    grepOutput = stdout;
  } catch (err: unknown) {
    const execErr = err as { code?: number | string };
    if (execErr.code === 1) {
      return;
    }
    throw err;
  }

  const matchedFiles = grepOutput
    .trim()
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const violations = matchedFiles.filter((file) => {
    const normalised = file.replace(/\\/g, "/");
    return NON_PUSH_ADAPTERS.some((adapter) => normalised.includes(adapter));
  });

  assert.deepEqual(
    violations,
    [],
    `"push" found in non-push adapter files: ${violations.join(", ")}`,
  );
});
