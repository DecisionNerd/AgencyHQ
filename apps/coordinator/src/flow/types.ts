/**
 * FlowDeps — shared dependencies injected into all flow components.
 */

import type { RuntimeProfile } from "@agencyhq/contracts";
import type { createPool } from "@agencyhq/db";
import type { Clock, ExecutionRuntime, IdGen } from "@agencyhq/domain";

// ---------------------------------------------------------------------------
// ProfileResolver
// ---------------------------------------------------------------------------

/**
 * Resolves a verification profile by its id, returning the digest and checks.
 * Decouples flow/payloads.ts from @agencyhq/verification.
 */
export type ProfileResolver = (profileId: string) => Promise<{
  digest: string;
  checks: { id: string; version: string; command: string[]; timeoutSeconds: number }[];
  protectedPaths: string[];
}>;

// ---------------------------------------------------------------------------
// FlowConfig
// ---------------------------------------------------------------------------

export interface FlowConfig {
  worktreeBase: string;
  workerModel: string;
  leadModel: string;
  reviewerModel: string;
  verifierName: string;
  leadVariant?: string | undefined;
  /** Milliseconds before a stop without evidence is classified uncertain. */
  uncertainAfterMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// FlowDeps
// ---------------------------------------------------------------------------

export interface FlowDeps {
  pool: ReturnType<typeof createPool>;
  runtime: ExecutionRuntime;
  clock: Clock;
  ids: IdGen;
  profile: RuntimeProfile;
  config: FlowConfig;
  profileResolver: ProfileResolver;
}
