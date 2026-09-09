// Artifact bundle export and upload for the container profile (epic #14, P18.3).
//
// exportAttemptBundle: creates a thin git bundle of the worker's commit against
//   the source revision and computes its sha256 and byte length.
//
// uploadAttemptArtifact: calls exportAttemptBundle then uploads via the Broker
//   with proper ArtifactUploadMeta.
//
// No Trigger SDK usage.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ArtifactRef, ArtifactUploadMeta } from "@agencyhq/contracts";
import { bundleRefFor } from "@agencyhq/contracts";

import type { Broker } from "./broker.ts";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024; // small for git bundle output

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportBundleResult = {
  /** Absolute path to the temporary bundle file. Caller must delete. */
  bundlePath: string;
  /** SHA-256 hex of the bundle bytes. */
  bundleSha256: string;
  /** Byte length of the bundle. */
  bundleBytes: number;
};

export type UploadArtifactArgs = {
  /** Absolute path to the materialized clone (worker's working directory). */
  repoPath: string;
  /** The attempt commit SHA produced by the worker. */
  commitId: string;
  /** The source revision (base) SHA — used as the bundle basis. */
  baseRevision: string;
  attemptId: string;
  generation: number;
  kind: "attempt" | "checkpoint";
  changedPaths: string[];
  quarantinePatch?: string | undefined;
  diffDigest: string;
  broker: Broker;
  /** Bearer token from the upload lease grant. */
  token: string;
};

export type UploadArtifactResult = {
  artifactRef: ArtifactRef | null;
  uploadStatus: "uploaded" | "failed" | "skipped";
  failureReason?: string;
};

// ---------------------------------------------------------------------------
// git helper
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// ---------------------------------------------------------------------------
// sha256File
// ---------------------------------------------------------------------------

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
// exportAttemptBundle
// ---------------------------------------------------------------------------

/**
 * Create a thin git bundle of `commitId` against `baseRevision`.
 *
 * The bundle is thin (only objects not reachable from baseRevision), so the
 * coordinator only stores the delta. The coordinator's mirror must already have
 * `baseRevision` (it does, since the source bundle came from it).
 *
 * Returns the bundle path (caller must delete), sha256, and byte count.
 * Throws on any git failure.
 */
export async function exportAttemptBundle(args: {
  repoPath: string;
  commitId: string;
  baseRevision: string;
}): Promise<ExportBundleResult> {
  const bundlePath = join(
    tmpdir(),
    `agencyhq-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`,
  );

  // Use the canonical bundle ref name (D5 / W-7). Both the worker and coordinator
  // must agree on this ref name so that `git fetch <bundle> <ref>:target` resolves.
  // bundleRefFor(sha) → refs/agencyhq/export/<sha>
  const exportRef = bundleRefFor(args.commitId);

  try {
    await git(["update-ref", exportRef, args.commitId], args.repoPath);

    // Thin bundle: exclude objects reachable from baseRevision.
    await git(["bundle", "create", bundlePath, `^${args.baseRevision}`, exportRef], args.repoPath);

    const s = await stat(bundlePath);
    const bundleBytes = s.size;
    const bundleSha256 = await sha256File(bundlePath);

    return { bundlePath, bundleSha256, bundleBytes };
  } catch (err) {
    await unlink(bundlePath).catch(() => undefined);
    throw err;
  } finally {
    // Always delete the temporary ref, even on error.
    await git(["update-ref", "-d", exportRef], args.repoPath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// uploadAttemptArtifact
// ---------------------------------------------------------------------------

/**
 * Export a bundle for the worker's commit and upload it to the coordinator.
 *
 * Returns:
 *   - { uploadStatus: "uploaded", artifactRef } on success.
 *   - { uploadStatus: "skipped" } when commitId is null (no commit was made).
 *   - { uploadStatus: "failed", failureReason } when the export or upload fails.
 *
 * Never throws; errors are captured in failureReason.
 */
export async function uploadAttemptArtifact(
  args: UploadArtifactArgs,
): Promise<UploadArtifactResult> {
  let bundlePath: string | undefined;

  try {
    const exported = await exportAttemptBundle({
      repoPath: args.repoPath,
      commitId: args.commitId,
      baseRevision: args.baseRevision,
    });
    bundlePath = exported.bundlePath;

    const bundleBytes = await readFile(exported.bundlePath);

    const meta: ArtifactUploadMeta = {
      attemptId: args.attemptId,
      generation: args.generation,
      kind: args.kind,
      commitId: args.commitId,
      diffDigest: args.diffDigest,
      changedPaths: args.changedPaths,
      ...(args.quarantinePatch !== undefined && args.quarantinePatch !== ""
        ? { quarantinePatch: args.quarantinePatch }
        : {}),
      bundleSha256: exported.bundleSha256,
      bundleBytes: exported.bundleBytes,
    };

    const uploadFn =
      args.kind === "attempt" ? args.broker.uploadArtifact : args.broker.uploadCheckpoint;

    await uploadFn.call(args.broker, {
      attemptId: args.attemptId,
      token: args.token,
      meta,
      bundleBytes,
    });

    const artifactRef: ArtifactRef = {
      attemptId: args.attemptId,
      generation: args.generation,
      revision: args.commitId,
    };

    return { artifactRef, uploadStatus: "uploaded" };
  } catch (err) {
    return {
      artifactRef: null,
      uploadStatus: "failed",
      failureReason: (err as Error).message,
    };
  } finally {
    if (bundlePath) {
      await unlink(bundlePath).catch(() => undefined);
    }
  }
}
