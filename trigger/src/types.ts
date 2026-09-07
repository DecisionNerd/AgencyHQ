export type SpikeEchoPayload = {
  message: string;
};

export const TASK_IDS = {
  spikeEcho: "spike.echo",
  workerAttempt: "worker.attempt",
} as const;

// Appended for the worker.attempt spike libraries (trigger/src/lib/**). See
// trigger/src/lib/opencode.ts for the OpenCode facts these types encode.

/** A single OpenCode permission decision. */
export type PermissionAction = "allow" | "ask" | "deny";

/** A per-tool pattern map, e.g. `bash: {"*": "allow", "*git push*": "deny"}`. */
export type PermissionPatternMap = Record<string, PermissionAction>;

/** The worker permission ruleset written to `opencode.worker.json` and to
 * `OPENCODE_PERMISSION`. Keys not covered by a pattern map are plain actions. */
export type PermissionRuleset = {
  "*": PermissionAction;
  read: PermissionAction;
  glob: PermissionAction;
  grep: PermissionAction;
  list: PermissionAction;
  edit: PermissionPatternMap;
  bash: PermissionPatternMap;
  task: PermissionAction;
  webfetch: PermissionAction;
  websearch: PermissionAction;
  skill: PermissionAction;
  external_directory: PermissionAction;
  doom_loop: PermissionAction;
};

/** One line of `opencode run --format json` output, decoded. The shape
 * beyond `type` is event-specific and intentionally loose here. */
export type OpenCodeEvent = {
  type: string;
  timestamp?: number;
  sessionID?: string;
  [key: string]: unknown;
};

/** A denied tool call recovered from the event stream. */
export type EventDenial = {
  tool: string;
  pattern: string | undefined;
  message: string;
};

/** `summarize()`'s reduction of one run's event stream. */
export type EventSummary = {
  sessionID: string | undefined;
  denials: EventDenial[];
  errors: string[];
  toolUses: { tool: string; count: number }[];
  textTail: string;
};

// Appended for the worker.attempt task (trigger/src/tasks/worker-attempt.ts,
// trigger/src/tasks/worker-attempt-core.ts). See ADR-0007
// (docs/engineering/adrs/0007-worker-effect-model.md).

/** Payload for the `worker.attempt` task: one attempt in one fresh worktree. */
export type WorkerAttemptPayload = {
  attemptId: string;
  repoPath: string;
  baseRev: string;
  prompt: string;
  allowedPaths: string[];
  model?: string;
  worktreeBase?: string;
};

/** Result of one `worker.attempt` run. `survivors` is only ever non-empty
 * for `outcome: "cancelled"`; the other outcomes finish with the OpenCode
 * process already reaped. */
/** Worker's own account of what it did: context for the Lead, never evidence
 * (TESTING.md:67-73). Mirrors @agencyhq/contracts WorkerReportSchema. */
export type WorkerReportLite = {
  attempted: string;
  outputs: string[];
  checksRun: { command: string; claimedResult: "pass" | "fail" | "unknown" }[];
  unmetCriteria: string[];
  limitations: string[];
  findings: { subject: string; cause: string; description: string }[];
};

export type WorkerAttemptOutput = {
  attemptId: string;
  /** OpenCode session id, or "unknown" when the session never reported one. */
  sessionId: string;
  report: WorkerReportLite;
  outcome: "completed" | "path_violation" | "opencode_error" | "cancelled" | "timed_out";
  worktreePath: string;
  runDir: string;
  commitId: string | null;
  diffDigest: string | null;
  changedPaths: string[];
  pathViolations: string[];
  checkpointCommit: string | null;
  survivors: number[];
  opencode: {
    sessionID: string | null;
    exitCode: number | null;
    denials: EventDenial[];
    errors: string[];
  };
};

// Appended for lead review and accept tasks (Packet 3.D).
// These types support the lead.review and lead.accept Trigger tasks.

import type { AcceptanceProposal, ReviewOutput } from "@agencyhq/contracts";

/**
 * The exact LeadSession signature implemented by trigger/src/opencode/sdk.ts.
 * Defined here so core files and task files can reference it without importing sdk.ts
 * (sdk.ts is written by the w3b-lead-plan worker and may not exist during typecheck).
 */
export type LeadSession = <T>(input: {
  dir: string;
  runDir: string;
  model: string;
  variant?: string | undefined;
  agentName: "agencyhq-lead";
  ruleset: PermissionRuleset;
  env: Record<string, string>;
  systemContext: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  parse: (raw: unknown) => T;
  timeoutMs: number;
}) => Promise<{ sessionId: string; raw: unknown; value: T }>;

/** An output record indicating the lead session returned malformed data. */
export type InvalidOutput = { kind: "invalid_output"; reason: string };

/**
 * The output type for the lead.review task.
 * Either a well-formed ReviewOutput or an invalid_output sentinel.
 */
export type ReviewTaskOutput = ReviewOutput | InvalidOutput;

/**
 * The output type for the lead.accept task.
 * Either a well-formed AcceptanceProposal or an invalid_output sentinel.
 */
export type AcceptTaskOutput = AcceptanceProposal | InvalidOutput;
// Appended for the lead.plan task (ADR-0006).
// The model variant controls inference speed/cost (e.g. "low" = faster/cheaper).
// Default variant is "low"; override via payload.variant or AGENCYHQ_LEAD_VARIANT env.

/** Optional model variant extension for lead.plan payload. */
export type LeadPlanVariant = {
  /** Model variant (e.g. "low", "high"). Defaults to AGENCYHQ_LEAD_VARIANT env or "low". */
  variant?: string | undefined;
};
