// Structured-output extraction from an OpenCode SDK AssistantMessage.
//
// Field verified against @opencode-ai/sdk v2 (dist/v2/gen/types.gen.d.ts),
// read 2026-09-07:
//   export type AssistantMessage = { ...; structured?: unknown; ... };
//
// The AssistantMessage.structured field holds the model's structured-output
// value when the prompt was sent with format: { type: "json_schema", schema }.
// This file is the single place that knows the field name, so SDK drift is
// isolated here. parseWithSchema wraps zod safeParse for uniform result shapes
// without importing zod directly (the caller supplies the schema object).

/**
 * Extract the `structured` field from an OpenCode SDK AssistantMessage.
 *
 * Returns { ok: true, value } when the field is present and non-null, or
 * { ok: false, reason } otherwise. The caller should treat a failed extraction
 * as invalid output (not a parse failure).
 */
export function extractStructured(
  info: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof info !== "object" || info === null) {
    return {
      ok: false,
      reason: `response info is not an object (got ${typeof info})`,
    };
  }
  const obj = info as Record<string, unknown>;
  if (!Object.hasOwn(obj, "structured")) {
    return { ok: false, reason: "response info has no 'structured' field" };
  }
  const value = obj.structured;
  if (value === undefined || value === null) {
    return {
      ok: false,
      reason: `response info.structured is ${String(value)}; model may not have produced structured output`,
    };
  }
  return { ok: true, value };
}

/** Minimal Zod-compatible schema interface (avoids importing zod in this file). */
export interface ZodLike<T> {
  safeParse(
    raw: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

/**
 * Parse a raw value against a Zod schema, returning a uniform result shape.
 */
export function parseWithSchema<T>(
  schema: ZodLike<T>,
  raw: unknown,
): { ok: true; value: T } | { ok: false; reason: string } {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, reason: result.error.message };
}
