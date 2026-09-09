import { z } from "zod";
import { CriterionSchema, DigestStringSchema } from "../step-contract.ts";
import { VerificationResultSchema } from "../verification-result.ts";
import { ReviewOutputSchema } from "./lead-review.ts";

/**
 * Payload for the lead.accept task — v1.
 * payloadVersion 1 is the default when the field is absent.
 */
export const LeadAcceptPayloadSchema = z.object({
  payloadVersion: z.literal(1).optional(),
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
/** Alias for the v1 schema. */
export const LeadAcceptPayloadV1Schema = LeadAcceptPayloadSchema;
export type LeadAcceptPayloadV1 = LeadAcceptPayload;

/**
 * Payload for the lead.accept task — v2 (portable execution).
 *
 * lead.accept has no host filesystem path fields; v2 is structurally
 * identical except for the explicit payloadVersion discriminant. Strict
 * parsing ensures no legacy path fields are accidentally accepted.
 */
export const LeadAcceptPayloadV2Schema = z
  .object({
    payloadVersion: z.literal(2),
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
  })
  .strict();
export type LeadAcceptPayloadV2 = z.infer<typeof LeadAcceptPayloadV2Schema>;

/**
 * Union of v1 and v2. Use where both formats must be accepted.
 */
export const LeadAcceptPayloadAnySchema = z.union([
  LeadAcceptPayloadSchema,
  LeadAcceptPayloadV2Schema,
]);
export type LeadAcceptPayloadAny = z.infer<typeof LeadAcceptPayloadAnySchema>;

/** Type guard: returns true iff the payload is a v2 LeadAcceptPayload. */
export function isV2Payload(p: LeadAcceptPayloadAny): p is LeadAcceptPayloadV2 {
  return p.payloadVersion === 2;
}

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
