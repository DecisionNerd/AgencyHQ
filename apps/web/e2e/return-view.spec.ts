/**
 * Return view and completed-item state cards — 4 tests.
 *
 * (i-a) Return view renders all four sections (Changed, Decisions, Stops,
 *       Continuing).
 * (i-b) Return view shows pending decisions section with seeded data (no
 *       error alert).
 * (i-c) Return view: acknowledge visit button is present.
 * (i-d) Completed item (wiCompleted): each of the four state cards shows a
 *       source text of "ledger" and a non-empty timestamp (R-011/R-019).
 */

import { expect, test } from "@playwright/test";
import { injectToken, seedIds } from "./helpers.ts";

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

test("completed item: four state cards each show 'ledger' source and a timestamp", async ({
  page,
}) => {
  // R-011: lifecycle and state dimensions shown; R-019: source and timestamp shown.
  // Navigate directly to the seeded completed work item where all four state
  // card meta lines are guaranteed to be rendered.
  const ids = seedIds();
  expect(ids.wiCompleted, "seed must publish wiCompleted").toBeTruthy();

  await page.goto(`/#/work-items/${ids.wiCompleted}`);
  await expect(page.getByTestId("work-item-detail")).toBeVisible({ timeout: 10_000 });

  // Each .state-card-meta contains "{source} · {timestamp}".
  // For a fully-completed ledger item all four should read "ledger · <date>".
  const stateCards = page.locator(".state-cards > .state-card");
  // There are exactly four (Contract, Execution, Verification, Acceptance).
  await expect(stateCards).toHaveCount(4, { timeout: 5_000 });

  for (let i = 0; i < 4; i++) {
    const meta = stateCards.nth(i).locator(".state-card-meta");
    const text = await meta.innerText();
    expect(text, `state card ${i} meta should contain 'ledger'`).toContain("ledger");
    // A date/time locale string contains at least one digit.
    expect(text, `state card ${i} meta should contain a timestamp`).toMatch(/\d/);
    expect(text, `state card ${i} meta should not say 'no timestamp'`).not.toContain(
      "no timestamp",
    );
  }
});
