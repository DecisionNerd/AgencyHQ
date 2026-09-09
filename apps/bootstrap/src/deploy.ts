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

import { spawn, spawnSync } from "node:child_process";
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
  /** Target platform (e.g. linux/arm64). Written to deployment.json. */
  platform: string;
  /** Registry URL for the task image push (e.g. http://registry:5000/v2/). */
  registryUrl?: string;
}

export interface DeploymentRecord {
  /** Version from the Trigger API (enriched after verify phase). */
  version?: string;
  /** Image reference (enriched after verify phase). */
  imageRef?: string;
  /** Digest from the registry (enriched after verify phase). */
  digest?: string;
  /** External ID: sha256 fingerprint of trigger/ tree + lockfile. */
  externalId: string;
  /** Resolved webapp IP URL used at deploy time. */
  webappIpUrl: string;
  /** Target platform (e.g. linux/arm64). */
  platform: string;
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
/**
 * Resolve the `trigger` CLI binary path.
 * Prefers the trigger package's own .bin (trigger/node_modules/.bin/trigger),
 * falls back to the workspace-root hoisted binary (node_modules/.bin/trigger),
 * then falls back to PATH.
 */
function resolveTriggerBin(workspaceRoot: string): string {
  const triggerPkg = join(workspaceRoot, "trigger", "node_modules", ".bin", "trigger");
  const hoisted = join(workspaceRoot, "node_modules", ".bin", "trigger");
  if (existsSync(triggerPkg)) return triggerPkg;
  if (existsSync(hoisted)) return hoisted;
  return "trigger"; // fallback to PATH
}

/** Failure categories the deploy phase can surface (readiness shows them verbatim). */
export type DeployFailureCategory = "deploy_failed" | "deploy_in_progress";

/**
 * Classify a failed `trigger deploy` from the tail of its output. The webapp
 * rejects a deploy whose external id is already BUILDING with "A deployment for
 * external id … is already in progress" (trigger.dev v4.5.16, read 2026-09-09).
 */
export function classifyDeployFailure(outputTail: string): DeployFailureCategory {
  return /is already in progress/.test(outputTail) ? "deploy_in_progress" : "deploy_failed";
}

/** Bytes of CLI output kept for failure classification (never persisted). */
const OUTPUT_TAIL_BYTES = 16 * 1024;

/**
 * Run the Trigger CLI, streaming its output to this process (so `docker logs`
 * shows progress) while keeping the last OUTPUT_TAIL_BYTES for classification.
 * Resolves with the exit status; a spawn error surfaces as status null.
 */
export function runTriggerCli(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; tail: string }> {
  return new Promise((resolve) => {
    let tail = "";
    const keep = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
      sink.write(chunk);
      tail = (tail + chunk.toString("utf-8")).slice(-OUTPUT_TAIL_BYTES);
    };
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => keep(c, process.stdout));
    child.stderr.on("data", (c: Buffer) => keep(c, process.stderr));
    child.on("error", (err) => {
      tail = `${tail}\ntrigger deploy process error: ${err.message}`;
      resolve({ status: null, tail });
    });
    child.on("close", (status) => resolve({ status, tail }));
  });
}

/** Name of the buildx builder the Trigger CLI uses by default (`--builder`). */
const BUILDER_NAME = "trigger";
/** Docker's embedded DNS resolver, reachable from containers on user-defined networks. */
const EMBEDDED_DNS = "127.0.0.11";

function docker(args: string[], dockerConfigDir: string): { status: number | null; out: string } {
  const r = spawnSync("docker", args, {
    encoding: "utf-8",
    env: { ...process.env, DOCKER_CONFIG: dockerConfigDir },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Prepare the buildx builder the CLI will use.
 *
 * `trigger deploy --local-build` creates a `docker-container` builder named
 * `trigger` when none exists (deploy/buildImage.js, 4.5.16). The Containerfile
 * it builds runs the task indexer as a RUN step, and that step must reach the
 * webapp at the advertised API origin (`http://webapp:3000`). A builder on the
 * daemon's host network resolves no Docker service names (observed 2026-09-09:
 * "Failed to fetch environment variables: Connection error." at Containerfile
 * line 75), so the builder is created here, attached to the Docker network the
 * webapp is on. BuildKit still rewrites the sandbox's resolv.conf to public
 * nameservers (it drops loopback entries such as Docker's embedded DNS at
 * 127.0.0.11; observed 2026-09-09), so a buildkitd config pins the embedded DNS
 * as the sandbox nameserver; RUN steps then resolve service names and reach the
 * internet through it.
 *
 * The Docker CLI writes buildx state under $DOCKER_CONFIG (default
 * $HOME/.docker); HOME is /app in the image, which the runtime user cannot
 * write to, so the state lives under the writable state directory.
 */
export function ensureBuilder(dockerConfigDir: string, network: string): void {
  const configPath = join(dockerConfigDir, "buildkitd.toml");
  const config = `[dns]\n  nameservers = ["${EMBEDDED_DNS}"]\n`;
  // Marker of the configuration the existing builder was created with; buildx
  // inspect reports the driver options but not the daemon config file.
  const markerPath = join(dockerConfigDir, "builder.marker");
  const marker = `${BUILDER_NAME} network=${network} dns=${EMBEDDED_DNS}`;

  const inspect = docker(["buildx", "inspect", BUILDER_NAME], dockerConfigDir);
  const existingMarker = existsSync(markerPath) ? readFileSync(markerPath, "utf-8") : "";
  if (
    inspect.status === 0 &&
    inspect.out.includes(`network="${network}"`) &&
    existingMarker === marker
  ) {
    log(`buildx builder '${BUILDER_NAME}' present on network ${network}`);
    return;
  }
  if (inspect.status === 0) {
    log(`buildx builder '${BUILDER_NAME}' exists with a different configuration; recreating`);
    docker(["buildx", "rm", "--force", BUILDER_NAME], dockerConfigDir);
  }
  writeFileSync(configPath, config, "utf-8");
  const create = docker(
    [
      "buildx",
      "create",
      "--name",
      BUILDER_NAME,
      "--driver",
      "docker-container",
      `--driver-opt=network=${network}`,
      "--buildkitd-config",
      configPath,
    ],
    dockerConfigDir,
  );
  if (create.status !== 0) {
    throw new Error(`failed to create buildx builder '${BUILDER_NAME}': ${create.out.trim()}`);
  }
  writeFileSync(markerPath, marker, "utf-8");
  log(`buildx builder '${BUILDER_NAME}' created on network ${network}`);
}

/**
 * True when deployment.json records a deployment of the current toolchain
 * (same external id as the workspace hashes to). A changed trigger/ tree or
 * lockfile yields a new external id, so a restart redeploys even though the
 * deploy phase was completed once (observed 2026-09-09: a bootstrap rerun
 * skipped the deploy phase after a toolchain change).
 */
export function deploymentIsCurrent(workspaceRoot: string, stateDir: string): boolean {
  const existing = readDeploymentRecord(stateDir);
  return existing !== null && existing.externalId === computeExternalId(workspaceRoot);
}

export async function runDeploy(opts: DeployOptions): Promise<DeploymentRecord> {
  const { workspaceRoot, stateDir, accessToken, webappIpUrl, projectRef, platform } = opts;
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

  const dockerConfigDir = process.env["DOCKER_CONFIG"] ?? join(stateDir, "docker");
  mkdirSync(dockerConfigDir, { recursive: true });
  ensureBuilder(dockerConfigDir, process.env["AGENCYHQ_BUILD_NETWORK"] ?? "webapp");

  log("running trigger deploy --local-build");

  const args = [
    "deploy",
    "--env",
    "prod",
    "--local-build",
    "--external-id",
    externalId,
    "--skip-update-check",
    // No --network flag: the CLI would then require a builder created with
    // `network=<mode>` and recreate ours. The builder prepared by ensureBuilder()
    // sits on the webapp Docker network instead (see there).
  ];

  /**
   * Flags confirmed from the trigger.dev 4.5.16 CLI source (commands/deploy.js,
   * read 2026-09-09): `--local-build`, hidden `--builder <name>`, hidden
   * `--network <default|none|host>`, hidden `--push/--no-push`. An image tagged
   * for a localhost registry is loaded into the daemon (`--output type=docker`)
   * and not pushed unless `--push` is given (deploy/buildImage.js shouldPush).
   *
   * Extra flags can be injected via TRIGGER_DEPLOY_ARGS env var (space-separated).
   */
  const extraArgs = process.env["TRIGGER_DEPLOY_ARGS"];
  if (extraArgs) {
    args.push(...extraArgs.split(/\s+/).filter(Boolean));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerConfigDir,
    TRIGGER_ACCESS_TOKEN: accessToken,
    TRIGGER_API_URL: webappIpUrl,
    TRIGGER_PROJECT_REF: projectRef,
  };

  const triggerBin = resolveTriggerBin(workspaceRoot);
  // Ensure the token is never visible in process listing.
  log(`spawning: ${triggerBin} ${args.filter((a) => a !== accessToken).join(" ")}`);

  let result = await runTriggerCli(triggerBin, args, triggerDir, env);

  if (result.status !== 0 && classifyDeployFailure(result.tail) === "deploy_in_progress") {
    // An earlier build of this exact toolchain was interrupted (container killed
    // or restarted mid-build); the webapp keeps that deployment BUILDING until
    // its DEPLOY_TIMEOUT_MS (default 8 min) and rejects a new one for the same
    // external id. The bootstrap is the only deployer of this project, so the
    // stale build is ours: cancel it and build again (observed 2026-09-09).
    log(
      "the webapp still marks an interrupted build of this toolchain in progress; retrying with --force",
    );
    result = await runTriggerCli(triggerBin, [...args, "--force"], triggerDir, env);
  }

  if (result.status !== 0) {
    const category = classifyDeployFailure(result.tail);
    const hint =
      category === "deploy_in_progress"
        ? "The webapp still reports a build of this toolchain in progress; it times out after DEPLOY_TIMEOUT_MS (default 8 min), after which the bootstrap retry succeeds. "
        : "Check the output above for the exact failure. ";
    throw Object.assign(
      new Error(
        `trigger deploy exited with code ${result.status}. ${hint}` +
          "Re-run bootstrap to retry only the deploy phase.",
      ),
      { errorCategory: category },
    );
  }

  log("trigger deploy succeeded");

  const record: DeploymentRecord = {
    externalId,
    webappIpUrl,
    platform,
    at: new Date().toISOString(),
  };
  writeDeploymentRecord(stateDir, record);
  return record;
}

/**
 * Enrich an existing deployment.json with version/imageRef/externalId from
 * the verify phase. Never throws — enrichment is best-effort.
 */
export function enrichDeployment(
  stateDir: string,
  fields: { version?: string; imageRef?: string; externalId?: string },
): void {
  try {
    const existing = readDeploymentRecord(stateDir);
    if (!existing) return;
    const enriched: DeploymentRecord = {
      ...existing,
      ...(fields.version !== undefined ? { version: fields.version } : {}),
      ...(fields.imageRef !== undefined ? { imageRef: fields.imageRef } : {}),
      ...(fields.externalId !== undefined ? { externalId: fields.externalId } : {}),
    };
    writeDeploymentRecord(stateDir, enriched);
  } catch {
    // Enrichment failure is non-fatal; the coordinator will re-probe the API.
  }
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

/**
 * Check if trigger binary is present (sanity check).
 * @param workspaceRoot Optional: resolve from workspace first.
 */
export function triggerBinaryAvailable(workspaceRoot?: string): boolean {
  const bin = workspaceRoot ? resolveTriggerBin(workspaceRoot) : "trigger";
  const result = spawnSync(bin, ["--version"], { stdio: "pipe" });
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
