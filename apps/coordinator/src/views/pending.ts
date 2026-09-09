/**
 * A pending_human decision stays in the ledger as history after an operator
 * approves or rejects it (the approve command appends an `approved` decision
 * for the same attempt; reject appends `rejected`). The views must show only
 * the decisions that are still open. Observed 2026-09-08 in the browser
 * journey: after approving, the decisions page kept listing the resolved row.
 *
 * U-4: two resolution modes:
 *  - Attempt-scoped rows (attemptId non-null): resolved when a later decision
 *    with a RESOLVING_OUTCOME exists for the SAME attemptId and kind.
 *  - No-attempt rows (attemptId null): resolved when a later decision with a
 *    RESOLVING_OUTCOME exists with the same workItemId, kind, and
 *    contractVersion (nulls equal). This covers plan/review decisions that
 *    bounded-repair writes without an attempt.
 */
export type PendingLike = {
  id: string;
  workItemId: string | null;
  kind?: string | null;
  outcome: string | null;
  attemptId?: string | null;
  /** Contract version for no-attempt pending resolution (U-4). */
  contractVersion?: number | null;
  at?: string | null;
};

const RESOLVING_OUTCOMES = new Set(["approved", "rejected", "accepted", "invalidated"]);

/**
 * Two subjects are the "same" when a resolving outcome should close a pending
 * decision. For attempt-scoped rows, the attempt id must match. For no-attempt
 * rows, the work item + kind (checked by caller) + contract version must match.
 */
function sameSubject(a: PendingLike, b: PendingLike): boolean {
  if (a.attemptId != null) {
    // Attempt-scoped: the resolving decision must share the same attempt.
    return a.attemptId === b.attemptId;
  }
  // No-attempt: both must lack an attempt id, share the same work item, and
  // have equal contract versions (nulls treated as equal via == null check).
  return (
    b.attemptId == null &&
    a.workItemId === b.workItemId &&
    (a.contractVersion ?? null) === (b.contractVersion ?? null)
  );
}

/** True when `d` is pending_human and no later resolving decision of the same
 * kind exists for the same subject. */
export function isOpenPending(d: PendingLike, all: readonly PendingLike[]): boolean {
  if (d.outcome !== "pending_human") return false;
  return !all.some(
    (o) =>
      o.id !== d.id &&
      RESOLVING_OUTCOMES.has(o.outcome ?? "") &&
      (o.kind ?? null) === (d.kind ?? null) &&
      sameSubject(d, o) &&
      (o.at === undefined || o.at === null || d.at === undefined || d.at === null || o.at >= d.at),
  );
}

export function openPendingDecisions<T extends PendingLike>(all: readonly T[]): T[] {
  return all.filter((d) => isOpenPending(d, all));
}
