/**
 * Canned lead output builders for integration tests.
 *
 * "good" proposal: narrower than HOST_TRIAL_AUTHORITY (accepted by checkProposal).
 * "bad" proposal: widens scope (rejected by checkProposal, yields pending_human).
 */

import type {
  AcceptanceProposal,
  LeadPlanOutput,
  LeadProposal,
  ReviewOutput,
  VerificationResult,
} from "@agencyhq/contracts";
import { digestOf } from "@agencyhq/contracts";

// ---------------------------------------------------------------------------
// Good proposal (narrower than HOST_TRIAL_AUTHORITY)
// ---------------------------------------------------------------------------

export const GOOD_PROPOSAL: LeadProposal = {
  criteria: [
    {
      id: "c1",
      text: "All parser edge cases pass",
      source: "operator",
      citation: "Issue #42",
    },
  ],
  profileId: "default",
  changeClass: "behavior",
  review: "adversarial",
  boundary: "artifact",
  paths: {
    // Use specific literal path to avoid intersecting with humanRequired.paths
    // (src/parser/public-api.ts), which would force humanRequired=true and
    // block automated acceptance.
    allow: ["src/parser/edge-cases.ts"],
    deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
  },
  capabilities: {
    bash: {
      allow: ["pnpm test*"],
      deny: [],
    },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  budget: {
    maxAttempts: 2,
    maxDurationSeconds: 600,
    estimatedSpendUsd: 2,
  },
  models: {
    worker: "openai/gpt-5.6-terra",
    reviewer: "openai/gpt-5.6-sol",
  },
  rationale: "Narrow fix to parser edge cases only",
  sources: [{ criterionId: "c1", source: "operator", citation: "Issue #42" }],
};

/**
 * Build a good (accepted) LeadPlanOutput for tests.
 */
export function goodPlanOutput(): LeadPlanOutput {
  return { kind: "proposal", proposal: GOOD_PROPOSAL };
}

// ---------------------------------------------------------------------------
// Bad proposal (widens scope — disallowed path)
// ---------------------------------------------------------------------------

export const BAD_PROPOSAL: LeadProposal = {
  ...GOOD_PROPOSAL,
  // Widens to include all of src/ (not allowed by HOST_TRIAL_AUTHORITY which
  // only allows src/parser/**). Keep deny patterns from authority.
  paths: {
    allow: ["src/**"],
    deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
  },
  rationale: "Wide fix to all of src",
};

/**
 * Build a bad (rejected) LeadPlanOutput for tests.
 * Should yield pending_human Decision, no StepContract created.
 */
export function badPlanOutput(): LeadPlanOutput {
  return { kind: "proposal", proposal: BAD_PROPOSAL };
}

// ---------------------------------------------------------------------------
// WorkerAttemptOutput builder
// ---------------------------------------------------------------------------

export function workerCompletedOutput(
  attemptId: string,
  opts?: {
    commitId?: string;
    diffDigest?: string;
    changedPaths?: string[];
  },
): import("@agencyhq/contracts").WorkerAttemptOutput {
  const commitId = opts?.commitId ?? "abcdef1234567890abcdef1234567890abcdef12";
  const diffDigest = opts?.diffDigest ?? String(digestOf({ commitId }));
  const changedPaths = opts?.changedPaths ?? ["src/parser/edge-cases.ts"];

  return {
    attemptId,
    sessionId: "session-123",
    outcome: "completed",
    worktreePath: `/worktrees/${attemptId}`,
    runDir: `/worktrees/${attemptId}/.run`,
    commitId,
    diffDigest,
    changedPaths,
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: {
      sessionID: "ocsess-123",
      exitCode: 0,
      denials: [],
      errors: [],
    },
    report: {
      attempted: "Fixed parser edge cases",
      outputs: changedPaths,
      checksRun: [{ command: "pnpm test", claimedResult: "pass" }],
      unmetCriteria: [],
      limitations: [],
      findings: [],
    },
  };
}

/**
 * Build a null-commit completed output for tests.
 * The run status is COMPLETED and outcome is "completed", but commitId is null.
 * This is the F-14 scenario: worker claimed to finish but produced no commit.
 */
export function workerNullCommitOutput(
  attemptId: string,
): import("@agencyhq/contracts").WorkerAttemptOutput {
  return {
    attemptId,
    sessionId: "session-null-commit",
    outcome: "completed",
    worktreePath: `/worktrees/${attemptId}`,
    runDir: `/worktrees/${attemptId}/.run`,
    commitId: null,
    diffDigest: null,
    changedPaths: [],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: {
      sessionID: "ocsess-null-commit",
      exitCode: 0,
      denials: [],
      errors: [],
    },
    report: {
      attempted: "Ran to completion but produced no commit",
      outputs: [],
      checksRun: [],
      unmetCriteria: [],
      limitations: ["No commit produced"],
      findings: [],
    },
  };
}

export function workerTimedOutOutput(
  attemptId: string,
): import("@agencyhq/contracts").WorkerAttemptOutput {
  return {
    attemptId,
    sessionId: null,
    outcome: "timed_out",
    worktreePath: `/worktrees/${attemptId}`,
    runDir: `/worktrees/${attemptId}/.run`,
    commitId: null,
    diffDigest: null,
    changedPaths: [],
    pathViolations: [],
    checkpointCommit: null,
    survivors: [],
    opencode: {
      sessionID: null,
      exitCode: null,
      denials: [],
      errors: [],
    },
    report: {
      attempted: "Timed out",
      outputs: [],
      checksRun: [],
      unmetCriteria: [],
      limitations: ["Timed out before completion"],
      findings: [],
    },
  };
}

export function workerPathViolationOutput(
  attemptId: string,
): import("@agencyhq/contracts").WorkerAttemptOutput {
  return {
    attemptId,
    sessionId: null,
    outcome: "path_violation",
    worktreePath: `/worktrees/${attemptId}`,
    runDir: `/worktrees/${attemptId}/.run`,
    commitId: null,
    diffDigest: null,
    changedPaths: ["package.json"],
    pathViolations: ["package.json"],
    checkpointCommit: null,
    survivors: [],
    opencode: {
      sessionID: null,
      exitCode: 1,
      denials: [{ tool: "edit", pattern: "package.json", message: "Path denied" }],
      errors: [],
    },
    report: {
      attempted: "Attempted path violation",
      outputs: [],
      checksRun: [],
      unmetCriteria: [],
      limitations: ["Path violation"],
      findings: [],
    },
  };
}

// ---------------------------------------------------------------------------
// ReviewOutput builder
// ---------------------------------------------------------------------------

export function goodReviewOutput(opts?: {
  attemptRevision?: string;
  diffDigest?: string;
  criteriaDigest?: string;
  profileDigest?: string;
}): ReviewOutput {
  return {
    reviewer: { model: "openai/gpt-5.6-sol" },
    subject: {
      attemptRevision: opts?.attemptRevision ?? "abcdef1234567890abcdef1234567890abcdef12",
      diffDigest: (opts?.diffDigest ??
        String(digestOf({ placeholder: "diff" }))) as import("@agencyhq/contracts").Digest,
      criteriaDigest: (opts?.criteriaDigest ??
        String(digestOf({ placeholder: "criteria" }))) as import("@agencyhq/contracts").Digest,
      profileDigest: (opts?.profileDigest ??
        String(digestOf({ placeholder: "profile" }))) as import("@agencyhq/contracts").Digest,
    },
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// AcceptanceProposal builder
// ---------------------------------------------------------------------------

export function goodAcceptanceProposal(
  criteriaIds: string[],
  verificationResultRefs: string[],
): AcceptanceProposal {
  return {
    accept: true,
    criteria: criteriaIds.map((id) => ({
      criterionId: id,
      satisfied: true,
      evidence: verificationResultRefs.map((ref) => ({
        kind: "verification_result" as const,
        ref,
      })),
    })),
    findingDispositions: [],
    rationale: "All criteria satisfied by verification results",
  };
}

export function rejectingAcceptanceProposal(): AcceptanceProposal {
  return {
    accept: false,
    criteria: [],
    findingDispositions: [],
    rationale: "Did not meet criteria",
  };
}

// ---------------------------------------------------------------------------
// VerificationResult builder
// ---------------------------------------------------------------------------

export function passingVerificationResult(opts: {
  verifierName: string;
  stepContractId: string;
  attemptId: string;
  criteriaDigest: string;
  profileDigest: string;
  baseRevision: string;
  attemptRevision: string;
  diffDigest: string;
  checkId?: string;
}): VerificationResult {
  const now = new Date().toISOString();
  return {
    verifier: { name: opts.verifierName, version: "1.0.0" },
    stepContractId: opts.stepContractId,
    attemptId: opts.attemptId,
    criteriaDigest: opts.criteriaDigest as import("@agencyhq/contracts").Digest,
    profileDigest: opts.profileDigest as import("@agencyhq/contracts").Digest,
    repository: "/repo",
    baseRevision: opts.baseRevision,
    attemptRevision: opts.attemptRevision,
    diffDigest: opts.diffDigest as import("@agencyhq/contracts").Digest,
    checkId: opts.checkId ?? "pnpm-test",
    environmentFingerprint: { node: "20.0.0" },
    startedAt: now,
    endedAt: now,
    exitStatus: 0,
    stdoutTail: "All tests passed",
    stderrTail: "",
    artifactDigests: [],
    result: "pass",
  };
}
