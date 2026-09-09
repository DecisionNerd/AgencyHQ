// Per-run HOME directory for the container profile (epic #14, P17.2).
// On the container profile, each run gets an isolated home directory under
// <runRoot>/runs/<runId>/home so that provider auth material delivered by the
// coordinator lease broker (P18.3 / P17.1) is kept out of the shared /home/node.
// On the host profile (trigger dev) the host's own HOME is used unchanged.
// No Trigger SDK usage.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type RuntimeProfile = "container" | "host";

export interface ResolveRunHomeArgs {
  profile: RuntimeProfile;
  /** Root of the run filesystem, e.g. /tmp/agencyhq */
  runRoot: string;
  /** Unique run identifier — must match /^[A-Za-z0-9_-]{1,128}$/ */
  runId: string;
  /** The host's HOME, returned as-is on the host profile */
  hostHome: string;
}

export interface ResolveRunHomeResult {
  /** Absolute path to use as HOME for this run */
  home: string;
  /** true if the directory was just created; false if it already existed */
  created: boolean;
}

/**
 * Resolve the per-run HOME directory.
 *
 * Container profile: creates <runRoot>/runs/<runId>/home (0700) and
 * <home>/.local/share/opencode (0700) so a later lease can place auth.json
 * there.
 *
 * Host profile: returns hostHome unchanged; creates nothing.
 */
export function resolveRunHome(args: ResolveRunHomeArgs): ResolveRunHomeResult {
  const { profile, runRoot, runId, hostHome } = args;

  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`Invalid runId "${runId}": must match /^[A-Za-z0-9_-]{1,128}$/`);
  }

  if (profile === "host") {
    return { home: hostHome, created: false };
  }

  // container profile
  const home = join(runRoot, "runs", runId, "home");

  // mkdirSync with recursive returns the first directory path created, or
  // undefined when the directory already existed — use that to set created.
  const firstCreated = mkdirSync(home, { recursive: true, mode: 0o700 });
  const created = firstCreated !== undefined;

  // Ensure .local/share/opencode also exists at 0700 so a later lease can
  // drop auth.json there without needing to create the directory itself.
  mkdirSync(join(home, ".local", "share", "opencode"), {
    recursive: true,
    mode: 0o700,
  });

  return { home, created };
}

/**
 * Read the runtime profile from the process environment (or a provided env
 * map). Returns "container" only when AGENCYHQ_RUNTIME_PROFILE is exactly
 * "container"; otherwise returns "host".
 */
export function readRuntimeProfile(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RuntimeProfile {
  return env.AGENCYHQ_RUNTIME_PROFILE === "container" ? "container" : "host";
}
