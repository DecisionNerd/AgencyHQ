/**
 * AgencyHQ toolchain build extension.
 *
 * Adds the required system packages, installs pinned global CLI tools
 * (opencode-ai and pnpm) onto PATH, creates the node-user home directory
 * and the shared run-root, and injects the container-profile environment
 * variables that every task adapter reads.
 *
 * This extension only runs during `trigger deploy` (container profile).
 * It has no effect on `trigger dev` (host profile).
 *
 * --- Type citation (read 2026-09-09) ---
 * BuildExtension interface, BuildContext, and BuildLayer verified from:
 *   node_modules/.pnpm/@trigger.dev+build@4.5.16_.../
 *   node_modules/@trigger.dev/build/dist/commonjs/extensions/index.d.ts
 *   (re-exports from @trigger.dev/core/v3/build/extensions.d.ts)
 *   → BuildExtension { name, onBuildStart?, onBuildComplete?, ... }
 *   → BuildContext { addLayer(layer: BuildLayer): void; ... }
 *   → BuildLayer { id, image?: { pkgs?, instructions? }, deploy?: { env? } }
 * All field names used below are verified from that file (read 2026-09-09).
 * Import uses @trigger.dev/build/extensions (direct devDependency of this
 * package) rather than @trigger.dev/core/v3/build (peer dep, not linked).
 */

import type { BuildContext, BuildExtension } from "@trigger.dev/build/extensions";

/**
 * Pinned tool versions — single source of truth for tests and docs.
 *
 * opencode-ai@1.18.29: matches the host OpenCode version qualified by the
 * Slice 1 trial (docs/engineering/trials/2026-09-slice1.md, 2026-09-07).
 * pnpm@11.25.0: matches the workspace pnpm version (engines field, lockfile).
 */
export const OPENCODE_VERSION = "1.18.29";
export const PNPM_VERSION = "11.25.0";

/** Reserved for future per-project overrides. Currently unused. */
export interface AgencyhqToolchainOptions {
  _reserved?: never;
}

/**
 * Returns a BuildExtension that configures the AgencyHQ task image:
 *
 * Image layer (Dockerfile fragments run as root in the base stage, before
 * the image switches to USER node):
 * - System packages via apt-get: git, ca-certificates
 * - Global npm installs: opencode-ai@OPENCODE_VERSION, pnpm@PNPM_VERSION
 *   (both binaries land in /usr/local/bin, which is on PATH for uid 1000)
 * - mkdir /home/node /tmp/agencyhq, chown to uid 1000 (node)
 * - ENV HOME=/home/node and ENV AGENCYHQ_RUN_ROOT=/tmp/agencyhq for anything
 *   that inherits the image environment (the task process does not, see below)
 *
 * Deploy-time environment (synced to the Trigger deployment, injected into
 * every task run at runtime — no secret values):
 * - AGENCYHQ_RUNTIME_PROFILE=container
 * - AGENCYHQ_COORDINATOR_INTERNAL_URL=http://app:8787
 * - AGENCYHQ_RUN_ROOT=/tmp/agencyhq
 * - HOME=/home/node — the managed runner builds the task process environment
 *   from the deployment's env vars, not from the image ENV (observed
 *   2026-09-09: `runtime.probe` saw no HOME key although the image sets it),
 *   so HOME must travel as a deploy env var for opencode, pnpm and git.
 */
export function agencyhqToolchain(_opts?: AgencyhqToolchainOptions): BuildExtension {
  return {
    name: "agencyhq-toolchain",

    // onBuildComplete signature verified against extensions.d.ts (read 2026-09-09):
    // onBuildComplete?(context: BuildContext, manifest: BuildManifest): Promise<undefined|void>|undefined|void
    onBuildComplete(context: BuildContext): void {
      // addLayer signature verified against extensions.d.ts (read 2026-09-09):
      // context.addLayer(layer: BuildLayer): void
      context.addLayer({
        id: "agencyhq-toolchain",

        // image.pkgs: list of apt-get package names installed as root in the
        // base stage. Verified from BuildLayer.image.pkgs in extensions.d.ts
        // (read 2026-09-09).
        // image.instructions: Dockerfile RUN/ENV lines inserted as root.
        // Verified from BuildLayer.image.instructions in extensions.d.ts
        // (read 2026-09-09).
        image: {
          pkgs: ["git", "ca-certificates"],
          instructions: [
            // Install both CLIs in one npm invocation so they share the
            // global prefix (/usr/local). The Trigger base image has npm/node
            // on PATH; global bin lands in /usr/local/bin (on PATH for all
            // users including uid 1000 node).
            `RUN npm install -g opencode-ai@${OPENCODE_VERSION} pnpm@${PNPM_VERSION}`,
            // Create the node user's writable home and the shared run root.
            // chown to uid 1000 (node) so task processes can write there
            // without privilege escalation.
            "RUN mkdir -p /home/node /tmp/agencyhq && chown 1000:1000 /home/node /tmp/agencyhq",
            // Set HOME so that Node child processes, opencode, and npm find
            // a writable home directory. The Trigger runner sets uid=1000 but
            // does not always set HOME in the container environment (HOME was
            // unset in the Slice 6 container trial, 2026-09-08).
            "ENV HOME=/home/node",
            // Declare the shared run root so task adapters find it without
            // requiring an extra coordinator-supplied env var.
            "ENV AGENCYHQ_RUN_ROOT=/tmp/agencyhq",
          ],
        },

        // deploy.env: key-value pairs synced to the Trigger deployment and
        // injected into every task run environment at dispatch time.
        // No secret values are included here.
        // Verified from BuildLayer.deploy.env in extensions.d.ts (read 2026-09-09).
        deploy: {
          env: {
            AGENCYHQ_RUNTIME_PROFILE: "container",
            // Internal coordinator URL reachable by task containers via the
            // agencyhq Docker network (supervisor injects DOCKER_RUNNER_NETWORKS).
            AGENCYHQ_COORDINATOR_INTERNAL_URL: "http://app:8787",
            AGENCYHQ_RUN_ROOT: "/tmp/agencyhq",
            // The runner does not pass the image ENV to the task process
            // (L1, 2026-09-09); the writable home is created in the image layer.
            HOME: "/home/node",
          },
        },
      });
    },
  };
}
