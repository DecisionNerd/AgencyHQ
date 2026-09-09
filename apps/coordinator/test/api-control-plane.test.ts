/**
 * API route tests for slice-5 control-plane endpoints.
 * Uses app.request() (Hono's testing helper) — no real Postgres required.
 *
 * Covers: GET /api/overview, GET /api/decisions, GET /api/work-items/:id/evidence,
 *         GET /api/projects/:id/authority, PUT /api/projects/:id/authority,
 *         and the new POST /api/commands kinds.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOST_TRIAL_AUTHORITY } from "@agencyhq/contracts";
import type {
  CommandsLike,
  FlowLike,
  LedgerSnapshot,
  PoolClientLike,
  PoolLike,
  ReconcilerLike,
  RuntimeLike,
} from "../src/app.ts";
import { createApp } from "../src/app.ts";
import type { CoordinatorConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Fake dependencies (mirrors api.test.ts helpers)
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

const NOW = "2026-09-07T12:00:00.000Z";

/** Minimal pool fake — throws on connect, which is fine for fake-pool tests. */
function makeFakePool(): PoolLike {
  return {
    connect: async () => {
      throw new Error("FakePool.connect should not be called when loadSnapshot is injected");
    },
    end: async () => {},
  };
}

/** Pool that returns a fake project authority_version on any query (for 409 tests). */
function makeVersionedPool(authorityVersion: number): PoolLike {
  const client: PoolClientLike = {
    query: async (_sql: string, _params?: unknown[]) => ({
      rows: [{ authority_version: String(authorityVersion) }],
    }),
    release: () => {},
  };
  return {
    connect: async () => client,
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

function makeFakeReconciler(): ReconcilerLike {
  return {
    freshness: () => ({ lastPollAt: NOW, stale: false }),
  };
}

function makeFakeFlow(): FlowLike {
  return {
    async plan() {
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

function makeControlPlaneCommands(): CommandsLike {
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
    reject: async (input) => ({ ok: true, decisionId: input.decisionId }),
    invalidateAcceptance: async () => ({ ok: true, invalidationDecisionId: "inv-fake" }),
    createCampaign: async (input) => ({
      ok: true,
      campaignId: `cmp-${input.commandId.slice(0, 8)}`,
    }),
    assignCampaign: async () => ({ ok: true }),
    setMainEffort: async () => ({ ok: true }),
    setWorkItemRank: async () => ({ ok: true }),
    updateAuthority: async () => ({ ok: true, version: "2" }),
  };
}

// ---------------------------------------------------------------------------
// GET /api/overview — bearer auth
// ---------------------------------------------------------------------------

describe("GET /api/overview — bearer auth", () => {
  it("returns 401 without Authorization header when token is configured", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig({ apiToken: "my-secret" }),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/overview");
    assert.equal(res.status, 401);
  });

  it("returns 401 with wrong token", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig({ apiToken: "my-secret" }),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/overview", {
      headers: { Authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/decisions — bearer auth
// ---------------------------------------------------------------------------

describe("GET /api/decisions — bearer auth", () => {
  it("returns 401 without token when token is configured", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig({ apiToken: "my-secret" }),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/decisions");
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/work-items/:id/evidence — bearer auth
// ---------------------------------------------------------------------------

describe("GET /api/work-items/:id/evidence — bearer auth", () => {
  it("returns 401 without token when token is configured", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig({ apiToken: "my-secret" }),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/work-items/wi-123/evidence");
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:id/authority — bearer auth
// ---------------------------------------------------------------------------

describe("GET /api/projects/:id/authority — bearer auth", () => {
  it("returns 401 without token when token is configured", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig({ apiToken: "my-secret" }),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/projects/prj-123/authority");
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/projects/:id/authority — bearer auth and validation
// ---------------------------------------------------------------------------

describe("PUT /api/projects/:id/authority — bearer auth and validation", () => {
  it("returns 401 without token when token is configured", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig({ apiToken: "my-secret" }),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", authority: {}, actor: "op" }),
    });
    assert.equal(res.status, 401);
  });

  it("returns 400 when commandId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authority: {}, actor: "op" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when authority is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", actor: "op" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when actor is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", authority: { version: "2" } }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 200 with result when all fields valid and commands wired", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    // U-2: authority must be a valid AuthoritySchema object; use HOST_TRIAL_AUTHORITY
    // with version bumped to "2". The route validates before calling the command.
    const validAuthority = { ...HOST_TRIAL_AUTHORITY, version: "2" };
    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", authority: validAuthority, actor: "operator" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      commandId: string;
      result: { ok: boolean; version: number };
    };
    assert.equal(body.commandId, "cmd-1");
    assert.equal(body.result.ok, true);
    // U-2: version is returned as a number, not a string.
    assert.equal(typeof body.result.version, "number", "U-2: version is a number");
    assert.equal(body.result.version, 2, "U-2: version value = 2");
  });

  it("U-2: returns 200 with expectedVersion injecting next version", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    // Send authority without version field + expectedVersion=1 → server injects version "2".
    const authorityWithoutVersion = { ...HOST_TRIAL_AUTHORITY } as Record<string, unknown>;
    delete authorityWithoutVersion.version;
    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-exp",
        authority: authorityWithoutVersion,
        actor: "operator",
        expectedVersion: 1,
      }),
    });
    assert.equal(res.status, 200, "expectedVersion injects version '2' → valid authority → 200");
    const body = (await res.json()) as { result: { ok: boolean; version: number } };
    assert.equal(body.result.ok, true);
    assert.equal(body.result.version, 2, "U-2: version computed from expectedVersion+1");
  });

  it("U-2: returns 422 with errors array when authority fails AuthoritySchema", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        authority: { version: "2" }, // missing required fields → 422
        actor: "operator",
      }),
    });
    assert.equal(res.status, 422, "U-2: invalid authority → 422");
    const body = (await res.json()) as {
      commandId: string;
      errors: Array<{ path: string[]; message: string }>;
    };
    assert.equal(body.commandId, "cmd-1");
    assert.ok(Array.isArray(body.errors), "U-2: errors is an array");
    assert.ok(body.errors.length > 0, "U-2: errors array is non-empty");
    assert.ok(
      body.errors.every((e) => Array.isArray(e.path) && typeof e.message === "string"),
      "U-2: each error has path (array) and message (string)",
    );
  });

  it("U-2: returns 409 with currentVersion when CAS fails (version_not_increasing)", async () => {
    const commandsWithCasFail: CommandsLike = {
      ...makeControlPlaneCommands(),
      updateAuthority: async () => ({ ok: false, reason: "version_not_increasing" as const }),
    };
    const app = createApp({
      pool: makeVersionedPool(1),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: commandsWithCasFail,
    });

    const validAuthority = { ...HOST_TRIAL_AUTHORITY, version: "2" };
    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-cas", authority: validAuthority, actor: "op" }),
    });
    assert.equal(res.status, 409, "U-2: CAS failure → 409");
    const body = (await res.json()) as {
      commandId: string;
      result: { ok: boolean; reason: string; currentVersion: number };
    };
    assert.equal(body.commandId, "cmd-cas");
    assert.equal(body.result.ok, false);
    assert.equal(body.result.reason, "version_not_increasing");
    assert.equal(body.result.currentVersion, 1, "U-2: currentVersion returned in 409");
  });

  it("U-2: returns 404 for unknown project", async () => {
    const commandsWithNotFound: CommandsLike = {
      ...makeControlPlaneCommands(),
      updateAuthority: async () => ({ ok: false, reason: "project_not_found" as const }),
    };
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: commandsWithNotFound,
    });

    const validAuthority = { ...HOST_TRIAL_AUTHORITY, version: "2" };
    const res = await app.request("/api/projects/unknown-prj/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-404", authority: validAuthority, actor: "op" }),
    });
    assert.equal(res.status, 404, "U-2: project_not_found → 404");
  });

  it("returns 400 when commands not wired", async () => {
    // Without commands, PUT /api/projects/:id/authority returns 400
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      // commands omitted
    });

    const res = await app.request("/api/projects/prj-123/authority", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", authority: { version: "2" }, actor: "operator" }),
    });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=reject — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=reject — field validation", () => {
  it("returns 400 when workItemId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", kind: "reject", decisionId: "dec-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when decisionId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", kind: "reject", workItemId: "wi-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when reason is missing (T-5: reason_required)", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "reject",
        workItemId: "wi-1",
        decisionId: "dec-1",
        // reason intentionally omitted
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "reason_required");
  });

  it("returns 400 when reason is empty string (T-5: reason_required)", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "reject",
        workItemId: "wi-1",
        decisionId: "dec-1",
        reason: "",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "reason_required");
  });

  it("returns 200 when all required fields are present (including reason)", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "reject",
        workItemId: "wi-1",
        decisionId: "dec-1",
        reason: "Not acceptable quality",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean; decisionId: string } };
    assert.equal(body.result.ok, true);
  });

  it("U-7: returns 400 reason_required when reason is whitespace-only", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "reject",
        workItemId: "wi-1",
        decisionId: "dec-1",
        reason: "   ", // whitespace-only → trimmed to "" → reason_required
      }),
    });
    assert.equal(res.status, 400, "U-7: whitespace-only reason → 400");
    const body = (await res.json()) as { reason: string };
    assert.equal(body.reason, "reason_required", "U-7: reason_required for whitespace reason");
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=invalidate_acceptance — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=invalidate_acceptance — field validation", () => {
  it("returns 400 when workItemId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "invalidate_acceptance",
        attemptId: "att-1",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when attemptId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "invalidate_acceptance",
        workItemId: "wi-1",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("U-7: returns 400 reason_required when reason is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "invalidate_acceptance",
        workItemId: "wi-1",
        attemptId: "att-1",
        // no reason → reason_required
      }),
    });
    assert.equal(res.status, 400, "U-7: missing reason → 400");
    const body = (await res.json()) as { reason: string };
    assert.equal(body.reason, "reason_required", "U-7: reason_required for invalidate_acceptance");
  });

  it("returns 200 when all required fields are present (including reason)", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "invalidate_acceptance",
        workItemId: "wi-1",
        attemptId: "att-1",
        reason: "defect found",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean } };
    assert.equal(body.result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=create_campaign — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=create_campaign — field validation", () => {
  it("returns 400 when name is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", kind: "create_campaign" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 200 with campaignId when name is present", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-abc12345",
        kind: "create_campaign",
        name: "Sprint 1",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean; campaignId: string } };
    assert.equal(body.result.ok, true);
    assert.ok(body.result.campaignId.startsWith("cmp-"));
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=assign_campaign — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=assign_campaign — field validation", () => {
  it("returns 400 when campaignId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", kind: "assign_campaign", workItemId: "wi-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 200 when all fields present", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "assign_campaign",
        workItemId: "wi-1",
        campaignId: "cmp-1",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean } };
    assert.equal(body.result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=set_main_effort — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=set_main_effort — field validation", () => {
  it("returns 400 when campaignId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", kind: "set_main_effort", workItemId: "wi-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 200 when all fields present", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "set_main_effort",
        campaignId: "cmp-1",
        workItemId: "wi-1",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean } };
    assert.equal(body.result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=set_rank — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=set_rank — field validation", () => {
  it("returns 400 when rank is not a number", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "set_rank",
        workItemId: "wi-1",
        rank: "not-a-number",
        expectedVersion: 1,
      }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when expectedVersion is not a number", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "set_rank",
        workItemId: "wi-1",
        rank: 2,
      }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 200 when all fields valid", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "set_rank",
        workItemId: "wi-1",
        rank: 2,
        expectedVersion: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean } };
    assert.equal(body.result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/commands kind=update_authority — field validation
// ---------------------------------------------------------------------------

describe("POST /api/commands kind=update_authority — field validation", () => {
  it("returns 400 when projectId is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "update_authority",
        authority: {},
        actor: "op",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when authority is missing", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-1", kind: "update_authority", projectId: "prj-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 200 when all fields valid", async () => {
    const app = createApp({
      pool: makeFakePool(),
      flow: makeFakeFlow(),
      reconciler: makeFakeReconciler(),
      runtime: makeFakeRuntime(),
      config: makeConfig(),
      clock: () => NOW,
      loadSnapshot: async () => EMPTY_SNAPSHOT,
      commands: makeControlPlaneCommands(),
    });

    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-1",
        kind: "update_authority",
        projectId: "prj-1",
        authority: { version: "2" },
        actor: "operator",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { ok: boolean; version: string } };
    assert.equal(body.result.ok, true);
    assert.equal(body.result.version, "2");
  });
});
