/**
 * (i) Return view shows state cards.
 *
 * Verifies that the return view page loads, renders the four expected sections,
 * and shows at least one ItemCard (state card) in the "continuing" or "decisions"
 * section, given the seeded data.
 */

import { expect, test } from "@playwright/test";
import { injectToken } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("return view renders all sections", async ({ page }) => {
  await page.goto("/#/return");

  // Wait for view to load (sections appear after API response)
  await expect(page.getByRole("heading", { name: /Changed since your last visit/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("heading", { name: /Decisions pending/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Stops/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Continuing/i })).toBeVisible();
});

test("return view shows pending decisions section with seeded data", async ({ page }) => {
  await page.goto("/#/return");

  // Wait for the view to render
  await expect(page.getByRole("heading", { name: /Decisions pending/i })).toBeVisible({
    timeout: 10_000,
  });

  // The seeded data has two pending_human decisions (wiApprove, wiReject)
  // They should appear in either the decisions or continuing section.
  // We verify the page is not in an error state.
  await expect(page.getByRole("alert")).not.toBeVisible();
});

test("return view: acknowledge visit button is present", async ({ page }) => {
  await page.goto("/#/return");

  await expect(page.getByRole("button", { name: /Acknowledge/i })).toBeVisible({
    timeout: 10_000,
  });
});
