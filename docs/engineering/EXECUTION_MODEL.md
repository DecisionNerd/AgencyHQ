# Durable execution model

## Lifecycle

1. The supervisor approves a versioned definition of done; the coordinator
   validates scope, approvals, dependencies, enforcement support, and capacity.
2. It creates a StepInstance attempt, WorkerAllocation, and authority generation
   in Postgres, with a transactional dispatch record.
3. A transactional dispatch record causes Trigger.dev to start or resume work.
4. Trigger.dev invokes the OpenCode adapter with the immutable StepContract,
   worktree identity, and attempt identity.
5. OpenCode performs bounded work and reports outputs, checks, limitations,
   unmet criteria, and Findings honestly, including partial or failed results.
6. The coordinator records observations, obtains required verification and review,
   and applies the supervisor's acceptance decision only if the gates pass.
7. Human approval is requested only where the contract or policy requires it.

Every callback and command carries an idempotency key. Replaying a delivery may
reconcile state but must not create a second logical attempt or approval.
Bind keys to the caller, logical operation, and payload digest; reject reuse
with different intent. Retain identities through the supported replay window;
older or unknown callbacks cannot authorize effects. A new attempt has a new
identity, but retrying the same external operation retains its operation key.

Persist the OpenCode session, runtime host/process or container identity, Trigger
run, worktree, base revision, contract, and authority generation for each attempt.
Treat a lost dispatch response as uncertain delivery: look up the existing run
by its dispatch identity or use a proven idempotent dispatch API before retrying.
Trigger retries reconcile the assigned attempt; they cannot independently create
a new OpenCode session or retry a mutating step.

## Failure taxonomy

| Class | Definition | Typical response |
| --- | --- | --- |
| Execution failure | The mechanism could not run or finish an otherwise valid contract: unavailable worker, timeout, lost lease, provider outage. | Reconcile first; retry/resume only after authority and effect checks, within the retry budget. |
| Contract failure | Inputs, outputs, scope, or acceptance obligations were invalid or unmet. | Supervisor chooses bounded output remediation under the same contract or an explicit replacement contract; no blind retry. |
| Process failure | The process definition or policy cannot reach a valid next state: impossible dependency, missing gate, contradictory policy. | Halt affected process and repair/version the definition or policy. |

Failures are explicit domain records with category, phase, attempt, cause, and
evidence. Trigger.dev run status is supporting telemetry, not the classification.

## Replacement-worker gate

A timeout is evidence of lost contact, not evidence that the worker stopped.
Use at-least-once delivery with idempotent effects and fenced authority; do not
promise exactly-once execution of an arbitrary worker or shell command.

1. **Freeze and reconcile.** Mark the attempt contact-lost, prevent acceptance
   and new dispatch for the affected step, and query the runtime, Trigger, Git,
   and recorded external operations. If the original session is recoverable and
   has not been superseded, reconnect to it rather than create a second worker.
2. **Revoke old authority.** For replacement, atomically supersede the attempt
   and advance its authority generation in Postgres. Coordinator commands and
   effect adapters reject stale generations. The trusted runtime must confirm
   termination of the worker and descendants, or confirm isolation that prevents
   them reaching replacement work, shared mutable resources, and credentials.
   An abort request, expired lease, or worker self-report is insufficient.
3. **Resolve effects already in flight.** Record each operation as completed
   with its external identity, confirmed not performed, or unknown. Reuse a
   completed result. Retry only a confirmed absent effect or one protected by a
   still-valid provider idempotency guarantee. An unknown non-idempotent effect
   blocks conflicting replacement work until authoritative reconciliation.
4. **Authorize replacement.** Record the revocation/termination or isolation
   evidence, operation reconciliation, selected immutable starting artifact,
   current contract, and remaining budget. Persist the fresh attempt, allocation,
   and provisioning intents atomically with the outbox. Adapters then provision
   a fresh session and worktree idempotently, recording their identities before
   worker execution. External resources are not part of the Postgres transaction;
   an uncertain provisioning result uses the same reconciliation rule.

All applicable conditions above must hold before replacement runs. The
coordinator may perform this automatically within policy; require a decision
only when uncertainty, exceeded limits, or a scope change prevents continuation.
Replacement inherits the remaining step budget, not a fresh budget allowance.

Generation checks must protect the resource where an effect occurs, not merely
the callback that reports it. Workers have no direct publish/merge/deploy
credentials. Coordinator-owned adapters serialize shared-resource operations
and validate current authority when dispatching them. Where an external API
cannot enforce a generation, a request already sent may still finish after
revocation: keep the resource blocked until that request is reconciled.

Late observations from superseded attempts remain in history but cannot advance
state. Salvaging their work requires a stable snapshot after termination or
isolation, supervisor selection, and verification under the current contract.
Never let replacement work share an old attempt's writable worktree.

## Pause, cancellation, and bounded recovery

- Pause stops new dispatch and lets the current bounded step finish. It does not
  silently abort the worker; the UI states which work may still finish.
- Stop/cancel records a durable request, revokes authority, and requests runtime
  termination including descendants. Show stopping until trusted termination is
  confirmed. Isolation may permit recovery but must not be displayed as stopped.
- Preserve already-created artifacts and external effects; cancellation is not
  rollback. Reconcile in-flight effects even after a worker has stopped.
- Retry transient execution failures with bounded backoff within the contract's
  attempts/time budget. Block on exhaustion; do not retry contract/process
  failures without a supervisor decision.
- Resumption means reconstructing from durable domain state and verified
  artifacts, or reconnecting a known surviving session. It does not assume a
  saved worker memory image or a replayable conversation.

## Basis and implementation proof

The recovery policy applies the distinction between lease expiry and effective
write exclusion described in [Kleppmann's fencing analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html),
and the explicit request identities and ambiguous-effect handling described in
[Amazon's idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).
The AgencyHQ-specific gate above is a design decision, not a claim that either
execution adapter already implements it. The required failure trials are in
[TESTING.md](TESTING.md); see [ADR-0004](adrs/0004-supervised-completion-and-safe-recovery.md).
