/**
 * Project aggregate.
 * A linked Git repository with delegated authority schema and verification profile catalog.
 */

import type { Authority } from "@agencyhq/contracts";
import type { ProjectId } from "../ids.ts";

export type Project = {
  readonly id: ProjectId;
  /** Remote URL (HTTPS or SSH). */
  readonly remote: string;
  /** Absolute path to the coordinator-owned clone. */
  readonly clonePath: string;
  /** Base directory for attempt worktrees. */
  readonly worktreeBase: string;
  /** Git refs the coordinator is allowed to checkout or target. */
  readonly allowedRefs: string[];
  /** Identifiers of verification profiles available to this project. */
  readonly profileCatalog: string[];
  /** Delegated authority schema for this project. */
  readonly authority: Authority;
  /** Opaque version string; bumped on every authority update. */
  readonly authorityVersion: string;
};
