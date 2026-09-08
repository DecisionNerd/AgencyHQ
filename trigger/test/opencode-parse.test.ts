import assert from "node:assert/strict";
import test from "node:test";

import { buildPermissionRuleset, parseEvents, summarize } from "../src/lib/opencode.ts";

// Captured verbatim from the required smoke run (see trigger/src/lib/opencode.ts
// header comment and the packet report): the model call failed with an
// upstream auth error before any tool call happened, so this is the one real
// event this binary version produced for the spike. It exercises the
// `errors` path of summarize() against genuine output.
const REAL_ERROR_EVENT_LINE =
  '{"type":"error","timestamp":1788766912551,"sessionID":"ses_f852f087bffepvMX6c3mINjQOu","error":{"name":"APIError","data":{"message":"Invalid API key.","statusCode":401,"isRetryable":false,"responseHeaders":{"cf-placement":"remote-ORD","cf-ray":"a37412d32bdc5305-SLC","connection":"keep-alive","content-length":"74","content-type":"text/plain;charset=UTF-8","date":"Mon, 07 Sep 2026 07:41:52 GMT","server":"cloudflare"},"responseBody":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"AuthError\\",\\"message\\":\\"Invalid API key.\\"}}","metadata":{"url":"https://opencode.ai/zen/v1/chat/completions"}}}}';

// Captured 2026-09-07 from smoke scenario c (git push) with OpenCode 1.18.29
// and model openai/gpt-5.6-terra. The `state.error` prefix is verbatim; the
// trailing "relevant rules" array is abridged to two entries and the part's
// output/metadata/time fields are dropped for readability.
const REAL_DENIAL_EVENT_LINE =
  '{"type":"tool_use","timestamp":1788767581025,"sessionID":"ses_f8524dc0effe7XABktGeqTyj8y","part":{"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"git push origin HEAD","workdir":"/private/var/folders/qn/rntm81jj49g_nhf97pw1_3j40000gn/T/agencyhq-opencode-smoke-wt-1788767457018","timeout":120000},"error":"The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{\\"permission\\":\\"bash\\",\\"pattern\\":\\"*\\",\\"action\\":\\"allow\\"},{\\"permission\\":\\"bash\\",\\"pattern\\":\\"*git push*\\",\\"action\\":\\"deny\\"}]"},"id":"prt_07adb2f5b001zgQdZHvPk9x6AM"}}';

// A completed tool call (same run), for the toolUses count and to prove a
// non-error tool_use is never a denial.
const REAL_TOOL_OK_EVENT_LINE = JSON.stringify({
  type: "tool_use",
  timestamp: 1788767580000,
  sessionID: "ses_f8524dc0effe7XABktGeqTyj8y",
  part: { type: "tool", tool: "read", state: { status: "completed", input: {}, output: "" } },
});

test("parseEvents decodes the real captured NDJSON line", () => {
  const events = parseEvents(REAL_ERROR_EVENT_LINE);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.sessionID, "ses_f852f087bffepvMX6c3mINjQOu");
});

test("summarize extracts the real error message from a genuine APIError event", () => {
  const events = parseEvents(REAL_ERROR_EVENT_LINE);
  const summary = summarize(events);
  assert.equal(summary.sessionID, "ses_f852f087bffepvMX6c3mINjQOu");
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0] ?? "", /Invalid API key\./);
  assert.equal(summary.denials.length, 0);
});

test("summarize detects a real permission denial (tool_use with state.status error)", () => {
  const events = parseEvents([REAL_TOOL_OK_EVENT_LINE, REAL_DENIAL_EVENT_LINE].join("\n"));
  const summary = summarize(events);
  assert.equal(summary.denials.length, 1);
  assert.equal(summary.denials[0]?.tool, "bash");
  assert.equal(summary.denials[0]?.pattern, "git push origin HEAD");
  assert.match(summary.denials[0]?.message ?? "", /specified a rule which prevents/);
  assert.equal(summary.errors.length, 0);
  assert.deepEqual(
    summary.toolUses.sort((a, b) => a.tool.localeCompare(b.tool)),
    [
      { tool: "bash", count: 1 },
      { tool: "read", count: 1 },
    ],
  );
});

test("summarize records a non-denial tool error under errors, not denials", () => {
  const line = JSON.stringify({
    type: "tool_use",
    sessionID: "ses_x",
    part: {
      type: "tool",
      tool: "bash",
      state: { status: "error", error: "exit code 1", input: {} },
    },
  });
  const summary = summarize(parseEvents(line));
  assert.equal(summary.denials.length, 0);
  assert.deepEqual(summary.errors, ["bash: exit code 1"]);
});

test("parseEvents handles multiple NDJSON lines, ignoring blanks", () => {
  const ndjson = [REAL_ERROR_EVENT_LINE, "", REAL_DENIAL_EVENT_LINE, ""].join("\n");
  const events = parseEvents(ndjson);
  assert.equal(events.length, 2);
});

test("buildPermissionRuleset always denies task, webfetch, and git push regardless of input", () => {
  const rulesetA = buildPermissionRuleset({ allowedPaths: [], worktreePath: "/tmp/wt-a" });
  const rulesetB = buildPermissionRuleset({
    allowedPaths: ["**", "src/*", "docs/**"],
    worktreePath: "/some/other/worktree",
  });

  for (const ruleset of [rulesetA, rulesetB]) {
    assert.equal(ruleset.task, "deny");
    assert.equal(ruleset.webfetch, "deny");
    assert.equal(ruleset.websearch, "deny");
    assert.equal(ruleset.skill, "deny");
    assert.equal(ruleset.external_directory, "deny");
    assert.equal(ruleset.doom_loop, "deny");
    assert.equal(ruleset["*"], "deny");
    assert.equal(ruleset.edit["*"], "deny");
    assert.equal(ruleset.bash["*git push*"], "deny");
    assert.equal(ruleset.bash["*git remote*"], "deny");
    assert.equal(ruleset.bash["*git fetch*"], "deny");
    assert.equal(ruleset.bash["*git pull*"], "deny");
    assert.equal(ruleset.bash["*gh *"], "deny");
    assert.equal(ruleset.bash["*curl*"], "deny");
    assert.equal(ruleset.bash["*wget*"], "deny");
    assert.equal(ruleset.bash["*ssh *"], "deny");
    assert.equal(ruleset.bash["*scp *"], "deny");
  }
});
