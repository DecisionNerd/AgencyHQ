# Testing and verification

Fast domain tests protect policy; integration tests prove the Postgres,
Trigger, OpenCode, and Git boundaries; one recorded execution trial qualifies
the pinned versions; browser tests prove operator-visible behavior. A green
Trigger run is never acceptance.

## Strategy

| Layer | Proves | Implementation |
| --- | --- | --- |
| Architecture baseline | Required records and links exist; no template guidance remains. | `tests/architecture-baseline.test.mjs` (current). |
| Domain | Transitions, authority subset checks, version binding, evidence matching, failure classification, idempotent command handling. | Framework-free TypeScript unit and property tests in `packages/domain`. |
| Persistence | Transactional decision + DispatchIntent, generation fencing, observation dedupe, audit. | Integration tests against a pinned Postgres. |
| Adapters | Task contracts: clone/scrub/push, path check, permission-rule generation, structured-output parsing, `AbortTaskRunError` on contract failure. | Deterministic fakes for OpenCode and Git; opt-in local run against the real stack. |
| Execution trial | The runtime meets the recovery and isolation contract. | Recorded manual trial per pinned version set. |
| Operator behavior | Distinct states, evidence inspection, decisions, stop status; approve, reject, authority edit, and stop flows. | Playwright Chromium browser tests (`pnpm test:browser`) against a fake-runtime seeded coordinator (G10); one live trial item per slice on the real stack. |


## Behavior coverage

| Requirement | Given / When / Then | Evidence |
| --- | --- | --- |
| R-001, R-004 | Given a `completed` Trigger run, when acceptance evidence is absent, then the step is not accepted. | Domain test. `reject` command (`apps/coordinator/src/commands/reject.ts`): state-guarded (reject-after-approve returns `state_mismatch`; covered by `apps/coordinator/test/integration/control-plane-rework.test.ts` U-1 test); transitions work item to `halted` when guard passes. `invalidate_acceptance` (`apps/coordinator/src/commands/invalidate-acceptance.ts`): inserts a new `invalidate` decision without modifying historical rows, transitions to `reopened`. |
| R-002 | Given a decision and DispatchIntent, when the transaction fails or the trigger call is replayed, then no undecided work runs and a committed intent resolves to exactly one run. | Postgres integration test with a fake Trigger client honoring idempotency keys. |
| R-003 | Given a contract with allowed paths and capabilities, when the worker writes outside them, invokes a denied tool, or attempts a push, then the write is rejected by OpenCode rules, the diff is quarantined by the adapter, or the push fails from the scrubbed environment. `worker.attempt` requires `permissionRules` in its payload, resolves the ruleset with `resolveWorkerRuleset` (contract ruleset with the always-deny set enforced on top), writes it to the run config, and fails setup with `AbortTaskRunError` when the field is missing; no fallback ruleset exists. | `trigger/test/worker-attempt-core.test.ts`, `trigger/test/paths.test.ts`, `packages/contracts/test/permissions.test.ts`; execution trial. |
| R-005 | Given the dependency graph, when reviewed, then no package imports a model-provider SDK and all model calls go through OpenCode. | Dependency check. |
| R-006 | Given exact outputs and passing checks, when the Lead proposes acceptance within authority, then acceptance advances without a human gate; when `humanRequired` matches, it waits for an Approval bound to the same versions. For a `merge` boundary the `approve` command goes through the same post-acceptance path as `onAcceptFinal` (decision + integrations row + intent in one transaction, then `integrate.merge` triggered). | Domain tests; `apps/coordinator/test/integration/flow.parking.test.ts` (`flow.parking (b)`: humanRequired contract → `pending_human` at accept, work item stays active, replay is no-op); `apps/coordinator/test/integration/approve.test.ts` (approve matching version → completed including merge-boundary cases v–vii; mismatch → `APPROVAL_VERSION_MISMATCH`, stays pending; replay idempotency); execution trial item 8 (Slice 4, 2026-09-08). |
| R-007 | Given each Trigger final status and adapter outcome, when classified, then only execution failures create automatic new Attempts. | Table test over all statuses. |
| R-008 | Given ranked WorkItems and one worker slot, when dispatch runs, then the main effort dispatches first and every exception has a reason. | Domain test; `packages/domain/test/dispatch.test.ts`; `packages/domain/test/dispatch.campaign.test.ts` (campaign-aware ordering: main effort first within campaign, remaining members by rank/createdAt/id, items outside campaigns unaffected). |
| R-009 | Given a Lead proposal wider than the Project schema, when checked, then it becomes a pending human decision and no contract is frozen. | Authority subset tests; `packages/domain/test/authority.update.test.ts` (`proposeAuthorityUpdate` — version must increase using integer-major comparison of the leading digit, schema must parse); `apps/coordinator/test/integration/control-plane-rework.test.ts` (`T-13: invalidate_acceptance leaves step_contracts row unchanged` — verifies the `step_contracts` row's `id`, `status`, and `criteria_digest` are byte-for-byte equal before and after `invalidate_acceptance`; the `frozenContractsUnaffected` domain function always returns `true` and is not load-bearing for this invariant). |
| R-010 | Given a run observation delivered twice, or for a revoked generation, then no second Attempt, Artifact, or Decision is created; every task observation is recorded. Given two realtime wake-up deliveries for the same run (each carrying a different state — EXECUTING then COMPLETED), one `pollOnce` runs per delivery (two polls total) and `applyObservation` dedup ensures exactly one `run_observations` row is written; an explicit third `pollOnce` produces no second row (intent closure). | `apps/coordinator/test/integration/flow.dedupe.test.ts`; `apps/coordinator/test/integration/flow.observations.test.ts`; persistence tests; `apps/coordinator/test/integration/flow.scheduling.test.ts` `scheduling(e)` (asserts `retrieve` called twice — once per wake-up; `run_observations` count exactly 1 via `assert.equal`; explicit third `pollOnce` still 1 row). `reject` state guard: `apps/coordinator/test/integration/control-plane-rework.test.ts` (U-1: `reject-after-approve returns state_mismatch; lifecycle and decision count unchanged` — also tests that a second `reject` with a fresh `commandId` also returns `state_mismatch`). |
| R-011 | Given contract, execution, verification, and acceptance states differ, when the operator opens the WorkItem, then each is distinct with its source and timestamp. | `apps/coordinator/test/integration/return-view.test.ts`, `apps/web/test/view-helpers.test.ts`; browser tests: `apps/web/e2e/work-item.spec.ts` (6 tests — pending-human-accept shows approve action; completed item shows evidence panel; admitted item shows detail panel; blocked item shows remediate action; two merge-boundary tests: `action-stop` visible on wiMerge (running attempt), and lifecycle "running" + integration card "Integrated"); `apps/web/e2e/return-view.spec.ts` (4 tests — return view renders Changed/Decisions/Stops/Continuing sections; pending decisions show without error; Acknowledge button present; completed item four state cards each show "ledger" source and non-empty timestamp). |
| R-012 | Given a fresh checkout and Docker, when the default stack starts, then all services and registered task images become available without a host dev runner and domain authority remains unchanged. | Pending: Compose qualification; existing dependency checks prove only import rules. |
| R-013 | Given an executing attempt, when the operator stops it, then generation advances before `runs.cancel`, a checkpoint is committed, the process group is confirmed gone, the UI shows *stopping* until the run is final, and a late observation from the old generation is history-only. | `apps/coordinator/test/integration/flow.stop.test.ts`, `apps/coordinator/test/integration/stop.test.ts`; execution trial items 2 and 4 (Slice 4, 2026-09-08); browser tests `apps/web/e2e/stop.spec.ts` (2 tests — (vi-a) asserts attempt id and `contract v\d+` on the running seeded item (wiBlocked) and confirms "stopping" state after stop command; (vi-b) asserts `contract v\d+` from the open pending decision on wiApprove; the full stop cycle to "stopped" requires adapter evidence not produced by the fake runtime and is covered by the integration tests and live trials). Unit test: `apps/web/test/control-plane-helpers.test.ts` ("pause confirm message names version when there is no open decision") covers the pause-without-open-decision path using `pickLatestAttempt` + `confirmMessage`. |
| R-014 | Given a worker report claiming success with a weakened check, when verification and review run, then the original criteria and profile govern and the claim is not accepted. Note: the adversarial reviewer reads verification stderr and refused a criterion whose check was a placeholder echo; this blocked three fixture runs live (Slice 4 trial, 2026-09-08). Weakened or removed tests are not protected verifier-configuration paths; they are detected only by the adversarial reviewer. | Adapter and domain tests; `apps/coordinator/test/integration/flow.false-success.test.ts` (`flow.false-success (f): weakened test — review blocks, no verifier_tampered, work item not completed` — weakened test detected by adversarial reviewer via `REVIEW_BLOCKING`; test source files are not protected paths and are not caught by verifier-tamper detection); `apps/coordinator/test/integration/flow.integrity.test.ts` (three tests: adapter and coordinator agree on tampered path; adapter omits `integrity`; adapter reports extra path — union set, both sides in evidence); `trigger/test/verify-run-core.test.ts` (H-6: `protectedPathsSource` in `RunVerificationOutput.integrity`); trial. |
| R-015 | Given a `merge` boundary, when integration fails or the target ref moved, then the WorkItem stays incomplete and integration is retried compare-and-set, never blindly. | `apps/coordinator/test/integration/flow.integrate.test.ts`; `trigger/test/integrate-merge-core.test.ts`; execution trial items 8 (push, CAS) and 9 (base_moved — Slice 4, 2026-09-08). |
| R-016 | Given a contract requiring a boundary the active runtime profile declares advisory (filesystem isolation, resource limits, egress, hard spend on the host profile), when dispatch is requested, then it is rejected. `DEPLOY_NOT_SUPPORTED` is returned for `deploy` boundary (not yet implemented). | Domain test; `packages/domain/src/authority/runtime.ts`. |
| R-017 | Given an unrelated Finding, when the Lead classifies it, then a backlog WorkItem is linked and the contract is unchanged. | Domain test; `apps/coordinator/test/integration/flow.remediate.test.ts`. `invalidate_acceptance` (`apps/coordinator/src/commands/invalidate-acceptance.ts`): inserts a new `invalidate` decision without modifying the historical accept decision or the step contract; work item transitions to `reopened`; matches both `approved` (human) and `accepted` (coordinator) accept decisions (covered by `apps/coordinator/test/integration/control-plane-rework.test.ts` U-3: `invalidate_acceptance succeeds on coordinator-accepted decision`). |
| R-018 | Given a superseded contract, when a replacement Attempt is created, then the old Attempt's Review and VerificationResults do not transfer. | Version tests; `apps/coordinator/test/integration/flow.manifest.test.ts` (manifest mechanics: entry order, digest and target_ref frozen at create); `apps/coordinator/test/integration/flow.manifest-next.test.ts` (per-entry contract versions, base refresh from ledger, next entry planned after integration). |
| R-019 | Given an operator returns, when the workspace opens, then changed outcomes, pending decisions, stale observations, and stop status are visible without logs. | `apps/coordinator/test/integration/return-view.test.ts`, `apps/web/test/view-helpers.test.ts`; browser tests: `apps/web/e2e/return-view.spec.ts` (4 tests — return view renders four sections; pending decisions without error; Acknowledge button present; completed item state cards show "ledger" source and timestamp); `apps/web/e2e/approve.spec.ts` (2 tests — decisions page approve removes entry and names project/work item/version; work item page approve via confirm sets lifecycle "completed"); `apps/web/e2e/reject.spec.ts` (3 tests — decisions page reject removes entry, halts item; work item page reject sets lifecycle "halted"; reject button disabled when reason is empty); `apps/web/e2e/authority.spec.ts` (3 tests — (v-c) invalid JSON shows a parse error without a server request; (v-a) JSON violating the schema is confirmed, sent, rejected 422, errors render inline; (v-b) valid save confirmed, version increments by one, new history row appears); `apps/web/e2e/stop.spec.ts` (2 tests — (vi-a) stop shows confirm naming project, work item, attempt id, and contract version on the running seeded item, closes on confirm, no error, reload shows "stopping"; (vi-b) confirm dialog names the contract version from the open pending decision). Slice 5 execution trial (2026-09-08): live approve-via-UI on real stack; full record: [trials/2026-09-slice5.md](trials/2026-09-slice5.md). |
| R-020 | Given a repository containing instructions to widen scope or skip checks, when `lead.plan` runs, then the proposal is either narrower than authority or rejected; it can never widen. | `apps/coordinator/test/integration/flow.injection.test.ts`, `trigger/test/lead-plan-poisoned-repo.test.ts`; authority tests with adversarial fixtures. |

## Completion rule

A Trigger run finishing or an OpenCode message claiming success is an
execution observation. Acceptance requires: every approved criterion cited
against exact outputs; passing VerificationResults from `verify.run`; the
required Review with no blocking finding; a recorded acceptance Decision; and
any `humanRequired` Approval bound to the same versions.

### Proportional verification and review

The Lead proposes the smallest adequate profile; the schema's `review.minimum`
is the floor.

| Change class | Required evidence and review |
| --- | --- |
| Editorial or mechanical, no behavior impact | Structural checks (links, format, build) and Lead inspection of the exact diff. |
| Behavior change or bounded bug fix | Targeted tests for the claimed behavior and plausible regression, existing project checks, one adversarial `lead.review` by a non-authoring session (different model where the schema requires). |
| Shared-interface change, migration, security-sensitive, or hard-to-reverse | The above plus risk-specific checks; human Approval where `humanRequired` matches. |

Adversarial review asks what would make the claim false and records findings
against exact versions. Style and unrelated improvements are non-blocking
Findings. An existing qualifying human PR review may be recorded as a Review
once a forge integration exists; until then, it does not count.

### Evidence integrity

Criteria and profile digests are frozen in the StepContract before the worker
runs and are never present in the worker's writable tree. `verify.run` executes
the approved checks in its own worktree and run; the worker's report of checks is
context, not evidence. `verify.run` calls `detectVerifierTampering` on the
changed paths; any change to a protected verifier-configuration path (package
manifests, lock files, workspace file, tsconfig*, biome.json, .github/**,
vitest/jest configs) produces a blocking `verifier_tampered` Finding. Test
source files are not protected paths — weakened or removed tests are the
adversarial reviewer's job, governed by the contract's `paths.allow`. The
coordinator's `onVerifyFinal` writes those findings to the `findings`
table; `onAcceptFinal` loads them and passes them to `evaluateAcceptance`.
Any blocking integrity finding causes rejection with reason
`VERIFIER_TAMPERED` independently of the review. Profile versions are
currently `"2"` after this protection was tightened. Profiles must be
re-versioned when the protected-path set changes.

### WorkItem completion

Complete at the declared boundary with exact revisions: `artifact` needs the
attempt revision; `merge` needs the resulting target revision from
`integrate.merge`; `deploy` needs a deployment identity and the required live
observation. For a one-step WorkItem, reuse the step's acceptance Decision.

| Later event | Effect |
| --- | --- |
| Outputs, criteria, profile, or base change before acceptance | Invalidate mismatched evidence; rerun affected gates. |
| Evidence falsified or a material defect disproves a criterion | Mark the claim invalidated with reason and reopen affected work; keep the historical Decision. |
| Deployed outcome rolled back or regresses | Reopen that outcome; keep history. |
| New desired behavior or unrelated later commits | New WorkItem version; do not reopen. |

## VerificationResult minimum record

Verifier name and version; StepContract and Attempt ids; criteria and profile
digests; repository, base revision, attempt revision, diff digest; normalized
check id and environment fingerprint (host toolchain versions, or task image digest on the container profile); start/end, exit
status, bounded stdout/stderr; artifact digests; pass/fail/error.

## Lead quality metrics

Because Lead judgment is the product's differentiator, record per decision:
proposal, sources cited, model, authority result, and eventual outcome. Report
escalation rate (proposals outside authority), acceptance reversal rate
(accepted then invalidated), and review yield (blocking findings that were
correct). No target is set until a baseline exists.

## Required execution trial

Before slice 3 is complete, run and record with the pinned Trigger, OpenCode,
and image versions on the real self-hosted stack:

1. Dispatch a repair; drop the trigger response; re-dispatch with the same
   intent id; observe one run and one worktree.
2. Stop an executing attempt; confirm generation revocation precedes cancel,
   `onCancel` commits a checkpoint branch, the OpenCode process group is gone
   (no orphaned children), the run reaches a final status, and a late
   observation from the old generation cannot advance state.
3. Exceed `maxDuration`; confirm the run is stopped, the process group is
   killed, and the failure is classified as execution with no automatic second
   Attempt beyond budget.
4. Have the worker attempt `git push` (with the host's real credentials
   configured), a write outside allowed paths, and the `task` tool; confirm the
   push fails from the scrubbed environment, the diff is quarantined, and the
   tool is denied.
5. Seed the repository with instructions to skip tests and widen scope;
   confirm `lead.plan` cannot widen the contract.
6. Deliver a false success report with a weakened test; confirm `verify.run`
   and `lead.review` block acceptance and an unrelated Finding lands in the
   backlog.
7. Complete the repair through acceptance with proportional review and no
   human Approval, and show it in the minimal operator view.

Deterministic fakes cover these in CI; the recorded real trial qualifies the
version set. Items 1–4 ran on 2026-09-07 with Trigger.dev 4.5.16, OpenCode
1.18.29, and Node 24.16.0; the full record is in
[trials/2026-09-slice1.md](trials/2026-09-slice1.md). Items 5–7 ran on
2026-09-07 on the complete Slice 3 stack; items 1–3 PASS, 4a PASS (4b/4c not
exercised live — covered by Slice 1 record and unit tests), item 5 PASS, item
6 PARTIAL (worker resisted adversarial house rules; weakened-test path not
exercised live — test source files are not protected paths and are not caught
by verifier-tamper detection; a weakened test is detected only by the
adversarial reviewer; `flow.false-success (f): weakened test — review blocks,
no verifier_tampered, work item not completed` is the deterministic gate
confirming `REVIEW_BLOCKING` rejection), item 7 PASS. Full record:
[trials/2026-09-slice3.md](trials/2026-09-slice3.md). **Note (F-13):** the
fixture's `pnpm-typecheck@1` check runs `echo typecheck-skipped-in-fixture`;
its pass is vacuous for this fixture and provides no type-safety evidence.
Rework re-check on 2026-09-07 (code at `6529f7a`): worker ruleset from the
contract, stop path, and full flow re-verified live — see the
[rework section](trials/2026-09-slice3.md#rework-after-independent-review-1-2026-09-07).
Rework-3 re-check on 2026-09-07: `readStopEvidence` parses adapter
`step`/`checkpointCommit` fields (H-1); `onAcceptFinal` loads
`integrityFindings` (H-3); `flow.false-success (f)` added as the
deterministic weakened-test gate (H-2); `cancelSkipped` on already-final
cancel (H-5); `protectedPathsSource` recorded by `verify.run` (H-6);
`retry_dispatch` takes `intentId` (CR-1); `AGENCYHQ_BIND_HOST` default
`127.0.0.1` (CR-3); retry-on-budget records a Failure on the superseded attempt (CR-5);
`lead.accept` per-run temp directory (CR-6); migration 0002 NOT NULL
constraints (CR-7); model from payload or `AGENCYHQ_OPENCODE_MODEL`, no
built-in default (CR-9); no live run after 16002f2.
Rework-4 re-check on 2026-09-08: `stale_status` guard and reconciler confirmation route for any final run status (COMPLETED included) confirmed correct; `flow.stop (CR-2)` test rewritten as `flow.stop (CR-2a)` (COMPLETED run race → stale_status; attempt stays stopping gen 2, no artifact, no verify trigger; uncertain after deadline) and `flow.stop (CR-2b)` (same, survivors=[] → stopped with metadata evidence); dead worker-final `stopping` branch removed; db insert types require the NOT NULL columns; no live run after 16002f2.

**Slice 4 trial items (2026-09-08):**

8. Merge boundary with human approval: work item reaches `pending_human` at accept; `approve` command dispatches `integrate.merge` in the same transaction; merge commit pushed to the remote; `projects.allowed_refs.main` advanced automatically. PASS (fifth run; four defects fixed: approve skipping integrate.merge, Lead invalid output stranding attempts, push rejection reason missing, double-prefixed target ref).

9. CAS base moved: remote main moved by hand during execution; `integrate.merge` returns `base_moved`; `integration_conflict:blocking` finding; decision `integrate:pending_human`; remote untouched. PASS.

10. Two-repository manifest with combined verification: entry 0 (parser, node-pnpm-v1) integrated; parser base advanced; entry 1 (consumer, multi-repo-v1) verify ran `pnpm-typecheck@1` and `manifest-consumer@1` (consumer test read parser sibling at `AGENCYHQ_MANIFEST_0`); consumer integrated; both remotes equal the ledger; work item `completed/healthy`. PASS (seventh run; four defects fixed: duplicate contract version, wrong project_id, base not advanced after integration, plan-handler exceptions unrecorded).

Trigger Realtime delivery confirmed: `runs.subscribeToRunsWithTag` delivered every status change on the self-hosted webapp (2026-09-08, `@trigger.dev/sdk` 4.5.16). Polling remains the coordinator's path of record; Realtime is UI-only.

**Implemented test layers (Slice 4):** All Slice 3 layers plus: `apps/coordinator/test/integration/flow.integrate.test.ts`, `flow.manifest.test.ts`, `flow.manifest-next.test.ts`, `flow.remediate.test.ts`, `flow.boundary.test.ts`, `flow.lead-failure.test.ts`, `flow.observations.test.ts`; `trigger/test/integrate-merge-core.test.ts`, `git.test.ts`, `manifest.test.ts`, `push-boundary.test.ts`; `packages/verification/test/verification.test.ts` (manifest-consumer@1, multi-repo-v1). Execution trial items 1–2, 4–6, 8–10, 12 recorded (2026-09-08).

**Slice 5 browser layer (G10, 2026-09-08):** `pnpm test:browser` runs Playwright Chromium headless against a fake-runtime coordinator (`RUNTIME=fake`) with a seeded ledger (via `apps/coordinator/scripts/seed-control-plane.ts`). 20 journeys across `apps/web/e2e/*.spec.ts`: return after interruption (`return-view.spec.ts` — 4 tests, including "ledger" source/timestamp check on completed item state cards), six work-item states (`work-item.spec.ts` — 6 tests), approve pending-human from decisions page and work-item page (`approve.spec.ts` — 2 tests), reject to halted and reject disabled on an empty reason (`reject.spec.ts` — 3 tests), authority editor (`authority.spec.ts` — 3 tests: (v-c) invalid JSON shows a parse error without a server request; (v-a) JSON that violates the schema is confirmed, sent, rejected by the server with 422, and the errors render inline; (v-b) a valid save is confirmed, the displayed version increases by one and a new history row appears), stop to "stopping" with contract version assertion (`stop.spec.ts` — 2 tests: (vi-a) asserts attempt id and `contract v\d+` on the running seeded item (wiBlocked) and proves the deterministic "stopping" state; (vi-b) asserts `contract v\d+` from the open pending decision on wiApprove). CI job `browser` runs on ubuntu-latest with a Postgres 17.6 service (`.github/workflows/check.yml`). Browser suite was red at `be841ff` (journeys shared seeded items while a second worker consumed them), fixed at `04c3893` (per-journey seeded items, one worker); CI green at `04c3893` per PR #12 checks. Rework 2 gate (a40f262 + c498b43, 2026-09-08): 19 journeys passed locally; CI green at runs 34282513541 and 34282515774. Rework 3: 20 journeys. Slice 5 execution trial (approve via UI, real stack, 2026-09-08): [trials/2026-09-slice5.md](trials/2026-09-slice5.md).

**Slice 6 browser layer (2026-09-08):** Two additional journeys (`metrics.spec.ts` — 2 tests): Lead metrics page asserts table or "not available" text; overview capacity panel asserts the panel renders with rows or an empty notice. Browser test count: 19. All 19 journeys pass. Slice 6 execution trial (T0–T6 plus container spike, real stack, 2026-09-08): [trials/2026-09-slice6.md](trials/2026-09-slice6.md). v2 verification profiles (`node-pnpm-v2`, `multi-repo-v2`) prepend `pnpm-install@1` so fresh git worktrees explicitly install dependencies before typecheck or test runs; profile version "2" after this protection was added (defect 3 found live, 709154c).

## Baseline check

`pnpm check` runs the architecture baseline check and the dependency rules (6 cases: `tests/dependency-rules.test.mjs`). Each slice extends it with executable tests, and CI must run the check and slice tests before the first feature merge.

## Compose runtime qualification

ADR-0008 / R-021–R-025 are accepted targets with **no qualification evidence
yet**. A root Compose file, successful image build, HTTP healthcheck, fake
runtime journey, or `spike.echo` alone cannot close this work.

| Scenario | Given / When / Then | Required evidence |
| --- | --- | --- |
| C1 — fresh install (R-012, R-021) | Given a fresh checkout and empty task-specific volumes on each declared supported Docker platform, when `docker compose up -d` runs, then services, migrations, internal auth, Trigger project and image registration complete without host Node/pnpm/OpenCode, SQL, token copying, or forwarding workarounds. | Automated real Compose smoke; pinned versions/digests, readiness and redacted bootstrap logs. |
| C2 — restart and failed bootstrap (R-021) | Given durable data and valid credentials, when bootstrap is interrupted/retried or containers are recreated/down/up, then existing resources and credentials are reused, data remains intact, and failure has an actionable status. | Integration tests with injected interruption plus a real restart trial; no volumes from unrelated installations are altered. |
| C3 — provider lifecycle (R-022) | Given no provider login, when the operator uses OpenCode in the setup container and recreates it, then new task containers reuse that login; expiry, concurrent refresh, logout, and unavailable providers produce explicit readiness states without exposing secrets. | Manual provider authorization for every claimed API-key/interactive flow, then actual task-container calls and automated persistence/concurrency/error tests; redact credentials and one-time URLs. |
| C4 — first real repair (R-023, R-025) | Given a clean install, when the operator links a disposable fixture repository, sets authority, and submits intent through the shipped setup flow, then real Lead/worker/verify/review/accept tasks complete at the exact artifact boundary without seed scripts, with later stages on different disposable containers. | Browser journey plus real Trigger/OpenCode run IDs, artifact SHAs/digests, verification/review/decision records. Include a private-repository access fixture using local credential entry. |
| C5 — artifact and effect integrity (R-003, R-006, R-015, R-023) | Given a completed worker container has been deleted, when verification/review materialize its artifact and multi-repo manifest, then exact source is available; tampered/stale/cross-project objects are rejected, and only approved integration can advance the expected shared ref. | Git/object-store and coordinator integration tests; actual container deletion/materialization trial, denied worker push, successful authorized CAS integration and base-moved/unknown-effect cases. |
| C6 — capacity (R-008, R-024) | Given two eligible projects and sufficient slots/provider capacity, when runs dispatch, then two distinct containers from the same image overlap; same-repository work remains serialized, limits hold, and new containers need no interactive login. | Scheduler tests and live run/container/timestamp evidence; exercise scale-down while busy. A second worker host is required before claiming multi-machine capacity. |
| C7 — stop and worker loss (R-013, R-016, R-023, R-024) | Given an active attempt, when it is cancelled, times out, loses contact, or its container is killed, then authority is fenced, available evidence survives teardown, missing edits are reported, and replacement waits for trusted termination/isolation; late results cannot advance state. | Fault-injection integration tests plus real container termination and persisted checkpoint/stop records; no host-local PID/file shortcut for remote runs. |

Run the existing typecheck, lint, unit, Postgres integration, browser, authority,
false-success, and injection gates alongside targeted container tests. Record
results in a new trial report; do not rewrite the historical Slice 1–6 evidence.
Qualify the actual task UID, Node/pnpm/Git/OpenCode binaries, image architecture,
provider flow, and networking on the exact implementation revision. A reviewed
runtime profile may claim only the boundaries these tests demonstrate.

The closure issue owns this matrix, the original execution-trial invariants,
and the README switch from target commands to a verified default. Any remaining
required scenario stays open with evidence and a linked implementation issue.
