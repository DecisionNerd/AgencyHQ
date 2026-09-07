# Baseline requirements

These requirements define the first architecture contract. IDs remain stable as
implementation and test evidence are added.

| ID | Requirement | Initial acceptance evidence |
| --- | --- | --- |
| R-001 | The coordinator shall be the only component that commits authorized scope, allocation, approval, and acceptance transitions; the supervisor makes engineering decisions within delegated policy. | Domain policy tests and adapter-boundary tests. |
| R-002 | Postgres shall persist policy-relevant state, causation, actor, version, and idempotency identity before external effects are dispatched. | Transaction/outbox integration tests. |
| R-003 | Every worker attempt shall bind to one immutable StepContract version, base Git revision, isolated worktree, and allowed repository scope. | Contract validation and Git-adapter tests. |
| R-004 | Trigger.dev shall provide durable execution while its run state remains observational rather than authoritative domain state. | Retry/replay/reconciliation integration tests. |
| R-005 | OpenCode shall be used through its supported runtime/provider abstraction; AgencyHQ shall not implement an agent loop or model-provider adapters. | OpenCode adapter contract test and dependency review. |
| R-006 | Completion shall require the supervisor-approved criteria, required checks and proportional review against exact outputs, a recorded supervisor acceptance decision, and any policy-required exact-version human Approval. | Acceptance-state tests including false-success cases. |
| R-007 | The system shall classify execution, contract, and process failures separately and apply category-appropriate recovery. | State-machine table tests for all three classes. |
| R-008 | Capacity allocation shall preserve declared main effort, allocate feasible capacity in global Campaign/Initiative order, serialize conflicting repository work, and record exceptions and stale-capacity handling. | Deterministic allocation-policy tests. |
| R-009 | Scope expansion shall create a new StepContract version and shall not be self-authorized by a worker. | Authorization and contract-version tests. |
| R-010 | Commands and callbacks shall be idempotent and retries shall preserve prior attempt evidence. | Duplicate-delivery and recovery tests. |
| R-011 | The web app shall expose distinct contract, execution, process, and acceptance states with source identities and timestamps. | Browser acceptance tests. |
| R-012 | The initial deployment shall remain a modular monolith unless a measured requirement and ADR justify another service or infrastructure component. | Architecture dependency check and ADR review. |
| R-013 | Replacement shall require fenced prior authority, confirmed termination or effective isolation, reconciled external effects, and remaining budget; lease expiry alone shall not permit replacement. | Interruption, in-flight effect, descendant cancellation, and stale-result tests. |
| R-014 | The supervisor shall approve and version the definition of done from context; workers shall report actual results and unmet criteria without authorizing changes or acceptance. | Supervisor/worker authorization and verification-profile provenance tests. |
| R-015 | Initiative/Goal completion shall cover the declared artifact, merge, or deployment boundary and exact combined revisions; relevant invalidation shall reopen affected claims without rewriting history. | Combined-result, boundary, and invalidation tests. |
| R-016 | Dispatch shall require declared enforcement capabilities; unsupported hard limits and unaccounted nested delegation shall be rejected. | Runtime isolation, capability, budget, and descendant tests. |
| R-017 | Process selection shall distinguish missing inputs from unsupported work; Findings shall receive an owned disposition without silently expanding scope. | Catalog mapping and Finding-disposition tests. |
| R-018 | Contract/process repair shall supersede rather than rebind immutable instances, retain provenance, and invalidate mismatched evidence and approvals. | Version-repair and late-result transition tests. |
| R-019 | The operator shall see changes since their last visit, pending decisions, continuing work, observation freshness, and requested versus confirmed stop status without reading raw logs. | Return-after-interruption browser journey. |

All runtime evidence above is planned. Only the documentation baseline checks
currently exist. Detailed Given/When/Then scenarios and completion policy live
in [engineering/TESTING.md](engineering/TESTING.md).
