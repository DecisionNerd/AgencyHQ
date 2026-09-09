/**
 * Table tests for ProviderCapacity aggregate.
 *
 * Covers:
 *   - effectiveCapacity: absent obs, fresh obs, stale obs, boundary at validUntil
 *   - concurrencyFor: all four status values
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapacity } from "../src/aggregates/provider-capacity.ts";
import { concurrencyFor, effectiveCapacity } from "../src/aggregates/provider-capacity.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function obs(
  status: ProviderCapacity["status"],
  validUntil: string,
  source: ProviderCapacity["source"] = "adapter",
): ProviderCapacity {
  return {
    provider: "anthropic",
    model: "claude-opus-4",
    status,
    observedAt: "2026-09-08T10:00:00.000Z",
    validUntil,
    source,
  };
}

// ---------------------------------------------------------------------------
// effectiveCapacity — absent observation
// ---------------------------------------------------------------------------

test("effectiveCapacity: absent observation → unknown", () => {
  assert.equal(effectiveCapacity(undefined, "2026-09-08T10:00:00.000Z"), "unknown");
});

// ---------------------------------------------------------------------------
// effectiveCapacity — fresh observations (now <= validUntil)
// ---------------------------------------------------------------------------

test("effectiveCapacity: status=ok, now before validUntil → ok", () => {
  const o = obs("ok", "2026-09-08T11:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T10:30:00.000Z"), "ok");
});

test("effectiveCapacity: status=limited, now before validUntil → limited", () => {
  const o = obs("limited", "2026-09-08T11:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T10:30:00.000Z"), "limited");
});

test("effectiveCapacity: status=down, now before validUntil → down", () => {
  const o = obs("down", "2026-09-08T11:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T10:30:00.000Z"), "down");
});

// ---------------------------------------------------------------------------
// effectiveCapacity — boundary at validUntil (now === validUntil → still fresh)
// ---------------------------------------------------------------------------

test("effectiveCapacity: now equals validUntil → still fresh (ok)", () => {
  const o = obs("ok", "2026-09-08T11:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T11:00:00.000Z"), "ok");
});

test("effectiveCapacity: now equals validUntil → still fresh (limited)", () => {
  const o = obs("limited", "2026-09-08T11:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T11:00:00.000Z"), "limited");
});

test("effectiveCapacity: now equals validUntil → still fresh (down)", () => {
  const o = obs("down", "2026-09-08T11:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T11:00:00.000Z"), "down");
});

// ---------------------------------------------------------------------------
// effectiveCapacity — stale observations (now > validUntil → unknown)
// ---------------------------------------------------------------------------

test("effectiveCapacity: now after validUntil, status=ok → unknown (stale)", () => {
  const o = obs("ok", "2026-09-08T10:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T10:00:00.001Z"), "unknown");
});

test("effectiveCapacity: now after validUntil, status=limited → unknown (stale)", () => {
  const o = obs("limited", "2026-09-08T10:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T11:00:00.000Z"), "unknown");
});

test("effectiveCapacity: now after validUntil, status=down → unknown (stale)", () => {
  const o = obs("down", "2026-09-08T09:00:00.000Z");
  assert.equal(effectiveCapacity(o, "2026-09-08T10:00:00.000Z"), "unknown");
});

// ---------------------------------------------------------------------------
// effectiveCapacity — source field does not affect result
// ---------------------------------------------------------------------------

test("effectiveCapacity: source=operator, fresh → returns status", () => {
  const o = obs("ok", "2026-09-08T12:00:00.000Z", "operator");
  assert.equal(effectiveCapacity(o, "2026-09-08T10:00:00.000Z"), "ok");
});

// ---------------------------------------------------------------------------
// concurrencyFor — all status values
// ---------------------------------------------------------------------------

test("concurrencyFor: ok → null (unbounded)", () => {
  assert.equal(concurrencyFor("ok"), null);
});

test("concurrencyFor: limited → 1", () => {
  assert.equal(concurrencyFor("limited"), 1);
});

test("concurrencyFor: unknown → 1 (conservative)", () => {
  assert.equal(concurrencyFor("unknown"), 1);
});

test("concurrencyFor: down → 0", () => {
  assert.equal(concurrencyFor("down"), 0);
});
