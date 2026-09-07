# Testing and verification

AgencyHQ uses behavior-first tests and deterministic evidence. Fast domain
tests protect policy and state transitions; integration tests prove the real
Postgres, Git/worktree, Trigger.dev, and OpenCode boundaries; browser tests
prove operator-visible behavior. A green workflow is never a substitute for
the acceptance evidence required by a StepContract.

## Strategy

| Layer | What it proves | Planned implementation |
| --- | --- | --- |
| Architecture baseline | Required records, links, boundary language, and completed DocSlime docs remain intact. | Node test runner in `tests/architecture-baseline.test.mjs`. |
| Domain | Invariants, transitions, ranking, scope, idempotency, and failure classification. | Framework-free TypeScript unit and property tests in the domain package. |
| Persistence | Transactional state, outbox dispatch, concurrency, replay, audit, and recovery. | Integration tests against a pinned Postgres version. |
| Adapters | Exact contracts at Git/worktree, Trigger.dev, and OpenCode boundaries. | Deterministic fakes plus opt-in local integration tests. |
| Operator behavior | Distinct states, evidence inspection, scope preview, and approval commands. | Browser-level acceptance tests against the composed system. |

## Behavior coverage

The following scenarios are the required evidence map. Test paths beyond the
architecture baseline are explicit roadmap gaps, not claims of current code.

| Requirement | Given / When / Then | Evidence |
| --- | --- | --- |
| R-001, R-004 | Given a successful Trigger.dev run, when required acceptance evidence is absent, then the coordinator does not mark the step accepted. | Planned domain and Trigger adapter tests. |
| R-002 | Given a state transition and dispatch intent, when a transaction fails or dispatch is replayed, then no uncommitted decision produces an external effect and committed dispatch remains recoverable. | Planned Postgres transaction/outbox tests. |
| R-003, R-009 | Given a bounded StepContract, when a worker attempts a prohibited capability or repository access, then the runtime rejects it; a disallowed output diff is quarantined and cannot be accepted. | Planned runtime isolation and Git adapter tests. |
| R-005 | Given a configured OpenCode runtime, when work is dispatched, then it uses the pinned supported API and provider abstraction without an AgencyHQ agent loop or direct provider adapter. | Planned OpenCode contract test and dependency review. |
| R-006 | Given exact outputs, when the pinned checks and required review pass and the supervisor accepts the matching evidence, then acceptance may advance without an extra human gate unless policy requires one. | Planned verification-policy tests. |
| R-007 | Given equivalent retry conditions in different failure categories, when recovery is evaluated, then only execution failure is automatically retryable by default. | Planned domain table tests. |
| R-008 | Given constrained compatible capacity, when ranked work is allocated, then the feasible main effort receives capacity first and every exception has a reason. | Planned allocation-policy tests. |
| R-008 | Given two Campaigns share a repository or stale capacity data, when allocation runs, then global rank and repository serialization apply, conservative limits bound dispatch, and blocked main effort retains its identity. | Planned shared-capacity and stale-observation tests. |
| R-010 | Given a previously handled callback, when it is delivered again with the same idempotency key, then no second logical attempt or approval is created. | Planned persistence integration tests. |
| R-011 | Given contract, execution, process, and acceptance states differ, when the operator opens the process view, then each state and its source timestamp are distinct. | Planned browser acceptance test. |
| R-012 | Given package and deployment changes, when the architecture is reviewed, then domain dependencies remain inward and new services require measured need and an ADR. | Planned dependency check and architecture review. |
| R-013 | Given an expired lease with an unconfirmed worker or unknown external effect, when recovery runs, then replacement is blocked until the recovery gate holds; late stale results cannot advance it. | Planned real interruption and stale-worker integration tests. |
| R-014 | Given a supervisor-approved definition of done, when a worker changes a check or reports partial success, then the original criteria remain authoritative and unmet work is not accepted. | Planned profile provenance and supervisor authorization tests. |
| R-015 | Given separately passing branches or repositories, when the required combined revision set fails, then the Goal remains incomplete. | Planned integration acceptance tests. |
| R-015 | Given a completed Goal, when relevant evidence is disproved or required live behavior regresses, then current completion is reopened with its historical acceptance preserved; unrelated commits alone do not reopen it. | Planned completion-validity tests. |
| R-016 | Given a required capability is only advisory or unavailable, when dispatch is requested, then it is rejected; unaccounted child delegation is disabled. | Planned adapter capability and nested-delegation tests. |
| R-017 | Given an unclear request or unrelated Finding, when the supervisor classifies it, then it requests inputs or records the correct disposition without authorizing unrelated work. | Planned process selection and Finding tests. |
| R-018 | Given a contract is superseded, when a replacement is created, then the old instance stays immutable and mismatched checks/approvals cannot transfer. | Planned version-transition tests. |
| R-019 | Given an operator returns after interruption, when the workspace opens, then changed outcomes, pending decisions, stale observations, and actual stop status are understandable without opening logs. | Planned browser journey test. |

## Completion rule

A successful Trigger.dev run or OpenCode response is an execution observation;
it does not establish accepted completion or that every descendant stopped.
Acceptance requires the supervisor-approved criteria to be met by exact outputs,
passing required VerificationResults, the required review, and a recorded
supervisor acceptance decision. Any required human Approval binds to the same
subject version and evidence. The coordinator enforces these prerequisites.

### Lean verification and review

The supervisor chooses the smallest adequate profile before dispatch, guided by
project context and the consequences of failure. Repository-mandated checks and
review still apply. The following are defaults, not additional workflow layers:

| Work | Required evidence and review |
| --- | --- |
| Editorial or mechanical change with no behavior impact | Relevant structural checks (such as links, formatting, or a build) and supervisor inspection of the exact diff against the request. No invented behavior test or separate review session solely for ceremony. |
| Behavior change or bounded bug fix | Targeted tests for the claimed behavior and plausible regression, relevant existing project checks, and one adversarial review by the supervisor or another reviewer who did not author the change. |
| Shared-interface change, migration, security-sensitive or hard-to-reverse action | The behavior-change profile plus checks aimed at the specific risk, such as compatibility, migration recovery, or deployment observations. Human approval only where policy or delegated authority requires it. |

Adversarial review asks what could make the completion claim false: an untested
criterion, scope violation, regression, incompatible dependency, or misleading
evidence. It records concise findings or no blocking findings against exact
versions. An existing qualifying PR review counts; do not require another panel,
meeting, or named red-team process. The reviewer cannot approve its own authored
change where independent review is required. Reviewer identity and authorship
are recorded; review by another agent is useful evidence, not a guarantee.

Acceptance waits for criterion failures and material correctness or safety
findings. Style preferences and unrelated improvements become nonblocking
Findings. Recheck changed outputs and affected risks after remediation; do not
restart unrelated review. Stop once the agreed gates pass.

Deterministic checks prove their assertions, not all possible correctness.
Qualitative judgments are recorded as review evidence, never fabricated as
deterministic tests. This policy follows the proportionality of [Google's code
review standard](https://google.github.io/eng-practices/review/reviewer/standard.html),
which favors meaningful improvement over perfection; the profiles are AgencyHQ's
chosen application of that principle.

### Evidence integrity

Before execution, record the supervisor-approved criteria and verification
profile digests outside the worker's writable scope. The verification adapter
runs the approved checks against a stable snapshot in an isolated environment
and records its own results; worker reports do not substitute for that run.
Workers may add tests or propose corrections, but any alteration to an approved
verifier, assertion, or its transitive configuration requires supervisor review
and explicit profile versioning before it counts. A green weakened suite does
not satisfy the original contract.

Review, Approval, and VerificationResult records identify the evidence they
cover. Preserve reused artifact provenance, including any source attempt; check
reuse follows [version repair](DOMAIN_MODEL.md#version-repair), not a worker's
claim that prior checks remain valid.

### Initiative and Goal completion

An Initiative or Goal is complete when all criteria in its approved definition
of done are satisfied at its declared completion boundary, required evidence
and review cover the resulting integrated identities, required approvals exist,
and no unresolved blocking Finding or ambiguous external operation affects the
claim. The supervisor records acceptance and rationale; counting successful
steps is insufficient. Unrelated backlog work need not finish.

Use one target revision for a repository or a manifest of exact compatible
revisions for multiple repositories. Name an integration owner in the process;
serialize updates to shared target refs, revalidate against their current base,
and verify the combined result. Cross-repository work declares dependency order
and runs a compatibility check against that manifest. Independent green results
do not replace the combined check.

Accepted artifact, merged change, and deployed outcome are distinct boundaries.
Require authoritative merge evidence only for a merge goal, and deployment
identity plus relevant live observations only for a deployed outcome. A deploy
goal cannot complete from tests alone; a documentation goal needs no deployment.
For a one-step Goal, reuse the same evidence and supervisor decision at both
levels when the criteria and boundary match; do not add a second approval ritual.

| Later event | Effect on completion |
| --- | --- |
| Output, criteria, verification profile, or dependency identity changes before acceptance | Invalidate mismatched evidence/review/approval; rerun only affected gates against the new identities. |
| Evidence is falsified, misattributed, unavailable for a required audit, or a material defect disproves an accepted criterion | Mark the current claim invalidated and reopen affected work with the reason and evidence. Preserve the historical acceptance record. |
| A required deployed outcome is rolled back or demonstrably regresses | Reopen that outcome and affected dependents; retain the earlier deployment and acceptance history. |
| New desired behavior or unrelated later commits | Create a new Goal version or work item; do not retroactively invalidate a valid historical completion. |

Invalidate only dependent claims supported by the affected evidence. Completion
records are immutable historical facts; current validity is a separate state.
Continuous monitoring is required only when the Goal explicitly includes it,
not an automatic obligation for every completed change.

## VerificationResult minimum record

- verifier name and version;
- StepContract and attempt identities;
- definition-of-done and approved verification profile versions/digests;
- repository, base revision, and resulting revision or diff digest;
- normalized command/check identifier and relevant environment fingerprint;
- start/end timestamps, exit status, and bounded stdout/stderr evidence;
- input and output artifact digests;
- deterministic pass/fail/error outcome.

## Initial verification layers

1. Contract validation: required inputs, scope, identities, and artifact schema.
2. Repository validation: clean provenance, allowed paths, expected base, and
   inspectable diff.
3. Project checks: formatter, typecheck, unit/integration tests, and build as
   selected by the Project's versioned verification profile.
4. Acceptance checks: Goal/Initiative-specific assertions from StepContract.
5. Review and acceptance: the required adversarial or supervisor inspection,
   supervisor acceptance, and human Approval only where mandated.

Checks must be runnable without relying on a prior agent conversation. Network
and nondeterministic tests are isolated and reported separately; they cannot be
silently treated as deterministic acceptance.

## Required first execution trial

Before a real-worker slice is called complete, demonstrate one bounded repair
with the pinned self-hosted Trigger/OpenCode versions and the actual runtime:

- create an output, interrupt contact, reconcile, and resume or replace without
  duplicate sessions or external effects;
- delay an old worker/callback past supersession and prove it cannot alter the
  replacement or advance acceptance;
- lose an external operation response and block conflicting retry until its
  outcome or valid idempotency protection is established;
- cancel with a descendant running and distinguish requested, isolated, and
  confirmed stopped states;
- reject altered success criteria and a false worker success report, capture an
  unrelated Finding, and finish with exact evidence and proportional review.

Use deterministic fakes for routine checks, but require one recorded real trial
to qualify the adapter versions. Rerun relevant trials when those versions or
enforcement mechanisms change. No such trial has been implemented or passed yet.

## Repository baseline check

The current `pnpm check` is intentionally small. It verifies the architecture
record itself while product code does not yet exist. Each vertical slice must
extend the check with executable domain and integration tests before it can be
called complete.

Run the currently implemented suite with:

```sh
pnpm check
```

No CI workflow exists yet. Before the first feature branch is merged, the
baseline check and the slice-specific tests must run in CI and block merge on
failure.
