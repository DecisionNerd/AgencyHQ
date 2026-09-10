# infra/secrets — AgencyHQ secret management for the container profile

This directory contains the scripts that generate and inject internal secrets
for the container runtime profile (ADR-0008). No secret values are stored here
or in any tracked file; they live only in the `secrets` Docker volume.

## How it works

1. The `secrets-init` service (a one-shot container) runs `secrets-init.mjs`
   on every `docker compose up`. It generates random secrets for each
   required name and writes them to `/run/agencyhq/secrets/` in the `secrets`
   volume. **It never overwrites a non-empty value**, so repeating `up` is safe.

2. Services that need secrets mount the volume at `/run/agencyhq/secrets:ro`
   and override their entrypoints with the wrapper scripts in this directory.
   Each wrapper sources the relevant `.env` file before `exec`-ing the real
   process, injecting secrets into the process environment.

3. Postgres services use `POSTGRES_PASSWORD_FILE` natively, pointing at
   `/run/agencyhq/secrets/trigger-db-password` and
   `/run/agencyhq/secrets/agencyhq-db-password` respectively.

## Files

| File | Purpose |
| --- | --- |
| `secrets-init.mjs` | Node.js secret generator (no deps). Writes all secret files with mode 0644 (see below). |
| `entrypoint-app.sh` | Wrapper for the AgencyHQ coordinator container; sources `agencyhq.env`. |

The Trigger webapp, the worker stack container, ClickHouse, MinIO, Electric and
the Trigger Postgres run their upstream images, so they source their files
through inline `command:`/`entrypoint:` wrappers in `infra/trigger/docker-compose.yml`,
`infra/trigger/docker-compose.worker.yml` and `infra/agencyhq/trigger-overrides.yaml`
(each tolerant of a missing file so the host profile is unaffected).

## Secrets generated

| Secret file | Keys | Consumer(s) |
| --- | --- | --- |
| `webapp.env` | `SESSION_SECRET`, `MAGIC_LINK_SECRET`, `ENCRYPTION_KEY`, `PROVIDER_SECRET`, `COORDINATOR_SECRET`, `MANAGED_WORKER_SECRET`, `DATABASE_URL`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_URL`, `RUN_REPLICATION_CLICKHOUSE_URL`, `OBJECT_STORE_SECRET_ACCESS_KEY` | Trigger webapp |
| `supervisor.env` | `MANAGED_WORKER_SECRET` | Trigger worker stack container (supervisor) |
| `agencyhq.env` | `AGENCYHQ_POSTGRES_PASSWORD`, `DATABASE_URL`, `AGENCYHQ_API_TOKEN`, `AGENCYHQ_SECRETS_KEY` (AES-256-GCM key for project credential rows) | AgencyHQ coordinator |
| `clickhouse.env` | `CLICKHOUSE_PASSWORD` | Clickhouse |
| `minio.env` | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `OBJECT_STORE_SECRET_ACCESS_KEY` | MinIO |
| `trigger-db-password` | (raw password) | Trigger postgres (POSTGRES_PASSWORD_FILE) |
| `agencyhq-db-password` | (raw password) | AgencyHQ postgres (POSTGRES_PASSWORD_FILE) |

## Resetting

`docker compose down -v` removes all volumes, including `agencyhq_secrets`.
The next `docker compose up` generates a fresh set of secrets. **All data is
lost on a full volume reset** — this is the intended reset path.

To reset only secrets (keeping data volumes): remove the `agencyhq_secrets`
volume explicitly, then bring the stack back up with `docker compose up -d`.

## File permissions

Secret files are written with mode **0644** (not 0600). This is intentional: the secrets volume is mounted read-only into every consumer, and services run as different UIDs (Trigger webapp: root, Trigger Postgres wrapper: root, ClickHouse: uid 101, MinIO: uid 1001, Electric: varies, AgencyHQ app: uid 1000). Since no single UID can own all files and still allow reading by others, 0644 gives all services read access. See trial record defect 7 (`docs/engineering/trials/2026-09-compose.md §Deviations`).

`trigger-prod.key` and `trigger-pat.key` are written by the **bootstrap** container (not by `secrets-init`) with mode **0600**; they live in the `agencyhq-state` volume, not the secrets volume.
