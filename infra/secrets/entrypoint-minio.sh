#!/bin/bash
# entrypoint-minio.sh — wrapper for the MinIO (bitnami) container.
#
# Sources /run/agencyhq/secrets/minio.env before exec-ing the standard bitnami
# MinIO entrypoint, so MINIO_ROOT_PASSWORD and OBJECT_STORE_SECRET_ACCESS_KEY
# are set from the secrets volume rather than as Docker environment variables
# at creation time.
#
# Never logs secret values.
set -eu

SECRETS_FILE="/run/agencyhq/secrets/minio.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "[entrypoint-minio] ERROR: secrets file not found: $SECRETS_FILE" >&2
  echo "[entrypoint-minio] Has secrets-init completed successfully?" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$SECRETS_FILE"
set +a

echo "[entrypoint-minio] secrets loaded (keys only: MINIO_ROOT_USER MINIO_ROOT_PASSWORD OBJECT_STORE_SECRET_ACCESS_KEY)"

exec /opt/bitnami/scripts/minio/entrypoint.sh /opt/bitnami/scripts/minio/run.sh "$@"
