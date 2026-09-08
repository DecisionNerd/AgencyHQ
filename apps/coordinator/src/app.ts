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
  getWorkItem,
  listAttemptsByContract,
  listDecisionsByWorkItem,
  listFindingsByAttempt,
  listIntegrationsByAttempt,
  listProjects,
  listReviewsByAttempt,
  listStepContractsByWorkItem,
  listVerificationResultsByAttempt,
  listWorkItemProjects,
  listWorkItemsByProject,
} from "@agencyhq/db";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createBearerAuthMiddleware } from "./auth.ts";
import type { CoordinatorConfig } from "./config.ts";
import { buildAuthorityView } from "./views/authority-view.ts";
import { buildDecisionsView } from "./views/decisions-view.ts";
import { buildEvidenceView } from "./views/evidence-view.ts";
import { buildOverviewView } from "./views/overview-view.ts";
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
    boundary: "artifact" | "merge";
    rank: number;
    manifest?: { entries: Array<{ projectId: string; targetRef: string }> };
  }): Promise<unknown>;
  disposition(input: {
    commandId: string;
    findingId: string;
    disposition: "remediate" | "scope_decision" | "block" | "backlog";
    reason: string;
    actor: string;
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
  // Control-plane commands (slice 5)
  reject(input: {
    commandId: string;
    workItemId: string;
    decisionId: string;
    reason: string;
  }): Promise<unknown>;
  invalidateAcceptance(input: {
    commandId: string;
    workItemId: string;
    attemptId: string;
    reason: string;
  }): Promise<unknown>;
  createCampaign(input: { commandId: string; name: string }): Promise<unknown>;
  assignCampaign(input: {
    commandId: string;
    workItemId: string;
    campaignId: string;
  }): Promise<unknown>;
  setMainEffort(input: {
    commandId: string;
    campaignId: string;
    workItemId: string;
  }): Promise<unknown>;
  setWorkItemRank(input: {
    commandId: string;
    workItemId: string;
    rank: number;
    expectedVersion: number;
  }): Promise<unknown>;
  updateAuthority(input: {
    commandId: string;
    projectId: string;
    authority: unknown;
    actor: string;
  }): Promise<unknown>;
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
  integrations?: import("./views/return-view.ts").IntegrationLike[];
  workItemProjects?: import("./views/return-view.ts").WorkItemProjectLike[];
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
    const integrations: import("./views/return-view.ts").IntegrationLike[] = [];
    const workItemProjects: import("./views/return-view.ts").WorkItemProjectLike[] = [];

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
          boundary: wi.boundary as "artifact" | "merge" | "deploy",
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

            // Load integration events for merge-boundary attempts.
            const attemptIntegrations = await listIntegrationsByAttempt(pgClient, a.id);
            for (const integ of attemptIntegrations) {
              integrations.push({
                id: integ.id,
                attemptId: a.id,
                targetRef: integ.target_ref,
                outcome: integ.outcome ?? null,
                resultingRevision: integ.resulting_revision ?? null,
                at: integ.at instanceof Date ? integ.at.toISOString() : String(integ.at),
              });
            }
          }
        }

        // Load work_item_projects for manifest tracking.
        const wipRows = await listWorkItemProjects(pgClient, wi.id);
        for (const wip of wipRows) {
          workItemProjects.push({
            workItemId: wi.id,
            position: wip.position,
            resultRevision: wip.result_revision ?? null,
          });
        }
      }
    }

    return {
      workItems,
      contracts,
      attempts,
      decisions,
      results,
      reviews,
      findings,
      integrations,
      workItemProjects,
    };
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
  // Bearer-token auth middleware (guards /api/* except /api/health)
  // ------------------------------------------------------------------
  app.use("/api/*", createBearerAuthMiddleware(config.apiToken));

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
  // GET /api/work-items/:id/view
  // Returns an Item-shaped payload for a single work item, built by
  // running buildReturnView over a snapshot scoped to just this item.
  // ------------------------------------------------------------------
  app.get("/api/work-items/:id/view", async (c) => {
    const id = c.req.param("id");
    const client = await pool.connect();
    try {
      const pgClient = client as Parameters<typeof listStepContractsByWorkItem>[0];

      const wiRow = await getWorkItem(pgClient, id);
      if (!wiRow) {
        return c.json({ error: "not found" }, 404);
      }

      const wi: WorkItemLike = {
        id: wiRow.id,
        intent: wiRow.intent,
        rank: wiRow.rank,
        mainEffort: wiRow.main_effort,
        lifecycle: wiRow.lifecycle,
        condition: wiRow.condition,
        updatedAt: wiRow.updated_at.toISOString(),
        boundary: wiRow.boundary as "artifact" | "merge" | "deploy",
      };

      const wiDecisions = await listDecisionsByWorkItem(pgClient, id);
      const decisions: DecisionLike[] = wiDecisions.map((d) => ({
        id: d.id,
        workItemId: id,
        kind: d.kind ?? "",
        outcome: d.outcome ?? "",
        at: d.at instanceof Date ? d.at.toISOString() : String(d.at),
      }));

      const wiContracts = await listStepContractsByWorkItem(pgClient, id);
      const contracts: ContractLike[] = wiContracts.map((c) => ({
        id: c.id,
        workItemId: id,
        version: c.version,
        status: c.status,
        updatedAt: c.updated_at.toISOString(),
      }));

      const attempts: AttemptLike[] = [];
      const results: ResultLike[] = [];
      const reviews: ReviewLike[] = [];
      const findings: FindingLike[] = [];

      for (const contract of wiContracts) {
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
            if (f.attempt_id !== null) finding.attemptId = f.attempt_id;
            findings.push(finding);
          }
        }
      }

      // Load integration events and work_item_projects so that the Integration
      // card and manifest progress are populated (mirrors defaultLoadSnapshot).
      const integrations: import("./views/return-view.ts").IntegrationLike[] = [];
      const workItemProjects: import("./views/return-view.ts").WorkItemProjectLike[] = [];
      for (const a of attempts) {
        const attemptIntegrations = await listIntegrationsByAttempt(pgClient, a.id);
        for (const integ of attemptIntegrations) {
          integrations.push({
            id: integ.id,
            attemptId: a.id,
            targetRef: integ.target_ref,
            outcome: integ.outcome ?? null,
            resultingRevision: integ.resulting_revision ?? null,
            at: integ.at instanceof Date ? integ.at.toISOString() : String(integ.at),
          });
        }
      }
      const wipRows = await listWorkItemProjects(pgClient, id);
      for (const wip of wipRows) {
        workItemProjects.push({
          workItemId: id,
          position: wip.position,
          resultRevision: wip.result_revision ?? null,
        });
      }

      const input: ReturnViewInput = {
        now: new Date().toISOString(),
        lastAckAt: null,
        freshness: { lastPollAt: null },
        freshnessStaleMs: config.freshnessStaleMs,
        workItems: [wi],
        contracts,
        attempts,
        decisions,
        results,
        reviews,
        findings,
        integrations,
        workItemProjects,
      };

      const view = buildReturnView(input);

      // The item appears in exactly one of these sections
      const item =
        view.changedSinceLastVisit.find((i) => i.workItemId === id) ??
        view.continuing.find((i) => i.workItemId === id);

      if (!item) {
        return c.json({ error: "item not renderable" }, 500);
      }

      return c.json(item);
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
  // GET /api/overview
  // ------------------------------------------------------------------
  app.get("/api/overview", async (c) => {
    const client = await pool.connect();
    try {
      const pgClient = client as Parameters<typeof listProjects>[0];

      // Load projects
      const projects = await listProjects(pgClient);

      // Load campaigns (migration 0004 table — direct SQL until merge packet lands)
      const { rows: _campaignRows } = await client.query(
        `SELECT id, name, main_effort_work_item_id FROM campaigns ORDER BY created_at`,
      );
      const campaignRows = _campaignRows as Array<{
        id: string;
        name: string;
        main_effort_work_item_id: string | null;
      }>;

      // Load all work items and decisions
      const allWorkItems: Array<{
        id: string;
        project_id: string;
        intent: string;
        rank: number;
        main_effort: boolean;
        lifecycle: string;
        condition: string;
        boundary: "artifact" | "merge" | "deploy";
        campaign_id: string | null;
      }> = [];
      const allDecisions: Array<{
        id: string;
        work_item_id: string | null;
        kind: string;
        outcome: string | null;
        attempt_id: string | null;
        at: string;
      }> = [];

      for (const project of projects) {
        const wiRows = await listWorkItemsByProject(pgClient, project.id);
        for (const wi of wiRows) {
          allWorkItems.push({
            id: wi.id,
            project_id: project.id,
            intent: wi.intent,
            rank: wi.rank,
            main_effort: wi.main_effort,
            lifecycle: wi.lifecycle,
            condition: wi.condition,
            boundary: wi.boundary,
            campaign_id: null, // populated below if column exists
          });

          const decisions = await listDecisionsByWorkItem(pgClient, wi.id);
          for (const d of decisions) {
            allDecisions.push({
              id: d.id,
              work_item_id: d.work_item_id,
              kind: d.kind,
              outcome: d.outcome,
              attempt_id: d.attempt_id ?? null,
              at: d.at instanceof Date ? d.at.toISOString() : String(d.at),
            });
          }
        }
      }

      // Enrich campaign_id from work_items (migration 0004 column — direct SQL)
      if (allWorkItems.length > 0) {
        try {
          const ids = allWorkItems.map((_, i) => `$${i + 1}`).join(", ");
          const { rows: _campaignIdRows } = await client.query(
            `SELECT id, campaign_id FROM work_items WHERE id IN (${ids})`,
            allWorkItems.map((wi) => wi.id),
          );
          const campaignIdRows = _campaignIdRows as Array<{
            id: string;
            campaign_id: string | null;
          }>;
          const campaignIdMap = new Map<string, string | null>();
          for (const row of campaignIdRows) {
            campaignIdMap.set(row.id, row.campaign_id);
          }
          for (const wi of allWorkItems) {
            wi.campaign_id = campaignIdMap.get(wi.id) ?? null;
          }
        } catch {
          // campaign_id column may not exist yet — leave as null
        }
      }

      const view = buildOverviewView({
        campaigns: campaignRows.map((r) => ({
          id: r.id,
          name: r.name,
          mainEffortWorkItemId: r.main_effort_work_item_id,
        })),
        projects: projects.map((p) => ({ id: p.id })),
        workItems: allWorkItems.map((wi) => ({
          id: wi.id,
          projectId: wi.project_id,
          intent: wi.intent,
          rank: wi.rank,
          mainEffort: wi.main_effort,
          lifecycle: wi.lifecycle,
          condition: wi.condition,
          boundary: wi.boundary,
          campaignId: wi.campaign_id,
        })),
        decisions: allDecisions.map((d) => ({
          id: d.id,
          workItemId: d.work_item_id,
          kind: d.kind,
          outcome: d.outcome,
          attemptId: d.attempt_id,
          at: d.at,
        })),
      });

      return c.json(view);
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // GET /api/decisions
  // ------------------------------------------------------------------
  app.get("/api/decisions", async (c) => {
    const client = await pool.connect();
    try {
      const pgClient = client as Parameters<typeof listProjects>[0];

      const projects = await listProjects(pgClient);

      // Collect all pending_human decisions across all projects' work items
      const allDecisions: Array<{
        id: string;
        workItemId: string | null;
        kind: string;
        outcome: string | null;
        at: string;
        contractVersion: number | null;
        attemptId: string | null;
        rationale: string | null;
      }> = [];
      const allAttempts: Array<{
        id: string;
        contractId: string;
        status: string;
        artifactRevision: string | null;
      }> = [];
      const allContracts: Array<{
        id: string;
        workItemId: string;
        version: number;
        status: string;
      }> = [];
      const allFindings: Array<{
        id: string;
        attemptId: string | null;
        kind: string;
        severity: string;
      }> = [];

      for (const project of projects) {
        const workItems = await listWorkItemsByProject(pgClient, project.id);
        for (const wi of workItems) {
          const decisions = await listDecisionsByWorkItem(pgClient, wi.id);
          for (const d of decisions) {
            allDecisions.push({
              id: d.id,
              workItemId: d.work_item_id,
              kind: d.kind ?? "",
              outcome: d.outcome,
              at: d.at instanceof Date ? d.at.toISOString() : String(d.at),
              contractVersion: d.contract_version,
              attemptId: d.attempt_id,
              rationale: null, // Lead rationale would need to be fetched from proposal
            });
          }

          const contracts = await listStepContractsByWorkItem(pgClient, wi.id);
          for (const c of contracts) {
            allContracts.push({
              id: c.id,
              workItemId: wi.id,
              version: c.version,
              status: c.status,
            });

            const attempts = await listAttemptsByContract(pgClient, c.id);
            for (const a of attempts) {
              // Load the latest artifact revision for this attempt so the
              // decisions view can expose contractId + attemptRevision for approve.
              const { rows: _artRows } = await client.query(
                "SELECT revision FROM artifacts WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1",
                [a.id],
              );
              const artifactRevision =
                (_artRows[0] as { revision?: string } | undefined)?.revision ?? null;

              allAttempts.push({
                id: a.id,
                contractId: c.id,
                status: a.status,
                artifactRevision,
              });

              const findings = await listFindingsByAttempt(pgClient, a.id);
              for (const f of findings) {
                allFindings.push({
                  id: f.id,
                  attemptId: f.attempt_id,
                  kind: f.kind ?? "",
                  severity: f.severity ?? "",
                });
              }
            }
          }
        }
      }

      const view = buildDecisionsView({
        decisions: allDecisions,
        attempts: allAttempts,
        contracts: allContracts,
        findings: allFindings,
      });

      return c.json(view);
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // GET /api/work-items/:id/evidence
  // ------------------------------------------------------------------
  app.get("/api/work-items/:id/evidence", async (c) => {
    const id = c.req.param("id");
    const client = await pool.connect();
    try {
      const pgClient = client as Parameters<typeof listStepContractsByWorkItem>[0];

      const contracts = await listStepContractsByWorkItem(pgClient, id);
      const decisions = await listDecisionsByWorkItem(pgClient, id);

      const allAttempts: Array<{
        id: string;
        contractId: string;
        status: string;
        runId: string | null;
        checkpointCommit: string | null;
        commitSha: string | null;
        updatedAt: string;
      }> = [];
      const allArtifacts: Array<{
        id: string;
        attemptId: string;
        revision: string;
        diffDigest: string;
        updatedAt: string;
      }> = [];
      const allVerificationResults: Array<{
        id: string;
        attemptId: string;
        stepContractId: string;
        result: string;
        updatedAt: string;
      }> = [];
      const allReviews: Array<{
        id: string;
        attemptId: string;
        attemptRevision: string | null;
        diffDigest: string | null;
        updatedAt: string;
      }> = [];
      const allFindings: Array<{
        id: string;
        attemptId: string | null;
        severity: string;
        kind: string;
        description: string;
        evidence: string | null;
        disposition: string | null;
        updatedAt: string;
      }> = [];
      const allIntegrations: Array<{
        id: string;
        attemptId: string;
        targetRef: string;
        outcome: string | null;
        resultingRevision: string | null;
        at: string;
      }> = [];

      for (const contract of contracts) {
        const attempts = await listAttemptsByContract(pgClient, contract.id);
        for (const a of attempts) {
          allAttempts.push({
            id: a.id,
            contractId: contract.id,
            status: a.status,
            runId: a.run_id ?? null,
            checkpointCommit: a.checkpoint_commit ?? null,
            commitSha: a.commit_sha ?? null,
            updatedAt: a.updated_at.toISOString(),
          });

          const verResults = await listVerificationResultsByAttempt(pgClient, a.id);
          for (const r of verResults) {
            allVerificationResults.push({
              id: r.id,
              attemptId: a.id,
              stepContractId: r.step_contract_id,
              result: r.result,
              updatedAt: r.updated_at.toISOString(),
            });
          }

          const reviews = await listReviewsByAttempt(pgClient, a.id);
          for (const r of reviews) {
            allReviews.push({
              id: r.id,
              attemptId: a.id,
              attemptRevision: r.attempt_revision ?? null,
              diffDigest: r.diff_digest ?? null,
              updatedAt: r.updated_at.toISOString(),
            });
          }

          const findings = await listFindingsByAttempt(pgClient, a.id);
          for (const f of findings) {
            allFindings.push({
              id: f.id,
              attemptId: f.attempt_id ?? null,
              severity: f.severity ?? "",
              kind: f.kind ?? "",
              description: f.description,
              evidence: f.evidence ?? null,
              disposition: f.disposition ?? null,
              updatedAt: f.updated_at.toISOString(),
            });
          }

          // Load integration events
          const integrations = await listIntegrationsByAttempt(pgClient, a.id);
          for (const integ of integrations) {
            allIntegrations.push({
              id: integ.id,
              attemptId: a.id,
              targetRef: integ.target_ref,
              outcome: integ.outcome ?? null,
              resultingRevision: integ.resulting_revision ?? null,
              at: integ.at instanceof Date ? integ.at.toISOString() : String(integ.at),
            });
          }
        }
      }

      // Load artifacts via direct SQL (listArtifactsByAttempt not yet exported from @agencyhq/db index)
      type ArtifactRow = {
        id: string;
        attempt_id: string;
        revision: string;
        diff_digest: string;
        updated_at: Date;
      };
      let artifacts: typeof allArtifacts = [];
      if (allAttempts.length > 0) {
        const attemptIds = allAttempts.map((_, i) => `$${i + 1}`).join(", ");
        const { rows: _artifactRows } = await client.query(
          `SELECT id, attempt_id, revision, diff_digest, updated_at FROM artifacts WHERE attempt_id IN (${attemptIds}) ORDER BY created_at`,
          allAttempts.map((a) => a.id),
        );
        const artifactRows = _artifactRows as ArtifactRow[];
        artifacts = artifactRows.map((r) => ({
          id: r.id,
          attemptId: r.attempt_id,
          revision: r.revision,
          diffDigest: r.diff_digest,
          updatedAt: r.updated_at.toISOString(),
        }));
      }

      // Load approvals for decisions
      type ApprovalQueryRow = {
        id: string;
        decision_id: string;
        contract_id: string | null;
        contract_version: number | null;
        attempt_revision: string | null;
        human_actor: string | null;
        at: Date | null;
      };
      const allApprovals: Array<{
        id: string;
        decisionId: string;
        contractId: string | null;
        contractVersion: number | null;
        attemptRevision: string | null;
        humanActor: string | null;
        at: string | null;
      }> = [];
      for (const d of decisions) {
        const { rows: _approvalRows } = await client.query(
          `SELECT * FROM approvals WHERE decision_id = $1 ORDER BY created_at`,
          [d.id],
        );
        const approvalRows = _approvalRows as ApprovalQueryRow[];
        for (const r of approvalRows) {
          allApprovals.push({
            id: r.id,
            decisionId: r.decision_id,
            contractId: r.contract_id,
            contractVersion: r.contract_version,
            attemptRevision: r.attempt_revision,
            humanActor: r.human_actor,
            at: r.at ? r.at.toISOString() : null,
          });
        }
      }

      // Load manifest rows for this work item
      const manifestRows = await listWorkItemProjects(pgClient, id);

      const view = buildEvidenceView({
        workItemId: id,
        artifacts,
        verificationResults: allVerificationResults,
        reviews: allReviews,
        findings: allFindings,
        decisions: decisions.map((d) => ({
          id: d.id,
          kind: d.kind ?? "",
          actor: d.actor ?? "",
          outcome: d.outcome,
          contractVersion: d.contract_version,
          attemptId: d.attempt_id,
          at: d.at instanceof Date ? d.at.toISOString() : String(d.at),
        })),
        approvals: allApprovals,
        integrations: allIntegrations,
        manifestRows: manifestRows.map((r) => ({
          workItemId: id,
          position: r.position,
          resultRevision: r.result_revision ?? null,
        })),
        attempts: allAttempts,
      });

      return c.json(view);
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // GET /api/projects/:id/authority
  // ------------------------------------------------------------------
  app.get("/api/projects/:id/authority", async (c) => {
    const id = c.req.param("id");
    const client = await pool.connect();
    try {
      // Load project
      type ProjectQueryRow = { id: string; authority: unknown; authority_version: string };
      const { rows: _projectRows } = await client.query(
        `SELECT id, authority, authority_version FROM projects WHERE id = $1`,
        [id],
      );
      const projectRows = _projectRows as ProjectQueryRow[];

      if (projectRows.length === 0) {
        return c.json({ error: "project not found" }, 404);
      }

      const project = projectRows[0];
      if (!project) {
        return c.json({ error: "project not found" }, 404);
      }

      // Load authority history (migration 0004 table — direct SQL until merge packet lands)
      type HistoryQueryRow = { version: string; authority: unknown; actor: string; at: Date };
      let historyRows: HistoryQueryRow[] = [];
      try {
        const { rows: _historyRows } = await client.query(
          `SELECT version, authority, actor, at FROM authority_versions WHERE project_id = $1 ORDER BY at`,
          [id],
        );
        historyRows = _historyRows as HistoryQueryRow[];
      } catch {
        // Table may not exist yet — return empty history
      }

      // Parse authority via AuthoritySchema
      const { AuthoritySchema } = await import("@agencyhq/contracts");
      const currentAuthority = AuthoritySchema.parse(project.authority);

      const view = buildAuthorityView({
        projectId: id,
        currentVersion: project.authority_version,
        currentAuthority,
        history: historyRows.map((r) => ({
          version: r.version,
          authority: AuthoritySchema.parse(r.authority),
          actor: r.actor,
          at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
        })),
      });

      return c.json(view);
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/projects/:id/authority
  // ------------------------------------------------------------------
  app.put("/api/projects/:id/authority", async (c) => {
    const id = c.req.param("id");

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { commandId, authority, actor } = body;

    if (!commandId || typeof commandId !== "string") {
      return c.json({ error: "commandId is required" }, 400);
    }
    if (!authority || typeof authority !== "object") {
      return c.json({ error: "authority object is required" }, 400);
    }
    if (!actor || typeof actor !== "string") {
      return c.json({ error: "actor is required" }, 400);
    }

    if (!commands) {
      return c.json({ error: "update_authority not supported in this configuration" }, 400);
    }

    const result = await commands.updateAuthority({
      commandId,
      projectId: id,
      authority,
      actor,
    });

    return c.json({ commandId, result }, 200);
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
      // DISPATCH ORDERING NOTE: the coordinator dispatches work items one at a
      // time on demand (per-command). If a batch scheduler is ever added, call
      // selectDispatch({ workItems, activeAttempts, slots, uncertainRepositories,
      // mainEffortByCampaign }) from @agencyhq/domain here to select the next
      // item and respect campaign ordering (main-effort first within a campaign).
      //
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
        // Parse boundary: default to "artifact"; "merge" allowed when manifest supplied
        const boundaryVal = body.boundary === "merge" ? ("merge" as const) : ("artifact" as const);
        const createInput: Parameters<typeof commands.createWorkItem>[0] = {
          commandId,
          projectId,
          intent,
          boundary: boundaryVal,
          rank: typeof body.rank === "number" ? body.rank : 1,
        };
        if (defectVal !== undefined) {
          createInput.defect = defectVal;
        }
        // Attach manifest if provided
        if (body.manifest && typeof body.manifest === "object") {
          const manifestBody = body.manifest as { entries?: unknown[] };
          if (Array.isArray(manifestBody.entries)) {
            createInput.manifest = {
              entries: manifestBody.entries
                .filter(
                  (e): e is { projectId: string; targetRef: string } =>
                    typeof e === "object" &&
                    e !== null &&
                    typeof (e as Record<string, unknown>).projectId === "string" &&
                    typeof (e as Record<string, unknown>).targetRef === "string",
                )
                .map((e) => ({ projectId: e.projectId, targetRef: e.targetRef })),
            };
          }
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

      if (kind === "disposition") {
        const findingId = body.findingId;
        const disposition = body.disposition;
        if (!findingId || typeof findingId !== "string") {
          return c.json({ error: "findingId required for disposition" }, 400);
        }
        if (
          disposition !== "remediate" &&
          disposition !== "scope_decision" &&
          disposition !== "block" &&
          disposition !== "backlog"
        ) {
          return c.json(
            {
              error: "disposition must be one of: remediate, scope_decision, block, backlog",
            },
            400,
          );
        }
        const dispositionActor = typeof body.actor === "string" ? body.actor : "human";
        const dispositionReason = typeof body.reason === "string" ? body.reason : "";
        const result = await commands.disposition({
          commandId,
          findingId,
          disposition,
          reason: dispositionReason,
          actor: dispositionActor,
        });
        return c.json({ commandId, replayed: false, result }, 200);
      }

      // Control-plane commands (slice 5)

      if (kind === "reject") {
        const workItemId = body.workItemId;
        const decisionId = body.decisionId;
        const reason = typeof body.reason === "string" ? body.reason : "operator rejected";
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for reject" }, 400);
        }
        if (!decisionId || typeof decisionId !== "string") {
          return c.json({ error: "decisionId required for reject" }, 400);
        }
        const result = await commands.reject({ commandId, workItemId, decisionId, reason });
        return c.json({ commandId, result }, 200);
      }

      if (kind === "invalidate_acceptance") {
        const workItemId = body.workItemId;
        const attemptId = body.attemptId;
        const reason = typeof body.reason === "string" ? body.reason : "acceptance invalidated";
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for invalidate_acceptance" }, 400);
        }
        if (!attemptId || typeof attemptId !== "string") {
          return c.json({ error: "attemptId required for invalidate_acceptance" }, 400);
        }
        const result = await commands.invalidateAcceptance({
          commandId,
          workItemId,
          attemptId,
          reason,
        });
        return c.json({ commandId, result }, 200);
      }

      if (kind === "create_campaign") {
        const name = body.name;
        if (!name || typeof name !== "string") {
          return c.json({ error: "name required for create_campaign" }, 400);
        }
        const result = await commands.createCampaign({ commandId, name });
        return c.json({ commandId, result }, 200);
      }

      if (kind === "assign_campaign") {
        const workItemId = body.workItemId;
        const campaignId = body.campaignId;
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for assign_campaign" }, 400);
        }
        if (!campaignId || typeof campaignId !== "string") {
          return c.json({ error: "campaignId required for assign_campaign" }, 400);
        }
        const result = await commands.assignCampaign({ commandId, workItemId, campaignId });
        return c.json({ commandId, result }, 200);
      }

      if (kind === "set_main_effort") {
        const campaignId = body.campaignId;
        const workItemId = body.workItemId;
        if (!campaignId || typeof campaignId !== "string") {
          return c.json({ error: "campaignId required for set_main_effort" }, 400);
        }
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for set_main_effort" }, 400);
        }
        const result = await commands.setMainEffort({ commandId, campaignId, workItemId });
        return c.json({ commandId, result }, 200);
      }

      if (kind === "set_rank") {
        const workItemId = body.workItemId;
        const rank = body.rank;
        const expectedVersion = body.expectedVersion;
        if (!workItemId || typeof workItemId !== "string") {
          return c.json({ error: "workItemId required for set_rank" }, 400);
        }
        if (typeof rank !== "number") {
          return c.json({ error: "rank (number) required for set_rank" }, 400);
        }
        if (typeof expectedVersion !== "number") {
          return c.json({ error: "expectedVersion (number) required for set_rank" }, 400);
        }
        const result = await commands.setWorkItemRank({
          commandId,
          workItemId,
          rank,
          expectedVersion,
        });
        return c.json({ commandId, result }, 200);
      }

      if (kind === "update_authority") {
        const projectId = body.projectId;
        const authority = body.authority;
        const actor = typeof body.actor === "string" ? body.actor : "operator";
        if (!projectId || typeof projectId !== "string") {
          return c.json({ error: "projectId required for update_authority" }, 400);
        }
        if (!authority || typeof authority !== "object") {
          return c.json({ error: "authority object required for update_authority" }, 400);
        }
        const result = await commands.updateAuthority({ commandId, projectId, authority, actor });
        return c.json({ commandId, result }, 200);
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
