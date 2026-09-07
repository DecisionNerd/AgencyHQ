// Tests for trigger/src/opencode/structured.ts
// Covers extractStructured (over real SDK response shapes and malformed
// variants) and parseWithSchema.

import assert from "node:assert/strict";
import test from "node:test";

import { extractStructured, parseWithSchema } from "../src/opencode/structured.ts";

// ---------------------------------------------------------------------------
// extractStructured
// ---------------------------------------------------------------------------

test("extractStructured: returns ok=false for non-object input (null)", () => {
  const result = extractStructured(null);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /not an object/);
});

test("extractStructured: returns ok=false for non-object input (string)", () => {
  const result = extractStructured("some string");
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /not an object/);
});

test("extractStructured: returns ok=false when structured field is absent", () => {
  const info = { id: "msg-1", role: "assistant", cost: 0 };
  const result = extractStructured(info);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /no 'structured' field/);
});

test("extractStructured: returns ok=false when structured field is null", () => {
  const info = { id: "msg-1", role: "assistant", structured: null };
  const result = extractStructured(info);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /structured is null/);
});

test("extractStructured: returns ok=false when structured field is undefined", () => {
  const info = { id: "msg-1", role: "assistant", structured: undefined };
  const result = extractStructured(info);
  assert.equal(result.ok, false);
});

test("extractStructured: returns ok=true with value for a valid AssistantMessage shape", () => {
  // Minimal real-shaped AssistantMessage with structured output (v2 SDK,
  // read 2026-09-07: AssistantMessage has structured?: unknown)
  const structured = { kind: "proposal", proposal: { criteria: [], rationale: "test" } };
  const info = {
    id: "msg-abc",
    sessionID: "ses-1",
    role: "assistant",
    modelID: "gpt-5.6-sol",
    providerID: "openai",
    mode: "primary",
    agent: "agencyhq-lead",
    cost: 0.001,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    structured,
    finish: "end_turn",
  };
  const result = extractStructured(info);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: unknown }).value, structured);
});

test("extractStructured: accepts any non-null structured value (object, array, string)", () => {
  const cases = [
    { structured: { kind: "needs_facts", questions: ["q1"] } },
    { structured: ["a", "b"] },
    { structured: "raw-string" },
    { structured: 42 },
    { structured: true },
  ];
  for (const info of cases) {
    const result = extractStructured(info);
    assert.equal(result.ok, true, `expected ok for structured: ${JSON.stringify(info.structured)}`);
  }
});

// ---------------------------------------------------------------------------
// parseWithSchema (using a minimal Zod-like stub)
// ---------------------------------------------------------------------------

function makeSuccessSchema<T>(value: T) {
  return {
    safeParse: (_raw: unknown) => ({ success: true as const, data: value }),
  };
}

function makeFailSchema(message: string) {
  return {
    safeParse: (_raw: unknown) => ({
      success: false as const,
      error: { message },
    }),
  };
}

test("parseWithSchema: returns ok=true with parsed value on success", () => {
  const schema = makeSuccessSchema({ kind: "proposal" as const });
  const result = parseWithSchema(schema, { kind: "proposal" });
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: unknown }).value, { kind: "proposal" });
});

test("parseWithSchema: returns ok=false with reason on schema failure", () => {
  const schema = makeFailSchema("Required field missing");
  const result = parseWithSchema(schema, {});
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; reason: string }).reason, "Required field missing");
});

test("parseWithSchema: passes raw value through to safeParse", () => {
  let received: unknown;
  const schema = {
    safeParse: (raw: unknown) => {
      received = raw;
      return { success: true as const, data: raw };
    },
  };
  parseWithSchema(schema, { test: 123 });
  assert.deepEqual(received, { test: 123 });
});
