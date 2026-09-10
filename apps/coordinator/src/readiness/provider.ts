/**
 * Provider and worker readiness computation.
 *
 * Feeds the `provider` and `worker` fields of the /api/readiness response.
 * Pure — no I/O. All file reads and capacity queries happen in the loader.
 *
 * No credential values appear in any output.
 */

import type { ProviderStatus } from "../provider/state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderReadinessStatus =
  | "ready"
  | "login_required"
  | "expired"
  | "unavailable"
  | "unknown";

export type WorkerReadinessStatus =
  | "ready"
  | "login_required"
  | "expired"
  | "unavailable"
  | "unknown";

export interface ProviderReadinessResult {
  provider: ProviderReadinessStatus;
  worker: WorkerReadinessStatus;
}

// ---------------------------------------------------------------------------
// buildProviderReadiness
// ---------------------------------------------------------------------------

/**
 * Compute the provider and worker readiness fields.
 *
 * worker = "ready" when the task image is registered AND provider is "ready".
 * worker mirrors the provider status when provider is not ready.
 * When providerStatus is undefined (host profile), both fields are "unknown".
 */
export function buildProviderReadiness(input: {
  providerStatus: ProviderStatus | undefined;
  imageRegistered: boolean;
}): ProviderReadinessResult {
  const { providerStatus, imageRegistered } = input;

  if (providerStatus === undefined) {
    return { provider: "unknown", worker: "unknown" };
  }

  const provider: ProviderReadinessStatus = providerStatus;

  // worker is ready only when both image is registered and provider is ready
  let worker: WorkerReadinessStatus;
  if (providerStatus === "ready") {
    worker = imageRegistered ? "ready" : "unavailable";
  } else {
    worker = providerStatus;
  }

  return { provider, worker };
}

// ---------------------------------------------------------------------------
// nextAction hints for provider states
// ---------------------------------------------------------------------------

/**
 * Return the nextAction string for a given provider status.
 * Returns null when the provider is ready (caller uses other logic for nextAction).
 */
export function providerNextAction(providerStatus: ProviderStatus | undefined): string | null {
  if (providerStatus === "login_required") {
    return "Provider login required: run `docker compose exec opencode opencode auth login`";
  }
  if (providerStatus === "expired") {
    return "Provider credentials expired or rejected: run `docker compose exec opencode opencode auth login` again";
  }
  if (providerStatus === "unavailable") {
    return "OpenCode setup volume unavailable; check the opencode service";
  }
  return null;
}
