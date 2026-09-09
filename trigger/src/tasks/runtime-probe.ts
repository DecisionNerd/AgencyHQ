/**
 * runtime.probe task — reports the tool versions, uid, home directory,
 * writable-directory status, platform, cwd, and environment key names
 * inside the task container.
 *
 * This task is the first live signal that the AgencyHQ task image is correctly
 * configured (introduced in P16.1 as the production successor to the Slice 6
 * probe):
 * the expected binaries (git, opencode, pnpm) are on PATH, HOME is set
 * and writable, and the shared run root (/tmp/agencyhq) is writable.
 *
 * The task NEVER returns env values — only the sorted list of env variable
 * names (envKeys). This is enforced by construction: only process.env key
 * names are collected, never the values.
 *
 * machine: "small-1x" — verified against MachinePresetName in:
 *   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
 *   node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/common.d.ts
 *   ZodEnum<["micro","small-1x","small-2x","medium-1x","medium-2x",...]>
 *   (read 2026-09-09)
 * machine field on task verified from:
 *   node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
 *   node_modules/@trigger.dev/core/dist/commonjs/v3/types/tasks.d.ts
 *   machine?: { preset?: MachinePresetName } | MachinePresetName
 *   (read 2026-09-09)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { task } from "@trigger.dev/sdk";

import type { RuntimeProbeOutput, RuntimeProbePayload } from "../types.ts";
import { TASK_IDS } from "../types.ts";

/**
 * Run a single binary and return its trimmed stdout, or
 * "unavailable: <short reason>" on any error.
 */
function probeVersion(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", timeout: 20_000 }).trim();
  } catch (err) {
    const msg = String((err as Error).message).slice(0, 100);
    return `unavailable: ${msg}`;
  }
}

/**
 * Return true when a temp file can be created and removed in `dir`.
 * Returns false on any filesystem error.
 */
function isWritable(dir: string): boolean {
  let tmpDir: string | undefined;
  try {
    tmpDir = mkdtempSync(join(dir, ".probe-"));
    writeFileSync(join(tmpDir, "probe"), "");
    return true;
  } catch {
    return false;
  } finally {
    if (tmpDir !== undefined) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Core probe logic, exported for unit tests. The Trigger task wrapper calls
 * this function; tests call it directly without needing the Trigger runtime.
 */
export async function runProbeImpl(_payload: RuntimeProbePayload): Promise<RuntimeProbeOutput> {
  const home = process.env.HOME ?? "";
  const runRoot = process.env.AGENCYHQ_RUN_ROOT ?? "/tmp/agencyhq";

  return {
    tools: {
      git: probeVersion("git", ["--version"]),
      opencode: probeVersion("opencode", ["--version"]),
      pnpm: probeVersion("pnpm", ["--version"]),
      node: probeVersion("node", ["--version"]),
    },
    uid: String(process.getuid?.() ?? "n/a"),
    home,
    homeWritable: home !== "" && isWritable(home),
    runRootWritable: runRoot !== "" && isWritable(runRoot),
    platform: `${process.platform}/${process.arch}`,
    cwd: process.cwd(),
    // Keys only — no values are returned, preventing accidental secret exposure.
    envKeys: Object.keys(process.env).sort(),
  };
}

export const runtimeProbe = task({
  id: TASK_IDS.runtimeProbe,
  // small-1x: probe is lightweight diagnostics; no model or git operations.
  // MachinePresetName "small-1x" verified from schemas/common.d.ts (read 2026-09-09).
  machine: "small-1x",
  maxDuration: 120,
  retry: { maxAttempts: 1 },

  run: runProbeImpl,
});
