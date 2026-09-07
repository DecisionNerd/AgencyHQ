// Pure/injectable pieces of the `lead.review` task (Packet 3.D, ADR-0006).
//
// Factored out so they can be unit-tested without importing `@trigger.dev/sdk`.
// No Trigger SDK usage. No domain-acceptance imports. No decision logic here —
// this task produces output for the coordinator to evaluate, never evaluates itself.

import { mkdir, writeFile } from "node:fs/promises";
import type { LeadReviewPayload, ReviewOutput } from "@agencyhq/contracts";
import {
  LEAD_OUTPUT_JSON_SCHEMAS,
  leadAgentPermissions,
  ReviewOutputSchema,
} from "@agencyhq/contracts";

import { scrubbedChildEnv } from "../lib/env.ts";
import { buildReviewPrompt } from "../opencode/review-prompt.ts";
import type { LeadSession, ReviewTaskOutput } from "../types.ts";

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export type ReviewDeps = {
  worktreeAdd: (args: { repoPath: string; worktreePath: string; rev: string }) => Promise<void>;
  worktreeRemove: (args: {
    repoPath: string;
    worktreePath: string;
    force?: boolean;
  }) => Promise<void>;
  /** Produces `git diff <base> <attempt>` text from the main repo. */
  gitDiff: (repoPath: string, base: string, attempt: string) => Promise<string>;
  leadSession: LeadSession;
  now: () => Date;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** The review worktree path: `<worktreeBase>/review/<attemptId>-<generation>`. */
export function resolveReviewWorktreePath(args: {
  worktreeBase: string;
  attemptId: string;
  generation: number;
}): string {
  return `${args.worktreeBase}/review/${args.attemptId}-${args.generation}`;
}

/** The review run directory (outside the worktree): `<worktreeBase>/runs/review-<attemptId>-<generation>`. */
export function resolveReviewRunDir(args: {
  worktreeBase: string;
  attemptId: string;
  generation: number;
}): string {
  return `${args.worktreeBase}/runs/review-${args.attemptId}-${args.generation}`;
}

// ---------------------------------------------------------------------------
// Runtime invariant: no worker session id or transcript
// ---------------------------------------------------------------------------

const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  "sessionId",
  "workerSessionId",
  "transcript",
  "workerTranscript",
  "conversationId",
];

/**
 * ADR-0006 independence check: asserts that the payload object carries none
 * of the forbidden worker-internal keys. Throws if any are present.
 */
export function assertNoWorkerContext(payload: Record<string, unknown>): void {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (key in payload) {
      throw new Error(
        `ADR-0006 independence violation: payload contains forbidden key "${key}". ` +
          `The reviewer must not receive worker session ids or transcripts.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// runReview
// ---------------------------------------------------------------------------

export type ReviewResult = (ReviewTaskOutput & { reviewerModel: string }) | InvalidReviewResult;

type InvalidReviewResult = {
  kind: "invalid_output";
  reason: string;
  reviewerModel: string;
};

/**
 * Runs one adversarial lead.review session for the given attempt.
 *
 * Invariants:
 * - Asserts the payload has no worker session id or transcript (ADR-0006).
 * - Creates a read-only worktree at the attempt revision.
 * - Writes the patch file to `<runDir>/attempt.patch` (outside the worktree).
 * - Passes only the diff, criteria, and verification results to the reviewer.
 * - Post-validates that the reviewer's `subject` exactly matches the payload digests.
 * - Removes the worktree in a finally block.
 */
export async function runReview(
  payload: LeadReviewPayload,
  deps: ReviewDeps,
): Promise<ReviewTaskOutput & { reviewerModel: string }> {
  // Runtime invariant (ADR-0006): assert no worker-internal keys leaked in.
  assertNoWorkerContext(payload as unknown as Record<string, unknown>);

  const worktreePath = resolveReviewWorktreePath({
    worktreeBase: payload.worktreeBase,
    attemptId: payload.attemptId,
    generation: payload.generation,
  });
  const runDir = resolveReviewRunDir({
    worktreeBase: payload.worktreeBase,
    attemptId: payload.attemptId,
    generation: payload.generation,
  });

  await mkdir(runDir, { recursive: true });
  await deps.worktreeAdd({
    repoPath: payload.repoPath,
    worktreePath,
    rev: payload.attemptRevision,
  });

  try {
    // Produce the patch (outside the worktree — in runDir).
    const patch = await deps.gitDiff(
      payload.repoPath,
      payload.baseRevision,
      payload.attemptRevision,
    );
    const patchFilePath = `${runDir}/attempt.patch`;
    await writeFile(patchFilePath, patch, "utf8");

    // Build the adversarial review prompts.
    const { systemContext, userPrompt } = buildReviewPrompt(payload, patch);

    // Scrubbed environment: no credentials, no Trigger tokens.
    const env = scrubbedChildEnv({ attemptId: payload.attemptId });

    // Call the lead session.
    let value: ReviewOutput;
    try {
      const result = await deps.leadSession<ReviewOutput>({
        dir: worktreePath,
        runDir,
        model: payload.model,
        agentName: "agencyhq-lead",
        ruleset: leadAgentPermissions(),
        env,
        systemContext,
        userPrompt,
        schema: LEAD_OUTPUT_JSON_SCHEMAS.reviewOutput,
        parse: (raw: unknown): ReviewOutput => ReviewOutputSchema.parse(raw),
        timeoutMs: 540_000,
      });
      value = result.value;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        kind: "invalid_output",
        reason: `Lead session error: ${reason}`,
        reviewerModel: payload.model,
      };
    }

    // Post-validate: subject must exactly match the payload digests/revision.
    // A review of the wrong subject is not evidence for this attempt.
    const s = value.subject;
    if (
      s.attemptRevision !== payload.attemptRevision ||
      s.diffDigest !== payload.diffDigest ||
      s.criteriaDigest !== payload.criteriaDigest ||
      s.profileDigest !== payload.profileDigest
    ) {
      return {
        kind: "invalid_output",
        reason:
          `Subject mismatch: reviewer output subject does not match payload. ` +
          `Expected attemptRevision=${payload.attemptRevision} diffDigest=${payload.diffDigest} ` +
          `criteriaDigest=${payload.criteriaDigest} profileDigest=${payload.profileDigest}; ` +
          `got attemptRevision=${s.attemptRevision} diffDigest=${s.diffDigest} ` +
          `criteriaDigest=${s.criteriaDigest} profileDigest=${s.profileDigest}`,
        reviewerModel: payload.model,
      };
    }

    return { ...value, reviewerModel: payload.model };
  } finally {
    // Always remove the review worktree, even on error.
    await deps
      .worktreeRemove({ repoPath: payload.repoPath, worktreePath, force: true })
      .catch(() => undefined);
  }
}
