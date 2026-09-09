/**
 * Pure function that computes the readiness response from injected inputs.
 *
 * No I/O.  All file reads and service probes happen in the loader; this
 * function only assembles the response and derives nextAction from the inputs.
 * No secret values appear in any output.
 */

import type {
  BootstrapReadiness,
  ImageReadiness,
  ReadinessInputs,
  ReadinessResponse,
} from "./types.ts";

/**
 * Derive a human-readable nextAction sentence from the readiness inputs.
 *
 * Rules (evaluated in order):
 * 1. Database down → instruct operator to check agencyhq-postgres.
 * 2. Bootstrap absent → instruct operator to run `docker compose up -d`.
 * 3. Bootstrap running → report current phase.
 * 4. Bootstrap failed → surface phase and error category.
 * 5. Bootstrap done but trigger unconfigured → bootstrap may still be deploying the key.
 * 6. Bootstrap done but image absent → deploy still in progress.
 * 7. All ready → instruct operator to log in with OpenCode.
 */
function deriveNextAction(inputs: ReadinessInputs): string {
  const { database, trigger, bootstrapJson, deploymentJson } = inputs;

  if (database === "down") {
    return "Database is unavailable; check the agencyhq-postgres container";
  }

  if (bootstrapJson === null) {
    return "Bootstrap not started; run `docker compose up -d`";
  }

  if (bootstrapJson.status === "running") {
    return `Bootstrap is running: phase ${bootstrapJson.phase}`;
  }

  if (bootstrapJson.status === "failed") {
    const category = bootstrapJson.error ?? "unknown";
    return `Bootstrap failed at ${bootstrapJson.phase}: ${category}; run \`docker compose logs bootstrap\``;
  }

  // Bootstrap is done from here on.
  if (trigger === "unconfigured") {
    return "Trigger key not yet available; bootstrap may still be writing credentials";
  }

  if (trigger === "down") {
    return "Trigger API is unreachable; check the Trigger webapp container";
  }

  if (deploymentJson === null) {
    return "Task image not yet deployed; bootstrap may still be deploying";
  }

  return "Ready for provider login: run `docker compose exec opencode opencode auth login`";
}

/**
 * Build the full readiness response from injected inputs.
 * Pure — no I/O, no side effects.
 */
export function buildReadiness(inputs: ReadinessInputs): ReadinessResponse {
  const { database, trigger, bootstrapJson, deploymentJson } = inputs;

  const bootstrap: BootstrapReadiness = bootstrapJson
    ? {
        phase: bootstrapJson.phase,
        status: bootstrapJson.status,
        ...(bootstrapJson.error !== undefined ? { error: bootstrapJson.error } : {}),
        at: bootstrapJson.at,
      }
    : null;

  const image: ImageReadiness = deploymentJson
    ? {
        version: deploymentJson.version,
        platform: deploymentJson.platform,
        ...(deploymentJson.digest !== undefined ? { digest: deploymentJson.digest } : {}),
        at: deploymentJson.at,
      }
    : null;

  const nextAction = deriveNextAction(inputs);

  return {
    services: { database, trigger },
    bootstrap,
    image,
    provider: "unknown",
    worker: "unknown",
    nextAction,
  };
}
