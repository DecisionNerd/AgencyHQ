# Engineering

Engineering carries the [requirements contract](../REQUIREMENTS.md) through
system design and deterministic evidence.

| Document | Responsibility |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Components, task adapters, enforcement boundaries, deployment shape, security baseline. |
| [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) | Aggregates by slice, Lead and authority rules, allocation, Findings, version repair. |
| [`PROCESS_CATALOG.md`](PROCESS_CATALOG.md) | The bounded repair process and a worked example. |
| [`EXECUTION_MODEL.md`](EXECUTION_MODEL.md) | Step lifecycle on Trigger.dev, idempotency identities, failure taxonomy, stop/replace. |
| [`TESTING.md`](TESTING.md) | Scenarios, completion rule, evidence records, Lead metrics, execution trial. |
| [`adrs/`](adrs/) | Durable reasons for significant technical decisions. |

The local deployment target is Compose (ADR-0008); implementation and runtime
qualification are pending. Release distribution and promotion remain undecided.
Execution observability comes from Trigger.dev and coordinator evidence views.

[ADR-0008](adrs/0008-compose-first-container-runtime.md) defines the accepted
Compose-first deployment and portable task-runtime refactor. Implementation
and qualification are pending; see the [roadmap](../strategy/roadmap.md#compose-first-container-runtime).
