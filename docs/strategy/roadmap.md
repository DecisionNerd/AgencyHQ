# Incremental roadmap

Each slice leaves the repository runnable, tested, and more capable. The
riskiest assumption — that self-hosted Trigger.dev plus OpenCode can meet the
isolation and recovery contract — is tested first, before domain code depends
on it.

## Slice 0 — architecture baseline (current)

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

## Slice 2 — domain kernel and ledger (current)

- Implement the slice-2 aggregates in `packages/domain` with the authority
  subset check, transition validation, failure classification over Trigger
  statuses, and evidence matching; unit and property tests.
- Add Postgres migrations and repositories for the ledger, DispatchIntent, and
  generation fencing; integration tests for transactional decision-then-dispatch,
  duplicate observation, and stale-generation refusal.
- Add the Trigger client wrapper with a deterministic fake and the worktree
  retention policy.

## Slice 3 — one complete bounded repair

- Implement `lead.plan`, `verify.run`, `lead.review`, `lead.accept`, and the
  coordinator flow through acceptance at the `artifact` boundary.
- Adversarial fixtures for repository-content injection and false success.
- Minimal operator view: return-after-interruption journey with Trigger
  Realtime for execution state and links to Trigger runs for logs.
- Run the full execution trial on the real stack and record it. CI runs the
  baseline check and all slice tests.

## Slice 4 — integration boundaries and multiple repositories

- `integrate.merge` with compare-and-set and per-repository serialization;
  `merge` boundary completion.
- Multi-repository WorkItems with revision manifests, dependency order, and
  combined verification; `deploy` boundary only where a project needs it.
- Extract a ProcessDefinition type only if a second process is now required.

## Slice 5 — control plane

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
