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
3. `hasOpenIntegrateIntent` must not be `true` — else `integration_pending` (integration is in flight; dispatching would race with the integrator)
4. The work item must not already have a running attempt — `already_active`
5. The item's repository must not be listed as uncertain — `repository_uncertain`
6. The item's repository must not already have an active attempt or an
   earlier selection in this pass — `repository_busy`
7. There must be remaining slot capacity — `no_slot`

`mainEffort` is the id of the highest-ranked item passing rules 1–2, whether
or not it was dispatched. It is stable when the top item is blocked by a busy
repository or exhausted slots — the UI always shows the correct main effort.

**Campaign ordering** (when `mainEffortByCampaign` is provided): campaign members cluster at their campaign's main effort's rank. Within the cluster, the designated main effort sorts first; remaining members follow in `(rank, createdAt, id)` order. Items without a `campaignId` keep the existing global `(rank, id)` order. No new skip reason (`not_main_effort_slot`) is introduced — the main effort is prioritised entirely through sort ordering.

**Provider capacity gating** (when `providerCapacity` and `now` are provided): each dispatched work item carries an optional `provider` and `model` field. `selectDispatch` looks up the matching `ProviderCapacity` observation, computes `effectiveCapacity(obs, now)`, and applies `concurrencyFor(status)`:

| effective status | concurrencyFor | skip reason when blocked |
| --- | --- | --- |
| `ok` | null (unbounded) | — |
| `limited` | 1 | `provider_limited` |
| `unknown` | 1 (conservative) | `provider_unknown` |
| `down` | 0 | `provider_down` (always skipped) |

`activeByProvider: Record<string, number>` counts active attempts per provider before this pass. The combined count (active + chosen this pass) never exceeds `concurrencyFor`. Observations past their `validUntil` are treated as `unknown` (conservative stale handling, R-008/Slice 6).

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

### `update.ts` — Authority update proposal

`proposeAuthorityUpdate(current, next)` validates an authority update. `next` must parse with `AuthoritySchema` and its numeric version must be strictly greater than `current.version`. Returns `Ok({ version, authority })` on success; `Err({ kind: "parse_error", issues })` or `Err({ kind: "version_not_greater" })` on failure. The returned `version` comes from the parsed authority so the project's `authorityVersion` can be updated atomically.

`frozenContractsUnaffected(contract, newAuthority)` always returns `true`, documenting the R-018 invariant: an authority update never mutates existing `StepContract` bounds or digests — it governs only future proposals. The table test in `authority.update.test.ts` verifies `contract.bounds` is deep-equal before and after an update.

### `runtime.ts` — Dispatch enforceability

`requiredBoundariesFor(bounds)` returns the `BoundaryKind[]` the runtime profile must enforce for a given contract. Always includes: `worktree`, `output_paths`, `push`, `termination`, `capability`, `duration`. Conditionally adds `fs_isolation` and `egress_spend` when external network tools are enabled. Adds `integrate` when `bounds.boundary` is `"merge"` or `"deploy"` (R-015).

`enforceable(profile, requiredBoundaries)` checks whether a runtime profile can enforce all required boundaries. Returns `ok: false` with an `advisory` list if any required boundary is marked advisory in the profile (R-016: the `HOST_PROFILE` marks `fs_isolation`, `cpu_memory`, and `egress_spend` as advisory — contracts requiring those must run in a container).

`checkBoundarySupport(bounds)` checks whether the contract's completion boundary is currently implemented. Returns a `RuntimeViolation` with code `DEPLOY_NOT_SUPPORTED` when `bounds.boundary === "deploy"` (deploy is declared but not yet implemented), or `null` when the boundary is supported. This check is distinct from `requiredBoundariesFor`/`enforceable` — it is a categorical "not implemented" gate applied before dispatch.

## Modules

- **`ids.ts`** — Branded id types (`ProjectId`, `WorkItemId`, `StepContractId`, `AttemptId`, `DispatchIntentId`, `ArtifactId`, `VerificationResultId`, `ReviewId`, `DecisionId`, `ApprovalId`, `FindingId`, `FailureId`, `CommandId`). `newId(prefix)` generates a UUID-backed id. `asXId(s)` performs a prefix-check cast.
- **`result.ts`** — `Ok<T>`, `Err<E>`, `Result<T,E>` discriminated union with `ok()`, `err()`, `isOk()`, `mapResult()` helpers. No dependencies.
- **`ports.ts`** — Port interfaces: `ExecutionRuntime` (trigger/cancel/retrieve/createPublicToken, optional `subscribe?`), `Clock` (now), `IdGen` (next). Also exports `TriggerRunStatus`, `FINAL_RUN_STATUSES`, and `RunObservation`. Adapters that report provider capacity include a `capacity` key in `RunObservation.metadata`; the coordinator updates the `ProviderCapacity` store after the normal dedupe path (R-010). The optional `subscribe?` method on `ExecutionRuntime` is a wake-up hint only — the coordinator must still poll and apply observations through the dedupe path.
- **`aggregates/provider-capacity.ts`** — `ProviderCapacity` aggregate: `{ provider, model, status: "ok"|"limited"|"down", observedAt, validUntil, source: "adapter"|"operator" }`. `effectiveCapacity(obs, now)` returns `"ok"|"limited"|"down"|"unknown"` (past `validUntil` or absent → `"unknown"`). `concurrencyFor(status)` maps `ok→null`, `limited→1`, `unknown→1`, `down→0` (Slice 6, conservative stale handling).
- **`aggregates/campaign.ts`** — `Campaign` aggregate: `{ id, name, mainEffortWorkItemId: string | null }`. `setMainEffort(campaign, workItem)` returns `Ok(campaign)` when the work item's `campaignId` matches the campaign id, else `Err("work_item_not_in_campaign")`. `campaignRankOrder(items)` returns a new array sorted by `(rank asc, createdAt asc, id asc)` — a total order guaranteeing no two distinct items compare equal.
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
- **`transitions/work-item.ts`** — Pure work-item transitions: `admit`, `activate`, `complete`, `halt`, `reopen`, `markCondition`. `WORK_ITEM_TRANSITIONS` table drives all legal-transition checks. `complete()` is boundary-aware: `"artifact"` requires an attempt revision; `"merge"` requires a fully-resolved `RevisionManifest` (all entries must have `resultRevision`) and returns the last entry's revision plus the manifest digest in the event; `"deploy"` always returns `Err(deploy_not_supported)`.

## Integration (`src/integration/`)

- **`manifest.ts`** — Revision manifest helpers for multi-repository work items. Exports `ManifestEntry` and `IntegrateOutcome` structural types (shape-compatible with the contracts package's `RevisionManifestSchema` / `IntegrateMergeOutputSchema`; kept local by design — the domain package does not import from sibling packages, and the trigger package imports `IntegrateMergePayloadSchema` from `@agencyhq/contracts` directly). `nextEntry(entries)` returns the unresolved entry with the lowest position; `allResolved(entries)` returns true when all entries have a non-null `resultRevision`; `manifestDigestInput(entries)` produces the canonical JSON string (position-sorted, without `resultRevision`) that both this package and the contracts package digest to fingerprint the manifest.
- **`decide.ts`** — `decideIntegrationOutcome(input)` is a pure decision function. Input is `{ kind: "output", output }` (COMPLETED task) or `{ kind: "observed", observedTargetRevision, expectedBaseRevision, attemptRevision, containsAttempt }` (non-COMPLETED task, coordinator read the remote). Output is `{ decision: "completed", resultingRevision }`, `{ decision: "retry_cas" }`, or `{ decision: "escalate", reason }`. Property guarantee: `retry_cas` is never returned when `observedTargetRevision !== expectedBaseRevision`.
- **`index.ts`** — Re-exports from `manifest.ts` and `decide.ts`.

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
