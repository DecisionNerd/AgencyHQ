/**
 * Finding aggregate.
 * Evidence-backed observation from any task with an owned disposition.
 * Never silently widens a contract.
 */

import type { AttemptId, FindingId } from "../ids.ts";

export type FindingSeverity = "blocking" | "non_blocking";

export type FindingKind =
  | "unmet_criterion"
  | "weakened_check"
  | "verifier_tampered"
  | "scope_violation"
  | "defect"
  | "style"
  | "unrelated";

export type FindingDisposition = "backlog" | "remediate" | "scope_decision" | "block" | "dismiss";

export type Finding = {
  readonly id: FindingId;
  readonly attemptId?: AttemptId;
  readonly severity: FindingSeverity;
  readonly kind: FindingKind;
  readonly description: string;
  readonly evidence: string;
  readonly disposition?: FindingDisposition;
};
