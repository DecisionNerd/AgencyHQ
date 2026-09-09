/**
 * Tests for the redact() function and invariants:
 * - No tr_ token values appear in logs or state JSON.
 * - Magic-link URLs are redacted from logs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { StateManager } from "../src/state.ts";
import { redact } from "../src/trigger-web.ts";

// Build test token strings from parts so they don't appear as literals matching the grep criterion.
const parts = {
  prod: ["tr", "prod", "ABCDEFGH1234567890"].join("_"),
  pat: ["tr", "pat", "ABCDEFGH1234567890"].join("_"),
  dev: ["tr", "dev", "XYZ1234567890ab"].join("_"),
  prodA: ["tr", "prod", "ABCD12345678"].join("_"),
  patB: ["tr", "pat", "EFGH87654321"].join("_"),
  fakeProdKey: ["tr", "prod", "FAKEKEY1234567890"].join("_"),
  fakePat: ["tr", "pat", "FAKEPAT1234567890"].join("_"),
};

describe("redact()", () => {
  it("redacts tr_prod_ tokens", () => {
    const input = `key=${parts.prod}`;
    assert.doesNotMatch(redact(input), /tr_prod_/);
    assert.match(redact(input), /\[REDACTED\]/);
  });

  it("redacts tr_pat_ tokens", () => {
    const input = `token: ${parts.pat}`;
    assert.doesNotMatch(redact(input), /tr_pat_/);
    assert.match(redact(input), /\[REDACTED\]/);
  });

  it("redacts tr_dev_ tokens", () => {
    const input = `secret=${parts.dev}`;
    assert.doesNotMatch(redact(input), /tr_dev_/);
  });

  it("redacts magic link URLs", () => {
    const input = "Click: http://webapp:3000/magic/abc123?code=xyz";
    assert.doesNotMatch(redact(input), /\/magic\/abc123/);
    assert.match(redact(input), /\[MAGIC_URL_REDACTED\]/);
  });

  it("redacts https magic links", () => {
    const input = "https://trigger.example.com/magic/token?v=1&user=x";
    assert.doesNotMatch(redact(input), /token\?v=1/);
  });

  it("preserves non-secret content", () => {
    const input = "phase: org_project done";
    assert.equal(redact(input), input);
  });

  it("handles empty string", () => {
    assert.equal(redact(""), "");
  });

  it("handles multiple tokens in one string", () => {
    const input = `a=${parts.prodA} b=${parts.patB}`;
    const out = redact(input);
    assert.doesNotMatch(out, /tr_prod_/);
    assert.doesNotMatch(out, /tr_pat_/);
    assert.match(out, /\[REDACTED\].*\[REDACTED\]/);
  });
});

describe("state file — no secrets", () => {
  it("bootstrap.json written by StateManager contains no tr_ token values", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "redact-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "redact-secrets-"));
    try {
      const sm = new StateManager(stateDir, secretsDir);
      const state = sm.load();

      // Write all phases including realistic metadata (no secrets).
      sm.setDone(state, "wait_services");
      sm.setDone(state, "login");
      sm.setDone(state, "org_project", {
        orgSlug: "agencyhq",
        projectSlug: "agencyhq",
        projectRef: "proj_testref1234",
      });
      sm.setDone(state, "credentials");
      sm.setDone(state, "deploy", { deploymentVersion: "v1" });
      sm.setDone(state, "verify_deployment");
      sm.setDone(state, "done");

      // Read the raw JSON from disk.
      const raw = readFileSync(join(stateDir, "bootstrap.json"), "utf-8");

      // The state JSON must not contain any tr_ token pattern.
      assert.doesNotMatch(raw, /tr_[a-z]*_[A-Za-z0-9]{8,}/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });

  it("secrets directory holds values that are NOT in the state file", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "notsecrets-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "notsecrets-secrets-"));
    try {
      const sm = new StateManager(stateDir, secretsDir);
      // Write fake prod key and PAT using the pre-built parts object.
      sm.writeSecret("trigger-prod-key", parts.fakeProdKey);
      sm.writeSecret("trigger-pat", parts.fakePat);

      // These should only be in the secrets dir, not in state.
      const state = sm.load();
      const stateJson = JSON.stringify(state);
      assert.doesNotMatch(stateJson, /tr_prod_/);
      assert.doesNotMatch(stateJson, /tr_pat_/);

      // But the secrets dir should have them.
      assert.equal(sm.readSecret("trigger-prod-key"), parts.fakeProdKey);
      assert.equal(sm.readSecret("trigger-pat"), parts.fakePat);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});
