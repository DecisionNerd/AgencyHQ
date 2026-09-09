#!/bin/sh
# entrypoint-trigger-worker.sh — wrapper for the Trigger.dev worker stack container.
#
# Sources /run/agencyhq/secrets/trigger-worker.env before exec-ing the original
# Trigger worker stack startup command. This injects MANAGED_WORKER_SECRET
# (and any future secrets) into the process environment.
#
# The Trigger.dev worker stack container is the component that creates and
# manages runner task containers. It connects to the webapp via TRIGGER_API_URL
# and authenticates via TRIGGER_WORKER_TOKEN.
#
# Never logs secret values.
set -eu

SECRETS_FILE="/run/agencyhq/secrets/supervisor.env"  # worker stack secrets

if [ ! -f "$SECRETS_FILE" ]; then
  echo "[entrypoint-trigger-worker] ERROR: secrets file not found: $SECRETS_FILE" >&2
  echo "[entrypoint-trigger-worker] Has secrets-init completed successfully?" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$SECRETS_FILE"
set +a

echo "[entrypoint-trigger-worker] secrets loaded (keys only: MANAGED_WORKER_SECRET)"

exec "$@"
