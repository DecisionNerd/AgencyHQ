/**
 * Redeploy rule: a completed deploy phase is only current while
 * deployment.json carries the external id of the present toolchain.
 *
 * - deploymentIsCurrent() is false without a record, false when the record's
 *   external id differs from the workspace hash, true when it matches.
 * - StateManager.reopen() turns done phases back to pending (and leaves other
 *   statuses alone) so the CLI repeats deploy, verify_deployment and done.
 *
 * Observed 2026-09-09 (L1): after a toolchain change the bootstrap rerun
 * skipped "deploy — already done" and the stale image stayed deployed.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { computeExternalId, deploymentIsCurrent } from "../src/deploy.ts";
import { StateManager } from "../src/state.ts";

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "redeploy-ws-"));
  mkdirSync(join(root, "trigger", "src"), { recursive: true });
  writeFileSync(join(root, "trigger", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

describe("deploymentIsCurrent", () => {
  it("is false without a deployment record", () => {
    const root = makeWorkspace();
    const stateDir = mkdtempSync(join(tmpdir(), "redeploy-state-"));
    try {
      assert.equal(deploymentIsCurrent(root, stateDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("is true when the record carries the workspace external id and false after a toolchain change", () => {
    const root = makeWorkspace();
    const stateDir = mkdtempSync(join(tmpdir(), "redeploy-state-"));
    try {
      const externalId = computeExternalId(root);
      writeFileSync(
        join(stateDir, "deployment.json"),
        JSON.stringify({ externalId, platform: "linux/arm64", at: "2026-09-09T00:00:00Z" }),
      );
      assert.equal(deploymentIsCurrent(root, stateDir), true);

      writeFileSync(join(root, "trigger", "src", "a.ts"), "export const a = 2;\n");
      assert.notEqual(computeExternalId(root), externalId, "toolchain change yields a new id");
      assert.equal(deploymentIsCurrent(root, stateDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("StateManager.reopen", () => {
  it("turns done phases back to pending, persists, and leaves other statuses untouched", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "reopen-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "reopen-secrets-"));
    const sm = new StateManager(stateDir, secretsDir);
    const state = sm.load();
    try {
      sm.setDone(state, "credentials");
      sm.setDone(state, "deploy", { deploymentVersion: "20260909.14" });
      sm.setDone(state, "verify_deployment");
      sm.setDone(state, "done");
      sm.setRunning(state, "login");

      sm.reopen(state, ["deploy", "verify_deployment", "done", "login"]);

      assert.equal(state.phases.deploy?.status, "pending");
      assert.equal(state.phases.deploy?.deploymentVersion, undefined);
      assert.equal(state.phases.verify_deployment?.status, "pending");
      assert.equal(state.phases.done?.status, "pending");
      assert.equal(state.phases.login?.status, "running", "non-done phases are left alone");
      assert.equal(state.phases.credentials?.status, "done", "phases not listed stay done");

      const reloaded = sm.load();
      assert.ok(!sm.isDone(reloaded, "deploy"));
      assert.ok(sm.isDone(reloaded, "credentials"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});
