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
| [`engineering/ARCHITECTURE.md`](engineering/ARCHITECTURE.md) | How do the domain and component boundaries satisfy those requirements? |
| [`engineering/TESTING.md`](engineering/TESTING.md) | Which checks, review, and integration evidence qualify completion? |
| Publishing | Deferred until AgencyHQ has a chosen deployment and promotion path. |
| Observability | Deferred until executable journeys and real telemetry sources exist. |

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

The current baseline includes [supervisor authority and version repair](engineering/DOMAIN_MODEL.md),
one [worked process](engineering/PROCESS_CATALOG.md), a
[replacement-worker gate](engineering/EXECUTION_MODEL.md), and
[proportional completion rules](engineering/TESTING.md).
[ADR-0004](engineering/adrs/0004-supervised-completion-and-safe-recovery.md) records
the acceptance revision; the original accepted ADR files remain historical.
