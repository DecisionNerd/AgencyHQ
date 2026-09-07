# AgencyHQ

AgencyHQ is an engineering coordination control plane. It turns intent into
bounded, durable work while keeping completion tied to source-controlled
changes and reproducible evidence.

This repository is at **architecture baseline** stage. The structure and
contracts are deliberate; product implementation has not started.

## System boundary

| Concern | Authority |
| --- | --- |
| Intent, delegated authority, contracts, decisions, evidence, acceptance | AgencyHQ coordinator, recorded in AgencyHQ Postgres |
| Engineering judgment: definition of done, review, acceptance proposals | The Lead — OpenCode sessions in a read-only agent, validated by the coordinator |
| Execution: queues, isolation, limits, retries, cancellation, run status, logs, realtime | Self-hosted Trigger.dev |
| Coding-agent execution and model/provider abstraction | OpenCode |
| Code, branches, commits, diffs | Git; attempt and checkpoint refs committed locally by task adapters; shared refs pushed only by integration tasks |

Trigger.dev is trusted for how work runs and whether it is still running. It is
never trusted for whether work is done. OpenCode is the agent runtime, not the
coordinator. Workers hold no credentials and cause no external effects.

## Repository map

```text
apps/
  web/              React/TypeScript operator control plane
  coordinator/      ledger, authority checks, dispatch intents, token issuance
packages/
  domain/           domain types, invariants, transitions, authority subset checks
  contracts/        versioned schemas for contracts, task payloads, reports, proposals
  db/               Postgres schema, migrations, repositories
  verification/     verification profiles and result construction
trigger/             Trigger.dev task adapters and the pinned task image
infra/trigger/       self-hosted Trigger.dev compose and environment notes
docs/
  PRODUCT.md         purpose, users, scope
  DESIGN.md          operator experience principles
  REQUIREMENTS.md    testable baseline requirements
  experience/        operator journey and discovery evidence
  strategy/          roadmap
  engineering/       architecture, domain, execution, testing, ADRs
```

Directories contain boundary notes only. Production code is added one slice at
a time, starting with the execution spike in the
[roadmap](docs/strategy/roadmap.md).

## Baseline check

Requires Node.js 24+ and pnpm 11+.

```sh
pnpm check
```

The check fails if required records disappear, internal Markdown links break,
unfinished template guidance remains, or the current ADRs stop naming the
authorities above.

## Working rules

- Start work from a frozen StepContract validated against delegated authority.
- Every attempt is one Trigger run in its own Git worktree folder.
- Worker output is a proposal on an attempt branch; verification and review
  run separately; only the coordinator records acceptance.
- Stop means revoke the generation, cancel the run, checkpoint the worktree,
  confirm the process group is gone, and wait for a final status.
- Add infrastructure only when a concrete requirement earns it; Trigger.dev is
  the one exception, adopted so AgencyHQ does not own execution plumbing.

See [ADR-0005](docs/engineering/adrs/0005-trigger-as-execution-runtime.md),
[ADR-0006](docs/engineering/adrs/0006-lead-role-and-delegated-authority.md), and
[ADR-0007](docs/engineering/adrs/0007-worker-effect-model.md) for the 2026-09-07
revision.
