/**
 * Return-view: pure view model for the operator return-after-interruption journey.
 *
 * R-011: contract, execution, verification, and acceptance states shown distinctly
 *        with source and timestamp.
 * R-019: changes, pending decisions, continuing runs, freshness, stop status.
 *
 * No database access. No side effects. Fully testable with plain objects.
 */

// ---------------------------------------------------------------------------
// Input snapshot shapes (minimal fields; named to match domain aggregates)
// ---------------------------------------------------------------------------

export type WorkItemLike = {
  id: string;
  intent: string;
  rank: number;
  mainEffort: boolean;
  lifecycle: string;
  condition: string;
  updatedAt: string; // ISO-8601
  /** Completion boundary. Defaults to "artifact" when omitted. */
  boundary?: "artifact" | "merge" | "deploy";
};

export type ContractLike = {
  id: string;
  workItemId: string;
  version: number;
  status: string; // "active" | "superseded" | ...
  updatedAt: string; // ISO-8601
};

export type AttemptLike = {
  id: string;
  contractId: string;
  status: string; // AttemptStatus
  checkpointCommit?: string | null;
  updatedAt: string; // ISO-8601
};

export type DecisionLike = {
  id: string;
  workItemId: string;
  kind: string; // DecisionKind
  outcome: string; // DecisionOutcome
  at: string; // ISO-8601
  detail?: string; // free-form detail for pending decisions
};

export type ResultLike = {
  id: string;
  attemptId: string;
  result: string; // "pass" | "fail" | ...
  updatedAt: string; // ISO-8601
};

export type ReviewLike = {
  id: string;
  attemptId: string;
  updatedAt: string; // ISO-8601
};

export type FindingLike = {
  id: string;
  attemptId?: string | null;
  severity: string;
  kind: string;
  evidence?: string | null;
};

/**
 * Integration event for a work item with boundary=merge.
 * Mirrors the integrations table columns relevant to the view.
 */
export type IntegrationLike = {
  id: string;
  attemptId: string;
  targetRef: string;
  outcome: string | null;
  resultingRevision: string | null;
  at: string; // ISO-8601
};

/**
 * A single project entry in the work item's manifest.
 * Mirrors the work_item_projects table.
 */
export type WorkItemProjectLike = {
  workItemId: string;
  position: number;
  resultRevision: string | null;
};

// ---------------------------------------------------------------------------
// ReturnView output types
// ---------------------------------------------------------------------------

export type StateSource = "ledger" | "runtime" | "adapter";

export type State = {
  label: string;
  source: StateSource;
  at: string | null;
  stale?: boolean;
  detail?: string;
};

/**
 * Integration state for a work item with boundary=merge.
 * - pending: integrations row without outcome, or no row yet after acceptance
 * - integrated: outcome = "integrated" | "already_integrated"
 * - failed: outcome = "base_moved" | "conflict" | "push_rejected"
 */
export type IntegrationView = {
  state: "pending" | "integrated" | "failed";
  outcome: string | null;
  targetRef: string | null;
  resultingRevision: string | null;
  at: string | null; // integrations.at ISO
  source: "ledger";
};

/** Manifest progress for a work item's project set. */
export type ManifestView = {
  resolved: number;
  total: number;
};

export type Item = {
  workItemId: string;
  intent: string;
  contract: State;
  execution: State;
  verification: State;
  acceptance: State;
  /** Present when boundary=merge; null when boundary=artifact. */
  integration: IntegrationView | null;
  /** Present when boundary=merge and rows exist; null otherwise. */
  manifest: ManifestView | null;
};

export type StopEntry = {
  attemptId: string;
  state: "stopping" | "stopped" | "uncertain";
  checkpointCommit?: string;
  at: string;
};

export type PendingDecision = {
  decisionId: string;
  workItemId: string;
  kind: string;
  outcome: string;
  detail?: string;
  at: string;
};

export type FreshnessView = {
  lastPollAt: string | null;
  stale: boolean;
};

export type ReturnView = {
  changedSinceLastVisit: Item[];
  pendingDecisions: PendingDecision[];
  continuing: Item[];
  stops: StopEntry[];
  mainEffort: string | null;
  freshness: FreshnessView;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type ReturnViewInput = {
  now: string;
  lastAckAt: string | null;
  freshness: { lastPollAt: string | null };
  freshnessStaleMs: number;
  workItems: WorkItemLike[];
  contracts: ContractLike[];
  attempts: AttemptLike[];
  decisions: DecisionLike[];
  results: ResultLike[];
  reviews: ReviewLike[];
  findings: FindingLike[];
  /** Integration events for work items with boundary=merge. Omit or leave empty when not needed. */
  integrations?: IntegrationLike[];
  /** Project manifest rows for work items with boundary=merge. Omit or leave empty when not needed. */
  workItemProjects?: WorkItemProjectLike[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the latest ISO timestamp from a list, or null. */
function latest(timestamps: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const ts of timestamps) {
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

/** ISO timestamp comparison: a > b (both non-null). */
function after(a: string, b: string): boolean {
  return a > b;
}

// Stop statuses that map to a stop entry
const STOP_STATUSES = new Set(["stopping", "stopped", "uncertain"]);

// Integration outcomes that map to each state
const INTEGRATED_OUTCOMES = new Set(["integrated", "already_integrated"]);
const FAILED_OUTCOMES = new Set(["base_moved", "conflict", "push_rejected"]);

// ---------------------------------------------------------------------------
// buildReturnView
// ---------------------------------------------------------------------------

export function buildReturnView(input: ReturnViewInput): ReturnView {
  const {
    now,
    lastAckAt,
    freshness,
    freshnessStaleMs,
    workItems,
    contracts,
    attempts,
    decisions,
    results,
    reviews,
    findings,
    integrations = [],
    workItemProjects = [],
  } = input;

  // Derive freshness stale flag
  const isStale = (() => {
    if (freshness.lastPollAt === null) return true;
    const elapsed = new Date(now).getTime() - new Date(freshness.lastPollAt).getTime();
    return elapsed > freshnessStaleMs;
  })();

  const freshnessView: FreshnessView = {
    lastPollAt: freshness.lastPollAt,
    stale: isStale,
  };

  // Index contracts by workItemId → latest version contract
  const contractByWorkItem = new Map<string, ContractLike>();
  for (const c of contracts) {
    const existing = contractByWorkItem.get(c.workItemId);
    if (!existing || c.version > existing.version) {
      contractByWorkItem.set(c.workItemId, c);
    }
  }

  // Index attempts by contractId → all attempts
  const attemptsByContract = new Map<string, AttemptLike[]>();
  for (const a of attempts) {
    const arr = attemptsByContract.get(a.contractId) ?? [];
    arr.push(a);
    attemptsByContract.set(a.contractId, arr);
  }

  // Index results by attemptId → latest
  const resultByAttempt = new Map<string, ResultLike>();
  for (const r of results) {
    const existing = resultByAttempt.get(r.attemptId);
    if (!existing || r.updatedAt > existing.updatedAt) {
      resultByAttempt.set(r.attemptId, r);
    }
  }

  // Index reviews by attemptId → latest
  const reviewByAttempt = new Map<string, ReviewLike>();
  for (const r of reviews) {
    const existing = reviewByAttempt.get(r.attemptId);
    if (!existing || r.updatedAt > existing.updatedAt) {
      reviewByAttempt.set(r.attemptId, r);
    }
  }

  // Decisions by workItemId
  const decisionsByWorkItem = new Map<string, DecisionLike[]>();
  for (const d of decisions) {
    const arr = decisionsByWorkItem.get(d.workItemId) ?? [];
    arr.push(d);
    decisionsByWorkItem.set(d.workItemId, arr);
  }

  // Index integrations by attemptId → most recent integration
  const integrationByAttempt = new Map<string, IntegrationLike>();
  for (const integ of integrations) {
    const existing = integrationByAttempt.get(integ.attemptId);
    if (!existing || integ.at > existing.at) {
      integrationByAttempt.set(integ.attemptId, integ);
    }
  }

  // Index work item projects by workItemId
  const workItemProjectsByWorkItem = new Map<string, WorkItemProjectLike[]>();
  for (const wip of workItemProjects) {
    const arr = workItemProjectsByWorkItem.get(wip.workItemId) ?? [];
    arr.push(wip);
    workItemProjectsByWorkItem.set(wip.workItemId, arr);
  }

  // Build attemptId → workItemId map (for finding → work item resolution)
  const workItemIdByAttempt = new Map<string, string>();
  for (const [workItemId, contract] of contractByWorkItem) {
    for (const a of attemptsByContract.get(contract.id) ?? []) {
      workItemIdByAttempt.set(a.id, workItemId);
    }
  }

  // Index integration_conflict findings by workItemId → most recent finding
  const integConflictFindingByWorkItem = new Map<string, FindingLike>();
  for (const f of findings) {
    if (f.kind === "integration_conflict" && f.attemptId) {
      const workItemId = workItemIdByAttempt.get(f.attemptId);
      if (workItemId) {
        const existing = integConflictFindingByWorkItem.get(workItemId);
        // Keep the most recent by updated_at (use id as tiebreak); findings lack a timestamp
        // so we just keep the last one encountered per work item
        if (!existing) {
          integConflictFindingByWorkItem.set(workItemId, f);
        }
      }
    }
  }

  // Collect pending decisions (outcome = "pending_human"), enriched with
  // integration_conflict finding evidence when no explicit detail is set.
  const pendingDecisions: PendingDecision[] = [];
  for (const d of decisions) {
    if (d.outcome === "pending_human") {
      const pd: PendingDecision = {
        decisionId: d.id,
        workItemId: d.workItemId,
        kind: d.kind,
        outcome: d.outcome,
        at: d.at,
      };
      if (d.detail !== undefined) {
        pd.detail = d.detail;
      } else {
        // Enrich with integration_conflict finding evidence if available
        const conflictFinding = integConflictFindingByWorkItem.get(d.workItemId);
        if (conflictFinding?.evidence) {
          pd.detail = conflictFinding.evidence;
        }
      }
      pendingDecisions.push(pd);
    }
  }
  // Sort by at ascending
  pendingDecisions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // Collect stop entries
  const stops: StopEntry[] = [];
  for (const a of attempts) {
    if (STOP_STATUSES.has(a.status)) {
      const entry: StopEntry = {
        attemptId: a.id,
        state: a.status as "stopping" | "stopped" | "uncertain",
        at: a.updatedAt,
      };
      if (a.checkpointCommit) {
        entry.checkpointCommit = a.checkpointCommit;
      }
      stops.push(entry);
    }
  }

  // Determine mainEffort
  const mainEffortItem = workItems.find((w) => w.mainEffort);
  const mainEffort = mainEffortItem?.id ?? null;

  // Build items for each work item, ordered by rank
  const sortedWorkItems = [...workItems].sort((a, b) => a.rank - b.rank);

  const changedSinceLastVisit: Item[] = [];
  const continuing: Item[] = [];

  for (const wi of sortedWorkItems) {
    const contract = contractByWorkItem.get(wi.id);
    const contractAttempts = contract ? (attemptsByContract.get(contract.id) ?? []) : [];

    // Latest attempt for this work item
    const latestAttempt = contractAttempts.reduce<AttemptLike | null>((best, a) => {
      if (!best) return a;
      return a.updatedAt > best.updatedAt ? a : best;
    }, null);

    // Contract state
    const contractState: State = {
      label: contract ? `v${contract.version} ${contract.status}` : "none",
      source: "ledger",
      at: contract?.updatedAt ?? null,
    };

    // Execution state — derives from attempt status; stale flag propagated for live statuses
    let executionState: State;
    if (!latestAttempt) {
      executionState = {
        label: "no attempt",
        source: "ledger",
        at: null,
        stale: isStale,
      };
    } else {
      const status = latestAttempt.status;
      // The execution state source is "runtime" for live statuses
      const isLive = status === "running" || status === "stopping" || status === "uncertain";
      if (isLive) {
        executionState = {
          label: status,
          source: "runtime",
          at: latestAttempt.updatedAt,
          stale: isStale,
        };
      } else {
        executionState = {
          label: status,
          source: "ledger",
          at: latestAttempt.updatedAt,
        };
      }
    }

    // Verification state
    const latestResult = latestAttempt ? resultByAttempt.get(latestAttempt.id) : undefined;
    const verificationState: State = {
      label: latestResult ? latestResult.result : "none",
      source: "ledger",
      at: latestResult?.updatedAt ?? null,
    };

    // Acceptance state — look for accept/reject decisions on this work item
    const wiDecisions = decisionsByWorkItem.get(wi.id) ?? [];
    const acceptDecisions = wiDecisions.filter((d) => d.kind === "accept" || d.kind === "reject");
    const latestAccept =
      acceptDecisions.length > 0
        ? acceptDecisions.reduce((best, d) => (d.at > best.at ? d : best))
        : null;

    let acceptanceState: State;
    if (latestAccept) {
      acceptanceState = {
        label: `${latestAccept.kind} (${latestAccept.outcome})`,
        source: "ledger",
        at: latestAccept.at,
      };
    } else {
      // Check if review present
      const latestReview = latestAttempt ? reviewByAttempt.get(latestAttempt.id) : undefined;
      if (latestReview) {
        acceptanceState = {
          label: "reviewed",
          source: "ledger",
          at: latestReview.updatedAt,
        };
      } else {
        acceptanceState = {
          label: "none",
          source: "ledger",
          at: null,
        };
      }
    }

    // Integration view (boundary=merge only)
    let integrationView: IntegrationView | null = null;
    let manifestView: ManifestView | null = null;

    if (wi.boundary === "merge") {
      // Find the most recent integration row across all attempts for this work item
      let latestInteg: IntegrationLike | null = null;
      for (const a of contractAttempts) {
        const integ = integrationByAttempt.get(a.id);
        if (integ) {
          if (!latestInteg || integ.at > latestInteg.at) {
            latestInteg = integ;
          }
        }
      }

      if (latestInteg) {
        let state: "pending" | "integrated" | "failed";
        if (latestInteg.outcome === null) {
          state = "pending";
        } else if (INTEGRATED_OUTCOMES.has(latestInteg.outcome)) {
          state = "integrated";
        } else if (FAILED_OUTCOMES.has(latestInteg.outcome)) {
          state = "failed";
        } else {
          state = "pending";
        }

        integrationView = {
          state,
          outcome: latestInteg.outcome,
          targetRef: latestInteg.targetRef,
          resultingRevision: latestInteg.resultingRevision,
          at: latestInteg.at,
          source: "ledger",
        };
      } else {
        // No integration row yet: pending
        integrationView = {
          state: "pending",
          outcome: null,
          targetRef: null,
          resultingRevision: null,
          at: null,
          source: "ledger",
        };
      }

      // Manifest: work_item_projects rows
      const wips = workItemProjectsByWorkItem.get(wi.id) ?? [];
      if (wips.length > 0) {
        const resolved = wips.filter((p) => p.resultRevision !== null).length;
        manifestView = { resolved, total: wips.length };
      }
    }

    const item: Item = {
      workItemId: wi.id,
      intent: wi.intent,
      contract: contractState,
      execution: executionState,
      verification: verificationState,
      acceptance: acceptanceState,
      integration: integrationView,
      manifest: manifestView,
    };

    // Determine newest timestamp across this work item's data
    const allTimestamps: Array<string | null | undefined> = [
      wi.updatedAt,
      contract?.updatedAt,
      latestAttempt?.updatedAt,
      latestResult?.updatedAt,
      latestAccept?.at,
      ...wiDecisions.map((d) => d.at),
    ];
    const latestReviewForTs = latestAttempt ? reviewByAttempt.get(latestAttempt.id) : undefined;
    allTimestamps.push(latestReviewForTs?.updatedAt);

    // Include integration.at in changed timestamp calculation
    if (integrationView?.at) {
      allTimestamps.push(integrationView.at);
    }

    const newestAt = latest(allTimestamps);

    // changedSinceLastVisit: newest > lastAckAt (or lastAckAt is null)
    const hasChanged = newestAt !== null && (lastAckAt === null || after(newestAt, lastAckAt));

    // continuing: has an active/running/dispatched/stopping attempt
    const activeStatuses = new Set(["admitted", "dispatched", "running", "stopping", "uncertain"]);
    const isContinuing = latestAttempt !== null && activeStatuses.has(latestAttempt.status);

    if (hasChanged) {
      changedSinceLastVisit.push(item);
    }
    if (isContinuing) {
      continuing.push(item);
    }
  }

  return {
    changedSinceLastVisit,
    pendingDecisions,
    continuing,
    stops,
    mainEffort,
    freshness: freshnessView,
  };
}
