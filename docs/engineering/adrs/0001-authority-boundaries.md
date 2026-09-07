# ADR-0001: Preserve authority boundaries

- Status: Accepted
- Date: 2026-09-06

## Context

The system coordinates durable agent work across domain policy, workflow
execution, coding runtime, and mutable source trees. Treating any one supporting
tool as the whole system would blur recovery and acceptance semantics.

## Decision

- The AgencyHQ coordinator owns policy and domain control.
- Postgres is the engineering/domain truth.
- Self-hosted Trigger.dev is the durable execution mechanism.
- OpenCode is the coding-agent runtime and provider abstraction.
- Git and isolated worktrees are source truth.
- Deterministic verification plus exact-version approvals determine acceptance.

Adapters report observations and accept commands; they do not directly decide
domain completion. MCP is not the internal orchestration bus.

## Consequences

The coordinator must reconcile external state and persist decisions before side
effects. Some status is intentionally duplicated as observations, with stable
external identifiers. This costs integration work but makes responsibility,
recovery, and evidence unambiguous.

