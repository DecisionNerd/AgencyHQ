import type { Page } from "@playwright/test";

export const API_TOKEN = "browser-test-token";

/**
 * Inject the API token into localStorage before the page hydrates.
 * Must be called before page.goto().
 */
export async function injectToken(page: Page): Promise<void> {
  await page.addInitScript((token: string) => {
    try {
      localStorage.setItem("agencyhq.apiToken", token);
    } catch {
      // ignore
    }
  }, API_TOKEN);
}
