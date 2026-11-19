import { expect, test, type Page } from "@playwright/test";
import type { DesktopCommandResult, DesktopDaemonStatus, LingDesktopCapabilities, LockedComputerControlDesktopState } from "../../desktop/shared/desktop-capabilities.js";
import {
  createMockBundledEmbeddedCuaPlugin,
  mockDaemon,
  type MockManagedPlugin,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

interface LockedControlTestBridge {
  state: LockedComputerControlDesktopState;
  failReads: boolean;
  holdNextRead: boolean;
  holdAllReads: boolean;
  readHeld: boolean;
  reads: number;
  deferAuthorization: boolean;
  commands: Array<{ readonly command: string; readonly args: readonly unknown[] }>;
  completeAuthorization(result: DesktopCommandResult): void;
  releaseRead(): void;
}

declare global {
  interface Window { __lockedControlTest: LockedControlTestBridge; }
}

async function installComputerControlBridge(
  page: Page,
  input: { readonly locale?: "en-US" | "zh-CN"; readonly platform?: "macos" | "windows"; readonly theme?: "dark"; readonly lockedUse?: boolean; readonly themeId?: string; readonly holdInitialRead?: boolean },
): Promise<void> {
  await page.addInitScript(({ locale, platform, theme, lockedUse, themeId, holdInitialRead }) => {
    localStorage.setItem("ling-stack.locale", locale ?? "en-US");
    if (theme) localStorage.setItem("ling-stack.themePreference", theme);
    if (themeId) {
      const selection = JSON.stringify({ mode: "fixed", themeId });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    }
    let completeAuthorization: ((result: DesktopCommandResult) => void) | undefined;
    let heldReadCount = 0;
    let releaseReads: Array<() => void> = [];
    let continueWhileLocked = true;
    const locked: LockedControlTestBridge = window.__lockedControlTest = {
      state: { projection: lockedUse
        ? { schemaVersion: 1, capability: "supported_restricted", phase: "off" }
        : { schemaVersion: 1, capability: "disabled_by_build", phase: "off", reason: "locked_control_disabled_by_build" }, activeTaskAvailable: true },
      failReads: false, holdNextRead: false, holdAllReads: holdInitialRead === true, readHeld: false, reads: 0, deferAuthorization: true,
      commands: [],
      completeAuthorization(result) { completeAuthorization?.(result); completeAuthorization = undefined; },
      releaseRead() { locked.holdAllReads = false; for (const release of releaseReads) release(); releaseReads = []; },
    };
    const daemonStatus: DesktopDaemonStatus = {
      state: "connected",
      baseUrl: "http://127.0.0.1:17891",
      ownedByDesktop: true,
    };
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
          getLockedComputerControlState: async (...args: unknown[]) => {
            locked.reads += 1;
            if (locked.failReads) throw new Error("fixture_read_failure");
            const state = structuredClone(locked.state);
            if (locked.holdNextRead || locked.holdAllReads) {
              locked.holdNextRead = false;
              heldReadCount += 1;
              locked.readHeld = true;
              await new Promise<void>((resolve) => { releaseReads.push(resolve); });
              heldReadCount -= 1;
              locked.readHeld = heldReadCount > 0;
            }
            if (args.length) throw new Error("unexpected_status_arguments");
            return state;
          },
          authorizeLockedComputerControl: async (...args: unknown[]) => {
            locked.commands.push({ command: "authorize", args });
            return locked.deferAuthorization
              ? new Promise<DesktopCommandResult>((resolve) => { completeAuthorization = resolve; })
              : { accepted: true };
          },
          revokeLockedComputerControl: async (...args: unknown[]) => {
            locked.commands.push({ command: "revoke", args });
            locked.state = { ...locked.state, projection: { schemaVersion: 1, capability: "supported_restricted", phase: "off" } };
            return { accepted: true };
          },
        },
        lockedTaskContinuation: {
          getLockedTaskContinuationPreferences: async () => ({ continueWhileLocked }),
          setContinueTasksWhileLocked: async (enabled) => { continueWhileLocked = enabled; return { accepted: true }; },
        },
        navigation: {
          acknowledgeIntent: async () => ({ accepted: true }),
          onIntent: () => () => undefined,
        },
        daemon: {
          getStatus: async () => daemonStatus,
          restart: async () => daemonStatus,
          onStatusChanged(listener) {
            let subscribed = true;
            queueMicrotask(() => {
              if (subscribed) listener(daemonStatus);
            });
            return () => { subscribed = false; };
          },
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
      } satisfies Pick<LingDesktopCapabilities,
        "platform" | "daemonBaseUrl" | "appearance" | "computerControl" | "lockedTaskContinuation" | "navigation" | "daemon" | "computerUse">,
    });
  }, input);
}

async function openComputerControl(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /^(Settings|设置)$/ }).click();
  await page.getByLabel(/^(Settings sections|设置分组)$/).getByRole("button", { name: /^(Computer Control|电脑控制)$/ }).click();
  await expect(page.locator(".computer-control-settings")).toBeVisible();
}

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /^(Plugin Manager|插件管理)$/ }).click();
  await expect(page.locator(".plugin-manager-page .settings-plugin-manager")).toBeVisible();
}

test("bundled Computer Control keeps enable intent through navigation, recheck, and disable", async ({ page }) => {
  await installComputerControlBridge(page, {});
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "official:cua-driver");
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
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "official:cua-driver");
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
  await expect(page.locator('.plugin-table-row[data-plugin-id="official:cua-driver"]')).toHaveCount(0);
});

test("bundled Windows Computer Control localizes readiness and limitations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installComputerControlBridge(page, { locale: "zh-CN", platform: "windows", theme: "dark" });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "official:cua-driver");
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
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "official:cua-driver");
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

async function openReadyLockedControl(page: Page, input: Parameters<typeof installComputerControlBridge>[1] = {}): Promise<void> {
  await installComputerControlBridge(page, { lockedUse: true, ...input });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "official:cua-driver");
  state.managedPlugins[index] = createMockBundledEmbeddedCuaPlugin({
    providerState: "ready", platform: "darwin", requestedEnabled: true, effectiveEnabled: true,
  });
  await mockDaemon(page, state);
  await openComputerControl(page);
  await expect(page.locator(".computer-control-settings")).toHaveAttribute("data-computer-control-state", "ready");
}

async function refreshLockedControl(page: Page): Promise<void> {
  const previous = await page.evaluate(() => window.__lockedControlTest.reads);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => page.evaluate(() => window.__lockedControlTest.reads)).toBeGreaterThan(previous);
}

async function beginLockedAuthorization(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Authorize for this task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Authorize control while locked?" });
  await expect(dialog).toContainText("temporarily unlocks your session behind protected screens");
  await dialog.getByRole("button", { name: "Continue to system verification" }).click();
}

async function publishArmedLockedControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__lockedControlTest.state = {
      activeTaskAvailable: true,
      projection: { schemaVersion: 1, capability: "supported_restricted", phase: "armed",
        grantId: "fixture-grant", runId: "fixture-run", computerUseSessionId: "fixture-session",
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() },
    };
  });
}

test("ordinary builds keep continuation independent and never offer GUI authorization", async ({ page }) => {
  await openReadyLockedControl(page, { lockedUse: false });
  const section = page.locator(".lock-aware-computer-control-section");
  await expect(section.getByText("Computer Control pauses", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Authorize for this task" })).toHaveCount(0);
  const continuation = section.getByRole("switch", { name: "Continue running while locked" });
  await expect(continuation).toBeChecked();
  await continuation.click();
  await expect(continuation).not.toBeChecked();
  await refreshLockedControl(page);
  await expect(section.getByRole("button", { name: "Authorize for this task" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__lockedControlTest.commands)).toEqual([]);
});

test("task authorization requires confirmation and daemon truth, supports cancellation and explicit revocation", async ({ page }, testInfo) => {
  await openReadyLockedControl(page);
  const section = page.locator(".locked-computer-control-section");
  const authorize = section.getByRole("button", { name: "Authorize for this task", exact: true });
  await expect(authorize).toBeEnabled();
  await page.evaluate(() => { window.__lockedControlTest.state = { ...window.__lockedControlTest.state, activeTaskAvailable: false }; });
  await refreshLockedControl(page);
  await expect(authorize).toBeDisabled();
  await page.evaluate(() => { window.__lockedControlTest.state = { ...window.__lockedControlTest.state, activeTaskAvailable: true }; });
  await refreshLockedControl(page);
  await authorize.click();
  await expect(page.getByRole("dialog", { name: "Authorize control while locked?" }).getByRole("button", { name: "Cancel", exact: true }).first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__lockedControlTest.commands)).toEqual([]);
  await beginLockedAuthorization(page);
  await expect(section).toHaveAttribute("data-locked-control-state", "verifying");
  await expect(section.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  await page.evaluate(() => window.__lockedControlTest.completeAuthorization({ accepted: false, reason: "locked_control_identity_cancelled" }));
  await expect(section).toHaveAttribute("data-locked-control-state", "off");
  await expect(section).toContainText("Identity verification was cancelled.");
  await beginLockedAuthorization(page);
  await publishArmedLockedControl(page);
  await page.evaluate(() => window.__lockedControlTest.completeAuthorization({ accepted: true }));
  await expect(section).toHaveAttribute("data-locked-control-state", "armed");
  await expect(section).toContainText("Authorized for the next lock");
  await expect(section.locator("time")).toBeVisible();
  await section.screenshot({ path: testInfo.outputPath("locked-control-armed.png") });
  await page.evaluate(() => { window.__lockedControlTest.failReads = true; });
  await refreshLockedControl(page);
  await expect(section).toContainText("state could not be refreshed");
  await section.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__lockedControlTest.commands.length)).toBe(3);
  await expect(section).toContainText("state could not be refreshed");
  await page.evaluate(() => { window.__lockedControlTest.failReads = false; });
  await refreshLockedControl(page);
  await expect(section).toHaveAttribute("data-locked-control-state", "off");
  expect(await page.evaluate(() => window.__lockedControlTest.commands)).toEqual([
    { command: "authorize", args: [] }, { command: "authorize", args: [] }, { command: "revoke", args: [] },
  ]);
});

test("an accepted command alone never renders an armed authorization", async ({ page }) => {
  await openReadyLockedControl(page);
  await page.evaluate(() => { window.__lockedControlTest.deferAuthorization = false; });
  await beginLockedAuthorization(page);
  const section = page.locator(".locked-computer-control-section");
  await expect(section).toHaveAttribute("data-locked-control-state", "off");
  await expect(section.getByText("Authorized for the next lock", { exact: true })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Authorize for this task", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__lockedControlTest.commands)).toEqual([{ command: "authorize", args: [] }]);
});

test("pending and malformed status reads cannot enable authorization", async ({ page }) => {
  await openReadyLockedControl(page, { holdInitialRead: true });
  const section = page.locator(".locked-computer-control-section");
  await expect.poll(() => page.evaluate(() => window.__lockedControlTest.readHeld)).toBe(true);
  await expect(section.getByRole("button", { name: "Authorize for this task", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__lockedControlTest.releaseRead());
  const authorize = section.getByRole("button", { name: "Authorize for this task", exact: true });
  await expect(authorize).toBeEnabled();
  await page.evaluate(() => {
    window.__lockedControlTest.state = { activeTaskAvailable: true,
      projection: { schemaVersion: 1, capability: "supported_restricted", phase: "armed" } };
  });
  await refreshLockedControl(page);
  await expect(authorize).toBeDisabled();
  await expect(section).toContainText("state could not be refreshed");
  expect(await page.evaluate(() => window.__lockedControlTest.commands)).toEqual([]);
});

test("revocation fences late authorization replies and stale status reads", async ({ page }) => {
  await openReadyLockedControl(page);
  await beginLockedAuthorization(page);
  const section = page.locator(".locked-computer-control-section");
  await expect(section).toHaveAttribute("data-locked-control-state", "verifying");
  await page.evaluate(() => {
    window.__lockedControlTest.state = { ...window.__lockedControlTest.state,
      projection: { schemaVersion: 1, capability: "supported_restricted", phase: "verifying" } };
    window.__lockedControlTest.holdNextRead = true;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => page.evaluate(() => window.__lockedControlTest.readHeld)).toBe(true);
  await section.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(section).toHaveAttribute("data-locked-control-state", "off");
  await page.evaluate(() => {
    window.__lockedControlTest.completeAuthorization({ accepted: true });
    window.__lockedControlTest.releaseRead();
  });
  await expect.poll(() => page.evaluate(() => window.__lockedControlTest.readHeld)).toBe(false);
  await expect(section).toHaveAttribute("data-locked-control-state", "off");
  await expect(section.getByRole("button", { name: "Authorize for this task", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__lockedControlTest.commands)).toEqual([
    { command: "authorize", args: [] }, { command: "revoke", args: [] },
  ]);
});

test("active, approval-paused and expired projections remain truthful", async ({ page }, testInfo) => {
  await openReadyLockedControl(page);
  await publishArmedLockedControl(page);
  await page.evaluate(() => {
    window.__lockedControlTest.state = { ...window.__lockedControlTest.state,
      projection: { ...window.__lockedControlTest.state.projection, phase: "active_locked", lockedSince: new Date().toISOString() } };
  });
  await refreshLockedControl(page);
  const section = page.locator(".locked-computer-control-section");
  await expect(section).toHaveAttribute("data-locked-control-state", "active_locked");
  await section.screenshot({ path: testInfo.outputPath("locked-control-active.png") });
  await page.evaluate(() => {
    window.__lockedControlTest.state = { ...window.__lockedControlTest.state,
      projection: { ...window.__lockedControlTest.state.projection, phase: "paused", reason: "locked_control_approval_required" } };
  });
  await refreshLockedControl(page);
  await expect(section).toHaveAttribute("data-locked-control-state", "paused");
  await expect(section).toContainText("An action needs approval; locked control is paused.");
  await section.screenshot({ path: testInfo.outputPath("locked-control-paused.png") });
  await page.evaluate(() => {
    window.__lockedControlTest.state = { activeTaskAvailable: false,
      projection: { schemaVersion: 1, capability: "supported_restricted", phase: "off", reason: "locked_control_grant_expired" } };
  });
  await refreshLockedControl(page);
  await expect(section).toContainText("The authorization expired.");
  await expect(section.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Authorize for this task", exact: true })).toBeDisabled();
});

for (const themeId of ["ling-light", "ling-dark", "ling-breeze", "ling-night", "ling-ocean", "ling-journey"]) {
  test(`locked authorization uses shared controls and dialog in ${themeId}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openReadyLockedControl(page, { themeId });
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
    const section = page.locator(".lock-aware-computer-control-section");
    const authorize = section.getByRole("button", { name: "Authorize for this task", exact: true });
    await authorize.scrollIntoViewIfNeeded();
    await authorize.hover();
    await authorize.focus();
    await authorize.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Authorize control while locked?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Local input stops control and relocks the computer.");
    await page.screenshot({ path: testInfo.outputPath(`locked-control-confirm-${themeId}.png`) });
    await page.keyboard.press("Escape");
    await expect(authorize).toBeFocused();
    await section.screenshot({ path: testInfo.outputPath(`locked-control-ready-${themeId}.png`) });
    const box = await section.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test("locked authorization localizes and fits narrow forced-color settings", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openReadyLockedControl(page, { locale: "zh-CN", themeId: "ling-dark" });
  const authorize = page.getByRole("button", { name: "为当前任务授权", exact: true });
  await authorize.click();
  const dialog = page.getByRole("dialog", { name: "授权锁定时控制？" });
  await expect(dialog).toContainText("临时解锁当前会话");
  await expect(dialog.getByRole("button", { name: "继续系统验证" })).toBeEnabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("locked-control-zh-narrow-forced-colors.png") });
});
