import { execFileSync } from "node:child_process";
import { task } from "@trigger.dev/sdk";

import type { SpikeEchoPayload } from "../types.ts";
import { TASK_IDS } from "../types.ts";

/** Spike-only: report whether the tools the adapters need exist in this
 * runtime (host or container image). Never runs a model. */
function toolProbe(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, argv] of [
    ["git", ["git", "--version"]],
    ["opencode", ["opencode", "--version"]],
    ["pnpm", ["pnpm", "--version"]],
    ["node", ["node", "--version"]],
  ] as const) {
    try {
      out[name] = execFileSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        timeout: 20_000,
      }).trim();
    } catch (err) {
      out[name] = `unavailable: ${String((err as Error).message).slice(0, 80)}`;
    }
  }
  out.cwd = process.cwd();
  out.platform = `${process.platform}/${process.arch}`;
  out.uid = String(process.getuid?.() ?? "n/a");
  return out;
}

export const spikeEcho = task({
  id: TASK_IDS.spikeEcho,
  run: async (payload: SpikeEchoPayload) => {
    return {
      message: payload.message,
      envKeys: Object.keys(process.env).sort(),
      node: process.version,
      // Spike-only: values of the allowlisted names the adapters forward to
      // child processes (never secrets), so a host-profile run can be compared
      // with an interactive shell.
      tools: toolProbe(),
      envValues: Object.fromEntries(
        ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR"].map((k) => [
          k,
          process.env[k] ?? null,
        ]),
      ),
    };
  },
});
