import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("channel environment surface shows read-only context and opens review", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.setViewportSize({ width: 2160, height: 1200 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [
    {
      id: "run_environment",
      threadId: "thread_channel_channel_engineering",
      status: "succeeded",
      cwd,
      taskId: "task_environment",
      channelId: "channel_engineering",
      providerPresetId: "provider_local",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      taskSnapshot: { id: "task_environment", title: "Prepare environment diff" },
      providerSnapshot: { provider: "local-relay", model: "gpt-5.5" },
      requestSnapshot: { cwd, providerPresetId: "provider_local" },
      eventLogPath: ".ling-stack/sessions/run_environment.jsonl",
      createdAt: "2026-06-29T00:00:30.000Z",
      startedAt: "2026-06-29T00:00:31.000Z",
      endedAt: "2026-06-29T00:00:59.000Z",
      updatedAt: "2026-06-29T00:00:59.000Z",
    },
  ];
  state.approvals = [];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? {
          ...channel,
          workspaceBinding: {
            mode: "managed_worktree",
            status: "ready",
            executionPath: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
            worktreePath: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
            branchName: "ling/channel-environment",
            baseBranch: "main",
            updatedAt: "2026-06-29T00:00:00.000Z",
            checkedAt: "2026-06-29T00:00:00.000Z",
          },
        }
      : channel
  );
  state.artifactsByRun = {
    run_environment: [
      {
        id: "artifact_environment_diff",
        runId: "run_environment",
        type: "diff",
        path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
        title: "Workspace environment diff",
        contentType: "text/x-diff; charset=utf-8",
        contentText: [
          "diff --git a/apps/web/src/features/workspace/WorkspaceClientView.tsx b/apps/web/src/features/workspace/WorkspaceClientView.tsx",
          "index 1111111..2222222 100644",
          "--- a/apps/web/src/features/workspace/WorkspaceClientView.tsx",
          "+++ b/apps/web/src/features/workspace/WorkspaceClientView.tsx",
          "@@ -10,3 +10,4 @@",
          " import React from \"react\";",
          "-const oldLabel = \"Environment\";",
          "+const newLabel = \"Environment\";",
          "+const reviewPreview = true;",
          " export function WorkspaceClientView() {",
          "   return null;",
          " }",
        ].join("\n"),
        createdAt: "2026-06-29T00:01:00.000Z",
      },
    ],
  };
  state.channelWorkspaceGitStatusByChannel.channel_engineering = {
    state: "dirty",
    cwd: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
    repoRoot: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
    branchName: "ling/channel-environment",
    upstream: "main",
    headSha: "abc1234",
    changedFileCount: 1,
    stagedFileCount: 0,
    unstagedFileCount: 1,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    additions: 12,
    deletions: 3,
    files: [
      {
        path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
        indexStatus: " ",
        worktreeStatus: "M",
        kind: "modified",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    checkedAt: "2026-06-29T00:01:00.000Z",
  };

  await mockDaemon(page, state);
  await page.route(/\/workspace\/work-summary(?:\?.*)?$/, async (route) => {
    const worktreeCwd = `${cwd}/.ling-stack/worktrees/channels/channel_engineering`;
    await route.fulfill({ json: {
      cwd,
      sessions: [{ id: "channel:channel_engineering", channelId: "channel_engineering", title: "Engineering", status: "open", surface: "channel", workspaceKey: worktreeCwd }],
      workspaces: [{ key: worktreeCwd, cwd: worktreeCwd, state: "ready", branch: "ling/channel-environment", changedFiles: 1, additions: 12, deletions: 3, binaryFiles: 0, commits: [], partial: false, checkedAt: "2026-06-29T00:01:00.000Z" }],
      pullRequests: [], truncated: false, checkedAt: "2026-06-29T00:01:00.000Z",
    } });
  });
  await page.route(/\/workspace\/changes(?:\?.*)?$/, async (route) => {
    const worktreeCwd = `${cwd}/.ling-stack/worktrees/channels/channel_engineering`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: worktreeCwd,
        state: "dirty",
        repoRoot: worktreeCwd,
        branchName: "ling/channel-environment",
        upstream: "main",
        headSha: "abc1234",
        additions: 12,
        deletions: 3,
        files: [{
          path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
          kind: "modified",
          staged: false,
          unstaged: true,
          untracked: false,
          additions: 12,
          deletions: 3,
          diff: state.artifactsByRun.run_environment?.[0]?.contentText,
          truncated: false,
        }],
        totalFileCount: 1,
        truncated: false,
        checkedAt: "2026-06-29T00:01:00.000Z",
      }),
    });
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveAttribute("data-sidebar-mode", "compact");
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  const readChatLayoutSnapshot = async () => page.evaluate(() => {
    const chatLayout = document.querySelector<HTMLElement>(".activity-chat-layout");
    const composer = document.querySelector<HTMLElement>(".activity-shell .channel-composer");
    const main = document.querySelector<HTMLElement>(".task-workbench-main");
    const chatPanel = document.querySelector<HTMLElement>(".channel-chat-panel");
    const chatBox = chatLayout?.getBoundingClientRect();
    const composerBox = composer?.getBoundingClientRect();
    return {
      chatHeight: Math.round(chatBox?.height ?? 0),
      chatTransform: chatLayout ? getComputedStyle(chatLayout).transform : "",
      chatWidth: Math.round(chatBox?.width ?? 0),
      chatX: Math.round(chatBox?.x ?? 0),
      chatY: Math.round(chatBox?.y ?? 0),
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      composerWidth: Math.round(composerBox?.width ?? 0),
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      panelMarginRight: chatPanel ? getComputedStyle(chatPanel).marginRight : "",
    };
  });

  const summaryButton = page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Summary", exact: true });
  await summaryButton.click();
  const popover = page.locator(".channel-progress-popover");
  await expect(popover).toBeVisible();
  await expect.poll(async () => Math.round((await popover.boundingBox())?.width ?? 0)).toBe(326);
  await expect(popover).toContainText("Environment");
  await expect(popover.getByRole("region", { name: "Work summary", exact: true })).toBeVisible();
  await popover.getByRole("tab", { name: "Project overview" }).click();
  await expect(popover.getByRole("region", { name: "Linked pull requests" })).toBeVisible();
  await popover.getByRole("tab", { name: "Current conversation" }).click();
  await expect(popover).toContainText("Local environment");
  await expect(popover).toContainText("Working branch");
  await expect(popover).toContainText("Commit or push");
  const summaryChanges = popover.getByRole("tabpanel", { name: "Current conversation" }).getByRole("button", { name: /Uncommitted changes.*1 changed file/u });
  await expect(summaryChanges).toHaveCount(1);
  await expect(summaryChanges).toContainText("+12");
  await expect(summaryChanges).toContainText("−3");
  await expect(popover.locator(".attention-environment-section")).not.toContainText("Changes");
  await popover.getByRole("button", { name: "Local environment" }).click();
  const quickEnvironmentPage = page.locator(".channel-environment-page");
  await expect(quickEnvironmentPage).toBeVisible();
  await expect(quickEnvironmentPage).toContainText("Local environment");
  await expect(quickEnvironmentPage).toContainText("Worktree");
  await expect(quickEnvironmentPage).toContainText("ling/channel-environment");
  await page.getByRole("button", { name: "Back to channel" }).click();
  await expect(quickEnvironmentPage).toHaveCount(0);
  await summaryButton.click();
  await expect(popover).toBeVisible();

  const dock = page.locator(".channel-side-panel");
  const chatLayout = page.locator(".activity-chat-layout");
  const messageFeed = page.getByLabel("Channel message feed");
  const feedScrollBeforeDock = await messageFeed.evaluate((node) => {
    node.dataset.remountProbe = "right-dock-stable";
    return Math.round(node.scrollTop);
  });
  const chatLayoutBeforeDock = await chatLayout.boundingBox();
  expect(chatLayoutBeforeDock).not.toBeNull();
  const chatSnapshotBeforeDock = await readChatLayoutSnapshot();
  expect(chatSnapshotBeforeDock.chatWidth).toBeGreaterThanOrEqual(chatSnapshotBeforeDock.composerWidth);
  expect(chatSnapshotBeforeDock.composerWidth).toBeGreaterThanOrEqual(780);
  expect(chatSnapshotBeforeDock.composerWidth).toBeLessThanOrEqual(820);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(chatSnapshotBeforeDock.chatTransform);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(chatSnapshotBeforeDock.composerTransform);
  expect(chatSnapshotBeforeDock.mainPaddingRight).toBe("0px");
  expect(chatSnapshotBeforeDock.panelMarginRight).toBe("0px");
  await page.locator(".task-toolbar-panel").click();
  await page.waitForTimeout(160);
  const chatLayoutDuringDockOpen = await chatLayout.boundingBox();
  expect(chatLayoutDuringDockOpen).not.toBeNull();
  expect(Math.abs((chatLayoutDuringDockOpen?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutDuringDockOpen?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  await expect(dock).toBeVisible();
  const chatLayoutAfterDockOpen = await chatLayout.boundingBox();
  expect(chatLayoutAfterDockOpen).not.toBeNull();
  expect(Math.abs((chatLayoutAfterDockOpen?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutAfterDockOpen?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  await expect(popover).toBeVisible();
  await expect.poll(async () => {
    const popoverBox = await popover.boundingBox();
    const dockBox = await dock.boundingBox();
    if (!popoverBox || !dockBox) {
      return 999;
    }
    return Math.round(popoverBox.x + popoverBox.width - dockBox.x);
  }).toBeLessThanOrEqual(-8);
  expect(await messageFeed.evaluate((node) => node.dataset.remountProbe)).toBe("right-dock-stable");
  expect(Math.abs(await messageFeed.evaluate((node) => Math.round(node.scrollTop)) - feedScrollBeforeDock)).toBeLessThanOrEqual(1);
  await page.locator(".task-toolbar-panel").click();
  await page.waitForTimeout(80);
  await expect(dock).toHaveCount(1);
  const closingDockFrameBox = await page.locator(".channel-side-panel-frame").boundingBox();
  expect(closingDockFrameBox).not.toBeNull();
  expect(closingDockFrameBox?.width ?? 0).toBeGreaterThan(0);
  expect(closingDockFrameBox?.width ?? 0).toBeLessThan(304);
  const chatLayoutDuringDockClose = await chatLayout.boundingBox();
  expect(chatLayoutDuringDockClose).not.toBeNull();
  expect(Math.abs((chatLayoutDuringDockClose?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutDuringDockClose?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  await expect(dock).toHaveCount(0);
  const chatLayoutAfterDockClose = await chatLayout.boundingBox();
  expect(chatLayoutAfterDockClose).not.toBeNull();
  expect(Math.abs((chatLayoutAfterDockClose?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutAfterDockClose?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  const dockCloseHorizontalTolerance = 28;
  await expect.poll(async () => {
    const snapshot = await readChatLayoutSnapshot();
    return Math.abs(snapshot.chatX - chatSnapshotBeforeDock.chatX);
  }).toBeLessThanOrEqual(dockCloseHorizontalTolerance);
  const chatSnapshotAfterDockClose = await readChatLayoutSnapshot();
  expect(Math.abs(chatSnapshotAfterDockClose.chatX - chatSnapshotBeforeDock.chatX)).toBeLessThanOrEqual(dockCloseHorizontalTolerance);
  expect(Math.abs(chatSnapshotAfterDockClose.chatY - chatSnapshotBeforeDock.chatY)).toBeLessThanOrEqual(1);
  expect(Math.abs(chatSnapshotAfterDockClose.chatWidth - chatSnapshotBeforeDock.chatWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(chatSnapshotAfterDockClose.chatHeight - chatSnapshotBeforeDock.chatHeight)).toBeLessThanOrEqual(1);
  expect(chatSnapshotAfterDockClose.chatTransform).toBe(chatSnapshotBeforeDock.chatTransform);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(chatSnapshotAfterDockClose.composerTransform);
  expect(chatSnapshotAfterDockClose.mainPaddingRight).toBe("0px");
  expect(chatSnapshotAfterDockClose.panelMarginRight).toBe("0px");
  expect(await messageFeed.evaluate((node) => node.dataset.remountProbe)).toBe("right-dock-stable");
  expect(Math.abs(await messageFeed.evaluate((node) => Math.round(node.scrollTop)) - feedScrollBeforeDock)).toBeLessThanOrEqual(1);
  await expect(popover).toBeVisible();

  await page.locator(".task-toolbar-panel").click();
  await expect(dock).toBeVisible();
  await page.locator(".task-toolbar-panel").click();
  await page.waitForTimeout(80);
  await page.locator(".task-toolbar-panel").click();
  await expect.poll(async () => Math.round((await page.locator(".channel-side-panel-frame").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  await expect(dock).toBeVisible();
  await expect(page.locator(".task-toolbar-panel")).toHaveAttribute("aria-expanded", "true");
  const chatLayoutAfterReopen = await chatLayout.boundingBox();
  expect(chatLayoutAfterReopen).not.toBeNull();
  expect(Math.abs((chatLayoutAfterReopen?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutAfterReopen?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Show navigation" }).click();
  await page.setViewportSize({ width: 1984, height: 1200 });
  await page.waitForTimeout(200);

  await summaryChanges.click();
  await expect(popover).toBeHidden();
  await expect(dock).toBeVisible();
  await expect(dock.locator(".right-dock-head-page")).toContainText("Review");
  await expect(dock.locator(".right-dock-head-page")).toContainText("Workspace changes");
  await summaryButton.click();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(320);
  await expect(popover).toBeVisible();
  await expect.poll(async () => {
    const popoverBox = await popover.boundingBox();
    const dockBox = await dock.boundingBox();
    if (!popoverBox || !dockBox) {
      return 999;
    }
    return Math.round(popoverBox.x + popoverBox.width - dockBox.x);
  }).toBeLessThanOrEqual(-8);
  const defaultPopoverWithDockBox = await popover.boundingBox();
  const defaultDockWithPopoverBox = await dock.boundingBox();
  expect(defaultPopoverWithDockBox).not.toBeNull();
  expect(defaultDockWithPopoverBox).not.toBeNull();
  expect((defaultPopoverWithDockBox?.x ?? 0) + (defaultPopoverWithDockBox?.width ?? 0)).toBeLessThanOrEqual((defaultDockWithPopoverBox?.x ?? 0) - 8);
  const resizeHandle = page.getByRole("separator", { name: "Resize workspace dock" });
  await expect(resizeHandle).toBeVisible();
  await expect(resizeHandle).toHaveCSS("cursor", "col-resize");
  const initialDockBox = await dock.boundingBox();
  expect(initialDockBox).not.toBeNull();
  const resizeHandleBox = await resizeHandle.boundingBox();
  expect(resizeHandleBox).not.toBeNull();
  await page.mouse.move(resizeHandleBox!.x + resizeHandleBox!.width / 2, resizeHandleBox!.y + 40);
  await page.mouse.down();
  await page.mouse.move(resizeHandleBox!.x - 130, resizeHandleBox!.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThan((initialDockBox?.width ?? 0) + 80);
  await expect(dock).toContainText("ling/channel-environment");
  const changedFileSection = dock.locator('.workspace-change-file-section[data-workspace-change-path="apps/web/src/features/workspace/WorkspaceClientView.tsx"]');
  await expect(changedFileSection).toBeVisible();
  await expect(changedFileSection).toContainText("WorkspaceClientView.tsx");
  await expect(changedFileSection.locator(".diff-viewer")).toContainText("reviewPreview");
  await expect(changedFileSection.getByRole("button", { name: "Open with" })).toBeVisible();
  await changedFileSection.getByRole("button", { name: "Collapse code preview: WorkspaceClientView.tsx" }).click();
  await expect(changedFileSection).toHaveClass(/collapsed/u);
  await expect(changedFileSection.locator(".diff-viewer")).toHaveCount(0);
  const expandedResizeHandleBox = await resizeHandle.boundingBox();
  expect(expandedResizeHandleBox).not.toBeNull();
  await page.mouse.move(expandedResizeHandleBox!.x + expandedResizeHandleBox!.width / 2, expandedResizeHandleBox!.y + 40);
  await page.mouse.down();
  await page.mouse.move(860, expandedResizeHandleBox!.y + 40, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(840);
  await expect(popover).toBeHidden();
  await expect(summaryButton).not.toHaveAttribute("aria-pressed", "true");
  await expect(summaryButton).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(560);
  await page.locator(".task-toolbar-panel").click();
  await expect(dock).toHaveCount(0);
  await expect(popover).toBeVisible();
  await expect(summaryButton).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  const environmentPage = page.locator(".channel-environment-page");
  await expect(environmentPage).toBeVisible();
  await expect(page.locator(".channel-settings-top-title small")).toHaveCount(0);
  await expect(environmentPage.locator(".channel-environment-page-header > div")).toHaveCount(0);
  await expect(environmentPage).not.toContainText("#Engineering");
  await expect(environmentPage).toContainText("Local environment");
  await expect(environmentPage).toContainText("Worktree");
  await expect(environmentPage).toContainText("ling/channel-environment");
  await expect(environmentPage).toContainText("1 changed file");
  await expect(environmentPage).toContainText("+12");
  await expect(environmentPage).toContainText("-3");
  await expect(environmentPage).toContainText("1 review item");
  await expect(environmentPage).toContainText("No browser evidence");
  await expect(environmentPage).toContainText("No sources");
  await expect(environmentPage).toContainText("1 artifact");
  await expect(environmentPage.locator(".channel-environment-metric")).toHaveCount(3);
  await expect(environmentPage.locator('[data-environment-row="commit"]')).toBeVisible();
  const environmentRows = environmentPage.locator(".channel-environment-list > .ling-ui-data-row");
  const summaryLeftEdges = await environmentRows.locator(".ling-ui-data-row-summary").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().left)),
  );
  const statusLeftEdges = await environmentRows.locator(".ling-ui-data-row-status").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.querySelector(".ling-ui-status-indicator")!.getBoundingClientRect().left)),
  );
  const actionRightEdges = await environmentRows.locator(".ling-ui-data-row-actions").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().right)),
  );
  expect(new Set(summaryLeftEdges).size, `summary columns: ${summaryLeftEdges.join(", ")}`).toBe(1);
  expect(
    Math.max(...statusLeftEdges) - Math.min(...statusLeftEdges),
    `status columns: ${statusLeftEdges.join(", ")}`,
  ).toBeLessThanOrEqual(1);
  expect(statusLeftEdges).toHaveLength(5);
  expect(new Set(actionRightEdges).size, `action columns: ${actionRightEdges.join(", ")}`).toBe(1);

  const selectedEnvironmentPath = "/Users/example/workspace/projects";
  await environmentPage.getByRole("button", { name: "Change directory" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    if (!isRecord(channel) || !isRecord(channel.workspaceBinding)) {
      return undefined;
    }
    return {
      boundPath: channel.boundPath,
      mode: channel.workspaceBinding.mode,
      executionPath: channel.workspaceBinding.executionPath,
    };
  }).toEqual({
    boundPath: selectedEnvironmentPath,
    mode: "local",
    executionPath: selectedEnvironmentPath,
  });
  const localEnvironment = environmentPage.locator('[data-environment-row="workspace"]');
  await expect(localEnvironment).toContainText("Local");
  await expect(localEnvironment).toContainText(selectedEnvironmentPath);
  const environmentPath = localEnvironment.locator(".channel-environment-path");
  await expect(environmentPath).toHaveAttribute("title", selectedEnvironmentPath);
  await expect(environmentPath).toHaveCSS("white-space", "nowrap");
  await expect(environmentPath).toHaveCSS("text-overflow", "ellipsis");
  await expect(environmentPath).toHaveCSS("font-family", /mono/u);
  await expect.poll(async () => {
    const box = await environmentPath.boundingBox();
    return Math.round(box?.height ?? 0);
  }).toBeLessThanOrEqual(20);
  await expect(localEnvironment.getByRole("button", { name: "Change directory" })).toBeVisible();

  await environmentPage.locator('[data-environment-row="commit"]').getByRole("button", { name: "Open" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit or push" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(dialog).toContainText("first version is read-only");
  const includeUnstagedSwitch = dialog.getByRole("switch", { name: "Include unstaged changes" });
  await expect(includeUnstagedSwitch).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Commit and push" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Push", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await environmentPage.getByRole("button", { name: "View review" }).click();
  await expect(page.locator(".channel-environment-page")).toHaveCount(0);
  const rightDock = page.locator(".channel-side-panel");
  await expect(rightDock.locator(".right-dock-head-page")).toContainText("Review");
  await expect(rightDock.locator(".right-dock-filter-row")).toHaveCount(0);
  await expect(rightDock.locator(".right-dock-review-status-card")).toHaveCount(0);
  await expect(rightDock.locator(".workspace-change-review-page")).toBeVisible();
  await expect(rightDock.locator(".workspace-change-review-page")).not.toContainText("Risk");
  await expect(rightDock.locator(".workspace-change-review-page")).not.toContainText("Runtime");
});
