# Incremental roadmap

Each slice must leave the repository runnable, tested, and more capable than the
previous slice. Later slices must not be pulled forward merely to anticipate
scale.

## Slice 0 — architecture baseline (current)

- Repository/package boundaries and authority decisions are documented.
- Domain vocabulary, failure taxonomy, scope rule, and completion rule exist.
- A deterministic check protects the baseline and internal links.

## Slice 1 — bounded process and domain kernel

- Walk through the bounded repair contract, supervisor criteria, an honest
  partial result, and a return-after-interruption view using in-memory data.
- Implement only the identifiers/transitions needed for that path, including
  version repair, acceptance, Finding disposition, and recovery gate decisions.
- Add unit/property tests for invalid transitions, version binding, scope,
  idempotency, evidence invalidation, and the three failure classes.
- No real worker dispatch or generalized process graph editor yet.

## Slice 2 — Postgres truth

- Add migrations and repositories for the domain ledger and transactional
  dispatch/outbox.
- Prove concurrent transition, idempotency, audit, and recovery behavior with
  integration tests against a pinned Postgres version.
- Include attempt generations, capacity reservations, external-operation
  identities, and supervisor-approved verification profiles before real effects.

## Slice 3 — one complete executable repair

- Use one repository, one bounded repair process, one worker, and pinned
  Trigger/OpenCode versions. Prove runtime isolation before admitting contracts.
- Include exact artifact capture, supervisor-approved verification, proportional
  review, acceptance, and an unrelated Finding with a backlog disposition.
- Include leases, revocation, cancellation, reconciliation, and safe replacement
  now. Demonstrate interruption and delayed stale results using the real runtime.
- Add a minimal operator view for changes, evidence, decisions, and confirmed
  versus requested stop state. It need not implement the complete control plane.
- Use deterministic fakes for routine tests and require the recorded real
  [execution trial](../engineering/TESTING.md#required-first-execution-trial)
  to qualify this slice. Workflow success alone cannot qualify it.

## Slice 4 — integration and multiple repositories

- Extend the proven path with merge/deployment boundaries only where required.
- Define shared-interface ownership, compatible revision manifests, dependency
  order, and combined acceptance before enabling multi-repository Goals.
- Prove that individually passing changes cannot bypass failed integration and
  that relevant regressions reopen completion without erasing acceptance history.

## Slice 5 — expanded operator control plane

- Extend the minimal view with campaigns, ranked work, process/step state, failures,
  allocations, evidence, and approval actions.
- Exercise primary flows with browser-level acceptance tests.

## Slice 6 — broader capacity allocation

- Extend the single-worker limit with ProviderCapacity observations, explicit
  cross-campaign rank, main-effort allocation, and conservative stale-data rules.
- Retain the existing recovery gate and repository serialization. Add concurrent
  workers or nested delegation only after shared-scope, aggregate budget, and
  descendant cancellation checks pass.
- Load-test only enough to expose actual bottlenecks before considering new
  infrastructure or deployment boundaries.
