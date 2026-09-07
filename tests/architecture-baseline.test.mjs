import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const requiredDocs = [
  "README.md",
  "docs/README.md",
  "docs/PRODUCT.md",
  "docs/DESIGN.md",
  "docs/REQUIREMENTS.md",
  "docs/experience/README.md",
  "docs/strategy/README.md",
  "docs/strategy/roadmap.md",
  "docs/engineering/README.md",
  "docs/engineering/ARCHITECTURE.md",
  "docs/engineering/DOMAIN_MODEL.md",
  "docs/engineering/EXECUTION_MODEL.md",
  "docs/engineering/PROCESS_CATALOG.md",
  "docs/engineering/TESTING.md",
  "docs/engineering/adrs/README.md",
  "docs/engineering/adrs/0001-authority-boundaries.md",
  "docs/engineering/adrs/0002-modular-monolith.md",
  "docs/engineering/adrs/0003-evidence-first-completion.md",
  "docs/engineering/adrs/0004-supervised-completion-and-safe-recovery.md",
  "docs/engineering/adrs/0005-trigger-as-execution-runtime.md",
  "docs/engineering/adrs/0006-lead-role-and-delegated-authority.md",
  "docs/engineering/adrs/0007-worker-effect-model.md",
  "apps/web/README.md",
  "apps/coordinator/README.md",
  "packages/domain/README.md",
  "packages/contracts/README.md",
  "packages/db/README.md",
  "packages/verification/README.md",
  "trigger/README.md",
  "infra/trigger/README.md",
];

// Documents that describe the current design. ADR-0001 to ADR-0004 are immutable
// history, and ADR-0005/0006 and the ADR index discuss the rename itself.
const currentDesignDocs = requiredDocs.filter(
  (path) => !/adrs\/(000[1-6]|README)/.test(path),
);

test("required architecture records exist", async () => {
  await Promise.all(requiredDocs.map((path) => access(join(root, path))));
});

test("ADR index lists every ADR file", async () => {
  const index = await readFile(join(root, "docs/engineering/adrs/README.md"), "utf8");
  for (const path of requiredDocs.filter((p) => /adrs\/\d{4}-/.test(p))) {
    const file = path.split("/").at(-1);
    assert.match(index, new RegExp(`\\(${file}\\)`), `ADR index is missing ${file}`);
  }
});

test("current design documents use the Lead vocabulary", async () => {
  // "supervisor" is a Trigger.dev component; AgencyHQ's decision role is the
  // Lead. A line may mention the Trigger supervisor only in that sense.
  for (const path of currentDesignDocs) {
    const lines = (await readFile(join(root, path), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (/\bsupervisor\b/i.test(line)) {
        assert.match(
          line,
          /trigger|container|worker (machine|stack)/i,
          `${path}:${index + 1} uses "supervisor" for the AgencyHQ role`,
        );
      }
    });
  }
});

test("retained DocSlime documents contain no unfinished guidance", async () => {
  for (const path of requiredDocs.filter((path) => path.startsWith("docs/"))) {
    const content = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(content, /LLM:/, `${path} contains template guidance`);
  }
});

test("relative Markdown links resolve", async () => {
  const markdownFiles = await Promise.all(
    requiredDocs.map(async (path) => [path, await readFile(join(root, path), "utf8")]),
  );

  for (const [path, content] of markdownFiles) {
    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/g)) {
      const target = resolve(root, dirname(path), match[1]);
      await assert.doesNotReject(access(target), `${path} links to missing ${match[1]}`);
    }
  }
});
