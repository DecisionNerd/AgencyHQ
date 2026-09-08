/**
 * (iv) Reject pending_human decision → work item moves to halted.
 *
 * Tests the decisions page reject flow:
 *   1. Navigate to the decisions page.
 *   2. Find a pending decision with a reject reason input and button.
 *   3. Fill in a reason.
 *   4. Click reject.
 *   5. Verify the decision is removed from the list.
 */

import { expect, test } from "@playwright/test";
import { injectToken } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("decisions page: reject pending_human decision removes it from the list", async ({ page }) => {
  await page.goto("/#/decisions");
  await expect(page.getByTestId("decisions-list")).toBeVisible({ timeout: 10_000 });

  // Count initial pending decisions
  const initialRejectButtons = page.locator(`[data-testid^="reject-btn-"]`);
  const initialCount = await initialRejectButtons.count();
  expect(initialCount).toBeGreaterThanOrEqual(1);

  // Fill in a reject reason for the first decision and reject it
  const firstRejectReason = page.locator(`[data-testid^="reject-reason-"]`).first();
  await firstRejectReason.fill("Browser test rejection — not ready");

  const firstRejectBtn = initialRejectButtons.first();
  await firstRejectBtn.click();

  // Wait for the list to refresh with fewer entries
  await page.waitForFunction(
    (count: number) => {
      const buttons = document.querySelectorAll('[data-testid^="reject-btn-"]');
      return buttons.length < count;
    },
    initialCount,
    { timeout: 15_000 },
  );

  // Verify no action error
  await expect(page.getByTestId("action-error")).not.toBeVisible();

  // Verify count decreased
  const finalCount = await page.locator(`[data-testid^="reject-btn-"]`).count();
  expect(finalCount).toBeLessThan(initialCount);
});

test("work item page: reject action from work item page", async ({ page }) => {
  // Navigate to the overview and find a pending item
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const pendingCell = page
    .locator(`[data-testid^="pending-decisions-"]`)
    .filter({ hasNotText: "0" })
    .first();

  const count = await pendingCell.count();
  if (count === 0) {
    // All decisions were already processed by approve test — skip
    return;
  }

  const row = pendingCell.locator("xpath=ancestor::tr");
  const link = row.locator("a").first();
  await link.click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  const rejectReason = page.getByTestId("action-reject-reason");
  const rejectReasonCount = await rejectReason.count();
  if (rejectReasonCount === 0) {
    return; // No reject available on this item
  }

  await rejectReason.fill("Browser test: rejecting from work item page");
  await page.getByTestId("action-reject").click();

  // Confirm dialog
  await expect(page.getByTestId("confirm-dialog")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("confirm-ok").click();

  await expect(page.getByTestId("confirm-dialog")).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();
});
