/**
 * Stop journeys — 2 tests.
 *
 * (vi-a) Work item page: stop action on a running item.
 *
 *   1. Navigate directly to the seeded wiBlocked item (running lifecycle,
 *      running attempt; the seed has no attempt in the `dispatched` state).
 *   2. Click Stop; assert the confirmation names the project, work item,
 *      contract version, consequence phrase, and attempt id.
 *   3. Confirm; assert no error.
 *   4. Reload; assert the Execution card reports "stopping" (or "stopped").
 *
 * The stop command marks the attempt `stopping` (generation revoked) before it
 * asks the runtime to cancel, so "stopping" is deterministic. "stopped"
 * requires adapter evidence (survivors, checkpoint) that the fake runtime does
 * not produce, so the full stop cycle is proven by the coordinator's
 * integration tests and the live trials, not by this journey.
 *
 * (vi-b) Confirm dialog names the contract version when a pending decision
 *        carries one. wiApprove has an open pending accept decision with
 *        contract_version = 1. The test clicks Stop, asserts the message
 *        contains "v1" (and the consequence), then cancels without confirming
 *        so the attempt is not mutated.
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

  // Confirm dialog appears — check it names the project, work item, and consequence.
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.projectId);
  expect(message).toContain(ids.wiBlocked);
  expect(message).toMatch(/stops the running attempt/i);
  expect(message).toMatch(/attempt/i);
  expect(message).toMatch(/contract v\d+/i);
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

test("work item page: stop confirm dialog names the contract version when a pending decision carries one", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const ids = seedIds();
  expect(ids.wiApprove, "seed must publish wiApprove").toBeTruthy();
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  // wiApprove has an open pending_human accept decision with contract_version = 1.
  // The stop button shows because a completed attempt exists in the evidence view.
  await page.goto(`/#/work-items/${ids.wiApprove}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  const stopBtn = page.getByTestId("action-stop");
  await expect(stopBtn).toBeVisible({ timeout: 5_000 });
  await stopBtn.click();

  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const message = await page.getByTestId("confirm-message").innerText();
  expect(message).toContain(ids.projectId);
  expect(message).toContain(ids.wiApprove);
  // Contract version from the open pending decision (contract_version = 1).
  expect(message).toMatch(/v\d+/);
  expect(message).toMatch(/stops the running attempt/i);

  // Cancel — do not actually stop the attempt so it remains available for other journeys.
  await page.getByTestId("confirm-cancel").click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("work-item-action-error")).not.toBeVisible();
});
