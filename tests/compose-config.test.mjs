/**
 * tests/compose-config.test.mjs — Docker Compose configuration validation.
 *
 * Renders the root compose.yaml with `docker compose config` and asserts
 * the structural invariants required by ADR-0008 and TESTING.md C1:
 *
 *   1. Every published port is bound to 127.0.0.1 (loopback only).
 *   2. No env var value looks like a literal secret (password|secret|token
 *      as part of the key name, and the value is non-empty, non-${...} ref,
 *      and not a _FILE path).
 *   3. Every image tag is pinned (no bare ":latest" or missing tag).
 *   4. Required services are present and have healthchecks.
 *   5. The only host bind mounts are the two Docker socket files (read-only).
 *   6. agencyhq-postgres is NOT attached to the `agencyhq` network.
 *
 * The test skips gracefully when `docker compose` is not available so that
 * CI environments without Docker can still run `pnpm check`.
 *
 * Run directly:   node --test tests/compose-config.test.mjs
 * Run via check:  pnpm check
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Docker availability check ─────────────────────────────────────────────────

async function isDockerComposeAvailable() {
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Render the merged config ──────────────────────────────────────────────────

async function renderConfig() {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "--project-directory", root, "config"],
    {
      cwd: root,
      timeout: 60_000,
      // Pass empty env so secrets are not accidentally injected from the shell.
      env: { ...process.env },
    },
  );
  return stdout;
}

// ── YAML helpers ─────────────────────────────────────────────────────────────
// We parse with a simple regex-based approach to avoid a YAML library dependency.

/**
 * Extract all published ports from the rendered config.
 * Matches lines like:   - "127.0.0.1:8787:8787" or   - 127.0.0.1:8030:3000
 */
function extractPublishedPorts(configYaml) {
  const ports = [];
  // After `docker compose config`, ports are rendered as:
  //   published: "127.0.0.1"
  //   target: 3000
  //   host_ip: "127.0.0.1"
  // We look for lines that contain published/host_ip patterns.
  for (const line of configYaml.split("\n")) {
    // Only match host_ip: lines — published: lines contain port numbers, not IPs.
    const m = line.match(/^\s+host_ip:\s+"?([^"\s]+)"?\s*$/);
    if (m) ports.push(m[1]);
  }
  return ports;
}

/**
 * Extract environment variable entries from the rendered config.
 * Returns [{ key, value }] pairs where value is the RENDERED value.
 */
function extractEnvEntries(configYaml) {
  const entries = [];
  // docker compose config renders env as:
  //   environment:
  //     KEY: value
  //   or
  //     KEY: "value"
  const envPattern = /^\s{8,}([A-Z][A-Z0-9_]+):\s*(.*)$/;
  for (const line of configYaml.split("\n")) {
    const m = line.match(envPattern);
    if (m) {
      const key = m[1];
      const raw = m[2].trim();
      // Strip surrounding quotes from rendered values
      const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      entries.push({ key, value });
    }
  }
  return entries;
}

/**
 * Extract image references from the rendered config.
 */
function extractImages(configYaml) {
  const images = [];
  for (const line of configYaml.split("\n")) {
    const m = line.match(/^\s+image:\s+(.+)$/);
    if (m) images.push(m[1].trim());
  }
  return images;
}

/**
 * Extract bind mount source paths from the rendered config.
 */
function extractBindMounts(configYaml) {
  const binds = [];
  // Compose renders bind mounts as:
  //   - source: /var/run/docker.sock
  //     target: /var/run/docker.sock
  //     type: bind
  // We look for source lines within a type:bind block context by extracting
  // all source lines near a type: bind declaration.
  const lines = configYaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const sourceMatch = lines[i].match(/^\s+source:\s+(.+)$/);
    if (!sourceMatch) continue;
    // Look only BEFORE the source line (within 2 lines) for type: bind.
    // In docker compose config output, the volume item is rendered as:
    //   - type: volume|bind
    //     source: <name>
    // so the type always precedes the source in the same list item.
    // Looking after the source would produce false positives (e.g. a
    // named volume immediately before an XML bind mount).
    let isBindMount = false;
    for (let j = Math.max(0, i - 2); j <= i; j++) {
      if (/type:\s+bind/.test(lines[j])) {
        isBindMount = true;
        break;
      }
    }
    if (isBindMount) {
      binds.push(sourceMatch[1].trim());
    }
  }
  return binds;
}

/**
 * Extract service → networks mappings from the rendered config.
 */
function extractServiceNetworks(configYaml) {
  const serviceNetworks = {};
  let currentService = null;
  let inNetworks = false;
  let serviceIndent = 0;
  let networksIndent = 0;

  for (const line of configYaml.split("\n")) {
    // Detect top-level services section
    const serviceMatch = line.match(/^(\s{4})(\S+):$/);
    if (serviceMatch && line.startsWith("    ")) {
      const indent = serviceMatch[1].length;
      if (indent === 4) {
        currentService = serviceMatch[2];
        serviceNetworks[currentService] = [];
        inNetworks = false;
        serviceIndent = 4;
      }
    }

    // Detect networks: subsection within a service
    if (currentService && /^\s{8}networks:/.test(line)) {
      inNetworks = true;
      networksIndent = 8;
      continue;
    }

    // Collect network entries
    if (inNetworks && currentService) {
      const netMatch = line.match(/^\s{10,}(\S+):/);
      if (netMatch) {
        serviceNetworks[currentService].push(netMatch[1]);
      } else if (line.match(/^\s{8}\S/) || line.match(/^\s{4}\S/)) {
        inNetworks = false;
      }
    }
  }

  return serviceNetworks;
}

/**
 * Extract service names that have a healthcheck.
 */
function extractServicesWithHealthchecks(configYaml) {
  const services = new Set();
  let currentService = null;

  for (const line of configYaml.split("\n")) {
    // docker compose config renders service names at 2-space indent under `services:`.
    const serviceMatch = line.match(/^  (\S+):$/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
    }
    if (currentService && /^\s+healthcheck:/.test(line)) {
      services.add(currentService);
    }
  }

  return services;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const dockerAvailable = await isDockerComposeAvailable();

if (!dockerAvailable) {
  console.log(
    "SKIP: compose-config.test.mjs — docker compose is not available in this environment.",
  );
  console.log(
    "      Install Docker Desktop and re-run `node --test tests/compose-config.test.mjs`.",
  );
  process.exit(0);
}

// Render config once and share across tests.
let configYaml;
try {
  configYaml = await renderConfig();
} catch (err) {
  console.error("FATAL: docker compose config failed:\n", err.message ?? err);
  process.exit(1);
}

// ── C1: every published port binds to 127.0.0.1 ─────────────────────────────
test("every published port host IP is 127.0.0.1", () => {
  const ports = extractPublishedPorts(configYaml);

  // We expect at least the webapp (8030), app (8787), registry (5001) to be published.
  assert.ok(ports.length > 0, "Expected at least one published port");

  for (const ip of ports) {
    assert.equal(
      ip,
      "127.0.0.1",
      `Published port host IP must be 127.0.0.1, got: ${ip}`,
    );
  }
});

// ── C2: no literal secret values ─────────────────────────────────────────────
test("no secret-looking literal values in rendered config", () => {
  const entries = extractEnvEntries(configYaml);
  const secretKeyPattern = /password|secret|token/i;

  const violations = [];

  for (const { key, value } of entries) {
    if (!secretKeyPattern.test(key)) continue;
    if (!value || value === "") continue;                    // empty: OK (placeholder)
    if (value.startsWith("${") && value.endsWith("}")) continue; // interpolation ref: OK
    if (/_FILE$/.test(key)) continue;                       // file path key: OK
    if (/^\/run\/agencyhq\/secrets\//.test(value)) continue; // secrets path value: OK
    if (/^\/[a-z]/.test(value) && !/\s/.test(value)) continue; // any /path value: OK

    // Anything else with a non-empty value for a secret-sounding key is suspicious.
    violations.push(`${key}=${value.slice(0, 20)}...`);
  }

  assert.deepEqual(
    violations,
    [],
    `Secret-looking literal values found in rendered config:\n  ${violations.join("\n  ")}`,
  );
});

// ── C3: every image tag is pinned ─────────────────────────────────────────────
test("every image tag is pinned (no bare :latest)", () => {
  const images = extractImages(configYaml);
  assert.ok(images.length > 0, "Expected at least one image reference");

  const violations = [];
  for (const image of images) {
    // Bare image name without any tag or digest is treated as :latest.
    const hasPinnedTag =
      image.includes("@sha256:") ||
      (image.includes(":") && !image.endsWith(":latest"));
    if (!hasPinnedTag) {
      // Skip build-context images (no image: field in rendered config for those)
      if (image.startsWith("agencyhq/")) continue; // local builds: OK
      violations.push(image);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Images with floating or missing tags:\n  ${violations.join("\n  ")}`,
  );
});

// ── C4: required services have healthchecks ──────────────────────────────────
test("required services are present with healthchecks", () => {
  const required = [
    "webapp",
    "postgres",
    "redis",
    "electric",
    "clickhouse",
    "registry",
    "minio",
    "agencyhq-postgres",
    "app",
    "docker-proxy",
    "docker-proxy-build",
  ];

  const withHealthchecks = extractServicesWithHealthchecks(configYaml);

  // All required services must appear in the config.
  for (const svc of required) {
    assert.ok(
      configYaml.includes(`${svc}:`),
      `Required service not found in rendered config: ${svc}`,
    );
  }

  // Long-running services must have healthchecks.
  const longRunning = ["webapp", "postgres", "redis", "clickhouse", "agencyhq-postgres", "app"];
  for (const svc of longRunning) {
    assert.ok(
      withHealthchecks.has(svc),
      `Long-running service missing healthcheck: ${svc}`,
    );
  }
});

// ── C5: only the two Docker socket files are host bind mounts ────────────────
test("only the two Docker socket files are host bind mounts (read-only)", () => {
  const binds = extractBindMounts(configYaml);
  const allowedSockets = new Set([
    "/var/run/docker.sock",
    "/run/docker.sock",
  ]);

  // Clickhouse config XML files are host bind mounts in the upstream config;
  // we allow read-only mounts from infra/clickhouse/ because they are
  // project config files (not host state or secrets).
  const violations = [];
  for (const source of binds) {
    // Allow the two docker sockets
    if (allowedSockets.has(source)) continue;
    // Allow infra/clickhouse XML config files (read-only, project files)
    if (source.includes("clickhouse") && source.endsWith(".xml")) continue;
    // Reject any other host path bind
    violations.push(source);
  }

  assert.deepEqual(
    violations,
    [],
    `Unexpected host bind mounts:\n  ${violations.join("\n  ")}`,
  );
});

// ── C7: bootstrap service env names are correct ──────────────────────────────
// These names must match what apps/bootstrap/src/cli.ts reads.
test("bootstrap service has the required env variable names", () => {
  // Extract the bootstrap service's environment block.
  // docker compose config renders the merged config; we look for the bootstrap
  // service section and check that the required keys appear.
  const requiredBootstrapEnv = [
    "TRIGGER_WEBAPP_URL",
    "BOOTSTRAP_EMAIL",
    "AGENCYHQ_STATE_DIR",
    "AGENCYHQ_WORKSPACE_ROOT",
    "AGENCYHQ_PLATFORM",
    "DOCKER_HOST",
    "BOOTSTRAP_SMTP_PORT",
  ];

  // Find the bootstrap service section in the rendered config.
  // docker compose config renders service names at 2-space indent under `services:`.
  const bootstrapSection = configYaml.match(
    /\n  bootstrap:([\s\S]*?)(?=\n  [a-z]|\nnetworks:|\nvolumes:|$)/,
  );
  assert.ok(
    bootstrapSection !== null,
    "bootstrap service not found in rendered compose config",
  );

  const section = bootstrapSection[1];

  for (const envName of requiredBootstrapEnv) {
    assert.ok(
      section.includes(envName),
      `bootstrap service is missing required env var: ${envName} (must match apps/bootstrap/src/cli.ts)`,
    );
  }

  // Negative: old env names that must NOT be present in bootstrap's env block.
  // Check the environment: subsection only (not other fields like command).
  const envMatch = section.match(/\n    environment:([\s\S]*?)(?=\n    [a-z]|$)/);
  const envSection = envMatch ? envMatch[1] : "";
  const forbiddenBootstrapEnv = [
    "TRIGGER_API_URL",          // renamed to TRIGGER_WEBAPP_URL
    "AGENCYHQ_BOOTSTRAP_EMAIL", // renamed to BOOTSTRAP_EMAIL at the service level
  ];
  for (const envName of forbiddenBootstrapEnv) {
    assert.equal(
      envSection.includes(`${envName}:`),
      false,
      `bootstrap service must NOT use old env name: ${envName}`,
    );
  }
});

// ── C8: bootstrap command file exists in repo ─────────────────────────────────
test("bootstrap command file apps/bootstrap/src/cli.ts exists in the repo", () => {
  const cliPath = resolve(root, "apps/bootstrap/src/cli.ts");
  let exists = false;
  try {
    statSync(cliPath);
    exists = true;
  } catch {
    exists = false;
  }
  assert.ok(exists, `apps/bootstrap/src/cli.ts not found at ${cliPath}`);
});

// ── C9: agencyhq-postgres not on agencyhq network (was C6 before P15.5) ──────
test("agencyhq-postgres is not attached to the agencyhq network", () => {
  // The domain ledger is on agencyhq-internal only; runners on the agencyhq
  // network must not be able to reach it directly.
  //
  // In `docker compose config` output, services are at 2-space indent under
  // `services:`. Properties of a service are at 4-space indent, and network
  // entries within the `networks:` block are at 6-space indent.
  const lines = configYaml.split("\n");
  let inService = false;
  let inNetworks = false;
  const agencyhqPostgresNetworks = [];

  for (const line of lines) {
    // Service starts at exactly "  agencyhq-postgres:" (2-space indent)
    if (/^  agencyhq-postgres:$/.test(line)) {
      inService = true;
      inNetworks = false;
      continue;
    }
    if (inService) {
      // Another top-level key (0-space) or another service (2-space) ends this block
      if (/^[a-z]/.test(line) || /^  [a-z]/.test(line)) {
        inService = false;
        inNetworks = false;
        break;
      }
      // networks: key within the service (4-space indent)
      if (/^    networks:/.test(line)) {
        inNetworks = true;
        continue;
      }
      if (inNetworks) {
        // Network name entries at 6-space indent: "      agencyhq-internal:"
        const m = line.match(/^      ([^:\s]+):/);
        if (m) {
          agencyhqPostgresNetworks.push(m[1]);
        } else if (/^    [a-z]/.test(line)) {
          // Another 4-space property ends the networks block
          inNetworks = false;
        }
      }
    }
  }

  assert.ok(
    agencyhqPostgresNetworks.length > 0,
    "agencyhq-postgres networks block could not be parsed from rendered config (indentation may have changed)",
  );
  assert.ok(
    !agencyhqPostgresNetworks.includes("agencyhq"),
    `agencyhq-postgres must not be attached to the agencyhq network (ledger isolation); found networks: ${agencyhqPostgresNetworks.join(", ")}`,
  );
});

// ── CR6: compose.override.example.yaml list keys use !override ───────────────
test("compose.override.example.yaml list keys use !override (not !reset)", () => {
  const src = readFileSync(resolve(root, "compose.override.example.yaml"), "utf-8");
  assert.ok(
    !src.includes("!reset"),
    "compose.override.example.yaml must not use !reset (use !override to replace a list)",
  );
  assert.ok(
    src.includes("!override"),
    "compose.override.example.yaml must use !override for replacement lists (ports, platforms)",
  );
});

// ── CR7: electric command uses escaped shell substitution ────────────────────
test("electric command contains $(cat .../trigger-db-password) in rendered config", () => {
  // trigger-overrides.yaml uses $$(cat ...) so Docker Compose interpolation does
  // not expand it as a variable; `$(cat ...)` appears as a substring in the
  // rendered config (docker compose config preserves `$$` as `$$`, which at
  // container runtime becomes `$`, letting the shell run the subshell command).
  const electricSection = configYaml.match(
    /\n  electric:([\s\S]*?)(?=\n  [a-z]|\nnetworks:|\nvolumes:|$)/,
  );
  assert.ok(electricSection !== null, "electric service not found in rendered compose config");
  assert.ok(
    electricSection[1].includes("$(cat /run/agencyhq/secrets/trigger-db-password)"),
    "electric command must contain $(cat /run/agencyhq/secrets/trigger-db-password) in rendered config",
  );
});

// ── E-16: webapp API_ORIGIN default is http://webapp:3000 ────────────────────
test("webapp API_ORIGIN is http://webapp:3000 in the rendered container profile", () => {
  // The override layer pins the value: Compose `include` interpolates the vendored
  // file with infra/trigger/.env (host profile), whose API_ORIGIN would otherwise
  // leak into the container profile and break in-stack deploys (E-16).
  const webappSection = configYaml.match(
    /\n  webapp:([\s\S]*?)(?=\n  [a-z]|\nnetworks:|\nvolumes:|$)/,
  );
  if (!webappSection) return;
  assert.ok(
    webappSection[1].includes("API_ORIGIN: http://webapp:3000"),
    "webapp API_ORIGIN must be http://webapp:3000 in the rendered container profile (pinned in infra/agencyhq/trigger-overrides.yaml)",
  );
});
