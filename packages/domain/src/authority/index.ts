/**
 * Authority subset checks, human-approval determination, and runtime enforceability
 * for the AgencyHQ delegated-authority model.
 *
 * See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
 */

export { requiresApproval } from "./human-required.ts";
export { enforceable, requiredBoundariesFor } from "./runtime.ts";
export type { AuthorityViolation, ViolationCode } from "./subset.ts";
export { bashPatternSubset, checkProposal, effectiveAuthority } from "./subset.ts";
