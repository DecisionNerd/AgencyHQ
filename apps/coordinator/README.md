# Coordinator

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
- **`approve` command**: handles human approval for `humanRequired` contracts. When `onAcceptFinal` detects that a contract requires human sign-off (`humanRequired: true`) and no `Approval` was supplied, it records a `pending_human` decision and leaves the work item active. The `approve` command (`POST /api/commands` with `kind: "approve"`) supplies the `Approval` (`contractId`, `contractVersion`, `attemptRevision`) and re-runs `evaluateAcceptance` via the shared `evaluateAcceptanceForAttempt` function. On match: inserts an `approvals` row, records an `accepted` decision, and sets `work_items.lifecycle = completed`. On mismatch: records a `rejected` decision with reason `APPROVAL_VERSION_MISMATCH` and leaves the item `pending_human`. The command is idempotent by `commandId`; a repeated call returns the stored result with `replayed: true`.
- **`disposition` command**: records an operator decision on a finding. Accepts `findingId`, `disposition` (one of `remediate`, `scope_decision`, `block`, `backlog`), `reason`, and `actor`. For `remediate`: if budget remains, inserts a failure row for the old attempt, admits a new attempt, records a dispatch intent, records a `remediate` decision, and triggers the new worker — all committed before the trigger call (R-002); if budget is exhausted, records `pending_human` instead. For `scope_decision` and `block`: records `pending_human` and updates the finding. For `backlog`: records `backlog` and updates the finding. The command is idempotent by `commandId` (R-010). The contract row is never mutated by disposition (R-017).

### Testing

Integration tests use `withTestSchema` (isolated Postgres schema per test) and `FakeExecutionRuntime` (deterministic in-process double). Run with:

```
DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test pnpm --filter @agencyhq/coordinator test:integration
```

## Network isolation

The coordinator binds to `AGENCYHQ_BIND_HOST` (default `127.0.0.1`). All
`/api/*` routes except `/api/health` require an `Authorization: Bearer
<token>` header matching `AGENCYHQ_API_TOKEN`. When `AGENCYHQ_API_TOKEN` is
unset and the bind host is not loopback, the server fails closed at startup.
Loopback without a token is allowed but logs a startup warning. All
coordinator-to-Trigger communication uses the Trigger secret key held only
by the coordinator process.

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
