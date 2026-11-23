import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

test("Desktop Settings shows measured storage and editable browser defaults", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const management = { history: [{ id: "visited", title: "Example", url: "https://example.com", visitedAt: Date.now() }],
      downloads: [], devices: [], downloadDirectory: "/tmp/downloads", askBeforeDownload: true, extensions: [] };
    const browser = {
      getState: async () => ({ generation: 1, revision: 0, tabs: [], preferences: { websiteLinks: "in_app", localhostLinks: "in_app", restoreTabs: true } }),
      act: async () => ({ generation: 1, revision: 0, tabs: [], preferences: { websiteLinks: "in_app", localhostLinks: "in_app", restoreTabs: true } }),
      getSettingsState: async () => management,
      actSettings: async (request: { action: string; rule?: { origin: string; permission: string; decision: string } }) => {
        if (request.action === "device_permission" && request.rule) management.devices = [request.rule];
        if (request.action === "download_preferences") return { ...management, error: true };
        return management;
      },
      getProfileSize: async () => ({ category: "browser", knownBytes: 4096, status: "complete" }),
      reportViewport: () => {}, onStateChanged: () => () => {}, onAddressFocusRequested: () => () => {},
    };
    Object.defineProperty(window, "lingDesktop", { configurable: true, value: { browser, platform: "darwin", daemon: { onStatusChanged: () => () => {} } } });
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  let policy: { defaults?: { browse: string; downloads: string; history: string; webMcp: boolean }; rules: unknown[] } = { rules: [] };
  await page.route(/\/workspace-settings(?:\?.*)?$/u, async route => {
    const base = createBaseState({ approvalStatus: "expired" }).workspaceSettings;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { desktopBrowserPolicy?: typeof policy };
      if (body.desktopBrowserPolicy) policy = body.desktopBrowserPolicy;
    }
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", settings: { ...base, desktopBrowserPolicy: policy } } });
  });
  await page.route(/\/device-storage\/scans(?:\/[\w-]+)?(?:\?.*)?$/u, async route => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 202, json: { id: "11111111-1111-1111-1111-111111111111", status: "scanning" } }); return;
    }
    await route.fulfill({ json: { id: "11111111-1111-1111-1111-111111111111", status: "partial", snapshot: {
      measurement: "logical_file_bytes", scope: "all", scannedAt: "2026-11-23T00:00:00Z", complete: false, knownBytes: 1024,
      categories: [
        { category: "conversations", knownBytes: 1024, status: "complete" },
        { category: "worktrees", knownBytes: 0, status: "complete" },
        { category: "plugins", knownBytes: 0, status: "complete" },
        { category: "browser", knownBytes: 0, status: "unavailable" },
        { category: "other", knownBytes: 0, status: "complete" },
      ],
    } } });
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-settings-section="device-storage"]').click();
  const storage = page.locator("[data-device-storage]");
  await expect(storage.getByRole("heading", { name: "Device storage" })).toBeVisible();
  await expect(storage.getByText("5.0 KB")).toBeVisible();
  await expect(storage.getByText("Ling file sizes", { exact: true })).toBeVisible();
  if (process.env.LING_SETTINGS_EVIDENCE_DIR) {
    await mkdir(process.env.LING_SETTINGS_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.LING_SETTINGS_EVIDENCE_DIR}/device-storage.png`, fullPage: true });
  }
  await storage.getByRole("button", { name: "Manage browser data" }).click();
  const browser = page.locator("[data-browser-settings]");
  await expect(browser.getByRole("heading", { name: "Browser", exact: true })).toBeVisible();
  await page.locator(".settings-content-stack").evaluate(element => { element.scrollTop = 0; });
  if (process.env.LING_SETTINGS_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.LING_SETTINGS_EVIDENCE_DIR}/browser-settings.png`, fullPage: true });
  }
  await browser.getByRole("combobox", { name: "Agent browsing" }).selectOption("deny");
  await browser.getByRole("button", { name: "Save default permissions" }).click();
  await expect.poll(() => policy.defaults?.browse).toBe("deny");
  await browser.locator(".browser-management-section").getByRole("textbox", { name: "Website origin" }).fill("https://example.com/path");
  await expect(browser.getByText("Enter an exact website origin, including http or https.")).toBeVisible();
  await browser.locator(".settings-browser-device-form").getByRole("textbox", { name: "Website origin" }).fill("https://example.com");
  await browser.locator(".settings-browser-device-form").getByRole("button", { name: "Save" }).click();
  await expect(browser.locator(".settings-browser-device-row")).toContainText("https://example.com");
  if (process.env.LING_SETTINGS_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.LING_SETTINGS_EVIDENCE_DIR}/browser-settings-interaction.png`, fullPage: true });
  }
  const saveError = browser.getByRole("alert").filter({ hasText: "Browser data could not be saved or restored." });
  await expect(saveError).toHaveCount(0);
  await browser.getByText("Ask where to save each download", { exact: true }).click();
  await expect(saveError).toBeVisible();
  expect(errors).toEqual([]);
});
