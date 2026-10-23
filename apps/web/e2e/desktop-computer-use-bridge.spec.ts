import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd, type MockState } from "./support/mock-state";

const DESKTOP_BRIDGE_THREAD_ID = "thread_channel_branch_desktop_bridge";
const DESKTOP_BRIDGE_STALE_THREAD_ID = "thread_desktop_bridge_stale";
const DESKTOP_BRIDGE_TEAMMATE_ID = "teammate_desktop_bridge";
const DESKTOP_BRIDGE_TEAMMATE_THREAD_ID = `tdthread_${DESKTOP_BRIDGE_TEAMMATE_ID}`;

interface DesktopComputerUseTestSummary {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly status: "starting" | "running" | "waiting_for_approval" | "paused" | "stopping" | "succeeded" | "failed" | "cancelled";
  readonly targetLabel: string;
  readonly previewAvailable: boolean;
  readonly visible: boolean;
  readonly activePageId?: string;
  readonly pageCount?: number;
}

interface DesktopNavigationTestIntent {
  readonly kind: "open_conversation";
  readonly requestId: number;
  readonly conversationId: string;
}

interface DesktopComputerUseTestHostLayout {
  readonly windowBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly obstacles: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly kind: string;
  }[];
  readonly reportedAt: string;
}

interface DesktopThemeTestInput {
  readonly themeId: string;
  readonly colorScheme: "light" | "dark";
  readonly presentationProfileId: string;
  readonly variables: Readonly<Record<string, string>>;
}

interface DesktopComputerUseTestControl {
  emitNavigationIntent(intent: DesktopNavigationTestIntent): void;
  emit(summary: DesktopComputerUseTestSummary | undefined): void;
  rejectNextHide(message: string): void;
  rejectNextShow(message: string): void;
  rejectNextStop(message: string): void;
  resolveNextHide(result: { readonly accepted: boolean; readonly reason?: string }): void;
  resolveNextShow(result: { readonly accepted: boolean; readonly reason?: string }): void;
  resolveNextStop(result: { readonly accepted: boolean; readonly reason?: string }): void;
  setAutoShowResult(result: { readonly accepted: boolean; readonly reason?: string }): void;
  snapshot(): {
    readonly hideCalls: readonly string[];
    readonly navigationAckCalls: readonly number[];
    readonly navigationListenerCount: number;
    readonly latestHostLayout?: DesktopComputerUseTestHostLayout;
    readonly latestLocale?: "en-US" | "zh-CN";
    readonly pendingHideCount: number;
    readonly pendingShowCount: number;
    readonly pendingStopCount: number;
    readonly reportedLocales: readonly ("en-US" | "zh-CN")[];
    readonly reportedThemes: readonly DesktopThemeTestInput[];
    readonly selectedConversationId?: string;
    readonly selectedDeckOwner?: {
      readonly surfaceKind: "channel" | "normal_conversation" | "teammate_direct";
      readonly ownerId: string;
    };
    readonly showCalls: readonly string[];
    readonly stopCalls: readonly string[];
    readonly subscribeCalls: number;
    readonly unsubscribeCalls: number;
    readonly listenerCount: number;
  };
}

declare global {
  interface Window {
    __desktopComputerUseTest: DesktopComputerUseTestControl;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    let selectedConversationId: string | undefined;
    let selectedDeckOwner: {
      readonly surfaceKind: "channel" | "normal_conversation" | "teammate_direct";
      readonly ownerId: string;
    } | undefined;
    let latestHostLayout: DesktopComputerUseTestHostLayout | undefined;
    const reportedLocales: Array<"en-US" | "zh-CN"> = [];
    const reportedThemes: DesktopThemeTestInput[] = [];
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;
    let autoShowResult: { readonly accepted: boolean; readonly reason?: string } = { accepted: true };
    let pendingNavigationIntent: DesktopNavigationTestIntent | undefined;
    const navigationAckCalls: number[] = [];
    const navigationListeners = new Set<(intent: DesktopNavigationTestIntent) => void>();
    const showCalls: string[] = [];
    const hideCalls: string[] = [];
    const stopCalls: string[] = [];
    const pendingShows: Array<{
      readonly resolve: (result: { readonly accepted: boolean; readonly reason?: string }) => void;
      readonly reject: (error: Error) => void;
    }> = [];
    const pendingHides: Array<{
      readonly resolve: (result: { readonly accepted: boolean; readonly reason?: string }) => void;
      readonly reject: (error: Error) => void;
    }> = [];
    const pendingStops: Array<{
      readonly resolve: (result: { readonly accepted: boolean; readonly reason?: string }) => void;
      readonly reject: (error: Error) => void;
    }> = [];
    const listeners = new Set<(summary: DesktopComputerUseTestSummary | undefined) => void>();
    window.__desktopComputerUseTest = {
      emitNavigationIntent(intent) {
        pendingNavigationIntent = intent;
        navigationListeners.forEach((listener) => listener(intent));
      },
      emit(summary) {
        listeners.forEach((listener) => listener(summary));
      },
      rejectNextHide(message) {
        pendingHides.shift()?.reject(new Error(message));
      },
      rejectNextShow(message) {
        pendingShows.shift()?.reject(new Error(message));
      },
      rejectNextStop(message) {
        pendingStops.shift()?.reject(new Error(message));
      },
      resolveNextHide(result) {
        pendingHides.shift()?.resolve(result);
      },
      resolveNextShow(result) {
        pendingShows.shift()?.resolve(result);
      },
      resolveNextStop(result) {
        pendingStops.shift()?.resolve(result);
      },
      setAutoShowResult(result) {
        autoShowResult = result;
      },
      snapshot() {
        return {
          hideCalls: [...hideCalls],
          navigationAckCalls: [...navigationAckCalls],
          navigationListenerCount: navigationListeners.size,
          latestHostLayout,
          latestLocale: reportedLocales.at(-1),
          pendingHideCount: pendingHides.length,
          pendingShowCount: pendingShows.length,
          pendingStopCount: pendingStops.length,
          reportedLocales: [...reportedLocales],
          reportedThemes: [...reportedThemes],
          selectedConversationId,
          selectedDeckOwner,
          showCalls: [...showCalls],
          stopCalls: [...stopCalls],
          subscribeCalls,
          unsubscribeCalls,
          listenerCount: listeners.size,
        };
      },
    };
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
        appearance: {
          reportTheme(theme: DesktopThemeTestInput) {
            reportedThemes.push(theme);
          },
        },
        navigation: {
          async acknowledgeIntent(requestId: number) {
            navigationAckCalls.push(requestId);
            if (pendingNavigationIntent?.requestId !== requestId) {
              return { accepted: false, reason: "stale_navigation_intent" };
            }
            pendingNavigationIntent = undefined;
            return { accepted: true };
          },
          onIntent(listener: (intent: DesktopNavigationTestIntent) => void) {
            navigationListeners.add(listener);
            if (pendingNavigationIntent) {
              queueMicrotask(() => {
                if (pendingNavigationIntent) {
                  listener(pendingNavigationIntent);
                }
              });
            }
            return () => navigationListeners.delete(listener);
          },
        },
        computerUse: {
          reportLocale(locale: "en-US" | "zh-CN") {
            reportedLocales.push(locale);
          },
          reportSelectedDeckOwner(owner?: {
            readonly surfaceKind: "channel" | "normal_conversation" | "teammate_direct";
            readonly ownerId: string;
          }) {
            selectedDeckOwner = owner;
            selectedConversationId = owner?.ownerId;
          },
          reportSelectedConversation(conversationId?: string) {
            selectedConversationId = conversationId;
          },
          reportHostLayout(layout: DesktopComputerUseTestHostLayout) {
            latestHostLayout = layout;
          },
          show(sessionId: string) {
            showCalls.push(sessionId);
            return new Promise<{ readonly accepted: boolean; readonly reason?: string }>((resolve, reject) => {
              pendingShows.push({ resolve, reject });
            });
          },
          hide(sessionId: string) {
            hideCalls.push(sessionId);
            return new Promise<{ readonly accepted: boolean; readonly reason?: string }>((resolve, reject) => {
              pendingHides.push({ resolve, reject });
            });
          },
          stop(sessionId: string) {
            stopCalls.push(sessionId);
            return new Promise<{ readonly accepted: boolean; readonly reason?: string }>((resolve, reject) => {
              pendingStops.push({ resolve, reject });
            });
          },
          getPreferences: async () => ({ previewAutoShow: true }),
          setAutoShow: async () => autoShowResult,
          onSummaryChanged(listener: (summary: DesktopComputerUseTestSummary | undefined) => void) {
            subscribeCalls += 1;
            listeners.add(listener);
            return () => {
              unsubscribeCalls += 1;
              listeners.delete(listener);
            };
          },
        },
      },
    });
  });
  const state = createBaseState({ approvalStatus: "pending" });
  seedDesktopBridgeConversationSurfaces(state);
  state.channelBranches = [{
    id: "channel_branch_desktop_bridge",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    name: "Desktop bridge test",
    status: "active",
    rootThreadId: DESKTOP_BRIDGE_THREAD_ID,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  }];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Desktop bridge test" }).click();
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId).toBeTruthy();
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedDeckOwner).toEqual({
    surfaceKind: "channel",
    ownerId: DESKTOP_BRIDGE_THREAD_ID,
  });
});

test("reports initial and runtime locale changes through the narrow Desktop capability", async ({ page }) => {
  await expect.poll(async () => (await desktopControlSnapshot(page)).latestLocale).toBe("en-US");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByLabel("Product language").selectOption("zh-CN");
  await expect.poll(async () => (await desktopControlSnapshot(page)).latestLocale).toBe("zh-CN");
  await page.getByLabel("产品语言").selectOption("en-US");
  await expect.poll(async () => (await desktopControlSnapshot(page)).latestLocale).toBe("en-US");

  const compacted = (await desktopControlSnapshot(page)).reportedLocales.filter(
    (locale, index, values) => index === 0 || values[index - 1] !== locale,
  );
  expect(compacted).toEqual(["en-US", "zh-CN", "en-US"]);
});

test("reports resolved theme changes through the narrow Desktop appearance capability", async ({ page }) => {
  await expect.poll(async () => (await desktopControlSnapshot(page)).reportedThemes.at(-1)).toMatchObject({
    themeId: "ling-light",
    colorScheme: "light",
    presentationProfileId: "ling-standard",
    variables: {
      "--ling-bg-app": "#ffffff",
      "--ling-compact-window-bg": "#ffffff",
      "--ling-compact-window-text": "#191c1f",
    },
  });

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("radiogroup", { name: "Theme packs" }).getByRole("radio", { name: /Ling Dark/ }).click();
  await expect.poll(async () => (await desktopControlSnapshot(page)).reportedThemes.at(-1)).toMatchObject({
    themeId: "ling-dark",
    colorScheme: "dark",
    presentationProfileId: "ling-standard",
    variables: {
      "--ling-bg-app": "#1f1f1f",
      "--ling-compact-window-bg": "#1f1f1f",
      "--ling-compact-window-text": "#f4f5f6",
    },
  });
});

test("keeps a session-only auto-show change and warns when Desktop cannot persist it", async ({ page }) => {
  await page.evaluate(() => window.__desktopComputerUseTest.setAutoShowResult({
    accepted: true,
    reason: "desktop_preferences_not_persisted",
  }));
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();

  const toggle = page.getByLabel("Automatically show Computer Use picture-in-picture");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("status")).toContainText(
    "Changed for this session, but not saved. It may revert after restart.",
  );
});

test("Open task intent leaves Settings, teammate, or a blank home and selects the requested conversation", async ({ page }) => {
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationListenerCount).toBe(1);
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });

  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await emitDesktopNavigationIntent(page, 1, DESKTOP_BRIDGE_THREAD_ID);
  await expect(page.locator(".normal-conversation-header")).toBeVisible();
  await expect(page.getByText("The header capability slot is ready.")).toBeVisible();
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([1]);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId)
    .toBe(DESKTOP_BRIDGE_THREAD_ID);

  await openDesktopBridgeTeammate(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId)
    .toBe(DESKTOP_BRIDGE_TEAMMATE_THREAD_ID);
  await emitDesktopNavigationIntent(page, 2, DESKTOP_BRIDGE_THREAD_ID);
  await expect(page.locator(".normal-conversation-header")).toBeVisible();
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([1, 2]);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByLabel("Conversation home")).toBeVisible();
  await expect(page.locator(".normal-conversation-header")).toHaveCount(0);
  await emitDesktopNavigationIntent(page, 3, DESKTOP_BRIDGE_THREAD_ID);
  await expect(page.locator(".normal-conversation-header")).toBeVisible();
  await expect(page.getByText("The header capability slot is ready.")).toBeVisible();
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([1, 2, 3]);
});

test("a newer Open task intent wins while an older conversation lookup is still settling", async ({ page }) => {
  const staleDetail = await page.evaluate(async ({ threadId, workspaceCwd }) => {
    const response = await fetch(
      `http://127.0.0.1:17891/conversations/${encodeURIComponent(threadId)}?cwd=${encodeURIComponent(workspaceCwd)}`,
    );
    return response.json();
  }, { threadId: DESKTOP_BRIDGE_STALE_THREAD_ID, workspaceCwd: cwd });
  let releaseStaleLookup: (() => void) | undefined;
  let markStaleLookupStarted: (() => void) | undefined;
  const staleLookupStarted = new Promise<void>((resolve) => {
    markStaleLookupStarted = resolve;
  });
  const staleLookupRelease = new Promise<void>((resolve) => {
    releaseStaleLookup = resolve;
  });
  await page.route(`**/conversations/${DESKTOP_BRIDGE_STALE_THREAD_ID}*`, async (route) => {
    markStaleLookupStarted?.();
    await staleLookupRelease;
    await route.fulfill({ json: staleDetail });
  });

  await page.evaluate((targetConversationId) => {
    window.__desktopComputerUseTest.emitNavigationIntent({
      kind: "open_conversation",
      requestId: 41,
      conversationId: "thread_desktop_bridge_stale",
    });
  }, DESKTOP_BRIDGE_THREAD_ID);
  await staleLookupStarted;
  await page.evaluate((targetConversationId) => {
    window.__desktopComputerUseTest.emitNavigationIntent({
      kind: "open_conversation",
      requestId: 42,
      conversationId: targetConversationId,
    });
  }, DESKTOP_BRIDGE_THREAD_ID);

  await expect(page.locator(".normal-conversation-header")).toBeVisible();
  await expect(page.getByText("The header capability slot is ready.")).toBeVisible();
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([42]);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId)
    .toBe(DESKTOP_BRIDGE_THREAD_ID);
  releaseStaleLookup?.();
  await page.waitForTimeout(100);
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([42]);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId)
    .toBe(DESKTOP_BRIDGE_THREAD_ID);
});

test("Open task waits for the Desktop workspace authority before acknowledging navigation", async ({ page }) => {
  await page.route("http://127.0.0.1:17891/health", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.fulfill({
      json: {
        ok: true,
        service: "ling-stack-daemon",
        defaultWorkspaceCwd: cwd,
        features: {
          channels: { autoRoute: false },
        },
      },
    });
  });

  await page.reload();
  await page.evaluate((targetConversationId) => {
    window.__desktopComputerUseTest.emitNavigationIntent({
      kind: "open_conversation",
      requestId: 51,
      conversationId: targetConversationId,
    });
  }, DESKTOP_BRIDGE_THREAD_ID);

  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([]);
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationListenerCount).toBe(1);
  await expect(page.locator(".normal-conversation-header")).toBeVisible();
  await expect(page.getByText("The header capability slot is ready.")).toBeVisible();
  await expect.poll(async () => (await desktopControlSnapshot(page)).navigationAckCalls).toEqual([51]);
});

test("mounts the current Computer Use entry in channel, normal conversation, and teammate-direct headers", async ({ page }) => {
  await emitComputerUseSummary(page, { sessionId: "computer-use-channel" });
  await expect(page.locator(".channel-header").getByLabel("Computer Use preview controls")).toBeVisible();
  await expect(page.locator(".workspace").locator(":scope > [aria-label='Computer Use preview controls']")).toHaveCount(0);

  await openDesktopBridgeNormalConversation(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId).toBe(DESKTOP_BRIDGE_THREAD_ID);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedDeckOwner).toEqual({
    surfaceKind: "normal_conversation",
    ownerId: DESKTOP_BRIDGE_THREAD_ID,
  });
  await expect(page.locator(".normal-conversation-header").getByLabel("Computer Use preview controls")).toBeVisible();

  await openDesktopBridgeTeammate(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId).toBe(DESKTOP_BRIDGE_TEAMMATE_THREAD_ID);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedDeckOwner).toEqual({
    surfaceKind: "teammate_direct",
    ownerId: DESKTOP_BRIDGE_TEAMMATE_THREAD_ID,
  });
  await emitComputerUseSummary(page, { sessionId: "computer-use-teammate" });
  await expect(page.locator(".teammate-chat-header").getByLabel("Computer Use preview controls")).toBeVisible();
});

test("keeps active and stopping states in the header with state-specific tone, then unmounts terminal summaries", async ({ page }) => {
  const controls = page.getByLabel("Computer Use preview controls");
  const dot = controls.locator(".ling-ui-status-indicator-dot");

  await emitComputerUseSummary(page, { status: "starting", previewAvailable: false, visible: false });
  await expect(controls).toHaveAttribute("data-status", "starting");
  await expect(controls.getByRole("button", { name: "Show" })).toHaveCount(0);
  await expect(controls.getByRole("button", { name: "Stop" })).toBeEnabled();
  const startingTone = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);

  await emitComputerUseSummary(page, { status: "running" });
  await expect(controls).toHaveAttribute("data-status", "running");
  const runningTone = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);

  await emitComputerUseSummary(page, { status: "waiting_for_approval", previewAvailable: false, visible: false });
  await expect(controls).toHaveAttribute("data-status", "waiting_for_approval");
  await expect(controls.getByRole("button", { name: "Show" })).toHaveCount(0);
  const approvalTone = await dot.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(new Set([startingTone, runningTone, approvalTone]).size).toBe(3);

  await emitComputerUseSummary(page, { status: "paused" });
  await expect(controls).toContainText("Paused");
  await expect(controls.getByRole("button", { name: "Stop" })).toBeEnabled();

  await emitComputerUseSummary(page, { status: "stopping" });
  await expect(controls).toHaveAttribute("data-status", "stopping");
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();
  await expect(controls.getByRole("button", { name: "Hide" })).toBeEnabled();

  await emitComputerUseSummary(page, { status: "stopping", visible: false });
  await expect(controls.getByRole("button", { name: "Show" })).toHaveCount(0);
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();

  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    await emitComputerUseSummary(page, { status });
    await expect(controls).toHaveCount(0);
    await expect(page.locator("[data-current-session-header-capability-slot='true']")).toBeEmpty();
    await emitComputerUseSummary(page, { status: "running" });
    await expect(controls).toBeVisible();
  }
});

test("remounts the header slot without duplicating the bridge subscription or losing an in-flight command", async ({ page }) => {
  await openDesktopBridgeNormalConversation(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId).toBe(DESKTOP_BRIDGE_THREAD_ID);
  await emitComputerUseSummary(page, { sessionId: "computer-use-slot-remount", visible: true });

  const normalControls = page.locator(".normal-conversation-header").getByLabel("Computer Use preview controls");
  await normalControls.getByRole("button", { name: "Hide" }).click();
  await expect(normalControls.getByRole("button", { name: "Hiding" })).toBeDisabled();
  const subscriptionBaseline = await desktopControlSnapshot(page);
  expect(subscriptionBaseline.listenerCount).toBe(1);

  await openDesktopBridgeChannel(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId).toBe(DESKTOP_BRIDGE_THREAD_ID);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedDeckOwner).toEqual({
    surfaceKind: "channel",
    ownerId: DESKTOP_BRIDGE_THREAD_ID,
  });
  const channelControls = page.locator(".channel-header").getByLabel("Computer Use preview controls");
  await expect(channelControls.getByRole("button", { name: "Hiding" })).toBeDisabled();
  await expect.poll(async () => await desktopControlSnapshot(page)).toMatchObject({
    listenerCount: 1,
    pendingHideCount: 1,
    hideCalls: ["computer-use-slot-remount"],
    subscribeCalls: subscriptionBaseline.subscribeCalls,
    unsubscribeCalls: subscriptionBaseline.unsubscribeCalls,
  });

  await page.evaluate(() => window.__desktopComputerUseTest.resolveNextHide({ accepted: true }));
  await expect(channelControls.getByRole("button", { name: "Hiding" })).toBeDisabled();
  await emitComputerUseSummary(page, { sessionId: "computer-use-slot-remount", visible: false });
  await expect(channelControls.getByRole("button", { name: "Show" })).toBeEnabled();
});

test("keeps header controls inside a 640px viewport with 32px action targets", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await openDesktopBridgeChannel(page);
  await page.setViewportSize({ width: 640, height: 760 });
  await emitComputerUseSummary(page, { sessionId: "computer-use-narrow" });
  await expectNarrowHeaderControl(page, ".channel-header");

  await page.setViewportSize({ width: 1280, height: 760 });
  await emitDesktopNavigationIntent(page, 100, DESKTOP_BRIDGE_THREAD_ID);
  await expect(page.locator(".normal-conversation-header")).toBeVisible();
  await page.setViewportSize({ width: 640, height: 760 });
  await expectNarrowHeaderControl(page, ".normal-conversation-header");

  await page.setViewportSize({ width: 1280, height: 760 });
  const showNavigation = page.getByRole("button", { name: "Show navigation" });
  if (await showNavigation.isVisible()) await showNavigation.click();
  await openDesktopBridgeTeammate(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId).toBe(DESKTOP_BRIDGE_TEAMMATE_THREAD_ID);
  await emitComputerUseSummary(page, { sessionId: "computer-use-narrow-teammate" });
  await page.setViewportSize({ width: 640, height: 760 });
  await expectNarrowHeaderControl(page, ".teammate-chat-header");
});

test("reports teammate-direct composer, summary, dock, and terminal obstacles", async ({ page }) => {
  await openDesktopBridgeTeammate(page);
  await expect.poll(async () => (await desktopControlSnapshot(page)).selectedConversationId)
    .toBe(DESKTOP_BRIDGE_TEAMMATE_THREAD_ID);

  const hideNavigation = page.getByRole("button", { name: "Hide navigation" });
  await hideNavigation.click();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveAttribute("data-sidebar-mode", "compact");

  const directComposer = page.locator(
    '[data-surface="teammate_direct"][data-computer-use-obstacle-kind="composer"]',
  );
  await expect(directComposer).toHaveAttribute("data-computer-use-obstacle", "true");

  const header = page.locator(".teammate-chat-header");
  await header.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".teammate-private-right-dock-frame");
  await expect(dock).toHaveAttribute("data-computer-use-obstacle", "true");
  await expect(dock).toHaveAttribute("data-computer-use-obstacle-kind", "right-dock");

  await header.getByRole("button", { name: "Summary", exact: true }).click();
  const summary = page.locator(".teammate-private-summary-panel");
  await expect(summary).toHaveAttribute("data-computer-use-obstacle", "true");
  await expect(summary).toHaveAttribute("data-computer-use-obstacle-kind", "summary");
  await expect(summary).toBeVisible();
  await expect.poll(async () => {
    const layout = (await desktopControlSnapshot(page)).latestHostLayout;
    return layout?.obstacles.map((obstacle) => obstacle.kind) ?? [];
  }).toContain("popover");

  await header.getByRole("button", { name: "Terminal" }).click();
  const terminal = page.locator(".teammate-private-bottom-terminal");
  await expect(terminal).toHaveAttribute("data-computer-use-obstacle", "true");
  await expect(terminal).toHaveAttribute("data-computer-use-obstacle-kind", "terminal");
  await expect(summary).toBeVisible();
  await expect(header.getByRole("button", { name: "Summary", exact: true })).toHaveAttribute("aria-pressed", "true");

  await expect.poll(async () => {
    const layout = (await desktopControlSnapshot(page)).latestHostLayout;
    return layout?.obstacles.map((obstacle) => obstacle.kind) ?? [];
  }).toEqual(expect.arrayContaining(["composer", "dock", "popover", "terminal"]));
});

test("Show and Hide suppress duplicates, wait for projection ownership, and expose safe failures", async ({ page }) => {
  await emitComputerUseSummary(page, { sessionId: "computer-use-visibility", visible: true });
  const controls = page.getByLabel("Computer Use preview controls");
  const hideButton = controls.getByRole("button", { name: "Hide" });

  await hideButton.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(controls.getByRole("button", { name: "Hiding" })).toBeDisabled();
  await expect.poll(async () => await desktopControlSnapshot(page)).toMatchObject({
    hideCalls: ["computer-use-visibility"],
    pendingHideCount: 1,
  });

  await page.evaluate(() => {
    window.__desktopComputerUseTest.resolveNextHide({
      accepted: false,
      reason: "private Desktop release reason",
    });
  });
  const visibilityAlert = controls.locator("[data-visibility-error-action]");
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-action", "hide");
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-kind", "not-accepted");
  await expect(visibilityAlert).toContainText("Unable to hide preview");
  await expect(visibilityAlert).toContainText("The task is still running. Try again.");
  await expect(controls).not.toContainText("private Desktop release reason");
  await expect(hideButton).toBeEnabled();

  await hideButton.click();
  await page.evaluate(() => window.__desktopComputerUseTest.resolveNextHide({ accepted: true }));
  await expect(controls.getByRole("button", { name: "Hiding" })).toBeDisabled();
  await emitComputerUseSummary(page, { sessionId: "computer-use-visibility", visible: false });
  const showButton = controls.getByRole("button", { name: "Show" });
  await expect(showButton).toBeEnabled();

  await showButton.click();
  await page.evaluate(() => window.__desktopComputerUseTest.rejectNextShow("private IPC stack"));
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-action", "show");
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-kind", "unavailable");
  await expect(visibilityAlert).toContainText("Unable to show preview");
  await expect(visibilityAlert).toContainText("Desktop could not update the preview.");
  await expect(controls).not.toContainText("private IPC stack");
  await expect.poll(async () => (await desktopControlSnapshot(page)).showCalls).toEqual([
    "computer-use-visibility",
  ]);
});

test("accepted Show and Hide fail retryably when the authoritative summary never converges", async ({ page }) => {
  await page.clock.install();
  await emitComputerUseSummary(page, {
    sessionId: "computer-use-visibility-convergence",
    visible: false,
  });
  const controls = page.getByLabel("Computer Use preview controls");
  const visibilityAlert = controls.locator("[data-visibility-error-action]");

  await controls.getByRole("button", { name: "Show" }).click();
  await page.evaluate(() => window.__desktopComputerUseTest.resolveNextShow({ accepted: true }));
  await expect(controls.getByRole("button", { name: "Showing" })).toBeDisabled();

  await page.clock.fastForward(10_001);
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-action", "show");
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-kind", "unavailable");
  await expect(controls.getByRole("button", { name: "Show" })).toBeEnabled();

  await emitComputerUseSummary(page, {
    sessionId: "computer-use-visibility-convergence",
    visible: true,
  });
  await expect(visibilityAlert).toHaveCount(0);

  await controls.getByRole("button", { name: "Hide" }).click();
  await page.evaluate(() => window.__desktopComputerUseTest.resolveNextHide({ accepted: true }));
  await expect(controls.getByRole("button", { name: "Hiding" })).toBeDisabled();

  await page.clock.fastForward(10_001);
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-action", "hide");
  await expect(visibilityAlert).toHaveAttribute("data-visibility-error-kind", "unavailable");
  await expect(controls.getByRole("button", { name: "Hide" })).toBeEnabled();
});

test("Stop prevents duplicate requests and exposes safe assertive feedback", async ({ page }) => {
  await emitComputerUseSummary(page, { sessionId: "computer-use-1" });
  const controls = page.getByLabel("Computer Use preview controls");
  const stopButton = controls.getByRole("button", { name: "Stop" });
  await expect(stopButton).toBeVisible();

  await stopButton.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();
  await expect.poll(async () => await desktopControlSnapshot(page)).toMatchObject({
    pendingStopCount: 1,
    stopCalls: ["computer-use-1"],
  });

  await page.evaluate(() => {
    window.__desktopComputerUseTest.resolveNextStop({
      accepted: false,
      reason: "internal session token must never be rendered",
    });
  });
  const alert = controls.getByRole("alert");
  await expect(alert).toHaveAttribute("aria-live", "assertive");
  await expect(alert).toHaveAttribute("aria-atomic", "true");
  await expect(alert).toHaveAttribute("data-stop-error-kind", "not-accepted");
  await expect(alert).toContainText("Unable to stop Computer Use");
  await expect(alert).toContainText("The task may still be running. Try again.");
  await expect(controls).not.toContainText("internal session token");
  await expect(stopButton).toBeEnabled();

  await stopButton.click();
  await page.evaluate(() => {
    window.__desktopComputerUseTest.rejectNextStop("private IPC stack and source descriptor");
  });
  await expect(alert).toHaveAttribute("data-stop-error-kind", "unavailable");
  await expect(alert).toContainText("Desktop could not send the stop request.");
  await expect(controls).not.toContainText("private IPC stack");
  await expect.poll(async () => (await desktopControlSnapshot(page)).stopCalls).toEqual([
    "computer-use-1",
    "computer-use-1",
  ]);
});

test("accepted Stop remains pending until the projection enters stopping", async ({ page }) => {
  await emitComputerUseSummary(page, { sessionId: "computer-use-accepted" });
  const controls = page.getByLabel("Computer Use preview controls");
  await controls.getByRole("button", { name: "Stop" }).click();
  await page.evaluate(() => window.__desktopComputerUseTest.resolveNextStop({ accepted: true }));

  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();
  await expect(controls).toContainText("Live");
  await expect(controls.getByRole("alert")).toHaveCount(0);

  await emitComputerUseSummary(page, { sessionId: "computer-use-accepted", status: "running" });
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();

  await emitComputerUseSummary(page, { sessionId: "computer-use-accepted", status: "stopping" });
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();
  await expect(controls).toContainText("Stopping");
});

test("accepted Stop fails retryably when the authoritative projection never converges", async ({ page }) => {
  await page.clock.install();
  await emitComputerUseSummary(page, { sessionId: "computer-use-stop-convergence" });
  const controls = page.getByLabel("Computer Use preview controls");
  await controls.getByRole("button", { name: "Stop" }).click();
  await page.evaluate(() => window.__desktopComputerUseTest.resolveNextStop({ accepted: true }));
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();

  await page.clock.fastForward(10_001);
  const alert = controls.getByRole("alert");
  await expect(alert).toHaveAttribute("data-stop-error-kind", "unavailable");
  await expect(controls.getByRole("button", { name: "Stop" })).toBeEnabled();

  await emitComputerUseSummary(page, {
    sessionId: "computer-use-stop-convergence",
    status: "stopping",
  });
  await expect(alert).toHaveCount(0);
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();
});

test("a hung Desktop command times out and ignores its late result", async ({ page }) => {
  await page.clock.install();
  await emitComputerUseSummary(page, { sessionId: "computer-use-timeout" });
  const controls = page.getByLabel("Computer Use preview controls");
  await controls.getByRole("button", { name: "Stop" }).click();
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();

  await page.clock.fastForward(10_001);
  const alert = controls.getByRole("alert");
  await expect(alert).toHaveAttribute("data-stop-error-kind", "unavailable");
  await expect(controls.getByRole("button", { name: "Stop" })).toBeEnabled();

  await page.evaluate(() => {
    window.__desktopComputerUseTest.resolveNextStop({
      accepted: false,
      reason: "late internal timeout result",
    });
  });
  await expect(alert).toHaveAttribute("data-stop-error-kind", "unavailable");
  await expect(controls).not.toContainText("late internal timeout result");

  await controls.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => await desktopControlSnapshot(page)).toMatchObject({
    pendingStopCount: 1,
    stopCalls: ["computer-use-timeout", "computer-use-timeout"],
  });
  await page.evaluate(() => window.__desktopComputerUseTest.rejectNextStop("cleanup"));
});

test("a result from a replaced session cannot overwrite the current controls", async ({ page }) => {
  await emitComputerUseSummary(page, { sessionId: "computer-use-old", targetLabel: "Old target" });
  const controls = page.getByLabel("Computer Use preview controls");
  await controls.getByRole("button", { name: "Stop" }).click();

  await emitComputerUseSummary(page, { sessionId: "computer-use-new", targetLabel: "Current target" });
  await expect(controls).toContainText("Current target");
  await expect(controls.getByRole("button", { name: "Stop" })).toBeEnabled();
  await controls.getByRole("button", { name: "Stop" }).click();

  await page.evaluate(() => {
    window.__desktopComputerUseTest.resolveNextStop({
      accepted: false,
      reason: "stale internal failure",
    });
  });
  await expect(controls.getByRole("alert")).toHaveCount(0);
  await expect(controls).not.toContainText("stale internal failure");
  await expect(controls).toContainText("Current target");
  await expect(controls.getByRole("button", { name: "Stopping" })).toBeDisabled();

  await page.evaluate(() => {
    window.__desktopComputerUseTest.resolveNextStop({
      accepted: false,
      reason: "current internal failure",
    });
  });
  await expect(controls.getByRole("alert")).toHaveAttribute("data-stop-error-kind", "not-accepted");
  await expect(controls).not.toContainText("current internal failure");
  await expect.poll(async () => (await desktopControlSnapshot(page)).stopCalls).toEqual([
    "computer-use-old",
    "computer-use-new",
  ]);
});

test("host layout reports canonical obstacle kinds and fails unknown values safe", async ({ page }) => {
  await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (!workspace) {
      throw new Error("Workspace host is unavailable.");
    }
    const fixture = document.createElement("div");
    fixture.dataset.testComputerUseObstacles = "true";
    const kinds = [
      "composer",
      "approval",
      "modal",
      "dock",
      "terminal",
      "unknown",
      "right-dock",
      "summary",
      "not-a-supported-kind",
    ];
    kinds.forEach((kind, index) => {
      const obstacle = document.createElement("div");
      obstacle.dataset.computerUseObstacle = "true";
      obstacle.dataset.computerUseObstacleKind = kind;
      obstacle.style.position = "fixed";
      obstacle.style.left = `${40 + index * 24}px`;
      obstacle.style.top = "40px";
      obstacle.style.width = "16px";
      obstacle.style.height = "16px";
      fixture.append(obstacle);
    });
    workspace.append(fixture);
  });

  await expect.poll(async () => {
    const layout = (await desktopControlSnapshot(page)).latestHostLayout;
    return layout?.obstacles.map((obstacle) => obstacle.kind) ?? [];
  }).toEqual(expect.arrayContaining([
    "composer",
    "approval",
    "modal",
    "dock",
    "terminal",
    "unknown",
    "popover",
  ]));
  const reportedKinds = (await desktopControlSnapshot(page)).latestHostLayout?.obstacles
    .map((obstacle) => obstacle.kind) ?? [];
  expect(reportedKinds).not.toContain("right-dock");
  expect(reportedKinds).not.toContain("summary");
  expect(reportedKinds).not.toContain("not-a-supported-kind");
});

test("auto-marked modal obstacles release ownership when modal identity ends", async ({ page }) => {
  const modalRect = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (!workspace) {
      throw new Error("Workspace host is unavailable.");
    }
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.style.position = "fixed";
    dialog.style.left = "720px";
    dialog.style.top = "180px";
    dialog.style.width = "40px";
    dialog.style.height = "30px";
    workspace.append(dialog);
    (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture = dialog;
    const bounds = dialog.getBoundingClientRect();
    return {
      x: window.screenX + bounds.left,
      y: window.screenY + bounds.top,
    };
  });

  await expect.poll(async () => page.evaluate(() => {
    const dialog = (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture;
    return {
      obstacle: dialog?.getAttribute("data-computer-use-obstacle"),
      kind: dialog?.getAttribute("data-computer-use-obstacle-kind"),
    };
  })).toEqual({ obstacle: "true", kind: "modal" });

  await page.evaluate(() => {
    const dialog = (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture;
    dialog?.removeAttribute("role");
    dialog?.removeAttribute("aria-modal");
  });
  await expect.poll(async () => page.evaluate(() => {
    const dialog = (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture;
    return {
      obstacle: dialog?.getAttribute("data-computer-use-obstacle"),
      kind: dialog?.getAttribute("data-computer-use-obstacle-kind"),
    };
  })).toEqual({ obstacle: null, kind: null });
  await expect.poll(async () => {
    const obstacles = (await desktopControlSnapshot(page)).latestHostLayout?.obstacles ?? [];
    return obstacles.some((obstacle) => (
      Math.abs(obstacle.x - modalRect.x) < 1
      && Math.abs(obstacle.y - modalRect.y) < 1
    ));
  }).toBe(false);

  await page.evaluate(() => {
    const dialog = (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture;
    dialog?.setAttribute("role", "dialog");
    dialog?.setAttribute("aria-modal", "true");
  });
  await expect.poll(async () => page.evaluate(() => {
    const dialog = (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture;
    return dialog?.getAttribute("data-computer-use-obstacle-kind");
  })).toBe("modal");

  await page.evaluate(() => {
    (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture?.remove();
  });
  await expect.poll(async () => page.evaluate(() => {
    const dialog = (window as Window & { __desktopComputerUseModalFixture?: HTMLElement }).__desktopComputerUseModalFixture;
    return {
      connected: dialog?.isConnected,
      obstacle: dialog?.getAttribute("data-computer-use-obstacle"),
      kind: dialog?.getAttribute("data-computer-use-obstacle-kind"),
    };
  })).toEqual({ connected: false, obstacle: null, kind: null });
});

async function emitComputerUseSummary(
  page: Page,
  overrides: Partial<Omit<DesktopComputerUseTestSummary, "conversationId">> = {},
): Promise<void> {
  const snapshot = await desktopControlSnapshot(page);
  const conversationId = snapshot.selectedConversationId;
  if (!conversationId) {
    throw new Error("Desktop bridge did not report a selected conversation.");
  }
  await page.evaluate(({ activeConversationId, summaryOverrides }) => {
    window.__desktopComputerUseTest.emit({
      sessionId: "computer-use-session",
      conversationId: activeConversationId,
      status: "running",
      targetLabel: "Authorized browser target",
      previewAvailable: true,
      visible: true,
      ...summaryOverrides,
    });
  }, { activeConversationId: conversationId, summaryOverrides: overrides });
}

async function desktopControlSnapshot(page: Page): Promise<ReturnType<DesktopComputerUseTestControl["snapshot"]>> {
  return page.evaluate(() => window.__desktopComputerUseTest.snapshot());
}

async function emitDesktopNavigationIntent(
  page: Page,
  requestId: number,
  conversationId: string,
): Promise<void> {
  await page.evaluate(({ navigationRequestId, targetConversationId }) => {
    window.__desktopComputerUseTest.emitNavigationIntent({
      kind: "open_conversation",
      requestId: navigationRequestId,
      conversationId: targetConversationId,
    });
  }, { navigationRequestId: requestId, targetConversationId: conversationId });
}

async function openDesktopBridgeChannel(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Desktop bridge test" }).click();
  await expect(page.locator(".channel-header")).toBeVisible();
}

async function openDesktopBridgeNormalConversation(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .locator(".sidebar-recent-row")
    .filter({ hasText: "Desktop normal conversation" })
    .click();
  await expect(page.locator(".normal-conversation-header")).toBeVisible();
}

async function openDesktopBridgeTeammate(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Desktop Teammate", exact: true }).click();
  await expect(page.locator(".teammate-chat-header")).toBeVisible();
}

async function expectNarrowHeaderControl(page: Page, headerSelector: string): Promise<void> {
  const header = page.locator(headerSelector);
  const controls = header.getByLabel("Computer Use preview controls");
  await expect(controls).toBeVisible();
  const geometry = await controls.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const headerBounds = element.closest("header, section")?.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      position: getComputedStyle(element).position,
      headerLeft: headerBounds?.left,
      headerRight: headerBounds?.right,
    };
  });
  expect(geometry.position).toBe("relative");
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.headerLeft ?? 0);
  expect(geometry.right).toBeLessThanOrEqual((geometry.headerRight ?? 640) + 1);
  expect(geometry.right).toBeLessThanOrEqual(641);
  expect(geometry.width).toBeGreaterThanOrEqual(75);

  const actionSizes = await controls.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }));
  expect(actionSizes).toHaveLength(2);
  for (const size of actionSizes) {
    expect(size.width).toBeGreaterThanOrEqual(32);
    expect(size.height).toBeGreaterThanOrEqual(32);
  }
}

function seedDesktopBridgeConversationSurfaces(state: MockState): void {
  const turnId = "turn_desktop_bridge_normal";
  const runId = "run_desktop_bridge_normal";
  const createdAt = "2026-07-16T00:00:00.000Z";
  const completedAt = "2026-07-16T00:00:05.000Z";
  state.threads = [{
    id: DESKTOP_BRIDGE_THREAD_ID,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Desktop normal conversation",
    objective: "Verify the current-session header capability slot.",
    status: "succeeded",
    lastRunId: runId,
    createdAt,
    updatedAt: completedAt,
  }, {
    id: DESKTOP_BRIDGE_STALE_THREAD_ID,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Desktop stale conversation",
    objective: "Exercise stale Desktop navigation lookup suppression.",
    status: "succeeded",
    createdAt,
    updatedAt: completedAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId: DESKTOP_BRIDGE_THREAD_ID,
    kind: "initial_request",
    status: "succeeded",
    title: "Desktop normal conversation",
    userInstruction: "Verify the current-session header capability slot.",
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
    taskId: "task_desktop_bridge_normal",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_desktop_bridge_normal", title: "Desktop normal conversation" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId: DESKTOP_BRIDGE_THREAD_ID,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: completedAt,
    endedAt: completedAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_desktop_bridge_normal",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "The header capability slot is ready." },
  }];

  state.aiTeammates = [createMockTeammate({
    id: DESKTOP_BRIDGE_TEAMMATE_ID,
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Desktop Teammate",
  })];
  state.teammateDirectThreads[DESKTOP_BRIDGE_TEAMMATE_ID] = {
    id: DESKTOP_BRIDGE_TEAMMATE_THREAD_ID,
    workspaceId: "workspace_default",
    teammateId: DESKTOP_BRIDGE_TEAMMATE_ID,
    title: "Desktop Teammate",
    createdAt,
    updatedAt: completedAt,
  };
  state.teammateDirectMessages = [{
    id: "tdmsg_desktop_bridge",
    workspaceId: "workspace_default",
    threadId: DESKTOP_BRIDGE_TEAMMATE_THREAD_ID,
    teammateId: DESKTOP_BRIDGE_TEAMMATE_ID,
    authorType: "ai-teammate",
    authorId: DESKTOP_BRIDGE_TEAMMATE_ID,
    body: "The private header capability slot is ready.",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt,
    updatedAt: completedAt,
  }];
}
