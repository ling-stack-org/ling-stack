import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /Plugin Manager|插件管理/u }).click();
  await expect(page.getByRole("region", { name: /Official|官方/u })).toBeVisible();
}

test("plugin styles keep one facade and the marketplace owns the visible surface", async () => {
  const styles = await readFile(new URL("../src/styles/plugins.css", import.meta.url), "utf8");
  for (const importName of [
    "plugin-manager-shell.css",
    "plugin-manager-toolbar.css",
    "plugin-manager-feedback.css",
    "plugin-manager-table.css",
    "plugin-detail-runtime.css",
    "plugin-runtime-sections.css",
    "plugin-cua-install.css",
  ]) {
    expect(styles).toContain(importName);
  }
});

test("catalog failure stays actionable without a fake empty plugin list", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route("**/plugins/catalog**", async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "plugin_catalog_unavailable", message: "Official plugin catalog is unavailable." },
    });
  });
  await page.goto("/");
  await openPluginManager(page);

  const status = page.locator(".plugin-marketplace-empty");
  await expect(status).toContainText("Official plugin source unavailable");
  await expect(page.locator(".plugin-marketplace-row")).toHaveCount(0);
  await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("marketplace installation, enable switch, and bounded layout survive a refresh", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await openPluginManager(page);

  const marketplace = page.getByRole("region", { name: "Official" });
  const row = marketplace.locator(".plugin-marketplace-row").filter({ hasText: "Cua Driver" });
  await expect(row.getByRole("button", { name: "Install" })).toBeVisible();
  await row.getByRole("button", { name: "Install" }).click();
  await marketplace.getByRole("tab", { name: /Installed/ }).click();
  const installed = marketplace.locator(".plugin-marketplace-row").filter({ hasText: "Cua Driver" });
  const toggle = installed.getByRole("switch");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
  const overflow = await marketplace.evaluate((element) => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  await page.reload();
  await openPluginManager(page);
});
