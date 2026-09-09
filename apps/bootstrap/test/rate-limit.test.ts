/**
 * Tests for magic-link rate-limit detection and exponential backoff.
 *
 * Evidence (2026-09-09): Trigger.dev v4.5.16 webapp rate-limits POST /login/magic
 * per email address — its log prints
 *   {"limit":30,"reset":<epoch ms>,"remaining":0,"identifier":"<email>"}
 * and answers 302 to /login without sending mail.  The bootstrap must recognise
 * this and back off instead of hammering.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startSmtpSink } from "../src/smtp-sink.ts";
import type { BootstrapState } from "../src/state.ts";
import { StateManager } from "../src/state.ts";
import { createJar, requestMagicLink } from "../src/trigger-web.ts";
import { startFakeWebapp } from "./helpers/fake-webapp.ts";

// ── Rate-limit detection via headers ─────────────────────────────────────────

describe("requestMagicLink — rate-limit header detection", () => {
  it("returns rate_limited when x-ratelimit-remaining: 0", async () => {
    const webapp = await startFakeWebapp({ rateLimitMagicLink: true });
    try {
      const jar = createJar();
      const result = await requestMagicLink(webapp.url, "test@example.com", jar);
      assert.equal(result.kind, "rate_limited");
    } finally {
      await webapp.stop();
    }
  });

  it("rate_limited result carries resetAt from x-ratelimit-reset (epoch-ms)", async () => {
    const resetMs = Date.now() + 3_600_000; // 1 hour from now
    const webapp = await startFakeWebapp({ rateLimitMagicLink: resetMs });
    try {
      const jar = createJar();
      const result = await requestMagicLink(webapp.url, "test@example.com", jar);
      assert.equal(result.kind, "rate_limited");
      assert.ok(result.kind === "rate_limited"); // narrowing for TS
      assert.ok(result.resetAt !== null, "resetAt should be set from x-ratelimit-reset");
      // Allow a small tolerance (test execution time).
      assert.ok(
        Math.abs((result.resetAt ?? 0) - resetMs) < 2000,
        `resetAt ${result.resetAt} should be close to ${resetMs}`,
      );
    } finally {
      await webapp.stop();
    }
  });

  it("returns sent when magic link is accepted (normal 302 → /)", async () => {
    const webapp = await startFakeWebapp();
    try {
      const jar = createJar();
      const result = await requestMagicLink(webapp.url, "test@example.com", jar);
      assert.equal(result.kind, "sent");
    } finally {
      await webapp.stop();
    }
  });

  it("increments webapp.state.rateLimitedRequests on rate-limit", async () => {
    const webapp = await startFakeWebapp({ rateLimitMagicLink: true });
    try {
      const jar = createJar();
      await requestMagicLink(webapp.url, "test@example.com", jar);
      assert.equal(webapp.state.rateLimitedRequests, 1);
    } finally {
      await webapp.stop();
    }
  });

  it("does NOT increment rateLimitedRequests on a normal request", async () => {
    const webapp = await startFakeWebapp();
    try {
      const jar = createJar();
      await requestMagicLink(webapp.url, "test@example.com", jar);
      assert.equal(webapp.state.rateLimitedRequests, 0);
    } finally {
      await webapp.stop();
    }
  });
});

// ── SMTP sink not waited on rate-limit ────────────────────────────────────────

describe("SMTP sink abort on rate-limit", () => {
  it("AbortController aborts the SMTP sink before its timeout", async () => {
    const abort = new AbortController();
    const SHORT_TIMEOUT_MS = 10_000; // 10 s — would be a long wait without abort
    const sinkPromise = startSmtpSink({
      port: 0,
      timeoutMs: SHORT_TIMEOUT_MS,
      signal: abort.signal,
    });

    // Abort immediately — simulating what happens when requestMagicLink returns rate_limited.
    abort.abort();

    await assert.rejects(sinkPromise, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("aborted"),
        `expected 'aborted' in error message, got: ${err.message}`,
      );
      return true;
    });
  });

  it("already-aborted signal rejects the sink promise immediately", async () => {
    const abort = new AbortController();
    abort.abort(); // abort BEFORE creating the sink

    const sinkPromise = startSmtpSink({ port: 0, timeoutMs: 30_000, signal: abort.signal });
    await assert.rejects(sinkPromise, /aborted/);
  });
});

// ── Exponential backoff computation ──────────────────────────────────────────

describe("backoff — exponential sequence", () => {
  // Replicate the computeBackoffMs logic to verify the sequence without importing
  // the private function from cli.ts.
  function computeBackoffMs(state: BootstrapState, category: string): number {
    if (category === "login_rate_limited" && state.magicLinkRateLimitedUntil) {
      const resetMs = new Date(state.magicLinkRateLimitedUntil).getTime();
      const waitMs = resetMs - Date.now();
      return Math.min(Math.max(waitMs, 0), 15 * 60_000);
    }
    const attempt = state.attempt ?? 0;
    return Math.min(2 ** attempt * 15_000, 5 * 60_000);
  }

  function makeState(attempt: number): BootstrapState {
    return { version: 1, phases: {}, updatedAt: new Date().toISOString(), attempt };
  }

  it("attempt 0 → 15 s", () => {
    assert.equal(computeBackoffMs(makeState(0), "magic_link_timeout"), 15_000);
  });

  it("attempt 1 → 30 s", () => {
    assert.equal(computeBackoffMs(makeState(1), "magic_link_timeout"), 30_000);
  });

  it("attempt 2 → 60 s", () => {
    assert.equal(computeBackoffMs(makeState(2), "magic_link_timeout"), 60_000);
  });

  it("attempt 3 → 120 s", () => {
    assert.equal(computeBackoffMs(makeState(3), "magic_link_timeout"), 120_000);
  });

  it("attempt 5 → 300 s (cap at 5 min)", () => {
    assert.equal(computeBackoffMs(makeState(5), "magic_link_timeout"), 300_000);
  });

  it("attempt 100 → still capped at 5 min", () => {
    assert.equal(computeBackoffMs(makeState(100), "magic_link_timeout"), 300_000);
  });

  it("login_rate_limited with known resetAt uses rate-limit time (capped at 15 min)", () => {
    const resetMs = Date.now() + 2 * 60_000; // 2 minutes
    const state: BootstrapState = {
      version: 1,
      phases: {},
      updatedAt: new Date().toISOString(),
      magicLinkRateLimitedUntil: new Date(resetMs).toISOString(),
    };
    const backoff = computeBackoffMs(state, "login_rate_limited");
    assert.ok(backoff > 1 * 60_000 && backoff <= 2 * 60_000 + 500, `got ${backoff}ms`);
  });

  it("login_rate_limited reset > 15 min is capped at 15 min", () => {
    const resetMs = Date.now() + 60 * 60_000; // 1 hour
    const state: BootstrapState = {
      version: 1,
      phases: {},
      updatedAt: new Date().toISOString(),
      magicLinkRateLimitedUntil: new Date(resetMs).toISOString(),
    };
    assert.equal(computeBackoffMs(state, "login_rate_limited"), 15 * 60_000);
  });
});

// ── Attempt counter reset on phase success ────────────────────────────────────

describe("StateManager — attempt counter", () => {
  let stateDir: string;
  let secretsDir: string;

  before(() => {
    stateDir = mkdtempSync(join(tmpdir(), "bs-attempt-state-"));
    secretsDir = mkdtempSync(join(tmpdir(), "bs-attempt-secrets-"));
  });

  after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it("attempt is undefined by default", () => {
    const sm = new StateManager(stateDir, secretsDir);
    const state = sm.load();
    assert.equal(state.attempt, undefined);
  });

  it("setDone resets attempt to 0", () => {
    const sm = new StateManager(stateDir, secretsDir);
    const state = sm.load();
    state.attempt = 5;
    state.nextRetryAt = "2026-09-09T12:00:00.000Z";
    sm.save(state);

    sm.setDone(state, "wait_services");

    // Reload from disk.
    const reloaded = sm.load();
    assert.equal(reloaded.attempt, 0);
    assert.equal(reloaded.nextRetryAt, undefined);
  });

  it("magicLinkRateLimitedUntil is preserved across save/load", () => {
    const sm = new StateManager(stateDir, secretsDir);
    const state = sm.load();
    const iso = new Date(Date.now() + 3_600_000).toISOString();
    state.magicLinkRateLimitedUntil = iso;
    sm.save(state);

    const reloaded = sm.load();
    assert.equal(reloaded.magicLinkRateLimitedUntil, iso);
  });
});
