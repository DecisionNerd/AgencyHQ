/**
 * CR1 / F2-3: sink rejection is handled when runAll aborts the sink.
 *
 * Drives the real runAll with fakes to verify:
 * 1. When requestMagicLink returns rate_limited: the sink is aborted and its
 *    rejection is handled; no unhandledRejection fires; phase fails with
 *    login_rate_limited.
 * 2. When requestMagicLink throws (network error): the sink is aborted and its
 *    rejection is handled; no unhandledRejection fires; phase fails.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunDeps } from "../src/run.ts";
import { runAll } from "../src/run.ts";
import { StateManager } from "../src/state.ts";

/**
 * Build a fake startSmtpSink that rejects with "aborted" when the signal fires,
 * simulating the real SMTP sink (which rejects on abort).
 */
function makeAbortingSink(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

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
    magicLinkThrottleMs: 0,
    sessionFile: join(stateDir, "session.json"),
    secretProdKey: "trigger-prod.key",
    secretPAT: "trigger-pat.key",
    waitForReadiness: async () => {},
    startSmtpSink: async (_opts) => ({
      magicLink: "http://fake/magic",
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

describe("CR1/F2-3 — sink rejection handled when rate_limited", () => {
  it("no unhandledRejection when runAll aborts the sink on rate_limited", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "sink-rl-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "sink-rl-secrets-"));
    try {
      const unhandled: unknown[] = [];
      const handler = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", handler);

      const deps = makeDeps(stateDir, secretsDir, {
        // Sink rejects on abort (like the real smtp-sink).
        startSmtpSink: async (opts) => {
          makeAbortingSink(opts.signal).catch(() => {});
          // Return a proxy so callers can call .catch / await on the sink promise.
          return makeAbortingSink(opts.signal) as unknown as {
            magicLink: string;
            stop: () => void;
          };
        },
        requestMagicLink: async () => ({
          kind: "rate_limited" as const,
          resetAt: Date.now() + 60_000,
        }),
      });

      await assert.rejects(
        () => runAll(deps),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(
            (err as { errorCategory?: string }).errorCategory,
            "login_rate_limited",
            "phase must fail with login_rate_limited",
          );
          return true;
        },
      );

      // Give microtasks a chance to fire any unhandled rejection.
      await new Promise((r) => setImmediate(r));
      process.off("unhandledRejection", handler);

      assert.equal(
        unhandled.length,
        0,
        `unhandled rejections must be zero; got: ${String(unhandled[0])}`,
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});

describe("CR1/F2-3 — sink rejection handled when requestMagicLink throws", () => {
  it("no unhandledRejection when requestMagicLink throws a network error", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "sink-net-state-"));
    const secretsDir = mkdtempSync(join(tmpdir(), "sink-net-secrets-"));
    try {
      const unhandled: unknown[] = [];
      const handler = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", handler);

      let abortSignalPassed: AbortSignal | undefined;
      const deps = makeDeps(stateDir, secretsDir, {
        startSmtpSink: async (opts) => {
          abortSignalPassed = opts.signal;
          // Return a never-resolving promise that rejects on abort (real sink behaviour).
          return makeAbortingSink(opts.signal) as unknown as {
            magicLink: string;
            stop: () => void;
          };
        },
        requestMagicLink: async () => {
          throw new Error("network error: connection refused");
        },
      });

      await assert.rejects(() => runAll(deps), /network error/);

      // Give microtasks a chance to fire any unhandled rejection.
      await new Promise((r) => setImmediate(r));
      process.off("unhandledRejection", handler);

      // The abort signal must have been triggered (run.ts aborted the sink).
      assert.ok(
        abortSignalPassed?.aborted,
        "abort signal must be triggered after requestMagicLink throws",
      );

      assert.equal(
        unhandled.length,
        0,
        `unhandled rejections must be zero; got: ${String(unhandled[0])}`,
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});
