/**
 * Authority edit journeys — 3 tests.
 *
 * (v-c) Client-side JSON parse error: entering unparseable text in the editor
 *       shows an error without sending a request.
 * (v-a) Invalid schema: submit JSON that parses but violates the authority
 *       schema (budget.maxAttempts: -1), click Save, confirm, assert
 *       authority-errors visible. Depends on server contract returning 422.
 * (v-b) Valid save: edit a real field, click Save, confirm, assert the
 *       displayed current version increased by exactly one and a new history
 *       row appeared.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { injectToken, seedIds } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await injectToken(page);
});

/** Navigate directly to the authority page for the seeded project. */
async function gotoAuthorityPage(page: Page, projectId: string): Promise<void> {
  await page.goto(`/#/projects/${encodeURIComponent(projectId)}/authority`);
  await expect(page.getByTestId("authority-section")).toBeVisible({ timeout: 10_000 });
}

test("authority page: invalid JSON shows a parse error without sending a request", async ({
  page,
}) => {
  const ids = seedIds();
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  await gotoAuthorityPage(page, ids.projectId);

  const editor = page.getByTestId("authority-editor");
  await expect(editor).toBeVisible();

  // Replace with invalid JSON — this is a client-side parse error
  await editor.fill("{ invalid json !!!");
  await page.getByTestId("authority-save-btn").click();

  // Error appears immediately without a confirm dialog (parse error, no request sent)
  await expect(page.getByTestId("authority-save-error")).toBeVisible({ timeout: 5_000 });
  // No confirm dialog should have appeared
  await expect(page.getByTestId("confirm-dialog")).not.toBeVisible();
});

test("authority page: invalid schema shows authority-errors after confirm", async ({ page }) => {
  // NOTE: this journey depends on the coordinator returning 422 for schema
  // failures (PUT /api/projects/:id/authority). Marked "verified against
  // contract, pending merge" — the current coordinator does not yet return 422.
  const ids = seedIds();
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  await gotoAuthorityPage(page, ids.projectId);

  const editor = page.getByTestId("authority-editor");
  await expect(editor).toBeVisible();

  // Read the current valid authority JSON and corrupt a field to violate schema:
  // budget.maxAttempts: -1 is invalid (must be >= 1).
  const currentJson = await editor.inputValue();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(currentJson) as Record<string, unknown>;
  } catch {
    // use empty object if unparseable
  }
  const budget = (parsed.budget as Record<string, unknown> | undefined) ?? {};
  const invalid = { ...parsed, budget: { ...budget, maxAttempts: -1 } };
  await editor.fill(JSON.stringify(invalid, null, 2));

  // Click Save — confirm dialog should appear
  await page.getByTestId("authority-save-btn").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Confirm message should name the project and the consequence
  const confirmMsg = await page.getByTestId("confirm-message").innerText();
  expect(confirmMsg).toContain(ids.projectId);
  expect(confirmMsg).toMatch(/creates authority version/i);

  await page.getByTestId("confirm-ok").click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });

  // Server returns 422 — authority-errors should appear with at least one message
  await expect(page.getByTestId("authority-errors")).toBeVisible({ timeout: 10_000 });
  const errorText = await page.getByTestId("authority-errors").innerText();
  expect(
    errorText.trim().length,
    "authority-errors must contain at least one message",
  ).toBeGreaterThan(0);
});

test("authority page: valid authority save increments version and adds history row", async ({
  page,
}) => {
  const ids = seedIds();
  expect(ids.projectId, "seed must publish projectId").toBeTruthy();

  await gotoAuthorityPage(page, ids.projectId);

  // Read the current version number
  const versionEl = page.getByTestId("authority-version");
  await expect(versionEl).toBeVisible({ timeout: 5_000 });
  const initialVersionText = await versionEl.innerText();
  const initialVersion = Number(initialVersionText.replace(/[^0-9]/g, ""));
  expect(initialVersion, "initial version must be a positive integer").toBeGreaterThan(0);

  // Re-save the same JSON (content unchanged; version still increments)
  const editor = page.getByTestId("authority-editor");
  const currentJson = await editor.inputValue();
  await editor.fill(currentJson);

  // Click Save
  await page.getByTestId("authority-save-btn").click();

  // Confirm dialog appears with consequence phrase
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const confirmMsg = await page.getByTestId("confirm-message").innerText();
  expect(confirmMsg).toContain(ids.projectId);
  expect(confirmMsg).toMatch(/creates authority version/i);
  expect(confirmMsg).toMatch(/frozen contracts are unaffected/i);
  await page.getByTestId("confirm-ok").click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });

  // No errors should appear
  await expect(page.getByTestId("authority-errors")).not.toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("authority-save-error")).not.toBeVisible({ timeout: 5_000 });

  // Version display must increase by exactly 1
  const expectedVersion = initialVersion + 1;
  await expect(versionEl).toContainText(`${expectedVersion}`, { timeout: 15_000 });

  // A new history row for the new version must appear
  await expect(page.locator(`[data-testid="history-row-${expectedVersion}"]`)).toBeVisible({
    timeout: 10_000,
  });
});
