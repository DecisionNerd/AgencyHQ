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

/**
 * An open pending decision returned by GET /api/work-items/:id/view.
 * This is the only source of truth for whether Approve/Reject/Invalidate
 * actions are live on the work item page.
 */
export interface OpenPendingDecision {
  id: string;
  kind: string;
  attemptId: string | null;
  contractVersion: number | null;
  at: string;
}

export interface Item {
  workItemId: string;
  intent: string;
  /** Lifecycle phase of the work item (e.g. "proposed", "active", "completed"). */
  lifecycle: string;
  /** Readiness condition of the work item (e.g. "nominal", "blocked"). */
  condition: string;
  contract: State;
  execution: State;
  verification: State;
  acceptance: State;
  integration: IntegrationInfo | null;
  manifest: ManifestInfo | null;
  /**
   * Source of truth for whether Approve/Reject/Invalidate actions are live.
   * When absent (older server), treat as no open decisions.
   */
  openPendingDecisions?: OpenPendingDecision[];
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
// Control-plane types (mirrors coordinator view output types)
// ---------------------------------------------------------------------------

export interface OverviewWorkItemEntry {
  id: string;
  intent: string;
  rank: number;
  mainEffort: boolean;
  lifecycle: string;
  condition: string;
  boundary: "artifact" | "merge" | "deploy";
  campaignId: string | null;
  pendingDecisionCount: number;
  /** Why the item is queued rather than dispatched. Null when not queued or reason unknown. */
  skipReason?: string | null;
}

export interface OverviewProjectEntry {
  id: string;
  activeAttempts: number;
  workItems: OverviewWorkItemEntry[];
}

export interface OverviewCampaignEntry {
  id: string;
  name: string;
  mainEffortWorkItemId: string | null;
}

export interface CapacityProviderEntry {
  provider: string;
  model: string;
  status: "ok" | "limited" | "down";
  effective: "ok" | "limited" | "down" | "unknown";
  concurrency: number | null;
  observedAt: string;
  validUntil: string;
  source: "adapter" | "operator";
  evidence?: string;
}

export interface CapacityView {
  now: string;
  providers: CapacityProviderEntry[];
}

export interface OverviewView {
  campaigns: OverviewCampaignEntry[];
  projects: OverviewProjectEntry[];
  /** Top-level capacity snapshot, identical to GET /api/capacity providers array. */
  capacity: CapacityProviderEntry[];
}

export interface LeadMetricsProjectEntry {
  project_id: string;
  plans_total: number;
  plans_escalated: number;
  escalation_rate: number | null;
  acceptances: number;
  invalidations: number;
  reversal_rate: number | null;
  reviews_total: number;
  reviews_with_findings: number;
  review_yield: number | null;
  findings_by_disposition: Record<string, number>;
  integrations_by_outcome: Record<string, number>;
}

export interface LeadMetricsView {
  since: string | null;
  projects: LeadMetricsProjectEntry[];
}

export interface DecisionImpact {
  workItemId: string | null;
  contractVersion: number | null;
  attemptId: string | null;
  /** The step_contract id required by the approve command. */
  contractId: string | null;
  /** The artifact revision (git SHA) required by the approve command. */
  attemptRevision: string | null;
}

export interface DecisionEntry {
  id: string;
  workItemId: string | null;
  obstacle: string;
  recommendation: string | null;
  impact: DecisionImpact;
  noActionConsequence: string;
  actions: string[];
  at: string;
}

export interface DecisionsView {
  decisions: DecisionEntry[];
}

export interface EvidenceAttempt {
  id: string;
  contractId: string;
  status: string;
  runId?: string | null;
  checkpointCommit?: string | null;
  commitSha?: string | null;
  updatedAt: string;
}

export interface EvidenceArtifact {
  id: string;
  attemptId: string;
  revision: string;
  diffDigest: string;
  changedPaths?: unknown;
  updatedAt: string;
}

export interface EvidenceVerificationResult {
  id: string;
  attemptId: string;
  stepContractId: string;
  result: string;
  updatedAt: string;
}

export interface EvidenceReview {
  id: string;
  attemptId: string;
  attemptRevision?: string | null;
  diffDigest?: string | null;
  updatedAt: string;
}

export interface EvidenceFinding {
  id: string;
  attemptId?: string | null;
  severity: string;
  kind: string;
  description?: string;
  evidence?: string | null;
  disposition?: string | null;
  updatedAt: string;
}

export interface EvidenceDecision {
  id: string;
  kind: string;
  actor: string;
  outcome: string | null;
  contractVersion?: number | null;
  attemptId?: string | null;
  at: string;
}

export interface EvidenceApproval {
  id: string;
  decisionId: string;
  contractId?: string | null;
  contractVersion?: number | null;
  attemptRevision?: string | null;
  humanActor?: string | null;
  at?: string | null;
}

export interface EvidenceIntegration {
  id: string;
  attemptId: string;
  targetRef: string;
  outcome?: string | null;
  resultingRevision?: string | null;
  at: string;
}

export interface EvidenceManifestRow {
  workItemId: string;
  position: number;
  resultRevision?: string | null;
}

export interface EvidenceView {
  workItemId: string;
  attempts: EvidenceAttempt[];
  artifacts: EvidenceArtifact[];
  verificationResults: EvidenceVerificationResult[];
  reviews: EvidenceReview[];
  findings: EvidenceFinding[];
  decisions: EvidenceDecision[];
  approvals: EvidenceApproval[];
  integrations: EvidenceIntegration[];
  manifestRows: EvidenceManifestRow[];
}

export interface AuthorityVersionEntry {
  version: string;
  authority: Record<string, unknown>;
  actor: string;
  at: string;
}

export interface AuthorityView {
  projectId: string;
  currentVersion: string;
  authority: Record<string, unknown>;
  history: AuthorityVersionEntry[];
}

export interface CommandResult {
  commandId: string;
  replayed: boolean;
  result?: unknown;
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
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/view`, {
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

export async function fetchOverview(): Promise<OverviewView> {
  const res = await fetch("/api/overview", { headers: buildAuthHeaders(getToken()) });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchOverview: ${res.status} ${res.statusText}`);
  return res.json() as Promise<OverviewView>;
}

export async function fetchDecisions(): Promise<DecisionsView> {
  const res = await fetch("/api/decisions", { headers: buildAuthHeaders(getToken()) });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchDecisions: ${res.status} ${res.statusText}`);
  return res.json() as Promise<DecisionsView>;
}

export async function fetchEvidence(workItemId: string): Promise<EvidenceView> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(workItemId)}/evidence`, {
    headers: buildAuthHeaders(getToken()),
  });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchEvidence: ${res.status} ${res.statusText}`);
  return res.json() as Promise<EvidenceView>;
}

export async function fetchAuthority(projectId: string): Promise<AuthorityView> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/authority`, {
    headers: buildAuthHeaders(getToken()),
  });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`fetchAuthority: ${res.status} ${res.statusText}`);
  return res.json() as Promise<AuthorityView>;
}

export type PutAuthorityResult =
  | { commandId: string; result: { ok: true; version: number } }
  | { commandId: string; result: { ok: false; reason: string; currentVersion: number } }
  | { commandId: string; errors: Array<{ message: string; path?: string[] }> };

export async function putAuthority(
  projectId: string,
  body: { authority: Record<string, unknown>; expectedVersion: number },
): Promise<PutAuthorityResult> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/authority`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(getToken()) },
    body: JSON.stringify({ commandId: crypto.randomUUID(), actor: "operator", ...body }),
  });
  if (res.status === 401) throw handle401(safeStorage);
  // 422 carries schema errors inline — return them rather than throwing
  if (res.status === 422) {
    return res.json() as Promise<{
      commandId: string;
      errors: Array<{ message: string; path?: string[] }>;
    }>;
  }
  // 409 carries version conflict details inline — return them rather than throwing
  if (res.status === 409) {
    return res.json() as Promise<{
      commandId: string;
      result: { ok: false; reason: string; currentVersion: number };
    }>;
  }
  if (!res.ok) throw new Error(`putAuthority: ${res.status} ${res.statusText}`);
  return res.json() as Promise<{ commandId: string; result: { ok: true; version: number } }>;
}

/**
 * Post an arbitrary command body. Adds a fresh commandId and auth header.
 * Returns the parsed result including `replayed`.
 */
export async function postCommand(body: Record<string, unknown>): Promise<CommandResult> {
  const fullBody = { commandId: crypto.randomUUID(), ...body };
  const res = await fetch("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(getToken()) },
    body: JSON.stringify(fullBody),
  });
  if (res.status === 401) throw handle401(safeStorage);
  if (!res.ok) throw new Error(`postCommand: ${res.status} ${res.statusText}`);
  return res.json() as Promise<CommandResult>;
}

/**
 * Fetch lead quality metrics. Returns null when the route is not yet available (404).
 * The `since` parameter is an ISO timestamp or null (all time).
 */
export async function fetchLeadMetrics(since: string | null): Promise<LeadMetricsView | null> {
  const url = since ? `/api/metrics/lead?since=${encodeURIComponent(since)}` : "/api/metrics/lead";
  const res = await fetch(url, { headers: buildAuthHeaders(getToken()) });
  if (res.status === 401) throw handle401(safeStorage);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchLeadMetrics: ${res.status} ${res.statusText}`);
  return res.json() as Promise<LeadMetricsView>;
}

/**
 * Fetch provider capacity observations. Returns null when the route is not yet available (404).
 */
export async function fetchCapacity(): Promise<CapacityView | null> {
  const res = await fetch("/api/capacity", { headers: buildAuthHeaders(getToken()) });
  if (res.status === 401) throw handle401(safeStorage);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchCapacity: ${res.status} ${res.statusText}`);
  return res.json() as Promise<CapacityView>;
}
