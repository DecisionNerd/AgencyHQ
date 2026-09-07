// Process-tree kill and survivor scan for the stop sequence in
// docs/engineering/EXECUTION_MODEL.md lines 68-86 ("Cancel... sends SIGTERM
// then SIGKILL to the OpenCode process group, and records whether any
// process survived") and the "Termination" row of
// docs/engineering/ARCHITECTURE.md lines 109-127. No Trigger SDK usage.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 100;

type ProcRow = { pid: number; ppid: number; pgid: number };

function isSignalableTarget(pid: number): boolean {
  return pid > 1 && pid !== process.pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  if (!isSignalableTarget(pid)) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal: not an error for this function.
  }
}

function tryGroupSignal(pgid: number, signal: NodeJS.Signals): void {
  if (!isSignalableTarget(pgid)) {
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already empty or not ours: not an error for this function.
  }
}

async function listProcesses(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(pgid)) {
      rows.push({ pid, ppid, pgid });
    }
  }
  return rows;
}

export async function descendants(rootPid: number): Promise<number[]> {
  const rows = await listProcesses();
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid) ?? [];
    siblings.push(row.pid);
    childrenByParent.set(row.ppid, siblings);
  }

  const result = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || result.has(pid)) {
      continue;
    }
    result.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      queue.push(child);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killTree(args: {
  rootPid: number;
  pgid: number;
  graceMs?: number;
}): Promise<{ terminated: number[]; killed: number[]; survivors: number[] }> {
  const graceMs = args.graceMs ?? 3000;
  const targets = await descendants(args.rootPid);

  tryGroupSignal(args.pgid, "SIGTERM");
  for (const pid of targets) {
    trySignal(pid, "SIGTERM");
  }

  const deadline = Date.now() + graceMs;
  let remaining = targets.filter((pid) => isSignalableTarget(pid) && isAlive(pid));
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    remaining = remaining.filter((pid) => isAlive(pid));
  }

  const terminated = targets.filter((pid) => !remaining.includes(pid));

  let killed: number[] = [];
  if (remaining.length > 0) {
    tryGroupSignal(args.pgid, "SIGKILL");
    for (const pid of remaining) {
      trySignal(pid, "SIGKILL");
    }
    killed = [...remaining];
    await sleep(POLL_INTERVAL_MS);
  }

  const survivors = targets.filter(
    (pid) => isSignalableTarget(pid) && isAlive(pid) && killed.includes(pid),
  );

  return { terminated, killed, survivors };
}

/**
 * Every live process that belongs to an attempt: matched by the
 * `AGENCYHQ_ATTEMPT_ID=<id>` environment marker where `ps -E` exposes it
 * (macOS prints environments only for some processes), unioned with any
 * command line that carries the attempt id (the OpenCode child is spawned
 * with `--title attempt-<id>` and `--dir .../attempts/<id>`). Observed
 * 2026-09-07 during trial item 2: `ps -E` showed no environment for a live
 * OpenCode child, so the command-line match is load-bearing, not a fallback.
 */
export async function survivorScan(attemptId: string): Promise<number[]> {
  const needle = `AGENCYHQ_ATTEMPT_ID=${attemptId}`;
  const found = new Set<number>();
  try {
    const { stdout } = await execFileAsync("ps", ["-E", "-axo", "pid=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const pid of extractPids(stdout, needle)) {
      found.add(pid);
    }
  } catch {
    // `ps -E` unsupported: the command-line scan below still runs.
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const pid of extractPids(stdout, attemptId)) {
    found.add(pid);
  }
  return [...found].filter((pid) => isAlive(pid)).sort((a, b) => a - b);
}

function extractPids(psOutput: string, needle: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.includes(needle)) {
      continue;
    }
    const trimmed = line.trim();
    const firstSpace = trimmed.indexOf(" ");
    const pidText = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const pid = Number(pidText);
    if (Number.isFinite(pid) && isSignalableTarget(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}
