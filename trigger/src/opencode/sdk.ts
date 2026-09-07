// OpenCode SDK integration for the AgencyHQ Lead agent.
//
// SDK facts verified against @opencode-ai/sdk 1.18.29 typings and
// https://opencode.ai/docs/sdk/ (read 2026-09-07):
//
// - The v2 SDK exports `createOpencodeClient` from "@opencode-ai/sdk/v2/client"
//   and `OpencodeClient` which has `client.session` (Session2 class).
// - Session2.create({ directory }) creates a new session; returns Session { id }.
// - Session2.prompt({ sessionID, format, variant, model, agent, system, parts })
//   sends a prompt and waits for the full response. Supports:
//     format?: OutputFormat  where OutputFormat = { type: "json_schema"; schema: JsonSchema }
//     variant?: string
//   Returns: { info: AssistantMessage; parts: Part[] }
//   AssistantMessage has `structured?: unknown` (the structured output value).
// - Verified field name: AssistantMessage.structured (not "structured_output").
//
// SERVER SPAWN DECISION (2026-09-07):
//   The SDK's createOpencodeServer (from "@opencode-ai/sdk/v2/server") spawns
//   `opencode serve` but only supports { hostname, port, signal, timeout, config }
//   in ServerOptions — it has NO `env` parameter to pass custom env vars like
//   OPENCODE_DISABLE_PROJECT_CONFIG=1, OPENCODE_PURE=1. It does pass
//   OPENCODE_CONFIG_CONTENT (the config serialized) via process.env spread.
//   Since we need OPENCODE_DISABLE_PROJECT_CONFIG and OPENCODE_PURE for
//   isolation, we spawn opencode ourselves with child_process.spawn (detached)
//   and connect the v2 client to it. This is the spawn-yourself path.
//
// PROBE RUN (see scripts/lead-probe.ts): recorded in the probe script header comment.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { PermissionRuleset } from "@agencyhq/contracts";
import { runConfigFor } from "@agencyhq/contracts";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { extractStructured } from "./structured.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadPromptInput<T> {
  /** Worktree directory the Lead should inspect. */
  dir: string;
  /** Run directory for config/log files (created if absent). */
  runDir: string;
  /** Provider/model string (e.g. "openai/model-name"). */
  model: string;
  /** Model variant (e.g. "low"). */
  variant?: string | undefined;
  /** Agent name in the OpenCode config (must be "agencyhq-lead"). */
  agentName: "agencyhq-lead";
  /** Permission ruleset for the Lead (read-only). */
  ruleset: PermissionRuleset;
  /** Scrubbed child environment (from scrubbedChildEnv). */
  env: Record<string, string>;
  /** System context explaining the Lead role and authority. */
  systemContext: string;
  /** User prompt with operator intent and repository context. */
  userPrompt: string;
  /** JSON schema for the expected output (draft-2020-12). */
  schema: Record<string, unknown>;
  /** Parse function applied to the raw structured output. */
  parse: (raw: unknown) => T;
  /** Hard timeout for the prompt call in milliseconds. */
  timeoutMs: number;
}

export interface LeadPromptResult<T> {
  sessionId: string;
  /** Raw structured output as returned by the model (before parse). */
  raw: unknown;
  /** Parsed output value. */
  value: T;
  /** Token/cost usage from the AssistantMessage, if available. */
  usage?: unknown;
}

// ---------------------------------------------------------------------------
// Server spawn helpers
// ---------------------------------------------------------------------------

/** Parse the opencode server URL from its stdout output. */
function parseServerUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("opencode server listening")) {
      const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

/** Spawn `opencode serve` with the given env and wait until it reports its URL. */
async function spawnServe(args: {
  dir: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<{ url: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: args.dir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: args.env,
    });

    let output = "";
    let settled = false;

    const kill = () => {
      if (!child.killed) {
        try {
          process.kill(-(child.pid ?? 0), "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    };

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        kill();
        reject(new Error(`opencode serve did not start within ${args.timeoutMs}ms`));
      }
    }, args.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString();
      const url = parseServerUrl(output);
      if (url) {
        settled = true;
        clearTimeout(timeout);
        resolve({ url, kill });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`opencode serve spawn error: ${err.message}`));
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`opencode serve exited with code ${String(code)} before reporting URL`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// leadPrompt
// ---------------------------------------------------------------------------

/**
 * Run one Lead session via OpenCode:
 *  1. Write the run config to `<runDir>/opencode.lead.json`.
 *  2. Spawn `opencode serve --port 0` with isolation env vars.
 *  3. Create a session bound to `dir`.
 *  4. Send ONE prompt with json_schema structured output.
 *  5. Extract `info.structured`, apply `parse`.
 *  6. Record request/response summary in `<runDir>/lead-events.json`.
 *  7. Kill the server in `finally`.
 *
 * Throws on SDK/server errors. The caller is responsible for mapping parse
 * failures to { kind: "invalid_output" }.
 */
export async function leadPrompt<T>(input: LeadPromptInput<T>): Promise<LeadPromptResult<T>> {
  await mkdir(input.runDir, { recursive: true });

  // 1. Write run config
  const config = runConfigFor({
    model: input.model,
    agentName: input.agentName,
    ruleset: input.ruleset,
    disableMcp: ["jean", "t3-coordinator"],
  });
  const configPath = `${input.runDir}/opencode.lead.json`;
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // 2. Build env for the spawned server
  const [providerID, ...modelParts] = input.model.split("/");
  const modelID = modelParts.join("/");
  if (!providerID || !modelID) {
    throw new Error(`model must be "provider/model" format, got: ${input.model}`);
  }

  const serverEnv: Record<string, string> = {
    ...input.env,
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_PERMISSION: JSON.stringify(input.ruleset),
  };

  const startMs = Date.now();
  let server: { url: string; kill: () => void } | undefined;

  try {
    // 2. Spawn server (SDK cannot pass env vars — spawn ourselves)
    server = await spawnServe({
      dir: input.dir,
      env: serverEnv,
      timeoutMs: Math.min(30_000, input.timeoutMs),
    });

    // 3. Create SDK client and session
    const client = createOpencodeClient({ baseUrl: server.url });
    const sessionResp = await client.session.create({
      directory: input.dir,
      agent: input.agentName,
    });
    if (sessionResp.error) {
      throw new Error(`session create failed: ${JSON.stringify(sessionResp.error)}`);
    }
    const sessionId = sessionResp.data?.id;
    if (!sessionId) {
      throw new Error("session create returned no id");
    }

    // 4. Send ONE prompt with json_schema format and timeout
    const promptDeadlineMs = input.timeoutMs - (Date.now() - startMs);
    if (promptDeadlineMs <= 0) throw new Error("timeout before prompt could be sent");

    let promptData: { info: unknown; parts: unknown[] } | undefined;
    await Promise.race([
      (async () => {
        const resp = await client.session.prompt({
          sessionID: sessionId,
          directory: input.dir,
          agent: input.agentName,
          model: { providerID, modelID },
          ...(input.variant !== undefined ? { variant: input.variant } : {}),
          system: input.systemContext,
          format: { type: "json_schema", schema: input.schema },
          parts: [{ type: "text", text: input.userPrompt }],
        });
        if (resp.error) {
          throw new Error(`session prompt failed: ${JSON.stringify(resp.error)}`);
        }
        promptData = resp.data as typeof promptData;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`leadPrompt timed out after ${input.timeoutMs}ms`)),
          promptDeadlineMs,
        ),
      ),
    ]);

    if (!promptData) throw new Error("prompt returned no data");

    // 5. Extract structured output
    const extracted = extractStructured(promptData.info);
    if (!extracted.ok) {
      throw new Error(`structured extraction failed: ${extracted.reason}`);
    }
    const raw = extracted.value;

    // Parse with caller's function
    const value = input.parse(raw);

    // 6. Record events
    const usage =
      typeof promptData.info === "object" && promptData.info !== null
        ? (promptData.info as Record<string, unknown>).tokens
        : undefined;

    const summary = {
      date: "2026-09-07",
      request: {
        model: input.model,
        variant: input.variant,
        agentName: input.agentName,
        sessionId,
        systemContextLength: input.systemContext.length,
        userPromptLength: input.userPrompt.length,
        schemaKeys: Object.keys(input.schema),
      },
      response: {
        infoKeys:
          typeof promptData.info === "object" && promptData.info !== null
            ? Object.keys(promptData.info)
            : [],
        hasStructured: extracted.ok,
        usage,
        elapsedMs: Date.now() - startMs,
      },
    };
    await writeFile(`${input.runDir}/lead-events.json`, JSON.stringify(summary, null, 2)).catch(
      () => {
        /* non-fatal */
      },
    );

    return { sessionId, raw, value, usage };
  } finally {
    server?.kill();
  }
}
