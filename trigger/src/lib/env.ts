// Scrubbed child environment for the OpenCode worker process (ADR-0007
// item 3, docs/engineering/adrs/0007-worker-effect-model.md lines 29-34, and
// the enforcement table in docs/engineering/ARCHITECTURE.md lines 109-127,
// "Git pushes from the worker" row). This is an allowlist, not a denylist:
// only the names below are ever copied from `process.env`. No Trigger SDK
// usage.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ALLOWED_NAMES = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR"];

/**
 * Names the design calls out as the reason this is an allowlist and not a
 * denylist: copying `process.env` and deleting these would be fragile
 * against unlisted secrets. Not used to filter; documentation only.
 */
export const REMOVED_BY_ALLOWLIST = [
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_API_URL",
  "TRIGGER_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_*",
] as const;

export function scrubbedChildEnv(args: {
  attemptId: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of ALLOWED_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) {
      env[key] = value;
    }
  }

  env.AGENCYHQ_ATTEMPT_ID = args.attemptId;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/usr/bin/false";
  env.GIT_SSH_COMMAND = "/usr/bin/false";

  if (args.extra) {
    for (const [key, value] of Object.entries(args.extra)) {
      env[key] = value;
    }
  }

  return env;
}

export async function assertPushBlocked(args: {
  repoPath: string;
  env: Record<string, string>;
}): Promise<{ blocked: boolean; exitCode: number; stderrTail: string }> {
  try {
    await execFileAsync(
      "git",
      ["push", "--dry-run", "origin", "HEAD:refs/heads/agencyhq-spike-control"],
      { cwd: args.repoPath, env: args.env, maxBuffer: 8 * 1024 * 1024 },
    );
    return { blocked: false, exitCode: 0, stderrTail: "" };
  } catch (error: unknown) {
    const execError = error as { code?: number | string; stderr?: string };
    const exitCode = typeof execError.code === "number" ? execError.code : 1;
    const stderr = execError.stderr ?? "";
    const stderrTail = stderr.slice(-2000);
    return { blocked: exitCode !== 0, exitCode, stderrTail };
  }
}
