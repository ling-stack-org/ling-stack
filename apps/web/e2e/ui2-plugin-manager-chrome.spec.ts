import { expect, test, type Page } from "@playwright/test";
import {
  createMockChromePlugin,
  mockDaemon,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

test("Chrome built-in plugin enables, generates pairing, refreshes state, and revokes", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins.push(createMockChromePlugin());
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Plugin Manager" }).click();

  const row = page.locator('[data-plugin-id="built-in:chrome"]');
  await expect(row).toBeVisible();
  await expect(row.locator(".plugin-table-chrome-icon")).toBeVisible();
  await expect(row).toContainText("Control Chrome with Ling.");
  await expect(row).toHaveAttribute("data-primary-state", "disabled");
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row).toHaveAttribute("data-primary-state", "setup-missing");

  await row.getByRole("button", { name: "Connect Chrome" }).click();
  const drawer = page.getByRole("dialog", { name: "Connect Chrome" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("LING-CHROME-PAIR");
  await expect(drawer).toContainText("Chrome Web Store release is pending for this build.");
  await expect(drawer).toContainText("visible screenshots only for browser tasks you approve");
  if (process.env.LING_CAPTURE_CHROME_PLUGIN_EVIDENCE === "1") {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(drawer).toBeVisible();
    await page.screenshot({ animations: "disabled", path: "/tmp/ling-plugin-manager-chrome-light.png" });
  }

  updateChromeFixture(state, "waiting");
  await expect(row).toHaveAttribute("data-primary-state", "connecting", { timeout: 4_000 });
  await expect(drawer.getByRole("button", { name: "Remove Chrome access" })).toBeVisible();

  updateChromeFixture(state, "ready");
  await expect(row).toHaveAttribute("data-primary-state", "ready", { timeout: 4_000 });
  await expect(drawer).toContainText("Chrome is ready");
  await drawer.getByRole("button", { name: "Remove Chrome access" }).click();
  await expect(row).toHaveAttribute("data-primary-state", "setup-missing");

  updateChromeFixture(state, "incompatible");
  await expect(row).toHaveAttribute("data-primary-state", "failed", { timeout: 4_000 });
  await expect(row).toContainText("Needs attention");
  expect(runtimeErrors).toEqual([]);
});

test("Chrome built-in plugin keeps compact Chinese dark presentation", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "zh-CN", "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins.push(createMockChromePlugin({
    status: "enabled",
    setup: {
      kind: "browser_extension",
      state: "ready",
      checkedAt: "2026-08-17T00:00:00.000Z",
      browserFamily: "chrome",
      browserState: "ready",
      paired: true,
      connected: true,
      extensionVersion: "0.1.0",
      browserVersion: "Chrome/140",
    },
  }));
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "插件管理" }).click();

  const row = page.locator('[data-plugin-id="built-in:chrome"]');
  await expect(row.locator(".plugin-table-chrome-icon")).toBeVisible();
  await expect(row).toContainText("使用 Ling 控制 Chrome。");
  await expect(row).toContainText("已连接");
  await expect(page.locator(".plugin-table")).toHaveJSProperty("scrollWidth", await page.locator(".plugin-table").evaluate((element) => element.clientWidth));
  if (process.env.LING_CAPTURE_CHROME_PLUGIN_EVIDENCE === "1") {
    await page.screenshot({ animations: "disabled", path: "/tmp/ling-plugin-manager-chrome-dark.png" });
  }
  expect(runtimeErrors).toEqual([]);
});

function updateChromeFixture(state: ReturnType<typeof createBaseState>, mode: "waiting" | "ready" | "incompatible"): void {
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "built-in:chrome");
  const connected = mode === "ready";
  const browserState = connected ? "ready" : mode === "incompatible" ? "incompatible" : "waiting_for_chrome";
  state.managedPlugins[index] = createMockChromePlugin({
    status: "enabled",
    setup: {
      kind: "browser_extension",
      state: connected ? "ready" : "connected",
      checkedAt: "2026-08-17T00:01:00.000Z",
      browserFamily: "chrome",
      browserState,
      paired: true,
      connected,
      extensionVersion: "0.1.0",
      browserVersion: "Chrome/140",
    },
  });
}

async function prepareSurface(
  page: Page,
  locale: "en-US" | "zh-CN",
  theme: "light" | "dark",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ localeValue, themeValue }) => {
    localStorage.setItem("ling-stack.locale", localeValue);
    localStorage.setItem("ling-stack.themePreference", themeValue);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeValue);
  }, { localeValue: locale, themeValue: theme });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
