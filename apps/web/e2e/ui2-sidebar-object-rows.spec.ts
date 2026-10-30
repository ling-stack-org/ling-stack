import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-object-rows/",
  import.meta.url,
));

test("UI 2.0 Sidebar object rows keep compact identity and actions in the expanded Sidebar", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  let workspaceChangesRequests = 0;
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createSidebarState());
  await page.route("http://127.0.0.1:17891/workspace/changes?**", async (route) => {
    workspaceChangesRequests += 1;
    await route.fulfill({
      json: {
        cwd: "/tmp/ling-stack/apps/web",
        state: "dirty",
        repoRoot: "/tmp/ling-stack",
        branchName: "codex/sidebar-approval-dialogs",
        additions: 12,
        deletions: 4,
        files: [],
        totalFileCount: 2,
        truncated: false,
        checkedAt: "2026-08-26T00:00:00.000Z",
      },
    });
  });
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  const channel = navigation.getByRole("button", { name: "Engineering", exact: true });
  await page.mouse.move(720, 320);
  await channel.hover();
  const channelPreview = page.locator('[role="tooltip"]:visible').filter({ hasText: "Engineering" });
  await expect(channelPreview).not.toContainText("Channel");
  await expect(channelPreview).not.toContainText("ling-stack");
  await expect(channelPreview).not.toContainText("codex/sidebar-approval-dialogs");
  const channelPreviewBox = await channelPreview.boundingBox();
  expect(channelPreviewBox).not.toBeNull();
  expect(channelPreviewBox!.width).toBeLessThanOrEqual(220);
  expectTooltipInsideViewport(channelPreviewBox!, 1440, 960);
  await captureEvidence(page, "1440x960-ling-light-channel-preview.png");

  const teammate = navigation.getByRole("button", { name: "Designer", exact: true });
  const avatar = teammate.locator(".teammate-avatar-image.compact");
  const label = teammate.locator('[data-ling-button-slot="label"]');
  const avatarBox = await avatar.boundingBox();
  const labelBox = await label.boundingBox();

  expect(avatarBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(avatarBox!.width).toBeLessThanOrEqual(24);
  expect(labelBox!.x - (avatarBox!.x + avatarBox!.width)).toBeGreaterThanOrEqual(4);
  await teammate.hover();
  const teammatePreview = page.locator('[role="tooltip"]:visible').filter({ hasText: "Designer" });
  await expect(teammatePreview).not.toContainText("Private chat");
  await expect(teammatePreview).toContainText("ling-stack");
  await expect(teammatePreview).toContainText("codex/sidebar-approval-dialogs");
  await captureEvidence(page, "1440x960-ling-light-private-chat-preview.png");
  const teammateRow = navigation.locator('.sidebar-row-shell:has(.sidebar-row-main[aria-label="Designer"])');
  const archive = teammateRow.getByRole("button", { name: "Archive teammate" });
  await expect(archive).toBeVisible();
  await expectHitArea(archive, 32);

  const recent = navigation.locator(".sidebar-recent-row").filter({
    hasText: "A deliberately long conversation title",
  });
  const recentShell = recent.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' sidebar-recent-row-shell ')][1]");
  await expect(recent).toContainText("A deliberately long conversation title");
  await expect(navigation.locator(".sidebar-recent-row .sidebar-row-description")).toHaveCount(0);
  await expect(recentShell).toHaveAttribute("data-sidebar-row-overflow", "true");
  await expect(recent.locator(".sidebar-row-title-viewport")).toHaveCSS("overflow", "hidden");
  await expect(recent.locator(".sidebar-row-title-track")).not.toHaveCSS("text-overflow", "ellipsis");
  expect(await recentShell.evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u))).toHaveLength(1);
  const recentTools = recentShell.locator(".sidebar-row-tools");
  await expect(recentTools).toHaveCSS("position", "absolute");
  const recentBox = await recent.boundingBox();
  const recentShellBox = await recentShell.boundingBox();
  const recentIconBox = await recent.locator("svg").first().boundingBox();
  const recentTitleBox = await recent.locator(".sidebar-row-title-viewport").boundingBox();
  expect(recentBox).not.toBeNull();
  expect(recentShellBox).not.toBeNull();
  expect(recentIconBox).not.toBeNull();
  expect(recentTitleBox).not.toBeNull();
  expect(Math.round(recentBox!.height)).toBe(32);
  expect(Math.round(recentShellBox!.height)).toBe(32);
  expect(Math.abs(
    (recentIconBox!.y + recentIconBox!.height / 2)
    - (recentTitleBox!.y + recentTitleBox!.height / 2),
  )).toBeLessThanOrEqual(1);
  await recent.hover();
  await expect(recentTools).toHaveCSS("opacity", "1");
  await expect(page.getByRole("tooltip")).toContainText("A deliberately long conversation title that must remain inside the Sidebar row");
  await expect(page.getByRole("tooltip")).not.toContainText("Conversation");
  await expect(page.getByRole("tooltip")).toContainText("ling-stack");
  await expect(page.getByRole("tooltip")).toContainText("codex/sidebar-approval-dialogs");
  const conversationPreviewBox = await page.getByRole("tooltip").boundingBox();
  expect(conversationPreviewBox).not.toBeNull();
  expect(conversationPreviewBox!.width).toBeGreaterThan(channelPreviewBox!.width);
  expect(conversationPreviewBox!.width).toBeLessThanOrEqual(240);
  expectTooltipInsideViewport(conversationPreviewBox!, 1440, 960);
  await expectPreviewWithoutScrollbars(page.getByRole("tooltip"));
  const previewTitle = page.getByRole("tooltip").locator(".sidebar-object-preview-line.is-title");
  await expect(previewTitle).toHaveAttribute("data-sidebar-preview-overflow", "true");
  await expect.poll(async () => previewTitle.locator(".sidebar-object-preview-line-track").evaluate((element) => (
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
  ))).toBeLessThan(-1);
  expect(workspaceChangesRequests).toBe(1);
  await expectNoHorizontalOverflow(navigation);
  await captureEvidence(page, "1440x960-ling-light-conversation-preview.png");
  expect(runtimeErrors).toEqual([]);
});

test("UI 2.0 Sidebar preview stays inside the minimum desktop window", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 980, 680);
  await mockDaemon(page, createSidebarState());
  await page.goto("/");

  const recent = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({
    hasText: "A deliberately long conversation title",
  });
  await recent.hover();
  const preview = page.locator('[role="tooltip"]:visible').filter({
    hasText: "A deliberately long conversation title",
  });
  await expect(preview).toBeVisible();
  const previewBox = await preview.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.width).toBeLessThanOrEqual(188);
  expectTooltipInsideViewport(previewBox!, 980, 680);
  await expectPreviewWithoutScrollbars(preview);
  expect(runtimeErrors).toEqual([]);
});

function createSidebarState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" }),
    createMockTeammate({ id: "teammate_sidebar_research", displayName: "Research" }),
  ];
  state.threads = Array.from({ length: 4 }, (_, index) => {
    const timestamp = `2026-07-19T00:0${index}:00.000Z`;
    return {
      id: `thread_sidebar_${index}`,
      workspaceId: "workspace_default",
      kind: "conversation" as const,
      teammateId: "ling_agent",
      title: index === 0
        ? "A deliberately long conversation title that must remain inside the Sidebar row"
        : `Recent conversation ${index + 1}`,
      objective: "Verify UI 2.0 Sidebar object-row geometry.",
      status: "open" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { schemaVersion: 1 as const, lastActivityAt: timestamp },
    };
  });
  const sourceRun = state.runs[0]!;
  state.channels[0] = {
    ...state.channels[0]!,
    boundPath: cwd,
  };
  const conversationRuns = state.threads.map((thread, index) => ({
    ...sourceRun,
    id: `run_sidebar_${index}`,
    taskId: `task_sidebar_${index}`,
    channelId: undefined,
    teammateId: undefined,
    threadId: thread.id,
    cwd: "/tmp/ling-stack/apps/web",
    eventLogPath: `/tmp/ling-stack/.ling-stack/runs/run_sidebar_${index}/events.jsonl`,
    updatedAt: thread.updatedAt,
  }));
  state.runs = [
    ...conversationRuns,
    {
      ...sourceRun,
      id: "run_sidebar_private_chat",
      taskId: "task_sidebar_private_chat",
      channelId: undefined,
      teammateId: state.aiTeammates[0]!.id,
      threadId: "thread_sidebar_private_chat",
      cwd: "/tmp/ling-stack/apps/web",
      eventLogPath: "/tmp/ling-stack/.ling-stack/runs/run_sidebar_private_chat/events.jsonl",
      updatedAt: "2026-08-26T00:11:00.000Z",
    },
  ];
  return state;
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function expectHitArea(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

function expectTooltipInsideViewport(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewportWidth: number,
  viewportHeight: number,
): void {
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(box.y).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth - 12);
  expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight - 12);
}

async function expectPreviewWithoutScrollbars(preview: Locator): Promise<void> {
  const metrics = await preview.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.overflowX).toBe("hidden");
  expect(metrics.overflowY).toBe("hidden");
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
