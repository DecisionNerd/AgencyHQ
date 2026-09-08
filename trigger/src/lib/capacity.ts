// Pure capacity classification from OpenCode event streams.
// No SDK or framework imports — this file is safe to import from domain/test code.
//
// Design: scan OpenCode events for error signals and map them to a capacity
// classification.  The function returns null when no relevant signal is found
// (the caller should treat that as "capacity unknown").
//
// Classification rules (first match wins, ordered from most specific to least):
//   401/403 / "invalid api key" / "insufficient credits"
//     → status: "down", validUntil: +30 min
//   HTTP 429 / "rate limit" / "quota" / "overloaded"
//     → status: "limited", validUntil: +5 min
//   5xx / "unavailable"
//     → status: "limited", validUntil: +2 min
//   nothing matched → null
//
// Callers that do not have a raw event stream (e.g. the lead tasks, which use
// the OpenCode SDK server mode rather than `opencode run --format json`) can
// construct a synthetic event from the caught error message:
//
//   const syntheticEvent: OpenCodeEvent = { type: "error", error: { message: errorMessage } };
//   classifyCapacity([syntheticEvent], { provider, model, now });
//
// This keeps the function's public surface minimal while making it useful for
// both the worker path (real NDJSON events) and the lead path (caught errors).

import type { OpenCodeEvent } from "../types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata key: "capacity".  Shape stored under run metadata. */
export type CapacityClassification = {
  /** Provider segment of the model string, e.g. "openai". */
  provider: string;
  /** Full provider/model string, e.g. "openai/gpt-4". */
  model: string;
  /** "limited" = provider is throttling; "down" = provider is unreachable/auth failed. */
  status: "limited" | "down";
  /** ISO-8601 timestamp when the signal was observed. */
  observedAt: string;
  /** ISO-8601 timestamp after which the classification should be re-evaluated. */
  validUntil: string;
  /** Human-readable excerpt from the event that triggered the classification. */
  evidence: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS = {
  /** "limited" window for rate-limit / quota / overloaded signals. */
  LIMITED_5MIN: 5 * 60 * 1000,
  /** "limited" window for 5xx / unavailable signals. */
  LIMITED_2MIN: 2 * 60 * 1000,
  /** "down" window for auth / quota-exhausted signals. */
  DOWN_30MIN: 30 * 60 * 1000,
} as const;

// Text patterns — tested against the full extracted message string (case-insensitive).
const AUTH_DOWN_TEXT: RegExp[] = [/invalid.{0,4}api.{0,4}key/i, /insufficient.{0,8}credits/i];
const RATE_LIMIT_TEXT: RegExp[] = [/rate.?limit/i, /quota/i, /overloaded/i];
const SERVER_ERROR_TEXT: RegExp[] = [/unavailable/i];

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Extract the human-readable text from any OpenCode event, or "". */
function extractText(event: OpenCodeEvent): string {
  const r = event as Record<string, unknown>;
  const errField = r.error as { message?: unknown; data?: { message?: unknown } } | undefined;
  const candidates: unknown[] = [
    r.text,
    r.message,
    (r.part as { text?: unknown } | undefined)?.text,
    errField?.data?.message,
    errField?.message,
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return "";
}

/** Extract the HTTP status code from an OpenCode error event, or undefined. */
function extractStatusCode(event: OpenCodeEvent): number | undefined {
  const r = event as Record<string, unknown>;
  const errField = r.error as { data?: { statusCode?: unknown } } | undefined;
  const code = errField?.data?.statusCode;
  return typeof code === "number" ? code : undefined;
}

/** Add `ms` milliseconds to `base` and return an ISO-8601 string. */
function addMs(base: Date, ms: number): string {
  return new Date(base.getTime() + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `events` for provider capacity signals and return a classification.
 *
 * Returns `null` when no relevant signal is found in the event stream.
 *
 * The `provider` and `model` arguments are only used to populate the returned
 * classification; they do not affect the pattern matching.  Pass the full
 * `provider/model` string (e.g. `"openai/gpt-4"`) for `model` and the
 * provider segment for `provider` (use `providerFromModel` if you have the
 * full model string and need to split it).
 */
export function classifyCapacity(
  events: OpenCodeEvent[],
  args: { provider: string; model: string; now: Date },
): CapacityClassification | null {
  const { provider, model, now } = args;
  const observedAt = now.toISOString();

  for (const event of events) {
    const text = extractText(event);
    const statusCode = extractStatusCode(event);

    // --- auth / credentials down (401, 403, "invalid api key", "insufficient credits") ---
    const isAuthDown =
      statusCode === 401 || statusCode === 403 || AUTH_DOWN_TEXT.some((p) => p.test(text));
    if (isAuthDown) {
      return {
        provider,
        model,
        status: "down",
        observedAt,
        validUntil: addMs(now, MS.DOWN_30MIN),
        evidence: (text || String(statusCode ?? "auth error")).slice(0, 200),
      };
    }

    // --- rate limit / quota / overloaded → limited 5 min ---
    const isRateLimit = statusCode === 429 || RATE_LIMIT_TEXT.some((p) => p.test(text));
    if (isRateLimit) {
      return {
        provider,
        model,
        status: "limited",
        observedAt,
        validUntil: addMs(now, MS.LIMITED_5MIN),
        evidence: (text || String(statusCode ?? "rate limit")).slice(0, 200),
      };
    }

    // --- 5xx / "unavailable" → limited 2 min ---
    const isServerError =
      (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
      SERVER_ERROR_TEXT.some((p) => p.test(text));
    if (isServerError) {
      return {
        provider,
        model,
        status: "limited",
        observedAt,
        validUntil: addMs(now, MS.LIMITED_2MIN),
        evidence: (text || String(statusCode ?? "server error")).slice(0, 200),
      };
    }
  }

  return null;
}

/**
 * Extract the provider prefix from a "provider/model" string.
 * Returns the full string unchanged if no "/" is found.
 *
 * @example providerFromModel("openai/gpt-4") // → "openai"
 * @example providerFromModel("anthropic")   // → "anthropic"
 */
export function providerFromModel(model: string): string {
  const idx = model.indexOf("/");
  return idx !== -1 ? model.slice(0, idx) : model;
}
