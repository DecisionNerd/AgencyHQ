# Database package

Postgres migrations and repositories for the ledger: Projects, WorkItems,
StepContracts, Attempts with authority generations, DispatchIntents, evidence,
Decisions, Approvals, Findings, and idempotency tables. Separate database and
credentials from Trigger.dev's. No policy here.

## Package

Package name: `@agencyhq/db`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite; `test:integration` runs integration tests (requires `pnpm db:up`).
