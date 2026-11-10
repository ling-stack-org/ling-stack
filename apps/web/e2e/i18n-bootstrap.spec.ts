import { expect, test } from "@playwright/test";

test("localization bootstrap keeps the first visible frame free of product text", async ({ page }) => {
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });

  await page.route(/\/catalogs\/en-US\.(?:js|ts)(?:\?|$)/u, async (route) => {
    await catalogGate;
    await route.continue();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const bootstrap = page.locator("[data-i18n-bootstrap]");
  await expect(bootstrap).toBeVisible();
  await expect(bootstrap).toHaveText("");
  await expect(bootstrap).toHaveAttribute("aria-label", "Loading");

  releaseCatalog();
  await expect(bootstrap).toHaveCount(0);
});
