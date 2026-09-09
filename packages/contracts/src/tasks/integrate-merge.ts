/**
 * integrate.merge task schemas for AgencyHQ.
 *
 * After a recorded acceptance the coordinator dispatches integrate.merge with
 * an operation-scoped credential. The task serializes per repository and is
 * idempotent by attempt id + target ref + expected base revision (compare-
 * and-set). Only integrate.merge may push to a remote.
 *
 * See: docs/engineering/EXECUTION_MODEL.md step 9 (Integrate)
 * See: docs/engineering/ARCHITECTURE.md task table ("only integrate.merge may push")
 * See: docs/REQUIREMENTS.md R-015 (compare-and-set integration)
 */

import { z } from "zod";

import { HexRevision40Schema } from "../manifest.ts";
import { SourceRefSchema } from "../source.ts";

// ---------------------------------------------------------------------------
// IntegrateMergePayloadSchema — v1 (kept as primary export for compatibility)
// ---------------------------------------------------------------------------

/**
 * Payload for the integrate.merge task — v1.
 * payloadVersion 1 is the default when the field is absent.
 */
export const IntegrateMergePayloadSchema = z.object({
  payloadVersion: z.literal(1).optional(),
  attemptId: z.string().min(1),
  /**
   * Monotonically increasing per-attempt generation (min 1 for integration:
   * a generation-0 attempt is still in flight and cannot yet be integrated).
   * Guards stale replays.
   */
  generation: z.int().gte(1),
  contractId: z.string().min(1),
  /** Monotonic version counter of the StepContract (integer, min 1). */
  contractVersion: z.int().gte(1),
  projectId: z.string().min(1),
  /** Absolute path to the coordinator-owned local clone. */
  repoPath: z.string().min(1),
  /** Git remote name or URL to push to. */
  remote: z.string().min(1),
  /** Git ref to push to (e.g. "refs/heads/main"). */
  targetRef: z.string().min(1),
  /**
   * The commit SHA expected at targetRef before pushing.
   * Integration aborts with outcome base_moved if the ref has advanced.
   */
  expectedBaseRevision: HexRevision40Schema,
  /** The commit SHA produced by the worker attempt, to be integrated. */
  attemptRevision: HexRevision40Schema,
  /** Merge strategy to apply when pushing. */
  strategy: z.enum(["merge_commit", "fast_forward"]),
});
export type IntegrateMergePayload = z.infer<typeof IntegrateMergePayloadSchema>;
/** Alias for the v1 schema. */
export const IntegrateMergePayloadV1Schema = IntegrateMergePayloadSchema;
export type IntegrateMergePayloadV1 = IntegrateMergePayload;

// ---------------------------------------------------------------------------
// IntegrateMergePayloadV2Schema
// ---------------------------------------------------------------------------

/**
 * Payload for the integrate.merge task — v2 (portable execution).
 *
 * repoPath is replaced by source: SourceRef. An integrateLease marker
 * (purpose: "integrate") signals that the coordinator has issued an
 * integrate-purpose lease; the actual credential material is obtained via
 * the lease API, not embedded in this payload.
 *
 * Strict parsing rejects legacy host path fields.
 */
export const IntegrateMergePayloadV2Schema = z
  .object({
    payloadVersion: z.literal(2),
    attemptId: z.string().min(1),
    generation: z.int().gte(1),
    contractId: z.string().min(1),
    contractVersion: z.int().gte(1),
    projectId: z.string().min(1),
    /** Source reference (replaces repoPath). */
    source: SourceRefSchema,
    /** Git remote URL to push to. */
    remote: z.string().min(1),
    targetRef: z.string().min(1),
    expectedBaseRevision: HexRevision40Schema,
    attemptRevision: HexRevision40Schema,
    strategy: z.enum(["merge_commit", "fast_forward"]),
    /** Marker indicating an integrate-purpose lease has been issued for this task. */
    integrateLease: z.object({ purpose: z.literal("integrate") }),
  })
  .strict();
export type IntegrateMergePayloadV2 = z.infer<typeof IntegrateMergePayloadV2Schema>;

/**
 * Union of v1 and v2. Use where both formats must be accepted.
 */
export const IntegrateMergePayloadAnySchema = z.union([
  IntegrateMergePayloadSchema,
  IntegrateMergePayloadV2Schema,
]);
export type IntegrateMergePayloadAny = z.infer<typeof IntegrateMergePayloadAnySchema>;

/** Type guard: returns true iff the payload is a v2 IntegrateMergePayload. */
export function isV2Payload(p: IntegrateMergePayloadAny): p is IntegrateMergePayloadV2 {
  return p.payloadVersion === 2;
}

// ---------------------------------------------------------------------------
// IntegrateMergeOutputSchema
// ---------------------------------------------------------------------------

export const IntegrateMergeOutputSchema = z.object({
  /**
   * Integration outcome:
   * - integrated: push succeeded; resultingRevision is the new tip.
   * - already_integrated: the attempt revision is already an ancestor of
   *   targetRef (idempotent replay).
   * - base_moved: targetRef has advanced past expectedBaseRevision; the
   *   coordinator must re-evaluate.
   * - conflict: the merge produced unresolvable conflicts; conflictingPaths
   *   lists the affected paths.
   * - push_rejected: the remote rejected the push for a non-conflict reason
   *   (permissions, hooks, etc.).
   */
  outcome: z.enum(["integrated", "already_integrated", "base_moved", "conflict", "push_rejected"]),
  /** The new tip SHA after integration; present when outcome is integrated. */
  resultingRevision: HexRevision40Schema.optional(),
  /**
   * The SHA observed at targetRef at the time of the integration attempt.
   * Always present; used to diagnose base_moved and already_integrated.
   */
  observedTargetRevision: HexRevision40Schema,
  /** Human-readable evidence strings for auditing and debugging. */
  evidence: z.array(z.string()),
  /** Paths with merge conflicts; present when outcome is conflict. */
  conflictingPaths: z.array(z.string()).optional(),
});

export type IntegrateMergeOutput = z.infer<typeof IntegrateMergeOutputSchema>;
