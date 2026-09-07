import { z } from "zod";
import { PermissionRulesetSchema } from "../opencode/permissions.ts";
import { ContractBoundsSchema } from "../step-contract.ts";
import type { WorkerReport } from "../worker-report.ts";
import { WorkerReportSchema } from "../worker-report.ts";

/**
 * Payload for the worker.attempt task.
 *
 * Superset-compatible formalization of the spike's WorkerAttemptPayload
 * (trigger/src/types.ts): same field names, plus generation, contractId,
 * contractVersion, bounds, permissionRules, and model (now required).
 */
export const WorkerAttemptPayloadSchema = z.object({
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
        pattern: z.string().optional(),
        message: z.string(),
      }),
    ),
    errors: z.array(z.string()),
  }),
  /** Worker self-report: context, never evidence. */
  report: WorkerReportSchema,
});
export type WorkerAttemptOutput = z.infer<typeof WorkerAttemptOutputSchema>;
