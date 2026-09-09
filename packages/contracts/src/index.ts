export const PACKAGE_NAME = "@agencyhq/contracts";

// Artifact and source reference schemas (P18.1 — portable execution).
export type { ArtifactRef, ArtifactUploadMeta, StopEvidenceUpload } from "./artifact.ts";
export {
  ArtifactRefSchema,
  ArtifactUploadMetaSchema,
  StopEvidenceUploadSchema,
} from "./artifact.ts";
// Authority, runtime profile, and StepContract schemas (wave 2.B).
export * from "./authority.ts";
// Digests and path patterns (wave 2.A).
export type { Digest } from "./digest.ts";
export { canonicalJson, digestOf, isDigest, sha256Hex } from "./digest.ts";
// Lead proposal and plan output (wave 2.C/2.D).
export type { LeadPlanOutput, LeadProposal } from "./lead-proposal.ts";
export { LeadPlanOutputSchema, LeadProposalSchema } from "./lead-proposal.ts";
// Lease schemas (P18.1 — credential delegation to containers).
export type { LeaseGrant, LeasePurpose, LeaseRefusal, LeaseRequest } from "./lease.ts";
export {
  LeaseGrantSchema,
  LeasePurposeSchema,
  LeaseRefusalSchema,
  LeaseRequestSchema,
  redactLeaseGrant,
} from "./lease.ts";
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
// Source reference (P18.1 — portable source bundles).
export type { SourceRef } from "./source.ts";
export { SourceRefSchema } from "./source.ts";
export * from "./step-contract.ts"; // includes DigestStringSchema
export type {
  IntegrateMergeOutput,
  IntegrateMergePayload,
  IntegrateMergePayloadAny,
  IntegrateMergePayloadV1,
  IntegrateMergePayloadV2,
} from "./tasks/integrate-merge.ts";
export {
  IntegrateMergeOutputSchema,
  IntegrateMergePayloadAnySchema,
  IntegrateMergePayloadSchema,
  IntegrateMergePayloadV1Schema,
  IntegrateMergePayloadV2Schema,
  isV2Payload as isV2IntegrateMergePayload,
} from "./tasks/integrate-merge.ts";
// Task schemas
export type {
  AcceptanceProposal,
  LeadAcceptPayload,
  LeadAcceptPayloadAny,
  LeadAcceptPayloadV1,
  LeadAcceptPayloadV2,
} from "./tasks/lead-accept.ts";
export {
  AcceptanceProposalSchema,
  isV2Payload as isV2LeadAcceptPayload,
  LeadAcceptPayloadAnySchema,
  LeadAcceptPayloadSchema,
  LeadAcceptPayloadV1Schema,
  LeadAcceptPayloadV2Schema,
} from "./tasks/lead-accept.ts";
export type {
  LeadPlanPayload,
  LeadPlanPayloadAny,
  LeadPlanPayloadV1,
  LeadPlanPayloadV2,
} from "./tasks/lead-plan.ts";
export {
  isV2Payload as isV2LeadPlanPayload,
  LeadPlanPayloadAnySchema,
  LeadPlanPayloadSchema,
  LeadPlanPayloadV1Schema,
  LeadPlanPayloadV2Schema,
} from "./tasks/lead-plan.ts";
export type {
  LeadReviewPayload,
  LeadReviewPayloadAny,
  LeadReviewPayloadV1,
  LeadReviewPayloadV2,
  ReviewOutput,
} from "./tasks/lead-review.ts";
export {
  isV2Payload as isV2LeadReviewPayload,
  LeadReviewPayloadAnySchema,
  LeadReviewPayloadSchema,
  LeadReviewPayloadV1Schema,
  LeadReviewPayloadV2Schema,
  ReviewOutputSchema,
} from "./tasks/lead-review.ts";
export type {
  VerifyRunOutput,
  VerifyRunPayload,
  VerifyRunPayloadAny,
  VerifyRunPayloadV1,
  VerifyRunPayloadV2,
} from "./tasks/verify-run.ts";
export {
  isV2Payload as isV2VerifyRunPayload,
  VerifyRunOutputSchema,
  VerifyRunPayloadAnySchema,
  VerifyRunPayloadSchema,
  VerifyRunPayloadV1Schema,
  VerifyRunPayloadV2Schema,
} from "./tasks/verify-run.ts";
export type {
  WorkerAttemptOutput,
  WorkerAttemptPayload,
  WorkerAttemptPayloadAny,
  WorkerAttemptPayloadV1,
  WorkerAttemptPayloadV2,
} from "./tasks/worker-attempt.ts";
export {
  isV2Payload as isV2WorkerAttemptPayload,
  WorkerAttemptOutputSchema,
  WorkerAttemptPayloadAnySchema,
  WorkerAttemptPayloadSchema,
  WorkerAttemptPayloadV1Schema,
  WorkerAttemptPayloadV2Schema,
} from "./tasks/worker-attempt.ts";

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
