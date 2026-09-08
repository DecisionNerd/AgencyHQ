/**
 * Integration flow — handles integrate.merge final observations.
 *
 * Implements step 9 of the EXECUTION_MODEL: the coordinator receives the
 * integrate.merge task result and:
 *  - integrated / already_integrated: records result_revision, completes the
 *    work item when all manifest entries are resolved, or dispatches lead.plan
 *    for the next entry in a multi-repository manifest.
 *  - base_moved / conflict / push_rejected: records integration_conflict
 *    finding, decision pending_human — no automatic retry.
 *  - Non-COMPLETED run: reads the remote ref to determine the actual outcome
 *    (decideIntegrationOutcome "observed" path); retries CAS up to
 *    AGENCYHQ_INTEGRATE_RETRIES times, then escalates.
 *
 * INVARIANTS:
 * - DB changes committed before runtime.trigger() (R-002).
 * - Duplicate/stale observations are no-ops (R-010) via claimCommand.
 * - Coordinator never runs git push; only ls-remote and fetch reads allowed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  manifestDigest as contractManifestDigest,
  digestOf,
  IntegrateMergeOutputSchema,
  IntegrateMergePayloadSchema,
  LeadPlanPayloadSchema,
  TASK_IDS,
} from "@agencyhq/contracts";
import {
  applyObservation,
  claimCommand,
  completeCommand,
  type createPool,
  finalizeIntegration,
  getIntegrationByAttempt,
  listWorkItemProjects,
  setResultRevision,
} from "@agencyhq/db";
import type { DispatchIntentId, RunObservation } from "@agencyhq/domain";
import {
  allResolved,
  decideIntegrationOutcome,
  type IdGen,
  type ManifestEntry,
  nextEntry,
  type ProjectId,
  type WorkItemCondition,
  type WorkItemId,
  type WorkItemLifecycle,
  workItemTransitions,
} from "@agencyhq/domain";

import { generationOfIntent } from "./bounded-repair.ts";
import { buildLeadPlanIntent } from "./payloads.ts";
import type { FlowDeps, IsAncestorFn, LsRemoteFn } from "./types.ts";

const execFileAsync = promisify(execFile);

type Pool = ReturnType<typeof createPool>;
type PoolClient = import("pg").PoolClient;

// ---------------------------------------------------------------------------
// Default injectable implementations
// ---------------------------------------------------------------------------

/**
 * Default lsRemote: runs `git ls-remote <remote> <targetRef>` in the clone.
 * Returns the 40-hex SHA at that ref, or null if absent / unreachable.
 */
export const defaultLsRemote: LsRemoteFn = async (remote, targetRef, repoPath) => {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "ls-remote", remote, targetRef]);
    const firstLine = stdout.trim().split("\n")[0] ?? "";
    const sha = firstLine.split("\t")[0]?.trim() ?? "";
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
};

/**
 * Default isAncestor: fetches the remote ref then checks ancestry.
 * Returns true when `revision` is reachable from the fetched FETCH_HEAD.
 */
export const defaultIsAncestor: IsAncestorFn = async (revision, remote, targetRef, repoPath) => {
  try {
    await execFileAsync("git", ["-C", repoPath, "fetch", remote, targetRef]);
    await execFileAsync("git", [
      "-C",
      repoPath,
      "merge-base",
      "--is-ancestor",
      revision,
      "FETCH_HEAD",
    ]);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Local row interfaces
// ---------------------------------------------------------------------------

interface AttemptRow {
  id: string;
  contract_id: string;
  contract_version: number;
  generation: number;
  status: string;
  run_id: string | null;
  commit_sha: string | null;
  diff_digest: string | null;
}

interface StepContractRow {
  id: string;
  work_item_id: string;
  project_id: string;
  version: number;
  base_revision: string;
  target_ref: string | null;
  profile_id: string;
  inputs: { intent: string };
  authority?: unknown;
}

interface ProjectRow {
  id: string;
  remote: string | null;
  clone_path: string | null;
  allowed_refs: unknown;
  authority: unknown;
  authority_version: string;
  profile_catalog: unknown;
}

interface WorkItemRow {
  id: string;
  project_id: string;
  rank: number;
  intent: string;
  defect: string | null;
  boundary: "artifact" | "merge" | "deploy";
  lifecycle: string;
  condition: string;
  main_effort: boolean;
  version: number;
}

interface DispatchIntentRow {
  id: string;
  task: string;
  attempt_id: string | null;
  idempotency_key: string;
  status: string;
  run_id: string | null;
}

// ---------------------------------------------------------------------------
// Load helpers
// ---------------------------------------------------------------------------

async function loadAttempt(pool: Pool, attemptId: string): Promise<AttemptRow> {
  const { rows } = await pool.query("SELECT * FROM attempts WHERE id = $1", [attemptId]);
  const row = rows[0];
  if (!row) throw new Error(`Attempt ${attemptId} not found`);
  return row as AttemptRow;
}

async function loadContract(pool: Pool, contractId: string): Promise<StepContractRow> {
  const { rows } = await pool.query("SELECT * FROM step_contracts WHERE id = $1", [contractId]);
  const row = rows[0];
  if (!row) throw new Error(`StepContract ${contractId} not found`);
  return row as StepContractRow;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the git target ref name from a project's allowed_refs object.
 * For the common single-repo case where allowed_refs = { main: "<sha>" },
 * the ref name is refs/heads/main.
 */
export function deriveTargetRef(_allowedRefs: unknown): string {
  // Currently only "main" is supported; extend this when other ref names arise.
  // Short form: the integrate.merge helpers prefix refs/heads/ themselves and
  // manifests store the short name (observed 2026-09-08: the long form broke
  // the push lease).
  return "main";
}

/**
 * Record a failure outcome for an integration: finalize the row, insert a
 * blocking integration_conflict finding, and a pending_human decision.
 * Caller must wrap in a transaction.
 */
async function recordEscalation(
  client: PoolClient,
  opts: {
    integrationId: string;
    attemptId: string;
    workItemId: string;
    contractId: string;
    contractVersion: number;
    outcome: string;
    runId: string | null;
    evidence: string;
    ids: IdGen;
  },
): Promise<void> {
  await finalizeIntegration(client, opts.integrationId, {
    outcome: opts.outcome,
    resultingRevision: null,
    runId: opts.runId,
  });

  const findingId = opts.ids.next("fnd");
  await client.query(
    `INSERT INTO findings
       (id, attempt_id, severity, kind, description, evidence, disposition)
     VALUES ($1, $2, 'blocking', 'integration_conflict', $3, $4, 'pending')`,
    [String(findingId), opts.attemptId, `Integration failed: ${opts.outcome}`, opts.evidence],
  );

  const decisionId = opts.ids.next("dec");
  await client.query(
    `INSERT INTO decisions
       (id, kind, actor, work_item_id, contract_id, contract_version,
        attempt_id, outcome, at)
     VALUES ($1, 'integrate', 'coordinator', $2, $3, $4, $5, 'pending_human', now())`,
    [String(decisionId), opts.workItemId, opts.contractId, opts.contractVersion, opts.attemptId],
  );
}

// ---------------------------------------------------------------------------
// onIntegrateFinal
// ---------------------------------------------------------------------------

/**
 * Handle a final observation for an integrate.merge run.
 *
 * R-010: idempotent via claimCommand (commandId = cmd_obs_<runId>_<gen>).
 */
export async function onIntegrateFinal(
  obs: RunObservation,
  commandId: string,
  deps: FlowDeps,
): Promise<void> {
  const { pool, ids, runtime, config } = deps;
  const lsRemote = deps.lsRemote ?? defaultLsRemote;
  const isAncestor = deps.isAncestor ?? defaultIsAncestor;
  const integrateRetries = config.integrateRetries ?? 2;

  const client = await pool.connect();
  try {
    const claim = await claimCommand(client, commandId, "onIntegrateFinal");
    if (!claim.claimed) return;

    // Locate the dispatch intent and context for this run.
    const intentRow = await loadIntentByRunAndTask(pool, obs.runId, TASK_IDS.integrateMerge);
    if (!intentRow.attempt_id) throw new Error(`Intent ${intentRow.id} has no attempt_id`);
    const attemptId = intentRow.attempt_id;
    const dispatchedGen = generationOfIntent(intentRow);

    const attemptRow = await loadAttempt(pool, attemptId);
    const contractRow = await loadContract(pool, attemptRow.contract_id);
    const projectRow = await loadProject(pool, contractRow.project_id);
    const targetRef = contractRow.target_ref ?? deriveTargetRef(projectRow.allowed_refs);

    // Integration row must exist (inserted at accept time).
    const integrationRow = await getIntegrationByAttempt(client, attemptId);
    if (!integrationRow) {
      throw new Error(`No integration row for attempt ${attemptId}`);
    }

    // R-010: record observation for deduplication.
    const obsResult = await applyObservation(client, {
      runId: obs.runId,
      generation: dispatchedGen,
      attemptId,
      status: obs.status,
      payload: obs,
      observedAt: new Date(obs.observedAt),
    });
    if (obsResult === "duplicate") {
      await completeCommand(client, commandId, { skipped: "duplicate" });
      return;
    }

    // -----------------------------------------------------------------------
    // Determine integration decision
    // -----------------------------------------------------------------------

    let decision: import("@agencyhq/domain").DecideIntegrationResult;
    let parsedOutcome: string | null = null;
    let conflictingPaths: string[] = [];

    if (obs.status === "COMPLETED") {
      const parseResult = IntegrateMergeOutputSchema.safeParse(obs.output);
      if (!parseResult.success) {
        throw new Error(`Invalid integrate.merge output: ${parseResult.error.message}`);
      }
      const parsed = parseResult.data;
      parsedOutcome = parsed.outcome;
      conflictingPaths = parsed.conflictingPaths ?? [];

      decision = decideIntegrationOutcome({
        kind: "output",
        output: {
          outcome: parsed.outcome as import("@agencyhq/domain").IntegrateOutcome,
          resultRevision: parsed.resultingRevision ?? null,
        },
      });
    } else {
      // Non-COMPLETED: read remote state.
      const repoPath = projectRow.clone_path ?? "";
      const remote = projectRow.remote ?? "origin";
      const attemptRevision = attemptRow.commit_sha ?? "";
      const expectedBase = integrationRow.expected_base_revision;

      const observedRevision = await lsRemote(remote, targetRef, repoPath);

      const containsAttempt =
        observedRevision !== null && attemptRevision !== ""
          ? await isAncestor(attemptRevision, remote, targetRef, repoPath)
          : false;

      decision = decideIntegrationOutcome({
        kind: "observed",
        observedTargetRevision: observedRevision ?? expectedBase,
        expectedBaseRevision: expectedBase,
        attemptRevision,
        containsAttempt,
      });
    }

    // -----------------------------------------------------------------------
    // Act on decision
    // -----------------------------------------------------------------------

    if (decision.decision === "completed") {
      const resultingRevision = decision.resultingRevision;

      await client.query("BEGIN");

      // Finalize integration row.
      const finalizeResult = await finalizeIntegration(client, integrationRow.id, {
        outcome: parsedOutcome ?? "integrated",
        resultingRevision,
        runId: obs.runId,
      });
      if (finalizeResult === "already_set") {
        await client.query("ROLLBACK");
        await completeCommand(client, commandId, { skipped: "already_finalized" });
        return;
      }

      // Set result_revision on the work_item_projects row.
      const { rows: wipRows } = await client.query<{
        work_item_id: string;
        project_id: string;
        position: number;
        target_ref: string;
        expected_base_revision: string;
        result_revision: string | null;
      }>("SELECT * FROM work_item_projects WHERE work_item_id = $1 AND project_id = $2", [
        contractRow.work_item_id,
        contractRow.project_id,
      ]);
      const wipRow = wipRows[0];
      if (!wipRow) {
        throw new Error(
          `No work_item_projects row for work_item ${contractRow.work_item_id}, ` +
            `project ${contractRow.project_id}`,
        );
      }

      await setResultRevision(client, contractRow.work_item_id, wipRow.position, resultingRevision);

      // Defect 3: advance the project's stored base (allowed_refs) to the
      // resulting revision.  Guarded: only update when the stored value equals
      // the integration's expected base so stale / concurrent writes are ignored.
      {
        const allowedRefs = (projectRow.allowed_refs ?? {}) as Record<string, string>;
        // Find the key in allowed_refs that corresponds to targetRef.
        // allowed_refs may use either the full ref ("refs/heads/main") or the
        // short name ("main") as the key; try both forms.
        const shortRef = targetRef.replace(/^refs\/heads\//, "");
        const advanceKey: string | null =
          targetRef in allowedRefs ? targetRef : shortRef in allowedRefs ? shortRef : null;
        if (advanceKey && allowedRefs[advanceKey] === integrationRow.expected_base_revision) {
          await client.query(
            `UPDATE projects
             SET allowed_refs = jsonb_set(allowed_refs, $1::text[], $2::jsonb, false)
             WHERE id = $3`,
            [`{${advanceKey}}`, JSON.stringify(resultingRevision), contractRow.project_id],
          );
        }
      }

      // Reload all entries; check if all resolved.
      const allEntries = await listWorkItemProjects(client, contractRow.work_item_id);
      const manifestEntries: ManifestEntry[] = allEntries.map((row) => ({
        position: row.position,
        projectId: row.project_id,
        targetRef: row.target_ref,
        expectedBaseRevision: row.expected_base_revision,
        // Use the freshly-written revision for this project.
        resultRevision:
          row.project_id === contractRow.project_id ? resultingRevision : row.result_revision,
      }));

      // Pending trigger info (for after COMMIT, R-002).
      let pendingLeadPlan: {
        intentId: DispatchIntentId;
        task: string;
        payload: unknown;
        idempotencyKey: string;
      } | null = null;

      if (allResolved(manifestEntries)) {
        // Complete the work item.
        const wiRow = await loadWorkItem(pool, contractRow.work_item_id);
        const mDigest = String(contractManifestDigest(manifestEntries));

        const completeResult = workItemTransitions.complete(
          {
            id: contractRow.work_item_id as WorkItemId,
            projectId: contractRow.project_id as ProjectId,
            rank: wiRow.rank,
            intent: wiRow.intent,
            boundary: wiRow.boundary,
            lifecycle: wiRow.lifecycle as WorkItemLifecycle,
            condition: wiRow.condition as WorkItemCondition,
            mainEffort: wiRow.main_effort,
            version: wiRow.version,
          },
          { boundary: "merge", manifest: manifestEntries, manifestDigest: mDigest },
        );
        if (!completeResult.ok) {
          throw new Error(`complete(merge) failed: ${JSON.stringify(completeResult.error)}`);
        }

        await client.query(
          `UPDATE work_items
           SET lifecycle = 'completed', boundary = 'merge',
               version   = version + 1, updated_at = now()
           WHERE id = $1`,
          [contractRow.work_item_id],
        );
      } else {
        // Multi-entry: prepare lead.plan intent for the next entry.
        const nextE = nextEntry(manifestEntries);
        if (nextE) {
          pendingLeadPlan = await prepareNextEntryLeadPlan(
            client,
            nextE,
            contractRow,
            manifestEntries,
            deps,
          );
        }
      }

      await client.query("COMMIT");

      // Trigger AFTER commit (R-002).
      if (pendingLeadPlan) {
        const { runId: leadRunId } = await runtime.trigger({
          intentId: pendingLeadPlan.intentId,
          task: pendingLeadPlan.task,
          payload: pendingLeadPlan.payload,
          options: {
            idempotencyKey: pendingLeadPlan.idempotencyKey,
            tags: [`workItem:${contractRow.work_item_id}`],
          },
        });
        await pool.query(
          "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
          [String(pendingLeadPlan.intentId), leadRunId],
        );
      }

      await completeCommand(client, commandId, { resultingRevision });
      return;
    }

    if (decision.decision === "retry_cas") {
      // Count total integrate.merge intents for this attempt to determine retries used.
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM dispatch_intents
         WHERE task = $1 AND attempt_id = $2`,
        [TASK_IDS.integrateMerge, attemptId],
      );
      const totalIntents = Number.parseInt(countRows[0]?.count ?? "1", 10);

      // totalIntents includes the current intent being processed.
      // We've already used (totalIntents - 1) retries; check if we can use one more.
      if (totalIntents > integrateRetries) {
        // Exhausted — escalate.
        await client.query("BEGIN");
        await recordEscalation(client, {
          integrationId: integrationRow.id,
          attemptId,
          workItemId: contractRow.work_item_id,
          contractId: contractRow.id,
          contractVersion: contractRow.version,
          outcome: "base_moved",
          runId: obs.runId,
          evidence: JSON.stringify({
            reason: "retry_cas_exhausted",
            retries: totalIntents - 1,
            expectedBaseRevision: integrationRow.expected_base_revision,
          }),
          ids,
        });
        await client.query("COMMIT");
        await completeCommand(client, commandId, { escalated: "retry_cas_exhausted" });
        return;
      }

      // Dispatch a new integrate.merge intent.
      const newIntentId = ids.next("di") as DispatchIntentId;
      const idempotencyKey = `${String(newIntentId)}:g${String(dispatchedGen)}`;
      const artifactRevision = attemptRow.commit_sha ?? "";

      const payload = IntegrateMergePayloadSchema.parse({
        attemptId: attemptRow.id,
        generation: attemptRow.generation,
        contractId: contractRow.id,
        contractVersion: contractRow.version,
        projectId: contractRow.project_id,
        repoPath: projectRow.clone_path ?? "",
        remote: projectRow.remote ?? "origin",
        targetRef,
        expectedBaseRevision: integrationRow.expected_base_revision,
        attemptRevision: artifactRevision,
        strategy: "merge_commit",
      });

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dispatch_intents
           (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
         VALUES ($1, $2, $3, $4, 'recorded', NULL, $5)`,
        [
          String(newIntentId),
          TASK_IDS.integrateMerge,
          String(digestOf(payload)),
          attemptId,
          idempotencyKey,
        ],
      );
      await client.query("COMMIT");

      // Trigger AFTER commit (R-002).
      const { runId: retryRunId } = await runtime.trigger({
        intentId: newIntentId,
        task: TASK_IDS.integrateMerge,
        payload,
        options: {
          idempotencyKey,
          concurrencyKey: contractRow.project_id,
          tags: [
            `project:${contractRow.project_id}`,
            `workItem:${contractRow.work_item_id}`,
            `contract:${contractRow.id}:${String(contractRow.version)}`,
            `attempt:${attemptId}`,
          ],
        },
      });

      await pool.query(
        "UPDATE dispatch_intents SET status = 'triggered', run_id = $2, updated_at = now() WHERE id = $1",
        [String(newIntentId), retryRunId],
      );

      await completeCommand(client, commandId, { retried: true, newRunId: retryRunId });
      return;
    }

    // decision.decision === "escalate"
    {
      const reason = decision.reason;
      let evidence: string;

      if (obs.status === "COMPLETED") {
        const parsed = IntegrateMergeOutputSchema.safeParse(obs.output);
        const p = parsed.success ? parsed.data : null;
        evidence = JSON.stringify({
          outcome: reason,
          observedTargetRevision: p?.observedTargetRevision,
          expectedBaseRevision: integrationRow.expected_base_revision,
          conflictingPaths: p?.conflictingPaths ?? conflictingPaths,
          evidence: p?.evidence ?? [],
        });
      } else {
        evidence = JSON.stringify({
          outcome: reason,
          runStatus: obs.status,
          expectedBaseRevision: integrationRow.expected_base_revision,
        });
      }

      await client.query("BEGIN");
      await recordEscalation(client, {
        integrationId: integrationRow.id,
        attemptId,
        workItemId: contractRow.work_item_id,
        contractId: contractRow.id,
        contractVersion: contractRow.version,
        outcome: reason,
        runId: obs.runId,
        evidence,
        ids,
      });
      await client.query("COMMIT");
      await completeCommand(client, commandId, { escalated: reason });
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

// ---------------------------------------------------------------------------
// prepareNextEntryLeadPlan — insert intent and return trigger data
// ---------------------------------------------------------------------------

/**
 * Insert a lead.plan dispatch intent for the next manifest entry inside the
 * caller's transaction.  Returns the trigger arguments so the caller can
 * invoke runtime.trigger() AFTER committing (R-002).
 */
async function prepareNextEntryLeadPlan(
  client: PoolClient,
  nextE: ManifestEntry,
  contractRow: StepContractRow,
  manifestEntries: ManifestEntry[],
  deps: FlowDeps,
): Promise<{
  intentId: DispatchIntentId;
  task: string;
  payload: unknown;
  idempotencyKey: string;
}> {
  const { ids, config } = deps;

  // Load the next entry's project.
  const { rows: nextProjectRows } = await client.query("SELECT * FROM projects WHERE id = $1", [
    nextE.projectId,
  ]);
  const nextProject = nextProjectRows[0] as ProjectRow | undefined;
  if (!nextProject) throw new Error(`Project ${nextE.projectId} not found for next manifest entry`);

  // Load the work item.
  const { rows: wiRows } = await client.query("SELECT * FROM work_items WHERE id = $1", [
    contractRow.work_item_id,
  ]);
  const wiRow = wiRows[0] as WorkItemRow | undefined;
  if (!wiRow) throw new Error(`WorkItem ${contractRow.work_item_id} not found`);

  // Defect 3: refresh base revision for next entry from the project's current
  // allowed_refs (which may have been advanced by a concurrent integration of
  // a sibling entry). Fall back to the ledger value if no valid SHA is found.
  const nextBaseRevision = (() => {
    const refs = (nextProject.allowed_refs ?? {}) as Record<string, string>;
    const shortRef = (nextE.targetRef ?? "main").replace(/^refs\/heads\//, "");
    const key =
      nextE.targetRef && nextE.targetRef in refs
        ? nextE.targetRef
        : shortRef in refs
          ? shortRef
          : null;
    const v = key ? refs[key] : undefined;
    return typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? v : nextE.expectedBaseRevision;
  })();

  // Build manifest with refreshed base revision for next entry.
  const updatedEntries = manifestEntries.map((e) => ({
    ...e,
    expectedBaseRevision: e.position === nextE.position ? nextBaseRevision : e.expectedBaseRevision,
  }));
  const contractManifest = {
    entries: updatedEntries,
    digest: String(contractManifestDigest(updatedEntries)),
  };

  const intentId = ids.next("di") as DispatchIntentId;
  const idempotencyKey = `leadplan:${wiRow.id}:${String(intentId)}`;

  // Defect 2: build operatorIntent through the shared helper so the Lead
  // receives the boundary requirement text and the entry-context line.
  const operatorIntent = buildLeadPlanIntent(wiRow.intent, {
    boundary: "merge", // manifest work items always require merge boundary
    manifestEntry: {
      position: nextE.position,
      totalEntries: manifestEntries.length,
      projectId: nextE.projectId,
      clonePath: nextProject.clone_path,
      allEntries: manifestEntries.map((e) => ({
        position: e.position,
        projectId: e.projectId,
        resultRevision: e.resultRevision,
      })),
    },
  });

  const payload = LeadPlanPayloadSchema.parse({
    workItemId: wiRow.id,
    projectId: nextE.projectId,
    repoPath: nextProject.clone_path ?? config.worktreeBase,
    baseRevision: nextBaseRevision,
    worktreeBase: config.worktreeBase,
    authority: nextProject.authority,
    profileCatalog: Array.isArray(nextProject.profile_catalog)
      ? (nextProject.profile_catalog as string[])
      : ["default"],
    operatorIntent,
    model: config.leadModel,
    manifest: contractManifest,
  });

  await client.query(
    `INSERT INTO dispatch_intents
       (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
     VALUES ($1, $2, $3, NULL, 'recorded', NULL, $4)`,
    [String(intentId), TASK_IDS.leadPlan, String(digestOf(payload)), idempotencyKey],
  );

  return { intentId, task: TASK_IDS.leadPlan, payload, idempotencyKey };
}
