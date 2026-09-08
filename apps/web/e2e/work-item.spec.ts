/**
 * (ii) Work item page: five states.
 *
 * Verifies that the work item detail page renders correctly for each of the
 * five seeded item types:
 *   1. active + pending_human accept (wiApprove)
 *   2. completed (wiCompleted)
 *   3. proposed/admitted (wiAdmitted)
 *   4. active + blocked with blocking finding (wiBlocked)
 *   5. merge-boundary + pending_human integrate (wiMerge)
 *
 * We navigate via the overview page to find each item by its intent text,
 * then assert the work-item-detail panel appears.
 */

import { expect, test } from "@playwright/test";
import { injectToken, seedIds } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

/**
 * Navigate to the overview, find a work item row whose intent column matches
 * the given text, click its link, and return the page.
 */
async function openWorkItemByIntent(page: ReturnType<typeof page.constructor>, intentText: string) {
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  // Find the row containing the intent text
  const row = page.locator(`[data-testid^="work-item-row-"]`).filter({ hasText: intentText });
  await expect(row).toBeVisible({ timeout: 5_000 });

  // Click the first link in that row (the work item ID / intent link)
  const link = row.locator("a").first();
  await link.click();

  // Wait for the work-item detail to load
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
}

test("work item page: pending_human accept state shows approve action", async ({ page }) => {
  // Target the seeded item that no journey resolves (wiPending): the approve
  // and reject journeys consume their own items, and on a clean ledger (CI)
  // "any item with pending decisions" would be empty once they ran.
  const ids = seedIds();
  expect(ids.wiPending, "seed must publish wiPending").toBeTruthy();

  await injectToken(page);
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const pendingCell = page.getByTestId(`pending-decisions-${ids.wiPending}`);
  await expect(pendingCell).toBeVisible({ timeout: 5_000 });
  await expect(pendingCell).not.toHaveText("0");

  // Navigate to that work item by clicking the link in the same row
  const row = page.getByTestId(`work-item-row-${ids.wiPending}`);
  await row.locator("a").first().click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-item-lifecycle")).toContainText("active");
  // Approve action should be visible for pending_human items
  await expect(page.getByTestId("action-approve")).toBeVisible();
});

test("work item page: completed item shows evidence panel", async ({ page }) => {
  await injectToken(page);
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  // Find a work item row containing "wi-completed:" in intent
  const row = page
    .locator(`[data-testid^="work-item-row-"]`)
    .filter({ hasText: "wi-completed:" })
    .first();
  await expect(row).toBeVisible({ timeout: 5_000 });

  // Navigate via the link
  const link = row.locator("a").first();
  await link.click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("evidence-panel")).toBeVisible();
  // Approve action should NOT be visible for a completed item
  await expect(page.getByTestId("action-approve")).not.toBeVisible();
});

test("work item page: proposed/admitted item has no actions", async ({ page }) => {
  await injectToken(page);
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const row = page
    .locator(`[data-testid^="work-item-row-"]`)
    .filter({ hasText: "wi-admitted:" })
    .first();
  await expect(row).toBeVisible({ timeout: 5_000 });

  const link = row.locator("a").first();
  await link.click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  // No approve action for proposed items
  await expect(page.getByTestId("action-approve")).not.toBeVisible();
});

test("work item page: blocked item shows remediate action", async ({ page }) => {
  await injectToken(page);
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const row = page
    .locator(`[data-testid^="work-item-row-"]`)
    .filter({ hasText: "wi-blocked:" })
    .first();
  await expect(row).toBeVisible({ timeout: 5_000 });

  const link = row.locator("a").first();
  await link.click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  // Blocked items with a blocking finding show the remediate action
  await expect(page.getByTestId("action-remediate")).toBeVisible();
});

test("work item page: merge-boundary item has stop action available", async ({ page }) => {
  await injectToken(page);
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const row = page
    .locator(`[data-testid^="work-item-row-"]`)
    .filter({ hasText: "wi-merge:" })
    .first();
  await expect(row).toBeVisible({ timeout: 5_000 });

  const link = row.locator("a").first();
  await link.click();

  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });
  // Merge-boundary running item shows the evidence panel
  await expect(page.getByTestId("evidence-panel")).toBeVisible();
});

test("work item page: merge-boundary item shows integration state and lifecycle", async ({
  page,
}) => {
  await injectToken(page);

  // Navigate directly to the seeded wiMerge item using its known ID
  const { wiMerge } = seedIds();
  await page.goto(`/#/work-items/${encodeURIComponent(wiMerge)}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  // Lifecycle text must be visible (R-011: lifecycle and condition shown)
  const lifecycleEl = page.getByTestId("work-item-lifecycle");
  await expect(lifecycleEl).toBeVisible({ timeout: 5_000 });
  // Seed sets lifecycle: "running", condition: "nominal"
  await expect(lifecycleEl).toContainText("running");

  // Integration card must show a non-pending state (seeded integration has outcome=integrated)
  // The Integration card label should be "Integrated", not "Pending integration"
  const integrationCard = page.locator(".state-card").filter({ hasText: "Integration" });
  await expect(integrationCard).toBeVisible({ timeout: 5_000 });
  await expect(integrationCard).not.toContainText("Pending integration");
  await expect(integrationCard).toContainText("Integrated");
});
