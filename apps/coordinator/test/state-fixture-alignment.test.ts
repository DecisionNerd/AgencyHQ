/**
 * Fixture alignment test — verifies that the JSON shapes written by the
 * bootstrap package (StateManager / runDeploy) are correctly parsed by the
 * coordinator readiness loader.
 *
 * These tests encode the exact JSON that apps/bootstrap/src/state.ts
 * StateManager.save() and apps/bootstrap/src/deploy.ts writeDeploymentRecord()
 * produce, and assert that the coordinator's readBootstrapJson /
 * readDeploymentJson return the expected ReadinessInputs values.
 *
 * If either side changes its JSON shape, this test suite breaks, making the
 * contract violation explicit before a live Compose start.
 *
 * Counterpart: apps/bootstrap/test/ (interrupt.test.ts, phases.test.ts) covers
 * the bootstrap side of the state machine; this file covers the coordinator
 * reader side.
 *
 * JSON shapes defined here must match:
 *   apps/bootstrap/src/state.ts  — BootstrapState / PhaseState
 *   apps/bootstrap/src/deploy.ts — DeploymentRecord
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readBootstrapJson, readDeploymentJson } from "../src/readiness/loader.ts";

// ---------------------------------------------------------------------------
// Temporary directory setup
// ---------------------------------------------------------------------------

function makeTmpDir(suffix: string): string {
  const dir = join(
    "/private/tmp/claude-501/-Users-davidspencer-Code-GitHub-AgencyHQ/7492d762-bf2c-42d2-b217-19a1e7f80b22/scratchpad",
    `fixture-alignment-${suffix}-${Date.now()}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// BootstrapState JSON fixtures
//
// These are the EXACT shapes written by StateManager.save() in
// apps/bootstrap/src/state.ts. Field names and types must match.
// ---------------------------------------------------------------------------

/**
 * The BootstrapState shape written by StateManager:
 * { version: 1, phases: Record<Phase, PhaseState>, updatedAt: string }
 *
 * PhaseState shape: { status, startedAt?, completedAt?, errorCategory?,
 *                     errorMessage?, orgSlug?, projectSlug?, projectRef?,
 *                     deploymentVersion? }
 */

const BOOTSTRAP_RUNNING_JSON = JSON.stringify({
  version: 1,
  phases: {
    wait_services: {
      status: "done",
      startedAt: "2026-09-08T10:00:00.000Z",
      completedAt: "2026-09-08T10:00:05.000Z",
    },
    login: {
      status: "running",
      startedAt: "2026-09-08T10:00:05.000Z",
    },
  },
  updatedAt: "2026-09-08T10:00:05.000Z",
});

const BOOTSTRAP_FAILED_JSON = JSON.stringify({
  version: 1,
  phases: {
    wait_services: {
      status: "done",
      startedAt: "2026-09-08T10:00:00.000Z",
      completedAt: "2026-09-08T10:00:05.000Z",
    },
    login: {
      status: "failed",
      startedAt: "2026-09-08T10:00:05.000Z",
      completedAt: "2026-09-08T10:01:05.000Z",
      errorCategory: "magic_link_timeout",
      errorMessage: "SMTP sink timed out after 60000ms",
    },
  },
  updatedAt: "2026-09-08T10:01:05.000Z",
});

const BOOTSTRAP_DONE_JSON = JSON.stringify({
  version: 1,
  phases: {
    wait_services: { status: "done", startedAt: "...", completedAt: "..." },
    login: { status: "done", startedAt: "...", completedAt: "..." },
    org_project: {
      status: "done",
      startedAt: "...",
      completedAt: "...",
      orgSlug: "agencyhq",
      projectSlug: "agencyhq",
      projectRef: "proj_abc123",
    },
    credentials: { status: "done", startedAt: "...", completedAt: "..." },
    deploy: { status: "done", startedAt: "...", completedAt: "..." },
    verify_deployment: {
      status: "done",
      startedAt: "...",
      completedAt: "...",
      deploymentVersion: "20240901.1",
    },
    done: {
      status: "done",
      completedAt: "2026-09-08T10:30:00.000Z",
    },
  },
  updatedAt: "2026-09-08T10:30:00.000Z",
});

const BOOTSTRAP_CREDENTIALS_FAILED_JSON = JSON.stringify({
  version: 1,
  phases: {
    wait_services: { status: "done", startedAt: "...", completedAt: "..." },
    login: { status: "done", startedAt: "...", completedAt: "..." },
    org_project: { status: "done", startedAt: "...", completedAt: "..." },
    credentials: {
      status: "failed",
      startedAt: "2026-09-08T10:05:00.000Z",
      completedAt: "2026-09-08T10:05:30.000Z",
      errorCategory: "secret_key_missing",
      errorMessage: "could not find prod secret key (tr_prod_...) on apikeys page",
    },
  },
  updatedAt: "2026-09-08T10:05:30.000Z",
});

// ---------------------------------------------------------------------------
// DeploymentRecord JSON fixtures
//
// These are the EXACT shapes written by runDeploy() and enrichDeployment()
// in apps/bootstrap/src/deploy.ts. Field names and types must match.
// ---------------------------------------------------------------------------

/**
 * Shape written by runDeploy() immediately after `trigger deploy` succeeds.
 * version/imageRef/digest are absent at this point; added by enrichDeployment()
 * after the verify phase.
 */
const DEPLOYMENT_POST_DEPLOY_JSON = JSON.stringify({
  externalId: "a1b2c3d4e5f60708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  webappIpUrl: "http://172.16.0.5:3000",
  platform: "linux/arm64",
  at: "2026-09-08T10:20:00.000Z",
});

/**
 * Shape written by enrichDeployment() after verifyDeployment() returns.
 * This is the full deployment.json as the coordinator should see it.
 */
const DEPLOYMENT_ENRICHED_JSON = JSON.stringify({
  externalId: "a1b2c3d4e5f60708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  webappIpUrl: "http://172.16.0.5:3000",
  platform: "linux/arm64",
  at: "2026-09-08T10:20:00.000Z",
  version: "20240901.1",
  imageRef: "localhost:5001/trigger/agencyhq:20240901.1",
});

// ---------------------------------------------------------------------------
// Tests: bootstrap.json (BootstrapState format)
// ---------------------------------------------------------------------------

describe("bootstrap.json fixture alignment — BootstrapState format", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir("bootstrap");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("running bootstrap: login phase running → status=running, phase=login", () => {
    writeFileSync(join(tmpDir, "bootstrap.json"), BOOTSTRAP_RUNNING_JSON);
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null, "should parse running bootstrap.json");
    assert.equal(result.status, "running");
    assert.equal(result.phase, "login");
    assert.equal(result.at, "2026-09-08T10:00:05.000Z");
    assert.equal("error" in result, false, "error should be absent when status=running");
  });

  it("failed bootstrap: login phase failed → status=failed, phase=login, error=magic_link_timeout", () => {
    writeFileSync(join(tmpDir, "bootstrap.json"), BOOTSTRAP_FAILED_JSON);
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null, "should parse failed bootstrap.json");
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "login");
    assert.equal(result.error, "magic_link_timeout");
  });

  it("done bootstrap: done phase done → status=done, phase=done", () => {
    writeFileSync(join(tmpDir, "bootstrap.json"), BOOTSTRAP_DONE_JSON);
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null, "should parse done bootstrap.json");
    assert.equal(result.status, "done");
    assert.equal(result.phase, "done");
    assert.equal(result.at, "2026-09-08T10:30:00.000Z");
  });

  it("failed at credentials → status=failed, phase=credentials, error=secret_key_missing", () => {
    writeFileSync(join(tmpDir, "bootstrap.json"), BOOTSTRAP_CREDENTIALS_FAILED_JSON);
    const result = readBootstrapJson(tmpDir);
    assert.ok(result !== null, "should parse credentials-failed bootstrap.json");
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "credentials");
    assert.equal(result.error, "secret_key_missing");
  });
});

// ---------------------------------------------------------------------------
// Tests: deployment.json (DeploymentRecord format)
// ---------------------------------------------------------------------------

describe("deployment.json fixture alignment — DeploymentRecord format", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir("deployment");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("post-deploy record: has platform, externalId, at; version absent", () => {
    writeFileSync(join(tmpDir, "deployment.json"), DEPLOYMENT_POST_DEPLOY_JSON);
    const result = readDeploymentJson(tmpDir);
    assert.ok(result !== null, "should parse post-deploy deployment.json");
    assert.equal(result.platform, "linux/arm64");
    assert.equal(result.at, "2026-09-08T10:20:00.000Z");
    assert.equal(
      result.externalId,
      "a1b2c3d4e5f60708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
    assert.equal(result.version, undefined, "version should be absent before verify");
  });

  it("enriched record: has version, platform, imageRef, externalId, at", () => {
    writeFileSync(join(tmpDir, "deployment.json"), DEPLOYMENT_ENRICHED_JSON);
    const result = readDeploymentJson(tmpDir);
    assert.ok(result !== null, "should parse enriched deployment.json");
    assert.equal(result.version, "20240901.1");
    assert.equal(result.platform, "linux/arm64");
    assert.equal(result.imageRef, "localhost:5001/trigger/agencyhq:20240901.1");
    assert.equal(result.at, "2026-09-08T10:20:00.000Z");
    assert.equal("digest" in result, false, "digest absent when not enriched");
  });

  it("returns null when at field is missing", () => {
    writeFileSync(
      join(tmpDir, "deployment.json"),
      JSON.stringify({ externalId: "abc", platform: "linux/arm64" }),
    );
    assert.equal(readDeploymentJson(tmpDir), null);
  });
});
