// Pure view helpers — no DOM, no React. Fully unit-testable with node:test.

import type { Freshness, IntegrationInfo, Item, ManifestInfo, State, Stop } from "./api.js";

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

/** Truncate a full SHA to 7 characters, or return null when sha is null/empty. */
export function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}

/** Format a manifest as "Manifest n/m", or null when manifest is null. */
export function manifestLabel(manifest: ManifestInfo | null): string | null {
  if (!manifest) return null;
  return `Manifest ${manifest.resolved}/${manifest.total}`;
}

export interface IntegrationCardModel {
  label: string;
  iconKey: "pending" | "integrated" | "failed";
  outcome: string | null;
  targetRef: string | null;
  shortRevision: string | null;
  fullRevision: string | null;
  at: string | null;
  source: string;
}

const INTEGRATION_LABELS: Record<IntegrationInfo["state"], string> = {
  pending: "Pending integration",
  integrated: "Integrated",
  failed: "Integration failed",
};

/**
 * Build a model for the integration state card, or null when integration is absent.
 * Suitable for rendering without DOM or React dependency.
 */
export function integrationCardModel(item: Item): IntegrationCardModel | null {
  const { integration } = item;
  if (!integration) return null;

  return {
    label: INTEGRATION_LABELS[integration.state],
    iconKey: integration.state,
    outcome: integration.outcome,
    targetRef: integration.targetRef,
    shortRevision: shortSha(integration.resultingRevision),
    fullRevision: integration.resultingRevision,
    at: integration.at,
    source: integration.source,
  };
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
