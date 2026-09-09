/**
 * Config tests for bearer-token validation rules (I2.a) and
 * secret-file resolution precedence (P15.3).
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError, loadConfig, readSecretFile, readTriggerKeyFromState } from "../src/config.ts";

// Minimal env that satisfies all required fields except the one under test.
const REQUIRED_ENV = {
  DATABASE_URL: "postgres://fake/test",
  RUNTIME: "fake",
  AGENCYHQ_WORKTREE_BASE: "/worktrees",
  AGENCYHQ_WORKER_MODEL: "claude-sonnet-4",
  AGENCYHQ_LEAD_MODEL: "claude-opus-4",
  AGENCYHQ_REVIEWER_MODEL: "claude-sonnet-4",
} as const;

describe("loadConfig — apiToken / bindHost validation", () => {
  it("token unset + bindHost 127.0.0.1 (default) → ok, apiToken absent", () => {
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.apiToken, undefined);
  });

  it("token unset + bindHost ::1 → ok", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_BIND_HOST: "::1",
    } as NodeJS.ProcessEnv);
    assert.equal(config.bindHost, "::1");
    assert.equal(config.apiToken, undefined);
  });

  it("token unset + bindHost localhost → ok", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_BIND_HOST: "localhost",
    } as NodeJS.ProcessEnv);
    assert.equal(config.apiToken, undefined);
  });

  it("token unset + bindHost 0.0.0.0 → throws ConfigError naming AGENCYHQ_API_TOKEN", () => {
    assert.throws(
      () =>
        loadConfig({
          ...REQUIRED_ENV,
          AGENCYHQ_BIND_HOST: "0.0.0.0",
        } as NodeJS.ProcessEnv),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, "expected ConfigError");
        assert.ok(
          err.missing.includes("AGENCYHQ_API_TOKEN"),
          `expected AGENCYHQ_API_TOKEN in missing, got: ${err.missing.join(", ")}`,
        );
        return true;
      },
    );
  });

  it("token set + bindHost 0.0.0.0 → ok, apiToken present", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_BIND_HOST: "0.0.0.0",
      AGENCYHQ_API_TOKEN: "super-secret-token",
    } as NodeJS.ProcessEnv);
    assert.equal(config.bindHost, "0.0.0.0");
    assert.equal(config.apiToken, "super-secret-token");
  });

  it("token set + bindHost 127.0.0.1 → ok, apiToken present", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_API_TOKEN: "tok-abc",
    } as NodeJS.ProcessEnv);
    assert.equal(config.apiToken, "tok-abc");
  });
});

// ---------------------------------------------------------------------------
// readSecretFile unit tests
// ---------------------------------------------------------------------------

describe("readSecretFile", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `secrets-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when dir is undefined", () => {
    assert.equal(readSecretFile("FOO", undefined), undefined);
  });

  it("returns undefined when neither file exists", () => {
    assert.equal(readSecretFile("MISSING_SECRET", tmpDir), undefined);
  });

  it("reads value from <NAME>.env file (NAME=value format)", () => {
    writeFileSync(join(tmpDir, "DATABASE_URL.env"), "DATABASE_URL=postgres://user:pass@host/db\n");
    const val = readSecretFile("DATABASE_URL", tmpDir);
    assert.equal(val, "postgres://user:pass@host/db");
  });

  it("reads value from <NAME> raw file", () => {
    writeFileSync(join(tmpDir, "TRIGGER_SECRET_KEY"), "sk_live_abc123\n");
    const val = readSecretFile("TRIGGER_SECRET_KEY", tmpDir);
    assert.equal(val, "sk_live_abc123");
  });

  it("<NAME>.env takes priority over <NAME> raw file", () => {
    writeFileSync(join(tmpDir, "AGENCYHQ_API_TOKEN.env"), "AGENCYHQ_API_TOKEN=from-env-file\n");
    writeFileSync(join(tmpDir, "AGENCYHQ_API_TOKEN"), "from-raw-file");
    const val = readSecretFile("AGENCYHQ_API_TOKEN", tmpDir);
    assert.equal(val, "from-env-file");
  });

  it("never returns the value when the env file line has no value", () => {
    writeFileSync(join(tmpDir, "EMPTY_SECRET.env"), "EMPTY_SECRET=\n");
    // Falls through to raw file which also doesn't exist → undefined
    const val = readSecretFile("EMPTY_SECRET", tmpDir);
    assert.equal(val, undefined);
  });
});

// ---------------------------------------------------------------------------
// readTriggerKeyFromState unit tests
// ---------------------------------------------------------------------------

describe("readTriggerKeyFromState", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `trigger-key-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when stateDir is undefined", () => {
    assert.equal(readTriggerKeyFromState(undefined), undefined);
  });

  it("returns undefined when trigger-prod.key does not exist", () => {
    assert.equal(readTriggerKeyFromState(tmpDir), undefined);
  });

  it("reads the key from trigger-prod.key", () => {
    writeFileSync(join(tmpDir, "trigger-prod.key"), "tr_live_mysecretkey\n");
    assert.equal(readTriggerKeyFromState(tmpDir), "tr_live_mysecretkey");
  });

  it("returns undefined for an empty trigger-prod.key", () => {
    writeFileSync(join(tmpDir, "trigger-prod.key"), "   \n");
    assert.equal(readTriggerKeyFromState(tmpDir), undefined);
  });
});

// ---------------------------------------------------------------------------
// loadConfig secret precedence tests
// ---------------------------------------------------------------------------

describe("loadConfig — secret precedence (env wins over file)", () => {
  let secretsDir: string;
  let stateDir: string;

  before(() => {
    secretsDir = join(tmpdir(), `load-config-secrets-${Date.now()}`);
    stateDir = join(tmpdir(), `load-config-state-${Date.now()}`);
    mkdirSync(secretsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
  });

  after(() => {
    rmSync(secretsDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("DATABASE_URL from env wins over secrets dir file", () => {
    writeFileSync(join(secretsDir, "DATABASE_URL.env"), "DATABASE_URL=postgres://from-file/db\n");
    const config = loadConfig({
      ...REQUIRED_ENV,
      DATABASE_URL: "postgres://from-env/db",
      AGENCYHQ_SECRETS_DIR: secretsDir,
    } as NodeJS.ProcessEnv);
    assert.equal(config.databaseUrl, "postgres://from-env/db");
  });

  it("DATABASE_URL from secrets dir when env not set", () => {
    writeFileSync(
      join(secretsDir, "DATABASE_URL.env"),
      "DATABASE_URL=postgres://from-secrets-dir/db\n",
    );
    const envWithoutDbUrl = {
      ...REQUIRED_ENV,
      AGENCYHQ_SECRETS_DIR: secretsDir,
    } as NodeJS.ProcessEnv;
    // Remove DATABASE_URL from the env
    const { DATABASE_URL: _removed, ...envNoDb } = envWithoutDbUrl as Record<string, string>;
    const config = loadConfig(envNoDb as NodeJS.ProcessEnv);
    assert.equal(config.databaseUrl, "postgres://from-secrets-dir/db");
  });

  it("stateDir and secretsDir are present on the config", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_SECRETS_DIR: secretsDir,
      AGENCYHQ_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    assert.equal(config.secretsDir, secretsDir);
    assert.equal(config.stateDir, stateDir);
  });

  it("stateDir and secretsDir are absent when env vars not set", () => {
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    assert.equal(config.stateDir, undefined);
    assert.equal(config.secretsDir, undefined);
  });

  it("AGENCYHQ_API_TOKEN from secrets dir satisfies non-loopback bindHost requirement", () => {
    writeFileSync(join(secretsDir, "AGENCYHQ_API_TOKEN"), "tok-from-file");
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_BIND_HOST: "0.0.0.0",
      AGENCYHQ_SECRETS_DIR: secretsDir,
    } as NodeJS.ProcessEnv);
    assert.equal(config.apiToken, "tok-from-file");
    assert.equal(config.bindHost, "0.0.0.0");
  });

  it("TRIGGER_SECRET_KEY from state dir for real runtime — no error", () => {
    writeFileSync(join(stateDir, "trigger-prod.key"), "sk_from_state");
    // real runtime needs TRIGGER_API_URL at minimum; key comes from state dir
    const config = loadConfig({
      ...REQUIRED_ENV,
      RUNTIME: "real",
      TRIGGER_API_URL: "http://trigger:3000",
      AGENCYHQ_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    // Should not throw and key should be loaded
    assert.equal(config.triggerSecretKey, "sk_from_state");
  });

  it("real runtime starts without trigger key — empty string, no throw", () => {
    // No key in env, secrets dir, or state dir → empty string
    const config = loadConfig({
      ...REQUIRED_ENV,
      RUNTIME: "real",
      TRIGGER_API_URL: "http://trigger:3000",
    } as NodeJS.ProcessEnv);
    assert.equal(config.triggerSecretKey, "");
  });
});
