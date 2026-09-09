/**
 * Full happy-path test for the bootstrap phase machine using a fake webapp
 * server and fake trigger binary.
 *
 * Uses node:test + node:assert/strict; no third-party dependencies.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { computeExternalId } from "../src/deploy.ts";
import { StateManager } from "../src/state.ts";
import {
  findOrCreateOrgProject,
  mintPAT,
  readProdSecretKey,
  waitForReadiness,
} from "../src/trigger-web.ts";
import { verifyDeployment } from "../src/verify.ts";
import type { FakeWebapp } from "./helpers/fake-webapp.ts";
import { FAKE, startFakeWebapp } from "./helpers/fake-webapp.ts";

// ── Happy path ────────────────────────────────────────────────────────────────

describe("phase machine — happy path", () => {
  let webapp: FakeWebapp;
  let stateDir: string;
  let secretsDir: string;
  let sm: StateManager;

  before(async () => {
    webapp = await startFakeWebapp();
    stateDir = mkdtempSync(join(tmpdir(), "bootstrap-state-"));
    secretsDir = mkdtempSync(join(tmpdir(), "bootstrap-secrets-"));
    sm = new StateManager(stateDir, secretsDir);
  });

  after(async () => {
    await webapp.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it("wait_services: webapp is reachable", async () => {
    await assert.doesNotReject(waitForReadiness(webapp.url, 5000));
  });

  it("state is initially empty", () => {
    const state = sm.load();
    assert.equal(state.version, 1);
    assert.deepEqual(state.phases, {});
  });

  it("org_project: finds or creates org and project", async () => {
    const jar = new Map<string, string>();
    const result = await findOrCreateOrgProject(webapp.url, "agencyhq", "agencyhq", jar);
    assert.ok(result.orgSlug.startsWith("agencyhq"));
    assert.ok(result.projectSlug.startsWith("agencyhq"));
    assert.match(result.projectRef, /^proj_/);
  });

  it("credentials: reads prod secret key", async () => {
    const jar = new Map<string, string>();
    // Simulate login by visiting the fake magic route.
    await fetch(`${webapp.url}/magic/test`, { redirect: "follow" });
    // Read prod key.
    const key = await readProdSecretKey(webapp.url, FAKE.ORG_SLUG, FAKE.PROJECT_SLUG, jar);
    assert.equal(key, FAKE.PROD_KEY);
    // Store and verify.
    sm.writeSecret("trigger-prod-key", key);
    assert.equal(sm.readSecret("trigger-prod-key"), FAKE.PROD_KEY);
  });

  it("credentials: mints PAT on first call", async () => {
    const jar = new Map<string, string>();
    const pat = await mintPAT(webapp.url, "agencyhq-bootstrap", jar);
    assert.equal(pat, FAKE.PAT);
    sm.writeSecret("trigger-pat", pat);
    assert.equal(sm.readSecret("trigger-pat"), FAKE.PAT);
  });

  it("state machine: setRunning / setDone / isDone round-trip", () => {
    const state = sm.load();
    sm.setRunning(state, "org_project");
    assert.equal(state.phases.org_project?.status, "running");
    sm.setDone(state, "org_project", {
      orgSlug: FAKE.ORG_SLUG,
      projectSlug: FAKE.PROJECT_SLUG,
      projectRef: FAKE.PROJECT_REF,
    });
    assert.equal(state.phases.org_project?.status, "done");
    assert.ok(sm.isDone(state, "org_project"));
  });

  it("state machine: setFailed records category and message", () => {
    const state = sm.load();
    sm.setFailed(state, "deploy", "deploy_failed", "trigger deploy exited 1");
    assert.equal(state.phases.deploy?.status, "failed");
    assert.equal(state.phases.deploy?.errorCategory, "deploy_failed");
    assert.match(state.phases.deploy?.errorMessage ?? "", /exited 1/);
  });

  it("secrets: write/read/has round-trip", () => {
    sm.writeSecret("test-secret", "myvalue");
    assert.ok(sm.hasSecret("test-secret"));
    assert.equal(sm.readSecret("test-secret"), "myvalue");
    assert.equal(sm.readSecret("nonexistent-secret"), null);
    assert.ok(!sm.hasSecret("nonexistent-secret"));
  });

  it("state file contains no tr_ token values", () => {
    const state = sm.load();
    sm.setDone(state, "credentials");
    const stateJson = JSON.stringify(state);
    // Must not contain any Trigger token value patterns.
    assert.doesNotMatch(stateJson, /tr_[a-z]*_[A-Za-z0-9]{8,}/);
  });
});

// ── verify that org creation count is tracked ────────────────────────────────

describe("fake webapp — org and project creation tracking", () => {
  it("tracks orgs and projects created", async () => {
    const webapp = await startFakeWebapp();
    try {
      const jar = new Map<string, string>();
      await findOrCreateOrgProject(webapp.url, "agencyhq", "agencyhq", jar);
      assert.equal(webapp.state.orgsCreated.length, 1);
      assert.equal(webapp.state.projectsCreated.length, 1);
    } finally {
      await webapp.stop();
    }
  });

  it("reuses existing org and project without duplicating", async () => {
    // Pre-seed with the same mixed-case slugs the fake webapp produces on creation.
    const webapp = await startFakeWebapp({
      existingOrgSlug: FAKE.ORG_SLUG,
      existingProjectSlug: FAKE.PROJECT_SLUG,
    });
    try {
      const jar = new Map<string, string>();
      // Dashboard shows the existing org/project, so nothing new is created.
      const result = await findOrCreateOrgProject(webapp.url, "agencyhq", "agencyhq", jar);
      assert.ok(result.orgSlug.startsWith("agencyhq"));
      assert.ok(result.projectSlug.startsWith("agencyhq"));
      // No new creation should have happened.
      assert.equal(webapp.state.orgsCreated.length, 1); // only the pre-seeded one
    } finally {
      await webapp.stop();
    }
  });
});

// ── State machine idempotency ─────────────────────────────────────────────────

describe("state machine — idempotency", () => {
  it("isDone returns true only after setDone", () => {
    const sd = mkdtempSync(join(tmpdir(), "idem-state-"));
    const sc = mkdtempSync(join(tmpdir(), "idem-secrets-"));
    const sm2 = new StateManager(sd, sc);
    const state = sm2.load();
    assert.ok(!sm2.isDone(state, "login"));
    sm2.setRunning(state, "login");
    assert.ok(!sm2.isDone(state, "login"));
    sm2.setDone(state, "login");
    assert.ok(sm2.isDone(state, "login"));
    // Reload from disk — still done.
    const reloaded = sm2.load();
    assert.ok(sm2.isDone(reloaded, "login"));
    rmSync(sd, { recursive: true, force: true });
    rmSync(sc, { recursive: true, force: true });
  });

  it("phases start as pending when not set", () => {
    const sd = mkdtempSync(join(tmpdir(), "pending-state-"));
    const sc = mkdtempSync(join(tmpdir(), "pending-secrets-"));
    const sm2 = new StateManager(sd, sc);
    const state = sm2.load();
    assert.equal(sm2.getPhase(state, "deploy").status, "pending");
    rmSync(sd, { recursive: true, force: true });
    rmSync(sc, { recursive: true, force: true });
  });
});

// ── Verify phase unit test ────────────────────────────────────────────────────

describe("verify phase — HTTP client", () => {
  it("parses deployment info from fake webapp response", async () => {
    const webapp = await startFakeWebapp();
    try {
      const info = await verifyDeployment(webapp.url, FAKE.PROD_KEY);
      assert.equal(info.status, "DEPLOYED");
      assert.equal(info.version, "v1");
    } finally {
      await webapp.stop();
    }
  });
});

// ── Compute external-id is deterministic ─────────────────────────────────────

describe("computeExternalId", () => {
  it("produces the same hash for the same file tree", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "exid-"));
    try {
      // Create a minimal trigger/ directory with known content.
      mkdirSync(join(workspaceRoot, "trigger"));
      writeFileSync(join(workspaceRoot, "trigger", "trigger.config.ts"), "export default {};");
      writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

      const id1 = computeExternalId(workspaceRoot);
      const id2 = computeExternalId(workspaceRoot);
      assert.equal(id1, id2);
      assert.match(id1, /^[0-9a-f]{64}$/);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("produces a different hash when a file changes", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "exid-diff-"));
    try {
      mkdirSync(join(workspaceRoot, "trigger"));
      writeFileSync(join(workspaceRoot, "trigger", "trigger.config.ts"), "v1");
      writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "v1");
      const id1 = computeExternalId(workspaceRoot);

      writeFileSync(join(workspaceRoot, "trigger", "trigger.config.ts"), "v2");
      const id2 = computeExternalId(workspaceRoot);
      assert.notEqual(id1, id2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
