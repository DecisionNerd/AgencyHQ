# Durable execution model

Trigger.dev supplies durability, isolation, limits, retries, cancellation, and
observation (ADR-0005). This document defines what the coordinator adds and how
the two compose. Anything Trigger already does is referenced, not reimplemented.

## Container target and current implementation

[ADR-0008](adrs/0008-compose-first-container-runtime.md) makes the deployed
container profile the default target; implementation is pending. Current
lifecycle mechanics below use host worktrees and local evidence files.
Container task inputs must use project/revision/artifact identities, not host
paths. Each stage materializes its own checkout, and trusted adapters export
Git objects, manifests, and stop evidence durably so the next stage can run on
a different worker. The coordinator validates provenance, versions, digests,
and generation before recording evidence. Coding agents never gain upstream
push authority through artifact transport.

Cancellation must export available checkpoint/stop evidence before normal
teardown. On abrupt loss, record missing unexported work honestly and obtain
trusted termination/isolation evidence before replacement. Host `stop.ndjson`
reads remain a fallback implementation detail; a stopped container's filesystem
is not durable transport. Existing host records must be imported or retained
explicitly, never silently interpreted as container-accessible paths.

## Container-profile execution path (wave 2 — not yet exercised; L2 trial pending)

The following describes the code path added in wave 2 (P17.1–P18.4). None of
this path has run against a live Trigger task container; L2 trial evidence is
pending.

### Dispatch nonce

When the coordinator dispatches a `worker.attempt` intent for a project whose
`source_mode = 'mirror'`, it generates a 32-byte cryptographically random
dispatch nonce (`apps/coordinator/src/internal/nonce.ts`: `generateNonce()`),
stores only its SHA-256 hash (`hashNonce()`) in
`dispatch_intents.dispatch_nonce_hash`, and passes the raw nonce to the task
container in the payload environment (read from `AGENCYHQ_DISPATCH_NONCE` inside
the container). The raw nonce is never persisted.

### Task start — prepareRuntime

At task start, `trigger/src/lib/runtime.ts` `prepareRuntime()` runs:

1. **Profile check.** Reads `AGENCYHQ_RUNTIME_PROFILE`. On `host` profile (the
   current default), `HOME` is the process home and cleanup is a no-op. On
   `container` profile:
2. **Per-run isolated HOME.** `resolveRunHome()` creates
   `<AGENCYHQ_RUN_ROOT>/runs/<runId>/home` at mode `0700`, and
   `<home>/.local/share/opencode/` at `0700` (`trigger/src/lib/runtime-home.ts`).
3. **Provider lease.** The task requests a `provider` lease from
   `POST /internal/leases` (the Broker client, `trigger/src/lib/broker.ts`),
   presenting `{ runId, attemptId, generation, purpose: "provider", nonce }`.
   The coordinator verifies `sha256(nonce) == dispatch_nonce_hash`. On success,
   the grant's `material.authJson` is written to `<home>/.local/share/opencode/auth.json`
   at mode `0600` via `writeFile` + `chmod`. The file is deleted in the cleanup
   step (see below).
4. **Upload lease.** The task also requests an `upload` lease (same nonce) from
   `POST /internal/leases`. The upload token from this grant is used for all
   subsequent artifact, checkpoint, and stop-evidence uploads.
5. **Refusal handling.** If the provider lease is refused, `prepareRuntime`
   returns `{ ok: false, failureKind }` — one of `provider_login_required`,
   `provider_expired`, or `provider_unavailable`. The caller sets Trigger run
   metadata and throws `AbortTaskRunError` (no retry for login-required). No
   secret values appear in the error or metadata.
6. **Cleanup.** On task completion or error, `rm -rf <home>` removes the per-run
   HOME tree, including `auth.json`.

**Host profile fallback.** On `host` profile, `prepareRuntime` returns the
process `HOME` unchanged; no leases are requested, no auth.json is written, and
cleanup is a no-op. The host's OpenCode installation provides credentials.

**Profile selection per project.** The coordinator picks execution mode per
project from `projects.source_mode`: `'host_clone'` (default) uses host
worktrees and local stop.ndjson evidence; `'mirror'` uses the container-profile
path described here. The column was added in migration
`packages/db/migrations/0008_container_runtime.sql`.

### Source materialization

For container-profile tasks, the payload carries a `SourceRef` (`projectId`,
`revision`, `bundlePath`) instead of host-path fields. The task calls
`trigger/src/lib/source.ts` `materializeSource()`:

1. Download the bundle from `GET /internal/source/<projectId>?rev=<sha>`,
   authenticated with the upload or git-read lease token. The coordinator
   verifies the token against the lease table and that the lease covers the
   project.
2. Write the bundle bytes to a temporary file; verify SHA-256 against the
   `X-AgencyHQ-Bundle-Sha256` header.
3. `git clone <bundleFile> <dir>` — creates a local clone.
4. `git checkout --detach <source.revision>` — detached HEAD at the requested SHA.
5. Verify `git rev-parse HEAD == source.revision`; a mismatch is a
   `revision_mismatch` failure (no partial clone left on disk).
6. Delete the temporary bundle file.

### Work and artifact upload

The coding agent (OpenCode) runs with `HOME` pointing to the per-run isolated
directory. On completion, the task exports a thin git bundle of the worker's
commit against the source revision (`trigger/src/lib/artifact-upload.ts`
`exportAttemptBundle()`), then uploads it via `POST /internal/attempts/:id/artifacts`
with the upload lease token and `ArtifactUploadMeta` in the `X-AgencyHQ-Meta`
header. Checkpoint bundles use `POST /internal/attempts/:id/checkpoints`. Stop
evidence is uploaded via `POST /internal/attempts/:id/stop-evidence` with the
structured step list (`trigger/src/lib/evidence.ts`).

### Coordinator admission

When the coordinator receives an artifact upload at
`apps/coordinator/src/internal/artifacts-router.ts`:

1. **Lease lookup.** The upload token (SHA-256 of it, stored as `nonce_hash`) is
   looked up against the `leases` table to find a valid `upload` lease for the
   attempt.
2. **Generation check.** The claimed generation is compared to the attempt's
   current generation; stale (lower) or future (higher) generations are rejected.
3. **Project path verification.** `validateArtifactAdmission()`
   (`packages/domain/src/admission/artifact.ts`) runs all 12 checks in order:
   lease present, not revoked, not expired, purpose = upload, attempt matches,
   generation current, attempt not terminal, bundle size within limit, paths safe,
   commit in mirror, digest matches.
4. **Bundle import.** `importBundle()` writes the bundle into the git bare mirror
   at `AGENCYHQ_GIT_ROOT/<projectId>.git`. The coordinator recomputes the diff
   digest from the mirror and sets `verified = true` when both bundle SHA and diff
   digest match.
5. **Persistence.** `insertAttemptArtifact()` stores the row (idempotent via ON
   CONFLICT DO NOTHING).

**Stop evidence.** `validateStopEvidenceAdmission()`
(`packages/domain/src/admission/evidence.ts`) checks lease validity and
generation. `upsertAttemptStopEvidence()` stores the step list; later submissions
overwrite earlier ones (idempotent by `(attempt_id, generation)`).

### Verification, review, and accept from the mirror

Verify, review, and accept tasks running on the container profile fetch source
and artifacts from the coordinator's mirror via the same `GET /internal/source`
and `GET /internal/attempts/:id/artifacts` routes (authenticated with a
git-read lease). The trusted mirror serves as the durable artifact store across
container lifetimes.

### Integrate with the integrate lease

The `integrate.merge` task requests an `integrate` lease (TTL: 5 minutes,
configurable via `AGENCYHQ_INTEGRATE_LEASE_TTL_MS`) from the coordinator. The
grant's `material.askpassToken` is used as a git credential helper token for
`git push` to the remote. The integrate lease is operation-scoped: it is issued
only for the exact attempt/generation pair and expires after use.

### Host profile stop evidence (current fallback)

On the host profile (`source_mode = 'host_clone'`), stop evidence is still
read from the run directory's `stop.ndjson` file by the coordinator's
`confirmStop` path. The host adapter writes this file before exit.
`dispatch_intents.dispatch_nonce_hash` and the `leases` table are populated
on host-profile dispatches when `source_mode = 'mirror'`; host-profile dispatches
with `source_mode = 'host_clone'` do not use the nonce (the `dispatch_nonce_hash`
field remains null and the lease broker allows null for backward compatibility).

## Lifecycle of one step

1. **Plan.** The coordinator dispatches `lead.plan` for the WorkItem, tagged
   `project:<id>` and `workItem:<id>` so the operator view's realtime
   subscription can track it. The Lead proposal is checked against delegated
   authority; the result is a Decision and a frozen StepContract (or a pending
   human decision). The proposed `profileId` must come from the project's
   verification profile catalog; a proposal naming an unlisted profile becomes
   a `pending_human` decision with `PROFILE_NOT_IN_CATALOG` and is not retried
   automatically. Realtime evaluation of plan runs is Slice 4 trial scope
   (planned).
2. **Admit.** The coordinator confirms rank, budget, and that every bound the
   contract requires is enforceable by the runtime. It records an Attempt with
   a new authority generation and a DispatchIntent, in one transaction.
3. **Dispatch.** It triggers `worker.attempt` with `idempotencyKey` = intent id
   (global scope, TTL covering the retry window), `concurrencyKey` =
   repository id, `machine` and `maxDuration` from the contract, and tags for
   Project, WorkItem, contract version, and attempt. The run id is stored on
   the intent. A lost response is retried with the same key and returns the
   same run.
4. **Execute.** The adapter process creates the attempt worktree at the base
   revision, spawns OpenCode as a child process group with a scrubbed
   environment and the contract's permission rules, publishes progress to run
   metadata, and on exit diffs, path-checks, commits
   `agencyhq/attempts/<attempt-id>` locally, and returns the report as run
   output. (Target container profile: materialize exact source, commit and
   export attempt-scoped Git objects through the trusted adapter; no upstream
   push from the coding worker. Only integration advances shared refs.)
5. **Observe.** The coordinator polls open DispatchIntents and retrieves each
   run by id; tags are used by the operator view's realtime subscription. On a
   final status it stores the report and classifies the outcome (below).
   A worker output with a null commit id (nothing changed) is classified as a
   failure; no Artifact is created. Covered by `flow.parking (a)`
   (`apps/coordinator/test/integration/flow.parking.test.ts`): one `failures`
   row (`class='contract'`, `phase='final'`), `attempt.status='failed'`, no
   artifact, no `verify.run` dispatch.
   A completed run with a valid commit id has its Artifact stored. Status
   updates (completion, quarantine, failure) are guarded by the attempt's
   expected prior status (`WHERE status IN ('admitted','dispatched','running')`);
   a stop that lands between `applyObservation` and the update wins
   (`stale_status`): the observation is skipped, the intent stays open, and
   the reconciler routes the `stopping` attempt to confirmation at its next
   poll — any final run status, COMPLETED included, triggers that route with
   the same evidence order and deadline. Duplicate deliveries are no-ops keyed
   by run id and attempt generation; a delivery for a revoked generation is
   stored as history-only (stale) and does not advance state.
6. **Verify.** `verify.run` is dispatched against the attempt revision with the
   approved profile; results are stored as VerificationResults.
7. **Review.** `lead.review` is dispatched with the diff, criteria, and results;
   the output is a Review record.
8. **Accept.** `lead.accept` proposes acceptance; the coordinator checks the
   proposal names every criterion, cites passing results, and has no blocking
   Review finding, then records the acceptance Decision. If the authority
   schema requires it (`humanRequired` is true), the work item is parked as
   `pending_human` until a matching Approval exists. The `approve` command
   (`POST /api/commands` with `kind: "approve"`, fields `contractId`,
   `contractVersion`, `attemptRevision`) writes an `approvals` row and
   re-runs acceptance via `evaluateAcceptanceForAttempt`; the command is
   idempotent by `commandId`. `APPROVAL_VERSION_MISMATCH` inserts an
   `approval_mismatch` decision; this outcome is **not** resolving, so the
   `pending_human` decision stays open for a corrected approve. A pending
   decision is open when no later decision of a resolving outcome (`approved`,
   `rejected`, `accepted`, `invalidated`) exists that closes it: for
   attempt-scoped decisions (attemptId non-null) the resolving decision must
   share the same attemptId; for plan and review decisions written without an
   attempt (attemptId null) the resolving decision must share the same work
   item, kind, and contract version. `approval_mismatch` is not a resolving
   outcome. The `openPendingDecisions` helper (`apps/coordinator/src/views/pending.ts`)
   is the sole filter for operator-visible pending decisions and for the
   work-item view's action buttons. Covered by `apps/coordinator/test/views.unit.test.ts`
   (attempt-scoped and no-attempt cases). The `approve` command goes through the same
   post-acceptance path as `onAcceptFinal`: for a `merge` boundary it commits
   the approval decision, an `integrations` row, and a `dispatch_intents` row
   in one transaction and then triggers `integrate.merge`; the work item stays
   active until integration completes. Covered by `flow.parking (b)`
   (`apps/coordinator/test/integration/flow.parking.test.ts`) and
   `apps/coordinator/test/integration/approve.test.ts` (cases including
   merge-boundary items v–vii). Invalid structured output from `lead.review`
   or `lead.accept` is recorded as a failure and one retry attempt (`:r1`) is
   dispatched; if the retry also fails with invalid output the work item is
   escalated to `pending_human`. Covered by
   `apps/coordinator/test/integration/flow.lead-failure.test.ts`.
   The work item's requested boundary constrains the Lead: a Lead proposal with
   a boundary narrower than the operator's requested boundary is rejected with
   `BOUNDARY_BELOW_REQUESTED` and the item remains `pending_human`. Covered by
   `apps/coordinator/test/integration/flow.boundary.test.ts`.
9. **Integrate** (`merge` boundary only; `deploy` boundary is not yet
   implemented — `DEPLOY_NOT_SUPPORTED` is returned at dispatch). On acceptance
   the coordinator commits an `integrations` row and a `dispatch_intents` row
   in the same transaction as the acceptance decision, then triggers
   `integrate.merge`. The task: fetches the target ref to read the current
   remote revision; checks ancestry; merges the attempt commit in a temporary
   worktree; pushes with `--force-with-lease` using the expected base as the
   lease. Outcomes: `integrated` (success — `projects.allowed_refs.<ref>` is
   advanced to the resulting revision in the ledger); `already_integrated`
   (idempotent replay); `base_moved` / `conflict` / `push_rejected` (all park
   the work item as `pending_human` with an `integration_conflict:blocking`
   finding). A non-COMPLETED `integrate.merge` run causes the coordinator to
   call `git ls-remote` and run `decideIntegrationOutcome` with the observed
   remote revision; up to `AGENCYHQ_INTEGRATE_RETRIES` retries are attempted
   before escalating to `pending_human`. Push rejection reason is classified
   from stderr: `lease_broken`, `auth`, `network`, or `other`; credentials are
   scrubbed from the evidence. Covered by
   `apps/coordinator/test/integration/flow.integrate.test.ts`,
   `trigger/test/integrate-merge-core.test.ts`, `trigger/test/git.test.ts`, and
   `trigger/test/push-boundary.test.ts`.

   **Revision manifests.** A multi-repository work item carries a
   `RevisionManifest` (table `work_item_projects`) with one entry per
   repository. Entries are ordered by position (0..n-1). Each entry records the
   project id, target ref, expected base revision, and (after integration) the
   resulting revision. The manifest digest is computed from entries excluding
   `resultRevision`; it is stable throughout the work item's lifetime. After
   each entry integrates, the coordinator plans the next entry's `lead.plan`
   (refreshing the base from the ledger's current `projects.allowed_refs` value,
   not from a stale fixture). When all entries have a non-null `resultRevision`
   the manifest is resolved and the work item completes. For combined
   verification, `verify.run` materializes sibling worktrees and injects
   `AGENCYHQ_MANIFEST_<N>` environment variables so checks like
   `manifest-consumer@1` can read peer repositories at their committed
   revisions.

   Every run observation is recorded for the current task, regardless of
   outcome, so the coordinator and operator can reconstruct the full execution
   history (R-010). The `disposition` command (`POST /api/commands` with
   `kind: "disposition"`) resolves an open Finding: `remediate` creates a new
   Attempt under the same contract if budget allows (budget exhausted →
   `pending_human` decision); `scope_decision`, `block`, and `backlog` each
   record a `pending_human` or backlog decision without mutating the contract.
   Covered by `apps/coordinator/test/integration/flow.remediate.test.ts`.

10. **Reject.** The `reject` command (`POST /api/commands` with `kind: "reject"`,
    fields `workItemId`, `decisionId`, `reason`) is state-guarded: it returns
    `{ ok: false, reason: "state_mismatch" }` when the target decision already
    has a resolving outcome (covered by `apps/coordinator/test/integration/control-plane-rework.test.ts`,
    U-1: `reject-after-approve returns state_mismatch`). When the guard passes,
    it appends a new decision with outcome `"rejected"` and the supplied reason
    for the same attempt (the pending row is kept as history — R-017), and sets
    the work item lifecycle to `"halted"` in one transaction. `reason` is stored
    in `decisions.reason` (migration 0005; nullable text). Both `reject` and
    `invalidate_acceptance` require a non-empty trimmed reason; the API returns
    400 `reason_required` for an empty or whitespace-only value (covered by
    `apps/coordinator/test/api-control-plane.test.ts` U-7 tests), and the UI
    keeps the confirm button disabled until a non-empty reason is typed — no
    placeholder is substituted (`apps/web/e2e/reject.spec.ts` iv-c). The command
    is idempotent by `commandId`. A rejected work item is not automatically
    re-planned; a new plan requires an explicit operator command.

11. **Invalidate acceptance.** The `invalidate_acceptance` command (`POST /api/commands`
    with `kind: "invalidate_acceptance"`, fields `workItemId`, `attemptId`,
    `reason`) verifies the attempt belongs to the work item and has a recorded
    accept decision with outcome `approved` (human approval) or `accepted`
    (coordinator acceptance) — both are matched by the query (`outcome IN
    ('approved','accepted')`); a non-human-approved completion writes outcome
    `accepted` (covered by `apps/coordinator/test/integration/control-plane-rework.test.ts`,
    U-3: `invalidate_acceptance succeeds on coordinator-accepted decision`). When
    the accept decision is found, in one transaction: inserts a new decision of
    kind `"invalidate"` referencing the historical accept decision, with the
    supplied reason stored in `decisions.reason` (migration 0005); sets the work
    item lifecycle to `"reopened"`; appends a transition audit row. The historical
    accept decision row is never modified (R-017). The contract row is never
    modified (R-018). A new plan is permitted after reopening. The command is
    idempotent by `commandId`.

12. **Update authority.** The `update_authority` command (`PUT /api/projects/:id/authority`
    or `POST /api/commands` with `kind: "update_authority"`) validates the
    proposed authority with `AuthoritySchema`; the numeric version must be
    strictly greater than the current project version (integer-major comparison
    — the leading integer of each version string is compared). In one
    transaction: acquires a row lock (`SELECT … FOR UPDATE` on the project row)
    to prevent lost updates; applies a CAS update
    (`UPDATE … WHERE authority_version = $current`) — a concurrent update from
    the same base version returns `version_not_increasing` (the row lock
    serializes writes so the second writer always reads the committed new version;
    `stale_version` is a non-locking CAS fallback that is defined in the type but
    not reachable in this code path and is not exercised by the T-9 test);
    backfills the pre-update version into `authority_versions` attributed to actor
    `backfill` at the project's `created_at` timestamp when the table has no
    history for the project (first update; covered by T-13 in
    `apps/coordinator/test/integration/control-plane-rework.test.ts`); appends a row
    to `authority_versions` (idempotent on `(project_id, version)`); inserts a
    decision of kind `"authority_update"` for the audit trail. Frozen
    `step_contracts` rows are never modified — their bounds and digests are fixed
    at freeze time and govern only the attempt for which they were frozen
    (R-018). Future Lead proposals are governed by the new authority.

13. **Campaign and rank commands.** `create_campaign` inserts a campaign and
    returns its id. `assign_campaign` sets `campaign_id` on a work item.
    `set_main_effort` sets `main_effort_work_item_id` on a campaign; the work
    item must already belong to the campaign (`not_a_member` otherwise). `set_rank`
    updates a work item's rank with optimistic CAS on the work item's `version`
    column; returns `{ ok: false, reason: "stale_version" }` on mismatch. All
    are idempotent by `commandId`.

**Campaign-aware dispatch ordering and batch scheduler (Slice 6).** When a work item is admitted, the coordinator records the worker intent as `queued` and `BoundedRepairFlow.onLeadPlanOutput` calls `scheduleQueuedIntents` (`apps/coordinator/src/flow/schedule.ts`) directly. `scheduleQueuedIntents` runs `selectDispatch` (`packages/domain/src/dispatch/select.ts`) and applies every eligibility gate — repository busy, provider capacity, slot limit, uncertain repositories, and main-effort ordering — at admission time. Error semantics: dispatch errors for individual intents are returned as per-intent outcomes; the function never throws for a single intent's dispatch error. If the admitted item's own worker dispatch fails, `onLeadPlanOutput` fires recovery: a failure row and `pending_human` decision are recorded and the worker intent is marked `failed` (not left `queued`) so a subsequent poll cannot re-dispatch it. Failures of other queued items during the pass are logged; those items stay `queued` and are retried on the next poll. The coordinator polling loop also calls `scheduleQueuedIntents` via the reconciler polling wrapper (a thin function with catch) on every pass. `selectDispatch` returns the highest-ranked eligible work items, up to `AGENCYHQ_WORKER_SLOTS`, and a skip reason for every other item. Active attempts — attempts in `stopping` status or with an in-flight `worker.attempt` intent, whose work item is not halted/completed/done — are deducted from the slot count before the pass (`listActiveAttemptsForScheduling`, ecc3cd6). Provider capacity gating applies before the slot gate and is **skipped entirely when the `provider_capacity` table is empty** (unconstrained): a provider with no observation in a non-empty table yields `unknown` → concurrency 1; `limited` → 1; `down` → 0 (always skipped, `provider_down`); `ok` → unconstrained. Observations past their `validUntil` are treated as `unknown` (conservative stale handling). Campaign rank and main effort surface in the overview sort order and in `main_effort_work_item_id`. Skip reasons — `not_admitted`, `blocked`, `uncertain`, `repository_uncertain`, `repository_busy`, `already_active`, `integration_pending`, `provider_down`, `provider_limited`, `provider_unknown`, `no_slot` — are recorded and exposed in the overview via `skipReason`. Admission tests: `scheduling(admission-a)` (provider down → `queued` + `provider_down`); `scheduling(admission-b)` (same project → `repository_busy`); `scheduling(admission-c)` (empty capacity table, free slot → dispatched immediately); `scheduling(admission-d)` (replay → one intent); `scheduling(admission-N1)` (own worker trigger fails → failure row + `pending_human` + worker intent `failed`, next poll does not re-dispatch); `scheduling(admission-N2)` (another item's trigger fails during admission → admitted item unaffected, other item stays `queued` and dispatched on next poll). No live run was performed after 0c5809f (review rework); T2/T4 live passes predate the admission change and were reached with every admission queued (33 seed attempts held the slots). T0 PASS (halted-item scheduler fix; 20:50Z), T1 PASS (concurrency across two projects; 21:22–21:23Z), T2 PASS (20:52:10Z), T3 PASS (ecc3cd6), T4 PASS (21:25–21:30Z) — see [trials/2026-09-slice6.md](trials/2026-09-slice6.md).

Lead and human decisions happen between runs. No run waits on a human; a
waiting self-hosted run holds its process or container and a concurrency slot.

## Idempotency

| Operation | Identity | Mechanism |
| --- | --- | --- |
| Dispatch | DispatchIntent id | Trigger `idempotencyKey`, global scope. Keys clear on run failure, so a retried failed run needs a new intent, which needs a Decision. |
| Run observation | Trigger run id + attempt generation | Coordinator upsert; stale generation stored as history only. |
| Attempt commit | `agencyhq/attempts/<attempt-id>` | Adapter commits to the attempt's own branch; a retried adapter step finds the branch and re-reads it. |
| Token issuance (container profile) | Attempt id + generation + purpose | Coordinator rejects stale generation; tokens expire in minutes. |
| Integration | Attempt id + target ref + expected base revision | Compare-and-set on the target ref; a replay finds the ref already advanced and records completion. |
| Operator command | Command id from the UI | Coordinator idempotency table. |

## Failure taxonomy

| Class | Trigger observation | Coordinator response |
| --- | --- | --- |
| Execution failure | Run `crashed`, `timed_out`, `system_failure`, `expired`, OOM, or `canceled` by policy; provider outage reported by the adapter. | Trigger's retry policy handles transient attempts within the task's `maxAttempts`; once the run is final, the coordinator may create a new Attempt within the step budget. When a new Attempt is admitted, a Failure record for the superseded attempt is committed to Postgres in the same transaction before the new attempt row is inserted. No Decision needed unless budget is exhausted. |
| Contract failure | Run `completed` with unmet criteria, failed VerificationResult, path violation, or `failed` via `AbortTaskRunError`. | Lead disposition: bounded remediation under the same contract or a replacement contract. Never automatic retry. |
| Process failure | Coordinator cannot compute a valid next state: contradictory authority, missing gate, impossible dependency. | Halt the WorkItem; repair the authority schema or process code; human decision. |

Failures are domain records with class, phase, attempt, run id, cause, and
evidence. Trigger status is the observation that supports the class.

## Stop, cancel, and replacement

Because workers cannot cause external effects (ADR-0007), replacement is short:

1. **Revoke.** Advance the attempt's authority generation in Postgres. From
   this instant observations for the old generation are history-only.
2. **Cancel.** Call `runs.cancel`. If the run is already in a final state
   and the cancel call throws, the attempt's generation is already revoked; the
   stop command completes with `cancelSkipped: true` and the attempt proceeds
   normally through stop confirmation. The adapter's `onCancel` gets a bounded
   grace period: it commits the worktree to `agencyhq/checkpoints/<attempt-id>`,
   sends SIGTERM then SIGKILL to the OpenCode process group, and records
   whether any process survived. `runs.cancel` also cancels child runs.
3. **Confirm.** The reconciler always routes CANCELED/TIMED_OUT worker
   observations to stop confirmation; no such observation is skipped. If the
   attempt is `dispatched` or `running` at that point (externally cancelled or
   hard-timed-out by Trigger), the coordinator first calls `stopAttempt` with
   actor `"coordinator"` to transition it to `stopping`, then calls
   `confirmStop`. Evidence is read in priority order: (1) run metadata
   (`survivors`, `checkpointCommit`) from the observation, (2) the run
   directory's `stop.ndjson` file — `readStopEvidence` parses the adapter's
   `step` and `checkpointCommit` NDJSON fields (with legacy `event`/`commit`
   keys accepted for compatibility) — when metadata has no `survivors` field,
   (3) pending — no evidence yet. The checkpoint commit is recorded on the
   attempt row. On the host profile, the Trigger API reports a final status
   before adapter cleanup completes (observed 22–38 ms after `runs.cancel` in
   the Slice 1 trial); `stop.ndjson` is the fallback evidence source for that
   gap. `AGENCYHQ_UNCERTAIN_AFTER_MS` (default 120 000 ms) applies on the
   reconciler's confirmation route; if the deadline passes with no evidence,
   the attempt becomes `uncertain` and the work item condition `uncertain`;
   no replacement runs on that repository while uncertain. The adapter also applies a soft deadline (`maxDuration` minus 15 s,
   minimum 5 s) to stop the worker before the CLI delivers SIGTERM on
   `maxDuration`, returning outcome `timed_out` with the run COMPLETED; the
   hard `maxDuration` remains the backstop. See the
   [Slice 1 execution trial](../engineering/trials/2026-09-slice1.md). The UI
   shows *stopping* until confirmation and *stopped* after. The cancelled
   observation is recorded as history-only (stale) so it does not advance state
   on a later delivery. Stop command replay returns `replayed: true`.
4. **Operator-stop: no replacement.** On an operator-initiated stop the
   coordinator records the final status and checkpoint revision but does not
   admit a new Attempt. The work item stays at its pre-stop lifecycle state
   (no auto-replacement). A new Attempt requires an explicit operator or Lead
   decision. For *automatic* retry on execution failure (not an operator stop),
   the coordinator may admit a new Attempt under the remaining step budget,
   starting from the base revision or a Lead-selected checkpoint. The old
   worktree is retained for inspection, never reused.

Integration tasks are the one place an effect can be in flight. They are
serialized per repository and compare-and-set on the target ref; an unknown
outcome is resolved by reading the ref, never by retrying blindly.

## Contact loss

For the container target, contact loss with a Trigger worker has the same
uncertain-state semantics. Reconcile using trusted runtime identity/status and
durable artifacts, never coordinator-local PID/file checks for a remote run.
No fresh attempt can reuse the old container or grant authority to an unfenced
execution. The following describes the current host fallback.

If the coordinator cannot reach the Trigger API, or Trigger cannot reach the
`trigger dev` process on the host, observations are marked stale, dispatch
stops, and no decisions are made. `maxDuration` still bounds running work, so
the worst case is a bounded run finishing without an observer; its output is
retrieved when contact returns. Lost contact is displayed as *uncertain*,
never *stopped* or *idle*. If the host process dies, Trigger reports the run
as crashed or system failure and the worktree remains on disk for inspection.

## Pause

Pause stops new dispatch. Running attempts continue to their bounded end. The
UI names which run may still finish and links to it. Pause does not cancel.

## Budgets

A StepContract's budget is: attempts, `maxDuration` per attempt, and an
estimated-spend ceiling (machine preset on the container profile). Trigger
enforces attempts and duration per run. Spend is an estimate from token usage reported by OpenCode; it is never
represented as a hard limit until a model gateway exists.

## Basis

Fencing by generation follows [Kleppmann's analysis of distributed locks](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html);
idempotent operation identities follow [Amazon's guidance on idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).
Trigger behaviors cited here come from its documentation as read on 2026-09-07
and must be re-verified when the pinned version changes. The
[execution trial](TESTING.md#required-execution-trial) is the proof.
