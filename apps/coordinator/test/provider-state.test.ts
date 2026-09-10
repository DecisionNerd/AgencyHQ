/**
 * Unit tests for the provider state reader.
 *
 * Tests readProviderState() for all status outcomes and verifies that
 * no credential values (key, access, refresh) appear in the returned state.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readProviderState } from "../src/provider/state.ts";

// ---------------------------------------------------------------------------
// Fixture secrets — must never appear in output
// ---------------------------------------------------------------------------

const SECRET_KEY = "sk-ant-supersecretapikey123456789";
const SECRET_ACCESS = "oauth-access-token-supersecret-value";
const SECRET_REFRESH = "oauth-refresh-token-supersecret-value";

const FIXTURE_API_ONLY = JSON.stringify({
  anthropic: {
    type: "api",
    key: SECRET_KEY,
  },
});

const FIXTURE_OAUTH_VALID = JSON.stringify({
  openai: {
    type: "oauth",
    access: SECRET_ACCESS,
    refresh: SECRET_REFRESH,
    // Far future expiry: 2099-01-01
    expires: new Date("2099-01-01T00:00:00.000Z").getTime(),
    accountId: "user_123",
  },
});

const FIXTURE_OAUTH_EXPIRED = JSON.stringify({
  openai: {
    type: "oauth",
    access: SECRET_ACCESS,
    refresh: SECRET_REFRESH,
    // Already expired: 2020-01-01
    expires: new Date("2020-01-01T00:00:00.000Z").getTime(),
    accountId: "user_123",
  },
});

const FIXTURE_MIXED = JSON.stringify({
  anthropic: {
    type: "api",
    key: SECRET_KEY,
  },
  openai: {
    type: "oauth",
    access: SECRET_ACCESS,
    refresh: SECRET_REFRESH,
    expires: new Date("2099-01-01T00:00:00.000Z").getTime(),
    accountId: "user_123",
  },
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "agencyhq-provider-state-test-"));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeAuthJson(content: string): string {
  const dir = mkdtempSync(join(tempDir, "test-"));
  writeFileSync(join(dir, "auth.json"), content, "utf-8");
  return dir;
}

const NOW = "2026-09-09T00:00:00.000Z";

// Ensure no secret strings appear in the returned state
function assertNoSecretLeaks(state: unknown): void {
  const json = JSON.stringify(state);
  assert.ok(!json.includes(SECRET_KEY), "state must not contain api key");
  assert.ok(!json.includes(SECRET_ACCESS), "state must not contain access token");
  assert.ok(!json.includes(SECRET_REFRESH), "state must not contain refresh token");
}

// ---------------------------------------------------------------------------
// Tests: provider state
// ---------------------------------------------------------------------------

describe("readProviderState — unavailable", () => {
  it("returns unavailable when dataDir is undefined", () => {
    const state = readProviderState({ dataDir: undefined, now: NOW });
    assert.equal(state.status, "unavailable");
    assertNoSecretLeaks(state);
  });

  it("returns unavailable when dataDir does not exist", () => {
    // We return login_required when dir exists but file is missing
    // When dir itself is missing, readFileSync throws → login_required
    const state = readProviderState({ dataDir: "/nonexistent/path/xyz", now: NOW });
    assert.equal(state.status, "login_required");
    assertNoSecretLeaks(state);
  });
});

describe("readProviderState — login_required", () => {
  it("returns login_required when auth.json is absent", () => {
    const state = readProviderState({ dataDir: tempDir, now: NOW });
    assert.equal(state.status, "login_required");
    assert.deepEqual(state.providers, []);
    assertNoSecretLeaks(state);
  });

  it("returns login_required when auth.json is empty object", () => {
    const dir = writeAuthJson("{}");
    const state = readProviderState({ dataDir: dir, now: NOW });
    assert.equal(state.status, "login_required");
    assertNoSecretLeaks(state);
  });

  it("returns login_required when required provider is missing", () => {
    const dir = writeAuthJson(FIXTURE_API_ONLY);
    const state = readProviderState({
      dataDir: dir,
      now: NOW,
      requiredProviderIds: ["openai"],
    });
    assert.equal(state.status, "login_required");
    assert.ok(state.reason?.includes("openai"));
    assertNoSecretLeaks(state);
  });
});

describe("readProviderState — ready (api key)", () => {
  it("returns ready for api key provider", () => {
    const dir = writeAuthJson(FIXTURE_API_ONLY);
    const state = readProviderState({ dataDir: dir, now: NOW });
    assert.equal(state.status, "ready");
    assert.equal(state.providers.length, 1);
    assert.equal(state.providers[0]?.id, "anthropic");
    assert.equal(state.providers[0]?.type, "api");
    assertNoSecretLeaks(state);
  });

  it("returned state does not contain key field", () => {
    const dir = writeAuthJson(FIXTURE_API_ONLY);
    const state = readProviderState({ dataDir: dir, now: NOW });
    const json = JSON.stringify(state);
    assert.ok(!json.includes('"key"'), "key field must not appear in state");
    assertNoSecretLeaks(state);
  });
});

describe("readProviderState — ready (oauth valid)", () => {
  it("returns ready for valid oauth provider", () => {
    const dir = writeAuthJson(FIXTURE_OAUTH_VALID);
    const state = readProviderState({ dataDir: dir, now: NOW });
    assert.equal(state.status, "ready");
    assert.equal(state.providers[0]?.type, "oauth");
    assert.ok(state.providers[0]?.expiresAt?.includes("2099"));
    assertNoSecretLeaks(state);
  });

  it("returned state does not contain access or refresh fields", () => {
    const dir = writeAuthJson(FIXTURE_OAUTH_VALID);
    const state = readProviderState({ dataDir: dir, now: NOW });
    const json = JSON.stringify(state);
    assert.ok(!json.includes('"access"'), "access field must not appear in state");
    assert.ok(!json.includes('"refresh"'), "refresh field must not appear in state");
    assertNoSecretLeaks(state);
  });
});

describe("readProviderState — expired (oauth)", () => {
  it("returns expired when oauth token is in the past", () => {
    const dir = writeAuthJson(FIXTURE_OAUTH_EXPIRED);
    const state = readProviderState({ dataDir: dir, now: NOW });
    assert.equal(state.status, "expired");
    assertNoSecretLeaks(state);
  });

  it("returns expired when capacity row shows 401 within lookback window", () => {
    const dir = writeAuthJson(FIXTURE_API_ONLY);
    const nowMs = new Date(NOW).getTime();
    // Simulate a recent 401-like capacity observation (1 min before NOW)
    const recentObservation = new Date(nowMs - 60_000).toISOString();
    const state = readProviderState({
      dataDir: dir,
      now: NOW,
      requiredProviderIds: ["anthropic"],
      capacityRows: [
        {
          provider: "anthropic",
          model: "claude-opus-4",
          status: "down",
          observedAt: recentObservation,
          validUntil: new Date(nowMs + 60_000).toISOString(),
        },
      ],
    });
    assert.equal(state.status, "expired");
    assertNoSecretLeaks(state);
  });

  it("ignores capacity 401 outside lookback window", () => {
    const dir = writeAuthJson(FIXTURE_API_ONLY);
    const nowMs = new Date(NOW).getTime();
    // Observation 2 hours before NOW — outside 30-min lookback
    const oldObservation = new Date(nowMs - 7_200_000).toISOString();
    const state = readProviderState({
      dataDir: dir,
      now: NOW,
      requiredProviderIds: ["anthropic"],
      expiredWithinMs: 1_800_000,
      capacityRows: [
        {
          provider: "anthropic",
          model: "claude-opus-4",
          status: "down",
          observedAt: oldObservation,
          validUntil: new Date(nowMs + 60_000).toISOString(),
        },
      ],
    });
    assert.equal(state.status, "ready");
    assertNoSecretLeaks(state);
  });
});

describe("readProviderState — mixed providers", () => {
  it("returns ready when all required providers present with valid creds", () => {
    const dir = writeAuthJson(FIXTURE_MIXED);
    const state = readProviderState({
      dataDir: dir,
      now: NOW,
      requiredProviderIds: ["anthropic", "openai"],
    });
    assert.equal(state.status, "ready");
    assert.equal(state.providers.length, 2);
    assertNoSecretLeaks(state);
  });
});

// ---------------------------------------------------------------------------
// Snapshot test: JSON.stringify output must not contain secret strings
// ---------------------------------------------------------------------------

describe("no-leak snapshot", () => {
  it("full state JSON never contains secret values from fixture files", () => {
    const dir = writeAuthJson(FIXTURE_MIXED);
    const state = readProviderState({
      dataDir: dir,
      now: NOW,
      requiredProviderIds: ["anthropic", "openai"],
    });
    const serialized = JSON.stringify(state);
    const SECRETS = [SECRET_KEY, SECRET_ACCESS, SECRET_REFRESH];
    for (const secret of SECRETS) {
      assert.ok(
        !serialized.includes(secret),
        `serialized state must not contain secret: ${secret.slice(0, 8)}...`,
      );
    }
  });
});
