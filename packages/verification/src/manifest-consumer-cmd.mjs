/**
 * manifest-consumer-cmd.mjs
 *
 * Pre-flight validator and pnpm test runner for the manifest-consumer@1 check.
 *
 * 1. Scans process.env for AGENCYHQ_MANIFEST_<N> variables (N is a decimal integer).
 * 2. Exits 1 with "manifest_missing" if none are set.
 * 3. Exits 1 with "manifest_path_not_found" if any resolved path is not an existing directory.
 * 4. Prints manifest_env evidence lines to stdout (captured by the ring buffer).
 * 5. Spawns "pnpm test" in the current working directory and exits with its exit code.
 *
 * This file is plain JavaScript (ESM); it is spawned directly by node so that
 * TypeScript stripping is not required at runtime.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Collect AGENCYHQ_MANIFEST_N env vars (N = non-negative integer)
// ---------------------------------------------------------------------------

const manifests = [];
for (const [key, value] of Object.entries(process.env)) {
  if (/^AGENCYHQ_MANIFEST_\d+$/.test(key) && typeof value === "string") {
    const position = parseInt(key.slice("AGENCYHQ_MANIFEST_".length), 10);
    manifests.push({ position, key, path: value });
  }
}
manifests.sort((a, b) => a.position - b.position);

// ---------------------------------------------------------------------------
// Guard: at least one manifest must be present
// ---------------------------------------------------------------------------

if (manifests.length === 0) {
  process.stdout.write(
    "manifest_missing: no AGENCYHQ_MANIFEST_N env vars set; " +
      "verify.run must export AGENCYHQ_MANIFEST_<position>=<worktree path> " +
      "when a manifest is present\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Guard: every manifest path must exist as a directory
// ---------------------------------------------------------------------------

for (const { position, path } of manifests) {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    process.stdout.write(
      `manifest_path_not_found: AGENCYHQ_MANIFEST_${position}=${path} is not an existing directory\n`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Record manifest evidence (captured in VerificationResult.stdoutTail)
// ---------------------------------------------------------------------------

for (const { position, path } of manifests) {
  process.stdout.write(`manifest_env: position=${position} path=${path}\n`);
}
const manifestDigest = process.env.AGENCYHQ_MANIFEST_DIGEST;
if (typeof manifestDigest === "string" && manifestDigest.length > 0) {
  process.stdout.write(`manifest_digest: ${manifestDigest}\n`);
}

// ---------------------------------------------------------------------------
// Run pnpm test in the current working directory
// ---------------------------------------------------------------------------

const child = spawn("pnpm", ["test"], {
  cwd: process.cwd(),
  env: process.env,
  // Inherit the node process's file descriptors so runCheck's ring buffer
  // captures pnpm test's output directly.
  stdio: ["ignore", "inherit", "inherit"],
  detached: false,
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    // Re-raise the signal so the parent sees the correct termination reason.
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

child.on("error", (err) => {
  process.stderr.write(`manifest-consumer: spawn error: ${err.message}\n`);
  process.exit(1);
});
