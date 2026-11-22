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

test("Chrome updates to the compatible version offered by the official catalog", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const chrome = createMockChromePlugin();
  state.managedPlugins.push({ ...chrome, package: installedChromePackage("0.1.0") });
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const row = page.locator(".plugin-marketplace-row").filter({ hasText: "Ling for Chrome" });
  const request = page.waitForRequest((request) => request.url().includes("/install-remote") && request.method() === "POST");
  await row.getByRole("button", { name: "Update 0.1.1" }).click();
  expect((await request).postDataJSON()).toMatchObject({ version: "0.1.1" });
  await expect(row.getByRole("button", { name: "Update 0.1.1" })).toHaveCount(0);
  await expect(row).toContainText("0.1.1");
});

test("a cached previous version can be selected while the official catalog is offline", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const chrome = createMockChromePlugin();
  state.managedPlugins.push({
    ...chrome,
    package: { ...installedChromePackage("0.1.1"), previousVersion: "0.1.0" },
    actions: { ...chrome.actions, canRollback: true },
  });
  await mockDaemon(page, state);
  await page.route("**/plugins/catalog?*", (route) => route.fulfill({ status: 503, json: { error: "catalog_unavailable" } }));
  await page.route("**/plugins/*/rollback?*", (route) => {
    const packageRecord = installedChromePackage("0.1.0");
    return route.fulfill({ json: { plugin: { ...chrome, package: packageRecord }, package: packageRecord } });
  });
  await page.goto("/");
  await openPluginManager(page);

  const row = page.locator(".plugin-marketplace-row").filter({ hasText: chrome.displayName });
  await row.getByRole("button", { name: "Roll back" }).click();
  await expect(row).toContainText("0.1.0");
  await expect(page.getByText("Restart Ling, then check again.")).toBeVisible();
});

function installedChromePackage(version: string) {
  return {
    pluginId: "official:chrome-browser",
    sourceKind: "official-remote",
    version,
    status: "installed",
    cacheRef: `host/official-remote/official-chrome-browser/${version}`,
    packageHash: "a".repeat(64),
    installedAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  } as const;
}
