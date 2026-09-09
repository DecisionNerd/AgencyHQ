# @agencyhq/bootstrap

Bootstraps a self-hosted Trigger.dev webapp into a usable AgencyHQ execution environment. Runs as a one-shot container in the Compose stack and drives the webapp's web interface to create an organisation, project, credentials, and a deployed task image.

**Status:** Implemented; exercised live in L1 (2026-09-09) against Trigger.dev v4.5.16 (see [trial record](../../docs/engineering/trials/2026-09-compose.md#l1--packaging-bootstrap-and-task-image-2026-09-09)).

## What it does

1. **wait_services** — Polls `GET /healthcheck` until the webapp responds HTTP 200.
2. **login** — Starts a minimal SMTP sink on port 2525, requests a magic link for the bootstrap email address, captures the link from the incoming email (MIME-decoded: quoted-printable soft breaks and `=XX` sequences are resolved; HTML entities such as `&amp;` and `&#x3D;` in HTML parts are unescaped; the first URL with a non-empty `token` query parameter wins), follows it to establish an authenticated session. The authenticated cookie jar is saved to `webapp-session.json` (0600) in `AGENCYHQ_STATE_DIR` so container restarts do not need to re-login. On rerun, the phase loads the session file; if the session is invalid (GET `/` redirects to `/login`), the file is deleted and a fresh magic link is requested. If the magic link is not received within `BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS`, the run fails with category `login_required` and an actionable message rather than silently continuing. A 60-second throttle between requests prevents the webapp from rejecting rapid repeated requests.
3. **org_project** — Finds or creates the organisation and project by slug prefix (`agencyhq`). Reuses existing resources if already present; never creates duplicates.
4. **credentials** — Reads the prod environment secret key (`tr_prod_...`) from the webapp's API keys page. Mints a personal access token (`tr_pat_...`) only when none is already stored. Both are persisted as separate 0600 files in `AGENCYHQ_SECRETS_DIR`, never in the state JSON.
5. **deploy** — Runs `trigger deploy --local-build --external-id <sha256>` from the workspace `trigger/` directory with `TRIGGER_ACCESS_TOKEN` (the PAT file) and `TRIGGER_API_URL` (webapp with DNS-resolved IP, to avoid the CLI's `localhost` → `host.docker.internal` rewrite). `DOCKER_CONFIG` is set to `<AGENCYHQ_STATE_DIR>/docker` so the Docker CLI writes buildx state under the state volume rather than the root-owned `/app`. `ensureBuilder` creates the `trigger` buildx `docker-container` builder on `AGENCYHQ_BUILD_NETWORK` (default `webapp`) with a buildkitd config that pins Docker's embedded DNS 127.0.0.11, and writes a `builder.marker` file to track the builder configuration; the builder is recreated when the marker differs. `deploymentIsCurrent` checks whether `deployment.json` already records the current toolchain hash: if so the deploy phase is skipped. If the webapp rejects the deploy with "already in progress" (`deploy_in_progress`), the bootstrap retries once with `--force` (cancels the stale build); if that also fails, the webapp times the stale build out after `DEPLOY_TIMEOUT_MS` (default 8 min) and the backoff retry succeeds.
6. **verify_deployment** — `GET /api/v1/deployments/current` with the prod secret key; writes the result into the bootstrap state.
7. **done** — Marks the bootstrap complete.

Each phase is idempotent and resumable: restarting the container picks up from the last completed phase. No secrets or one-time URLs appear in the state JSON or structured logs.

## Environment variables read

| Variable | Default | Description |
| --- | --- | --- |
| `AGENCYHQ_STATE_DIR` | `/var/agencyhq/state` | Directory for `bootstrap.json` and `deployment.json`. |
| `AGENCYHQ_SECRETS_DIR` | `AGENCYHQ_STATE_DIR` | Directory for 0600 secret files (`trigger-prod.key`, `trigger-pat.key`). Defaults to the same path as `AGENCYHQ_STATE_DIR`. |
| `DOCKER_CONFIG` | `<AGENCYHQ_STATE_DIR>/docker` | Docker CLI configuration directory; buildx state is written here. Set so the CLI does not write to the root-owned `/app`. |
| `AGENCYHQ_BUILD_NETWORK` | `webapp` | Docker network on which the `trigger` buildx builder is created. The builder pins Docker's embedded DNS 127.0.0.11 so the indexer RUN step can reach the webapp by service name. |
| `TRIGGER_WEBAPP_URL` | `http://webapp:3000` | Internal URL of the Trigger.dev webapp container. |
| `BOOTSTRAP_EMAIL` | `agencyhq@example.com` | Email address for the magic-link login. Must match `WHITELISTED_EMAILS`/`ADMIN_EMAILS`. |
| `BOOTSTRAP_SMTP_PORT` | `2525` | Port for the built-in SMTP sink (the webapp sends to this host). |
| `BOOTSTRAP_MAGIC_LINK_TIMEOUT_MS` | `90000` | How long to wait for the magic-link email (ms). Increase if the email consistently arrives late; note the webapp throttles repeated requests to the same address (see throttle below). |
| `AGENCYHQ_ORG_NAME` | `agencyhq` | Organisation name to find or create. |
| `AGENCYHQ_PROJECT_NAME` | `agencyhq` | Project name to find or create. |
| `AGENCYHQ_TOKEN_NAME` | `agencyhq-bootstrap` | Personal access token name. |
| `AGENCYHQ_WORKSPACE_ROOT` | `/workspace` | Path to the repo root inside the container (must contain `trigger/`). |
| `AGENCYHQ_PLATFORM` | (host arch) | Target platform for the task image (e.g. `linux/arm64`). |
| `TRIGGER_DEPLOY_ARGS` | (empty) | Extra space-separated flags appended to `trigger deploy` (e.g. `--network host`). |

The webapp must be configured with `EMAIL_TRANSPORT=smtp`, `SMTP_HOST=bootstrap`, `SMTP_PORT=2525` and `WHITELISTED_EMAILS`/`ADMIN_EMAILS` matching `BOOTSTRAP_EMAIL`.

## CLI commands

```sh
bootstrap run              # Run all phases (resumes from last completed phase).
bootstrap status           # Print bootstrap.json without secrets.
bootstrap dashboard-link   # Request a fresh magic link and print it to stdout only.
```

## Phases and failure categories

| Phase | Error category | Meaning |
| --- | --- | --- |
| `wait_services` | `services_unavailable` | Webapp did not respond within the timeout. |
| `login` | `login_rate_limited` | The webapp rejected the magic-link request because the per-address limit (30 per address per day, observed 2026-09-09) is exhausted. The bootstrap backs off until the reset time (up to 15 minutes) before exiting, so `restart: on-failure` does not hot-loop. The `nextRetryAt` field in `bootstrap.json` carries the ISO timestamp of the next attempt. |
| `login` | `magic_link_timeout` | SMTP sink timed out; no magic-link email received. |
| `login` | `login_failed` | Following the magic link returned a non-200 response. |
| `login` | `login_required` | Session could not be re-established after a container restart (magic link not received within timeout). Rerun after 60 s or use `dashboard-link`. |
| `org_project` | `org_create_failed` | Org or project creation failed. |
| `credentials` | `secret_key_missing` | Prod key or PAT not found in the webapp response. |
| `credentials` | `project_page_not_found` | API keys page returned 404 after env/prod provisioning attempt. Check that the org and project slugs are correct. |
| `credentials` | `pat_create_failed` | Token creation endpoint returned an unexpected response. |
| `deploy` | `deploy_failed` | `trigger deploy` exited non-zero; see output for details. Re-run to retry. |
| `deploy` | `deploy_in_progress` | The webapp still marks an interrupted build of this toolchain as in progress (the bootstrap was killed mid-build). The bootstrap retries once with `--force` (cancels the stale build); if that also fails, the webapp times the stale build out after `DEPLOY_TIMEOUT_MS` (default 8 min) and the backoff retry succeeds. |
| `verify_deployment` | `verify_failed` | `GET /api/v1/deployments/current` returned non-200. |

## Backoff behaviour

On any **transient** failure (categories: `login_rate_limited`, `magic_link_timeout`, `services_unavailable`, `deploy_failed`, `deploy_in_progress`) the bootstrap process sleeps before exiting non-zero. This prevents `restart: on-failure` from hot-looping.

### Sleep duration

| Condition | Duration |
| --- | --- |
| `login_rate_limited` with known reset time | Until reset time, capped at 15 minutes |
| `login_rate_limited` without reset time | Exponential: `min(2^attempt × 15 s, 5 min)` |
| Other transient failures | Exponential: `min(2^attempt × 15 s, 5 min)` |

The **attempt counter** is persisted in `bootstrap.json` (field `attempt`) and **reset to 0 on any successful phase**. The `nextRetryAt` ISO field is written just before sleeping so the coordinator readiness endpoint can surface it (e.g. "Bootstrap is backing off until 2026-09-09T14:00:00Z (login_rate_limited)").

### Rate-limit detection

Trigger.dev v4.5.16 rate-limits `POST /login/magic` per email address. The observed server log line is:

```
{"limit":30,"reset":<epoch ms>,"remaining":0,"identifier":"<email>"}
```

The bootstrap detects this in three ways (checked in order):
1. `x-ratelimit-remaining: 0` header on the initial response hop.
2. `retry-after` header (RFC 7231 seconds) on the initial response hop.
3. After all redirects the final URL path is `/login` AND the page body matches `too many|rate.?limit|try again later` — the webapp served a rate-limit page. A `/login` final path without that text means the link was sent (the webapp redirects POST /login/magic → 302 /login normally; only the page text distinguishes a rate-limited response).

The reset time is parsed from `x-ratelimit-reset` (epoch-seconds or epoch-ms, auto-detected by magnitude) or `retry-after` (seconds from now).

### Fail fast

The SMTP sink timeout (default 90 s) applies **only after a successful magic-link request**. If the request is rate-limited or otherwise failed, the SMTP sink is cancelled immediately via `AbortController` and the bootstrap sleeps before exiting — it does not wait the full SMTP timeout.

## Confirmed in L1 (2026-09-09)

The following were open questions before L1 and are now confirmed against
Trigger.dev v4.5.16 (commands/deploy.js, read 2026-09-09):

- `--push`, `--network`, `--builder`, and `--force` exist as hidden flags in
  the 4.5.16 CLI. The bootstrap uses `--local-build` (not `--push`);
  localhost-tagged images are loaded into the daemon by the CLI, not pushed to
  the registry (the registry catalog stayed empty in L1).
- `/api/v1/deployments/current` works with the prod key and returns the current
  deployment record.
- `--external-id` returns an existing server deployment without triggering a new
  build (`deploymentIsCurrent` uses this to skip redundant deploys) and rejects
  one still in progress with "already in progress" (`deploy_in_progress` — the
  `--force` retry handles this case).
