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
export type WorkerAttemptOutput = {
  attemptId: string;
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
