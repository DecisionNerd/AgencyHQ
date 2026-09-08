# ADR-0007: Workers produce proposals, not effects

- Status: Accepted
- Date: 2026-09-07
- Extends: ADR-0004 (simplifies the replacement gate by removing worker-side
  external effects) and ADR-0005.
- Implementation status: Slice 1 spike implemented; Slice 3 complete task adapters and coordinator flow implemented. Qualified by the Slice 1 execution trial on 2026-09-07 (items 1–4 PASS), see [../trials/2026-09-slice1.md](../trials/2026-09-slice1.md); and by the Slice 3 trial on 2026-09-07 (items 1–3 PASS live, 4a PASS live, 4b/4c not exercised live, 5 PASS live, 6 PARTIAL — weakened-test path not exercised live and covered by deterministic tests, 7 PASS live), see [../trials/2026-09-slice3.md](../trials/2026-09-slice3.md). Rework re-check 2026-09-07: worker ruleset from the contract, stop path, and full flow re-verified live; see the [rework section](../trials/2026-09-slice3.md#rework-after-independent-review-1-2026-09-07). Rework-2 (2026-09-07): `permissionRules` is now required in the payload (no fallback); `resolveWorkerRuleset` and `enforceAlwaysDeny` moved to `worker-attempt-core.ts` and covered by deterministic tests (`trigger/test/worker-attempt-core.test.ts`); no live run after 16002f2. Rework-3 (2026-09-07): retry-on-budget path commits a Failure record for the superseded attempt in the same transaction before inserting the new attempt; `verify.run` records `protectedPathsSource` in its output; `lead.accept` uses a per-run temp directory (removed on success, retained on failure); migration 0002 adds NOT NULL to columns always written by the coordinator; no live run after 16002f2. Rework-4 (2026-09-08): `protectedPathsSource` qualified as recorded by the adapter (rework-4 note: the coordinator did not yet consume it at that point); db insert types require NOT NULL columns; reconciler-route and stop-path fixes in coordinator; no live run after 16002f2. Issues wave (2026-09-07): `verify.run` `integrity` field now consumed by the coordinator — `onVerifyFinal` unions the adapter's tampered set with its own recomputed set and records both sides in finding evidence. Slice 4 (2026-09-08): push boundary realized — `integrate.merge` is the only task that may push; confirmed by `trigger/test/push-boundary.test.ts` and live trial (items 8–10); `verify.run` manifest materialization: sibling worktrees injected as `AGENCYHQ_MANIFEST_<N>` for combined verification across manifest entries; `manifest-consumer@1` check confirmed live (item 10, seventh run). Full record: [../trials/2026-09-slice4.md](../trials/2026-09-slice4.md). Slice 5 (2026-09-08): push boundary remains the only task that may push; `reject` and `invalidate_acceptance` are coordinator-only operations with no task dispatch — no external effect from a worker is in flight for those commands; no change to adapter scope. S5 rework (84cdb08, 2026-09-08): no change to adapter scope or push boundary; coordinator-side fixes (open-pending rule, persisted reasons, membership guard, authority CAS) do not alter task dispatch.

## Context

The baseline replacement gate had to reconcile "effects already in flight"
from a lost worker: pushes, merges, deployments, unknown external calls. That
is necessary only if workers can cause external effects. The baseline also
said both "grant workers repository- and operation-scoped credentials" and
"workers receive no publish/merge/deploy credentials", and never said where
worktrees live.

## Decision

1. **A worker's only output is the state of its attempt worktree and its
   report.** Workers get no publish, merge, or deploy capability. OpenCode's
   permission rules for worker agents deny `git push`, `git remote`, network
   tools, the `task` tool, and access outside the worktree.
2. **Worktrees are real Git worktrees on the host.** Each Project has a
   coordinator-owned base folder with one clone; each attempt gets
   `git worktree add <base>/attempts/<attempt-id> <base-revision>`. The folder
   is the operator-visible artifact of the attempt and is never reused by
   another attempt.
3. **The worker child process runs with a scrubbed environment.** The adapter
   spawns OpenCode with `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`, and
   similar variables removed, `credential.helper` overridden to empty through
   `GIT_CONFIG_*` variables, and `HOME` retained so OpenCode finds its own
   config. This is a before-action control against pushes from the worker
   process; it is not filesystem isolation.
4. **Outputs are committed by the adapter after the worker exits.** The
   adapter diffs the worktree, quarantines paths outside the contract, and
   commits on `agencyhq/attempts/<attempt-id>` in the local repository. The
   commit id and diff digest are the attempt Artifact. No push occurs.
5. **Verification runs as its own Trigger task** in a separate worktree at the
   attempt revision, with the approved checks, and returns results.
6. **Integration is a coordinator-dispatched task** that merges the attempt
   revision to the target ref and pushes with the host's credentials, only
   after a recorded acceptance Decision, serialized per repository, and
   compare-and-set on the target ref's expected base.
7. **Cancellation salvage.** On `onCancel` the adapter commits whatever is in
   the worktree to `agencyhq/checkpoints/<attempt-id>` before terminating the
   process group, so a stopped attempt's work is inspectable and a Lead may
   select it as a starting revision for a replacement.
8. **Provider credentials** are the host's. A worker with shell access can
   read them; this is a declared risk of the host profile, mitigated by the
   permission rules and by moving to the container profile with per-attempt
   keys when hardening is needed.

## Consequences

- Replacement reduces to: revoke the generation, cancel the run, confirm the
  process group is gone and the run is final, start a new attempt in a new
  worktree. Nothing the old worker did reached a shared ref, because the
  adapter, not the worker, commits, and only integration pushes.
- Unknown-effect reconciliation applies only to the integration task, which
  is serialized and compare-and-set.
- Attempt worktrees accumulate on disk; a retention policy removes worktrees
  whose attempt is final and whose commits are retained in the repository.
- The coordinator needs no inbound endpoint for task adapters on the host
  profile; the container profile adds token issuance.
