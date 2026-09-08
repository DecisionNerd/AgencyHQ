import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveModel } from "../scripts/opencode-smoke.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "opencode-smoke.ts");

// ---------------------------------------------------------------------------
// Pure-function unit tests for resolveModel
// ---------------------------------------------------------------------------

test("resolveModel: returns model from --model flag", () => {
  const result = resolveModel(["--model", "myvendor/mymodel"], {});
  assert.deepEqual(result, { model: "myvendor/mymodel" });
});

test("resolveModel: returns model from AGENCYHQ_OPENCODE_MODEL env", () => {
  const result = resolveModel([], { AGENCYHQ_OPENCODE_MODEL: "env/model" });
  assert.deepEqual(result, { model: "env/model" });
});

test("resolveModel: --model flag takes precedence over env var", () => {
  const result = resolveModel(["--model", "flag/model"], {
    AGENCYHQ_OPENCODE_MODEL: "env/model",
  });
  assert.deepEqual(result, { model: "flag/model" });
});

test("resolveModel: returns error when neither --model nor env is set", () => {
  const result = resolveModel([], {});
  assert("error" in result, "expected { error } result");
});

test("resolveModel: returns error when --model flag has no value", () => {
  const result = resolveModel(["--model"], {});
  assert("error" in result, "expected { error } result when --model has no value");
});

test("resolveModel: returns error when --model value starts with a dash", () => {
  const result = resolveModel(["--model", "--other-flag"], {});
  assert("error" in result, "expected { error } when --model is followed by another flag");
});

// ---------------------------------------------------------------------------
// Integration: spawning the script with no model yields exit code 2
// ---------------------------------------------------------------------------

test("script exits with code 2 when neither --model nor env is provided", async () => {
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env["PATH"] ?? "" },
      stdio: "pipe",
    });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  assert.equal(code, 2);
});
