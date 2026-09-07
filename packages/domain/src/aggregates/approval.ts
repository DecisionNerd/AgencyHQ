/**
 * Approval aggregate.
 * Human decision over an exact subject version and evidence set.
 * Required only where the authority schema says so.
 * Never a mutable boolean.
 */

import type { ApprovalId, DecisionId, StepContractId } from "../ids.ts";

export type Approval = {
  readonly id: ApprovalId;
  readonly decisionId: DecisionId;
  readonly contractId: StepContractId;
  readonly contractVersion: number;
  readonly attemptRevision?: string;
  readonly humanActor: string;
  readonly at: string;
};
