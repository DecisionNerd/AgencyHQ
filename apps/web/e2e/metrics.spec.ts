/**
 * Metrics and capacity journeys — 2 tests.
 *
 * (a) #/metrics: asserts the metrics table renders with at least the seeded
 *     project's row (data-testid="metrics-row-<projectId>"). "Not available"
 *     text must NOT appear — the seeded ledger always has data.
 *
 * (b) Overview capacity panel: asserts the capacity panel renders and contains
 *     the seeded provider capacity row (data-testid="capacity-row-openai-gpt-5.6-sol").
 *     The seed script inserts a valid openai/gpt-5.6-sol capacity row so this
 *     assertion is deterministic regardless of live coordinator state.
 */

import { expect, test } from "@playwright/test";
import { injectToken, seedIds } from "./helpers.ts";

const ids = seedIds();

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("metrics page: table renders with seeded project row", async ({ page }) => {
  await page.goto("/#/metrics");

  // Wait for the metrics section heading to appear
  await expect(page.getByRole("heading", { name: /Lead quality metrics/i })).toBeVisible({
    timeout: 10_000,
  });

  // The metrics table must be visible — "not available" is a failure condition.
  const table = page.getByTestId("metrics-table");
  await expect(table).toBeVisible({ timeout: 5_000 });

  // The seeded project's row must be present.
  const projectRow = page.getByTestId(`metrics-row-${ids.projectId}`);
  await expect(projectRow).toBeVisible({ timeout: 5_000 });

  // No uncaught error alert
  await expect(page.getByRole("alert")).not.toBeVisible();
});

test("overview: capacity panel renders with seeded capacity row", async ({ page }) => {
  await page.goto("/#/");

  // Wait for overview to load (campaigns section is always rendered)
  await expect(page.getByTestId("campaigns-section")).toBeVisible({ timeout: 10_000 });

  // Capacity panel must be present
  const panel = page.getByTestId("capacity-panel");
  await expect(panel).toBeVisible({ timeout: 5_000 });

  // The seeded openai/gpt-5.6-sol capacity row must appear.
  // The seed script inserts this row with a valid validUntil so it's always returned.
  const capacityRow = panel.getByTestId("capacity-row-openai-gpt-5.6-sol");
  await expect(capacityRow).toBeVisible({ timeout: 5_000 });
});
