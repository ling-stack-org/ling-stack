import { expect, test, type Page } from "@playwright/test";
import { createMockChromePlugin, mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /Plugin Manager|插件管理/u }).click();
  await expect(page.getByRole("region", { name: /Official|官方/u })).toBeVisible();
}

test("Chrome is offered by the official catalog and installs through the marketplace", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins.push(createMockChromePlugin());
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const marketplace = page.getByRole("region", { name: "Official" });
  const row = marketplace.locator(".plugin-marketplace-row").filter({ hasText: "Ling for Chrome" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("0.1.1");
  await expect(row.getByRole("button", { name: "Install" })).toBeVisible();
  await expect(row.getByRole("button", { name: /Enable|Disable/ })).toHaveCount(0);

  await row.getByRole("button", { name: "Install" }).click();
  await expect(marketplace.getByRole("tab", { name: /Installed 1/ })).toBeVisible();
  await marketplace.getByRole("tab", { name: /Installed/ }).click();
  const installed = marketplace.locator(".plugin-marketplace-row").filter({ hasText: "Ling for Chrome" });
  await expect(installed).toBeVisible();
  await expect(installed.getByRole("switch")).toBeVisible();
  await expect(marketplace.locator(".plugin-table")).toHaveCount(0);
});

test("Chrome catalog rows remain bounded in the Chinese dark marketplace", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins.push(createMockChromePlugin());
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const marketplace = page.getByRole("region", { name: "官方" });
  await expect(marketplace).toBeVisible();
  await expect(marketplace.getByRole("tab", { name: /未安装/ })).toBeVisible();
  await expect(marketplace.locator(".plugin-marketplace-row").filter({ hasText: "Ling for Chrome" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const overflow = await marketplace.evaluate((element) => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
});
