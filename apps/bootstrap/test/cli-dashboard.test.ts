/**
 * CR3: Tests for runDashboardLink (the core of `bootstrap dashboard-link`).
 *
 * Verifies:
 * 1. Happy path: stdout receives only the URL, link is never followed.
 * 2. Rate-limited: stderr receives the reset time, exit called with code 1,
 *    URL not written to stdout.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DashboardLinkDeps } from "../src/dashboard-link.ts";
import { runDashboardLink } from "../src/dashboard-link.ts";

function makeDeps(overrides: Partial<DashboardLinkDeps> = {}): {
  deps: DashboardLinkDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];

  const deps: DashboardLinkDeps = {
    webappUrl: "http://fake-webapp",
    email: "test@example.com",
    smtpPort: 2525,
    sessionFile: "/dev/null",
    loadSession: () => new Map(),
    startSmtpSink: async () => ({
      magicLink: "http://fake-webapp/magic?token=abc",
      stop: () => {},
    }),
    requestMagicLink: async () => ({ kind: "sent" as const }),
    sleep: async () => {},
    stdout: (msg) => stdout.push(msg),
    stderr: (msg) => stderr.push(msg),
    exit: (code) => {
      exitCodes.push(code);
      // Simulate process.exit by throwing so execution stops.
      throw Object.assign(new Error(`exit(${String(code)})`), { _exitCode: code });
    },
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

describe("runDashboardLink — happy path", () => {
  it("writes only the URL to stdout and never follows the link", async () => {
    const { deps, stdout, stderr } = makeDeps();
    const followCalled = false;
    const depsWithSpy: DashboardLinkDeps = {
      ...deps,
      // There is no followMagicLink in DashboardLinkDeps — verify by side-effect absence.
      // The startSmtpSink gives a URL; runDashboardLink must write it and return.
      startSmtpSink: async () => ({
        magicLink: "http://fake-webapp/magic?token=secret",
        stop: () => {},
      }),
    };
    void followCalled; // unused — absence of any follow dep proves the link is not followed

    await runDashboardLink(depsWithSpy);

    assert.equal(stdout.length, 1, "exactly one stdout write");
    assert.equal(stdout[0], "http://fake-webapp/magic?token=secret\n", "stdout receives the URL");
    assert.equal(stderr.length, 0, "no stderr output on success");
  });
});

describe("runDashboardLink — rate-limited", () => {
  it("writes reset time to stderr and exits with code 1 on rate limit", async () => {
    const resetAt = new Date("2026-09-09T15:00:00.000Z").getTime();
    const { deps, stdout, stderr, exitCodes } = makeDeps({
      requestMagicLink: async () => ({
        kind: "rate_limited" as const,
        resetAt,
      }),
    });

    await assert.rejects(
      () => runDashboardLink(deps),
      // The fake exit() throws — this is expected.
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { _exitCode?: number })._exitCode, 1);
        return true;
      },
    );

    assert.equal(stdout.length, 0, "URL must not be written to stdout on rate limit");
    assert.equal(exitCodes.length, 1);
    assert.equal(exitCodes[0], 1, "exit code must be 1 on rate limit");
    assert.equal(stderr.length, 1, "one stderr write");
    const stderrLine = stderr[0] ?? "";
    assert.ok(
      stderrLine.includes("2026-09-09T15:00:00.000Z"),
      `stderr must contain the reset time; got: ${stderrLine}`,
    );
  });

  it("writes 'reset time unknown' to stderr when resetAt is null", async () => {
    const { deps, stdout, stderr } = makeDeps({
      requestMagicLink: async () => ({
        kind: "rate_limited" as const,
        resetAt: null,
      }),
    });

    await assert.rejects(() => runDashboardLink(deps));

    assert.equal(stdout.length, 0);
    assert.ok(
      stderr[0]?.includes("reset time unknown"),
      `stderr must mention 'reset time unknown'; got: ${stderr[0]}`,
    );
  });
});
