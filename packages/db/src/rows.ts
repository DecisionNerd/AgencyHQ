/**
 * Zod row schemas for all ledger tables.
 * All columns are snake_case as stored in Postgres.
 * mapRow helpers parse JSONB columns into their contracts types.
 */

import {
  AuthoritySchema,
  ContractBoundsSchema,
  CriterionSchema,
  VerificationResultSchema,
} from "@agencyhq/contracts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NullableText = z.string().nullable();
const NullableInt = z.number().int().nullable();
const Timestamps = z.object({
  created_at: z.date(),
  updated_at: z.date(),
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const ProjectRowSchema = z
  .object({
    id: z.string(),
    remote: NullableText,
    clone_path: NullableText,
    worktree_base: NullableText,
    allowed_refs: z.unknown().nullable(),
    profile_catalog: z.unknown().nullable(),
    authority: z.unknown(),
    authority_version: z.string(),
  })
  .merge(Timestamps);

export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export function mapProjectRow(row: ProjectRow) {
  return {
    ...row,
    authority: AuthoritySchema.parse(row.authority),
  };
}

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

export const WorkItemRowSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    rank: z.number().int(),
    intent: z.string(),
    defect: NullableText,
    boundary: z.enum(["artifact", "merge", "deploy"]),
    lifecycle: z.string(),
    condition: z.string(),
    main_effort: z.boolean(),
    version: z.number().int(),
  })
  .merge(Timestamps);

export type WorkItemRow = z.infer<typeof WorkItemRowSchema>;

// ---------------------------------------------------------------------------
// step_contracts
// ---------------------------------------------------------------------------

export const StepContractRowSchema = z
  .object({
    id: z.string(),
    work_item_id: z.string(),
    project_id: z.string(),
    version: z.number().int(),
    base_revision: z.string(),
    inputs: z.unknown(),
    criteria: z.unknown(),
    criteria_digest: z.string(),
    profile_id: z.string(),
    profile_digest: z.string(),
    bounds: z.unknown(),
    required_boundaries: z.unknown(),
    human_required: z.boolean(),
    status: z.string(),
    superseded_by: NullableText,
    target_ref: NullableText.default(null),
    manifest_digest: NullableText.default(null),
  })
  .merge(Timestamps);

export type StepContractRow = z.infer<typeof StepContractRowSchema>;

export function mapStepContractRow(row: StepContractRow) {
  return {
    ...row,
    bounds: ContractBoundsSchema.parse(row.bounds),
    criteria: z.array(CriterionSchema).parse(row.criteria),
  };
}

// ---------------------------------------------------------------------------
// attempts
// ---------------------------------------------------------------------------

export const AttemptRowSchema = z
  .object({
    id: z.string(),
    contract_id: z.string(),
    contract_version: z.number().int(),
    generation: z.number().int(),
    status: z.string(),
    run_id: NullableText,
    worktree_path: NullableText,
    session_id: NullableText,
    commit_sha: NullableText,
    diff_digest: NullableText,
    checkpoint_commit: NullableText,
    failure_id: NullableText,
    budget_remaining: z.number().int(),
  })
  .merge(Timestamps);

export type AttemptRow = z.infer<typeof AttemptRowSchema>;

// ---------------------------------------------------------------------------
// dispatch_intents
// ---------------------------------------------------------------------------

export const DispatchIntentRowSchema = z
  .object({
    id: z.string(),
    task: z.string(),
    payload_digest: z.string(),
    attempt_id: NullableText,
    status: z.string(),
    run_id: NullableText,
    idempotency_key: z.string(),
  })
  .merge(Timestamps);

export type DispatchIntentRow = z.infer<typeof DispatchIntentRowSchema>;

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export const ArtifactRowSchema = z
  .object({
    id: z.string(),
    attempt_id: z.string(),
    revision: z.string(),
    diff_digest: z.string(),
    changed_paths: z.unknown(),
  })
  .merge(Timestamps);

export type ArtifactRow = z.infer<typeof ArtifactRowSchema>;

// ---------------------------------------------------------------------------
// verification_results
// ---------------------------------------------------------------------------

export const VerificationResultRowSchema = z
  .object({
    id: z.string(),
    attempt_id: z.string(),
    step_contract_id: z.string(),
    record: z.unknown(),
    result: z.string(),
  })
  .merge(Timestamps);

export type VerificationResultRow = z.infer<typeof VerificationResultRowSchema>;

export function mapVerificationResultRow(row: VerificationResultRow) {
  return {
    ...row,
    record: VerificationResultSchema.parse(row.record),
  };
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

export const ReviewRowSchema = z
  .object({
    id: z.string(),
    attempt_id: z.string(),
    attempt_revision: NullableText,
    diff_digest: NullableText,
    criteria_digest: NullableText,
    profile_digest: NullableText,
    reviewer_model: z.string(),
    profile: z.string(),
    findings: z.unknown(),
  })
  .merge(Timestamps);

export type ReviewRow = z.infer<typeof ReviewRowSchema>;

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

export const DecisionRowSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    actor: z.string(),
    proposal_digest: NullableText,
    authority_version: NullableText,
    work_item_id: NullableText,
    contract_id: NullableText,
    contract_version: NullableInt,
    attempt_id: NullableText,
    causation_id: NullableText,
    command_id: NullableText,
    outcome: NullableText,
    at: z.date(),
  })
  .merge(Timestamps);

export type DecisionRow = z.infer<typeof DecisionRowSchema>;

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export const ApprovalRowSchema = z
  .object({
    id: z.string(),
    decision_id: z.string(),
    contract_id: NullableText,
    contract_version: NullableInt,
    attempt_revision: NullableText,
    human_actor: NullableText,
    at: z.date().nullable(),
  })
  .merge(Timestamps);

export type ApprovalRow = z.infer<typeof ApprovalRowSchema>;

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

export const FindingRowSchema = z
  .object({
    id: z.string(),
    attempt_id: NullableText,
    severity: z.string(),
    kind: z.string(),
    description: z.string(),
    evidence: NullableText,
    disposition: NullableText,
  })
  .merge(Timestamps);

export type FindingRow = z.infer<typeof FindingRowSchema>;

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

export const FailureRowSchema = z
  .object({
    id: z.string(),
    class: z.string(),
    phase: z.string(),
    attempt_id: NullableText,
    run_id: NullableText,
    cause: z.string(),
    evidence: NullableText,
  })
  .merge(Timestamps);

export type FailureRow = z.infer<typeof FailureRowSchema>;

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

export const TransitionRowSchema = z.object({
  id: z.number(), // bigserial returned as number by pg
  aggregate: NullableText,
  aggregate_id: NullableText,
  from_state: NullableText,
  to_state: NullableText,
  actor: NullableText,
  causation_id: NullableText,
  command_id: NullableText,
  at: z.date().nullable(),
});

export type TransitionRow = z.infer<typeof TransitionRowSchema>;

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export const CommandRowSchema = z.object({
  command_id: z.string(),
  kind: z.string(),
  result: z.unknown().nullable(),
  at: z.date().nullable(),
  created_at: z.date(),
});

export type CommandRow = z.infer<typeof CommandRowSchema>;

// ---------------------------------------------------------------------------
// run_observations
// ---------------------------------------------------------------------------

export const RunObservationRowSchema = z.object({
  run_id: z.string(),
  generation: z.number().int(),
  stale: z.boolean(),
  payload: z.unknown(),
  observed_at: z.date().nullable(),
});

export type RunObservationRow = z.infer<typeof RunObservationRowSchema>;

// ---------------------------------------------------------------------------
// work_item_projects
// ---------------------------------------------------------------------------

export const WorkItemProjectRowSchema = z
  .object({
    work_item_id: z.string(),
    project_id: z.string(),
    position: z.number().int(),
    target_ref: z.string(),
    expected_base_revision: z.string(),
    result_revision: NullableText,
  })
  .merge(Timestamps);

export type WorkItemProjectRow = z.infer<typeof WorkItemProjectRowSchema>;

// ---------------------------------------------------------------------------
// integrations
// ---------------------------------------------------------------------------

export const IntegrationRowSchema = z
  .object({
    id: z.string(),
    attempt_id: z.string(),
    contract_id: z.string(),
    contract_version: z.number().int(),
    target_ref: z.string(),
    expected_base_revision: z.string(),
    resulting_revision: NullableText,
    outcome: NullableText,
    run_id: NullableText,
    at: z.date(),
  })
  .merge(Timestamps);

export type IntegrationRow = z.infer<typeof IntegrationRowSchema>;
