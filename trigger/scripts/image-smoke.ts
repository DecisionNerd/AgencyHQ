/**
 * Image smoke script — proves the deployed AgencyHQ task image toolchain.
 *
 * Run by the orchestrator (Fable-main) during L1 qualification (#16, C1).
 * NOT run directly by Sonnet workers — it requires a live Trigger instance.
 *
 * Placed under trigger/scripts/ (not infra/tests/) because @trigger.dev/sdk
 * is declared as a dependency of @agencyhq/trigger and resolves from this
 * package's node_modules.  Running it from infra/tests/ would require either
 * a separate package.json or a path hack; the scripts/ convention is already
 * established (see echo.ts, trial.ts).
 *
 * Usage (see infra/tests/README.md for the full L1 command):
 *   node scripts/image-smoke.ts
 *
 * Required environment variables (checked at startup — script refuses without them):
 *   TRIGGER_API_URL          — Trigger webapp URL (e.g. http://127.0.0.1:8030)
 *   TRIGGER_SECRET_KEY       — Trigger prod environment secret key
 *   AGENCYHQ_FIXTURE_REMOTE  — Public https git URL of the fixture repository
 *   AGENCYHQ_FIXTURE_REVISION — Git revision (branch, tag, or commit SHA)
 *
 * Optional environment variables:
 *   AGENCYHQ_PLATFORM        — Expected platform string, default "linux/arm64"
 *
 * NEVER prints env values or secret data.  Only env variable names are
 * referenced in error messages and the JSON report.
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — one or more assertions failed (failing assertion named in stderr)
 *   1 — missing required env variable (names printed, values never)
 *   1 — unexpected error (message in stderr)
 */

import { configure, runs, tasks } from "@trigger.dev/sdk";

import { OPENCODE_VERSION, PNPM_VERSION } from "../build/toolchain.ts";
import type { ImageSmokeOutput, ImageSmokePayload, RuntimeProbeOutput } from "../src/types.ts";
import { TASK_IDS } from "../src/types.ts";
import { assertProbe, assertSmoke } from "./lib/image-smoke-assertions.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 600_000;

const FINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

const REQUIRED_ENV = [
  "TRIGGER_API_URL",
  "TRIGGER_SECRET_KEY",
  "AGENCYHQ_FIXTURE_REMOTE",
  "AGENCYHQ_FIXTURE_REVISION",
] as const;

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

/**
 * Read an env var and return its value, or null if absent or empty.
 * NEVER used to print the value itself in any error output.
 */
function readEnv(name: string): string | null {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : null;
}

/**
 * Validate all required env vars are present.
 * Prints the missing names (not values) and exits 1 if any are absent.
 */
function requireEnvVars(): void {
  const missing = REQUIRED_ENV.filter((name) => readEnv(name) === null);
  if (missing.length > 0) {
    // C4: script refuses to run without the four env names; prints names only.
    console.error(`image-smoke: missing required environment variables: ${missing.join(", ")}`);
    console.error(`Required: ${REQUIRED_ENV.join(", ")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollToFinal(
  runId: string,
  timeoutMs: number,
  label: string,
): Promise<{ status: string; output: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runs.retrieve(runId);
    if (FINAL_STATUSES.has(run.status)) {
      return { status: run.status, output: run.output };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: run ${runId} did not reach a final status within ${timeoutMs}ms (last status: ${run.status})`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // C4: refuse without the four env names.
  requireEnvVars();

  // All four required vars are present after requireEnvVars() — use ?? "" to
  // satisfy exactOptionalPropertyTypes without a non-null assertion.
  const apiUrl = readEnv("TRIGGER_API_URL") ?? "";
  const secretKey = readEnv("TRIGGER_SECRET_KEY") ?? "";
  const fixtureRemote = readEnv("AGENCYHQ_FIXTURE_REMOTE") ?? "";
  const fixtureRevision = readEnv("AGENCYHQ_FIXTURE_REVISION") ?? "";
  // Platform defaults to linux/arm64 (ADR-0008 §3, assumption 12).
  const platform = readEnv("AGENCYHQ_PLATFORM") ?? "linux/arm64";

  // Configure the Trigger SDK.
  configure({
    baseURL: apiUrl,
    secretKey,
  });

  const scriptStart = Date.now();

  // ---------------------------------------------------------------------------
  // Step A: runtime.probe — verify toolchain versions, uid, platform, env keys
  // ---------------------------------------------------------------------------

  const probeStart = Date.now();
  console.error(`[image-smoke] triggering ${TASK_IDS.runtimeProbe}...`);
  const probeHandle = await tasks.trigger(TASK_IDS.runtimeProbe, {});
  const probeRunId = probeHandle.id;
  console.error(`[image-smoke] probe run id: ${probeRunId}`);

  const probeResult = await pollToFinal(probeRunId, PROBE_TIMEOUT_MS, "runtime.probe");
  const probeMs = Date.now() - probeStart;

  if (probeResult.status !== "COMPLETED") {
    fail(
      `assertion failed: runtime.probe run ${probeRunId} ended with status "${probeResult.status}" (not COMPLETED)`,
    );
  }

  const probeOutput = probeResult.output as RuntimeProbeOutput;

  const probeError = assertProbe(probeOutput, {
    opencodeVersion: OPENCODE_VERSION,
    pnpmVersion: PNPM_VERSION,
    platform,
  });
  if (probeError !== null) {
    fail(probeError);
  }

  console.error(`[image-smoke] runtime.probe assertions passed`);

  // ---------------------------------------------------------------------------
  // Step B: image.smoke — clone fixture and run fixture-node-v1 checks
  // ---------------------------------------------------------------------------

  const smokePayload: ImageSmokePayload = {
    fixtureRemote,
    fixtureRevision,
    profileId: "fixture-node-v1",
  };

  const smokeStart = Date.now();
  console.error(`[image-smoke] triggering ${TASK_IDS.imageSmoke}...`);
  const smokeHandle = await tasks.trigger(TASK_IDS.imageSmoke, smokePayload);
  const smokeRunId = smokeHandle.id;
  console.error(`[image-smoke] smoke run id: ${smokeRunId}`);

  const smokeResult = await pollToFinal(smokeRunId, SMOKE_TIMEOUT_MS, "image.smoke");
  const smokeMs = Date.now() - smokeStart;

  if (smokeResult.status !== "COMPLETED") {
    fail(
      `assertion failed: image.smoke run ${smokeRunId} ended with status "${smokeResult.status}" (not COMPLETED)`,
    );
  }

  const smokeOutput = smokeResult.output as ImageSmokeOutput;

  const smokeError = assertSmoke(smokeOutput.results);
  if (smokeError !== null) {
    // Print the failing check's stdout/stderr for debugging (these are
    // check process outputs, not secrets).
    for (const r of smokeOutput.results) {
      if (!r.passed) {
        console.error(`[image-smoke] failing check: ${r.checkId}`);
        if (r.stdoutTail) console.error(`stdout: ${r.stdoutTail}`);
        if (r.stderrTail) console.error(`stderr: ${r.stderrTail}`);
      }
    }
    fail(smokeError);
  }

  console.error(`[image-smoke] image.smoke assertions passed`);

  // ---------------------------------------------------------------------------
  // Step C: print compact JSON report to stdout and exit 0
  // ---------------------------------------------------------------------------

  const report = {
    timestamp: new Date().toISOString(),
    totalMs: Date.now() - scriptStart,
    probe: {
      runId: probeRunId,
      status: probeResult.status,
      durationMs: probeMs,
      // Selected fields from the probe output (no env values).
      tools: probeOutput.tools,
      uid: probeOutput.uid,
      platform: probeOutput.platform,
      homeWritable: probeOutput.homeWritable,
      runRootWritable: probeOutput.runRootWritable,
    },
    smoke: {
      runId: smokeRunId,
      status: smokeResult.status,
      durationMs: smokeMs,
      profileId: "fixture-node-v1",
      // Results: checkId and pass/fail only (no stdout/stderr in the report).
      results: smokeOutput.results.map((r) => ({
        checkId: r.checkId,
        passed: r.passed,
        exitStatus: r.exitStatus,
        timedOut: r.timedOut,
      })),
    },
  };

  // JSON report on stdout; diagnostics on stderr.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error("[image-smoke] unexpected error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
