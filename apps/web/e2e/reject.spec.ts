/**
 * Reject journeys — 3 tests.
 *
 * (iv-a) Decisions page: reject pending_human decision via confirm dialog →
 *        decision removed from list, work item lifecycle becomes "halted";
 *        confirm message names project, work item, and consequence phrase.
 * (iv-b) Work item page: reject action → confirm dialog → lifecycle halted;
 *        confirm message names project, work item, and consequence phrase.
 * (iv-c) U-7: reject with an empty reason — button is disabled; dialog never
 *        opens; no request is sent; lifecycle is unchanged.
 */

import { expect, test } from "@playwright/test";
import { injectToken, seedIds } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("decisions page: reject pending_human decision removes it from the list", async ({ page }) => {
  const ids = seedIds();
  expect(ids.decReject, "seed must publish decReject").toBeTruthy();
  expect(ids.wiReject, "seed must publish wiReject").toBeTruthy();
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  await page.goto("/#/decisions");
  await expect(page.getByTestId("decisions-list")).toBeVisible({ timeout: 10_000 });
  const entry = page.getByTestId(`decision-entry-${ids.decReject}`);
  await expect(entry).toBeVisible({ timeout: 5_000 });

  await page
    .getByTestId(`reject-reason-${ids.decReject}`)
    .fill("Browser test rejection — not ready");
  await page.getByTestId(`reject-btn-${ids.decReject}`).click();

  // A confirm dialog appears — assert it names the project, work item, and consequence.
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.projectId);
  expect(message).toContain(ids.wiReject);
  expect(message).toMatch(/halts the work item/i);
  await page.getByTestId("confirm-ok").click();

  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
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
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  await page.goto(`/#/work-items/${ids.wiReject2}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  await page
    .getByTestId("action-reject-reason")
    .fill("Browser test: rejecting from work item page");
  await page.getByTestId("action-reject").click();

  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.projectId);
  expect(message).toContain(ids.wiReject2);
  expect(message).toMatch(/halts the work item/i);
  await page.getByTestId("confirm-ok").click();

  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("halted", {
    timeout: 15_000,
  });
});

test("work item page: reject button is disabled when reason is empty", async ({ page }) => {
  // U-7: no placeholder — the reject button must be disabled until a non-empty
  // trimmed reason is provided. No confirm dialog opens; no request is sent;
  // lifecycle is unchanged.
  const ids = seedIds();
  // Use wiPending: it has a pending_human decision that no other journey consumes.
  expect(ids.wiPending, "seed must publish wiPending").toBeTruthy();

  await page.goto(`/#/work-items/${encodeURIComponent(ids.wiPending)}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  // Lifecycle is running — this is what we assert is unchanged at the end.
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("running");

  // Reason input must be empty initially
  const reasonInput = page.getByTestId("action-reject-reason");
  await expect(reasonInput).toBeVisible({ timeout: 5_000 });
  await expect(reasonInput).toHaveValue("");

  // Reject button must be disabled when reason is empty
  // NOTE: action-reject is only rendered when openPendingDecisions is non-empty.
  // This journey depends on the coordinator sending openPendingDecisions.
  // If the button is not visible (old server), the test is marked pending merge.
  const rejectBtn = page.getByTestId("action-reject");
  await expect(rejectBtn).toBeVisible({ timeout: 5_000 });
  await expect(rejectBtn).toBeDisabled();

  // No confirm dialog should be open
  await expect(page.getByTestId("confirm-dialog")).not.toBeVisible();

  // Lifecycle is still running (no request was sent)
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("running");
});
