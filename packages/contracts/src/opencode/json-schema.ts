// Fetched: https://zod.dev/json-schema on 2026-09-07
// Confirmed: z.toJSONSchema(schema, { target: "draft-2020-12" }) and the
// `unrepresentable` option ("throw" | "any") are available in zod 4.5.4.

import { z } from "zod";

import { LeadPlanOutputSchema } from "../lead-proposal.ts";
import { AcceptanceProposalSchema } from "../tasks/lead-accept.ts";
import { ReviewOutputSchema } from "../tasks/lead-review.ts";

/**
 * Convert any Zod schema to a draft-2020-12 JSON Schema object.
 * Throws if the schema contains unrepresentable constructs (e.g. ZodTransform).
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  }) as Record<string, unknown>;
}

/**
 * Pre-built JSON Schemas for each Lead structured output.
 * Pass these to OpenCode's structured-output request to enforce shape.
 */
export const LEAD_OUTPUT_JSON_SCHEMAS = {
  leadPlanOutput: jsonSchemaFor(LeadPlanOutputSchema),
  reviewOutput: jsonSchemaFor(ReviewOutputSchema),
  acceptanceProposal: jsonSchemaFor(AcceptanceProposalSchema),
} as const;
