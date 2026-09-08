/**
 * Branded identifier types for the AgencyHQ domain.
 * All ids are opaque strings with a runtime-checkable prefix.
 */

// ---------------------------------------------------------------------------
// Brand utility
// ---------------------------------------------------------------------------
type Brand<S extends string> = string & { readonly __brand: S };

// ---------------------------------------------------------------------------
// Id types
// ---------------------------------------------------------------------------
export type ProjectId = Brand<"ProjectId">;
export type WorkItemId = Brand<"WorkItemId">;
export type StepContractId = Brand<"StepContractId">;
export type AttemptId = Brand<"AttemptId">;
export type DispatchIntentId = Brand<"DispatchIntentId">;
export type ArtifactId = Brand<"ArtifactId">;
export type VerificationResultId = Brand<"VerificationResultId">;
export type ReviewId = Brand<"ReviewId">;
export type DecisionId = Brand<"DecisionId">;
export type ApprovalId = Brand<"ApprovalId">;
export type FindingId = Brand<"FindingId">;
export type FailureId = Brand<"FailureId">;
export type CommandId = Brand<"CommandId">;

// ---------------------------------------------------------------------------
// Prefix map
// ---------------------------------------------------------------------------
const PREFIX_MAP = {
  prj: "ProjectId",
  wi: "WorkItemId",
  sc: "StepContractId",
  att: "AttemptId",
  di: "DispatchIntentId",
  art: "ArtifactId",
  vr: "VerificationResultId",
  rev: "ReviewId",
  dec: "DecisionId",
  apr: "ApprovalId",
  fnd: "FindingId",
  fail: "FailureId",
  cmd: "CommandId",
} as const;

type KnownPrefix = keyof typeof PREFIX_MAP;

// ---------------------------------------------------------------------------
// newId — generate a new branded id with given prefix
// ---------------------------------------------------------------------------
export function newId(prefix: "prj"): ProjectId;
export function newId(prefix: "wi"): WorkItemId;
export function newId(prefix: "sc"): StepContractId;
export function newId(prefix: "att"): AttemptId;
export function newId(prefix: "di"): DispatchIntentId;
export function newId(prefix: "art"): ArtifactId;
export function newId(prefix: "vr"): VerificationResultId;
export function newId(prefix: "rev"): ReviewId;
export function newId(prefix: "dec"): DecisionId;
export function newId(prefix: "apr"): ApprovalId;
export function newId(prefix: "fnd"): FindingId;
export function newId(prefix: "fail"): FailureId;
export function newId(prefix: "cmd"): CommandId;
export function newId(prefix: KnownPrefix): Brand<string> {
  return `${prefix}_${crypto.randomUUID()}` as Brand<string>;
}

// ---------------------------------------------------------------------------
// asXId — safe casts with prefix check
// ---------------------------------------------------------------------------
function castId<T extends Brand<string>>(prefix: string, s: string): T {
  if (!s.startsWith(`${prefix}_`)) {
    throw new Error(`Expected id with prefix "${prefix}_", got: "${s}"`);
  }
  return s as T;
}

export function asProjectId(s: string): ProjectId {
  return castId("prj", s);
}
export function asWorkItemId(s: string): WorkItemId {
  return castId("wi", s);
}
export function asStepContractId(s: string): StepContractId {
  return castId("sc", s);
}
export function asAttemptId(s: string): AttemptId {
  return castId("att", s);
}
export function asDispatchIntentId(s: string): DispatchIntentId {
  return castId("di", s);
}
export function asArtifactId(s: string): ArtifactId {
  return castId("art", s);
}
export function asVerificationResultId(s: string): VerificationResultId {
  return castId("vr", s);
}
export function asReviewId(s: string): ReviewId {
  return castId("rev", s);
}
export function asDecisionId(s: string): DecisionId {
  return castId("dec", s);
}
export function asApprovalId(s: string): ApprovalId {
  return castId("apr", s);
}
export function asFindingId(s: string): FindingId {
  return castId("fnd", s);
}
export function asFailureId(s: string): FailureId {
  return castId("fail", s);
}
export function asCommandId(s: string): CommandId {
  return castId("cmd", s);
}
