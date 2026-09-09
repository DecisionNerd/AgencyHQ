# Experience

This folder connects evidence about engineering coordinators and operators to
the product's stable requirements. The current baseline comes from the project
design discussion and is product intent, not validated user research.

Future interviews, observed operator sessions, support evidence, and production
signals belong in focused artifacts here. A Finding changes a requirement only
when its evidence and the resulting decision are explicit.

## Experience principles

- **Evidence before completion** — the operator can inspect what proves a claim.
- **State without ambiguity** — contract, execution, process, and acceptance
  states remain distinct.
- **Controlled action** — scope, allocation, and approval impact is visible
  before a command is committed.
- **Recoverable history** — retries and corrections preserve prior attempts and
  causation.

## Startup requirement from the project owner (2026-09-08)

The owner rejected an onboarding path requiring manually assembled services
and host development processes. The requested experience is one Compose startup,
OpenCode provider login with persisted state, and reusable worker images that
support additional task containers. This is direct product input, not a
validated usability study. R-021–R-025 and
[ADR-0008](../engineering/adrs/0008-compose-first-container-runtime.md) turn it
into a target; [C1–C7](../engineering/TESTING.md#compose-runtime-qualification)
define the observable success criteria.

## Artifact shape

A future opportunity, journey, or study should record observed need and
evidence, desired outcome, users and context, current journey, hypothesis,
Given/When/Then behavior, constraints, success signals, open questions, and
links to requirements, tests, architecture, and ADRs.

## Index

No focused discovery artifacts exist yet. That gap is explicit; no user
research or validation is implied by the baseline design.

