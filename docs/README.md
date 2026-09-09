# AgencyHQ documentation

These are AgencyHQ's living product and engineering contracts. Product intent
flows through experience evidence and stable requirements into architecture,
tests, delivery, and eventually production learning.

## Lifecycle

| Document | Question it answers |
| --- | --- |
| [`PRODUCT.md`](PRODUCT.md) | What is AgencyHQ, who is it for, and why does it exist? |
| [`DESIGN.md`](DESIGN.md) | What should remain consistent in the operator experience? |
| [`experience/`](experience/) | What evidence and desired behaviors inform the product? |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | What must the delivered system demonstrably do? |
| [`engineering/ARCHITECTURE.md`](engineering/ARCHITECTURE.md) | How do the components and the Trigger.dev runtime satisfy those requirements? |
| [`engineering/TESTING.md`](engineering/TESTING.md) | Which checks, review, trial, and integration evidence qualify completion? |
| Deployment / publishing | Compose deployment target selected in ADR-0008; implementation and qualification pending. Release distribution and promotion remain undecided. |
| Observability | Trigger's dashboard and Realtime cover execution; AgencyHQ-level telemetry is deferred until the first slice runs. |

## Supporting detail

| Folder | Contents |
| --- | --- |
| [`strategy/`](strategy/) | Incremental implementation roadmap. |
| [`experience/`](experience/) | Initial operator intent and future discovery evidence. |
| [`engineering/`](engineering/) | Architecture, domain, execution, testing, and decision records. |
| [`engineering/adrs/`](engineering/adrs/) | Accepted architecture decisions. |

## Conventions

- Update affected documentation in the same change as behavior.
- Link instead of duplicating detail.
- Keep requirements stable, testable, and traceable to evidence.
- Record significant decisions as ADRs.
- Do not represent planned implementation, delivery, or telemetry as current.
- Cite Trigger.dev and OpenCode behavior with the date it was read; re-verify
  when pinned versions change.

The 2026-09-07 revision adopts self-hosted Trigger.dev as the execution
runtime ([ADR-0005](engineering/adrs/0005-trigger-as-execution-runtime.md)),
defines the Lead role and delegated authority
([ADR-0006](engineering/adrs/0006-lead-role-and-delegated-authority.md)), and
removes worker-side external effects
([ADR-0007](engineering/adrs/0007-worker-effect-model.md)).

The accepted Compose/container target is recorded in
[ADR-0008](engineering/adrs/0008-compose-first-container-runtime.md), with
[implementation tracking](strategy/roadmap.md#compose-first-container-runtime)
and [qualification scenarios](engineering/TESTING.md#compose-runtime-qualification).
Root Compose startup and persistent container login are not implemented yet;
current host procedures remain a fallback until qualification passes.
