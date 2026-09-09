/**
 * Bootstrap state machine persisted to AGENCYHQ_STATE_DIR/bootstrap.json.
 * Phases progress from wait_services → login → org_project → credentials →
 * deploy → verify_deployment → done.
 *
 * No secrets or one-time URLs are stored in the JSON; those go to AGENCYHQ_SECRETS_DIR
 * as separate 0600 files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Phase =
  | "wait_services"
  | "login"
  | "org_project"
  | "credentials"
  | "deploy"
  | "verify_deployment"
  | "done";

export type PhaseStatus = "pending" | "running" | "done" | "failed";

export interface PhaseState {
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  /** Machine-readable failure category for actionable error display. */
  errorCategory?: string;
  /** Human-readable error summary — must NOT contain secret values. */
  errorMessage?: string;
  /** Non-secret metadata persisted across restarts. */
  orgSlug?: string;
  projectSlug?: string;
  projectRef?: string;
  deploymentVersion?: string;
}

export interface BootstrapState {
  version: 1;
  phases: Partial<Record<Phase, PhaseState>>;
  updatedAt: string;
  /**
   * ISO timestamp of the most recent magic-link request.
   * Used to enforce a 60-second throttle between requests to the same address.
   */
  lastMagicLinkRequestAt?: string;
  /**
   * ISO timestamp when the webapp's magic-link rate limit resets.
   * Set when the login phase encounters a 429/302-to-login rate-limit response.
   * The CLI sleeps until this time (capped at 15 minutes) before exiting.
   */
  magicLinkRateLimitedUntil?: string;
  /**
   * ISO timestamp of the next retry attempt.
   * Set just before the process sleeps so the coordinator can surface it.
   * Cleared to undefined on any successful phase.
   */
  nextRetryAt?: string;
  /**
   * Exponential backoff attempt counter.
   * Incremented on each transient failure exit; reset to 0 on any phase success.
   * Used to compute min(2^attempt × 15 s, 5 min) backoff when no rate-limit
   * reset time is known.
   */
  attempt?: number;
}

export const PHASES: readonly Phase[] = [
  "wait_services",
  "login",
  "org_project",
  "credentials",
  "deploy",
  "verify_deployment",
  "done",
];

function emptyState(): BootstrapState {
  return { version: 1, phases: {}, updatedAt: new Date().toISOString() };
}

export class StateManager {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly secretsDir: string;

  constructor(stateDir: string, secretsDir: string) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, "bootstrap.json");
    this.secretsDir = secretsDir;
  }

  load(): BootstrapState {
    if (existsSync(this.statePath)) {
      const raw = readFileSync(this.statePath, "utf-8");
      return JSON.parse(raw) as BootstrapState;
    }
    return emptyState();
  }

  save(state: BootstrapState): void {
    mkdirSync(this.stateDir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  }

  /** Returns the phase state (defaulting to pending) without mutating. */
  getPhase(state: BootstrapState, phase: Phase): PhaseState {
    return state.phases[phase] ?? { status: "pending" };
  }

  /** Returns true when a phase has successfully completed. */
  isDone(state: BootstrapState, phase: Phase): boolean {
    return state.phases[phase]?.status === "done";
  }

  setRunning(state: BootstrapState, phase: Phase): void {
    // Spread existing then omit optional fields that must be cleared.
    const { errorCategory: _ec, errorMessage: _em, ...rest } = state.phases[phase] ?? {};
    state.phases[phase] = {
      ...rest,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.save(state);
  }

  /** Marks completed phases pending again so the next run repeats them (e.g. a redeploy). */
  reopen(state: BootstrapState, phases: readonly Phase[]): void {
    for (const phase of phases) {
      if (state.phases[phase]?.status === "done") {
        state.phases[phase] = { status: "pending" };
      }
    }
    this.save(state);
  }

  setDone(state: BootstrapState, phase: Phase, meta?: Partial<PhaseState>): void {
    state.phases[phase] = {
      ...state.phases[phase],
      ...meta,
      status: "done",
      completedAt: new Date().toISOString(),
    };
    // Reset backoff on any phase success so the next failure starts from attempt 0.
    state.attempt = 0;
    delete state.nextRetryAt;
    this.save(state);
  }

  setFailed(
    state: BootstrapState,
    phase: Phase,
    errorCategory: string,
    errorMessage: string,
  ): void {
    state.phases[phase] = {
      ...state.phases[phase],
      status: "failed",
      errorCategory,
      errorMessage,
      completedAt: new Date().toISOString(),
    };
    this.save(state);
  }

  // ── Secrets (stored as 0600 files outside bootstrap.json) ────────────────

  hasSecret(name: string): boolean {
    return existsSync(join(this.secretsDir, name));
  }

  readSecret(name: string): string | null {
    const p = join(this.secretsDir, name);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf-8").trim();
  }

  writeSecret(name: string, value: string): void {
    mkdirSync(this.secretsDir, { recursive: true });
    writeFileSync(join(this.secretsDir, name), value, { mode: 0o600 });
  }
}

/** Produce a state summary without any secret values (for `bootstrap status`). */
export function redactedSummary(state: BootstrapState): BootstrapState {
  return state; // state.json never contains secrets; safe to return as-is.
}
