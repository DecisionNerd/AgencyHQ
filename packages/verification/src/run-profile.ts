/**
 * Profile runner for @agencyhq/verification.
 *
 * Runs all checks in a VerificationProfile sequentially and returns one
 * VerificationResult per check.
 */

import type { Digest, VerificationResult } from "@agencyhq/contracts";

import { CHECK_CATALOG } from "./checks.ts";
import { environmentFingerprint } from "./fingerprint.ts";
import type { VerificationProfile } from "./profiles.ts";
import { buildVerificationResult } from "./result.ts";
import { runCheck } from "./runner.ts";

// ---------------------------------------------------------------------------
// RunProfileInput
// ---------------------------------------------------------------------------

export interface RunProfileInput {
  profile: VerificationProfile;
  cwd: string;
  verifierVersion: string;
  stepContractId: string;
  attemptId: string;
  criteriaDigest: Digest;
  profileDigest: Digest;
  repository: string;
  baseRevision: string;
  attemptRevision: string;
  diffDigest: Digest;
  env?: Record<string, string> | undefined;
  artifactDigests?: Digest[] | undefined;
}

// ---------------------------------------------------------------------------
// runProfile
// ---------------------------------------------------------------------------

/**
 * Run all checks in `profile` sequentially.
 *
 * Returns one VerificationResult per check.  A check failure does not
 * short-circuit subsequent checks — all checks run regardless.
 */
export async function runProfile(input: RunProfileInput): Promise<VerificationResult[]> {
  const fingerprint = await environmentFingerprint(input.cwd);

  const results: VerificationResult[] = [];

  for (const checkId of input.profile.checks) {
    const def = CHECK_CATALOG[checkId];
    if (def === undefined) {
      throw new Error(`runProfile: unknown check id "${checkId}" in profile "${input.profile.id}"`);
    }

    const run = await runCheck(def, {
      cwd: input.cwd,
      env: input.env,
    });

    const vr = buildVerificationResult({
      verifier: { name: "agencyhq-verification", version: input.verifierVersion },
      stepContractId: input.stepContractId,
      attemptId: input.attemptId,
      criteriaDigest: input.criteriaDigest,
      profileDigest: input.profileDigest,
      repository: input.repository,
      baseRevision: input.baseRevision,
      attemptRevision: input.attemptRevision,
      diffDigest: input.diffDigest,
      check: def,
      run,
      environmentFingerprint: fingerprint,
      artifactDigests: input.artifactDigests,
    });

    results.push(vr);
  }

  return results;
}
