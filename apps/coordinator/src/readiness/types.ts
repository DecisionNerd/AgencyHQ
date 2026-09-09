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
 */
export type BootstrapJson = {
  phase: string;
  status: "running" | "done" | "failed";
  error?: string;
  at: string; // ISO-8601 timestamp of the last write
};

/**
 * Shape of <AGENCYHQ_STATE_DIR>/deployment.json.
 * Written by the bootstrap after a successful `trigger deploy`.
 */
export type DeploymentJson = {
  version: string;
  platform: string;
  digest?: string;
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
} | null;

/**
 * Image readiness: null means the deployment.json file is absent (not yet deployed).
 */
export type ImageReadiness = {
  version: string;
  platform: string;
  digest?: string;
  at: string;
} | null;

/**
 * The full readiness response.
 * provider and worker are "unknown" until issues #17/#19 supply real data.
 */
export type ReadinessResponse = {
  services: {
    database: DatabaseStatus;
    trigger: TriggerStatus;
  };
  bootstrap: BootstrapReadiness;
  image: ImageReadiness;
  provider: "unknown";
  worker: "unknown";
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
};
