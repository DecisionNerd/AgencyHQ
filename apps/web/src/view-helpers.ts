// Pure view helpers — no DOM, no React. Fully unit-testable with node:test.

import type { Freshness, Item, State, Stop } from "./api.js";

/** Format a State into a human-readable string: "label (source, timestamp)". */
export function formatState(state: State): string {
  const ts = state.at ? new Date(state.at).toLocaleString() : "no timestamp";
  return `${state.label} (${state.source}, ${ts})`;
}

/** Render a stop badge string, including checkpoint commit when present. */
export function stopBadge(stop: Stop): string {
  const base = `[${stop.state}]`;
  if (stop.checkpointCommit) {
    return `${base} checkpoint: ${stop.checkpointCommit.slice(0, 8)}`;
  }
  return base;
}

/** Return true when freshness indicates the data is stale relative to now. */
export function isStale(freshness: Freshness, now: Date, thresholdMs: number): boolean {
  if (freshness.stale) return true;
  if (!freshness.lastPollAt) return true;
  const pollTime = new Date(freshness.lastPollAt).getTime();
  return now.getTime() - pollTime > thresholdMs;
}

/**
 * Order items: mainEffort first, then changed items, then continuing.
 * Items in `changed` come before items in `continuing` when both lists are given.
 */
export function orderItems(
  changed: Item[],
  continuing: Item[],
  mainEffortId: string | null,
): Item[] {
  const all = [...changed, ...continuing];
  if (!mainEffortId) return all;

  const mainIdx = all.findIndex((i) => i.workItemId === mainEffortId);
  if (mainIdx <= 0) return all;

  const main = all[mainIdx];
  if (!main) return all;
  all.splice(mainIdx, 1);
  return [main, ...all];
}
