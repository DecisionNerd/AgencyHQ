// Unit tests for Slice-6 lead-metrics and capacity helpers.
// Pure functions only — no DOM, no React.

import assert from "node:assert/strict";
import test from "node:test";

import type { CapacityProviderEntry } from "../src/api.ts";
import {
  buildCapacityRow,
  buildSetCapacityBody,
  capacityStatusLabel,
  formatPercentage,
  formatRateTitle,
  parseRoute,
  sinceWindowToISO,
} from "../src/control-plane-helpers.ts";

// ---------------------------------------------------------------------------
// formatPercentage
// ---------------------------------------------------------------------------

test("formatPercentage: formats a rate to 1 decimal percentage", () => {
  assert.equal(formatPercentage(0.75), "75.0%");
});

test("formatPercentage: formats 0 correctly", () => {
  assert.equal(formatPercentage(0), "0.0%");
});

test("formatPercentage: formats 1.0 correctly", () => {
  assert.equal(formatPercentage(1.0), "100.0%");
});

test("formatPercentage: returns 'not available' for null", () => {
  assert.equal(formatPercentage(null), "not available");
});

test("formatPercentage: rounds to 1 decimal", () => {
  const result = formatPercentage(1 / 3);
  assert.ok(result.endsWith("%"), "should end with %");
  assert.ok(result.includes("."), "should have decimal");
});

// ---------------------------------------------------------------------------
// formatRateTitle
// ---------------------------------------------------------------------------

test("formatRateTitle: shows numerator/denominator when rate is null", () => {
  assert.equal(formatRateTitle(3, 0, null), "3/0");
});

test("formatRateTitle: shows n/d = pct when rate is given", () => {
  assert.equal(formatRateTitle(3, 4, 0.75), "3/4 = 75.0%");
});

test("formatRateTitle: shows 0/0 = 0.0% for zero rate", () => {
  assert.equal(formatRateTitle(0, 5, 0), "0/5 = 0.0%");
});

// ---------------------------------------------------------------------------
// sinceWindowToISO
// ---------------------------------------------------------------------------

test("sinceWindowToISO: returns null for 'all'", () => {
  const result = sinceWindowToISO("all");
  assert.equal(result, null);
});

test("sinceWindowToISO: returns ISO string 7 days before now for '7d'", () => {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const result = sinceWindowToISO("7d", now);
  assert.ok(result !== null, "should not be null");
  const parsed = new Date(result as string);
  const expected = new Date("2026-09-01T00:00:00.000Z");
  assert.equal(parsed.toISOString(), expected.toISOString());
});

test("sinceWindowToISO: returns ISO string 30 days before now for '30d'", () => {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const result = sinceWindowToISO("30d", now);
  assert.ok(result !== null, "should not be null");
  const parsed = new Date(result as string);
  const expected = new Date("2026-08-09T00:00:00.000Z");
  assert.equal(parsed.toISOString(), expected.toISOString());
});

// ---------------------------------------------------------------------------
// buildCapacityRow
// ---------------------------------------------------------------------------

const sampleEntry: CapacityProviderEntry = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  status: "ok",
  effective: "ok",
  concurrency: 5,
  observedAt: "2026-09-08T10:00:00.000Z",
  validUntil: "2026-09-09T10:00:00.000Z",
  source: "adapter",
};

test("buildCapacityRow: isStale false when validUntil is in the future", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const row = buildCapacityRow(sampleEntry, now);
  assert.equal(row.isStale, false);
  assert.ok(row.validityLabel.startsWith("valid until"), "label should say valid until");
});

test("buildCapacityRow: isStale true when validUntil is in the past", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");
  const row = buildCapacityRow(sampleEntry, now);
  assert.equal(row.isStale, true);
  assert.ok(row.validityLabel.startsWith("stale since"), "label should say stale since");
});

test("buildCapacityRow: preserves all provider fields", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const row = buildCapacityRow(sampleEntry, now);
  assert.equal(row.provider, "anthropic");
  assert.equal(row.model, "claude-sonnet-4-6");
  assert.equal(row.status, "ok");
  assert.equal(row.effective, "ok");
  assert.equal(row.concurrency, 5);
  assert.equal(row.source, "adapter");
});

test("buildCapacityRow: handles null concurrency", () => {
  const entry: CapacityProviderEntry = { ...sampleEntry, concurrency: null };
  const row = buildCapacityRow(entry, new Date("2026-09-08T12:00:00.000Z"));
  assert.equal(row.concurrency, null);
});

// ---------------------------------------------------------------------------
// capacityStatusLabel
// ---------------------------------------------------------------------------

test("capacityStatusLabel: ok returns checkmark and text", () => {
  const result = capacityStatusLabel("ok");
  assert.equal(result.icon, "✓");
  assert.equal(result.text, "ok");
});

test("capacityStatusLabel: limited returns warning icon", () => {
  const result = capacityStatusLabel("limited");
  assert.equal(result.icon, "⚠");
  assert.equal(result.text, "limited");
});

test("capacityStatusLabel: down returns cross", () => {
  const result = capacityStatusLabel("down");
  assert.equal(result.icon, "✗");
  assert.equal(result.text, "down");
});

test("capacityStatusLabel: unknown returns question mark", () => {
  const result = capacityStatusLabel("unknown");
  assert.equal(result.icon, "?");
  assert.equal(result.text, "unknown");
});

// ---------------------------------------------------------------------------
// buildSetCapacityBody
// ---------------------------------------------------------------------------

test("buildSetCapacityBody: produces correct shape", () => {
  const body = buildSetCapacityBody({
    commandId: "cmd-1",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    status: "limited",
    validUntil: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(body.commandId, "cmd-1");
  assert.equal(body.kind, "set_capacity");
  assert.equal(body.provider, "anthropic");
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.status, "limited");
  assert.equal(body.validUntil, "2026-09-09T00:00:00.000Z");
});

test("buildSetCapacityBody: includes all three status values", () => {
  for (const status of ["ok", "limited", "down"] as const) {
    const body = buildSetCapacityBody({
      commandId: "x",
      provider: "p",
      model: "m",
      status,
      validUntil: "2026-09-09T00:00:00.000Z",
    });
    assert.equal(body.status, status);
  }
});

// ---------------------------------------------------------------------------
// parseRoute: #/metrics
// ---------------------------------------------------------------------------

test("parseRoute: #/metrics returns metrics page", () => {
  assert.deepEqual(parseRoute("#/metrics"), { page: "metrics" });
});
