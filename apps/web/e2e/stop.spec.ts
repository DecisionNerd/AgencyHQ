/**
 * Stop journey — 1 test.
 *
 * (vi) Work item page: stop action on a running item.
 *
 *   1. Navigate directly to the seeded wiBlocked item (running lifecycle,
 *      running attempt; the seed has no attempt in the `dispatched` state).
 *   2. Click Stop; assert the confirmation names the project and the work item.
 *   3. Confirm; assert no error.
 *   4. Reload; assert the Execution card reports "stopping" (or "stopped").
 *
 * The stop command marks the attempt `stopping` (generation revoked) before it
 * asks the runtime to cancel, so "stopping" is deterministic. "stopped"
 * requires adapter evidence (survivors, checkpoint) that the fake runtime does
 * not produce, so the full stop cycle is proven by the coordinator's
 * integration tests and the live trials, not by this journey.
 */

import { expect, test } from "@playwright/test";
import { injectToken, seedIds } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("work item page: stop action on running item shows confirm dialog and transitions to stopping", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const ids = seedIds();
  expect(ids.wiBlocked, "seed must publish wiBlocked").toBeTruthy();
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  // Navigate directly to the seeded running item by id.
  await page.goto(`/#/work-items/${ids.wiBlocked}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  // The stop action is visible for a running attempt.
  const stopBtn = page.getByTestId("action-stop");
  await expect(stopBtn).toBeVisible({ timeout: 5_000 });

  await stopBtn.click();

  // Confirm dialog appears — check it names the project and work item.
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.projectId);
  expect(message).toContain(ids.wiBlocked);
  expect(message).toMatch(/stops the running attempt/i);
  expect(message).toMatch(/attempt/i);
  await page.getByTestId("confirm-ok").click();

  // Dialog closes; no error.
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();

  // The stop command revokes the attempt's generation and marks the attempt
  // `stopping` before it asks the runtime to cancel, so the Execution card
  // reports "stopping" on the next load regardless of whether the fake
  // runtime ever confirms the stop. "stopped" needs adapter evidence
  // (survivors/checkpoint) that the fake runtime does not produce, so this
  // journey asserts the deterministic half of the cycle.
  await page.reload();
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  const executionCard = page.locator(".state-card").filter({ hasText: "Execution" });
  await expect(executionCard).toContainText(/stopping|stopped/, { timeout: 15_000 });
  await expect(page.getByTestId("work-item-detail")).toContainText(/stop/i);
});
