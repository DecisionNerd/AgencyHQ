import { z } from "zod";

import {
  BoundarySchema,
  BudgetSchema,
  CapabilitiesSchema,
  ChangeClassSchema,
  PathsSchema,
  ReviewProfileSchema,
} from "./authority.ts";
import { CriterionSchema, CriterionSourceSchema } from "./step-contract.ts";

export type { CriterionSource } from "./step-contract.ts";
export { CriterionSchema, CriterionSourceSchema };

/** A Lead proposal: always a proposal, never a decision. The coordinator
 * validates each proposal deterministically against delegated authority
 * before recording it as a decision (ADR-0006). */
export const LeadProposalSchema = z.object({
  /** At least one criterion is required. */
  criteria: z.array(CriterionSchema).min(1),
  profileId: z.string().min(1),
  changeClass: ChangeClassSchema,
  review: ReviewProfileSchema,
  boundary: BoundarySchema,
  paths: PathsSchema,
  capabilities: CapabilitiesSchema,
  budget: BudgetSchema,
  models: z.object({
    worker: z.string().min(1),
    reviewer: z.string().min(1),
  }),
  rationale: z.string().min(1),
  /** Each entry records which source supplied a criterion and the citation. */
  sources: z.array(
    z.object({
      criterionId: z.string().min(1),
      source: CriterionSourceSchema,
      citation: z.string().min(1),
    }),
  ),
});
export type LeadProposal = z.infer<typeof LeadProposalSchema>;

/** Discriminated union of all possible lead.plan outputs. */
export const LeadPlanOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proposal"),
    proposal: LeadProposalSchema,
  }),
  z.object({
    kind: z.literal("needs_facts"),
    questions: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal("mapping_alert"),
    nearest: z.string(),
    failedEntry: z.string(),
  }),
  z.object({
    kind: z.literal("invalid_output"),
    reason: z.string(),
  }),
]);
export type LeadPlanOutput = z.infer<typeof LeadPlanOutputSchema>;
