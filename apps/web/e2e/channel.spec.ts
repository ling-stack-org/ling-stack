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
  await expect(page.locator(".channel-left-drawer .sidebar-channel-group > .sidebar-row-shell.selected")).toContainText("Engineering");
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
    const branchTree = document.querySelector(".channel-work-thread-tree");
    const workbenchMain = document.querySelector(".task-workbench-main");
    const workbenchWindow = document.querySelector(".task-workbench-window");
    const workspace = document.querySelector(".workspace");
    const composer = document.querySelector(".channel-composer");
    const feed = document.querySelector(".message-feed");
    const emptyState = document.querySelector(".activity-shell .message-feed-empty-state");
    const selectedChannel = document.querySelector(".channel-left-drawer .sidebar-channel-group > .sidebar-row-shell.selected");
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
      rightWidth: Math.round(rightDrawer?.getBoundingClientRect().width ?? 0),
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
      branchTreeHeight: Math.round(branchTree?.getBoundingClientRect().height ?? 0),
      branchTreeText: branchTree?.textContent?.trim() ?? "",
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
  expect(expanded.columns.startsWith("272px ")).toBe(true);
  expect(expanded.leftWidth).toBe(272);
  expect(expanded.leftToolbarWidth).toBe(272);
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
  expect(expanded.rightWidth).toBe(340);
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
  expect(expanded.branchTreeText).toBe("");
  expect(expanded.branchTreeHeight).toBe(0);
  await expect(page.locator(".channel-work-thread-tree")).toHaveCount(0);
  await expect(page.locator(".channel-left-drawer .sidebar-branch-list")).toHaveCount(0);
  expect(expanded.feedHeight).toBeGreaterThan(240);
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
  expect(leftCollapsed.leftX).toBe(-224);
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
  expect(restored.columns.startsWith("272px ")).toBe(true);
  expect(restored.leftWidth).toBe(272);
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
  const engineering = drawer.locator(".sidebar-channel-group").filter({ hasText: "Engineering" }).locator(".sidebar-row-shell").first();
  const research = drawer.locator(".sidebar-channel-group").filter({ hasText: "Research" }).locator(".sidebar-row-shell").first();
  await expect(engineering.locator(".channel-mention")).toHaveCount(0);
  await expect(engineering.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator(".channel-mention")).toHaveCount(0);
  await expect(research.locator(".channel-unread")).toBeVisible();

  await research.locator(".sidebar-row-main").click();
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
  expect(spacing.attentionWidth).toBe(340);
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
  const currentManagement = page.getByLabel("Channel management");
  await expect(currentManagement.getByLabel("Preferred specialist")).toHaveValue("engineer");
  await expect(currentManagement.getByLabel("Ling reply")).toHaveCount(0);
  await currentManagement.getByRole("button", { name: "Save channel" }).click();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel).toBeVisible();
  await expect(createChannelPanel.getByLabel("Execution path")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Ling reply")).toHaveCount(0);
  await createChannelPanel.getByLabel("Name").fill("Release");
  await createChannelPanel.getByLabel("Status").selectOption("paused");
  await createChannelPanel.getByLabel("Preferred specialist").selectOption("designer");
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
  await expect(details.getByLabel("Preferred specialist")).toHaveValue("designer");
  await expect(details.getByLabel("Ling reply")).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Create channel" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Create default" })).toHaveCount(0);
  await details.getByLabel("Name").fill("Release QA");
  await details.getByRole("button", { name: "Save channel" }).click();
  await expect.poll(() => {
    const updated = state.channels.find((channel) => isRecord(channel) && channel.id === (isRecord(created) ? created.id : ""));
    return isRecord(updated) ? updated.name : "";
  }).toBe("Release QA");
});

test("channel reply routing mode is not exposed in ordinary settings", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "designer", roleKey: "designer", displayName: "Ling Designer" }),
  ];
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  const currentManagement = page.getByLabel("Channel management");
  await expect(currentManagement.getByLabel("Ling reply")).toHaveCount(0);
  await expect(currentManagement.getByText("Auto route")).toHaveCount(0);
  await expect(currentManagement.getByText("Ling Agent decides")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel.getByLabel("Ling reply")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Auto route")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Ling Agent decides")).toHaveCount(0);
  await createChannelPanel.getByLabel("Name").fill("Auto Route");
  await createChannelPanel.getByLabel("Preferred specialist").selectOption("designer");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();
  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Auto Route")).toBe(true);
});

test("multi-role channel messages create workflow proposals instead of AI replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer", autoReplyMode: "default_teammate" }
      : channel,
  );
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_architect",
      templateId: "architect",
      roleKey: "architect",
      displayName: "Architect",
      allowedTools: ["read", "grep"],
    }),
    createMockTeammate({
      id: "teammate_builtin_engineer",
      displayName: "Engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    }),
    createMockTeammate({
      id: "teammate_builtin_qa",
      templateId: "qa",
      roleKey: "qa",
      displayName: "QA",
      allowedTools: ["read", "grep", "find", "ls", "bash"],
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Architect 先拆，Engineer 实现，QA 验证，可以吗？");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.lastChannelMessageRequest?.requestAiReply).toBe(false);
  await expect.poll(() => state.channelExecutionProposals.length).toBe(1);
  await expect.poll(() => state.channelMessages.filter((message) => isRecord(message) && message.kind === "ai_reply").length).toBe(0);
  const proposal = page.getByLabel("Task confirmation");
  await expect(proposal).toContainText("Architect 先拆，Engineer 实现，QA 验证，可以吗？");
  await expect(proposal).toContainText("Engineer");
  await expect(proposal.locator(".channel-proposal-collaboration")).toContainText("Collaboration 3 records");
  await expect(proposal).toContainText("Non-direct multi-agent collaboration waits for confirmation");
  await expect(proposal).toContainText("Starting this task does not approve future runtime actions");
  await expect(proposal.getByRole("button", { name: "Authorize and start task" })).toBeVisible();
  await expect(page.getByText("AI teammate is preparing a reply...")).toHaveCount(0);
  await expect.poll(() => {
    const decision = state.channelIntentDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy].join("|") : "";
  }).toBe("workflow_proposal|accepted|deterministic");
});

test("task confirmation cards explain bounded tool permission and target", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] })];
  state.channelMessages = [
    {
      id: "msg_permission_confirmations",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "帮我创建 README、编辑 docs，再跑 pnpm test",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_permission_write",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_permission_confirmations",
      proposedByTeammateId: "ling_agent",
      title: "Create README.md",
      prompt: "Create /tmp/example/README.md.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["README.md is created."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Create the requested file." }],
      requiredTools: ["write"],
      riskSummary: "Need write permission for /tmp/example/README.md.",
      status: "draft",
      createdAt: "2026-05-25T00:10:01.000Z",
      updatedAt: "2026-05-25T00:10:01.000Z",
    },
    {
      id: "proposal_permission_edit",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_permission_confirmations",
      proposedByTeammateId: "ling_agent",
      title: "Edit docs/guide.md",
      prompt: "Update docs/guide.md with the new workflow note.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["docs/guide.md is updated."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Edit the requested file." }],
      requiredTools: ["edit"],
      riskSummary: "Need edit permission for docs/guide.md.",
      status: "draft",
      createdAt: "2026-05-25T00:10:02.000Z",
      updatedAt: "2026-05-25T00:10:02.000Z",
    },
    {
      id: "proposal_permission_bash",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_permission_confirmations",
      proposedByTeammateId: "ling_agent",
      title: "Run pnpm test",
      prompt: "Command requested by user: pnpm test",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Test command completes."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Run the requested command." }],
      requiredTools: ["bash"],
      riskSummary: "Need bash permission to run pnpm test.",
      status: "draft",
      createdAt: "2026-05-25T00:10:03.000Z",
      updatedAt: "2026-05-25T00:10:03.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  const confirmations = page.getByLabel("Task confirmation");
  await expect(confirmations).toHaveCount(3);
  const createCard = confirmations.filter({ hasText: "Create README.md" });
  await expect(createCard).toContainText("Need write permission to create /tmp/example/README.md for this task.");
  await expect(createCard).toContainText("Required tool");
  await expect(createCard).toContainText("write");
  await expect(createCard).toContainText("Target");
  await expect(createCard).toContainText("/tmp/example/README.md");
  await expect(createCard).toContainText("Executor");
  await expect(createCard).toContainText("Ling Agent");

  const editCard = confirmations.filter({ hasText: "Edit docs/guide.md" });
  await expect(editCard).toContainText("Need edit permission to update docs/guide.md for this task.");
  await expect(editCard).toContainText("edit");

  const commandCard = confirmations.filter({ hasText: "Run pnpm test" });
  await expect(commandCard).toContainText("Need bash permission to run pnpm test for this task.");
  await expect(commandCard).toContainText("bash");

  await expect(commandCard).toContainText("Starting this task does not approve future runtime actions");
  await expect(commandCard.getByRole("button", { name: "Authorize and start task" })).toBeVisible();
});

test("Ling Agent session acceptance matrix auto-starts executable messages", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("在 /tmp/example 下创建 README.md");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.lastChannelMessageRequest?.requestAiReply).toBe(false);
  await expect.poll(() => state.channelExecutionProposals.length).toBe(1);
  await expect.poll(() => state.channelWorkflows.length).toBe(1);
  await expect.poll(() => state.channelMessages.filter((message) => isRecord(message) && message.kind === "ai_reply").length).toBe(0);
  const feed = page.locator(".activity-shell");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const createWorkCell = feed.locator(".conversation-work-cell").filter({ hasText: "Create /tmp/example/README.md" });
  await expect(createWorkCell).toBeVisible();
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].status : undefined).toBe("accepted");
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].linkedWorkflowId : undefined).toBe(
    isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].id : undefined,
  );
  await expect(feed.getByText("AI teammate is preparing a reply...")).toHaveCount(0);

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("在 README.md 中添加一句测试语句");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.channelExecutionProposals.length).toBe(2);
  await expect.poll(() => state.channelWorkflows.length).toBe(2);
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const editWorkCell = feed.locator(".conversation-work-cell").filter({ hasText: "Edit /tmp/example/README.md" });
  await expect(editWorkCell).toBeVisible();
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].status : undefined).toBe("accepted");
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].linkedWorkflowId : undefined).toBe(
    isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].id : undefined,
  );
  await expect.poll(() => {
    const decision = state.channelIntentDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy].join("|") : "";
  }).toBe("direct_workflow|accepted|deterministic");
});

test("Ling Agent session keeps ordinary questions on chat routing", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer", autoReplyMode: "default_teammate" }
      : channel,
  );
  state.aiTeammates = [createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Engineer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("这个 workspace 里面都有谁？");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.channelExecutionProposals.length).toBe(0);
  await expect.poll(() => state.channelMessageRouteDecisions.length).toBe(1);
  await expect.poll(() => {
    const decision = state.channelMessageRouteDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy, decision.selectedTeammateId].join("|") : "";
  }).toBe("reply|accepted|deterministic|teammate_builtin_engineer");
  const feed = page.locator(".activity-shell");
  await expect(feed.getByText("收到，我会按频道上下文推进。")).toBeVisible();
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
});

test("ordinary channel feed hides routing and intent decision internals", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", allowedTools: ["read", "grep", "find", "ls", "edit", "write"] })];
  state.channelMessages = [
    {
      id: "msg_suppressed_greeting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "晚上好",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
    {
      id: "msg_direct_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "在 README.md 中添加一句测试语句",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:11:00.000Z",
      updatedAt: "2026-05-25T00:11:00.000Z",
    },
  ];
  state.channelMessageRouteDecisions = [
    {
      schemaVersion: 1,
      id: "route_suppressed_greeting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_suppressed_greeting",
      mode: "auto_route",
      action: "no_reply",
      reason: "Mock suppressed greeting.",
      alternativesConsidered: [],
      status: "suppressed",
      createdBy: "model",
      createdAt: "2026-05-25T00:10:00.500Z",
      updatedAt: "2026-05-25T00:10:00.500Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_direct_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_direct_workflow",
      proposedByTeammateId: "ling_agent",
      title: "Edit README.md",
      prompt: "Edit README.md with one test sentence.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["README.md is updated."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Edit the requested file." }],
      requiredTools: ["edit"],
      riskSummary: "Need edit permission for README.md.",
      responseLanguage: "zh-CN",
      status: "draft",
      createdAt: "2026-05-25T00:11:01.000Z",
      updatedAt: "2026-05-25T00:11:01.000Z",
    },
  ];
  state.channelIntentDecisions = [
    {
      schemaVersion: 1,
      id: "intent_direct_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_direct_workflow",
      action: "direct_workflow",
      proposalId: "proposal_direct_workflow",
      reason: "Direct workflow proposal created by mock intent selector.",
      status: "accepted",
      createdBy: "deterministic",
      createdAt: "2026-05-25T00:11:00.500Z",
      updatedAt: "2026-05-25T00:11:00.500Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  const feed = page.locator(".activity-shell");
  await expect(feed.getByText("晚上好")).toBeVisible();
  await expect(feed.locator(".channel-execution-proposal").filter({ hasText: "Edit README.md" })).toBeVisible();
  await expect(feed.getByText("未自动回复")).toHaveCount(0);
  await expect(feed.getByText("为什么没回复")).toHaveCount(0);
  await expect(feed.getByText("Ling 未回复")).toHaveCount(0);
  await expect(feed.getByText("Ling did not reply")).toHaveCount(0);
  await expect(feed.getByText("Why no reply?")).toHaveCount(0);
  await expect(feed.getByText("直接工作流提案")).toHaveCount(0);
  await expect(feed.getByText("Direct workflow proposal")).toHaveCount(0);
  await expect(feed.getByText("为什么这样处理")).toHaveCount(0);
  await expect(feed.getByText("Why this handling?")).toHaveCount(0);
  expect(state.channelMessageRouteDecisions).toHaveLength(1);
  expect(state.channelIntentDecisions).toHaveLength(1);
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

test("channel message feed renders AI teammate avatar images", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      avatarImageAttachmentId: "tpatt_designer_avatar",
    }),
  ];
  state.teammatePrivateAttachments = [
    {
      id: "tpatt_designer_avatar",
      workspaceId: "workspace_default",
      teammateId: "teammate_builtin_designer",
      scope: "teammate_profile_avatar",
      kind: "image",
      fileName: "designer.png",
      contentType: "image/png",
      sizeBytes: 67,
      path: "teammates/teammate_builtin_designer/avatar/mock",
      createdAt: "2026-06-04T00:11:00.000Z",
    },
  ];
  state.teammateChannelMemberships = [
    {
      teammateId: "teammate_builtin_designer",
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_designer_avatar_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_designer",
      body: "Designer reply with profile avatar.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:01.000Z",
      updatedAt: "2026-05-25T00:18:01.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const designerReply = page.getByLabel("Channel message feed").locator(".channel-message-row").filter({ hasText: "Designer reply with profile avatar." });
  await expect(designerReply).toBeVisible();
  await expect(designerReply.locator(".teammate-avatar-image")).toBeVisible();
  await expect(designerReply.locator(".avatar-initial")).toHaveCount(0);
  await expect(designerReply.locator(".teammate-avatar-image")).toHaveAttribute("src", /\/attachments\/tpatt_designer_avatar\/content/);
});

test("channel settings manage workspace binding and header badge", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.locator(".channel-workspace-badge")).toContainText("Local");
  await expect(page.locator(".channel-workspace-badge")).toHaveAttribute("title", "/tmp/ling-stack-workspace");

  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  const details = page.getByLabel("Channel management");
  const workspaceControl = details.getByLabel("Channel workspace");
  await expect(workspaceControl).toContainText("Local");
  await workspaceControl.getByRole("button", { name: "Create worktree" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.mode : "";
  }).toBe("managed_worktree");
  await expect(workspaceControl).toContainText("Worktree");
  await expect(page.locator(".channel-workspace-badge")).toContainText("Worktree");

  await workspaceControl.getByPlaceholder("External workspace path").fill("/tmp/external-channel-workspace");
  await workspaceControl.getByRole("button", { name: "Hand off to External" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.executionPath : "";
  }).toBe("/tmp/external-channel-workspace");
  await expect(workspaceControl).toContainText("External");
  await expect(page.locator(".channel-workspace-badge")).toContainText("External");

  await workspaceControl.getByRole("button", { name: "Hand off to Local" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.mode : "";
  }).toBe("local");
  await expect(workspaceControl).toContainText("Local");
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
  await composerInput.type("Eng");
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

test("channel composer sends workspace file refs as native message payload", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await composerInput.fill("Please inspect apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await expect(page.getByLabel("Pending message assets")).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.lastChannelMessageRequest?.fileRefs).toEqual([
    {
      path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      label: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      source: "composer",
    },
  ]);
  await expect(page.getByLabel("Workspace file references").getByText("apps/web/src/features/workspace/WorkspaceClientView.tsx")).toBeVisible();
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
});

test("channel screenshot request shows materialization clarify reply instead of hidden routing", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.locator("input[type=file]").setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await composerInput.fill("Please fix the UI from this screenshot");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("Please fix the UI from this screenshot")).toBeVisible();
  await expect(channelFeed.getByText("could not read image content from screenshot.png")).toBeVisible();
  await expect(page.getByText("routeDecision")).toHaveCount(0);
  await expect(page.getByText("workflow_proposal")).toHaveCount(0);
  await expect(page.getByText("image content is not available")).toHaveCount(0);
  await expect(page.getByText("metadata_only")).toHaveCount(0);
  await expect(page.getByText("unsupported")).toHaveCount(0);
  await expect(page.getByText("extractor")).toHaveCount(0);
  await expect(page.getByText("SSRF")).toHaveCount(0);
  await expect.poll(() => state.channelIntentDecisions.some((decision) =>
    isRecord(decision) && decision.action === "clarify" && /Mock attachment content is not materialized/.test(String(decision.reason))
  )).toBe(true);
});

test("channel local link request shows natural clarify copy without debug vocabulary", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await composerInput.fill("Please summarize this link http://127.0.0.1/private");
  await expect(page.getByText("Private network previews are blocked.")).toBeVisible({ timeout: 3_000 });
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("Please summarize this link http://127.0.0.1/private")).toBeVisible();
  await expect(channelFeed.getByText("will not open local/private links automatically")).toBeVisible();
  await expect(channelFeed.getByText("Paste the content")).toBeVisible();
  await expect(page.getByText("body extraction is blocked")).toHaveCount(0);
  await expect(page.getByText("metadata_only")).toHaveCount(0);
  await expect(page.getByText("extractor")).toHaveCount(0);
  await expect(page.getByText("SSRF")).toHaveCount(0);
  await expect.poll(() => state.channelIntentDecisions.some((decision) =>
    isRecord(decision) && decision.action === "clarify" && /Mock link body materialization is blocked/.test(String(decision.reason))
  )).toBe(true);
});

test("channel execution proposal confirms into a multi-step workflow", async ({ page }) => {
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
    createMockTeammate({
      id: "teammate_builtin_qa",
      templateId: "qa",
      roleKey: "qa",
      displayName: "Ling QA",
      description: "Validates regression checks.",
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
    {
      teammateId: "teammate_builtin_designer",
      channelId: "channel_engineering",
      isDefault: false,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
    {
      teammateId: "teammate_builtin_qa",
      channelId: "channel_engineering",
      isDefault: false,
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
      prompt: "The user message looks like a coordinated workflow request. Original request: 所有的队友，都回复我一下 Proposed collaboration: 1. QA: Validate the expected behavior and regression checks. 2. 产品策略: Clarify product scope and acceptance before execution. 3. Security: Review trust boundaries and approval-sensitive publication steps. Non-direct multi-agent collaboration waits for user confirmation before starting.",
      assigneeTeammateId: "teammate_builtin_engineer",
      acceptanceCriteria: [
        "Task is created only after confirmation, with every visible long acceptance criterion wrapping inside the proposal card.",
        "Run uses the assignee provider and keeps selector, handoff, run, approval, and artifact evidence expandable.",
      ],
      collaborationSteps: [
        { teammateId: "teammate_builtin_engineer", action: "coordinated", summary: "Summarized discussion into one execution proposal. Preserved approval-sensitive context for the implementation path." },
        { teammateId: "teammate_builtin_designer", action: "reviewed", summary: "Checked visual hierarchy before execution. Verified long collaboration summaries stay inside the card." },
      ],
      requiredTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      riskSummary: "Provider must be ready before execution and approval-sensitive publication steps must stay explicitly gated.",
      status: "draft",
      createdAt: "2026-05-25T00:18:02.000Z",
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const proposal = page.getByLabel("Task confirmation");
  await expect(proposal).toContainText("Refine channel workspace copy");
  await expect(proposal).toContainText("Ling is shaping the task");
  await expect(proposal).toContainText("Goal");
  await expect(proposal).toContainText("Participants");
  await expect(proposal).toContainText("Boundary");
  await expect(proposal).toContainText("Ling Engineer");
  await expect(proposal).toContainText("Ling Designer");
  const collaboration = proposal.locator(".channel-proposal-collaboration");
  await expect(collaboration).not.toHaveAttribute("open", /.+/);
  await expect(collaboration.locator("summary")).toContainText("Collaboration 2 records");
  await expect(collaboration.locator("summary")).toContainText("Ling Engineer Summarized discussion into one execution proposal.");
  await expect(collaboration.locator("summary")).toContainText("Ling Designer Checked visual hierarchy before execution.");
  const overflowingProposalSections = await proposal.evaluate((element) => {
    const proposalRect = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll(":scope > p, .channel-proposal-meta, .channel-proposal-criteria, .channel-proposal-risk, .channel-proposal-collaboration summary"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left < proposalRect.left - 1 || rect.right > proposalRect.right + 1;
      })
      .map((node) => node.className || node.tagName.toLowerCase());
  });
  expect(overflowingProposalSections).toEqual([]);
  await expect(collaboration.locator("li").first()).not.toBeVisible();
  await collaboration.locator("summary").click();
  await expect(collaboration.locator("li").first()).toBeVisible();
  await expect(collaboration).toContainText("Coordinated");
  await expect(collaboration).toContainText("Reviewed");
  await proposal.getByRole("button", { name: "Edit" }).click();
  const editForm = proposal.locator(".channel-proposal-edit-form");
  await editForm.getByLabel("Scope").fill("Refine the channel workspace copy, then run focused QA checks.");
  const editSteps = editForm.locator(".channel-proposal-edit-step");
  await editSteps.nth(1).locator("select").first().selectOption("teammate_builtin_qa");
  await editSteps.nth(1).locator("textarea").fill("Run focused regression checks before execution.");
  await proposal.getByRole("button", { name: "Save" }).click();
  await expect(editForm).toHaveCount(0);
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_1");
    if (!isRecord(updated) || !Array.isArray(updated.collaborationSteps)) {
      return "";
    }
    const secondStep = updated.collaborationSteps[1];
    return isRecord(secondStep) ? `${updated.prompt}|${secondStep.teammateId}|${secondStep.summary}` : "";
  }).toBe("Refine the channel workspace copy, then run focused QA checks.|teammate_builtin_qa|Run focused regression checks before execution.");
  await proposal.getByRole("button", { name: "Authorize and start task" }).click();

  await expect.poll(() => {
    const workflow = state.channelWorkflows.find((item) => isRecord(item) && item.title === "Refine channel workspace copy");
    return isRecord(workflow) ? workflow.status : undefined;
  }).toBe("running");
  await expect.poll(() => state.channelWorkflowSteps.filter((item) => isRecord(item) && item.workflowId === "workflow_1").length).toBe(2);
  await expect.poll(() => {
    const steps = state.channelWorkflowSteps.filter((item) => isRecord(item) && item.workflowId === "workflow_1");
    return steps.map((step) => isRecord(step) ? step.toParticipantId : "").join("|");
  }).toBe("teammate_builtin_engineer|teammate_builtin_qa");
  await expect.poll(() => {
    const secondStep = state.channelWorkflowSteps.find((item) => isRecord(item) && item.workflowId === "workflow_1" && item.position === 2);
    return isRecord(secondStep) && isRecord(secondStep.metadata) && Array.isArray(secondStep.metadata.dependsOnStepIds)
      ? secondStep.metadata.dependsOnStepIds.join(",")
      : "";
  }).toBe("workflow_step_1");
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_1");
    return isRecord(updated) ? [updated.status, updated.linkedWorkflowId].join("|") : "";
  }).toBe("accepted|workflow_1");
  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const workCell = feed.locator(".conversation-work-cell").filter({ hasText: "Refine channel workspace copy" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Collaboration in progress");
  await expect(workCell.getByLabel("Work summary")).toContainText("Mode");
  await expect(workCell.getByRole("button", { name: "Open diagnostics" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toBeVisible();

  await openChannelChatTools(page);
  const acceptedProposal = feed.getByLabel("Task confirmation").filter({ hasText: "Refine channel workspace copy" });
  await expect(acceptedProposal).toBeVisible();
  await expect(acceptedProposal.getByRole("button", { name: "Open workflow" })).toBeVisible();
});

test("completed workflow hides accepted proposal and leaves final result in default chat", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const completedAt = "2026-05-25T00:31:00.000Z";
  const workflowRun = {
    ...state.runs[0],
    id: "run_completed_workflow",
    status: "succeeded",
    threadId: "thread_completed_workflow_step",
    taskId: "task_completed_workflow",
    workflowStepId: "workflow_step_completed",
    taskSnapshot: {
      id: "task_completed_workflow",
      title: "Create README.md",
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      workflowStepId: "workflow_step_completed",
      task: {
        id: "task_completed_workflow",
        title: "Create README.md",
        prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_completed_workflow.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T00:30:00.000Z",
    startedAt: "2026-05-25T00:30:05.000Z",
    endedAt: completedAt,
    updatedAt: completedAt,
  };
  state.channelMessages = [
    {
      id: "msg_create_readme",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "/Users/tianxiao/ling-stack-test 下面，帮我创建一个 README.md",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:29:00.000Z",
      updatedAt: "2026-05-25T00:29:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_completed_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_create_readme",
      proposedByTeammateId: "docs",
      title: "Create /Users/tianxiao/ling-stack-test/README.md",
      prompt: "Create the requested README file with the declared file tool scope.",
      assigneeTeammateId: "docs",
      acceptanceCriteria: ["Target file is created."],
      collaborationSteps: [{ teammateId: "docs", action: "coordinated", summary: "Created the requested file." }],
      requiredTools: ["write"],
      status: "accepted",
      linkedWorkflowId: "workflow_completed",
      createdAt: "2026-05-25T00:29:01.000Z",
      updatedAt: "2026-05-25T00:29:05.000Z",
    },
  ];
  state.tasks = [
    {
      id: "task_completed_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
      status: "done",
      currentRunId: workflowRun.id,
      createdAt: "2026-05-25T00:30:00.000Z",
      updatedAt: completedAt,
    },
  ];
  state.runs = [workflowRun];
  state.channelWorkflows = [
    {
      id: "workflow_completed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create /Users/tianxiao/ling-stack-test/README.md",
      objective: "Create the requested README file with the declared file tool scope.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:29:05.000Z",
      updatedAt: completedAt,
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_completed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_completed",
      taskId: "task_completed_workflow",
      runId: workflowRun.id,
      position: 1,
      title: "Docs: Create README.md",
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
      toParticipantId: "docs",
      toParticipantLabel: "Docs",
      status: "succeeded",
      resultSummary: "Created the requested README file.",
      createdAt: "2026-05-25T00:29:05.000Z",
      updatedAt: completedAt,
    },
  ];
  state.artifactsByRun[workflowRun.id] = [
    {
      id: "artifact_completed_readme",
      runId: workflowRun.id,
      type: "file",
      path: "/Users/tianxiao/ling-stack-test/README.md",
      title: "README.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 0,
      createdAt: completedAt,
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const workCell = feed.locator(".conversation-work-cell").filter({ hasText: "Create /Users/tianxiao/ling-stack-test/README.md" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Collaboration complete");
  await expect(workCell).toContainText("Collaboration complete: Created the requested README file.");
  await expect(workCell).toContainText("Final Ling report");
  await expect(workCell).toContainText("Outcome");
  await expect(workCell).toContainText("Changed");
  await expect(workCell).toContainText("Changed: README.md. Evidence recorded: 1.");
  await expect(workCell).toContainText("Validated");
  await expect(workCell).toContainText("No validation commands recorded.");
  await expect(workCell).toContainText("Blockers / risks");
  await expect(workCell).toContainText("No blockers or risks recorded.");
  await expect(workCell).toContainText("Next action");
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open diagnostics" })).toHaveCount(0);
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);

  await openChannelChatTools(page);
  await expect(feed.getByLabel("Task confirmation")).toContainText("Create /Users/tianxiao/ling-stack-test/README.md");
});

test("blocked workflow hides accepted proposal and leaves blocker report in default chat", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const blockedAt = "2026-05-25T00:41:00.000Z";
  state.channelMessages = [
    {
      id: "msg_blocked_readme",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "/Users/tianxiao/ling-stack-test 下面，帮我创建一个 README.md",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:39:00.000Z",
      updatedAt: "2026-05-25T00:39:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_blocked_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_blocked_readme",
      proposedByTeammateId: "ling_agent",
      title: "Create README.md",
      prompt: "Create the requested README file.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Target file is created."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Create the requested file." }],
      requiredTools: ["write"],
      status: "accepted",
      linkedWorkflowId: "workflow_blocked",
      createdAt: "2026-05-25T00:39:01.000Z",
      updatedAt: "2026-05-25T00:39:05.000Z",
    },
  ];
  state.runs = [];
  state.tasks = [];
  state.channelWorkflows = [
    {
      id: "workflow_blocked",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      objective: "Create the requested README file.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:39:05.000Z",
      updatedAt: blockedAt,
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_blocked_readme",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_blocked",
      position: 1,
      title: "Ling Agent: Create README.md",
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "blocked",
      blocker: "Write permission was not granted.",
      createdAt: "2026-05-25T00:39:05.000Z",
      updatedAt: blockedAt,
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const workCell = feed.locator(".conversation-work-cell").filter({ hasText: "Create README.md" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Collaboration blocked");
  await expect(workCell).toContainText("Collaboration blocked: Write permission was not granted.");
  await expect(workCell).toContainText("Final Ling report");
  await expect(workCell).toContainText("Blockers / risks");
  await expect(workCell).toContainText("Blocker: Write permission was not granted.");
  await expect(workCell).toContainText("Next action");
  await expect(workCell).toContainText("Resolve blocker");
  await expect(workCell).toContainText("No changed files recorded. Evidence recorded: 0.");
  await expect(workCell).toContainText("No validation commands recorded.");

  await openChannelChatTools(page);
  await expect(feed.getByLabel("Task confirmation")).toContainText("Create README.md");
});

test("right progress panel renders workflow collaboration task cards", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelWorkflows = [
    {
      id: "workflow_running_ui",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Ship workflow UI",
      objective: "Render collaboration task cards in the right progress panel.",
      status: "running",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:45:00.000Z",
      updatedAt: "2026-05-25T00:47:00.000Z",
    },
    {
      id: "workflow_blocked_ui",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      objective: "Create the requested README file.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:44:00.000Z",
      updatedAt: "2026-05-25T00:48:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_design_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 1,
      title: "Design right panel card",
      prompt: "Design the right panel task card.",
      toParticipantId: "designer",
      toParticipantLabel: "Designer",
      status: "succeeded",
      resultSummary: "Card shape accepted.",
      metadata: {
        branchGroupId: "branch_design",
      },
      createdAt: "2026-05-25T00:45:00.000Z",
      updatedAt: "2026-05-25T00:46:00.000Z",
    },
    {
      id: "workflow_step_engineer_active",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 2,
      title: "Implement card UI",
      prompt: "Implement the collaboration card UI.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "running",
      metadata: {
        branchGroupId: "branch_engineer",
      },
      createdAt: "2026-05-25T00:46:00.000Z",
      updatedAt: "2026-05-25T00:47:00.000Z",
    },
    {
      id: "workflow_step_qa_waiting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 3,
      title: "Validate progress panel",
      prompt: "Validate the right panel task card.",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "queued",
      metadata: {
        branchGroupId: "branch_qa",
      },
      createdAt: "2026-05-25T00:47:00.000Z",
      updatedAt: "2026-05-25T00:47:00.000Z",
    },
    {
      id: "workflow_step_blocked_ui",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_blocked_ui",
      position: 1,
      title: "Ling Agent: Create README.md",
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "blocked",
      blocker: "Write permission was not granted.",
      createdAt: "2026-05-25T00:44:00.000Z",
      updatedAt: "2026-05-25T00:48:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  const feed = page.getByLabel("Channel message feed");
  const feedWorkCell = feed.locator(".conversation-work-cell").filter({ hasText: "Ship workflow UI" });
  await expect(feedWorkCell).toContainText("Parallel branches");
  await expect(feedWorkCell).toContainText("Engineer branch");
  await expect(feedWorkCell).toContainText("QA branch");
  await expect(feedWorkCell).not.toContainText("branch_engineer");
  const engineerBranch = feedWorkCell.locator(".conversation-work-cell-branch").filter({ hasText: "Engineer branch" });
  await expect(engineerBranch.locator(".conversation-work-cell-branch-detail")).toHaveCount(0);
  await engineerBranch.locator(".conversation-work-cell-branch-head").click();
  await expect(engineerBranch.locator(".conversation-work-cell-branch-detail")).toContainText("Engineer: Implement card UI");
  await expect(engineerBranch.locator(".conversation-work-cell-branch-toggle")).toContainText("Collapse branch");

  await openChannelTasksTab(page);

  const panel = page.locator(".channel-side-panel");
  const cards = panel.locator(".collaboration-task-card");
  await expect(cards).toHaveCount(2);

  const blockedCard = cards.filter({ hasText: "Create README.md" });
  await expect(blockedCard).toContainText("Blocked");
  await expect(blockedCard).toContainText("Write permission was not granted.");
  await expect(blockedCard).toContainText("Ling Agent: Create README.md");
  await expect(blockedCard).not.toContainText("workflow_blocked_ui");

  const runningCard = cards.filter({ hasText: "Ship workflow UI" });
  await expect(runningCard).toContainText("Running");
  await expect(runningCard).toContainText("Parallel");
  await expect(runningCard).toContainText("Owner: Engineer");
  await expect(runningCard).toContainText("Engineer branch");
  await expect(runningCard).toContainText("QA branch");
  await expect(runningCard).not.toContainText("branch_engineer");
  await expect(runningCard).not.toContainText("workflow_running_ui");

  await runningCard.click();
  await expect(panel).toContainText("Workflow evidence");
  const evidenceWorkCell = panel.locator(".conversation-work-cell");
  await expect(evidenceWorkCell).toContainText("Ship workflow UI");
  await expect(evidenceWorkCell).toContainText("Parallel branches");
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
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
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

test("channel message feed stays pinned while AI reply text streams", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "auto_route";
  }
  state.channelMessages = Array.from({ length: 36 }, (_, index) => ({
    id: `msg_stream_scroll_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: `Streaming scroll seed message ${index + 1}.`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 4, 25, 1, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 4, 25, 1, index, 0)).toISOString(),
  }));
  state.channelAiReplyBody = Array.from({ length: 40 }, (_, index) => `Auto-scroll proof paragraph ${index + 1}.`).join("\n\n");
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");

  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Who owns the streaming scroll follow-up?");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() =>
    state.channelMessages.some((message) =>
      isRecord(message) && typeof message.body === "string" && message.body.includes("Auto-scroll proof paragraph 40.")
    )
  ).toBe(true);
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
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
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
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

test("channel composer moves sent messages into the feed while routing is pending", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "auto_route";
  }
  state.channelMessageDelayMs = 1_000;
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");

  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  const channelFeed = page.getByLabel("Channel message feed");
  await composerInput.fill("Who owns the release checklist?");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect(composerInput).toHaveValue("");
  await expect(channelFeed.getByText("Who owns the release checklist?")).toBeVisible();
  await expect(channelFeed.getByText("Thinking...")).toBeVisible();
  await expect(channelFeed.getByText("收到，我会按频道上下文推进。")).toBeVisible({ timeout: 3_000 });
  await expect(channelFeed.getByText("Thinking...")).toHaveCount(0);
  await expect(channelFeed.getByText("AI teammate is replying...")).toHaveCount(0);
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

test("thread-backed runs render as collapsed conversation work cells", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.threadId = "thread_inspect";
  run.status = "succeeded";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-25T00:20:00.000Z";
  run.endedAt = "2026-05-25T00:22:00.000Z";
  run.updatedAt = "2026-05-25T00:22:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect" ? { ...task, status: "done", updatedAt: run.updatedAt } : task);
  state.approvals = [];
  state.artifactsByRun[run.id] = [
    {
      id: "artifact_thread_diff",
      runId: run.id,
      type: "diff",
      path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      title: "WorkspaceClientView.tsx",
      contentType: "text/x-diff; charset=utf-8",
      sizeBytes: 512,
      createdAt: "2026-05-25T00:21:00.000Z",
    },
  ];
  state.executionActions = [
    {
      id: "execution_action_thread_ui",
      workspaceId: "workspace_default",
      threadId: "thread_inspect",
      runId: run.id,
      actionType: "edit",
      risk: "medium",
      status: "succeeded",
      title: "Render conversation work cell",
      summary: "Conversation work cell was rendered from thread-backed run data.",
      targetRefs: [{ type: "file", path: "apps/web/src/features/workspace/WorkspaceClientView.tsx" }],
      previewArtifactIds: [],
      resultArtifactIds: ["artifact_thread_diff"],
      createdAt: "2026-05-25T00:20:30.000Z",
      updatedAt: "2026-05-25T00:22:00.000Z",
      executedAt: "2026-05-25T00:21:30.000Z",
    },
  ];
  const threadEvidenceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/threads/thread_inspect/evidence")) {
      threadEvidenceRequests.push(request.url());
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");

  const workCell = page.getByLabel("Channel message feed").locator(".conversation-work-cell").filter({ hasText: "Inspect workspace" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Task completed");
  await expect(workCell).toContainText("Completed 1 attempts with 1 evidence items.");
  await expect(workCell).toContainText("Attempts");
  await expect(workCell.locator(".conversation-work-cell-group")).toHaveCount(0);
  await expect(workCell).not.toContainText(".ling-stack/sessions/run_failed.jsonl");
  expect(threadEvidenceRequests).toHaveLength(0);

  await workCell.getByRole("button", { name: "Show details" }).click();
  await expect(workCell.getByLabel("Changed")).toContainText("WorkspaceClientView.tsx");
  await expect(workCell.getByLabel("Checked work")).toContainText("succeeded");
  await expect(workCell.getByRole("region", { name: "Evidence" })).toContainText("diff");
  await expect(workCell.locator(".conversation-work-cell-group.attention")).toHaveCount(0);
  await expect(workCell).not.toContainText("No items recorded");
  await expect(workCell.getByRole("link", { name: /WorkspaceClientView\.tsx/ })).toHaveAttribute("href", /\/artifacts\/artifact_thread_diff\/content/);
  expect(threadEvidenceRequests).toHaveLength(1);

  await workCell.getByRole("button", { name: "Hide details" }).click();
  await workCell.getByRole("button", { name: "Show details" }).click();
  await expect(workCell.getByLabel("Changed")).toContainText("WorkspaceClientView.tsx");
  expect(threadEvidenceRequests).toHaveLength(1);

  await workCell.getByRole("button", { name: "Open diagnostics" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");
});

test("durable Ling turns drive conversation work cell title, status, and attempts", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const firstAttempt = {
    ...state.runs[0],
    threadId: "thread_durable_turn",
    status: "failed",
    startedAt: "2026-05-25T00:10:00.000Z",
    endedAt: "2026-05-25T00:11:00.000Z",
    updatedAt: "2026-05-25T00:11:00.000Z",
    errorMessage: "First attempt failed before retry.",
  };
  const secondAttempt = {
    ...firstAttempt,
    id: "run_durable_retry",
    status: "succeeded",
    errorMessage: undefined,
    eventLogPath: ".ling-stack/sessions/run_durable_retry.jsonl",
    createdAt: "2026-05-25T00:12:00.000Z",
    startedAt: "2026-05-25T00:12:30.000Z",
    endedAt: "2026-05-25T00:14:00.000Z",
    updatedAt: "2026-05-25T00:14:00.000Z",
  };
  state.runs = [secondAttempt, firstAttempt];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "done", currentRunId: secondAttempt.id, updatedAt: secondAttempt.updatedAt }
    : task);
  state.turns = [
    {
      id: "turn_durable_inspect",
      workspaceId: "workspace_default",
      threadId: "thread_durable_turn",
      kind: "initial_request",
      status: "succeeded",
      title: "Durable inspect turn",
      userInstruction: "Inspect the repo and report next steps.",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      activeRunId: undefined,
      lastRunId: secondAttempt.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:14:00.000Z",
      completedAt: "2026-05-25T00:14:00.000Z",
    },
  ];
  state.turnRunLinks = [
    {
      turnId: "turn_durable_inspect",
      runId: firstAttempt.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: "2026-05-25T00:10:00.000Z",
    },
    {
      turnId: "turn_durable_inspect",
      runId: secondAttempt.id,
      attemptNumber: 2,
      role: "retry",
      createdAt: "2026-05-25T00:12:00.000Z",
    },
  ];
  state.artifactsByRun[secondAttempt.id] = [
    {
      id: "artifact_durable_retry_diff",
      runId: secondAttempt.id,
      type: "diff",
      path: "packages/core/src/storage/sqlite-run-store.ts",
      title: "sqlite-run-store.ts",
      contentType: "text/x-diff; charset=utf-8",
      sizeBytes: 1024,
      createdAt: "2026-05-25T00:13:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(".conversation-work-cell").filter({ hasText: "Durable inspect turn" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Task completed");
  await expect(workCell).toContainText("Completed 2 attempts with 1 evidence items.");
  await expect(workCell.getByLabel("Work summary")).toContainText("Attempts");
  await expect(workCell.getByLabel("Work summary")).toContainText("2");
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);

  await workCell.getByRole("button", { name: "Show details" }).click();
  await expect(workCell.getByLabel("Checked work")).toContainText("failed");
  await expect(workCell.getByLabel("Checked work")).toContainText("succeeded");
  await expect(workCell.getByRole("region", { name: "Evidence" })).toContainText("diff");
});

test("conversation work cell falls back when Ling turn loading fails", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.threadId = "thread_turn_failure";
  run.status = "succeeded";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-25T00:20:00.000Z";
  run.endedAt = "2026-05-25T00:22:00.000Z";
  run.updatedAt = "2026-05-25T00:22:00.000Z";
  state.failThreadTurnsForThreadIds = ["thread_turn_failure"];
  await mockDaemon(page, state);
  await page.goto("/");

  const workCell = page.getByLabel("Channel message feed").locator(".conversation-work-cell").filter({ hasText: "Inspect workspace" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Completed 1 attempts with 0 evidence items.");
});

test("active conversation work cell renders sparse rows while runtime approvals stay in composer overlay", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const run = state.runs[0];
  run.threadId = "thread_active_approval";
  run.status = "waiting_for_approval";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-22T00:00:30.000Z";
  run.updatedAt = "2026-05-22T00:01:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  await mockDaemon(page, state);
  await page.goto("/");

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(".conversation-work-cell").filter({ hasText: "Inspect workspace" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Task waiting for approval");
  await expect(workCell).toContainText("Waiting for 1 approvals before continuing.");
  await expect(workCell.getByLabel("Active work stream")).toContainText("Waiting for approval");
  await expect(workCell.getByLabel("Active work stream")).toContainText("Approve shell command");
  await expect(feed.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(feed.getByRole("button", { name: "Deny" })).toHaveCount(0);

  const composer = page.getByLabel("Channel composer");
  const overlay = composer.getByLabel("Composer approval overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Runtime approval needed");
  await expect(overlay).toContainText("Highest risk: medium");
  await expect(overlay).toContainText("Approve shell command");
  await expect(feed.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await overlay.getByRole("button", { name: "Approve" }).click();
  await expect(composer.getByLabel("Composer approval overlay")).toHaveCount(0);
  await expect(composer).not.toContainText("Approve shell command");
  expect(state.approvals.find((approval) => isRecord(approval) && approval.id === "approval_1")?.status).toBe("approved");
  expect(state.approvalPolicy.toolDecisions.bash).toBe("ask");
  expect(state.approvalPolicy.toolDecisions.write).toBe("ask");
});

test("Ling Agent session active run guidance queues follow-up from composer and stops the run", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.status = "running";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-22T00:00:30.000Z";
  run.updatedAt = "2026-05-22T00:01:00.000Z";
  state.approvals = [];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  await mockDaemon(page, state);
  await page.goto("/");

  const guidance = page.getByLabel("Run guidance");
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("Type guidance in the message box and press Enter to queue it.");
  const composer = page.getByLabel("Channel composer");
  const composerInput = composer.getByPlaceholder("Message this channel or @ an AI teammate");
  await composerInput.fill("完成后也更新 docs");
  await composerInput.press("Enter");

  await expect.poll(() => state.runInterventions.length).toBe(1);
  await expect(guidance).toContainText("完成后也更新 docs");
  expect(state.runInterventions[0]).toMatchObject({
    sourceRunId: run.id,
    mode: "queue_followup",
    status: "queued",
    instruction: "完成后也更新 docs",
  });
  expect(state.channelMessages).toHaveLength(0);
  expect(state.channelExecutionProposals).toHaveLength(0);

  await expect(composerInput).toHaveValue("");
  await composerInput.fill("停，改用 daemon API");
  await expect(composer.getByRole("button", { name: "Queue guidance" })).toBeEnabled();
  await composer.getByRole("button", { name: "Queue guidance" }).click();
  await expect.poll(() => state.runInterventions.map((item) => item.instruction)).toEqual([
    "完成后也更新 docs",
    "停，改用 daemon API",
  ]);
  await expect(composerInput).toHaveValue("");
  await composer.getByRole("button", { name: "Stop run" }).click();

  await expect.poll(() => state.runs.find((item) => item.id === run.id)?.status).toBe("cancelled");
  expect(state.runInterventions).toHaveLength(2);
  expect(state.channelMessages).toHaveLength(0);
  expect(state.channelExecutionProposals).toHaveLength(0);
});

test("composer approval overlay groups multiple local approvals and excludes review queue actions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const run = state.runs[0];
  state.approvals.push(
    {
      id: "approval_write_overlay",
      runId: run.id,
      taskId: run.taskId,
      actionType: "write",
      risk: "high",
      title: "Approve file write",
      description: "Write report.md",
      payload: { type: "file_write", path: "report.md" },
      status: "pending",
      createdAt: "2026-05-22T00:00:30.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    },
    {
      id: "approval_external_overlay",
      channelId: "channel_engineering",
      externalWorkActionId: "external_action_overlay",
      actionType: "external_send",
      risk: "critical",
      title: "Approve external send",
      description: "Post external update",
      payload: { type: "external_action", actionKind: "comment" },
      status: "pending",
      createdAt: "2026-05-22T00:00:40.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    },
  );
  await mockDaemon(page, state);
  await page.goto("/");

  const overlay = page.getByLabel("Channel composer").getByLabel("Composer approval overlay");
  await expect(overlay).toContainText("Runtime approvals needed");
  await expect(overlay).toContainText("Highest risk: high");
  const primaryApproval = overlay.locator(".inline-approval-item.primary");
  await expect(primaryApproval).toContainText("Approve file write");
  await expect(primaryApproval).not.toContainText("Approve shell command");
  await expect(overlay).not.toContainText("Approve external send");

  await overlay.getByText("Show other approvals").click();
  await expect(overlay).toContainText("Approve shell command");
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
  const runSettings = attentionQueue.getByLabel("Run settings");
  await expect(runSettings).toContainText("Permission mode");
  await expect(runSettings.getByText("Current channel", { exact: true })).toHaveCount(0);
  await expect(runSettings.getByText("Local", { exact: true })).toHaveCount(0);
  await expect(runSettings.getByText("Preferred teammate reply", { exact: true })).toHaveCount(0);
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
      runSettingsTitle: read(".attention-context-section .attention-section-head strong"),
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
  expect(attentionTypography.runSettingsTitle).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "20px" });
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
