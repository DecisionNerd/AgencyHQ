# Domain model

The model is sized for the first executable path — one repository, one bounded
process, one worker — and grows only when a later slice needs a concept.
Concepts marked *deferred* are vocabulary now and code later.

## Aggregate map

| Concept | Meaning and key invariants | Slice |
| --- | --- | --- |
| Project | A linked Git repository: remote, coordinator-owned clone and worktree base folder, allowed refs, verification profile catalog, and its versioned [delegated-authority schema](adrs/0006-lead-role-and-delegated-authority.md). | 2 |
| WorkItem | A ranked, scoped unit of intended change with a versioned definition of done and a completion boundary (`artifact`, `merge`, `deploy`). Owns lifecycle. The Campaign/Initiative/Goal split of the original baseline collapses into this until multiple campaigns exist. | 2 |
| StepContract | Immutable version: inputs, base revision, allowed paths, OpenCode permission rules, required runtime boundaries, `maxDuration`, attempt budget, expected outputs, criteria and profile digests. | 2 |
| Attempt | One execution of a StepContract: Trigger run id, authority generation, worktree path, OpenCode session id, attempt commit, checkpoint commit, report, and failure record. At most one active Attempt per StepContract. | 2 |
| DispatchIntent | Coordinator-recorded intent to trigger a task, keyed by intent id (the Trigger idempotency key), with the resulting run id once known. | 2 |
| Artifact | Content-addressed output: attempt commit id, diff digest, path summary, and worktree location. | 2 |
| VerificationResult | Result of one approved check against exact inputs, from a `verify.run` task. | 2 |
| Review | Adversarial review evidence: reviewer identity (model or human), subject versions, findings, and blocking status. | 2 |
| Decision | A Lead proposal accepted by the coordinator's authority check, or a human decision; immutable, versioned, with sources and rationale. Kinds: definition-of-done, profile, boundary, disposition, classification, acceptance, scope change. | 2 |
| Approval | Human decision over an exact subject version and evidence set, required only where the authority schema says so. Never a mutable boolean. | 2 |
| Finding | Evidence-backed observation from any task with an owned disposition; never silently widens a contract. | 2 |
| Campaign | Grouping of WorkItems across Projects with a shared rank order and declared main effort. *Deferred.* | 5 |
| ProcessDefinition | Versioned step/gate sequence. The bounded repair process is code until a second process exists. *Deferred.* | 4 |
| ProviderCapacity | Timestamped capacity observation with validity window. *Deferred.* | 6 |

*Implementation: all Slice 2 aggregates in `packages/domain/src/aggregates/`; lifecycle transitions namespaced per aggregate in `packages/domain/src/transitions/`.*

## Relationships

- A WorkItem belongs to one Project (multi-repository WorkItems arrive in
  slice 4 with revision manifests).
- A WorkItem has one or more StepContracts; the bounded repair process has one.
- Each Attempt binds to exactly one StepContract version, one Trigger run, and
  one authority generation.
- Artifacts, VerificationResults, and Reviews name the Attempt and revision
  they cover; Decisions and Approvals name the exact versions and digests they
  cover, so later changes cannot inherit them.

## The Lead and the definition of done

The Lead proposes; the coordinator decides (ADR-0006). Before dispatch the
Lead's `lead.plan` task produces, from operator intent and repository context,
a proposal containing: the criteria for done with a source for each (operator
intent or repository instruction); required checks and the verification
profile; review depth by change class; completion boundary; allowed paths and
capabilities; and budget. The coordinator checks every bound is a subset of the
Project's delegated authority. In-bounds proposals are recorded as Decisions
and frozen into the StepContract. Out-of-bounds proposals become a pending
human decision.

The Lead must not weaken the requested outcome to fit a result. Workers report
what they attempted, exact outputs, checks run, unmet criteria, limitations,
and Findings. An honest partial or failed report is valid execution evidence,
not acceptance. Missing results remain unknown.

A worker output with a null commit id (nothing changed) is classified as a
failure; no Artifact is created for that attempt. Test: `flow.parking (a)`
(`apps/coordinator/test/integration/flow.parking.test.ts`) asserts one
`failures` row with `class='contract'`, `phase='final'`, `cause` mentioning
`null commitId`; `attempt.status='failed'`; no `artifacts` row; no
`dispatch_intents` row for `verify.run`.

When the authority schema sets `humanRequired` true, the work item is parked as
`pending_human` after acceptance is proposed, and stays there until a matching
Approval bound to the same contract version and attempt exists. The `approve`
command (`POST /api/commands` with `kind: "approve"`) supplies the Approval
(`contractId`, `contractVersion`, `attemptRevision`), writes an `approvals`
row, and re-runs acceptance via `evaluateAcceptanceForAttempt`; the command is
idempotent by `commandId`. `APPROVAL_VERSION_MISMATCH` leaves the item
`pending_human`. Test: `flow.parking (b)` asserts one `decisions` row with
`kind='accept'`, `outcome='pending_human'`, `actor='coordinator'`; `work_items`
lifecycle not `'completed'`; no `approvals` row; replay is a no-op (still
exactly one decision row). The Approval command is covered by
`apps/coordinator/test/integration/approve.test.ts`.

## Delegated authority

The schema is defined in ADR-0006. Two rules govern it here:

1. Authority only narrows down the hierarchy: Project schema ⊇ WorkItem
   narrowing ⊇ StepContract bounds ⊇ what a worker's permission rules allow.
2. Widening any bound is a new StepContract version and, where `humanRequired`
   applies, an Approval. Workers cannot request widening; they report Findings.

The Project's **verification profile catalog is an authority ceiling**: the Lead may only choose a `profileId` from this catalog. A proposal naming an unknown profile becomes a `pending_human` decision with `PROFILE_NOT_IN_CATALOG`.

*Implementation: authority subset check with 15 violation codes in `packages/domain/src/authority/subset.ts`; human-approval determination in `packages/domain/src/authority/human-required.ts`; dispatch enforceability in `packages/domain/src/authority/runtime.ts`.*

## Allocation

Until slice 6, allocation is: the coordinator dispatches at most the
environment's configured number of worker attempts, in WorkItem rank order,
with Trigger serializing attempts per repository (`concurrencyKey`). Rank is
explicit; the highest-ranked runnable WorkItem is the main effort. Being
blocked does not change rank. Running attempts are not preempted by rank
changes. Every time supporting work runs ahead of the main effort, the reason
(blocked, awaiting decision, repository busy) is recorded.

Lifecycle (queued, active, paused, completed, cancelled), execution condition
(ready, running, blocked, awaiting decision), and rank are distinct. A
completed Attempt is not a completed WorkItem.

## Findings and dispositions

The Lead classifies each Finding; the coordinator records the disposition.

| Finding | Disposition |
| --- | --- |
| Required by current criteria and within bounds | Bounded remediation under the same contract, new Attempt. |
| Needs different scope, architecture, or criteria | Scope Decision; replacement contract if within authority, else human decision. |
| Unrelated defect or improvement | Linked backlog WorkItem; does not block acceptance. |
| Prevents safe or correct continuation | Block the WorkItem and name the resume condition. |
| Duplicate or unsupported | Link the original or dismiss with a reason. |

Match Findings by subject and cause before creating another.

*Implementation: finding dispositions in `packages/domain/src/findings/disposition.ts`; acceptance rule with 14 reason codes (`PROPOSAL_REJECTS`, `VERIFIER_TAMPERED`, `CRITERION_UNCITED`, `CRITERION_UNSATISFIED`, `CITED_RESULT_MISSING`, `CITED_RESULT_NOT_PASSING`, `RESULT_VERSION_MISMATCH`, `REVIEW_MISSING`, `REVIEW_VERSION_MISMATCH`, `REVIEW_BLOCKING`, `REVIEW_BELOW_REQUIRED`, `REVIEWER_NOT_DISTINCT`, `APPROVAL_REQUIRED`, `APPROVAL_VERSION_MISMATCH`) in `packages/domain/src/evidence/acceptance.ts`; verifier-tampering detection in `packages/domain/src/evidence/integrity.ts` (protected paths: package manifests, lock files, workspace file, tsconfig*, biome.json, .github/**, vitest/jest configs; test source files are not protected).*

## Version repair

| Change | Transition |
| --- | --- |
| Output needs correction; contract valid | New Attempt under the same contract once the prior run is final. A Failure record for the superseded attempt is committed in the same transaction before the new attempt is inserted. |
| Inputs, scope, or criteria change | Supersede the StepContract; new version, new Attempt; prior Attempt's generation revoked. |
| Evidence may carry forward | Link prior Artifacts with provenance. Reuse a VerificationResult only when criteria, profile, inputs, and revision match exactly; otherwise rerun. |

No instance is rebound in place. No Approval or Review transfers to a changed
subject version. Superseded Attempts may complete their run and their output is
stored as history, but their generation cannot advance state. Their worktrees
are retained until the retention policy removes them.

## State-transition rule

Every policy-relevant transition is validated in `packages/domain`, committed
to Postgres with actor, causation, and an idempotency key, and only then
followed by a DispatchIntent. Trigger runs are consumed as observations with
the run id and attempt generation as the dedupe identity.

*Implementation: failure classification table over 13 Trigger statuses in `packages/domain/src/failure/classify.ts`; dispatch selection in `packages/domain/src/dispatch/`.*
