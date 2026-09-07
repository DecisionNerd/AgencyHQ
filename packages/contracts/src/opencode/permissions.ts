/**
 * OpenCode permission-rule generator for AgencyHQ worker and lead agents.
 * See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
 * See: docs/engineering/adrs/0007-worker-effect-model.md
 */

import { z } from "zod";

import type { ContractBounds } from "../step-contract.ts";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

export const PermissionPatternMapSchema = z.record(z.string(), PermissionActionSchema);
export type PermissionPatternMap = z.infer<typeof PermissionPatternMapSchema>;

export const PermissionRulesetSchema = z.object({
  "*": PermissionActionSchema,
  read: PermissionActionSchema,
  glob: PermissionActionSchema,
  grep: PermissionActionSchema,
  list: PermissionActionSchema,
  edit: PermissionPatternMapSchema,
  bash: PermissionPatternMapSchema,
  task: PermissionActionSchema,
  webfetch: PermissionActionSchema,
  websearch: PermissionActionSchema,
  skill: PermissionActionSchema,
  external_directory: PermissionActionSchema,
  doom_loop: PermissionActionSchema,
  /** OpenCode's internal structured-output tool. Observed 2026-09-07 with
   * OpenCode 1.18.29: when a prompt carries `format: { type: "json_schema" }`
   * the model must call a tool named `StructuredOutput`; under `"*": "deny"`
   * that call is refused and the session loops until the timeout. Lead
   * sessions therefore allow it explicitly; worker sessions never use
   * structured output and leave it unset (denied by `*`). */
  StructuredOutput: PermissionActionSchema.optional(),
});
export type PermissionRuleset = z.infer<typeof PermissionRulesetSchema>;

// ---------------------------------------------------------------------------
// Always-deny constants
// ---------------------------------------------------------------------------

/** Bash patterns that are always denied for workers, regardless of contract. */
export const WORKER_ALWAYS_DENY_BASH: readonly string[] = [
  "*git push*",
  "*git remote*",
  "*git fetch*",
  "*git pull*",
  "*gh *",
  "*curl*",
  "*wget*",
  "*ssh *",
  "*scp *",
];

/** File glob patterns that are always denied for workers (both relative and absolute). */
export const WORKER_ALWAYS_DENY_PATHS: readonly string[] = [
  "opencode.json*",
  "opencode.jsonc*",
  ".opencode/**",
];

// ---------------------------------------------------------------------------
// permissionRulesFor — worker ruleset
// ---------------------------------------------------------------------------

/**
 * Build the OpenCode permission ruleset for a worker agent operating within
 * the given ContractBounds.
 *
 * Key rules:
 * - Default deny everything ("*": "deny").
 * - read/glob/grep/list: always allow.
 * - edit: deny by default; then allow each paths.allow glob (both relative
 *   and absolute under worktreePath); then deny paths.deny and
 *   WORKER_ALWAYS_DENY_PATHS (last-match-wins, so denies come after allows).
 * - bash: default deny when contract lists explicit bash allows, else allow;
 *   then allow each allow pattern; then deny bounds.capabilities.bash.deny
 *   and WORKER_ALWAYS_DENY_BASH (last-match-wins).
 * - task and external_directory: always deny (cannot be unlocked).
 * - webfetch/websearch: allow only when explicitly enabled in bounds.
 * - skill/doom_loop: always deny.
 *
 * Output is deterministic: input arrays are sorted before processing so that
 * calls with shuffled arrays produce identical JSON.
 */
export function permissionRulesFor(
  bounds: ContractBounds,
  opts: { worktreePath: string },
): PermissionRuleset {
  // Sort input arrays for deterministic key insertion order.
  const allowPaths = [...bounds.paths.allow].sort();
  const denyPaths = [...bounds.paths.deny].sort();
  const bashAllow = [...bounds.capabilities.bash.allow].sort();
  const bashDeny = [...bounds.capabilities.bash.deny].sort();

  // --- edit pattern map ---
  // Default deny, then allow globs (both forms), then deny paths (last wins).
  const edit: PermissionPatternMap = { "*": "deny" };
  for (const glob of allowPaths) {
    edit[glob] = "allow";
    edit[`${opts.worktreePath}/${glob}`] = "allow";
  }
  for (const glob of denyPaths) {
    edit[glob] = "deny";
    edit[`${opts.worktreePath}/${glob}`] = "deny";
  }
  for (const glob of WORKER_ALWAYS_DENY_PATHS) {
    edit[glob] = "deny";
    edit[`${opts.worktreePath}/${glob}`] = "deny";
  }

  // --- bash pattern map ---
  // When the contract lists explicit allows, default to deny so only those
  // commands are permitted; otherwise default to allow.
  const hasBashAllows = bashAllow.length > 0;
  const bash: PermissionPatternMap = { "*": hasBashAllows ? "deny" : "allow" };
  if (hasBashAllows) {
    for (const pattern of bashAllow) {
      bash[pattern] = "allow";
    }
  }
  // Deny entries come after allows (last-match-wins).
  for (const pattern of bashDeny) {
    bash[pattern] = "deny";
  }
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    bash[pattern] = "deny";
  }

  // --- tools ---
  // task and external_directory can NEVER be allowed.
  const webfetch: PermissionAction = bounds.capabilities.tools.webfetch === true ? "allow" : "deny";
  const websearch: PermissionAction =
    bounds.capabilities.tools.websearch === true ? "allow" : "deny";

  return {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit,
    bash,
    task: "deny",
    webfetch,
    websearch,
    skill: "deny",
    external_directory: "deny",
    doom_loop: "deny",
  };
}

// ---------------------------------------------------------------------------
// leadAgentPermissions — read-only Lead ruleset
// See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md §33-37
// ---------------------------------------------------------------------------

/**
 * Permission ruleset for the AgencyHQ Lead agent (read-only role).
 *
 * The Lead may read files, search, run read-only git commands, run test/typecheck
 * commands, and use grep/find. It may NOT edit files, push, fetch, open external
 * connections, spawn sub-agents, or invoke tasks.
 */
export function leadAgentPermissions(): PermissionRuleset {
  const bash: PermissionPatternMap = {
    "*": "deny",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "git ls-files*": "allow",
    "ls*": "allow",
    "cat *": "allow",
    "head *": "allow",
    "tail *": "allow",
    "wc *": "allow",
    "rg *": "allow",
    "grep *": "allow",
    "find *": "allow",
    "pnpm test*": "allow",
    "pnpm typecheck*": "allow",
    "node --test*": "allow",
  };
  // Always-deny bash patterns override the allows above (last-match-wins).
  for (const pattern of WORKER_ALWAYS_DENY_BASH) {
    bash[pattern] = "deny";
  }

  return {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: { "*": "deny" },
    bash,
    task: "deny",
    webfetch: "deny",
    websearch: "deny",
    skill: "deny",
    external_directory: "deny",
    doom_loop: "deny",
    StructuredOutput: "allow",
  };
}

// ---------------------------------------------------------------------------
// runConfigFor — OpenCode run config object
// ---------------------------------------------------------------------------

/**
 * Build the OpenCode run config object written to `opencode.worker.json` and
 * loaded via `OPENCODE_CONFIG`.
 *
 * Shape is superset-compatible with the spike's `writeRunConfig` object:
 * `$schema`, `share`, `autoupdate`, `permission`, `agent.<agentName>`, `mcp`.
 */
export function runConfigFor(args: {
  model: string;
  agentName: "worker" | "agencyhq-lead";
  ruleset: PermissionRuleset;
  disableMcp: string[];
}): Record<string, unknown> {
  const mcp: Record<string, { enabled: false }> = {};
  for (const name of args.disableMcp) {
    mcp[name] = { enabled: false };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    permission: args.ruleset,
    agent: {
      [args.agentName]: {
        mode: "primary",
        model: args.model,
        permission: args.ruleset,
      },
    },
    mcp,
  };
}
