// OpenCode invocation config and NDJSON event parsing for the worker.attempt
// spike. No Trigger SDK usage.
//
// OpenCode facts below were verified against https://opencode.ai/docs/cli/,
// https://opencode.ai/docs/permissions/, https://opencode.ai/docs/config/,
// and https://opencode.ai/docs/agents/ (fetched 2026-09-07), and against the
// installed `opencode` 1.18.29 binary's own `--help` output and embedded
// strings (also read 2026-09-07), which is authoritative where it differs
// from the docs:
//
// - `opencode run [message..]` flags used here: `--format json` (raw JSON
//   events, one per line), `--dir <path>`, `--agent <name>`, `--model
//   <provider/model>`, `--pure`, `--title <title>`, `--print-logs`.
// - IMPORTANT DEVIATION FROM THE ASSUMED READING: `--pure` / `OPENCODE_PURE=1`
//   means "run without external plugins" (skips things like the repo's
//   `./plugins/caveman/plugin.js`), NOT "ignore project config". Project
//   config (`opencode.json`/`opencode.jsonc` discovered by walking up from
//   `--dir`) is a *separate* concern controlled by
//   `OPENCODE_DISABLE_PROJECT_CONFIG=1` ("skip the project's local
//   opencode.json"). Both are set here, for different reasons: `--pure` so a
//   plugin cannot inject behavior, `OPENCODE_DISABLE_PROJECT_CONFIG` so a
//   worktree-planted `opencode.json` (see the smoke script) cannot loosen
//   permissions. This matches the packet's env var list; only the mental
//   model behind `--pure` needed correcting.
// - `OPENCODE_CONFIG=<path>` loads that file as an *additional* explicit
//   config, merged over the global `~/.config/opencode/config.json` (source:
//   `OPENCODE_CONFIG=/path/to/file.json: load an additional explicit
//   config.`, from the binary's own embedded help text). It is not a
//   total replacement, which is why the run config also repeats `mcp`
//   disablement and the ruleset rather than relying on it being the only
//   config in play.
// - `OPENCODE_PERMISSION=<json>` is deep-merged into `config.permission`
//   (confirmed from the binary: `B.permission=$$(B.permission??{},
//   JSON.parse(k.OPENCODE_PERMISSION))`) after config-file loading, so it is
//   the last, most defense-in-depth layer for the ruleset.
// - Permission pattern maps evaluate last-match-wins; an explicit "deny"
//   survives `--auto` (docs/permissions). We never pass `--auto` here.
// - Disabling an MCP server in config is `{"mcp": {"<name>": {"enabled":
//   false}}}` (docs/config).
// - Agent-level permission override shape is `{"agent": {"<name>": {"mode":
//   "primary", "model": "...", "permission": {...}}}}` (docs/agents).
// - The docs do not state whether an "ask" permission is auto-rejected under
//   `opencode run` (non-interactive, no server to answer a prompt); this
//   ruleset never uses "ask" so the spike does not depend on that behavior.
// - The smoke run (2026-09-07, once, all 4 scenarios) hit
//   `AI_APICallError: Invalid API key.` from `https://opencode.ai/zen/v1/...`
//   on the model's first stream call, before any tool was ever invoked, so
//   no permission-deny event was actually exercised end to end. This
//   reproduced identically outside this adapter's scrubbed env (a bare
//   `opencode run --model opencode/big-pickle "say hi"` in the caller's own
//   ambient shell also returned "Invalid API key."), so it is a host/account
//   credential issue for the `opencode/big-pickle` model on this host, not
//   something the scrubbed env, `--pure`, or `OPENCODE_DISABLE_PROJECT_CONFIG`
//   caused. See the report for the raw NDJSON. The one real event captured
//   is a top-level `{"type":"error","sessionID":...,"error":{"name":
//   "APIError","data":{"message":"Invalid API key.", ...}}}` object; `errors`
//   in `summarize()` is confirmed against this shape (drilling into
//   `error.data.message`/`error.message`).
// - Denial shape, observed 2026-09-07 with OpenCode 1.18.29 (smoke scenarios b and c):
//   a denied tool call is a
//   `{"type":"tool_use", "part": {"tool": "<name>", "state": {"status":
//   "error", "error": "The user has specified a rule which prevents you from
//   using this specific tool call. Here are some of the relevant rules [...]",
//   "input": {...}}}}` event. `summarize()` classifies exactly that shape as a
//   denial; every other `tool_use` with `state.status === "error"` is recorded
//   under `errors`. The `task` tool was not offered to the model at all under
//   `task: "deny"` (the model reported "Task tool unavailable"), so a denied
//   `task` produces no event; callers must check `toolUses` for absence.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { EventDenial, EventSummary, OpenCodeEvent, PermissionRuleset } from "../types.ts";

const DENIED_BASH_PATTERNS = [
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

export function buildPermissionRuleset(args: {
  allowedPaths: string[];
  worktreePath: string;
  /** Glob patterns the worker must NOT edit. Inserted AFTER allows in the edit
   * map so last-match-wins semantics mirror the on-output `classifyPaths` deny
   * check. */
  deniedPaths?: string[];
}): PermissionRuleset {
  const edit: Record<string, "allow" | "deny"> = { "*": "deny" };
  for (const glob of args.allowedPaths) {
    edit[glob] = "allow";
    edit[`${args.worktreePath}/${glob}`] = "allow";
  }
  // Deny entries come after allows (last-match-wins).
  for (const glob of args.deniedPaths ?? []) {
    edit[glob] = "deny";
    edit[`${args.worktreePath}/${glob}`] = "deny";
  }

  const bash: Record<string, "allow" | "deny"> = { "*": "allow" };
  for (const pattern of DENIED_BASH_PATTERNS) {
    bash[pattern] = "deny";
  }

  return {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit,
    bash,
    task: "deny",
    webfetch: "deny",
    websearch: "deny",
    skill: "deny",
    external_directory: "deny",
    doom_loop: "deny",
  };
}

export async function writeRunConfig(args: {
  runDir: string;
  model: string;
  ruleset: PermissionRuleset;
}): Promise<string> {
  await mkdir(args.runDir, { recursive: true });
  const configPath = `${args.runDir}/opencode.worker.json`;
  const config = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    permission: args.ruleset,
    agent: {
      worker: {
        mode: "primary",
        model: args.model,
        permission: args.ruleset,
      },
    },
    mcp: {
      jean: { enabled: false },
      "t3-coordinator": { enabled: false },
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export async function spawnOpenCode(args: {
  worktreePath: string;
  runDir: string;
  prompt: string;
  model: string;
  env: Record<string, string>;
  bin?: string;
}): Promise<{
  child: ReturnType<typeof spawn>;
  pid: number;
  pgid: number;
}> {
  const bin = args.bin ?? "opencode";
  await mkdir(args.runDir, { recursive: true });

  const configPath = `${args.runDir}/opencode.worker.json`;
  const configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText) as { permission: PermissionRuleset };

  const attemptId = args.env.AGENCYHQ_ATTEMPT_ID ?? "unknown";
  const title = `attempt-${attemptId}`;

  const spawnEnv: Record<string, string> = {
    ...args.env,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_CONFIG: configPath,
    OPENCODE_PERMISSION: JSON.stringify(config.permission),
  };

  const spawnArgs = [
    "run",
    "--format",
    "json",
    "--print-logs",
    "--dir",
    args.worktreePath,
    "--agent",
    "worker",
    "--model",
    args.model,
    "--pure",
    "--title",
    title,
    args.prompt,
  ];

  const child = spawn(bin, spawnArgs, {
    cwd: args.worktreePath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv,
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("opencode child process did not start (no pid)");
  }

  const eventsStream = createWriteStream(`${args.runDir}/events.ndjson`);
  child.stdout?.pipe(eventsStream);

  const stderrStream = createWriteStream(`${args.runDir}/stderr.log`);
  child.stderr?.pipe(stderrStream);

  // detached:true on POSIX makes the child its own process group leader.
  return { child, pid, pgid: pid };
}

export function parseEvents(ndjsonText: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  const lines = ndjsonText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && "type" in parsed) {
        events.push(parsed as OpenCodeEvent);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`opencode NDJSON parse failure at line ${i + 1}: ${message}`);
    }
  }
  return events;
}

const DENIAL_ERROR_PATTERN =
  /specified a rule which prevents you from using this specific tool call/i;
const ERROR_TYPE_PATTERN = /^error$/i;

type ToolState = { status?: unknown; error?: unknown; input?: unknown };

function toolState(event: OpenCodeEvent): ToolState | undefined {
  const part = (event as Record<string, unknown>).part as Record<string, unknown> | undefined;
  return part?.state as ToolState | undefined;
}

function firstPattern(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const candidates = [record.command, record.filePath, record.patchText];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate.slice(0, 200);
    }
  }
  return undefined;
}

function extractText(event: OpenCodeEvent): string {
  const record = event as Record<string, unknown>;
  const errorField = record.error as
    | { message?: unknown; data?: { message?: unknown } }
    | undefined;
  const candidates = [
    record.text,
    record.message,
    (record.part as { text?: unknown } | undefined)?.text,
    (record.properties as { text?: unknown } | undefined)?.text,
    errorField?.data?.message,
    errorField?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

function extractToolName(event: OpenCodeEvent): string {
  const record = event as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const part = record.part as Record<string, unknown> | undefined;
  const candidates = [record.tool, properties?.tool, part?.tool, record.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "unknown";
}

export function summarize(events: OpenCodeEvent[]): EventSummary {
  let sessionID: string | undefined;
  const denials: EventDenial[] = [];
  const errors: string[] = [];
  const toolCounts = new Map<string, number>();
  let lastText = "";

  for (const event of events) {
    if (sessionID === undefined && typeof event.sessionID === "string") {
      sessionID = event.sessionID;
    }

    const text = extractText(event);

    if (event.type === "tool_use") {
      const tool = extractToolName(event);
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      const state = toolState(event);
      if (state?.status === "error" && typeof state.error === "string") {
        if (DENIAL_ERROR_PATTERN.test(state.error)) {
          denials.push({
            tool,
            pattern: firstPattern(state.input),
            message: state.error.slice(0, 200),
          });
        } else {
          errors.push(`${tool}: ${state.error.slice(0, 500)}`);
        }
      }
    } else if (ERROR_TYPE_PATTERN.test(event.type)) {
      errors.push(text.length > 0 ? text : event.type);
    }

    if (text.length > 0) {
      lastText = text;
    }
  }

  const toolUses = Array.from(toolCounts.entries()).map(([tool, count]) => ({ tool, count }));

  return {
    sessionID,
    denials,
    errors,
    toolUses,
    textTail: lastText.slice(-2000),
  };
}
