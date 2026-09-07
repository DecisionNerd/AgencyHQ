import { z } from "zod";
import { CriterionSchema, DigestStringSchema } from "../step-contract.ts";
import { VerificationResultSchema } from "../verification-result.ts";
import { ReviewOutputSchema } from "./lead-review.ts";

export const LeadAcceptPayloadSchema = z.object({
  attemptId: z.string().min(1),
  generation: z.number().int().min(0),
  contractId: z.string().min(1),
  criteria: z.array(CriterionSchema),
  criteriaDigest: DigestStringSchema,
  profileDigest: DigestStringSchema,
  attemptRevision: z.string().min(1),
  diffDigest: DigestStringSchema,
  verificationResults: z.array(VerificationResultSchema),
  review: ReviewOutputSchema,
  model: z.string().min(1),
});
export type LeadAcceptPayload = z.infer<typeof LeadAcceptPayloadSchema>;

export const AcceptanceProposalSchema = z.object({
  accept: z.boolean(),
  criteria: z.array(
    z.object({
      criterionId: z.string().min(1),
      satisfied: z.boolean(),
      evidence: z.array(
        z.object({
          kind: z.enum(["verification_result", "diff", "review_finding"]),
          ref: z.string().min(1),
        }),
      ),
    }),
  ),
  findingDispositions: z.array(
    z.object({
      findingId: z.string().min(1),
      disposition: z.enum(["backlog", "remediate", "scope_decision", "block", "dismiss"]),
      reason: z.string(),
    }),
  ),
  rationale: z.string(),
});
export type AcceptanceProposal = z.infer<typeof AcceptanceProposalSchema>;
