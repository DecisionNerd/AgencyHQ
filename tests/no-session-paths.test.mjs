// Tracked files must not embed machine- or session-specific absolute paths
// (an agent scratchpad, a home directory). Such paths made the coordinator
// unit tests fail in CI on 2026-09-09 (EACCES on a path that exists only on
// the author's machine). Tests use os.tmpdir(); docs cite repository paths.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// Container homes such as /home/node or /home/opencode are legitimate; a macOS
// user home or an agent scratchpad is not.
const FORBIDDEN = [/\/private\/tmp\/claude-/, /\/tmp\/claude-/, /\/Users\/[A-Za-z0-9_.-]+\//];
const ALLOW = [/^\.claude\/plans\//];

test("no tracked file embeds a session or home-directory path", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf-8" })
    .split("\0")
    .filter((f) => f && !ALLOW.some((re) => re.test(f)));
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue; // removed from the working tree or unreadable
    }
    if (text.includes("\u0000")) continue; // binary
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `session/home paths found in: ${hits.join(", ")}`);
});
