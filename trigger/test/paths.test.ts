import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildPermissionRuleset } from "../src/lib/opencode.ts";
import { classifyPaths, matchesGlob, quarantinePatch } from "../src/lib/paths.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

test("src/* allows a direct child but not a nested file", () => {
  assert.equal(matchesGlob("src/*", "src/a.ts"), true);
  assert.equal(matchesGlob("src/*", "src/x/b.ts"), false);
});

test("src/** allows nested files", () => {
  assert.equal(matchesGlob("src/**", "src/x/b.ts"), true);
  assert.equal(matchesGlob("src/**", "src/a.ts"), true);
});

test("classifyPaths flags .., absolute, and out-of-scope paths as violations", () => {
  const { allowed, violations } = classifyPaths({
    changed: ["src/a.ts", "../x", "/tmp/x", "secrets/x"],
    allowed: ["src/*"],
  });
  assert.deepEqual(allowed, ["src/a.ts"]);
  assert.deepEqual(violations, ["../x", "/tmp/x", "secrets/x"]);
});

test("classifyPaths allows nested paths under a ** pattern", () => {
  const { allowed, violations } = classifyPaths({
    changed: ["src/nested/deep/file.ts"],
    allowed: ["src/**"],
  });
  assert.deepEqual(allowed, ["src/nested/deep/file.ts"]);
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// F-4: classifyPaths with denied list
// ---------------------------------------------------------------------------

test("classifyPaths: denied glob quarantines a path even when it matches allowed", () => {
  // src/parser/public-api.ts matches src/parser/** (allowed) but also matches
  // the specific deny glob — it must be quarantined.
  const { allowed, violations } = classifyPaths({
    changed: ["src/parser/public-api.ts", "src/parser/internal.ts"],
    allowed: ["src/parser/**"],
    denied: ["src/parser/public-api.ts"],
  });
  assert.deepEqual(violations, ["src/parser/public-api.ts"]);
  assert.deepEqual(allowed, ["src/parser/internal.ts"]);
});

test("classifyPaths: path in neither allowed nor denied is still a violation", () => {
  const { allowed, violations } = classifyPaths({
    changed: ["unrelated/file.ts"],
    allowed: ["src/**"],
    denied: ["src/parser/public-api.ts"],
  });
  assert.deepEqual(violations, ["unrelated/file.ts"]);
  assert.deepEqual(allowed, []);
});

test("classifyPaths: empty denied list behaves the same as omitting denied", () => {
  const withEmpty = classifyPaths({
    changed: ["src/a.ts"],
    allowed: ["src/**"],
    denied: [],
  });
  const withOmit = classifyPaths({
    changed: ["src/a.ts"],
    allowed: ["src/**"],
  });
  assert.deepEqual(withEmpty, withOmit);
});

test("buildPermissionRuleset: denied path entry appears after allow in edit map (last-match-wins)", () => {
  const ruleset = buildPermissionRuleset({
    allowedPaths: ["src/parser/**"],
    worktreePath: "/wt",
    deniedPaths: ["src/parser/public-api.ts"],
  });
  const keys = Object.keys(ruleset.edit);
  const allowIdx = keys.indexOf("src/parser/**");
  const denyIdx = keys.indexOf("src/parser/public-api.ts");
  assert.ok(allowIdx !== -1, "allow glob must be in edit map");
  assert.ok(denyIdx !== -1, "deny glob must be in edit map");
  assert.ok(denyIdx > allowIdx, "deny entry must appear after allow entry for last-match-wins");
  assert.equal(ruleset.edit["src/parser/public-api.ts"], "deny");
  assert.equal(ruleset.edit["src/parser/**"], "allow");
});

test("quarantinePatch contains the violating file's content", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-paths-test-"));
  try {
    await git(["init", "--initial-branch=main"], repoPath);
    await writeFile(join(repoPath, "README.md"), "hello\n");
    await git(["add", "-A"], repoPath);
    await git(
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"],
      repoPath,
    );
    const baseRev = (await git(["rev-parse", "HEAD"], repoPath)).trim();

    await mkdir(join(repoPath, "secrets"), { recursive: true });
    await writeFile(join(repoPath, "secrets", "leak.txt"), "top secret contents\n");

    const patch = await quarantinePatch({
      worktreePath: repoPath,
      baseRev,
      paths: ["secrets/leak.txt"],
    });

    assert.match(patch, /secrets\/leak\.txt/);
    assert.match(patch, /top secret contents/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
