export const PACKAGE_NAME = "@agencyhq/domain";

// Aggregates (wave 2.E)
export * from "./aggregates/approval.ts";
export * from "./aggregates/artifact.ts";
export * from "./aggregates/attempt.ts";
export * from "./aggregates/decision.ts";
export * from "./aggregates/dispatch-intent.ts";
export * from "./aggregates/failure.ts";
export * from "./aggregates/finding.ts";
export * from "./aggregates/project.ts";
export * from "./aggregates/review.ts";
export * from "./aggregates/step-contract.ts";
export * from "./aggregates/verification-result.ts";
export * from "./aggregates/work-item.ts";
// Authority subset check, human approval, runtime enforceability (wave 2.F)
export * from "./authority/index.ts";
// Dispatch selection (wave 2.I)
export * from "./dispatch/index.ts";
// Evidence matching, acceptance rule, verifier integrity, dispositions (wave 2.H)
export * from "./evidence/index.ts";
// Failure classification (wave 2.G). `RunObservation` and `TriggerRunStatus`
// are exported from ports.ts; classify.ts's structurally identical copies are
// not re-exported.
export type {
  Classification,
  ClassificationContext,
  ClassificationTableRow,
  FailureClass,
} from "./failure/classify.ts";
export { CLASSIFICATION_TABLE, classifyObservation } from "./failure/classify.ts";
export * from "./findings/index.ts";
// Primitives and ports (wave 2.E)
export * from "./ids.ts";
export * from "./ports.ts";
export * from "./result.ts";
// Transitions (wave 2.E): namespaced because attempt and work-item share
// command names such as `admit`.
export * as attemptTransitions from "./transitions/attempt.ts";
export * as workItemTransitions from "./transitions/work-item.ts";
