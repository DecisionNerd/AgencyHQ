/**
 * BoundedRepairFlow — drives the plan → admit → dispatch → observe → verify
 * → review → accept lifecycle for a single WorkItem at the `artifact` boundary.
 *
 * INVARIANTS:
 * - Every state change: domain transition validated → committed in a transaction
 *   → THEN runtime.trigger() (R-002).
 * - Lead outputs are proposals: checked via checkProposal / evaluateAcceptance
 *   before any Decision is recorded (R-001).
 * - Every method is idempotent via claimCommand / completeCommand.
 * - No @trigger.dev/sdk or @opencode-ai/sdk imports.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  Authority,
  BoundaryKind,
  ContractBounds,
  Criterion,
  Digest,
  LeadPlanOutput,
  ReviewProfile,
  VerificationResult,
} from "@agencyhq/contracts";
import {
  AcceptanceProposalSchema,
  manifestDigest as contractManifestDigest,
  criteriaDigestInput,
  digestOf,
  IntegrateMergePayloadSchema,
  LeadAcceptPayloadSchema,
  LeadPlanPayloadSchema,
  LeadReviewPayloadSchema,
  permissionRulesFor,
  ReviewOutputSchema,
  TASK_IDS,
  VerifyRunOutputSchema,
  VerifyRunPayloadSchema,
  WorkerAttemptOutputSchema,
  WorkerAttemptPayloadSchema,
} from "@agencyhq/contracts";
import {
  applyObservation,
  claimCommand,
  completeCommand,
  type createPool,
  insertApproval,
  insertIntegration,
  insertTransition,
  insertWorkItemProjects,
  listWorkItemProjects,
} from "@agencyhq/db";
import {
  type AcceptanceFailureReason,
  type ApprovalLike,
  type ArtifactId,
  type AttemptId,
  checkBoundarySupport,
  checkProposal,
  classifyObservation,
  type DecisionId,
  type DispatchIntentId,
  detectVerifierTampering,
  enforceable,
  evaluateAcceptance,
  type FailureId,
  type FindingId,
  freezeContract,
  type ManifestEntry,
  nextEntry,
  type ProjectId,
  type ReviewId,
  type RunObservation,
  requiredBoundariesFor,
  requiresApproval,
  type StepContractId,
  type VerificationResultId,
  type WorkItemId,
} from "@agencyhq/domain";
import type pg from "pg";

import { deriveTargetRef } from "./integrate.ts";
import type { FlowDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Row types (raw DB rows, accessed via pool.query)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  remote: string | null;
  clone_path: string | null;
  worktree_base: string | null;
  authority: Authority;
  authority_version: string;
  profile_catalog?: unknown;
  allowed_refs: unknown;
}

interface WorkItemRow {
  id: string;
  project_id: string;
  intent: string;
  defect: string | null;
  boundary: "artifact" | "merge" | "deploy";
  lifecycle: string;
  condition: string;
  version: number;
}

interface StepContractRow {
  id: string;
  work_item_id: string;
  project_id: string;
  version: number;
  base_revision: string;
  profile_id: string;
  profile_digest: string;
  criteria_digest: string;
  bounds: ContractBounds;
  criteria: Criterion[];
  required_boundaries: string[];
  human_required: boolean;
  status: string;
  inputs: { intent: string; defect?: string };
  target_ref: string | null;
}

interface AttemptRow {
  id: string;
  contract_id: string;
  contract_version: number;
  generation: number;
  status: string;
  run_id: string | null;
  commit_sha: string | null;
  diff_digest: string | null;
  worktree_path: string | null;
  budget_remaining: number;
  failure_id: string | null;
}

interface DispatchIntentRow {
  id: string;
  task: string;
  payload_digest: string;
  attempt_id: string | null;
  status: string;
  run_id: string | null;
  idempotency_key: string;
}

interface ArtifactRow {
  id: string;
  attempt_id: string;
  revision: string;
  diff_digest: string;
  changed_paths: string[];
}

interface ReviewRow {
  id: string;
  attempt_id: string;
  attempt_revision: string | null;
  diff_digest: string | null;
  criteria_digest: string | null;
  profile_digest: string | null;
  reviewer_model: string | null;
  profile: string | null;
  findings: unknown[];
}

type Pool = ReturnType<typeof createPool>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function baseRevisionFromProject(projectRow: ProjectRow): Promise<string> {
  if (
    projectRow.allowed_refs &&
    typeof projectRow.allowed_refs === "object" &&
    "main" in (projectRow.allowed_refs as Record<string, unknown>)
  ) {
    const v = (projectRow.allowed_refs as Record<string, string>).main;
    if (typeof v === "string" && /^[0-9a-f]{40}$/.test(v)) return v;
  }
  // No stored revision: the base is the clone's current HEAD (host profile,
  // one clone per project). Observed 2026-09-07 in the Slice 3 trial: a zero
  // revision made the Lead worktree add fail before any model call.
  if (projectRow.clone_path) {
    const { stdout } = await execFileAsync("git", [
      "-C",
      projectRow.clone_path,
      "rev-parse",
      "HEAD",
    ]);
    return stdout.trim();
  }
  throw new Error(`project ${projectRow.id} has no base revision and no clone path`);
}

async function loadProject(pool: Pool, projectId: string): Promise<ProjectRow> {
  const { rows } = await pool.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  const row = rows[0];
  if (!row) throw new Error(`Project ${projectId} not found`);
  return row as ProjectRow;
}

async function loadWorkItem(pool: Pool, workItemId: string): Promise<WorkItemRow> {
  const { rows } = await pool.query("SELECT * FROM work_items WHERE id = $1", [workItemId]);
  const row = rows[0];
  if (!row) throw new Error(`WorkItem ${workItemId} not found`);
  return row as WorkItemRow;
}

async function loadContract(pool: Pool, contractId: string): Promise<StepContractRow> {
  const { rows } = await pool.query("SELECT * FROM step_contracts WHERE id = $1", [contractId]);
  const row = rows[0];
  if (!row) throw new Error(`StepContract ${contractId} not found`);
  return row as StepContractRow;
}

async function loadAttemptByRunId(pool: Pool, runId: string): Promise<AttemptRow> {
  const { rows } = await pool.query("SELECT * FROM attempts WHERE run_id = $1", [runId]);
  const row = rows[0];
  if (!row) throw new Error(`Attempt for runId ${runId} not found`);
  return row as AttemptRow;
}

async function loadAttempt(pool: Pool, attemptId: string): Promise<AttemptRow> {
  const { rows } = await pool.query("SELECT * FROM attempts WHERE id = $1", [attemptId]);
  const row = rows[0];
  if (!row) throw new Error(`Attempt ${attemptId} not found`);
  return row as AttemptRow;
}

async function loadIntent(pool: Pool, intentId: string): Promise<DispatchIntentRow> {
  const { rows } = await pool.query("SELECT * FROM dispatch_intents WHERE id = $1", [intentId]);
  const row = rows[0];
  if (!row) throw new Error(`Intent ${intentId} not found`);
  return row as DispatchIntentRow;
}

async function loadIntentByRunAndTask(
  pool: Pool,
  runId: string,
  task: string,
): Promise<DispatchIntentRow> {
  const { rows } = await pool.query(
    "SELECT * FROM dispatch_intents WHERE run_id = $1 AND task = $2 ORDER BY created_at DESC LIMIT 1",
    [runId, task],
  );
  const row = rows[0];
  if (!row) throw new Error(`Intent for runId ${runId} task ${task} not found`);
  return row as DispatchIntentRow;
}

async function loadArtifact(pool: Pool, attemptId: string): Promise<ArtifactRow | null> {
  const { rows } = await pool.query(
    "SELECT * FROM artifacts WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1",
    [attemptId],
  );
  return (rows[0] as ArtifactRow | undefined) ?? null;
}

async function loadReview(pool: Pool, attemptId: string): Promise<ReviewRow | null> {
  const { rows } = await pool.query(
    "SELECT * FROM reviews WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1",
    [attemptId],
  );
  return (rows[0] as ReviewRow | undefined) ?? null;
}

async function loadVerificationResults(
  pool: Pool,
  attemptId: string,
): Promise<VerificationResult[]> {
  const { rows } = await pool.query(
    "SELECT record FROM verification_results WHERE attempt_id = $1 ORDER BY created_at",
    [attemptId],
  );
  return rows.map((r: { record: unknown }) => r.record as VerificationResult);
}

/** Extract workItemId from a lead.plan idempotency key: `leadplan:${workItemId}:${intentId}`. */
function workItemIdFromPlanIntentKey(ikey: string): string | null {
  if (!ikey.startsWith("leadplan:")) return null;
  const parts = ikey.split(":");
  if (parts.length < 3) return null;
  return parts[1] ?? null;
}

/**
 * Extract the dispatched generation from a worker intent's idempotency key.
 *
 * Worker intent keys use the format `<intentId>:g<generation>` so the
 * coordinator can tell the observation's dispatched generation from the
 * attempt's current (possibly revoked) generation (F-2).
 *
 * Returns 1 as a backward-compatible default for intents without a suffix.
 */
export function generationOfIntent(intentRow: { idempotency_key: string }): number {
  const match = /:g(\d+)$/.exec(intentRow.idempotency_key);
  if (match?.[1]) return Number.parseInt(match[1], 10);
  return 1;
}

/** Build the standard trigger tags for a contract attempt. */
function triggerTags(opts: {
  projectId: string;
  workItemId: string;
  contractId: string;
  contractVersion: number;
  attemptId: string;
}): string[] {
  return [
    `project:${opts.projectId}`,
    `workItem:${opts.workItemId}`,
    `contract:${opts.contractId}:${opts.contractVersion}`,
    `attempt:${opts.attemptId}`,
  ];
}

// ---------------------------------------------------------------------------
// Shared acceptance evaluation — used by onAcceptFinal and approveWorkItem
// ---------------------------------------------------------------------------

/**
 * Context returned by evaluateAcceptanceForAttempt.
 * Provides everything the caller needs to record the decision and update state.
 */
export type AcceptanceEvalContext = {
  acceptResult: { ok: true } | { ok: false; reasons: AcceptanceFailureReason[] };
  humanRequired: boolean;
  workItemId: string;
  contractId: string;
  contractVersion: number;
  attemptId: string;
  artifactRevision: string;
  profileId: string;
};

/**
 * Load all data needed for acceptance evaluation and run the domain gate.
 *
 * Called by onAcceptFinal (approval=undefined, normal flow) and by the
 * approve command (with the human Approval supplied).  Avoids duplication
 * of the acceptance-evaluation rule (R-001).
 */
export async function evaluateAcceptanceForAttempt(
  pool: Pool,
  config: Pick<import("./types.ts").FlowConfig, "workerModel">,
  attemptId: string,
  proposal: import("@agencyhq/contracts").AcceptanceProposal,
  approval?: ApprovalLike,
): Promise<AcceptanceEvalContext> {
  const attemptRow = await loadAttempt(pool, attemptId);
  const contractRow = await loadContract(pool, attemptRow.contract_id);
  const artifactRow = await loadArtifact(pool, attemptRow.id);
  const reviewRow = await loadReview(pool, attemptRow.id);
  const verificationResults = await loadVerificationResults(pool, attemptRow.id);

  // Load blocking verifier_tampered findings for this attempt (R-017).
  const { rows: integrityFindingRows } = await pool.query(
    `SELECT id, severity, kind, description, evidence FROM findings
     WHERE attempt_id = $1 AND kind = 'verifier_tampered' AND severity = 'blocking'`,
    [attemptRow.id],
  );
  const integrityFindings = integrityFindingRows.map(
    (r: { id: string; severity: string; kind: string; description: string; evidence: string }) => ({
      id: r.id,
      severity: r.severity as "blocking" | "non_blocking",
      kind: r.kind,
      description: r.description,
      evidence: r.evidence ?? "",
    }),
  );

  const acceptResult = evaluateAcceptance({
    contract: {
      id: contractRow.id,
      workItemId: contractRow.work_item_id,
      projectId: contractRow.project_id,
      version: contractRow.version,
      baseRevision: contractRow.base_revision,
      inputs: contractRow.inputs,
      criteria: contractRow.criteria,
      criteriaDigest: contractRow.criteria_digest,
      profileId: contractRow.profile_id,
      profileDigest: contractRow.profile_digest,
      bounds: contractRow.bounds,
      requiredBoundaries: contractRow.required_boundaries as BoundaryKind[],
      humanRequired: contractRow.human_required,
      status: contractRow.status as "active" | "superseded",
    },
    attempt: {
      id: attemptRow.id,
      contractId: attemptRow.contract_id,
      contractVersion: attemptRow.contract_version,
      generation: attemptRow.generation,
    },
    artifact: {
      revision: artifactRow?.revision ?? "",
      diffDigest: (artifactRow?.diff_digest ?? "") as Digest,
      changedPaths: artifactRow?.changed_paths ?? [],
    },
    results: verificationResults,
    review: reviewRow
      ? {
          attemptRevision: reviewRow.attempt_revision ?? "",
          diffDigest: (reviewRow.diff_digest ?? "") as Digest,
          criteriaDigest: (reviewRow.criteria_digest ?? "") as Digest,
          profileDigest: (reviewRow.profile_digest ?? "") as Digest,
          reviewerModel: reviewRow.reviewer_model ?? "",
          profile: (reviewRow.profile ?? "lead_inspection") as ReviewProfile,
          findings: reviewRow.findings as Array<{
            id: string;
            severity: "blocking" | "non_blocking";
            kind: string;
            description: string;
            evidence: string;
            disposition?: string;
          }>,
        }
      : undefined,
    proposal,
    approval,
    reviewerMustDiffer: contractRow.bounds?.models?.reviewer !== contractRow.bounds?.models?.worker,
    workerModel: config.workerModel,
    integrityFindings,
  });

  return {
    acceptResult,
    humanRequired: contractRow.human_required,
    workItemId: contractRow.work_item_id,
    contractId: contractRow.id,
    contractVersion: contractRow.version,
    attemptId: attemptRow.id,
    artifactRevision: artifactRow?.revision ?? "",
    profileId: contractRow.profile_id,
  };
}

// ---------------------------------------------------------------------------
// Shared post-acceptance effect — used by onAcceptFinal and approveWorkItem
// ---------------------------------------------------------------------------

/**
 * Options for finalizeAcceptedAttempt.
 */
export type FinalizeAcceptedOpts = {
  /** Pre-generated decision UUID to insert. */
  decisionId: string;
  /** "coordinator" for automatic acceptance, "human" for human-approved acceptance. */
  decisionActor: "coordinator" | "human";
  /** The commandId for transition causation (used in audit rows). */
  commandId: string;
  /**
   * The id of the incoming accept dispatch_intent to close (F-5).
   * Only provided when called from onAcceptFinal.
   */
  intentId?: string;
  /**
   * Approval data to insert in the same transaction.
   * Only provided when called from approveWorkItem.
   */
  approval?: {
    id: string;
    attemptRevision: string;
    actor: string;
  };
};

/**
 * Result of finalizeAcceptedAttempt.
 */
export type FinalizeAcceptedResult =
  | { boundary: "artifact" }
  | { boundary: "merge"; mergeIntentId: string; mergeRunId: string };

/**
 * Executes the post-acceptance DB writes and (for merge) runtime trigger.
 *
 * Merge path: decision + approval? + integrations row + dispatch_intent committed
 * in ONE transaction before trigger (R-002). Work item is NOT completed.
 *
 * Artifact path: decision + approval? + work_item completed in ONE transaction.
 *
 * Called by both onAcceptFinal (coordinator) and approveWorkItem (human).
 * Idempotency is the caller's responsibility (claimCommand / completeCommand).
 */
export async function finalizeAcceptedAttempt(
  pool: Pool,
  runtime: FlowDeps["runtime"],
  worktreeBase: string,
  client: pg.PoolClient,
  ctx: AcceptanceEvalContext,
  at: Date,
  opts: FinalizeAcceptedOpts,
): Promise<FinalizeAcceptedResult> {
  const contractRow = await loadContract(pool, ctx.contractId);
  const projectRow = await loadProject(pool, contractRow.project_id);
  const boundary = contractRow.bounds.boundary;
  // "approved" for human-reviewed acceptance; "accepted" for coordinator (automatic) acceptance.
  const decisionOutcome = opts.decisionActor === "human" ? "approved" : "accepted";

  if (boundary === "merge") {
    // Merge boundary: record acceptance, insert integration row and
    // dispatch intent in ONE transaction, then trigger (R-002).
    const targetRef = contractRow.target_ref ?? deriveTargetRef(projectRow.allowed_refs);
    const expectedBaseRevision = contractRow.base_revision;

    const attemptRow = await loadAttempt(pool, ctx.attemptId);
    const integrationId = randomUUID();
    const mergeIntentId = randomUUID() as unknown as DispatchIntentId;
    const mergeIdempotencyKey = `${String(mergeIntentId)}:g${String(attemptRow.generation)}`;

    const mergePayload = IntegrateMergePayloadSchema.parse({
      attemptId: ctx.attemptId,
      generation: attemptRow.generation,
      contractId: ctx.contractId,
      contractVersion: ctx.contractVersion,
      projectId: contractRow.project_id,
      repoPath: projectRow.clone_path ?? worktreeBase,
      remote: projectRow.remote ?? "origin",
      targetRef,
      expectedBaseRevision,
      attemptRevision: ctx.artifactRevision,
      strategy: "merge_commit",
    });

    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id,
            causation_id, command_id, outcome, at)
         VALUES ($1, 'accept', $2, $3, $4, $5, $6, $7, $7, $8, $9)`,
        [
          opts.decisionId,
          opts.decisionActor,
          ctx.workItemId,
          ctx.contractId,
          ctx.contractVersion,
          ctx.attemptId,
          opts.commandId,
          decisionOutcome,
          at,
        ],
      );

      // Insert approval row in same transaction (human-approved path only).
      if (opts.approval) {
        await insertApproval(client, {
          id: opts.approval.id,
          decision_id: opts.decisionId,
          contract_id: ctx.contractId,
          contract_version: ctx.contractVersion,
          attempt_revision: opts.approval.attemptRevision,
          human_actor: opts.approval.actor,
          at,
        });
      }

      // Insert integration row (idempotent on conflict).
      await insertIntegration(client, {
        id: integrationId,
        attempt_id: ctx.attemptId,
        contract_id: ctx.contractId,
        contract_version: ctx.contractVersion,
        target_ref: targetRef,
        expected_base_revision: expectedBaseRevision,
      });

      // Insert dispatch intent for integrate.merge (R-002: committed before trigger).
      await client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
        [
          String(mergeIntentId),
          TASK_IDS.integrateMerge,
          String(digestOf(mergePayload)),
          ctx.attemptId,
          mergeIdempotencyKey,
        ],
      );

      // Close incoming accept intent (F-5) if provided.
      if (opts.intentId) {
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [opts.intentId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    // Trigger integrate.merge AFTER commit (R-002).
    const { runId: mergeRunId } = await runtime.trigger({
      intentId: mergeIntentId,
      task: TASK_IDS.integrateMerge,
      payload: mergePayload,
      options: {
        idempotencyKey: mergeIdempotencyKey,
        concurrencyKey: contractRow.project_id,
        tags: [
          `project:${contractRow.project_id}`,
          `workItem:${ctx.workItemId}`,
          `contract:${ctx.contractId}:${String(ctx.contractVersion)}`,
          `attempt:${ctx.attemptId}`,
        ],
      },
    });

    await pool.query(
      "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
      [String(mergeIntentId), mergeRunId],
    );

    return { boundary: "merge", mergeIntentId: String(mergeIntentId), mergeRunId };
  } else {
    // Artifact boundary: complete work item immediately.
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id,
            causation_id, command_id, outcome, at)
         VALUES ($1, 'accept', $2, $3, $4, $5, $6, $7, $7, $8, $9)`,
        [
          opts.decisionId,
          opts.decisionActor,
          ctx.workItemId,
          ctx.contractId,
          ctx.contractVersion,
          ctx.attemptId,
          opts.commandId,
          decisionOutcome,
          at,
        ],
      );

      // Insert approval row in same transaction (human-approved path only).
      if (opts.approval) {
        await insertApproval(client, {
          id: opts.approval.id,
          decision_id: opts.decisionId,
          contract_id: ctx.contractId,
          contract_version: ctx.contractVersion,
          attempt_revision: opts.approval.attemptRevision,
          human_actor: opts.approval.actor,
          at,
        });
      }

      await client.query(
        `UPDATE work_items
         SET lifecycle = 'completed', boundary = 'artifact',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [ctx.workItemId],
      );

      // Close incoming accept intent (F-5) if provided.
      if (opts.intentId) {
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [opts.intentId],
        );
      }

      // Transition audit row for work item completion.
      await insertTransition(client, {
        aggregate: "work_item",
        aggregate_id: ctx.workItemId,
        from_state: "active",
        to_state: "completed",
        actor: opts.decisionActor,
        causation_id: opts.commandId,
        command_id: opts.commandId,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    return { boundary: "artifact" };
  }
}

// ---------------------------------------------------------------------------
// BoundedRepairFlow
// ---------------------------------------------------------------------------

export class BoundedRepairFlow {
  private readonly deps: FlowDeps;

  constructor(deps: FlowDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // plan
  // -------------------------------------------------------------------------

  async plan(workItemId: string, commandId: string): Promise<{ intentId: string; runId: string }> {
    const { pool, runtime, ids, config } = this.deps;

    const client = await pool.connect();
    try {
      const claim = await claimCommand(client, commandId, "plan");
      if (!claim.claimed) {
        const stored = claim.result as { intentId: string; runId: string } | null;
        if (stored) return stored;
        throw new Error(`Command ${commandId} is in-flight; retry later`);
      }

      const wiRow = await loadWorkItem(pool, workItemId);

      // Check if this is a manifest work item: load work_item_projects rows.
      const wipRows = await listWorkItemProjects(client, workItemId);
      let targetProjectRow: ProjectRow;
      let manifestForPayload: { entries: ManifestEntry[]; digest: string } | undefined;

      if (wipRows.length > 0) {
        // Manifest item: build entries and target the first unresolved entry.
        const manifestEntries: ManifestEntry[] = wipRows.map((row) => ({
          position: row.position,
          projectId: row.project_id,
          targetRef: row.target_ref,
          expectedBaseRevision: row.expected_base_revision,
          resultRevision: row.result_revision,
        }));
        const firstEntry = nextEntry(manifestEntries);
        if (!firstEntry) {
          // All entries already resolved — nothing to plan.
          await completeCommand(client, commandId, { skipped: "all_resolved" });
          return { intentId: "", runId: "" };
        }
        targetProjectRow = await loadProject(pool, firstEntry.projectId);
        manifestForPayload = {
          entries: manifestEntries,
          digest: String(contractManifestDigest(manifestEntries)),
        };
      } else {
        targetProjectRow = await loadProject(pool, wiRow.project_id);
      }

      const baseRevision = await baseRevisionFromProject(targetProjectRow);

      const payload = LeadPlanPayloadSchema.parse({
        workItemId: wiRow.id,
        projectId: targetProjectRow.id,
        repoPath: targetProjectRow.clone_path ?? config.worktreeBase,
        baseRevision,
        worktreeBase: config.worktreeBase,
        authority: targetProjectRow.authority,
        profileCatalog: Array.isArray(targetProjectRow.profile_catalog)
          ? (targetProjectRow.profile_catalog as string[])
          : [],
        ...(wiRow.defect ? { defect: wiRow.defect } : {}),
        operatorIntent: wiRow.intent,
        model: config.leadModel,
        ...(manifestForPayload ? { manifest: manifestForPayload } : {}),
      });

      const intentId = ids.next("di") as DispatchIntentId;
      const idempotencyKey = `leadplan:${workItemId}:${String(intentId)}`;
      const payloadDigest = digestOf(payload);

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, $3, NULL, 'recorded', NULL, $4)`,
        [String(intentId), TASK_IDS.leadPlan, String(payloadDigest), idempotencyKey],
      );
      await client.query("COMMIT");

      const { runId } = await runtime.trigger({
        intentId,
        task: TASK_IDS.leadPlan,
        payload,
        options: {
          idempotencyKey,
          tags: [`project:${targetProjectRow.id}`, `workItem:${wiRow.id}`],
        },
      });

      await pool.query(
        "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
        [String(intentId), runId],
      );

      const result = { intentId: String(intentId), runId };
      await completeCommand(client, commandId, result);
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // onLeadPlanOutput
  // -------------------------------------------------------------------------

  async onLeadPlanOutput(
    intentId: string,
    output: LeadPlanOutput,
    commandId: string,
  ): Promise<void> {
    const { pool, runtime, ids, config, profile, profileResolver } = this.deps;

    const client = await pool.connect();
    try {
      const claim = await claimCommand(client, commandId, "onLeadPlanOutput");
      if (!claim.claimed) return;

      const intentRow = await loadIntent(pool, intentId);

      const workItemId = workItemIdFromPlanIntentKey(intentRow.idempotency_key);
      if (!workItemId) throw new Error(`Cannot recover workItemId from intent ${intentId}`);

      const wiRow = await loadWorkItem(pool, workItemId);

      // For manifest work items, use the next unresolved entry's project.
      const wipRows = await listWorkItemProjects(client, workItemId);
      let projectRow: ProjectRow;
      let activeEntryTargetRef: string | null = null;
      let manifestDigestValue: string | null = null;
      if (wipRows.length > 0) {
        const manifestEntries: ManifestEntry[] = wipRows.map((row) => ({
          position: row.position,
          projectId: row.project_id,
          targetRef: row.target_ref,
          expectedBaseRevision: row.expected_base_revision,
          resultRevision: row.result_revision,
        }));
        const activeEntry = nextEntry(manifestEntries);
        projectRow = await loadProject(pool, activeEntry?.projectId ?? wiRow.project_id);
        activeEntryTargetRef = activeEntry?.targetRef ?? null;
        manifestDigestValue = String(contractManifestDigest(manifestEntries));
      } else {
        projectRow = await loadProject(pool, wiRow.project_id);
      }

      const at = new Date();
      const decisionId = ids.next("dec") as DecisionId;

      if (output.kind !== "proposal") {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions (id, kind, actor, work_item_id, outcome, at)
           VALUES ($1, 'plan', 'coordinator', $2, 'pending_human', $3)`,
          [String(decisionId), workItemId, at],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          decisionId: String(decisionId),
          kind: output.kind,
        });
        return;
      }

      const { proposal } = output;

      // R-001: authority subset check before any Decision
      const authorityCheck = checkProposal(projectRow.authority, proposal);
      if (!authorityCheck.ok) {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions (id, kind, actor, work_item_id, outcome, at)
           VALUES ($1, 'plan', 'coordinator', $2, 'pending_human', $3)`,
          [String(decisionId), workItemId, at],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          decisionId: String(decisionId),
          violations: authorityCheck.violations,
        });
        return;
      }

      const bounds: ContractBounds = {
        paths: proposal.paths,
        capabilities: proposal.capabilities,
        boundary: proposal.boundary,
        budget: proposal.budget,
        review: proposal.review,
        changeClass: proposal.changeClass,
        models: proposal.models,
      };

      const approvalCheck = requiresApproval(projectRow.authority, bounds);
      const reqBoundaries = requiredBoundariesFor(bounds);
      const enforceCheck = enforceable(profile, reqBoundaries);

      // Only block when the runtime CANNOT enforce required boundaries.
      // humanRequired=true means a human Approval is needed before accept,
      // but the worker attempt still runs (stored on the contract).
      if (!enforceCheck.ok) {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions (id, kind, actor, work_item_id, outcome, at)
           VALUES ($1, 'plan', 'coordinator', $2, 'pending_human', $3)`,
          [String(decisionId), workItemId, at],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          decisionId: String(decisionId),
          unenforceableReasons: enforceCheck,
        });
        return;
      }

      // R-016: reject proposals for boundaries the coordinator cannot execute.
      // deploy is not yet implemented; merge is supported.
      const boundarySupportViolation = checkBoundarySupport(bounds);
      if (boundarySupportViolation) {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions (id, kind, actor, work_item_id, outcome, at)
           VALUES ($1, 'plan', 'coordinator', $2, 'pending_human', $3)`,
          [String(decisionId), workItemId, at],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          decisionId: String(decisionId),
          violations: [boundarySupportViolation],
        });
        return;
      }

      const catalog = Array.isArray(projectRow.profile_catalog)
        ? (projectRow.profile_catalog as string[])
        : [];
      let resolvedProfile: Awaited<ReturnType<typeof profileResolver>> | null = null;
      if (catalog.includes(proposal.profileId)) {
        try {
          resolvedProfile = await profileResolver(proposal.profileId);
        } catch {
          resolvedProfile = null;
        }
      }
      if (!resolvedProfile) {
        // A profile outside the project catalog is outside authority (the
        // catalog is the ceiling for verification); record a pending human
        // decision rather than freezing a contract whose checks do not exist.
        // Observed 2026-09-07: the Lead invented "reject-empty-parser-input".
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions (id, kind, actor, work_item_id, outcome, at)
           VALUES ($1, 'plan', 'coordinator', $2, 'pending_human', $3)`,
          [String(decisionId), workItemId, at],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          decisionId: String(decisionId),
          violations: [
            {
              code: "PROFILE_NOT_IN_CATALOG",
              path: "profileId",
              detail: `${proposal.profileId} is not in the project catalog [${catalog.join(", ")}]`,
            },
          ],
        });
        return;
      }
      const profileDigest = resolvedProfile.digest as Digest;
      const criteriaDigest = digestOf(criteriaDigestInput(proposal.criteria)) as Digest;
      const baseRevision = await baseRevisionFromProject(projectRow);

      const contractId = ids.next("sc") as StepContractId;

      const contract = freezeContract({
        proposal,
        decisionId,
        workItem: {
          id: wiRow.id as WorkItemId,
          projectId: wiRow.project_id as ProjectId,
          intent: wiRow.intent,
          ...(wiRow.defect ? { defect: wiRow.defect } : {}),
        },
        project: { id: projectRow.id as ProjectId },
        baseRevision,
        profileDigest,
        criteriaDigest,
        requiredBoundaries: reqBoundaries,
        humanRequired: approvalCheck.required,
        version: 1,
        id: contractId,
      });

      const attemptId = ids.next("att") as AttemptId;
      const budgetRemaining = contract.bounds.budget.maxAttempts;
      const workerIntentId = ids.next("di") as DispatchIntentId;

      const worktreePath = `${config.worktreeBase}/${String(attemptId)}`;
      const workerPayload = WorkerAttemptPayloadSchema.parse({
        attemptId: String(attemptId),
        generation: 1,
        contractId: String(contractId),
        contractVersion: String(contract.version),
        repoPath: projectRow.clone_path ?? config.worktreeBase,
        baseRev: baseRevision,
        prompt: wiRow.intent,
        allowedPaths: bounds.paths.allow,
        bounds,
        permissionRules: permissionRulesFor(bounds, { worktreePath }),
        model: config.workerModel,
        worktreeBase: config.worktreeBase,
      });

      const workerPayloadDigest = digestOf(workerPayload);

      // For merge boundary: freeze target_ref.
      // Prefer target_ref from manifest (stored in work_item_projects); fall back to derived.
      const mergeTargetRef =
        bounds.boundary === "merge"
          ? (activeEntryTargetRef ?? deriveTargetRef(projectRow.allowed_refs))
          : null;

      // Commit Decision + StepContract + Attempt + DispatchIntent atomically (R-002)
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO decisions
           (id, kind, actor, proposal_digest, authority_version, work_item_id,
            contract_id, contract_version, outcome, at)
         VALUES ($1, 'plan', 'coordinator', $2, $3, $4, $5, $6, 'accepted', $7)`,
        [
          String(decisionId),
          String(digestOf(proposal)),
          projectRow.authority_version,
          workItemId,
          String(contractId),
          contract.version,
          at,
        ],
      );

      await client.query(
        `INSERT INTO step_contracts
           (id, work_item_id, project_id, version, base_revision, inputs, criteria,
            criteria_digest, profile_id, profile_digest, bounds, required_boundaries,
            human_required, status, target_ref, manifest_digest)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb, $13, 'active', $14, $15)`,
        [
          String(contractId),
          String(contract.workItemId),
          String(contract.projectId),
          contract.version,
          contract.baseRevision,
          JSON.stringify(contract.inputs),
          JSON.stringify(contract.criteria),
          String(contract.criteriaDigest),
          contract.profileId,
          String(contract.profileDigest),
          JSON.stringify(contract.bounds),
          JSON.stringify(contract.requiredBoundaries),
          contract.humanRequired,
          mergeTargetRef,
          manifestDigestValue,
        ],
      );

      // For merge boundary with no pre-existing manifest rows: create single-repo work_item_projects.
      // When work_item_projects already exist (from create_work_item with manifest), skip insert.
      if (bounds.boundary === "merge" && mergeTargetRef && wipRows.length === 0) {
        await insertWorkItemProjects(client, workItemId, [
          {
            project_id: String(contract.projectId),
            position: 0,
            target_ref: mergeTargetRef,
            expected_base_revision: contract.baseRevision,
          },
        ]);
      }

      await client.query(
        `INSERT INTO attempts
           (id, contract_id, contract_version, generation, status, budget_remaining)
         VALUES ($1, $2, $3, 1, 'admitted', $4)`,
        [String(attemptId), String(contractId), contract.version, budgetRemaining],
      );

      // Worker intent idempotency_key encodes the dispatched generation (F-2).
      const workerIntentKey = `${String(workerIntentId)}:g1`;

      await client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
        [
          String(workerIntentId),
          TASK_IDS.workerAttempt,
          String(workerPayloadDigest),
          String(attemptId),
          workerIntentKey,
        ],
      );

      // Close the incoming lead.plan intent inside the same transaction (F-5).
      await client.query(
        "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
        [intentId],
      );

      // Activate the work item now that a contract + worker are admitted.
      // Raw SQL (no domain transition): the real system starts work items in
      // "admitted" (createWorkItem) and transitions proposed→active or
      // admitted→active here. The guard prevents downgrading a halted/completed item.
      await client.query(
        `UPDATE work_items
         SET lifecycle = 'active', version = version + 1, updated_at = now()
         WHERE id = $1 AND lifecycle NOT IN ('active', 'completed', 'halted')`,
        [workItemId],
      );

      await client.query("COMMIT");

      // Trigger AFTER commit (R-002)
      const { runId } = await runtime.trigger({
        intentId: workerIntentId,
        task: TASK_IDS.workerAttempt,
        payload: workerPayload,
        options: {
          idempotencyKey: workerIntentKey,
          maxDurationSeconds: contract.bounds.budget.maxDurationSeconds,
          concurrencyKey: String(contract.projectId),
          tags: triggerTags({
            projectId: String(contract.projectId),
            workItemId: String(contract.workItemId),
            contractId: String(contractId),
            contractVersion: contract.version,
            attemptId: String(attemptId),
          }),
        },
      });

      await pool.query(
        "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
        [String(workerIntentId), runId],
      );
      await pool.query(
        "UPDATE attempts SET run_id = $2, status = 'dispatched', updated_at = now() WHERE id = $1",
        [String(attemptId), runId],
      );

      await completeCommand(client, commandId, {
        decisionId: String(decisionId),
        contractId: String(contractId),
        attemptId: String(attemptId),
        workerIntentId: String(workerIntentId),
        runId,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // onWorkerFinal
  // -------------------------------------------------------------------------

  async onWorkerFinal(obs: RunObservation, commandId: string): Promise<void> {
    const { pool, runtime, ids, config, profileResolver } = this.deps;

    const client = await pool.connect();
    try {
      const claim = await claimCommand(client, commandId, "onWorkerFinal");
      if (!claim.claimed) return;

      const attemptRow = await loadAttemptByRunId(pool, obs.runId);
      const contractRow = await loadContract(pool, attemptRow.contract_id);
      const projectRow = await loadProject(pool, contractRow.project_id);

      // F-2: Load the dispatch intent to recover the dispatched generation from the
      // idempotency key suffix (`:g<n>`).  This is distinct from the attempt's
      // current generation which may have been bumped by revokeGeneration (stop).
      const workerIntentRow = await loadIntentByRunAndTask(pool, obs.runId, TASK_IDS.workerAttempt);
      const observedGeneration = generationOfIntent(workerIntentRow);

      const obsResult = await applyObservation(client, {
        runId: obs.runId,
        generation: observedGeneration, // dispatched generation, not current (F-2)
        attemptId: attemptRow.id,
        status: obs.status,
        payload: obs,
        observedAt: new Date(obs.observedAt),
      });

      if (obsResult === "duplicate") {
        await completeCommand(client, commandId, { skipped: "duplicate" });
        return;
      }

      const obsForClassify: RunObservation = {
        runId: obs.runId,
        status: obs.status,
        observedAt: obs.observedAt,
        ...(obs.output !== undefined ? { output: obs.output } : {}),
        ...(obs.metadata !== undefined ? { metadata: obs.metadata } : {}),
        ...(obs.error !== undefined ? { error: obs.error } : {}),
      };
      const classification = classifyObservation(obsForClassify, {
        generation: attemptRow.generation, // current (possibly revoked) generation
        observedGeneration, // dispatched generation (F-2)
        budgetRemaining: attemptRow.budget_remaining,
        stopRequested: attemptRow.status === "stopping", // F-2: derive from actual status
      });

      if (classification.stale) {
        await completeCommand(client, commandId, { skipped: "stale" });
        return;
      }

      // J-3: The onWorkerFinal stopping branch was removed because it was
      // unreachable: stopRequested requires the attempt to already be `stopping`
      // at load time, but revokeGeneration bumps the generation, making the
      // observation stale before the stopping check could fire.  Stop+COMPLETED
      // races are now handled by the Reconciler via handleStoppingWorker (J-1).

      if (classification.attemptStatus === "completed") {
        const workerOutput = WorkerAttemptOutputSchema.safeParse(obs.output);
        if (!workerOutput.success) {
          throw new Error(`Invalid worker output: ${workerOutput.error.message}`);
        }
        const output = workerOutput.data;

        // F-14: a null commitId means the worker produced no artifact.  Treat
        // this as a contract failure (no Artifact row, no verify dispatch).
        if (!output.commitId) {
          const failureId = ids.next("fail") as FailureId;
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO failures (id, class, phase, attempt_id, run_id, cause)
             VALUES ($1, 'contract', 'final', $2, $3, $4)`,
            [
              String(failureId),
              attemptRow.id,
              obs.runId,
              "worker completed without a commit (null commitId — no artifact)",
            ],
          );
          const { rowCount: nullCommitFailedRows } = await client.query(
            "UPDATE attempts SET status = 'failed', failure_id = $2, updated_at = now() WHERE id = $1 AND status IN ('admitted','dispatched','running')",
            [attemptRow.id, String(failureId)],
          );
          if (!nullCommitFailedRows) {
            await client.query("ROLLBACK");
            await completeCommand(client, commandId, { skipped: "stale_status" });
            return;
          }
          // Close the incoming worker intent (F-5).
          await client.query(
            "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
            [workerIntentRow.id],
          );
          await client.query("COMMIT");
          await completeCommand(client, commandId, {
            failureId: String(failureId),
            nullCommit: true,
          });
          return;
        }

        const artifactId = ids.next("art") as ArtifactId;
        const revision = output.commitId;
        const diffDigest = output.diffDigest ?? String(digestOf({ revision }));

        const resolvedProfile = await profileResolver(contractRow.profile_id);

        await client.query("BEGIN");
        await client.query(
          `INSERT INTO artifacts (id, attempt_id, revision, diff_digest, changed_paths)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            String(artifactId),
            attemptRow.id,
            revision,
            diffDigest,
            JSON.stringify(output.changedPaths),
          ],
        );
        const { rowCount: completedRows } = await client.query(
          `UPDATE attempts
           SET status = 'completed', commit_sha = $2, diff_digest = $3,
               worktree_path = $4, session_id = $5, updated_at = now()
           WHERE id = $1 AND status IN ('admitted','dispatched','running')`,
          [
            attemptRow.id,
            output.commitId,
            output.diffDigest,
            output.worktreePath,
            output.opencode.sessionID,
          ],
        );

        if (!completedRows) {
          // A stop landed between applyObservation and here — stale skip.
          await client.query("ROLLBACK");
          await completeCommand(client, commandId, { skipped: "stale_status" });
          return;
        }

        const verifyIntentId = ids.next("di") as DispatchIntentId;

        // For manifest work items: load siblings and build manifest ext fields.
        const verifyWipRows = await listWorkItemProjects(client, contractRow.work_item_id);
        let verifyManifestPayload: { entries: ManifestEntry[]; digest: string } | undefined;
        let verifyManifestExt: {
          manifestProjectId?: string;
          manifestRepoPaths?: Record<string, string>;
        } = {};
        if (verifyWipRows.length > 0) {
          const verifyManifestEntries: ManifestEntry[] = verifyWipRows.map((row) => ({
            position: row.position,
            projectId: row.project_id,
            targetRef: row.target_ref,
            expectedBaseRevision: row.expected_base_revision,
            resultRevision: row.result_revision,
          }));
          verifyManifestPayload = {
            entries: verifyManifestEntries,
            digest: String(contractManifestDigest(verifyManifestEntries)),
          };
          // Build sibling project paths (all entries except the current project)
          const siblingPaths: Record<string, string> = {};
          for (const wip of verifyWipRows) {
            if (wip.project_id !== contractRow.project_id) {
              const { rows: sibRows } = await client.query<{ clone_path: string | null }>(
                "SELECT clone_path FROM projects WHERE id = $1",
                [wip.project_id],
              );
              const clonePath = sibRows[0]?.clone_path;
              if (clonePath) {
                siblingPaths[wip.project_id] = clonePath;
              }
            }
          }
          verifyManifestExt = {
            manifestProjectId: contractRow.project_id,
            manifestRepoPaths: siblingPaths,
          };
        }

        const verifyPayload = VerifyRunPayloadSchema.parse({
          attemptId: attemptRow.id,
          generation: attemptRow.generation,
          contractId: contractRow.id,
          profileId: contractRow.profile_id,
          profileDigest: resolvedProfile.digest,
          criteriaDigest: contractRow.criteria_digest,
          repoPath: projectRow.clone_path ?? config.worktreeBase,
          worktreeBase: config.worktreeBase,
          baseRevision: contractRow.base_revision,
          attemptRevision: revision,
          diffDigest,
          checks: resolvedProfile.checks,
          protectedPaths: resolvedProfile.protectedPaths, // F-6
          ...(verifyManifestPayload ? { manifest: verifyManifestPayload } : {}),
        });

        // Combine parsed payload with extension fields (manifest ext is not in the schema).
        const verifyTriggerPayload = { ...verifyPayload, ...verifyManifestExt };

        await client.query(
          `INSERT INTO dispatch_intents
             (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
           VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
          [
            String(verifyIntentId),
            TASK_IDS.verifyRun,
            String(digestOf(verifyPayload)),
            attemptRow.id,
            String(verifyIntentId),
          ],
        );

        // Close the incoming worker intent inside the transaction (F-5).
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [workerIntentRow.id],
        );

        await client.query("COMMIT");

        const { runId: verifyRunId } = await runtime.trigger({
          intentId: verifyIntentId,
          task: TASK_IDS.verifyRun,
          payload: verifyTriggerPayload,
          options: {
            idempotencyKey: String(verifyIntentId),
            maxDurationSeconds: contractRow.bounds.budget.maxDurationSeconds,
            concurrencyKey: contractRow.project_id,
            tags: triggerTags({
              projectId: contractRow.project_id,
              workItemId: contractRow.work_item_id,
              contractId: contractRow.id,
              contractVersion: contractRow.version,
              attemptId: attemptRow.id,
            }),
          },
        });

        await pool.query(
          "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
          [String(verifyIntentId), verifyRunId],
        );

        await completeCommand(client, commandId, {
          artifactId: String(artifactId),
          verifyIntentId: String(verifyIntentId),
          verifyRunId,
        });
      } else if (
        classification.attemptStatus === "quarantined" ||
        classification.class === "contract"
      ) {
        const workerOutput = WorkerAttemptOutputSchema.safeParse(obs.output);
        const pathViolations = workerOutput.success ? workerOutput.data.pathViolations : [];

        await client.query("BEGIN");

        const failureId = ids.next("fail") as FailureId;
        await client.query(
          `INSERT INTO failures (id, class, phase, attempt_id, run_id, cause)
           VALUES ($1, $2, 'final', $3, $4, $5)`,
          [
            String(failureId),
            classification.class,
            attemptRow.id,
            obs.runId,
            classification.reason,
          ],
        );

        for (const violation of pathViolations) {
          const findingId = ids.next("fnd") as FindingId;
          await client.query(
            `INSERT INTO findings (id, attempt_id, severity, kind, description, evidence)
             VALUES ($1, $2, 'blocking', 'scope_violation', $3, $4)`,
            [String(findingId), attemptRow.id, `Path violation: ${violation}`, `path:${violation}`],
          );
        }

        const { rowCount: quarantinedRows } = await client.query(
          `UPDATE attempts SET status = 'quarantined', failure_id = $2, updated_at = now() WHERE id = $1 AND status IN ('admitted','dispatched','running')`,
          [attemptRow.id, String(failureId)],
        );

        if (!quarantinedRows) {
          await client.query("ROLLBACK");
          await completeCommand(client, commandId, { skipped: "stale_status" });
          return;
        }

        // Close the incoming worker intent (F-5).
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [workerIntentRow.id],
        );

        await client.query("COMMIT");
        await completeCommand(client, commandId, { failureId: String(failureId), pathViolations });
      } else if (classification.autoNewAttempt) {
        const newAttemptId = ids.next("att") as AttemptId;
        const newBudget = attemptRow.budget_remaining - 1;
        const worktreePath = `${config.worktreeBase}/${String(newAttemptId)}`;

        const newWorkerPayload = WorkerAttemptPayloadSchema.parse({
          attemptId: String(newAttemptId),
          generation: 1,
          contractId: contractRow.id,
          contractVersion: String(contractRow.version),
          repoPath: projectRow.clone_path ?? config.worktreeBase,
          baseRev: contractRow.base_revision,
          prompt: contractRow.inputs?.intent ?? "",
          allowedPaths: contractRow.bounds.paths.allow,
          bounds: contractRow.bounds,
          permissionRules: permissionRulesFor(contractRow.bounds, { worktreePath }),
          model: config.workerModel,
          worktreeBase: config.worktreeBase,
        });

        const newIntentId = ids.next("di") as DispatchIntentId;
        // New attempt starts at generation 1; encode it in the idempotency key (F-2).
        const newIntentKey = `${String(newIntentId)}:g1`;

        const retryFailureId = ids.next("fail") as FailureId;
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO failures (id, class, phase, attempt_id, run_id, cause)
           VALUES ($1, 'execution', 'final', $2, $3, $4)`,
          [String(retryFailureId), attemptRow.id, obs.runId, obs.status],
        );
        const { rowCount: retryFailedRows } = await client.query(
          "UPDATE attempts SET status = 'failed', failure_id = $2, updated_at = now() WHERE id = $1 AND status IN ('admitted','dispatched','running')",
          [attemptRow.id, String(retryFailureId)],
        );
        if (!retryFailedRows) {
          await client.query("ROLLBACK");
          await completeCommand(client, commandId, { skipped: "stale_status" });
          return;
        }
        await client.query(
          `INSERT INTO attempts
             (id, contract_id, contract_version, generation, status, budget_remaining)
           VALUES ($1, $2, $3, 1, 'admitted', $4)`,
          [String(newAttemptId), contractRow.id, contractRow.version, newBudget],
        );
        await client.query(
          `INSERT INTO dispatch_intents
             (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
           VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
          [
            String(newIntentId),
            TASK_IDS.workerAttempt,
            String(digestOf(newWorkerPayload)),
            String(newAttemptId),
            newIntentKey,
          ],
        );
        // Close the incoming worker intent inside the transaction (F-5).
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [workerIntentRow.id],
        );
        await client.query("COMMIT");

        const { runId: newRunId } = await runtime.trigger({
          intentId: newIntentId,
          task: TASK_IDS.workerAttempt,
          payload: newWorkerPayload,
          options: {
            idempotencyKey: newIntentKey,
            maxDurationSeconds: contractRow.bounds.budget.maxDurationSeconds,
            concurrencyKey: contractRow.project_id,
            tags: triggerTags({
              projectId: contractRow.project_id,
              workItemId: contractRow.work_item_id,
              contractId: contractRow.id,
              contractVersion: contractRow.version,
              attemptId: String(newAttemptId),
            }),
          },
        });

        await pool.query(
          "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
          [String(newIntentId), newRunId],
        );
        await pool.query(
          "UPDATE attempts SET run_id = $2, status = 'dispatched', updated_at = now() WHERE id = $1",
          [String(newAttemptId), newRunId],
        );

        await completeCommand(client, commandId, {
          newAttemptId: String(newAttemptId),
          newIntentId: String(newIntentId),
          newRunId,
        });
      } else {
        await client.query("BEGIN");
        const failureId = ids.next("fail") as FailureId;
        await client.query(
          `INSERT INTO failures (id, class, phase, attempt_id, run_id, cause)
           VALUES ($1, $2, 'final', $3, $4, $5)`,
          [
            String(failureId),
            classification.class,
            attemptRow.id,
            obs.runId,
            classification.reason,
          ],
        );
        const { rowCount: failedRows } = await client.query(
          "UPDATE attempts SET status = 'failed', failure_id = $2, updated_at = now() WHERE id = $1 AND status IN ('admitted','dispatched','running')",
          [attemptRow.id, String(failureId)],
        );
        if (!failedRows) {
          await client.query("ROLLBACK");
          await completeCommand(client, commandId, { skipped: "stale_status" });
          return;
        }
        // Close the incoming worker intent (F-5).
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [workerIntentRow.id],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, { failureId: String(failureId) });
      }
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // onVerifyFinal
  // -------------------------------------------------------------------------

  async onVerifyFinal(obs: RunObservation, commandId: string): Promise<void> {
    const { pool, runtime, ids, config, profileResolver } = this.deps;

    const client = await pool.connect();
    try {
      const claim = await claimCommand(client, commandId, "onVerifyFinal");
      if (!claim.claimed) return;

      const intentRow = await loadIntentByRunAndTask(pool, obs.runId, TASK_IDS.verifyRun);
      if (!intentRow.attempt_id) throw new Error(`Intent ${intentRow.id} has no attempt_id`);

      const attemptRow = await loadAttempt(pool, intentRow.attempt_id);
      const contractRow = await loadContract(pool, attemptRow.contract_id);
      const projectRow = await loadProject(pool, contractRow.project_id);
      const artifactRow = await loadArtifact(pool, attemptRow.id);
      if (!artifactRow) throw new Error(`No artifact for attempt ${attemptRow.id}`);

      const verifyOutput = VerifyRunOutputSchema.safeParse(obs.output);
      const results: VerificationResult[] = verifyOutput.success ? verifyOutput.data.results : [];

      const resolvedProfile = await profileResolver(contractRow.profile_id);

      await client.query("BEGIN");
      for (const result of results) {
        const vrId = ids.next("vr") as VerificationResultId;
        await client.query(
          `INSERT INTO verification_results
             (id, attempt_id, step_contract_id, record, result)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [String(vrId), attemptRow.id, contractRow.id, JSON.stringify(result), result.result],
        );
      }

      const changedPaths = artifactRow.changed_paths ?? [];
      const coordinatorFindings = detectVerifierTampering(
        changedPaths,
        resolvedProfile.protectedPaths,
      );

      // Build the set of paths the coordinator detected as tampered.
      // The evidence string format is "path:<path> pattern:<pattern>"; extract
      // the path by matching up to the first space.
      const coordinatorTamperedPaths = [
        ...new Set(
          coordinatorFindings
            .map((f) => {
              const m = String(f.evidence ?? "").match(/^path:(\S+)/);
              return m?.[1] ?? "";
            })
            .filter(Boolean),
        ),
      ];

      // Parse adapter integrity field (optional; absent on pre-H-6 runs).
      const adapterIntegrity = verifyOutput.success ? verifyOutput.data.integrity : undefined;

      if (adapterIntegrity) {
        const adapterPaths = adapterIntegrity.tamperedPaths;
        const coordinatorSet = new Set(coordinatorTamperedPaths);
        const adapterSet = new Set(adapterPaths);

        // Detect disagreement: either side has paths the other does not.
        const setsDiffer =
          coordinatorTamperedPaths.some((p) => !adapterSet.has(p)) ||
          adapterPaths.some((p) => !coordinatorSet.has(p));

        if (setsDiffer) {
          console.error(
            "[onVerifyFinal] integrity mismatch: adapter and coordinator tampered-path sets differ",
            { adapter: adapterPaths, coordinator: coordinatorTamperedPaths },
          );
        }

        // Enriched evidence records both sides for every finding.
        const enrichedEvidence = JSON.stringify({
          adapter: adapterPaths,
          coordinator: coordinatorTamperedPaths,
          ...(adapterIntegrity.protectedPathsSource
            ? { protectedPathsSource: adapterIntegrity.protectedPathsSource }
            : {}),
        });

        // Write coordinator findings with enriched evidence.
        for (const finding of coordinatorFindings) {
          const findingId = ids.next("fnd") as FindingId;
          await client.query(
            `INSERT INTO findings (id, attempt_id, severity, kind, description, evidence)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              String(findingId),
              attemptRow.id,
              finding.severity,
              finding.kind,
              finding.description,
              enrichedEvidence,
            ],
          );
        }

        // Union: add findings for paths the adapter detected but coordinator did not.
        for (const path of adapterPaths) {
          if (!coordinatorSet.has(path)) {
            const findingId = ids.next("fnd") as FindingId;
            await client.query(
              `INSERT INTO findings (id, attempt_id, severity, kind, description, evidence)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                String(findingId),
                attemptRow.id,
                "blocking",
                "verifier_tampered",
                `Changed path "${path}" reported by adapter as tampered but not matched by coordinator protected-path rules. Any change to an approved verifier or its configuration is Review-blocking until the profile is re-versioned.`,
                enrichedEvidence,
              ],
            );
          }
        }
      } else {
        // Adapter omitted integrity — use coordinator findings unchanged (backward compatible).
        for (const finding of coordinatorFindings) {
          const findingId = ids.next("fnd") as FindingId;
          await client.query(
            `INSERT INTO findings (id, attempt_id, severity, kind, description, evidence)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              String(findingId),
              attemptRow.id,
              finding.severity,
              finding.kind,
              finding.description,
              String(finding.evidence ?? ""),
            ],
          );
        }
      }
      const reviewIntentId = ids.next("di") as DispatchIntentId;
      const reviewPayload = LeadReviewPayloadSchema.parse({
        attemptId: attemptRow.id,
        generation: attemptRow.generation,
        contractId: contractRow.id,
        criteria: contractRow.criteria,
        criteriaDigest: contractRow.criteria_digest,
        profileDigest: resolvedProfile.digest,
        attemptRevision: artifactRow.revision,
        diffDigest: artifactRow.diff_digest,
        patchPath: `${config.worktreeBase}/${attemptRow.id}.patch`,
        verificationResults: results,
        model: config.reviewerModel,
        repoPath: projectRow.clone_path ?? config.worktreeBase,
        worktreeBase: config.worktreeBase,
        baseRevision: contractRow.base_revision,
      });

      // Insert review intent and close incoming verify intent in the same tx (F-5).
      await client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
        [
          String(reviewIntentId),
          TASK_IDS.leadReview,
          String(digestOf(reviewPayload)),
          attemptRow.id,
          String(reviewIntentId),
        ],
      );
      await client.query(
        "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
        [intentRow.id],
      );

      await client.query("COMMIT");

      const { runId: reviewRunId } = await runtime.trigger({
        intentId: reviewIntentId,
        task: TASK_IDS.leadReview,
        payload: reviewPayload,
        options: {
          idempotencyKey: String(reviewIntentId),
          maxDurationSeconds: contractRow.bounds.budget.maxDurationSeconds,
          concurrencyKey: contractRow.project_id,
          tags: triggerTags({
            projectId: contractRow.project_id,
            workItemId: contractRow.work_item_id,
            contractId: contractRow.id,
            contractVersion: contractRow.version,
            attemptId: attemptRow.id,
          }),
        },
      });

      await pool.query(
        "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
        [String(reviewIntentId), reviewRunId],
      );

      await completeCommand(client, commandId, {
        reviewIntentId: String(reviewIntentId),
        reviewRunId,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // onReviewFinal
  // -------------------------------------------------------------------------

  async onReviewFinal(obs: RunObservation, commandId: string): Promise<void> {
    const { pool, runtime, ids, config, profileResolver } = this.deps;

    const client = await pool.connect();
    try {
      const claim = await claimCommand(client, commandId, "onReviewFinal");
      if (!claim.claimed) return;

      const intentRow = await loadIntentByRunAndTask(pool, obs.runId, TASK_IDS.leadReview);
      if (!intentRow.attempt_id) throw new Error(`Intent ${intentRow.id} has no attempt_id`);

      const attemptRow = await loadAttempt(pool, intentRow.attempt_id);
      const contractRow = await loadContract(pool, attemptRow.contract_id);
      const artifactRow = await loadArtifact(pool, attemptRow.id);
      const resolvedProfile = await profileResolver(contractRow.profile_id);

      const reviewOutput = ReviewOutputSchema.safeParse(obs.output);
      if (!reviewOutput.success) {
        throw new Error(`Invalid review output: ${reviewOutput.error.message}`);
      }
      const review = reviewOutput.data;

      const verificationResults = await loadVerificationResults(pool, attemptRow.id);

      const acceptIntentId = ids.next("di") as DispatchIntentId;
      const acceptPayload = LeadAcceptPayloadSchema.parse({
        attemptId: attemptRow.id,
        generation: attemptRow.generation,
        contractId: contractRow.id,
        criteria: contractRow.criteria,
        criteriaDigest: contractRow.criteria_digest,
        profileDigest: resolvedProfile.digest,
        attemptRevision: artifactRow?.revision ?? "",
        diffDigest: artifactRow?.diff_digest ?? "",
        verificationResults,
        review,
        model: config.leadModel,
      });

      const reviewId = ids.next("rev") as ReviewId;
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO reviews
           (id, attempt_id, attempt_revision, diff_digest, criteria_digest,
            profile_digest, reviewer_model, profile, findings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          String(reviewId),
          attemptRow.id,
          artifactRow?.revision ?? null,
          artifactRow?.diff_digest ?? null,
          contractRow.criteria_digest,
          resolvedProfile.digest,
          config.reviewerModel, // F-8: use the invoked model, not self-reported
          contractRow.bounds.review,
          JSON.stringify(review.findings),
        ],
      );

      // Insert accept intent and close incoming review intent in same tx (F-5).
      await client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
        [
          String(acceptIntentId),
          TASK_IDS.leadAccept,
          String(digestOf(acceptPayload)),
          attemptRow.id,
          String(acceptIntentId),
        ],
      );
      await client.query(
        "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
        [intentRow.id],
      );

      await client.query("COMMIT");

      const { runId: acceptRunId } = await runtime.trigger({
        intentId: acceptIntentId,
        task: TASK_IDS.leadAccept,
        payload: acceptPayload,
        options: {
          idempotencyKey: String(acceptIntentId),
          maxDurationSeconds: contractRow.bounds.budget.maxDurationSeconds,
          concurrencyKey: contractRow.project_id,
          tags: triggerTags({
            projectId: contractRow.project_id,
            workItemId: contractRow.work_item_id,
            contractId: contractRow.id,
            contractVersion: contractRow.version,
            attemptId: attemptRow.id,
          }),
        },
      });

      await pool.query(
        "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
        [String(acceptIntentId), acceptRunId],
      );

      await completeCommand(client, commandId, {
        reviewId: String(reviewId),
        acceptIntentId: String(acceptIntentId),
        acceptRunId,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // onAcceptFinal
  // -------------------------------------------------------------------------

  async onAcceptFinal(obs: RunObservation, commandId: string): Promise<void> {
    const { pool, ids, config, profileResolver } = this.deps;

    const client = await pool.connect();
    try {
      const claim = await claimCommand(client, commandId, "onAcceptFinal");
      if (!claim.claimed) return;

      const intentRow = await loadIntentByRunAndTask(pool, obs.runId, TASK_IDS.leadAccept);
      if (!intentRow.attempt_id) throw new Error(`Intent ${intentRow.id} has no attempt_id`);

      const proposalResult = AcceptanceProposalSchema.safeParse(obs.output);
      if (!proposalResult.success) {
        throw new Error(`Invalid acceptance proposal: ${proposalResult.error.message}`);
      }
      const proposal = proposalResult.data;

      // Use shared acceptance-evaluation function (also used by the approve command).
      const ctx = await evaluateAcceptanceForAttempt(pool, config, intentRow.attempt_id, proposal);
      // Preserve existing profileResolver side-effect (no behaviour change).
      await profileResolver(ctx.profileId);

      const { acceptResult } = ctx;
      const at = new Date();
      const decisionId = ids.next("dec") as DecisionId;

      // F-14: humanRequired contract reaching accept without an Approval emits
      // pending_human (not silently rejected) so the work item stays active.
      if (
        ctx.humanRequired &&
        !acceptResult.ok &&
        acceptResult.reasons?.some((r) => r.code === "APPROVAL_REQUIRED")
      ) {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions
             (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id, outcome, at)
           VALUES ($1, 'accept', 'coordinator', $2, $3, $4, $5, 'pending_human', $6)`,
          [
            String(decisionId),
            ctx.workItemId,
            ctx.contractId,
            ctx.contractVersion,
            ctx.attemptId,
            at,
          ],
        );
        // Close incoming accept intent (F-5).
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [intentRow.id],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          accepted: false,
          humanRequired: true,
          decisionId: String(decisionId),
        });
        return;
      }

      if (acceptResult.ok) {
        // Delegate to shared post-acceptance function (R-006, R-015).
        const finalizeResult = await finalizeAcceptedAttempt(
          pool,
          this.deps.runtime,
          this.deps.config.worktreeBase,
          client,
          ctx,
          at,
          {
            decisionId: String(decisionId),
            decisionActor: "coordinator",
            commandId,
            intentId: intentRow.id,
          },
        );

        if (finalizeResult.boundary === "merge") {
          await completeCommand(client, commandId, {
            accepted: true,
            decisionId: String(decisionId),
            boundary: "merge",
            mergeIntentId: finalizeResult.mergeIntentId,
            mergeRunId: finalizeResult.mergeRunId,
          });
        } else {
          await completeCommand(client, commandId, {
            accepted: true,
            decisionId: String(decisionId),
            revision: ctx.artifactRevision,
          });
        }
      } else {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO decisions
             (id, kind, actor, work_item_id, contract_id, contract_version, attempt_id, outcome, at)
           VALUES ($1, 'accept', 'coordinator', $2, $3, $4, $5, 'rejected', $6)`,
          [
            String(decisionId),
            ctx.workItemId,
            ctx.contractId,
            ctx.contractVersion,
            ctx.attemptId,
            at,
          ],
        );
        for (const fd of proposal.findingDispositions) {
          if (fd.disposition === "backlog") {
            const findingId = ids.next("fnd") as FindingId;
            await client.query(
              `INSERT INTO findings (id, attempt_id, severity, kind, description, disposition)
               VALUES ($1, $2, 'non_blocking', 'unrelated', $3, 'backlog')`,
              [String(findingId), ctx.attemptId, `${fd.findingId}: ${fd.reason}`],
            );
          }
        }
        // Close incoming accept intent (F-5).
        await client.query(
          "UPDATE dispatch_intents SET status = 'observed', updated_at = now() WHERE id = $1 AND status = 'triggered'",
          [intentRow.id],
        );
        await client.query("COMMIT");
        await completeCommand(client, commandId, {
          accepted: false,
          decisionId: String(decisionId),
          reasons: acceptResult.reasons,
        });
      }
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // retryDispatch
  // -------------------------------------------------------------------------

  async retryDispatch(intentId: string): Promise<{ runId: string }> {
    const { pool, runtime, config } = this.deps;

    const intentRow = await loadIntent(pool, intentId);

    if (intentRow.status === "triggered" && intentRow.run_id) {
      return { runId: intentRow.run_id };
    }

    if (!intentRow.attempt_id) {
      throw new Error(`Intent ${intentId} has no attempt_id; cannot retry`);
    }

    const attemptRow = await loadAttempt(pool, intentRow.attempt_id);
    const contractRow = await loadContract(pool, attemptRow.contract_id);
    const projectRow = await loadProject(pool, contractRow.project_id);

    const worktreePath = `${config.worktreeBase}/${attemptRow.id}`;
    const payload = WorkerAttemptPayloadSchema.parse({
      attemptId: attemptRow.id,
      generation: attemptRow.generation,
      contractId: contractRow.id,
      contractVersion: String(contractRow.version),
      repoPath: projectRow.clone_path ?? config.worktreeBase,
      baseRev: contractRow.base_revision,
      prompt: contractRow.inputs?.intent ?? "",
      allowedPaths: contractRow.bounds.paths.allow,
      bounds: contractRow.bounds,
      permissionRules: permissionRulesFor(contractRow.bounds, { worktreePath }),
      model: config.workerModel,
      worktreeBase: config.worktreeBase,
    });

    const { runId } = await runtime.trigger({
      intentId: intentId as DispatchIntentId,
      task: intentRow.task,
      payload,
      // Use the stored idempotency_key (which encodes generation) so retryDispatch
      // returns the same run as the original trigger when the key is still live (F-2/F-3).
      options: {
        idempotencyKey: intentRow.idempotency_key,
        maxDurationSeconds: contractRow.bounds.budget.maxDurationSeconds,
        concurrencyKey: contractRow.project_id,
        tags: triggerTags({
          projectId: contractRow.project_id,
          workItemId: contractRow.work_item_id,
          contractId: contractRow.id,
          contractVersion: contractRow.version,
          attemptId: attemptRow.id,
        }),
      },
    });

    await pool.query(
      "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
      [intentId, runId],
    );
    await pool.query(
      "UPDATE attempts SET run_id = $2, status = 'dispatched', updated_at = now() WHERE id = $1",
      [attemptRow.id, runId],
    );

    return { runId };
  }
}
