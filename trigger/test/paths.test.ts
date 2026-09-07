import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

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
