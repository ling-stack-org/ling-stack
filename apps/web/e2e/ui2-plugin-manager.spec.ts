import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function openPluginManager(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.locator(".settings-plugin-manager")).toBeVisible();
  await expect(page.locator(".plugin-marketplace-row").first()).toBeVisible();
}

test("marketplace rows stay compact, searchable, and free of legacy management controls", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await openPluginManager(page);

  const marketplace = page.getByRole("region", { name: "Official" });
  await expect(marketplace.locator(".plugin-marketplace-row")).toHaveCount(3);
  await expect(marketplace.getByRole("tablist", { name: "Plugin status" })).toBeVisible();
  await expect(marketplace.getByLabel("Search plugins")).toHaveAttribute("placeholder", "Search plugins");
  await expect(marketplace.getByRole("button", { name: "Add plugin" })).toHaveCount(0);
  await expect(marketplace.getByRole("button", { name: "Import" })).toHaveCount(0);
  await expect(page.locator(".plugin-table")).toHaveCount(0);

  await marketplace.getByRole("tab", { name: /Not installed/ }).click();
  await marketplace.getByLabel("Search plugins").fill("Chrome");
  await expect(marketplace.locator(".plugin-marketplace-row")).toHaveCount(1);
  await expect(marketplace.locator(".plugin-marketplace-row")).toContainText("Ling for Chrome");
});

test("installed tab uses an icon switch after remote installation", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await openPluginManager(page);

  const cua = page.locator(".plugin-marketplace-row").filter({ hasText: "Cua Driver" });
  await cua.getByRole("button", { name: "Install" }).click();
  await page.getByRole("tab", { name: /Installed/ }).click();
  const installed = page.locator(".plugin-marketplace-row").filter({ hasText: "Cua Driver" });
  await expect(installed.getByRole("switch")).toBeVisible();
  await expect(installed.getByRole("button", { name: "Install" })).toHaveCount(0);
});
