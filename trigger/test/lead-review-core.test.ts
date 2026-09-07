import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LeadReviewPayload, ReviewOutput, VerificationResult } from "@agencyhq/contracts";
import type { ReviewDeps } from "../src/tasks/lead-review-core.ts";
import {
  assertNoWorkerContext,
  resolveReviewRunDir,
  resolveReviewWorktreePath,
  runReview,
} from "../src/tasks/lead-review-core.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;

const SAMPLE_RESULT: VerificationResult = {
  verifier: { name: "pnpm-test", version: "1.0.0" },
  stepContractId: "contract-1",
  attemptId: "attempt-1",
  criteriaDigest: DIGEST_A,
  profileDigest: DIGEST_B,
  repository: "github.com/example/repo",
  baseRevision: "abc123",
  attemptRevision: "def456",
  diffDigest: DIGEST_C,
  checkId: "check-typecheck",
  environmentFingerprint: { node: "24.0.0" },
  startedAt: "2026-09-07T10:00:00.000Z",
  endedAt: "2026-09-07T10:01:00.000Z",
  exitStatus: 0,
  stdoutTail: "",
  stderrTail: "",
  artifactDigests: [],
  result: "pass",
};

function makePayload(overrides: Partial<LeadReviewPayload> = {}): LeadReviewPayload {
  return {
    attemptId: "attempt-1",
    generation: 0,
    contractId: "contract-1",
    criteria: [{ id: "C-001", text: "All tests pass", source: "operator" }],
    criteriaDigest: DIGEST_A,
    profileDigest: DIGEST_B,
    attemptRevision: "def456",
    diffDigest: DIGEST_C,
    patchPath: "/tmp/attempt.patch",
    verificationResults: [SAMPLE_RESULT],
    model: "openai/gpt-5.6-terra",
    repoPath: "/srv/repo",
    worktreeBase: "/tmp/agencyhq-test",
    baseRevision: "abc123",
    ...overrides,
  };
}

function makeValidReviewOutput(payload: LeadReviewPayload): ReviewOutput {
  return {
    reviewer: { model: payload.model },
    subject: {
      attemptRevision: payload.attemptRevision,
      diffDigest: payload.diffDigest,
      criteriaDigest: payload.criteriaDigest,
      profileDigest: payload.profileDigest,
    },
    findings: [],
  };
}

/** Minimal fake ReviewDeps with no side effects beyond tracking calls. */
function makeFakeDeps(
  options: {
    worktreeBase?: string;
    sessionOutput?: ReviewOutput | Error;
    worktreeAddFails?: boolean;
    gitDiffResult?: string;
  } = {},
): ReviewDeps & {
  worktreeAddCalled: boolean;
  worktreeRemovedPath: string | undefined;
} {
  let worktreeAddCalled = false;
  let worktreeRemovedPath: string | undefined;
  const _worktreeBase = options.worktreeBase ?? "/tmp/agencyhq-test";

  const deps: ReviewDeps & {
    worktreeAddCalled: boolean;
    worktreeRemovedPath: string | undefined;
  } = {
    get worktreeAddCalled() {
      return worktreeAddCalled;
    },
    get worktreeRemovedPath() {
      return worktreeRemovedPath;
    },
    worktreeAdd: async (args) => {
      worktreeAddCalled = true;
      if (options.worktreeAddFails === true) {
        throw new Error("worktreeAdd failed");
      }
      // Simulate creating the worktree directory.
      mkdirSync(args.worktreePath, { recursive: true });
    },
    worktreeRemove: async (args) => {
      worktreeRemovedPath = args.worktreePath;
      // Remove the simulated worktree directory if it exists.
      if (existsSync(args.worktreePath)) {
        rmSync(args.worktreePath, { recursive: true, force: true });
      }
    },
    gitDiff: async (_repoPath, _base, _attempt) => {
      return options.gitDiffResult ?? "diff --git a/file.ts b/file.ts\n+hello";
    },
    leadSession: async <T>(input: { parse: (raw: unknown) => T }) => {
      if (options.sessionOutput instanceof Error) {
        throw options.sessionOutput;
      }
      const raw = options.sessionOutput;
      return {
        sessionId: "session-123",
        raw,
        value: input.parse(raw),
      };
    },
    now: () => new Date("2026-09-07T12:00:00.000Z"),
  };

  return deps;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

test("resolveReviewWorktreePath places worktree under <worktreeBase>/review/<attemptId>-<generation>", () => {
  assert.equal(
    resolveReviewWorktreePath({ worktreeBase: "/srv", attemptId: "a-1", generation: 3 }),
    "/srv/review/a-1-3",
  );
});

test("resolveReviewRunDir places run dir under <worktreeBase>/runs/review-<attemptId>-<generation>", () => {
  assert.equal(
    resolveReviewRunDir({ worktreeBase: "/srv", attemptId: "a-1", generation: 3 }),
    "/srv/runs/review-a-1-3",
  );
});

test("resolveReviewRunDir is outside the worktree path", () => {
  const wt = resolveReviewWorktreePath({ worktreeBase: "/srv", attemptId: "a-1", generation: 0 });
  const rd = resolveReviewRunDir({ worktreeBase: "/srv", attemptId: "a-1", generation: 0 });
  assert.ok(!rd.startsWith(wt), `runDir (${rd}) must not be inside worktree (${wt})`);
});

// ---------------------------------------------------------------------------
// assertNoWorkerContext
// ---------------------------------------------------------------------------

test("assertNoWorkerContext does not throw for a clean payload", () => {
  assert.doesNotThrow(() => assertNoWorkerContext({ attemptId: "a-1", model: "m-1" }));
});

test("assertNoWorkerContext throws when payload contains sessionId", () => {
  assert.throws(() => assertNoWorkerContext({ attemptId: "a-1", sessionId: "s-bad" }), /ADR-0006/);
});

test("assertNoWorkerContext throws when payload contains transcript", () => {
  assert.throws(() => assertNoWorkerContext({ attemptId: "a-1", transcript: "..." }), /ADR-0006/);
});

// ---------------------------------------------------------------------------
// runReview: valid output → returned
// ---------------------------------------------------------------------------

test("runReview returns a valid review output with reviewerModel", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const sessionOutput = makeValidReviewOutput(payload);
    const deps = makeFakeDeps({ worktreeBase: tmpBase, sessionOutput });

    const result = await runReview(payload, deps);

    assert.ok(!("kind" in result), "valid review should not have kind: invalid_output");
    assert.equal(result.reviewerModel, payload.model);
    assert.deepEqual(result.findings, []);
    assert.equal(result.subject.attemptRevision, payload.attemptRevision);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runReview: subject mismatch → invalid_output
// ---------------------------------------------------------------------------

test("runReview returns invalid_output when subject attemptRevision mismatches", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const badOutput: ReviewOutput = {
      reviewer: { model: payload.model },
      subject: {
        attemptRevision: "WRONG_REVISION",
        diffDigest: payload.diffDigest,
        criteriaDigest: payload.criteriaDigest,
        profileDigest: payload.profileDigest,
      },
      findings: [],
    };
    const deps = makeFakeDeps({ worktreeBase: tmpBase, sessionOutput: badOutput });

    const result = await runReview(payload, deps);

    assert.ok("kind" in result, "subject mismatch should produce invalid_output");
    assert.equal(result.kind, "invalid_output");
    assert.ok(result.reason.includes("mismatch"), "reason should mention mismatch");
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("runReview returns invalid_output when subject diffDigest mismatches", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const badOutput: ReviewOutput = {
      reviewer: { model: payload.model },
      subject: {
        attemptRevision: payload.attemptRevision,
        diffDigest: DIGEST_D, // wrong
        criteriaDigest: payload.criteriaDigest,
        profileDigest: payload.profileDigest,
      },
      findings: [],
    };
    const deps = makeFakeDeps({ worktreeBase: tmpBase, sessionOutput: badOutput });

    const result = await runReview(payload, deps);

    assert.ok("kind" in result, "diffDigest mismatch should produce invalid_output");
    assert.equal(result.kind, "invalid_output");
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runReview: garbage / parse error → invalid_output
// ---------------------------------------------------------------------------

test("runReview returns invalid_output when lead session throws", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const deps = makeFakeDeps({
      worktreeBase: tmpBase,
      sessionOutput: new Error("model refused"),
    });

    const result = await runReview(payload, deps);

    assert.ok("kind" in result, "session error should produce invalid_output");
    assert.equal(result.kind, "invalid_output");
    assert.ok(result.reason.includes("model refused"), "reason should include error message");
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("runReview returns invalid_output when session output fails schema parse", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    // Override leadSession to return something that fails ReviewOutputSchema.parse
    const deps: ReviewDeps & {
      worktreeRemovedPath: string | undefined;
      worktreeAddCalled: boolean;
    } = {
      worktreeAddCalled: false,
      worktreeRemovedPath: undefined,
      worktreeAdd: async (args) => {
        mkdirSync(args.worktreePath, { recursive: true });
      },
      worktreeRemove: async (args) => {
        deps.worktreeRemovedPath = args.worktreePath;
        if (existsSync(args.worktreePath)) {
          rmSync(args.worktreePath, { recursive: true, force: true });
        }
      },
      gitDiff: async () => "patch content",
      leadSession: async <T>(input: { parse: (raw: unknown) => T }) => {
        // Return an object that passes our fake session but fails parse
        const garbage = { not_a: "valid_review_output" };
        return {
          sessionId: "s-1",
          raw: garbage,
          value: input.parse(garbage), // parse will throw ZodError
        };
      },
      now: () => new Date(),
    };

    const result = await runReview(payload, deps);

    assert.ok("kind" in result, "garbage output should produce invalid_output");
    assert.equal(result.kind, "invalid_output");
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runReview: worktree removed in finally
// ---------------------------------------------------------------------------

test("runReview removes the worktree even when the session throws", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const deps = makeFakeDeps({
      worktreeBase: tmpBase,
      sessionOutput: new Error("session failed"),
    });

    await runReview(payload, deps);

    assert.ok(
      deps.worktreeRemovedPath !== undefined,
      "worktree should have been removed even after session error",
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("runReview removes the worktree on successful review", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const deps = makeFakeDeps({
      worktreeBase: tmpBase,
      sessionOutput: makeValidReviewOutput(payload),
    });

    await runReview(payload, deps);

    assert.ok(
      deps.worktreeRemovedPath !== undefined,
      "worktree should be removed after successful review",
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runReview: patch file written outside the worktree
// ---------------------------------------------------------------------------

test("runReview writes the patch file outside the worktree directory", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    const sessionOutput = makeValidReviewOutput(payload);
    const patch = "diff --git a/x.ts b/x.ts\n+exported change";
    let capturedWorktreePath: string | undefined;

    const deps: ReviewDeps & {
      worktreeRemovedPath: string | undefined;
      worktreeAddCalled: boolean;
    } = {
      worktreeAddCalled: false,
      worktreeRemovedPath: undefined,
      worktreeAdd: async (args) => {
        capturedWorktreePath = args.worktreePath;
        mkdirSync(args.worktreePath, { recursive: true });
      },
      worktreeRemove: async (args) => {
        deps.worktreeRemovedPath = args.worktreePath;
        if (existsSync(args.worktreePath))
          rmSync(args.worktreePath, { recursive: true, force: true });
      },
      gitDiff: async () => patch,
      leadSession: async <T>(input: { parse: (raw: unknown) => T }) => ({
        sessionId: "s-1",
        raw: sessionOutput,
        value: input.parse(sessionOutput),
      }),
      now: () => new Date(),
    };

    await runReview(payload, deps);

    // The patch file should be in the runDir, not inside the worktree.
    const runDir = resolveReviewRunDir({
      worktreeBase: tmpBase,
      attemptId: payload.attemptId,
      generation: payload.generation,
    });
    const patchFilePath = join(runDir, "attempt.patch");
    assert.ok(existsSync(patchFilePath), `patch file must exist at ${patchFilePath}`);

    // Verify the patch content matches.
    const written = readFileSync(patchFilePath, "utf8");
    assert.equal(written, patch);

    // Verify patch file is NOT inside the worktree.
    assert.ok(capturedWorktreePath !== undefined, "worktreeAdd should have been called");
    assert.ok(
      !patchFilePath.startsWith(capturedWorktreePath),
      `patch file (${patchFilePath}) must not be inside the worktree (${capturedWorktreePath})`,
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source-grep tests: independence from @agencyhq/domain
// ---------------------------------------------------------------------------

test("lead-review-core.ts does not import from @agencyhq/domain acceptance module", () => {
  const src = readFileSync(new URL("../src/tasks/lead-review-core.ts", import.meta.url), "utf8");
  assert.ok(
    !src.includes("@agencyhq/domain"),
    "lead-review-core must not import from @agencyhq/domain",
  );
  assert.ok(
    !src.includes("/domain/src/evidence/acceptance"),
    "lead-review-core must not import from acceptance module",
  );
});

test("lead-review-core.ts does not reference checkProposal or evaluateAcceptance", () => {
  const src = readFileSync(new URL("../src/tasks/lead-review-core.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("checkProposal"), "must not reference checkProposal");
  assert.ok(!src.includes("evaluateAcceptance"), "must not reference evaluateAcceptance");
});

// ---------------------------------------------------------------------------
// F-8: reviewerModel is the invoked payload.model, not the self-reported one
// ---------------------------------------------------------------------------

test("F-8: reviewerModel uses payload.model even when reviewer self-reports a different model", async () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "agencyhq-test-"));
  try {
    const payload = makePayload({ worktreeBase: tmpBase });
    // The model self-reports a DIFFERENT identifier than what was invoked.
    const selfReportedModel = "some-other-model/that-the-llm-claimed";
    const sessionOutput: ReviewOutput = {
      reviewer: { model: selfReportedModel },
      subject: {
        attemptRevision: payload.attemptRevision,
        diffDigest: payload.diffDigest,
        criteriaDigest: payload.criteriaDigest,
        profileDigest: payload.profileDigest,
      },
      findings: [],
    };
    const deps = makeFakeDeps({ worktreeBase: tmpBase, sessionOutput });

    const result = await runReview(payload, deps);

    assert.ok(!("kind" in result), "valid review should not produce invalid_output");
    // reviewerModel must be the INVOKED model, not the self-reported one.
    assert.equal(
      result.reviewerModel,
      payload.model,
      "reviewerModel must equal payload.model (invoked model), not the self-reported model",
    );
    assert.notEqual(
      result.reviewerModel,
      selfReportedModel,
      "reviewerModel must not equal the self-reported model identifier",
    );
    // The self-reported model is still in the raw output's reviewer field.
    assert.ok(
      "reviewer" in result && (result as ReviewOutput).reviewer.model === selfReportedModel,
      "self-reported reviewer.model should still be preserved in the result's reviewer field",
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
