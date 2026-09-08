export const PACKAGE_NAME = "@agencyhq/coordinator";

export * from "./app.ts";
export * from "./commands/index.ts";
export * from "./config.ts";
// Flow: bounded-repair driver, observation reconciler, types, and payload builders
export { BoundedRepairFlow } from "./flow/bounded-repair.ts";
export { Reconciler } from "./flow/observe.ts";
export {
  leadAcceptPayload,
  leadPlanPayload,
  leadReviewPayload,
  verifyRunPayload,
  workerAttemptPayload,
} from "./flow/payloads.ts";
export type { FlowConfig, FlowDeps, ProfileResolver } from "./flow/types.ts";
export * from "./views/return-view.ts";
