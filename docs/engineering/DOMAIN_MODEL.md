# Domain model

## Aggregate map

| Concept | Meaning and key invariants |
| --- | --- |
| Campaign | Coordination boundary joining Projects under an outcome and policy set. |
| Project | Link to a Git repository plus allowed refs, verification profile, and operational metadata. |
| Initiative | Ranked unit of coordinated change within a Campaign; owns scope and lifecycle. |
| Goal | Versioned desired outcome, definition of done, and completion boundary linked to one or more Initiatives. |
| Finding | Evidence-backed observation that can change scope, rank, or next action without silently rewriting a contract. |
| ProcessDefinition | Immutable, versioned graph/sequence of required steps and gates. |
| ProcessInstance | One durable enactment of a ProcessDefinition for a scoped subject. |
| StepContract | Immutable input, permissions, constraints, outputs, and acceptance obligations for a step version. |
| StepInstance | Attempt-aware execution state for one StepContract within a ProcessInstance. |
| Artifact | Content-addressed output metadata with producer, attempt, type, location, and digest. |
| VerificationResult | Deterministic check result tied to inputs, tool version, command, exit status, and evidence. |
| Approval | Actor decision over an exact subject version and evidence set; never a mutable boolean. |
| WorkerAllocation | Time-bounded lease assigning capacity and a worktree to an attempt, with a monotonically increasing authority generation. |
| ProviderCapacity | Timestamped observation of available provider/model/runtime capacity and constraints. |

## Relationships

- A Campaign links Projects and contains ranked Initiatives.
- Goals express outcomes; Initiatives are the controlled work used to pursue them.
- A ProcessInstance references exactly one immutable ProcessDefinition version.
- Each StepInstance references exactly one StepContract version and may have
  multiple attempts, but at most one active WorkerAllocation.
- Artifacts and VerificationResults identify the producing attempt.
- Approvals bind to exact versions/digests so later changes cannot inherit them.

## Supervisor and definition of done

The supervisor is AgencyHQ's engineering decision role, operating through the
coordinator rather than a separate authority or worker agent loop. It approves
the definition of done using operator intent, repository instructions, project
context, dependencies, and risk. The coordinator validates and records that
decision within the operator's delegated authority. Human approval is required
only when the decision exceeds that authority or an explicit policy requires it.

Before dispatch, the supervisor pins the Goal criteria, required evidence,
verification profile, review depth, and completion boundary: accepted artifact,
merged change, or deployed outcome. StepContracts reference these versions.
The supervisor must not silently weaken the requested outcome to fit a result;
a changed outcome requires an explicit scope decision within delegated authority.

Workers may propose changes but cannot authorize a new definition of done,
weaken a required check, or mark their own work accepted. Their final report
states what was attempted, exact outputs, checks run and their results, unmet
criteria, limitations, and Findings. An honest partial or failed result is valid
execution evidence; it is not accepted completion. Missing results remain unknown.

The lean evidence and Goal completion rules live in [TESTING.md](TESTING.md).

## Main-effort allocation

Initiatives have an explicit rank within their Campaign. The highest-ranked
active Initiative is the declared main effort; being blocked does not change its
rank or identity. Allocate feasible capacity to it first, then to other runnable
Initiatives in rank order. Record when supporting work runs because the main
effort is blocked, lacks compatible capacity, or has met its concurrency ceiling.

Campaigns share one global allocation policy. Order runnable candidates by
explicit Campaign rank, then Initiative rank, queue time, and stable identity.
Campaign rank defaults to creation order until changed by the supervisor within
policy or by the operator. Running allocations are not preempted merely because
rank changes. Serialize mutable work per repository initially, including across
Campaigns; later parallel work needs explicit interface ownership and integration
dependencies. Shared capacity reservations are atomic in Postgres.

ProviderCapacity is an observation, not a promise. Each observation has a source
and validity window. Unknown or stale provider availability uses a configured
conservative limit; no new work is admitted if no safe limit is available.
Unconfirmed workers continue to count against capacity until stopped or isolated
with their resource use bounded. Lease expiry alone neither frees capacity nor
authorizes replacement; use [the recovery gate](EXECUTION_MODEL.md#replacement-worker-gate).

Lifecycle (queued, active, paused, completed, cancelled), execution condition
(ready, running, blocked, awaiting decision), rank, and allocation are distinct.
An active Initiative can be blocked; a completed worker is not a completed Goal.

## Scope control

A StepContract names allowed Projects, path/ref constraints, permitted commands
or capabilities, context inputs, budget/time ceilings, and expected artifacts.
Expanding these bounds creates a new contract version and, where required, a new
Approval. Workers cannot self-authorize scope expansion.

Each bound declares whether it is enforced before action, checked on output, or
advisory, and names the enforcing adapter. An advisory limit cannot satisfy a
required hard limit. See [enforcement boundaries](ARCHITECTURE.md#enforcement-boundaries).

## Findings and process selection

The supervisor selects a supported versioned process, asks for missing inputs,
or records a mapping alert with nearest candidates and why they do not fit.
Missing information does not by itself mean the process catalog is defective.
Start with the [bounded repair process](PROCESS_CATALOG.md); no workflow designer
is required.

Retained Findings record evidence, affected components, impact, source attempt,
owner, and next decision. Match existing findings by affected subject and cause
before creating another. Discovery does not authorize execution.

| Finding | Supervisor disposition |
| --- | --- |
| Required by current acceptance and within limits | Bounded remediation under the existing contract. |
| Requires different scope, architecture, or success criteria | Scope decision and replacement contract if authorized. |
| Unrelated defect or improvement | Linked backlog item; does not block current acceptance. |
| Prevents safe or correct continuation | Block affected work and name the condition for resuming. |
| Duplicate or unsupported | Link the original or dismiss with a reason. |

## Version repair

| Change | Transition and retained evidence |
| --- | --- |
| Output needs correction; contract remains valid | Supervisor authorizes bounded remediation under the same StepInstance and contract, with a new attempt once prior authority ends. |
| Inputs, scope, or definition of done change | Supersede the old StepInstance after revoking its attempt authority; create a replacement bound to the new StepContract. |
| Process definition changes | Supersede the old ProcessInstance and create a replacement bound to the new definition; explicitly map retained work. |
| Evidence may carry forward | Link immutable prior artifacts with provenance. Reuse verification only if criteria, profile, inputs, environment constraints, and output identities still match; otherwise rerun affected checks. |

No instance is rebound in place and no approval transfers to a changed subject
version or evidence set. Superseded attempts may submit historical observations
but cannot advance replacements. Recovery gates apply before replacement work.

## State-transition rule

All policy-relevant transitions are validated by the domain layer, committed to
Postgres with an idempotency key, and recorded with actor and causation. External
effects are dispatched only after the decision is durable.
