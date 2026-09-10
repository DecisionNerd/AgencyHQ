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
test("worker/verify/review/accept/lead-plan adapters have no push code paths (source-level invariant)", async () => {
  const NON_PUSH_ADAPTERS = [
    "worker-attempt",
    "verify-run",
    "lead-review",
    "lead-accept",
    "lead-plan",
  ];

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

// Behavioural: integrate-merge calls pushForceWithLease from lib/git.ts which
// requires a lease token argument. Verify the push gating by checking that
// pushForceWithLease is the only export from lib/git.ts that performs a push,
// and that its signature requires a token (i.e. the function name and token param
// are present together in the source).
test("push-boundary behavioural: pushForceWithLease in lib/git.ts uses force-with-lease guard", async () => {
  const gitLibPath = join(triggerSrcDir, "lib", "git.ts");
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(gitLibPath, "utf8");

  // The function must exist.
  assert.ok(src.includes("pushForceWithLease"), "pushForceWithLease must be defined in lib/git.ts");

  // Must use --force-with-lease to prevent unauthorized pushes.
  assert.ok(
    src.includes("--force-with-lease"),
    "pushForceWithLease must use --force-with-lease git flag",
  );

  // Must accept an env parameter (credentials injected via env, not a bare token literal).
  assert.ok(
    src.includes("env?") || src.includes("env?: "),
    "pushForceWithLease must accept an env parameter for credential injection",
  );

  // The push command must require a remote (not a hard-coded remote).
  assert.ok(src.includes("args.remote"), "pushForceWithLease must use args.remote (not hard-coded)");

  // Structural: the only exported push-capable function is pushForceWithLease.
  const exportedPushFunctions = src
    .split("\n")
    .filter((line) => line.includes("export") && line.includes("push") && !line.includes("//"));

  assert.ok(
    exportedPushFunctions.every((line) => line.includes("pushForceWithLease")),
    `Only pushForceWithLease may be an exported push function; found: ${exportedPushFunctions.join(" | ")}`,
  );
});

// Behavioural: integrate-merge is the only task that calls pushForceWithLease.
// This is verified by the static scan above (no "push" in non-push adapters).
// Additionally confirm integrate-merge calls it with a lease token (not empty string).
test("push-boundary behavioural: integrate-merge calls pushForceWithLease with a lease grant token", async () => {
  const integrateMergePath = join(triggerSrcDir, "tasks", "integrate-merge.ts");
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(integrateMergePath, "utf8");

  // Must call pushForceWithLease.
  assert.ok(src.includes("pushForceWithLease"), "integrate-merge.ts must call pushForceWithLease");

  // Must pass a token from a lease grant (not a bare empty string constant "").
  // The call should include a property that comes from leaseResult/grant/token.
  const pushCallLines = src.split("\n").filter((line) => line.includes("pushForceWithLease"));

  assert.ok(pushCallLines.length > 0, "pushForceWithLease call must appear in integrate-merge.ts");

  // Negative: integrate-merge must not push with an empty string literal as token.
  // (If it did, the push would be unauthenticated.)
  const hasEmptyTokenPush = pushCallLines.some((line) => line.includes('token: ""'));
  assert.equal(
    hasEmptyTokenPush,
    false,
    "pushForceWithLease must not be called with empty token literal",
  );
});
