# AgencyHQ

AgencyHQ is an engineering coordination control plane. It turns campaigns and
engineering intent into bounded, durable work while keeping completion tied to
source-controlled changes and reproducible evidence.

This repository is currently at **architecture baseline** stage. The structure
and contracts are deliberate; product implementation has not started.

## System boundary

| Concern | Authority |
| --- | --- |
| Policy, scope, domain state, allocation, approvals | AgencyHQ coordinator |
| Engineering and coordination records | Postgres |
| Durable retries, waits, schedules, and resumable execution | Self-hosted Trigger.dev |
| Coding-agent execution and model/provider abstraction | OpenCode |
| Code, branches, worktrees, commits, and diffs | Git |
| Definition of done and acceptance | Supervisor decisions enforced by the coordinator, backed by required checks and proportional review |

AgencyHQ does not replace any of those authorities. In particular, Trigger.dev
is an execution mechanism rather than the domain model, and OpenCode is an agent
runtime rather than the coordinator.

## Repository map

```text
apps/
  web/              React/TypeScript operator control plane
  coordinator/      policy and domain application boundary
packages/
  domain/           domain types, invariants, and transitions
  contracts/        versioned execution and step contracts
  db/               Postgres schema, migrations, and repositories
  verification/     deterministic acceptance evaluators
trigger/             self-hosted Trigger.dev task adapter package
docs/
  PRODUCT.md         product purpose, users, and scope
  DESIGN.md          operator experience and interaction principles
  REQUIREMENTS.md    testable baseline requirements
  experience/        operator journey and continuous discovery
  strategy/          roadmap and strategic context
  engineering/       architecture, testing, domain, execution, and ADRs
```

Directories contain boundary notes only. Runtime dependencies and production
code should be added one vertical slice at a time, beginning with the domain
state machine and its tests.

## Baseline check

Requires Node.js 24+ and pnpm 11+.

```sh
pnpm check
```

The check fails if required DocSlime records disappear, internal Markdown links
break, unfinished template guidance remains, or the core authority boundary is
no longer stated in its ADR.

## Working rules

- Start a work item from an explicit scope and versioned contract.
- Give every execution a linked Git worktree and immutable starting revision.
- Treat worker output as evidence, not acceptance; apply the supervisor-approved
  definition of done, required checks, and proportional review.
- Record evidence and failure classification; do not infer completion from an
  agent message or a successful workflow run.
- Add infrastructure only when a concrete requirement earns it.

The first real worker slice must include [safe recovery](docs/engineering/EXECUTION_MODEL.md),
[lean completion](docs/engineering/TESTING.md), and a minimal operator view.
These are planned contracts; the current check proves documentation integrity
only. [ADR-0004](docs/engineering/adrs/0004-supervised-completion-and-safe-recovery.md)
records the revised acceptance and recovery decision.
