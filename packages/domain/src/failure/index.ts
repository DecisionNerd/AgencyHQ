/**
 * Failure classification sub-package.
 *
 * Classifies Trigger.dev run observations into execution / contract / process
 * failure classes so the coordinator can decide whether to create a new Attempt
 * automatically (execution only, within budget) or require a Lead or human
 * decision (contract / process).
 *
 * Pure domain code — no Trigger, OpenCode, React, or Postgres imports.
 */
export type {
  Classification,
  ClassificationContext,
  ClassificationTableRow,
  FailureClass,
  RunObservation,
  TriggerRunStatus,
} from "./classify.ts";

export { CLASSIFICATION_TABLE, classifyObservation } from "./classify.ts";
