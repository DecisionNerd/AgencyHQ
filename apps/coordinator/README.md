# Coordinator

Application boundary for the ledger and policy: authority subset checks,
transition validation, DispatchIntents, run observation, worktree retention,
and recording Lead and human decisions. It triggers Trigger.dev tasks only
after a decision is durable. Runs in the same Node process as the web app.
Token issuance for task adapters arrives with the container profile.

## Package

Package name: `@agencyhq/coordinator`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite; `test:integration` runs integration tests (requires `pnpm db:up`).

## BoundedRepairFlow

The `BoundedRepairFlow` class drives the plan → admit → dispatch → verify → review → accept lifecycle for a single WorkItem at the `artifact` boundary.

### Step sequence

1. `plan(workItemId, commandId)` — dispatches `lead.plan` and records a `DispatchIntent` in the same transaction before triggering (R-002).
2. `onLeadPlanOutput(intentId, output, commandId)` — validates the proposal via `checkProposal` (R-001) and `enforceable`, freezes a `StepContract`, creates an `Attempt`, and dispatches `worker.attempt`.
3. `onWorkerFinal(obs, commandId)` — classifies the observation, inserts an `Artifact`, and dispatches `verify.run`. Handles auto-retry on timeout and quarantine on path violation.
4. `onVerifyFinal(obs, commandId)` — stores `VerificationResult` rows, checks for verifier tampering, and dispatches `lead.review`.
5. `onReviewFinal(obs, commandId)` — stores the `Review` row and dispatches `lead.accept`.
6. `onAcceptFinal(obs, commandId)` — runs `evaluateAcceptance` (R-001, R-014); on success updates `WorkItem.lifecycle = completed`.

### Key invariants

- **R-002**: every domain state change is committed in a transaction _before_ `runtime.trigger()` is called.
- **R-001**: Lead outputs are proposals — `checkProposal` and `evaluateAcceptance` run before any Decision is recorded.
- **R-014**: Worker run reports are never used as acceptance evidence; only `VerificationResult` rows from `verify.run` count.
- **Idempotency**: all methods use `claimCommand` / `completeCommand` so re-delivery is safe.
- **Dispatch options**: `runtime.trigger()` is called with `concurrencyKey` (repository id), `tags` (project, workItem, contract version, attempt), and `maxDurationSeconds` from the contract.
- **Observation dedupe**: run observations are keyed by Trigger run id and attempt generation; a delivery for a revoked generation is stored as history-only (stale). Deterministic observation command ids are `cmd_obs_<runId>_<gen>`. An in-flight guard prevents concurrent poll deliveries for the same run.
- **Stop path**: `confirmStop` is called from the reconciler with the run's final metadata (`survivors`, `checkpointCommit`) as evidence; the checkpoint commit is recorded on the attempt row; the cancelled observation is stored as history-only (stale); no replacement attempt is dispatched on an operator-initiated stop.
- **Stop command replay**: a repeated stop command with the same command id returns `replayed: true`.

### Testing

Integration tests use `withTestSchema` (isolated Postgres schema per test) and `FakeExecutionRuntime` (deterministic in-process double). Run with:

```
DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test pnpm --filter @agencyhq/coordinator test:integration
```

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
