# @agencyhq/bootstrap

Bootstraps a self-hosted Trigger.dev webapp into a usable AgencyHQ execution environment. Runs as a one-shot container in the Compose stack and drives the webapp's web interface to create an organisation, project, credentials, and a deployed task image.

**Status:** Implemented; not yet run against a real Trigger.dev webapp (L1 is the live qualification step).

## What it does

1. **wait_services** — Polls `GET /healthcheck` until the webapp responds HTTP 200.
2. **login** — Starts a minimal SMTP sink on port 2525, requests a magic link for the bootstrap email address, captures the link from the incoming email (MIME-decoded: quoted-printable soft breaks and `=XX` sequences are resolved; HTML entities such as `&amp;` and `&#x3D;` in HTML parts are unescaped; the first URL with a non-empty `token` query parameter wins), follows it to establish an authenticated session. On rerun, the phase checks whether a valid session already exists (GET `/` must not redirect to `/login`); if not, a fresh magic link is requested — a previously captured link is never reused.
3. **org_project** — Finds or creates the organisation and project by slug prefix (`agencyhq`). Reuses existing resources if already present; never creates duplicates.
4. **credentials** — Reads the prod environment secret key (`tr_prod_...`) from the webapp's API keys page. Mints a personal access token (`tr_pat_...`) only when none is already stored. Both are persisted as separate 0600 files in `AGENCYHQ_SECRETS_DIR`, never in the state JSON.
5. **deploy** — Runs `trigger deploy --local-build --external-id <sha256>` from the workspace `trigger/` directory with `TRIGGER_ACCESS_TOKEN` (the PAT file) and `TRIGGER_API_URL` (webapp with DNS-resolved IP, to avoid the CLI's `localhost` → `host.docker.internal` rewrite). Skips the build when `deployment.json` already records the same external ID.
6. **verify_deployment** — `GET /api/v1/deployments/current` with the prod secret key; writes the result into the bootstrap state.
7. **done** — Marks the bootstrap complete.

Each phase is idempotent and resumable: restarting the container picks up from the last completed phase. No secrets or one-time URLs appear in the state JSON or structured logs.

## Environment variables read

| Variable | Default | Description |
| --- | --- | --- |
| `AGENCYHQ_STATE_DIR` | `/var/run/agencyhq/state` | Directory for `bootstrap.json` and `deployment.json`. |
| `AGENCYHQ_SECRETS_DIR` | `/var/run/agencyhq/secrets` | Directory for 0600 secret files (`trigger-prod-key`, `trigger-pat`). |
| `TRIGGER_WEBAPP_URL` | `http://webapp:3000` | Internal URL of the Trigger.dev webapp container. |
| `BOOTSTRAP_EMAIL` | `agencyhq@example.com` | Email address for the magic-link login. Must match `WHITELISTED_EMAILS`/`ADMIN_EMAILS`. |
| `BOOTSTRAP_SMTP_PORT` | `2525` | Port for the built-in SMTP sink (the webapp sends to this host). |
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
| `login` | `magic_link_timeout` | SMTP sink timed out; no magic-link email received. |
| `login` | `login_failed` | Following the magic link returned a non-200 response. |
| `org_project` | `org_create_failed` | Org or project creation failed. |
| `credentials` | `secret_key_missing` | Prod key or PAT not found in the webapp response. |
| `credentials` | `pat_create_failed` | Token creation endpoint returned an unexpected response. |
| `deploy` | `deploy_failed` | `trigger deploy` exited non-zero; see output for details. Re-run to retry. |
| `verify_deployment` | `verify_failed` | `GET /api/v1/deployments/current` returned non-200. |

## Known open questions (L1 required to confirm)

- `--push` flag: the Trigger.dev v4.5.16 docs (read 2026-09-09) do not list a `--push` flag on `trigger deploy`. The local build may push to the registry implicitly; this needs L1 verification.
- `--network` flag: not listed in the v4.5.16 docs. If RUN steps during build need webapp access, use `TRIGGER_DEPLOY_ARGS=--network host` or the socat fallback documented in ADR-0008.
- `/api/v1/deployments/current` route: copied from the plan and bootstrap.sh patterns; requires L1 verification against the real webapp.
