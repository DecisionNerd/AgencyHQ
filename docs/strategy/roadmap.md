# Incremental roadmap

Each slice leaves the repository runnable, tested, and more capable. The
riskiest assumption — that self-hosted Trigger.dev plus OpenCode can meet the
isolation and recovery contract — is tested first, before domain code depends
on it.

## Slice 0 — architecture baseline

- Authority boundaries, runtime choice, Lead role, worker effect model, and
  delegated-authority schema are recorded (ADR-0001 to ADR-0007).
- A deterministic check protects the records and links.

## Slice 1 — execution spike (throwaway)

- Stand up the self-hosted Trigger webapp stack with pinned versions; run
  `trigger dev` on the OpenCode host with the existing OpenCode config.
- Implement `worker.attempt` minimally: `git worktree add`, scrubbed child
  environment, `opencode run --format json` with a permission-rule file,
  diff, commit an attempt branch; `onCancel` checkpoint commit and
  process-group kill. No domain model, no UI.
- Run trial items 1–4 of the [execution trial](../engineering/TESTING.md#required-execution-trial):
  idempotent re-dispatch, stop with checkpoint and confirmed process death,
  `maxDuration`, and denied push/paths/`task`. Confirm dev-mode cancel and
  `maxDuration` behave as documented.
- Record results. If the contract cannot be met, supersede ADR-0005 with the
  evidence before any further slice.
- Outcome (2026-09-07): items 1–4 PASS; contract held on the host profile;
  ADR-0005 and ADR-0007 stand. Full record:
  [trials/2026-09-slice1.md](../engineering/trials/2026-09-slice1.md).

## Slice 2 — domain kernel and ledger

- Implement the slice-2 aggregates in `packages/domain` with the authority
  subset check, transition validation, failure classification over Trigger
  statuses, and evidence matching; unit and property tests.
- Add Postgres migrations and repositories for the ledger, DispatchIntent, and
  generation fencing; integration tests for transactional decision-then-dispatch,
  duplicate observation, and stale-generation refusal.
- Add the Trigger client wrapper with a deterministic fake and the worktree
  retention policy.
- Outcome (2026-09-07): contracts 184 tests, domain 344 tests, trigger 89 tests
  (+1 skipped live), db 8 unit + 41 integration on Postgres 17.6; `pnpm check`
  11/11; authority subset check with 15 violation codes, acceptance rule with 13
  reason codes, FakeExecutionRuntime and RealExecutionRuntime, 15-table ledger.

## Slice 3 — one complete bounded repair

- Implement `lead.plan`, `verify.run`, `lead.review`, `lead.accept`, and the
  coordinator flow through acceptance at the `artifact` boundary.
- Adversarial fixtures for repository-content injection and false success.
- Minimal operator view: return-after-interruption journey with Trigger
  Realtime for execution state and links to Trigger runs for logs.
- Run the full execution trial on the real stack and record it. CI runs the
  baseline check and all slice tests.
- Outcome (2026-09-07): items 1–7 run; items 1–3 PASS, item 4a PASS (4b/4c not
  exercised live — worker model declined to write via bash; Slice 1 record and
  unit tests are the evidence), item 5 PASS, item 6 PARTIAL (weakened-test path
  not exercised live — detected by adversarial reviewer only; `flow.false-success
  (f)` is the deterministic gate confirming `REVIEW_BLOCKING` rejection), item 7
  PASS (work item `89cfe999-9710-4388-8dd1-caf520d26d49` completed at artifact,
  no Approval, ~150 s end to end). 847 unit tests, 114 integration tests (as of
  rework-4, 2026-09-08; unchanged from rework-3; earlier counts were 787 unit / 86 integration). Full
  record: [trials/2026-09-slice3.md](../engineering/trials/2026-09-slice3.md).
- Post-rework issues wave (2026-09-07, branch issues-1-8): parking-path tests
  added (`flow.parking.test.ts`: null-commit contract failure, humanRequired
  pending_human — issues #1, #6 open items); `approve` command and
  `approve.test.ts` (issue #2); bearer auth on `/api/*` with `AGENCYHQ_API_TOKEN`,
  web client token prompt on 401 (issue #3); `verify.run` `integrity` field
  consumed by coordinator — union of adapter and coordinator sets, both sides
  in finding evidence (issue #6); `opencode-smoke.ts` exits 2 without `--model`
  or `AGENCYHQ_OPENCODE_MODEL` (issue #7); `lead.plan` runs tagged `project:`
  and `workItem:` (issue #8 part 1).

## Slice 4 — integration boundaries and multiple repositories

- `integrate.merge` with compare-and-set and per-repository serialization;
  `merge` boundary completion.
- Multi-repository WorkItems with revision manifests, dependency order, and
  combined verification; `deploy` boundary only where a project needs it.
- Extract a ProcessDefinition type only if a second process is now required.
- Outcome (2026-09-08): merge boundary with CAS confirmed live — `approve` path
  dispatches `integrate.merge` in the same transaction, merge commit pushed with
  `--force-with-lease`, `projects.allowed_refs.main` advanced after integration.
  Human-approval path (`pending_human` → `approve` command → `integrate.merge`
  intent triggered before the approve response returned) PASS. Two-repository
  manifest with combined verification: consumer `manifest-consumer@1` check read
  the parser sibling at `AGENCYHQ_MANIFEST_0`; both remotes advanced to the
  ledger result. Deploy boundary rejected with `DEPLOY_NOT_SUPPORTED` (not yet
  implemented). `integrate.merge` is the only task that may push (push-boundary
  test enforces this). ProcessDefinition not extracted — only one process exists;
  extraction rule documented for when a second catalog entry needs a different
  step/gate sequence. 9 defects found and fixed live, all with tests. 1,058 unit
  tests, 178 integration tests (61 db + 117 coordinator). Full record:
  [trials/2026-09-slice4.md](../engineering/trials/2026-09-slice4.md).

## Slice 5 — control plane (current)

- Campaigns, cross-project rank, work overview, decisions view, evidence view,
  and authority-schema editing; browser tests for primary flows.

## Slice 6 — capacity

- Multiple worker machines and concurrent attempts using Trigger queues and
  environment limits; ProviderCapacity observations with conservative stale
  handling; Lead quality metrics dashboard.
- Container runtime profile: deployed supervisor/worker stack, task image
  with pinned Git and OpenCode, API-key providers, generation-bound push
  tokens; then a model gateway with per-attempt keys, upgrading isolation,
  egress, and spend from advisory to enforced.
