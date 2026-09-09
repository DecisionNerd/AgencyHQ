/**
 * Deploy failure classification and CLI output capture.
 *
 * - classifyDeployFailure() maps the webapp's "already in progress" rejection
 *   (an interrupted build of the same external id) to deploy_in_progress and
 *   everything else to deploy_failed.
 * - runTriggerCli() streams output and returns the exit status with the
 *   output tail; a missing binary surfaces as status null, never a throw.
 *
 * Observed 2026-09-09 (L1): a bootstrap killed mid-build could not resume
 * until the webapp's DEPLOY_TIMEOUT_MS elapsed; the CLI's --force retry path
 * depends on this classification.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyDeployFailure, runTriggerCli } from "../src/deploy.ts";

describe("classifyDeployFailure", () => {
  it("recognises the webapp's in-progress rejection", () => {
    const tail =
      'X Error: Failed to start deployment: A deployment for external id "d39…" is already in progress (version 20260909.3). Wait for it to finish, or deploy again with --force to cancel it and start a new one.';
    assert.equal(classifyDeployFailure(tail), "deploy_in_progress");
  });

  it("treats any other failure as deploy_failed", () => {
    assert.equal(
      classifyDeployFailure("ERROR: failed to build: connection refused"),
      "deploy_failed",
    );
    assert.equal(classifyDeployFailure(""), "deploy_failed");
  });
});

describe("runTriggerCli", () => {
  it("returns the exit status and the captured output tail", async () => {
    const r = await runTriggerCli(
      "/bin/sh",
      ["-c", "echo out-line; echo err-line >&2; exit 3"],
      process.cwd(),
      process.env,
    );
    assert.equal(r.status, 3);
    assert.match(r.tail, /out-line/);
    assert.match(r.tail, /err-line/);
  });

  it("surfaces a missing binary as status null with the error in the tail", async () => {
    const r = await runTriggerCli("/nonexistent/trigger-cli", [], process.cwd(), process.env);
    assert.equal(r.status, null);
    assert.match(r.tail, /process error/);
  });
});
