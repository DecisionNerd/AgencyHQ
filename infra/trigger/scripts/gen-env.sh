#!/bin/sh
# agencyhq: generate infra/trigger/.env from .env.example, filling every
# blank secret variable with a fresh value. Idempotent: an existing non-empty
# value is never overwritten, and re-running fills nothing further.
#
# Usage: sh infra/trigger/scripts/gen-env.sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
example_file="$infra_dir/.env.example"
env_file="$infra_dir/.env"

# Variable names that hold secrets. WHITELISTED_EMAILS and every other blank
# in .env.example is a deliberate "unset" default, not a secret to fill.
secret_vars="
SESSION_SECRET
MAGIC_LINK_SECRET
ENCRYPTION_KEY
PROVIDER_SECRET
COORDINATOR_SECRET
MANAGED_WORKER_SECRET
POSTGRES_PASSWORD
CLICKHOUSE_PASSWORD
DOCKER_REGISTRY_PASSWORD
OBJECT_STORE_SECRET_ACCESS_KEY
"

if [ ! -f "$example_file" ]; then
  echo "gen-env.sh: missing $example_file" >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  cp "$example_file" "$env_file"
fi

chmod 600 "$env_file"

filled=""

for name in $secret_vars; do
  # Current value of $name in .env, if the line exists and is non-blank.
  current=$(sed -n "s/^${name}=\(.*\)\$/\1/p" "$env_file" | tail -n 1)

  if [ -n "$current" ]; then
    continue
  fi

  value=$(openssl rand -hex 16)

  if grep -q "^${name}=" "$env_file"; then
    tmp_file="$env_file.tmp.$$"
    sed "s|^${name}=.*|${name}=${value}|" "$env_file" > "$tmp_file"
    mv "$tmp_file" "$env_file"
  else
    printf '%s=%s\n' "$name" "$value" >> "$env_file"
  fi

  filled="$filled $name"
done

chmod 600 "$env_file"

if [ -n "$filled" ]; then
  for name in $filled; do
    echo "$name"
  done
else
  echo "gen-env.sh: no blank secrets to fill" >&2
fi
