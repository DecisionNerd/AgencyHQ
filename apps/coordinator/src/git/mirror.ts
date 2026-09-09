/**
 * Git mirror operations for the coordinator.
 *
 * The coordinator maintains a bare mirror per project at:
 *   <gitRoot>/mirrors/<projectId>.git
 *
 * Credentials for private remotes are supplied via a temporary GIT_ASKPASS
 * script file (mode 0700, deleted after each operation). The token value is
 * NEVER passed on the command line or written to process env logs.
 *
 * SECURITY INVARIANTS:
 *  - Secret values (askpass token) never appear in error messages or logs.
 *  - GIT_TERMINAL_PROMPT=0 on all network-facing git invocations.
 *  - Credential files are always deleted in a finally block.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirrorRef {
  /** Absolute path to the bare git mirror (ends with .git). */
  mirrorPath: string;
  /** The upstream HTTPS remote URL (no credentials embedded). */
  remote: string;
}

/**
 * Project fields needed by mirror operations.
 * Callers may supply a wider ProjectRow; only these fields are consumed.
 */
export interface MirrorProject {
  id: string;
  /** HTTPS remote URL; may be null for projects that have no upstream. */
  remote: string | null;
}

export interface MirrorDeps {
  /** Root directory for all mirrors, e.g. /var/agencyhq/git. */
  gitRoot: string;
  /**
   * Optional: decrypted askpass token for private remotes.
   * When provided, a temporary GIT_ASKPASS script is written before
   * any network-facing git call and deleted immediately after.
   * MUST NOT be logged or included in errors.
   */
  askpassToken?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command inside the given cwd, returning trimmed stdout.
 * Network-facing calls always include GIT_TERMINAL_PROMPT=0.
 *
 * @param args    Git arguments (first element must not be "git")
 * @param cwd     Working directory
 * @param env     Additional env overrides (e.g. GIT_ASKPASS)
 */
async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const mergedEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...env,
  };
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: mergedEnv,
    maxBuffer: 256 * 1024 * 1024, // 256 MiB for large diffs
  });
  return stdout;
}

/**
 * Write a temporary GIT_ASKPASS script that echoes the given token.
 * The script is executable (0700) and returns the token on stdout.
 * Returns the script path; caller is responsible for deleting it.
 * SECURITY: The token value is written only to the file, not to any log.
 */
async function writeAskpassScript(token: string): Promise<string> {
  const scriptPath = join(
    tmpdir(),
    `agencyhq-askpass-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  );
  // The script echoes the token; git calls it when credentials are needed.
  const content = `#!/bin/sh\necho '${token.replace(/'/g, "'\\''")}'`;
  await writeFile(scriptPath, content, { encoding: "utf-8" });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

// ---------------------------------------------------------------------------
// mirrorPath
// ---------------------------------------------------------------------------

/** Returns the deterministic mirror path for a project. */
export function mirrorPath(gitRoot: string, projectId: string): string {
  return join(gitRoot, "mirrors", `${projectId}.git`);
}

// ---------------------------------------------------------------------------
// ensureMirror
// ---------------------------------------------------------------------------

/**
 * Ensure the bare mirror for the given project exists and is up-to-date.
 *
 * - If the mirror directory does not exist: `git clone --mirror <remote>`
 * - If it already exists: `git remote update --prune`
 *
 * Credentials for private remotes are supplied via a temporary GIT_ASKPASS
 * script if `deps.askpassToken` is provided.
 *
 * Returns a MirrorRef with the mirror path and remote URL.
 */
export async function ensureMirror(project: MirrorProject, deps: MirrorDeps): Promise<MirrorRef> {
  if (!project.remote) {
    throw new Error(`ensureMirror: project ${project.id} has no remote`);
  }
  const mp = mirrorPath(deps.gitRoot, project.id);
  const remote = project.remote;

  // Ensure parent directory exists
  await mkdir(join(deps.gitRoot, "mirrors"), { recursive: true });

  let askpassPath: string | undefined;
  const networkEnv: Record<string, string> = {};

  if (deps.askpassToken) {
    askpassPath = await writeAskpassScript(deps.askpassToken);
    networkEnv.GIT_ASKPASS = askpassPath;
  }

  try {
    // Check if mirror already exists
    let mirrorExists = false;
    try {
      const s = await stat(mp);
      mirrorExists = s.isDirectory();
    } catch {
      mirrorExists = false;
    }

    if (!mirrorExists) {
      // Clone the remote as a bare mirror
      await git(["clone", "--mirror", remote, mp], deps.gitRoot, networkEnv);
    } else {
      // Update existing mirror
      await git(["remote", "update", "--prune"], mp, networkEnv);
    }
  } finally {
    if (askpassPath) {
      await unlink(askpassPath).catch(() => undefined);
    }
  }

  return { mirrorPath: mp, remote };
}

// ---------------------------------------------------------------------------
// fetchRef
// ---------------------------------------------------------------------------

/**
 * Fetch a specific ref (or all refs) in the mirror from the upstream remote.
 * Uses a temporary askpass credential if provided.
 */
export async function fetchRef(
  mirror: MirrorRef,
  deps: Pick<MirrorDeps, "askpassToken">,
  ref?: string,
): Promise<void> {
  let askpassPath: string | undefined;
  const networkEnv: Record<string, string> = {};

  if (deps.askpassToken) {
    askpassPath = await writeAskpassScript(deps.askpassToken);
    networkEnv.GIT_ASKPASS = askpassPath;
  }

  try {
    const args = ref ? ["fetch", "--prune", "origin", ref] : ["fetch", "--prune", "origin"];
    await git(args, mirror.mirrorPath, networkEnv);
  } finally {
    if (askpassPath) {
      await unlink(askpassPath).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// revParse
// ---------------------------------------------------------------------------

/** Resolve a revision (ref or sha) to its full 40-hex SHA. Returns null if not found. */
export async function revParse(mirror: MirrorRef, rev: string): Promise<string | null> {
  try {
    const sha = await git(["rev-parse", "--verify", rev], mirror.mirrorPath);
    return sha.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// hasCommit
// ---------------------------------------------------------------------------

/**
 * Returns true if the commit identified by `sha` is present in the mirror
 * (reachable from any ref).
 */
export async function hasCommit(mirror: MirrorRef, sha: string): Promise<boolean> {
  try {
    // git cat-file -e <sha> exits 0 if the object exists
    await git(["cat-file", "-e", `${sha}^{commit}`], mirror.mirrorPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// isAncestor
// ---------------------------------------------------------------------------

/**
 * Returns true if `ancestor` is an ancestor (reachable) of `descendant` in
 * the mirror object store. Both must be full 40-hex SHAs.
 */
export async function isAncestorInMirror(
  mirror: MirrorRef,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    // git merge-base --is-ancestor <ancestor> <descendant>
    // exits 0 if ancestor is an ancestor, 1 if not
    await git(["merge-base", "--is-ancestor", ancestor, descendant], mirror.mirrorPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// lsRemote
// ---------------------------------------------------------------------------

/**
 * Query the upstream remote for the SHA at the given ref (e.g. refs/heads/main).
 * Returns null if the ref does not exist or the call fails.
 * Uses a temporary askpass credential if provided.
 */
export async function lsRemote(
  mirror: MirrorRef,
  ref: string,
  deps: Pick<MirrorDeps, "askpassToken">,
): Promise<string | null> {
  let askpassPath: string | undefined;
  const networkEnv: Record<string, string> = {};

  if (deps.askpassToken) {
    askpassPath = await writeAskpassScript(deps.askpassToken);
    networkEnv.GIT_ASKPASS = askpassPath;
  }

  try {
    const out = await git(
      ["ls-remote", "--exit-code", mirror.remote, ref],
      mirror.mirrorPath,
      networkEnv,
    );
    // Output: "<sha>\t<ref>"
    const line = out.trim().split("\n")[0];
    if (!line) return null;
    return line.split("\t")[0]?.trim() ?? null;
  } catch {
    return null;
  } finally {
    if (askpassPath) {
      await unlink(askpassPath).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// diffDigest
// ---------------------------------------------------------------------------

/**
 * Compute the canonical diff digest for the diff from `baseRev` to `headRev`
 * using the same algorithm as trigger/src/lib/git.ts:diffDigest.
 *
 * The digest is computed over:
 *  - `git diff <baseRev> <headRev>` output
 *  - Plus any untracked files (git diff --diff-filter=A shows added files)
 *
 * For a commit-to-commit diff in a mirror, untracked files do not apply —
 * we use `git diff <baseRev>..<headRev>` which includes all added files.
 *
 * Returns a string of the form `sha256:<64-hex>`.
 */
export async function diffDigest(
  mirror: MirrorRef,
  baseRev: string,
  headRev: string,
): Promise<string> {
  // git diff between two commits — the output matches the worktree diff the
  // worker computed (which uses git diff <baseRev> in the worktree).
  // Mirror equivalent: git diff <baseRev> <headRev>
  const diffOut = await git(["diff", baseRev, headRev], mirror.mirrorPath);

  const hash = createHash("sha256");
  hash.update(diffOut);
  // In the worktree version untracked files are appended; for commits in a
  // mirror all changes are tracked, so we only hash the diff output.
  return `sha256:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// rm mirror (for tests)
// ---------------------------------------------------------------------------

/** Remove a mirror directory. For use in test teardown only. */
export async function removeMirror(mp: string): Promise<void> {
  await rm(mp, { recursive: true, force: true });
}
