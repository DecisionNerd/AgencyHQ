# Baseline requirements

IDs are stable. R-005 was restated and R-020 added on 2026-09-07 (ADR-0006).

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| R-001 | The coordinator shall be the only component that commits scope, dispatch, and acceptance transitions; the Lead proposes within delegated authority and the coordinator validates and records. | Domain policy and authority tests. |
| R-002 | Postgres shall persist the decision, actor, causation, generation, and DispatchIntent before any task is triggered. | Transaction and replay tests. |
| R-003 | Every worker attempt shall run as its own Trigger run in its own Git worktree at the contract's base revision, under the contract's permission rules, in a process environment with no usable push credential. | Adapter tests; execution trial. |
| R-004 | Trigger.dev shall be the execution runtime, trusted for run lifecycle, duration limits, status, and cancellation, and never for acceptance; each runtime profile shall declare which boundaries it enforces. | Classification tests; execution trial. |
| R-005 | AgencyHQ shall implement no coding-agent loop and no model-provider adapters; all model calls, including the Lead's, go through OpenCode. | Dependency review. |
| R-006 | Acceptance shall require approved criteria met by exact outputs, passing `verify.run` results, the required Review, a recorded acceptance Decision, and any `humanRequired` Approval bound to the same versions. | Acceptance tests including false-success cases. |
| R-007 | The system shall classify execution, contract, and process failures separately; only execution failures create automatic new Attempts, within budget. | Table tests over Trigger final statuses. |
| R-008 | Dispatch shall follow explicit rank, preserve the main effort's identity when blocked, serialize attempts per repository, and record every exception. | Allocation tests. |
| R-009 | Any widening of scope, capability, boundary, budget, or review depth shall be a new StepContract version validated against delegated authority; workers cannot request it. | Authority subset tests. |
| R-010 | Dispatch, observation, token issuance, integration, and operator commands shall be idempotent by the identities in EXECUTION_MODEL.md. | Duplicate-delivery tests. |
| R-011 | The web app shall show contract, execution, verification, and acceptance states distinctly with source and timestamp, using Trigger Realtime for execution state. | Browser tests. |
| R-012 | The deployment shall be one AgencyHQ process, one AgencyHQ Postgres, the self-hosted Trigger webapp stack, and `trigger dev` on the OpenCode host; any other service needs a measured requirement and an ADR. | Architecture review. |
| R-013 | Stopping an attempt shall revoke its generation before cancellation, commit a checkpoint, confirm the worker process group is gone, and display *stopping* until Trigger reports a final status. | Execution trial; persistence tests. |
| R-014 | The Lead shall approve criteria and profile before dispatch; workers report results and cannot alter criteria, checks, or acceptance. | Adapter and domain tests. |
| R-015 | WorkItem completion shall cover the declared boundary with exact revisions; integration shall be compare-and-set and serialized per repository. | Integration adapter tests. |
| R-016 | Dispatch shall reject a contract requiring a boundary the active runtime profile declares advisory; nested agents are denied until descendant accounting exists. | Domain tests. |
| R-017 | Findings shall receive an owned disposition without widening the contract. | Disposition tests. |
| R-018 | Contract repair shall supersede, never rebind; evidence and Reviews do not transfer across versions. | Version tests. |
| R-019 | A returning operator shall see changes, pending decisions, continuing runs, observation freshness, and requested-vs-confirmed stop status without logs. | Browser journey. |
| R-020 | Repository content and Lead proposals shall be untrusted input; a proposal can only narrow delegated authority, never widen it. | Adversarial-fixture authority tests. |

Only the documentation baseline check exists today. Scenarios live in
[engineering/TESTING.md](engineering/TESTING.md).
