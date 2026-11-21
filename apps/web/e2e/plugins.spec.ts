import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function openPluginManager(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /^(Plugin Manager|插件管理)$/u }).click();
  await expect(page.getByRole("region", { name: "Official" })).toBeVisible();
  await expect(page.locator(".plugin-marketplace-row").first()).toBeVisible();
}

function marketplaceRow(page: Page, name: string) {
  return page.locator(".plugin-marketplace-row").filter({ hasText: name });
}

test("official catalog separates installed and available plugins", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await openPluginManager(page);

  await expect(page.getByRole("tab", { name: /Installed 0/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Not installed 3/ })).toBeVisible();
  await expect(page.locator(".plugin-marketplace-row")).toHaveCount(3);
  await expect(marketplaceRow(page, "Cua Driver")).toContainText("0.2.0");
  await expect(page.locator(".settings-plugin-manager")).not.toContainText("Add plugin");
  await expect(page.locator(".settings-plugin-manager")).not.toContainText("Import");

  await page.getByLabel("Search plugins").fill("Office");
  await expect(page.locator(".plugin-marketplace-row")).toHaveCount(1);
  await expect(page.locator(".plugin-marketplace-row")).toContainText("Ling Office Documents");
  await page.getByLabel("Search plugins").fill("");
  await expect(page.locator(".plugin-marketplace-row")).toHaveCount(3);
});

test("remote install moves a plugin to Installed and exposes its enable switch", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await openPluginManager(page);

  const cua = marketplaceRow(page, "Cua Driver");
  await cua.getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("tab", { name: /Installed 1/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Not installed 2/ })).toBeVisible();
  await page.getByRole("tab", { name: /Installed/ }).click();
  const installed = marketplaceRow(page, "Cua Driver");
  await expect(installed).toBeVisible();
  const toggle = installed.getByRole("switch");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
});

test("catalog failure stays actionable and does not render an empty fake list", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route("**/plugins/catalog**", async (route) => {
    await route.fulfill({ status: 503, json: { error: "plugin_catalog_unavailable", message: "Official plugin catalog is unavailable." } });
  });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /^(Plugin Manager|插件管理)$/u }).click();
  const status = page.locator(".plugin-marketplace-empty");
  await expect(status).toContainText("Official plugin source unavailable");
  await expect(page.locator(".plugin-marketplace-row")).toHaveCount(0);
  await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
});
