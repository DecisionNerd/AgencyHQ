# ADR-0006: The Lead role and the delegated-authority schema

- Status: Accepted
- Date: 2026-09-07
- Extends: ADR-0004 (defines what the "supervisor" is and renames it)
- Amends: R-005 wording (see REQUIREMENTS.md)
- Implementation status: Authority subset check with 15 violation codes, fast-check property laws, and human-approval determination implemented in `packages/domain/src/authority/` (Slice 2). Lead tasks (`lead.plan`, `lead.review`, `lead.accept`) implemented via the OpenCode SDK with structured output; `BoundedRepairFlow` coordinator flow implemented (Slice 3). Qualified by the Slice 3 execution trial on 2026-09-07: item 5 PASS live, item 6 PARTIAL (worker resisted adversarial house rules — weakened-test path not exercised live; covered by deterministic tests), item 7 PASS live; see [../trials/2026-09-slice3.md](../trials/2026-09-slice3.md). Rework re-check 2026-09-07: full flow (plan → attempt → verify → review → accept) re-verified live; see the [rework section](../trials/2026-09-slice3.md#rework-after-independent-review-1-2026-09-07). Rework-2 (2026-09-07): `evaluateAcceptance` now accepts `integrityFindings`; `VERIFIER_TAMPERED` added as the 14th acceptance reason code; `onVerifyFinal` loads blocking verifier_tampered findings and passes them to the acceptance gate; no live run after 16002f2. Rework-3 (2026-09-07): corrected — `onVerifyFinal` writes `verifier_tampered` findings to the `findings` table; `onAcceptFinal` loads them and passes them to `evaluateAcceptance`; weakened tests are not protected paths and are detected only by the adversarial reviewer; `flow.false-success (f): weakened test — review blocks, no verifier_tampered, work item not completed` is the deterministic gate (`REVIEW_BLOCKING`); no live run after 16002f2. Rework-4 (2026-09-08): no change to this ADR's domain; stop-path and reconciler-route fixes in coordinator documented in trial rework-4 section; no live run after 16002f2.

## Context

ADR-0004 gave the "supervisor" every judgment task in the system — approving
the definition of done, choosing verification and review depth, classifying
Findings and failures, adversarial review, and acceptance — without saying what
performs it. The baseline also forbade the mechanisms that could: R-005 banned
an AgencyHQ agent loop and provider adapters, and the non-goals banned custom
LLM-provider integrations. "Delegated authority" decided whether a human is
consulted but had no schema. Repository content was untrusted for workers yet
supplied to the supervisor as context.

## Options considered

| Option | Benefit | Reason for decision |
| --- | --- | --- |
| The human operator is the supervisor | No model in the decision path. | Rejected: every transition then needs the operator, which contradicts automatic progress within delegated authority. |
| A worker agent with elevated permissions | One runtime. | Rejected: authority would rest on prompt discipline, and review would not be independent of authorship. |
| Direct LLM API calls inside the coordinator | Simple. | Rejected: introduces the provider adapters R-005 excludes and a second place model configuration lives. |
| OpenCode sessions in a read-only agent configuration with structured output, validated by deterministic coordinator policy | Reuses the provider abstraction, permissions, and structured-output validation OpenCode already has; keeps authority in code. | Selected. |

## Decision

**The Lead** is AgencyHQ's engineering decision role. It replaces the name
"supervisor" everywhere in AgencyHQ documents to avoid collision with
Trigger.dev's supervisor component.

The Lead is implemented as OpenCode sessions run as Trigger tasks, using a
dedicated OpenCode agent configuration: `edit`, `bash` writes, `webfetch`, and
`external_directory` denied; read, glob, grep, and read-only commands allowed;
the repository checked out at the relevant revision; and `--format json` with
a JSON-schema structured-output request for every decision. Lead sessions never
share a session, worktree, or container with a worker session.

**A Lead output is a proposal, not a decision.** The coordinator validates each
proposal deterministically against the project's delegated authority and only
then records it as the decision. Anything outside authority becomes a pending
human decision that names the obstacle, the proposal, and the consequence of no
action. The Lead cannot expand its own authority.

The **delegated-authority schema** is versioned data on each Project (and may be
narrowed per work item). Its fields:

| Field | Meaning |
| --- | --- |
| `paths.allow` / `paths.deny` | Glob patterns bounding the diff a worker may produce. |
| `capabilities` | OpenCode permission rules (bash patterns, tools) a contract may grant. |
| `boundaries` | Completion boundaries the Lead may select without a human: `artifact`, `merge`, `deploy`. |
| `budget` | Maximum attempts per step, `maxDuration` per attempt, machine preset ceiling, and an estimated-spend ceiling. |
| `review.minimum` | Least review profile the Lead may choose, by change class. |
| `models` | Provider/model identifiers permitted for worker, Lead, and reviewer sessions, and whether reviewer and worker must differ. |
| `humanRequired` | Path patterns, change classes, and boundaries that always require an exact-version human Approval. |

A proposal is within authority when every requested bound is a subset of the
schema's bound. Subset checks are code, with table tests.

**Repository content is untrusted input to the Lead.** Repository instructions
(AGENTS.md and similar) are supplied to the Lead as project context, but they
can only make a proposal *narrower*. The coordinator's subset check is what
prevents repository text from widening scope, weakening required checks, or
lowering review depth. Operator intent is recorded verbatim and separately
from repository text, and the Lead's structured output must cite which criteria
came from which source.

**Independence.** Adversarial review is a distinct Lead task, seeded with the
diff, the approved criteria, and verification results — never the worker's
conversation. Where the authority schema requires it, the reviewer model
differs from the worker model. Review by a model is recorded as review
evidence with the model identity; it is not represented as deterministic proof.

## Consequences

- R-005 is restated: AgencyHQ implements no coding-agent loop and no direct
  provider adapters; all model calls go through OpenCode.
- Lead quality is a measurable product property. Each Lead decision is stored
  with its proposal, sources, model, and the later outcome, so acceptance
  errors and unnecessary escalations can be counted (see TESTING.md).
- The coordinator's policy code is small and deterministic: subset checks,
  transition validation, and evidence matching.
- Prompt injection through repository content is bounded by the schema rather
  than by prompt wording; that bound is only as good as the schema's coverage.
