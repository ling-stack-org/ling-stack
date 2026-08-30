import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
} from "./support/mock-state";
import {
  installNormalConversationFixture,
  normalConversationFixtureTitle,
} from "./support/normal-conversation-fixture";

const viewport = { width: 1440, height: 919 } as const;

test("macOS Home chrome owns a fixed layout row and keeps the collapsed compact rail", async ({ page }, testInfo) => {
  await prepareSurface(page, "macos", { theme: "light" });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Conversation home")).toBeVisible();
  const shell = page.locator("main.app-shell.desktop-macos");
  const chrome = shell.locator("[data-desktop-window-chrome='true']");
  const leading = chrome.locator(".desktop-window-chrome-leading");
  const titlebarSurface = chrome.locator("[data-desktop-window-titlebar-surface='true']");
  const trafficLightExclusion = chrome.locator(".desktop-window-traffic-light-exclusion");
  const sidebarToggle = page.locator(".desktop-window-sidebar-toggle");
  const navigation = page.getByLabel("Ling Stack navigation");
  const newConversation = page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New conversation" });

  await expect(shell).toBeVisible();
  await expect(chrome).toHaveCount(1);
  await expect.poll(async () => roundedBox(chrome)).toEqual({
    height: 48,
    width: viewport.width,
    x: 0,
    y: 0,
  });
  await expectDragRegion(leading);
  await expectDragRegion(titlebarSurface);
  await expect.poll(async () => roundedBox(trafficLightExclusion)).toEqual({
    height: 48,
    width: 76,
    x: 0,
    y: 0,
  });
  await expect.poll(async () => titlebarBackgrounds(chrome, leading)).toEqual({
    chrome: "rgb(255, 255, 255)",
    leading: "rgb(230, 228, 223)",
  });
  await expectNoDragControl(sidebarToggle);
  await expect(page.locator(".channel-sidebar-switch")).toHaveCount(0);
  await expect.poll(async () => {
    const navigationBox = await navigation.boundingBox();
    const workspaceBox = await page.locator("main.app-shell > .workspace").boundingBox();
    return {
      navigationHeight: Math.round(navigationBox?.height ?? -1),
      navigationTop: Math.round(navigationBox?.y ?? -1),
      workspaceHeight: Math.round(workspaceBox?.height ?? -1),
      workspaceTop: Math.round(workspaceBox?.y ?? -1),
    };
  }).toEqual({
    navigationHeight: viewport.height - 48,
    navigationTop: 48,
    workspaceHeight: viewport.height - 48,
    workspaceTop: 48,
  });
  await expect.poll(async () => {
    const toggleBox = await sidebarToggle.boundingBox();
    const newConversationBox = await newConversation.boundingBox();
    if (!toggleBox || !newConversationBox) return undefined;
    return {
      height: Math.round(toggleBox.height),
      left: Math.round(toggleBox.x),
      overlapsNewConversation: rectanglesOverlap(toggleBox, newConversationBox),
      top: Math.round(toggleBox.y),
      width: Math.round(toggleBox.width),
    };
  }).toEqual({
    height: 32,
    left: 84,
    overlapsNewConversation: false,
    top: 8,
    width: 32,
  });
  await captureIfRequested(page, testInfo.outputPath("home-expanded.png"));

  const expandedToggleBox = await sidebarToggle.boundingBox();

  await sidebarToggle.click();
  await expect(shell).toHaveClass(/channel-sidebar-collapsed/u);
  await expect.poll(async () => roundedBox(chrome)).toEqual({
    height: 48,
    width: viewport.width,
    x: 0,
    y: 0,
  });
  await expect.poll(async () => Math.round((await titlebarSurface.boundingBox())?.x ?? -1)).toBe(124);
  await expect.poll(async () => titlebarBackgrounds(chrome, leading)).toEqual({
    chrome: "rgb(255, 255, 255)",
    leading: "rgb(255, 255, 255)",
  });
  await expect.poll(async () => {
    const collapsedToggleBox = await sidebarToggle.boundingBox();
    if (!expandedToggleBox || !collapsedToggleBox) return undefined;
    return {
      height: Math.round(collapsedToggleBox.height),
      left: Math.round(collapsedToggleBox.x),
      samePosition: Math.round(expandedToggleBox.x) === Math.round(collapsedToggleBox.x)
        && Math.round(expandedToggleBox.y) === Math.round(collapsedToggleBox.y),
      top: Math.round(collapsedToggleBox.y),
      width: Math.round(collapsedToggleBox.width),
    };
  }).toEqual({
    height: 32,
    left: 84,
    samePosition: true,
    top: 8,
    width: 32,
  });
  await expect(navigation).toHaveAttribute("data-sidebar-mode", "compact");
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? -1)).toBe(48);
  await expect(page.locator(".sidebar-rail-launcher")).toHaveCount(3);
  await expect.poll(async () => roundedBox(page.locator("main.app-shell > .workspace"))).toMatchObject({
    width: viewport.width - 48,
    x: 48,
    y: 48,
  });
  await expect(page.getByLabel("Conversation home")).toBeVisible();
  await captureIfRequested(page, testInfo.outputPath("home-collapsed.png"));
});

test("macOS normal-conversation and channel headers are draggable while their controls remain clickable", async ({ page }, testInfo) => {
  await prepareSurface(page, "macos");
  const state = createBaseState({ approvalStatus: "expired" });
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.locator(".sidebar-recent-row").filter({ hasText: normalConversationFixtureTitle }).click();

  const conversation = page.getByLabel("Conversation page");
  const titlebarSurface = page.locator("[data-desktop-window-titlebar-surface='true']");
  const normalHeader = titlebarSurface.locator("[data-ui2-normal-conversation-header='true']");
  const searchTrigger = normalHeader.getByRole("button", { name: "Search" });
  const sidebarToggle = page.locator(".desktop-window-sidebar-toggle");
  await expectDragRegion(normalHeader);
  await expect(conversation.locator("[data-ui2-normal-conversation-header='true']")).toHaveCount(0);
  await expect.poll(async () => roundedBox(normalHeader)).toMatchObject({ height: 48, y: 0 });
  await expect.poll(async () => ({
    actionCenters: await roundedCenterYs(normalHeader.getByRole("button")),
    sidebarToggleCenter: await roundedCenterY(sidebarToggle),
    titleCenter: await roundedCenterY(normalHeader.getByRole("heading", { name: normalConversationFixtureTitle })),
  })).toEqual({
    actionCenters: [24, 24, 24, 24],
    sidebarToggleCenter: 24,
    titleCenter: 24,
  });
  await expectNoDragControl(searchTrigger);
  await captureIfRequested(page, testInfo.outputPath("normal-conversation.png"));
  await searchTrigger.click();
  await expect(normalHeader.getByRole("textbox", { name: "Search conversation messages" })).toBeFocused();

  await navigation.getByRole("button", { name: "Engineering" }).click();
  const channelHeader = titlebarSurface.locator(".channel-header[data-desktop-window-drag-region='true']");
  const channelMenuTrigger = channelHeader.getByRole("button", { name: "More channel views" });
  await expectDragRegion(channelHeader);
  await expect(page.locator(".task-workbench-window > .channel-header")).toHaveCount(0);
  await expect.poll(async () => roundedBox(channelHeader)).toMatchObject({ height: 48, y: 0 });
  await expectNoDragControl(channelMenuTrigger);
  await channelMenuTrigger.click();
  const channelMenu = page.getByRole("menu", { name: "More channel views" });
  await expectNoDragControl(channelMenu);
  await page.keyboard.press("Escape");
  await expect(channelMenu).toBeHidden();
  await expect(channelMenuTrigger).toBeFocused();
  await captureIfRequested(page, testInfo.outputPath("channel.png"));
});

test("macOS Settings and Media stay below or inside the shared titlebar", async ({ page }, testInfo) => {
  await prepareSurface(page, "macos");
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();

  const titlebar = page.locator("[data-desktop-window-chrome='true']");
  const titlebarSurface = page.locator("[data-desktop-window-titlebar-surface='true']");
  const settingsNavigation = page.locator(".settings-section-nav");
  const backButton = settingsNavigation.getByRole("button", { name: "Back to app" });
  const settingsTitle = titlebarSurface.getByRole("heading", { name: "User profile" });
  await expect.poll(async () => roundedBox(titlebar)).toMatchObject({ height: 48, y: 0 });
  await expect(settingsTitle).toBeVisible();
  await expect(page.locator(".settings-layout .settings-window-titlebar")).toHaveCount(0);
  await expect.poll(async () => Math.round((await settingsNavigation.boundingBox())?.y ?? -1)).toBe(48);
  await expect.poll(async () => settingsBackGeometry(settingsNavigation, backButton)).toEqual({
    fillsContentWidth: true,
    leftAlignedToContent: true,
    top: 68,
  });
  await captureIfRequested(page, testInfo.outputPath("settings.png"));
  await backButton.click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  const mediaToolbar = titlebarSurface.locator(".media-production-canvas-toolbar[data-desktop-window-drag-region='true']");
  const jobsButton = mediaToolbar.getByRole("radio", { name: "Generation tasks" });
  await expectDragRegion(mediaToolbar);
  await expect.poll(async () => roundedBox(mediaToolbar)).toMatchObject({ height: 48, y: 0 });
  await expect(page.locator(".media-production-page > .media-production-canvas-toolbar")).toHaveCount(0);
  await expectNoDragControl(jobsButton);
  await jobsButton.click();
  await expect(page.locator(".media-production-page")).toHaveClass(/showing-jobs/u);
  await expect(page.locator(".media-production-jobs-view")).toBeVisible();
  await captureIfRequested(page, testInfo.outputPath("media.png"));
});

test("macOS portal overlays subtract the underlying shell drag region", async ({ page }) => {
  await prepareSurface(page, "macos");
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = [];
  state.channelBranches = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const trigger = page.getByLabel("Ling Stack navigation").getByRole("button", { name: "No channel yet" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "New channel" });
  const scrim = page.locator("#ling-ui-overlay-root [data-ling-overlay-scrim='dialog']");
  await expect(dialog).toBeVisible();
  await expectNoDragControl(dialog);
  await expectNoDragControl(scrim);
  await scrim.click({ position: { x: 100, y: 12 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "New channel" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.evaluate(() => {
    const preview = document.createElement("button");
    preview.type = "button";
    preview.dataset.desktopChromeFixture = "preview";
    preview.dataset.desktopWindowNoDrag = "true";
    preview.style.position = "fixed";
    preview.style.top = "36px";
    preview.style.left = "0";
    preview.style.zIndex = "61";
    preview.addEventListener("click", () => {
      preview.dataset.clicked = "true";
    });
    document.body.append(preview);
  });

  const preview = page.locator("[data-desktop-chrome-fixture='preview']");
  await expectNoDragControl(preview);
  await preview.click();
  await expect(preview).toHaveAttribute("data-clicked", "true");
});

test("macOS management surfaces share one titlebar owner", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  await prepareSurface(page, "macos");
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const titlebarSurface = page.locator("[data-desktop-window-titlebar-surface='true']");

  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expectSingleTitlebarOwner(titlebarSurface, "Plugin Manager");
  await expect(page.locator(".settings-plugin-manager > .plugin-manager-header")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Automations" }).click();
  await expectSingleTitlebarOwner(titlebarSurface, "Automations");
  await expect(page.locator(".automation-ui2-page > .automation-ui2-header")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expectSingleTitlebarOwner(titlebarSurface, "User profile");

  await settingsSections.getByRole("button", { name: "Model Workbench" }).click();
  await expectSingleTitlebarOwner(titlebarSurface, "Model Workbench");
  await expect(page.locator(".provider-workbench > .provider-workbench-header")).toHaveCount(0);
  await captureIfRequested(page, testInfo.outputPath("model-workbench.png"));

  await settingsSections.getByRole("button", { name: "Teammate Management" }).click();
  await expectSingleTitlebarOwner(titlebarSurface, "AI Teammates");
  await expect(page.locator(".teammates-page > .teammates-page-header")).toHaveCount(0);

  await settingsSections.getByRole("button", { name: "Council Workspace" }).click();
  await expectSingleTitlebarOwner(titlebarSurface, "Council Workspace");
  await expect(page.locator(".council-workspace-page > .council-workspace-header")).toHaveCount(0);
  await expect(browserErrors).toEqual([]);
});

test("macOS titlebar stays bounded at 1280x800 in dark mode", async ({ page }, testInfo) => {
  const compactViewport = { width: 1280, height: 800 } as const;
  await prepareSurface(page, "macos", { theme: "dark", viewport: compactViewport });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const shell = page.locator("main.app-shell.desktop-macos");
  const chrome = shell.locator("[data-desktop-window-chrome='true']");
  const leading = chrome.locator(".desktop-window-chrome-leading");
  const sidebarToggle = chrome.locator(".desktop-window-sidebar-toggle");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => roundedBox(chrome)).toEqual({
    height: 48,
    width: compactViewport.width,
    x: 0,
    y: 0,
  });
  await expect.poll(async () => titlebarBackgrounds(chrome, leading)).toEqual({
    chrome: "rgb(31, 31, 31)",
    leading: "rgb(40, 39, 37)",
  });

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.locator("[data-desktop-window-titlebar-surface='true']").getByRole("heading", { name: "Engineering" })).toBeVisible();
  const geometry = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".app-shell.desktop-macos > .workspace");
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      workspaceHeight: workspace?.getBoundingClientRect().height,
      workspaceTop: workspace?.getBoundingClientRect().top,
    };
  });
  expect(geometry.documentWidth).toBe(geometry.viewportWidth);
  expect(geometry.workspaceHeight).toBe(compactViewport.height - 48);
  expect(geometry.workspaceTop).toBe(48);
  await captureIfRequested(page, testInfo.outputPath("channel-dark-1280x800.png"));

  await sidebarToggle.click();
  await expect(shell).toHaveClass(/channel-sidebar-collapsed/u);
  await expect.poll(async () => titlebarBackgrounds(chrome, leading)).toEqual({
    chrome: "rgb(31, 31, 31)",
    leading: "rgb(31, 31, 31)",
  });
  await captureIfRequested(page, testInfo.outputPath("channel-collapsed-dark-1280x800.png"));
});

test("macOS private chat mounts one Header in the titlebar and keeps one dock divider", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    // Mock avatar/image endpoints intentionally return 404 and exercise the
    // existing fallback UI; only application console errors block this check.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  await prepareSurface(page, "macos");
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({
      id: "ling_agent",
      templateId: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      protectedProfile: true,
      displayName: "Ling Agent",
      roleKey: "custom",
    }),
  ];
  state.teammateDirectMessages = [];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.locator(".channel-left-drawer .sidebar-row-main").filter({ hasText: "Ling Agent" }).click();

  const titlebarSurface = page.locator("[data-desktop-window-titlebar-surface='true']");
  const header = titlebarSurface.locator(".teammate-chat-header[data-desktop-window-drag-region='true']");
  const detailsButton = header.locator(".conversation-toolbar-details");
  await expectDragRegion(header);
  await expectNoDragControl(detailsButton);
  await detailsButton.click();
  await expect(page.locator(".teammate-private-right-dock")).toBeVisible();
  await expect.poll(async () => {
    const frame = await page.locator(".teammate-private-right-dock-frame").boundingBox();
    return frame?.width ?? 0;
  }).toBeGreaterThanOrEqual(300);

  const metrics = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace-teammate-private-surface");
    const chatHeader = document.querySelector<HTMLElement>(".teammate-chat-header");
    const identity = chatHeader?.querySelector<HTMLElement>(".teammate-workspace-identity");
    const handle = document.querySelector<HTMLElement>(".workspace-right-dock-resize-handle");
    const dock = document.querySelector<HTMLElement>(".workspace-right-dock-frame > .right-dock");
    const workspaceStyle = workspace ? getComputedStyle(workspace) : undefined;
    const workspaceRect = workspace?.getBoundingClientRect();
    const headerRect = chatHeader?.getBoundingClientRect();
    const identityRect = identity?.getBoundingClientRect();
    const handleLine = handle ? getComputedStyle(handle, "::before") : undefined;
    const dockStyle = dock ? getComputedStyle(dock) : undefined;
    return {
      workspacePaddingTop: workspaceStyle?.paddingTop,
      workspacePaddingLeft: workspaceStyle?.paddingLeft,
      workspaceHeight: workspaceRect?.height,
      workspaceTop: workspaceRect?.top,
      headerHeight: headerRect?.height,
      headerTop: headerRect?.top,
      headerLeftInset: workspaceRect && headerRect ? headerRect.left - workspaceRect.left : undefined,
      identityLeftInset: headerRect && identityRect ? identityRect.left - headerRect.left : undefined,
      identityTopInset: headerRect && identityRect ? identityRect.top - headerRect.top : undefined,
      handleLineWidth: handleLine?.width,
      dockBorderLeftWidth: dockStyle?.borderLeftWidth,
    };
  });

  expect(metrics.workspacePaddingTop).toBe("0px");
  expect(metrics.workspacePaddingLeft).toBe("0px");
  expect(metrics.workspaceHeight).toBe(viewport.height - 48);
  expect(metrics.workspaceTop).toBe(48);
  expect(metrics.headerHeight).toBe(48);
  expect(metrics.headerTop).toBe(0);
  expect(metrics.headerLeftInset).toBe(0);
  expect(metrics.identityLeftInset).toBe(18);
  expect(metrics.identityTopInset).toBe(9);
  expect(metrics.handleLineWidth).toBe("1px");
  expect(metrics.dockBorderLeftWidth).toBe("0px");
  expect(browserErrors).toEqual([]);
  if (process.env.LING_DESIGN_QA_CAPTURE === "1") {
    await page.screenshot({ path: testInfo.outputPath("macos-titlebar.png") });
  }
});

for (const host of [
  { label: "Web", platform: undefined, dragRegion: false, leadingWidth: 48 },
  { label: "Windows", platform: "windows" as const, dragRegion: true, leadingWidth: 48 },
]) {
  test(`${host.label} shares the fixed titlebar and keeps the collapsed compact rail`, async ({ page }) => {
    await prepareSurface(page, host.platform);
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
    await page.goto("/");

    const shell = page.locator("main.app-shell");
    const chrome = page.locator("[data-desktop-window-chrome='true']");
    const titlebarSurface = chrome.locator("[data-desktop-window-titlebar-surface='true']");
    const sidebarToggle = chrome.locator(".desktop-window-sidebar-toggle");
    const navigation = page.getByLabel("Ling Stack navigation");
    await expect(shell).not.toHaveClass(/desktop-macos/u);
    await expect(chrome).toHaveCount(1);
    await expect.poll(async () => roundedBox(chrome)).toEqual({
      height: 48,
      width: viewport.width,
      x: 0,
      y: 0,
    });
    await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? -1)).toBe(292);
    await expect(sidebarToggle).toBeVisible();
    const expandedToggleBox = await sidebarToggle.boundingBox();
    await sidebarToggle.click();
    await expect(shell).toHaveClass(/channel-sidebar-collapsed/u);
    await expect(navigation).toHaveAttribute("data-sidebar-mode", "compact");
    await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? -1)).toBe(48);
    await expect(page.locator(".sidebar-rail-launcher")).toHaveCount(3);
    await expect.poll(async () => Math.round((await titlebarSurface.boundingBox())?.x ?? -1)).toBe(host.leadingWidth);
    await expect.poll(async () => roundedBox(page.locator("main.app-shell > .workspace"))).toMatchObject({
      width: viewport.width - 48,
      x: 48,
      y: 48,
    });
    const collapsedToggleBox = await sidebarToggle.boundingBox();
    expect(expandedToggleBox).not.toBeNull();
    expect(collapsedToggleBox).not.toBeNull();
    expect(roundedRectangle(expandedToggleBox!)).toEqual(roundedRectangle(collapsedToggleBox!));
    await sidebarToggle.click();
    await expect(shell).not.toHaveClass(/channel-sidebar-collapsed/u);
    await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
    const channelHeader = titlebarSurface.locator(".channel-header[data-desktop-window-drag-region='true']");
    await expect(channelHeader).toBeVisible();
    await expect(page.locator(".task-workbench-window > .channel-header")).toHaveCount(0);
    expect(await appRegion(channelHeader)).toBe(host.dragRegion ? "drag" : "none");

    const windowControls = chrome.locator(".desktop-window-controls");
    if (host.platform === "windows") {
      await expect(windowControls.getByRole("button")).toHaveCount(3);
      await windowControls.getByRole("button", { name: "Maximize window" }).click();
      await expect(windowControls.getByRole("button", { name: "Restore window" })).toBeVisible();
    } else {
      await expect(windowControls).toHaveCount(0);
    }
  });
}

async function prepareSurface(
  page: Page,
  platform?: "macos" | "windows",
  options: {
    readonly theme?: "dark" | "light";
    readonly viewport?: { readonly width: number; readonly height: number };
  } = {},
): Promise<void> {
  await page.setViewportSize(options.viewport ?? viewport);
  await page.addInitScript(({ desktopPlatform, theme }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    if (theme) {
      const themeId = theme === "dark" ? "ling-dark" : "ling-light";
      const selection = JSON.stringify({ mode: "fixed", themeId });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      localStorage.setItem("ling-stack.themePreference", theme);
      localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
    }
    if (desktopPlatform) {
      let maximized = false;
      const stateListeners = new Set<(state: { readonly maximized: boolean }) => void>();
      Object.defineProperty(window, "lingDesktop", {
        configurable: true,
        value: {
          platform: desktopPlatform,
          daemonBaseUrl: "http://127.0.0.1:17891",
          ...(desktopPlatform === "windows"
            ? {
                windowControls: {
                  getState: async () => ({ maximized }),
                  minimize: async () => ({ accepted: true }),
                  toggleMaximize: async () => {
                    maximized = !maximized;
                    for (const listener of stateListeners) listener({ maximized });
                    return { accepted: true };
                  },
                  close: async () => ({ accepted: true }),
                  onStateChanged: (listener: (state: { readonly maximized: boolean }) => void) => {
                    stateListeners.add(listener);
                    listener({ maximized });
                    return () => stateListeners.delete(listener);
                  },
                },
              }
            : {}),
        },
      });
    }
  }, { desktopPlatform: platform, theme: options.theme });
}

async function captureIfRequested(page: Page, path: string): Promise<void> {
  if (process.env.LING_DESIGN_QA_CAPTURE !== "1") return;
  await page.screenshot({ path });
}

async function expectDragRegion(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => appRegion(locator)).toBe("drag");
}

async function expectNoDragControl(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => appRegion(locator)).toBe("no-drag");
}

async function expectSingleTitlebarOwner(titlebarSurface: Locator, heading: string): Promise<void> {
  await expect(titlebarSurface.locator(":scope > *")).toHaveCount(1);
  await expect(titlebarSurface.getByRole("heading", { name: heading })).toBeVisible();
}

async function roundedCenterY(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  return Math.round((box?.y ?? -1) + (box?.height ?? 0) / 2);
}

async function roundedCenterYs(locator: Locator): Promise<number[]> {
  const centers: number[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    centers.push(await roundedCenterY(locator.nth(index)));
  }
  return centers;
}

async function appRegion(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region").trim());
}

async function titlebarBackgrounds(
  chrome: Locator,
  leading: Locator,
): Promise<{ readonly chrome: string; readonly leading: string }> {
  return {
    chrome: await chrome.evaluate((element) => getComputedStyle(element).backgroundColor),
    leading: await leading.evaluate((element) => getComputedStyle(element).backgroundColor),
  };
}

function rectanglesOverlap(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function roundedRectangle(rectangle: {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}): { readonly height: number; readonly width: number; readonly x: number; readonly y: number } {
  return {
    height: Math.round(rectangle.height),
    width: Math.round(rectangle.width),
    x: Math.round(rectangle.x),
    y: Math.round(rectangle.y),
  };
}

async function roundedBox(locator: Locator): Promise<{
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
} | undefined> {
  const box = await locator.boundingBox();
  return box ? {
    height: Math.round(box.height),
    width: Math.round(box.width),
    x: Math.round(box.x),
    y: Math.round(box.y),
  } : undefined;
}

async function settingsBackGeometry(navigation: Locator, button: Locator): Promise<{
  readonly fillsContentWidth: boolean;
  readonly leftAlignedToContent: boolean;
  readonly top: number;
}> {
  const navigationBox = await navigation.boundingBox();
  const buttonBox = await button.boundingBox();
  if (!navigationBox || !buttonBox) {
    return { fillsContentWidth: false, leftAlignedToContent: false, top: -1 };
  }
  const padding = await navigation.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      left: Number.parseFloat(style.paddingLeft),
      right: Number.parseFloat(style.paddingRight),
    };
  });
  const expectedLeft = navigationBox.x + padding.left;
  const expectedWidth = padding.clientWidth - padding.left - padding.right;
  return {
    fillsContentWidth: Math.abs(buttonBox.width - expectedWidth) <= 1,
    leftAlignedToContent: Math.abs(buttonBox.x - expectedLeft) <= 1,
    top: Math.round(buttonBox.y),
  };
}
