#!/bin/sh
# entrypoint-app.sh — wrapper for the AgencyHQ app container.
#
# Sources /run/agencyhq/secrets/agencyhq.env before exec-ing the coordinator
# startup command. This injects DATABASE_URL (pointing at agencyhq-postgres),
# AGENCYHQ_API_TOKEN, and the AGENCYHQ_POSTGRES_PASSWORD into the process
# environment without requiring them in Docker environment variables at
# container creation time.
#
# TRIGGER_SECRET_KEY (trigger-prod.key) is written to the agencyhq-state volume
# by the bootstrap container after it mints the production environment key.
# The coordinator reads it lazily on every readiness poll via readTriggerKeyFromState
# (apps/coordinator/src/config.ts) — no entrypoint injection needed. The app
# starts before bootstrap completes and shows an explicit readiness state.
#
# Never logs secret values.
set -eu

SECRETS_FILE="/run/agencyhq/secrets/agencyhq.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "[entrypoint-app] ERROR: secrets file not found: $SECRETS_FILE" >&2
  echo "[entrypoint-app] Has secrets-init completed successfully?" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$SECRETS_FILE"
set +a

echo "[entrypoint-app] secrets loaded (keys only: DATABASE_URL AGENCYHQ_API_TOKEN AGENCYHQ_POSTGRES_PASSWORD)"

exec "$@"
