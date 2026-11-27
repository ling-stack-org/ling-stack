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
  const checksum = `sha256:${"a".repeat(64)}`;
  let gstackConnected = false;
  let superpowersState: "not_installed" | "disabled" | "enabled" = "not_installed";
  await page.route("**/plugins/skill-packs**", async route => {
    if (route.request().method() === "POST" && route.request().url().includes("/gstack")) {
      expect(route.request().postDataJSON()).toEqual({ action: "connect", path: "/Users/example/workspace/projects",
        expectedManifestChecksum: checksum });
      gstackConnected = true;
    }
    if (route.request().method() === "POST" && route.request().url().includes("/superpowers")) {
      const action = route.request().postDataJSON()?.action;
      if (action === "install" || action === "disable") superpowersState = "disabled";
      if (action === "enable") superpowersState = "enabled";
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packs: [
          { id: "gstack", name: "gstack", upstreamUrl: "https://github.com/garrytan/gstack",
            state: gstackConnected ? "disabled" : "not_installed", version: gstackConnected ? "1.91.101.0" : undefined,
            retainedVersion: gstackConnected ? undefined : "1.91.101.0" },
          { id: "superpowers", name: "Superpowers", upstreamUrl: "https://github.com/obra/superpowers", state: superpowersState,
            downloadBytes: 700239, version: superpowersState === "not_installed" ? undefined : "7.0.2" },
        ],
      }),
    });
  });
  await page.goto("/");
  await openPluginManager(page);
  await page.getByRole("tab", { name: /Skill packs/u }).click();
  const gstack = page.getByRole("article", { name: "gstack" });
  await expect(gstack).toContainText("Use previous installation");
  await gstack.getByRole("button", { name: "Connect folder" }).click();
  const connection = page.getByRole("dialog", { name: "Connect gstack runtime" });
  await expect(connection.getByRole("button", { name: "Connect folder" })).toBeDisabled();
  await connection.getByLabel("Manifest SHA-256 from your build output or trusted source").fill(checksum);
  await connection.getByRole("button", { name: "Connect folder" }).click();
  await expect(gstack).toContainText("Disabled in this workspace");
  const superpowers = page.getByRole("article", { name: "Superpowers" });
  await expect(superpowers).toContainText("Not installed");
  await superpowers.getByRole("button", { name: "Install", exact: true }).click();
  await expect(superpowers).toContainText("Disabled in this workspace");
  await superpowers.getByRole("switch").click();
  await expect(superpowers).toContainText("Enabled in this workspace");
  await superpowers.getByRole("switch").click();
  await expect(superpowers).toContainText("Disabled in this workspace");
});
