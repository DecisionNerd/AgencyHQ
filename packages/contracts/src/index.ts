export const PACKAGE_NAME = "@agencyhq/contracts";

// Authority, runtime profile, and StepContract schemas (wave 2.B).
export * from "./authority.ts";
// Digests and path patterns (wave 2.A).
export type { Digest } from "./digest.ts";
export { canonicalJson, digestOf, isDigest, sha256Hex } from "./digest.ts";
// Lead proposal and plan output (wave 2.C/2.D).
export type { LeadPlanOutput, LeadProposal } from "./lead-proposal.ts";
export { LeadPlanOutputSchema, LeadProposalSchema } from "./lead-proposal.ts";
// Revision manifest (wave 4.A)
export type { ManifestEntry, RevisionManifest } from "./manifest.ts";
export { ManifestEntrySchema, manifestDigest, RevisionManifestSchema } from "./manifest.ts";
export type { PathPattern } from "./path-pattern.ts";
export {
  denySetCovers,
  matchesPath,
  parsePathPattern,
  pathSetSubset,
  patternSubset,
} from "./path-pattern.ts";
export * from "./runtime-profile.ts";
export * from "./step-contract.ts"; // includes DigestStringSchema
export type {
  IntegrateMergeOutput,
  IntegrateMergePayload,
} from "./tasks/integrate-merge.ts";
export {
  IntegrateMergeOutputSchema,
  IntegrateMergePayloadSchema,
} from "./tasks/integrate-merge.ts";
// Task schemas
export type { AcceptanceProposal, LeadAcceptPayload } from "./tasks/lead-accept.ts";
export { AcceptanceProposalSchema, LeadAcceptPayloadSchema } from "./tasks/lead-accept.ts";
export type { LeadPlanPayload } from "./tasks/lead-plan.ts";
export { LeadPlanPayloadSchema } from "./tasks/lead-plan.ts";
export type { LeadReviewPayload, ReviewOutput } from "./tasks/lead-review.ts";
export { LeadReviewPayloadSchema, ReviewOutputSchema } from "./tasks/lead-review.ts";
export type { VerifyRunOutput, VerifyRunPayload } from "./tasks/verify-run.ts";
export { VerifyRunOutputSchema, VerifyRunPayloadSchema } from "./tasks/verify-run.ts";
export type { WorkerAttemptOutput, WorkerAttemptPayload } from "./tasks/worker-attempt.ts";
export { WorkerAttemptOutputSchema, WorkerAttemptPayloadSchema } from "./tasks/worker-attempt.ts";

// Verification result and worker report
export type { VerificationResult } from "./verification-result.ts";
export { VerificationResultSchema } from "./verification-result.ts";
export type { WorkerReport } from "./worker-report.ts";
export { WorkerReportSchema } from "./worker-report.ts";

// Task IDs
export const TASK_IDS = {
  leadPlan: "lead.plan",
  workerAttempt: "worker.attempt",
  verifyRun: "verify.run",
  leadReview: "lead.review",
  leadAccept: "lead.accept",
  integrateMerge: "integrate.merge",
} as const;

// JSON Schema export
export { jsonSchemaFor, LEAD_OUTPUT_JSON_SCHEMAS } from "./opencode/json-schema.ts";

// OpenCode permissions
export type {
  PermissionAction,
  PermissionPatternMap,
  PermissionRuleset,
} from "./opencode/permissions.ts";
export {
  leadAgentPermissions,
  PermissionActionSchema,
  PermissionPatternMapSchema,
  PermissionRulesetSchema,
  permissionRulesFor,
  runConfigFor,
  WORKER_ALWAYS_DENY_BASH,
  WORKER_ALWAYS_DENY_PATHS,
} from "./opencode/permissions.ts";
