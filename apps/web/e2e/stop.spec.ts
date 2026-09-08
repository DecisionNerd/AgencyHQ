/**
 * (vi) Stop on a dispatched/running item.
 *
 * Tests the work item page stop flow:
 *   1. Navigate to the overview.
 *   2. Find the wiBlocked item (running with a blocking finding — it has an active attempt).
 *   3. Navigate to its detail page.
 *   4. Click the stop button.
 *   5. Confirm in the dialog.
 *   6. Verify no error message appears.
 */

import { expect, test } from "@playwright/test";
import { injectToken } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("work item page: stop action on running item shows confirm dialog", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  // Find the wi-blocked row (running state with blocking finding)
  const row = page
    .locator(`[data-testid^="work-item-row-"]`)
    .filter({ hasText: "wi-blocked:" })
    .first();
  await expect(row).toBeVisible({ timeout: 5_000 });

  const link = row.locator("a").first();
  await link.click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  // The stop action should be visible for a running attempt
  const stopBtn = page.getByTestId("action-stop");
  await expect(stopBtn).toBeVisible({ timeout: 5_000 });

  await stopBtn.click();

  // Confirm dialog appears
  await expect(page.getByTestId("confirm-dialog")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("confirm-ok").click();

  // Dialog closes
  await expect(page.getByTestId("confirm-dialog")).not.toBeVisible({ timeout: 10_000 });

  // No error
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();
});
