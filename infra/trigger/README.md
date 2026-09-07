# Self-hosted Trigger.dev webapp stack

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
| `.env.example` | Every environment variable the compose file reads, with pinned image-tag defaults and blank secrets. Copy this to `.env` before starting anything. |
| `scripts/gen-env.sh` | Creates `.env` from `.env.example` if missing, and fills every blank secret with `openssl rand -hex 16`. Safe to re-run: it never overwrites a secret that already has a value. |
| `UPSTREAM.md` | Upstream source URLs, the date they were read, and every edit made vs. the vendored files, with a reason for each. |

## Service list

| Service | Image (pinned via `.env`) | Host port(s) |
| --- | --- | --- |
| `webapp` | `ghcr.io/triggerdotdev/trigger.dev:${TRIGGER_IMAGE_TAG}` | `8030` (→ container `3000`) |
| `postgres` | `postgres:${POSTGRES_IMAGE_TAG}` | `5433` (→ container `5432`) |
| `redis` | `redis:${REDIS_IMAGE_TAG}` | `6389` (→ container `6379`) |
| `electric` | `electricsql/electric:${ELECTRIC_IMAGE_TAG}` | none published |
| `clickhouse` | `clickhouse/clickhouse-server:${CLICKHOUSE_IMAGE_TAG}` | `9123` (HTTP), `9090` (native) |
| `registry` | `registry:${REGISTRY_IMAGE_TAG}` | `5001` (→ container `5000`; host `5000` is macOS AirPlay Receiver — see Notes) |
| `minio` | `bitnamilegacy/minio:${MINIO_IMAGE_TAG}` | `9000` (S3 API), `9001` (console) |
| `s2-init`, `s2` | `busybox:${BUSYBOX_IMAGE_TAG}`, `${S2_IMAGE}` (digest-pinned) | none published |

All host ports above are bound to `127.0.0.1` (or `${WEBAPP_PUBLISH_IP}` for
the webapp) by the defaults in `.env.example`, so nothing here is reachable
off the host.

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

## Pinned versions

| Component | Version | Qualified by |
| --- | --- | --- |
| Trigger.dev webapp image | `v4.5.16` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| Trigger.dev SDK/CLI | `4.5.16` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `postgres` | `14` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `redis` | `7` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `electricsql/electric` | `1.2.4` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `clickhouse/clickhouse-server` | `26.2` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `registry` | `2` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `bitnamilegacy/minio` | `2025.5.24-debian-12-r5` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `busybox` (s2-init) | `1.37` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |
| `ghcr.io/s2-streamstore/s2` (s2-lite) | digest-pinned, see `.env.example` | pending: [Slice 1 execution trial](../../docs/engineering/TESTING.md#required-execution-trial) |

ADR-0005 requires the Trigger image tag, SDK/CLI, and OpenCode versions to be
pinned together and the execution trial rerun whenever any of them changes;
none of the pins above have been qualified by that trial yet.

## Sources

- Compose file vendored from
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/webapp/docker-compose.yml
  (read 2026-09-07).
- `.env.example` vendored from
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/.env.example
  (read 2026-09-07).
- Full list of edits vs. these sources, and how each pin was chosen: see
  `UPSTREAM.md` in this folder.
