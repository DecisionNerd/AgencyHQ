/**
 * Decisions view: every pending_human decision with obstacle, recommendation,
 * impact, no-action consequence, and available actions.
 *
 * R-001: coordinator is sole acceptance authority.
 * DESIGN.md: decisions view fields obstacle/recommendation/impact/no-action consequence.
 *
 * Pure builder — no database access.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

import { openPendingDecisions } from "./pending.ts";

export type DecisionInputLike = {
  id: string;
  workItemId: string | null;
  kind: string;
  outcome: string | null;
  at: string;
  contractVersion?: number | null;
  attemptId?: string | null;
  /** Free-form rationale from the lead proposal, if any. */
  rationale?: string | null;
};

export type AttemptInputLike = {
  id: string;
  contractId: string;
  status: string;
  checkpointCommit?: string | null;
  /** Revision (git SHA) from the artifact row for this attempt, if present. */
  artifactRevision?: string | null;
};

export type ContractInputLike = {
  id: string;
  workItemId: string;
  version: number;
  status: string;
};

export type FindingInputLike = {
  id: string;
  attemptId?: string | null;
  kind: string;
  severity: string;
};

export type DecisionsViewInput = {
  decisions: DecisionInputLike[];
  attempts: AttemptInputLike[];
  contracts: ContractInputLike[];
  findings: FindingInputLike[];
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type DecisionImpact = {
  workItemId: string | null;
  contractVersion: number | null;
  attemptId: string | null;
  /** The step_contract id required by the approve command. */
  contractId: string | null;
  /** The artifact revision (git SHA) required by the approve command. */
  attemptRevision: string | null;
};

export type DecisionEntry = {
  id: string;
  workItemId: string | null;
  /** Obstacle: violation codes (finding kinds) or the decision kind itself. */
  obstacle: string;
  /** Recommendation: the Lead proposal's rationale if present, else null. */
  recommendation: string | null;
  /** Impact: identifies the work item, contract version, and attempt. */
  impact: DecisionImpact;
  /** No-action consequence: what happens if the operator ignores this decision. */
  noActionConsequence: string;
  /** Available operator actions for this decision. */
  actions: string[];
  at: string;
};

export type DecisionsView = {
  decisions: DecisionEntry[];
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the decisions view — only pending_human decisions are included.
 * Pure function — no side effects.
 */
export function buildDecisionsView(input: DecisionsViewInput): DecisionsView {
  const { decisions, attempts, contracts, findings } = input;

  // Index attempts by id
  const attemptById = new Map<string, AttemptInputLike>();
  for (const a of attempts) {
    attemptById.set(a.id, a);
  }

  // Index contracts by id
  const contractById = new Map<string, ContractInputLike>();
  for (const c of contracts) {
    contractById.set(c.id, c);
  }

  // Group findings by attempt id
  const findingsByAttempt = new Map<string, FindingInputLike[]>();
  for (const f of findings) {
    if (f.attemptId) {
      const list = findingsByAttempt.get(f.attemptId) ?? [];
      list.push(f);
      findingsByAttempt.set(f.attemptId, list);
    }
  }

  const pendingDecisions = openPendingDecisions(decisions);

  const entries: DecisionEntry[] = pendingDecisions.map((d) => {
    // Determine obstacle: finding kinds for the associated attempt, or the decision kind
    let obstacle: string;
    const attemptFindings = d.attemptId ? (findingsByAttempt.get(d.attemptId) ?? []) : [];
    if (attemptFindings.length > 0) {
      const uniqueKinds = [...new Set(attemptFindings.map((f) => f.kind))].filter(Boolean);
      obstacle = uniqueKinds.join(", ") || d.kind;
    } else {
      obstacle = d.kind;
    }

    // Determine contract version from the decision or from the attempt's contract
    let contractVersion: number | null = d.contractVersion ?? null;
    if (contractVersion === null && d.attemptId) {
      const attempt = attemptById.get(d.attemptId);
      if (attempt) {
        const contract = contractById.get(attempt.contractId);
        if (contract) {
          contractVersion = contract.version;
        }
      }
    }

    // Available actions
    const actions: string[] = [];
    if (d.kind === "accept") {
      actions.push("approve", "reject");
    } else if (d.kind === "authority_update") {
      actions.push("approve", "reject");
    } else {
      actions.push("reject");
    }

    // Resolve contractId and artifactRevision from the associated attempt
    const attempt = d.attemptId ? attemptById.get(d.attemptId) : undefined;
    const contractId: string | null = attempt?.contractId ?? null;
    const attemptRevision: string | null = attempt?.artifactRevision ?? null;

    return {
      id: d.id,
      workItemId: d.workItemId,
      obstacle,
      recommendation: d.rationale ?? null,
      impact: {
        workItemId: d.workItemId,
        contractVersion,
        attemptId: d.attemptId ?? null,
        contractId,
        attemptRevision,
      },
      noActionConsequence: "stays pending; no dispatch",
      actions,
      at: d.at,
    };
  });

  return { decisions: entries };
}
