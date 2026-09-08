/**
 * Metrics and capacity journeys — 2 tests.
 *
 * (a) #/metrics: opens the metrics page and asserts either the metrics table
 *     (data-testid="metrics-table") is present, or the "not available" text is
 *     shown. The test is deterministic on the seeded ledger regardless of
 *     whether the coordinator route exists yet.
 *
 * (b) Overview capacity panel: navigates to #/ and asserts the capacity panel
 *     (data-testid="capacity-panel") renders, containing either capacity rows
 *     or a "no capacity observations" notice.
 */

import { expect, test } from "@playwright/test";
import { injectToken } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("metrics page: shows metrics table or 'not available' text", async ({ page }) => {
  await page.goto("/#/metrics");

  // Wait for the metrics section heading to appear
  await expect(page.getByRole("heading", { name: /Lead quality metrics/i })).toBeVisible({
    timeout: 10_000,
  });

  // Either the metrics table is present, or the "not available" notice is shown.
  // Both are valid outcomes before the coordinator route is wired up.
  const table = page.getByTestId("metrics-table");
  const notAvailable = page.getByText(/not available/i);
  const noProjects = page.getByText(/No project metrics for this period/i);

  const hasTable = await table.isVisible().catch(() => false);
  const hasNotAvailable = await notAvailable.isVisible().catch(() => false);
  const hasNoProjects = await noProjects.isVisible().catch(() => false);

  expect(
    hasTable || hasNotAvailable || hasNoProjects,
    "Expected metrics table or 'not available' / 'no project metrics' text",
  ).toBe(true);

  // No uncaught error alert
  await expect(page.getByRole("alert")).not.toBeVisible();
});

test("overview: capacity panel renders with rows or 'no capacity observations' notice", async ({
  page,
}) => {
  await page.goto("/#/");

  // Wait for overview to load (campaigns section is always rendered)
  await expect(page.getByTestId("campaigns-section")).toBeVisible({ timeout: 10_000 });

  // Capacity panel must be present
  const panel = page.getByTestId("capacity-panel");
  await expect(panel).toBeVisible({ timeout: 5_000 });

  // Either rows or the empty notice
  const rows = panel.locator("[data-testid^='capacity-row-']");
  const emptyNotice = panel.getByText(/No capacity observations/i);

  const hasRows = (await rows.count()) > 0;
  const hasNotice = await emptyNotice.isVisible().catch(() => false);

  expect(hasRows || hasNotice, "Expected capacity rows or 'No capacity observations' notice").toBe(
    true,
  );
});
