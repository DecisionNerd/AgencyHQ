/**
 * Tests for StateManager atomic persist and corrupt-file tolerance (CR2).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StateManager } from "../src/state.ts";

describe("StateManager — atomic persist", () => {
  let stateDir: string;
  let secretsDir: string;

  before(() => {
    stateDir = mkdtempSync(join(tmpdir(), "sm-atomic-state-"));
    secretsDir = mkdtempSync(join(tmpdir(), "sm-atomic-secrets-"));
  });

  after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it("save writes atomically — bak matches previous save", () => {
    const sm = new StateManager(stateDir, secretsDir);
    // First save
    const state1 = sm.load();
    sm.setDone(state1, "wait_services");
    // Second save
    const state2 = sm.load();
    sm.setDone(state2, "login");

    // bak should contain the state after the first save (wait_services done, login not yet done)
    const bakPath = join(stateDir, "bootstrap.json.bak");
    assert.ok(existsSync(bakPath), ".bak file should exist after second save");
    const bakRaw = readFileSync(bakPath, "utf-8");
    const bak = JSON.parse(bakRaw);
    assert.equal(bak.phases.wait_services?.status, "done");
    assert.equal(bak.phases.login, undefined);
  });
});

describe("StateManager — corrupt JSON tolerance", () => {
  it("corrupt main file falls back to .bak", () => {
    const stateDir2 = mkdtempSync(join(tmpdir(), "sm-corrupt-bak-"));
    const secretsDir2 = mkdtempSync(join(tmpdir(), "sm-corrupt-bak-s-"));
    try {
      const sm = new StateManager(stateDir2, secretsDir2);
      // First save creates main file
      const state = sm.load();
      sm.setDone(state, "wait_services");
      // Second save creates .bak (= first save's content: wait_services done)
      const state2 = sm.load();
      sm.setDone(state2, "login");
      // Now corrupt the main file (which has wait_services+login done)
      writeFileSync(join(stateDir2, "bootstrap.json"), "NOT JSON!!!", "utf-8");
      // load() should fall back to .bak (wait_services done, login not yet done)
      const loaded = sm.load();
      assert.equal(
        loaded.phases.wait_services?.status,
        "done",
        "bak state should have wait_services done",
      );
      assert.equal(loaded.phases.login, undefined, "bak should not have login (only first save)");
    } finally {
      rmSync(stateDir2, { recursive: true, force: true });
      rmSync(secretsDir2, { recursive: true, force: true });
    }
  });

  it("corrupt main file and corrupt bak → returns empty state (no throw)", () => {
    const stateDir3 = mkdtempSync(join(tmpdir(), "sm-corrupt-both-"));
    const secretsDir3 = mkdtempSync(join(tmpdir(), "sm-corrupt-both-s-"));
    try {
      const sm = new StateManager(stateDir3, secretsDir3);
      // Write both files as corrupt
      writeFileSync(join(stateDir3, "bootstrap.json"), "CORRUPT", "utf-8");
      writeFileSync(join(stateDir3, "bootstrap.json.bak"), "ALSO CORRUPT", "utf-8");
      // Should not throw, should return empty state
      const loaded = sm.load();
      assert.equal(Object.keys(loaded.phases).length, 0, "phases should be empty");
      assert.equal(loaded.version, 1, "version should be 1");
    } finally {
      rmSync(stateDir3, { recursive: true, force: true });
      rmSync(secretsDir3, { recursive: true, force: true });
    }
  });

  it("corrupt main file with no bak → returns empty state (no throw)", () => {
    const stateDir4 = mkdtempSync(join(tmpdir(), "sm-corrupt-nobak-"));
    const secretsDir4 = mkdtempSync(join(tmpdir(), "sm-corrupt-nobak-s-"));
    try {
      const sm = new StateManager(stateDir4, secretsDir4);
      writeFileSync(join(stateDir4, "bootstrap.json"), "CORRUPT", "utf-8");
      // No .bak file
      const loaded = sm.load();
      assert.equal(Object.keys(loaded.phases).length, 0, "phases should be empty");
    } finally {
      rmSync(stateDir4, { recursive: true, force: true });
      rmSync(secretsDir4, { recursive: true, force: true });
    }
  });
});
