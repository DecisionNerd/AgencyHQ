/**
 * API route tests using app.request() (Hono's testing helper).
 * Uses a fake pool and injected loadSnapshot — no real Postgres required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  FlowLike,
  LedgerSnapshot,
  PoolLike,
  ReconcilerLike,
  RuntimeLike,
} from "../src/app.ts";
import { createApp } from "../src/app.ts";
import type { CoordinatorConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Fake dependencies
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
  return {
    databaseUrl: "postgres://fake/fake",
    triggerApiUrl: "https://trigger.example.com",
    triggerSecretKey: "secret",
    runtime: "fake",
    worktreeBase: "/tmp/worktrees",
    workerModel: "claude-sonnet-4",
    leadModel: "claude-opus-4",
    reviewerModel: "claude-sonnet-4",
    reconcileIntervalMs: 5000,
    freshnessStaleMs: 30000,
    port: 8787,
    ...overrides,
  };
}

/** Minimal pool fake — connect throws so injected loadSnapshot is always used instead. */
function makeFakePool(): PoolLike {
  return {
    connect: async () => {
      throw new Error("FakePool.connect should not be called when loadSnapshot is injected");
    },
    end: async () => {},
  };
}

const EMPTY_SNAPSHOT: LedgerSnapshot = {
  workItems: [],
  contracts: [],
  attempts: [],
  decisions: [],
  results: [],
  reviews: [],
  findings: [],
};

const NOW = "2026-09-07T12:00:00.000Z";

function makeFakeReconciler(lastPollAt: string | null = NOW): ReconcilerLike {
  return {
    freshness: () => ({ lastPollAt, stale: false }),
  };
}

type FakeFlow = FlowLike & { planCalls: Array<{ workItemId: string; commandId: string }> };

function makeFakeFlow(): FakeFlow {
  const planCalls: Array<{ workItemId: string; commandId: string }> = [];
  return {
    planCalls,
    async plan(workItemId, commandId) {
      planCalls.push({ workItemId, commandId });
      return { ok: true };
    },
  };
}

function makeFakeRuntime(): RuntimeLike {
  return {
    async createPublicToken(input) {
      return `tok-${input.tags.join("-")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake command store for idempotency tests
// ---------------------------------------------------------------------------

type CommandEntry = { result: unknown | null };

function makeCommandPool(): PoolLike {
  const store = new Map<string, CommandEntry>();
  return {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        const sqlStr = sql.trim();
        if (sqlStr.startsWith("INSERT INTO commands")) {
          const commandId = String((params as unknown[])[0]);
          if (store.has(commandId)) {
            return { rows: [] }; // conflict - not claimed
          }
          store.set(commandId, { result: null });
          return { rows: [{ command_id: commandId }] };
        }
        if (sqlStr.startsWith("SELECT result FROM commands")) {
          const commandId = String((params as unknown[])[0]);
          const entry = store.get(commandId);
          return { rows: [{ result: entry?.result ?? null }] };
        }
        if (sqlStr.startsWith("UPDATE commands")) {
          const commandId = String((params as unknown[])[0]);
          const result = (params as unknown[])[1];
          const entry = store.get(commandId);
          if (entry) entry.result = result;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
    end: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  it("returns 200 with ok: true and current time", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; at: string };
    assert.equal(body.ok, true);
    assert.equal(body.at, NOW);
  });
});

describe("GET /api/return-view", () => {
  it("returns 200 with view structure including freshness", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(NOW),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    const res = await app.request("/api/return-view");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      changedSinceLastVisit: unknown[];
      pendingDecisions: unknown[];
      continuing: unknown[];
      stops: unknown[];
      mainEffort: string | null;
      freshness: { lastPollAt: string | null; stale: boolean };
    };
    assert.deepEqual(body.changedSinceLastVisit, []);
    assert.deepEqual(body.pendingDecisions, []);
    assert.equal(body.freshness.lastPollAt, NOW);
    assert.equal(body.freshness.stale, false);
  });

  it("since parameter excludes unchanged items", async () => {
    const snapshot: LedgerSnapshot = {
      ...EMPTY_SNAPSHOT,
      workItems: [
        {
          id: "w1",
          intent: "old item",
          rank: 1,
          mainEffort: false,
          lifecycle: "active",
          condition: "healthy",
          updatedAt: "2026-09-07T11:00:00.000Z",
        },
      ],
    };
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(NOW),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => snapshot,
    });

    // since is AFTER the work item's updatedAt — should NOT appear in changed
    const res = await app.request("/api/return-view?since=2026-09-07T11:30:00.000Z");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { changedSinceLastVisit: unknown[] };
    assert.equal(body.changedSinceLastVisit.length, 0);
  });

  it("includes items changed after since timestamp", async () => {
    const snapshot: LedgerSnapshot = {
      ...EMPTY_SNAPSHOT,
      workItems: [
        {
          id: "w1",
          intent: "recently changed",
          rank: 1,
          mainEffort: false,
          lifecycle: "active",
          condition: "healthy",
          updatedAt: "2026-09-07T11:45:00.000Z",
        },
      ],
    };
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(NOW),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => snapshot,
    });

    const res = await app.request("/api/return-view?since=2026-09-07T11:30:00.000Z");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { changedSinceLastVisit: Array<{ workItemId: string }> };
    assert.equal(body.changedSinceLastVisit.length, 1);
    assert.equal(body.changedSinceLastVisit[0]?.workItemId, "w1");
  });

  it("stale freshness when reconciler reports stale", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: {
        freshness: () => ({ lastPollAt: "2026-09-07T11:00:00.000Z", stale: true }),
      },
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    const res = await app.request("/api/return-view");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { freshness: { stale: boolean } };
    assert.equal(body.freshness.stale, true);
  });
});

describe("GET /api/work-items/:id/realtime-token", () => {
  it("calls createPublicToken with workItem tag and 15m expiry", async () => {
    const tokens: Array<{ tags: string[]; expiresIn: string }> = [];
    const runtime: RuntimeLike = {
      async createPublicToken(input) {
        tokens.push(input);
        return "test-token-123";
      },
    };
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime,
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    const res = await app.request("/api/work-items/wi-abc/realtime-token");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string };
    assert.equal(body.token, "test-token-123");
    assert.equal(tokens.length, 1);
    assert.deepEqual(tokens[0]?.tags, ["workItem:wi-abc"]);
    assert.equal(tokens[0]?.expiresIn, "15m");
  });

  it("returns different tokens for different work item ids", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    const res1 = await app.request("/api/work-items/wi-1/realtime-token");
    const res2 = await app.request("/api/work-items/wi-2/realtime-token");
    const body1 = (await res1.json()) as { token: string };
    const body2 = (await res2.json()) as { token: string };
    assert.notEqual(body1.token, body2.token);
  });
});

describe("POST /api/commands", () => {
  it("returns 400 for missing commandId", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "plan", workItemId: "w1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 for missing kind", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", workItemId: "w1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 for unknown command kind", async () => {
    const flow = makeFakeFlow();
    const app = createApp({
      pool: makeCommandPool(),
      flow,
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-unknown-1", kind: "unknown_kind", workItemId: "w1" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /unknown/i);
  });

  it("delegates plan command to flow.plan and returns result", async () => {
    const flow = makeFakeFlow();
    const app = createApp({
      pool: makeCommandPool(),
      flow,
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-plan-1", kind: "plan", workItemId: "w1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { replayed: boolean; result: { ok: boolean } };
    assert.equal(body.replayed, false);
    assert.equal(body.result.ok, true);
    assert.equal(flow.planCalls.length, 1);
    assert.equal(flow.planCalls[0]?.workItemId, "w1");
    assert.equal(flow.planCalls[0]?.commandId, "cmd-plan-1");
  });

  it("second request with same commandId returns replayed=true", async () => {
    const flow = makeFakeFlow();
    const commandPool = makeCommandPool();
    const app = createApp({
      pool: commandPool,
      flow,
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    // First request
    const first = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-idem-1", kind: "plan", workItemId: "w1" }),
    });
    assert.equal(first.status, 200);
    const body1 = (await first.json()) as { replayed: boolean };
    assert.equal(body1.replayed, false);

    // Second request with the same commandId
    const second = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-idem-1", kind: "plan", workItemId: "w1" }),
    });
    assert.equal(second.status, 200);
    const body2 = (await second.json()) as { replayed: boolean };
    assert.equal(body2.replayed, true);

    // Flow should only be called once
    assert.equal(flow.planCalls.length, 1);
  });

  it("ack_visit command returns ok without calling flow.plan", async () => {
    const flow = makeFakeFlow();
    const app = createApp({
      pool: makeCommandPool(),
      flow,
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-ack-1", kind: "ack_visit" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { replayed: boolean; result: { ok: boolean } };
    assert.equal(body.replayed, false);
    assert.equal(body.result.ok, true);
    assert.equal(flow.planCalls.length, 0);
  });

  it("plan command without workItemId returns 400", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-no-wi", kind: "plan" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /workItemId/);
  });
});

describe("GET /api/work-items/:id (ledger detail)", () => {
  it("returns empty arrays when no data in pool", async () => {
    const pool: PoolLike = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      end: async () => {},
    };

    const app = createApp({
      pool,
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });

    const res = await app.request("/api/work-items/w1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      contracts: unknown[];
      attempts: unknown[];
      decisions: unknown[];
    };
    assert.deepEqual(body.contracts, []);
    assert.deepEqual(body.attempts, []);
    assert.deepEqual(body.decisions, []);
  });
});
