# infra/app/Dockerfile — multi-stage build for AgencyHQ container images.
#
# Targets:
#   app      — coordinator + served web dist; runs as uid 1000; no build tools
#   tools    — app + Docker CLI + buildx; used by secrets-init and bootstrap
#   opencode — OpenCode AI service; sleep infinity; non-root opencode user
#
# Requirements: Docker BuildKit (default since Docker 23+).
# Platform: linux/arm64 by default; set AGENCYHQ_PLATFORM=linux/amd64 to cross-build.
#
# No credentials, host home directories, or .env files are copied into any layer.

# ─── base ─────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ─── deps ─────────────────────────────────────────────────────────────────────
# Install dependencies from the lockfile only (no source code yet).
FROM base AS deps

WORKDIR /app

# Enable pnpm via corepack at the pinned version.
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

# Copy workspace manifest files (order matters for layer caching).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./

# Copy each package's manifest so pnpm can resolve the workspace graph.
COPY apps/coordinator/package.json apps/coordinator/
COPY apps/web/package.json         apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json        packages/db/
COPY packages/domain/package.json    packages/domain/
COPY packages/verification/package.json packages/verification/
COPY trigger/package.json            trigger/

# Install all workspace dependencies without running lifecycle scripts that
# need the actual source (build steps happen in later stages).
RUN pnpm install --frozen-lockfile

# ─── web-build ────────────────────────────────────────────────────────────────
# Build the static web app. This stage is separate so a coordinator-only
# change does not invalidate the web build cache.
FROM deps AS web-build

WORKDIR /app

# Copy source required for the web build.
COPY apps/web/ apps/web/
COPY packages/contracts/ packages/contracts/
COPY packages/domain/ packages/domain/
COPY biome.json ./

RUN pnpm --filter @agencyhq/web build

# ─── app ──────────────────────────────────────────────────────────────────────
# Production image: coordinator + served web dist.
# Runs as uid 1000 (agencyhq). No build tools; Node type-stripping at runtime.
FROM base AS app

WORKDIR /app

# Create a non-root user for the coordinator process.
RUN groupadd -r agencyhq --gid 1000 && useradd -r -g agencyhq --uid 1000 -d /app agencyhq

# Copy node_modules from the deps stage (includes workspace symlinks).
COPY --from=deps /app/node_modules ./node_modules

# Copy workspace source (coordinator and its dependencies).
COPY --chown=agencyhq:agencyhq package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=agencyhq:agencyhq apps/coordinator/ apps/coordinator/
COPY --chown=agencyhq:agencyhq packages/contracts/ packages/contracts/
COPY --chown=agencyhq:agencyhq packages/db/ packages/db/
COPY --chown=agencyhq:agencyhq packages/domain/ packages/domain/
COPY --chown=agencyhq:agencyhq packages/verification/ packages/verification/
COPY --chown=agencyhq:agencyhq trigger/src/ trigger/src/
COPY --chown=agencyhq:agencyhq trigger/package.json trigger/

# Copy the built web dist.
COPY --chown=agencyhq:agencyhq --from=web-build /app/apps/web/dist apps/web/dist

# Entrypoint wrapper (secrets injection); must be executable.
COPY infra/secrets/entrypoint-app.sh /usr/local/bin/entrypoint-app.sh
RUN chmod +x /usr/local/bin/entrypoint-app.sh

# State and git volumes.
RUN mkdir -p /var/agencyhq/state /var/agencyhq/git && chown -R agencyhq:agencyhq /var/agencyhq

# The web dist is pre-built and copied above; the coordinator serves it.
ENV WEB_DIST=/app/apps/web/dist
ENV PORT=8787
ENV AGENCYHQ_BIND_HOST=0.0.0.0
ENV AGENCYHQ_STATE_DIR=/var/agencyhq/state
ENV AGENCYHQ_GIT_DIR=/var/agencyhq/git

USER agencyhq

# Run migrations then start the coordinator (Node 24 type-stripping; no build step).
ENTRYPOINT ["/usr/local/bin/entrypoint-app.sh"]
CMD ["node", "--experimental-strip-types", "apps/coordinator/src/main.ts"]

# ─── tools ────────────────────────────────────────────────────────────────────
# app + Docker CLI + buildx plugin.
# Used by: secrets-init (Node; generates secrets in the secrets volume),
#          bootstrap (TypeScript; bootstraps the Trigger project and runs
#          `trigger deploy --local-build` via the docker-proxy-build socket).
FROM app AS tools

USER root

# Docker CLI and buildx plugin (matching Docker Desktop 28.x feature set).
# Using the docker.io package from Debian stable (bookworm) keeps the install
# simple; for exact version pinning in CI replace with the upstream apt repo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      docker.io \
      docker-buildx \
 && rm -rf /var/lib/apt/lists/*

# Copy entrypoint wrappers used by other container roles.
COPY infra/secrets/entrypoint-webapp.sh         /usr/local/bin/entrypoint-webapp.sh
COPY infra/secrets/entrypoint-trigger-worker.sh /usr/local/bin/entrypoint-trigger-worker.sh
COPY infra/secrets/entrypoint-clickhouse.sh     /usr/local/bin/entrypoint-clickhouse.sh
COPY infra/secrets/entrypoint-minio.sh          /usr/local/bin/entrypoint-minio.sh
COPY infra/secrets/secrets-init.mjs             /usr/local/bin/secrets-init.mjs

RUN chmod +x /usr/local/bin/entrypoint-webapp.sh \
             /usr/local/bin/entrypoint-trigger-worker.sh \
             /usr/local/bin/entrypoint-clickhouse.sh \
             /usr/local/bin/entrypoint-minio.sh

# Default: run the secrets initialiser. Bootstrap overrides CMD.
USER agencyhq
CMD ["node", "/usr/local/bin/secrets-init.mjs"]

# ─── opencode ─────────────────────────────────────────────────────────────────
# Minimal OpenCode AI service image.
# Usage: docker compose exec opencode opencode auth login
# The container sleeps indefinitely and persists provider credentials in a
# named volume mounted at $HOME/.local/share/opencode.
FROM base AS opencode

# Install the pinned opencode-ai CLI globally.
# This must match the version installed in the task image (trigger/build/toolchain.ts).
RUN npm install -g opencode-ai@1.18.29

# Non-root user for OpenCode; UID 1001 to avoid conflict with the app user.
RUN groupadd -r opencode --gid 1001 && useradd -r -g opencode --uid 1001 -m -d /home/opencode opencode

ENV HOME=/home/opencode

USER opencode

# Provider state is stored in $HOME/.local/share/opencode (a named volume).
# The opencode-config volume holds any additional configuration.
CMD ["sleep", "infinity"]
