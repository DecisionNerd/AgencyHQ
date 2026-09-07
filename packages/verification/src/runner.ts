/**
 * Bounded check runner for @agencyhq/verification.
 *
 * Spawns the check command as a detached process group, captures the last
 * maxBytes of stdout/stderr (ring-buffer semantics), and kills the whole
 * process group on timeout.
 *
 * INVARIANT: never throws on non-zero exit.
 * INVARIANT: verification must not depend on @agencyhq/trigger.
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { CheckDef } from "./checks.ts";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Internal: ring buffer
// ---------------------------------------------------------------------------

/** Append `chunk` to a ring buffer of at most `maxBytes` bytes. */
function ringAppend(buf: Buffer[], currentSize: number, chunk: Buffer, maxBytes: number): number {
  buf.push(chunk);
  currentSize += chunk.length;
  // Trim from the front until we're within budget.
  while (currentSize > maxBytes && buf.length > 0) {
    const head = buf[0];
    if (head === undefined) break;
    if (head.length <= currentSize - maxBytes) {
      buf.shift();
      currentSize -= head.length;
    } else {
      // Slice the head so we keep only the bytes that fit.
      const drop = currentSize - maxBytes;
      buf[0] = head.slice(drop);
      currentSize -= drop;
      break;
    }
  }
  return currentSize;
}

// ---------------------------------------------------------------------------
// RunCheckResult
// ---------------------------------------------------------------------------

export interface RunCheckResult {
  exitStatus: number | null;
  signal: string | null;
  stdoutTail: string;
  stderrTail: string;
  startedAt: string;
  endedAt: string;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

/**
 * Run a single CheckDef and return an observed result.
 *
 * - Spawns with `detached: true` so the OS creates a new process group.
 * - Captures the last `maxBytes` of each stream.
 * - On timeout: sends SIGTERM to the process group; after 2 s sends SIGKILL.
 * - Never throws on non-zero exit or timeout.
 */
export async function runCheck(
  def: CheckDef,
  opts: {
    cwd: string;
    env?: Record<string, string> | undefined;
    maxBytes?: number | undefined;
  },
): Promise<RunCheckResult> {
  const maxBytes = opts.maxBytes ?? 16_384;
  const cwd = def.cwd ?? opts.cwd;
  const [executable, ...args] = def.command;

  if (executable === undefined) {
    throw new Error(`runCheck: def.command is empty for check "${def.id}"`);
  }

  const env: NodeJS.ProcessEnv = opts.env ? { ...process.env, ...opts.env } : { ...process.env };

  const startedAt = new Date().toISOString();

  const child = spawn(executable, args, {
    cwd,
    env,
    // detached: true creates a new process group so we can kill the whole tree.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutBufs: Buffer[] = [];
  const stderrBufs: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutSize = ringAppend(stdoutBufs, stdoutSize, chunk, maxBytes);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrSize = ringAppend(stderrBufs, stderrSize, chunk, maxBytes);
  });

  let timedOut = false;

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    } catch {
      // Process group may already be gone; ignore ESRCH.
    }
  };

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => {
      killGroup("SIGKILL");
    }, 2_000);
  }, def.timeoutSeconds * 1_000);

  const { exitStatus, signal } = await new Promise<{
    exitStatus: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("close", (code, sig) => {
      clearTimeout(timeoutHandle);
      resolve({ exitStatus: code, signal: sig });
    });
    child.on("error", () => {
      clearTimeout(timeoutHandle);
      resolve({ exitStatus: null, signal: null });
    });
  });

  const endedAt = new Date().toISOString();

  // Collect buffered output as UTF-8 strings.
  let stdoutTail = Buffer.concat(stdoutBufs).toString("utf8");
  const stderrTail = Buffer.concat(stderrBufs).toString("utf8");

  // Apply optional normalizer.
  if (def.normalize !== undefined) {
    stdoutTail = def.normalize(stdoutTail);
  }

  return {
    exitStatus,
    signal,
    stdoutTail,
    stderrTail,
    startedAt,
    endedAt,
    timedOut,
  };
}

// Re-export execFile for fingerprint.ts internal use.
export { execFile };
