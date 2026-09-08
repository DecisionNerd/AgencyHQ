import { z } from "zod";
import { CriterionSchema, DigestStringSchema } from "../step-contract.ts";
import { VerificationResultSchema } from "../verification-result.ts";

/**
 * Payload for the lead.review task.
 *
 * Independence invariant (ADR-0006): this payload must contain NO field
 * carrying a worker session id, conversation transcript, or any other
 * worker-internal context. The reviewer is seeded only with the diff,
 * approved criteria, and verification results.
 */
export const LeadReviewPayloadSchema = z.object({
  attemptId: z.string().min(1),
  generation: z.number().int().min(0),
  contractId: z.string().min(1),
  criteria: z.array(CriterionSchema),
  criteriaDigest: DigestStringSchema,
  profileDigest: DigestStringSchema,
  attemptRevision: z.string().min(1),
  diffDigest: DigestStringSchema,
  /** Path to the patch file in the review worktree. */
  patchPath: z.string().min(1),
  verificationResults: z.array(VerificationResultSchema),
  model: z.string().min(1),
  repoPath: z.string().min(1),
  worktreeBase: z.string().min(1),
  baseRevision: z.string().min(1),
  // NOTE: sessionId and transcript are intentionally absent (ADR-0006 independence).
});
export type LeadReviewPayload = z.infer<typeof LeadReviewPayloadSchema>;

export const ReviewOutputSchema = z.object({
  reviewer: z.object({
    model: z.string().min(1),
  }),
  subject: z.object({
    attemptRevision: z.string().min(1),
    diffDigest: DigestStringSchema,
    criteriaDigest: DigestStringSchema,
    profileDigest: DigestStringSchema,
  }),
  findings: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.enum(["blocking", "non_blocking"]),
      kind: z.enum([
        "unmet_criterion",
        "weakened_check",
        "verifier_tampered",
        "scope_violation",
        "defect",
        "style",
        "unrelated",
      ]),
      description: z.string(),
      evidence: z.string(),
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
