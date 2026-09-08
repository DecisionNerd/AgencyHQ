import { useCallback, useEffect, useState } from "react";
import type { Freshness, Item, PendingDecision, ReturnView, State, Stop } from "./api.js";
import { fetchReturnView, postCommand } from "./api.js";
import { ExecutionState } from "./ExecutionState.js";
import { isStale, orderItems, stopBadge } from "./view-helpers.js";

const ACK_KEY = "agencyhq.lastAckAt";
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---- Sub-components -------------------------------------------------------

function StateCard({ dim, state }: { dim: string; state: State }) {
  return (
    <div className="state-card">
      <div className="state-card-label">{dim}</div>
      <div className={`state-card-value${state.stale ? " state-stale" : ""}`}>{state.label}</div>
      <div className="state-card-meta">
        {state.source} · {state.at ? new Date(state.at).toLocaleString() : "no timestamp"}
      </div>
      {state.detail && <div className="state-card-detail">{state.detail}</div>}
    </div>
  );
}

function ItemCard({ item, isMain }: { item: Item; isMain: boolean }) {
  return (
    <div className={`item-card${isMain ? " main-effort" : ""}`}>
      <div className="item-header">
        <span className="item-intent">{item.intent}</span>
        <span className="item-id">{item.workItemId}</span>
        {isMain && <span className="main-effort-tag">Main effort</span>}
      </div>
      <div className="state-cards">
        <StateCard dim="Contract" state={item.contract} />
        <StateCard dim="Execution" state={item.execution} />
        <StateCard dim="Verification" state={item.verification} />
        <StateCard dim="Acceptance" state={item.acceptance} />
      </div>
      {item.execution.source !== "ledger" && (
        <ExecutionState workItemId={item.workItemId} ledgerExecution={item.execution} />
      )}
    </div>
  );
}

function DecisionCard({ decision }: { decision: PendingDecision }) {
  return (
    <div className="decision-card">
      <div className="decision-kind">{decision.kind}</div>
      <div className="decision-outcome">{decision.outcome}</div>
      <div className="decision-detail">{decision.detail}</div>
      <div className="decision-meta">
        Work item: {decision.workItemId} · {new Date(decision.at).toLocaleString()}
      </div>
    </div>
  );
}

function StopCard({ stop }: { stop: Stop }) {
  return (
    <div className="stop-card">
      <span role="status" className={`badge badge-${stop.state}`}>
        {stopBadge(stop)}
      </span>
      <div className="stop-info">
        <div className="stop-attempt-id">{stop.attemptId}</div>
        {stop.checkpointCommit && (
          <div className="stop-checkpoint">Checkpoint: {stop.checkpointCommit}</div>
        )}
        <div className="state-card-meta">{new Date(stop.at).toLocaleString()}</div>
      </div>
    </div>
  );
}

function FreshnessBar({ freshness, now }: { freshness: Freshness; now: Date }) {
  const stale = isStale(freshness, now, STALE_THRESHOLD_MS);
  return (
    <div className="freshness-bar">
      {freshness.lastPollAt ? (
        <span>Last polled: {new Date(freshness.lastPollAt).toLocaleString()}</span>
      ) : (
        <span>Never polled</span>
      )}
      {stale && (
        <span role="status" className="badge badge-stale">
          STALE
        </span>
      )}
    </div>
  );
}

// ---- Main App -------------------------------------------------------------

export function App() {
  const [view, setView] = useState<ReturnView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState(false);
  const [now] = useState(() => new Date());

  const lastAckAt = typeof localStorage !== "undefined" ? localStorage.getItem(ACK_KEY) : null;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchReturnView(lastAckAt)
      .then((data) => {
        setView(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [lastAckAt]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAckVisit = async () => {
    setAcking(true);
    try {
      await postCommand({ kind: "ack_visit" });
      const ts = new Date().toISOString();
      localStorage.setItem(ACK_KEY, ts);
      // Reload the view with the new ack time
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAcking(false);
    }
  };

  const mainEffortId = view?.mainEffort ?? null;

  const orderedContinuing = view ? orderItems([], view.continuing, mainEffortId) : [];

  return (
    <div className="layout">
      <div className="header">
        <h1>AgencyHQ</h1>
        {view && <FreshnessBar freshness={view.freshness} now={now} />}
        <button
          type="button"
          className="btn-primary"
          onClick={handleAckVisit}
          disabled={acking || loading}
          aria-label="Acknowledge this visit and mark the current time"
        >
          {acking ? "Acknowledging..." : "Acknowledge visit"}
        </button>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="loading">Loading...</div>}

      {view && (
        <>
          {/* Changed since last visit */}
          <section className="section" aria-labelledby="changed-heading">
            <h2 className="section-title" id="changed-heading">
              Changed since your last visit
            </h2>
            {view.changedSinceLastVisit.length === 0 ? (
              <p className="empty-notice">No changes since your last visit.</p>
            ) : (
              view.changedSinceLastVisit.map((item) => (
                <ItemCard
                  key={item.workItemId}
                  item={item}
                  isMain={item.workItemId === mainEffortId}
                />
              ))
            )}
          </section>

          {/* Decisions pending */}
          <section className="section" aria-labelledby="decisions-heading">
            <h2 className="section-title" id="decisions-heading">
              Decisions pending
            </h2>
            {view.pendingDecisions.length === 0 ? (
              <p className="empty-notice">No decisions pending.</p>
            ) : (
              view.pendingDecisions.map((d) => <DecisionCard key={d.decisionId} decision={d} />)
            )}
          </section>

          {/* Stops */}
          <section className="section" aria-labelledby="stops-heading">
            <h2 className="section-title" id="stops-heading">
              Stops
            </h2>
            {view.stops.length === 0 ? (
              <p className="empty-notice">No stop requests active.</p>
            ) : (
              view.stops.map((s) => <StopCard key={s.attemptId} stop={s} />)
            )}
          </section>

          {/* Continuing */}
          <section className="section" aria-labelledby="continuing-heading">
            <h2 className="section-title" id="continuing-heading">
              Continuing
            </h2>
            {orderedContinuing.length === 0 ? (
              <p className="empty-notice">No work continuing.</p>
            ) : (
              orderedContinuing.map((item) => (
                <ItemCard
                  key={item.workItemId}
                  item={item}
                  isMain={item.workItemId === mainEffortId}
                />
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
