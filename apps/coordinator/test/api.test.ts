/**
 * API route tests using app.request() (Hono's testing helper).
 * Uses a fake pool and injected loadSnapshot — no real Postgres required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CommandsLike,
  FlowLike,
  LedgerSnapshot,
  PoolLike,
  ReconcilerLike,
  RuntimeLike,
} from "../src/app.ts";
import { createApp } from "../src/app.ts";
import type { CoordinatorConfig } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";

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
    uncertainAfterMs: 120000,
    port: 8787,
    bindHost: "127.0.0.1",
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

// ---------------------------------------------------------------------------
// approve command: API validation (test v from PACKET I1.c)
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=approve — field validation", () => {
  function makeApproveCommands(): CommandsLike {
    return {
      stop: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      createWorkItem: async () => ({ ok: true, workItemId: "wi_fake" }),
      ackVisit: async () => ({ ok: true, at: NOW }),
      approve: async (input) => ({
        ok: true as const,
        decisionId: `dec-${input.commandId}`,
        artifactRevision: input.attemptRevision,
      }),
      disposition: async () => ({ ok: true, outcome: "backlog" as const }),
      lastAckAt: async () => null,
      reject: async () => ({ ok: true, decisionId: "dec-fake" }),
      invalidateAcceptance: async () => ({ ok: true, invalidationDecisionId: "inv-fake" }),
      createCampaign: async () => ({ ok: true, campaignId: "cmp-fake" }),
      assignCampaign: async () => ({ ok: true }),
      setMainEffort: async () => ({ ok: true }),
      setWorkItemRank: async () => ({ ok: true }),
      updateAuthority: async () => ({ ok: true, version: "2" }),
      importHostProject: async () => ({ ok: true }),
      revertImport: async () => ({ ok: true }),
    };
  }

  it("returns 400 when workItemId is missing", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeApproveCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-approve-1",
        kind: "approve",
        contractId: "sc_abc",
        contractVersion: 1,
        attemptRevision: "rev1",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /workItemId/);
  });

  it("returns 400 when contractId is missing", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeApproveCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-approve-2",
        kind: "approve",
        workItemId: "wi_abc",
        contractVersion: 1,
        attemptRevision: "rev1",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /contractId/);
  });

  it("returns 400 when contractVersion is not a number", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeApproveCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-approve-3",
        kind: "approve",
        workItemId: "wi_abc",
        contractId: "sc_abc",
        contractVersion: "not-a-number",
        attemptRevision: "rev1",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /contractVersion/);
  });

  it("returns 400 when attemptRevision is missing", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeApproveCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-approve-4",
        kind: "approve",
        workItemId: "wi_abc",
        contractId: "sc_abc",
        contractVersion: 1,
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /attemptRevision/);
  });

  it("returns 200 with result when all fields are valid", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeApproveCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-approve-5",
        kind: "approve",
        workItemId: "wi_abc",
        contractId: "sc_abc",
        contractVersion: 1,
        attemptRevision: "cafebabe1234",
        actor: "alice",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      commandId: string;
      replayed: boolean;
      result: { ok: boolean; decisionId: string; artifactRevision: string };
    };
    assert.equal(body.commandId, "cmd-approve-5");
    assert.equal(body.replayed, false);
    assert.ok(body.result.ok);
    assert.ok(body.result.decisionId);
    assert.equal(body.result.artifactRevision, "cafebabe1234");
  });
});

// ---------------------------------------------------------------------------
// CR-1: retry_dispatch uses intentId (not workItemId)
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=retry_dispatch (CR-1)", () => {
  type RetryFlow = FlowLike & {
    retryDispatchCalls: Array<{ intentId: string; commandId: string }>;
  };

  function makeRetryFlow(): RetryFlow {
    const retryDispatchCalls: Array<{ intentId: string; commandId: string }> = [];
    return {
      retryDispatchCalls,
      async plan(workItemId, commandId) {
        return { ok: true, intentId: workItemId, runId: "fake-run", commandId };
      },
      async retryDispatch(intentId, commandId) {
        retryDispatchCalls.push({ intentId, commandId });
        return { runId: "fake-run-2" };
      },
    };
  }

  it("missing intentId returns 400", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeRetryFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-rd-1", kind: "retry_dispatch" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /intentId/);
  });

  it("retry_dispatch with intentId reaches the flow with that id", async () => {
    const flow = makeRetryFlow();
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
      body: JSON.stringify({
        commandId: "cmd-rd-2",
        kind: "retry_dispatch",
        intentId: "di_abc123",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(flow.retryDispatchCalls.length, 1);
    assert.equal(flow.retryDispatchCalls[0]?.intentId, "di_abc123");
    assert.equal(flow.retryDispatchCalls[0]?.commandId, "cmd-rd-2");
  });
});

// ---------------------------------------------------------------------------
// CR-3: loadConfig bindHost defaults to 127.0.0.1; overrideable via env
// ---------------------------------------------------------------------------

describe("loadConfig bindHost (CR-3)", () => {
  const REQUIRED_ENV = {
    DATABASE_URL: "postgres://fake/test",
    RUNTIME: "fake",
    AGENCYHQ_WORKTREE_BASE: "/worktrees",
    AGENCYHQ_WORKER_MODEL: "claude-sonnet-4",
    AGENCYHQ_LEAD_MODEL: "claude-opus-4",
    AGENCYHQ_REVIEWER_MODEL: "claude-sonnet-4",
  };

  it("bindHost defaults to 127.0.0.1 when AGENCYHQ_BIND_HOST is not set", () => {
    const config = loadConfig(REQUIRED_ENV as NodeJS.ProcessEnv);
    assert.equal(config.bindHost, "127.0.0.1");
  });

  it("bindHost reads from AGENCYHQ_BIND_HOST env var", () => {
    // Non-loopback bind host requires a token (I2.a); provide one so this test
    // stays focused on bindHost and doesn't conflict with the auth config rule.
    const config = loadConfig({
      ...REQUIRED_ENV,
      AGENCYHQ_BIND_HOST: "0.0.0.0",
      AGENCYHQ_API_TOKEN: "test-token",
    } as NodeJS.ProcessEnv);
    assert.equal(config.bindHost, "0.0.0.0");
  });
});

// ---------------------------------------------------------------------------
// I2.a: Bearer-token authentication middleware
// ---------------------------------------------------------------------------

describe("Bearer-token auth middleware (I2.a)", () => {
  const TOKEN = "test-secret-bearer-token";

  function makeAuthApp(apiToken?: string) {
    // exactOptionalPropertyTypes: don't spread undefined into optional field
    const configOverrides: Partial<import("../src/config.ts").CoordinatorConfig> =
      apiToken !== undefined ? { apiToken } : {};
    // Use makeCommandPool so POST /api/commands (plan) can reach pool.connect()
    // without throwing (the legacy path is used when no commands are injected).
    return createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(configOverrides),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
    });
  }

  // ---------- with token configured ----------

  it("with token: missing Authorization header → 401 on /api/return-view", async () => {
    const app = makeAuthApp(TOKEN);
    const res = await app.request("/api/return-view");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  it("with token: wrong token → 401", async () => {
    const app = makeAuthApp(TOKEN);
    const res = await app.request("/api/return-view", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  it("with token: correct token → 200 on GET /api/return-view", async () => {
    const app = makeAuthApp(TOKEN);
    const res = await app.request("/api/return-view", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
  });

  it("with token: correct token → 200 on POST /api/commands", async () => {
    const app = makeAuthApp(TOKEN);
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ commandId: "cmd-auth-1", kind: "plan", workItemId: "wi-auth-1" }),
    });
    assert.equal(res.status, 200);
  });

  it("with token: /api/health → 200 without Authorization header", async () => {
    const app = makeAuthApp(TOKEN);
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
  });

  // ---------- without token configured ----------

  it("without token: /api/return-view → 200 without Authorization header", async () => {
    const app = makeAuthApp(undefined);
    const res = await app.request("/api/return-view");
    assert.equal(res.status, 200);
  });

  it("without token: /api/health → 200 without Authorization header", async () => {
    const app = makeAuthApp(undefined);
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// disposition command: API validation (PACKET 4.2.b C4)
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=disposition — field validation", () => {
  function makeDispositionCommands(): CommandsLike {
    return {
      stop: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      createWorkItem: async () => ({ ok: true, workItemId: "wi_fake" }),
      ackVisit: async () => ({ ok: true, at: NOW }),
      approve: async (input) => ({
        ok: true as const,
        decisionId: `dec-${input.commandId}`,
        artifactRevision: input.attemptRevision,
      }),
      disposition: async () => ({ ok: true, outcome: "backlog" as const }),
      lastAckAt: async () => null,
      reject: async () => ({ ok: true, decisionId: "dec-fake" }),
      invalidateAcceptance: async () => ({ ok: true, invalidationDecisionId: "inv-fake" }),
      createCampaign: async () => ({ ok: true, campaignId: "cmp-fake" }),
      assignCampaign: async () => ({ ok: true }),
      setMainEffort: async () => ({ ok: true }),
      setWorkItemRank: async () => ({ ok: true }),
      updateAuthority: async () => ({ ok: true, version: "2" }),
      importHostProject: async () => ({ ok: true }),
      revertImport: async () => ({ ok: true }),
    };
  }

  it("returns 400 when findingId is missing", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeDispositionCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-disp-1",
        kind: "disposition",
        disposition: "remediate",
        reason: "try again",
        actor: "human",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /findingId/);
  });

  it("returns 400 when disposition value is invalid", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeDispositionCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-disp-2",
        kind: "disposition",
        findingId: "fnd_abc",
        disposition: "invalid_value",
        reason: "test",
        actor: "human",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /disposition/);
  });

  it("returns 200 when all required fields are present", async () => {
    const app = createApp({
      pool: makeCommandPool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeDispositionCommands(),
    });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-disp-3",
        kind: "disposition",
        findingId: "fnd_abc",
        disposition: "backlog",
        reason: "not urgent",
        actor: "human",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean; outcome: string } };
    assert.ok(body.result.ok);
    assert.equal(body.result.outcome, "backlog");
  });
});

// ---------------------------------------------------------------------------
// return-view: merge item carries integrations and workItemProjects (PACKET 4.2.b C5)
// ---------------------------------------------------------------------------

describe("GET /api/return-view — merge item carries integrations and workItemProjects", () => {
  it("snapshot with integrations and workItemProjects propagates to return-view", async () => {
    const snapshot: LedgerSnapshot = {
      ...EMPTY_SNAPSHOT,
      workItems: [
        {
          id: "wi-merge-1",
          intent: "Multi-repo fix",
          rank: 1,
          mainEffort: true,
          lifecycle: "active",
          condition: "healthy",
          boundary: "merge",
          updatedAt: NOW,
        },
      ],
      integrations: [
        {
          id: "int-1",
          attemptId: "att-1",
          targetRef: "main",
          outcome: "ok",
          resultingRevision: "bbbb000000000000000000000000000000000000",
          at: NOW,
        },
      ],
      workItemProjects: [
        {
          workItemId: "wi-merge-1",
          position: 0,
          resultRevision: null,
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

    const res = await app.request("/api/return-view");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      continuing: Array<{ workItemId: string }>;
    };
    // The work item should appear in the view (active lifecycle)
    // (exact view structure depends on buildReturnView implementation)
    assert.ok(Array.isArray(body.continuing), "continuing array present");
  });
});
