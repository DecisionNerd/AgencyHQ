/**
 * app.request tests for GET /api/readiness.
 *
 * Tests the route registration, bearer-auth enforcement, response shape,
 * and nextAction derivation across the key readiness states.
 * No real Postgres or Trigger API is required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  FlowLike,
  PoolLike,
  ReadinessLoaderFn,
  ReconcilerLike,
  RuntimeLike,
} from "../src/app.ts";
import { createApp } from "../src/app.ts";
import type { CoordinatorConfig } from "../src/config.ts";
import type { ReadinessInputs } from "../src/readiness/types.ts";

// ---------------------------------------------------------------------------
// Fake helpers (shared with api.test.ts patterns)
// ---------------------------------------------------------------------------

const NOW = "2026-09-08T12:00:00.000Z";

function makeConfig(overrides: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
  return {
    databaseUrl: "postgres://fake/fake",
    triggerApiUrl: "",
    triggerSecretKey: "",
    runtime: "fake",
    worktreeBase: "/tmp/worktrees",
    workerModel: "claude-sonnet-4",
    leadModel: "claude-opus-4",
    reviewerModel: "claude-sonnet-4",
    reconcileIntervalMs: 5000,
    freshnessStaleMs: 30000,
    uncertainAfterMs: 120000,
    port: 8787,
    bindHost: "127.0.0.1",
    ...overrides,
  };
}

function makeFakePool(): PoolLike {
  return {
    connect: async () => {
      throw new Error("FakePool.connect should not be called in these tests");
    },
    end: async () => {},
  };
}

function makeFakeReconciler(): ReconcilerLike {
  return {
    freshness: () => ({ lastPollAt: NOW, stale: false }),
  };
}

function makeFakeFlow(): FlowLike {
  return {
    plan: async () => ({}),
  };
}

function makeFakeRuntime(): RuntimeLike {
  return {
    createPublicToken: async () => "fake-token",
  };
}

function makeReadinessInputs(overrides: Partial<ReadinessInputs> = {}): ReadinessInputs {
  return {
    database: "ok",
    trigger: "unconfigured",
    bootstrapJson: null,
    deploymentJson: null,
    ...overrides,
  };
}

function makeLoader(overrides: Partial<ReadinessInputs> = {}): ReadinessLoaderFn {
  return async () => makeReadinessInputs(overrides);
}

function makeApp(token?: string, loader?: ReadinessLoaderFn) {
  return createApp({
    pool: makeFakePool(),
    flow: makeFakeFlow(),
    reconciler: makeFakeReconciler(),
    runtime: makeFakeRuntime(),
    config: makeConfig(token !== undefined ? { apiToken: token } : {}),
    clock: () => NOW,
    ...(loader !== undefined ? { loadReadiness: loader } : {}),
  });
}

// ---------------------------------------------------------------------------
// Route availability
// ---------------------------------------------------------------------------

describe("GET /api/readiness — no loader injected", () => {
  it("returns 200 with stub response when no loader is wired", async () => {
    const app = makeApp(undefined, undefined);
    const res = await app.request("/api/readiness");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok("services" in body);
    assert.ok("bootstrap" in body);
    assert.ok("image" in body);
    assert.equal(body.provider, "unknown");
    assert.equal(body.worker, "unknown");
    assert.ok(typeof body.nextAction === "string");
  });
});

// ---------------------------------------------------------------------------
// Bearer-auth enforcement
// ---------------------------------------------------------------------------

describe("GET /api/readiness — bearer-auth", () => {
  it("401 when token is configured and request has no Authorization header", async () => {
    const app = makeApp("my-secret-token", makeLoader());
    const res = await app.request("/api/readiness");
    assert.equal(res.status, 401);
  });

  it("401 when token is configured and wrong token is provided", async () => {
    const app = makeApp("my-secret-token", makeLoader());
    const res = await app.request("/api/readiness", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  it("200 when token is configured and correct token is provided", async () => {
    const app = makeApp("my-secret-token", makeLoader());
    const res = await app.request("/api/readiness", {
      headers: { Authorization: "Bearer my-secret-token" },
    });
    assert.equal(res.status, 200);
  });

  it("200 when no token is configured (loopback mode)", async () => {
    const app = makeApp(undefined, makeLoader());
    const res = await app.request("/api/readiness");
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap absent state
// ---------------------------------------------------------------------------

describe("GET /api/readiness — bootstrap absent", () => {
  it("bootstrap is null and nextAction mentions 'Bootstrap not started'", async () => {
    const app = makeApp(undefined, makeLoader({ bootstrapJson: null }));
    const res = await app.request("/api/readiness");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.bootstrap, null);
    const nextAction = body.nextAction;
    assert.ok(typeof nextAction === "string");
    assert.ok(
      nextAction.includes("Bootstrap not started") || nextAction.includes("docker compose up"),
      `got: ${nextAction}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Bootstrap running state
// ---------------------------------------------------------------------------

describe("GET /api/readiness — bootstrap running", () => {
  it("nextAction says 'Bootstrap is running: phase deploy'", async () => {
    const app = makeApp(
      undefined,
      makeLoader({
        bootstrapJson: { phase: "deploy", status: "running", at: NOW },
      }),
    );
    const res = await app.request("/api/readiness");
    const body = (await res.json()) as Record<string, unknown>;
    const nextAction = body.nextAction;
    assert.equal(nextAction, "Bootstrap is running: phase deploy");
    const bootstrap = body.bootstrap as Record<string, unknown> | null;
    assert.ok(bootstrap !== null);
    assert.equal(bootstrap?.phase, "deploy");
    assert.equal(bootstrap?.status, "running");
  });
});

// ---------------------------------------------------------------------------
// Bootstrap failed state — category surfaced
// ---------------------------------------------------------------------------

describe("GET /api/readiness — bootstrap failed", () => {
  it("nextAction surfaces phase and error category", async () => {
    const app = makeApp(
      undefined,
      makeLoader({
        bootstrapJson: {
          phase: "credentials",
          status: "failed",
          error: "pat_creation_failed",
          at: NOW,
        },
      }),
    );
    const res = await app.request("/api/readiness");
    const body = (await res.json()) as Record<string, unknown>;
    const nextAction = body.nextAction as string;
    assert.ok(nextAction.includes("credentials"), `got: ${nextAction}`);
    assert.ok(nextAction.includes("pat_creation_failed"), `got: ${nextAction}`);
    assert.ok(nextAction.includes("docker compose logs bootstrap"), `got: ${nextAction}`);
    const bootstrap = body.bootstrap as Record<string, unknown> | null;
    assert.equal(bootstrap?.error, "pat_creation_failed");
  });
});

// ---------------------------------------------------------------------------
// Bootstrap done + deployment.json present
// ---------------------------------------------------------------------------

describe("GET /api/readiness — done + deployment.json", () => {
  it("image fields are populated and nextAction points to provider login", async () => {
    const app = makeApp(
      undefined,
      makeLoader({
        bootstrapJson: { phase: "done", status: "done", at: NOW },
        trigger: "ok",
        deploymentJson: {
          version: "1.2.3",
          platform: "linux/arm64",
          externalId: "ext-abc",
          at: NOW,
        },
      }),
    );
    const res = await app.request("/api/readiness");
    const body = (await res.json()) as Record<string, unknown>;
    const image = body.image as Record<string, unknown> | null;
    assert.ok(image !== null, "expected image to be present");
    assert.equal(image?.version, "1.2.3");
    assert.equal(image?.platform, "linux/arm64");
    assert.equal(image?.externalId, "ext-abc");
    const nextAction = body.nextAction as string;
    assert.ok(
      nextAction.includes("opencode auth login") || nextAction.includes("provider login"),
      `got: ${nextAction}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Database down
// ---------------------------------------------------------------------------

describe("GET /api/readiness — database down", () => {
  it("services.database is 'down' and nextAction mentions database", async () => {
    const app = makeApp(undefined, makeLoader({ database: "down", bootstrapJson: null }));
    const res = await app.request("/api/readiness");
    const body = (await res.json()) as Record<string, unknown>;
    const services = body.services as Record<string, unknown>;
    assert.equal(services?.database, "down");
    const nextAction = body.nextAction as string;
    assert.ok(nextAction.toLowerCase().includes("database"), `got: ${nextAction}`);
  });
});

// ---------------------------------------------------------------------------
// Loader error → 503
// ---------------------------------------------------------------------------

describe("GET /api/readiness — loader error", () => {
  it("returns 503 when loader throws", async () => {
    const failingLoader: ReadinessLoaderFn = async () => {
      throw new Error("probe failed");
    };
    const app = makeApp(undefined, failingLoader);
    const res = await app.request("/api/readiness");
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    const services = body.services as Record<string, unknown>;
    assert.equal(services?.database, "down");
  });
});

// ---------------------------------------------------------------------------
// /api/health stays public (existing invariant)
// ---------------------------------------------------------------------------

describe("GET /api/health — remains unauthenticated", () => {
  it("200 without token even when apiToken is configured", async () => {
    const app = makeApp("secret-token", makeLoader());
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
  });
});
