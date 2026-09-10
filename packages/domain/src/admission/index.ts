/**
 * Admission module public API.
 *
 * Pure validators that gate coordinator acceptance of worker-container
 * submissions (artifact bundles, stop evidence, lease requests).
 */

export type { ArtifactAdmissionCode, ArtifactAdmissionInput } from "./artifact.ts";
export { validateArtifactAdmission } from "./artifact.ts";

export type { StopEvidenceAdmissionCode, StopEvidenceAdmissionInput } from "./evidence.ts";
export { validateStopEvidenceAdmission } from "./evidence.ts";

export type {
  LeasePurpose,
  LeaseRefusalReason,
  LeaseRequestInput,
  ProviderState,
} from "./lease.ts";
export { validateLeaseRequest } from "./lease.ts";

export type { PathUnsafeCode } from "./paths.ts";
export { isSafePath, validateChangedPaths } from "./paths.ts";
