/**
 * Coordinator HTTP application (Hono).
 *
 * Pure HTTP layer: reads the ledger via injected loadSnapshot, delegates
 * commands to injected flow, and exposes realtime tokens via injected runtime.
 * Contains no scheduling or acceptance logic.
 */

import {
  claimCommand,
  completeCommand,
  listAttemptsByContract,
  listDecisionsByWorkItem,
  listFindingsByAttempt,
  listProjects,
  listReviewsByAttempt,
  listStepContractsByWorkItem,
  listVerificationResultsByAttempt,
  listWorkItemsByProject,
} from "@agencyhq/db";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { CoordinatorConfig } from "./config.ts";
import {
  type AttemptLike,
  buildReturnView,
  type ContractLike,
  type DecisionLike,
  type FindingLike,
  type ResultLike,
  type ReturnViewInput,
  type ReviewLike,
  type WorkItemLike,
} from "./views/return-view.ts";

// ---------------------------------------------------------------------------
// Minimal pool interface (avoids importing pg types directly)
// ---------------------------------------------------------------------------

export type PoolClientLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
};

export type PoolLike = {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Narrow structural interfaces (avoids importing flow/runtime internals)
// ---------------------------------------------------------------------------

/** Minimal interface for the bounded-repair flow module. */
export type FlowLike = {
  plan(workItemId: string, commandId: string): Promise<unknown>;
  retryDispatch?(intentId: string, commandId: string): Promise<unknown>;
};

/** Minimal interface for the reconciler. */
export type ReconcilerLike = {
  freshness(): { lastPollAt: string | null; stale: boolean };
};

/** Minimal interface for the execution runtime (structural subset of ExecutionRuntime). */
export type RuntimeLike = {
  createPublicToken(input: { tags: string[]; expiresIn: string }): Promise<string>;
};

/** Structural interface for the command handlers returned by commandHandlers(). */
export type CommandsLike = {
  stop(input: {
    commandId: string;
    attemptId: string;
    actor: "human" | "coordinator";
    reason: string;
  }): Promise<unknown>;
  pause(input: { commandId: string; workItemId: string; reason: string }): Promise<unknown>;
  resume(input: { commandId: string; workItemId: string; reason: string }): Promise<unknown>;
  createWorkItem(input: {
    commandId: string;
    projectId: string;
    intent: string;
    defect?: string;
    boundary: "artifact";
    rank: number;
  }): Promise<unknown>;
  ackVisit(input: { commandId: string; at: string }): Promise<unknown>;
  approve(input: {
    commandId: string;
    workItemId: string;
    contractId: string;
    contractVersion: number;
    attemptRevision: string;
    actor: string;
  }): Promise<unknown>;
  lastAckAt(client: PoolClientLike): Promise<string | null>;
};

// ---------------------------------------------------------------------------
// Ledger snapshot types
// ---------------------------------------------------------------------------

export type LedgerSnapshot = {
  workItems: WorkItemLike[];
  contracts: ContractLike[];
  attempts: AttemptLike[];
  decisions: DecisionLike[];
  results: ResultLike[];
  reviews: ReviewLike[];
  findings: FindingLike[];
};

/** Load all ledger rows needed for the return view. Injectable for testing. */
export type LoadSnapshotFn = (pool: PoolLike) => Promise<LedgerSnapshot>;

// ---------------------------------------------------------------------------
// Default loader (reads all projects)
// ---------------------------------------------------------------------------

async function defaultLoadSnapshot(pool: PoolLike): Promise<LedgerSnapshot> {
  const client = await pool.connect();
  try {
    // Cast to the pg PoolClient shape that the repo functions expect
    // The pool passed in production is a real pg.Pool so this is safe
    const pgClient = client as Parameters<typeof listProjects>[0];

    const projects = await listProjects(pgClient);

    const workItems: WorkItemLike[] = [];
    const contracts: ContractLike[] = [];
    const attempts: AttemptLike[] = [];
    const decisions: DecisionLike[] = [];
    const results: ResultLike[] = [];
    const reviews: ReviewLike[] = [];
    const findings: FindingLike[] = [];

    for (const project of projects) {
      const projectWorkItems = await listWorkItemsByProject(pgClient, project.id);
      for (const wi of projectWorkItems) {
        workItems.push({
          id: wi.id,
          intent: wi.intent,
          rank: wi.rank,
          mainEffort: wi.main_effort,
          lifecycle: wi.lifecycle,
          condition: wi.condition,
          updatedAt: wi.updated_at.toISOString(),
        });

        const wiDecisions = await listDecisionsByWorkItem(pgClient, wi.id);
        for (const d of wiDecisions) {
          const dec: DecisionLike = {
            id: d.id,
            workItemId: wi.id,
            kind: d.kind ?? "",
            outcome: d.outcome ?? "",
            at: d.at instanceof Date ? d.at.toISOString() : String(d.at),
          };
          decisions.push(dec);
        }

        const wiContracts = await listStepContractsByWorkItem(pgClient, wi.id);
        for (const c of wiContracts) {
          contracts.push({
            id: c.id,
            workItemId: wi.id,
            version: c.version,
            status: c.status,
            updatedAt: c.updated_at.toISOString(),
          });

          const contractAttempts = await listAttemptsByContract(pgClient, c.id);
          for (const a of contractAttempts) {
            attempts.push({
              id: a.id,
              contractId: c.id,
              status: a.status,
              checkpointCommit: a.checkpoint_commit,
              updatedAt: a.updated_at.toISOString(),
            });

            const attemptResults = await listVerificationResultsByAttempt(pgClient, a.id);
            for (const r of attemptResults) {
              results.push({
                id: r.id,
                attemptId: a.id,
                result: r.result,
                updatedAt: r.updated_at.toISOString(),
              });
            }

            const attemptReviews = await listReviewsByAttempt(pgClient, a.id);
            for (const r of attemptReviews) {
              reviews.push({
                id: r.id,
                attemptId: a.id,
                updatedAt: r.updated_at.toISOString(),
              });
            }

            const attemptFindings = await listFindingsByAttempt(pgClient, a.id);
            for (const f of attemptFindings) {
              const finding: FindingLike = {
                id: f.id,
                severity: f.severity ?? "",
                kind: f.kind ?? "",
              };
              if (f.attempt_id !== null) {
                finding.attemptId = f.attempt_id;
              }
              findings.push(finding);
            }
          }
        }
      }
    }

    return { workItems, contracts, attempts, decisions, results, reviews, findings };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type AppDeps = {
  pool: PoolLike;
  flow: FlowLike;
  reconciler: ReconcilerLike;
  runtime: RuntimeLike;
  config: CoordinatorConfig;
  clock?: () => string; // ISO now; injectable for tests
  loadSnapshot?: LoadSnapshotFn;
  commands?: CommandsLike;
};

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(deps: AppDeps): Hono {
  const {
    pool,
    flow,
    reconciler,
    runtime,
    config,
    clock = () => new Date().toISOString(),
    loadSnapshot = defaultLoadSnapshot,
    commands,
  } = deps;

  const app = new Hono();

  // ------------------------------------------------------------------
  // GET /api/health
  // ------------------------------------------------------------------
  app.get("/api/health", (c) => {
    return c.json({ ok: true, at: clock() });
  });

  // ------------------------------------------------------------------
  // GET /api/return-view?since=<iso>
  // ------------------------------------------------------------------
  app.get("/api/return-view", async (c) => {
    const since = c.req.query("since") ?? null;

    // When `since` is absent and commands are wired, read lastAckAt from the DB
    let lastAckAt: string | null = since;
    if (lastAckAt === null && commands) {
      const client = await pool.connect();
      try {
        lastAckAt = await commands.lastAckAt(client);
      } finally {
        client.release();
      }
    }

    const snapshot = await loadSnapshot(pool);
    const freshness = reconciler.freshness();
    const now = clock();

    const input: ReturnViewInput = {
      now,
      lastAckAt,
      freshness,
      freshnessStaleMs: config.freshnessStaleMs,
      ...snapshot,
    };

    const view = buildReturnView(input);
    return c.json(view);
  });

  // ------------------------------------------------------------------
  // GET /api/work-items/:id
  // ------------------------------------------------------------------
  app.get("/api/work-items/:id", async (c) => {
    const id = c.req.param("id");
    const client = await pool.connect();
    try {
      const pgClient = client as Parameters<typeof listStepContractsByWorkItem>[0];

      const contracts = await listStepContractsByWorkItem(pgClient, id);
      const decisions = await listDecisionsByWorkItem(pgClient, id);

      const attempts: AttemptLike[] = [];
      const results: ResultLike[] = [];
      const reviews: ReviewLike[] = [];
      const findings: FindingLike[] = [];

      for (const contract of contracts) {
        const contractAttempts = await listAttemptsByContract(pgClient, contract.id);
        for (const a of contractAttempts) {
          attempts.push({
            id: a.id,
            contractId: contract.id,
            status: a.status,
            checkpointCommit: a.checkpoint_commit,
            updatedAt: a.updated_at.toISOString(),
          });

          const attemptResults = await listVerificationResultsByAttempt(pgClient, a.id);
          for (const r of attemptResults) {
            results.push({
              id: r.id,
              attemptId: a.id,
              result: r.result,
              updatedAt: r.updated_at.toISOString(),
            });
          }

          const attemptReviews = await listReviewsByAttempt(pgClient, a.id);
          for (const r of attemptReviews) {
            reviews.push({
              id: r.id,
              attemptId: a.id,
              updatedAt: r.updated_at.toISOString(),
            });
          }

          const attemptFindings = await listFindingsByAttempt(pgClient, a.id);
          for (const f of attemptFindings) {
            const finding: FindingLike = {
              id: f.id,
              severity: f.severity ?? "",
              kind: f.kind ?? "",
            };
            if (f.attempt_id !== null) {
              finding.attemptId = f.attempt_id;
            }
            findings.push(finding);
          }
        }
      }

      return c.json({
        contracts: contracts.map((ct) => ({
          id: ct.id,
          workItemId: ct.work_item_id,
          version: ct.version,
          status: ct.status,
          updatedAt: ct.updated_at.toISOString(),
        })),
        attempts,
        decisions: decisions.map((d) => ({
          id: d.id,
          kind: d.kind,
          actor: d.actor,
          outcome: d.outcome,
          at: d.at instanceof Date ? d.at.toISOString() : String(d.at),
        })),
        results,
        reviews,
        findings,
      });
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // GET /api/work-items/:id/realtime-token
  // ------------------------------------------------------------------
  app.get("/api/work-items/:id/realtime-token", async (c) => {
    const id = c.req.param("id");
    const token = await runtime.createPublicToken({
      tags: [`workItem:${id}`],
      expiresIn: "15m",
    });
    return c.json({ token });
  });

  // ------------------------------------------------------------------
  // POST /api/commands
  // ------------------------------------------------------------------
  app.post("/api/commands", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { commandId, kind } = body;

    if (!commandId || typeof commandId !== "string") {
      return c.json({ error: "commandId is required" }, 400);
    }
    if (!kind || typeof kind !== "string") {
      return c.json({ error: "kind is required" }, 400);
    }

    if (kind === "plan") {
      const workItemId = body.workItemId;
      if (!workItemId || typeof workItemId !== "string") {
        return c.json({ error: "workItemId required for plan" }, 400);
      }
      // When real commands are wired, the flow manages its own claim/complete cycle.
      // When commands are absent (test/legacy mode), the app handles idempotency.
      if (commands) {
        const result = await flow.plan(workItemId, commandId);
        return c.json({ commandId, replayed: false, result }, 200);
      }
      // Legacy path: app-level claim for fake flows that don't manage their own claims.
      {
        const client = await pool.connect();
        try {
          const pgClient = client as Parameters<typeof claimCommand>[0];
          const claim = await claimCommand(pgClient, commandId, kind);
          if (!claim.claimed) {
            const inFlight = "inFlight" in claim && claim.inFlight === true;
            return c.json(
              { commandId, replayed: true, inFlight, result: inFlight ? null : claim.result },
              200,
            );
          }
          const result = await flow.plan(workItemId, commandId);
          await completeCommand(pgClient, commandId, result);
          return c.json({ commandId, replayed: false, result }, 200);
        } finally {
          client.release();
        }
      }
    }

    if (kind === "retry_dispatch") {
      const intentId = body.intentId;
      if (!intentId || typeof intentId !== "string") {
        return c.json({ error: "intentId required for retry_dispatch" }, 400);
      }
      if (!flow.retryDispatch) {
        return c.json({ error: "retry_dispatch not supported by flow" }, 400);
      }
      // retry_dispatch also managed by the flow internally
      if (commands) {
        const result = await flow.retryDispatch(intentId, commandId);
        return c.json({ commandId, replayed: false, result }, 200);
      }
      {
        const client = await pool.connect();
        try {
          const pgClient = client as Parameters<typeof claimCommand>[0];
          const claim = await claimCommand(pgClient, commandId, kind);
          if (!claim.claimed) {
            const inFlight = "inFlight" in claim && claim.inFlight === true;
            return c.json(
              { commandId, replayed: true, inFlight, result: inFlight ? null : claim.result },
              200,
            );
          }
          const result = await flow.retryDispatch(intentId, commandId);
          await completeCommand(pgClient, commandId, result);
          return c.json({ commandId, replayed: false, result }, 200);
        } finally {
          client.release();
        }
      }
    }

    // Command-handler-based commands: claim/complete managed by the handlers
    if (commands) {
      if (kind === "stop") {
        const attemptId = body.attemptId;
        if (!attemptId || typeof attemptId !== "string") {
          return c.json({ error: "attemptId required for stop" }, 400);
        }
        const actor = body.actor === "human" || body.actor === "coordinator" ? body.actor : "human";
        const reason = typeof body.reason === "string" ? body.reason : "operator requested";
        const result = await commands.stop({ commandId, attemptId, actor, reason });
        const stopReplayed =
          typeof result === "object" &&
          result !== null &&
          (result as Record<string, unknown>).replayed === true;
        return c.json({ commandId, replayed: stopReplayed, result }, 200);
      }

      if (kind === "pause") {
        const workItemId = body.workItemId;
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for pause" }, 400);
        }
        const reason = typeof body.reason === "string" ? body.reason : "operator requested";
        const result = await commands.pause({ commandId, workItemId, reason });
        return c.json({ commandId, replayed: false, result }, 200);
      }

      if (kind === "resume") {
        const workItemId = body.workItemId;
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for resume" }, 400);
        }
        const reason = typeof body.reason === "string" ? body.reason : "operator requested";
        const result = await commands.resume({ commandId, workItemId, reason });
        return c.json({ commandId, replayed: false, result }, 200);
      }

      if (kind === "create_work_item") {
        const projectId = body.projectId;
        const intent = body.intent;
        if (!projectId || typeof projectId !== "string") {
          return c.json({ error: "projectId required for create_work_item" }, 400);
        }
        if (!intent || typeof intent !== "string") {
          return c.json({ error: "intent required for create_work_item" }, 400);
        }
        const defectVal = typeof body.defect === "string" ? body.defect : undefined;
        const createInput: Parameters<typeof commands.createWorkItem>[0] = {
          commandId,
          projectId,
          intent,
          boundary: "artifact",
          rank: typeof body.rank === "number" ? body.rank : 1,
        };
        if (defectVal !== undefined) {
          createInput.defect = defectVal;
        }
        const result = await commands.createWorkItem(createInput);
        return c.json({ commandId, replayed: false, result }, 200);
      }

      if (kind === "ack_visit") {
        const at = typeof body.at === "string" ? body.at : clock();
        const result = await commands.ackVisit({ commandId, at });
        return c.json({ commandId, replayed: false, result }, 200);
      }

      if (kind === "approve") {
        const workItemId = body.workItemId;
        const contractId = body.contractId;
        const contractVersion = body.contractVersion;
        const attemptRevision = body.attemptRevision;
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for approve" }, 400);
        }
        if (!contractId || typeof contractId !== "string") {
          return c.json({ error: "contractId required for approve" }, 400);
        }
        if (typeof contractVersion !== "number") {
          return c.json({ error: "contractVersion (number) required for approve" }, 400);
        }
        if (!attemptRevision || typeof attemptRevision !== "string") {
          return c.json({ error: "attemptRevision required for approve" }, 400);
        }
        const approveActor = typeof body.actor === "string" ? body.actor : "human";
        const result = await commands.approve({
          commandId,
          workItemId,
          contractId,
          contractVersion,
          attemptRevision,
          actor: approveActor,
        });
        const approveReplayed =
          typeof result === "object" &&
          result !== null &&
          (result as Record<string, unknown>).replayed === true;
        return c.json({ commandId, replayed: approveReplayed, result }, 200);
      }
    } else {
      // Fallback when commands are not wired (legacy / test mode)
      if (kind === "ack_visit") {
        const client = await pool.connect();
        try {
          const pgClient = client as Parameters<typeof claimCommand>[0];
          const claim = await claimCommand(pgClient, commandId, kind);
          if (!claim.claimed) {
            const inFlight = "inFlight" in claim && claim.inFlight === true;
            return c.json(
              { commandId, replayed: true, inFlight, result: inFlight ? null : claim.result },
              200,
            );
          }
          const result = { ok: true, detail: "visit acknowledged" };
          await completeCommand(pgClient, commandId, result);
          return c.json({ commandId, replayed: false, result }, 200);
        } finally {
          client.release();
        }
      }
    }

    return c.json({ error: `Unknown command kind: ${kind}` }, 400);
  });

  // ------------------------------------------------------------------
  // Static serving of webDist when configured
  // ------------------------------------------------------------------
  if (config.webDist) {
    app.use(
      "/*",
      serveStatic({
        root: config.webDist,
      }),
    );
  } else {
    app.get("/", (c) => c.notFound());
  }

  return app;
}
