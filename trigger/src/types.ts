export type SpikeEchoPayload = {
  message: string;
};

export const TASK_IDS = {
  spikeEcho: "spike.echo",
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
