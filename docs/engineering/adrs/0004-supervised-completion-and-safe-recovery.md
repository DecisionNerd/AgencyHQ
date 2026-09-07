# ADR-0004: Supervised completion of recoverable work

- Status: Accepted
- Date: 2026-09-06
- Supersedes: ADR-0003 acceptance semantics; its state separation and failure taxonomy remain in force.
- Extends: ADR-0001 with supervisor responsibilities and the recovery authorization gate.
- Implementation status: Planned; this decision changes documentation only.

## Context

The baseline assigns acceptance to exact deterministic evidence but leaves the
owner of success criteria and the handling of uncertain attempts incomplete.
The operator has assigned the supervisor responsibility for defining success
from context, prohibited worker-authorized changes, and requested lean review.
A lost heartbeat cannot establish that an old worker or external action stopped.

The decision is what evidence and authority let AgencyHQ advance work, including
replacement execution and accepted completion. It supports R-006 and R-013 through
R-018 in [REQUIREMENTS.md](../../REQUIREMENTS.md).

## Options considered

| Option | Benefit | Reason for decision |
| --- | --- | --- |
| Trust worker success and replace on timeout | Minimal implementation and low latency. | Rejected: stale workers can still act, and passing a worker-selected check cannot establish the requested outcome. |
| Require a human gate and full adversarial review for every transition | Uniform scrutiny. | Rejected: makes routine delegated work depend on the operator without resolving ambiguous external effects. |
| Supervisor-approved criteria, proportional evidence, and a strict replacement gate | Fits delegated engineering work and permits automatic progress when evidence is sufficient. | Selected: puts rigor at consequential boundaries while reusing checks and reviews. |

## Decision

The supervisor approves the definition of done from operator intent and project
context, within delegated authority. Workers honestly report outputs, checks,
unmet criteria, and limitations; they cannot authorize altered criteria or their
own acceptance. The coordinator validates and records supervisor decisions.

Require relevant checks and supervisor inspection for nonbehavioral changes;
behavioral changes require targeted tests and one independent adversarial review.
Use an existing qualifying review rather than duplicating it. Add checks for
specific integration or operational risks and human approvals only where policy
requires them. Nonblocking polish and unrelated improvements do not prevent done.

Complete the Goal at its declared artifact, merge, or deployment boundary, using
exact combined identities and evidence covering every required criterion.
Preserve historical acceptance; reopen current claims only when relevant evidence
is invalidated or a required outcome is disproved. New desired scope gets a new
version rather than rewriting the prior result.

Replacement requires revoked prior authority, trusted confirmation of termination
or effective isolation, reconciled effects, and remaining budget. Use generation
checks at effect boundaries and idempotent operation identities. Where an external
system cannot fence an in-flight request, block conflicting work until its outcome
is known or its retry is covered by valid idempotency protection. Timeout alone
never qualifies replacement. These gates may run automatically within policy.

Detailed contracts live in [DOMAIN_MODEL.md](../DOMAIN_MODEL.md),
[EXECUTION_MODEL.md](../EXECUTION_MODEL.md), and [TESTING.md](../TESTING.md).
Those documents include the reliability and review sources used for this design.

## Consequences

- The first real execution slice must include acceptance and recovery, not defer
  them until after worker integration or the full UI.
- Supervisor judgment is explicit evidence; it is not mislabeled as a
  deterministic test. Workers can report failure without changing the goalposts.
- Effective runtime isolation and effect reconciliation must be demonstrated;
  neither worktrees nor an execution engine alone provide the promised contract.
- Reusing evidence and review avoids repeated approval rituals, while unresolved
  effects may deliberately delay replacement until continuation is safe.
- Trigger.dev remains selected. A pinned-version trial must demonstrate this
  contract before the real-worker slice qualifies as complete.
