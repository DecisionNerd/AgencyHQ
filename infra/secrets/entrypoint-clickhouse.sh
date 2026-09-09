#!/bin/sh
# entrypoint-clickhouse.sh — wrapper for the Clickhouse container.
#
# Sources /run/agencyhq/secrets/clickhouse.env before exec-ing the standard
# Clickhouse entrypoint, so CLICKHOUSE_PASSWORD is set from the secrets
# volume rather than as a Docker environment variable at creation time.
#
# Never logs secret values.
set -eu

SECRETS_FILE="/run/agencyhq/secrets/clickhouse.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "[entrypoint-clickhouse] ERROR: secrets file not found: $SECRETS_FILE" >&2
  echo "[entrypoint-clickhouse] Has secrets-init completed successfully?" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$SECRETS_FILE"
set +a

echo "[entrypoint-clickhouse] secrets loaded (keys only: CLICKHOUSE_PASSWORD)"

exec /entrypoint.sh "$@"
