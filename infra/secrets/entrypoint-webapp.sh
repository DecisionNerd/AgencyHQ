#!/bin/sh
# entrypoint-webapp.sh — wrapper for the Trigger.dev webapp container.
#
# Sources /run/agencyhq/secrets/webapp.env before exec-ing the original
# webapp startup command. This injects all secret values (SESSION_SECRET,
# MAGIC_LINK_SECRET, ENCRYPTION_KEY, PROVIDER_SECRET, COORDINATOR_SECRET,
# MANAGED_WORKER_SECRET, DATABASE_URL, CLICKHOUSE_URL, etc.) into the process
# environment without requiring them as Docker environment variables at
# container creation time.
#
# Docker-set environment variables (from the compose `environment:` section)
# with empty or placeholder values are overridden by the sourced file.
#
# Never logs secret values.
set -eu

SECRETS_FILE="/run/agencyhq/secrets/webapp.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "[entrypoint-webapp] ERROR: secrets file not found: $SECRETS_FILE" >&2
  echo "[entrypoint-webapp] Has secrets-init completed successfully?" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$SECRETS_FILE"
set +a

echo "[entrypoint-webapp] secrets loaded (keys only: SESSION_SECRET MAGIC_LINK_SECRET ENCRYPTION_KEY PROVIDER_SECRET COORDINATOR_SECRET MANAGED_WORKER_SECRET DATABASE_URL CLICKHOUSE_URL OBJECT_STORE_SECRET_ACCESS_KEY)"

exec "$@"
