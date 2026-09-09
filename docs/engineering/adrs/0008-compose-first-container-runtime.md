# ADR-0008: Make Compose and disposable task containers the default runtime

- Status: Accepted
- Date: 2026-09-08
- Decider: Project owner
- Supersedes: ADR-0005's host-first deployment choice and API-key-only container restriction; ADR-0007's host-only worktree and provider-auth placement. Their authority, acceptance, and worker-effect rules remain in force.
- Implementation status: Packaging, bootstrap and task image implemented on branch epic-14 (issues #15, #16); L1 live evidence 2026-09-09 in docs/engineering/trials/2026-09-compose.md (C1 and C2 partial on one linux/arm64 host). Provider login, portable artifacts, capacity and the operator journey (#17–#20) not started; not qualified. The host profile remains the runnable fallback.
- Requirements: R-003, R-012, R-013, R-016, R-021 through R-025.

## Context

The current onboarding requires Node, pnpm, separate database startup, a web
build, coordinator configuration, manual Trigger bootstrap, and a long-running
host `trigger dev` process. The operator asked for one Compose startup command,
provider login through OpenCode, and repeatable worker containers.

The Slice 6 container trial ran `spike.echo`; it did not run a coding attempt.
OpenCode and pnpm were unavailable on PATH. Task payloads still carry host
repository/worktree paths, and stop confirmation can read a host-local
`stop.ndjson`. Those assumptions prevent later stages from moving freely
between disposable containers. Mounting a volume on the Trigger supervisor
container does not by itself mount it in dynamically created task containers.

## Options considered

| Option | Benefit | Cost / disposition |
| --- | --- | --- |
| Keep documenting the host setup | Uses the exercised host path. | Retains onboarding toil and machine-specific execution; fallback only. |
| Put `trigger dev` in a persistent Compose service | Packages the existing process runner. | Retains dev-mode lifecycle and shared-path assumptions; does not qualify disposable runs or worker replication. Not the default target. |
| Compose-managed services with Trigger's deployed task containers | One local entry point, repeatable images, independent capacity, disposable execution. | Requires bootstrap, provider-auth persistence, portable source/artifacts, and recovery evidence. Selected. |

## Decision

### Operator contract

From a fresh checkout with Git, Docker, Docker Compose, and a browser available:

```sh
docker compose up -d
docker compose exec opencode opencode auth login
```

These commands specify the intended interface; no root Compose file or
`opencode` service exists yet. The first command builds or obtains the pinned
images, generates and persists internal credentials, starts all services,
applies migrations, bootstraps the Trigger project and worker registration,
and builds/deploys/registers the task image as needed. Repeating it reuses
existing state and reconciles missing setup without rotating valid secrets
or duplicating projects. A failed bootstrap is visible and safely resumable.

The second command is first-use or expired-credential setup, not part of every
startup. Provider selection and interactive/API-key login use OpenCode's own
flow. The operator completes any browser or device authorization locally;
credentials and one-time URLs never need to be pasted into AgencyHQ or chat.
No host Node, pnpm, OpenCode, `trigger dev`, manual SQL, dashboard token copying,
or networking workaround is required for the default path. An optional host
profile may reuse a host OpenCode installation; its prerequisites and weaker
enforcement remain explicitly documented.

The UI starts even when providers are unconfigured. It distinguishes services
starting, setup failed, provider login required, worker unavailable, and ready
for work, and shows the action needed. A healthy HTTP endpoint alone does not
mean coding execution is ready. Repository linking and authority setup must be
available through the shipped operator flow without database seeding or SQL.

### Runtime and state

| Part | Lifetime and responsibility |
| --- | --- |
| AgencyHQ web + coordinator | One application service; domain policy and acceptance remain here. |
| AgencyHQ Postgres | Persistent domain ledger, separate from Trigger's database. |
| Trigger webapp stack | Persistent execution services, including its backing stores, registry, and object storage. |
| Trigger worker stack | Deployed Trigger supervisor and its Docker socket proxy; creates and manages per-run task containers. |
| OpenCode setup service (`opencode`) | Stable interactive login surface with persistent provider state; no new provider adapter or coding-agent loop. |
| Task image | Pinned compatible Node, pnpm, Git, OpenCode, and Trigger tooling, executable as the actual task user. |
| Task container | One run, isolated checkout/worktree, bounded lifetime. No requirement to retain or revisit this container. |
| Durable artifacts | Attempt/checkpoint Git objects, manifests, verification/review evidence, and stop evidence retained beyond container deletion. |

Use persistent volumes for local durable state. Recreating containers and
`docker compose down` preserve it; data deletion is an explicit operation.
No personal home directory, Docker socket, application database credentials,
or source-control push credential is mounted into coding containers by default.
The Docker socket is restricted to the trusted Trigger worker machinery.

### Provider authentication

Provider authentication is configured once through OpenCode and survives setup
service recreation. Every new task container can use the selected authorized
provider without a new interactive login. Provider credentials are distinct
from source-control read/integration credentials and Trigger control credentials.
Only OpenCode performs provider-specific authentication and model calls.

The implementation must explicitly wire authentication into the actual task
containers and test read/write and refresh semantics. A shared setup volume
alone is insufficient. Resolve concurrent refresh/logout, avoid a shared mutable
OpenCode session database across tasks, and expose readiness without secrets.
Support API-key providers and provider-supported interactive login flows; qualify
each claimed flow inside the container, including browser/device callbacks.
Do not promise every provider/login method is portable before testing it.

This decision does not claim model credentials are inaccessible to a worker
with shell access. Declare the selected credential exposure in the runtime
profile. A provider gateway, hard spend enforcement, and per-attempt provider
keys are separate hardening work, not prerequisites for Compose onboarding.

### Source, artifacts, and effects

Task inputs identify the project, immutable source revision, contract/version,
attempt/generation, and authorized artifact references; host absolute paths are
not a transport protocol. Each stage materializes a fresh isolated checkout
and verifies the requested Git revision. Verification and review must be able
to run on a different worker from the coding attempt, including multi-repo
revision manifests.

The trusted adapter commits and exports attempt/checkpoint objects to durable
storage under attempt-scoped authority. The coordinator validates identity,
generation, revisions, digests, and evidence before admitting those objects as
domain evidence. A model's success report or uploaded archive is not trusted
proof. Transport may use Git objects/bundles or the existing object store;
choose the smallest mechanism that preserves Git identity and avoids a new
orchestration service. Imported source and archives must be path-validated.

Coding agents hold no upstream push/merge/publish/deploy credentials. Only the
coordinator-dispatched integration task may advance shared refs, after exact
acceptance and required approval, with repository-scoped authority and
compare-and-set. Private-repository read access and integration authentication
must have usable setup flows, independent of provider login.

### Capacity and recovery

Trigger creates task-container replicas from the same registered image as
eligible concurrency grows. Adding worker capacity reuses registration and
provider setup; it must not require manually cloning or authenticating each
disposable task container. Same-host parallel execution is the initial proof;
a second worker host must be qualified before claiming multi-machine support.
Coordinator rank, repository serialization, provider capacity, budgets, and
worker-slot limits remain binding. More containers cannot bypass those gates.

Before replacement: revoke/fence the generation, request cancellation, obtain
trusted confirmation that the old execution has terminated or is effectively
isolated, and reconcile any integration effect. Preserve available checkpoints
and cancellation evidence outside the container. Abrupt loss may make the
latest unexported edits unrecoverable; report this explicitly. Missing heartbeat,
missing files, or a Trigger final status alone never proves termination.
Retired generations may contribute historical evidence but cannot advance state.

## Consequences and qualification

- Startup becomes a product capability with repeatable first-use and restart tests.
- Host-path payloads, local Git reads, local stop-file reads, retention, profile selection, credential delivery, and task-image registration require implementation/refactoring.
- Existing volumes and host-profile projects are preserved; migration/import must be explicit and reversible. Do not silently relabel host paths or grant stronger runtime capabilities.
- The deployed profile becomes the documented default only after the [Compose qualification scenarios](../TESTING.md#compose-runtime-qualification) pass on the exact revision/image set. Keep unproved boundaries advisory or unavailable and reject contracts that require them.
- Container transport does not weaken Lead/coordinator ownership of definition of done, acceptance, generation fencing, or integration effects.

## Sources and evidence

- [Slice 6 trial](../trials/2026-09-slice6.md): historical container smoke and toolchain gaps.
- [Trigger Docker deployment](https://trigger.dev/docs/self-hosting/docker) and [supervisor settings](https://trigger.dev/docs/self-hosting/env/supervisor), read 2026-09-08: deployed worker and task-container lifecycle.
- [Pinned Trigger Docker workload manager](https://github.com/triggerdotdev/trigger.dev/blob/v4.5.16/apps/supervisor/src/workloadManager/docker.ts), read 2026-09-08: task-container creation has its own configuration; supervisor mounts are not inherited.
- [OpenCode CLI authentication](https://opencode.ai/docs/cli/#auth), read 2026-09-08: provider login and persisted authentication managed by OpenCode.
