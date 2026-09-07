// Repo-relative path classification and quarantine for the worker.attempt
// output-path boundary (docs/engineering/ARCHITECTURE.md lines 109-127,
// "Output paths" row: "Adapter diff check against paths.allow/deny;
// violations quarantine the attempt"). The matcher below is intentionally
// minimal: `*` (no `/`), `**` (crosses `/`), `?` (one char, no `/`), and
// exact literal paths. No Trigger SDK usage.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeRegExpChar(char: string): string {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile a minimal glob (`*`, `**`, `?`, literal) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined) {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function isSuspicious(path: string): boolean {
  if (path.startsWith("/")) {
    return true;
  }
  const segments = path.split("/");
  return segments.some((segment) => segment === "..");
}

export function classifyPaths(args: {
  changed: string[];
  allowed: string[];
  /** Glob patterns the worker must NOT edit. A path matching any denied glob
   * is a violation even when it also matches an allowed glob (last-match-wins
   * on-output layer mirrors the before-action permission ruleset). */
  denied?: string[];
}): {
  allowed: string[];
  violations: string[];
} {
  const allowed: string[] = [];
  const violations: string[] = [];
  const denied = args.denied ?? [];

  for (const path of args.changed) {
    if (isSuspicious(path)) {
      violations.push(path);
      continue;
    }
    const isAllowed = args.allowed.some((pattern) => matchesGlob(pattern, path));
    if (!isAllowed) {
      violations.push(path);
      continue;
    }
    // Deny overrides allow: a path matching any denied glob is quarantined even
    // when it also matches an allowed pattern (last-match-wins).
    const isDenied = denied.some((pattern) => matchesGlob(pattern, path));
    if (isDenied) {
      violations.push(path);
    } else {
      allowed.push(path);
    }
  }

  return { allowed, violations };
}

async function pathExistsAtRev(worktreePath: string, rev: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${rev}:${path}`], { cwd: worktreePath });
    return true;
  } catch {
    return false;
  }
}

function syntheticNewFilePatch(path: string, content: string): string {
  const lines = content.length === 0 ? [] : content.split("\n");
  // A trailing split artifact from a final newline is dropped so the patch
  // does not claim an extra empty added line.
  if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join("\n");
  const header = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join("\n");
  return lines.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
}

export async function quarantinePatch(args: {
  worktreePath: string;
  baseRev: string;
  paths: string[];
}): Promise<string> {
  if (args.paths.length === 0) {
    return "";
  }

  const trackedOrModified: string[] = [];
  const untracked: string[] = [];
  for (const path of args.paths) {
    const existedAtBase = await pathExistsAtRev(args.worktreePath, args.baseRev, path);
    if (existedAtBase) {
      trackedOrModified.push(path);
    } else {
      untracked.push(path);
    }
  }

  const parts: string[] = [];
  if (trackedOrModified.length > 0) {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", args.baseRev, "--", ...trackedOrModified],
      { cwd: args.worktreePath, maxBuffer: 64 * 1024 * 1024 },
    );
    if (stdout.length > 0) {
      parts.push(stdout);
    }
  }
  for (const path of untracked) {
    const content = await readFile(`${args.worktreePath}/${path}`, "utf8").catch(() => "");
    parts.push(syntheticNewFilePatch(path, content));
  }

  return parts.join("");
}
