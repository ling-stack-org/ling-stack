import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /Plugin Manager|插件管理/u }).click();
  await expect(page.getByRole("region", { name: /Official|官方/u })).toBeVisible();
}

test("skill pack tab exposes optional gstack and Superpowers controls", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  let superpowersEnabled = false;
  await page.route("**/plugins/skill-packs**", async route => {
    if (route.request().method() === "POST" && route.request().url().includes("/superpowers")) {
      const action = route.request().postDataJSON()?.action;
      if (action === "enable") superpowersEnabled = true;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packs: [
          { id: "gstack", name: "gstack", upstreamUrl: "https://github.com/garrytan/gstack", state: "not_installed", retainedVersion: "1.91.101.0" },
          { id: "superpowers", name: "Superpowers", upstreamUrl: "https://github.com/obra/superpowers", state: superpowersEnabled ? "enabled" : "not_installed", downloadBytes: 700239, version: superpowersEnabled ? "7.0.2" : undefined },
        ],
      }),
    });
  });
  await page.goto("/");
  await openPluginManager(page);
  await page.getByRole("tab", { name: /Skill packs/u }).click();
  await expect(page.getByRole("article", { name: "gstack" })).toContainText("Use previous installation");
  await expect(page.getByRole("article", { name: "Superpowers" })).toContainText("Install");
  await page.getByRole("article", { name: "Superpowers" }).getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("article", { name: "Superpowers" })).toContainText("Disabled in this workspace");
  await page.getByRole("article", { name: "Superpowers" }).getByRole("switch").click();
  await expect(page.getByRole("article", { name: "Superpowers" })).toContainText("Enabled in this workspace");
});
