/**
 * Runs `trigger deploy --local-build --external-id <hash>` from the trigger/
 * workspace directory, writing a deployment.json record on success.
 *
 * The external ID is the sha256 of every file under trigger/ plus pnpm-lock.yaml
 * and trigger.config.ts (which is already under trigger/). This lets the deploy
 * phase skip when the deployed version already matches the current toolchain.
 *
 * No third-party deps — uses node:crypto, node:fs, node:child_process.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface DeployOptions {
  /** Absolute path to the workspace root (contains trigger/ and pnpm-lock.yaml). */
  workspaceRoot: string;
  /** Absolute path to AGENCYHQ_STATE_DIR (for deployment.json). */
  stateDir: string;
  /** Content of the PAT file (TRIGGER_ACCESS_TOKEN). Never logged. */
  accessToken: string;
  /**
   * Internal webapp URL with resolved IP so the Trigger CLI does not rewrite
   * it to host.docker.internal (set as TRIGGER_API_URL).
   */
  webappIpUrl: string;
  /** Trigger project ref (proj_...), set as TRIGGER_PROJECT_REF. */
  projectRef: string;
  /** Registry URL for the task image push (e.g. http://registry:5000/v2/). */
  registryUrl?: string;
}

export interface DeploymentRecord {
  version?: string;
  externalId: string;
  webappIpUrl: string;
  at: string;
  skipped?: boolean;
}

function gatherFiles(dir: string, root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip .trigger build cache and node_modules
      if (entry.name === ".trigger" || entry.name === "node_modules") continue;
      files.push(...gatherFiles(full, root));
    } else {
      files.push(relative(root, full));
    }
  }
  return files.sort();
}

/**
 * Compute a stable sha256 fingerprint of the trigger/ directory tree,
 * pnpm-lock.yaml, and the root trigger.config.ts (if it exists outside trigger/).
 * Files are sorted for determinism.
 */
export function computeExternalId(workspaceRoot: string): string {
  const triggerDir = join(workspaceRoot, "trigger");
  const lockFile = join(workspaceRoot, "pnpm-lock.yaml");

  const hash = createHash("sha256");

  // Hash all files under trigger/
  const files = gatherFiles(triggerDir, workspaceRoot);
  for (const rel of files) {
    hash.update(`file:${rel}\n`);
    hash.update(readFileSync(join(workspaceRoot, rel)));
    hash.update("\n");
  }

  // Hash pnpm-lock.yaml
  if (existsSync(lockFile)) {
    hash.update("file:pnpm-lock.yaml\n");
    hash.update(readFileSync(lockFile));
    hash.update("\n");
  }

  return hash.digest("hex");
}

function readDeploymentRecord(stateDir: string): DeploymentRecord | null {
  const p = join(stateDir, "deployment.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as DeploymentRecord;
  } catch {
    return null;
  }
}

function writeDeploymentRecord(stateDir: string, record: DeploymentRecord): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "deployment.json"), JSON.stringify(record, null, 2) + "\n", "utf-8");
}

function log(msg: string): void {
  console.log(`[bootstrap:deploy] ${msg}`);
}

/**
 * Run `trigger deploy --local-build --external-id <hash>` from the trigger/
 * workspace. Returns true when the deploy ran (or was skipped), throws on failure.
 *
 * Skips the build when deployment.json already records the same externalId.
 */
export async function runDeploy(opts: DeployOptions): Promise<DeploymentRecord> {
  const { workspaceRoot, stateDir, accessToken, webappIpUrl, projectRef } = opts;
  const triggerDir = join(workspaceRoot, "trigger");

  if (!existsSync(triggerDir)) {
    throw new Error(`trigger directory not found: ${triggerDir}`);
  }

  const externalId = computeExternalId(workspaceRoot);
  log(`external-id: ${externalId.slice(0, 16)}…`);

  // Skip if already deployed with this external-id.
  const existing = readDeploymentRecord(stateDir);
  if (existing?.externalId === externalId && !existing.skipped) {
    log("deployment unchanged (external-id matches); skipping build");
    return { ...existing, skipped: true };
  }

  log("running trigger deploy --local-build");

  const args = ["deploy", "--local-build", "--external-id", externalId];

  /**
   * NOTE (open question): The Trigger.dev docs (read 2026-09-09) do not list a
   * --push or --network flag for `trigger deploy`. The plan references both but
   * they could not be confirmed from the v4.5.16 docs. The --local-build flag
   * handles the local build; registry push behaviour is internal to the CLI.
   * If --network is required for RUN steps to reach the webapp, the operator
   * must configure TRIGGER_DEPLOY_EXTRA_ARGS or use the socat fallback.
   *
   * Extra flags can be injected via TRIGGER_DEPLOY_ARGS env var (space-separated).
   */
  const extraArgs = process.env["TRIGGER_DEPLOY_ARGS"];
  if (extraArgs) {
    args.push(...extraArgs.split(/\s+/).filter(Boolean));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIGGER_ACCESS_TOKEN: accessToken,
    TRIGGER_API_URL: webappIpUrl,
    TRIGGER_PROJECT_REF: projectRef,
  };

  // Ensure the token is never visible in process listing.
  log(`spawning: trigger ${args.filter((a) => a !== accessToken).join(" ")}`);

  const result = spawnSync("trigger", args, {
    cwd: triggerDir,
    env,
    stdio: "inherit",
    encoding: "utf-8",
  });

  if (result.error) {
    throw Object.assign(new Error(`trigger deploy process error: ${result.error.message}`), {
      errorCategory: "deploy_failed",
    });
  }

  if (result.status !== 0) {
    throw Object.assign(
      new Error(
        `trigger deploy exited with code ${result.status}. ` +
          "Check the output above for the exact failure. " +
          "Re-run bootstrap to retry only the deploy phase.",
      ),
      { errorCategory: "deploy_failed" },
    );
  }

  log("trigger deploy succeeded");

  const record: DeploymentRecord = {
    externalId,
    webappIpUrl,
    at: new Date().toISOString(),
  };
  writeDeploymentRecord(stateDir, record);
  return record;
}

/**
 * Try to read the image digest from the local registry API.
 * Returns null when the registry is unreachable or the image is not found.
 * Never throws — this is best-effort enrichment.
 */
export async function fetchImageDigest(registryUrl: string, name: string): Promise<string | null> {
  try {
    const r = await fetch(`${registryUrl}${name}/manifests/latest`, {
      headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
    });
    return r.headers.get("Docker-Content-Digest");
  } catch {
    return null;
  }
}

/** Read deployment.json (may be null if not yet written). */
export function readDeployment(stateDir: string): DeploymentRecord | null {
  return readDeploymentRecord(stateDir);
}

/** Check if trigger binary is present on PATH (sanity check). */
export function triggerBinaryAvailable(): boolean {
  const result = spawnSync("trigger", ["--version"], { stdio: "pipe" });
  return result.status === 0;
}

/** Stat-based helper for tests: list file paths collected by gatherFiles. */
export function listToolchainFiles(workspaceRoot: string): string[] {
  const triggerDir = join(workspaceRoot, "trigger");
  if (!existsSync(triggerDir)) return [];
  return gatherFiles(triggerDir, workspaceRoot);
}

// Re-export statSync for test helpers.
export { statSync };
