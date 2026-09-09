import { z } from "zod";
import { PermissionRulesetSchema } from "../opencode/permissions.ts";
import type { SourceRef } from "../source.ts";
import { SourceRefSchema } from "../source.ts";
import { ContractBoundsSchema } from "../step-contract.ts";
import type { WorkerReport } from "../worker-report.ts";
import { WorkerReportSchema } from "../worker-report.ts";

/**
 * Payload for the worker.attempt task — v1.
 *
 * Superset-compatible formalization of the spike's WorkerAttemptPayload
 * (trigger/src/types.ts): same field names, plus generation, contractId,
 * contractVersion, bounds, permissionRules, and model (now required).
 *
 * payloadVersion 1 is the default when the field is absent.
 */
export const WorkerAttemptPayloadSchema = z.object({
  payloadVersion: z.literal(1).optional(),
  attemptId: z.string().min(1),
  /** Monotonically increasing per-attempt generation; guards stale replays. */
  generation: z.number().int().min(0),
  contractId: z.string().min(1),
  contractVersion: z.string().min(1),
  repoPath: z.string().min(1),
  baseRev: z.string().min(1),
  prompt: z.string().min(1),
  allowedPaths: z.array(z.string()),
  /** Structured contract bounds (paths, capabilities, boundary, budget, etc.). */
  bounds: ContractBoundsSchema,
  /** OpenCode permission rules for this attempt. */
  permissionRules: PermissionRulesetSchema,
  model: z.string().min(1),
  worktreeBase: z.string().optional(),
});
export type WorkerAttemptPayload = z.infer<typeof WorkerAttemptPayloadSchema>;
/** Alias for clarity; the main export keeps its existing name for compatibility. */
export const WorkerAttemptPayloadV1Schema = WorkerAttemptPayloadSchema;
export type WorkerAttemptPayloadV1 = WorkerAttemptPayload;

/**
 * Payload for the worker.attempt task — v2 (portable execution).
 *
 * Host filesystem paths are replaced by portable SourceRef. Workers fetch
 * source bundles from the coordinator internal API rather than reading mounts.
 * Strict parsing: presence of repoPath or worktreeBase is rejected.
 */
export const WorkerAttemptPayloadV2Schema = z
  .object({
    payloadVersion: z.literal(2),
    attemptId: z.string().min(1),
    generation: z.number().int().min(0),
    contractId: z.string().min(1),
    contractVersion: z.string().min(1),
    /** Source reference (replaces repoPath + worktreeBase). */
    source: SourceRefSchema,
    baseRev: z.string().min(1),
    prompt: z.string().min(1),
    allowedPaths: z.array(z.string()),
    bounds: ContractBoundsSchema,
    permissionRules: PermissionRulesetSchema,
    model: z.string().min(1),
  })
  .strict();
export type WorkerAttemptPayloadV2 = z.infer<typeof WorkerAttemptPayloadV2Schema>;

/**
 * Union of v1 and v2. Use where both formats must be accepted.
 * The existing WorkerAttemptPayloadSchema is kept as v1 to preserve trigger/ compatibility.
 */
export const WorkerAttemptPayloadAnySchema = z.union([
  WorkerAttemptPayloadSchema,
  WorkerAttemptPayloadV2Schema,
]);
export type WorkerAttemptPayloadAny = z.infer<typeof WorkerAttemptPayloadAnySchema>;

/** Type guard: returns true iff the payload is a v2 WorkerAttemptPayload. */
export function isV2Payload(
  p: WorkerAttemptPayloadAny,
): p is WorkerAttemptPayloadV2 & { source: SourceRef } {
  return p.payloadVersion === 2;
}

// Re-export WorkerReport so importers need only this module.
export type { WorkerReport };

/**
 * Output from the worker.attempt task.
 *
 * Extends the spike's WorkerAttemptOutput with a structured worker report
 * and the OpenCode session id.
 */
export const WorkerAttemptOutputSchema = z.object({
  attemptId: z.string().min(1),
  /** OpenCode session id for tracing (informational; never used as evidence). */
  sessionId: z.string().nullable(),
  outcome: z.enum(["completed", "path_violation", "opencode_error", "cancelled", "timed_out"]),
  worktreePath: z.string(),
  runDir: z.string(),
  commitId: z.string().nullable(),
  diffDigest: z.string().nullable(),
  changedPaths: z.array(z.string()),
  pathViolations: z.array(z.string()),
  checkpointCommit: z.string().nullable(),
  survivors: z.array(z.number().int()),
  opencode: z.object({
    sessionID: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    denials: z.array(
      z.object({
        tool: z.string(),
        // Optional in the adapter; the runtime serializes an absent value as
        // null (observed 2026-09-08 on a tool denial without a command).
        pattern: z.string().nullable().optional(),
        message: z.string(),
      }),
    ),
    errors: z.array(z.string()),
  }),
  /** Worker self-report: context, never evidence. */
  report: WorkerReportSchema,
});
export type WorkerAttemptOutput = z.infer<typeof WorkerAttemptOutputSchema>;
