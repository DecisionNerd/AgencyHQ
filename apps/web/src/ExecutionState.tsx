// ExecutionState — fetches a scoped realtime token and subscribes to run updates via
// Trigger.dev React Hooks 4.5.16 (verified against installed typings, 2026-09-07).
//
// TriggerAuthContext.Provider accepts ApiClientConfiguration { accessToken?, baseURL? }.
// useRealtimeRunsWithTag(tag) → { runs, error, stop }.
// Runs in the context of a single work item identified by workItemId.

import { TriggerAuthContext, useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import { useEffect, useState } from "react";
import type { RealtimeToken, State } from "./api.js";
import { fetchRealtimeToken } from "./api.js";

interface ExecutionStateProps {
  workItemId: string;
  /** Fallback ledger execution state, shown when no realtime token is available. */
  ledgerExecution: State;
}

interface LiveRunsProps {
  tag: string;
  apiUrl: string;
}

function LiveRuns({ tag, apiUrl }: LiveRunsProps) {
  const { runs, error } = useRealtimeRunsWithTag(tag, { enabled: true });

  if (error) {
    return (
      <div className="exec-state">
        <span className="exec-run-status">Realtime error: {error.message}</span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="exec-state">
        <span className="exec-run-status">Waiting for run data...</span>
      </div>
    );
  }

  const latest = runs[0];

  const phase =
    latest &&
    typeof latest.metadata === "object" &&
    latest.metadata !== null &&
    "phase" in latest.metadata
      ? String((latest.metadata as Record<string, unknown>).phase)
      : null;

  return (
    <div className="exec-state">
      <span className="exec-run-status">
        Status: <strong>{latest?.status ?? "unknown"}</strong>
        {phase ? ` · Phase: ${phase}` : ""}
      </span>{" "}
      {latest?.id && (
        <a
          href={`${apiUrl}/runs/${latest.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Open run in Trigger dashboard"
        >
          Open run
        </a>
      )}
    </div>
  );
}

export function ExecutionState({ workItemId, ledgerExecution }: ExecutionStateProps) {
  const [tokenData, setTokenData] = useState<RealtimeToken | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTokenError(null);
    fetchRealtimeToken(workItemId)
      .then((data) => {
        if (!cancelled) {
          setTokenData(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTokenError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workItemId]);

  if (loading) {
    return (
      <div className="exec-state">
        <span className="exec-run-status">Loading execution state...</span>
      </div>
    );
  }

  if (tokenError || !tokenData) {
    // Fall back to ledger state
    return (
      <div className="exec-state">
        <span className="exec-run-status">
          {ledgerExecution.label}
          {ledgerExecution.source === "ledger" ? " (ledger)" : ""}
        </span>
      </div>
    );
  }

  const { token, apiUrl, tag } = tokenData;

  return (
    <TriggerAuthContext.Provider value={{ accessToken: token, baseURL: apiUrl }}>
      <LiveRuns tag={tag} apiUrl={apiUrl} />
    </TriggerAuthContext.Provider>
  );
}
