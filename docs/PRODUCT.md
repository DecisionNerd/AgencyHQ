# Product baseline

## Purpose

AgencyHQ helps an engineering lead coordinate software projects and coding
agents without losing scope, source-of-truth discipline, or acceptance
evidence. The operator works in a React web control plane; a coordinator
records intent, authority, and evidence; self-hosted Trigger.dev runs every
unit of work as a durable run on the machine where OpenCode is configured;
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

## Scope

Initial: one operator, one or more linked repositories, one self-hosted
Trigger webapp with `trigger dev` on the operator's OpenCode host, and
OpenCode workers in per-attempt worktrees. The first
executable proof is one repository, the bounded repair process, and one
concurrent attempt, including stop/replace, verification, review, acceptance,
and a minimal operator view. Merge and deploy boundaries, multi-repository
WorkItems, Campaigns, and capacity observations follow in later slices.

Multi-tenant billing, a marketplace, a workflow designer, and generalized
process authoring are out of scope.

## Deliberate non-goals

AgencyHQ will not add Kubernetes, Kafka, LangGraph, Temporal, a graph
database, a custom LLM-provider integration, a custom coding-agent harness, MCP
as the internal orchestration bus, or its own job queue, process runner, or
realtime layer. Trigger.dev supplies the last three.
