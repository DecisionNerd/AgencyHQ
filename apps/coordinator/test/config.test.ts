/**
 * Config tests for bearer-token validation rules (I2.a).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

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
