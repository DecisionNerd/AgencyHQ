/**
 * Pure assertion functions for the image smoke script.
 *
 * Factored out of trigger/scripts/image-smoke.ts so they can be unit-tested
 * without running against a live Trigger instance (trigger/test/image-smoke.test.ts).
 *
 * Both functions return null on success, or a non-empty string naming the
 * failing assertion on failure.  The smoke script exits non-zero and prints
 * the returned string when either function returns a non-null value.
 *
 * INVARIANT: neither function prints env values or secret data — they only
 * reference field names and version strings.
 */

import type { ImageSmokeCheckResult, RuntimeProbeOutput } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// Probe pins — what the smoke script verifies against the runtime.probe output
// ---------------------------------------------------------------------------

export type ProbePins = {
  /** Expected opencode-ai version string, e.g. "1.18.29". */
  opencodeVersion: string;
  /** Expected pnpm version string, e.g. "11.25.0". */
  pnpmVersion: string;
  /**
   * Expected platform string in the format "linux/<arch>",
   * e.g. "linux/arm64".  Derived from AGENCYHQ_PLATFORM env var
   * (defaulting to "linux/arm64") in the smoke script.
   */
  platform: string;
};

// ---------------------------------------------------------------------------
// assertProbe
// ---------------------------------------------------------------------------

/**
 * Assert that a `runtime.probe` output matches the expected toolchain pins and
 * container configuration.
 *
 * Checks (in order):
 * 1. git is available (not "unavailable: …").
 * 2. opencode is available and its version string contains `pins.opencodeVersion`.
 * 3. pnpm is available and its version string contains `pins.pnpmVersion`.
 * 4. node is available and its major version is 24.
 * 5. uid is "1000" (the node user in the task image).
 * 6. HOME is writable.
 * 7. Run root (AGENCYHQ_RUN_ROOT) is writable.
 * 8. platform equals `pins.platform`.
 * 9. None of the forbidden env keys are present in `envKeys`:
 *    SSH_AUTH_SOCK, GH_TOKEN, GITHUB_TOKEN, and any key starting with AWS_.
 *
 * Returns null when all assertions pass, or a short description of the first
 * failing assertion (no env values are included).
 */
export function assertProbe(output: RuntimeProbeOutput, pins: ProbePins): string | null {
  // 1. git available
  if (output.tools.git.startsWith("unavailable:")) {
    return `assertion failed: git is unavailable in the task image`;
  }

  // 2. opencode available and version pinned
  if (output.tools.opencode.startsWith("unavailable:")) {
    return `assertion failed: opencode is unavailable in the task image`;
  }
  if (!output.tools.opencode.includes(pins.opencodeVersion)) {
    return `assertion failed: opencode version does not contain "${pins.opencodeVersion}" (got "${output.tools.opencode}")`;
  }

  // 3. pnpm available and version pinned
  if (output.tools.pnpm.startsWith("unavailable:")) {
    return `assertion failed: pnpm is unavailable in the task image`;
  }
  if (!output.tools.pnpm.includes(pins.pnpmVersion)) {
    return `assertion failed: pnpm version does not contain "${pins.pnpmVersion}" (got "${output.tools.pnpm}")`;
  }

  // 4. node available and major version 24
  if (output.tools.node.startsWith("unavailable:")) {
    return `assertion failed: node is unavailable in the task image`;
  }
  const nodeMatch = output.tools.node.match(/^v?(\d+)\./);
  if (nodeMatch === null || nodeMatch[1] !== "24") {
    return `assertion failed: node major version is not 24 (got "${output.tools.node}")`;
  }

  // 5. uid 1000
  if (output.uid !== "1000") {
    return `assertion failed: uid is not 1000 (got "${output.uid}")`;
  }

  // 6. HOME writable
  if (!output.homeWritable) {
    return `assertion failed: HOME is not writable in the task image`;
  }

  // 7. run root writable
  if (!output.runRootWritable) {
    return `assertion failed: AGENCYHQ_RUN_ROOT is not writable in the task image`;
  }

  // 8. platform matches
  if (output.platform !== pins.platform) {
    return `assertion failed: platform is "${output.platform}", expected "${pins.platform}"`;
  }

  // 9. forbidden env keys absent
  const forbiddenExact = ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"];
  for (const key of forbiddenExact) {
    if (output.envKeys.includes(key)) {
      return `assertion failed: forbidden env key "${key}" is present in the task container`;
    }
  }
  const awsKey = output.envKeys.find((k) => k.startsWith("AWS_"));
  if (awsKey !== undefined) {
    return `assertion failed: forbidden AWS env key "${awsKey}" is present in the task container`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// assertSmoke
// ---------------------------------------------------------------------------

/**
 * Assert that every check in an `image.smoke` result set passed.
 *
 * Returns null when all checks passed, or a short description naming the
 * first failing check (no stdout/stderr values are included in the return
 * value — the caller may print them separately for debugging).
 */
export function assertSmoke(results: ImageSmokeCheckResult[]): string | null {
  if (results.length === 0) {
    return "assertion failed: image.smoke ran no checks";
  }

  for (const r of results) {
    if (!r.passed) {
      const reason = r.timedOut ? "timed out" : `exited with status ${r.exitStatus ?? "null"}`;
      return `assertion failed: check "${r.checkId}" did not pass (${reason})`;
    }
  }

  return null;
}
