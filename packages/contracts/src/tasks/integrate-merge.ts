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

// ---------------------------------------------------------------------------
// IntegrateMergePayloadSchema
// ---------------------------------------------------------------------------

export const IntegrateMergePayloadSchema = z.object({
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
