// Pure git adapter used by the worker.attempt effect model (ADR-0007,
// docs/engineering/adrs/0007-worker-effect-model.md lines 18-63). Every
// function shells out to `git` via `child_process.execFile` with an explicit
// `cwd` and never through a shell. No Trigger SDK usage.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

type GitOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

async function git(
  args: string[],
  options: GitOptions,
): Promise<{ stdout: string; stderr: string }> {
  const execOptions: { cwd: string; maxBuffer: number; env?: NodeJS.ProcessEnv } = {
    cwd: options.cwd,
    maxBuffer: MAX_BUFFER,
  };
  if (options.env) {
    execOptions.env = options.env;
  }
  return execFileAsync("git", args, execOptions);
}

async function pathExistsAtRev(worktreePath: string, rev: string, path: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${rev}:${path}`], { cwd: worktreePath });
    return true;
  } catch {
    return false;
  }
}

export async function worktreeAdd(args: {
  repoPath: string;
  worktreePath: string;
  rev: string;
}): Promise<void> {
  await git(["worktree", "add", "--detach", args.worktreePath, args.rev], {
    cwd: args.repoPath,
  });
}

export async function worktreeRemove(args: {
  repoPath: string;
  worktreePath: string;
  force?: boolean;
}): Promise<void> {
  const gitArgs = ["worktree", "remove"];
  if (args.force) {
    gitArgs.push("--force");
  }
  gitArgs.push(args.worktreePath);
  await git(gitArgs, { cwd: args.repoPath });
}

export async function commitTree(args: {
  worktreePath: string;
  message: string;
  env?: NodeJS.ProcessEnv;
  /** Commit even when the tree is unchanged (used for checkpoints so the
   * checkpoint ref always exists and always points at a real commit). */
  allowEmpty?: boolean;
}): Promise<string | null> {
  const gitOptions: GitOptions = { cwd: args.worktreePath };
  if (args.env) {
    gitOptions.env = args.env;
  }
  await git(["add", "-A"], gitOptions);
  try {
    await git(
      [
        "-c",
        "user.name=agencyhq",
        "-c",
        "user.email=agencyhq@localhost",
        "commit",
        ...(args.allowEmpty ? ["--allow-empty"] : []),
        "-m",
        args.message,
      ],
      gitOptions,
    );
  } catch (error: unknown) {
    // Nothing to commit is not an error for this adapter: it means the
    // worker made no changes since the last checkpoint or the base revision.
    // execFile's rejection message only embeds stderr, so `git commit`'s
    // "nothing to commit" text (which it prints to stdout) is checked there.
    const execError = error as { message?: string; stdout?: string; stderr?: string };
    const combined = `${execError.message ?? ""}\n${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
    if (/nothing to commit/i.test(combined)) {
      return null;
    }
    throw error;
  }
  const { stdout } = await git(["rev-parse", "HEAD"], gitOptions);
  return stdout.trim();
}

export async function updateRef(args: {
  repoPath: string;
  ref: string;
  sha: string;
}): Promise<void> {
  await git(["update-ref", args.ref, args.sha], { cwd: args.repoPath });
}

export async function changedPaths(args: {
  worktreePath: string;
  baseRev: string;
}): Promise<string[]> {
  const [diffResult, untrackedResult] = await Promise.all([
    git(["diff", "--name-only", args.baseRev], { cwd: args.worktreePath }),
    git(["ls-files", "--others", "--exclude-standard"], { cwd: args.worktreePath }),
  ]);
  const diffPaths = diffResult.stdout.split("\n").filter((line) => line.length > 0);
  const untrackedPaths = untrackedResult.stdout.split("\n").filter((line) => line.length > 0);
  return Array.from(new Set([...diffPaths, ...untrackedPaths])).sort();
}

export async function diffDigest(args: { worktreePath: string; baseRev: string }): Promise<string> {
  const diffResult = await git(["diff", args.baseRev], { cwd: args.worktreePath });
  const untrackedResult = await git(["ls-files", "--others", "--exclude-standard"], {
    cwd: args.worktreePath,
  });
  const untrackedPaths = untrackedResult.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();

  const hash = createHash("sha256");
  hash.update(diffResult.stdout);
  for (const path of untrackedPaths) {
    const content = await readFile(`${args.worktreePath}/${path}`, "utf8").catch(() => "");
    hash.update(`\0untracked:${path}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export async function revertPaths(args: {
  worktreePath: string;
  paths: string[];
  baseRev: string;
}): Promise<void> {
  for (const path of args.paths) {
    const existedAtBase = await pathExistsAtRev(args.worktreePath, args.baseRev, path);
    if (existedAtBase) {
      await git(["checkout", args.baseRev, "--", path], { cwd: args.worktreePath });
      continue;
    }
    // Unstage if the adapter already ran `git add -A`, then remove the file
    // itself. Errors from an already-unstaged path are expected and ignored.
    await git(["rm", "-f", "--cached", "--ignore-unmatch", path], {
      cwd: args.worktreePath,
    }).catch(() => undefined);
    const fullPath = `${args.worktreePath}/${path}`;
    const info = await stat(fullPath).catch(() => null);
    if (info) {
      await rm(fullPath, { force: true, recursive: info.isDirectory() });
    }
  }
}
