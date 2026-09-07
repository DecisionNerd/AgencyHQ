# Trigger.dev task adapters

Task definitions run by `trigger dev` on the OpenCode host (host profile) and,
later, by the deployed supervisor from a task image (container profile).
Tasks: `lead.plan`, `worker.attempt`, `verify.run`, `lead.review`,
`lead.accept`, `integrate.merge`. Each is a thin adapter with no policy: it
does the work, reports progress through run metadata, returns structured
output, and throws `AbortTaskRunError` on contract failures so Trigger does
not retry them. `worker.attempt` performs the worktree-scrub-run-diff-commit
sequence and the `onCancel` checkpoint-and-kill sequence in ADR-0007. Pin the
Trigger image, SDK/CLI, and OpenCode versions together.

## Running

The `@agencyhq/trigger` workspace package pins `@trigger.dev/sdk` and
`trigger.dev` at `4.5.16`. `trigger.config.ts` declares the project ref (from
`TRIGGER_PROJECT_REF`), task directory (`./src/tasks`), Node runtime,
`maxDuration: 900`, and single-attempt retries with `enabledInDev: false`.

`src/tasks/spike-echo.ts` defines a single throwaway task, `spike.echo`,
that echoes its payload message alongside the sorted environment variable
key list and the running Node version — used to inspect what a task process
can see under the host profile. `scripts/echo.ts` triggers that task against
a running Trigger instance (`TRIGGER_API_URL`, `TRIGGER_SECRET_KEY`) and
polls `runs.retrieve` for a final status. `test/smoke.test.ts` is a
`node --test` smoke check that the package's types import cleanly under
Node's built-in TypeScript type stripping.

See `.env.example` for the environment variables these scripts and
`trigger dev` expect.

## Libraries

`src/lib/**` holds pure adapter functions for the `worker.attempt` effect
model (ADR-0007): no Trigger SDK usage, node built-ins only.

- `git.ts`: `worktreeAdd`, `worktreeRemove`, `commitTree` (adapter commits,
  `agencyhq` identity, returns `null` when there is nothing to commit),
  `updateRef`, `changedPaths` (tracked diff plus untracked files),
  `diffDigest` (deterministic sha256 over the diff and untracked contents),
  and `revertPaths` (restores or deletes listed paths back to a base
  revision, for quarantine).
- `env.ts`: `scrubbedChildEnv` builds an allowlisted child environment
  (`HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`,
  `TMPDIR`, plus `AGENCYHQ_ATTEMPT_ID` and the `GIT_*` overrides that empty
  the credential helper and disable prompting/SSH); `assertPushBlocked` is
  the before-action control that proves a scrubbed env cannot push.
- `paths.ts`: a minimal glob matcher (`*`, `**`, `?`, exact) plus
  `classifyPaths` (allow/violation split against `paths.allow`, rejecting
  `..` and absolute paths) and `quarantinePatch` (captures violating paths
  as a diff/patch for the record before they are reverted).
- `procs.ts`: `descendants`, `killTree` (SIGTERM the process group and every
  descendant, wait out the grace period, then SIGKILL survivors), and
  `survivorScan` (finds any process still tagged with an attempt's
  `AGENCYHQ_ATTEMPT_ID`) for the stop sequence in EXECUTION_MODEL.md.
- `opencode.ts`: `buildPermissionRuleset` and `writeRunConfig` produce the
  worker's permission ruleset and `opencode.worker.json`; `spawnOpenCode`
  runs `opencode run --format json` as a detached process group against a
  worktree with the scrubbed env, `OPENCODE_DISABLE_PROJECT_CONFIG`,
  `--pure`, and `OPENCODE_PERMISSION`, streaming events and stderr to the
  run directory; `parseEvents`/`summarize` reduce the NDJSON stream to
  denials, errors, tool uses, and a text tail. See the file's header comment
  for the OpenCode CLI/config/permission facts this encodes and their
  source dates, and for what the required smoke run actually observed.

`scripts/opencode-smoke.ts` exercises `opencode.ts` end to end against a
disposable temp fixture repo and worktree: an allowed edit, three
escape-path attempts, a `git push`, and a `task`-tool attempt, run once each.

## Tasks and scripts

`src/tasks/worker-attempt.ts` defines `worker.attempt`, the task ADR-0007
describes: `maxDuration: 600`, a single-concurrency `worker` queue, and one
attempt (`retry: { maxAttempts: 1 }`, contract failures do not retry). `run`
resolves the attempt's worktree and run directory, fails fast with
`AbortTaskRunError` if the worktree path already exists, `worktreeAdd`s it,
writes the permission ruleset and scrubbed env, and `spawnOpenCode`s the
prompt, publishing `phase` (`worktree_ready` → `opencode_running` →
`diffing` → `committed`/`path_violation`/`opencode_error`) and, once known,
`pid`/`pgid`/`sessionID` to run metadata. On exit it diffs the worktree,
`classifyPaths`, quarantines and reverts any violation before committing the
remainder to `refs/heads/agencyhq/attempts/<attempt-id>`. An abort listener
registered inside `run` (fires on cancel and on exceeding `maxDuration`) and
the separate `onCancel` hook both call the same
`checkpointAndKill`/`RunState` map from `src/tasks/worker-attempt-core.ts`,
so whichever reaches a given run first commits the checkpoint to
`refs/heads/agencyhq/checkpoints/<attempt-id>` and kills the process group
exactly once; the loser is a no-op. `worker-attempt-core.ts` holds every
piece of this that does not need the Trigger SDK (path resolution, output
shape, the checkpoint-and-kill routine) so it can be unit-tested with fake
git/proc functions instead of a running Trigger instance — see
`test/worker-attempt-core.test.ts`.

`scripts/lib/trigger-client.ts` wraps the SDK calls the trial script needs:
`configureFromEnv` (`TRIGGER_API_URL`/`TRIGGER_SECRET_KEY`), `triggerAttempt`
(dispatches `worker.attempt` with a global-scope `idempotencyKeys.create`
key), `waitFinal` (polls `runs.retrieve` every 2s for a final status),
`cancel`, and `metadataOf`. It imports the task's *type* only, so loading it
never runs the task file's own top-level registration code.

`scripts/fixture-repo.ts`'s `createFixture` builds a disposable one-commit
git repo with an allowed area (`src/`, `docs/`), a denied area (`secrets/`),
and `scripts/slow.js` (a node process that stays alive for 15 minutes, for
exercising cancel/timeout); run directly (`node --env-file=.env
scripts/fixture-repo.ts`) it prints `{repoPath, baseRev}` as JSON using
`AGENCYHQ_WORKTREE_BASE` and `AGENCYHQ_FIXTURE_REMOTE`.

`scripts/trial.ts <item> [--repo <path>] [--base-rev <sha>]` (also `pnpm
trial <item>`) runs one item of docs/engineering/TESTING.md's required
execution trial (lines 104-121) at a time against a real `trigger dev` and
`opencode`: item 1 dispatches the same payload twice concurrently under one
idempotency key and confirms one run, one worktree, one attempts ref; item 2
cancels a `scripts/slow.js` run mid-flight and confirms a checkpoint ref, no
survivors, and no live descendants of the OpenCode process group; item 3
repeats that prompt with `maxDuration: 30` and confirms `TIMED_OUT` with no
survivors and the worktree retained; item 4 checks a `git push` is blocked
(plus a control `assertPushBlocked` run outside any attempt), that escape
paths (`../`, `/tmp/...`, a denied in-worktree path) are quarantined, and
that the `task` tool is denied. Each item prints `EVIDENCE ...` lines and one
final `RESULT item=<n> PASS|FAIL reason=...` line.
## Trial

Trial items 1–4 ran against a live `trigger dev` on 2026-09-07 using Trigger.dev
4.5.16, OpenCode 1.18.29, and Node 24.16.0. Items 1–4 PASS. The full record,
including earlier failing runs and the adapter changes they prompted, is in
[docs/engineering/trials/2026-09-slice1.md](../docs/engineering/trials/2026-09-slice1.md).
Items 5–7 require the Slice 2 domain kernel and have not run.

The trial script is `scripts/trial.ts`; run one item at a time with
`pnpm trial <item>` once `trigger dev` and the webapp stack are running.

## Execution-runtime client (`src/client/`)

### `ExecutionRuntime` interface (`src/client/index.ts`)

Defines the four operations every execution-runtime adapter must provide:

- `trigger(input)` — start a task run with a global-scope idempotency key,
  an optional concurrency key (serialises per repository), and tags.
- `cancel(runId)` — cancel an in-flight run; resolves even if already final.
- `retrieve(runId)` — fetch the current `RunObservation` for a run.
- `createPublicToken(input)` — create a short-lived public access token.

`TriggerRunStatus` is the full 13-status v4 union.  `FINAL_RUN_STATUSES`
lists the statuses a run never leaves.  `FAILURE_RUN_STATUSES` lists those
that clear an idempotency key (FAILED, CRASHED, SYSTEM_FAILURE, EXPIRED,
TIMED_OUT); COMPLETED and CANCELED keep their keys.

### `FakeExecutionRuntime` (`src/client/fake.ts`)

Deterministic in-memory implementation for tests.  Does not import any
trigger.dev SDK package (asserted by `trigger/test/client-fake.test.ts`).

Key features:

- **Idempotency** — `idempotency` map mirrors the real table: same key
  returns the same `runId` while the key is live; failure-class finals clear
  it; COMPLETED and CANCELED keep it.
- **Lost-response simulation** — `dropNextResponse()` makes the next
  `trigger()` register the run (so the idempotency key is live) then throw
  `FakeNetworkError`, enabling retry-collapses-to-same-run tests.
- **Scripted progressions** — `script(task, handler)` programs the outcome
  per task; `advance(runId)` / `advanceAll()` step runs through the queue
  (QUEUED → EXECUTING → scripted steps) so tests observe each intermediate
  state via `retrieve()`.
- **Cancel** — sets CANCELED immediately, keeps the idempotency key.
- **setMetadata** — patches metadata after a run is final (models adapter
  survivors arriving post-completion).
- **Deterministic run ids** — `run_fake_<n>` for easy assertions.
- **`calls` log** — every method call in order for assertion.

### `RealExecutionRuntime` (`src/client/real.ts`)

Production adapter that wraps the real `@trigger.dev/sdk`.  Constructed with
`{ apiUrl, secretKey, taskIds? }` and an optional injectable `SdkSurface` for
unit tests (so tests never need a live Trigger instance).

- Calls `configure({ baseURL, secretKey })` once on construction.
- `trigger()` calls `idempotencyKeys.create(key, { scope: "global" })` then
  `tasks.trigger` with `idempotencyKeyTTL` defaulting to `"24h"`, plus
  `concurrencyKey`, `tags`, and `maxDuration` forwarded from the options.
- `retrieve()` maps `runs.retrieve`'s result to `RunObservation`, passing
  `status` through as-is (the 13-value SDK enum matches `TriggerRunStatus`),
  and sets `observedAt` to the current ISO timestamp.
- `cancel()` delegates to `runs.cancel`; resolves even if the run is final.
- `createPublicToken()` calls `auth.createPublicToken` with
  `{ scopes: { read: { tags } }, expirationTime: expiresIn }`.
- All SDK errors are wrapped in `RuntimeError { name, cause }` and re-thrown;
  no retries or error swallowing here.

## Worktree retention policy (`src/retention.ts`)

Implements the retention logic from ADR-0007 §56-63.

### `retentionCandidates(input)`

Pure function — no side-effects, no git I/O.  Given a list of attempts with
their status, commit SHAs, finalAt timestamps, and a protected set, it returns
`{ remove, keep }`:

- **Remove** when: status ∈ `{completed, quarantined, failed, stopped,
  timed_out}`, `finalAt` is non-null and older than `keepFinalForMs`, not in
  `protectedAttemptIds`, and `attemptCommit ?? checkpointCommit` is non-null
  (commits must already be retained in the repository).
- **Keep** otherwise, including for `uncertain` and `stopping` statuses.

### `removeRetained(repoPath, candidates, deps?)`

Async effect function.  For each candidate from `retentionCandidates().remove`
it first checks that the commit is reachable in the repository
(`git cat-file -e <sha>^{commit}`), then calls `git worktree remove --force`.
Candidates with an unreachable commit are skipped (kept for inspection).
Returns `{ removed, skipped }`.  The `deps` parameter accepts injectable
`worktreeRemove` and `refExists` implementations so the function is
unit-testable without a real git repository.
