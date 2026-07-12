import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
} from "./support/mock-state";
import {
  readSidebarSelection,
} from "./support/test-helpers";

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

async function readComposerGeometry(page: Page, selector: string): Promise<{ backgroundColor: string; borderRadius: string; boxShadow: string; inputHeight: number; padding: string }> {
  return page.locator(selector).evaluate((composer) => {
    const input = composer.querySelector<HTMLElement>(".tokenized-composer-input");
    const inputRect = input?.getBoundingClientRect();
    const style = getComputedStyle(composer);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      inputHeight: Math.round(inputRect?.height ?? 0),
      padding: style.padding,
    };
  });
}

async function expectActionMenuItemAligned(menuItem: Locator, options: { readonly disabled?: boolean } = {}): Promise<void> {
  const alignment = await menuItem.evaluate((element) => {
    const buttonRect = element.getBoundingClientRect();
    const iconRect = element.querySelector(".action-menu-item-icon svg")?.getBoundingClientRect();
    const labelRect = element.querySelector(".action-menu-item-title > span:last-child")?.getBoundingClientRect();
    const disabled = element instanceof HTMLButtonElement ? element.disabled : false;

    return iconRect && labelRect
      ? {
          disabled,
          height: buttonRect.height,
          iconCenter: iconRect.top + iconRect.height / 2,
          iconHeight: iconRect.height,
          iconWidth: iconRect.width,
          labelCenter: labelRect.top + labelRect.height / 2,
        }
      : undefined;
  });

  expect(alignment).toBeTruthy();
  if (!alignment) {
    throw new Error("Missing sidebar action menu alignment target");
  }
  expect(Math.abs(alignment.iconCenter - alignment.labelCenter)).toBeLessThanOrEqual(1);
  expect(Math.round(alignment.height)).toBeGreaterThanOrEqual(30);
  expect(Math.round(alignment.height)).toBeLessThanOrEqual(34);
  expect(Math.round(alignment.iconWidth)).toBe(14);
  expect(Math.round(alignment.iconHeight)).toBe(14);
  if (options.disabled !== undefined) {
    expect(alignment.disabled).toBe(options.disabled);
  }
}

test("sidebar selection is exclusive and conversation sections stay below primary navigation", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_sidebar_designer",
      displayName: "Designer",
      avatarImageAttachmentId: "attachment_sidebar_designer",
    }),
    createMockTeammate({
      id: "teammate_sidebar_engineer",
      displayName: "Ling Engineer",
      templateId: "engineer",
      roleKey: "engineer",
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const primaryNav = navigation.locator(".primary-nav");
  const newConversationButton = navigation.getByRole("button", { name: "New conversation" });
  await expect(newConversationButton).toBeVisible();
  const commandButtonWidth = await newConversationButton.evaluate((button) => Math.round(button.getBoundingClientRect().width));
  expect(commandButtonWidth).toBeGreaterThan(100);
  expect(commandButtonWidth).toBeLessThan(320);
  await expect(primaryNav.getByRole("button")).toHaveText(["Inbox", "Image Generation", "Automations"]);
  await expect(primaryNav.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Recent conversations", exact: true })).toBeVisible();
  const teammateAvatarGeometry = await navigation.getByRole("button", { name: "Designer", exact: true }).evaluate((row) => {
    const avatar = row.querySelector<HTMLElement>(".teammate-avatar-image.compact");
    const label = [...row.querySelectorAll<HTMLElement>("span")]
      .find((span) => !span.classList.contains("avatar-initial") && !span.classList.contains("channel-mention") && !span.classList.contains("channel-unread"));
    const avatarRect = avatar?.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    return {
      avatarWidth: Math.round(avatarRect?.width ?? 0),
      gap: Math.round((labelRect?.left ?? 0) - (avatarRect?.right ?? 0)),
    };
  });
  expect(teammateAvatarGeometry.avatarWidth).toBeLessThanOrEqual(24);
  expect(teammateAvatarGeometry.gap).toBeGreaterThanOrEqual(4);
  const engineerAvatar = navigation.getByRole("button", { name: "Ling Engineer", exact: true }).locator(".teammate-avatar-image-default");
  await expect(engineerAvatar).toBeVisible();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: [] });

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });
  const channelComposer = page.getByLabel("Channel composer");
  await expect(channelComposer).toHaveClass(/conversation-composer/);
  await expect(channelComposer.getByRole("button", { name: /Selected permission preset/ })).toBeVisible();
  await expect(channelComposer.getByRole("button", { name: "Mention teammate" })).toBeVisible();
  await expect(channelComposer.getByRole("button", { name: /Selected model/ })).toHaveCount(0);

  await expect(navigation.getByText("Ada")).toHaveCount(0);
  await expect(navigation.getByText("Tian")).toHaveCount(0);
  await expect(navigation).toHaveClass(/channel-left-drawer/);
  await expect(page.locator(".channel-sidebar-toolbar")).toBeHidden();
  await expect(page.locator(".channel-left-drawer .primary-nav")).toHaveCSS("border-bottom-width", "0px");
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await navigation.getByRole("button", { name: "Designer", exact: true }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Designer"] });
  const selectedTeammateRow = page.locator('.channel-left-drawer .sidebar-row-shell.selected:has-text("Designer")');
  await expect(selectedTeammateRow).toHaveCSS("background-color", "rgb(245, 245, 245)");
  expect(await selectedTeammateRow.evaluate((row) => getComputedStyle(row, "::before").content)).toBe("none");
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
});

test("AI teammate without uploaded avatar uses the default avatar", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_sidebar_engineer",
      displayName: "Ling Engineer",
      templateId: "engineer",
      roleKey: "engineer",
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const engineerRow = page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer", exact: true });
  await expect(engineerRow.locator(".teammate-avatar-image-default")).toBeVisible();
  await expect(engineerRow.locator(".avatar-initial")).toHaveCount(0);
});

test("sidebar sections collapse locally and keep group action menus", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_local",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const recentConversationRow = navigation.getByRole("button", { name: "No recent conversations" });
  await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible();
  await expect(recentConversationRow).toBeVisible();

  await navigation.getByRole("button", { name: "Channels" }).click();
  await expect(navigation.getByRole("button", { name: "Engineering" })).toHaveCount(0);
  await navigation.getByRole("button", { name: "Channels" }).click();
  await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible();

  await navigation.getByRole("button", { name: "AI Teammates" }).click();
  await expect(navigation.getByRole("button", { name: "Designer", exact: true })).toHaveCount(0);
  await navigation.getByRole("button", { name: "AI Teammates" }).click();
  await expect(navigation.getByRole("button", { name: "Designer", exact: true })).toBeVisible();

  await navigation.getByRole("button", { name: "Recent conversations", exact: true }).click();
  await expect(recentConversationRow).toHaveCount(0);
  await navigation.getByRole("button", { name: "Recent conversations", exact: true }).click();
  await expect(recentConversationRow).toBeVisible();

  await navigation.getByRole("button", { name: "Channel actions" }).click();
  const newChannelMenuItem = page.getByRole("menuitem", { name: "New channel" });
  await expect(newChannelMenuItem).toBeVisible();
  await expectActionMenuItemAligned(newChannelMenuItem);
  await navigation.getByRole("button", { name: "Teammate actions" }).click();
  const newAiTeammateMenuItem = page.getByRole("menuitem", { name: /New AI teammate/ });
  await expect(newAiTeammateMenuItem).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Quick create default teammate/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /More configuration/ })).toHaveCount(0);
  await expectActionMenuItemAligned(newAiTeammateMenuItem);
  await page.keyboard.press("Escape");
  await navigation.getByRole("button", { name: "Recent conversation actions" }).click();
  const archiveAllConversations = page.getByRole("menuitem", { name: "Archive all conversations" });
  await expect(archiveAllConversations).toBeVisible();
  await expect(archiveAllConversations).toBeDisabled();
  await expectActionMenuItemAligned(archiveAllConversations, { disabled: true });
});

test("sidebar archive hides conversations and teammates without deleting data", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5" })];
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const channelShell = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" }).locator(".sidebar-row-shell").first();
  await channelShell.hover();
  const channelArchiveButton = channelShell.getByRole("button", { name: "Archive channel" });
  await expect(channelArchiveButton).toBeVisible();
  await channelArchiveButton.click();
  await expect(navigation.getByRole("button", { name: "Engineering" })).toHaveCount(0);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  await home.getByRole("textbox", { name: "Conversation message" }).fill("Archive me");
  await home.getByRole("button", { name: "Send" }).click();

  const recentShell = navigation.locator(".sidebar-recent-row-shell").filter({ hasText: "Archive me" }).first();
  await expect(recentShell).toBeVisible();
  await navigation.getByRole("button", { name: "Recent conversation actions" }).click();
  const archiveAllConversations = page.getByRole("menuitem", { name: "Archive all conversations" });
  await expect(archiveAllConversations).toBeVisible();
  await expect(archiveAllConversations).toBeEnabled();
  await page.keyboard.press("Escape");
  await recentShell.hover();
  const conversationArchiveButton = recentShell.getByRole("button", { name: "Archive conversation" });
  await expect(conversationArchiveButton).toBeVisible();
  await conversationArchiveButton.click();
  await expect(navigation.locator(".sidebar-recent-row").filter({ hasText: "Archive me" })).toHaveCount(0);
  await expect.poll(() => state.threads.some((thread) => thread.kind === "conversation" && thread.title === "Archive me" && Boolean(thread.archivedAt))).toBe(true);

  const teammateShell = navigation.locator(".sidebar-row-shell").filter({ hasText: "Designer" }).first();
  await teammateShell.hover();
  const teammateArchiveButton = teammateShell.getByRole("button", { name: "Archive teammate" });
  await expect(teammateArchiveButton).toBeVisible();
  await teammateArchiveButton.click();
  await expect(navigation.getByRole("button", { name: "Designer", exact: true })).toHaveCount(0);
  await expect.poll(() => state.aiTeammates.find((teammate) => teammate.id === "teammate_sidebar_designer")?.hidden).toBe(true);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  await expect(page.locator(".archived-items-settings-panel").getByRole("heading", { name: "Archived items" })).toBeVisible();

  const conversationGroup = page.locator(".archived-item-group").filter({ hasText: "Conversations" });
  const teammateGroup = page.locator(".archived-item-group").filter({ hasText: "AI Teammates" });
  await expect(conversationGroup).toContainText("Archive me");
  await expect(teammateGroup).toContainText("Designer");

  await conversationGroup.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => state.threads.find((thread) => thread.kind === "conversation" && thread.title === "Archive me")?.archivedAt ?? "").toBe("");

  await teammateGroup.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => state.aiTeammates.find((teammate) => teammate.id === "teammate_sidebar_designer")?.hidden).toBe(false);
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(navigation.locator(".sidebar-recent-row").filter({ hasText: "Archive me" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Designer", exact: true })).toBeVisible();
});

test("recent conversations only show records created from the conversation home", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5" })];
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "No recent conversations" })).toBeVisible();
  await expect(navigation.locator(".sidebar-recent-row")).toHaveCount(0);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  const homeComposer = home.locator(".conversation-composer");
  await expect(homeComposer).toHaveClass(/conversation-composer-surface-normal_conversation/);
  await expect(homeComposer.getByRole("button", { name: /Selected permission preset/ })).toBeVisible();
  await expect(homeComposer.getByRole("button", { name: /Selected model/ })).toBeVisible();
  await expect(homeComposer.getByRole("button", { name: "Mention teammate" })).toHaveCount(0);
  await home.getByRole("textbox", { name: "Conversation message" }).fill("Plan launch");
  await home.getByRole("button", { name: "Send" }).click();
  const conversationPage = page.getByLabel("Conversation page");
  await expect(conversationPage).toBeVisible();
  const conversationToolbar = conversationPage.getByLabel("Conversation workspace toolbar");
  await expect(conversationToolbar).toBeVisible();
  await expect(conversationToolbar).toHaveClass(/workspace-top-right-toolbar/);
  await expect(conversationToolbar.locator(".workspace-toolbar-action-label")).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: "Search" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: "Refresh" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: "Summary" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: "Terminal" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: /^Review/ })).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: /^Evidence/ })).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: /^Files/ })).toHaveCount(0);
  const conversationDetailsButtonBox = await conversationToolbar.getByRole("button", { name: "Show details" }).boundingBox();
  expect(conversationDetailsButtonBox?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(conversationDetailsButtonBox?.height ?? 0).toBeGreaterThanOrEqual(32);
  await conversationToolbar.getByRole("button", { name: "Summary" }).click();
  await expect(page.locator(".normal-conversation-summary-popover")).toContainText("Workspace");
  await conversationPage.getByRole("button", { name: "Show details" }).click();
  const conversationDock = page.getByLabel("Conversation workspace dock");
  const conversationSummaryPanel = page.locator(".normal-conversation-summary-panel");
  await expect(conversationSummaryPanel).toBeVisible();
  await expect(conversationSummaryPanel).toHaveAttribute("data-summary-placement-motion", "header->main");
  await expect(conversationDock).toBeVisible();
  await expect(conversationDock).toContainText("Workspace tools");
  await expect(conversationDock.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(conversationDock.getByRole("button", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(conversationSummaryPanel).toContainText("Environment");
  await expect(conversationSummaryPanel.getByText("Evidence", { exact: true })).toHaveCount(0);
  await expect(conversationPage).toHaveClass(/summary-panel-expanded/);
  await expect(conversationSummaryPanel).toHaveClass(/is-popover-expanded/);
  await expect.poll(async () => {
    const summaryBox = await conversationSummaryPanel.boundingBox();
    const dockFrameBox = await page.locator(".normal-conversation-right-dock-frame").boundingBox();
    return summaryBox && dockFrameBox ? summaryBox.x + summaryBox.width <= dockFrameBox.x + 1 : false;
  }).toBe(true);
  await conversationToolbar.getByRole("button", { name: "Summary" }).click();
  await expect(conversationPage).toHaveClass(/summary-panel-collapsed/);
  await expect(conversationSummaryPanel).toHaveClass(/is-popover-collapsed/);
  await expect(conversationSummaryPanel).toHaveCount(0);
  await conversationToolbar.getByRole("button", { name: "Summary" }).click();
  await expect(conversationSummaryPanel).toBeVisible();
  await conversationToolbar.getByRole("button", { name: "Hide details" }).click();
  const conversationTopSummary = page.locator(".normal-conversation-summary-popover");
  await expect(conversationTopSummary).toBeVisible();
  await expect(conversationTopSummary).toHaveAttribute("data-summary-placement-motion", "main->header");
  await expect(conversationDock).toHaveCount(0);
  await expect(conversationTopSummary).toContainText("Workspace");
  await conversationToolbar.getByRole("button", { name: "Summary" }).click();
  await conversationToolbar.getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByLabel("Terminal session")).toBeVisible();
  await page.getByRole("button", { name: "Close terminal panel" }).click();
  await expect(page.getByLabel("Conversation home")).toHaveCount(0);
  await expect(conversationPage.getByText("Conversation saved to recent conversations.")).toHaveCount(0);
  await expect(conversationPage.locator(".conversation-composer")).toHaveClass(/conversation-composer-surface-normal_conversation/);
  await expect(conversationPage.getByRole("textbox", { name: "Conversation message" })).toHaveAttribute("data-value", "");
  await expect(conversationPage.getByLabel("Conversation messages", { exact: true })).toContainText("Plan launch");
  await expect(conversationPage.locator(".normal-conversation-message-row.ai-teammate")).toHaveCount(1);
  const assistantRow = conversationPage.locator(".normal-conversation-message-row.ai-teammate").first();
  await expect(assistantRow.locator(".conversation-work-cell")).toHaveCount(1);
  const assistantActions = assistantRow.locator(".normal-conversation-message-actions.message-action-bar");
  await expect(assistantActions).toHaveCount(1);
  await expect(assistantActions.locator('[data-tooltip="Copy message"]')).toHaveCount(1);
  await expect(assistantActions.locator('[data-tooltip="Like response"]')).toHaveCount(1);
  await expect(assistantActions.locator('[data-tooltip="Dislike response"]')).toHaveCount(1);
  await expect(assistantActions.locator('[data-tooltip="Reply in topic"]')).toHaveCount(0);
  await expect(assistantRow.locator(".message-reply-button")).toHaveCount(0);
  await expect(assistantRow.locator(".teammate-avatar-stack")).toHaveCount(0);
  await expect(assistantRow.locator(".source-icon-stack")).toHaveCount(0);
  const messageThread = conversationPage.getByLabel("Conversation messages");
  await expect.poll(() => messageThread.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBeGreaterThan(790);
  const threadWidthBeforeHover = await messageThread.evaluate((element) => element.getBoundingClientRect().width);
  await expect.poll(() => messageThread.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("none");
  await messageThread.hover();
  await expect.poll(() => messageThread.evaluate((element) => element.getBoundingClientRect().width)).toBe(threadWidthBeforeHover);

  const recentRow = navigation.locator(".sidebar-recent-row").first();
  await expect(recentRow).toBeVisible();
  await expect(recentRow).toContainText("Plan launch");
  await expect(navigation.locator(".sidebar-recent-row-shell").first()).toHaveClass(/selected/);
  await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible();
  await expect(navigation.locator('.sidebar-recent-row:has-text("Engineering")')).toHaveCount(0);
  await expect(navigation.locator('.sidebar-recent-row:has-text("Designer")')).toHaveCount(0);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(home).toBeVisible();
  await home.getByRole("textbox", { name: "Conversation message" }).fill("Second local conversation");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Conversation page").locator(".normal-conversation-message-row.ai-teammate")).toHaveCount(1);
  await expect(navigation.locator(".sidebar-recent-row").first()).toContainText("Second local conversation");
});

test("normal conversation composer sends and replays uploaded attachments", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  const homeComposer = home.locator(".conversation-composer");
  await expect(homeComposer).toHaveClass(/conversation-composer-surface-normal_conversation/);
  await expect(homeComposer.getByRole("button", { name: /Selected permission preset/ })).toBeVisible();
  await expect(homeComposer.getByRole("button", { name: /Selected model/ })).toBeVisible();
  await expect(homeComposer.getByRole("button", { name: "Mention teammate" })).toHaveCount(0);

  await homeComposer.locator('input[type="file"]').setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Launch scope\n- concise answer\n", "utf8"),
  });
  await expect(homeComposer.getByLabel("Pending message assets")).toContainText("brief.txt");

  await home.getByRole("textbox", { name: "Conversation message" }).fill("Review this brief");
  await home.getByRole("button", { name: "Send" }).click();

  const conversationPage = page.getByLabel("Conversation page");
  await expect(conversationPage).toBeVisible();
  await expect(conversationPage.locator(".conversation-composer")).toHaveClass(/conversation-composer-surface-normal_conversation/);
  await expect.poll(async () => readComposerGeometry(page, ".normal-conversation-page .conversation-composer")).toEqual(expect.objectContaining({
    borderRadius: "12px",
    inputHeight: 76,
    padding: "8px",
  }));
  await expect.poll(async () => (await readComposerGeometry(page, ".normal-conversation-page .conversation-composer")).boxShadow).not.toBe("none");
  await expect(conversationPage.getByRole("button", { name: "Mention teammate" })).toHaveCount(0);
  const messages = conversationPage.getByLabel("Conversation messages", { exact: true });
  await expect(messages).toContainText("Review this brief");
  await expect(messages.locator(".conversation-attachment-chip")).toContainText("brief.txt");
  await expect(conversationPage.locator(".composer-preview-strip")).toHaveCount(0);
  await expect(conversationPage.getByLabel("Conversation workspace toolbar").getByRole("button", { name: /^Files/ })).toHaveCount(0);
  await conversationPage.getByRole("button", { name: "Show details" }).click();
  const conversationDock = page.getByLabel("Conversation workspace dock");
  await expect(conversationDock).toBeVisible();
  await conversationDock.getByRole("button", { name: "Files" }).click();
  await expect(conversationDock.locator(".right-dock-head-page")).toContainText("Files");
  await expect(conversationDock).toContainText("brief.txt");
});

test("executed normal conversation renders one structured terminal report", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_terminal_report_conversation";
  const turnId = "turn_terminal_report_conversation";
  const runId = "run_terminal_report_conversation";
  const createdAt = "2026-07-11T03:00:00.000Z";
  const completedAt = "2026-07-11T03:01:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "实现结构化终局报告",
    objective: "实现结构化终局报告",
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
    title: "实现结构化终局报告",
    userInstruction: "实现结构化终局报告",
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
    taskId: "task_terminal_report_conversation",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_terminal_report_conversation", title: "实现结构化终局报告" },
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
    id: "event_terminal_report_assistant_text",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "旧的执行总结不应和结构化报告重复展示。" },
  }];
  state.terminalReports = [{
    schemaVersion: 1,
    id: "terminal_report_conversation",
    workspaceId: "workspace_default",
    threadId,
    turnId,
    source: { kind: "turn", id: turnId },
    status: "committed",
    language: "zh-CN",
    outcome: {
      status: "succeeded",
      title: "结构化终局报告已接入普通会话",
      summary: "执行过程保留在工作记录中，最终结果由 TerminalReport 独立展示。",
      corrections: [],
      sourceRefs: [{ kind: "turn", id: turnId, visibility: "conversation" }],
    },
    changes: [{
      id: "change_terminal_report_conversation",
      kind: "code",
      title: "接入普通会话投影",
      summary: "普通会话读取执行轮关联的结构化报告。",
      paths: ["apps/web/src/features/workspace/ConversationHome.tsx"],
      addedLines: 18,
      deletedLines: 2,
      sourceRefs: [],
    }],
    verification: [{
      id: "check_terminal_report_conversation",
      title: "Web typecheck",
      status: "passed",
      command: "corepack pnpm --filter @ling-stack/web typecheck",
      sourceRefs: [],
    }],
    participants: [],
    artifacts: [],
    risks: [],
    references: [],
    evidenceSnapshotId: "snapshot_terminal_report_conversation",
    evidenceFingerprint: "fingerprint_terminal_report_conversation",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: completedAt,
    committedAt: completedAt,
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.locator(".sidebar-recent-row").filter({ hasText: "实现结构化终局报告" }).click();

  const assistantRow = page.getByLabel("对话页面").locator(".normal-conversation-message-row.ai-teammate");
  await expect(assistantRow).toHaveCount(1);
  await expect(assistantRow.getByText("旧的执行总结不应和结构化报告重复展示。")).toHaveCount(0);
  const report = assistantRow.locator(".terminal-report-block");
  await expect(report).toContainText("结构化终局报告已接入普通会话");
  await expect(report.locator(".terminal-report-participants")).toHaveCount(0);
  await report.locator(".terminal-report-summary").click();
  await expect(report).toContainText("接入普通会话投影");
  await expect(report).toContainText("1 个文件");
  await expect(report).toContainText("已通过");
});

test("conversation home follows user language and shows thinking as off", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "新建对话" }).click();
  const home = page.getByLabel("对话首页");
  await expect(home.getByRole("heading", { name: "Ling Stack，让工作更简单。", level: 1 })).toBeVisible();
  await expect(home.getByRole("textbox", { name: "对话内容" })).toHaveAttribute("data-placeholder", "输入消息...（输入 / 唤起命令）");
  await expect(home.getByRole("button", { name: "创建 Team" })).toBeVisible();
  await expect(home.getByRole("button", { name: "幻灯片" })).toBeVisible();
  await expect(home.getByRole("button", { name: "文档" })).toBeVisible();
  await expect(home.getByRole("button", { name: "表格" })).toBeVisible();
  await expect(home.getByText("思考关闭")).toBeVisible();
  await home.getByRole("textbox", { name: "对话内容" }).fill("你好");
  await home.getByRole("button", { name: "发送" }).click();
  const conversationPage = page.getByLabel("对话页面");
  await expect(conversationPage.locator(".normal-conversation-message-row.ai-teammate")).toHaveCount(1);
  await expect(conversationPage.locator(".conversation-work-cell")).toHaveCount(0);
  await expect(conversationPage.getByText("Ling Agent 回复：你好")).toBeVisible();

  await navigation.getByRole("button", { name: "新建对话" }).click();
  await expect(home).toBeVisible();
  await home.getByRole("textbox", { name: "对话内容" }).fill("hello");
  await home.getByRole("button", { name: "发送" }).click();
  await expect(page.getByLabel("对话页面").locator(".normal-conversation-message-row.ai-teammate")).toHaveCount(1);
  await expect(page.getByLabel("对话页面").getByText("Ling Agent response: hello")).toBeVisible();
});

test("conversation home refreshes interface language and theme after workspace settings change outside the tab", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings = {
    ...state.workspaceSettings,
    locale: "en-US",
    theme: "dark",
  };
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByLabel("Conversation home").getByRole("heading", { name: "Ling Stack, make work easier.", level: 1 })).toBeVisible();

  state.workspaceSettings = {
    ...state.workspaceSettings,
    locale: "zh-CN",
    theme: "light",
  };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("对话首页").getByRole("heading", { name: "Ling Stack，让工作更简单。", level: 1 })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "收件箱" })).toBeVisible();
});

test("sidebar text entries route to context-aware inspectors", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const primaryNav = navigation.locator(".primary-nav");
  await expect(navigation.getByRole("button", { name: "Search or start" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(primaryNav.getByRole("button")).toHaveText(["Inbox", "Image Generation", "Automations"]);
  await expect(primaryNav.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Profile" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByLabel("Conversation home")).toBeVisible();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: [] });

  await primaryNav.getByRole("button", { name: "Inbox" }).click();
  await expect(page.locator(".approvals-panel").getByRole("heading", { name: "Inbox" })).toBeVisible();

  await navigation.getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await settingsSections.getByRole("button", { name: "Council Workspace" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.locator(".council-workspace-page[aria-label='Council Workspace']")).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: /^User profile$/ })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: /Interface preferences/ })).toBeVisible();
  await settingsSections.getByRole("button", { name: /^User profile$/ }).click();
  await expect(page.getByRole("heading", { name: "User profile", level: 1 })).toHaveCount(0);
  await expect(page.locator(".profile-settings-identity-block")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Identity information" })).toHaveCount(0);
  await expect(page.getByLabel("Handle")).toHaveCount(0);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Display preview" })).toHaveCount(0);
  await expect(page.getByLabel("Profile display preview")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Usage summary" })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toBeVisible();
  await settingsSections.getByRole("button", { name: "Teammate Management" }).click();
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await page.getByRole("button", { name: "Back to app" }).click();

  await navigation.getByRole("button", { name: "Image Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Generation task status")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await primaryNav.getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();

});

test("conversation home uses plus as the single attachment entry and keeps slash commands text-driven", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "New conversation" }).click();

  const home = page.getByLabel("Conversation home");
  await expect(home).toBeVisible();
  const homeComposer = home.locator(".conversation-composer");
  const attachTrigger = homeComposer.locator('label[aria-label="Attach files"]');
  await expect(attachTrigger).toBeVisible();
  await expect(attachTrigger).toHaveCount(1);
  await expect(attachTrigger.locator('input[type="file"]')).toHaveCount(1);
  await expect(homeComposer.getByRole("button", { name: "Skills" })).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Select folder" })).toHaveCount(0);
  await expect(page.locator(".conversation-skill-popover")).toHaveCount(0);
  await expect(page.locator(".conversation-folder-popover")).toHaveCount(0);

  const conversationInput = home.getByRole("textbox", { name: "Conversation message" });
  await conversationInput.fill("/rev");
  await expect(page.getByRole("listbox", { name: "Slash command" })).toBeVisible();
  await page.getByRole("option", { name: /^\/review\b/ }).click();
  await expect(conversationInput).toHaveAttribute("data-value", "/review ");
});

test("conversation home sends with workspace cwd without a folder picker", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "New conversation" }).click();

  const home = page.getByLabel("Conversation home");
  await expect(home).toBeVisible();
  await expect(page.locator(".conversation-folder-popover")).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Select folder" })).toHaveCount(0);

  await home.getByRole("textbox", { name: "Conversation message" }).fill("Project scoped conversation");
  await home.getByRole("button", { name: "Send" }).click();

  const recentRow = navigation.locator(".sidebar-recent-row").first();
  await expect(recentRow).toContainText("Project scoped conversation");
  await expect(recentRow).toContainText("Conversation");

  const conversationPage = page.getByLabel("Conversation page");
  await expect(conversationPage).toBeVisible();
  await expect(conversationPage.getByRole("button", { name: /Selected folder/ })).toHaveCount(0);
  await expect.poll(() => state.runs.at(-1)?.cwd).toBe(cwd);
});

test("conversation home model picker uses the model workbench default without changing it", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const readyCheck = {
    ok: true,
    code: "ready",
    message: "Provider is reachable.",
    checkedAt: "2026-05-25T00:00:00.000Z",
  };
  state.providers = [
    createChatProvider({
      id: "provider_local",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "gpt-5.5",
      updatedAt: "2026-05-25T00:10:00.000Z",
      lastCheck: readyCheck,
    }),
    createChatProvider({
      id: "provider_gemini",
      displayName: "Gemini Pro",
      providerId: "gemini",
      model: "gemini-2.5-pro",
      updatedAt: "2026-05-25T00:20:00.000Z",
      lastCheck: readyCheck,
    }),
    createChatProvider({
      id: "provider_sonnet",
      displayName: "Anthropic Sonnet",
      providerId: "anthropic",
      model: "claude-sonnet-4",
      updatedAt: "2026-05-25T00:30:00.000Z",
      lastCheck: readyCheck,
    }),
    createChatProvider({
      id: "provider_plain",
      displayName: "Plain Chat",
      providerId: "custom-openai-compatible",
      model: "cliproxy-gpt-4o",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
      updatedAt: "2026-05-25T00:40:00.000Z",
      lastCheck: readyCheck,
    }),
    createChatProvider({
      id: "provider_bad_image_chat",
      displayName: "Wrongly Saved Image",
      providerId: "custom-openai-compatible",
      model: "gpt-image-2",
      capabilities: ["chat"],
      reasoning: false,
      thinkingModes: [],
      updatedAt: "2026-05-25T00:50:00.000Z",
      lastCheck: readyCheck,
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  const geminiRow = page.locator(".provider-row").filter({ hasText: "Gemini Pro" });
  await geminiRow.getByRole("button", { name: "Set default" }).click();
  await expect(geminiRow).toContainText("Current default");
  await expect(geminiRow.getByRole("button", { name: "Set default" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to app" }).click();

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  await expect(home.getByRole("button", { name: "Selected model gemini-2.5-pro" })).toBeVisible();
  await expect(home.getByRole("button", { name: "Selected thinking mode Off" })).toBeVisible();
  await home.getByRole("button", { name: "Selected thinking mode Off" }).click();
  await expect(page.getByRole("listbox", { name: "Thinking mode" }).getByRole("option")).toHaveText(["Off", "Minimal", "Low", "Medium", "High", "XHigh"]);
  await page.keyboard.press("Escape");

  await home.getByRole("button", { name: "Selected model gemini-2.5-pro" }).click();
  const modelMenu = page.getByRole("listbox", { name: "Model options" });
  await expect(modelMenu).toBeVisible();
  await expect(modelMenu.locator(".conversation-model-option")).toHaveCount(4);
  await expect(modelMenu.locator(".conversation-model-option").first()).toContainText("gemini-2.5-pro");
  await expect(modelMenu.locator(".conversation-model-option").first()).toContainText("Default");
  await expect(modelMenu).not.toContainText("gpt-image-2");
  await expect(modelMenu).not.toContainText("gemini/");
  await expect(modelMenu).not.toContainText("anthropic/");

  const modelSearch = modelMenu.getByRole("textbox", { name: "Search models" });
  await modelSearch.focus();
  await expect.poll(() => modelMenu.locator(".conversation-model-search").evaluate((searchField) => {
    const fieldRect = searchField.getBoundingClientRect();
    const inputRect = searchField.querySelector("input")?.getBoundingClientRect();
    if (!inputRect) {
      return false;
    }
    return inputRect.left >= fieldRect.left &&
      inputRect.right <= fieldRect.right &&
      inputRect.top >= fieldRect.top &&
      inputRect.bottom <= fieldRect.bottom;
  })).toBe(true);
  await modelSearch.fill("gpt-4o");
  await expect(modelMenu.locator(".conversation-model-option")).toHaveCount(1);
  await modelMenu.getByRole("option", { name: /cliproxy-gpt-4o/ }).click();
  await expect(home.getByRole("button", { name: "Selected model cliproxy-gpt-4o" })).toBeVisible();
  await expect(home.getByRole("button", { name: /Selected thinking mode/ })).toHaveCount(0);

  await home.getByRole("button", { name: "Selected model cliproxy-gpt-4o" }).click();
  await modelSearch.fill("sonnet");
  await expect(modelMenu.locator(".conversation-model-option")).toHaveCount(1);
  await expect(modelMenu.locator(".conversation-model-option")).toContainText("claude-sonnet-4");
  await modelMenu.getByRole("option", { name: /claude-sonnet-4/ }).click();
  await expect(home.getByRole("button", { name: "Selected model claude-sonnet-4" })).toBeVisible();
  await home.getByRole("button", { name: "Selected thinking mode Off" }).click();
  await page.getByRole("listbox", { name: "Thinking mode" }).getByRole("option", { name: "High", exact: true }).click();
  await expect(home.getByRole("button", { name: "Selected thinking mode High" })).toBeVisible();

  await home.getByRole("textbox", { name: "Conversation message" }).fill("Use Sonnet for this conversation");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(navigation.locator(".sidebar-recent-row").first()).toContainText("Use Sonnet for this conversation");
  const conversationPage = page.getByLabel("Conversation page");
  await expect(conversationPage).toBeVisible();

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(home).toBeVisible();
  await expect(home.getByRole("button", { name: "Selected model gemini-2.5-pro" })).toBeVisible();

  await navigation.locator(".sidebar-recent-row").filter({ hasText: "Use Sonnet for this conversation" }).click();
  await expect(conversationPage.getByRole("button", { name: "Selected model claude-sonnet-4" })).toBeVisible();
  await expect(conversationPage.getByRole("button", { name: "Selected thinking mode High" })).toBeVisible();
});

test("settings workspace tools keep left navigation available on nested tool pages", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ready",
    displayName: "Ready Relay",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_settings_designer",
    displayName: "Designer",
    providerPresetId: "provider_ready",
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toBeVisible();

  await settingsSections.getByRole("button", { name: "Model Workbench" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.locator(".provider-workbench[aria-label='Model Workbench']")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections).toBeVisible();

  await settingsSections.getByRole("button", { name: "Teammate Management" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections).toBeVisible();

  await settingsSections.getByRole("button", { name: "Work Board" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.locator(".work-board-page")).toBeVisible();
  await expect(page.locator(".work-board-page").getByRole("heading", { name: "Needs action" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toBeVisible();

  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
});
