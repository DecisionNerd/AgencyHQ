import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { assertPushBlocked, REMOVED_BY_ALLOWLIST, scrubbedChildEnv } from "../src/lib/env.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

test("scrubbedChildEnv drops secrets not on the allowlist and keeps HOME", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    process.env.GH_TOKEN = "gh-secret";
    process.env.GITHUB_TOKEN = "gh-secret-2";
    process.env.TRIGGER_SECRET_KEY = "trig-secret";
    process.env.TRIGGER_API_URL = "https://example.invalid";
    process.env.HOME = process.env.HOME ?? "/home/test";

    const env = scrubbedChildEnv({ attemptId: "attempt-1" });

    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.TRIGGER_SECRET_KEY, undefined);
    assert.equal(env.TRIGGER_API_URL, undefined);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.AGENCYHQ_ATTEMPT_ID, "attempt-1");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.equal(env.GIT_SSH_COMMAND, "/usr/bin/false");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  }
});

test("scrubbedChildEnv merges extra last, overriding defaults", () => {
  const env = scrubbedChildEnv({
    attemptId: "attempt-2",
    extra: { AGENCYHQ_ATTEMPT_ID: "override", CUSTOM: "value" },
  });
  assert.equal(env.AGENCYHQ_ATTEMPT_ID, "override");
  assert.equal(env.CUSTOM, "value");
});

test("REMOVED_BY_ALLOWLIST documents the named secrets", () => {
  for (const name of [
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "TRIGGER_SECRET_KEY",
    "TRIGGER_API_URL",
    "TRIGGER_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_*",
  ]) {
    assert.ok(REMOVED_BY_ALLOWLIST.includes(name as (typeof REMOVED_BY_ALLOWLIST)[number]));
  }
});

test("assertPushBlocked reports blocked when the scrubbed env cannot push", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "agencyhq-env-test-"));
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "hello\n");
  await git(["add", "-A"], repoPath);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "base"],
    repoPath,
  );
  await git(["remote", "add", "origin", "https://example.invalid/nonexistent.git"], repoPath);

  const env = scrubbedChildEnv({ attemptId: "attempt-push-test" });
  const result = await assertPushBlocked({ repoPath, env });

  assert.equal(result.blocked, true);
  assert.notEqual(result.exitCode, 0);
});
