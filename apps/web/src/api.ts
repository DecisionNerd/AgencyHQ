// AgencyHQ web API types and client functions.
// Types mirror the coordinator's ReturnView contract; web never imports coordinator code.

import {
  buildAuthHeaders,
  clearStoredToken,
  getStoredToken,
  handle401,
  type StorageLike,
  setStoredToken,
} from "./auth.js";

export type { StorageLike } from "./auth.js";
export { UnauthorizedError } from "./auth.js";

// ---------------------------------------------------------------------------
// Token store — localStorage-backed, tolerates storage failures gracefully.
// ---------------------------------------------------------------------------

const safeStorage: StorageLike = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore quota / private-browsing errors
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage errors
    }
  },
};

export function getToken(): string | null {
  return getStoredToken(safeStorage);
}

export function setToken(token: string): void {
  setStoredToken(safeStorage, token);
}

export function clearToken(): void {
  clearStoredToken(safeStorage);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface State {
  label: string;
  source: "ledger" | "runtime" | "adapter";
  at: string | null;
  stale?: boolean;
  detail?: string;
}

export interface IntegrationInfo {
  state: "pending" | "integrated" | "failed";
  outcome: string | null;
  targetRef: string | null;
  resultingRevision: string | null;
  at: string | null;
  source: "ledger";
}

export interface ManifestInfo {
  resolved: number;
  total: number;
}

export interface Item {
  workItemId: string;
  intent: string;
  contract: State;
  execution: State;
  verification: State;
  acceptance: State;
  integration: IntegrationInfo | null;
  manifest: ManifestInfo | null;
}

export interface PendingDecision {
  decisionId: string;
  workItemId: string;
  kind: string;
  outcome: string;
  detail: string;
  at: string;
}

export interface Stop {
  attemptId: string;
  state: "stopping" | "stopped" | "uncertain";
  checkpointCommit?: string;
  at: string;
}

export interface Freshness {
  lastPollAt: string | null;
  stale: boolean;
}

export interface ReturnView {
  changedSinceLastVisit: Item[];
  pendingDecisions: PendingDecision[];
  continuing: Item[];
  stops: Stop[];
  mainEffort: string | null;
  freshness: Freshness;
}

export interface RealtimeToken {
  token: string;
  apiUrl: string;
  tag: string;
}

export type CommandKind = "plan" | "ack_visit" | "retry_dispatch";

export interface Command {
  commandId: string;
  kind: CommandKind;
  workItemId?: string;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function fetchReturnView(since: string | null): Promise<ReturnView> {
  const url = since ? `/api/return-view?since=${encodeURIComponent(since)}` : "/api/return-view";
  const res = await fetch(url, { headers: buildAuthHeaders(getToken()) });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchReturnView: ${res.status} ${res.statusText}`);
  return res.json() as Promise<ReturnView>;
}

export async function fetchWorkItem(id: string): Promise<Item> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}`, {
    headers: buildAuthHeaders(getToken()),
  });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchWorkItem: ${res.status} ${res.statusText}`);
  return res.json() as Promise<Item>;
}

export async function fetchRealtimeToken(id: string): Promise<RealtimeToken> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/realtime-token`, {
    headers: buildAuthHeaders(getToken()),
  });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchRealtimeToken: ${res.status} ${res.statusText}`);
  return res.json() as Promise<RealtimeToken>;
}

export async function postCommand(cmd: Omit<Command, "commandId">): Promise<void> {
  const body: Command = { commandId: crypto.randomUUID(), ...cmd };
  const res = await fetch("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(getToken()) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`postCommand: ${res.status} ${res.statusText}`);
}
