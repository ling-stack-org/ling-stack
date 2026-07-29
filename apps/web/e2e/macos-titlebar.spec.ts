import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  cwd,
  type MockState,
} from "./support/mock-state";

const viewport = { width: 1440, height: 919 } as const;

test("macOS Home chrome overlays content, survives Sidebar collapse, and preserves Web geometry", async ({ page }) => {
  await prepareSurface(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Conversation home")).toBeVisible();
  await expect(page.locator("[data-desktop-window-chrome='true']")).toHaveCount(0);
  const webGeometry = await readHomeGeometry(page);

  await installDesktopHost(page, "macos");
  await page.reload();

  const shell = page.locator("main.app-shell.desktop-macos");
  const chrome = shell.locator("[data-desktop-window-chrome='true']");
  const sidebarRegion = chrome.locator("[data-desktop-window-drag-owner='sidebar']");
  const contentFallback = chrome.locator("[data-desktop-window-drag-owner='content-fallback']");
  const sidebarToggle = page.locator(".channel-sidebar-switch");

  await expect(shell).toBeVisible();
  await expect(chrome).toHaveCount(1);
  await expect.poll(() => readTrafficLightExclusion(page)).toEqual({
    appRegion: "no-drag",
    height: "28px",
    left: "0px",
    pointerEvents: "none",
    top: "0px",
    width: "76px",
  });
  await expectDragRegion(sidebarRegion);
  await expectDragRegion(contentFallback);
  await expect.poll(() => readHomeGeometry(page)).toEqual(webGeometry);

  await sidebarToggle.click();
  await expect(shell).toHaveClass(/channel-sidebar-collapsed/u);
  await expectDragRegion(contentFallback);
  await expect.poll(async () => {
    const box = await contentFallback.boundingBox();
    return Boolean(box && box.width > 0 && box.height >= 28);
  }).toBe(true);
  await expect.poll(async () => Math.round((await contentFallback.boundingBox())?.x ?? -1)).toBe(76);
  await expect(page.getByLabel("Conversation home")).toBeVisible();
});

test("macOS normal-conversation and channel headers are draggable while their controls remain clickable", async ({ page }) => {
  await prepareSurface(page, "macos");
  const state = createBaseState({ approvalStatus: "expired" });
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.locator(".sidebar-recent-row").filter({ hasText: "Desktop chrome fixture" }).click();

  const conversation = page.getByLabel("Conversation page");
  const normalHeader = conversation.locator("[data-ui2-normal-conversation-header='true']");
  const searchTrigger = normalHeader.getByRole("button", { name: "Search" });
  await expectDragRegion(normalHeader);
  await expectNoDragControl(searchTrigger);
  await searchTrigger.click();
  await expect(normalHeader.getByRole("textbox", { name: "Search conversation messages" })).toBeFocused();
  await expect(page.locator("[data-desktop-window-drag-owner='content-fallback']")).toBeHidden();

  await navigation.getByRole("button", { name: "Engineering" }).click();
  const channelHeader = page.locator(".channel-header[data-desktop-window-drag-region='true']");
  const channelMenuTrigger = channelHeader.getByRole("button", { name: "More channel views" });
  await expectDragRegion(channelHeader);
  await expectNoDragControl(channelMenuTrigger);
  await channelMenuTrigger.click();
  const channelMenu = page.getByRole("menu", { name: "More channel views" });
  await expectNoDragControl(channelMenu);
  await page.keyboard.press("Escape");
  await expect(channelMenu).toBeHidden();
  await expect(channelMenuTrigger).toBeFocused();
});

test("macOS Settings and Media expose stable drag markers without swallowing toolbar actions", async ({ page }) => {
  await prepareSurface(page, "macos");
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();

  const settingsNavigation = page.locator(".settings-section-nav[data-desktop-window-drag-region='true']");
  const backButton = settingsNavigation.getByRole("button", { name: "Back to app" });
  await expectDragRegion(settingsNavigation);
  await expectNoDragControl(backButton);
  await expect.poll(async () => Math.round((await backButton.boundingBox())?.x ?? -1)).toBeGreaterThanOrEqual(76);
  await backButton.click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  const mediaToolbar = page.locator(".media-production-canvas-toolbar[data-desktop-window-drag-region='true']");
  const jobsButton = mediaToolbar.getByRole("radio", { name: "Generation tasks" });
  await expectDragRegion(mediaToolbar);
  await expectNoDragControl(jobsButton);
  await jobsButton.click();
  await expect(page.locator(".media-production-page")).toHaveClass(/showing-jobs/u);
  await expect(page.locator(".media-production-jobs-view")).toBeVisible();
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

test("macOS private chat stays flush with the titlebar and keeps one dock divider", async ({ page }, testInfo) => {
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

  const header = page.locator(".teammate-chat-header[data-desktop-window-drag-region='true']");
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
  expect(metrics.headerHeight).toBe(48);
  expect(metrics.headerTop).toBe(0);
  expect(metrics.headerLeftInset).toBe(0);
  expect(metrics.identityLeftInset).toBe(18);
  expect(metrics.identityTopInset).toBeCloseTo(10.5, 1);
  expect(metrics.handleLineWidth).toBe("1px");
  expect(metrics.dockBorderLeftWidth).toBe("0px");
  expect(browserErrors).toEqual([]);
  if (process.env.LING_DESIGN_QA_CAPTURE === "1") {
    await page.screenshot({ path: testInfo.outputPath("macos-titlebar.png") });
  }
});

for (const host of [
  { label: "Web", platform: undefined },
  { label: "Windows", platform: "windows" as const },
]) {
  test(`${host.label} does not activate the macOS Desktop chrome`, async ({ page }) => {
    await prepareSurface(page, host.platform);
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
    await page.goto("/");

    const shell = page.locator("main.app-shell");
    await expect(shell).not.toHaveClass(/desktop-macos/u);
    await expect(page.locator("[data-desktop-window-chrome='true']")).toHaveCount(0);

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
    const channelHeader = page.locator(".channel-header[data-desktop-window-drag-region='true']");
    await expect(channelHeader).toBeVisible();
    expect(await appRegion(channelHeader)).not.toBe("drag");
  });
}

async function prepareSurface(page: Page, platform?: "macos" | "windows"): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript((desktopPlatform) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    if (desktopPlatform) {
      Object.defineProperty(window, "lingDesktop", {
        configurable: true,
        value: {
          platform: desktopPlatform,
          daemonBaseUrl: "http://127.0.0.1:17891",
        },
      });
    }
  }, platform);
}

async function installDesktopHost(page: Page, platform: "macos" | "windows"): Promise<void> {
  await page.addInitScript((desktopPlatform) => {
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: desktopPlatform,
        daemonBaseUrl: "http://127.0.0.1:17891",
      },
    });
  }, platform);
}

async function expectDragRegion(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => appRegion(locator)).toBe("drag");
}

async function expectNoDragControl(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => appRegion(locator)).toBe("no-drag");
}

async function appRegion(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region").trim());
}

async function readTrafficLightExclusion(page: Page): Promise<{
  readonly appRegion: string;
  readonly height: string;
  readonly left: string;
  readonly pointerEvents: string;
  readonly top: string;
  readonly width: string;
}> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("main.app-shell.desktop-macos");
    if (!shell) throw new Error("missing macOS shell");
    const style = getComputedStyle(shell, "::after");
    return {
      appRegion: style.getPropertyValue("-webkit-app-region").trim(),
      height: style.height,
      left: style.left,
      pointerEvents: style.pointerEvents,
      top: style.top,
      width: style.width,
    };
  });
}

async function readHomeGeometry(page: Page): Promise<{
  readonly homeHeight: number;
  readonly homeLeft: number;
  readonly homeTop: number;
  readonly homeWidth: number;
  readonly shellHeight: number;
  readonly shellPaddingTop: string;
  readonly workspaceHeight: number;
  readonly workspaceLeft: number;
  readonly workspaceTop: number;
  readonly workspaceWidth: number;
}> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("main.app-shell");
    const workspace = document.querySelector<HTMLElement>("main.app-shell > .workspace");
    const home = document.querySelector<HTMLElement>("[aria-label='Conversation home']");
    if (!shell || !workspace || !home) throw new Error("missing Home geometry target");
    const shellBox = shell.getBoundingClientRect();
    const workspaceBox = workspace.getBoundingClientRect();
    const homeBox = home.getBoundingClientRect();
    return {
      homeHeight: Math.round(homeBox.height),
      homeLeft: Math.round(homeBox.left),
      homeTop: Math.round(homeBox.top),
      homeWidth: Math.round(homeBox.width),
      shellHeight: Math.round(shellBox.height),
      shellPaddingTop: getComputedStyle(shell).paddingTop,
      workspaceHeight: Math.round(workspaceBox.height),
      workspaceLeft: Math.round(workspaceBox.left),
      workspaceTop: Math.round(workspaceBox.top),
      workspaceWidth: Math.round(workspaceBox.width),
    };
  });
}

function installNormalConversationFixture(state: MockState): void {
  const threadId = "thread_desktop_chrome";
  const turnId = "turn_desktop_chrome";
  const runId = "run_desktop_chrome";
  const createdAt = "2026-07-29T01:00:00.000Z";
  const completedAt = "2026-07-29T01:01:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Desktop chrome fixture",
    objective: "Verify normal-conversation Desktop chrome behavior.",
    status: "succeeded",
    lastRunId: runId,
    createdAt,
    updatedAt: completedAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title: "Desktop chrome fixture",
    userInstruction: "Verify the Desktop chrome drag contract.",
    activeRunId: runId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt,
    updatedAt: completedAt,
    completedAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt }];
  state.runs = [{
    id: runId,
    status: "succeeded",
    cwd,
    taskId: "task_desktop_chrome",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_desktop_chrome", title: "Desktop chrome fixture" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: completedAt,
    endedAt: completedAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_desktop_chrome",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "Desktop chrome fixture response." },
  }];
}
