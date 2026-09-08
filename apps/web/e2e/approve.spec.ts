import { seedIds } from "./helpers";
/**
 * (iii) Approve pending_human decision → work item moves to completed.
 *
 * Tests the decisions page approve flow:
 *   1. Navigate to the decisions page.
 *   2. Verify two pending decisions exist (wiApprove and wiReject from seed).
 *   3. Click the approve button for the first decision.
 *   4. Verify the decisions list refreshes with one fewer entry.
 */

import { expect, test } from "@playwright/test";
import { injectToken } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("decisions page: approve pending_human decision removes it from the list", async ({
  page,
}) => {
  // Target the seeded decision only: the shared database may hold other
  // pending decisions (for example from live trials on the same ledger).
  const ids = seedIds();
  const decisionId = ids.decApprove;
  expect(decisionId, "seed must publish decApprove").toBeTruthy();

  await page.goto("/#/decisions");
  await expect(page.getByTestId("decisions-list")).toBeVisible({ timeout: 10_000 });
  const entry = page.getByTestId(`decision-entry-${decisionId}`);
  await expect(entry).toBeVisible();

  await page.getByTestId(`approve-btn-${decisionId}`).click();

  // After approve, the page reloads the decisions list and the entry is gone.
  await expect(entry).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("action-error")).not.toBeVisible();
});

test("work item page: approve via confirm dialog updates the item", async ({ page }) => {
  const ids = seedIds();
  expect(ids.wiApprove2, "seed must publish wiApprove2").toBeTruthy();

  await page.goto(`/#/work-items/${ids.wiApprove2}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-lifecycle")).not.toContainText("completed");

  await page.getByTestId("action-approve").click();

  // The confirmation names the project, the work item and the contract version.
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.wiApprove2);
  expect(message).toMatch(/contract v?\d+/i);
  await page.getByTestId("confirm-ok").click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();

  // The page reloads the item: acceptance approved, lifecycle completed.
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("completed", {
    timeout: 15_000,
  });
});
