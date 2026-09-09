/**
 * infra/tests/secrets-init.test.mjs — test suite for infra/secrets/secrets-init.mjs.
 *
 * Runs the script with a temporary secrets directory via AGENCYHQ_SECRETS_DIR.
 * Tests idempotency, missing-key addition, and password/URL agreement.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "../secrets/secrets-init.mjs");

function runScript(secretsDir) {
  return execFileSync("node", [scriptPath], {
    env: { ...process.env, AGENCYHQ_SECRETS_DIR: secretsDir },
    encoding: "utf8",
  });
}

function readEnvKey(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq) !== key) continue;
    const val = t.slice(eq + 1);
    return val.startsWith("'") && val.endsWith("'") ? val.slice(1, -1) : val;
  }
  return undefined;
}

test("fresh run creates all required files", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-fresh-"));
  try {
    runScript(dir);
    assert.ok(existsSync(join(dir, "webapp.env")), "webapp.env must be created");
    assert.ok(existsSync(join(dir, "supervisor.env")), "supervisor.env must be created");
    assert.ok(existsSync(join(dir, "agencyhq.env")), "agencyhq.env must be created");
    assert.ok(existsSync(join(dir, "clickhouse.env")), "clickhouse.env must be created");
    assert.ok(existsSync(join(dir, "minio.env")), "minio.env must be created");
    assert.ok(existsSync(join(dir, "trigger-db-password")), "trigger-db-password must be created");
    assert.ok(
      existsSync(join(dir, "agencyhq-db-password")),
      "agencyhq-db-password must be created",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("second run changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-idem-"));
  try {
    runScript(dir);
    const snap = {};
    for (const f of ["trigger-db-password", "agencyhq-db-password", "webapp.env", "agencyhq.env"]) {
      snap[f] = readFileSync(join(dir, f), "utf8");
    }
    runScript(dir);
    for (const f of Object.keys(snap)) {
      assert.equal(
        readFileSync(join(dir, f), "utf8"),
        snap[f],
        `${f} must not change on second run`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing key is added on second run without changing existing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-addkey-"));
  try {
    runScript(dir);
    const agFile = join(dir, "agencyhq.env");
    const originalApiToken = readEnvKey(agFile, "AGENCYHQ_API_TOKEN");
    assert.ok(
      originalApiToken && originalApiToken.length > 0,
      "AGENCYHQ_API_TOKEN must exist after first run",
    );

    // Remove AGENCYHQ_API_TOKEN from the file (simulate it being absent)
    let content = readFileSync(agFile, "utf8");
    content = content
      .split("\n")
      .filter((l) => !l.startsWith("AGENCYHQ_API_TOKEN"))
      .join("\n");
    writeFileSync(agFile, content, "utf8");
    assert.equal(
      readEnvKey(agFile, "AGENCYHQ_API_TOKEN"),
      undefined,
      "token must be absent after manual removal",
    );

    // Second run should add it back
    runScript(dir);
    const restoredToken = readEnvKey(agFile, "AGENCYHQ_API_TOKEN");
    assert.ok(restoredToken && restoredToken.length > 0, "AGENCYHQ_API_TOKEN must be re-added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trigger-db-password and DATABASE_URL in webapp.env agree after fresh run", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-agree-"));
  try {
    runScript(dir);
    const rawPw = readFileSync(join(dir, "trigger-db-password"), "utf8").trim();
    const dbUrl = readEnvKey(join(dir, "webapp.env"), "DATABASE_URL");
    assert.ok(dbUrl, "DATABASE_URL must be in webapp.env");
    const url = new URL(dbUrl);
    assert.equal(
      decodeURIComponent(url.password),
      rawPw,
      "DATABASE_URL password must match trigger-db-password",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when raw password file missing, derive it from existing DATABASE_URL in webapp.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-derive-"));
  try {
    // First run — creates all files
    runScript(dir);
    const rawPw = readFileSync(join(dir, "trigger-db-password"), "utf8").trim();

    // Delete the raw password file
    rmSync(join(dir, "trigger-db-password"));
    assert.ok(!existsSync(join(dir, "trigger-db-password")), "raw file must be absent");

    // Second run — should derive from DATABASE_URL in webapp.env and restore the raw file
    runScript(dir);
    assert.ok(existsSync(join(dir, "trigger-db-password")), "raw file must be restored");
    const restoredPw = readFileSync(join(dir, "trigger-db-password"), "utf8").trim();
    assert.equal(restoredPw, rawPw, "restored password must match the original");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
