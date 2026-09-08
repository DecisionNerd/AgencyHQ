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
  | { page: "not-found" };

/**
 * Parse a window.location.hash value (including the leading "#") into a Route.
 * Handles:
 *   #/          → overview
 *   #/return    → return
 *   #/work-items/:id → work-item
 *   #/decisions → decisions
 *   #/projects/:id/authority → authority
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
