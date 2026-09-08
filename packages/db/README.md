# Database package

Postgres migrations and repositories for the ledger: Projects, WorkItems,
StepContracts, Attempts with authority generations, DispatchIntents, evidence,
Decisions, Approvals, Findings, and idempotency tables. Separate database and
credentials from Trigger.dev's. No policy here.

## Package

Package name: `@agencyhq/db`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite; `test:integration` runs integration tests (requires `pnpm db:up`); `migrate` applies pending migrations via `node --env-file=../../.env src/migrate-cli.ts`.

## Schema

Migration `migrations/0001_ledger.sql` creates the following tables in the `agencyhq` schema (tracked by `schema_migrations`):

| Table | Purpose |
| --- | --- |
| `projects` | Git repositories with versioned delegated-authority schema (jsonb). |
| `work_items` | Ranked, scoped units of change with lifecycle and boundary (`artifact`, `merge`, `deploy`). |
| `step_contracts` | Immutable versioned execution contracts: inputs, criteria, bounds, digests, status. Unique on `(work_item_id, version)`. |
| `attempts` | One execution of a StepContract: Trigger run id, authority generation, worktree, session, commit, failure. |
| `dispatch_intents` | Coordinator-recorded intent to trigger a task. Unique on `idempotency_key`. |
| `artifacts` | Content-addressed outputs: attempt commit, diff digest, changed paths. |
| `verification_results` | Results of approved checks stored as jsonb `record` (VerificationResultSchema). |
| `reviews` | Adversarial review evidence: reviewer, findings, subject versions. |
| `decisions` | Immutable Lead or human decisions with actor, causation, and outcome. |
| `approvals` | Human decisions over exact subject versions. |
| `findings` | Evidence-backed observations with owned dispositions. |
| `failures` | Failure records by class, phase, attempt, and run. |
| `transitions` | Append-only audit log: every policy-relevant state transition with actor, causation, and command id. |
| `commands` | Idempotency table for operator commands keyed by `command_id`. |
| `run_observations` | Trigger run events deduped by `(run_id, generation)` primary key. |

Migration `migrations/0002_ledger_not_null.sql` adds `NOT NULL` constraints
to columns that every coordinator insert site already supplies:
`findings.{severity, kind, description}`, `decisions.{kind, actor}`,
`failures.{class, phase, cause}`, `reviews.{reviewer_model, profile}`, and
`commands.kind`. Each `ALTER TABLE` statement is guarded by an
`information_schema` check so the migration is idempotent. Migrations are
append-only; applied files are never modified.

Migration `migrations/0003_manifest_integration.sql` adds revision manifest and integration tables:

| Table | Purpose |
| --- | --- |
| `work_item_projects` | Per-project manifest entries for a multi-repository WorkItem: `position`, `target_ref`, `expected_base_revision`, nullable `result_revision`. Primary key `(work_item_id, position)`; unique on `(work_item_id, project_id)`. |
| `integrations` | Compare-and-set integration ledger: `outcome`, `resulting_revision`, `run_id`. Unique on `(attempt_id, target_ref, expected_base_revision)`. |

The migration also adds nullable `target_ref` and `manifest_digest` columns to `step_contracts`. Each `ALTER TABLE` is guarded by an `information_schema` check so the migration is idempotent.

Migration `migrations/0004_campaigns.sql` adds campaign grouping and authority version tracking:

| Table | Purpose |
| --- | --- |
| `campaigns` | Grouping of WorkItems across Projects with a declared main effort (`main_effort_work_item_id` nullable FK to `work_items`). |
| `authority_versions` | Append-only log of delegated-authority schema versions per project: `(project_id, version)` primary key, `authority` jsonb, `actor`, `at`. |

The migration also adds nullable `campaign_id` (FK to `campaigns`) to `work_items` with a `work_items_campaign_id_idx` index. `decisions.kind` is free text with no CHECK constraint; the values `authority_update`, `reject`, and `invalidate` are produced by the coordinator and insert without error. All `CREATE TABLE` and `ALTER TABLE` statements are guarded by `IF NOT EXISTS` / `DO $$ … IF NOT EXISTS` blocks so the migration is idempotent.

Row schemas with inferred TypeScript types live in `src/rows.ts`. `mapRow` helpers parse jsonb columns (`authority`, `bounds`, `criteria`, `record`) through their contracts Zod schemas. Repository insert types (e.g. `FindingInsert`, `DecisionInsert`, `ReviewInsert`) require the columns marked NOT NULL in migration 0002 — `severity`, `kind`, `description` for findings; `kind`, `actor` for decisions; `reviewer_model`, `profile` for reviews; `class`, `phase`, `cause` for failures; `kind` for commands — as non-nullable fields; the coordinator always supplies them. Migration 0003 adds `WorkItemProjectRowSchema` / `WorkItemProjectRow` and `IntegrationRowSchema` / `IntegrationRow`.

## Fencing and idempotency

### Authority-generation fencing (`src/fencing.ts`)

`revokeGeneration(client, attemptId, expectedGeneration)` advances an attempt's authority generation with a compare-and-set UPDATE. If `generation` in the row equals `expectedGeneration`, it increments generation and sets `status = 'stopping'`, then appends a `transitions` audit row. Returns `{ ok: true, generation }` on success, `{ ok: false, reason: "stale_generation", current? }` when the expected generation is stale, or `{ ok: false, reason: "not_found" }` when no such attempt exists.

`applyObservation(client, obs)` deduplicates a run observation and generation-fences it in one SQL sequence. It inserts into `run_observations (run_id, generation)` with `ON CONFLICT DO NOTHING`; a no-op insert means the observation is a `"duplicate"`. If inserted, it reads the attempt's current generation (SELECT FOR UPDATE). When `obs.generation < current` it marks the new row `stale = true` and returns `"stale"` (history-only; state is never advanced). Otherwise it returns `"applied"` and leaves state transition to the caller.

`confirmStopped(client, attemptId, generation, input)` CAS-transitions an attempt from `'stopping'` to `'stopped'` (when `survivorsConfirmedGone`) or `'uncertain'` (when not), writes `checkpoint_commit`, and appends a `transitions` row. Returns `{ ok: false, reason: "stale_generation" }` when generation is wrong, or `{ ok: false, reason: "state_mismatch" }` when the attempt is not in `'stopping'`.

### Run observations (`src/repos/observations.ts`)

`listObservations(client, runId)` returns all observations for a run ordered by generation. `latestObservation(client, runId, generation)` returns the single row for a `(run_id, generation)` pair, or `null` if absent. Stale observations are preserved as history.

### Operator command idempotency (`src/repos/commands.ts`)

`claimCommand(client, commandId, kind)` inserts a `commands` row with `ON CONFLICT DO NOTHING`. Returns `{ claimed: true }` on the first call. Subsequent calls return `{ claimed: false, result }` when a result has been stored, or `{ claimed: false, result: null, inFlight: true }` when the original is still executing. `completeCommand(client, commandId, result)` writes the final result.

## Repositories

Each table has a typed repository module in `src/repos/`. Every function takes a `pg.PoolClient` as its first argument so callers control transactions.

| Module | Key functions |
| --- | --- |
| `repos/projects.ts` | `insertProject`, `getProject`, `listProjects` |
| `repos/campaigns.ts` | `insertCampaign`, `getCampaign`, `listCampaigns`, `setMainEffort` (guarded: work item must belong to campaign; null clears unconditionally), `assignWorkItemToCampaign` |
| `repos/authority-versions.ts` | `insertAuthorityVersion` (idempotent on `(project_id, version)`; returns `{ status: "inserted" \| "existing", row }`), `listAuthorityVersions` |
| `repos/work-items.ts` | `insertWorkItem`, `getWorkItem`, `listWorkItemsByProject`, `setWorkItemRank` (optimistic CAS on `version`; returns `"applied" \| "stale"`) |
| `repos/step-contracts.ts` | `insertStepContract`, `getStepContract`, `listStepContractsByWorkItem`, `updateStepContractStatus` |
| `repos/attempts.ts` | `insertAttempt`, `getAttempt`, `listAttemptsByContract`, `updateAttemptStatus` |
| `repos/dispatch-intents.ts` | `insertDispatchIntent`, `getDispatchIntent`, `listOpenDispatchIntents`, `updateDispatchIntentStatus` |
| `repos/artifacts.ts` | `insertArtifact`, `getArtifact`, `listArtifactsByAttempt` |
| `repos/verification-results.ts` | `insertVerificationResult`, `getVerificationResult`, `listVerificationResultsByAttempt` |
| `repos/reviews.ts` | `insertReview`, `getReview`, `listReviewsByAttempt` |
| `repos/decisions.ts` | `insertDecision`, `getDecision`, `listDecisionsByWorkItem` |
| `repos/approvals.ts` | `insertApproval`, `getApproval`, `listApprovalsByDecision` |
| `repos/findings.ts` | `insertFinding`, `getFinding`, `listFindingsByAttempt` |
| `repos/failures.ts` | `insertFailure`, `getFailure`, `listFailuresByAttempt` |
| `repos/transitions.ts` | `insertTransition` (append-only audit) |
| `repos/work-item-projects.ts` | `insertWorkItemProjects` (bulk), `listWorkItemProjects` (ordered by position), `setResultRevision` (guarded: only writes when `result_revision IS NULL`; returns `"applied" | "already_set"`) |
| `repos/integrations.ts` | `insertIntegration` (idempotent on `(attempt_id, target_ref, expected_base_revision)`; returns `{ status: "inserted" | "existing", row }`), `finalizeIntegration` (guarded: only writes when `outcome IS NULL`; returns `"applied" | "already_set"`), `getIntegrationByAttempt`, `listIntegrationsByAttempt` |

Every `updateXStatus(client, id, from, to, audit)` applies `UPDATE … WHERE id=$1 AND status=$2`. Zero rows updated returns `{ ok: false, reason: "state_mismatch" }` and writes no audit row. On success it appends a `transitions` row with `actor`, `causation_id`, and `command_id`.

## Unit of Work

`src/unit-of-work.ts` exports `recordDecisionAndIntent(client, input)`, which implements R-002: it commits a Decision, an optional StepContract, an optional Attempt, and a DispatchIntent in a single transaction before any trigger call. When `audit.commandId` matches an existing `commands` row the stored result is returned immediately (idempotent replay). Accepts `pg.Pool` (manages BEGIN/COMMIT/ROLLBACK) or `pg.PoolClient` (caller controls the transaction).
