#!/usr/bin/env node
/**
 * secrets-init.mjs — one-shot secret generator for the AgencyHQ container profile.
 *
 * Generates every internal secret exactly once, writing 0644 files to the secrets
 * directory. Never rotates a non-empty value (idempotent). Adds missing keys to
 * existing env files without overwriting present values.
 * No runtime dependencies beyond Node.js built-ins.
 *
 * File mode is 0644 (not 0600): the Trigger webapp and its postgres wrapper run
 * as root, ClickHouse as uid 101, MinIO as uid 1001, and the AgencyHQ app as
 * uid 1000; all consumers mount the volume read-only. No single-user-only mode
 * would satisfy every reader (L1 trial record, defect 7). The bootstrap writes trigger-prod.key
 * and trigger-pat.key as 0600 — those are not written here.
 *
 * Secret files written:
 *   webapp.env           — Trigger webapp process secrets (sourced by the webapp command wrapper)
 *   supervisor.env       — Trigger worker stack container process secrets (sourced by its command wrapper)
 *   agencyhq.env         — AgencyHQ coordinator process secrets (sourced by entrypoint-app.sh)
 *   trigger-db-password  — Raw Trigger postgres password (POSTGRES_PASSWORD_FILE)
 *   agencyhq-db-password — Raw AgencyHQ postgres password (POSTGRES_PASSWORD_FILE)
 *   clickhouse.env       — Clickhouse credentials (sourced by the clickhouse command wrapper)
 *   minio.env            — MinIO credentials (sourced by the minio command wrapper)
 *
 * Never logs secret values — only variable names and file paths.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

// AGENCYHQ_SECRETS_DIR takes precedence over legacy SECRETS_DIR
const SECRETS_DIR =
  process.env.AGENCYHQ_SECRETS_DIR ?? process.env.SECRETS_DIR ?? "/run/agencyhq/secrets";
const BOOTSTRAP_EMAIL = process.env.AGENCYHQ_BOOTSTRAP_EMAIL ?? "bootstrap@agencyhq.local";

mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });

function hex(bytes = 16) {
  return randomBytes(bytes).toString("hex");
}

/**
 * Read existing value from a secrets env file for a given key.
 * Returns undefined if the file doesn't exist or the key is absent.
 */
function readExistingValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    if (trimmed.slice(0, eqIdx) === key) return unquote(trimmed.slice(eqIdx + 1));
  }
  return undefined;
}

/**
 * Read existing raw value from a plain (non-env-format) file.
 */
function readExistingRaw(filePath) {
  if (!existsSync(filePath)) return undefined;
  const v = readFileSync(filePath, "utf8").trim();
  return v.length > 0 ? v : undefined;
}

/** Quote every KEY=value line of a sourced env file (values may contain &, ?, $). */
function quoteEnv(content) {
  return content
    .split("\n")
    .map((line) => {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) return line;
      const v = m[2];
      if (v.startsWith("'") && v.endsWith("'")) return line;
      return `${m[1]}='${v.replace(/'/g, "'\\''")}'`;
    })
    .join("\n");
}

function unquote(v) {
  return v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/'\\''/g, "'") : v;
}

async function writeSecret(filePath, content) {
  if (filePath.endsWith(".env")) content = quoteEnv(content);
  writeFileSync(filePath, content, { mode: 0o644 });
  await chmod(filePath, 0o644);
}

/**
 * Ensure a key in an env file has a value; generate one if missing or empty.
 * Returns the (possibly new) value.
 */
function ensureValue(existingValue, generator) {
  if (existingValue !== undefined && existingValue.length > 0) {
    return existingValue;
  }
  return generator();
}

console.log(`[secrets-init] secrets dir: ${SECRETS_DIR}`);

// ── 1. Per-password raw files (for POSTGRES_PASSWORD_FILE) ──────────────────

const triggerDbFile = join(SECRETS_DIR, "trigger-db-password");
const agencyhqDbFile = join(SECRETS_DIR, "agencyhq-db-password");
const webappFile = join(SECRETS_DIR, "webapp.env");

// Resolve trigger-db-password: read raw file, or derive from existing DATABASE_URL,
// or generate fresh. webapp.env is read first to support the derivation path.
let triggerDbPassword = readExistingRaw(triggerDbFile);
if (!triggerDbPassword) {
  // If webapp.env already has DATABASE_URL, derive the password from it so the
  // raw file and the URL stay in sync (CR10 password/URL agreement).
  const existingDbUrl = readExistingValue(webappFile, "DATABASE_URL");
  if (existingDbUrl) {
    try {
      const url = new URL(existingDbUrl);
      const fromUrl = decodeURIComponent(url.password);
      if (fromUrl) {
        triggerDbPassword = fromUrl;
        await writeSecret(triggerDbFile, triggerDbPassword);
        console.log("[secrets-init] derived: trigger-db-password from DATABASE_URL in webapp.env");
      }
    } catch {
      // URL parse failure — fall through to generate
    }
  }
}
if (!triggerDbPassword) {
  triggerDbPassword = hex(20);
  await writeSecret(triggerDbFile, triggerDbPassword);
  console.log("[secrets-init] generated: trigger-db-password");
} else if (readExistingRaw(triggerDbFile) === triggerDbPassword) {
  console.log("[secrets-init] retained: trigger-db-password");
}

const agencyhqDbPassword = ensureValue(readExistingRaw(agencyhqDbFile), () => hex(20));

const existingAgencyhqDb = readExistingRaw(agencyhqDbFile);
if (!existingAgencyhqDb) {
  await writeSecret(agencyhqDbFile, agencyhqDbPassword);
  console.log("[secrets-init] generated: agencyhq-db-password");
} else {
  console.log("[secrets-init] retained: agencyhq-db-password");
}

// ── 2. webapp.env ────────────────────────────────────────────────────────────

// Read existing values or generate new ones; always rewrite so missing keys are added.
const sessionSecret = ensureValue(readExistingValue(webappFile, "SESSION_SECRET"), () => hex(32));
const magicLinkSecret = ensureValue(readExistingValue(webappFile, "MAGIC_LINK_SECRET"), () =>
  hex(32),
);
// The webapp requires ENCRYPTION_KEY to be exactly 32 characters (env.server.ts
// "must be exactly 32 bytes"; upstream generates `openssl rand -hex 16`).
const encryptionKey = ensureValue(readExistingValue(webappFile, "ENCRYPTION_KEY"), () => hex(16));
const providerSecret = ensureValue(readExistingValue(webappFile, "PROVIDER_SECRET"), () => hex(32));
const coordinatorSecret = ensureValue(readExistingValue(webappFile, "COORDINATOR_SECRET"), () =>
  hex(32),
);
const managedWorkerSecret = ensureValue(
  readExistingValue(webappFile, "MANAGED_WORKER_SECRET"),
  () => hex(32),
);
const clickhousePassword = ensureValue(readExistingValue(webappFile, "CLICKHOUSE_PASSWORD"), () =>
  hex(20),
);
const minioSecret = ensureValue(
  readExistingValue(webappFile, "OBJECT_STORE_SECRET_ACCESS_KEY"),
  () => hex(20),
);

// Escape the bootstrap email for use as a regex anchor.
// Only alphanumeric, @, ., and - are expected; escape dots.
const bootstrapEmailRegex = `^${BOOTSTRAP_EMAIL.replace(/\./g, "\\.")}$`;

const webappEnv = [
  "# Trigger webapp secrets — sourced by the webapp command wrapper (infra/trigger/docker-compose.yml)",
  "# Never commit this file. Generated by secrets-init.",
  `SESSION_SECRET=${sessionSecret}`,
  `MAGIC_LINK_SECRET=${magicLinkSecret}`,
  `ENCRYPTION_KEY=${encryptionKey}`,
  `PROVIDER_SECRET=${providerSecret}`,
  `COORDINATOR_SECRET=${coordinatorSecret}`,
  `MANAGED_WORKER_SECRET=${managedWorkerSecret}`,
  `POSTGRES_PASSWORD=${triggerDbPassword}`,
  `DATABASE_URL=postgresql://postgres:${triggerDbPassword}@postgres:5432/main?schema=public&sslmode=disable`,
  `DIRECT_URL=postgresql://postgres:${triggerDbPassword}@postgres:5432/main?schema=public&sslmode=disable`,
  `CLICKHOUSE_PASSWORD=${clickhousePassword}`,
  `CLICKHOUSE_URL=http://default:${clickhousePassword}@clickhouse:8123?secure=false`,
  `RUN_REPLICATION_CLICKHOUSE_URL=http://default:${clickhousePassword}@clickhouse:8123`,
  `OBJECT_STORE_ACCESS_KEY_ID=admin`,
  `OBJECT_STORE_SECRET_ACCESS_KEY=${minioSecret}`,
  // env.server.ts line 333: WHITELISTED_EMAILS — restrict sign-in to bootstrap address.
  `WHITELISTED_EMAILS=${bootstrapEmailRegex}`,
  // env.server.ts line 337: ADMIN_EMAILS — grant admin to bootstrap address.
  `ADMIN_EMAILS=${bootstrapEmailRegex}`,
  "",
].join("\n");

const webappExists = existsSync(webappFile);
// Always write to add any missing keys; ensureValue above preserves existing values.
await writeSecret(webappFile, webappEnv);
if (!webappExists) {
  console.log(
    "[secrets-init] generated: webapp.env (keys: SESSION_SECRET MAGIC_LINK_SECRET ENCRYPTION_KEY PROVIDER_SECRET COORDINATOR_SECRET MANAGED_WORKER_SECRET POSTGRES_PASSWORD DATABASE_URL CLICKHOUSE_PASSWORD OBJECT_STORE_SECRET_ACCESS_KEY)",
  );
} else {
  console.log("[secrets-init] updated: webapp.env (missing keys added, existing values retained)");
}

// ── 3. supervisor.env (Trigger worker stack container) ───────────────────────

const supervisorFile = join(SECRETS_DIR, "supervisor.env");
const supervisorManagedWorkerSecret = ensureValue(
  readExistingValue(supervisorFile, "MANAGED_WORKER_SECRET"),
  () => managedWorkerSecret,
);
const supervisorEnv = [
  "# Trigger worker stack container secrets — sourced by the supervisor command wrapper",
  "# Never commit this file. Generated by secrets-init.",
  `MANAGED_WORKER_SECRET=${supervisorManagedWorkerSecret}`,
  "",
].join("\n");

const supervisorExists = existsSync(supervisorFile);
await writeSecret(supervisorFile, supervisorEnv);
if (!supervisorExists) {
  console.log(
    "[secrets-init] generated: supervisor.env (worker stack; keys: MANAGED_WORKER_SECRET)",
  );
} else {
  console.log(
    "[secrets-init] updated: supervisor.env (missing keys added, existing values retained)",
  );
}

// ── 4. agencyhq.env ──────────────────────────────────────────────────────────

const agencyhqFile = join(SECRETS_DIR, "agencyhq.env");

// AES-256-GCM key (64 hex chars = 32 bytes) for project credential rows
// (packages/db/src/crypto.ts). Never rotated once present.
const agencyhqSecretsKey = ensureValue(
  readExistingValue(agencyhqFile, "AGENCYHQ_SECRETS_KEY"),
  () => randomBytes(32).toString("hex"),
);
const agencyhqApiToken = ensureValue(readExistingValue(agencyhqFile, "AGENCYHQ_API_TOKEN"), () =>
  hex(32),
);
const agencyhqPostgresPassword = ensureValue(
  readExistingValue(agencyhqFile, "AGENCYHQ_POSTGRES_PASSWORD"),
  () => agencyhqDbPassword,
);

const agencyhqEnv = [
  "# AgencyHQ coordinator secrets — sourced by entrypoint-app.sh",
  "# Never commit this file. Generated by secrets-init.",
  `AGENCYHQ_POSTGRES_PASSWORD=${agencyhqPostgresPassword}`,
  `DATABASE_URL=postgresql://agencyhq:${agencyhqPostgresPassword}@agencyhq-postgres:5432/agencyhq?sslmode=disable`,
  `AGENCYHQ_API_TOKEN=${agencyhqApiToken}`,
  `AGENCYHQ_SECRETS_KEY=${agencyhqSecretsKey}`,
  "# TRIGGER_SECRET_KEY is set by bootstrap after the Trigger project is created",
  "# and written to the agencyhq-state volume. The coordinator reads it from there.",
  "",
].join("\n");

const agencyhqExists = existsSync(agencyhqFile);
await writeSecret(agencyhqFile, agencyhqEnv);
if (!agencyhqExists) {
  console.log(
    "[secrets-init] generated: agencyhq.env (keys: AGENCYHQ_POSTGRES_PASSWORD DATABASE_URL AGENCYHQ_API_TOKEN AGENCYHQ_SECRETS_KEY)",
  );
} else {
  console.log(
    "[secrets-init] updated: agencyhq.env (missing keys added, existing values retained)",
  );
}

// ── 5. clickhouse.env ────────────────────────────────────────────────────────

const clickhouseFile = join(SECRETS_DIR, "clickhouse.env");
const clickhouseExistingPassword = ensureValue(
  readExistingValue(clickhouseFile, "CLICKHOUSE_PASSWORD"),
  () => clickhousePassword,
);

const clickhouseEnv = [
  "# Clickhouse secrets — sourced by the clickhouse command wrapper (infra/trigger/docker-compose.yml)",
  "# Never commit this file. Generated by secrets-init.",
  `CLICKHOUSE_PASSWORD=${clickhouseExistingPassword}`,
  "",
].join("\n");

const clickhouseExists = existsSync(clickhouseFile);
await writeSecret(clickhouseFile, clickhouseEnv);
if (!clickhouseExists) {
  console.log("[secrets-init] generated: clickhouse.env (keys: CLICKHOUSE_PASSWORD)");
} else {
  console.log(
    "[secrets-init] updated: clickhouse.env (missing keys added, existing values retained)",
  );
}

// ── 6. minio.env ─────────────────────────────────────────────────────────────

const minioFile = join(SECRETS_DIR, "minio.env");
const minioExistingSecret = ensureValue(
  readExistingValue(minioFile, "OBJECT_STORE_SECRET_ACCESS_KEY"),
  () => minioSecret,
);

const minioEnv = [
  "# MinIO secrets — sourced by the minio command wrapper (infra/trigger/docker-compose.yml)",
  "# Never commit this file. Generated by secrets-init.",
  `MINIO_ROOT_USER=admin`,
  `MINIO_ROOT_PASSWORD=${minioExistingSecret}`,
  `OBJECT_STORE_ACCESS_KEY_ID=admin`,
  `OBJECT_STORE_SECRET_ACCESS_KEY=${minioExistingSecret}`,
  "",
].join("\n");

const minioExists = existsSync(minioFile);
await writeSecret(minioFile, minioEnv);
if (!minioExists) {
  console.log(
    "[secrets-init] generated: minio.env (keys: MINIO_ROOT_USER MINIO_ROOT_PASSWORD OBJECT_STORE_ACCESS_KEY_ID OBJECT_STORE_SECRET_ACCESS_KEY)",
  );
} else {
  console.log("[secrets-init] updated: minio.env (missing keys added, existing values retained)");
}

console.log("[secrets-init] done — all secrets present");
