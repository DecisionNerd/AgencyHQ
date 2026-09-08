// Pure control-plane helpers — no DOM, no React. Fully unit-testable with node:test.
// Used by the hash-routed control plane views in App.tsx.

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

export type Route =
  | { page: "overview" }
  | { page: "return" }
  | { page: "work-item"; id: string }
  | { page: "decisions" }
  | { page: "authority"; projectId: string }
  | { page: "metrics" }
  | { page: "not-found" };

/**
 * Parse a window.location.hash value (including the leading "#") into a Route.
 * Handles:
 *   #/          → overview
 *   #/return    → return
 *   #/work-items/:id → work-item
 *   #/decisions → decisions
 *   #/projects/:id/authority → authority
 *   #/metrics   → metrics
 *   anything else → not-found
 */
export function parseRoute(hash: string): Route {
  // Strip the leading "#" to get the path
  const path = hash.startsWith("#") ? hash.slice(1) : hash;

  if (path === "/" || path === "" || path === "#/") {
    return { page: "overview" };
  }

  if (path === "/return") {
    return { page: "return" };
  }

  if (path === "/decisions") {
    return { page: "decisions" };
  }

  if (path === "/metrics") {
    return { page: "metrics" };
  }

  const workItemMatch = /^\/work-items\/([^/]+)$/.exec(path);
  if (workItemMatch?.[1]) {
    return { page: "work-item", id: decodeURIComponent(workItemMatch[1]) };
  }

  const authorityMatch = /^\/projects\/([^/]+)\/authority$/.exec(path);
  if (authorityMatch?.[1]) {
    return { page: "authority", projectId: decodeURIComponent(authorityMatch[1]) };
  }

  return { page: "not-found" };
}

// ---------------------------------------------------------------------------
// Timestamp formatting — same style as existing state cards
// ---------------------------------------------------------------------------

/** Format an ISO timestamp to locale string, or "no timestamp" when null. */
export function formatTimestamp(at: string | null | undefined): string {
  if (!at) return "no timestamp";
  return new Date(at).toLocaleString();
}

// ---------------------------------------------------------------------------
// Lifecycle and condition icons
// ---------------------------------------------------------------------------

const LIFECYCLE_ICONS: Record<string, string> = {
  // Known lifecycle values
  pending: "⏸",
  planning: "📋",
  planned: "📋",
  dispatching: "📤",
  dispatched: "📤",
  running: "▶",
  paused: "⏸",
  stopping: "⏳",
  stopped: "⏹",
  accepting: "✓",
  accepted: "✓",
  integrating: "🔗",
  integrated: "🔗",
  done: "✅",
  failed: "✗",
  cancelled: "✗",
};

const CONDITION_ICONS: Record<string, string> = {
  nominal: "✓",
  blocked: "✗",
  uncertain: "?",
  degraded: "⚠",
  warning: "⚠",
  ok: "✓",
};

/** Return a text icon for a lifecycle value. Falls back to "○". */
export function lifecycleIcon(lifecycle: string): string {
  return LIFECYCLE_ICONS[lifecycle.toLowerCase()] ?? "○";
}

/** Return a text icon for a condition value. Falls back to "○". */
export function conditionIcon(condition: string): string {
  return CONDITION_ICONS[condition.toLowerCase()] ?? "○";
}

// ---------------------------------------------------------------------------
// Overview row model
// ---------------------------------------------------------------------------

export interface OverviewWorkItemRowInput {
  id: string;
  intent: string;
  rank: number;
  mainEffort: boolean;
  lifecycle: string;
  condition: string;
  boundary: "artifact" | "merge" | "deploy";
  campaignId: string | null;
  pendingDecisionCount: number;
}

export interface OverviewWorkItemRow {
  id: string;
  intent: string;
  rank: number;
  mainEffort: boolean;
  lifecycle: string;
  lifecycleIcon: string;
  condition: string;
  conditionIcon: string;
  boundary: "artifact" | "merge" | "deploy";
  campaignId: string | null;
  pendingDecisionCount: number;
}

/** Build the display row model for an overview work item entry. */
export function buildOverviewWorkItemRow(entry: OverviewWorkItemRowInput): OverviewWorkItemRow {
  return {
    id: entry.id,
    intent: entry.intent,
    rank: entry.rank,
    mainEffort: entry.mainEffort,
    lifecycle: entry.lifecycle,
    lifecycleIcon: lifecycleIcon(entry.lifecycle),
    condition: entry.condition,
    conditionIcon: conditionIcon(entry.condition),
    boundary: entry.boundary,
    campaignId: entry.campaignId,
    pendingDecisionCount: entry.pendingDecisionCount,
  };
}

// ---------------------------------------------------------------------------
// Decision row model
// ---------------------------------------------------------------------------

export interface DecisionRowInput {
  id: string;
  workItemId: string | null;
  obstacle: string;
  recommendation: string | null;
  impact: {
    workItemId: string | null;
    contractVersion: number | null;
    attemptId: string | null;
    contractId: string | null;
    attemptRevision: string | null;
  };
  noActionConsequence: string;
  actions: string[];
  at: string;
}

export interface DecisionRow {
  id: string;
  workItemId: string | null;
  obstacle: string;
  recommendation: string | null;
  impact: {
    workItemId: string | null;
    contractVersion: number | null;
    attemptId: string | null;
    contractId: string | null;
    attemptRevision: string | null;
  };
  noActionConsequence: string;
  actions: string[];
  at: string;
  formattedAt: string;
}

/** Build a display row model for a pending decision entry. */
export function buildDecisionRow(entry: DecisionRowInput): DecisionRow {
  return {
    id: entry.id,
    workItemId: entry.workItemId,
    obstacle: entry.obstacle,
    recommendation: entry.recommendation,
    impact: entry.impact,
    noActionConsequence: entry.noActionConsequence,
    actions: entry.actions,
    at: entry.at,
    formattedAt: formatTimestamp(entry.at),
  };
}

// ---------------------------------------------------------------------------
// Action body builders — field names must match app.ts exactly
// ---------------------------------------------------------------------------

export interface ApproveParams {
  commandId: string;
  workItemId: string;
  contractId: string;
  contractVersion: number;
  attemptRevision: string;
}

/** Build the POST /api/commands body for an approve command. */
export function buildApproveBody(params: ApproveParams): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "approve",
    workItemId: params.workItemId,
    contractId: params.contractId,
    contractVersion: params.contractVersion,
    attemptRevision: params.attemptRevision,
    actor: "human",
  };
}

export interface RejectParams {
  commandId: string;
  workItemId: string;
  decisionId: string;
  reason: string;
}

/** Build the POST /api/commands body for a reject command. */
export function buildRejectBody(params: RejectParams): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "reject",
    workItemId: params.workItemId,
    decisionId: params.decisionId,
    reason: params.reason,
  };
}

export interface StopParams {
  commandId: string;
  attemptId: string;
}

/** Build the POST /api/commands body for a stop command. */
export function buildStopBody(params: StopParams): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "stop",
    attemptId: params.attemptId,
    actor: "human",
    reason: "operator requested",
  };
}

export interface PauseParams {
  commandId: string;
  workItemId: string;
  reason: string;
}

/** Build the POST /api/commands body for a pause command. */
export function buildPauseBody(params: PauseParams): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "pause",
    workItemId: params.workItemId,
    reason: params.reason,
  };
}

export interface ResumeParams {
  commandId: string;
  workItemId: string;
  reason: string;
}

/** Build the POST /api/commands body for a resume command. */
export function buildResumeBody(params: ResumeParams): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "resume",
    workItemId: params.workItemId,
    reason: params.reason,
  };
}

export interface DispositionRemediateParams {
  commandId: string;
  findingId: string;
}

/**
 * Build the POST /api/commands body for a disposition command with
 * disposition=remediate. This triggers a new attempt via the finding.
 */
export function buildDispositionRemediateBody(
  params: DispositionRemediateParams,
): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "disposition",
    findingId: params.findingId,
    disposition: "remediate",
    actor: "human",
    reason: "",
  };
}

export interface InvalidateAcceptanceParams {
  commandId: string;
  workItemId: string;
  attemptId: string;
  reason: string;
}

/** Build the POST /api/commands body for an invalidate_acceptance command. */
export function buildInvalidateAcceptanceBody(
  params: InvalidateAcceptanceParams,
): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "invalidate_acceptance",
    workItemId: params.workItemId,
    attemptId: params.attemptId,
    reason: params.reason,
  };
}

// ---------------------------------------------------------------------------
// Confirmation message builder
// ---------------------------------------------------------------------------

export interface ConfirmMessageParams {
  /** The action name, e.g. "approve", "reject", "stop". Capitalised automatically. */
  action: string;
  /** The project id owning the work item. */
  projectId: string;
  /** The work item id being acted upon. */
  workItemId: string;
  /** The contract version, if available. Rendered as "contract v<n>". */
  contractVersion?: number | null | undefined;
}

/**
 * Build the text shown in the ConfirmDialog for every destructive action.
 * The returned string always names the action, the project and the work item;
 * and appends the contract version when provided.
 *
 * Unit-tested in control-plane-helpers.test.ts.
 */
export function confirmMessage(params: ConfirmMessageParams): string {
  const { action, projectId, workItemId, contractVersion } = params;
  const head = `${action.charAt(0).toUpperCase()}${action.slice(1)} work item ${workItemId} · project ${projectId}`;
  const versionSuffix = contractVersion != null ? ` · contract v${contractVersion}` : "";
  return `${head}${versionSuffix}?`;
}

// ---------------------------------------------------------------------------
// Authority error formatting
// ---------------------------------------------------------------------------

export interface AuthoritySchemaError {
  message: string;
  path?: string[];
}

/**
 * Format an array of authority schema errors (from a 422 PUT response)
 * into a human-readable string.
 */
export function formatAuthorityErrors(errors: AuthoritySchemaError[]): string {
  if (errors.length === 0) return "";
  return errors
    .map((e) => {
      if (e.path && e.path.length > 0) {
        return `${e.path.join(".")}: ${e.message}`;
      }
      return e.message;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Lead metrics helpers
// ---------------------------------------------------------------------------

/**
 * Format a rate (0.0–1.0) as a percentage string, e.g. "75.0%".
 * Returns "not available" when rate is null.
 */
export function formatPercentage(rate: number | null): string {
  if (rate === null) return "not available";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Build a title attribute string showing numerator/denominator.
 * e.g. "3/4 = 75.0%"
 */
export function formatRateTitle(
  numerator: number,
  denominator: number,
  rate: number | null,
): string {
  if (rate === null) return `${numerator}/${denominator}`;
  return `${numerator}/${denominator} = ${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Since-window helpers
// ---------------------------------------------------------------------------

export type SinceWindow = "7d" | "30d" | "all";

/**
 * Convert a since-window label to an ISO 8601 timestamp, or null for "all time".
 * The optional `now` parameter allows deterministic testing.
 */
export function sinceWindowToISO(window: SinceWindow, now?: Date): string | null {
  if (window === "all") return null;
  const base = now ? new Date(now) : new Date();
  const days = window === "7d" ? 7 : 30;
  base.setDate(base.getDate() - days);
  return base.toISOString();
}

// ---------------------------------------------------------------------------
// Capacity row model
// ---------------------------------------------------------------------------

import type { CapacityProviderEntry } from "./api.js";

export interface CapacityRowModel {
  provider: string;
  model: string;
  status: "ok" | "limited" | "down";
  effective: "ok" | "limited" | "down" | "unknown";
  concurrency: number | null;
  source: "adapter" | "operator";
  evidence?: string;
  observedAt: string;
  validUntil: string;
  isStale: boolean;
  /** Human-readable validity: "valid until …" or "stale since …". */
  validityLabel: string;
}

/** Status icon + text label — text and icon, never color alone. */
export function capacityStatusLabel(status: "ok" | "limited" | "down" | "unknown"): {
  icon: string;
  text: string;
} {
  switch (status) {
    case "ok":
      return { icon: "✓", text: "ok" };
    case "limited":
      return { icon: "⚠", text: "limited" };
    case "down":
      return { icon: "✗", text: "down" };
    default:
      return { icon: "?", text: "unknown" };
  }
}

/**
 * Build a display row model for a capacity provider entry.
 * Computes whether the observation is stale (validUntil < now).
 * The optional `now` parameter allows deterministic testing.
 */
export function buildCapacityRow(entry: CapacityProviderEntry, now?: Date): CapacityRowModel {
  const d = now ?? new Date();
  const until = new Date(entry.validUntil);
  const stale = until < d;
  const row: CapacityRowModel = {
    provider: entry.provider,
    model: entry.model,
    status: entry.status,
    effective: entry.effective,
    concurrency: entry.concurrency,
    source: entry.source,
    observedAt: entry.observedAt,
    validUntil: entry.validUntil,
    isStale: stale,
    validityLabel: stale
      ? `stale since ${formatTimestamp(entry.validUntil)}`
      : `valid until ${formatTimestamp(entry.validUntil)}`,
  };
  if (entry.evidence !== undefined) {
    row.evidence = entry.evidence;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Set-capacity command body builder
// ---------------------------------------------------------------------------

export interface SetCapacityParams {
  commandId: string;
  provider: string;
  model: string;
  status: "ok" | "limited" | "down";
  validUntil: string;
}

/** Build the POST /api/commands body for a set_capacity command. */
export function buildSetCapacityBody(params: SetCapacityParams): Record<string, unknown> {
  return {
    commandId: params.commandId,
    kind: "set_capacity",
    provider: params.provider,
    model: params.model,
    status: params.status,
    validUntil: params.validUntil,
  };
}
