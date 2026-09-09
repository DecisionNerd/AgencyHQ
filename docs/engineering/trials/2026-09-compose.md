# Compose runtime trial

This record collects the live evidence for the Compose-first container runtime
([ADR-0008](../adrs/0008-compose-first-container-runtime.md), epic
[#14](https://github.com/DecisionNerd/AgencyHQ/issues/14)). Each section is one
live step of the plan; the qualification matrix C1–C7 in
[TESTING.md](../TESTING.md#compose-runtime-qualification) is the release gate
and nothing here closes it on its own.

## L1 — packaging, bootstrap and task image (2026-09-09)

- Date: 2026-09-09, 06:49–14:26 UTC, one host
- Scope: issues [#15](https://github.com/DecisionNerd/AgencyHQ/issues/15) and
  [#16](https://github.com/DecisionNerd/AgencyHQ/issues/16); C1 and C2 partially
  (single platform, no provider login, no repair)
- Code under test: branch `epic-14`, waves 1a–1c (634ea09, 4d7ae74, c3229a2) plus
  the fix loops committed during the trial (3b41ce1 … f5b7d05, listed below);
  final pass on the tree at f5b7d05
- Spend: USD 0 (no model calls; the fixture checks run pnpm only)
- Status: fresh install PASS, image smoke PASS, restart PASS, interrupted
  bootstrap PASS after fix loop 14; 25 defects found and fixed in-branch

### Host and pinned versions

| Component | Version / digest (linux/arm64) |
| --- | --- |
| Host | macOS (Darwin 25.6.0), Docker Desktop, daemon API 1.51, buildx v0.37.0; VM memory 8 GiB |
| Trigger.dev webapp | `ghcr.io/triggerdotdev/trigger.dev:v4.5.16` sha256:db0d3be2… |
| Trigger.dev supervisor | `ghcr.io/triggerdotdev/supervisor:v4.5.16` sha256:dea5109f… |
| Trigger Postgres / Redis / Electric / ClickHouse / MinIO | `postgres:14` sha256:156f0b25…, `redis:7` sha256:71da9275…, `electricsql/electric:1.2.4` sha256:20da3d0b…, `clickhouse/clickhouse-server:26.2` sha256:c2f26055…, `bitnamilegacy/minio:2025.5.24-debian-12-r5` sha256:451fe685… |
| Registry, socket proxies | `registry:2` sha256:a3d8aaa6…, `tecnativa/docker-socket-proxy:v0.5.0` sha256:1f5038b5… (two instances) |
| AgencyHQ Postgres | `postgres:17.6` sha256:00bc8661… |
| AgencyHQ app image | `agencyhq/app:app` sha256:94069d36…, `agencyhq/app:opencode` sha256:28275232…, `agencyhq/app:tools` (bootstrap); built from `infra/app/Dockerfile` on `node:24` |
| Task image (deployed) | `localhost:5001/trigger/proj_iemqwtcrgjviimfanmxz:20260909.5.production.*`, built by the Trigger CLI from `triggerdotdev/node:24-bookworm@sha256:d2d0c018…`; toolchain layer node v24.18.0, git 2.39.5, opencode-ai 1.18.29, pnpm 11.25.0; 284,604,460 bytes; loaded into the daemon (not pushed, see observations) |
| Trigger CLI / SDK | trigger.dev 4.5.16 (in the tools image) |
| Fixture | `DecisionNerd/agencyhq-fixture-node` @ 7a79b81 (public; sum parser with typecheck and tests) |

### Procedure

1. Fresh clone of `epic-14` into a scratch directory; `COMPOSE_PROJECT_NAME=agencyhq-c1
   AGENCYHQ_BOOTSTRAP_EMAIL=bootstrap2@agencyhq.local docker compose up -d --build`.
   Fix loops rebuilt only the changed image (`docker compose build secrets-init`
   rebuilds the tools target) and restarted the affected service.
2. Observed `secrets-init`, the bootstrap phases (`docker compose logs bootstrap`),
   `deployment.json` and `bootstrap.json` in the state volume, the webapp log
   (API calls only), the Trigger database (`Organization`, `Project`,
   `PersonalAccessToken`, `WorkerDeployment` counts) and `/api/readiness`.
3. Image smoke from the tools image on the stack network:
   `docker compose run --rm --no-deps -e TRIGGER_API_URL=http://webapp:3000
   -e AGENCYHQ_FIXTURE_REMOTE=… -e AGENCYHQ_FIXTURE_REVISION=7a79b81… bootstrap`
   with `TRIGGER_SECRET_KEY` read from `/var/agencyhq/state/trigger-prod.key`
   inside the container, running `node --experimental-strip-types
   trigger/scripts/image-smoke.ts` (the script triggers `runtime.probe` and
   `image.smoke` on the deployed image and asserts the report).
4. Restart: `docker compose down` (volumes kept) then `docker compose up -d`.
5. Fresh install again (`docker compose down -v`, `up -d`), then an interrupted
   bootstrap: `docker kill` of the bootstrap container 28 s into an uncached
   image build, then a second run.
6. Tokens, magic links and passwords were redacted from every saved log; no
   secret left the containers except through the readiness call in step 2,
   where the coordinator token stayed in a shell variable.

### Results

| Step | Result | Evidence |
| --- | --- | --- |
| Fresh install (C1) | PASS after fix loops 1–6 | Final fresh install (14:15 UTC): `docker compose up -d` returned in 44 s; the bootstrap ran wait_services → login (magic link captured by the built-in SMTP sink) → org_project (`agencyhq-e8cc` / `agencyhq-xW-k`, `proj_iemqwtcrgjviimfanmxz`) → credentials (prod key and PAT stored 0600 in the state volume) → deploy → verify_deployment → done and exited 0 at 94 s, with no operator step. 14 services healthy plus the two one-shot containers. |
| Image build and registration (#16) | PASS after fix loops 7–12 | Deploy version 20260909.14 was the first to complete (8 tasks detected; `POST /api/v1/deployments` 200 on the webapp; `verify_deployment` reported `DEPLOYED`). The final image is version 20260909.5 of the fresh install. |
| `runtime.probe` in a container | PASS | Run `run_cmtu6hd8j00083onz9qudu3pi` COMPLETED in 4,072 ms: git 2.39.5, opencode 1.18.29, pnpm 11.25.0, node v24.18.0, uid 1000, platform linux/arm64, cwd `/app`, HOME `/home/node` writable, run root `/tmp/agencyhq` writable; environment keys were `TRIGGER_*`, `OTEL_*`, `AGENCYHQ_*`, `PATH`, `HOME`, `NODE_*` only (no `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN`, `AWS_*`). The supervisor created the runner container from the daemon-local image and attached it to the `supervisor`, `webapp` and `agencyhq` networks. |
| `image.smoke` fixture checks in a container | PASS | Run `run_cmtu6hgdh000b3onzch33dc85` COMPLETED in 6,081 ms: profile `fixture-node-v1` on the public fixture at 7a79b81; `pnpm-install@1`, `pnpm-typecheck@1`, `pnpm-test@1` all passed (exit 0, no timeout). Whole smoke 10,156 ms, exit 0. |
| Readiness (R-025) | PASS | Before the bootstrap finished: `bootstrap {phase org_project, status failed, error org_create_failed}` with `nextAction` naming the phase and the log command. After: `services {database ok, trigger ok}`, `bootstrap done`, `image {version 20260909.5, platform linux/arm64, externalId …}`, `nextAction` "Ready for provider login: run `docker compose exec opencode opencode auth login`". |
| Redeploy on toolchain change | PASS after fix loop 13 | Changing `trigger/` content (HOME env var) changed the external id; the restarted bootstrap logged "toolchain changed since the last deployment; redeploying", built version 20260909.15 (one env var synced) and verified it. Before the fix it logged "deploy — already done" and kept the stale image. |
| Restart (C2) | PASS | `docker compose down` 15 s (13 project volumes untouched), `up -d` 13 s; all 12 health-checked services healthy and the bootstrap exited 0 within 23 s with "bootstrap already complete" (no new deployment; version unchanged); `secrets-init` retained every file. |
| Interrupted bootstrap (C2) | PASS after fix loop 14 | Killed 28 s into an uncached build (exit 137, phase `deploy=running`, server deployment BUILDING). Second run: login session reused, org/project/credentials skipped, the webapp's "already in progress" rejection detected, one retry with `--force`, version 20260909.5 deployed with 8 tasks and verified in 51 s. Trigger counts stayed 1 organisation, 1 project, 1 personal access token throughout; interrupted deployments remain on the server: the one left BUILDING became TIMED_OUT after the webapp's `DEPLOY_TIMEOUT_MS` (default 8 min; observed between 14:19 and 14:28 UTC), the one cancelled by `--force` shows CANCELED. Before the fix the second run failed with `deploy_failed` and could only succeed after that timeout. |
| Negative smoke (#16 scenario 3) | PASS | Smoke runs 1 and 2 (before fix loops 12–13) exited 1 naming the failing assertion ("HOME is not writable in the task image") after `runtime.probe` runs `run_cmtu6abk500013onzom9e6tri` and `run_cmtu6egbm00043onzek5hhqyd`; the script never advertised the image as usable. Readiness likewise reported `bootstrap {phase deploy, status failed, error deploy_failed}` with the log command while deploys were failing. |
| Idempotent deploy by external id | PASS | Re-running the deploy phase with an unchanged toolchain returned the existing server deployment in 11 s without a build (`--external-id`). |

### Defects found live (25, all fixed on `epic-14`)

| # | Where | Observed | Fix (commit) |
| --- | --- | --- | --- |
| 1 | infra/app/Dockerfile | `groupadd --gid 1000` conflicts with the base image's `node` user (exit 4); then `usermod` targeted the new name | rename `node` to `agencyhq` (3b41ce1) |
| 2 | infra/app/Dockerfile | `docker-buildx` package absent from bookworm apt | Docker CLI + buildx plugin from Docker's apt repository (3b41ce1) |
| 3 | infra/agencyhq/compose.yaml | secrets-init and bootstrap both built `agencyhq/app:tools` ("image already exists") | bootstrap reuses the image built by secrets-init, `pull_policy: never` (3b41ce1) |
| 4 | infra/agencyhq/compose.yaml | secrets-init ran through the app entrypoint, which requires the secrets it creates | dedicated entrypoint (3b41ce1) |
| 5 | root compose.yaml | no Trigger service waited for secrets-init: blank Postgres password, no `MANAGED_WORKER_SECRET` for the supervisor | override layers add `depends_on: secrets-init: service_completed_successfully` (3b41ce1) |
| 6 | Electric | needs the Postgres password from the secrets volume | entrypoint wrapper exporting `DATABASE_URL` (3b41ce1) |
| 7 | secrets volume | root-owned volume, EACCES for uid 1000 | image pre-creates `/run/agencyhq/secrets` owned by agencyhq; files 0644 because readers run as several uids (3b41ce1) |
| 8 | secrets-init | env files sourced by `sh` had unquoted values (`&` in `DATABASE_URL`), webapp failed with P1000 | values single-quoted on write, unquoted on read (3b41ce1) |
| 9 | vendored compose | `POSTGRES_DB` default `postgres`; the webapp expects `main` | default `main` (3b41ce1) |
| 10 | secrets-init | `ENCRYPTION_KEY` 64 hex chars; the webapp requires exactly 32 | `hex(16)` (3b41ce1) |
| 11 | bootstrap login | magic link arrived quoted-printable and HTML-escaped; token empty | MIME decoding (58d70fb) |
| 12 | bootstrap login | redirects followed automatically; the `__session` cookie set on an intermediate hop was lost | manual redirect following with per-hop cookie capture (58d70fb) |
| 13 | bootstrap login | stale magic link reused after restart | session validity check before requesting a new link (58d70fb) |
| 14 | bootstrap org_project | mixed-case project slug truncated (`agencyhq-MvNP` parsed as `agencyhq-`) | slug regex `[A-Za-z0-9_-]+` (c637204) |
| 15 | bootstrap | session not persisted; no honest `login_required` failure | `webapp-session.json` in the state volume; explicit failure (c637204) |
| 16 | bootstrap | webapp magic-link limit is 30 per address per day; the on-failure restart loop exhausted it | rate-limit detection and exponential backoff persisted in bootstrap.json (4777d26) |
| 17 | bootstrap | backoff misclassified the normal 302 to `/login` as rate-limited | only rate-limit headers or page text count (b54478c) |
| 18 | infra/app/Dockerfile | `No lockfile found from /app/trigger` during deploy | image carries `pnpm-lock.yaml` (2dde3e3) |
| 19 | deploy | the CLI switches to the API URL the webapp advertises (`API_ORIGIN`, default `http://localhost:8030`), unreachable in-container: "Failed to start deployment: Connection error." | webapp advertises its container IP; bootstrap joins the supervisor network; build with `--network host` (73a482c) |
| 20 | deploy | `mkdir /app/.docker: permission denied` (Docker CLI writes `$HOME/.docker`; HOME is the root-owned `/app`) | `DOCKER_CONFIG=<state>/docker` (538e9a5) |
| 21 | build proxy | the CLI's buildx `docker-container` builder needs container, exec and volume endpoints (403 on `GET /containers/buildx_buildkit_*/json`); the daemon-side `docker` driver is unusable behind haproxy (the daemon answers 500 to the `/grpc` h2c upgrade) | build proxy allows CONTAINERS, EXEC, VOLUMES, NETWORKS, ALLOW_START, ALLOW_STOP; webapp advertises `http://webapp:3000` (c0fc933) |
| 22 | deploy (indexer RUN step) | the Containerfile runs the task indexer as a RUN step that must reach the API origin; a host-network builder resolves no service name, and a builder on the webapp network still had public nameservers in the sandbox (BuildKit drops loopback entries) | bootstrap creates the `trigger` builder on the webapp network with a buildkitd config pinning Docker's embedded DNS; no `--network` flag (00377d9, ae6e4ca) |
| 23 | task image | `runtime.probe` saw no HOME although the image sets it: the runner builds the task environment from deploy env vars, not image ENV | HOME as a deploy env var (f9e4afa) |
| 24 | bootstrap | a completed deploy phase was final: after a toolchain change the rerun logged "deploy — already done" and the stale image stayed deployed | deploy phase current only while deployment.json carries the present external id; deploy, verify_deployment and done reopen otherwise (loop 13) |
| 25 | bootstrap resume | a bootstrap killed mid-build could not resume: the webapp keeps the interrupted deployment BUILDING until `DEPLOY_TIMEOUT_MS` (default 8 min) and rejects the same external id ("is already in progress") | deploy output captured and classified; `deploy_in_progress` retried once with `--force`; readiness reports the backoff for any retried failure (f5b7d05) |

### Deviations from the plan (recorded, not silently absorbed)

- **Build proxy scope (plan assumption 10).** The plan restricted the build
  socket proxy to build endpoints. The Trigger CLI only builds through a buildx
  `docker-container` builder, and the daemon's own `docker` driver cannot be used
  behind the proxy (defect 21), so `docker-proxy-build` now also allows container,
  exec, volume and network endpoints with start/stop. The buildkit container it
  creates is privileged; only the one-shot bootstrap container can reach this
  proxy. The supervisor's proxy is unchanged.
- **API origin.** The webapp advertises `http://webapp:3000` instead of the host
  URL; the bootstrap joins the `supervisor` network; the builder sits on the
  `webapp` network with Docker's embedded DNS pinned (defects 19, 22). No `--network
  host` build and no socat fallback were needed.
- **Registry unused for the single-host path.** The CLI does not push an image
  tagged for a localhost registry; it loads it into the daemon and the supervisor
  runs it from there (the registry catalog stayed empty). The `registry` service
  remains in the stack for the multi-host case in #19.
- **`HOME` is a deploy env var**, not only an image `ENV` (defect 23).

### Observations

- Timings on this host: fresh `up -d` 44 s; first uncached task-image build about
  3 min; cached rebuild and load under 10 s; restart 13 s to healthy; bootstrap
  resume 5–7 s when nothing changed.
- `docker compose down -v` removes the 13 project volumes but not the buildx
  builder container `buildx_buildkit_trigger0` and its `_state` volume (created
  by the bootstrap outside the Compose project). The bootstrap recreates the
  builder when its recorded configuration differs. Removing it by hand forces an
  uncached build.
- The webapp rate-limits magic links to 30 per address per day (headers
  `x-ratelimit-*`); an on-failure restart loop exhausted it once during the
  trial (defect 16). The bootstrap now backs off and readiness shows the retry
  time.
- Compose prints "variable is not set" warnings for `POSTGRES_PASSWORD`,
  `CLICKHOUSE_PASSWORD`, `MANAGED_WORKER_SECRET` and `NODE_MAX_OLD_SPACE_SIZE`
  on every command: the values come from the secrets volume at runtime, not from
  the environment. Cosmetic; left for the docs packet.
- Memory: the stack idles around 4 GiB in the 8 GiB VM (ClickHouse 1.5 GiB, webapp
  1 GiB); a foreground bootstrap pass was once killed by host memory pressure
  while the test Postgres and a stray builder were also running.
- `deployment.json` records `webappIpUrl` as the resolved webapp IP on the
  `agencyhq` network; it is informational only (the CLI switches to the advertised
  API origin).

### Not covered by L1

Provider login and task containers using it (#17, C3), portable source and
artifacts (#18), a real repair through the UI (C4), capacity (C6) and stop/loss
(C7), and any platform other than linux/arm64 on Docker Desktop.

Raw material: the scratch directory `l1/` of this session (evidence-raw.md,
bootstrap-pass-*.log, image-smoke-*.log, restart-1.log, interrupt-*.log,
readiness-*.json, netprobe/*.log).
