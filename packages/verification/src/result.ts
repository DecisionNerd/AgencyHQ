/**
 * VerificationResult construction for @agencyhq/verification.
 *
 * Builds a fully-validated VerificationResult from observed check output.
 * The result field is derived solely from what the runner observed — never
 * from anything the worker claimed.
 */

import type { Digest, VerificationResult } from "@agencyhq/contracts";
import { VerificationResultSchema } from "@agencyhq/contracts";

import type { CheckDef } from "./checks.ts";
import type { RunCheckResult } from "./runner.ts";

// ---------------------------------------------------------------------------
// BuildVerificationResultInput
// ---------------------------------------------------------------------------

export interface BuildVerificationResultInput {
  verifier: {
    name: "agencyhq-verification";
    version: string;
  };
  stepContractId: string;
  attemptId: string;
  criteriaDigest: Digest;
  profileDigest: Digest;
  repository: string;
  baseRevision: string;
  attemptRevision: string;
  diffDigest: Digest;
  check: CheckDef;
  run: RunCheckResult;
  environmentFingerprint: Record<string, string>;
  artifactDigests?: Digest[] | undefined;
}

// ---------------------------------------------------------------------------
// buildVerificationResult
// ---------------------------------------------------------------------------

/**
 * Construct a VerificationResult from observed runner output.
 *
 * Result derivation (TESTING.md §89-94):
 * - "error"  when timedOut is true or exitStatus is null
 * - "pass"   when passWhen predicate returns true (default: exitStatus === 0)
 * - "fail"   otherwise
 *
 * Validates through VerificationResultSchema.parse before returning,
 * so callers get a ParseError if any required field is missing or invalid.
 */
export function buildVerificationResult(input: BuildVerificationResultInput): VerificationResult {
  const { check, run } = input;

  // Derive result.
  let result: "pass" | "fail" | "error";
  if (run.timedOut || run.exitStatus === null) {
    result = "error";
  } else if (check.passWhen !== undefined) {
    result = check.passWhen({
      exitStatus: run.exitStatus,
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
    })
      ? "pass"
      : "fail";
  } else {
    result = run.exitStatus === 0 ? "pass" : "fail";
  }

  // Build and validate the record.
  const record = VerificationResultSchema.parse({
    verifier: input.verifier,
    stepContractId: input.stepContractId,
    attemptId: input.attemptId,
    criteriaDigest: input.criteriaDigest,
    profileDigest: input.profileDigest,
    repository: input.repository,
    baseRevision: input.baseRevision,
    attemptRevision: input.attemptRevision,
    diffDigest: input.diffDigest,
    checkId: check.id,
    environmentFingerprint: input.environmentFingerprint,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitStatus: run.exitStatus,
    stdoutTail: run.stdoutTail,
    stderrTail: run.stderrTail,
    artifactDigests: input.artifactDigests ?? [],
    result,
  });

  return record;
}
