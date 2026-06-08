import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  isRecord,
} from "./support/mock-state";
import {
  channelEventFilterToggle,
  channelEventFilters,
  openChannelChatTools,
  openChannelContextPanel,
  openChannelFilesPanel,
  openChannelTasksTab,
  openTaskFromAttentionQueue,
  readScrollState,
} from "./support/test-helpers";

test("channel drawers match the accepted HTML layout", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_drawer_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");
  await expect(page.locator(".channel-left-drawer .sidebar-row.selected")).toContainText("Engineering");
  await expect(page.getByLabel("Channel message feed").getByText("No channel messages yet")).toBeVisible();
  await expect(page.locator(".channel-attention-popover")).toHaveCount(0);
  await page.locator(".task-toolbar-attention").click();
  await expect(page.locator(".channel-attention-popover")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Progress");
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await page.mouse.move(640, 120);
  await page.waitForTimeout(200);

  const expanded = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const leftToolbar = document.querySelector(".channel-sidebar-toolbar");
    const rightDrawer = document.querySelector(".channel-side-panel");
    const header = document.querySelector(".task-workbench-header");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const activityShell = document.querySelector(".activity-shell");
    const activityMain = document.querySelector(".activity-chat-main");
    const workbenchMain = document.querySelector(".task-workbench-main");
    const workbenchWindow = document.querySelector(".task-workbench-window");
    const workspace = document.querySelector(".workspace");
    const composer = document.querySelector(".channel-composer");
    const feed = document.querySelector(".message-feed");
    const emptyState = document.querySelector(".activity-shell .message-feed-empty-state");
    const selectedChannel = document.querySelector(".channel-left-drawer .sidebar-row.selected");
    const selectedChannelBefore = selectedChannel ? getComputedStyle(selectedChannel, "::before") : undefined;
    const primaryNav = document.querySelector(".channel-left-drawer .primary-nav");
    const drawerSections = Array.from(document.querySelectorAll(".channel-left-drawer .sidebar-section"));
    const firstSection = drawerSections[0];
    const teammateSection = drawerSections[1];
    const firstSectionTitle = firstSection?.querySelector(".sidebar-section-title");
    const teammateSectionTitle = teammateSection?.querySelector(".sidebar-section-title");
    const teammateRows = Array.from(teammateSection?.querySelectorAll(".sidebar-row") ?? []);
    const teammateFirstRow = teammateSection?.querySelector(".sidebar-row");
    const teammateSecondRow = teammateRows[1];
    const sidebarAction = firstSection?.querySelector(".sidebar-section-action");
    const sidebarActionSvg = sidebarAction?.querySelector("svg");
    const sidebarSwitchSvg = document.querySelector(".channel-sidebar-switch svg");
    const titleIcon = document.querySelector(".channel-title-icon");
    const channelMoreButton = document.querySelector(".channel-more-button");
    const toolbarButton = document.querySelector(".task-toolbar-attention");
    const toolbarButtonSvg = toolbarButton?.querySelector("svg");
    const sidebarSwitch = document.querySelector(".channel-sidebar-switch");
    const toolbarCount = toolbarButton?.querySelector(".toolbar-count");
    const sidePanelActions = document.querySelector(".channel-side-panel-actions");
    const sidebarBottom = document.querySelector(".channel-left-drawer .sidebar-bottom");
    const approvals = document.querySelector(".channel-left-drawer .sidebar-inbox-alert");
    const settings = document.querySelector(".channel-left-drawer .config-button");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const feedRect = feed?.getBoundingClientRect();
    const emptyStateRect = emptyState?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      leftToolbarWidth: Math.round(leftToolbar?.getBoundingClientRect().width ?? 0),
      selectedChannelText: selectedChannel?.textContent?.trim() ?? "",
      selectedChannelBackground: selectedChannel ? getComputedStyle(selectedChannel).backgroundColor : "",
      selectedChannelBeforeContent: selectedChannelBefore?.content ?? "",
      primaryNavBorderBottom: primaryNav ? getComputedStyle(primaryNav).borderBottomWidth : "",
      primaryNavSectionGap: primaryNav && firstSectionTitle
        ? Math.round(firstSectionTitle.getBoundingClientRect().top - primaryNav.getBoundingClientRect().bottom)
        : -1,
      teammateTitleListGap: teammateSectionTitle && teammateFirstRow
        ? Math.round(teammateFirstRow.getBoundingClientRect().top - teammateSectionTitle.getBoundingClientRect().bottom)
        : -1,
      teammateRowGap: teammateFirstRow && teammateSecondRow
        ? Math.round(teammateSecondRow.getBoundingClientRect().top - teammateFirstRow.getBoundingClientRect().bottom)
        : -1,
      sectionTitleColor: firstSectionTitle ? getComputedStyle(firstSectionTitle).color : "",
      sectionTitleFontSize: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontSize : "",
      sectionTitleFontWeight: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontWeight : "",
      sidebarActionWidth: Math.round(sidebarAction?.getBoundingClientRect().width ?? 0),
      sidebarActionHeight: Math.round(sidebarAction?.getBoundingClientRect().height ?? 0),
      sidebarActionColor: sidebarAction ? getComputedStyle(sidebarAction).color : "",
      sidebarActionSvgStroke: sidebarActionSvg ? getComputedStyle(sidebarActionSvg).strokeWidth : "",
      sidebarSwitchBorderWidth: sidebarSwitch ? getComputedStyle(sidebarSwitch).borderTopWidth : "",
      sidebarSwitchColor: sidebarSwitch ? getComputedStyle(sidebarSwitch).color : "",
      sidebarSwitchSvgWidth: Math.round(sidebarSwitchSvg?.getBoundingClientRect().width ?? 0),
      sidebarSwitchSvgHeight: Math.round(sidebarSwitchSvg?.getBoundingClientRect().height ?? 0),
      sidebarSwitchSvgStroke: sidebarSwitchSvg ? getComputedStyle(sidebarSwitchSvg).strokeWidth : "",
      titleIconText: titleIcon?.textContent?.trim() ?? "",
      titleIconBorderWidth: titleIcon ? getComputedStyle(titleIcon).borderTopWidth : "",
      titleIconColor: titleIcon ? getComputedStyle(titleIcon).color : "",
      titleIconFontSize: titleIcon ? getComputedStyle(titleIcon).fontSize : "",
      titleIconFontWeight: titleIcon ? getComputedStyle(titleIcon).fontWeight : "",
      titleIconWidth: Math.round(titleIcon?.getBoundingClientRect().width ?? 0),
      titleIconHeight: Math.round(titleIcon?.getBoundingClientRect().height ?? 0),
      channelMoreButtonColor: channelMoreButton ? getComputedStyle(channelMoreButton).color : "",
      channelMoreButtonBorderWidth: channelMoreButton ? getComputedStyle(channelMoreButton).borderTopWidth : "",
      channelMoreButtonWidth: Math.round(channelMoreButton?.getBoundingClientRect().width ?? 0),
      toolbarButtonBorderWidth: toolbarButton ? getComputedStyle(toolbarButton).borderTopWidth : "",
      toolbarButtonColor: toolbarButton ? getComputedStyle(toolbarButton).color : "",
      toolbarButtonWidth: Math.round(toolbarButton?.getBoundingClientRect().width ?? 0),
      toolbarButtonSvgWidth: Math.round(toolbarButtonSvg?.getBoundingClientRect().width ?? 0),
      toolbarButtonSvgHeight: Math.round(toolbarButtonSvg?.getBoundingClientRect().height ?? 0),
      toolbarButtonSvgStroke: toolbarButtonSvg ? getComputedStyle(toolbarButtonSvg).strokeWidth : "",
      toolbarCountText: toolbarCount?.textContent?.trim() ?? "",
      selectedChannelMentionText: selectedChannel?.querySelector(".channel-mention")?.textContent?.trim() ?? "",
      selectedChannelUnreadCount: selectedChannel?.querySelectorAll(".channel-unread").length ?? 0,
      channelMentionCount: document.querySelectorAll(".channel-left-drawer .sidebar-section:first-of-type .channel-mention").length,
      selectedChannelHashText: selectedChannel?.querySelector(".sidebar-hash")?.textContent?.trim() ?? "",
      teammateAvatarCount: document.querySelectorAll(".channel-left-drawer .sidebar-section .avatar-initial").length,
      teammateNotificationCount: Array.from(document.querySelectorAll(".channel-left-drawer .sidebar-row")).filter((row) =>
        row.querySelector(".avatar-initial") && (
          row.querySelector(".channel-mention") ||
          row.querySelector(".channel-unread") ||
          row.querySelector(".status-dot")
        )
      ).length,
      rightY: Math.round(rightDrawer?.getBoundingClientRect().y ?? -1),
      rightHeight: Math.round(rightDrawer?.getBoundingClientRect().height ?? 0),
      viewportHeight: window.innerHeight,
      headerRight: Math.round(header?.getBoundingClientRect().right ?? 0),
      rightLeft: Math.round(rightDrawer?.getBoundingClientRect().left ?? 0),
      sidePanelActions: document.querySelectorAll(".channel-side-panel-actions .icon-button").length,
      sidePanelActionsOpacity: sidePanelActions ? getComputedStyle(sidePanelActions).opacity : "",
      sidePanelActionsVisibility: sidePanelActions ? getComputedStyle(sidePanelActions).visibility : "",
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      composerCenterDelta: chatPanelRect && composerRect ? Math.round((composerRect.left + composerRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      chatPanelWidth: Math.round(chatPanelRect?.width ?? 0),
      chatWidth: Math.round(chatRect?.width ?? 0),
      composerWidth: Math.round(composerRect?.width ?? 0),
      workspaceHeight: Math.round(workspace?.getBoundingClientRect().height ?? 0),
      workbenchWindowHeight: Math.round(workbenchWindow?.getBoundingClientRect().height ?? 0),
      workbenchMainHeight: Math.round(workbenchMain?.getBoundingClientRect().height ?? 0),
      chatPanelHeight: Math.round(chatPanelRect?.height ?? 0),
      activityShellHeight: Math.round(activityShell?.getBoundingClientRect().height ?? 0),
      chatHeight: Math.round(chatRect?.height ?? 0),
      activityMainHeight: Math.round(activityMain?.getBoundingClientRect().height ?? 0),
      emptyStateText: emptyState?.textContent?.trim() ?? "",
      emptyStateCenterDelta: feedRect && emptyStateRect
        ? Math.round((emptyStateRect.top + emptyStateRect.height / 2) - (feedRect.top + feedRect.height / 2))
        : 999,
      emptyStateIconCount: emptyState?.querySelectorAll("svg").length ?? 0,
      composerBottomGap: chatPanelRect && composerRect ? Math.round(chatPanelRect.bottom - composerRect.bottom) : 999,
      feedHeight: Math.round(feedRect?.height ?? 0),
      feedBottomComposerGap: feedRect && composerRect ? Math.round(composerRect.top - feedRect.bottom) : 999,
      sidebarBottomDisplay: sidebarBottom ? getComputedStyle(sidebarBottom).display : "",
      sidebarBottomBorderTop: sidebarBottom ? getComputedStyle(sidebarBottom).borderTopWidth : "",
      approvalsText: approvals?.textContent?.trim() ?? "",
      approvalsHeight: Math.round(approvals?.getBoundingClientRect().height ?? 0),
      approvalsColumns: approvals ? getComputedStyle(approvals).gridTemplateColumns : "",
      settingsText: settings?.textContent?.trim() ?? "",
      settingsHeight: Math.round(settings?.getBoundingClientRect().height ?? 0),
      settingsColumns: settings ? getComputedStyle(settings).gridTemplateColumns : "",
      globalRightPanels: document.querySelectorAll(".right-panel").length,
    };
  });
  expect(expanded.columns.startsWith("232px ")).toBe(true);
  expect(expanded.leftWidth).toBe(232);
  expect(expanded.leftToolbarWidth).toBe(232);
  expect(expanded.selectedChannelText).toContain("Engineering");
  expect(expanded.selectedChannelBackground).toBe("rgb(245, 245, 245)");
  expect(expanded.selectedChannelBeforeContent).toBe("none");
  expect(expanded.primaryNavBorderBottom).toBe("0px");
  expect(expanded.primaryNavSectionGap).toBeLessThanOrEqual(16);
  expect(expanded.teammateTitleListGap).toBeLessThanOrEqual(6);
  expect(expanded.teammateRowGap).toBeLessThanOrEqual(6);
  expect(expanded.sectionTitleColor).toBe("rgb(107, 107, 107)");
  expect(expanded.sectionTitleFontSize).toBe("12px");
  expect(expanded.sectionTitleFontWeight).toBe("500");
  expect(expanded.sidebarActionWidth).toBe(20);
  expect(expanded.sidebarActionHeight).toBe(20);
  expect(expanded.sidebarActionColor).toBe("rgb(17, 17, 17)");
  expect(expanded.sidebarActionSvgStroke).toBe("2.4px");
  expect(expanded.sidebarSwitchBorderWidth).toBe("0px");
  expect(expanded.sidebarSwitchColor).toBe("rgb(17, 17, 17)");
  expect(expanded.sidebarSwitchSvgWidth).toBe(18);
  expect(expanded.sidebarSwitchSvgHeight).toBe(18);
  expect(expanded.sidebarSwitchSvgStroke).toBe("2.4px");
  expect(expanded.titleIconText).toBe("#");
  expect(expanded.titleIconBorderWidth).toBe("0px");
  expect(expanded.titleIconColor).toBe("rgb(17, 17, 17)");
  expect(expanded.titleIconFontSize).toBe("18px");
  expect(expanded.titleIconFontWeight).toBe("600");
  expect(expanded.titleIconWidth).toBe(30);
  expect(expanded.titleIconHeight).toBe(30);
  expect(expanded.channelMoreButtonColor).toBe("rgb(17, 17, 17)");
  expect(expanded.channelMoreButtonBorderWidth).toBe("0px");
  expect(expanded.channelMoreButtonWidth).toBe(30);
  expect(expanded.toolbarButtonBorderWidth).toBe("0px");
  expect(expanded.toolbarButtonColor).toBe("rgb(17, 17, 17)");
  expect(expanded.toolbarButtonWidth).toBe(34);
  expect(expanded.toolbarButtonSvgWidth).toBe(18);
  expect(expanded.toolbarButtonSvgHeight).toBe(18);
  expect(expanded.toolbarButtonSvgStroke).toBe("2.4px");
  expect(expanded.toolbarCountText).toBe("");
  expect(expanded.selectedChannelHashText).toBe("#");
  expect(expanded.selectedChannelMentionText).toBe("");
  expect(expanded.selectedChannelUnreadCount).toBe(0);
  expect(expanded.channelMentionCount).toBe(0);
  expect(expanded.teammateAvatarCount).toBeGreaterThan(0);
  expect(expanded.teammateNotificationCount).toBe(0);
  expect(expanded.rightY).toBe(0);
  expect(expanded.rightHeight).toBe(expanded.viewportHeight);
  expect(expanded.headerRight).toBeLessThanOrEqual(expanded.rightLeft);
  expect(expanded.sidePanelActions).toBe(2);
  expect(Number(expanded.sidePanelActionsOpacity)).toBeLessThanOrEqual(0.05);
  expect(expanded.sidePanelActionsVisibility).toBe("hidden");
  expect(Math.abs(expanded.chatCenterDelta)).toBeLessThanOrEqual(1);
  expect(Math.abs(expanded.composerCenterDelta)).toBeLessThanOrEqual(1);
  expect(expanded.chatPanelWidth - expanded.chatWidth).toBe(48);
  expect(expanded.composerWidth).toBe(expanded.chatWidth);
  expect(expanded.emptyStateText).toBe("No channel messages yet");
  expect(expanded.emptyStateIconCount).toBe(1);
  expect(Math.abs(expanded.emptyStateCenterDelta)).toBeLessThanOrEqual(2);
  expect(expanded.composerBottomGap).toBeLessThanOrEqual(18);
  expect(expanded.feedHeight).toBeGreaterThan(300);
  expect(expanded.feedBottomComposerGap).toBe(0);
  expect(expanded.sidebarBottomDisplay).toBe("grid");
  expect(expanded.sidebarBottomBorderTop).toBe("1px");
  expect(expanded.approvalsText).toContain("pending approvals");
  expect(expanded.approvalsHeight).toBe(38);
  expect(expanded.approvalsColumns.startsWith("24px ")).toBe(true);
  expect(expanded.settingsText).toBe("Settings");
  expect(expanded.settingsHeight).toBe(38);
  expect(expanded.settingsColumns.startsWith("24px ")).toBe(true);
  expect(expanded.globalRightPanels).toBe(0);

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.mouse.move(640, 120);
  await page.waitForTimeout(200);
  const leftCollapsed = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const leftToolbar = document.querySelector(".channel-sidebar-toolbar");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftX: Math.round(leftDrawer?.getBoundingClientRect().x ?? 0),
      leftOpacity: leftDrawer ? getComputedStyle(leftDrawer).opacity : "",
      toolbarWidth: Math.round(leftToolbar?.getBoundingClientRect().width ?? 0),
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      composerCenterDelta: chatPanelRect && composerRect ? Math.round((composerRect.left + composerRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
    };
  });
  expect(leftCollapsed.columns.startsWith("48px ")).toBe(true);
  expect(leftCollapsed.leftX).toBe(-184);
  expect(leftCollapsed.leftOpacity).toBe("0");
  expect(leftCollapsed.toolbarWidth).toBe(48);
  expect(Math.abs(leftCollapsed.chatCenterDelta)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftCollapsed.composerCenterDelta)).toBeLessThanOrEqual(1);

  await page.mouse.move(22, 22);
  await page.waitForTimeout(200);
  const leftPeek = await page.evaluate(() => {
    const leftDrawer = document.querySelector(".channel-left-drawer");
    return {
      leftX: Math.round(leftDrawer?.getBoundingClientRect().x ?? -999),
      leftOpacity: leftDrawer ? getComputedStyle(leftDrawer).opacity : "",
    };
  });
  expect(leftPeek.leftX).toBe(0);
  expect(leftPeek.leftOpacity).toBe("1");
  await page.mouse.move(640, 120);
  await page.waitForTimeout(200);

  await page.getByRole("button", { name: "Hide details" }).click();
  await page.waitForTimeout(200);
  const rightCollapsed = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const main = document.querySelector(".task-workbench-main");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const attention = document.querySelector(".channel-attention-popover");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      sidePanelCount: document.querySelectorAll(".channel-side-panel").length,
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      composerCenterDelta: chatPanelRect && composerRect ? Math.round((composerRect.left + composerRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      chatTransform: chat ? getComputedStyle(chat).transform : "",
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      attentionCount: document.querySelectorAll(".channel-attention-popover").length,
      attentionTop: Math.round(attention?.getBoundingClientRect().top ?? 0),
      chatLeft: Math.round(chatRect?.left ?? 0),
      attentionLeft: Math.round(attention?.getBoundingClientRect().left ?? 0),
      composerRight: Math.round(composerRect?.right ?? 0),
      composerAttentionGap: composerRect && attention
        ? Math.round(attention.getBoundingClientRect().left - composerRect.right)
        : 0,
      composerAttentionOverlapX: composerRect && attention
        ? Math.max(0, Math.round(Math.min(composerRect.right, attention.getBoundingClientRect().right) - Math.max(composerRect.left, attention.getBoundingClientRect().left)))
        : 0,
    };
  });
  expect(rightCollapsed.columns.startsWith("48px ")).toBe(true);
  expect(rightCollapsed.sidePanelCount).toBe(0);
  expect(rightCollapsed.mainPaddingRight).toBe("0px");
  expect(rightCollapsed.chatTransform).toBe("none");
  expect(rightCollapsed.composerTransform).toBe("none");
  expect(rightCollapsed.attentionCount).toBe(0);
  expect(rightCollapsed.chatLeft).toBeGreaterThanOrEqual(70);
  expect(rightCollapsed.composerAttentionOverlapX).toBe(0);

  await page.getByRole("button", { name: "Show details" }).click();
  await page.getByRole("button", { name: "Show navigation" }).click();
  await page.waitForTimeout(200);
  await expect(page.locator(".channel-side-panel")).toHaveCount(1);
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Progress");
  const restored = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      sidePanelCount: document.querySelectorAll(".channel-side-panel").length,
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      attentionCount: document.querySelectorAll(".channel-attention-popover").length,
    };
  });
  expect(restored.columns.startsWith("232px ")).toBe(true);
  expect(restored.leftWidth).toBe(232);
  expect(restored.sidePanelCount).toBe(1);
  expect(Math.abs(restored.chatCenterDelta)).toBeLessThanOrEqual(1);
  expect(restored.attentionCount).toBe(0);
});

test("channel drawer does not flash legacy create labels in section headers", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const drawer = page.locator(".channel-left-drawer");
  await expect(drawer.getByRole("button", { name: "New channel" })).toBeVisible();
  await expect(drawer.locator(".sidebar-section-title small")).toHaveCount(0);
  await expect(drawer.getByText("Create", { exact: true })).toHaveCount(0);
  await expect(drawer.locator(".sidebar-section:first-of-type .sidebar-section-action")).toHaveText("");
});

test("channel drawer uses unread dots instead of count badges and clears on channel open", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels.push({
    id: "channel_research",
    workspaceId: "workspace_default",
    name: "Research",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  });
  state.approvals.push({
    id: "approval_research",
    channelId: "channel_research",
    actionType: "channel_message",
    risk: "low",
    title: "Review new channel note",
    description: "Unread channel item",
    payload: { type: "channel_message" },
    status: "pending",
    createdAt: "2026-05-22T00:02:00.000Z",
    expiresAt: "2099-01-01T00:01:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  const drawer = page.locator(".channel-left-drawer");
  const engineering = drawer.locator(".sidebar-row").filter({ hasText: "Engineering" });
  const research = drawer.locator(".sidebar-row").filter({ hasText: "Research" });
  await expect(engineering.locator(".channel-mention")).toHaveCount(0);
  await expect(engineering.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator(".channel-mention")).toHaveCount(0);
  await expect(research.locator(".channel-unread")).toBeVisible();

  await research.click();
  await expect(research).toHaveClass(/selected/);
  await expect(research.locator(".channel-unread")).toHaveCount(0);
});

test("wide channel attention popover keeps the accepted HTML spacing", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1140 });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_attention_layout",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Kick off the attention layout discussion.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.waitForTimeout(200);

  const spacing = await page.evaluate(() => {
    const main = document.querySelector(".task-workbench-main");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const attention = document.querySelector(".channel-attention-popover");
    const composerRect = composer?.getBoundingClientRect();
    const attentionRect = attention?.getBoundingClientRect();
    return {
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      chatWidth: Math.round(chat?.getBoundingClientRect().width ?? 0),
      composerWidth: Math.round(composerRect?.width ?? 0),
      attentionWidth: Math.round(attentionRect?.width ?? 0),
      chatTransform: chat ? getComputedStyle(chat).transform : "",
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      gap: composerRect && attentionRect ? Math.round(attentionRect.left - composerRect.right) : -1,
      overlapX: composerRect && attentionRect
        ? Math.max(0, Math.round(Math.min(composerRect.right, attentionRect.right) - Math.max(composerRect.left, attentionRect.left)))
        : -1,
    };
  });
  expect(spacing.mainPaddingRight).toBe("0px");
  expect(spacing.chatWidth).toBe(960);
  expect(spacing.composerWidth).toBe(960);
  expect(spacing.attentionWidth).toBe(390);
  expect(spacing.chatTransform).not.toBe("none");
  expect(spacing.composerTransform).not.toBe("none");
  expect(spacing.gap).toBeGreaterThanOrEqual(48);
  expect(spacing.gap).toBeLessThanOrEqual(80);
  expect(spacing.overlapX).toBe(0);
});

test("channel runtime policy and default teammate are visible and used when creating channels", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "designer", roleKey: "designer", displayName: "Ling Designer" }),
  ];
  const openAiTemplate = {
    templateId: "openai-gpt",
    description: "Official OpenAI endpoint.",
    kind: "openai",
    displayName: "OpenAI GPT",
    providerId: "openai",
    model: "gpt-5.4",
    api: "openai-completions",
    apiKeyRef: "env:OPENAI_API_KEY",
    capabilities: ["chat", "tool_call", "reasoning"],
    input: ["text"],
    enabled: false,
    authHeader: true,
    reasoning: true,
  };
  await mockDaemon(page, state, { templates: [openAiTemplate] });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByText("active channel")).toHaveCount(0);
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Channel management").getByLabel("Default AI teammate")).toHaveValue("engineer");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel).toBeVisible();
  await expect(createChannelPanel.getByLabel("Execution path")).toHaveCount(0);
  await createChannelPanel.getByLabel("Name").fill("Release");
  await createChannelPanel.getByLabel("Status").selectOption("paused");
  await createChannelPanel.getByLabel("Default AI teammate").selectOption("designer");
  await createChannelPanel.getByLabel("Execution mode").selectOption("parallel");
  await createChannelPanel.getByLabel("Write lock").selectOption("workspace");
  await createChannelPanel.getByLabel("Max runs").fill("2");
  await createChannelPanel.getByLabel("Queue on conflict").uncheck();
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Release")).toBe(true);
  const created = state.channels.find((channel) => isRecord(channel) && channel.name === "Release");
  expect(created).toBeTruthy();
  expect(isRecord(created) ? created.status : undefined).toBe("paused");
  expect(isRecord(created) ? created.defaultTeammateId : undefined).toBe("designer");
  const runtimePolicy = isRecord(created) && isRecord(created.runtimePolicy) ? created.runtimePolicy : {};
  expect(runtimePolicy.executionMode).toBe("parallel");
  expect(runtimePolicy.writeLockScope).toBe("workspace");
  expect(runtimePolicy.maxConcurrentRuns).toBe(2);
  expect(runtimePolicy.queueOnConflict).toBe(false);
  await expect(createChannelPanel).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Release" })).toBeVisible();
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  const details = page.getByLabel("Channel management");
  await expect(details.getByLabel("Default AI teammate")).toHaveValue("designer");
  await expect(details.getByRole("button", { name: "Create channel" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Create default" })).toHaveCount(0);
  await details.getByLabel("Name").fill("Release QA");
  await details.getByRole("button", { name: "Save channel" }).click();
  await expect.poll(() => {
    const updated = state.channels.find((channel) => isRecord(channel) && channel.id === (isRecord(created) ? created.id : ""));
    return isRecord(updated) ? updated.name : "";
  }).toBe("Release QA");
});

test("channel settings can add remove and set default teammates", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: undefined }
      : channel,
  );
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer" }),
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      description: "Owns channel design review.",
    }),
  ];
  state.teammateChannelMemberships = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  let manager = page.getByLabel("Channel teammates");
  await expect(manager).toContainText("No teammates in this channel");
  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  await expect(manager).toHaveCount(0);
  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  manager = page.getByLabel("Channel teammates");
  await expect(manager).toContainText("No teammates in this channel");
  await manager.click();
  await expect(manager).toBeVisible();
  await manager.getByLabel("Add teammate").selectOption("teammate_builtin_engineer");
  await manager.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((membership) =>
    isRecord(membership) &&
    membership.teammateId === "teammate_builtin_engineer" &&
    membership.channelId === "channel_engineering"
  )).toBe(true);
  const engineerChip = manager.locator(".channel-teammate-chip").filter({ hasText: "Ling Engineer" });
  await expect(engineerChip).toBeVisible();
  await expect(engineerChip.getByRole("button", { name: "Remove from channel" })).toHaveCount(1);

  await engineerChip.locator(".channel-teammate-chip-main").click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultTeammateId : undefined;
  }).toBe("teammate_builtin_engineer");
  await expect(engineerChip).toHaveClass(/default/);

  await manager.getByLabel("Add teammate").selectOption("teammate_builtin_designer");
  await manager.getByRole("button", { name: "Add", exact: true }).click();
  const designerChip = manager.locator(".channel-teammate-chip").filter({ hasText: "Ling Designer" });
  await expect(designerChip).toBeVisible();
  await designerChip.locator(".channel-teammate-chip-main").click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultTeammateId : undefined;
  }).toBe("teammate_builtin_designer");
  await expect(designerChip).toHaveClass(/default/);

  await engineerChip.getByRole("button", { name: "Remove from channel" }).click({ force: true });
  await expect.poll(() => state.teammateChannelMemberships.some((membership) =>
    isRecord(membership) &&
    membership.teammateId === "teammate_builtin_engineer" &&
    membership.channelId === "channel_engineering"
  )).toBe(false);
  await expect(engineerChip).toHaveCount(0);
  await expect(designerChip).toBeVisible();
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  const notifications = page.getByLabel("Channel notifications");
  await notifications.getByRole("radio", { name: "Muted" }).click();
  await expect(notifications.getByRole("radio", { name: "Muted" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.channelNotifications.%2Ftmp%2Fling-stack-workspace.channel_engineering"))).toBe("muted");
});

test("paused channels disable task run actions", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = state.channels.map((channel) => isRecord(channel) ? { ...channel, status: "paused" } : channel);
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskCard = page.locator("article.task-detail");
  await expect(taskCard).toContainText("Channel is not active");
  await expect(taskCard.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
});

test("channel activity supports mentions, messages, files, links, and topic replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-05-25T00:11:00.000Z",
    },
  })];
  state.channelMessageDelayMs = 150;
  state.linkPreviewDelayMs = 150;
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator('.channel-composer [aria-label="Composer mode"]')).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Task" })).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByText("Discuss")).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByText("@ teammates, drop files, or paste links")).toHaveCount(0);
  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await expect(page.getByLabel("Message tools").getByLabel("Attach files")).toBeVisible();
  await expect(page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" })).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Send" })).toBeVisible();
  await page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" }).click();
  await expect(composerInput).toHaveValue("@");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composerInput.fill("@Eng");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await page.getByRole("option", { name: /@Engineer/ }).click();
  await expect(page.getByLabel("Pending message assets")).toContainText("@Engineer");
  await expect(composerInput).toHaveValue("@Engineer ");
  await composerInput.fill("please refine without mention");
  await composerInput.fill("@Engineer please refine the channel requirements https://example.com");
  await expect(page.getByText("Example Domain").first()).toBeVisible({ timeout: 3_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["channel brief"], "brief.txt", { type: "text/plain" }));
    return transfer;
  });
  const dropZone = page.locator(".composer-drop-zone");
  await dropZone.dispatchEvent("dragover", { dataTransfer });
  await expect(page.getByText("Drop files to attach")).toBeVisible();
  await dropZone.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  const pendingAssets = page.getByLabel("Pending message assets");
  await expect(pendingAssets).toContainText("brief.txt");
  const previewLayout = await page.locator(".channel-composer").evaluate((element) => {
    const preview = element.querySelector(".composer-preview-strip");
    const textarea = element.querySelector("textarea");
    if (!preview || !textarea) {
      return null;
    }
    return {
      previewTop: preview.getBoundingClientRect().top,
      textareaTop: textarea.getBoundingClientRect().top,
    };
  });
  if (!previewLayout) {
    throw new Error("Expected composer pending assets to render before the textarea.");
  }
  expect(previewLayout.previewTop).toBeLessThan(previewLayout.textareaTop);
  const imageTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    const binary = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    transfer.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    return transfer;
  });
  await dropZone.dispatchEvent("drop", { dataTransfer: imageTransfer });
  await imageTransfer.dispose();
  await expect(page.locator(".composer-preview-thumbnail[alt='shot.png']")).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Send" })).toBeEnabled();
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("@Engineer please refine the channel requirements")).toBeVisible();
  await expect(page.locator(".channel-composer .composer-status-row.loading")).toHaveCount(0);
  const pendingReply = page.locator(".message-bubble").filter({ hasText: "AI teammate is replying..." });
  await expect(pendingReply).toBeVisible();
  await expect(pendingReply).toHaveClass(/message-bubble-peer/);
  await expect(page.getByText("收到，我会按频道上下文推进。")).toBeVisible();
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
  await expect.poll(() => state.lastChannelMessageRequest?.providerPresetId).toBe("provider_local");
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Files" }).click();
  await expect(page.getByRole("link", { name: /brief\.txt/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /shot\.png/ })).toBeVisible();
  await expect(page.getByText("Example Domain")).toBeVisible();

  const sentMessage = page.locator(".message-bubble").filter({ hasText: "@Engineer please refine the channel requirements" });
  const teammateReply = page.locator(".message-bubble").filter({ hasText: "收到，我会按频道上下文推进。" });
  const sentMessageContent = sentMessage.locator(".message-content");
  const teammateReplyContent = teammateReply.locator(".message-content");
  await expect(sentMessage).toBeVisible();
  await expect(teammateReply).toBeVisible();
  await expect(sentMessage).toHaveClass(/message-bubble-own/);
  await expect(teammateReply).toHaveClass(/message-bubble-peer/);
  const messageLayout = await page.locator(".message-feed").evaluate((feed) => {
    const own = feed.querySelector(".message-bubble-own .message-content");
    const peer = feed.querySelector(".message-bubble-peer .message-content");
    if (!own || !peer) {
      return null;
    }
    const feedRect = feed.getBoundingClientRect();
    const ownRect = own.getBoundingClientRect();
    const peerRect = peer.getBoundingClientRect();
    return {
      feedLeft: feedRect.left,
      feedRight: feedRect.right,
      ownLeft: ownRect.left,
      ownRight: ownRect.right,
      peerLeft: peerRect.left,
      peerRight: peerRect.right,
    };
  });
  if (!messageLayout) {
    throw new Error("Expected own and peer chat bubbles to render in the message feed.");
  }
  expect(messageLayout.ownRight).toBeGreaterThan(messageLayout.feedRight - 64);
  expect(messageLayout.peerLeft).toBeLessThan(messageLayout.feedLeft + 48);
  expect(messageLayout.ownLeft).toBeGreaterThan(messageLayout.peerLeft);
  expect(messageLayout.ownRight).toBeGreaterThan(messageLayout.peerRight);
  await expect(sentMessage.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);
  await expect(sentMessage.locator(".message-meta")).toHaveCount(0);
  await expect(teammateReply.locator(".message-meta time")).toHaveCount(0);
  const sentMessageTypography = await sentMessage.evaluate((element) => {
    const body = element.querySelector(".message-content p");
    return {
      bodyColor: body ? getComputedStyle(body).color : "",
      bodyFontWeight: body ? Number(getComputedStyle(body).fontWeight) : 0,
    };
  });
  expect(sentMessageTypography.bodyColor).not.toBe("");
  expect(sentMessageTypography.bodyFontWeight).toBeGreaterThanOrEqual(550);
  await expect(sentMessageContent).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(sentMessageContent).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(sentMessageContent).toHaveCSS("padding-top", "0px");
  await teammateReply.hover();
  await expect(teammateReplyContent).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(teammateReplyContent).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(teammateReplyContent).toHaveCSS("padding-top", "0px");
  await page.mouse.move(8, 8);
  await expect(sentMessage.locator(".message-meta-action")).toHaveCSS("opacity", "0");
  const replyActionLayout = await sentMessage.evaluate((element) => {
    const action = element.querySelector(".message-meta-action");
    const content = element.querySelector(".message-content");
    if (!action || !content) {
      return null;
    }
    const actionRect = action.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      actionHeight: actionRect.height,
      actionRightInset: contentRect.right - actionRect.right,
    };
  });
  expect(replyActionLayout).toEqual({
    actionHeight: expect.any(Number),
    actionRightInset: expect.any(Number),
  });
  expect(replyActionLayout?.actionHeight).toBeLessThanOrEqual(20);
  expect(replyActionLayout?.actionRightInset).toBeLessThanOrEqual(12);
  await sentMessage.hover();
  await expect(sentMessage.locator(".message-meta-action")).toHaveCSS("opacity", "1");
  await expect(sentMessage.getByRole("button", { name: "Reply in topic" })).toHaveAttribute("data-tooltip", "Reply in topic");
  await sentMessage.getByRole("button", { name: "Reply in topic" }).click();
  const topicPanel = page.getByLabel("Topic replies");
  await expect(topicPanel).toBeVisible();
  await expect(topicPanel).toContainText("收到，我会按频道上下文推进。");
  await topicPanel.getByLabel("Topic reply input").fill("Thread follow-up from the topic panel");
  await topicPanel.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => state.lastChannelMessageRequest?.threadId).toBe("msg_1");
  await expect(topicPanel).toContainText("Thread follow-up from the topic panel");
});

test("channel execution proposal confirms into a task run with the assignee provider", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Relay",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-05-25T00:11:00.000Z" },
    }),
  ];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_engineer",
      displayName: "Ling Engineer",
      providerPresetId: "provider_ready",
      allowedTools: ["read", "bash"],
      approvalProfile: { mode: "standard", risk: "medium", requiredForTools: ["bash"] },
    }),
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      description: "Reviews visual flow and interaction risks.",
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer" }
      : channel,
  );
  state.teammateChannelMemberships = [
    {
      teammateId: "teammate_builtin_engineer",
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_user_proposal",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Can we turn this into an execution task?",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:00.000Z",
      updatedAt: "2026-05-25T00:18:00.000Z",
    },
    {
      id: "msg_ai_proposal",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_user_proposal",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_engineer",
      body: "I can handle this as an execution task after confirmation.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:01.000Z",
      updatedAt: "2026-05-25T00:18:01.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_ai_proposal",
      proposedByTeammateId: "teammate_builtin_engineer",
      title: "Refine channel workspace copy",
      prompt: "Refine the channel workspace copy and verify the visible chat flow.",
      assigneeTeammateId: "teammate_builtin_engineer",
      acceptanceCriteria: ["Task is created only after confirmation", "Run uses the assignee provider"],
      collaborationSteps: [
        { teammateId: "teammate_builtin_engineer", action: "coordinated", summary: "Summarized discussion into one execution proposal." },
        { teammateId: "teammate_builtin_designer", action: "reviewed", summary: "Checked visual hierarchy before execution." },
      ],
      requiredTools: ["read", "grep"],
      riskSummary: "Provider must be ready before execution.",
      status: "draft",
      createdAt: "2026-05-25T00:18:02.000Z",
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const proposal = page.getByLabel("Execution proposal");
  await expect(proposal).toContainText("Refine channel workspace copy");
  await expect(proposal).toContainText("Ling Engineer");
  const collaboration = proposal.locator(".channel-proposal-collaboration");
  await expect(collaboration).not.toHaveAttribute("open", /.+/);
  await expect(collaboration.locator("summary")).toContainText("Collaboration 2 records");
  await expect(collaboration.locator("summary")).toContainText("Ling Engineer Summarized discussion into one execution proposal.");
  await expect(collaboration.locator("summary")).toContainText("Ling Designer Checked visual hierarchy before execution.");
  await expect(collaboration.locator("li").first()).not.toBeVisible();
  await collaboration.locator("summary").click();
  await expect(collaboration.locator("li").first()).toBeVisible();
  await expect(collaboration).toContainText("Coordinated");
  await expect(collaboration).toContainText("Reviewed");
  await proposal.getByRole("button", { name: "Start handling" }).click();

  await expect.poll(() => {
    const task = state.tasks.find((item) => isRecord(item) && item.title === "Refine channel workspace copy");
    return isRecord(task) ? task.assigneeTeammateId : undefined;
  }).toBe("teammate_builtin_engineer");
  await expect.poll(() => state.runs[0]?.providerPresetId).toBe("provider_ready");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) && Array.isArray(snapshot.tools) ? snapshot.tools.join(",") : "";
  }).toBe("read,bash");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) && isRecord(snapshot.approvalProfile) ? snapshot.approvalProfile.mode : "";
  }).toBe("standard");
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_1");
    return isRecord(updated) ? [updated.status, updated.linkedTaskId, updated.linkedRunId].join("|") : "";
  }).toMatch(/^accepted\|task_\d+\|run_\d+$/);
  await expect(proposal.getByRole("button", { name: "Open run" })).toBeVisible();
});

test("channel files tab keeps daylight surfaces even when the app theme is dark", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelFilesPanel(page);
  await expect(page.getByText("No attachments in this channel")).toBeVisible();
  await expect(page.getByText("No shared links in this channel")).toBeVisible();
  await expect(page.getByText("No run artifacts in this channel")).toBeVisible();
  const fileTabLayout = await page.evaluate(() => {
    const panel = document.querySelector(".task-list-panel");
    const files = document.querySelector(".channel-files");
    if (!panel || !files) {
      return null;
    }
    return {
      filesHeight: files.getBoundingClientRect().height,
      panelHeight: panel.getBoundingClientRect().height,
    };
  });
  if (!fileTabLayout) {
    throw new Error("Files tab layout was not rendered");
  }
  expect(fileTabLayout.filesHeight).toBeGreaterThan(fileTabLayout.panelHeight - 96);
  const fileTabDaylightSurfaces = await page.evaluate(() => {
    function effectiveBackgroundColor(element: Element): number[] {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        const channels = color.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        const alpha = channels.length >= 4 ? channels[3] : 1;
        if (channels.length >= 3 && alpha > 0) {
          return channels.slice(0, 3);
        }
        current = current.parentElement;
      }
      return [255, 255, 255];
    }
    const selectors = [".file-section", ".channel-files .client-empty-state"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const color = effectiveBackgroundColor(element);
        return {
          selector,
          maxChannel: color.length > 0 ? Math.max(...color) : 255,
        };
      }),
    );
  });
  expect(fileTabDaylightSurfaces).toHaveLength(6);
  for (const surface of fileTabDaylightSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on the accepted daylight channel surface`).toBeGreaterThanOrEqual(245);
  }
});

test("channel activity filter chips keep daylight channel tokens", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const activityFilters = channelEventFilters(page);
  await channelEventFilterToggle(activityFilters).click();
  await expect(activityFilters.locator(".activity-filter-panel")).toBeVisible();
  await activityFilters.getByLabel("Activity attention filters").locator(".activity-filter-chip").filter({ hasText: "Failed" }).click();
  const filterChipSurfaces = await page.evaluate(() => {
    const selectors = [".activity-filter-chip", ".activity-filter-chip.attention.active"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const color = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
        return {
          selector,
          maxChannel: color.length > 0 ? Math.max(...color) : 255,
        };
      }),
    );
  });
  expect(filterChipSurfaces.length).toBeGreaterThan(0);
  for (const surface of filterChipSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on daylight channel tokens`).toBeGreaterThanOrEqual(245);
  }
});

test("channel activity keeps the composer visible while the message feed scrolls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = Array.from({ length: 36 }, (_, index) => ({
    id: `msg_scroll_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: `Scrollable channel message ${index + 1}. This message keeps the Activity feed tall enough to scroll independently.`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 4, 25, 0, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 4, 25, 0, index, 0)).toISOString(),
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await expect(page.locator('[aria-label="Channel activity"] > .panel-title')).toHaveCount(0);
  const scrollState = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollState.max).toBeGreaterThan(0);
  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  const latestButton = page.getByRole("button", { name: "Jump to latest message" });
  await expect(latestButton).toHaveCount(0);
  const feedChrome = await page.locator(".activity-shell .message-feed").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
    };
  });
  expect(feedChrome).toEqual({
    overflowY: "auto",
    scrollbarWidth: "none",
  });
  await expect(page.locator(".activity-chat-layout")).toHaveCSS("padding-top", "0px");
  const panelBox = await page.locator(".task-list-panel.activity-tab-panel").boundingBox();
  const feedBox = await page.locator(".activity-shell .message-feed").boundingBox();
  const composerBox = await page.getByLabel("Channel composer").boundingBox();
  expect(feedBox?.height ?? 0).toBeGreaterThan(180);
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeGreaterThan((panelBox?.y ?? 0) + (panelBox?.height ?? 0) - 36);
  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(latestButton).toBeVisible();
  await expect.poll(async () => {
    const latestButtonBox = await latestButton.boundingBox();
    return {
      width: Math.round(latestButtonBox?.width ?? 0),
      height: Math.round(latestButtonBox?.height ?? 0),
    };
  }).toMatchObject({ width: 42, height: 42 });
  await latestButton.click({ force: true });
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect(latestButton).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
});

test("channel activity paginates long message history and virtualizes visible rows", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = Array.from({ length: 3000 }, (_, index) => ({
    id: `msg_long_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: index % 2 === 0 ? "local-user" : "ai-teammate",
    authorId: index % 2 === 0 ? "tian" : "engineer",
    body: `Long channel message ${index + 1}`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 4, 26, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 4, 26, 0, 0, index)).toISOString(),
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 3000")).toBeVisible();
  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 1")).toHaveCount(0);
  expect(state.channelMessageQueries?.[0]).toMatchObject({
    channelId: "channel_engineering",
    limit: 200,
    beforeMessageId: undefined,
  });

  const renderedBefore = await page.locator(".activity-shell .message-feed .message-bubble").count();
  expect(renderedBefore).toBeGreaterThan(0);
  expect(renderedBefore).toBeLessThan(100);
  const scrollBefore = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollBefore.atBottom).toBe(true);

  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => state.channelMessageQueries?.some((query) => query.beforeMessageId === "msg_long_2801")).toBe(true);
  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 2801")).toBeVisible();
  const renderedAfter = await page.locator(".activity-shell .message-feed .message-bubble").count();
  expect(renderedAfter).toBeLessThan(120);
  const scrollAfter = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollAfter.top).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
});

test("channel composer preserves failed sends and can retry", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.failNextChannelMessage = true;
  await mockDaemon(page, state);
  await page.goto("/");

  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await composerInput.fill("Retryable channel message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Message failed")).toBeVisible();
  await expect(composerInput).toHaveValue("Retryable channel message");

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Channel message feed").getByText("Retryable channel message")).toBeVisible();
  await expect(composerInput).toHaveValue("");
  await expect(page.getByText("Message failed")).toHaveCount(0);
});

test("channel URL preview blocked state stays in Activity and still allows sending text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Please remember this blocked reference http://127.0.0.1/private");
  await expect(page.getByText("Private network previews are blocked.")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByLabel("Channel message feed")).toBeVisible();

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Channel message feed").getByText("Please remember this blocked reference http://127.0.0.1/private")).toBeVisible();
});

test("channel files tab supports PDF and Office uploads without AI ingestion", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  const initialMessageCount = state.channelMessages.length;
  const initialTaskCount = state.tasks.length;
  await expect(page.getByPlaceholder("Message this channel or @ an AI teammate")).toBeVisible();
  await page.locator("input[type=file]").setInputFiles([
    {
      name: "requirements.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7"),
    },
    {
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("docx"),
    },
    {
      name: "budget.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("xlsx"),
    },
    {
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("pptx"),
    },
  ]);

  await expect.poll(() => state.channelAttachments.length).toBe(4);
  await openChannelFilesPanel(page);
  await expect(page.locator(".channel-side-panel")).toContainText("Files");
  for (const fileName of ["requirements.pdf", "notes.docx", "budget.xlsx", "deck.pptx"]) {
    const card = page.locator(".file-card").filter({ hasText: fileName });
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/attachments\/att_.*\/content/);
  }
  expect(state.channelAttachments.filter((attachment) => isRecord(attachment)).map((attachment) => attachment.fileName).sort()).toEqual([
    "budget.xlsx",
    "deck.pptx",
    "notes.docx",
    "requirements.pdf",
  ]);
  expect(state.channelAttachments.every((attachment) => isRecord(attachment) && (attachment.kind === "pdf" || attachment.kind === "office"))).toBe(true);
  expect(state.channelMessages.length).toBe(initialMessageCount);
  expect(state.tasks.length).toBe(initialTaskCount);
});

test("channel files tab aggregates run artifacts and keeps other channel artifacts isolated", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  });
  state.tasks.push({
    id: "task_design",
    workspaceId: "workspace_default",
    channelId: "channel_design",
    title: "Design artifact task",
    prompt: "Produce design artifacts.",
    status: "done",
    currentRunId: "run_design",
    createdAt: "2026-05-25T00:10:00.000Z",
    updatedAt: "2026-05-25T00:20:00.000Z",
  });
  state.runs = [
    {
      ...state.runs[0],
      status: "succeeded",
      summaryPath: ".ling-stack/summaries/run_failed.json",
      errorMessage: undefined,
      updatedAt: "2026-05-25T00:20:30.000Z",
    },
    {
      id: "run_design",
      status: "succeeded",
      cwd,
      taskId: "task_design",
      channelId: "channel_design",
      providerPresetId: "provider_local",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      taskSnapshot: { id: "task_design", title: "Design artifact task" },
      providerSnapshot: { provider: "local-relay", model: "gpt-5.5" },
      requestSnapshot: { cwd, providerPresetId: "provider_local" },
      eventLogPath: ".ling-stack/sessions/run_design.jsonl",
      summaryPath: ".ling-stack/summaries/run_design.json",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:20:00.000Z",
    },
  ];
  state.artifactsByRun.run_failed = [
    {
      id: "artifact_channel_report",
      runId: "run_failed",
      type: "markdown",
      path: "run_failed/001-channel-report.md",
      title: "Channel report",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 512,
      createdAt: "2026-05-25T00:20:31.000Z",
    },
    {
      id: "artifact_channel_image",
      runId: "run_failed",
      type: "image",
      path: "run_failed/002-channel-image.png",
      title: "Channel image",
      contentType: "image/png",
      sizeBytes: 2048,
      createdAt: "2026-05-25T00:20:32.000Z",
    },
  ];
  state.artifactsByRun.run_design = [
    {
      id: "artifact_design_report",
      runId: "run_design",
      type: "markdown",
      path: "run_design/001-design-report.md",
      title: "Other channel report",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 128,
      createdAt: "2026-05-25T00:20:33.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelFilesPanel(page);
  await expect(page.getByText("Loading run artifacts...")).toHaveCount(0);
  await expect(page.getByText("Run artifacts")).toBeVisible();
  await expect(page.locator(".run-artifact-group")).toHaveCount(1);
  const runGroup = page.locator(".run-artifact-group").filter({ hasText: "Inspect workspace" });
  await expect(runGroup).toContainText("Inspect workspace");
  await expect(runGroup.locator(".session-file-list")).not.toBeVisible();
  await expect(runGroup.locator(".artifact-row").first()).toContainText("Channel report");
  await expect(runGroup.locator(".artifact-row").first().locator(".artifact-main-link")).toHaveAttribute(
    "href",
    /\/artifacts\/artifact_channel_report\/content\?cwd=%2Ftmp%2Fling-stack-workspace/,
  );
  const imageRow = runGroup.locator(".artifact-row").filter({ hasText: "Channel image" });
  await expect(imageRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_channel_image\/content/);
  await expect(imageRow.getByRole("link", { name: "Download" })).toHaveAttribute("href", /\/artifacts\/artifact_channel_image\/content/);
  await expect(page.getByText("Other channel report")).toHaveCount(0);
});

test("channel v1.1 protocol supports brief, decisions, handoffs, and context task creation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  const briefLoaded = page.waitForResponse((response) => response.url().includes("/channels/channel_engineering/brief") && response.request().method() === "GET");
  await page.goto("/");
  await briefLoaded;

  await expect(page.getByText("Loading protocol...")).toHaveCount(0);
  await expect(page.getByLabel("Objective")).toHaveCount(0);
  await openChannelContextPanel(page);
  await page.getByLabel("Objective").fill("Ship channel v1.1 protocol");
  await page.getByLabel("Scope").fill("Brief, decisions, handoffs, context summaries");
  await page.getByLabel("Acceptance criteria").fill("Brief saves\nActivity shows protocol items");
  await page.getByRole("button", { name: "Save brief" }).click();
  await expect.poll(() => {
    const brief = state.channelBriefs.channel_engineering;
    return isRecord(brief) ? brief.objective : undefined;
  }).toBe("Ship channel v1.1 protocol");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Keep v1.1 handoffs manual and visible.");
  await page.getByRole("button", { name: "Send" }).click();
  const plainMessage = page.locator(".message-bubble").filter({ hasText: "Keep v1.1 handoffs manual and visible." });
  await expect(plainMessage).toBeVisible();
  await expect(plainMessage.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);

  const taskEventBubble = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" });
  const activityDetails = page.getByLabel("Activity details");
  const openTriageActions = async () => {
    const triageSection = activityDetails.locator(".activity-triage-section");
    await expect(triageSection).toBeVisible();
    if ((await triageSection.getAttribute("open")) === null) {
      await triageSection.locator("summary").click();
    }
  };

  await openChannelChatTools(page);
  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Record decision" }).click();
  await activityDetails.getByLabel("Triage title").fill("Decision: Keep v1.1 handoffs manual");
  await activityDetails.getByLabel("Decision text").fill("Keep v1.1 handoffs manual and visible.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelDecisions.length).toBe(1);
  await activityDetails.getByLabel("Close details").click();
  await expect(page.getByText("Decision log")).toBeVisible();

  await page.getByRole("button", { name: "Supersede" }).first().click();
  await expect.poll(() => state.channelDecisions.filter((decision) => isRecord(decision) && decision.status === "active").length).toBe(1);
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.status === "superseded")).toBe(true);

  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create handoff" }).click();
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);
  await activityDetails.getByLabel("Close details").click();
  await expect(page.getByText("Handoff", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Complete" }).first().click();
  await expect.poll(() => isRecord(state.channelHandoffs[0]) ? state.channelHandoffs[0].status : undefined).toBe("completed");
  await expect.poll(() => isRecord(state.tasks.find((task) => isRecord(task) && task.id === "task_inspect")) ? state.tasks.find((task) => isRecord(task) && task.id === "task_inspect")?.status : undefined).toBe("failed");

  const taskCount = state.tasks.length;
  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create context summary" }).click();
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelContextSummaries.length).toBe(1);
  await activityDetails.getByLabel("Close details").click();
  const summaryBubble = page.locator(".message-bubble").filter({ hasText: "Context summary" }).first();
  await expect(summaryBubble).toBeVisible();
  await summaryBubble.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);

  await page.reload();
  await openChannelContextPanel(page);
  await expect(page.getByLabel("Objective")).toHaveValue("Ship channel v1.1 protocol");
});

test("channel v1.2 handoff workflows can start steps and surface runtime context", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider()];
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator("article.task-detail").getByRole("button", { name: "Create handoff" }).click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);

  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Handoffs" }).click();
  await page.getByRole("button", { name: "Start workflow" }).first().click();
  await expect.poll(() => state.channelWorkflows.length).toBe(1);
  await expect.poll(() => state.channelWorkflowSteps.length).toBe(1);
  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Runtime" }).click();
  await expect(page.getByText("Workflow queue")).toBeVisible();
  await expect(page.getByText("Active decisions: 0")).toBeVisible();
  const workflowStepLayout = await page.locator(".workflow-step-card").first().evaluate((element) => {
    const cardRect = element.getBoundingClientRect();
    const actionRow = element.querySelector(".activity-action-row");
    const actionRect = actionRow?.getBoundingClientRect();
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>(".activity-action-row .compact-button")).map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        whiteSpace: getComputedStyle(button).whiteSpace,
      };
    });
    return {
      cardLeft: Math.round(cardRect.left),
      cardRight: Math.round(cardRect.right),
      actionLeft: Math.round(actionRect?.left ?? 0),
      actionRight: Math.round(actionRect?.right ?? 0),
      gridColumns: getComputedStyle(element).gridTemplateColumns,
      buttons,
    };
  });
  expect(workflowStepLayout.gridColumns.split(" ").length).toBe(1);
  expect(workflowStepLayout.actionLeft).toBeGreaterThanOrEqual(workflowStepLayout.cardLeft);
  expect(workflowStepLayout.actionRight).toBeLessThanOrEqual(workflowStepLayout.cardRight);
  for (const button of workflowStepLayout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(workflowStepLayout.cardLeft);
    expect(button.right).toBeLessThanOrEqual(workflowStepLayout.cardRight);
    expect(button.width).toBeGreaterThanOrEqual(58);
    expect(button.whiteSpace).toBe("nowrap");
  }

  const taskCount = state.tasks.length;
  await page.getByRole("button", { name: "Start step" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await expect.poll(() => {
    const step = state.channelWorkflowSteps[0];
    return isRecord(step) ? step.status : undefined;
  }).toBe("succeeded");
  await openChannelTasksTab(page);
  await expect(page.locator("article.task-detail")).toContainText("Source workflow");

  const blockedStep = {
    id: "workflow_step_blocked",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    workflowId: isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].id : "workflow_1",
    position: 2,
    title: "Blocked follow-up",
    prompt: "Needs provider recovery.",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    status: "blocked",
    blocker: "Provider preflight failed.",
    createdAt: "2026-05-25T00:35:00.000Z",
    updatedAt: "2026-05-25T00:35:00.000Z",
  };
  state.channelWorkflowSteps.push(blockedStep);
  const workflow = state.channelWorkflows[0];
  if (isRecord(workflow)) {
    workflow.status = "running";
  }
  await page.reload();
  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Runtime" }).click();
  await expect(page.locator(".workflow-step-card").filter({ hasText: "Blocked follow-up" })).toContainText("Provider preflight failed.");
});

test("channel v1.2 workflow start and run uses the existing run surface", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider()];
  state.channelWorkflows = [
    {
      id: "workflow_seed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Seed workflow",
      objective: "Create and run a task from a workflow step.",
      status: "ready",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:34:00.000Z",
      updatedAt: "2026-05-25T00:34:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_seed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_seed",
      position: 1,
      title: "Run seeded step",
      prompt: "Run this workflow step.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "queued",
      createdAt: "2026-05-25T00:34:00.000Z",
      updatedAt: "2026-05-25T00:34:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Runtime" }).click();
  await page.getByRole("button", { name: "Start + run" }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect.poll(() => {
    const step = state.channelWorkflowSteps.find((item) => isRecord(item) && item.id === "workflow_step_seed");
    return isRecord(step) ? step.runId : undefined;
  }).toBe("run_2");
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Run seeded step" })).toContainText("succeeded");
});

test("channel activity derives task run approval transition and workflow events", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_timeline",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Timeline source message",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  });
  state.tasks.push({
    id: "task_design_timeline",
    workspaceId: "workspace_default",
    channelId: "channel_design",
    title: "Other channel task leak",
    prompt: "Should not appear in Engineering.",
    status: "done",
    currentRunId: "run_design_timeline",
    createdAt: "2026-05-25T00:02:00.000Z",
    updatedAt: "2026-05-25T00:03:00.000Z",
  });
  state.runs.push({
    id: "run_design_timeline",
    status: "succeeded",
    cwd,
    taskId: "task_design_timeline",
    channelId: "channel_design",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_design_timeline", title: "Other channel task leak" },
    providerSnapshot: { provider: "local-relay" },
    requestSnapshot: { cwd },
    eventLogPath: ".ling-stack/sessions/run_design_timeline.jsonl",
    createdAt: "2026-05-25T00:02:00.000Z",
    updatedAt: "2026-05-25T00:03:00.000Z",
  });
  state.approvals.push({
    id: "approval_design_timeline",
    runId: "run_design_timeline",
    taskId: "task_design_timeline",
    actionType: "bash",
    risk: "medium",
    title: "Other channel approval leak",
    description: "echo design",
    payload: {},
    status: "pending",
    createdAt: "2026-05-25T00:03:00.000Z",
    expiresAt: "2099-01-01T00:01:00.000Z",
  });
  state.channelWorkflows = [
    {
      id: "workflow_activity",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Timeline workflow",
      objective: "Show workflow in Activity.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:05:00.000Z",
      updatedAt: "2026-05-25T00:06:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_activity",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_activity",
      position: 1,
      title: "Blocked timeline step",
      prompt: "Wait for runtime recovery.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "blocked",
      blocker: "Runtime policy is waiting.",
      createdAt: "2026-05-25T00:06:00.000Z",
      updatedAt: "2026-05-25T00:07:00.000Z",
    },
  ];
  state.stateTransitions = [
    {
      id: "transition_task_timeline",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_inspect",
      fromStatus: "todo",
      toStatus: "failed",
      event: "task_failed",
      actor: "runner",
      createdAt: "2026-05-25T00:03:00.000Z",
    },
    {
      id: "transition_design_timeline",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_design_timeline",
      fromStatus: "todo",
      toStatus: "done",
      event: "other_channel_done",
      actor: "runner",
      createdAt: "2026-05-25T00:04:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const messageBubble = page.locator(".channel-message-row").filter({ hasText: "Timeline source message" });
  const taskEventBubble = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" });
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" });
  const stateTransitionBubble = page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" });
  const workflowStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" });
  const activityDetails = page.getByLabel("Activity details");
  const openDetailsFrom = async (bubble: Locator, expectedText: string) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const detailsButton = bubble.getByRole("button", { name: "Details" });
        await expect(detailsButton).toBeVisible();
        await detailsButton.click({ timeout: 1_000 });
        break;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await page.waitForTimeout(50);
      }
    }
    await expect(activityDetails).toBeVisible();
    await expect(activityDetails).toContainText(expectedText);
    await expect(activityDetails).toContainText("Source summary");
    await expect(activityDetails).toContainText("Source metadata");
    await expect(activityDetails).toContainText("Related objects");
    await activityDetails.getByLabel("Close details").click();
    await expect(activityDetails).toHaveCount(0);
  };

  await expect(messageBubble).toBeVisible();
  await expect(messageBubble.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);
  await expect(taskEventBubble).toHaveCount(0);
  await expect(runEventBubble).toHaveCount(0);
  await expect(approvalEventBubble).toHaveCount(0);
  await expect(stateTransitionBubble).toHaveCount(0);
  await expect(workflowStepBubble).toHaveCount(0);
  await openChannelChatTools(page);
  await expect(taskEventBubble).toContainText("failed");
  await expect(runEventBubble).toContainText("failed");
  await expect(approvalEventBubble).toContainText("pending");
  await expect(stateTransitionBubble).toBeVisible();
  await expect(workflowStepBubble).toContainText("Runtime policy is waiting.");
  await expect(page.getByText("Other channel task leak")).toHaveCount(0);
  await expect(page.getByText("Other channel approval leak")).toHaveCount(0);
  await expect(page.getByText("other_channel_done")).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const composer = page.getByLabel("Channel composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "More" })).toHaveCount(0);
  await composer.getByPlaceholder("Message this channel or @ an AI teammate").fill("@Eng");
  await expect(composer.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composer.getByRole("option", { name: /@Engineer/ }).click();
  await expect(composer.getByLabel("Pending message assets")).toContainText("@Engineer");

  await openDetailsFrom(taskEventBubble, "Inspect workspace");
  await openDetailsFrom(runEventBubble, "Run run_failed");
  await openDetailsFrom(approvalEventBubble, "Approve shell command");
  await openDetailsFrom(stateTransitionBubble, "task_failed");
  await openDetailsFrom(workflowStepBubble, "Blocked timeline step");

  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open task" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");
  await expect(activityDetails).toHaveCount(0);

  await openChannelChatTools(page);
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open run" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);

  await approvalEventBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open approval" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Approval details");
  await expect(page.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);

  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open context" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await expect(activityDetails).toHaveCount(0);

  await openChannelChatTools(page);
  const activityFilters = channelEventFilters(page);
  const activityFeed = page.getByLabel("Channel message feed");
  const searchInput = activityFilters.getByPlaceholder("Search activity");
  const savedViewSelect = activityFilters.locator('select[aria-label="Saved views"]');
  const savedViewOption = (label: string) => savedViewSelect.locator("option").filter({ hasText: label });
  const selectSavedView = async (label: string) => {
    await openChannelChatTools(page);
    const value = await savedViewOption(label).getAttribute("value");
    expect(value).toBeTruthy();
    await savedViewSelect.selectOption(value ?? "");
  };
  const openFilterPanel = async () => {
    if (await activityFilters.locator(".activity-filter-panel").count() === 0) {
      await channelEventFilterToggle(activityFilters).click();
    }
  };
  const categoryChip = (label: string) => activityFilters.getByLabel("Activity categories").locator(".activity-filter-chip").filter({ hasText: label });
  const attentionChip = (label: string) => activityFilters.getByLabel("Activity attention filters").locator(".activity-filter-chip").filter({ hasText: label });

  await expect(activityFilters).toBeVisible();
  await expect(activityFilters.locator(".activity-saved-views")).toHaveCount(0);
  await expect(savedViewSelect).toContainText("All (7)");
  await expect(savedViewSelect).toContainText("Needs attention (5)");
  await expect(savedViewSelect).toContainText("Blocked (1)");
  await expect(savedViewSelect).toContainText("Failed (3)");
  await expect(savedViewSelect).toContainText("Pending approvals (1)");
  await expect(savedViewSelect).toContainText("Failed work (2)");
  await expect(savedViewSelect).toContainText("Runtime (3)");
  await expect(activityFilters.getByLabel("Activity categories")).toHaveCount(0);
  await openFilterPanel();
  await expect(activityFilters.locator(".activity-filter-panel")).toBeVisible();
  await expect(categoryChip("All")).toContainText("7");
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("2");
  await expect(categoryChip("Approvals")).toContainText("1");
  await expect(categoryChip("Protocol")).toContainText("0");
  await expect(categoryChip("Runtime")).toContainText("3");

  const attentionQueue = page.getByRole("region", { name: "Attention queue" });
  await expect(attentionQueue.getByLabel("Environment")).toContainText("Current channel");
  await expect(attentionQueue.getByLabel("Environment")).toContainText("Engineering");
  await expect(attentionQueue).toContainText("Attention");
  await expect(attentionQueue).toContainText("5");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Blocked 1");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Failed 3");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Pending 1");
  const topAttentionItems = attentionQueue.getByLabel("Top attention items");
  await expect(topAttentionItems.locator(".attention-queue-item")).toHaveCount(5);
  await expect(topAttentionItems.locator(".attention-queue-item-open").first()).toContainText("Blocked timeline step");
  const attentionTypography = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const style = getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    };
    const readIcon = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        strokeWidth: style.strokeWidth,
      };
    };
    return {
      environmentTitle: read(".attention-context-section .attention-section-head strong"),
      progressTitle: read(".attention-progress-head strong"),
      progressPrimary: read(".attention-progress-copy strong"),
      progressSecondary: read(".attention-progress-copy small"),
      progressIcon: readIcon(".attention-progress-list svg"),
      attentionTitle: read(".attention-queue-head strong"),
      attentionCount: read(".attention-queue-head small"),
      countChip: read(".attention-queue-counts small"),
      itemTitle: read(".attention-queue-item-main strong"),
      itemCopy: read(".attention-queue-item-main small"),
      itemMetaChipCount: document.querySelector(".attention-queue-item-meta")?.querySelectorAll("small").length ?? 0,
      itemTimeCount: document.querySelectorAll(".attention-queue-item-meta time").length,
      detailsButtonCount: document.querySelectorAll(".attention-queue-details").length,
    };
  });
  expect(attentionTypography.environmentTitle).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "20px" });
  expect(attentionTypography.progressTitle).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "20px" });
  expect(attentionTypography.progressPrimary).toEqual({ fontSize: "12px", fontWeight: "500", lineHeight: "17px" });
  expect(attentionTypography.progressSecondary).toEqual({ fontSize: "12px", fontWeight: "400", lineHeight: "17px" });
  expect(attentionTypography.progressIcon).toEqual({ width: 18, height: 18, strokeWidth: "2.4px" });
  expect(attentionTypography.attentionTitle).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "20px" });
  expect(attentionTypography.attentionCount).toEqual({ fontSize: "12px", fontWeight: "500", lineHeight: "17px" });
  expect(attentionTypography.countChip).toEqual({ fontSize: "11px", fontWeight: "600", lineHeight: "16px" });
  expect(attentionTypography.itemTitle).toEqual({ fontSize: "13px", fontWeight: "600", lineHeight: "18px" });
  expect(attentionTypography.itemCopy).toEqual({ fontSize: "12px", fontWeight: "400", lineHeight: "17px" });
  expect(attentionTypography.itemMetaChipCount).toBe(1);
  expect(attentionTypography.itemTimeCount).toBe(0);
  expect(attentionTypography.detailsButtonCount).toBe(0);
  const expandQueueIfNeeded = async () => {
    const hideDetails = page.getByRole("button", { name: "Hide details" });
    if (await hideDetails.isVisible().catch(() => false)) {
      await hideDetails.click();
    }
    await openChannelChatTools(page);
    await expect(attentionQueue.locator(".attention-queue-item").first()).toBeVisible();
  };
  const attentionQueueItemByTitle = (title: string) =>
    attentionQueue.locator(".attention-queue-item").filter({
      has: page.locator(".attention-queue-item-main strong").filter({ hasText: title }),
    });
  const blockedQueueItem = attentionQueueItemByTitle("Blocked timeline step");
  await blockedQueueItem.locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
  await expandQueueIfNeeded();
  await attentionQueueItemByTitle("Run run_failed").locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expandQueueIfNeeded();
  await attentionQueueItemByTitle("Approve shell command").locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Approval details");
  await expect(page.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expandQueueIfNeeded();
  await attentionQueueItemByTitle("Inspect workspace").locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");

  await selectSavedView("Blocked");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await selectSavedView("Pending approvals");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toHaveCount(0);
  await selectSavedView("Failed work");
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toHaveCount(0);
  await selectSavedView("Runtime");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await activityFilters.getByRole("button", { name: /Clear/ }).click();
  await openFilterPanel();

  await searchInput.fill("Timeline source");
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();
  await expect(activityFeed.getByText("Inspect workspace")).toHaveCount(0);
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("0");

  await searchInput.fill("Inspect the repo");
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);

  await searchInput.fill("run_failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();

  await searchInput.fill("Approve shell command");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toBeVisible();

  await searchInput.fill("Wait for runtime recovery");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();

  await searchInput.fill("task_failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();

  await searchInput.fill("");
  await openFilterPanel();
  await categoryChip("Messages").click();
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();
  await expect(activityFeed.getByText("Inspect workspace")).toHaveCount(0);
  await categoryChip("Runtime").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await activityFilters.getByRole("button", { name: /Clear/ }).click();
  await openFilterPanel();

  await attentionChip("Needs attention").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await attentionChip("Failed").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "failed" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toHaveCount(0);
  await attentionChip("Pending").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "failed" })).toHaveCount(0);
  await activityFilters.getByRole("button", { name: /Clear/ }).click();

  await searchInput.fill("definitely-not-present");
  await expect(page.getByText("No activity matches these filters")).toBeVisible();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await searchInput.fill("run_failed");
  await expandQueueIfNeeded();
  await expect(runEventBubble).toBeVisible();
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await expect(activityDetails).toContainText("Run run_failed");
  await expect(searchInput).toHaveValue("run_failed");
  await expect(attentionQueue.locator(".attention-queue-item")).toHaveCount(5);
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("run_failed");
  await expect(attentionQueue.locator(".attention-queue-item")).toHaveCount(5);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Saved view name");
    await dialog.accept("Run failures");
  });
  await activityFilters.getByRole("button", { name: "Save view" }).click();
  await expect(savedViewOption("Run failures")).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await openChannelChatTools(page);
  await expect(savedViewOption("Run failures")).toHaveCount(1);
  await selectSavedView("Run failures");
  await expect(searchInput).toHaveValue("run_failed");
  await openFilterPanel();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Rename saved view");
    await dialog.accept("Run problems");
  });
  await activityFilters.getByRole("button", { name: "Rename" }).click();
  await expect(savedViewOption("Run problems")).toHaveCount(1);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await openChannelChatTools(page);
  await expect(searchInput).toHaveValue("");
  await expect(savedViewOption("Run problems")).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await expect(savedViewOption("Run problems")).toHaveCount(1);
  await selectSavedView("Run problems");
  await openFilterPanel();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Delete saved view?");
    await dialog.accept();
  });
  await activityFilters.getByRole("button", { name: "Delete view" }).click();
  await expect(savedViewOption("Run problems")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await openChannelChatTools(page);
  await expect(searchInput).toHaveValue("");
  await expect(activityFeed.getByText("Other channel task leak").first()).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await expect(page.getByText("No activity matches these filters")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await expect(searchInput).toHaveValue("");
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();

  await page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Open task" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");

  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Open run" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" }).getByRole("button", { name: "Open approval" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Approval details");
  await expect(page.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" }).getByRole("button", { name: "Open context" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
});

test("channel activity triage actions create follow-up records and preserve local state", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_triage",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Timeline source message for triage",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_triage",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Triage workflow",
      objective: "Show blocked workflow step triage.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:05:00.000Z",
      updatedAt: "2026-05-25T00:06:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_triage",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_triage",
      position: 1,
      title: "Blocked triage step",
      prompt: "Wait for runtime recovery.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "blocked",
      blocker: "Runtime policy is waiting.",
      createdAt: "2026-05-25T00:06:00.000Z",
      updatedAt: "2026-05-25T00:07:00.000Z",
    },
  ];
  state.stateTransitions = [
    {
      id: "transition_triage_task",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_inspect",
      fromStatus: "todo",
      toStatus: "failed",
      event: "task_failed",
      actor: "runner",
      createdAt: "2026-05-25T00:03:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const activityDetails = page.getByLabel("Activity details");
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const workflowStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked triage step" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" });
  const messageBubble = page.locator(".message-bubble").filter({ hasText: "Timeline source message for triage" });
  const openTriageActions = async () => {
    const triageSection = activityDetails.locator(".activity-triage-section");
    await expect(triageSection).toBeVisible();
    if ((await triageSection.getAttribute("open")) === null) {
      await triageSection.locator("summary").click();
    }
  };

  await expect(messageBubble).toBeVisible();
  await expect(messageBubble.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);

  await openChannelChatTools(page);
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await expect(activityDetails).toContainText("Triage actions");
  await expect(activityDetails.getByLabel("Triage title")).toHaveCount(0);
  await openTriageActions();
  await expect(activityDetails.getByText("Choose a triage action to continue.")).toBeVisible();
  await activityDetails.getByRole("button", { name: "Create follow-up task" }).click();
  await activityDetails.getByLabel("Triage title").fill("Investigate failed run triage");
  state.failNextTaskCreate = true;
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect(activityDetails.getByRole("alert")).toContainText("Triage action failed");
  await expect(activityDetails.getByLabel("Triage title")).toHaveValue("Investigate failed run triage");
  await expect(activityDetails.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(activityDetails.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await activityDetails.getByRole("button", { name: "Retry" }).click();
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.title === "Investigate failed run triage")).toBe(true);
  await activityDetails.getByRole("button", { name: "Open in Tasks" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Investigate failed run triage");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create handoff" }).click();
  await activityDetails.getByLabel("Reason").fill("Escalate blocked triage step");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelHandoffs.some((handoff) => isRecord(handoff) && handoff.reason === "Escalate blocked triage step")).toBe(true);
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await activityDetails.getByRole("button", { name: "Open in Context" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
  await expect(page.getByRole("region", { name: "Channel inspector" })).toContainText("Escalate blocked triage step");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await approvalEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Record decision" }).click();
  await activityDetails.getByLabel("Triage title").fill("Decision: approval stays pending");
  await activityDetails.getByLabel("Decision text").fill("Keep the approval pending until the user reviews the shell command.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.title === "Decision: approval stays pending")).toBe(true);
  await activityDetails.getByRole("button", { name: "Open in Context" }).click();
  await expect(page.getByRole("region", { name: "Channel inspector" })).toContainText("Decision: approval stays pending");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  const activityFilters = channelEventFilters(page);
  const searchInput = activityFilters.getByPlaceholder("Search activity");
  const composer = page.getByPlaceholder("Message this channel or @ an AI teammate");
  const attentionQueue = page.getByLabel("Attention queue");
  await searchInput.fill("Blocked triage");
  await composer.fill("Composer draft survives triage");
  await expect(attentionQueue.locator(".attention-queue-item").first()).toBeVisible();
  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create context summary" }).click();
  await activityDetails.getByLabel("Summary").fill("Summary from Blocked triage step.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelContextSummaries.some((summary) => isRecord(summary) && summary.summary === "Summary from Blocked triage step.")).toBe(true);
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("Blocked triage");
  await expect(composer).toHaveValue("Composer draft survives triage");
  await expect(attentionQueue.locator(".attention-queue-item").first()).toBeVisible();
  const summaryBubble = page.locator(".message-bubble").filter({ hasText: "Context summary" }).filter({ hasText: "Summary from Blocked triage step" });
  await expect(summaryBubble).toBeVisible();
  const taskCount = state.tasks.length;
  await summaryBubble.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});

test("channel activity hides the attention queue when no items need attention", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.approvals = [];
  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "done", updatedAt: "2026-05-25T00:02:00.000Z" } : task,
  );
  state.runs = state.runs.map((run) => ({
    ...run,
    status: "succeeded",
    endedAt: "2026-05-25T00:02:00.000Z",
    updatedAt: "2026-05-25T00:02:00.000Z",
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Attention queue" }).locator(".toolbar-count")).toHaveCount(0);
  await expect(page.locator(".channel-attention-popover")).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});
