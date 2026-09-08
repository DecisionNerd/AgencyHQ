# ADR-0005: Adopt self-hosted Trigger.dev as the execution runtime

- Status: Accepted
- Date: 2026-09-07
- Extends: ADR-0001 (names the runtime authority that ADR-0001 left implicit)
- Amends: ADR-0002 (Trigger.dev is the one infrastructure component admitted
  without a measured scaling requirement, for the reasons below)
- Implementation status: Slice 1 spike implemented; Slice 3 complete task adapters (`lead.plan`, `verify.run`, `lead.review`, `lead.accept`) and coordinator flow implemented. Qualified by the Slice 1 execution trial on 2026-09-07 (items 1–4 PASS), see [../trials/2026-09-slice1.md](../trials/2026-09-slice1.md); and by the Slice 3 trial on 2026-09-07 (items 1–3 PASS live, 4a PASS live, 4b/4c not exercised live, 5 PASS live, 6 PARTIAL — weakened-test path not exercised live and covered by deterministic tests, 7 PASS live), see [../trials/2026-09-slice3.md](../trials/2026-09-slice3.md). Rework re-check 2026-09-07: worker ruleset from the contract, stop path, and full flow re-verified live; see the [rework section](../trials/2026-09-slice3.md#rework-after-independent-review-1-2026-09-07). Rework-2 (2026-09-07): CANCELED/TIMED_OUT observations always routed to stop confirmation; uncertain-by-deadline wired via `AGENCYHQ_UNCERTAIN_AFTER_MS`; `stop.ndjson` fallback evidence; externally-cancelled attempts transitioned by coordinator before confirmation; no live run after 16002f2. Rework-3 (2026-09-07): `readStopEvidence` parses adapter `step`/`checkpointCommit` fields; `cancelSkipped` when `runtime.cancel` throws on an already-final run; status guards on completion/quarantine/failure updates; `AGENCYHQ_UNCERTAIN_AFTER_MS` confirmed on both confirmation paths; coordinator binds `AGENCYHQ_BIND_HOST` (default `127.0.0.1`), no auth, bearer auth deferred; model resolved from payload then `AGENCYHQ_OPENCODE_MODEL`, missing model is setup failure; no live run after 16002f2. Rework-4 (2026-09-08): reconciler routes any `stopping`+final-run to `confirmStop` (COMPLETED included); dead worker-final `stopping` branch removed; `flow.stop (CR-2)` test rewritten as CR-2a/CR-2b; deadline applies only on reconciler's confirmation route; db insert types require NOT NULL columns; no live run after 16002f2.

## Context

The baseline treated Trigger.dev as "durable invocation, retry, scheduling,
waits" and assigned isolation, hard limits, termination, and dispatch
deduplication to an unnamed "runtime" or to coordinator code that did not yet
exist. That left the enforcement boundaries without an owner and left AgencyHQ
on a path to reimplement a queue, a lease manager, a process runner, and a
realtime feed.

The operator's working setup is also a constraint: OpenCode is configured and
authenticated on the host machine, some providers through interactive
subscription logins whose credentials live in
`~/.local/share/opencode/auth.json`, and the operator wants attempts to be Git
worktree folders they can open, not throwaway clones.

Self-hosted Trigger.dev v4 was reviewed against its published documentation on
2026-09-07. The relevant facts:

- Runs have a durable lifecycle (queued, dequeued, executing, waiting, and the
  final states completed, failed, canceled, timed out, crashed, system failure,
  expired), attempts with configurable retry/backoff, a hard `maxDuration`,
  and queue TTL.
- `runs.cancel` stops a run and its in-progress child runs; the run receives an
  `AbortSignal` and an `onCancel` hook with a bounded grace period.
- Trigger-time `idempotencyKey` (global scope, configurable TTL) returns the
  original run handle for a duplicate trigger; keys clear on failure and are
  retained on success or cancellation.
- Queues with `concurrencyLimit` and a per-trigger `concurrencyKey` serialize
  work per key; the environment concurrency limit bounds parallel runs.
- Tags, metadata (256 KB, updatable from inside the run), run output (10 MB),
  and Realtime (backend subscriptions and React hooks backed by Electric SQL)
  expose run state without custom websocket or polling code.
- Two execution profiles exist. **Deployed**: the self-hosted supervisor runs
  each run in its own Docker container on a worker machine with machine-preset
  CPU/RAM limits, no host networking, and automatic container removal.
  **Dev** (`trigger dev`): the CLI on a machine runs each task as a separate
  Node process on that machine, with its filesystem and environment.
- The self-hosted stack does **not** provide checkpoints: a waiting run keeps
  its process or container and its concurrency slot. Warm starts and
  autoscaling are Cloud-only. The webapp stack is webapp, Postgres, Redis,
  Electric, registry, object storage, and a Docker socket proxy; the worker
  stack (supervisor plus containers) is needed only for the deployed profile.

## Options considered

| Option | Benefit | Reason for decision |
| --- | --- | --- |
| Postgres-backed job queue plus a hand-written process runner | No extra services. | Rejected: AgencyHQ would own run lifecycle, cancellation, heartbeats, retries, log capture, and a realtime feed — plumbing Trigger already has. |
| Trigger deployed profile: every run in a container with a fresh clone | Strongest isolation and clean termination. | Deferred: requires API-key providers in every container, discards the host OpenCode setup, and replaces worktree folders with clones. Kept as the hardening profile. |
| Trigger dev profile on the host where OpenCode is configured | Uses the host's OpenCode auth and config and real worktree folders; keeps queues, retries, cancel, Realtime, dashboard; needs only the webapp stack. | Selected for slices 1–3 as the **host runtime profile**, with enforcement declared honestly (below). |

## Decision

Trigger.dev is the **execution runtime**. It is trusted for execution
mechanics — run lifecycle, attempts, `maxDuration`, cancellation and its
`onCancel` grace, queue serialization, idempotent dispatch, run status — and
never for domain truth: a run's success is an observation, not acceptance.

AgencyHQ defines **runtime profiles**. Each profile declares which enforcement
boundaries it provides before action, which only on output, and which are
advisory. A StepContract names the boundaries it requires; dispatch rejects a
contract on a profile that cannot provide them.

**Host profile (slices 1–3).** `trigger dev` runs on the machine where OpenCode
is configured (the operator's workstation or a dedicated box with the same
setup). Each task is a Node process on that machine. The task adapter creates
a Git worktree per attempt under a coordinator-owned base folder, spawns
OpenCode as a child process group in that worktree with a scrubbed
environment, and on cancel terminates the process group. Provides: process
termination, `maxDuration`, per-repository serialization, retries, run status,
Realtime. Does not provide: filesystem isolation, CPU/RAM limits, or egress
control. Declared honestly in the enforcement table.

**Container profile (later).** The deployed self-hosted supervisor with a task
image carrying pinned Git and OpenCode; fresh clone per run; API-key providers
only; attempt refs pushed with a generation-bound token. Provides everything
the host profile does plus filesystem isolation, resource limits, and
credential-free workers.

Common to both:

1. Every unit of work — Lead decision, worker attempt, verification, review,
   integration — is one Trigger run.
2. Dispatch uses a coordinator-recorded intent as the global `idempotencyKey`.
3. Repository serialization uses `concurrencyKey` = repository id with limit 1.
4. Hard duration is Trigger's `maxDuration` from the contract.
5. Termination is confirmed by Trigger's final run status after `runs.cancel`,
   plus the adapter's own confirmation that the child process group is gone.
6. The coordinator observes runs by tag through Realtime and the management
   API; attempt reports are run output; the UI uses Trigger's React hooks.
7. No run waits on a human or a Lead; decisions happen between runs.
8. Trigger's dashboard is the raw-log surface.

Provider authentication: workers may use whatever the host's OpenCode is
authenticated with, but the Project's `models` allowlist records which
providers attempts may use. Subscription logins are host-bound and, for
Anthropic Pro/Max, prohibited for third-party tools by the provider; the
documented expectation is API-key or cloud-credential providers for worker
volume, with subscription logins limited to what their terms allow.

AgencyHQ pins the Trigger image tag, SDK/CLI, and OpenCode versions together
and reruns the execution trial when any changes.

## Consequences

- The coordinator keeps the ledger, authority checks, and dispatch intents; it
  owns no queue, scheduler, process runner, or realtime layer.
- Slices 1–3 need only the Trigger webapp stack plus `trigger dev` on the host.
  Dev mode is not Trigger's production path: the CLI must stay running and
  queued runs should carry an explicit `ttl`. That is accepted for a single
  operator.
- On the host profile, a worker process shares the machine's filesystem and
  can read host files, including OpenCode's credential store. Contracts that
  require isolation are rejected on this profile rather than pretended.
- "Supervisor" is a Trigger.dev component name; AgencyHQ's decision role is
  the **Lead** (ADR-0006).
- If the Slice 1 trial shows the host profile cannot meet the stop and
  boundary contract, this ADR is superseded with the trial as evidence.
