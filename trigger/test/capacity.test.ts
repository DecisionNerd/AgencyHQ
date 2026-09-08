// Unit tests for trigger/src/lib/capacity.ts
//
// Each classification class is tested with at least one fixture event and
// with a scenario that confirms null is returned when no signal is present.
import assert from "node:assert/strict";
import test from "node:test";

import { classifyCapacity, providerFromModel } from "../src/lib/capacity.ts";
import type { OpenCodeEvent } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-08T00:00:00.000Z");

function makeApiErrorEvent(message: string, statusCode?: number): OpenCodeEvent {
  return {
    type: "error",
    error: {
      name: "APIError",
      data: {
        message,
        ...(statusCode !== undefined ? { statusCode } : {}),
      },
    },
  };
}

function makeSyntheticErrorEvent(message: string): OpenCodeEvent {
  return { type: "error", error: { message } };
}

function classify(events: OpenCodeEvent[], model = "openai/gpt-5") {
  return classifyCapacity(events, { provider: providerFromModel(model), model, now: NOW });
}

// ---------------------------------------------------------------------------
// null — no match
// ---------------------------------------------------------------------------

test("classifyCapacity returns null for an empty event list", () => {
  assert.strictEqual(classify([]), null);
});

test("classifyCapacity returns null for a non-error text event", () => {
  const event: OpenCodeEvent = { type: "text", text: "Hello from the model" };
  assert.strictEqual(classify([event]), null);
});

test("classifyCapacity returns null for a tool_use event with non-capacity error", () => {
  const event: OpenCodeEvent = {
    type: "tool_use",
    part: {
      tool: "bash",
      state: { status: "error", error: "exit code 1", input: {} },
    },
  };
  assert.strictEqual(classify([event]), null);
});

// ---------------------------------------------------------------------------
// 401/403 / "invalid api key" / "insufficient credits" → down, 30 min
// ---------------------------------------------------------------------------

test("classifyCapacity: statusCode 401 → down, 30 min", () => {
  const result = classify([makeApiErrorEvent("Unauthorized", 401)]);
  assert.ok(result);
  assert.equal(result.status, "down");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "openai/gpt-5");
  assert.equal(result.observedAt, NOW.toISOString());
  // validUntil should be 30 minutes after NOW
  const expected = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
  assert.ok(result.evidence.length > 0);
});

test("classifyCapacity: statusCode 403 → down, 30 min", () => {
  const result = classify([makeApiErrorEvent("Forbidden", 403)]);
  assert.ok(result);
  assert.equal(result.status, "down");
  const expected = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
});

test("classifyCapacity: 'Invalid API key.' text → down, 30 min (real smoke event shape)", () => {
  // This is the exact event from the real smoke run (opencode-parse.test.ts fixture)
  const realEvent: OpenCodeEvent = {
    type: "error",
    timestamp: 1788766912551,
    sessionID: "ses_f852f087bffepvMX6c3mINjQOu",
    error: {
      name: "APIError",
      data: {
        message: "Invalid API key.",
        statusCode: 401,
        isRetryable: false,
      },
    },
  };
  const result = classify([realEvent]);
  assert.ok(result);
  assert.equal(result.status, "down");
  assert.match(result.evidence, /Invalid API key\./);
});

test("classifyCapacity: 'insufficient credits' text → down, 30 min", () => {
  const result = classify([makeSyntheticErrorEvent("Your account has insufficient credits")]);
  assert.ok(result);
  assert.equal(result.status, "down");
});

// ---------------------------------------------------------------------------
// HTTP 429 / "rate limit" / "quota" / "overloaded" → limited, 5 min
// ---------------------------------------------------------------------------

test("classifyCapacity: statusCode 429 → limited, 5 min", () => {
  const result = classify([makeApiErrorEvent("Too Many Requests", 429)]);
  assert.ok(result);
  assert.equal(result.status, "limited");
  const expected = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
});

test("classifyCapacity: 'rate limit exceeded' text → limited, 5 min", () => {
  const result = classify([makeSyntheticErrorEvent("You have exceeded the rate limit")]);
  assert.ok(result);
  assert.equal(result.status, "limited");
  const expected = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
});

test("classifyCapacity: 'rate_limit' text → limited, 5 min", () => {
  // Underscored variant (common in some API error codes)
  const result = classify([makeSyntheticErrorEvent("error_type: rate_limit")]);
  assert.ok(result);
  assert.equal(result.status, "limited");
});

test("classifyCapacity: 'quota exceeded' text → limited, 5 min", () => {
  const result = classify([makeSyntheticErrorEvent("Monthly quota exceeded")]);
  assert.ok(result);
  assert.equal(result.status, "limited");
});

test("classifyCapacity: 'overloaded' text → limited, 5 min", () => {
  const result = classify([makeSyntheticErrorEvent("The API is currently overloaded")]);
  assert.ok(result);
  assert.equal(result.status, "limited");
});

// ---------------------------------------------------------------------------
// 5xx / "unavailable" → limited, 2 min
// ---------------------------------------------------------------------------

test("classifyCapacity: statusCode 500 → limited, 2 min", () => {
  const result = classify([makeApiErrorEvent("Internal Server Error", 500)]);
  assert.ok(result);
  assert.equal(result.status, "limited");
  const expected = new Date(NOW.getTime() + 2 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
});

test("classifyCapacity: statusCode 503 → limited, 2 min", () => {
  const result = classify([makeApiErrorEvent("Service Unavailable", 503)]);
  assert.ok(result);
  assert.equal(result.status, "limited");
  const expected = new Date(NOW.getTime() + 2 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
});

test("classifyCapacity: 'unavailable' text → limited, 2 min", () => {
  const result = classify([makeSyntheticErrorEvent("Service is currently unavailable")]);
  assert.ok(result);
  assert.equal(result.status, "limited");
  const expected = new Date(NOW.getTime() + 2 * 60 * 1000).toISOString();
  assert.equal(result.validUntil, expected);
});

// ---------------------------------------------------------------------------
// Precedence: auth/down wins over rate-limit (first check in classifyCapacity)
// ---------------------------------------------------------------------------

test("classifyCapacity: 401 in event wins over later 429 in different event", () => {
  const events: OpenCodeEvent[] = [
    makeApiErrorEvent("Unauthorized", 401),
    makeApiErrorEvent("Too Many Requests", 429),
  ];
  const result = classify(events);
  assert.ok(result);
  // First matching event wins; 401 → down
  assert.equal(result.status, "down");
});

// ---------------------------------------------------------------------------
// Evidence truncation and output shape
// ---------------------------------------------------------------------------

test("classifyCapacity: evidence is at most 200 chars", () => {
  const longMsg = "A".repeat(500);
  const result = classify([makeSyntheticErrorEvent(longMsg + " insufficient credits")]);
  assert.ok(result);
  assert.ok(result.evidence.length <= 200, `evidence length ${result.evidence.length} > 200`);
});

// ---------------------------------------------------------------------------
// providerFromModel helper
// ---------------------------------------------------------------------------

test("providerFromModel splits 'openai/gpt-4' correctly", () => {
  assert.equal(providerFromModel("openai/gpt-4"), "openai");
});

test("providerFromModel handles model without slash", () => {
  assert.equal(providerFromModel("anthropic"), "anthropic");
});

test("providerFromModel uses only the first slash segment", () => {
  // e.g. opencode/big-pickle has a second slash in the model name part
  assert.equal(providerFromModel("opencode/big-pickle"), "opencode");
});
