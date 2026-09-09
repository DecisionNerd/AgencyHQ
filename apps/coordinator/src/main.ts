/**
 * Coordinator process entry point.
 *
 * Reads config, creates Postgres pool, runs migrations, picks ExecutionRuntime,
 * constructs the flow, starts the reconciler, and serves the Hono app.
 * Handles SIGTERM/SIGINT gracefully.
 */

import { existsSync } from "node:fs";
import { HOST_PROFILE } from "@agencyhq/contracts";
import { createPool, runMigrations } from "@agencyhq/db";
import { newId } from "@agencyhq/domain";
import { FakeExecutionRuntime, RealExecutionRuntime } from "@agencyhq/trigger/client";
import { CHECK_CATALOG, profileDigest, resolveProfile } from "@agencyhq/verification";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { commandHandlers } from "./commands/index.ts";
import { loadConfig, readTriggerKeyFromState } from "./config.ts";
import { BoundedRepairFlow } from "./flow/bounded-repair.ts";
import { Reconciler } from "./flow/observe.ts";
import type { FlowDeps } from "./flow/types.ts";
import type { ProviderStatus } from "./provider/state.ts";
import { providerIdFromModel, readProviderState } from "./provider/state.ts";
import { loadReadinessInputs } from "./readiness/loader.ts";

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const config = loadConfig();

const pool = createPool(config.databaseUrl);

// Run migrations — requires a PoolClient
{
  const client = await pool.connect();
  try {
    await runMigrations(client);
  } finally {
    client.release();
  }
}

// Pick ExecutionRuntime: real or fake
let runtime: FakeExecutionRuntime | RealExecutionRuntime;

if (config.runtime === "real") {
  // Resolve the key lazily so the coordinator can start before bootstrap writes
  // trigger-prod.key. The provider reads trigger-prod.key from disk lazily;
  // once a non-empty value is found it is memoized so subsequent calls skip
  // the filesystem read even before _ensureConfigured() memoizes the key for configure.
  let _memoizedKey = "";
  runtime = new RealExecutionRuntime({
    apiUrl: config.triggerApiUrl,
    secretKey: () => {
      if (!_memoizedKey) {
        _memoizedKey = config.triggerSecretKey || readTriggerKeyFromState(config.stateDir) || "";
      }
      return _memoizedKey;
    },
  });
} else {
  runtime = new FakeExecutionRuntime();
}

// Build profileResolver from @agencyhq/verification catalog
function profileResolver(profileId: string) {
  const profile = resolveProfile(profileId);
  const digest = String(profileDigest(profile));
  const checks = profile.checks.map((checkId) => {
    const def = CHECK_CATALOG[checkId];
    if (!def) throw new Error(`Unknown check id: ${checkId}`);
    return {
      id: def.id,
      version: def.version,
      command: def.command,
      timeoutSeconds: def.timeoutSeconds,
    };
  });
  return Promise.resolve({ digest, checks, protectedPaths: profile.protectedPaths });
}

// Construct clock and id generator
const clock = { now: () => new Date().toISOString() };
const ids = { next: (prefix: string) => newId(prefix as Parameters<typeof newId>[0]) };

// Construct FlowDeps
const flowDeps: FlowDeps = {
  pool,
  runtime,
  clock,
  ids,
  profile: HOST_PROFILE,
  config: {
    worktreeBase: config.worktreeBase,
    workerModel: config.workerModel,
    leadModel: config.leadModel,
    reviewerModel: config.reviewerModel,
    verifierName: "agencyhq/verify.run",
    leadVariant: config.leadVariant,
    uncertainAfterMs: config.uncertainAfterMs,
    workerSlots: config.workerSlots,
    ...(config.integrateRetries !== undefined ? { integrateRetries: config.integrateRetries } : {}),
  },
  profileResolver,
  // D9 / W-11: provider state for dispatch gate — only for container runtime profile.
  ...(config.runtimeProfile === "container" ? { providerState: readCurrentProviderState } : {}),
};

// Construct flow and reconciler
const flow = new BoundedRepairFlow(flowDeps);
const reconciler = new Reconciler(flowDeps, flow, {
  uncertainAfterMs: config.uncertainAfterMs,
  ...(config.workerSlots !== undefined ? { workerSlots: config.workerSlots } : {}),
  ...(config.realtimeWakeup !== undefined ? { realtimeWakeup: config.realtimeWakeup } : {}),
});
reconciler.start(config.reconcileIntervalMs);

// Construct command handlers (workerModel required for approve command evaluation)
const commands = commandHandlers({
  pool,
  runtime,
  clock,
  config: {
    workerModel: config.workerModel,
    worktreeBase: config.worktreeBase,
    uncertainAfterMs: config.uncertainAfterMs,
  },
});

// Provider state helper — derive required provider ids from worker/lead models.
const requiredProviderIds: string[] = [];
for (const model of [config.workerModel, config.leadModel]) {
  const id = providerIdFromModel(model);
  if (id && !requiredProviderIds.includes(id)) requiredProviderIds.push(id);
}

function readCurrentProviderState(): ProviderStatus | undefined {
  if (config.runtimeProfile !== "container") return undefined;
  const state = readProviderState({
    dataDir: config.opencodeDataDir,
    now: new Date().toISOString(),
    requiredProviderIds,
  });
  return state.status;
}

// Wire the readiness loader — re-reads state files on every poll (lazy, no restart needed).
const readinessLoader = async () => {
  const inputs = await loadReadinessInputs({
    pool,
    triggerApiUrl: config.triggerApiUrl,
    triggerSecretKey: config.triggerSecretKey,
    stateDir: config.stateDir,
  });
  const providerStatus = readCurrentProviderState();
  if (providerStatus !== undefined) {
    return { ...inputs, providerStatus };
  }
  return inputs;
};

// Wire internal router deps (lease broker) when secretsKey is available.
const internalDeps =
  config.runtimeProfile === "container"
    ? {
        pool,
        providerState: async (): Promise<ProviderStatus> => {
          return readCurrentProviderState() ?? "unavailable";
        },
        dataDirFn: () => config.opencodeDataDir,
        secretsKey: () => config.secretsKey,
        leaseTtlMs: config.leaseTtlMs,
        integrateLeaseTtlMs: config.integrateLeaseTtlMs,
      }
    : undefined;

// Build and serve the app
const app = createApp({
  pool,
  flow,
  reconciler: {
    freshness: () => ({
      lastPollAt: reconciler.freshness,
      stale:
        reconciler.freshness === null ||
        Date.now() - new Date(reconciler.freshness).getTime() > config.freshnessStaleMs,
    }),
  },
  runtime,
  config,
  commands,
  loadReadiness: readinessLoader,
  ...(internalDeps ? { internalDeps } : {}),
});

const server = serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.bindHost,
});

// Warn when API runs without bearer-token protection (loopback-only allowed without a token).
if (!config.apiToken) {
  console.warn(
    "WARNING: AGENCYHQ_API_TOKEN is not set. The API has no bearer-token protection. " +
      "Set AGENCYHQ_API_TOKEN to enable authentication.",
  );
}

// Log startup facts (no secrets)
const webDistPresent = config.webDist !== undefined && existsSync(config.webDist);
console.log(
  `Coordinator listening on ${config.bindHost}:${String(config.port)} runtime=${config.runtime} webDist=${webDistPresent ? config.webDist : "none"}`,
);

// Graceful shutdown on SIGTERM and SIGINT
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down...`);
  reconciler.stop();
  server.close(() => {
    console.log("HTTP server closed");
  });
  await pool.end();
  console.log("Database pool closed. Exited cleanly.");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
