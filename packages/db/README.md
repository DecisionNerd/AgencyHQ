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

Row schemas with inferred TypeScript types live in `src/rows.ts`. `mapRow` helpers parse jsonb columns (`authority`, `bounds`, `criteria`, `record`) through their contracts Zod schemas.
