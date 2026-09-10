/**
 * Shared types for the coordinator readiness subsystem.
 *
 * These types define the shape of bootstrap.json and deployment.json written
 * by the bootstrap container, and the shape of the /api/readiness response.
 * No secret values appear in any of these types.
 */

// ---------------------------------------------------------------------------
// State-file shapes (written by the bootstrap container)
// ---------------------------------------------------------------------------

/**
 * Shape of <AGENCYHQ_STATE_DIR>/bootstrap.json.
 * The bootstrap container writes this file as it progresses through phases.
 *
 * Phases (in order): wait, smtp, org, project, credentials, deploy, verify, done
 * Status: running | done | failed
 * error: present only when status === "failed"; contains a category string, never a secret.
 * nextRetryAt: ISO timestamp of the next retry attempt; set when the bootstrap is backing
 *   off after a transient failure (e.g. login_rate_limited). Cleared on success.
 */
export type BootstrapJson = {
  phase: string;
  status: "running" | "done" | "failed";
  error?: string;
  at: string; // ISO-8601 timestamp of the last write
  nextRetryAt?: string; // ISO-8601 timestamp of the next retry attempt (backoff)
};

/**
 * Shape of <AGENCYHQ_STATE_DIR>/deployment.json.
 * Written by the bootstrap deploy phase; enriched with version/imageRef
 * after the verify phase calls GET /api/v1/deployments/current.
 *
 * Fields are optional because the file may be read between the deploy phase
 * (which writes platform/externalId/at) and the verify phase (which adds
 * version/imageRef). Consumers should treat absent fields as "not yet available".
 */
export type DeploymentJson = {
  version?: string;
  platform?: string;
  imageRef?: string;
  externalId?: string;
  at: string; // ISO-8601 timestamp of the deployment
};

// ---------------------------------------------------------------------------
// Readiness response shape (returned by GET /api/readiness)
// ---------------------------------------------------------------------------

export type DatabaseStatus = "ok" | "down";
export type TriggerStatus = "ok" | "down" | "unconfigured";

/**
 * Bootstrap readiness: null means the bootstrap.json file is absent (not started).
 */
export type BootstrapReadiness = {
  phase: string;
  status: "running" | "done" | "failed";
  error?: string;
  at: string;
  nextRetryAt?: string; // ISO timestamp of the next retry (backoff in progress)
} | null;

/**
 * Image readiness: null means the deployment.json file is absent (not yet deployed).
 * Fields mirror DeploymentJson — version/platform may be absent if the verify
 * phase has not completed yet.
 */
export type ImageReadiness = {
  version?: string;
  platform?: string;
  imageRef?: string;
  externalId?: string;
  at: string;
} | null;

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

/**
 * The full readiness response.
 * provider and worker reflect OpenCode auth and image registration state.
 */
export type ReadinessResponse = {
  services: {
    database: DatabaseStatus;
    trigger: TriggerStatus;
  };
  bootstrap: BootstrapReadiness;
  image: ImageReadiness;
  provider: ProviderReadinessStatus;
  worker: WorkerReadinessStatus;
  nextAction: string;
};

// ---------------------------------------------------------------------------
// Inputs to the pure buildReadiness function
// ---------------------------------------------------------------------------

export type ReadinessInputs = {
  /** Current database reachability. */
  database: DatabaseStatus;
  /** Current Trigger API reachability (unconfigured = no key available). */
  trigger: TriggerStatus;
  /** Contents of bootstrap.json, or null if the file is absent. */
  bootstrapJson: BootstrapJson | null;
  /** Contents of deployment.json, or null if the file is absent. */
  deploymentJson: DeploymentJson | null;
  /**
   * Provider auth state derived from reading the OpenCode auth.json.
   * Absent on the host profile where no dataDir is configured.
   * When absent, provider and worker fields in the response are "unknown".
   */
  providerStatus?: import("../provider/state.ts").ProviderStatus | undefined;
};
