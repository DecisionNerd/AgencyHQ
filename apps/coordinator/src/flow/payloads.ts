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
  profile_catalog?: unknown;
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
    profileCatalog: Array.isArray(project.profile_catalog)
      ? (project.profile_catalog as string[])
      : ["node-pnpm-v1"],
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

// ---------------------------------------------------------------------------
// buildLeadPlanIntent
// ---------------------------------------------------------------------------

/**
 * Describes one entry's position in a multi-repository manifest.
 * Used to produce an entry-scoped operatorIntent for lead.plan payloads.
 */
export interface ManifestEntryContext {
  /** Zero-based position of this entry in the manifest. */
  position: number;
  /** Total number of entries in the manifest. */
  totalEntries: number;
  /** Project ID for this entry. */
  projectId: string;
  /** Local clone path for this entry's project, or null if unknown. */
  clonePath: string | null;
  /** All entries (including this one) — used to describe siblings. */
  allEntries: ReadonlyArray<{
    position: number;
    projectId: string;
    resultRevision: string | null;
  }>;
}

/**
 * Build the operatorIntent string for a lead.plan payload.
 *
 * For merge-boundary work items, appends the boundary requirement so the Lead
 * knows to propose `boundary: "merge"` (R-015 / R-018).
 *
 * For manifest work items, prepends an entry-context line naming the entry's
 * project and its role, plus a summary of sibling entries.
 *
 * This function is the single source of truth for operatorIntent construction —
 * both the initial plan() dispatch and the next-entry lead.plan dispatch in
 * integrate.ts must call it so the Lead always receives the same framing.
 */
export function buildLeadPlanIntent(
  baseIntent: string,
  opts: {
    boundary: "artifact" | "merge" | "deploy";
    manifestEntry?: ManifestEntryContext;
  },
): string {
  let intent = baseIntent;

  if (opts.manifestEntry) {
    const { position, totalEntries, projectId, clonePath, allEntries } = opts.manifestEntry;
    const pathSuffix = clonePath ? ` (${clonePath})` : "";
    const siblings = allEntries
      .filter((e) => e.position !== position)
      .map((e) => `${e.position} = ${e.projectId} at ${e.resultRevision ?? "pending"}`)
      .join(", ");
    const entryLine =
      `Manifest entry ${position} of ${totalEntries}: project ${projectId}${pathSuffix}` +
      (siblings ? `; sibling entries: ${siblings}` : "");
    intent = `${intent}\n\n${entryLine}`;
  }

  if (opts.boundary === "merge") {
    intent = `${intent}\n\nIntegration requirement: this work item completes at the merge boundary; propose boundary merge.`;
  }

  return intent;
}

// Re-export for convenience
export { criteriaDigestInput, digestOf };
