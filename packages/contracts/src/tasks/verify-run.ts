import { z } from "zod";

import { RevisionManifestSchema } from "../manifest.ts";
import { DigestStringSchema } from "../step-contract.ts";
import { VerificationResultSchema } from "../verification-result.ts";

export const VerifyRunPayloadSchema = z.object({
  attemptId: z.string().min(1),
  generation: z.number().int().min(0),
  contractId: z.string().min(1),
  profileId: z.string().min(1),
  profileDigest: DigestStringSchema,
  criteriaDigest: DigestStringSchema,
  repoPath: z.string().min(1),
  worktreeBase: z.string().min(1),
  baseRevision: z.string().min(1),
  attemptRevision: z.string().min(1),
  diffDigest: DigestStringSchema,
  /** Frozen profile protected paths (verifier-tampering detection); the
   * single source of truth for verify.run, copied from the profile by the
   * coordinator. Optional for older payloads: the task then uses the domain
   * default list. */
  protectedPaths: z.array(z.string().min(1)).optional(),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      command: z.array(z.string().min(1)),
      timeoutSeconds: z.number().int().min(1),
    }),
  ),
  /**
   * Revision manifest for multi-repository WorkItems. The verifier uses this
   * to confirm that the attempt revision is consistent with the plan.
   */
  manifest: RevisionManifestSchema.optional(),
});
export type VerifyRunPayload = z.infer<typeof VerifyRunPayloadSchema>;

export const VerifyRunIntegritySchema = z.object({
  tamperedPaths: z.array(z.string()),
  protectedPathsSource: z.enum(["payload", "default"]),
});
export type VerifyRunIntegrity = z.infer<typeof VerifyRunIntegritySchema>;

export const VerifyRunOutputSchema = z.object({
  results: z.array(VerificationResultSchema),
  /** Integrity metadata from tamper detection. Optional so older outputs
   * (before H-6) still parse; the coordinator treats absence as a pre-H-6
   * run with no tamper findings. */
  integrity: VerifyRunIntegritySchema.optional(),
});
export type VerifyRunOutput = z.infer<typeof VerifyRunOutputSchema>;
