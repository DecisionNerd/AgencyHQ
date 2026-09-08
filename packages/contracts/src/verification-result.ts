import { z } from "zod";

import { DigestStringSchema as DigestSchema } from "./step-contract.ts";

/** Maximum bytes stored for stdout/stderr tail (16 KiB). */
const MAX_OUTPUT_BYTES = 16_384;

/**
 * Minimum verification record as specified in TESTING.md §89-94.
 * Every field is required; nothing may be dropped.
 */
export const VerificationResultSchema = z.object({
  verifier: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  stepContractId: z.string().min(1),
  attemptId: z.string().min(1),
  criteriaDigest: DigestSchema,
  profileDigest: DigestSchema,
  repository: z.string().min(1),
  baseRevision: z.string().min(1),
  attemptRevision: z.string().min(1),
  diffDigest: DigestSchema,
  checkId: z.string().min(1),
  /** Host toolchain versions, or task image digest on the container profile. */
  environmentFingerprint: z.record(z.string(), z.string()),
  /** ISO 8601 timestamp. */
  startedAt: z.string().datetime(),
  /** ISO 8601 timestamp. */
  endedAt: z.string().datetime(),
  exitStatus: z.number().int().nullable(),
  /** Bounded to ≤ 16 KiB. */
  stdoutTail: z.string().max(MAX_OUTPUT_BYTES),
  /** Bounded to ≤ 16 KiB. */
  stderrTail: z.string().max(MAX_OUTPUT_BYTES),
  artifactDigests: z.array(DigestSchema),
  result: z.enum(["pass", "fail", "error"]),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
