import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

test("macOS desktop private chat is flush with the titlebar and uses one dock divider", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    // Mock avatar/image endpoints intentionally return 404 and exercise the
    // existing fallback UI; only application console errors block this check.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
      },
    });
  });
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
  await page.setViewportSize({ width: 1440, height: 919 });
  await page.goto("/");
  await page.locator(".channel-left-drawer .sidebar-row-main").filter({ hasText: "Ling Agent" }).click();
  await page.locator(".teammate-chat-header .conversation-toolbar-details").click();
  await expect(page.locator(".teammate-private-right-dock")).toBeVisible();
  await expect.poll(async () => {
    const frame = await page.locator(".teammate-private-right-dock-frame").boundingBox();
    return frame?.width ?? 0;
  }).toBeGreaterThanOrEqual(300);

  const metrics = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace-teammate-private-surface");
    const header = document.querySelector<HTMLElement>(".teammate-chat-header");
    const identity = header?.querySelector<HTMLElement>(".teammate-workspace-identity");
    const handle = document.querySelector<HTMLElement>(".workspace-right-dock-resize-handle");
    const dock = document.querySelector<HTMLElement>(".workspace-right-dock-frame > .right-dock");
    const workspaceStyle = workspace ? getComputedStyle(workspace) : undefined;
    const workspaceRect = workspace?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
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
