/**
 * Integrity (verifier-tampering detection) unit tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROTECTED_PATHS, detectVerifierTampering } from "../src/evidence/integrity.ts";

// ---------------------------------------------------------------------------
// No tamper: no protected paths changed
// ---------------------------------------------------------------------------
test("integrity: no findings when no protected paths changed", () => {
  // src/parser.ts and test source files are not verifier-config paths.
  const findings = detectVerifierTampering(["src/parser.ts", "src/tests/parser.test.ts"]);
  assert.equal(findings.length, 0, "neither src/parser.ts nor test source files should be flagged");
});

// ---------------------------------------------------------------------------
// Tamper: package.json
// ---------------------------------------------------------------------------
test("integrity: package.json triggers blocking finding", () => {
  const findings = detectVerifierTampering(["package.json"]);
  assert.ok(findings.length > 0, "expected at least one finding");
  assert.ok(
    findings.every((f) => f.severity === "blocking"),
    "all findings must be blocking",
  );
  assert.ok(
    findings.every((f) => f.kind === "verifier_tampered"),
    "all findings must be verifier_tampered",
  );
});

// ---------------------------------------------------------------------------
// Tamper: pnpm-lock.yaml
// ---------------------------------------------------------------------------
test("integrity: pnpm-lock.yaml triggers blocking finding", () => {
  const findings = detectVerifierTampering(["pnpm-lock.yaml"]);
  assert.ok(findings.length > 0);
  assert.equal(findings[0]?.severity, "blocking");
});

// ---------------------------------------------------------------------------
// Tamper: pnpm-workspace.yaml
// ---------------------------------------------------------------------------
test("integrity: pnpm-workspace.yaml triggers blocking finding", () => {
  const findings = detectVerifierTampering(["pnpm-workspace.yaml"]);
  assert.ok(findings.length > 0);
  assert.equal(findings[0]?.severity, "blocking");
});

// ---------------------------------------------------------------------------
// Tamper: .github/** glob
// ---------------------------------------------------------------------------
test("integrity: .github/workflows/ci.yml triggers blocking finding", () => {
  const findings = detectVerifierTampering([".github/workflows/ci.yml"]);
  assert.ok(findings.length > 0, ".github/** should match .github/workflows/ci.yml");
  assert.ok(findings.every((f) => f.severity === "blocking"));
});

// ---------------------------------------------------------------------------
// Non-tamper: test source files (governed by contract paths.allow, not verifier
// config) must NOT produce findings — only the adversarial reviewer flags them.
// ---------------------------------------------------------------------------
test("integrity: tests/architecture-baseline.test.mjs does NOT trigger (test files not protected)", () => {
  const findings = detectVerifierTampering(["tests/architecture-baseline.test.mjs"]);
  assert.equal(findings.length, 0, "tests/** is not a protected verifier-config path");
});

test("integrity: test/parser/x.test.ts does NOT trigger (test files not protected)", () => {
  const findings = detectVerifierTampering(["test/parser/x.test.ts"]);
  assert.equal(findings.length, 0, "test/** is not a protected verifier-config path");
});

test("integrity: tests/y.spec.ts does NOT trigger (spec files not protected)", () => {
  const findings = detectVerifierTampering(["tests/y.spec.ts"]);
  assert.equal(findings.length, 0, "*.spec.ts is not a protected verifier-config path");
});

test("integrity: src/foo.test.ts does NOT trigger (test files not protected)", () => {
  const findings = detectVerifierTampering(["src/foo.test.ts"]);
  assert.equal(findings.length, 0, "*.test.* is not a protected verifier-config path");
});

// ---------------------------------------------------------------------------
// Tamper: tsconfig*.json glob
// ---------------------------------------------------------------------------
test("integrity: tsconfig.base.json triggers blocking finding", () => {
  const findings = detectVerifierTampering(["tsconfig.base.json"]);
  assert.ok(findings.length > 0, "tsconfig*.json should match tsconfig.base.json");
});

// ---------------------------------------------------------------------------
// Tamper: **/vitest.config.* glob
// ---------------------------------------------------------------------------
test("integrity: packages/domain/vitest.config.ts triggers blocking finding", () => {
  const findings = detectVerifierTampering(["packages/domain/vitest.config.ts"]);
  assert.ok(findings.length > 0, "**/vitest.config.* should match in nested dirs");
  assert.ok(findings.every((f) => f.severity === "blocking"));
});

// ---------------------------------------------------------------------------
// Tamper: **/jest.config.* glob
// ---------------------------------------------------------------------------
test("integrity: apps/web/jest.config.js triggers blocking finding", () => {
  const findings = detectVerifierTampering(["apps/web/jest.config.js"]);
  assert.ok(findings.length > 0, "**/jest.config.* should match in nested dirs");
  assert.ok(findings.every((f) => f.severity === "blocking"));
});

// ---------------------------------------------------------------------------
// Custom protected paths
// ---------------------------------------------------------------------------
test("integrity: custom protected paths work", () => {
  const findings = detectVerifierTampering(["custom/checker.ts"], ["custom/**"]);
  assert.ok(findings.length > 0);
  assert.equal(findings[0]?.kind, "verifier_tampered");
  assert.equal(findings[0]?.severity, "blocking");
});

// ---------------------------------------------------------------------------
// Multiple paths, multiple findings
// ---------------------------------------------------------------------------
test("integrity: multiple changed paths produce multiple findings", () => {
  const findings = detectVerifierTampering(["package.json", "pnpm-lock.yaml"]);
  // Each path matches at least one pattern.
  assert.ok(findings.length >= 2);
});

// ---------------------------------------------------------------------------
// DEFAULT_PROTECTED_PATHS is exported and non-empty
// ---------------------------------------------------------------------------
test("integrity: DEFAULT_PROTECTED_PATHS is a non-empty array of strings", () => {
  assert.ok(Array.isArray(DEFAULT_PROTECTED_PATHS));
  assert.ok(DEFAULT_PROTECTED_PATHS.length > 0);
  assert.ok(DEFAULT_PROTECTED_PATHS.every((p) => typeof p === "string"));
});

// ---------------------------------------------------------------------------
// Empty changed paths: no findings
// ---------------------------------------------------------------------------
test("integrity: empty changedPaths produces no findings", () => {
  const findings = detectVerifierTampering([]);
  assert.equal(findings.length, 0);
});

// ---------------------------------------------------------------------------
// biome.json
// ---------------------------------------------------------------------------
test("integrity: biome.json triggers blocking finding", () => {
  const findings = detectVerifierTampering(["biome.json"]);
  assert.ok(findings.length > 0, "biome.json should be protected");
  assert.ok(findings.every((f) => f.severity === "blocking"));
});
