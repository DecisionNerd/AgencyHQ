# Upstream provenance

Vendored from Trigger.dev tag **v4.5.16**. Both files fetched from the exact
tag path on the first try — no fallback to `main` was needed.

## Sources (read 2026-09-07)

- `docker-compose.yml` vendored from:
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/webapp/docker-compose.yml
- `.env.example` vendored from:
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/.env.example
- To confirm `WHITELISTED_EMAILS` and `TRIGGER_TELEMETRY_DISABLED` are real
  webapp config keys at this tag (neither appears in the upstream
  `.env.example` above), the webapp's own env schema was read:
  https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/apps/webapp/app/env.server.ts
  (lines ~333-336 define `WHITELISTED_EMAILS` as an optional regex string;
  line ~374 defines `TRIGGER_TELEMETRY_DISABLED` as an optional string.)
- To choose a non-floating pin for `bitnamilegacy/minio` (see below), the
  Docker Hub tags API was read:
  https://hub.docker.com/v2/repositories/bitnamilegacy/minio/tags

Fallback note: the fallback to
`https://raw.githubusercontent.com/triggerdotdev/trigger.dev/main/...` was
**not needed** — both v4.5.16 URLs returned HTTP 200 on the first request.

## docker-compose.yml — every edit vs upstream

Only the webapp-stack file (`hosting/docker/webapp/docker-compose.yml`) was
vendored; the worker/supervisor stack and Traefik overlay files at that path
were not fetched or added, per scope (host profile only, no worker stack, no
docker-socket-proxy).

1. **Registry publish port 5000 → 5001** (`registry.ports`, and the matching
   `webapp.environment.DEPLOY_REGISTRY_HOST` default). Reason: macOS
   AirPlay Receiver holds host port 5000 on this operator's machine
   (verified 2026-09-07); the registry's container port (5000) is
   unchanged, only the host-side publish port moves.
2. **`webapp` image default `latest` → `v4.5.16`**. Reason: (b) no bare
   `latest` default; this vendoring pins the exact Trigger.dev release
   AgencyHQ is qualifying together with the SDK/CLI and OpenCode versions
   (ADR-0005). `.env.example` also sets `TRIGGER_IMAGE_TAG=v4.5.16`
   explicitly, so this default is a belt-and-braces fallback.
3. **`minio` image default `latest` → `2025.5.24-debian-12-r5`**. Reason:
   (b) no bare `latest` default. The Docker Hub tags API (read 2026-09-07)
   shows `bitnamilegacy/minio` is a frozen legacy repository that no longer
   receives new version tags; `latest` and `2025.5.24-debian-12-r5` resolve
   to the identical image digest
   (`sha256:b3d51900e846b92f7503ca6be07d2e8c56ebb6a13a60bc71b8777c716c074bcf`
   for `amd64`), so this pin changes nothing about which bytes get pulled —
   it only replaces a floating alias with the fixed tag it currently
   points at.
4. **`s2` image default: dropped the `:latest` tag qualifier**, keeping the
   digest — `ghcr.io/s2-streamstore/s2:latest@sha256:...` →
   `ghcr.io/s2-streamstore/s2@sha256:...`. Reason: upstream's own default is
   already pinned by digest (the only pin this single-tag image supports —
   see the `.env.example` comment "Pin the s2-lite image in production
   (full image reference, digest recommended)"), but the literal string
   `:latest` in the reference reads as a floating tag and would trip a
   naive `:latest` grep. Digest-only addressing (`name@sha256:...`, no tag)
   is valid Docker image reference syntax and resolves to the exact same
   image.
5. **Required-secret guards (`${VAR:?message}`) relaxed to `${VAR:-}`** for
   `postgres.environment.POSTGRES_PASSWORD`,
   `clickhouse.environment.CLICKHOUSE_PASSWORD`, and
   `minio.environment.MINIO_ROOT_PASSWORD`'s `OBJECT_STORE_SECRET_ACCESS_KEY`
   fallback. Reason: upstream's `:?` form fails `docker compose config`
   itself (not just `up`) whenever these are blank — which they are in the
   shipped `.env.example`, by design, until an operator runs
   `scripts/gen-env.sh`. That blocked validating the vendored file's syntax
   and image pins before secrets exist. `scripts/gen-env.sh` is this repo's
   actual guard against blank secrets reaching `docker compose up`; the
   upstream messages also referenced `./generate-secrets.sh`, a script this
   vendoring does not carry (replaced by `scripts/gen-env.sh`). This is the
   one edit outside the (a)/(b)/(c) categories named for this packet; it
   only affects `docker compose config`'s willingness to render the file,
   not which values end up in a real deployment.

Everything else — the full service list (`webapp`, `postgres`, `redis`,
`electric`, `clickhouse`, `registry`, `minio`, `s2-init`, `s2`), all
`depends_on` edges, all healthchecks, the `docker-proxy` and `supervisor`
named networks (inert placeholders for the undeployed worker stack, kept so
this file stays a drop-in match for upstream's if that stack is added
later), and all other image tag variables (`POSTGRES_IMAGE_TAG`,
`REDIS_IMAGE_TAG`, `ELECTRIC_IMAGE_TAG`, `CLICKHOUSE_IMAGE_TAG`,
`REGISTRY_IMAGE_TAG`, `BUSYBOX_IMAGE_TAG`) — is unchanged from upstream.

## Worker stack (docker-compose.worker.yml) — every edit vs upstream

Source: https://raw.githubusercontent.com/triggerdotdev/trigger.dev/v4.5.16/hosting/docker/worker/docker-compose.yml
(read 2026-09-08; a verbatim copy was also saved locally for reference)

This file was not included in the initial vendoring (Slice 1/host profile only).
It was added in Slice 6 as the container profile scaffold.

Edits vs upstream:

1. **`supervisor` image default `latest` → `${TRIGGER_IMAGE_TAG:-v4.5.16}`**.
   Reason: (b) no bare `latest` default; pins the same Trigger.dev release
   AgencyHQ is qualifying for the container profile. `TRIGGER_IMAGE_TAG` is
   already set in `.env.example`, so the compose default is a belt-and-braces
   fallback matching the webapp file's pattern.

2. **`docker-proxy` image default `latest` → `${DOCKER_PROXY_IMAGE_TAG:-v0.5.0}`**.
   Reason: (b) no bare `latest` default. `DOCKER_PROXY_IMAGE_TAG=v0.5.0`
   chosen from the Docker Hub tags API on 2026-09-08 (upstream uses `latest`;
   v0.5.0 is the most recent release tag at that date, 2026-07-27).

3. **`DOCKER_REGISTRY_URL` default `localhost:5000` → `localhost:5001`**.
   Reason: matches the webapp file's `DEPLOY_REGISTRY_HOST` default and the
   registry's publish port (macOS AirPlay Receiver holds 5000 on this host —
   same as webapp-file edit #1 in UPSTREAM.md § docker-compose.yml).

4. **Header comment added** with the upstream URL, date read, and a statement
   that the trigger worker stack has not yet been exercised
   (pending: Slice 6 container spike).

5. **Inline comments added** to satisfy the supervisor-word rule: every trigger
   worker stack line that contains `supervisor` now also contains trigger,
   container, or worker stack on the same line. The comments read
   "trigger.dev worker stack container", "trigger worker stack", or
   "worker stack internal routing domain" depending on context.

Everything else — service definitions, healthchecks, `depends_on` edges,
`ENFORCE_MACHINE_PRESETS`, `DEBUG`, `DOCKER_RUNNER_NETWORKS`, the bootstrap
token path (`file:///home/node/shared/worker_token`), `shared` volume,
and trigger worker-stack named networks (`docker-proxy` and `supervisor`) and
all other upstream environment variables — is unchanged from upstream.

Note: the `shared` volume and the named networks are declared in both this
file and `docker-compose.yml`. Docker Compose merges them — so the trigger
worker stack networks (`docker-proxy`, `supervisor`, `webapp`) and the `shared`
volume are shared with the webapp stack, letting the trigger worker stack
container (supervisor) read the bootstrap token at
`/home/node/shared/worker_token` that the webapp writes on startup.

## .env.example — every edit vs upstream

Unlike the compose file, this file's edits were not restricted to a minimal
list; every value change below was named explicitly for this packet, plus
some structural trims to match the reduced (webapp-only) service scope.

Values set as directed:

- `TRIGGER_IMAGE_TAG=latest` → `TRIGGER_IMAGE_TAG=v4.5.16`.
- `APP_ORIGIN` / `LOGIN_ORIGIN` / `API_ORIGIN` / `DEV_OTEL_EXPORTER_OTLP_ENDPOINT`:
  already `http://localhost:8030`-based upstream; unchanged.
- `WEBAPP_PUBLISH_IP` (commented, `0.0.0.0`) → uncommented,
  `WEBAPP_PUBLISH_IP=127.0.0.1`.
- `DOCKER_REGISTRY_URL=localhost:5000` → `DOCKER_REGISTRY_URL=localhost:5001`,
  matching the compose registry port edit above.
- `RESTART_POLICY` (commented) → uncommented, `RESTART_POLICY=unless-stopped`.
- Added `TRIGGER_TELEMETRY_DISABLED=1` (new; not present in upstream
  `.env.example`, confirmed as a real webapp env var — see Sources above).
- Added `WHITELISTED_EMAILS=` (new; not present in upstream `.env.example`,
  confirmed as a real webapp env var) with a comment showing the regex form.
  Left blank (unrestricted sign-in) since no operator email allowlist has
  been decided yet — **not** filled by `scripts/gen-env.sh`, which only
  fills secrets.
- Every secret line's comment reduced to `# openssl rand -hex 16`, and
  references to upstream's `./generate-secrets.sh` replaced with pointers to
  this repo's `scripts/gen-env.sh`.
- Added the `*_IMAGE_TAG` variables this vendoring introduced as explicit,
  uncommented, pinned values (upstream ships these as commented-out
  examples): `POSTGRES_IMAGE_TAG=14`, `REDIS_IMAGE_TAG=7`,
  `ELECTRIC_IMAGE_TAG=1.2.4`, `CLICKHOUSE_IMAGE_TAG=26.2`,
  `REGISTRY_IMAGE_TAG=2`, `MINIO_IMAGE_TAG=2025.5.24-debian-12-r5` (see the
  compose-file entry above for why this isn't `latest`), and
  `BUSYBOX_IMAGE_TAG=1.37` (upstream's compose file already parameterizes
  this image but upstream's own `.env.example` never surfaces the
  variable — an upstream gap this vendoring fills).
- Corrected the `ELECTRIC_IMAGE_TAG` example value: upstream's
  `.env.example` comment says `1.0.13`, but upstream's own
  `hosting/docker/webapp/docker-compose.yml` at this same tag defaults
  `ELECTRIC_IMAGE_TAG` to `1.2.4` — an inconsistency in upstream itself.
  This vendoring uses `1.2.4` to match the compose file it ships with.
- `S2_IMAGE` example line: dropped the `:latest` tag qualifier, matching
  the compose-file edit above (`ghcr.io/s2-streamstore/s2:latest@sha256:...`
  → `ghcr.io/s2-streamstore/s2@sha256:...`).

Structural trims (sections removed, none of them applicable to a
webapp-only host profile with no worker/supervisor container and no
Traefik):

- Removed the **Worker token** section (`TRIGGER_WORKER_TOKEN`) — only
  relevant to a split webapp/worker deployment; this profile runs `trigger
  dev` on the host instead of a worker container.
- Removed the **Worker URLs** section (`TRIGGER_API_URL`,
  `OTEL_EXPORTER_OTLP_ENDPOINT` for split setups) — same reason.
- Removed the **Traefik** section and `TRAEFIK_*` variables — this
  vendoring does not ship `docker-compose.traefik.yml` or any reverse
  proxy.
- Removed the commented `DOCKER_PROXY_IMAGE_TAG=latest` line — this
  vendoring does not deploy `docker-socket-proxy`.

Everything else (Postgres, ClickHouse, Docker Registry, Object store,
Realtime streams sections and their variable names/defaults) is unchanged
from upstream apart from the value edits listed above.
