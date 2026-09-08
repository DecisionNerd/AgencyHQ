/**
 * StepContract schema for AgencyHQ.
 * See: docs/engineering/DOMAIN_MODEL.md (aggregate table, authority narrowing, state transitions)
 * See: docs/engineering/PROCESS_CATALOG.md lines 13-51 (bounded repair v1 contract)
 */

import { z } from "zod";

import type { Boundary, ChangeClass, ReviewProfile, WorkerTool } from "./authority.ts";
import {
  BoundarySchema,
  ChangeClassSchema,
  ReviewProfileSchema,
  WorkerToolSchema,
} from "./authority.ts";

import { BoundaryKindSchema } from "./runtime-profile.ts";

// Re-export digest schema for callers
export { DigestSchema } from "./authority.ts";
export type { Digest } from "./digest.ts";

// ---------------------------------------------------------------------------
// CriterionSource
// See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md —
// Lead structured output must cite which criteria came from which source.
// ---------------------------------------------------------------------------
export type CriterionSource = "operator" | "repository" | "lead";

export const CriterionSourceSchema = z.union([
  z.literal("operator"),
  z.literal("repository"),
  z.literal("lead"),
]);

// ---------------------------------------------------------------------------
// CriterionSchema
// ---------------------------------------------------------------------------
export const CriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: CriterionSourceSchema,
  citation: z.string().min(1).optional(),
});

export type Criterion = z.infer<typeof CriterionSchema>;

// ---------------------------------------------------------------------------
// ContractBoundsSchema
// The concrete bounds frozen into a StepContract.
// Single worker and reviewer model (not arrays — one execution context).
// ---------------------------------------------------------------------------
export const ContractBoundsSchema = z.object({
  paths: z.object({
    allow: z.array(z.string().min(1)),
    deny: z.array(z.string().min(1)),
  }),
  capabilities: z.object({
    bash: z.object({
      allow: z.array(z.string().min(1)),
      deny: z.array(z.string().min(1)),
    }),
    tools: z.record(WorkerToolSchema, z.boolean()),
  }),
  boundary: BoundarySchema,
  budget: z.object({
    maxAttempts: z.int().gte(1),
    maxDurationSeconds: z.int().gte(5),
    machine: z.string().min(1).optional(),
    estimatedSpendUsd: z.number().gte(0),
  }),
  review: ReviewProfileSchema,
  changeClass: ChangeClassSchema,
  models: z.object({
    worker: z.string().min(1),
    reviewer: z.string().min(1),
  }),
});

export type ContractBounds = z.infer<typeof ContractBoundsSchema>;

// ---------------------------------------------------------------------------
// StepContractSchema
// Immutable: inputs, base revision, allowed paths, OpenCode permission rules,
// required runtime boundaries, maxDuration, attempt budget, expected outputs,
// criteria and profile digests.
// See: docs/engineering/DOMAIN_MODEL.md (StepContract fields, aggregate table)
// ---------------------------------------------------------------------------
const BaseRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-hex git revision");

/**
 * JSON-Schema-representable digest validator (z.string + regex).
 * Use in task schemas and output schemas where z.toJSONSchema() must succeed.
 * DigestSchema (from authority.ts) uses z.custom() for branded types and
 * cannot be serialized to JSON Schema.
 */
export const DigestStringSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const DigestFieldSchema = DigestStringSchema;

export const StepContractSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  projectId: z.string().min(1),
  /** Monotonic version counter. Supersede, never rebind. */
  version: z.int().gte(1),
  /** 40-hex git commit sha pinning the base revision. */
  baseRevision: BaseRevisionSchema,
  inputs: z.object({
    intent: z.string().min(1),
    defect: z.string().min(1).optional(),
    /**
     * Git ref to integrate into (e.g. "refs/heads/main").
     * Required for merge and deploy boundary contracts; absent for
     * artifact-only contracts.
     */
    targetRef: z.string().min(1).optional(),
    /**
     * Digest of the RevisionManifest for multi-repository WorkItems.
     * Absent for single-repository contracts.
     */
    manifestDigest: DigestFieldSchema.optional(),
  }),
  /** At least one criterion required. */
  criteria: z.array(CriterionSchema).min(1),
  /**
   * SHA-256 digest of the canonical criteria object.
   * Computed by packages/domain via digestOf(criteriaDigestInput(criteria)).
   * Frozen before the worker runs; never present in the worker's writable tree.
   */
  criteriaDigest: DigestFieldSchema,
  /** Identifies the verification profile applied. */
  profileId: z.string().min(1),
  /**
   * SHA-256 digest of the verification profile at time of contract creation.
   * Frozen before the worker runs.
   */
  profileDigest: DigestFieldSchema,
  bounds: ContractBoundsSchema,
  /** Subset of BoundaryKinds the runtime profile must enforce (not advisory). */
  requiredBoundaries: z.array(BoundaryKindSchema),
  /** Whether a human Approval is required before completion. */
  humanRequired: z.boolean(),
  status: z.union([z.literal("active"), z.literal("superseded")]),
  /** Id of the StepContract that supersedes this one, if any. */
  supersededBy: z.string().min(1).optional(),
});

export type StepContract = z.infer<typeof StepContractSchema>;

// ---------------------------------------------------------------------------
// criteriaDigestInput
// Returns the canonical object to digest for criteriaDigest.
// Only id, text, source are included — citation is omitted for stability.
// packages/domain computes the actual digest via digestOf(criteriaDigestInput(criteria)).
// ---------------------------------------------------------------------------
export function criteriaDigestInput(
  criteria: readonly Criterion[],
): { id: string; text: string; source: CriterionSource }[] {
  return criteria.map(({ id, text, source }) => ({ id, text, source }));
}

// Explicit type re-exports for callers (BoundaryKind re-exported from runtime-profile.ts)
export type { Boundary, ChangeClass, ReviewProfile, WorkerTool };
