import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { VerificationResult, VerifyRunPayload } from "@agencyhq/contracts";
import { VerificationResultSchema } from "@agencyhq/contracts";
import { changedPaths, diffDigest, worktreeAdd, worktreeRemove } from "../src/lib/git.ts";
import type {
  RunProfileInput,
  VerificationRunner,
  VerifyRunDeps,
} from "../src/tasks/verify-run-core.ts";
import { resolveVerifyWorktreePath, runVerification } from "../src/tasks/verify-run-core.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

/** Fake sha256 digest for payload (format must satisfy DigestStringSchema). */
const FAKE_DIGEST = `sha256:${"0".repeat(64)}`;
const FAKE_PROFILE_DIGEST = `sha256:${"a".repeat(64)}`;
const FAKE_CRITERIA_DIGEST = `sha256:${"b".repeat(64)}`;

// ---------------------------------------------------------------------------
// Fixture repo factory
// ---------------------------------------------------------------------------

type Fixture = {
  repoPath: string;
  worktreeBase: string;
  baseRevision: string;
  attemptRevision: string;
  payloadDiffDigest: string;
};

/**
 * Build a temp git repo with:
 *   - base commit: README.md
 *   - attempt commit: adds src/a.ts (and optionally package.json for tamper test)
 * Returns the base/attempt revisions and the correct diffDigest.
 */
async function makeFixture(opts: { includeTamperedFile?: boolean } = {}): Promise<Fixture> {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-verify-test-repo-"));
  const worktreeBase = await mkdtemp(join(tmpdir(), "agencyhq-verify-test-wt-"));

  // Init repo.
  await git(["init", "--initial-branch=main"], repoPath);

  // Base commit.
  await writeFile(join(repoPath, "README.md"), "hello\n");
  await git(["add", "-A"], repoPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"],
    repoPath,
  );
  const baseRevision = (await git(["rev-parse", "HEAD"], repoPath)).trim();

  // Attempt commit: add src/a.ts and optionally package.json.
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(join(repoPath, "src", "a.ts"), "export const a = 1;\n");
  if (opts.includeTamperedFile) {
    await writeFile(join(repoPath, "package.json"), '{"name":"test"}\n');
  }
  await git(["add", "-A"], repoPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "attempt"],
    repoPath,
  );
  const attemptRevision = (await git(["rev-parse", "HEAD"], repoPath)).trim();

  // Compute the real diffDigest from the main repo at attemptRevision.
  // runVerification will create a worktree at attemptRevision and compute the
  // same digest; the two must match for the integrity check to pass.
  // git.ts diffDigest() returns raw hex; prefix with "sha256:" to match DigestStringSchema.
  const rawHex = await diffDigest({ worktreePath: repoPath, baseRev: baseRevision });
  const payloadDiffDigest = rawHex;

  return { repoPath, worktreeBase, baseRevision, attemptRevision, payloadDiffDigest };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.repoPath, { recursive: true, force: true });
  await rm(fixture.worktreeBase, { recursive: true, force: true });
}

/** Make a minimal VerifyRunPayload with the fixture revisions. */
function makePayload(fixture: Fixture, overrides?: Partial<VerifyRunPayload>): VerifyRunPayload {
  return {
    attemptId: "attempt-test-1",
    generation: 3,
    contractId: "contract-1",
    profileId: "profile-1",
    profileDigest: FAKE_PROFILE_DIGEST,
    criteriaDigest: FAKE_CRITERIA_DIGEST,
    repoPath: fixture.repoPath,
    worktreeBase: fixture.worktreeBase,
    baseRevision: fixture.baseRevision,
    attemptRevision: fixture.attemptRevision,
    diffDigest: fixture.payloadDiffDigest,
    checks: [
      { id: "lint", version: "1.0.0", command: ["echo", "lint-ok"], timeoutSeconds: 60 },
      { id: "test", version: "1.0.0", command: ["echo", "test-ok"], timeoutSeconds: 120 },
    ],
    ...overrides,
  };
}

/** Build a fake runner that records what cwd it was called with. */
function makeFakeRunner(): { runner: VerificationRunner; calls: { cwd: string }[] } {
  const calls: { cwd: string }[] = [];

  const runner: VerificationRunner = {
    runProfile: async (input: RunProfileInput): Promise<VerificationResult[]> => {
      calls.push({ cwd: input.cwd });
      const now = input.now();
      return input.checks.map((check) => ({
        verifier: { name: "fake-runner", version: "1.0.0" },
        stepContractId: input.contractId,
        attemptId: input.attemptId,
        criteriaDigest: input.criteriaDigest,
        profileDigest: input.profileDigest,
        repository: input.repoPath,
        baseRevision: input.baseRevision,
        attemptRevision: input.attemptRevision,
        diffDigest: input.diffDigest,
        checkId: check.id,
        environmentFingerprint: {},
        startedAt: now,
        endedAt: now,
        exitStatus: 0,
        stdoutTail: "ok",
        stderrTail: "",
        artifactDigests: [],
        result: "pass" as const,
      }));
    },
  };

  return { runner, calls };
}

/** Build deps wiring the real git lib and the given runner. */
function makeDeps(runner: VerificationRunner): VerifyRunDeps {
  return {
    worktreeAdd,
    worktreeRemove,
    // Prefix with "sha256:" to match DigestStringSchema (git.ts returns raw hex).
    diffDigest: async (args) => {
      const hex = await diffDigest({ worktreePath: args.worktreePath, baseRev: args.baseRev });
      return hex;
    },
    changedPaths: (args) =>
      changedPaths({ worktreePath: args.worktreePath, baseRev: args.baseRev }),
    runner,
    now: () => new Date().toISOString(),
  };
}

/** Check whether a path exists on disk. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// T1: resolveVerifyWorktreePath includes generation in the path
// ---------------------------------------------------------------------------
test("resolveVerifyWorktreePath includes attemptId and generation in path", () => {
  const path = resolveVerifyWorktreePath({
    worktreeBase: "/srv/wt",
    attemptId: "abc",
    generation: 5,
  });
  assert.equal(path, "/srv/wt/verify/abc-5");
  assert.ok(path.includes("abc-5"), "path should include '<attemptId>-<generation>'");
});

// ---------------------------------------------------------------------------
// T2: happy path — integrity matches, runner called, worktree removed after
// ---------------------------------------------------------------------------
test("happy path: integrity matches, runner is called, worktree is removed after run", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture);
    const { runner, calls } = makeFakeRunner();
    const deps = makeDeps(runner);

    const expectedWorktreePath = resolveVerifyWorktreePath({
      worktreeBase: fixture.worktreeBase,
      attemptId: payload.attemptId,
      generation: payload.generation,
    });

    const output = await runVerification(payload, deps);

    // Integrity matched.
    assert.equal(output.integrity.diffDigestMatches, true, "diffDigest should match");
    // Runner was called with the verify worktree cwd.
    assert.equal(calls.length, 1, "runner should be called once");
    assert.equal(calls[0]?.cwd, expectedWorktreePath, "runner cwd should be the verify worktree");
    // Results produced.
    assert.equal(output.results.length, 2, "should have one result per check");
    // Worktree removed after run.
    const wtExists = await pathExists(expectedWorktreePath);
    assert.equal(wtExists, false, "verify worktree should be removed after run");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T3: each result parses with VerificationResultSchema and carries payload digests
// ---------------------------------------------------------------------------
test("every result parses with VerificationResultSchema and carries payload profileDigest/criteriaDigest", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture);
    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);

    const output = await runVerification(payload, deps);

    for (const result of output.results) {
      // Must parse with the schema.
      assert.doesNotThrow(
        () => VerificationResultSchema.parse(result),
        "result must satisfy VerificationResultSchema",
      );
      // Must carry the payload's frozen digests verbatim.
      assert.equal(result.profileDigest, FAKE_PROFILE_DIGEST, "profileDigest must match payload");
      assert.equal(
        result.criteriaDigest,
        FAKE_CRITERIA_DIGEST,
        "criteriaDigest must match payload",
      );
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T4: wrong diffDigest → all results error, runner NOT called
// ---------------------------------------------------------------------------
test("wrong diffDigest in payload: all results error with integrity_mismatch and runner not called", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture, { diffDigest: FAKE_DIGEST });
    const { runner, calls } = makeFakeRunner();
    const deps = makeDeps(runner);

    const output = await runVerification(payload, deps);

    // Integrity mismatch.
    assert.equal(output.integrity.diffDigestMatches, false, "diffDigest should not match");
    // Runner was NOT called.
    assert.equal(calls.length, 0, "runner must not be called on integrity mismatch");
    // All results are error with integrity_mismatch in stderrTail.
    assert.equal(
      output.results.length,
      payload.checks.length,
      "should have one error result per check",
    );
    for (const result of output.results) {
      assert.equal(result.result, "error", "result should be error");
      assert.ok(
        result.stderrTail.includes("integrity_mismatch"),
        "stderrTail should contain integrity_mismatch",
      );
      // Still parses with the schema.
      assert.doesNotThrow(() => VerificationResultSchema.parse(result));
      // Carries payload digests.
      assert.equal(result.profileDigest, FAKE_PROFILE_DIGEST);
      assert.equal(result.criteriaDigest, FAKE_CRITERIA_DIGEST);
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T5: tampered package.json → tamperedPaths reported, results still produced
// ---------------------------------------------------------------------------
test("tampered package.json in attempt commit: tamperedPaths includes it, results still produced", async () => {
  const fixture = await makeFixture({ includeTamperedFile: true });
  try {
    const payload = makePayload(fixture);
    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);

    const output = await runVerification(payload, deps);

    // Results still produced (tamper does not block checks).
    assert.equal(
      output.results.length,
      payload.checks.length,
      "results still produced despite tamper",
    );
    // tamperedPaths contains package.json.
    assert.ok(
      output.integrity.tamperedPaths.includes("package.json"),
      `tamperedPaths should include package.json, got: ${JSON.stringify(output.integrity.tamperedPaths)}`,
    );
    // All results parse correctly.
    for (const result of output.results) {
      assert.doesNotThrow(() => VerificationResultSchema.parse(result));
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T6: worktree path includes generation (integration)
// ---------------------------------------------------------------------------
test("verify worktree path includes generation component (integration)", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture, { generation: 7 });
    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);

    // Override worktreeAdd to capture the path used.
    let capturedWorktreePath: string | undefined;
    const capturingDeps: VerifyRunDeps = {
      ...deps,
      worktreeAdd: async (args) => {
        capturedWorktreePath = args.worktreePath;
        return deps.worktreeAdd(args);
      },
    };

    await runVerification(payload, capturingDeps);

    assert.ok(capturedWorktreePath, "worktreeAdd should be called");
    assert.ok(
      capturedWorktreePath?.includes("-7"),
      `worktree path should include generation '-7', got: ${capturedWorktreePath}`,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T7: worktree is removed even when the runner throws
// ---------------------------------------------------------------------------
test("verify worktree is removed even when the runner throws", async () => {
  const fixture = await makeFixture();
  let capturedWorktreePath: string | undefined;
  try {
    const payload = makePayload(fixture);
    const throwingRunner: VerificationRunner = {
      runProfile: async (): Promise<VerificationResult[]> => {
        throw new Error("runner exploded");
      },
    };

    const deps: VerifyRunDeps = {
      worktreeAdd: async (args) => {
        capturedWorktreePath = args.worktreePath;
        return worktreeAdd(args);
      },
      worktreeRemove,
      diffDigest: async (args) => {
        const hex = await diffDigest({ worktreePath: args.worktreePath, baseRev: args.baseRev });
        return hex;
      },
      changedPaths: (args) =>
        changedPaths({ worktreePath: args.worktreePath, baseRev: args.baseRev }),
      runner: throwingRunner,
      now: () => new Date().toISOString(),
    };

    await assert.rejects(() => runVerification(payload, deps), /runner exploded/);

    // Worktree still removed.
    if (capturedWorktreePath) {
      const wtExists = await pathExists(capturedWorktreePath);
      assert.equal(wtExists, false, "verify worktree must be removed even on runner failure");
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T8: results for integrity_mismatch carry checkId from the payload checks
// ---------------------------------------------------------------------------
test("integrity_mismatch error results carry the checkId from the payload checks", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture, { diffDigest: FAKE_DIGEST });
    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);

    const output = await runVerification(payload, deps);

    const resultIds = output.results.map((r) => r.checkId).sort();
    const payloadIds = payload.checks.map((c) => c.id).sort();
    assert.deepEqual(resultIds, payloadIds, "error results should have one result per check by id");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T9: happy path results have result: "pass"
// ---------------------------------------------------------------------------
test("happy path results from the fake runner are all result: pass", async () => {
  const fixture = await makeFixture();
  try {
    const payload = makePayload(fixture);
    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);

    const output = await runVerification(payload, deps);

    for (const result of output.results) {
      assert.equal(result.result, "pass", "fake runner should produce pass results");
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// T10: source-grep — verify-run-core.ts never references `report` or `checksRun`
// ---------------------------------------------------------------------------
test("verify-run-core.ts does not reference 'report' or 'checksRun' (TESTING.md §71: worker report is not evidence)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const srcPath = join(thisDir, "..", "src", "tasks", "verify-run-core.ts");
  const src = await readFile(srcPath, "utf8");

  // Strip single-line comments from the source to avoid false positives
  // from documentation comments.
  const codeWithoutComments = src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  assert.doesNotMatch(
    codeWithoutComments,
    /\breport\b/,
    "verify-run-core.ts must not reference 'report' (worker report is not evidence, TESTING.md §71)",
  );
  assert.doesNotMatch(
    codeWithoutComments,
    /\bchecksRun\b/,
    "verify-run-core.ts must not reference 'checksRun'",
  );
});

// ---------------------------------------------------------------------------
// F-6: protectedPaths from payload (single source of truth)
// ---------------------------------------------------------------------------

// T11: when payload.protectedPaths is absent, DEFAULT_PROTECTED_PATHS are used.
test("protectedPaths absent: default list catches package.json tamper", async () => {
  // includeTamperedFile adds package.json — it is in DEFAULT_PROTECTED_PATHS.
  const fixture = await makeFixture({ includeTamperedFile: true });
  try {
    const payload = makePayload(fixture);
    assert.equal(
      payload.protectedPaths,
      undefined,
      "fixture payload should have no protectedPaths",
    );

    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);
    const output = await runVerification(payload, deps);

    assert.ok(
      output.integrity.tamperedPaths.includes("package.json"),
      `expected package.json in tamperedPaths; got ${JSON.stringify(output.integrity.tamperedPaths)}`,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

// T12: when payload.protectedPaths is an explicit list, only those paths are checked.
test("protectedPaths explicit: custom list overrides DEFAULT_PROTECTED_PATHS", async () => {
  // includeTamperedFile adds package.json, which is in the default list but
  // NOT in our custom explicit list.
  const fixture = await makeFixture({ includeTamperedFile: true });
  try {
    const payload = makePayload(fixture, {
      protectedPaths: ["src/critical-verifier.ts"],
    });

    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);
    const output = await runVerification(payload, deps);

    assert.equal(
      output.integrity.tamperedPaths.length,
      0,
      "package.json must NOT be flagged when it is outside the explicit protectedPaths list",
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

// T13: test files are NOT verifier configuration. After review 2 (G-1) the
// default list covers verifier config only; weakened tests are the adversarial
// review's job and are governed by the contract's paths.allow.
test("protectedPaths default: test/parser/reject.test.ts is not covered by DEFAULT_PROTECTED_PATHS", async () => {
  const { DEFAULT_PROTECTED_PATHS } = await import("@agencyhq/domain");
  const { matchesGlob } = await import("../src/lib/paths.ts");

  const testFilePath = "test/parser/reject.test.ts";
  const covered = DEFAULT_PROTECTED_PATHS.some((p) => matchesGlob(p, testFilePath));
  assert.equal(covered, false, `${testFilePath} must not be a protected verifier path`);
  assert.ok(DEFAULT_PROTECTED_PATHS.some((p) => matchesGlob(p, "package.json")));
});

// ---------------------------------------------------------------------------
// H-6: protectedPathsSource metadata in RunVerificationOutput.integrity
// ---------------------------------------------------------------------------

// T14: when payload.protectedPaths is absent, protectedPathsSource is "default".
test("protectedPathsSource: absent protectedPaths records source=default", async () => {
  const fixture = await makeFixture({ includeTamperedFile: false });
  try {
    const payload = makePayload(fixture);
    assert.equal(
      payload.protectedPaths,
      undefined,
      "fixture payload should have no protectedPaths",
    );

    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);
    const output = await runVerification(payload, deps);

    assert.equal(
      output.integrity.protectedPathsSource,
      "default",
      "absent protectedPaths should record source=default",
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

// T15: when payload.protectedPaths is explicitly set, protectedPathsSource is "payload".
test("protectedPathsSource: explicit protectedPaths records source=payload", async () => {
  const fixture = await makeFixture({ includeTamperedFile: false });
  try {
    const payload = makePayload(fixture, {
      protectedPaths: ["src/critical-verifier.ts"],
    });

    const { runner } = makeFakeRunner();
    const deps = makeDeps(runner);
    const output = await runVerification(payload, deps);

    assert.equal(
      output.integrity.protectedPathsSource,
      "payload",
      "explicit protectedPaths should record source=payload",
    );
  } finally {
    await cleanupFixture(fixture);
  }
});
