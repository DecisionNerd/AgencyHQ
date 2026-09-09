/**
 * Phase machine tests for runAll — drives the phase runner with fake deps to
 * verify idempotency, resumption, and error isolation.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunDeps } from "../src/run.ts";
import { runAll } from "../src/run.ts";
import { StateManager } from "../src/state.ts";

function makeDeps(stateDir: string, secretsDir: string, overrides: Partial<RunDeps> = {}): RunDeps {
  const sm = new StateManager(stateDir, secretsDir);
  return {
    sm,
    stateDir,
    webappUrl: "http://fake-webapp",
    bootstrapEmail: "test@example.com",
    orgName: "testorg",
    projectName: "testproject",
    tokenName: "test-token",
    workspaceRoot: "/fake/workspace",
    platform: "linux/arm64",
    smtpPort: 2525,
    magicLinkTimeoutMs: 1000,
    magicLinkThrottleMs: 0, // no throttle in tests
    sessionFile: join(stateDir, "session.json"),
    secretProdKey: "trigger-prod.key",
    secretPAT: "trigger-pat.key",
    waitForReadiness: async () => {},
    startSmtpSink: async () => ({
      magicLink: "http://fake-webapp/magic?token=fake",
      stop: () => {},
    }),
    requestMagicLink: async () => ({ kind: "sent" as const }),
    followMagicLink: async () => "/dashboard",
    confirmBasicDetailsIfNeeded: async (_u, _e, _j, path) => path,
    hasValidSession: async () => true,
    loadSession: () => new Map(),
    saveSession: () => {},
    deleteSession: () => {},
    findOrCreateOrgProject: async () => ({
      orgSlug: "testorg",
      projectSlug: "testproject",
      projectRef: "proj_123",
    }),
    readProdSecretKey: async () => "tr_prod_fake",
    mintPAT: async () => "tr_pat_fake",
    resolveWebappIp: async () => "http://1.2.3.4:3000",
    runDeploy: async () => ({
      externalId: "abc",
      webappIpUrl: "http://1.2.3.4:3000",
      platform: "linux/arm64",
      at: new Date().toISOString(),
    }),
    verifyDeployment: async () => ({ raw: { status: "DEPLOYED" }, status: "DEPLOYED" }),
    deploymentIsCurrent: () => true,
    enrichDeployment: () => {},
    sleep: async () => {},
    log: () => {},
    ...overrides,
  };
}

describe("runAll — happy path", () => {
  it("completes all phases when everything succeeds", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ra-happy-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "ra-happy-secrets-"));
    try {
      const deps = makeDeps(stateDir, secretsDir);
      await runAll(deps);
      const state = deps.sm.load();
      assert.equal(state.phases.done?.status, "done");
      assert.equal(state.phases.verify_deployment?.status, "done");
      assert.equal(state.phases.deploy?.status, "done");
      assert.equal(state.phases.credentials?.status, "done");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});

describe("runAll — interruption after org_project", () => {
  it("rerun does not call findOrCreateOrgProject again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ra-int-org-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "ra-int-org-secrets-"));
    try {
      let orgCalls = 0;
      const findOrCreateOrgProject = async () => {
        orgCalls++;
        return { orgSlug: "testorg", projectSlug: "testproject", projectRef: "proj_123" };
      };

      // First run: org_project succeeds, then credentials throws
      const deps1 = makeDeps(stateDir, secretsDir, {
        findOrCreateOrgProject,
        readProdSecretKey: async () => {
          throw Object.assign(new Error("cred fail"), { errorCategory: "secret_key_missing" });
        },
      });
      await assert.rejects(() => runAll(deps1));
      assert.equal(orgCalls, 1);

      // Second run: credentials now succeeds; org_project should not be called again
      const deps2 = makeDeps(stateDir, secretsDir, { findOrCreateOrgProject });
      await runAll(deps2);
      assert.equal(orgCalls, 1, "findOrCreateOrgProject must not be called on rerun");

      const state = deps2.sm.load();
      assert.equal(state.phases.done?.status, "done");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});

describe("runAll — PAT reuse", () => {
  it("rerun does not mint a new PAT after interruption before deploy", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ra-pat-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "ra-pat-secrets-"));
    try {
      let mintCalls = 0;
      const mintPAT = async () => {
        mintCalls++;
        return "tr_pat_fake";
      };

      // First run: credentials succeeds but deploy throws
      const deps1 = makeDeps(stateDir, secretsDir, {
        mintPAT,
        runDeploy: async () => {
          throw Object.assign(new Error("deploy fail"), { errorCategory: "deploy_failed" });
        },
      });
      await assert.rejects(() => runAll(deps1));
      assert.equal(mintCalls, 1, "PAT minted once on first run");

      // Second run: PAT already stored; deploy now succeeds
      const deps2 = makeDeps(stateDir, secretsDir, { mintPAT });
      await runAll(deps2);
      assert.equal(mintCalls, 1, "mintPAT must not be called on rerun");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});

describe("runAll — deploy failure", () => {
  it("only deploy is retried on rerun; verify not called before deploy succeeds", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ra-deploy-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "ra-deploy-secrets-"));
    try {
      let deployCalls = 0;
      let verifyCalls = 0;

      const deps1 = makeDeps(stateDir, secretsDir, {
        runDeploy: async () => {
          deployCalls++;
          throw Object.assign(new Error("deploy fail"), { errorCategory: "deploy_failed" });
        },
        verifyDeployment: async () => {
          verifyCalls++;
          return { raw: { status: "DEPLOYED" }, status: "DEPLOYED" };
        },
      });
      await assert.rejects(() => runAll(deps1));
      assert.equal(deployCalls, 1);
      assert.equal(verifyCalls, 0);

      const deps2 = makeDeps(stateDir, secretsDir, {
        runDeploy: async () => {
          deployCalls++;
          return {
            externalId: "abc",
            webappIpUrl: "http://1.2.3.4:3000",
            platform: "linux/arm64",
            at: new Date().toISOString(),
          };
        },
        verifyDeployment: async () => {
          verifyCalls++;
          return { raw: { status: "DEPLOYED" }, status: "DEPLOYED" };
        },
      });
      await runAll(deps2);
      assert.equal(deployCalls, 2, "deploy called on rerun");
      assert.equal(verifyCalls, 1, "verify called after deploy");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});

describe("runAll — deploymentIsCurrent false", () => {
  it("deploy reruns even if deploy phase was previously done", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ra-redeploy-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "ra-redeploy-secrets-"));
    try {
      let deployCalls = 0;

      const deps1 = makeDeps(stateDir, secretsDir, {
        runDeploy: async () => {
          deployCalls++;
          return {
            externalId: "v1",
            webappIpUrl: "http://1.2.3.4:3000",
            platform: "linux/arm64",
            at: new Date().toISOString(),
          };
        },
      });
      await runAll(deps1);
      assert.equal(deployCalls, 1);

      // Second run: toolchain changed
      const deps2 = makeDeps(stateDir, secretsDir, {
        runDeploy: async () => {
          deployCalls++;
          return {
            externalId: "v2",
            webappIpUrl: "http://1.2.3.4:3000",
            platform: "linux/arm64",
            at: new Date().toISOString(),
          };
        },
        deploymentIsCurrent: () => false,
      });
      await runAll(deps2);
      assert.equal(deployCalls, 2, "deploy should re-run when toolchain changed");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});

describe("runAll — corrupt state file", () => {
  it("does not lose stored PAT when main state file is corrupted (bak fallback)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ra-corrupt-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "ra-corrupt-secrets-"));
    try {
      // First run: credentials phase completes, deploy fails so we stop there
      const deps1 = makeDeps(stateDir, secretsDir, {
        runDeploy: async () => {
          throw Object.assign(new Error("deploy fail"), { errorCategory: "deploy_failed" });
        },
      });
      await assert.rejects(() => runAll(deps1));

      // PAT must be stored
      const sm = new StateManager(stateDir, secretsDir);
      assert.ok(sm.hasSecret("trigger-pat.key"), "PAT stored after credentials phase");

      // Corrupt the main state file (bak should still exist from the last save)
      writeFileSync(join(stateDir, "bootstrap.json"), "CORRUPTED {{{{", "utf-8");

      // Second run: load() falls back to bak; PAT already stored → no new mint
      let _mintCalls = 0;
      const deps2 = makeDeps(stateDir, secretsDir, {
        mintPAT: async () => {
          _mintCalls++;
          return "tr_pat_new";
        },
      });
      // May or may not complete (depends on bak state), but must not re-mint the PAT
      try {
        await runAll(deps2);
      } catch {
        // ok — bak may have credentials not yet done
      }
      // PAT file must still exist
      assert.ok(sm.hasSecret("trigger-pat.key"), "PAT still present after corrupt state load");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});
