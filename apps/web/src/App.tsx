import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AuthorityView,
  DecisionEntry,
  DecisionsView,
  EvidenceView,
  Freshness,
  Item,
  OverviewView,
  PendingDecision,
  ReturnView as ReturnViewData,
  State,
  Stop,
} from "./api.js";
import {
  fetchAuthority,
  fetchDecisions,
  fetchEvidence,
  fetchOverview,
  fetchReturnView,
  fetchWorkItem,
  postCommand,
  putAuthority,
  setToken,
  UnauthorizedError,
} from "./api.js";
import {
  buildApproveBody,
  buildDecisionRow,
  buildDispositionRemediateBody,
  buildInvalidateAcceptanceBody,
  buildOverviewWorkItemRow,
  buildPauseBody,
  buildRejectBody,
  buildResumeBody,
  buildStopBody,
  conditionIcon,
  confirmMessage,
  formatAuthorityErrors,
  formatTimestamp,
  lifecycleIcon,
  parseRoute,
} from "./control-plane-helpers.js";
import { ExecutionState } from "./ExecutionState.js";
import {
  integrationCardModel,
  isStale,
  manifestLabel,
  orderItems,
  stopBadge,
} from "./view-helpers.js";

const ACK_KEY = "agencyhq.lastAckAt";
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---- Shared sub-components -------------------------------------------------

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

const INTEGRATION_ICONS: Record<"pending" | "integrated" | "failed", string> = {
  pending: "⏳",
  integrated: "✓",
  failed: "✗",
};

function IntegrationCard({ item }: { item: Item }) {
  const model = integrationCardModel(item);
  if (!model) return null;

  const icon = INTEGRATION_ICONS[model.iconKey];
  const ts = model.at ? new Date(model.at).toLocaleString() : "no timestamp";
  const mLabel = manifestLabel(item.manifest);

  return (
    <div className="state-card">
      <div className="state-card-label">Integration</div>
      <div className="state-card-value">
        <span aria-hidden="true">{icon}</span> {model.label}
      </div>
      {model.outcome && <div className="state-card-detail">Outcome: {model.outcome}</div>}
      {model.targetRef && <div className="state-card-detail">Target: {model.targetRef}</div>}
      {model.shortRevision && (
        <div className="state-card-detail">
          Revision: <span title={model.fullRevision ?? undefined}>{model.shortRevision}</span>
        </div>
      )}
      <div className="state-card-meta">
        {model.source} · {ts}
      </div>
      {mLabel && <div className="state-card-detail">{mLabel}</div>}
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
        <IntegrationCard item={item} />
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

// ---- Navigation ------------------------------------------------------------

function Nav({ currentHash }: { currentHash: string }) {
  return (
    <nav className="nav" data-testid="nav">
      <a href="#/" className={currentHash === "#/" || currentHash === "" ? "nav-active" : ""}>
        Overview
      </a>
      <a href="#/decisions" className={currentHash === "#/decisions" ? "nav-active" : ""}>
        Decisions
      </a>
      <a href="#/return" className={currentHash === "#/return" ? "nav-active" : ""}>
        Return view
      </a>
    </nav>
  );
}

// ---- Token entry form -------------------------------------------------------

interface TokenFormProps {
  onSubmit: (token: string) => void;
  submitting: boolean;
  error: string | null;
}

function TokenForm({ onSubmit, submitting, error }: TokenFormProps) {
  const [value, setValue] = useState("");
  return (
    <div className="layout">
      <div className="header">
        <h1>AgencyHQ</h1>
      </div>
      <div className="section">
        <p role="status">Authentication required: enter your API token to continue.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(value);
          }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: "24rem" }}
          >
            <label htmlFor="api-token">API token</label>
            <input
              id="api-token"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || value.trim() === ""}
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
        {error && (
          <div className="error-box" role="alert" style={{ marginTop: "0.75rem" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Return view (existing) ------------------------------------------------

function ReturnViewPage({ hash, onUnauthorized }: { hash: string; onUnauthorized: () => void }) {
  const [view, setView] = useState<ReturnViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState(false);
  const [now] = useState(() => new Date());

  const lastAckAtRef = useRef<string | null>(
    typeof localStorage !== "undefined" ? localStorage.getItem(ACK_KEY) : null,
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchReturnView(lastAckAtRef.current)
      .then((data) => {
        setView(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      });
  }, [onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAckVisit = async () => {
    setAcking(true);
    try {
      await postCommand({ kind: "ack_visit" });
      const ts = new Date().toISOString();
      localStorage.setItem(ACK_KEY, ts);
      lastAckAtRef.current = ts;
      load();
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
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
        <Nav currentHash={hash} />
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

// ---- Overview page ---------------------------------------------------------

function OverviewPage({ hash, onUnauthorized }: { hash: string; onUnauthorized: () => void }) {
  const [view, setView] = useState<OverviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOverview()
      .then((data) => {
        setView(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      });
  }, [onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="layout">
      <div className="header">
        <h1>AgencyHQ</h1>
        <Nav currentHash={hash} />
        <button type="button" className="btn-primary" onClick={load} disabled={loading}>
          Refresh
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
          <section
            className="section"
            aria-labelledby="campaigns-heading"
            data-testid="campaigns-section"
          >
            <h2 className="section-title" id="campaigns-heading">
              Campaigns
            </h2>
            {view.campaigns.length === 0 ? (
              <p className="empty-notice">No campaigns.</p>
            ) : (
              <table className="data-table" data-testid="campaigns-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Main effort</th>
                    <th>Members</th>
                  </tr>
                </thead>
                <tbody>
                  {view.campaigns.map((c) => {
                    const memberCount = view.projects.reduce(
                      (acc, p) => acc + p.workItems.filter((wi) => wi.campaignId === c.id).length,
                      0,
                    );
                    return (
                      <tr key={c.id} data-testid={`campaign-row-${c.id}`}>
                        <td>{c.name}</td>
                        <td>
                          {c.mainEffortWorkItemId ? (
                            <a href={`#/work-items/${encodeURIComponent(c.mainEffortWorkItemId)}`}>
                              {c.mainEffortWorkItemId}
                            </a>
                          ) : (
                            <span className="empty-notice">—</span>
                          )}
                        </td>
                        <td>{memberCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section
            className="section"
            aria-labelledby="projects-heading"
            data-testid="projects-section"
          >
            <h2 className="section-title" id="projects-heading">
              Projects
            </h2>
            {view.projects.length === 0 ? (
              <p className="empty-notice">No projects.</p>
            ) : (
              view.projects.map((p) => (
                <div key={p.id} className="project-block" data-testid={`project-${p.id}`}>
                  <div className="project-header">
                    <span className="project-id" data-testid={`project-id-${p.id}`}>
                      {p.id}
                    </span>
                    <a
                      href={`#/projects/${encodeURIComponent(p.id)}/authority`}
                      data-testid={`authority-link-${p.id}`}
                    >
                      Authority
                    </a>
                  </div>
                  {p.workItems.length === 0 ? (
                    <p className="empty-notice">No work items.</p>
                  ) : (
                    <table className="data-table" data-testid={`work-items-table-${p.id}`}>
                      <thead>
                        <tr>
                          <th>Rank</th>
                          <th>Intent</th>
                          <th>Lifecycle</th>
                          <th>Condition</th>
                          <th>Boundary</th>
                          <th>Decisions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.workItems.map((wi) => {
                          const row = buildOverviewWorkItemRow(wi);
                          return (
                            <tr
                              key={wi.id}
                              data-testid={`work-item-row-${wi.id}`}
                              className={wi.mainEffort ? "main-effort-row" : ""}
                            >
                              <td>{row.rank}</td>
                              <td>
                                <a href={`#/work-items/${encodeURIComponent(wi.id)}`}>
                                  {row.intent}
                                </a>
                                {wi.mainEffort && (
                                  <span className="main-effort-tag"> Main effort</span>
                                )}
                              </td>
                              <td data-testid={`lifecycle-${wi.id}`}>
                                <span aria-hidden="true">{row.lifecycleIcon}</span> {row.lifecycle}
                              </td>
                              <td data-testid={`condition-${wi.id}`}>
                                <span aria-hidden="true">{row.conditionIcon}</span> {row.condition}
                              </td>
                              <td>{row.boundary}</td>
                              <td data-testid={`pending-decisions-${wi.id}`}>
                                {row.pendingDecisionCount > 0 ? (
                                  <a href="#/decisions">{row.pendingDecisionCount}</a>
                                ) : (
                                  "0"
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---- Decisions page --------------------------------------------------------

function DecisionsPage({ hash, onUnauthorized }: { hash: string; onUnauthorized: () => void }) {
  const [view, setView] = useState<DecisionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);
  // workItemId → projectId, built from the overview on each load.
  const [workItemProjectMap, setWorkItemProjectMap] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchDecisions(), fetchOverview()])
      .then(([decisionsData, overviewData]) => {
        setView(decisionsData);
        // Build a workItemId → projectId map so confirm messages can name the project.
        const map: Record<string, string> = {};
        for (const proj of overviewData.projects) {
          for (const wi of proj.workItems) {
            map[wi.id] = proj.id;
          }
        }
        setWorkItemProjectMap(map);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      });
  }, [onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  const confirmThen = (message: string, fn: () => void) => {
    setConfirm({ message, onConfirm: fn });
  };

  const runAction = async (key: string, body: Record<string, unknown>) => {
    setActionInFlight(key);
    setActionError(null);
    try {
      await postCommand(body);
      load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionInFlight(null);
    }
  };

  const handleApprove = (entry: DecisionEntry) => {
    const { impact } = entry;
    if (!impact.workItemId) return;
    const wid = impact.workItemId;
    const pid = workItemProjectMap[wid] ?? "unknown";
    confirmThen(
      confirmMessage({
        action: "approve",
        projectId: pid,
        workItemId: wid,
        contractVersion: impact.contractVersion,
      }),
      () =>
        runAction(
          `approve-${entry.id}`,
          buildApproveBody({
            commandId: crypto.randomUUID(),
            workItemId: wid,
            contractId: impact.contractId ?? "",
            contractVersion: impact.contractVersion ?? 0,
            attemptRevision: impact.attemptRevision ?? "",
          }),
        ),
    );
  };

  const handleReject = (entry: DecisionEntry) => {
    const wid = entry.workItemId ?? entry.impact.workItemId;
    if (!wid) return;
    const pid = workItemProjectMap[wid] ?? "unknown";
    const reason = rejectReasons[entry.id] ?? "operator rejected";
    confirmThen(
      confirmMessage({
        action: "reject",
        projectId: pid,
        workItemId: wid,
        contractVersion: entry.impact.contractVersion,
      }),
      () =>
        runAction(
          `reject-${entry.id}`,
          buildRejectBody({
            commandId: crypto.randomUUID(),
            workItemId: wid,
            decisionId: entry.id,
            reason,
          }),
        ),
    );
  };

  return (
    <div className="layout">
      <div className="header">
        <h1>AgencyHQ — Decisions</h1>
        <Nav currentHash={hash} />
        <button type="button" className="btn-primary" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={() => {
            const fn = confirm.onConfirm;
            setConfirm(null);
            fn();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {actionError && (
        <div className="error-box" role="alert" data-testid="action-error">
          {actionError}
        </div>
      )}
      {loading && <div className="loading">Loading...</div>}

      {view && (
        <section
          className="section"
          aria-labelledby="decisions-page-heading"
          data-testid="decisions-list"
        >
          <h2 className="section-title" id="decisions-page-heading">
            Pending decisions ({view.decisions.length})
          </h2>
          {view.decisions.length === 0 ? (
            <p className="empty-notice">No pending decisions.</p>
          ) : (
            view.decisions.map((entry) => {
              const row = buildDecisionRow(entry);
              return (
                <div
                  key={entry.id}
                  className="decision-entry"
                  data-testid={`decision-entry-${entry.id}`}
                >
                  <div className="decision-header">
                    <span className="decision-id" data-testid={`decision-id-${entry.id}`}>
                      {entry.id}
                    </span>
                    <span className="decision-meta" data-testid={`decision-at-${entry.id}`}>
                      {row.formattedAt}
                    </span>
                  </div>
                  <dl className="decision-fields">
                    <dt>Obstacle</dt>
                    <dd data-testid={`decision-obstacle-${entry.id}`}>{row.obstacle}</dd>
                    {row.recommendation && (
                      <>
                        <dt>Recommendation</dt>
                        <dd data-testid={`decision-recommendation-${entry.id}`}>
                          {row.recommendation}
                        </dd>
                      </>
                    )}
                    <dt>Impact</dt>
                    <dd data-testid={`decision-impact-${entry.id}`}>
                      Work item:{" "}
                      {entry.impact.workItemId ? (
                        <a href={`#/work-items/${encodeURIComponent(entry.impact.workItemId)}`}>
                          {entry.impact.workItemId}
                        </a>
                      ) : (
                        "—"
                      )}
                      {entry.impact.contractVersion != null &&
                        ` · Contract v${entry.impact.contractVersion}`}
                      {entry.impact.attemptId && ` · Attempt ${entry.impact.attemptId}`}
                    </dd>
                    <dt>No-action consequence</dt>
                    <dd data-testid={`decision-noaction-${entry.id}`}>{row.noActionConsequence}</dd>
                  </dl>
                  <div className="decision-actions" data-testid={`decision-actions-${entry.id}`}>
                    {entry.actions.includes("approve") && (
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid={`approve-btn-${entry.id}`}
                        disabled={actionInFlight !== null}
                        onClick={() => handleApprove(entry)}
                      >
                        {actionInFlight === `approve-${entry.id}` ? "Approving..." : "Approve"}
                      </button>
                    )}
                    {entry.actions.includes("reject") && (
                      <span className="reject-group">
                        <input
                          type="text"
                          placeholder="Reason"
                          aria-label={`Reject reason for ${entry.id}`}
                          data-testid={`reject-reason-${entry.id}`}
                          value={rejectReasons[entry.id] ?? ""}
                          onChange={(e) =>
                            setRejectReasons((prev) => ({ ...prev, [entry.id]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="btn-danger"
                          data-testid={`reject-btn-${entry.id}`}
                          disabled={actionInFlight !== null}
                          onClick={() => handleReject(entry)}
                        >
                          {actionInFlight === `reject-${entry.id}` ? "Rejecting..." : "Reject"}
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}
    </div>
  );
}

// ---- Work item page --------------------------------------------------------

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" data-testid="confirm-dialog">
      <div className="confirm-box">
        <p data-testid="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button type="button" className="btn-danger" data-testid="confirm-ok" onClick={onConfirm}>
            Confirm
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function EvidencePanel({ evidence }: { evidence: EvidenceView }) {
  return (
    <div className="evidence-panel" data-testid="evidence-panel">
      <h3 className="section-title">Evidence</h3>

      {/* Attempts */}
      {evidence.attempts.length > 0 && (
        <div className="evidence-block" data-testid="evidence-attempts">
          <h4>Attempts</h4>
          {evidence.attempts.map((a) => (
            <div key={a.id} className="evidence-item" data-testid={`attempt-${a.id}`}>
              <div>
                <strong>{a.id}</strong> — {a.status}
              </div>
              {a.runId && <div className="state-card-meta">Run: {a.runId}</div>}
              {a.checkpointCommit && (
                <div className="state-card-meta">Checkpoint: {a.checkpointCommit.slice(0, 8)}</div>
              )}
              <div className="state-card-meta">{formatTimestamp(a.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Artifacts */}
      {evidence.artifacts.length > 0 && (
        <div className="evidence-block" data-testid="evidence-artifacts">
          <h4>Artifacts</h4>
          {evidence.artifacts.map((a) => (
            <div key={a.id} className="evidence-item" data-testid={`artifact-${a.id}`}>
              <div>
                <strong>{a.revision.slice(0, 7)}</strong> (attempt {a.attemptId})
              </div>
              <div className="state-card-meta">{formatTimestamp(a.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Verification results */}
      {evidence.verificationResults.length > 0 && (
        <div className="evidence-block" data-testid="evidence-verification-results">
          <h4>Verification results</h4>
          {evidence.verificationResults.map((v) => (
            <div key={v.id} className="evidence-item" data-testid={`verification-result-${v.id}`}>
              <div>
                {v.result} — step {v.stepContractId}
              </div>
              <div className="state-card-meta">{formatTimestamp(v.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Reviews */}
      {evidence.reviews.length > 0 && (
        <div className="evidence-block" data-testid="evidence-reviews">
          <h4>Reviews</h4>
          {evidence.reviews.map((r) => (
            <div key={r.id} className="evidence-item" data-testid={`review-${r.id}`}>
              <div>Review {r.id}</div>
              {r.attemptRevision && (
                <div className="state-card-meta">Revision: {r.attemptRevision.slice(0, 7)}</div>
              )}
              <div className="state-card-meta">{formatTimestamp(r.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Findings */}
      {evidence.findings.length > 0 && (
        <div className="evidence-block" data-testid="evidence-findings">
          <h4>Findings</h4>
          {evidence.findings.map((f) => (
            <div key={f.id} className="evidence-item" data-testid={`finding-${f.id}`}>
              <div>
                <strong>{f.severity}</strong> — {f.kind}
              </div>
              {f.description && <div>{f.description}</div>}
              {f.disposition && <div className="state-card-meta">Disposition: {f.disposition}</div>}
              <div className="state-card-meta">{formatTimestamp(f.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Decisions */}
      {evidence.decisions.length > 0 && (
        <div className="evidence-block" data-testid="evidence-decisions">
          <h4>Decisions</h4>
          {evidence.decisions.map((d) => (
            <div key={d.id} className="evidence-item" data-testid={`evidence-decision-${d.id}`}>
              <div>
                {d.kind} — {d.outcome ?? "pending"} ({d.actor})
              </div>
              {d.contractVersion != null && (
                <div className="state-card-meta">Contract v{d.contractVersion}</div>
              )}
              <div className="state-card-meta">{formatTimestamp(d.at)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Approvals */}
      {evidence.approvals.length > 0 && (
        <div className="evidence-block" data-testid="evidence-approvals">
          <h4>Approvals</h4>
          {evidence.approvals.map((a) => (
            <div key={a.id} className="evidence-item" data-testid={`approval-${a.id}`}>
              <div>Decision {a.decisionId}</div>
              {a.contractVersion != null && (
                <div className="state-card-meta">Contract v{a.contractVersion}</div>
              )}
              {a.attemptRevision && (
                <div className="state-card-meta">Revision: {a.attemptRevision.slice(0, 7)}</div>
              )}
              {a.humanActor && <div className="state-card-meta">By: {a.humanActor}</div>}
              <div className="state-card-meta">{formatTimestamp(a.at ?? null)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Integrations */}
      {evidence.integrations.length > 0 && (
        <div className="evidence-block" data-testid="evidence-integrations">
          <h4>Integrations</h4>
          {evidence.integrations.map((i) => (
            <div key={i.id} className="evidence-item" data-testid={`integration-${i.id}`}>
              <div>Target: {i.targetRef}</div>
              {i.outcome && <div>Outcome: {i.outcome}</div>}
              {i.resultingRevision && (
                <div className="state-card-meta">Revision: {i.resultingRevision.slice(0, 7)}</div>
              )}
              <div className="state-card-meta">{formatTimestamp(i.at)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Manifest rows */}
      {evidence.manifestRows.length > 0 && (
        <div className="evidence-block" data-testid="evidence-manifest-rows">
          <h4>Manifest</h4>
          {evidence.manifestRows.map((m) => (
            <div
              key={`${m.workItemId}-${m.position}`}
              className="evidence-item"
              data-testid={`manifest-row-${m.workItemId}-${m.position}`}
            >
              <div>
                Position {m.position} — {m.workItemId}
              </div>
              {m.resultRevision && (
                <div className="state-card-meta">Revision: {m.resultRevision.slice(0, 7)}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {evidence.attempts.length === 0 &&
        evidence.artifacts.length === 0 &&
        evidence.verificationResults.length === 0 &&
        evidence.reviews.length === 0 &&
        evidence.findings.length === 0 &&
        evidence.decisions.length === 0 &&
        evidence.approvals.length === 0 &&
        evidence.integrations.length === 0 &&
        evidence.manifestRows.length === 0 && <p className="empty-notice">No evidence yet.</p>}
    </div>
  );
}

function WorkItemPage({
  workItemId,
  hash,
  onUnauthorized,
}: {
  workItemId: string;
  hash: string;
  onUnauthorized: () => void;
}) {
  const [item, setItem] = useState<Item | null>(null);
  const [evidence, setEvidence] = useState<EvidenceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [invalidateReason, setInvalidateReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  // Resolved from the overview on each load — used in confirm messages.
  const [projectId, setProjectId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchWorkItem(workItemId), fetchEvidence(workItemId), fetchOverview()])
      .then(([itemData, evidenceData, overviewData]) => {
        setItem(itemData);
        setEvidence(evidenceData);
        // Find the project that owns this work item.
        for (const proj of overviewData.projects) {
          if (proj.workItems.some((wi) => wi.id === workItemId)) {
            setProjectId(proj.id);
            break;
          }
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      });
  }, [workItemId, onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (key: string, body: Record<string, unknown>) => {
    setActionInFlight(key);
    setActionError(null);
    try {
      await postCommand(body);
      load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionInFlight(null);
    }
  };

  const confirmThen = (message: string, fn: () => void) => {
    setConfirm({ message, onConfirm: fn });
  };

  // Find the first pending decision from evidence to prefill approve
  const pendingDecision = evidence?.decisions.find(
    (d) => d.outcome === "pending_human" || d.outcome == null,
  );

  // Find the first attempt id for stop/invalidate
  const latestAttempt = evidence?.attempts[0];

  return (
    <div className="layout">
      <div className="header">
        <h1>AgencyHQ — Work item</h1>
        <Nav currentHash={hash} />
        <button type="button" className="btn-primary" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={() => {
            const fn = confirm.onConfirm;
            setConfirm(null);
            fn();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {actionError && (
        <div className="error-box" role="alert" data-testid="work-item-action-error">
          {actionError}
        </div>
      )}
      {loading && <div className="loading">Loading...</div>}

      {item && (
        <>
          <section
            className="section"
            aria-labelledby="work-item-heading"
            data-testid="work-item-detail"
          >
            <h2 className="section-title" id="work-item-heading" data-testid="work-item-id">
              {item.workItemId}
            </h2>
            <p data-testid="work-item-intent">{item.intent}</p>
            <p data-testid="work-item-lifecycle">
              <span aria-hidden="true">{lifecycleIcon(item.lifecycle)}</span> {item.lifecycle}
              {" · "}
              <span aria-hidden="true">{conditionIcon(item.condition)}</span> {item.condition}
            </p>
            <div className="state-cards">
              <StateCard dim="Contract" state={item.contract} />
              <StateCard dim="Execution" state={item.execution} />
              <StateCard dim="Verification" state={item.verification} />
              <StateCard dim="Acceptance" state={item.acceptance} />
              <IntegrationCard item={item} />
            </div>
            {item.execution.source !== "ledger" && (
              <ExecutionState workItemId={item.workItemId} ledgerExecution={item.execution} />
            )}
          </section>

          {/* Actions */}
          <section
            className="section"
            aria-labelledby="actions-heading"
            data-testid="work-item-actions"
          >
            <h2 className="section-title" id="actions-heading">
              Actions
            </h2>
            <div className="action-group">
              {/* Approve — prefill from pending decision */}
              {pendingDecision && (
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="action-approve"
                  disabled={actionInFlight !== null}
                  onClick={() => {
                    // Look up contractId and artifact revision from evidence
                    const attemptForDecision = evidence?.attempts.find(
                      (a) => a.id === pendingDecision.attemptId,
                    );
                    const artifactForAttempt = evidence?.artifacts.find(
                      (a) => a.attemptId === pendingDecision.attemptId,
                    );
                    confirmThen(
                      confirmMessage({
                        action: "approve",
                        projectId: projectId ?? "unknown",
                        workItemId: item.workItemId,
                        contractVersion: pendingDecision.contractVersion,
                      }),
                      () =>
                        runAction(
                          "approve",
                          buildApproveBody({
                            commandId: crypto.randomUUID(),
                            workItemId: item.workItemId,
                            contractId: attemptForDecision?.contractId ?? "",
                            contractVersion: pendingDecision.contractVersion ?? 0,
                            attemptRevision: artifactForAttempt?.revision ?? "",
                          }),
                        ),
                    );
                  }}
                >
                  Approve
                </button>
              )}

              {/* Reject with reason */}
              <span className="reject-group">
                <input
                  type="text"
                  placeholder="Reject reason"
                  aria-label="Reject reason"
                  data-testid="action-reject-reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-danger"
                  data-testid="action-reject"
                  disabled={actionInFlight !== null || !pendingDecision}
                  onClick={() => {
                    if (!pendingDecision) return;
                    confirmThen(
                      confirmMessage({
                        action: "reject",
                        projectId: projectId ?? "unknown",
                        workItemId: item.workItemId,
                        contractVersion: pendingDecision.contractVersion,
                      }),
                      () =>
                        runAction(
                          "reject",
                          buildRejectBody({
                            commandId: crypto.randomUUID(),
                            workItemId: item.workItemId,
                            decisionId: pendingDecision.id,
                            reason: rejectReason || "operator rejected",
                          }),
                        ),
                    );
                  }}
                >
                  Reject
                </button>
              </span>

              {/* Stop */}
              {latestAttempt && (
                <button
                  type="button"
                  className="btn-danger"
                  data-testid="action-stop"
                  disabled={actionInFlight !== null}
                  onClick={() =>
                    confirmThen(
                      confirmMessage({
                        action: "stop",
                        projectId: projectId ?? "unknown",
                        workItemId: item.workItemId,
                      }),
                      () =>
                        runAction(
                          "stop",
                          buildStopBody({
                            commandId: crypto.randomUUID(),
                            attemptId: latestAttempt.id,
                          }),
                        ),
                    )
                  }
                >
                  Stop
                </button>
              )}

              {/* Pause */}
              <button
                type="button"
                className="btn-primary"
                data-testid="action-pause"
                disabled={actionInFlight !== null}
                onClick={() =>
                  confirmThen(
                    confirmMessage({
                      action: "pause",
                      projectId: projectId ?? "unknown",
                      workItemId: item.workItemId,
                    }),
                    () =>
                      runAction(
                        "pause",
                        buildPauseBody({
                          commandId: crypto.randomUUID(),
                          workItemId: item.workItemId,
                          reason: "operator requested",
                        }),
                      ),
                  )
                }
              >
                Pause
              </button>

              {/* Resume */}
              <button
                type="button"
                className="btn-primary"
                data-testid="action-resume"
                disabled={actionInFlight !== null}
                onClick={() =>
                  runAction(
                    "resume",
                    buildResumeBody({
                      commandId: crypto.randomUUID(),
                      workItemId: item.workItemId,
                      reason: "operator requested",
                    }),
                  )
                }
              >
                Resume
              </button>

              {/* Disposition remediate (new attempt) */}
              {evidence && evidence.findings.length > 0 && (
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="action-remediate"
                  disabled={actionInFlight !== null}
                  onClick={() => {
                    const firstFinding = evidence.findings[0];
                    if (!firstFinding) return;
                    confirmThen(
                      confirmMessage({
                        action: "remediate",
                        projectId: projectId ?? "unknown",
                        workItemId: item.workItemId,
                      }),
                      () =>
                        runAction(
                          "remediate",
                          buildDispositionRemediateBody({
                            commandId: crypto.randomUUID(),
                            findingId: firstFinding.id,
                          }),
                        ),
                    );
                  }}
                >
                  New attempt (remediate)
                </button>
              )}

              {/* Invalidate acceptance */}
              {latestAttempt && (
                <span className="reject-group">
                  <input
                    type="text"
                    placeholder="Invalidate reason"
                    aria-label="Invalidate acceptance reason"
                    data-testid="action-invalidate-reason"
                    value={invalidateReason}
                    onChange={(e) => setInvalidateReason(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-danger"
                    data-testid="action-invalidate"
                    disabled={actionInFlight !== null}
                    onClick={() =>
                      confirmThen(
                        confirmMessage({
                          action: "invalidate",
                          projectId: projectId ?? "unknown",
                          workItemId: item.workItemId,
                          contractVersion: pendingDecision?.contractVersion,
                        }),
                        () =>
                          runAction(
                            "invalidate",
                            buildInvalidateAcceptanceBody({
                              commandId: crypto.randomUUID(),
                              workItemId: item.workItemId,
                              attemptId: latestAttempt.id,
                              reason: invalidateReason || "acceptance invalidated",
                            }),
                          ),
                      )
                    }
                  >
                    Invalidate acceptance
                  </button>
                </span>
              )}
            </div>
          </section>

          {/* Evidence */}
          {evidence && <EvidencePanel evidence={evidence} />}
        </>
      )}
    </div>
  );
}

// ---- Authority page --------------------------------------------------------

function AuthorityPage({
  projectId,
  hash,
  onUnauthorized,
}: {
  projectId: string;
  hash: string;
  onUnauthorized: () => void;
}) {
  const [view, setView] = useState<AuthorityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorValue, setEditorValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAuthority(projectId)
      .then((data) => {
        setView(data);
        setEditorValue(JSON.stringify(data.authority, null, 2));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      });
  }, [projectId, onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editorValue) as Record<string, unknown>;
    } catch {
      setSaveError("Invalid JSON: cannot parse the authority text.");
      return;
    }

    const newVersion = view ? `v${Number(view.currentVersion.replace(/[^0-9]/g, "")) + 1}` : "v1";
    setConfirm({
      message: `Update authority for project ${projectId} to ${newVersion}?`,
      onConfirm: async () => {
        setSaving(true);
        setSaveError(null);
        try {
          const result = await putAuthority(projectId, { authority: parsed });
          if ("errors" in result && Array.isArray(result.errors)) {
            setSaveError(
              formatAuthorityErrors(result.errors as Array<{ message: string; path?: string[] }>),
            );
          } else {
            load();
          }
        } catch (err: unknown) {
          setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  return (
    <div className="layout">
      <div className="header">
        <h1>AgencyHQ — Authority</h1>
        <Nav currentHash={hash} />
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={() => {
            const fn = confirm.onConfirm;
            setConfirm(null);
            fn();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="loading">Loading...</div>}

      {view && (
        <>
          <section
            className="section"
            aria-labelledby="authority-heading"
            data-testid="authority-section"
          >
            <h2 className="section-title" id="authority-heading">
              Authority — project <span data-testid="authority-project-id">{view.projectId}</span>
            </h2>
            <div className="state-card-meta" data-testid="authority-version">
              Current version: {view.currentVersion}
            </div>

            <div style={{ marginTop: "1rem" }}>
              <label htmlFor="authority-editor">Authority (JSON)</label>
              <textarea
                id="authority-editor"
                data-testid="authority-editor"
                rows={20}
                style={{ width: "100%", fontFamily: "monospace", marginTop: "0.5rem" }}
                value={editorValue}
                onChange={(e) => setEditorValue(e.target.value)}
                disabled={saving}
                spellCheck={false}
              />
            </div>

            {saveError && (
              <div className="error-box" role="alert" data-testid="authority-save-error">
                {saveError}
              </div>
            )}

            <button
              type="button"
              className="btn-primary"
              data-testid="authority-save-btn"
              disabled={saving}
              onClick={handleSave}
              style={{ marginTop: "0.75rem" }}
            >
              {saving ? "Saving..." : "Save authority"}
            </button>
          </section>

          {/* Version history */}
          {view.history.length > 0 && (
            <section
              className="section"
              aria-labelledby="history-heading"
              data-testid="authority-history"
            >
              <h2 className="section-title" id="history-heading">
                Version history
              </h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Actor</th>
                    <th>At</th>
                  </tr>
                </thead>
                <tbody>
                  {view.history.map((h) => (
                    <tr key={h.version} data-testid={`history-row-${h.version}`}>
                      <td>{h.version}</td>
                      <td>{h.actor}</td>
                      <td>{formatTimestamp(h.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---- Main App — hash router ------------------------------------------------

export function App() {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  const [unauthorized, setUnauthorized] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSubmitting, setTokenSubmitting] = useState(false);

  useEffect(() => {
    const handleHashChange = () => {
      setHash(window.location.hash || "#/");
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const handleTokenSubmit = async (token: string) => {
    setTokenSubmitting(true);
    setTokenError(null);
    setToken(token);
    try {
      // Probe with a lightweight call
      await fetchReturnView(null);
      setUnauthorized(false);
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) {
        setTokenError("Token rejected: unauthorized. Check the token and try again.");
      } else {
        // Non-auth error: token may be fine, proceed
        setUnauthorized(false);
      }
    } finally {
      setTokenSubmitting(false);
    }
  };

  const handleUnauthorized = useCallback(() => {
    setUnauthorized(true);
  }, []);

  if (unauthorized) {
    return (
      <TokenForm onSubmit={handleTokenSubmit} submitting={tokenSubmitting} error={tokenError} />
    );
  }

  const route = parseRoute(hash);

  if (route.page === "return") {
    return <ReturnViewPage hash={hash} onUnauthorized={handleUnauthorized} />;
  }

  if (route.page === "work-item") {
    return <WorkItemPage workItemId={route.id} hash={hash} onUnauthorized={handleUnauthorized} />;
  }

  if (route.page === "decisions") {
    return <DecisionsPage hash={hash} onUnauthorized={handleUnauthorized} />;
  }

  if (route.page === "authority") {
    return (
      <AuthorityPage projectId={route.projectId} hash={hash} onUnauthorized={handleUnauthorized} />
    );
  }

  // Default: overview
  return <OverviewPage hash={hash} onUnauthorized={handleUnauthorized} />;
}
