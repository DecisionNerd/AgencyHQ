/**
 * Runtime profile schemas for AgencyHQ execution environments.
 * See: docs/engineering/ARCHITECTURE.md lines 105-127 (enforcement boundaries table)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// BoundaryKind
// Transcribed from ARCHITECTURE.md enforcement boundaries table (lines 105-127).
// ---------------------------------------------------------------------------
export type BoundaryKind =
  | "worktree"
  | "fs_isolation"
  | "cpu_memory"
  | "duration"
  | "capability"
  | "output_paths"
  | "push"
  | "integrate"
  | "termination"
  | "egress_spend"
  | "nested_agents";

export const BoundaryKindSchema = z.union([
  z.literal("worktree"),
  z.literal("fs_isolation"),
  z.literal("cpu_memory"),
  z.literal("duration"),
  z.literal("capability"),
  z.literal("output_paths"),
  z.literal("push"),
  z.literal("integrate"),
  z.literal("termination"),
  z.literal("egress_spend"),
  z.literal("nested_agents"),
]);

// ---------------------------------------------------------------------------
// EnforcementKind
// See: ARCHITECTURE.md enforcement boundaries table (lines 105-127)
// ---------------------------------------------------------------------------
export type EnforcementKind = "before_action" | "on_output" | "trusted_observation" | "advisory";

export const EnforcementKindSchema = z.union([
  z.literal("before_action"),
  z.literal("on_output"),
  z.literal("trusted_observation"),
  z.literal("advisory"),
]);

// ---------------------------------------------------------------------------
// RuntimeProfileSchema
// ---------------------------------------------------------------------------
export const RuntimeProfileSchema = z.object({
  id: z.union([z.literal("host"), z.literal("container")]),
  enforcement: z.record(BoundaryKindSchema, EnforcementKindSchema),
});

export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;

// ---------------------------------------------------------------------------
// HOST_PROFILE constant
// Transcribed from ARCHITECTURE.md enforcement boundaries table lines 105-127.
// Advisory boundaries on the host profile: fs_isolation, cpu_memory, egress_spend.
// ---------------------------------------------------------------------------
export const HOST_PROFILE: RuntimeProfile = {
  id: "host",
  // Source: docs/engineering/ARCHITECTURE.md lines 105-127 (enforcement boundaries table)
  enforcement: {
    worktree: "before_action",
    fs_isolation: "advisory",
    cpu_memory: "advisory",
    duration: "before_action",
    capability: "before_action",
    output_paths: "on_output",
    push: "before_action",
    integrate: "before_action",
    termination: "trusted_observation",
    egress_spend: "advisory",
    nested_agents: "before_action",
  },
};

// ---------------------------------------------------------------------------
// enforceableBoundaries
// Returns all BoundaryKinds that are NOT advisory in the given profile.
// See: docs/engineering/ARCHITECTURE.md — "A contract that requires a boundary
// the profile marks advisory is rejected at dispatch." (lines 108-109)
// ---------------------------------------------------------------------------
export function enforceableBoundaries(profile: RuntimeProfile): BoundaryKind[] {
  return (Object.entries(profile.enforcement) as [BoundaryKind, EnforcementKind][])
    .filter(([, kind]) => kind !== "advisory")
    .map(([boundary]) => boundary);
}
