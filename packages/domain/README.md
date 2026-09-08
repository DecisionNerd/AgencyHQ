# Domain package

Framework-free TypeScript: aggregates, transitions, authority subset checks,
failure classification over Trigger run statuses, evidence matching, and
dispatch ordering. Imports nothing from Trigger.dev, OpenCode, React, or a
Postgres client.

## Package

Package name: `@agencyhq/domain`. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs the unit test suite with `node --test`.

## Failure classification

`src/failure/classify.ts` classifies Trigger.dev run observations into three mutually exclusive failure classes (R-007):

| Class | When | Coordinator response |
| --- | --- | --- |
| `execution` | Run crashed, timed out, was canceled unexpectedly, or the adapter returned an error outcome. | Create a new Attempt automatically, up to the remaining step budget. |
| `contract` | Run completed with a path violation, or failed with `AbortTaskRunError` (adapter setup failure). | Lead disposition only; never automatic retry. |
| `process` | Run completed but the output is absent or unparseable — the coordinator cannot compute a next state. | Halt the WorkItem; human decision required. |
| `none` | Run is still in flight, completed as requested, or the observation is stale. | No action. |

**Key rules (from EXECUTION_MODEL.md §Failure taxonomy and the Slice 1 trial):**

- `COMPLETED` with `output.outcome = "timed_out"` is an execution failure (adapter soft deadline), not a Trigger-level timeout.
- `CANCELED` or `COMPLETED+cancelled` with `stopRequested = true` is class `none` (`attemptStatus: "stopping"`), not a failure.
- `FAILED` with `AbortTaskRunError` or a setup-contract error message is class `contract`, never retried.
- `COMPLETED` with `output.outcome = "completed"` is class `none`; it is **not acceptance** — acceptance requires approved criteria, passing `VerificationResult`s, a Review, and a recorded Decision.

**Stale observations** (`observedGeneration !== generation`) return `class: "none"` with `stale: true` and `attemptStatus: "uncertain"`. Callers must not apply stale classifications to attempt state.

The `CLASSIFICATION_TABLE` constant exports all rules as a data array (`status`, `outcome`, `stopRequested`, `errorType`, `class`, `attemptStatus`, `autoNewAttemptWhenBudget`). `classifyObservation(obs, ctx)` looks up this table to ensure the test can assert exhaustiveness.

## Dispatch ordering (`src/dispatch/`)

`selectDispatch` implements R-008: given a ranked list of work items and the
set of currently active attempts, it returns the items to dispatch this pass
and the reason every other item was skipped.

**Eligibility rules** (applied in priority order):

1. `lifecycle` must be `admitted`, `active`, or `reopened` — else `not_admitted`
2. `condition` must be `healthy` — `blocked` → `blocked`, `uncertain` → `uncertain`
3. The work item must not already have a running attempt — `already_active`
4. The item's repository must not be listed as uncertain — `repository_uncertain`
5. The item's repository must not already have an active attempt or an
   earlier selection in this pass — `repository_busy`
6. There must be remaining slot capacity — `no_slot`

`mainEffort` is the id of the highest-ranked item passing rules 1–2, whether
or not it was dispatched. It is stable when the top item is blocked by a busy
repository or exhausted slots — the UI always shows the correct main effort.

The function is pure (no I/O) and deterministic (ties broken by `id` ascending).
## Authority

The `authority/` module implements the delegated-authority security boundary (R-009, R-020).

### `subset.ts` — Proposal validation

`checkProposal(schema, proposal, opts?)` validates a LeadProposal against a project Authority schema. It collects **all** violations (never just the first) and returns either a passing result with assembled `ContractBounds` from the proposal and a `humanRequired` flag, or a failure with typed `AuthorityViolation[]` objects.

Each violation carries a `ViolationCode`, a dot-path, and a detail string. Codes: `PATH_ALLOW_WIDER`, `PATH_DENY_DROPPED`, `BASH_ALLOW_WIDER`, `BASH_DENY_DROPPED`, `TOOL_NOT_GRANTED`, `BOUNDARY_NOT_DELEGATED`, `BUDGET_ATTEMPTS`, `BUDGET_DURATION`, `BUDGET_SPEND`, `BUDGET_MACHINE`, `REVIEW_BELOW_MINIMUM`, `MODEL_NOT_ALLOWED`, `REVIEWER_SAME_AS_WORKER`, `NO_OPERATOR_CRITERION`, `INVALID_PATTERN`.

`effectiveAuthority(schema, narrowing?)` applies a per-WorkItem narrowing that can only narrow (allow ⊆, deny ⊇, tools only false-ward, boundaries ⊆, budget ≤, review ≥, models ⊆, humanRequired ⊇). Widening fields are silently ignored.

`bashPatternSubset(narrow, wide)` determines whether one bash command-glob is a subset of another. It is conservative: when uncertain, it returns false.

### `human-required.ts` — Approval gates

`requiresApproval(schema, bounds)` determines whether a contract requires a human Approval. Gates fire when any allow pattern intersects a `humanRequired.paths` pattern (conservative intersection), the change class is in `humanRequired.changeClasses`, or the boundary is in `humanRequired.boundaries`. Always computed from the assembled `ContractBounds`, never from the proposal's claimed class alone.

### `runtime.ts` — Dispatch enforceability

`requiredBoundariesFor(bounds)` returns the `BoundaryKind[]` the runtime profile must enforce for a given contract. Always includes: `worktree`, `output_paths`, `push`, `termination`, `capability`, `duration`. Conditionally adds `fs_isolation` and `egress_spend` when external network tools are enabled or a spend ceiling exists.

`enforceable(profile, requiredBoundaries)` checks whether a runtime profile can enforce all required boundaries. Returns `ok: false` with an `advisory` list if any required boundary is marked advisory in the profile (R-016: the `HOST_PROFILE` marks `fs_isolation`, `cpu_memory`, and `egress_spend` as advisory — contracts requiring those must run in a container).

## Modules

- **`ids.ts`** — Branded id types (`ProjectId`, `WorkItemId`, `StepContractId`, `AttemptId`, `DispatchIntentId`, `ArtifactId`, `VerificationResultId`, `ReviewId`, `DecisionId`, `ApprovalId`, `FindingId`, `FailureId`, `CommandId`). `newId(prefix)` generates a UUID-backed id. `asXId(s)` performs a prefix-check cast.
- **`result.ts`** — `Ok<T>`, `Err<E>`, `Result<T,E>` discriminated union with `ok()`, `err()`, `isOk()`, `mapResult()` helpers. No dependencies.
- **`ports.ts`** — Port interfaces: `ExecutionRuntime` (trigger/cancel/retrieve/createPublicToken), `Clock` (now), `IdGen` (next). Also exports `TriggerRunStatus`, `FINAL_RUN_STATUSES`, and `RunObservation`.
- **`aggregates/project.ts`** — `Project` aggregate: remote, clone path, worktree base, allowed refs, profile catalog, delegated authority.
- **`aggregates/work-item.ts`** — `WorkItem` aggregate: ranked, scoped unit of intended change with lifecycle and condition.
- **`aggregates/step-contract.ts`** — `StepContract` re-export plus `freezeContract()` (pure assembly from an approved lead proposal — copies bounds from the proposal, not the authority schema) and `supersede()` (creates superseded old + active next; caller provides all replacement fields explicitly).
- **`aggregates/attempt.ts`** — `Attempt` aggregate: Trigger run, authority generation, worktree, session, commits, budget.
- **`aggregates/dispatch-intent.ts`** — `DispatchIntent` aggregate: coordinator-recorded trigger intent keyed by idempotency key.
- **`aggregates/artifact.ts`** — `Artifact` aggregate: content-addressed attempt output.
- **`aggregates/finding.ts`** — `Finding` aggregate: evidence-backed observation with severity, kind, and disposition.
- **`aggregates/review.ts`** — `Review` aggregate: adversarial review evidence with findings.
- **`aggregates/decision.ts`** — `Decision` aggregate: immutable coordinator or human decision.
- **`aggregates/approval.ts`** — `Approval` aggregate: human decision over exact subject version.
- **`aggregates/failure.ts`** — `Failure` aggregate: classified failure with class, phase, cause, and evidence.
- **`aggregates/verification-result.ts`** — Re-export of `VerificationResult` from `@agencyhq/contracts`.
- **`transitions/attempt.ts`** — Pure attempt transitions: `markDispatched`, `observe`, `revoke`, `confirmStopped`, `markUncertain`. `ATTEMPT_TRANSITIONS` table drives all legal-transition checks. Returns `Result<{attempt, events}, TransitionError>`.
- **`transitions/work-item.ts`** — Pure work-item transitions: `admit`, `activate`, `complete`, `halt`, `reopen`, `markCondition`. `WORK_ITEM_TRANSITIONS` table drives all legal-transition checks.

## Evidence and findings

`packages/domain/src/evidence/` implements the acceptance gate and evidence-integrity checks:

- **`types.ts`** — Structural input shapes (`ArtifactLike`, `AttemptLike`, `ApprovalLike`, `ReviewLike`, `FindingLike`) and re-exports of contract types used throughout this subsystem.
- **`match.ts`** — Exact-equality matching for `VerificationResult`, `ReviewLike`, and `ApprovalLike` against the current `StepContract`, attempt, and artifact. Each mismatch field is named individually so callers can inspect the full set. `verificationResultRef` produces the stable ref string used in `AcceptanceProposal` evidence entries. Implements R-018: an `Approval` or `Review` on a different contract version never matches.
- **`acceptance.ts`** — `evaluateAcceptance` collects every acceptance failure before returning. It accepts an optional `integrityFindings` input; any blocking `verifier_tampered` finding causes rejection with reason `VERIFIER_TAMPERED` independently of the review. 14 reason codes: `PROPOSAL_REJECTS`, `VERIFIER_TAMPERED`, `CRITERION_UNCITED`, `CRITERION_UNSATISFIED`, `CITED_RESULT_MISSING`, `CITED_RESULT_NOT_PASSING`, `RESULT_VERSION_MISMATCH`, `REVIEW_MISSING`, `REVIEW_VERSION_MISMATCH`, `REVIEW_BLOCKING`, `REVIEW_BELOW_REQUIRED`, `REVIEWER_NOT_DISTINCT`, `APPROVAL_REQUIRED`, `APPROVAL_VERSION_MISMATCH`. The `WorkerReport.checksRun` field is absent from the input by construction (R-014).
- **`integrity.ts`** — `detectVerifierTampering` produces a blocking `FindingLike` for each changed path that matches a protected verifier-configuration path pattern (package manifests, lock files, workspace file, tsconfig*, biome.json, .github/**, vitest/jest configs). Test source files (`test/**`, `tests/**`, `*.test.*`, `*.spec.*`) are not protected: weakened or removed tests are the adversarial reviewer's job, governed by the contract's `paths.allow`. Any change to a protected path is Review-blocking until the profile is re-versioned (TESTING.md §68-84).
- **`index.ts`** — Public re-exports for the evidence subsystem.

`packages/domain/src/findings/` implements finding dispositions:

- **`disposition.ts`** — `applyDisposition` routes a finding to one of five dispositions (`backlog`, `remediate`, `scope_decision`, `block`, `dismiss`) and returns the appropriate `DispositionEvent`. The contract digest is never altered: `contractDigestAfter` is always the input `contractDigest` unchanged (R-017).
- **`index.ts`** — Public re-exports for the findings subsystem.
