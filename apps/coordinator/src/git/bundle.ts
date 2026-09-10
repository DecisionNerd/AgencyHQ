/**
 * Git bundle export and import for the coordinator artifact store.
 *
 * exportBundle: creates a (optionally thin) bundle from the mirror and
 *               streams it as application/x-git-bundle.
 * importBundle: verifies a bundle's prerequisites are met by the mirror,
 *               fetches the head commit, and asserts SHA equality.
 *
 * Size limit: AGENCYHQ_MAX_BUNDLE_BYTES (default 200 MiB) is enforced
 * before writing to disk.
 *
 * SECURITY INVARIANTS:
 *  - Bundle files are always written to a temporary directory and deleted
 *    after use (or on error).
 *  - Path traversal is never introduced into git ref names.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { MirrorRef } from "./mirror.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BUNDLE_BYTES = 200 * 1024 * 1024; // 200 MiB

/**
 * Ref namespace used for temporary export refs created in the mirror.
 * Bundles include this ref so that `git fetch bundle <ref>:target` resolves
 * even when the SHA has no other named ref in the mirror.
 */
const EXPORT_REF_PREFIX = "refs/agencyhq/export/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const mergedEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env };
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: mergedEnv,
    maxBuffer: 512 * 1024, // git bundle output is small
  });
  return stdout;
}

/** Compute sha256 hex over the contents of a file. */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(filePath);
    rs.on("error", reject);
    rs.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) hash.update(chunk);
    });
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

// ---------------------------------------------------------------------------
// exportBundle
// ---------------------------------------------------------------------------

export interface ExportBundleResult {
  /** Absolute path to the temporary bundle file. Caller must delete. */
  bundlePath: string;
  /** SHA-256 hex of the bundle file bytes. */
  bundleSha256: string;
  /** Byte length of the bundle file. */
  bundleBytes: number;
}

/**
 * Export a bundle from the mirror for the given revision.
 *
 * When `basis` is provided, a thin bundle is created (containing only objects
 * not reachable from `basis`). The receiving end must have `basis` in order to
 * apply it.
 *
 * Size limit: enforced after creation; throws if exceeded.
 *
 * Returns the path to the temporary file (caller must stream and then delete).
 *
 * Implementation note: git bundle create refuses to bundle a bare commit SHA
 * because it requires a named ref.  We create a temporary ref
 * `refs/agencyhq/export/<sha>` in the mirror, bundle that ref (thin against
 * `^<basis>` when provided), and delete the temp ref in a finally block.
 * importBundle uses the same ref name when fetching from the bundle.
 */
export async function exportBundle(
  mirror: MirrorRef,
  revision: string,
  basis?: string | undefined,
  maxBundleBytes: number = DEFAULT_MAX_BUNDLE_BYTES,
): Promise<ExportBundleResult> {
  const bundlePath = join(
    tmpdir(),
    `agencyhq-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`,
  );

  // Create a temp ref so git bundle can resolve the revision.
  const tempRef = `${EXPORT_REF_PREFIX}${revision}`;
  await git(["update-ref", tempRef, revision], mirror.mirrorPath);

  try {
    const args = basis
      ? ["bundle", "create", bundlePath, `^${basis}`, tempRef]
      : ["bundle", "create", bundlePath, tempRef];

    await git(args, mirror.mirrorPath);

    const s = await stat(bundlePath);
    const bundleBytes = s.size;
    if (bundleBytes > maxBundleBytes) {
      throw Object.assign(new Error(`Bundle size ${bundleBytes} exceeds limit ${maxBundleBytes}`), {
        code: "BUNDLE_TOO_LARGE",
        bundleBytes,
        maxBundleBytes,
      });
    }

    const bundleSha256 = await sha256File(bundlePath);
    return { bundlePath, bundleSha256, bundleBytes };
  } catch (err) {
    await unlink(bundlePath).catch(() => undefined);
    throw err;
  } finally {
    // Always delete the temp ref, even on error.
    await git(["update-ref", "-d", tempRef], mirror.mirrorPath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// importBundle
// ---------------------------------------------------------------------------

export interface ImportBundleOpts {
  /** The attempt ID — used to construct the ref name. */
  attemptId: string;
  /** The generation number — used to construct the ref name. */
  generation: number;
  /** The artifact kind — used to construct the ref name (X2-8). */
  kind: "attempt" | "checkpoint";
  /** The expected head commit SHA (40-hex). */
  expectedHead: string;
  /** Max allowed bundle bytes (defaults to 200 MiB). */
  maxBundleBytes?: number | undefined;
}

export interface ImportBundleResult {
  /** The resolved head SHA after import (equals expectedHead on success). */
  headSha: string;
  /** SHA-256 hex of the bundle bytes. */
  bundleSha256: string;
  /** Byte length of the bundle bytes. */
  bundleBytes: number;
}

/**
 * Import a bundle into the mirror.
 *
 * Steps:
 * 1. Write the incoming bytes to a temporary file.
 * 2. Check size limit.
 * 3. `git bundle verify` — prerequisites must already be in the mirror.
 * 4. `git fetch <bundlePath> refs/agencyhq/export/<sha>:refs/agencyhq/attempts/<id>/g<gen>`
 * 5. `git rev-parse refs/agencyhq/attempts/<id>/g<gen>` — assert equals expectedHead.
 *
 * The bundle is expected to have been created by exportBundle (or worker-side
 * tooling that uses the same `refs/agencyhq/export/<sha>` naming convention).
 *
 * On any failure: deletes the temp file and throws (no state change in mirror
 * beyond the failed verify/fetch).
 */
export async function importBundle(
  mirror: MirrorRef,
  bundleBytes: AsyncIterable<Buffer> | Buffer,
  opts: ImportBundleOpts,
): Promise<ImportBundleResult> {
  const maxBundleBytes = opts.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const tmpPath = join(
    tmpdir(),
    `agencyhq-import-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`,
  );

  let totalBytes = 0;
  try {
    // Write bytes to temp file, enforcing size limit
    if (Buffer.isBuffer(bundleBytes)) {
      totalBytes = bundleBytes.length;
      if (totalBytes > maxBundleBytes) {
        throw Object.assign(
          new Error(`Bundle size ${totalBytes} exceeds limit ${maxBundleBytes}`),
          { code: "BUNDLE_TOO_LARGE", bundleBytes: totalBytes, maxBundleBytes },
        );
      }
      await writeFile(tmpPath, bundleBytes);
    } else {
      // Stream it
      const ws = createWriteStream(tmpPath);
      for await (const chunk of bundleBytes) {
        totalBytes += chunk.length;
        if (totalBytes > maxBundleBytes) {
          ws.destroy();
          throw Object.assign(new Error(`Bundle size exceeds limit ${maxBundleBytes}`), {
            code: "BUNDLE_TOO_LARGE",
            bundleBytes: totalBytes,
            maxBundleBytes,
          });
        }
        ws.write(chunk);
      }
      await new Promise<void>((resolve, reject) => {
        ws.on("finish", resolve);
        ws.on("error", reject);
        ws.end();
      });
    }

    const bundleSha256 = await sha256File(tmpPath);

    // Verify prerequisites exist in the mirror
    try {
      await git(["bundle", "verify", tmpPath], mirror.mirrorPath);
    } catch (err) {
      throw Object.assign(
        new Error("Bundle prerequisites not met in mirror (tampered or missing basis)"),
        { code: "BUNDLE_PREREQ_MISSING", cause: err },
      );
    }

    // Fetch head commit into a named ref.
    // The bundle was created with refs/agencyhq/export/<sha>, so we fetch that ref.
    const exportRef = `${EXPORT_REF_PREFIX}${opts.expectedHead}`;
    // X2-8: ref name includes kind so attempt and checkpoint refs are distinct.
    const targetRef = `refs/agencyhq/attempts/${opts.attemptId}/g${opts.generation}/${opts.kind}`;
    try {
      await git(["fetch", tmpPath, `${exportRef}:${targetRef}`], mirror.mirrorPath);
    } catch (err) {
      throw Object.assign(
        new Error(`Bundle fetch failed: commit ${opts.expectedHead} not in bundle`),
        { code: "BUNDLE_FETCH_FAILED", cause: err },
      );
    }

    // Verify the resolved SHA matches expectedHead
    const resolvedOut = await git(["rev-parse", "--verify", targetRef], mirror.mirrorPath);
    const resolvedSha = resolvedOut.trim();
    if (resolvedSha !== opts.expectedHead) {
      throw Object.assign(
        new Error(`Bundle head mismatch: expected ${opts.expectedHead}, got ${resolvedSha}`),
        { code: "BUNDLE_SHA_MISMATCH" },
      );
    }

    return { headSha: resolvedSha, bundleSha256, bundleBytes: totalBytes };
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}
