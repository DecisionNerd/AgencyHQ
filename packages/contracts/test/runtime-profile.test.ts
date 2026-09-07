import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundaryKindSchema,
  enforceableBoundaries,
  HOST_PROFILE,
  RuntimeProfileSchema,
} from "../src/runtime-profile.ts";

// ---------------------------------------------------------------------------
// BoundaryKindSchema
// ---------------------------------------------------------------------------
test("BoundaryKindSchema: accepts all valid boundary kinds", () => {
  const kinds = [
    "worktree",
    "fs_isolation",
    "cpu_memory",
    "duration",
    "capability",
    "output_paths",
    "push",
    "integrate",
    "termination",
    "egress_spend",
    "nested_agents",
  ];
  for (const kind of kinds) {
    assert.equal(BoundaryKindSchema.safeParse(kind).success, true, `Expected ${kind} to be valid`);
  }
});

test("BoundaryKindSchema: rejects unknown boundary kind", () => {
  assert.equal(BoundaryKindSchema.safeParse("unknown_boundary").success, false);
});

// ---------------------------------------------------------------------------
// RuntimeProfileSchema
// ---------------------------------------------------------------------------
test("RuntimeProfileSchema: parses a valid host profile", () => {
  const result = RuntimeProfileSchema.safeParse(HOST_PROFILE);
  assert.equal(result.success, true);
});

test("RuntimeProfileSchema: rejects unknown profile id", () => {
  const bad = { id: "sandbox", enforcement: {} };
  assert.equal(RuntimeProfileSchema.safeParse(bad).success, false);
});

// ---------------------------------------------------------------------------
// HOST_PROFILE: all BoundaryKinds present
// Source: docs/engineering/ARCHITECTURE.md lines 105-127
// ---------------------------------------------------------------------------
test("HOST_PROFILE: contains all 11 BoundaryKinds", () => {
  const allKinds = [
    "worktree",
    "fs_isolation",
    "cpu_memory",
    "duration",
    "capability",
    "output_paths",
    "push",
    "integrate",
    "termination",
    "egress_spend",
    "nested_agents",
  ];
  for (const kind of allKinds) {
    assert.ok(
      kind in HOST_PROFILE.enforcement,
      `Expected ${kind} to be in HOST_PROFILE.enforcement`,
    );
  }
  assert.equal(Object.keys(HOST_PROFILE.enforcement).length, 11);
});

test("HOST_PROFILE: advisory boundaries match ARCHITECTURE.md lines 105-127", () => {
  // From ARCHITECTURE.md enforcement table:
  // - fs_isolation: "None; the worker can read host files." → Advisory
  // - cpu_memory: "None." → Advisory
  // - egress_spend: "None; spend is an estimate." → Advisory
  // (Source: docs/engineering/ARCHITECTURE.md lines 105-127)
  const expectedAdvisory = ["fs_isolation", "cpu_memory", "egress_spend"];
  const actualAdvisory = Object.entries(HOST_PROFILE.enforcement)
    .filter(([, v]) => v === "advisory")
    .map(([k]) => k)
    .sort();
  assert.deepEqual(actualAdvisory.sort(), expectedAdvisory.sort());
});

test("HOST_PROFILE: non-advisory boundaries match expected kinds", () => {
  // From ARCHITECTURE.md lines 105-127:
  // before_action: worktree, duration, capability, push, integrate, nested_agents
  // on_output: output_paths
  // trusted_observation: termination
  assert.equal(HOST_PROFILE.enforcement.worktree, "before_action");
  assert.equal(HOST_PROFILE.enforcement.duration, "before_action");
  assert.equal(HOST_PROFILE.enforcement.capability, "before_action");
  assert.equal(HOST_PROFILE.enforcement.push, "before_action");
  assert.equal(HOST_PROFILE.enforcement.integrate, "before_action");
  assert.equal(HOST_PROFILE.enforcement.nested_agents, "before_action");
  assert.equal(HOST_PROFILE.enforcement.output_paths, "on_output");
  assert.equal(HOST_PROFILE.enforcement.termination, "trusted_observation");
});

// ---------------------------------------------------------------------------
// enforceableBoundaries
// ---------------------------------------------------------------------------
test("enforceableBoundaries: returns all non-advisory boundaries for HOST_PROFILE", () => {
  const result = enforceableBoundaries(HOST_PROFILE);
  // Advisory on host: fs_isolation, cpu_memory, egress_spend
  // Enforceable: worktree, duration, capability, output_paths, push, integrate, termination, nested_agents
  assert.equal(result.length, 8);
  assert.equal(result.includes("fs_isolation"), false);
  assert.equal(result.includes("cpu_memory"), false);
  assert.equal(result.includes("egress_spend"), false);
  assert.equal(result.includes("worktree"), true);
  assert.equal(result.includes("duration"), true);
  assert.equal(result.includes("termination"), true);
});

test("enforceableBoundaries: returns empty for a fully-advisory profile", () => {
  const allAdvisory = RuntimeProfileSchema.parse({
    id: "host",
    enforcement: {
      worktree: "advisory",
      fs_isolation: "advisory",
      cpu_memory: "advisory",
      duration: "advisory",
      capability: "advisory",
      output_paths: "advisory",
      push: "advisory",
      integrate: "advisory",
      termination: "advisory",
      egress_spend: "advisory",
      nested_agents: "advisory",
    },
  });
  assert.equal(enforceableBoundaries(allAdvisory).length, 0);
});
