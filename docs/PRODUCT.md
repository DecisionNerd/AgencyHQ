# Product baseline

## Purpose

AgencyHQ helps an engineering lead coordinate multiple software projects and
coding agents without losing scope, source-of-truth discipline, or acceptance
evidence. The primary experience is a React/TypeScript web control plane backed
by a coordinator that applies policy to durable executions.

## Primary jobs

An operator must be able to:

1. define a Campaign and link one or more Projects;
2. express Goals and Initiatives with explicit scope and ranked priority;
3. turn approved intent into versioned process and step contracts;
4. allocate limited provider/worker capacity to the main effort first;
5. observe progress and distinguish process, contract, and execution failures;
6. review artifacts and deterministic verification evidence;
7. approve, reject, pause, resume, or terminate work without losing history.

The supervisor translates that intent and repository context into an approved
definition of done within delegated authority. Workers report what they achieved,
what failed, and what remains; they cannot change the success criteria or accept
their own work. The coordinator enforces and records supervisor decisions.

## Success criteria

- No work begins without a resolvable Project, scope, starting Git revision,
  and StepContract.
- A workflow completing does not by itself mark an Initiative or Goal complete.
- Every completion claim points to immutable artifacts and VerificationResults.
- Capacity decisions are explainable from recorded rank, constraints, and
  ProviderCapacity observations.
- Retries are idempotent and preserve the causal chain of prior attempts.
- Lost contact does not launch competing work: replacement requires revoked
  authority and reconciled effects, with uncertain cases held for resolution.
- Completion uses relevant tests and proportional review. Routine changes do
  not acquire extra human approvals, review rounds, or deployment gates.
- Returning operators can identify what advanced, what needs a decision, and
  what continues without reading worker conversations.

## Scope

The initial product targets one operator and multiple linked Git repositories,
one self-hosted Trigger.dev environment, and OpenCode workers in isolated execution
environments with assigned worktrees. The first executable proof is narrower:
one repository, one bounded repair process, and one active worker, including
recovery, acceptance, and a minimal operator view. Add multi-repository operation
only after compatible revisions and combined acceptance are demonstrated.
Multi-tenant billing, marketplace behavior, and generalized workflow authoring
are outside the initial scope.

## Deliberate non-goals

Until a measured requirement proves otherwise, AgencyHQ will not introduce
Kubernetes, Kafka, LangGraph, Temporal, a graph database, custom LLM-provider
integrations, a custom coding-agent harness, MCP as the internal orchestration
bus, or service decomposition beyond the web app, coordinator, Postgres, and
execution adapters.
