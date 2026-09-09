# AgencyHQ

AgencyHQ helps you coordinate AI coding agents across your repositories.
Describe a repair, set the scope and permissions, and follow the work from
planning through verification, review, and acceptance. Use the web interface
to see progress, inspect evidence, resolve decisions, and approve changes.

Work stays tied to Git revisions and reproducible evidence. You can organize
work into campaigns, prioritize across projects, and return after an
interruption to see what changed and what needs your attention.

AgencyHQ is under active development and runs from source. The current
implementation includes bounded repairs, merge integration, work spanning
multiple repositories, an operator dashboard, and capacity-aware scheduling.
Real coding runs use the host runtime profile; container execution remains
partially qualified. See the [roadmap](docs/strategy/roadmap.md) for progress
and recorded trial limitations.

## Installation and quick start target

The accepted installation experience is:

```sh
git clone https://github.com/DecisionNerd/AgencyHQ.git
cd AgencyHQ
docker compose up -d
docker compose exec opencode opencode auth login
```

**Implemented on branch `epic-14`; qualification pending.** The root
`compose.yaml`, `opencode` service, `bootstrap` container, and task image build
are implemented and were exercised in L1 (2026-09-09, linux/arm64 Docker
Desktop, one host): fresh install, image build and registration, restart with
volumes untouched, and interrupted bootstrap recovered without duplicate
org/project/token. Provider login and real repair have not yet been exercised;
qualification C1–C7 (multi-platform, provider lifecycle, real repair, artifact
integrity, capacity, stop/loss) is pending. See [trial record](docs/engineering/trials/2026-09-compose.md).

Only Git and Docker with Compose are required on the host. Docker builds and
starts the full stack, runs migrations, configures internal credentials,
bootstraps Trigger, and registers the worker image. OpenCode handles first-use
provider login; authentication and project data survive restarts.

`/api/readiness` returns `provider` and `worker` as `"unknown"` until issues
#17 and #19 supply real data; a `nextAction` sentence describes what to do.

See [ADR-0008](docs/engineering/adrs/0008-compose-first-container-runtime.md)
for the specification and the [implementation roadmap](docs/strategy/roadmap.md#compose-first-container-runtime)
for tracked work. The host setup below remains the runnable fallback.

## Current installation (host fallback)

You will need:

- Git.
- Node.js 24 or newer.
- pnpm 11 (the repository pins version 11.25.0).
- Docker with Docker Compose for the local PostgreSQL database.

Clone the repository and install its dependencies:

```sh
git clone https://github.com/DecisionNerd/AgencyHQ.git
cd AgencyHQ
pnpm install
cp .env.example .env
```

If you already have a checkout or `.env`, keep it and update the settings as
needed. In `.env`, set a writable location for worktrees:

```dotenv
AGENCYHQ_WORKTREE_BASE=/tmp/agencyhq-worktrees
```

Keep `RUNTIME=fake` for the local walkthrough below. The supplied database
URL uses `127.0.0.1:5434`, matching the bundled Compose configuration. The
model settings can stay at their defaults for this walkthrough; it does not
require OpenCode, model credentials, or Trigger.dev.

## Current local walkthrough (fake runtime)

Run these commands from the repository root with Docker running:

```sh
docker compose -f infra/db/compose.yaml up -d --wait
pnpm --filter @agencyhq/web build
WEB_DIST="$PWD/apps/web/dist" RUNTIME=fake pnpm --filter @agencyhq/coordinator start
```

The coordinator applies database migrations on startup and serves the web
interface at [http://127.0.0.1:8787](http://127.0.0.1:8787). The `WEB_DIST`
override gives it the absolute path to the built interface. A new database
opens with an empty overview.

To explore a populated dashboard, run the following in a second terminal
from the repository root, then refresh the page:

```sh
node --env-file=.env apps/coordinator/scripts/seed-control-plane.ts
```

This loads the browser-test sample campaign, projects, work items, evidence,
and pending decisions into your local database. Use it with the fake runtime
for a walkthrough. Each run creates a fresh sample project and expires
pending decisions from earlier sample projects.

- Open a work item to inspect its contract, execution, verification,
  acceptance, and integration state.
- Open **Decisions** to review pending approvals and their supporting evidence.
- Open the return view at
  [/#/return](http://127.0.0.1:8787/#/return) to see changes and attention items.

The fake runtime lets you explore the interface and stored sample evidence;
it does not run coding agents or carry out real repairs. The local default
binds to loopback without an API token. To enable token authentication, set
`AGENCYHQ_API_TOKEN` in `.env`, restart the coordinator, and enter that token
when the web interface prompts for it.

Stop the coordinator with Ctrl+C. To stop PostgreSQL while keeping its data:

```sh
pnpm db:down
```

### Current real execution (host profile)

Real execution additionally requires a self-hosted Trigger.dev instance,
OpenCode configured with access to your chosen models, and a local clone of
the repository you want AgencyHQ to work on.

1. Follow the [Trigger.dev setup](infra/trigger/README.md) to start the stack
   and configure its project and credentials.
2. Configure the [task adapters](trigger/README.md) and keep
   `pnpm trigger:dev` running on the OpenCode host.
3. Set `RUNTIME=real`, `TRIGGER_API_URL`, and `TRIGGER_SECRET_KEY` in the root
   `.env`, and choose the worker, Lead, and reviewer models.
4. Follow the [coordinator guide](apps/coordinator/README.md#seeding-a-project-for-local-work)
   to register a repository and repair intent. Start the coordinator with
   `WEB_DIST="$PWD/apps/web/dist" pnpm --filter @agencyhq/coordinator start`
   so it uses the runtime selected in `.env`.

The [coordinator guide](apps/coordinator/README.md) also documents commands,
authority settings, scheduling, and authentication.

## System boundary

| Concern | Authority |
| --- | --- |
| Intent, delegated authority, contracts, decisions, evidence, acceptance | AgencyHQ coordinator, recorded in AgencyHQ Postgres |
| Engineering judgment: definition of done, review, acceptance proposals | The Lead — OpenCode sessions in a read-only agent, validated by the coordinator |
| Execution: queues, isolation, limits, retries, cancellation, run status, logs, realtime | Self-hosted Trigger.dev |
| Coding-agent execution and model/provider abstraction | OpenCode |
| Code, branches, commits, diffs | Git; attempt and checkpoint refs committed locally by task adapters; shared refs pushed only by integration tasks |

Trigger.dev is trusted for how work runs and whether it is still running. It is
never trusted for whether work is done. OpenCode is the agent runtime, not the
coordinator. Coding agents hold no upstream push, merge, publish, or deploy
credentials; provider access goes through OpenCode. Only integration tasks
advance shared refs after acceptance.

## Repository map

```text
apps/
  web/              React/TypeScript operator control plane
  coordinator/      ledger, authority checks, dispatch intents, token issuance
packages/
  domain/           domain types, invariants, transitions, authority subset checks
  contracts/        versioned schemas for contracts, task payloads, reports, proposals
  db/               Postgres schema, migrations, repositories
  verification/     verification profiles and result construction
trigger/             Trigger.dev task adapters and the pinned task image
infra/trigger/       self-hosted Trigger.dev compose and environment notes
docs/
  PRODUCT.md         purpose, users, scope
  DESIGN.md          operator experience principles
  REQUIREMENTS.md    testable baseline requirements
  experience/        operator journey and discovery evidence
  strategy/          roadmap
  engineering/       architecture, domain, execution, testing, ADRs
```

Each package includes implementation and boundary notes. The
[documentation index](docs/README.md) links to the product, architecture,
requirements, and operating contracts.

## Baseline check

```sh
pnpm check
```

The check fails if required records disappear, internal Markdown links break,
unfinished template guidance remains, or the current ADRs stop naming the
authorities above.

## Working rules

- Start work from a frozen StepContract validated against delegated authority.
- Every attempt is one Trigger run in its own Git worktree folder.
- Worker output is a proposal on an attempt branch; verification and review
  run separately; only the coordinator records acceptance.
- Stop means revoke the generation, cancel the run, checkpoint the worktree,
  confirm the process group is gone, and wait for a final status.
- Add infrastructure only when a concrete requirement earns it; Trigger.dev is
  the one exception, adopted so AgencyHQ does not own execution plumbing.

See [ADR-0005](docs/engineering/adrs/0005-trigger-as-execution-runtime.md),
[ADR-0006](docs/engineering/adrs/0006-lead-role-and-delegated-authority.md), and
[ADR-0007](docs/engineering/adrs/0007-worker-effect-model.md) for the 2026-09-07
revision.

## Development

After installation, run the repository checks and tests:

```sh
pnpm check
pnpm test
pnpm db:up
DATABASE_URL=postgres://agencyhq:agencyhq@127.0.0.1:5434/agencyhq_test pnpm test:integration
```

For live UI development, keep the coordinator running and start
`pnpm --filter @agencyhq/web dev` in another terminal. Open the URL printed
by Vite; it proxies `/api` requests to the coordinator on port 8787. See the
[web guide](apps/web/README.md) for build and browser-test details.
