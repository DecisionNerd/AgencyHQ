/**
 * Unit tests for agencyhqToolchain() build extension.
 *
 * Tests verify that onBuildComplete records exactly one layer with the
 * expected pkgs, pinned version strings in the instructions, ENV lines,
 * and the four deploy env vars. No network calls, no file I/O.
 */

import assert from "node:assert/strict";
import test from "node:test";

// BuildContext and BuildLayer re-exported from @trigger.dev/build/extensions
// (which is a direct devDependency; the underlying source is
// @trigger.dev/core/v3/build/extensions.d.ts — read 2026-09-09).
import type { BuildContext, BuildLayer } from "@trigger.dev/build/extensions";

import { agencyhqToolchain, OPENCODE_VERSION, PNPM_VERSION } from "../build/toolchain.ts";

// ---------------------------------------------------------------------------
// Minimal fake BuildContext that records addLayer calls.
// Only the methods used by agencyhqToolchain() need real implementations.
// ---------------------------------------------------------------------------
function makeFakeContext(): { ctx: BuildContext; layers: BuildLayer[] } {
  const layers: BuildLayer[] = [];
  const ctx = {
    target: "deploy" as const,
    config: {} as never,
    workingDir: "/fake",
    logger: {
      debug: () => {},
      log: () => {},
      warn: () => {},
      progress: () => {},
      spinner: () => ({ stop: () => {}, message: () => {} }),
    },
    addLayer(layer: BuildLayer): void {
      layers.push(layer);
    },
    registerPlugin: () => {},
    resolvePath: async () => undefined,
  } as unknown as BuildContext;
  return { ctx, layers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("agencyhqToolchain exports pinned version constants", () => {
  assert.equal(typeof OPENCODE_VERSION, "string");
  assert.equal(typeof PNPM_VERSION, "string");
  // Versions must be non-empty semver-like strings
  assert.match(OPENCODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(PNPM_VERSION, /^\d+\.\d+\.\d+$/);
});

test("agencyhqToolchain returns an extension with the expected name", () => {
  const ext = agencyhqToolchain();
  assert.equal(ext.name, "agencyhq-toolchain");
  assert.equal(typeof ext.onBuildComplete, "function");
});

test("onBuildComplete adds exactly one layer", () => {
  const { ctx, layers } = makeFakeContext();
  const ext = agencyhqToolchain();
  ext.onBuildComplete?.(ctx, {} as never);
  assert.equal(layers.length, 1, "expected exactly one layer");
});

test("layer has id agencyhq-toolchain", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const layer = layers[0];
  assert.ok(layer, "layer should exist");
  assert.equal(layer.id, "agencyhq-toolchain");
});

test("layer image.pkgs contains git and ca-certificates", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const pkgs = layers[0]?.image?.pkgs ?? [];
  assert.ok(pkgs.includes("git"), "pkgs should include git");
  assert.ok(pkgs.includes("ca-certificates"), "pkgs should include ca-certificates");
  // No other packages are expected
  assert.equal(pkgs.length, 2, "exactly two packages");
});

test("layer image.instructions include pinned opencode version", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const instructions = layers[0]?.image?.instructions ?? [];
  const joined = instructions.join("\n");
  assert.ok(
    joined.includes(`opencode-ai@${OPENCODE_VERSION}`),
    `instructions should pin opencode-ai@${OPENCODE_VERSION}`,
  );
});

test("layer image.instructions include pinned pnpm version", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const instructions = layers[0]?.image?.instructions ?? [];
  const joined = instructions.join("\n");
  assert.ok(
    joined.includes(`pnpm@${PNPM_VERSION}`),
    `instructions should pin pnpm@${PNPM_VERSION}`,
  );
});

test("layer image.instructions set ENV HOME=/home/node", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const instructions = layers[0]?.image?.instructions ?? [];
  assert.ok(
    instructions.some((i) => i.includes("HOME=/home/node")),
    "instructions should set ENV HOME=/home/node",
  );
});

test("layer image.instructions set ENV AGENCYHQ_RUN_ROOT=/tmp/agencyhq", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const instructions = layers[0]?.image?.instructions ?? [];
  assert.ok(
    instructions.some((i) => i.includes("AGENCYHQ_RUN_ROOT=/tmp/agencyhq")),
    "instructions should set ENV AGENCYHQ_RUN_ROOT=/tmp/agencyhq",
  );
});

test("layer image.instructions create /home/node and /tmp/agencyhq owned by uid 1000", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const instructions = layers[0]?.image?.instructions ?? [];
  const joined = instructions.join("\n");
  assert.ok(joined.includes("/home/node"), "instructions should mention /home/node");
  assert.ok(joined.includes("/tmp/agencyhq"), "instructions should mention /tmp/agencyhq");
  assert.ok(joined.includes("1000"), "instructions should chown to uid 1000");
});

test("layer deploy.env contains AGENCYHQ_RUNTIME_PROFILE=container", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const env = layers[0]?.deploy?.env ?? {};
  assert.equal(env["AGENCYHQ_RUNTIME_PROFILE"], "container");
});

test("layer deploy.env contains AGENCYHQ_COORDINATOR_INTERNAL_URL", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const env = layers[0]?.deploy?.env ?? {};
  assert.ok(
    typeof env["AGENCYHQ_COORDINATOR_INTERNAL_URL"] === "string" &&
      env["AGENCYHQ_COORDINATOR_INTERNAL_URL"].length > 0,
    "AGENCYHQ_COORDINATOR_INTERNAL_URL should be set",
  );
});

test("layer deploy.env contains AGENCYHQ_RUN_ROOT", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const env = layers[0]?.deploy?.env ?? {};
  assert.ok(
    typeof env["AGENCYHQ_RUN_ROOT"] === "string" && env["AGENCYHQ_RUN_ROOT"].length > 0,
    "AGENCYHQ_RUN_ROOT should be set in deploy.env",
  );
});

test("layer deploy.env contains exactly four keys (no secrets)", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const env = layers[0]?.deploy?.env ?? {};
  const keys = Object.keys(env);
  assert.equal(keys.length, 4, `expected 4 deploy env keys, got: ${keys.join(", ")}`);
});

test("layer deploy.env sets HOME to the writable home created in the image layer", () => {
  const { ctx, layers } = makeFakeContext();
  agencyhqToolchain().onBuildComplete?.(ctx, {} as never);
  const env = layers[0]?.deploy?.env ?? {};
  assert.equal(env["HOME"], "/home/node");
  const instructions = layers[0]?.image?.instructions ?? [];
  assert.ok(
    instructions.some((i) => i.includes("mkdir -p /home/node") && i.includes("chown 1000:1000")),
    "image layer should create /home/node owned by uid 1000",
  );
});

test("agencyhqToolchain() can be called with no options", () => {
  assert.doesNotThrow(() => agencyhqToolchain());
});

test("agencyhqToolchain() can be called with an empty options object", () => {
  assert.doesNotThrow(() => agencyhqToolchain({}));
});
