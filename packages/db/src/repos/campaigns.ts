/**
 * Repository for the campaigns table and campaign-related work-item operations.
 */

import type pg from "pg";
import type { CampaignRow, WorkItemRow } from "../rows.ts";
import { CampaignRowSchema, WorkItemRowSchema } from "../rows.ts";

export interface CampaignInsert {
  id: string;
  name: string;
  main_effort_work_item_id?: string | null;
}

/** Insert a campaign row. Returns the parsed row. */
export async function insertCampaign(
  client: pg.PoolClient,
  row: CampaignInsert,
): Promise<CampaignRow> {
  const { rows } = await client.query<CampaignRow>(
    `INSERT INTO campaigns (id, name, main_effort_work_item_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [row.id, row.name, row.main_effort_work_item_id ?? null],
  );
  const first = rows[0];
  if (!first) throw new Error("insertCampaign: no row returned");
  return CampaignRowSchema.parse(first);
}

/** Get a campaign by id. Returns null if not found. */
export async function getCampaign(client: pg.PoolClient, id: string): Promise<CampaignRow | null> {
  const { rows } = await client.query<CampaignRow>("SELECT * FROM campaigns WHERE id = $1", [id]);
  const first = rows[0];
  if (!first) return null;
  return CampaignRowSchema.parse(first);
}

/** List all campaigns ordered by created_at. */
export async function listCampaigns(client: pg.PoolClient): Promise<CampaignRow[]> {
  const { rows } = await client.query<CampaignRow>("SELECT * FROM campaigns ORDER BY created_at");
  return rows.map((r) => CampaignRowSchema.parse(r));
}

/**
 * Set the main effort work item for a campaign.
 *
 * Guard: when workItemId is non-null, the work item must belong to the campaign
 * (i.e. work_items.campaign_id = campaignId). If it does not, returns
 * { ok: false, reason: "work_item_not_in_campaign" }. Passing null clears the
 * main effort unconditionally.
 *
 * Returns { ok: true, row } on success or a typed error.
 */
export async function setMainEffort(
  client: pg.PoolClient,
  campaignId: string,
  workItemId: string | null,
): Promise<
  | { ok: true; row: CampaignRow }
  | { ok: false; reason: "campaign_not_found" | "work_item_not_in_campaign" }
> {
  if (workItemId !== null) {
    // Guard: verify the work item belongs to this campaign.
    const { rows: wiRows } = await client.query<{ campaign_id: string | null }>(
      "SELECT campaign_id FROM work_items WHERE id = $1",
      [workItemId],
    );
    if (wiRows.length === 0 || wiRows[0]?.campaign_id !== campaignId) {
      return { ok: false, reason: "work_item_not_in_campaign" };
    }
  }

  const { rows } = await client.query<CampaignRow>(
    `UPDATE campaigns
        SET main_effort_work_item_id = $2, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [campaignId, workItemId],
  );
  const first = rows[0];
  if (!first) return { ok: false, reason: "campaign_not_found" };
  return { ok: true, row: CampaignRowSchema.parse(first) };
}

/**
 * Assign a work item to a campaign by setting work_items.campaign_id.
 *
 * Returns the updated WorkItemRow, or null if the work item is not found.
 */
export async function assignWorkItemToCampaign(
  client: pg.PoolClient,
  workItemId: string,
  campaignId: string | null,
): Promise<WorkItemRow | null> {
  const { rows } = await client.query<WorkItemRow>(
    `UPDATE work_items
        SET campaign_id = $2, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [workItemId, campaignId],
  );
  const first = rows[0];
  if (!first) return null;
  return WorkItemRowSchema.parse(first);
}
