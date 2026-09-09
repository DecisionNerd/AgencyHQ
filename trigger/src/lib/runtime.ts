// Per-run runtime preparation for task containers (epic #14, P18.3).
//
// On the host profile (trigger dev): HOME is process.env.HOME, cleanup is a noop,
// no broker interaction.
//
// On the container profile: a per-run isolated HOME is created under runRoot,
// a provider lease is requested, auth.json is written at mode 0600 under that HOME,
// and cleanup deletes the whole HOME tree in a finally block.
//
// Refusals: returned as a structured error (never thrown) so the task adapter
// can set Trigger metadata and throw AbortTaskRunError with a clear reason.
//
// SECURITY:
//   - auth.json is written at mode 0600 and deleted in cleanup.
//   - Secret values never appear in logs, errors, or metadata.
//   - The nonce is consumed once and not retained after requestLease.
//
// No Trigger SDK usage; no direct child_process calls.

import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeaseGrant, LeaseRequest } from "@agencyhq/contracts";

import type { Broker } from "./broker.ts";
import { readRuntimeProfile, resolveRunHome } from "./runtime-home.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Arguments for prepareRuntime. */
export type PrepareRuntimeArgs = {
  /** Trigger run id (from ctx.run.id). Used as runId for lease requests. */
  runId: string;
  /** Attempt id from the payload. */
  attemptId: string;
  /** Generation from the payload. */
  generation: number;
  /**
   * The dispatch nonce — proves the worker knows the current generation's
   * dispatch credential. Must be at least 32 characters.
   *
   * Currently read from the `AGENCYHQ_DISPATCH_NONCE` env var (see Open
   * Question in the report: contracts/v2 payloads do not yet include this
   * field explicitly). The caller is responsible for supplying it.
   */
  nonce: string;
  /** Coordinator broker client. Used only on the container profile. */
  broker: Broker;
  /** Environment variable map (default: process.env). */
  env?: Record<string, string | undefined>;
};

/** Successful prepareRuntime result. */
export type PrepareRuntimeOk = {
  ok: true;
  /**
   * HOME directory for child processes.
   * Host profile: process.env.HOME (unchanged).
   * Container profile: <runRoot>/runs/<runId>/home (isolated, will be deleted on cleanup).
   */
  home: string;
  /**
   * Additional env vars to inject into child processes.
   * Currently empty on the host profile.
   * Container profile: empty (HOME is passed explicitly via scrubbedChildEnv's `home` arg).
   */
  envAdditions: Record<string, string>;
  /**
   * The issued upload lease grant (container profile only; null on host profile).
   * Callers use the upload token from this lease for artifact/checkpoint/evidence uploads.
   */
  uploadLease: LeaseGrant | null;
  /** Async cleanup function: deletes the per-run HOME tree on the container profile. */
  cleanup: () => Promise<void>;
};

/** Failure result: the provider refused to issue a lease. */
export type PrepareRuntimeFailure = {
  ok: false;
  /**
   * Classified failure kind:
   *   provider_login_required  — coordinator has no provider auth; operator action needed.
   *   provider_expired         — provider credentials have expired; re-auth needed.
   *   provider_unavailable     — transient; retry may succeed.
   */
  failureKind: "provider_login_required" | "provider_expired" | "provider_unavailable";
  /** Human-readable explanation (no secret values). */
  reason: string;
};

export type PrepareRuntimeResult = PrepareRuntimeOk | PrepareRuntimeFailure;

// ---------------------------------------------------------------------------
// prepareRuntime
// ---------------------------------------------------------------------------

/**
 * Prepare the per-run runtime environment.
 *
 * Host profile: returns process.env.HOME unchanged, cleanup is a noop.
 * Container profile:
 *   1. Resolve (and create) the per-run isolated HOME under runRoot.
 *   2. Request a `provider` lease to get auth material.
 *   3. Write auth.json at 0600 inside the isolated HOME.
 *   4. Request an `upload` lease for later artifact/evidence uploads.
 *   5. Return home path, env additions, and cleanup that deletes the HOME tree.
 *
 * @returns PrepareRuntimeOk on success; PrepareRuntimeFailure if the coordinator
 *          refuses the provider lease (login required / expired / unavailable).
 */
export async function prepareRuntime(args: PrepareRuntimeArgs): Promise<PrepareRuntimeResult> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const profile = readRuntimeProfile(env);
  const hostHome = env.HOME ?? "/home/node";

  if (profile === "host") {
    return {
      ok: true,
      home: hostHome,
      envAdditions: {},
      uploadLease: null,
      cleanup: async () => {},
    };
  }

  // Container profile: per-run isolated HOME.
  const runRoot = env.AGENCYHQ_RUN_ROOT ?? "/tmp/agencyhq";
  const { home } = resolveRunHome({
    profile: "container",
    runRoot,
    runId: args.runId,
    hostHome,
  });

  // Request provider lease.
  const providerRequest: LeaseRequest = {
    runId: args.runId,
    attemptId: args.attemptId,
    generation: args.generation,
    purpose: "provider",
    nonce: args.nonce,
  };

  const providerResult = await args.broker.requestLease(providerRequest);

  if (!providerResult.ok) {
    const reason = providerResult.refusal.reason;
    let failureKind: PrepareRuntimeFailure["failureKind"];
    if (reason === "login_required") {
      failureKind = "provider_login_required";
    } else if (reason === "expired") {
      failureKind = "provider_expired";
    } else {
      failureKind = "provider_unavailable";
    }
    // W-13: clean up the home dir that resolveRunHome already created.
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      failureKind,
      reason: `provider lease refused: ${reason}`,
    };
  }

  const providerGrant = providerResult.grant;

  // Write auth.json to the isolated HOME (mode 0600).
  const authJsonPath = join(home, ".local", "share", "opencode", "auth.json");
  if (providerGrant.material.purpose === "provider") {
    const authJson = providerGrant.material.authJson;
    await writeFile(authJsonPath, authJson, { mode: 0o600, encoding: "utf8" });
    // Ensure the mode is 0600 even if umask restricted the writeFile mode
    await chmod(authJsonPath, 0o600);
  }

  // Request upload lease (for artifact/checkpoint/evidence uploads).
  const uploadRequest: LeaseRequest = {
    runId: args.runId,
    attemptId: args.attemptId,
    generation: args.generation,
    purpose: "upload",
    nonce: args.nonce,
  };

  const uploadResult = await args.broker.requestLease(uploadRequest);
  const uploadLease = uploadResult.ok ? uploadResult.grant : null;

  // Cleanup: delete the per-run HOME tree.
  const cleanup = async (): Promise<void> => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  };

  return {
    ok: true,
    home,
    envAdditions: {},
    uploadLease,
    cleanup,
  };
}
