/**
 * Pure builders from ledger records to task payloads.
 * All payloads are validated by contract schemas before returning.
 *
 * R-002: these functions never trigger — they only build the data.
 */

import type {
  Authority,
  Criterion,
  LeadProposal,
  ReviewOutput,
  StepContract,
} from "@agencyhq/contracts";
import {
  criteriaDigestInput,
  digestOf,
  LeadAcceptPayloadSchema,
  LeadPlanPayloadSchema,
  LeadReviewPayloadSchema,
  permissionRulesFor,
  VerifyRunPayloadSchema,
  WorkerAttemptPayloadSchema,
} from "@agencyhq/contracts";
import type { ProfileResolver } from "./types.ts";

// ---------------------------------------------------------------------------
// Types for ledger records (subset of row fields needed)
// ---------------------------------------------------------------------------

interface ProjectRecord {
  id: string;
  clone_path: string | null;
  worktree_base: string | null;
  authority: Authority;
  authority_version: string;
}

interface WorkItemRecord {
  id: string;
  project_id: string;
  intent: string;
  defect?: string | null;
  boundary: "artifact" | "merge" | "deploy";
}

interface ContractRecord {
  id: string;
  version: number;
  base_revision: string;
  profile_id: string;
  profile_digest: string;
  criteria_digest: string;
  bounds: StepContract["bounds"];
  criteria: Criterion[];
}

interface AttemptRecord {
  id: string;
  contract_id: string;
  contract_version: number;
  generation: number;
  commit_sha?: string | null;
  diff_digest?: string | null;
  worktree_path?: string | null;
}

// ---------------------------------------------------------------------------
// leadPlanPayload
// ---------------------------------------------------------------------------

export function leadPlanPayload(
  project: ProjectRecord,
  workItem: WorkItemRecord,
  opts: {
    baseRevision: string;
    worktreeBase: string;
    model: string;
    narrowing?: LeadProposal | undefined;
  },
): ReturnType<typeof LeadPlanPayloadSchema.parse> {
  const payload = {
    workItemId: workItem.id,
    projectId: project.id,
    repoPath: project.clone_path ?? opts.worktreeBase,
    baseRevision: opts.baseRevision,
    worktreeBase: opts.worktreeBase,
    authority: project.authority,
    operatorIntent: workItem.intent,
    ...(workItem.defect ? { defect: workItem.defect } : {}),
    model: opts.model,
  };
  return LeadPlanPayloadSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// workerAttemptPayload
// ---------------------------------------------------------------------------

export function workerAttemptPayload(
  project: ProjectRecord,
  contract: ContractRecord,
  attempt: AttemptRecord,
  opts: { worktreeBase: string; workerModel: string },
): ReturnType<typeof WorkerAttemptPayloadSchema.parse> {
  const worktreePath = attempt.worktree_path ?? `${opts.worktreeBase}/${attempt.id}`;
  const bounds = contract.bounds;
  const permissionRules = permissionRulesFor(bounds, { worktreePath });
  const payload = {
    attemptId: attempt.id,
    generation: attempt.generation,
    contractId: contract.id,
    contractVersion: String(contract.version),
    repoPath: project.clone_path ?? opts.worktreeBase,
    baseRev: contract.base_revision,
    prompt: `Execute bounded repair for contract ${contract.id}`,
    allowedPaths: bounds.paths.allow,
    bounds,
    permissionRules,
    model: opts.workerModel,
    worktreeBase: opts.worktreeBase,
  };
  return WorkerAttemptPayloadSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// verifyRunPayload
// ---------------------------------------------------------------------------

export async function verifyRunPayload(
  contract: ContractRecord,
  attempt: AttemptRecord,
  opts: {
    repoPath: string;
    worktreeBase: string;
    attemptRevision: string;
    diffDigest: string;
    profileResolver: ProfileResolver;
  },
): Promise<ReturnType<typeof VerifyRunPayloadSchema.parse>> {
  const resolved = await opts.profileResolver(contract.profile_id);
  const payload = {
    attemptId: attempt.id,
    generation: attempt.generation,
    contractId: contract.id,
    profileId: contract.profile_id,
    profileDigest: resolved.digest,
    criteriaDigest: contract.criteria_digest,
    repoPath: opts.repoPath,
    worktreeBase: opts.worktreeBase,
    baseRevision: contract.base_revision,
    attemptRevision: opts.attemptRevision,
    diffDigest: opts.diffDigest,
    checks: resolved.checks,
  };
  return VerifyRunPayloadSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// leadReviewPayload
// ---------------------------------------------------------------------------

export function leadReviewPayload(
  contract: ContractRecord,
  attempt: AttemptRecord,
  opts: {
    repoPath: string;
    worktreeBase: string;
    baseRevision: string;
    patchPath: string;
    verificationResults: ReturnType<typeof VerifyRunPayloadSchema.parse>["checks"] extends unknown[]
      ? unknown[]
      : never;
    model: string;
    profileDigest: string;
  },
): ReturnType<typeof LeadReviewPayloadSchema.parse> {
  if (!attempt.commit_sha) {
    throw new Error("leadReviewPayload: attempt.commit_sha is required");
  }
  if (!attempt.diff_digest) {
    throw new Error("leadReviewPayload: attempt.diff_digest is required");
  }
  const payload = {
    attemptId: attempt.id,
    generation: attempt.generation,
    contractId: contract.id,
    criteria: contract.criteria,
    criteriaDigest: contract.criteria_digest,
    profileDigest: opts.profileDigest,
    attemptRevision: attempt.commit_sha,
    diffDigest: attempt.diff_digest,
    patchPath: opts.patchPath,
    verificationResults: opts.verificationResults,
    model: opts.model,
    repoPath: opts.repoPath,
    worktreeBase: opts.worktreeBase,
    baseRevision: opts.baseRevision,
  };
  return LeadReviewPayloadSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// leadAcceptPayload
// ---------------------------------------------------------------------------

export function leadAcceptPayload(
  contract: ContractRecord,
  attempt: AttemptRecord,
  opts: {
    verificationResults: unknown[];
    review: ReviewOutput;
    model: string;
    profileDigest: string;
  },
): ReturnType<typeof LeadAcceptPayloadSchema.parse> {
  if (!attempt.commit_sha) {
    throw new Error("leadAcceptPayload: attempt.commit_sha is required");
  }
  if (!attempt.diff_digest) {
    throw new Error("leadAcceptPayload: attempt.diff_digest is required");
  }
  const payload = {
    attemptId: attempt.id,
    generation: attempt.generation,
    contractId: contract.id,
    criteria: contract.criteria,
    criteriaDigest: contract.criteria_digest,
    profileDigest: opts.profileDigest,
    attemptRevision: attempt.commit_sha,
    diffDigest: attempt.diff_digest,
    verificationResults: opts.verificationResults,
    review: opts.review,
    model: opts.model,
  };
  return LeadAcceptPayloadSchema.parse(payload);
}

// Re-export for convenience
export { criteriaDigestInput, digestOf };
