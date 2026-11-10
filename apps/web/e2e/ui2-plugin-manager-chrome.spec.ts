import { expect, test, type Page } from "@playwright/test";
import {
  createMockChromePlugin,
  mockDaemon,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

test("Chrome built-in plugin uses automatic Native Host states without pairing UI or polling", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins.push(createMockChromePlugin());
  await mockDaemon(page, state);
  await openPluginManager(page, "/");

  const row = page.locator('[data-plugin-id="built-in:chrome"]');
  await expect(row).toBeVisible();
  await expect(row.locator(".plugin-table-chrome-icon")).toBeVisible();
  await expect(row).toContainText("Control Chrome with Ling.");
  await expect(row).toHaveAttribute("data-primary-state", "disabled");
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row).toHaveAttribute("data-primary-state", "setup-missing");

  await row.getByRole("button", { name: "Open Chrome Web Store" }).click();
  const drawer = page.getByRole("dialog", { name: "Chrome connection" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Connection is automatic");
  await expect(drawer.getByRole("link", { name: "Open Chrome Web Store" })).toHaveAttribute(
    "href",
    "https://chromewebstore.google.com/detail/mbmlnnfhebclljonhedpjghbhibfapei",
  );
  await expect(drawer).not.toContainText("Pairing code");
  await drawer.getByRole("button", { name: "Close" }).last().click();

  updateChromeFixture(state, "host_missing");
  await reopenPluginManager(page);
  await expect(row).toContainText("Connection component missing");
  await row.getByRole("button", { name: "Repair connection" }).click();
  await expect(row).toContainText("Extension required");

  updateChromeFixture(state, "paused");
  await reopenPluginManager(page);
  await expect(row).toContainText("Paused");
  await row.getByRole("button", { name: "Resume in Chrome" }).click();
  await expect(drawer).toContainText("choose Resume");
  await drawer.getByRole("button", { name: "Close" }).last().click();

  updateChromeFixture(state, "ready");
  await reopenPluginManager(page);
  await expect(row).toHaveAttribute("data-primary-state", "ready");
  await expect(row).toContainText("Connected");

  updateChromeFixture(state, "incompatible");
  await reopenPluginManager(page);
  await expect(row).toHaveAttribute("data-primary-state", "failed");
  await expect(row).toContainText("Needs attention");
  await row.getByRole("button", { name: "Update Chrome connection" }).click();
  await expect(drawer).toContainText("needs an update");

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
      paired: false,
      connected: true,
      hostState: "ready",
      extensionState: "connected",
      transport: "native_messaging",
      extensionVersion: "0.1.1",
      browserVersion: "Chrome/151",
      storeUrl: "https://chromewebstore.google.com/detail/mbmlnnfhebclljonhedpjghbhibfapei",
    },
  }));
  await mockDaemon(page, state);
  await openPluginManager(page, "/");

  const row = page.locator('[data-plugin-id="built-in:chrome"]');
  await expect(row.locator(".plugin-table-chrome-icon")).toBeVisible();
  await expect(row).toContainText("使用 Ling 控制 Chrome。");
  await expect(row).toContainText("已连接");
  await expect(page.locator(".plugin-table")).toHaveJSProperty(
    "scrollWidth",
    await page.locator(".plugin-table").evaluate((element) => element.clientWidth),
  );
  if (process.env.LING_CAPTURE_CHROME_PLUGIN_EVIDENCE === "1") {
    await page.screenshot({ animations: "disabled", path: "/tmp/ling-plugin-manager-chrome-dark.png" });
  }
  expect(runtimeErrors).toEqual([]);
});

function updateChromeFixture(
  state: ReturnType<typeof createBaseState>,
  mode: "host_missing" | "paused" | "ready" | "incompatible",
): void {
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "built-in:chrome");
  const connected = mode === "ready";
  const browserState = mode === "incompatible" ? "incompatible" : mode;
  state.managedPlugins[index] = createMockChromePlugin({
    status: "enabled",
    setup: {
      kind: "browser_extension",
      state: connected ? "ready" : "missing",
      checkedAt: "2026-08-17T00:01:00.000Z",
      browserFamily: "chrome",
      browserState,
      paired: false,
      connected,
      hostState: mode === "host_missing" ? "missing" : "ready",
      extensionState: connected ? "connected" : mode === "paused" ? "paused" : mode === "incompatible" ? "incompatible" : "not_detected",
      ...(connected ? { transport: "native_messaging" as const } : {}),
      extensionVersion: "0.1.1",
      browserVersion: "Chrome/151",
      storeUrl: "https://chromewebstore.google.com/detail/mbmlnnfhebclljonhedpjghbhibfapei",
    },
  });
}

async function openPluginManager(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /Plugin Manager|插件管理/u }).click();
}

async function reopenPluginManager(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /Plugin Manager|插件管理/u }).click();
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
