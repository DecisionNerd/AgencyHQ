/**
 * Unit tests for the readiness subsystem.
 *
 * Covers buildReadiness for every meaningful state combination and the
 * file-reader helpers (readBootstrapJson, readDeploymentJson).
 * No real Postgres or Trigger API is required.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildReadiness } from "../src/readiness/build.ts";
import { readBootstrapJson, readDeploymentJson } from "../src/readiness/loader.ts";
import type { ReadinessInputs } from "../src/readiness/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inputs(overrides: Partial<ReadinessInputs> = {}): ReadinessInputs {
  return {
    database: "ok",
    trigger: "ok",
    bootstrapJson: null,
    deploymentJson: null,
    ...overrides,
  };
}

const DEPLOYMENT = {
  version: "1.2.3",
  platform: "linux/arm64",
  digest: "sha256:abc123",
  at: "2026-09-08T12:00:00.000Z",
};

const BOOTSTRAP_DONE = {
  phase: "done",
  status: "done" as const,
  at: "2026-09-08T11:00:00.000Z",
};

// ---------------------------------------------------------------------------
// buildReadiness — nextAction derivation
// ---------------------------------------------------------------------------

describe("buildReadiness — nextAction", () => {
  it("database down → instruct to check agencyhq-postgres", () => {
    const r = buildReadiness(inputs({ database: "down" }));
    assert.ok(
      r.nextAction.toLowerCase().includes("database"),
      `expected 'database' in nextAction, got: ${r.nextAction}`,
    );
    assert.equal(r.services.database, "down");
  });

  it("bootstrap absent → instruct to run docker compose up", () => {
    const r = buildReadiness(inputs({ bootstrapJson: null }));
    assert.ok(
      r.nextAction.includes("docker compose up") || r.nextAction.includes("Bootstrap not started"),
      `expected bootstrap not started in nextAction, got: ${r.nextAction}`,
    );
    assert.equal(r.bootstrap, null);
  });

  it("bootstrap running:wait → reports phase", () => {
    const r = buildReadiness(
      inputs({ bootstrapJson: { phase: "wait", status: "running", at: "2026-01-01T00:00:00Z" } }),
    );
    assert.ok(
      r.nextAction.includes("running") && r.nextAction.includes("wait"),
      `got: ${r.nextAction}`,
    );
  });

  it("bootstrap running:deploy → reports phase", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: { phase: "deploy", status: "running", at: "2026-01-01T00:00:00Z" },
      }),
    );
    assert.equal(r.nextAction, "Bootstrap is running: phase deploy");
  });

  it("bootstrap failed:credentials → surfaces phase and category", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "credentials",
          status: "failed",
          error: "pat_creation_failed",
          at: "2026-01-01T00:00:00Z",
        },
      }),
    );
    assert.ok(r.nextAction.includes("credentials"), `got: ${r.nextAction}`);
    assert.ok(r.nextAction.includes("pat_creation_failed"), `got: ${r.nextAction}`);
    assert.ok(r.nextAction.includes("docker compose logs bootstrap"), `got: ${r.nextAction}`);
  });

  it("bootstrap failed, no error category → uses 'unknown'", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: { phase: "smtp", status: "failed", at: "2026-01-01T00:00:00Z" },
      }),
    );
    assert.ok(r.nextAction.includes("unknown"), `got: ${r.nextAction}`);
    assert.ok(r.nextAction.includes("docker compose logs bootstrap"), `got: ${r.nextAction}`);
  });

  it("bootstrap done, trigger unconfigured → report key not yet available", () => {
    const r = buildReadiness(
      inputs({ bootstrapJson: BOOTSTRAP_DONE, trigger: "unconfigured", deploymentJson: null }),
    );
    assert.ok(
      r.nextAction.toLowerCase().includes("trigger") || r.nextAction.toLowerCase().includes("key"),
      `got: ${r.nextAction}`,
    );
  });

  it("bootstrap done, trigger down → report trigger unreachable", () => {
    const r = buildReadiness(
      inputs({ bootstrapJson: BOOTSTRAP_DONE, trigger: "down", deploymentJson: null }),
    );
    assert.ok(
      r.nextAction.toLowerCase().includes("trigger") ||
        r.nextAction.toLowerCase().includes("unreachable"),
      `got: ${r.nextAction}`,
    );
  });

  it("bootstrap done, trigger ok, image absent → report deploying", () => {
    const r = buildReadiness(
      inputs({ bootstrapJson: BOOTSTRAP_DONE, trigger: "ok", deploymentJson: null }),
    );
    assert.ok(
      r.nextAction.toLowerCase().includes("deploy") || r.nextAction.toLowerCase().includes("image"),
      `got: ${r.nextAction}`,
    );
  });

  it("fully ready → instruct provider login", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: BOOTSTRAP_DONE,
        trigger: "ok",
        deploymentJson: DEPLOYMENT,
      }),
    );
    assert.ok(
      r.nextAction.includes("opencode auth login") || r.nextAction.includes("provider login"),
      `got: ${r.nextAction}`,
    );
  });
});

// ---------------------------------------------------------------------------
// buildReadiness — response shape
// ---------------------------------------------------------------------------

describe("buildReadiness — response shape", () => {
  it("provider is always 'unknown'", () => {
    const r = buildReadiness(inputs());
    assert.equal(r.provider, "unknown");
  });

  it("worker is always 'unknown'", () => {
    const r = buildReadiness(inputs());
    assert.equal(r.worker, "unknown");
  });

  it("bootstrap null when bootstrapJson absent", () => {
    const r = buildReadiness(inputs({ bootstrapJson: null }));
    assert.equal(r.bootstrap, null);
  });

  it("bootstrap reflects phase/status/error/at", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "credentials",
          status: "failed",
          error: "token_error",
          at: "2026-01-01T00:00:00Z",
        },
      }),
    );
    assert.ok(r.bootstrap !== null);
    assert.equal(r.bootstrap?.phase, "credentials");
    assert.equal(r.bootstrap?.status, "failed");
    assert.equal(r.bootstrap?.error, "token_error");
    assert.equal(r.bootstrap?.at, "2026-01-01T00:00:00Z");
  });

  it("bootstrap done — error field absent when not provided", () => {
    const r = buildReadiness(inputs({ bootstrapJson: BOOTSTRAP_DONE }));
    assert.ok(r.bootstrap !== null);
    assert.equal("error" in (r.bootstrap ?? {}), false);
  });

  it("image null when deploymentJson absent", () => {
    const r = buildReadiness(inputs({ deploymentJson: null }));
    assert.equal(r.image, null);
  });

  it("image reflects version/platform/digest/at", () => {
    const r = buildReadiness(inputs({ deploymentJson: DEPLOYMENT }));
    assert.ok(r.image !== null);
    assert.equal(r.image?.version, "1.2.3");
    assert.equal(r.image?.platform, "linux/arm64");
    assert.equal(r.image?.digest, "sha256:abc123");
    assert.equal(r.image?.at, "2026-09-08T12:00:00.000Z");
  });

  it("image without digest — digest field absent", () => {
    const r = buildReadiness(
      inputs({
        deploymentJson: { version: "1.0.0", platform: "linux/arm64", at: "2026-01-01T00:00:00Z" },
      }),
    );
    assert.ok(r.image !== null);
    assert.equal("digest" in (r.image ?? {}), false);
  });

  it("services.database and services.trigger reflect inputs", () => {
    const r = buildReadiness(inputs({ database: "down", trigger: "unconfigured" }));
    assert.equal(r.services.database, "down");
    assert.equal(r.services.trigger, "unconfigured");
  });
});

// ---------------------------------------------------------------------------
// readBootstrapJson / readDeploymentJson — file reader unit tests
// ---------------------------------------------------------------------------

describe("readBootstrapJson", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `bootstrap-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when stateDir is undefined", () => {
    assert.equal(readBootstrapJson(undefined), null);
  });

  it("returns null when bootstrap.json does not exist", () => {
    assert.equal(readBootstrapJson(tmpDir), null);
  });

  it("returns null when bootstrap.json contains invalid JSON", () => {
    writeFileSync(join(tmpDir, "bootstrap.json"), "not-json");
    assert.equal(readBootstrapJson(tmpDir), null);
  });

  it("returns null when bootstrap.json missing required fields", () => {
    writeFileSync(join(tmpDir, "bootstrap.json"), JSON.stringify({ phase: "done" }));
    assert.equal(readBootstrapJson(tmpDir), null);
  });

  it("returns null when status is invalid", () => {
    writeFileSync(
      join(tmpDir, "bootstrap.json"),
      JSON.stringify({ phase: "done", status: "invalid", at: "2026-01-01T00:00:00Z" }),
    );
    assert.equal(readBootstrapJson(tmpDir), null);
  });

  it("parses a valid running bootstrap.json", () => {
    writeFileSync(
      join(tmpDir, "bootstrap.json"),
      JSON.stringify({ phase: "deploy", status: "running", at: "2026-09-08T10:00:00Z" }),
    );
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null);
    assert.equal(result?.phase, "deploy");
    assert.equal(result?.status, "running");
    assert.equal(result?.at, "2026-09-08T10:00:00Z");
    assert.equal("error" in (result ?? {}), false);
  });

  it("parses a failed bootstrap.json with error category", () => {
    writeFileSync(
      join(tmpDir, "bootstrap.json"),
      JSON.stringify({
        phase: "credentials",
        status: "failed",
        error: "pat_creation_failed",
        at: "2026-09-08T11:00:00Z",
      }),
    );
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null);
    assert.equal(result?.status, "failed");
    assert.equal(result?.error, "pat_creation_failed");
  });

  it("parses a done bootstrap.json", () => {
    writeFileSync(
      join(tmpDir, "bootstrap.json"),
      JSON.stringify({ phase: "done", status: "done", at: "2026-09-08T12:00:00Z" }),
    );
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null);
    assert.equal(result?.status, "done");
  });
});

describe("readDeploymentJson", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `deployment-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when stateDir is undefined", () => {
    assert.equal(readDeploymentJson(undefined), null);
  });

  it("returns null when deployment.json does not exist", () => {
    assert.equal(readDeploymentJson(tmpDir), null);
  });

  it("returns null for invalid JSON", () => {
    writeFileSync(join(tmpDir, "deployment.json"), "garbage");
    assert.equal(readDeploymentJson(tmpDir), null);
  });

  it("parses a valid deployment.json with digest", () => {
    writeFileSync(
      join(tmpDir, "deployment.json"),
      JSON.stringify({
        version: "2.0.0",
        platform: "linux/arm64",
        digest: "sha256:deadbeef",
        at: "2026-09-08T12:00:00Z",
      }),
    );
    const result = readDeploymentJson(tmpDir);
    assert.ok(result !== null);
    assert.equal(result?.version, "2.0.0");
    assert.equal(result?.platform, "linux/arm64");
    assert.equal(result?.digest, "sha256:deadbeef");
  });

  it("parses a valid deployment.json without digest", () => {
    writeFileSync(
      join(tmpDir, "deployment.json"),
      JSON.stringify({ version: "1.0.0", platform: "linux/amd64", at: "2026-09-08T12:00:00Z" }),
    );
    const result = readDeploymentJson(tmpDir);
    assert.ok(result !== null);
    assert.equal("digest" in (result ?? {}), false);
  });
});

// ---------------------------------------------------------------------------
// nextRetryAt — rate-limit backoff surface
// ---------------------------------------------------------------------------

describe("buildReadiness — login_rate_limited nextAction", () => {
  const RATE_LIMITED_AT = "2026-09-09T13:00:00.000Z";
  const NEXT_RETRY_AT = "2026-09-09T14:00:00.000Z";

  it("login_rate_limited with nextRetryAt → nextAction mentions backoff time", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "login",
          status: "failed",
          error: "login_rate_limited",
          at: RATE_LIMITED_AT,
          nextRetryAt: NEXT_RETRY_AT,
        },
      }),
    );
    assert.ok(
      r.nextAction.includes(NEXT_RETRY_AT) || r.nextAction.includes("backing off"),
      `expected backoff time in nextAction, got: ${r.nextAction}`,
    );
    assert.ok(
      r.nextAction.includes("login_rate_limited"),
      `expected category in nextAction, got: ${r.nextAction}`,
    );
  });

  it("deploy_in_progress with nextRetryAt → nextAction reports the backoff (interrupted build)", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "deploy",
          status: "failed",
          error: "deploy_in_progress",
          at: RATE_LIMITED_AT,
          nextRetryAt: NEXT_RETRY_AT,
        },
      }),
    );
    assert.ok(r.nextAction.includes(NEXT_RETRY_AT), `expected backoff time, got: ${r.nextAction}`);
    assert.ok(
      r.nextAction.includes("deploy_in_progress"),
      `expected category, got: ${r.nextAction}`,
    );
  });

  it("login_rate_limited without nextRetryAt → falls back to generic failed message", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "login",
          status: "failed",
          error: "login_rate_limited",
          at: RATE_LIMITED_AT,
        },
      }),
    );
    assert.ok(
      r.nextAction.includes("login_rate_limited"),
      `expected category in nextAction, got: ${r.nextAction}`,
    );
    assert.ok(
      r.nextAction.includes("docker compose logs bootstrap"),
      `expected docker compose logs in nextAction, got: ${r.nextAction}`,
    );
  });

  it("nextRetryAt propagated into bootstrap response field", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "login",
          status: "failed",
          error: "login_rate_limited",
          at: RATE_LIMITED_AT,
          nextRetryAt: NEXT_RETRY_AT,
        },
      }),
    );
    assert.equal(r.bootstrap?.nextRetryAt, NEXT_RETRY_AT);
  });

  it("nextRetryAt absent when bootstrapJson has no nextRetryAt", () => {
    const r = buildReadiness(
      inputs({
        bootstrapJson: {
          phase: "login",
          status: "failed",
          error: "other_error",
          at: RATE_LIMITED_AT,
        },
      }),
    );
    assert.equal("nextRetryAt" in (r.bootstrap ?? {}), false);
  });
});

describe("readBootstrapJson — nextRetryAt from BootstrapState format", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "next-retry-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads nextRetryAt from BootstrapState format", () => {
    const nextRetryAt = "2026-09-09T14:30:00.000Z";
    writeFileSync(
      join(tmpDir, "bootstrap.json"),
      JSON.stringify({
        version: 1,
        phases: {
          login: {
            status: "failed",
            errorCategory: "login_rate_limited",
            errorMessage: "rate limited",
            completedAt: "2026-09-09T13:00:00.000Z",
          },
        },
        updatedAt: "2026-09-09T13:00:00.000Z",
        nextRetryAt,
        magicLinkRateLimitedUntil: "2026-09-09T14:00:00.000Z",
        attempt: 1,
      }),
    );
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null);
    assert.equal(result?.nextRetryAt, nextRetryAt);
    assert.equal(result?.error, "login_rate_limited");
  });

  it("nextRetryAt is absent when not set in BootstrapState", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "no-retry-test-"));
    try {
      writeFileSync(
        join(tmp2, "bootstrap.json"),
        JSON.stringify({
          version: 1,
          phases: {
            deploy: { status: "running", startedAt: "2026-09-09T13:00:00.000Z" },
          },
          updatedAt: "2026-09-09T13:00:00.000Z",
        }),
      );
      const result = readBootstrapJson(tmp2);
      assert.ok(result !== null);
      assert.equal("nextRetryAt" in (result ?? {}), false);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
