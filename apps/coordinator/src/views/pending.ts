/**
 * A pending_human decision stays in the ledger as history after an operator
 * approves or rejects it (the approve command appends an `approved` decision
 * for the same attempt; reject appends `rejected`). The views must show only
 * the decisions that are still open. Observed 2026-09-08 in the browser
 * journey: after approving, the decisions page kept listing the resolved row.
 */
export type PendingLike = {
  id: string;
  workItemId: string | null;
  kind?: string | null;
  outcome: string | null;
  attemptId?: string | null;
  at?: string | null;
};

const RESOLVING_OUTCOMES = new Set(["approved", "rejected", "accepted", "invalidated"]);

/** Resolution is tied to an attempt: a pending decision without an attempt id
 * cannot be resolved by inference, so it stays open until a command updates it. */
function sameSubject(a: PendingLike, b: PendingLike): boolean {
  return Boolean(a.attemptId) && a.attemptId === b.attemptId;
}

/** True when `d` is pending_human and no later resolving decision of the same
 * kind exists for the same attempt. */
export function isOpenPending(d: PendingLike, all: readonly PendingLike[]): boolean {
  if (d.outcome !== "pending_human") return false;
  return !all.some(
    (o) =>
      o.id !== d.id &&
      RESOLVING_OUTCOMES.has(o.outcome ?? "") &&
      (o.kind ?? null) === (d.kind ?? null) &&
      sameSubject(o, d) &&
      (o.at === undefined || o.at === null || d.at === undefined || d.at === null || o.at >= d.at),
  );
}

export function openPendingDecisions<T extends PendingLike>(all: readonly T[]): T[] {
  return all.filter((d) => isOpenPending(d, all));
}
