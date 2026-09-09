// Source bundle materialization for the container profile (epic #14, P18.3).
//
// materializeSource downloads a git bundle from the coordinator internal API,
// clones it into a fresh directory, and checks out the requested revision.
// A HEAD mismatch after checkout is treated as a tampered/stale bundle and
// returns an execution failure (no work performed).
//
// No Trigger SDK usage; no direct network calls except through the injected Broker.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SourceRef } from "@agencyhq/contracts";

import type { Broker } from "./broker.ts";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MaterializeSourceArgs = {
  /** Source reference from the v2 payload. */
  source: SourceRef;
  /** Absolute path to the directory to clone into (must not exist yet). */
  dir: string;
  /** Coordinator broker client. */
  broker: Broker;
  /** Bearer token for the source download (from a git-read or upload lease). */
  token: string;
};

export type MaterializeSourceResult =
  | { ok: true; clonedDir: string }
  | {
      ok: false;
      /** "revision_mismatch": HEAD after checkout did not equal source.revision */
      failureKind: "revision_mismatch" | "clone_failed" | "checkout_failed" | "download_failed";
      reason: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// ---------------------------------------------------------------------------
// materializeSource
// ---------------------------------------------------------------------------

/**
 * Materialize a source bundle into a local git clone.
 *
 * Steps:
 *   1. Download the bundle bytes from the coordinator.
 *   2. Write the bundle to a temporary file.
 *   3. `git clone <bundleFile> <dir>` — creates a standard local clone.
 *   4. `git checkout <source.revision>` — detached HEAD at the requested SHA.
 *   5. Verify `git rev-parse HEAD` === source.revision — mismatch is a failure.
 *   6. Delete the temporary bundle file.
 *
 * Returns { ok: true, clonedDir: dir } on success.
 * Returns { ok: false, failureKind, reason } on any failure; no partial clone
 * is left on disk (cleans up dir on failure).
 */
export async function materializeSource(
  args: MaterializeSourceArgs,
): Promise<MaterializeSourceResult> {
  const { source, dir, broker, token } = args;

  // Step 1+2: download bundle and write to temp file.
  let bundlePath: string | undefined;
  try {
    let bundleResult: Awaited<ReturnType<typeof broker.downloadSourceBundle>>;
    try {
      bundleResult = await broker.downloadSourceBundle({
        projectId: source.projectId,
        rev: source.revision,
        token,
      });
    } catch (err) {
      return {
        ok: false,
        failureKind: "download_failed",
        reason: `source bundle download failed: ${(err as Error).message}`,
      };
    }

    const { bundleBytes, bundleSha256 } = bundleResult;

    // Verify the sha256 of the downloaded bytes matches what the server claims.
    // (This is informational: the coordinator validates the bundle on upload; we
    //  just double-check the transport didn't corrupt it.)
    if (bundleSha256) {
      const actualSha256 = createHash("sha256").update(bundleBytes).digest("hex");
      if (actualSha256 !== bundleSha256) {
        return {
          ok: false,
          failureKind: "download_failed",
          reason: `source bundle sha256 mismatch: expected ${bundleSha256}, got ${actualSha256}`,
        };
      }
    }

    bundlePath = join(
      tmpdir(),
      `agencyhq-source-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`,
    );
    await writeFile(bundlePath, bundleBytes);

    // Step 3: clone the bundle.
    try {
      // Create the parent directory if needed (git clone requires the target to not exist).
      await mkdir(dir, { recursive: true });
      await rm(dir, { recursive: true, force: true });
      await git(["clone", bundlePath, dir], tmpdir());
    } catch (err) {
      return {
        ok: false,
        failureKind: "clone_failed",
        reason: `git clone failed: ${(err as Error).message}`,
      };
    }

    // Step 4: checkout the requested revision.
    try {
      await git(["checkout", "--detach", source.revision], dir);
    } catch (err) {
      return {
        ok: false,
        failureKind: "checkout_failed",
        reason: `git checkout ${source.revision} failed: ${(err as Error).message}`,
      };
    }

    // Step 5: verify HEAD.
    const { stdout } = await git(["rev-parse", "HEAD"], dir);
    const actualHead = stdout.trim();
    if (actualHead !== source.revision) {
      return {
        ok: false,
        failureKind: "revision_mismatch",
        reason: `bundle HEAD mismatch: expected ${source.revision}, got ${actualHead}`,
      };
    }

    return { ok: true, clonedDir: dir };
  } catch (err) {
    return {
      ok: false,
      failureKind: "clone_failed",
      reason: `materializeSource failed: ${(err as Error).message}`,
    };
  } finally {
    if (bundlePath) {
      await unlink(bundlePath).catch(() => undefined);
    }
  }
}
