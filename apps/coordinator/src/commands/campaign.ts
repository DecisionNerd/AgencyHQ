/**
 * Campaign commands:
 *  - createCampaign: create a named campaign.
 *  - assignCampaign: assign a work item to a campaign.
 *  - setMainEffort: set the main-effort work item for a campaign.
 *  - setWorkItemRank: update a work item's rank with optimistic locking.
 *
 * All commands are idempotent by commandId (R-010).
 *
 * NOTE: This module writes SQL directly against the campaigns table and
 * work_items.campaign_id column introduced in migration 0004, because
 * packages/db repos for these are being added in a parallel packet.
 * Swap to @agencyhq/db repo imports when the merge packet lands.
 */

import { claimCommand, completeCommand } from "@agencyhq/db";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type CampaignDeps = {
  pool: pg.Pool;
};

// ---------------------------------------------------------------------------
// createCampaign
// ---------------------------------------------------------------------------

export type CreateCampaignInput = {
  commandId: string;
  name: string;
};

export type CreateCampaignResult =
  | { ok: true; campaignId: string; replayed?: boolean }
  | { ok: false; reason: string; replayed?: boolean };

export async function createCampaign(
  deps: CampaignDeps,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  const { commandId, name } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "create_campaign");
    if (!claim.claimed) {
      const stored = claim.result as CreateCampaignResult;
      return { ...stored, replayed: true };
    }

    const campaignId = `cmp-${commandId.slice(0, 8)}`;

    await client.query(
      `INSERT INTO campaigns (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [campaignId, name],
    );

    const result: CreateCampaignResult = { ok: true, campaignId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// assignCampaign
// ---------------------------------------------------------------------------

export type AssignCampaignInput = {
  commandId: string;
  workItemId: string;
  campaignId: string;
};

export type AssignCampaignResult =
  | { ok: true; replayed?: boolean }
  | { ok: false; reason: "not_found"; replayed?: boolean };

export async function assignCampaign(
  deps: CampaignDeps,
  input: AssignCampaignInput,
): Promise<AssignCampaignResult> {
  const { commandId, workItemId, campaignId } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "assign_campaign");
    if (!claim.claimed) {
      const stored = claim.result as AssignCampaignResult;
      return { ...stored, replayed: true };
    }

    // Check campaign exists
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    if (rows.length === 0) {
      const result: AssignCampaignResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    await client.query(`UPDATE work_items SET campaign_id = $1, updated_at = now() WHERE id = $2`, [
      campaignId,
      workItemId,
    ]);

    const result: AssignCampaignResult = { ok: true };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// setMainEffort
// ---------------------------------------------------------------------------

export type SetMainEffortInput = {
  commandId: string;
  campaignId: string;
  workItemId: string;
};

export type SetMainEffortResult =
  | { ok: true; replayed?: boolean }
  | { ok: false; reason: "not_found"; replayed?: boolean };

export async function setMainEffort(
  deps: CampaignDeps,
  input: SetMainEffortInput,
): Promise<SetMainEffortResult> {
  const { commandId, campaignId, workItemId } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "set_main_effort");
    if (!claim.claimed) {
      const stored = claim.result as SetMainEffortResult;
      return { ...stored, replayed: true };
    }

    const { rows } = await client.query<{ id: string }>(`SELECT id FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    if (rows.length === 0) {
      const result: SetMainEffortResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    await client.query(
      `UPDATE campaigns SET main_effort_work_item_id = $1, updated_at = now() WHERE id = $2`,
      [workItemId, campaignId],
    );

    const result: SetMainEffortResult = { ok: true };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// setWorkItemRank
// ---------------------------------------------------------------------------

export type SetWorkItemRankInput = {
  commandId: string;
  workItemId: string;
  rank: number;
  expectedVersion: number;
};

export type SetWorkItemRankResult =
  | { ok: true; replayed?: boolean }
  | { ok: false; reason: "stale_version" | "not_found"; replayed?: boolean };

export async function setWorkItemRank(
  deps: CampaignDeps,
  input: SetWorkItemRankInput,
): Promise<SetWorkItemRankResult> {
  const { commandId, workItemId, rank, expectedVersion } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "set_rank");
    if (!claim.claimed) {
      const stored = claim.result as SetWorkItemRankResult;
      return { ...stored, replayed: true };
    }

    // Load current version for optimistic locking
    const { rows: wiRows } = await client.query<{ version: number }>(
      `SELECT version FROM work_items WHERE id = $1`,
      [workItemId],
    );

    if (wiRows.length === 0) {
      const result: SetWorkItemRankResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    const currentVersion = wiRows[0]?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      const result: SetWorkItemRankResult = { ok: false, reason: "stale_version" };
      await completeCommand(client, commandId, result);
      return result;
    }

    await client.query(`UPDATE work_items SET rank = $1, updated_at = now() WHERE id = $2`, [
      rank,
      workItemId,
    ]);

    const result: SetWorkItemRankResult = { ok: true };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
