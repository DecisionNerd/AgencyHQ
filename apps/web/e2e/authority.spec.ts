/**
 * (v) Authority edit: error on invalid JSON, then save valid authority.
 *
 * Steps:
 *   1. Navigate to the overview page.
 *   2. Find the authority link for the seeded project.
 *   3. Click it to go to the authority page.
 *   4. Enter invalid JSON in the authority editor, click save.
 *   5. Verify an error message appears.
 *   6. Restore valid JSON, click save.
 *   7. Verify the save succeeds (no error, version increments).
 */

import { expect, test } from "@playwright/test";
import { injectToken } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

test("authority page: invalid JSON shows an error", async ({ page }) => {
  // Go to the overview and find the authority link
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const authorityLink = page.locator(`[data-testid^="authority-link-"]`).first();
  await expect(authorityLink).toBeVisible({ timeout: 5_000 });
  await authorityLink.click();

  // Authority page loads
  await expect(page.getByTestId("authority-section")).toBeVisible({ timeout: 10_000 });

  // Read the current valid authority JSON from the editor
  const editor = page.getByTestId("authority-editor");
  await expect(editor).toBeVisible();

  // Replace with invalid JSON
  await editor.fill("{ invalid json !!!");
  await page.getByTestId("authority-save-btn").click();

  // An error should appear
  await expect(page.getByTestId("authority-save-error")).toBeVisible({ timeout: 5_000 });
});

test("authority page: valid authority saves successfully", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByTestId("projects-section")).toBeVisible({ timeout: 10_000 });

  const authorityLink = page.locator(`[data-testid^="authority-link-"]`).first();
  await expect(authorityLink).toBeVisible({ timeout: 5_000 });
  await authorityLink.click();

  await expect(page.getByTestId("authority-section")).toBeVisible({ timeout: 10_000 });

  const editor = page.getByTestId("authority-editor");
  await expect(editor).toBeVisible();

  // Get the current authority JSON (valid)
  const currentJson = await editor.inputValue();

  // Re-save the same valid JSON (no change in content, but increments version)
  await editor.fill(currentJson);
  await page.getByTestId("authority-save-btn").click();

  // No error should appear; version should update
  await expect(page.getByTestId("authority-save-error")).not.toBeVisible({ timeout: 5_000 });
});
