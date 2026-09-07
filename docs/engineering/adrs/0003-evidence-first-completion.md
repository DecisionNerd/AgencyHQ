# ADR-0003: Completion is evidence-first

- Status: Accepted
- Date: 2026-09-06

## Context

Workflow engines and coding agents can report successful execution even when a
change violates scope, fails tests, targets the wrong revision, or lacks human
approval.

## Decision

Execution completion, contract satisfaction, process progress, and accepted
engineering completion are separate states. Acceptance requires deterministic
VerificationResults against exact artifact and Git identities plus any mandated
Approval. Failures are classified explicitly as execution, contract, or process
failures.

## Consequences

The UI must not collapse these states into a single success/failure flag.
Retries apply primarily to execution failures; contract and process failures
normally require a new decision or version. Evidence storage and verifier
versioning are part of the core model, not later observability work.

