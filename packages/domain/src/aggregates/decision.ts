/**
 * Decision aggregate.
 * A Lead proposal accepted by the coordinator's authority check, or a human
 * decision. Immutable, versioned, with sources and rationale.
 */

import type {
  ApprovalId,
  AttemptId,
  CommandId,
  DecisionId,
  StepContractId,
  WorkItemId,
} from "../ids.ts";

export type DecisionKind = "plan" | "admit" | "accept" | "reject" | "disposition" | "stop";

export type DecisionActor = "coordinator" | "lead" | "human";

export type DecisionOutcome = "recorded" | "pending_human";

export type Decision = {
  readonly id: DecisionId;
  readonly kind: DecisionKind;
  readonly actor: DecisionActor;
  readonly proposalDigest?: string;
  readonly authorityVersion: string;
  readonly workItemId: WorkItemId;
  readonly contractId?: StepContractId;
  readonly contractVersion?: number;
  readonly attemptId?: AttemptId;
  readonly causationId?: DecisionId | ApprovalId;
  readonly commandId?: CommandId;
  readonly at: string;
  readonly outcome: DecisionOutcome;
};
