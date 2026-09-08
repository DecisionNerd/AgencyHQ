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
  `classifyPaths` (allow/violation split against `paths.allow`, with an
  optional `denied` list — a path matching any denied glob is a violation
  even if it also matches an allowed glob, mirroring the ruleset's last-match-
  wins deny layer; rejects `..` and absolute paths) and `quarantinePatch`
  (captures violating paths
  as a diff/patch for the record before they are reverted).
- `procs.ts`: `descendants`, `killTree` (SIGTERM the process group and every
  descendant, wait out the grace period, then SIGKILL survivors), and
  `survivorScan` (finds any process still tagged with an attempt's
  `AGENCYHQ_ATTEMPT_ID`) for the stop sequence in EXECUTION_MODEL.md.
- `opencode.ts`: `writeRunConfig` writes `opencode.worker.json` from the
  resolved ruleset. `buildPermissionRuleset` remains in the file as a legacy
  helper but is no longer called by `worker.attempt` (no fallback path exists).
  Permission source: `WorkerAttemptPayload.permissionRules` is required;
  `resolveWorkerRuleset` (in `worker-attempt-core.ts`) applies
  `enforceAlwaysDeny` to merge `WORKER_ALWAYS_DENY_BASH` and
  `WORKER_ALWAYS_DENY_PATHS` on top for defense in depth and throws when the
  field is absent. `permissionSource` is always `"contract"` and is recorded
  in run metadata. Deny enforcement
  applies at two layers: before-action (the ruleset's edit/bash pattern map,
  last-match-wins) and on-output (`classifyPaths` with `denied` list from
  `payload.bounds?.paths.deny`). `spawnOpenCode` runs `opencode run --format
  json` as a detached process group against a worktree with the scrubbed env,
  `OPENCODE_DISABLE_PROJECT_CONFIG`, `--pure`, and `OPENCODE_PERMISSION`,
  streaming events and stderr to the run directory;
  `parseEvents`/`summarize` reduce the NDJSON stream to denials, errors, tool
  uses, and a text tail. See the file's header comment for the OpenCode
  CLI/config/permission facts this encodes and their source dates, and for
  what the required smoke run actually observed.
- `manifest.ts`: pure helpers for combined verification across manifest entries. `siblingEntries(entries, projectId)` returns all entries except the one belonging to the given projectId. `manifestEnv(entries, paths, digest)` builds the environment variable map for checks: each sibling entry at position N produces `AGENCYHQ_MANIFEST_<N>` pointing to its materialized worktree path, plus `AGENCYHQ_MANIFEST_DIGEST` set to the manifest plan digest.

`scripts/opencode-smoke.ts` exercises `opencode.ts` end to end against a
disposable temp fixture repo and worktree: an allowed edit, three
escape-path attempts, a `git push`, and a `task`-tool attempt, run once each.
The model id is required: pass `--model <model-id>` or set
`AGENCYHQ_OPENCODE_MODEL`; when neither is present the script writes a usage
message to stderr and exits with code 2 (tested by
`trigger/test/opencode-smoke-args.test.ts`).

## Tasks and scripts

`src/tasks/worker-attempt.ts` defines `worker.attempt`, the task ADR-0007
describes: `maxDuration: 600`, a single-concurrency `worker` queue, and one
attempt (`retry: { maxAttempts: 1 }`, contract failures do not retry). `run`
resolves the attempt's worktree and run directory, fails fast with
`AbortTaskRunError` if the worktree path already exists, `worktreeAdd`s it,
resolves the model — `payload.model` takes priority, then
`AGENCYHQ_OPENCODE_MODEL`; neither being set is a setup failure
(`AbortTaskRunError`, not retried),
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

Trial items 1–4 ran on 2026-09-07 using Trigger.dev 4.5.16, OpenCode 1.18.29,
and Node 24.16.0; items 1–4 PASS. Full record:
[docs/engineering/trials/2026-09-slice1.md](../docs/engineering/trials/2026-09-slice1.md).

Items 5–7 ran on 2026-09-07 on the complete Slice 3 stack: item 5 PASS
(Lead could not widen authority via injected AGENTS.md); item 6 PARTIAL (worker
resisted adversarial house rules; weakened-test path not exercised live);
item 7 PASS (work item `89cfe999-9710-4388-8dd1-caf520d26d49` completed at
artifact boundary, no Approval, ~150 s end to end). Full record:
[docs/engineering/trials/2026-09-slice3.md](../docs/engineering/trials/2026-09-slice3.md).

The trial script is `scripts/trial.ts`; run one item at a time with
`pnpm trial <item>` once `trigger dev` and the webapp stack are running.

## Execution-runtime client (`src/client/`)

### `ExecutionRuntime` interface (`src/client/index.ts`)

Defines the five operations every execution-runtime adapter must provide:

- `trigger(input)` — start a task run with a global-scope idempotency key,
  an optional concurrency key (serialises per repository), and tags.
- `cancel(runId)` — cancel an in-flight run; resolves even if already final.
- `retrieve(runId)` — fetch the current `RunObservation` for a run.
- `createPublicToken(input)` — create a short-lived public access token.
- `subscribe?(input, onObservation)` — **optional** real-time wake-up hint
  (see below).

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
- `subscribe()` (R-008, R-010) — calls `runs.subscribeToRunsWithTag(tag)` for
  each requested tag (SDK 4.5.16 async iterator); all per-tag subscriptions
  run concurrently; on error the subscription ends and the promise resolves so
  the caller falls back to polling.

### Subscribe — wake-up hint semantics

`subscribe?(input: { tags: string[]; signal: AbortSignal }, onObservation)`

Callers use `subscribe` to receive real-time run-state notifications without
polling.  **Polling via `retrieve` remains the authoritative path of record;
`subscribe` is an acceleration hint only.**

- The returned promise resolves when `signal` is aborted or an error ends the
  subscription.
- `onObservation` is called with the same `RunObservation` shape as `retrieve`,
  including `runId`, `status`, `output`, `metadata`, `error`, and `observedAt`.
- On error the subscription ends silently; no exception is propagated to the
  caller.
- The method is optional (`?`) — implementations that do not support real-time
  delivery may omit it; the coordinator checks for its presence before calling.

`FakeExecutionRuntime.subscribe` emits one observation per `advance()` call
for runs whose tags intersect the subscriber's tag set, enabling coordinator
tests to drive the subscribe path without a live Trigger.dev server.

### Capacity metadata (`src/lib/capacity.ts`)

`classifyCapacity(events, { provider, model, now })` scans an OpenCode event
stream for error signals and returns a `CapacityClassification` or `null`.

Classification rules (first match wins):

| Signal | Status | `validUntil` |
|---|---|---|
| HTTP 401/403 · "invalid api key" · "insufficient credits" | `"down"` | +30 min |
| HTTP 429 · "rate limit" · "quota" · "overloaded" | `"limited"` | +5 min |
| HTTP 5xx · "unavailable" | `"limited"` | +2 min |
| no match | *(null — returned)* | — |

**Metadata key**: `"capacity"` on the Trigger run.

**Shape**:

```ts
{
  provider: string;        // e.g. "openai"
  model: string;           // full "provider/model" string
  status: "limited" | "down";
  observedAt: string;      // ISO-8601
  validUntil: string;      // ISO-8601; re-evaluate after this time
  evidence: string;        // ≤200-char excerpt from the triggering event
}
```

Tasks that run a model (`worker.attempt`, `lead.plan`, `lead.review`,
`lead.accept`) call `classifyCapacity` after the model run and, when non-null,
call `metadata.set("capacity", ...)`.

- For `worker.attempt` the full NDJSON event list is passed directly.
- For lead tasks (OpenCode SDK server mode, no NDJSON stream) a synthetic
  `{ type: "error", error: { message: reason } }` event is constructed from
  the `invalid_output.reason` string and classified the same way.

`providerFromModel(model)` extracts the provider segment from a
`"provider/model"` string (e.g. `"openai/gpt-4"` → `"openai"`).

Neither `capacity.ts` nor any `*-core.ts` file imports the Trigger SDK
(asserted by C5 in the packet and the architecture baseline tests).

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

## `verify.run` task (`src/tasks/verify-run.ts`)

Implements ADR-0007 item 5: verification runs as its own Trigger task in a separate worktree at the attempt revision, with the approved checks.

- Task id: `verify.run`, `maxDuration: 1200`, single-concurrency `verify` queue, `retry: { maxAttempts: 1 }`.
- Validates the payload with `VerifyRunPayloadSchema` and throws `AbortTaskRunError` on contract failure (no retry).
- Publishes phases `worktree_ready` → `integrity_checked` → `checks_running` → `done` to run metadata.
- Wires real git deps (`worktreeAdd`, `worktreeRemove`, `diffDigest`, `changedPaths`), prefixing the raw hex from `git.ts diffDigest` with `sha256:` to satisfy `DigestStringSchema`.
- Loads `@agencyhq/verification` via a dynamic import guarded by a local structural type (`VerificationPackage`) so typecheck passes before that package is published. When the package is absent, a stub runner returns `result: "error"` with `stderrTail: "verification_package_unavailable"` for every check.
- Registers a signal abort listener that calls the runner's optional `abort()` so in-flight checks are killed when the task is cancelled or reaches `maxDuration`.

### `verify-run-core.ts` — pure/injectable logic

`src/tasks/verify-run-core.ts` factors out every piece that does not need the Trigger SDK:

- `VerificationRunner` interface: `runProfile(input) => Promise<VerificationResult[]>` plus optional `abort()`.
- `VerifyRunDeps`: injected git ops, runner, optional fingerprint, `now()`, plus optional `manifestProjectId` (the projectId of the project currently under verification) and `manifestRepoPaths` (map from projectId to absolute path of coordinator-owned clones of sibling repositories). Both manifest fields are required when `payload.manifest` is present.
- `resolveVerifyWorktreePath`: `<worktreeBase>/verify/<attemptId>-<generation>`.
- `resolveManifestWorktreeDir`: `<worktreeBase>/manifest-<attemptId>-<generation>` — base directory for sibling worktrees materialized during combined verification.
- `runVerification(payload, deps)`: creates the verify worktree at `attemptRevision`; reproduces `diffDigest` against `baseRevision` before any check runs; on mismatch returns one `result: "error"` per check with `stderrTail: "integrity_mismatch: expected <a> got <b>"` and does NOT call the runner; on match runs `detectVerifierTampering` on the changed paths (reporting `tamperedPaths` in output but not changing results). When `payload.manifest` is present and `deps.manifestProjectId`/`deps.manifestRepoPaths` are supplied, materializes each sibling entry as a detached worktree under `<manifestDir>/<position>` using `siblingEntries` and passes `manifestEnv` (`AGENCYHQ_MANIFEST_<N>` and `AGENCYHQ_MANIFEST_DIGEST`) into the check environment. All sibling worktrees are removed in `finally` before the main verify worktree. Each `VerificationResult` record receives the `manifest` field (plan digest and per-sibling revision info) when sibling repos were materialized. Then calls `runner.runProfile`; always removes the verify worktree in `finally`; re-stamps `profileDigest`/`criteriaDigest` from the payload on every result (frozen digests, never recomputed from the worktree); parses every result with `VerificationResultSchema`.

Evidence integrity invariants enforced (TESTING.md §67-73): the worktree is at `attemptRevision`; the digests are frozen before the worker runs and copied from the payload unchanged; the worker's report of checks run is context, not evidence (the file never references `report` or `checksRun`); the verify worktree is disposed after the run.

Tests are in `test/verify-run-core.test.ts` (10 tests covering the happy path, integrity mismatch, tamper detection, worktree cleanup on failure, schema validation, source-grep assertions, and the generation-in-path invariant).
## `lead.review` and `lead.accept` tasks (Packet 3.D)

### Overview

Two Trigger tasks implement the adversarial review and acceptance proposal steps
described in ADR-0006 (Lead role and delegated authority). Both tasks produce
proposals for the coordinator; neither task decides or evaluates criteria itself.

### `lead.review` (id: `lead.review`, maxDuration: 600s, queue: lead)

Runs an adversarial Lead session seeded with the diff, approved criteria, and
verification results — never the worker's session or conversation (ADR-0006
independence invariant). The reviewer is asked: _what would make the claim
false?_

Inputs (`LeadReviewPayload`): attemptId, generation, contractId, criteria with
digests, verification results from `verify.run`, model, repoPath, worktreeBase,
and baseRevision. The payload schema deliberately omits any worker session id or
transcript field; the runtime asserts this at every invocation.

The task:
1. Validates the payload with `LeadReviewPayloadSchema`.
2. Creates a read-only git worktree at the attempt revision
   (`<worktreeBase>/review/<attemptId>-<generation>`).
3. Runs `git diff <base> <attempt>` and writes the patch to
   `<runDir>/attempt.patch` (outside the worktree).
4. Builds an adversarial system + user prompt via `buildReviewPrompt`.
5. Calls the Lead session with `leadAgentPermissions()` and
   `LEAD_OUTPUT_JSON_SCHEMAS.reviewOutput`.
6. Post-validates that the reviewer's `subject` exactly matches the payload
   digests and revision (a mismatch → `{ kind: "invalid_output" }`).
7. Removes the review worktree in a `finally` block.

Reviewer identity: the `reviewerModel` field in the output is the invoked `payload.model` (not a self-reported model from the session).

Output: `ReviewOutput & { reviewerModel: string }` on success, or
`{ kind: "invalid_output"; reason: string; reviewerModel: string }` on failure.

### `lead.accept` (id: `lead.accept`, maxDuration: 300s, queue: lead)

Runs a Lead session to produce an acceptance proposal after all verification
results and a review are available. No worktree is created.

The acceptance proposer cites each criterion against evidence refs
(`verificationResultRef` strings from the payload's `verificationResults`). The
`accept` field may be true only when every criterion is satisfied and no
blocking finding is present. Non-blocking findings receive an explicit
disposition.

Inputs (`LeadAcceptPayload`): attemptId, generation, contractId, criteria,
verification results, the review output, and model. After the session, the task
post-validates that every cited `verification_result` ref exists in
`payload.verificationResults` (unknown refs → `{ kind: "invalid_output" }`).

A per-run working directory is created via `mkdtemp` (never the bare `/tmp`
directory). On success the directory is removed; on failure it is retained for
evidence so the caller can inspect the lead session artifacts.

Output: `AcceptanceProposal` on success, or `{ kind: "invalid_output"; reason }` on failure.

### Source layout

| File | Purpose |
|---|---|
| `src/opencode/review-prompt.ts` | `buildReviewPrompt(payload, patch)` — deterministic adversarial prompt builder |
| `src/opencode/accept-prompt.ts` | `buildAcceptPrompt(payload)` — deterministic acceptance proposer prompt builder |
| `src/tasks/lead-review-core.ts` | `runReview(payload, deps)` — pure/injectable review logic |
| `src/tasks/lead-accept-core.ts` | `runAccept(payload, deps)` — pure/injectable accept logic |
| `src/tasks/lead-review.ts` | Trigger task wiring for `lead.review` |
| `src/tasks/lead-accept.ts` | Trigger task wiring for `lead.accept` |
| `test/review-prompt.test.ts` | Prompt builder determinism and invariant tests |
| `test/lead-review-core.test.ts` | Review core unit tests with fake session |
| `test/lead-accept-core.test.ts` | Accept core unit tests with fake session |

### `LeadSession` type

The `LeadSession` generic function type in `src/types.ts` is the interface
implemented by `src/opencode/sdk.ts` (written by the w3b-lead-plan worker). Task
files import it dynamically via a computed URL so typecheck passes before the
implementation exists.

### Environment variables

| Name | Default | Purpose |
|---|---|---|
| `AGENCYHQ_LEAD_VARIANT` | `"low"` | Passed as the `variant` hint to the Lead session |
| `AGENCYHQ_WORKTREE_BASE` | (required in production) | Base path for worktrees and run dirs |
## Lead plan task (`src/tasks/lead-plan.ts`)

Implements the `lead.plan` Trigger task (ADR-0006, R-005, R-020). The Lead is
a read-only planning role: it inspects the repository at `baseRevision` and
produces a structured PROPOSAL. The coordinator validates each proposal
deterministically against delegated authority before recording a Decision. The
Lead never calls the authority subset check and never writes a Decision.

### What the task does

1. Validates the payload with `LeadPlanPayloadSchema` (→ `AbortTaskRunError`
   on failure — not retried).
2. Creates a git worktree at `baseRevision` (`worktreeBase/lead/<id>-<runId>`).
3. Reads `AGENTS.md`, README head, and `git ls-files` (≤ 500 entries) from
   the worktree.
4. Builds a system context and user prompt via `buildLeadPlanPrompt` in
   `src/opencode/lead-prompt.ts`.
5. Calls `leadPrompt` (`src/opencode/sdk.ts`) which spawns `opencode serve`
   and sends ONE prompt with `format: { type: "json_schema" }`.
6. Parses the response with `LeadPlanOutputSchema`.
7. On parse failure → returns `{ kind: "invalid_output", reason }` (retriable).
8. Removes the Lead worktree in `finally` (read-only, disposable; run dir kept).

### OpenCode SDK integration (`src/opencode/`)

- `sdk.ts` — `leadPrompt<T>()`: spawns `opencode serve --port 0` with
  `OPENCODE_CONFIG`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_PURE=1`,
  `OPENCODE_PERMISSION` env vars; connects the v2 SDK client; creates a
  session; sends a single prompt; extracts `AssistantMessage.structured`.
  The SDK's `createOpencodeServer` cannot pass custom env vars (it only exposes
  `hostname`, `port`, `signal`, `timeout`, `config` in `ServerOptions`), so
  the server is spawned with `child_process.spawn` and the client connects to
  the reported URL.
- `structured.ts` — `extractStructured()`: isolates the `structured` field
  name (SDK drift risk). `parseWithSchema()`: uniform Zod-compatible parse
  result shape.
- `lead-prompt.ts` — `buildLeadPlanPrompt()`: deterministic prompt builder
  that labels operator intent as TRUSTED and repository text as UNTRUSTED.

### Probe script

`scripts/lead-probe.ts` runs the core against a real OpenCode server (once;
model `openai/gpt-5.6-sol`, variant `low`). Run with:

```
node --env-file=.env scripts/lead-probe.ts
```

## Running

### Task development (local)

```sh
pnpm --filter @agencyhq/trigger dev
```

This starts `trigger dev` connected to the Trigger.dev cloud (requires `.env` with `TRIGGER_API_URL` and `TRIGGER_SECRET_KEY`).

### Unit tests

```sh
pnpm --filter @agencyhq/trigger test
```

## `integrate.merge` task (`src/tasks/integrate-merge.ts`)

Implements R-015 and R-010: integrates an attempt commit into the coordinator-owned
clone and pushes to the remote. This is the **only** task that may push; adapter tasks
commit locally only (ARCHITECTURE.md lines 85-110).

- Task id: `integrate.merge`, `maxDuration: 300`, single-concurrency `integrate` queue,
  `retry: { maxAttempts: 1 }` (effectively no retry on failure).
- Validates the payload against `IntegrateMergePayloadSchema` from `@agencyhq/contracts`.
  Throws `AbortTaskRunError` for missing `repoPath` or invalid payload — not retried.
- Runs with the **host environment** (credential helper available for pushes), not the
  scrubbed worker env.  `GIT_TERMINAL_PROMPT=0` is added to every git call.
- Publishes phases `validating` → `setup` → `integrating` → `done` plus `outcome` to
  run metadata.

### Outcomes

| Outcome | Meaning |
|---|---|
| `integrated` | Merge commit pushed; `resultingRevision` is the merge SHA. |
| `already_integrated` | `attemptRevision` is already an ancestor of the remote ref. |
| `base_moved` | Remote ref advanced past `expectedBaseRevision` before this run; nothing pushed. |
| `conflict` | Merge produced content conflicts; `conflictingPaths` lists the affected files; nothing pushed. |
| `push_rejected` | Force-with-lease rejected; evidence records the classified failure kind (`lease_broken`, `auth`, `network`, or `other`) and a scrubbed stderr excerpt; `observedTargetRevision` holds the current remote SHA re-read after rejection. |

### Pure core (`src/tasks/integrate-merge-core.ts`)

Factors out every piece that does not need the Trigger SDK — no Trigger SDK import,
no direct child_process or fs calls:

- `IntegrateMergeDeps`: injected interface for `fetchRef`, `lsRemote`, `isAncestor`,
  `worktreeAdd`, `worktreeRemove`, `mergeInWorktree`, `pushForceWithLease`.
- `resolveMergeWorktreePath(runDir)`: `<runDir>/merge-wt`.
- `normalizeTargetRef(ref)`: strips a `refs/heads/` prefix from `ref` if present, so both `"main"` and `"refs/heads/main"` resolve to the same branch name. Applied to `payload.targetRef` at the start of `runIntegrateMerge` — the coordinator freezes the long form for single-repo contracts; manifests use the short form.
- `runIntegrateMerge(payload, deps, runDir)`: normalizes `targetRef` via `normalizeTargetRef`, then implements the full algorithm; always removes the merge worktree in `finally`; builds an `evidence` array of git commands run with their exit codes and, on failures, scrubbed stderr excerpts (first 500 chars, credentials redacted). On `push_rejected`, classifies the failure kind (`lease_broken`, `auth`, `network`, or `other`) from git stderr and re-reads the remote ref for `observedTargetRevision`.

### Git helpers (`src/lib/git.ts` — additive)

`fetchRef`, `lsRemote`, `isAncestor`, `mergeInWorktree`, `pushForceWithLease` — all
set `GIT_TERMINAL_PROMPT=0` on network-facing calls; never prompt for credentials.
`pushForceWithLease` returns `{ ok: true }` on success or `{ ok: false, kind, stderr }`
on failure (never throws for a non-zero exit); `kind` is one of `lease_broken`, `auth`,
`network`, or `other`, classified from git's stderr; `stderr` is the first 500 characters
with credentials scrubbed via `scrubCredentials`. `scrubCredentials` redacts
`https://user:token@` patterns and `Authorization:` header values.

### Invariants

- Only `integrate.merge` pushes to a remote; all other tasks commit locally (grep
  assertion in `test/push-boundary.test.ts`).
- `integrate-merge-core.ts` contains no Trigger SDK import (C5).
- The merge worktree is always removed in a `finally` block.
- Evidence lists commands with exit codes and does not include credential strings.

### Tests (`test/integrate-merge-core.test.ts`, `test/push-boundary.test.ts`)

Tests per the packet spec:
1. `merge_commit` happy path → `integrated`; remote advanced; merge commit has two parents.
2. `fast_forward` happy path → `integrated`; remote advanced to attempt SHA directly.
3. Base moved (concurrent push before run) → `base_moved`; nothing pushed.
4. Content conflict → `conflict`; `conflictingPaths` includes the file; nothing pushed; worktree removed.
5. Replay after success → `already_integrated`; remote unchanged.
6. Lease rejection (remote advances between fetch and push, injected via deps) → `push_rejected`;
   `observedTargetRevision` equals the new remote SHA.
7. Grep assertion: no file in `trigger/src` except `integrate-merge*` and `lib/git.ts`
   (and the known `lib/env.ts` dry-run check) contains `"push"`.

`test/git.test.ts` additionally tests `pushForceWithLease` structured failures:
stale lease → `kind=lease_broken`; unresolvable host → `kind=network` with stderr
excerpt; `scrubCredentials` removes `https://user:token@` credentials and
`Authorization:` header values.

### Tasks connected to the coordinator

Each task is imported by the coordinator and wired through static imports. The `verify.run` task uses `@agencyhq/verification` directly. The `lead.plan`, `lead.review`, and `lead.accept` tasks use `leadPrompt` from `trigger/src/opencode/sdk.ts`.

To run the full integration loop locally, start the coordinator with `RUNTIME=fake` and use the seed script to create a project and work item.
