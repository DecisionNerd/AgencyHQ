# Self-hosted Trigger.dev webapp stack

> Deployment direction: [ADR-0008](../../docs/engineering/adrs/0008-compose-first-container-runtime.md) makes root Compose startup,
> persistent OpenCode login, and disposable deployed task containers the default
> target. Packaging and bootstrap are implemented on branch `epic-14` (L1,
> 2026-09-09). The procedures below describe the host fallback; container-profile
> startup uses the root `compose.yaml` instead.

This folder holds the self-hosted Trigger.dev **webapp stack** for
AgencyHQ's host runtime profile ([ADR-0005](../../docs/engineering/adrs/0005-trigger-as-execution-runtime.md),
[ARCHITECTURE.md § Deployment shape](../../docs/engineering/ARCHITECTURE.md)):
one Docker Compose file that runs the Trigger.dev webapp and its backing
services, with `trigger dev` kept running separately on the operator's
workstation (or a dedicated host with the same OpenCode setup) to execute
runs. Nothing here is provisioned by these files alone — they describe what
gets created once an operator runs the commands below.

## What's in this folder

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The webapp stack: `webapp`, `postgres`, `redis`, `electric`, `clickhouse`, `registry`, `minio`, and the `s2`/`s2-init` pair (self-hosted Realtime streams v2). Vendored from upstream Trigger.dev v4.5.16 with a small set of edits — see `UPSTREAM.md`. |
| `docker-compose.worker.yml` | The trigger worker stack overlay (container profile): `supervisor` and `docker-proxy`. Used as an overlay with `docker-compose.yml` — see "Worker stack (container profile)" below. Vendored from upstream Trigger.dev v4.5.16 with a small set of edits — see `UPSTREAM.md`. |
| `.env.example` | Every environment variable the compose files read, with pinned image-tag defaults and blank secrets. Copy this to `.env` before starting anything. |
| `scripts/gen-env.sh` | Creates `.env` from `.env.example` if missing, and fills every blank secret with `openssl rand -hex 16`. Safe to re-run: it never overwrites a secret that already has a value. |
| `scripts/bootstrap.sh` | Signs into the running dashboard (dev-mode magic link), finds or creates an org and project, mints a Personal Access Token, and writes `trigger/.env` — see "Bootstrap" below. |
| `UPSTREAM.md` | Upstream source URLs, the date they were read, and every edit made vs. the vendored files, with a reason for each. |

## Service list

| Service | Image (pinned via `.env`) | Host port(s) | Qualified by |
| --- | --- | --- | --- |
| `webapp` | `ghcr.io/triggerdotdev/trigger.dev:${TRIGGER_IMAGE_TAG}` | `8030` (→ container `3000`) | [Slice 1 trial](../../docs/engineering/trials/2026-09-slice1.md) (2026-09-07) |
| `postgres` | `postgres:${POSTGRES_IMAGE_TAG}` | `5433` (→ container `5432`) | same trial |
| `redis` | `redis:${REDIS_IMAGE_TAG}` | `6389` (→ container `6379`) | same trial |
| `electric` | `electricsql/electric:${ELECTRIC_IMAGE_TAG}` | none published | same trial |
| `clickhouse` | `clickhouse/clickhouse-server:${CLICKHOUSE_IMAGE_TAG}` | `9123` (HTTP), `9090` (native) | same trial |
| `registry` | `registry:${REGISTRY_IMAGE_TAG}` | `5001` (→ container `5000`; host `5000` is macOS AirPlay Receiver — see Notes) | same trial |
| `minio` | `bitnamilegacy/minio:${MINIO_IMAGE_TAG}` | `9000` (S3 API), `9001` (console) | same trial |
| `s2-init`, `s2` | `busybox:${BUSYBOX_IMAGE_TAG}`, `${S2_IMAGE}` (digest-pinned) | none published | same trial |

All host ports above are bound to `127.0.0.1` (or `${WEBAPP_PUBLISH_IP}` for
the webapp) by the defaults in `.env.example`, so nothing here is reachable
off the host.

The AgencyHQ coordinator API (default port 8787, bound to
`AGENCYHQ_BIND_HOST` which defaults to `127.0.0.1`) runs on the same host
supports bearer authentication through `AGENCYHQ_API_TOKEN`. Non-loopback
binding without a token fails closed. The Compose target must wire internal
and operator authentication without manual dashboard token copying.

## Operator procedure

Run these from the repository root.

1. Generate secrets:

   ```sh
   sh infra/trigger/scripts/gen-env.sh
   ```

   This copies `infra/trigger/.env.example` to `infra/trigger/.env` (if it
   doesn't already exist) and fills every blank secret. It prints only the
   variable names it filled, never the values.

2. Start the stack:

   ```sh
   docker compose -f infra/trigger/docker-compose.yml --env-file infra/trigger/.env up -d
   ```

3. Watch the webapp logs for the magic-link sign-in URL. No `EMAIL_TRANSPORT`
   is configured in `.env.example`, so the webapp logs the magic link instead
   of emailing it:

   ```sh
   docker compose -f infra/trigger/docker-compose.yml --env-file infra/trigger/.env logs -f webapp
   ```

4. Check service status:

   ```sh
   docker compose -f infra/trigger/docker-compose.yml --env-file infra/trigger/.env ps
   ```

5. Stop the stack:

   ```sh
   docker compose -f infra/trigger/docker-compose.yml --env-file infra/trigger/.env down
   ```

   `down -v` also deletes the named volumes (Postgres data, ClickHouse data,
   MinIO buckets, Redis data) — only use it when starting over is intended.

### Dashboard: create an org and project

Once the webapp is reachable at `http://localhost:8030` and a magic link has
been used to sign in:

1. Create an organization.
2. Create a project inside it.
3. From the project's environment settings, copy the **project ref**
   (`proj_…`) and the **Dev API key** (`tr_dev_…`).
4. Paste both into `trigger/.env` (see [`trigger/README.md`](../../trigger/README.md)
   for the exact variable names that consumes).

### Bootstrap

`scripts/bootstrap.sh` automates the sign-in-and-create steps above (dev-mode
magic-link login, org, project, Dev API key, and Personal Access Token) and
writes the results into `trigger/.env`, modeled on how a sibling project
automates the same dashboard bootstrap.

It requires `infra/trigger/.env` to have dev-mode login enabled — set
`NODE_ENV=development`, `APP_ENV=development`, and `ADMIN_EMAILS` (see the
"Dev-mode local login" section of `.env.example`) and (re)start the webapp
with them before running the script. Those three variables make the webapp
print the magic link to its own container logs instead of emailing it, and
restrict sign-in to the one bootstrap address — they are for a local,
single-operator dashboard only and must not be set on a shared deployment.

```sh
sh infra/trigger/scripts/bootstrap.sh --dry-run   # print the plan, write nothing
sh infra/trigger/scripts/bootstrap.sh             # sign in and bootstrap for real
```

The script finds an existing org/project by slug prefix before creating one,
so re-running it is safe. It never prints a token or key value — only the
variable names it wrote and the org/project slugs. Run
`sh infra/trigger/scripts/bootstrap.sh --help` for the full flag list
(`--org`, `--project`, `--email`, `--env-file`, `--token-name`).

### CLI login

`trigger dev` runs on the host, outside this compose stack, and authenticates
against the webapp above:

```sh
pnpm dlx trigger.dev@4.5.16 login -a http://localhost:8030 --profile agencyhq-local
```

## macOS notes

- **Port 5000 is taken by AirPlay Receiver.** macOS's built-in AirPlay
  Receiver listens on port 5000, which is the upstream default for the
  bundled registry. This stack publishes the registry on `5001` instead
  (container port stays `5000`) — see `UPSTREAM.md` for the exact edit.
- **Docker Desktop's socket is a symlink**, not a raw Unix socket file, on
  macOS. This matters only for a container that bind-mounts
  `/var/run/docker.sock` — the bundled `docker-socket-proxy` and Trigger's
  supervisor belong to the worker stack, not this host profile, so nothing
  here touches the Docker socket.
- **No `host.docker.internal` needed.** `trigger dev` runs directly on the
  host (not inside a container) and dials out to `http://localhost:8030`,
  which Docker Desktop already publishes to the host's loopback interface.
- **ClickHouse memory on Docker Desktop.** ClickHouse wants a meaningful
  slice of the Docker Desktop VM's memory allocation to start reliably;
  under-provisioning the VM (Settings → Resources) is a common cause of a
  `clickhouse` container that restarts on startup.

## Worker stack (container profile)

The worker stack is the trigger worker stack for the container profile
([ADR-0005](../../docs/engineering/adrs/0005-trigger-as-execution-runtime.md)):
each task run executes in its own Docker container managed by the trigger.dev
supervisor, using a task image built with `trigger deploy`.

### Services

| Service | Image | Purpose |
| --- | --- | --- |
| `supervisor` | `ghcr.io/triggerdotdev/supervisor:${TRIGGER_IMAGE_TAG}` | Trigger.dev worker stack container: dequeues runs from the webapp and launches task containers via the Docker socket proxy. |
| `docker-proxy` | `tecnativa/docker-socket-proxy:${DOCKER_PROXY_IMAGE_TAG}` | Exposes a filtered Docker API over TCP so the trigger worker stack container can manage task containers without direct socket access. |

### Starting the worker stack

Run the webapp stack first (see "Operator procedure" above), then add the
trigger worker stack container as an overlay:

```sh
docker compose \
  -f infra/trigger/docker-compose.yml \
  -f infra/trigger/docker-compose.worker.yml \
  --env-file infra/trigger/.env \
  up -d supervisor docker-proxy  # trigger worker stack services only
```

The `supervisor` and `docker-proxy` services above refer to the trigger worker
stack services defined in `docker-compose.worker.yml`.

### Worker token

The webapp bootstraps a worker group on startup and writes the token to the
shared volume at `/home/node/shared/worker_token`. The trigger worker stack
container reads it via:

```
TRIGGER_WORKER_TOKEN=file:///home/node/shared/worker_token
```

To use a token created manually in the Trigger dashboard (Trigger → Worker
groups) instead, set `TRIGGER_WORKER_TOKEN` in `.env` (see `.env.example`
for the commented line).

### Registry login

Before deploying a task image, log in to the bundled registry:

```sh
docker login localhost:5001 -u registry-user
```

Enter the value of `DOCKER_REGISTRY_PASSWORD` from `.env` when prompted. Never
print the password value directly.

### Deploying task images

Run from `trigger/`:

```sh
pnpm exec trigger deploy \
  --local-build \
  --skip-promotion \
  --profile agencyhq-local \
  --log-level info
```

Pass `--dry-run` to build the image locally without pushing or deploying —
useful to confirm the image builds before connecting to a live instance.

Non-interactive authentication uses `TRIGGER_ACCESS_TOKEN` and `TRIGGER_API_URL`
(https://trigger.dev/docs/cli-deploy, read 2026-09-08).

### macOS / Docker Desktop open questions (not yet observed)

- **Docker socket bind mount**: `docker-proxy` bind-mounts
  `/var/run/docker.sock`, which on Docker Desktop for macOS is a symlink
  rather than a raw Unix socket. Whether this bind mount works transparently
  for the trigger worker stack container has not been tested.
- **Registry access from containers**: whether task containers spawned by the
  trigger worker stack container can pull from `localhost:5001` (a host-side
  port) without additional Docker Desktop networking configuration is not yet
  known.

### Pinned versions (worker stack)

| Component | Version | Status |
| --- | --- | --- |
| `ghcr.io/triggerdotdev/supervisor` | `v4.5.16` (via `TRIGGER_IMAGE_TAG`) | connected to the trigger.dev platform and ran spike.echo in a container 2026-09-08 (Slice 6 spike) |
| `tecnativa/docker-socket-proxy` | `v0.5.0` (via `DOCKER_PROXY_IMAGE_TAG`) | connected to the trigger.dev platform and ran spike.echo in a container 2026-09-08 (Slice 6 spike) |

## Pinned versions

| Component | Version | Status |
| --- | --- | --- |
| Trigger.dev webapp image | `v4.5.16` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| Trigger.dev SDK/CLI | `4.5.16` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `postgres` | `14` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `redis` | `7` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `electricsql/electric` | `1.2.4` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `clickhouse/clickhouse-server` | `26.2` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `registry` | `2` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `bitnamilegacy/minio` | `2025.5.24-debian-12-r5` | exercised in the L1 Compose trial (2026-09-09, linux/arm64): [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09) |
| `busybox` (s2-init) | `1.37` | pending: not listed in the L1 trial digests |
| `ghcr.io/s2-streamstore/s2` (s2-lite) | digest-pinned, see `.env.example` | pending: not listed in the L1 trial digests |

ADR-0005 requires the Trigger image tag, SDK/CLI, and OpenCode versions to be
pinned together and the execution trial rerun whenever any of them changes.
The components listed as "exercised" above ran in the L1 Compose trial
(2026-09-09, linux/arm64 Docker Desktop); qualification (C1–C7) remains pending.

## Container-profile API_ORIGIN

In the container profile, the Trigger webapp advertises `http://webapp:3000` as
its `API_ORIGIN`. The Trigger CLI and runner processes take the API URL from the
webapp's project-env response, so they dial `http://webapp:3000` inside the
container network. On the host profile, `API_ORIGIN=http://localhost:8030` is
set in the env file so the host-side `trigger dev` process dials the published
port.

The Trigger webapp, worker stack container (supervisor), ClickHouse, MinIO,
Electric, and Trigger Postgres source their secrets through inline
`command:`/`entrypoint:` wrappers in `docker-compose.yml`,
`docker-compose.worker.yml`, and `infra/agencyhq/trigger-overrides.yaml` (each
tolerant of a missing file so the host profile is unaffected).

## Sources

- Compose file vendored from
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/webapp/docker-compose.yml
  (read 2026-09-07).
- `.env.example` vendored from
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/.env.example
  (read 2026-09-07).
- Full list of edits vs. these sources, and how each pin was chosen: see
  `UPSTREAM.md` in this folder.
