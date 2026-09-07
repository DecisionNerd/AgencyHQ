import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspacePaths = [
  "packages/contracts",
  "packages/domain",
  "packages/db",
  "packages/verification",
  "apps/coordinator",
  "apps/web",
  "trigger",
];

async function readPackageJson(pkgPath) {
  const content = await readFile(join(root, pkgPath, "package.json"), "utf8");
  return JSON.parse(content);
}

function allDeps(pkg) {
  return Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  });
}

async function collectSrcImports(dir) {
  const imports = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return imports;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectSrcImports(fullPath);
      imports.push(...nested);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      const content = await readFile(fullPath, "utf8");
      for (const match of content.matchAll(/from\s+["']([^"']+)["']/g)) {
        imports.push(match[1]);
      }
    }
  }
  return imports;
}

// (a) domain src imports no forbidden packages
test("domain src has no forbidden imports (trigger/opencode/react/pg/postgres)", async () => {
  const imports = await collectSrcImports(join(root, "packages/domain/src"));
  for (const imp of imports) {
    assert.doesNotMatch(
      imp,
      /trigger|opencode|react|^pg$|postgres/i,
      `packages/domain/src imports forbidden specifier: ${imp}`,
    );
  }
});

// (a) domain production dependencies: only @agencyhq/contracts
test("domain production deps are only @agencyhq/contracts", async () => {
  const pkg = await readPackageJson("packages/domain");
  const prodDeps = Object.keys(pkg.dependencies ?? {});
  for (const dep of prodDeps) {
    assert.equal(
      dep,
      "@agencyhq/contracts",
      `packages/domain has unexpected production dep: ${dep}`,
    );
  }
});

// (b) no workspace package depends on AI provider SDKs
test("no package depends on @anthropic-ai/*, openai, @ai-sdk/*, or ai", async () => {
  for (const pkgPath of workspacePaths) {
    const pkg = await readPackageJson(pkgPath);
    for (const dep of allDeps(pkg)) {
      assert.doesNotMatch(
        dep,
        /^@anthropic-ai\/|^openai$|^@ai-sdk\/|^ai$/,
        `${pkgPath} has forbidden AI SDK dep: ${dep}`,
      );
    }
  }
});

// (c) only @agencyhq/trigger depends on @trigger.dev/sdk or @opencode-ai/sdk
test("only trigger depends on @trigger.dev/sdk and @opencode-ai/sdk", async () => {
  for (const pkgPath of workspacePaths) {
    if (pkgPath === "trigger") continue;
    const pkg = await readPackageJson(pkgPath);
    for (const dep of allDeps(pkg)) {
      assert.doesNotMatch(
        dep,
        /^@trigger\.dev\/sdk$|^@opencode-ai\/sdk$/,
        `${pkgPath} must not depend on ${dep}`,
      );
    }
  }
});

// (c) only @agencyhq/web depends on react, react-dom, or @trigger.dev/react-hooks
test("only web depends on react and @trigger.dev/react-hooks", async () => {
  for (const pkgPath of workspacePaths) {
    if (pkgPath === "apps/web") continue;
    const pkg = await readPackageJson(pkgPath);
    for (const dep of allDeps(pkg)) {
      assert.doesNotMatch(
        dep,
        /^react$|^react-dom$|^@trigger\.dev\/react-hooks$/,
        `${pkgPath} must not depend on ${dep}`,
      );
    }
  }
});

// (d) only @agencyhq/db and @agencyhq/coordinator depend on pg or @types/pg
test("only db and coordinator depend on pg", async () => {
  for (const pkgPath of workspacePaths) {
    if (pkgPath === "packages/db" || pkgPath === "apps/coordinator") continue;
    const pkg = await readPackageJson(pkgPath);
    for (const dep of allDeps(pkg)) {
      assert.doesNotMatch(
        dep,
        /^pg$|^@types\/pg$/,
        `${pkgPath} must not depend on ${dep}`,
      );
    }
  }
});
