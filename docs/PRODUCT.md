# Product baseline

## Purpose

AgencyHQ helps an engineering lead coordinate software projects and coding
agents without losing scope, source-of-truth discipline, or acceptance
evidence. The operator works in a React web control plane; a coordinator
records intent, authority, and evidence; self-hosted Trigger.dev runs every
unit of work as a durable run in the selected runtime profile;
OpenCode is the agent runtime for both workers and the Lead.

## Primary jobs

An operator must be able to:

1. link Projects (Git repositories) and set each one's delegated authority;
2. state intent as ranked WorkItems with explicit scope;
3. let the Lead turn intent into a frozen, versioned StepContract within that
   authority, and decide the cases that exceed it;
4. see work run, with live execution state and distinct contract, execution,
   verification, and acceptance states;
5. review artifacts, verification results, and review findings;
6. stop, pause, resume, approve, reject, or re-scope work without losing history;
7. return after time away and know what advanced, what needs them, and what
   continues.

The Lead proposes the definition of done from intent and repository context;
the coordinator validates it against delegated authority and records it.
Workers report what they achieved, what failed, and what remains; they cannot
change criteria, push, or accept their own work.

## Success criteria

- No work runs without a Project, frozen StepContract, base revision, and
  authority-checked bounds.
- A Trigger run finishing never by itself completes anything.
- Every acceptance cites exact revisions, VerificationResults, and Review.
- Routine changes within authority proceed without a human gate; changes the
  schema marks `humanRequired` always get one.
- Stopping work is observable as requested, stopping, and stopped; a stopped
  worker cannot have affected any shared ref, and its worktree is kept.
- The operator never needs worker conversations to understand state.
- Lead decision quality is measured (escalation rate, reversal rate, review
  yield) rather than assumed.

## Installation and operation target

The default experience is `docker compose up -d`, followed by first-use
`docker compose exec opencode opencode auth login`. Docker manages the full
stack, task images, migrations, internal credentials, and Trigger setup.
Provider login persists; the UI identifies remaining setup and worker readiness.
Operators can link repositories and set authority without seed scripts or SQL.
New disposable task containers reuse the configured provider access and retain
source artifacts and evidence outside their lifetime. No host agent process is
required by default; a host profile is an optional compatibility path.

This is an accepted target, not shipped behavior. The current host profile and
partial container spike are recorded in the [roadmap](strategy/roadmap.md).
[ADR-0008](engineering/adrs/0008-compose-first-container-runtime.md) defines
startup, authentication, portability, replication, and qualification.

## Scope

One operator, one or more linked repositories, a Compose-managed AgencyHQ and
Trigger stack, and OpenCode workers in disposable task containers. Same-host
parallel work is the initial container capacity target; multiple worker hosts
require additional qualification. The earlier host-based slices established
bounded repair, merge integration, multi-repository work, campaigns, and
capacity observations; they remain useful evidence, not proof of the new
container runtime. Deploy-boundary execution remains outside this change.

Multi-tenant billing, a marketplace, a workflow designer, and generalized
process authoring are out of scope.

## Deliberate non-goals

AgencyHQ will not add Kubernetes, Kafka, LangGraph, Temporal, a graph
database, a custom LLM-provider integration, a custom coding-agent harness, MCP
as the internal orchestration bus, or its own job queue, process runner, or
realtime layer. Trigger.dev supplies the last three.
