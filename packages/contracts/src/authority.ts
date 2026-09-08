/**
 * Delegated-authority schema for AgencyHQ projects and work items.
 * See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
 */

import { z } from "zod";

import type { Digest } from "./digest.ts";

// ---------------------------------------------------------------------------
// PathPatternString
// Validated at runtime by packages/contracts/src/path-pattern.ts (wave 2.A).
// Here we use a plain string with z.string().min(1) validation.
// ---------------------------------------------------------------------------
export type PathPatternString = string; // validated by path-pattern.ts (wave 2.A)

// ---------------------------------------------------------------------------
// DigestSchema
// ---------------------------------------------------------------------------
export const DigestSchema = z.custom<Digest>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  { message: "expected sha256:<64 hex>" },
);

// ---------------------------------------------------------------------------
// ChangeClass
// See: docs/engineering/TESTING.md lines 51-73
// ---------------------------------------------------------------------------
export type ChangeClass = "editorial" | "behavior" | "shared_interface";

export const ChangeClassSchema = z.union([
  z.literal("editorial"),
  z.literal("behavior"),
  z.literal("shared_interface"),
]);

// ---------------------------------------------------------------------------
// ReviewProfile
// See: docs/engineering/TESTING.md lines 51-73
// Ordered from least to most review depth.
// ---------------------------------------------------------------------------
export type ReviewProfile =
  | "none"
  | "lead_inspection"
  | "adversarial"
  | "adversarial_distinct_model";

export const ReviewProfileSchema = z.union([
  z.literal("none"),
  z.literal("lead_inspection"),
  z.literal("adversarial"),
  z.literal("adversarial_distinct_model"),
]);

/** Ordered least-to-most review depth. */
export const REVIEW_PROFILE_ORDER: readonly ReviewProfile[] = [
  "none",
  "lead_inspection",
  "adversarial",
  "adversarial_distinct_model",
] as const;

/**
 * Returns true when review profile `a` is at least as strong as `b`.
 * "At least" means a's position in REVIEW_PROFILE_ORDER >= b's position.
 */
export function reviewProfileAtLeast(a: ReviewProfile, b: ReviewProfile): boolean {
  return REVIEW_PROFILE_ORDER.indexOf(a) >= REVIEW_PROFILE_ORDER.indexOf(b);
}

// ---------------------------------------------------------------------------
// Boundary
// See: docs/engineering/adrs/0006-lead-role-and-delegated-authority.md
// ---------------------------------------------------------------------------
export type Boundary = "artifact" | "merge" | "deploy";

export const BoundarySchema = z.union([
  z.literal("artifact"),
  z.literal("merge"),
  z.literal("deploy"),
]);

// ---------------------------------------------------------------------------
// WorkerTool
// See: trigger/src/lib/opencode.ts buildPermissionRuleset
// ---------------------------------------------------------------------------
export type WorkerTool =
  | "edit"
  | "webfetch"
  | "websearch"
  | "task"
  | "external_directory"
  | "skill";

export const WorkerToolSchema = z.union([
  z.literal("edit"),
  z.literal("webfetch"),
  z.literal("websearch"),
  z.literal("task"),
  z.literal("external_directory"),
  z.literal("skill"),
]);

// ---------------------------------------------------------------------------
// Named sub-schemas for AuthoritySchema fields.
// Exported so callers can reference them directly without duplicating shapes.
// ---------------------------------------------------------------------------

export const PathsSchema = z.object({
  allow: z.array(z.string().min(1)),
  deny: z.array(z.string().min(1)),
});
export type Paths = z.infer<typeof PathsSchema>;

export const BudgetSchema = z.object({
  maxAttempts: z.int().gte(1),
  maxDurationSeconds: z.int().gte(5),
  machine: z.string().min(1).optional(),
  estimatedSpendUsd: z.number().gte(0),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const CapabilitiesSchema = z.object({
  bash: z.object({
    allow: z.array(z.string().min(1)),
    deny: z.array(z.string().min(1)),
  }),
  tools: z.record(WorkerToolSchema, z.boolean()),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ModelsSchema = z.object({
  worker: z.array(z.string().min(1)),
  lead: z.array(z.string().min(1)),
  reviewer: z.array(z.string().min(1)),
  reviewerMustDiffer: z.boolean(),
});
export type Models = z.infer<typeof ModelsSchema>;

export const HumanRequiredSchema = z.object({
  paths: z.array(z.string().min(1)),
  changeClasses: z.array(ChangeClassSchema),
  boundaries: z.array(BoundarySchema),
});
export type HumanRequired = z.infer<typeof HumanRequiredSchema>;

export const ReviewMinimumSchema = z.object({
  minimum: z.record(ChangeClassSchema, ReviewProfileSchema),
});
export type ReviewMinimum = z.infer<typeof ReviewMinimumSchema>;

// ---------------------------------------------------------------------------
// AuthoritySchema
// ---------------------------------------------------------------------------
export const AuthoritySchema = z.object({
  version: z.string().min(1),
  paths: PathsSchema,
  capabilities: CapabilitiesSchema,
  boundaries: z.array(BoundarySchema),
  budget: BudgetSchema,
  review: ReviewMinimumSchema,
  models: ModelsSchema,
  humanRequired: HumanRequiredSchema,
});

export type Authority = z.infer<typeof AuthoritySchema>;

// ---------------------------------------------------------------------------
// AuthorityNarrowingSchema
// All fields optional — used for per-WorkItem narrowing.
// See: docs/engineering/DOMAIN_MODEL.md lines 56-62
// ---------------------------------------------------------------------------
export const AuthorityNarrowingSchema = z.object({
  version: z.string().min(1).optional(),
  paths: PathsSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
  boundaries: z.array(BoundarySchema).optional(),
  budget: BudgetSchema.optional(),
  review: ReviewMinimumSchema.optional(),
  models: ModelsSchema.optional(),
  humanRequired: HumanRequiredSchema.optional(),
});

export type AuthorityNarrowing = z.infer<typeof AuthorityNarrowingSchema>;

// ---------------------------------------------------------------------------
// HOST_TRIAL_AUTHORITY example constant
// Represents a host-profile authority scoped to parsing work.
// ---------------------------------------------------------------------------
export const HOST_TRIAL_AUTHORITY: Authority = {
  version: "1",
  paths: {
    allow: ["src/parser/**", "test/parser/**"],
    deny: [".github/**", "package.json", "opencode.json*", ".opencode/**"],
  },
  capabilities: {
    bash: {
      allow: ["pnpm test*", "pnpm typecheck", "git status*", "git diff*"],
      deny: [],
    },
    tools: {
      edit: true,
      webfetch: false,
      websearch: false,
      task: false,
      external_directory: false,
      skill: false,
    },
  },
  boundaries: ["artifact"],
  budget: {
    maxAttempts: 2,
    maxDurationSeconds: 1200,
    estimatedSpendUsd: 5,
  },
  review: {
    minimum: {
      editorial: "lead_inspection",
      behavior: "adversarial",
      shared_interface: "adversarial_distinct_model",
    },
  },
  models: {
    worker: ["openai/gpt-5.6-terra"],
    lead: ["openai/gpt-5.6-sol"],
    reviewer: ["openai/gpt-5.6-sol"],
    reviewerMustDiffer: true,
  },
  humanRequired: {
    paths: ["src/parser/public-api.ts"],
    changeClasses: [],
    boundaries: ["merge", "deploy"],
  },
};
