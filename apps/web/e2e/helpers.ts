import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Ids written by apps/coordinator/scripts/seed-control-plane.ts before the server starts. */
export function seedIds(): Record<string, string> {
  const file =
    process.env.AGENCYHQ_SEED_IDS_FILE ??
    resolve(dirname(fileURLToPath(import.meta.url)), ".seed-ids.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}
