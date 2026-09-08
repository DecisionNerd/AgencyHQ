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
import { injectToken, seedIds } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("decisions page: reject pending_human decision removes it from the list", async ({ page }) => {
  const ids = seedIds();
  expect(ids.decReject, "seed must publish decReject").toBeTruthy();

  await page.goto("/#/decisions");
  await expect(page.getByTestId("decisions-list")).toBeVisible({ timeout: 10_000 });
  const entry = page.getByTestId(`decision-entry-${ids.decReject}`);
  await expect(entry).toBeVisible({ timeout: 5_000 });

  await page
    .getByTestId(`reject-reason-${ids.decReject}`)
    .fill("Browser test rejection — not ready");
  await page.getByTestId(`reject-btn-${ids.decReject}`).click();

  await expect(entry).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("action-error")).not.toBeVisible();

  // The work item is halted with the reason recorded.
  await page.goto(`/#/work-items/${ids.wiReject}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("halted");
});

test("work item page: reject action from work item page", async ({ page }) => {
  const ids = seedIds();
  expect(ids.wiReject2, "seed must publish wiReject2").toBeTruthy();

  await page.goto(`/#/work-items/${ids.wiReject2}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  await page
    .getByTestId("action-reject-reason")
    .fill("Browser test: rejecting from work item page");
  await page.getByTestId("action-reject").click();

  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.wiReject2);
  await page.getByTestId("confirm-ok").click();

  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("halted", {
    timeout: 15_000,
  });
});
