/**
 * Tests for provider capacity integration in selectDispatch.
 *
 * Table tests cover every new skip reason and rule interaction.
 * fast-check properties verify:
 *   P1: chosen count never exceeds slots
 *   P2: per-provider (chosen + active) never exceeds the provider's concurrency limit
 *   P3: a "down" provider is never chosen
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fc from "fast-check";
import type { ProviderCapacity } from "../src/aggregates/provider-capacity.ts";
import type { ActiveAttemptLike, WorkItemLike } from "../src/dispatch/select.ts";
import { selectDispatch } from "../src/dispatch/select.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-09-08T10:00:00.000Z";
const FUTURE = "2026-09-08T12:00:00.000Z"; // validUntil in the future
const PAST = "2026-09-08T08:00:00.000Z"; // validUntil in the past (stale)

function item(
  id: string,
  rank: number,
  repositoryId: string,
  overrides: Partial<WorkItemLike> = {},
): WorkItemLike {
  return {
    id,
    projectId: "proj-1",
    repositoryId,
    rank,
    lifecycle: "admitted",
    condition: "healthy",
    mainEffort: false,
    ...overrides,
  };
}

function capacity(
  provider: string,
  model: string,
  status: ProviderCapacity["status"],
  validUntil = FUTURE,
): ProviderCapacity {
  return {
    provider,
    model,
    status,
    observedAt: NOW,
    validUntil,
    source: "adapter",
  };
}

function attempt(workItemId: string, repositoryId: string): ActiveAttemptLike {
  return { workItemId, repositoryId, status: "EXECUTING" };
}

// ---------------------------------------------------------------------------
// Table tests — provider_down
// ---------------------------------------------------------------------------

test("provider_down: item with down provider is skipped", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" })],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "down")],
    now: NOW,
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.workItemId, "w1");
  assert.equal(result.skipped[0]?.reason, "provider_down");
});

test("provider_down: stale down observation → unknown (conservative, not down)", () => {
  // A stale "down" observation becomes "unknown" → concurrency 1, not 0.
  // If no active attempts, the item can still be dispatched.
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" })],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "down", PAST)],
    now: NOW,
    activeByProvider: {},
  });
  // stale "down" → unknown → concurrency 1, 0 active → dispatched
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.deepEqual(result.skipped, []);
});

test("provider_down: multiple items all skipped when provider is down", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" }),
    ],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "down")],
    now: NOW,
  });
  assert.equal(result.dispatch.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((s) => s.reason === "provider_down"));
});

// ---------------------------------------------------------------------------
// Table tests — provider_limited
// ---------------------------------------------------------------------------

test("provider_limited: first item dispatched when concurrency slot available", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" })],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "limited")],
    now: NOW,
    activeByProvider: {},
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.deepEqual(result.skipped, []);
});

test("provider_limited: second item skipped when active already fills the slot", () => {
  const result = selectDispatch({
    workItems: [item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" })],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "limited")],
    now: NOW,
    activeByProvider: { anthropic: 1 }, // one active already
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.reason, "provider_limited");
});

test("provider_limited: first item takes slot, second skipped in same pass", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" }),
    ],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "limited")],
    now: NOW,
    activeByProvider: {},
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.workItemId, "w2");
  assert.equal(result.skipped[0]?.reason, "provider_limited");
});

// ---------------------------------------------------------------------------
// Table tests — provider_unknown
// ---------------------------------------------------------------------------

test("provider_unknown: absent observation → conservative concurrency 1", () => {
  // No entry in providerCapacity but providerCapacity array is non-empty and
  // provider is set → obs is undefined → effectiveCapacity = "unknown" →
  // concurrency 1. With 0 active, should dispatch.
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { provider: "openai", model: "gpt-5" })],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    // capacity array present but no entry for openai/gpt-5
    providerCapacity: [capacity("anthropic", "claude-opus-4", "ok")],
    now: NOW,
    activeByProvider: {},
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
});

test("provider_unknown: absent observation, active already → provider_unknown", () => {
  const result = selectDispatch({
    workItems: [item("w2", 2, "repo-b", { provider: "openai", model: "gpt-5" })],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "ok")],
    now: NOW,
    activeByProvider: { openai: 1 }, // already at the conservative limit
  });
  assert.deepEqual(result.dispatch, []);
  assert.equal(result.skipped[0]?.reason, "provider_unknown");
});

test("provider_unknown: stale observation → unknown → conservative concurrency", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" }),
    ],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "ok", PAST)], // stale → unknown
    now: NOW,
    activeByProvider: {},
  });
  // First item takes the 1 slot (unknown = conservative concurrency 1)
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "provider_unknown");
});

// ---------------------------------------------------------------------------
// Table tests — ok provider (no constraint)
// ---------------------------------------------------------------------------

test("provider ok: multiple items dispatched up to slots limit", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" }),
      item("w3", 3, "repo-c", { provider: "anthropic", model: "claude-opus-4" }),
    ],
    activeAttempts: [],
    slots: 3,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "ok")],
    now: NOW,
    activeByProvider: {},
  });
  assert.equal(result.dispatch.length, 3);
  assert.deepEqual(result.skipped, []);
});

// ---------------------------------------------------------------------------
// Table tests — no provider field (backward compat)
// ---------------------------------------------------------------------------

test("no provider field: item without provider is unaffected by capacity array", () => {
  // Items with no provider field must not be constrained by providerCapacity.
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a"), // no provider
      item("w2", 2, "repo-b"), // no provider
    ],
    activeAttempts: [],
    slots: 2,
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "down")],
    now: NOW,
  });
  assert.equal(result.dispatch.length, 2);
  assert.deepEqual(result.skipped, []);
});

// ---------------------------------------------------------------------------
// Table tests — mixed providers
// ---------------------------------------------------------------------------

test("mixed providers: down and ok providers coexist", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "openai", model: "gpt-5" }),
    ],
    activeAttempts: [],
    slots: 5,
    uncertainRepositories: [],
    providerCapacity: [
      capacity("anthropic", "claude-opus-4", "down"),
      capacity("openai", "gpt-5", "ok"),
    ],
    now: NOW,
    activeByProvider: {},
  });
  // w1 skipped (anthropic down), w2 dispatched (openai ok)
  assert.deepEqual(result.dispatch, [{ workItemId: "w2", repositoryId: "repo-b" }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "provider_down");
});

test("mixed providers: limited provider gets one slot while ok provider is unconstrained", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" }),
      item("w3", 3, "repo-c", { provider: "openai", model: "gpt-5" }),
      item("w4", 4, "repo-d", { provider: "openai", model: "gpt-5" }),
    ],
    activeAttempts: [],
    slots: 10,
    uncertainRepositories: [],
    providerCapacity: [
      capacity("anthropic", "claude-opus-4", "limited"),
      capacity("openai", "gpt-5", "ok"),
    ],
    now: NOW,
    activeByProvider: {},
  });
  // w1 dispatched (anthropic limited, 0 active → takes slot)
  // w2 skipped (anthropic limited, 1 already chosen)
  // w3, w4 dispatched (openai ok → no constraint)
  const dispatched = result.dispatch.map((d) => d.workItemId);
  assert.ok(dispatched.includes("w1"), "w1 should be dispatched");
  assert.ok(dispatched.includes("w3"), "w3 should be dispatched");
  assert.ok(dispatched.includes("w4"), "w4 should be dispatched");
  assert.ok(!dispatched.includes("w2"), "w2 should not be dispatched");
  assert.equal(result.skipped.find((s) => s.workItemId === "w2")?.reason, "provider_limited");
});

// ---------------------------------------------------------------------------
// Table tests — slots bound still applies
// ---------------------------------------------------------------------------

test("slots still bound dispatch when provider is ok", () => {
  const result = selectDispatch({
    workItems: [
      item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" }),
      item("w2", 2, "repo-b", { provider: "anthropic", model: "claude-opus-4" }),
    ],
    activeAttempts: [],
    slots: 1, // only 1 slot
    uncertainRepositories: [],
    providerCapacity: [capacity("anthropic", "claude-opus-4", "ok")],
    now: NOW,
    activeByProvider: {},
  });
  assert.equal(result.dispatch.length, 1);
  assert.equal(result.skipped[0]?.reason, "no_slot");
});

// ---------------------------------------------------------------------------
// Table tests — empty providerCapacity array disables capacity checks
// ---------------------------------------------------------------------------

test("empty providerCapacity array: items with provider field are not blocked", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
    providerCapacity: [], // empty → no capacity checks
    now: NOW,
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
});

// ---------------------------------------------------------------------------
// Table tests — omitted providerCapacity (backward compat)
// ---------------------------------------------------------------------------

test("providerCapacity omitted: no capacity checks (backward compat)", () => {
  const result = selectDispatch({
    workItems: [item("w1", 1, "repo-a", { provider: "anthropic", model: "claude-opus-4" })],
    activeAttempts: [],
    slots: 1,
    uncertainRepositories: [],
    // no providerCapacity field at all
  });
  assert.deepEqual(result.dispatch, [{ workItemId: "w1", repositoryId: "repo-a" }]);
});

// ---------------------------------------------------------------------------
// fast-check property tests
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a simple work item with a deterministic provider choice.
 */
const providerArb = fc.constantFrom("anthropic", "openai", "google");
const modelArb = fc.constantFrom("model-a", "model-b");

const itemArb = fc.record({
  id: fc.uuid(),
  rank: fc.integer({ min: 1, max: 100 }),
  repositoryId: fc.constantFrom("repo-1", "repo-2", "repo-3", "repo-4", "repo-5"),
  provider: providerArb,
  model: modelArb,
});

const statusArb = fc.constantFrom<ProviderCapacity["status"]>("ok", "limited", "down");

test("P1: chosen count never exceeds slots", () => {
  fc.assert(
    fc.property(
      fc.array(itemArb, { minLength: 0, maxLength: 20 }),
      fc.integer({ min: 0, max: 10 }),
      fc.tuple(statusArb, statusArb, statusArb),
      (rawItems, slots, [s0, s1, s2]) => {
        // Deduplicate by id; assign unique repositoryIds to avoid repo serialization interference
        const seen = new Set<string>();
        const workItems: WorkItemLike[] = rawItems
          .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          })
          .map((item, idx) => ({
            ...item,
            projectId: "proj-1",
            lifecycle: "admitted" as const,
            condition: "healthy" as const,
            mainEffort: false,
            repositoryId: `repo-${idx}`, // unique repo per item eliminates repo_busy
          }));

        const providerCapacity: ProviderCapacity[] = [
          {
            provider: "anthropic",
            model: "model-a",
            status: s0,
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "openai",
            model: "model-a",
            status: s1,
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "google",
            model: "model-a",
            status: s2,
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
        ];

        const result = selectDispatch({
          workItems,
          activeAttempts: [],
          slots,
          uncertainRepositories: [],
          providerCapacity,
          now: NOW,
          activeByProvider: {},
        });

        return result.dispatch.length <= slots;
      },
    ),
    { numRuns: 200 },
  );
});

test("P2: per-provider chosen+active never exceeds provider concurrency limit", () => {
  fc.assert(
    fc.property(
      fc.array(itemArb, { minLength: 0, maxLength: 20 }),
      fc.integer({ min: 0, max: 5 }),
      fc.record({
        anthropic: fc.integer({ min: 0, max: 3 }),
        openai: fc.integer({ min: 0, max: 3 }),
        google: fc.integer({ min: 0, max: 3 }),
      }),
      (rawItems, slots, activeByProvider) => {
        const seen = new Set<string>();
        const workItems: WorkItemLike[] = rawItems
          .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          })
          .map((item, idx) => ({
            ...item,
            projectId: "proj-1",
            lifecycle: "admitted" as const,
            condition: "healthy" as const,
            mainEffort: false,
            repositoryId: `repo-${idx}`,
          }));

        // Use "limited" for all providers → concurrency 1 per provider
        const providerCapacity: ProviderCapacity[] = [
          {
            provider: "anthropic",
            model: "model-a",
            status: "limited",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "anthropic",
            model: "model-b",
            status: "limited",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "openai",
            model: "model-a",
            status: "limited",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "openai",
            model: "model-b",
            status: "limited",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "google",
            model: "model-a",
            status: "limited",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
          {
            provider: "google",
            model: "model-b",
            status: "limited",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
        ];

        const result = selectDispatch({
          workItems,
          activeAttempts: [],
          slots,
          uncertainRepositories: [],
          providerCapacity,
          now: NOW,
          activeByProvider,
        });

        // Count chosen per provider
        const chosenByProvider: Record<string, number> = {};
        for (const d of result.dispatch) {
          const w = workItems.find((wi) => wi.id === d.workItemId);
          if (w?.provider) {
            chosenByProvider[w.provider] = (chosenByProvider[w.provider] ?? 0) + 1;
          }
        }

        // Verify: dispatch never adds attempts beyond the concurrency limit.
        // The invariant is that chosen (additions this pass) does not exceed
        // max(0, limit - active), i.e. we never push total above limit.
        // Note: activeByProvider can arrive already above the limit (from
        // previous passes) — that is not our responsibility to fix, only to not
        // make it worse.
        for (const provider of ["anthropic", "openai", "google"]) {
          const active = (activeByProvider as Record<string, number>)[provider] ?? 0;
          const chosen = chosenByProvider[provider] ?? 0;
          const limit = 1; // all providers are "limited" → concurrency 1
          const allowedToAdd = Math.max(0, limit - active);
          if (chosen > allowedToAdd) return false;
        }
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test("P3: a down provider is never chosen", () => {
  fc.assert(
    fc.property(
      fc.array(itemArb, { minLength: 0, maxLength: 20 }),
      fc.integer({ min: 0, max: 10 }),
      (rawItems, slots) => {
        const seen = new Set<string>();
        const workItems: WorkItemLike[] = rawItems
          .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          })
          .map((item, idx) => ({
            ...item,
            provider: "anthropic" as const, // force all to the down provider
            model: "model-a" as const,
            projectId: "proj-1",
            lifecycle: "admitted" as const,
            condition: "healthy" as const,
            mainEffort: false,
            repositoryId: `repo-${idx}`,
          }));

        const providerCapacity: ProviderCapacity[] = [
          {
            provider: "anthropic",
            model: "model-a",
            status: "down",
            observedAt: NOW,
            validUntil: FUTURE,
            source: "adapter",
          },
        ];

        const result = selectDispatch({
          workItems,
          activeAttempts: [],
          slots,
          uncertainRepositories: [],
          providerCapacity,
          now: NOW,
          activeByProvider: {},
        });

        return result.dispatch.length === 0;
      },
    ),
    { numRuns: 200 },
  );
});
