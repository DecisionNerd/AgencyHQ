# Engineering

Engineering carries the [requirements contract](../REQUIREMENTS.md) through
system design and deterministic evidence.

| Document | Responsibility |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Authority boundaries, components, dependencies, deployment shape, and security baseline. |
| [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) | Canonical concepts, relationships, ownership, allocation, and scope invariants. |
| [`PROCESS_CATALOG.md`](PROCESS_CATALOG.md) | Process selection and one worked bounded repair contract. |
| [`EXECUTION_MODEL.md`](EXECUTION_MODEL.md) | Durable lifecycle, idempotency, recovery, and failure taxonomy. |
| [`TESTING.md`](TESTING.md) | Behavior scenarios, verification records, test layers, and current evidence. |
| [`adrs/`](adrs/) | Durable reasons for significant technical decisions. |

Publishing and observability are intentionally deferred until real deployment
and telemetry decisions exist. Add those DocSlime documents when implementation
makes their contracts concrete.
