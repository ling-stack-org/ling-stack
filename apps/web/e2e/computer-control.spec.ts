import { expect, test, type Page } from "@playwright/test";
import {
  createMockBundledEmbeddedCuaPlugin,
  mockDaemon,
  type MockManagedPlugin,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function installComputerControlBridge(
  page: Page,
  input: { readonly locale?: "en-US" | "zh-CN"; readonly platform?: "macos" | "windows"; readonly theme?: "dark" },
): Promise<void> {
  await page.addInitScript(({ locale, platform, theme }) => {
    localStorage.setItem("ling-stack.locale", locale ?? "en-US");
    if (theme) localStorage.setItem("ling-stack.themePreference", theme);
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: platform ?? "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
        appearance: { reportTheme() {} },
        computerControl: {
          packagedBundledCapable: true,
          platform: platform ?? "macos",
          requestPermissions: async () => ({ accepted: true }),
          openPermissionSettings: async () => ({ accepted: true }),
        },
        navigation: {
          acknowledgeIntent: async () => ({ accepted: true }),
          onIntent: () => () => undefined,
        },
        daemon: {
          getStatus: async () => ({ state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true }),
          restart: async () => ({ state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true }),
        },
        computerUse: {
          reportLocale() {},
          reportSelectedDeckOwner() {},
          reportSelectedConversation() {},
          reportHostLayout() {},
          show: async () => ({ accepted: true }),
          hide: async () => ({ accepted: true }),
          stop: async () => ({ accepted: true }),
          getPreferences: async () => ({ previewAutoShow: true }),
          setAutoShow: async () => ({ accepted: true }),
          onSummaryChanged: () => () => undefined,
        },
      },
    });
  }, input);
}

async function openComputerControl(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /^(Settings|设置)$/ }).click();
  await page.getByLabel(/^(Settings sections|设置分组)$/).getByRole("button", { name: /^(Computer Control|电脑控制)$/ }).click();
  await expect(page.locator(".computer-control-settings")).toBeVisible();
}

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: /^(Plugin Manager|插件管理)$/ }).click();
  await expect(page.locator(".plugin-manager-page .settings-plugin-manager")).toBeVisible();
}

test("bundled Computer Control keeps enable intent through navigation, recheck, and disable", async ({ page }) => {
  await installComputerControlBridge(page, {});
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  state.managedPlugins[index] = createMockBundledEmbeddedCuaPlugin({
    providerState: "included",
    platform: "darwin",
    requestedEnabled: false,
    effectiveEnabled: false,
  });
  await mockDaemon(page, state);
  await openComputerControl(page);

  const surface = page.locator(".computer-control-settings");
  const toggle = surface.getByRole("switch", { name: "Enable Computer Control" });
  await expect(surface).toHaveAttribute("data-computer-control-state", "off");
  await expect(toggle).not.toBeChecked();
  await toggle.click();

  await expect(surface).toHaveAttribute("data-computer-control-state", "waiting_desktop");
  await expect(toggle).toBeChecked();
  expect(state.managedPlugins[index].setup?.requestedEnabled).toBe(true);

  await page.getByLabel("Settings sections").getByRole("button", { name: "User profile" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Computer Control" }).click();
  await expect(toggle).toBeChecked();

  await surface.getByRole("button", { name: "Recheck" }).click();
  await expect(surface).toHaveAttribute("data-computer-control-state", "ready");
  expect(state.managedPlugins[index].setup?.effectiveEnabled).toBe(true);

  await toggle.click();
  await expect(surface).toHaveAttribute("data-computer-control-state", "off");
  await expect(toggle).not.toBeChecked();
  expect(state.managedPlugins[index].setup?.requestedEnabled).toBe(false);
  expect(state.managedPlugins[index].setup?.distribution).toBe("bundled_embedded");
});

test("bundled Computer Control recovers macOS permissions without external installation actions", async ({ page }) => {
  await installComputerControlBridge(page, {});
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  const plugin = createMockBundledEmbeddedCuaPlugin({
    providerState: "permission_required",
    platform: "darwin",
    requestedEnabled: true,
    effectiveEnabled: false,
  });
  plugin.setup = {
    ...plugin.setup,
    permissions: {
      accessibility: "prompt",
      screenRecording: "prompt",
      capturable: false,
    },
  } as NonNullable<MockManagedPlugin["setup"]>;
  state.managedPlugins[index] = plugin;
  await mockDaemon(page, state);
  await openComputerControl(page);

  const surface = page.locator(".computer-control-settings");
  await expect(surface).toHaveAttribute("data-computer-control-state", "waiting_permission");
  await expect(surface.getByRole("button", { name: "Grant access" })).toBeVisible();
  await expect(surface.getByRole("button", { name: /Installation guide|Install/ })).toHaveCount(0);
  await surface.getByRole("button", { name: "Grant access" }).click();
  await expect(surface).toHaveAttribute("data-computer-control-state", "ready");

  await page.getByRole("button", { name: "Back to app" }).click();
  await openPluginManager(page);
  await expect(page.locator('.plugin-table-row[data-plugin-id="trusted-local:cua-driver"]')).toHaveCount(0);
});

test("bundled Windows Computer Control localizes readiness and limitations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installComputerControlBridge(page, { locale: "zh-CN", platform: "windows", theme: "dark" });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  const plugin = createMockBundledEmbeddedCuaPlugin({
    providerState: "ready",
    platform: "win32",
    requestedEnabled: true,
    effectiveEnabled: true,
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  });
  plugin.setup = {
    ...plugin.setup,
    windowsReadiness: {
      interactiveSession: "ready",
      wgcApi: "supported",
      d3d11: "available",
      uiaRuntime: "available",
      contentObserved: false,
      integrityCoverage: "standard",
      uiaHelper: "not_required",
    },
  } as NonNullable<MockManagedPlugin["setup"]>;
  state.managedPlugins[index] = plugin;
  await mockDaemon(page, state);
  await openComputerControl(page);

  const surface = page.locator(".computer-control-settings");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(surface).toHaveAttribute("data-computer-control-state", "ready");
  await expect(surface).toContainText("电脑控制");
  await expect(surface).toContainText("Windows");
  await expect(surface).toContainText("完整性覆盖范围");
  await expect(surface).toContainText("标准");
  await expect(surface).toContainText("高权限应用像素输入");
  await expect(surface).toContainText("UWP SendInput");
  await expect(surface.getByRole("button", { name: /安装引导|安装/ })).toHaveCount(0);
});

test("invalid bundled projection fails closed without connect or installation actions", async ({ page }) => {
  await installComputerControlBridge(page, {});
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  const malformed = createMockBundledEmbeddedCuaPlugin({
    providerState: "included",
    platform: "darwin",
    requestedEnabled: false,
    effectiveEnabled: false,
  });
  malformed.setup = {
    ...malformed.setup,
    state: "detected",
    providerState: "external_detected",
    requestedEnabled: false,
    effectiveEnabled: false,
    detectedCommand: "/opt/homebrew/bin/cua-driver",
    guide: {
      documentationUrl: "https://cua.ai/docs/cua-driver",
      installCommand: "install-cua-driver",
      supportsCustomCommand: true,
    },
  } as NonNullable<MockManagedPlugin["setup"]>;
  malformed.actions = {
    ...malformed.actions,
    canEnable: true,
    canInstall: true,
  };
  state.managedPlugins[index] = malformed;
  let connectCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/plugins/trusted-local%3Acua-driver/connect")) connectCount += 1;
  });
  await mockDaemon(page, state);
  await openComputerControl(page);

  const surface = page.locator('.computer-control-settings[data-computer-control-state="error"]');
  await expect(surface).toContainText("Computer Control could not be loaded");
  await expect(surface).toContainText("state is incomplete or invalid");
  await expect(surface.getByRole("switch", { name: "Enable Computer Control" })).toHaveCount(0);
  await expect(surface.getByRole("button", { name: /Installation guide|Install/ })).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(connectCount).toBe(0);
});
