#!/bin/sh
# entrypoint-app.sh — wrapper for the AgencyHQ app container.
#
# Sources /run/agencyhq/secrets/agencyhq.env before exec-ing the coordinator
# startup command. This injects DATABASE_URL (pointing at agencyhq-postgres),
# AGENCYHQ_API_TOKEN, and the AGENCYHQ_POSTGRES_PASSWORD into the process
# environment without requiring them in Docker environment variables at
# container creation time.
#
# TRIGGER_SECRET_KEY is written to the agencyhq-state volume by the bootstrap
# container after it mints the production environment key. If it is available
# in the state volume, this script reads it from there. If not, the
# coordinator starts without it and shows an explicit readiness state.
#
# Never logs secret values.
set -eu

SECRETS_FILE="/run/agencyhq/secrets/agencyhq.env"
STATE_DIR="${AGENCYHQ_STATE_DIR:-/var/agencyhq/state}"
TRIGGER_KEY_FILE="$STATE_DIR/trigger-secret-key"

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

# Load TRIGGER_SECRET_KEY from state volume if available (written by bootstrap).
if [ -f "$TRIGGER_KEY_FILE" ]; then
  TRIGGER_SECRET_KEY=$(cat "$TRIGGER_KEY_FILE")
  export TRIGGER_SECRET_KEY
  echo "[entrypoint-app] TRIGGER_SECRET_KEY loaded from state volume"
else
  echo "[entrypoint-app] TRIGGER_SECRET_KEY not yet available (bootstrap pending)"
fi

exec "$@"
