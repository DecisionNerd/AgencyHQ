# infra — AgencyHQ infrastructure layout

This directory contains Docker Compose files, image build specifications,
secret management scripts, and supporting configuration for the AgencyHQ
container runtime profile (ADR-0008).

## Directory layout

| Path | Purpose |
| --- | --- |
| `infra/agencyhq/compose.yaml` | AgencyHQ application services: `secrets-init`, `app`, `agencyhq-postgres`, `opencode`, `bootstrap`, `docker-proxy-build`. |
| `infra/app/Dockerfile` | Multi-stage image build for AgencyHQ containers. Targets: `app` (coordinator + web), `tools` (adds Docker CLI for bootstrap/secrets-init), `opencode` (OpenCode AI service). |
| `infra/secrets/` | Secret generation and entrypoint wrappers. See `infra/secrets/README.md`. |
| `infra/trigger/` | Vendored Trigger.dev v4.5.16 compose files. See `infra/trigger/README.md` and `infra/trigger/UPSTREAM.md`. |
| `infra/db/compose.yaml` | Test database for local development (postgres:17.6 on port 5434). Not used by the container profile. |
| `infra/clickhouse/` | Read-only Clickhouse configuration XML files (data-paths, override, users-override). |
| `infra/registry/` | Unused in the container profile (no htpasswd). The loopback registry requires no auth. |

## Service map (container profile)

The root `compose.yaml` includes all three Compose files and runs as project
`agencyhq`. All services reach each other by service name within their shared
networks.

| Service | Image / Target | Networks | Volumes | Role |
| --- | --- | --- | --- | --- |
| `secrets-init` | `tools` | none | `secrets` | One-shot: generates internal secrets; never rotates non-empty values. |
| `app` | `app` | `agencyhq-internal`, `agencyhq`, `webapp` | `secrets:ro`, `agencyhq-state`, `agencyhq-git`, `opencode-data:ro` | Coordinator + web (port 8787). Runs migrations on start. |
| `agencyhq-postgres` | `postgres:17.6` | `agencyhq-internal` | `agencyhq-postgres` | AgencyHQ domain ledger. Separate from Trigger's postgres:14. |
| `opencode` | `opencode` | `agencyhq` | `opencode-data`, `opencode-config` | `sleep infinity`; `docker compose exec opencode opencode auth login`. |
| `bootstrap` | `tools` | `agencyhq`, `webapp`, `docker-proxy-build` | `secrets:ro`, `agencyhq-state` | One-shot (restart on-failure): bootstraps Trigger project; deploys task image. |
| `docker-proxy-build` | `tecnativa/docker-socket-proxy:v0.5.0` | `docker-proxy-build` | `/var/run/docker.sock:ro` | Build-only socket proxy for bootstrap. |
| `webapp` | `ghcr.io/triggerdotdev/trigger.dev:v4.5.16` | `webapp`, `supervisor`, `agencyhq` | `shared`, `secrets:ro`, `agencyhq-state:ro` | Trigger.dev webapp (port 8030). |
| `postgres` | `postgres:14` | `webapp` | `postgres` | Trigger's own database. |
| `redis` | `redis:7` | `webapp` | `redis` | Trigger's job queue and cache. |
| `electric` | `electricsql/electric:1.2.4` | `webapp` | — | Postgres CDC for the Trigger dashboard. |
| `clickhouse` | `clickhouse/clickhouse-server:26.2` | `webapp` | `clickhouse` | Run analytics for the Trigger dashboard. |
| `registry` | `registry:2` | `webapp` | — | Local task image registry on 127.0.0.1:5001; no htpasswd (loopback-only). |
| `minio` | `bitnamilegacy/minio:2025.5.24-debian-12-r5` | `webapp` | `minio` | Object store for task payloads and artifacts. |
| `s2-init`, `s2` | `busybox:1.37`, `ghcr.io/s2-streamstore/s2@sha256:…` | `webapp` | `s2-config`, `s2` | Realtime streams v2. |
| `supervisor` | `ghcr.io/triggerdotdev/supervisor:v4.5.16` | `supervisor`, `docker-proxy`, `webapp`, `agencyhq` | `shared`, `secrets:ro` | Trigger worker stack container: creates runner task containers. |
| `docker-proxy` | `tecnativa/docker-socket-proxy:v0.5.0` | `docker-proxy` | `/var/run/docker.sock:ro` | Socket proxy for the Trigger worker stack container (supervisor). |

## Networks

| Network | Members | Purpose |
| --- | --- | --- |
| `agencyhq` | `app`, `opencode`, `bootstrap`, `supervisor` (Trigger worker stack), runner task containers | Coordinator ↔ opencode ↔ bootstrap ↔ runners. Runners reach `http://app:8787/internal/*`. |
| `agencyhq-internal` | `app`, `agencyhq-postgres` | Ledger isolation: runners cannot reach the domain database. |
| `webapp` | All Trigger services + `app`, `bootstrap`, runner task containers | Trigger API, registry, object store, realtime streams. |
| `supervisor` | `webapp`, `supervisor` (Trigger worker stack container) | Trigger worker stack container internal routing. |
| `docker-proxy` | `supervisor` (Trigger worker stack container), `docker-proxy` | Socket proxy for the Trigger worker stack container. |
| `docker-proxy-build` | `bootstrap`, `docker-proxy-build` | Build-only socket proxy for the deployer phase. |

## Published ports (container profile)

All ports are bound to `127.0.0.1` (loopback only) by default.

| Port | Service | Purpose |
| --- | --- | --- |
| `8787` | `app` | AgencyHQ coordinator API + web UI. |
| `8030` | `webapp` | Trigger.dev dashboard (debug; operator flow does not require it). |
| `5001` | `registry` | Local task image registry. |
| `5435` | `agencyhq-postgres` | (optional, not published by default) AgencyHQ postgres. |
| `5433` | `postgres` | (optional) Trigger postgres. |

## Provider setup

After `docker compose up -d`:

```sh
docker compose exec opencode opencode auth login
```

This starts the interactive OpenCode login flow. The qualified default is the
OpenCode Zen API key (`opencode/big-pickle`, zero spend). See ADR-0008 for
the list of qualified providers and unsupported combinations.

## Secret management

All internal credentials are generated by `secrets-init` and stored in the
`agencyhq_secrets` Docker volume. No secrets are required in a host `.env`
file. See `infra/secrets/README.md` for the full design.

## Resetting the stack

```sh
docker compose down -v    # stop all services and remove all data volumes
docker compose up -d      # fresh start; secrets-init generates new credentials
```

The host-profile volumes (`trigger_postgres`, `trigger_clickhouse`, etc.) are
separate and are not affected by operating on the `agencyhq` project.

## Host profile fallback

The Trigger vendored files in `infra/trigger/` remain usable as a standalone
host-profile stack. See `infra/trigger/README.md` for instructions.
