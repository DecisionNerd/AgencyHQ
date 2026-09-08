/**
 * Environment fingerprint for @agencyhq/verification.
 *
 * Returns a map of host toolchain versions used when running checks.
 * Any tool that is unavailable (missing binary, exec error) is recorded
 * as "unavailable" rather than throwing.
 */

import { execFile as execFileCb } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

async function toolVersion(executable: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile(executable, args, { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

/**
 * Collect the environment fingerprint for the current host.
 *
 * Fields:
 * - `node`  — `process.version`
 * - `pnpm`  — `pnpm --version`
 * - `git`   — `git --version`
 * - `os`    — `process.platform + "/" + os.release()`
 * - `arch`  — `process.arch`
 *
 * The `cwd` parameter is accepted for future use (e.g. container image digest)
 * but is not currently used.
 */
export async function environmentFingerprint(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _cwd: string,
): Promise<Record<string, string>> {
  const [pnpm, git] = await Promise.all([
    toolVersion("pnpm", ["--version"]),
    toolVersion("git", ["--version"]),
  ]);

  return {
    node: process.version,
    pnpm,
    git,
    os: `${process.platform}/${os.release()}`,
    arch: process.arch,
  };
}
