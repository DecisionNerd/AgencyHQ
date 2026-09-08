/**
 * seed-control-plane.ts
 *
 * Idempotent seed for the browser-test control-plane ledger.
 * Creates a deterministic set of projects, work items, contracts, attempts,
 * artifacts, decisions, and observations that Playwright e2e tests drive against.
 *
 * Runs migrations first.  Every run seeds a fresh project (unique clone_path)
 * and expires the pending decisions of earlier browser-test projects.
 *
 * Prints JSON { projectId, campaignId, wiApprove, wiReject, wiCompleted,
 *               wiAdmitted, wiBlocked, wiMerge } to stdout.
 *
 * Usage (from repo root):
 *   DATABASE_URL=... pnpm --filter @agencyhq/coordinator seed:control-plane
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Authority } from "@agencyhq/contracts";
import { HOST_TRIAL_AUTHORITY, TASK_IDS } from "@agencyhq/contracts";
import {
  createPool,
  insertArtifact,
  insertAttempt,
  insertCampaign,
  insertDecision,
  insertFinding,
  insertIntegration,
  insertProject,
  insertReview,
  insertStepContract,
  insertVerificationResult,
  insertWorkItem,
  runMigrations,
} from "@agencyhq/db";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// A fresh project per run: the browser journeys mutate the seeded rows
// (approve, reject, stop), so a re-run must not reuse a mutated ledger. Older
// browser-test projects keep their history; their pending decisions are
// expired below so they never appear in the decisions view.
const CLONE_PATH = `/browser-test-control-plane-${Date.now().toString(36)}`;

/** Host Trial Authority extended with "merge" boundary and humanRequired for merge. */
const BROWSER_TEST_AUTHORITY: Authority = {
  ...HOST_TRIAL_AUTHORITY,
  boundaries: ["artifact", "merge"],
  humanRequired: {
    ...(HOST_TRIAL_AUTHORITY.humanRequired ?? {}),
    boundaries: ["merge"],
  },
};

// ---------------------------------------------------------------------------
// Valid ContractBounds for seed — must satisfy ContractBoundsSchema.
// ---------------------------------------------------------------------------

/** Bounds for artifact-boundary work items (review=none for seed simplicity). */
const SEED_BOUNDS_ARTIFACT = {
  paths: { allow: ["src/**"], deny: [] },
  capabilities: {
    bash: { allow: ["pnpm test"], deny: [] },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundary: "artifact",
  budget: { maxAttempts: 3, maxDurationSeconds: 300, estimatedSpendUsd: 0.5 },
  review: "none",
  changeClass: "behavior",
  models: { worker: "claude-sonnet-4-5", reviewer: "openai/gpt-5.6-sol" },
} as const;

/** Bounds for merge-boundary work items. */
const SEED_BOUNDS_MERGE = {
  ...SEED_BOUNDS_ARTIFACT,
  boundary: "merge",
} as const;

// Fixed commit/digest constants — must be internally consistent for acceptance to pass.
const BASE_REVISION = "0000000000000000000000000000000000000000";
const ARTIFACT_REVISION_A = "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000";
// Digests must match /^sha256:[0-9a-f]{64}$/ — use fixed 64-hex-char suffixes.
const DIFF_DIGEST = `sha256:${"dd".repeat(32)}`;
const CRITERIA_DIGEST = `sha256:${"cc".repeat(32)}`;
const PROFILE_DIGEST = `sha256:${"bb".repeat(32)}`;
const VERIFIER_NAME = "agencyhq/verify.run";
const CHECK_ID = "pnpm-test";
// verificationResultRef = `${VERIFIER_NAME}:${CHECK_ID}:${ARTIFACT_REVISION_A}`
const VR_REF = `${VERIFIER_NAME}:${CHECK_ID}:${ARTIFACT_REVISION_A}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL is required");
  process.exit(1);
}

await runSeed(databaseUrl);

/** Where the browser tests read the seeded ids from (gitignored). Resolved at
 * call time: the seed runs before this module's tail is evaluated. */
function seedIdsFile(): string {
  return (
    process.env.AGENCYHQ_SEED_IDS_FILE ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../web/e2e/.seed-ids.json")
  );
}

function publishSeedIds(output: Record<string, string>): void {
  const file = seedIdsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

/** The pending_human accept decision the approve journey targets. */
async function pendingAcceptDecisionId(
  client: { query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  workItemId: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT id FROM decisions WHERE work_item_id = $1 AND kind = 'accept' AND outcome = 'pending_human' ORDER BY at DESC LIMIT 1`,
    [workItemId],
  );
  return rows[0]?.id ?? null;
}

async function runSeed(dbUrl: string): Promise<void> {
  const pool = createPool(dbUrl);
  const client = await pool.connect();

  try {
    // Run migrations first (outside transaction — DDL needs its own connection context)
    await runMigrations(client);

    // Repair any step_contracts with invalid bounds in browser-test projects (from old failed runs).
    // ContractBoundsSchema requires paths, capabilities, boundary, budget, changeClass, models.
    // Old seeds may have written { review: "none" } only.
    await client.query(
      `UPDATE step_contracts
     SET bounds = $1::jsonb
     WHERE project_id IN (
       SELECT id FROM projects WHERE clone_path LIKE '/browser-test-control-plane%'
     )
     AND NOT (
       bounds ? 'boundary'
       AND bounds ? 'capabilities'
       AND bounds ? 'paths'
       AND bounds ? 'changeClass'
       AND bounds ? 'models'
     )`,
      [JSON.stringify(SEED_BOUNDS_ARTIFACT)],
    );

    // Repair empty citation strings in criteria (CriterionSchema requires min(1) if present).
    await client.query(
      `UPDATE step_contracts
     SET criteria = (
       SELECT jsonb_agg(
         CASE WHEN c ->> 'citation' = '' THEN c - 'citation' ELSE c END
       )
       FROM jsonb_array_elements(criteria) c
     )
     WHERE project_id IN (
       SELECT id FROM projects WHERE clone_path LIKE '/browser-test-control-plane%'
     )
     AND criteria IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(criteria) c WHERE c ->> 'citation' = ''
     )`,
    );

    // Expire pending_human decisions from OLD orphaned browser-test projects (any clone_path
    // variant that is NOT the current v2 path). This prevents accumulated decisions from
    // previous test runs from polluting the decisions page.
    await client.query(
      `UPDATE decisions
     SET outcome = 'expired'
     WHERE outcome = 'pending_human'
     AND work_item_id IN (
       SELECT wi.id FROM work_items wi
       JOIN projects p ON p.id = wi.project_id
       WHERE p.clone_path LIKE '/browser-test-control-plane%'
       AND p.clone_path != $1
     )`,
      [CLONE_PATH],
    );

    // Idempotency: check for existing browser-test project with all work items present
    const { rows: existingRows } = await client.query<{ id: string }>(
      "SELECT id FROM projects WHERE clone_path = $1 LIMIT 1",
      [CLONE_PATH],
    );

    if (existingRows.length > 0 && existingRows[0]) {
      const existingProjectId = existingRows[0].id;
      // Load existing work item ids
      const { rows: wiRows } = await client.query<{ id: string; intent: string }>(
        "SELECT id, intent FROM work_items WHERE project_id = $1 ORDER BY rank",
        [existingProjectId],
      );
      const { rows: campaignRows } = await client.query<{ id: string }>(
        "SELECT id FROM campaigns WHERE id IN (SELECT campaign_id FROM work_items WHERE project_id = $1 LIMIT 1) LIMIT 1",
        [existingProjectId],
      );
      const output: Record<string, string> = { projectId: existingProjectId };
      if (campaignRows[0]) output.campaignId = campaignRows[0].id;
      for (const wi of wiRows) {
        const tag = intentToTag(wi.intent);
        if (tag) output[tag] = wi.id;
      }
      // Only return early if all 6 work items are present
      const expectedTags = [
        "wiApprove",
        "wiReject",
        "wiCompleted",
        "wiAdmitted",
        "wiBlocked",
        "wiMerge",
      ];
      const missingTags = expectedTags.filter((t) => !output[t]);
      if (missingTags.length === 0) {
        // Self-repair: fix any step contracts with incomplete bounds (from old seed runs).
        // ContractBoundsSchema requires paths, capabilities, boundary, budget, changeClass, models.
        await client.query(
          `UPDATE step_contracts
         SET bounds = $1::jsonb
         WHERE work_item_id IN (
           SELECT id FROM work_items WHERE project_id = $2
         )
         AND NOT (
           bounds ? 'boundary'
           AND bounds ? 'capabilities'
           AND bounds ? 'paths'
           AND bounds ? 'changeClass'
           AND bounds ? 'models'
         )`,
          [JSON.stringify(SEED_BOUNDS_ARTIFACT), existingProjectId],
        );
        if (output.wiApprove) {
          const dec = await pendingAcceptDecisionId(client, output.wiApprove);
          if (dec) output.decApprove = dec;
        }
        publishSeedIds(output);
        // Return early — finally block handles cleanup
        return;
      }
      // Incomplete seed from a previous failed run — abort and let the caller know
      throw new Error(
        `browser-test project ${existingProjectId} exists but is missing work items: ${missingTags.join(", ")}. ` +
          "Delete the project row and re-run to get a clean seed.",
      );
    }

    // Wrap all seeding in a transaction so a partial failure leaves no orphaned data
    await client.query("BEGIN");

    // ---------------------------------------------------------------------------
    // Project
    // ---------------------------------------------------------------------------

    const projectId = mkId("prj");
    await insertProject(client, {
      id: projectId,
      remote: "https://github.com/browser-test/repo",
      clone_path: CLONE_PATH,
      worktree_base: "/worktrees/browser-test",
      allowed_refs: { main: BASE_REVISION },
      authority: BROWSER_TEST_AUTHORITY,
      authority_version: "1",
      profile_catalog: ["default"],
    });

    // ---------------------------------------------------------------------------
    // Campaign
    // ---------------------------------------------------------------------------

    const campaignId = mkId("cmp");
    await insertCampaign(client, {
      id: campaignId,
      name: "Browser Test Campaign",
    });

    // ---------------------------------------------------------------------------
    // Work item WI_APPROVE: active + pending_human accept (for approve test)
    // ---------------------------------------------------------------------------

    const wiApprove = await seedPendingHumanItem(client, {
      projectId,
      campaignId,
      rank: 1,
      mainEffort: true,
      intent: "wi-approve: Fix parser to handle edge cases",
    });

    // ---------------------------------------------------------------------------
    // Work item WI_REJECT: active + pending_human accept (for reject test)
    // ---------------------------------------------------------------------------

    const wiReject = await seedPendingHumanItem(client, {
      projectId,
      campaignId,
      rank: 2,
      mainEffort: false,
      intent: "wi-reject: Fix linter warnings in auth module",
    });

    // Set campaign main effort
    await client.query("UPDATE campaigns SET main_effort_work_item_id = $1 WHERE id = $2", [
      wiApprove,
      campaignId,
    ]);

    // ---------------------------------------------------------------------------
    // Work item WI_COMPLETED: completed at artifact boundary
    // ---------------------------------------------------------------------------

    const wiCompletedId = mkId("wi");
    await insertWorkItem(client, {
      id: wiCompletedId,
      project_id: projectId,
      rank: 3,
      intent: "wi-completed: Add retry logic to network client",
      defect: null,
      boundary: "artifact",
      lifecycle: "done",
      condition: "nominal",
      main_effort: false,
      version: 1,
    });
    await client.query("UPDATE work_items SET campaign_id = $1 WHERE id = $2", [
      campaignId,
      wiCompletedId,
    ]);

    const scCompletedId = mkId("sc");
    await insertStepContract(client, {
      id: scCompletedId,
      work_item_id: wiCompletedId,
      project_id: projectId,
      version: 1,
      base_revision: BASE_REVISION,
      inputs: { defect: null },
      criteria: [{ id: "c-done", text: "Retry logic added", source: "operator" }],
      criteria_digest: CRITERIA_DIGEST,
      profile_id: "default",
      profile_digest: PROFILE_DIGEST,
      bounds: SEED_BOUNDS_ARTIFACT,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });

    const attCompletedId = mkId("att");
    await insertAttempt(client, {
      id: attCompletedId,
      contract_id: scCompletedId,
      contract_version: 1,
      generation: 1,
      status: "completed",
      budget_remaining: 10000,
    });

    const artCompletedRevision = "bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000";
    await insertArtifact(client, {
      id: mkId("art"),
      attempt_id: attCompletedId,
      revision: artCompletedRevision,
      diff_digest: DIFF_DIGEST,
      changed_paths: ["src/network/client.ts"],
    });

    await insertVerificationResult(client, {
      id: mkId("vr"),
      attempt_id: attCompletedId,
      step_contract_id: scCompletedId,
      record: makeVrRecord(scCompletedId, attCompletedId, artCompletedRevision),
      result: "pass",
    });

    await insertReview(client, {
      id: mkId("rev"),
      attempt_id: attCompletedId,
      attempt_revision: artCompletedRevision,
      diff_digest: DIFF_DIGEST,
      criteria_digest: CRITERIA_DIGEST,
      profile_digest: PROFILE_DIGEST,
      reviewer_model: "openai/gpt-5.6-sol",
      profile: "lead_inspection",
      findings: [],
    });

    await insertDecision(client, {
      id: mkId("dec"),
      kind: "accept",
      actor: "human",
      work_item_id: wiCompletedId,
      contract_id: scCompletedId,
      contract_version: 1,
      attempt_id: attCompletedId,
      outcome: "approved",
      at: new Date(),
    });

    // ---------------------------------------------------------------------------
    // Work item WI_ADMITTED: proposed — no contracts (just the work item)
    // ---------------------------------------------------------------------------

    const wiAdmittedId = mkId("wi");
    await insertWorkItem(client, {
      id: wiAdmittedId,
      project_id: projectId,
      rank: 4,
      intent: "wi-admitted: Investigate slow test suite",
      defect: null,
      boundary: "artifact",
      lifecycle: "proposed",
      condition: "nominal",
      main_effort: false,
      version: 1,
    });
    await client.query("UPDATE work_items SET campaign_id = $1 WHERE id = $2", [
      campaignId,
      wiAdmittedId,
    ]);

    // ---------------------------------------------------------------------------
    // Work item WI_BLOCKED: active with a blocking finding (for remediate)
    // ---------------------------------------------------------------------------

    const wiBlockedId = mkId("wi");
    await insertWorkItem(client, {
      id: wiBlockedId,
      project_id: projectId,
      rank: 5,
      intent: "wi-blocked: Remove deprecated API calls",
      defect: null,
      boundary: "artifact",
      lifecycle: "running",
      condition: "blocked",
      main_effort: false,
      version: 1,
    });
    await client.query("UPDATE work_items SET campaign_id = $1 WHERE id = $2", [
      campaignId,
      wiBlockedId,
    ]);

    const scBlockedId = mkId("sc");
    await insertStepContract(client, {
      id: scBlockedId,
      work_item_id: wiBlockedId,
      project_id: projectId,
      version: 1,
      base_revision: BASE_REVISION,
      inputs: { defect: null },
      criteria: [{ id: "c-blocked", text: "No deprecated API calls", source: "operator" }],
      criteria_digest: CRITERIA_DIGEST,
      profile_id: "default",
      profile_digest: PROFILE_DIGEST,
      bounds: SEED_BOUNDS_ARTIFACT,
      required_boundaries: ["artifact"],
      human_required: false,
      status: "active",
    });

    const attBlockedId = mkId("att");
    await insertAttempt(client, {
      id: attBlockedId,
      contract_id: scBlockedId,
      contract_version: 1,
      generation: 1,
      status: "running",
      budget_remaining: 10000,
    });

    await insertFinding(client, {
      id: mkId("fnd"),
      attempt_id: attBlockedId,
      severity: "blocking",
      kind: "test_failure",
      description: "Tests failed: 3 failures in deprecated-api.test.ts",
      evidence: "see stdout",
      disposition: null,
    });

    // ---------------------------------------------------------------------------
    // Work item WI_MERGE: merge-boundary + pending_human integrate decision
    // ---------------------------------------------------------------------------

    const wiMergeId = mkId("wi");
    await insertWorkItem(client, {
      id: wiMergeId,
      project_id: projectId,
      rank: 6,
      intent: "wi-merge: Add feature flag infrastructure (merge boundary)",
      defect: null,
      boundary: "merge",
      lifecycle: "running",
      condition: "nominal",
      main_effort: false,
      version: 1,
    });
    await client.query("UPDATE work_items SET campaign_id = $1 WHERE id = $2", [
      campaignId,
      wiMergeId,
    ]);

    const scMergeId = mkId("sc");
    await insertStepContract(client, {
      id: scMergeId,
      work_item_id: wiMergeId,
      project_id: projectId,
      version: 1,
      base_revision: BASE_REVISION,
      inputs: { defect: null },
      criteria: [
        {
          id: "c-merge",
          text: "Feature flag infra in place",
          source: "operator",
        },
      ],
      criteria_digest: CRITERIA_DIGEST,
      profile_id: "default",
      profile_digest: PROFILE_DIGEST,
      bounds: SEED_BOUNDS_MERGE,
      required_boundaries: ["artifact", "merge"],
      human_required: true,
      status: "active",
    });

    const mergeRevision = "cccc0000cccc0000cccc0000cccc0000cccc0000";
    const attMergeId = mkId("att");
    await insertAttempt(client, {
      id: attMergeId,
      contract_id: scMergeId,
      contract_version: 1,
      generation: 1,
      status: "completed",
      budget_remaining: 10000,
    });

    await insertArtifact(client, {
      id: mkId("art"),
      attempt_id: attMergeId,
      revision: mergeRevision,
      diff_digest: DIFF_DIGEST,
      changed_paths: ["src/flags/index.ts"],
    });

    // Integration event (integrated — outcome present)
    const integResultRevision = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
    await insertIntegration(client, {
      id: mkId("int"),
      attempt_id: attMergeId,
      contract_id: scMergeId,
      contract_version: 1,
      target_ref: "main",
      expected_base_revision: BASE_REVISION,
      resulting_revision: integResultRevision,
      outcome: "integrated",
    });

    // Integration conflict finding
    await insertFinding(client, {
      id: mkId("fnd"),
      attempt_id: attMergeId,
      severity: "blocking",
      kind: "integration_conflict",
      description: "Merge conflict in src/flags/index.ts — rebase required",
      evidence: null,
      disposition: null,
    });

    // Pending integrate decision (pending_human)
    await insertDecision(client, {
      id: mkId("dec"),
      kind: "integrate",
      actor: "coordinator",
      work_item_id: wiMergeId,
      contract_id: scMergeId,
      contract_version: 1,
      attempt_id: attMergeId,
      outcome: "pending_human",
      at: new Date(),
    });

    // ---------------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------------

    const output = {
      projectId,
      campaignId,
      wiApprove,
      wiReject,
      wiCompleted: wiCompletedId,
      wiAdmitted: wiAdmittedId,
      wiBlocked: wiBlockedId,
      wiMerge: wiMergeId,
    };

    // Commit the transaction — all data is consistent.
    await client.query("COMMIT");

    const decApprove = await pendingAcceptDecisionId(client, wiApprove);
    publishSeedIds({ ...output, ...(decApprove ? { decApprove } : {}) });
  } catch (err) {
    // Rollback on any error to leave no partial data.
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
} // end runSeed

// ---------------------------------------------------------------------------
// Helper: construct a matching verification-result record
// ---------------------------------------------------------------------------

function makeVrRecord(
  stepContractId: string,
  attemptId: string,
  attemptRevision: string,
): Record<string, unknown> {
  return {
    verifier: { name: VERIFIER_NAME, version: "1.0.0" },
    stepContractId,
    attemptId,
    criteriaDigest: CRITERIA_DIGEST,
    profileDigest: PROFILE_DIGEST,
    repository: "/repo",
    baseRevision: BASE_REVISION,
    attemptRevision,
    diffDigest: DIFF_DIGEST,
    checkId: CHECK_ID,
    environmentFingerprint: { node: "24.0.0" },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitStatus: 0,
    stdoutTail: "All tests passed",
    stderrTail: "",
    artifactDigests: [],
    result: "pass",
  };
}

// ---------------------------------------------------------------------------
// Helper: seed a work item with pending_human accept decision
// ---------------------------------------------------------------------------

async function seedPendingHumanItem(
  client: pg.PoolClient,
  opts: {
    projectId: string;
    campaignId: string;
    rank: number;
    mainEffort: boolean;
    intent: string;
  },
): Promise<string> {
  const { projectId, campaignId, rank, mainEffort, intent } = opts;

  const workItemId = mkId("wi");
  await insertWorkItem(client, {
    id: workItemId,
    project_id: projectId,
    rank,
    intent,
    defect: null,
    boundary: "artifact",
    lifecycle: "running",
    condition: "nominal",
    main_effort: mainEffort,
    version: 1,
  });
  await client.query("UPDATE work_items SET campaign_id = $1 WHERE id = $2", [
    campaignId,
    workItemId,
  ]);

  // Step contract: humanRequired=true, review="none" for simplicity
  const contractId = mkId("sc");
  await insertStepContract(client, {
    id: contractId,
    work_item_id: workItemId,
    project_id: projectId,
    version: 1,
    base_revision: BASE_REVISION,
    inputs: { defect: null },
    criteria: [{ id: "c-alpha", text: "All tests pass", source: "operator" }],
    criteria_digest: CRITERIA_DIGEST,
    profile_id: "default",
    profile_digest: PROFILE_DIGEST,
    bounds: SEED_BOUNDS_ARTIFACT,
    required_boundaries: ["artifact"],
    human_required: true,
    status: "active",
  });

  // Completed attempt
  const attemptId = mkId("att");
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await insertAttempt(client, {
    id: attemptId,
    contract_id: contractId,
    contract_version: 1,
    generation: 1,
    status: "completed",
    run_id: runId,
    budget_remaining: 10000,
  });

  // Artifact (revision must match VR + review)
  await insertArtifact(client, {
    id: mkId("art"),
    attempt_id: attemptId,
    revision: ARTIFACT_REVISION_A,
    diff_digest: DIFF_DIGEST,
    changed_paths: ["src/parser/edge-cases.ts"],
  });

  // Verification result (all digests match contract/attempt/artifact)
  await insertVerificationResult(client, {
    id: mkId("vr"),
    attempt_id: attemptId,
    step_contract_id: contractId,
    record: makeVrRecord(contractId, attemptId, ARTIFACT_REVISION_A),
    result: "pass",
  });

  // Review (stored for evidence display; acceptance skips review because bounds.review="none")
  await insertReview(client, {
    id: mkId("rev"),
    attempt_id: attemptId,
    attempt_revision: ARTIFACT_REVISION_A,
    diff_digest: DIFF_DIGEST,
    criteria_digest: CRITERIA_DIGEST,
    profile_digest: PROFILE_DIGEST,
    reviewer_model: "openai/gpt-5.6-sol",
    profile: "lead_inspection",
    findings: [],
  });

  // AcceptanceProposal stored in run_observations (read by approveWorkItem command)
  const acceptanceProposal = {
    accept: true,
    criteria: [
      {
        criterionId: "c-alpha",
        satisfied: true,
        evidence: [{ kind: "verification_result", ref: VR_REF }],
      },
    ],
    findingDispositions: [],
    rationale: "Browser test seed: all criteria satisfied",
  };

  // Dispatch intent: links attempt → lead.accept run_id
  const intentId = mkId("di");
  await client.query(
    `INSERT INTO dispatch_intents
       (id, task, payload_digest, attempt_id, status, run_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      intentId,
      TASK_IDS.leadAccept,
      "sha256-browser-test-payload",
      attemptId,
      "completed",
      runId,
      `leadaccept:${attemptId}:${intentId}`,
    ],
  );

  // Run observation with AcceptanceProposal as .output
  await client.query(
    `INSERT INTO run_observations (run_id, generation, stale, payload, observed_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (run_id, generation) DO NOTHING`,
    [runId, 0, false, JSON.stringify({ output: acceptanceProposal })],
  );

  // Pending human accept decision
  await insertDecision(client, {
    id: mkId("dec"),
    kind: "accept",
    actor: "coordinator",
    work_item_id: workItemId,
    contract_id: contractId,
    contract_version: 1,
    attempt_id: attemptId,
    outcome: "pending_human",
    at: new Date(),
  });

  return workItemId;
}

// Map intent prefix to output key for idempotency reload
function intentToTag(intent: string): string | null {
  if (intent.startsWith("wi-approve:")) return "wiApprove";
  if (intent.startsWith("wi-reject:")) return "wiReject";
  if (intent.startsWith("wi-completed:")) return "wiCompleted";
  if (intent.startsWith("wi-admitted:")) return "wiAdmitted";
  if (intent.startsWith("wi-blocked:")) return "wiBlocked";
  if (intent.startsWith("wi-merge:")) return "wiMerge";
  return null;
}
