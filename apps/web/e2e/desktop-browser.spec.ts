import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("shared Browser workspace isolates scopes, restores tabs and hides the native viewport for overlays", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html");
  const address = page.getByRole("textbox", { name: "Browser address" });
  await expect(address).toBeVisible();
  await address.fill("localhost:3000"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/");
  await expect(page.getByRole("tab", { name: "localhost:3000" })).toBeVisible();
  await page.getByRole("button", { name: "Allow agent control", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Agent control available");
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(true);
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.getByText("Recorded browser evidence", { exact: true })).toBeVisible();
  await expect(address).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(false);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/");
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(true);
  await page.getByRole("button", { name: "Open approval overlay" }).click();
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(false);
  await page.getByRole("button", { name: "Dismiss approval overlay" }).click();
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(true);
  for (const surface of ["channel", "teammate_direct"] as const) {
    await page.getByRole("button", { name: surface, exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(0); await expect(address).toHaveValue("");
    await address.fill("https://example.com"); await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(address).toHaveValue("https://example.com/");
  }
  await page.getByRole("button", { name: "normal_conversation", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/"); await expect(page.getByRole("tab")).toHaveCount(1);
  await page.getByRole("button", { name: "Open a browser tab", exact: true }).click();
  await address.fill("https://example.com/second"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Close browser tab" }).last().click();
  await expect(address).toHaveValue("http://localhost:3000/");
  await address.fill("javascript:alert(1)"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not complete");
  await page.evaluate(() => window.browserFixture.dispose());
  expect(await page.evaluate(() => window.browserFixture.subscriptions())).toBe(0);
  expect(await page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(false);
});

for (const locale of ["en-US", "zh-CN"] as const) for (const colorScheme of ["light", "dark"] as const) {
  test(`Browser layout supports ${locale} ${colorScheme} at desktop sizes`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(locale => { localStorage.setItem("ling-stack.locale", locale); localStorage.setItem("ling-stack.themePreference", "system"); }, locale);
    await page.goto("/e2e/support/desktop-browser.html");
    const address = page.getByRole("textbox", { name: locale === "en-US" ? "Browser address" : "浏览器地址" });
    await expect(address).toBeVisible();
    for (const viewport of [{ width: 1440, height: 960 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.locator(".browser-workspace").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      const evidence = resolve("../../output/playwright/desktop-browser"); await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${locale}-${colorScheme}-${viewport.width}.png` });
    }
  });
}

test("Web clients retain browser evidence without an interactive address bar", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html?web");
  await expect(page.getByText("Recorded browser evidence", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Browser address" })).toHaveCount(0);
});
