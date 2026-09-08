export const PACKAGE_NAME = "@agencyhq/verification";

export type { CheckDef, RunSummary } from "./checks.ts";
export { CHECK_CATALOG } from "./checks.ts";
export { environmentFingerprint } from "./fingerprint.ts";
export type { VerificationProfile } from "./profiles.ts";
export { PROFILE_CATALOG, profileDigest, resolveProfile } from "./profiles.ts";
export type { BuildVerificationResultInput } from "./result.ts";
export { buildVerificationResult } from "./result.ts";
export type { RunProfileInput } from "./run-profile.ts";
export { runProfile } from "./run-profile.ts";
export type { RunCheckResult } from "./runner.ts";
export { runCheck } from "./runner.ts";
