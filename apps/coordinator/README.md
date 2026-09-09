# Coordinator

> Deployment direction: [ADR-0008](../../docs/engineering/adrs/0008-compose-first-container-runtime.md) makes root Compose startup,
> persistent OpenCode login, and disposable deployed task containers the default
> target. Implementation is pending. The procedures and trial notes below
> describe the current host fallback and partial container spike; they do not
> qualify the new startup path.

Application boundary for the ledger and policy: authority subset checks,
transition validation, DispatchIntents, run observation, worktree retention,
and recording Lead and human decisions. It triggers Trigger.dev tasks only
after a decision is durable. Runs in the same Node process as the web app.
Token issuance for task adapters arrives with the container profile.

## Package

Package name: `@agencyhq/coordinator`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite; `test:integration` runs integration tests (requires `pnpm db:up`).

## BoundedRepairFlow

The `BoundedRepairFlow` class drives the plan → admit → dispatch → verify → review → accept lifecycle for a single WorkItem at the `artifact` or `merge` boundary.

### Step sequence

1. `plan(workItemId, commandId)` — dispatches `lead.plan` and records a `DispatchIntent` in the same transaction before triggering (R-002).
2. `onLeadPlanOutput(intentId, output, commandId)` — validates the proposal via `checkProposal` (R-001) and `enforceable`; rejects `deploy` boundary proposals with `DEPLOY_NOT_SUPPORTED` (pending_human); freezes a `StepContract` with `target_ref`; creates an `Attempt`; for `merge` boundary creates a `work_item_projects` row (implicit single-repo manifest); and dispatches `worker.attempt`.
3. `onWorkerFinal(obs, commandId)` — classifies the observation, inserts an `Artifact`, and dispatches `verify.run`. Handles auto-retry on timeout and quarantine on path violation.
4. `onVerifyFinal(obs, commandId)` — stores `VerificationResult` rows, writes blocking `verifier_tampered` findings to the `findings` table, and dispatches `lead.review`.
5. `onReviewFinal(obs, commandId)` — stores the `Review` row and dispatches `lead.accept`.
6. `onAcceptFinal(obs, commandId)` — loads `integrityFindings` and passes them to `evaluateAcceptance` (R-001, R-014). For `artifact` boundary: updates `WorkItem.lifecycle = completed`. For `merge` boundary: records the `accepted` decision, inserts an `integrations` row, and dispatches `integrate.merge` — all in ONE transaction before trigger (R-002); the work item is not completed yet.
7. `onIntegrateFinal(obs, commandId, deps)` — processes the `integrate.merge` result. `integrated` output: sets `result_revision`, and either completes the work item (all manifest entries resolved) or dispatches `lead.plan` for the next entry. Non-`COMPLETED` run: reads the remote ref via `lsRemote`/`isAncestor` (injectable) to determine if the attempt was already pushed (`completed`), needs a CAS retry (`retry_cas`), or should be escalated (`integration_conflict` finding + `pending_human` decision). Retries are limited by `AGENCYHQ_INTEGRATE_RETRIES` (default 2).

### Key invariants

- **R-002**: every domain state change is committed in a transaction _before_ `runtime.trigger()` is called.
- **R-001**: Lead outputs are proposals — `checkProposal` and `evaluateAcceptance` run before any Decision is recorded.
- **R-014**: Worker run reports are never used as acceptance evidence; only `VerificationResult` rows from `verify.run` count.
- **Idempotency**: all methods use `claimCommand` / `completeCommand` so re-delivery is safe.
- **Dispatch options**: `runtime.trigger()` is called with `concurrencyKey` (repository id), `tags` (project, workItem, contract version, attempt), and `maxDurationSeconds` from the contract.
- **Observation dedupe**: run observations are keyed by Trigger run id and attempt generation; a delivery for a revoked generation is stored as history-only (stale). Deterministic observation command ids are `cmd_obs_<runId>_<gen>`. An in-flight guard prevents concurrent poll deliveries for the same run.
- **Stop path**: CANCELED/TIMED_OUT worker observations are always routed to stop confirmation — no such observation is skipped. If the attempt is `dispatched` or `running` at that point (externally cancelled or hard-timed-out), the reconciler calls `stopAttempt` with actor `"coordinator"` first, then `confirmStop`. The reconciler also routes any `stopping` attempt whose run is final (any status, COMPLETED included) to confirmation at its next poll, using the same evidence order and deadline. Evidence priority: (1) run metadata (`survivors`, `checkpointCommit`), (2) `stop.ndjson` in the run directory — `readStopEvidence` parses the adapter's `step` and `checkpointCommit` NDJSON fields (legacy `event`/`commit` keys also accepted), (3) pending. The checkpoint commit is recorded on the attempt row; the cancelled observation is stored as history-only (stale); no replacement attempt is dispatched from the stop path. `AGENCYHQ_UNCERTAIN_AFTER_MS` (default 120 000 ms) applies on the reconciler's confirmation route; the attempt becomes `uncertain` when the deadline passes with no evidence. Test coverage: `apps/coordinator/test/integration/flow.stop.test.ts` (`flow.stop (CR-2a)`: COMPLETED run race → stale_status → reconciler confirmation; `flow.stop (CR-2b)`: same with survivors=[]) and `apps/coordinator/test/commands.unit.test.ts` (`readStopEvidence` unit tests).
- **Cancel on already-final run**: if `runtime.cancel` throws because the run reached a final status before the cancel call, the command completes with `cancelSkipped: true`; generation was already revoked and the attempt proceeds through normal stop confirmation.
- **Status guards**: completion, quarantine, and failure updates in `onWorkerFinal` are guarded by `WHERE status IN ('admitted','dispatched','running')`; a stop that lands between `applyObservation` and the update wins (`stale_status`): the observation is skipped, the intent stays open, and the reconciler routes the `stopping` attempt to confirmation at its next poll (`flow.stop (CR-2a)`: COMPLETED run race → stale_status, attempt stays stopping gen 2, no artifact, no verify trigger, then uncertain after deadline; `flow.stop (CR-2b)`: same, survivors=[] → stopped with metadata evidence).
- **`retry_dispatch` command**: takes `intentId` in the request body (not `workItemId`); calls `flow.retryDispatch(intentId, commandId)` to re-trigger the already-recorded intent.
- **`AGENCYHQ_INTEGRATE_RETRIES`**: maximum number of CAS retries for `integrate.merge` on `retry_cas` outcome (default 2). When exhausted, the attempt escalates to `integration_conflict` + `pending_human`.
- **Stop command replay**: a repeated stop command with the same command id returns `replayed: true`.
- **`approve` command**: handles human approval for `humanRequired` contracts. When `onAcceptFinal` detects that a contract requires human sign-off (`humanRequired: true`) and no `Approval` was supplied, it records a `pending_human` decision and leaves the work item active. The `approve` command (`POST /api/commands` with `kind: "approve"`) supplies the `Approval` (`contractId`, `contractVersion`, `attemptRevision`) and re-runs `evaluateAcceptance` via the shared `evaluateAcceptanceForAttempt` function. On match: delegates to `finalizeAcceptedAttempt` (shared with `onAcceptFinal`, R-006, R-015). For `merge` boundary: inserts an `approvals` row, records an `approved` decision, inserts an `integrations` row, and dispatches `integrate.merge` — all in ONE transaction before trigger (R-002); the work item stays active until `onIntegrateFinal` completes it. For `artifact` boundary: inserts an `approvals` row, records an `approved` decision, and sets `work_items.lifecycle = completed` in ONE transaction. On mismatch: inserts an `approval_mismatch` decision (this outcome is **not** resolving — the `pending_human` decision stays open for a corrected approve). A pending decision is open when no later decision of a resolving outcome (`approved`, `rejected`, `accepted`, `invalidated`) exists for the same attempt (attempt-scoped; implemented in `apps/coordinator/src/views/pending.ts` `isOpenPending`). The command is idempotent by `commandId`; a repeated call returns the stored result with `replayed: true`. A replayed approve on a merge-boundary item that already dispatched `integrate.merge` produces no second intent.
- **`disposition` command**: records an operator decision on a finding. Accepts `findingId`, `disposition` (one of `remediate`, `scope_decision`, `block`, `backlog`), `reason`, and `actor`. For `remediate`: if budget remains, inserts a failure row for the old attempt, admits a new attempt, records a dispatch intent, records a `remediate` decision, and triggers the new worker — all committed before the trigger call (R-002); if budget is exhausted, records `pending_human` instead. For `scope_decision` and `block`: records `pending_human` and updates the finding. For `backlog`: records `backlog` and updates the finding. The command is idempotent by `commandId` (R-010). The contract row is never mutated by disposition (R-017).
- **`create_work_item` with `manifest`**: the `create_work_item` command (`POST /api/commands` with `kind: "create_work_item"`) accepts an optional `manifest: { entries: [{ projectId, targetRef }] }` body field. When supplied the boundary must be `"merge"` and each entry's project must exist with `targetRef` in the project's `allowed_refs`. The command inserts `work_item_projects` rows for each entry (establishing the multi-repo manifest) before the work item is admitted. Single-repo `merge` boundary work items created without `manifest` receive an implicit single-entry manifest in `onLeadPlanOutput`.

### Testing

Integration tests use `withTestSchema` (isolated Postgres schema per test) and `FakeExecutionRuntime` (deterministic in-process double). Run with:

```
DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test pnpm --filter @agencyhq/coordinator test:integration
```

## Control-plane API (slices 5–6)

### Routes

All routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/overview` | Campaigns with main effort, projects, work items ranked by `rank` with lifecycle/condition/boundary/pending decision count, active-attempt counts, and optional `skipReason` |
| `GET` | `/api/decisions` | Every `pending_human` decision with obstacle, recommendation, impact, no-action consequence, and available actions |
| `GET` | `/api/work-items/:id/evidence` | Artifacts, verification results, reviews, findings, decisions, approvals, integrations, manifest rows, attempts with run ids |
| `GET` | `/api/projects/:id/authority` | Current authority version plus full history from `authority_versions` |
| `PUT` | `/api/projects/:id/authority` | Body `{ commandId, authority, actor }` — dispatches `update_authority` command |
| `GET` | `/api/capacity` | Current `provider_capacity` rows with `effective` and `concurrency` fields |
| `GET` | `/api/metrics/lead` | Per-project Lead quality metrics via `leadMetrics()`; optional `since` query param (ISO-8601 date) |

### Commands (POST /api/commands)

All commands are idempotent by `commandId` (R-010). Repeated delivery with the same id returns `replayed: true`.

| `kind` | Required fields | Effect |
|--------|-----------------|--------|
| `set_capacity` | `provider`, `model`, `status`, `validUntil` | Writes a `provider_capacity` row with `source = "operator"`; reflected immediately in `selectDispatch` capacity gating and `/api/capacity` |
| `reject` | `workItemId`, `decisionId`, `reason` | Appends a new `rejected` decision for the same attempt (pending row kept as history — R-017); persists reason in `decisions.reason`; work item lifecycle set to `halted` |
| `invalidate_acceptance` | `workItemId`, `attemptId`, `reason` | Inserts new decision of kind `invalidate` referencing historical accept; persists reason in `decisions.reason`; work item lifecycle set to `reopened`; historical rows untouched (R-017) |
| `create_campaign` | `name` | Creates a campaign; returns `campaignId` (`cmp-<commandId[:8]>`) |
| `assign_campaign` | `workItemId`, `campaignId` | Sets `campaign_id` on the work item |
| `set_main_effort` | `campaignId`, `workItemId` | Sets `main_effort_work_item_id` on the campaign; work item must belong to the campaign (`not_a_member` otherwise) |
| `set_rank` | `workItemId`, `rank`, `expectedVersion` | Updates work item rank; returns `{ ok: false, reason: "stale_version" }` if current version does not match |
| `update_authority` | `projectId`, `authority`, `actor` | Validated with `AuthoritySchema`; integer-major version must increase; `SELECT FOR UPDATE` row lock + CAS `UPDATE … WHERE authority_version = $current` (returns `stale_version` on concurrent update); backfills initial version to `authority_versions` on first update; inserts `authority_update` decision; frozen contract digests/bounds untouched (R-018) |

### Schema note

`campaigns`, `work_items.campaign_id`, and `authority_versions` are introduced by migration 0004; `decisions.reason` by migration 0005 (`ALTER TABLE decisions ADD COLUMN IF NOT EXISTS reason text`). Integration tests apply the DDL via `withControlPlaneSchema` in `apps/coordinator/test/helpers/control-plane-schema.ts` — never in `packages/db`.

## Scheduler and capacity environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENCYHQ_WORKER_SLOTS` | 1 | Maximum concurrent worker attempts across the shared ledger. On admission the worker intent is recorded `queued` and `BoundedRepairFlow.onLeadPlanOutput` calls `scheduleQueuedIntents` (`apps/coordinator/src/flow/schedule.ts`) directly, applying every gate at admission time. If the admitted item's own worker dispatch fails, recovery fires: a failure row and `pending_human` decision are recorded and the worker intent is marked `failed` so a subsequent poll cannot re-dispatch it. Failures of other queued items during the pass are logged; those items stay `queued` and are retried on the next poll. The reconciler polling wrapper also runs `scheduleQueuedIntents` on every poll and wake-up. Active attempts counted by `listActiveAttemptsForScheduling`: attempts in `stopping` status or with an in-flight `worker.attempt` intent, whose work item is not halted/completed/done. The provider gate is skipped entirely when the `provider_capacity` table is empty. The overview uses `listActiveAttemptCountsPerProject` with the same rule. No live run was performed after 0c5809f (review rework); T2/T4 live passes predate the admission change and were reached with every admission queued (33 seed attempts held the slots). (See [docs/engineering/trials/2026-09-slice6.md](../../docs/engineering/trials/2026-09-slice6.md).) |
| `AGENCYHQ_REALTIME_WAKEUP` | false | When `true`, subscribes to `runs.subscribeToRunsWithTag` for the tags of all non-terminal work items; refreshes and resubscribes after every poll when the tag set changes. On subscribe the SDK replays current run states (observed 2026-09-08, `@trigger.dev/sdk` 4.5.16); the pollOnce in-flight guard absorbs replays. Polling remains the authoritative observation path. |

## Configuration sources

### Environment variables (always highest priority)

All configuration is read from environment variables. The table below lists
the secret-bearing variables and their resolution order.

| Variable | Resolution order |
|----------|-----------------|
| `DATABASE_URL` | env → `<AGENCYHQ_SECRETS_DIR>/DATABASE_URL.env` → `<AGENCYHQ_SECRETS_DIR>/DATABASE_URL` → required |
| `TRIGGER_SECRET_KEY` | env → `<AGENCYHQ_SECRETS_DIR>/TRIGGER_SECRET_KEY.env` → `<AGENCYHQ_SECRETS_DIR>/TRIGGER_SECRET_KEY` → `<AGENCYHQ_STATE_DIR>/trigger-prod.key` → empty (bootstrap not yet complete) |
| `AGENCYHQ_API_TOKEN` | env → `<AGENCYHQ_SECRETS_DIR>/AGENCYHQ_API_TOKEN.env` → `<AGENCYHQ_SECRETS_DIR>/AGENCYHQ_API_TOKEN` → required when non-loopback |

### AGENCYHQ_SECRETS_DIR

Set to the mount point of the secrets volume (e.g. `/run/agencyhq/secrets`).
The coordinator reads each secret-bearing variable from a file in this
directory when the corresponding environment variable is not set. Two file
formats are supported:

- `<NAME>.env` — single line in `NAME=value` format (values parsed; comments
  skipped)
- `<NAME>` — raw file; trimmed whitespace

### AGENCYHQ_STATE_DIR

Set to the mount point of the `agencyhq-state` volume (e.g. `/var/agencyhq/state`).
The coordinator reads two files from this directory on every readiness poll:

- `bootstrap.json` — written by the bootstrap container as it progresses
  through phases; surfaced in `GET /api/readiness` as the `bootstrap` field.
- `deployment.json` — written by the bootstrap after a successful
  `trigger deploy`; surfaced as the `image` field.
- `trigger-prod.key` — the Trigger production secret key written by bootstrap
  after completing the credentials phase. Read lazily on every readiness poll
  so the app starts before bootstrap completes without requiring a restart.

## Network isolation

The coordinator binds to `AGENCYHQ_BIND_HOST` (default `127.0.0.1`). All
`/api/*` routes except `/api/health` require an `Authorization: Bearer
<token>` header matching `AGENCYHQ_API_TOKEN`. When `AGENCYHQ_API_TOKEN` is
unset and the bind host is not loopback, the server fails closed at startup.
Loopback without a token is allowed but logs a startup warning. All
coordinator-to-Trigger communication uses the Trigger secret key held only
by the coordinator process.

## Readiness API

`GET /api/readiness` returns the current readiness state of all subsystems.
The route is bearer-authenticated (same rule as all other `/api/*` routes).
`GET /api/health` remains unauthenticated infra-only.

### Response shape

```json
{
  "services": {
    "database": "ok | down",
    "trigger": "ok | down | unconfigured"
  },
  "bootstrap": {
    "phase": "wait_services | login | org_project | credentials | deploy | verify_deployment | done",
    "status": "running | done | failed",
    "error": "error_category",
    "at": "2026-09-08T12:00:00.000Z"
  },
  "image": {
    "version": "1.2.3",
    "platform": "linux/arm64",
    "digest": "sha256:...",
    "at": "2026-09-08T12:00:00.000Z"
  },
  "provider": "unknown",
  "worker": "unknown",
  "nextAction": "Human-readable sentence describing what to do next"
}
```

`bootstrap` and `image` are `null` when the corresponding state file is
absent (bootstrap not yet started; image not yet deployed). `provider` and
`worker` are placeholder values until issues #17 and #19 supply real data.
No secret values appear in the response.

### nextAction examples

| State | nextAction |
|-------|-----------|
| bootstrap.json absent | `Bootstrap not started; run \`docker compose up -d\`` |
| bootstrap running | `Bootstrap is running: phase deploy` |
| bootstrap failed | `Bootstrap failed at credentials: pat_create_failed; run \`docker compose logs bootstrap\`` |
| bootstrap backing off | `Bootstrap is backing off until 2026-09-09T14:00:00Z (login_rate_limited)` — reported for any retried failure; `nextRetryAt` is read from `bootstrap.json` |
| ready for login | `Ready for provider login: run \`docker compose exec opencode opencode auth login\`` |

## Running

### Development (fake runtime, no Trigger.dev)

```sh
RUNTIME=fake \
DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test \
AGENCYHQ_WORKTREE_BASE=/tmp/agencyhq-worktrees \
AGENCYHQ_WORKER_MODEL=openai/gpt-5.6-terra \
AGENCYHQ_LEAD_MODEL=openai/gpt-5.6-sol \
AGENCYHQ_REVIEWER_MODEL=openai/gpt-5.6-sol \
PORT=8787 \
pnpm --filter @agencyhq/coordinator start
```

Or with `--env-file`:

```sh
cp .env.example .env  # fill in values
pnpm --filter @agencyhq/coordinator start
```

Live-reload during development:

```sh
pnpm --filter @agencyhq/coordinator dev
```

### Seeding a project for local work

```sh
pnpm --filter @agencyhq/coordinator seed \
  --repo /path/to/repo \
  --intent "Fix the parser edge case" \
  --defect "ParserError on empty input"
# prints: { "projectId": "prj-...", "workItemId": "wi-..." }
```

### Wiring integration test

```sh
DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test \
pnpm --filter @agencyhq/coordinator test:integration
```

## Trial

The `BoundedRepairFlow` and the full coordinator pipeline were exercised against the real Trigger.dev stack on 2026-09-07 (Slice 3 trial items 5–7). Item 7 PASS: work item `89cfe999-9710-4388-8dd1-caf520d26d49` completed at artifact boundary with adversarial review and no Approval in ~150 s. Full record: [docs/engineering/trials/2026-09-slice3.md](../../docs/engineering/trials/2026-09-slice3.md).

Slice 4 (2026-09-08): merge boundary with human approval live (item 8 PASS, fifth run); CAS base_moved (item 9 PASS); two-repo manifest with combined verification (item 10 PASS, seventh run). Full record: [docs/engineering/trials/2026-09-slice4.md](../../docs/engineering/trials/2026-09-slice4.md).

Slice 5 (2026-09-08): approve via operator UI on the real stack — work item `8fafbd54`, merge boundary, `pending_human` at 174 s; operator clicked approve in `#/decisions`; `integrate.merge` dispatched in one transaction; remote `main` advanced from `b1f48d0` to `5cbff2c`; work item `completed/healthy`. One defect found by screenshot (single-item view omitted integration state; fixed in `6ab2f2f`). Rework commit `84cdb08` (open-pending rule, persisted reasons, membership guard, authority CAS). 17 Playwright browser journeys on the fake-runtime coordinator; CI green at `04c3893` per PR #12. Full record: [docs/engineering/trials/2026-09-slice5.md](../../docs/engineering/trials/2026-09-slice5.md).

Slice 6 (2026-09-08): batch scheduler wired into the polling loop; T0–T6 PASS or FIXED live (see items T1 concurrency at 21:22–21:24Z, T2 repository release at 20:52:10Z, T3 slots at ecc3cd6, T4 operator capacity at 21:25–21:30Z, T5 metrics at 20:48Z, T6 wake-up at 21:41Z); 7 defects found and fixed; container spike PARTIAL (supervisor connected; image build incomplete). Full record: [docs/engineering/trials/2026-09-slice6.md](../../docs/engineering/trials/2026-09-slice6.md).
