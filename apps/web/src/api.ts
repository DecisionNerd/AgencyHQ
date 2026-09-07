// AgencyHQ web API types and client functions.
// Types mirror the coordinator's ReturnView contract; web never imports coordinator code.

export interface State {
  label: string;
  source: "ledger" | "runtime" | "adapter";
  at: string | null;
  stale?: boolean;
  detail?: string;
}

export interface Item {
  workItemId: string;
  intent: string;
  contract: State;
  execution: State;
  verification: State;
  acceptance: State;
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

export async function fetchReturnView(since: string | null): Promise<ReturnView> {
  const url = since ? `/api/return-view?since=${encodeURIComponent(since)}` : "/api/return-view";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchReturnView: ${res.status} ${res.statusText}`);
  return res.json() as Promise<ReturnView>;
}

export async function fetchWorkItem(id: string): Promise<Item> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetchWorkItem: ${res.status} ${res.statusText}`);
  return res.json() as Promise<Item>;
}

export async function fetchRealtimeToken(id: string): Promise<RealtimeToken> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/realtime-token`);
  if (!res.ok) throw new Error(`fetchRealtimeToken: ${res.status} ${res.statusText}`);
  return res.json() as Promise<RealtimeToken>;
}

export async function postCommand(cmd: Omit<Command, "commandId">): Promise<void> {
  const body: Command = { commandId: crypto.randomUUID(), ...cmd };
  const res = await fetch("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`postCommand: ${res.status} ${res.statusText}`);
}
