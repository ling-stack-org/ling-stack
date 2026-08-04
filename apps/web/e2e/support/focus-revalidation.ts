import type { Page } from "@playwright/test";

export async function triggerFocusRevalidation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & { __lingFocusRevalidationOffset?: number };
    const currentNow = Date.now;
    testWindow.__lingFocusRevalidationOffset = (testWindow.__lingFocusRevalidationOffset ?? 0) + 20_000;
    Date.now = () => currentNow() + (testWindow.__lingFocusRevalidationOffset ?? 0);
    window.dispatchEvent(new Event("focus"));
    Date.now = currentNow;
  });
}
