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
  "docs/engineering/TESTING.md",
  "docs/engineering/adrs/README.md",
  "docs/engineering/adrs/0001-authority-boundaries.md",
  "docs/engineering/adrs/0002-modular-monolith.md",
  "docs/engineering/adrs/0003-evidence-first-completion.md",
];

test("required architecture records exist", async () => {
  await Promise.all(requiredDocs.map((path) => access(join(root, path))));
});

test("authority ADR preserves the core boundary", async () => {
  const adr = await readFile(
    join(root, "docs/engineering/adrs/0001-authority-boundaries.md"),
    "utf8",
  );

  for (const authority of [
    "coordinator owns policy and domain control",
    "Postgres is the engineering/domain truth",
    "Trigger.dev is the durable execution mechanism",
    "OpenCode is the coding-agent runtime and provider abstraction",
    "Git and isolated worktrees are source truth",
  ]) {
    assert.match(adr, new RegExp(authority.replaceAll(".", "\\."), "i"));
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
