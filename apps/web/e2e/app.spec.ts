import { expect, test, type Locator, type Page } from "@playwright/test";
import { timelineBatchGroup } from "./support/timeline-batch-group";
import { timelineResponseFooter } from "./support/timeline-response-footer";
import { installEarlyMeasurementScroll } from "./support/early-measurement-scroll";
import { mockDaemon, type MockExecutionAction } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  isRecord,
} from "./support/mock-state";
import {
  readSidebarSelection,
} from "./support/test-helpers";
import {
  expectSharedConversationRichBody,
  sharedConversationRichBody,
} from "./support/rich-content";

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

const readyProviderCheck = {
  ok: true,
  message: "Ready",
  checkedAt: "2026-08-25T00:00:00.000Z",
} as const;

function mockCommandExecutionAction(
  id: string,
  threadId: string,
  runId: string,
  command: string,
  startedAt: string,
  durationMs: number,
): MockExecutionAction {
  const completedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  return {
    id,
    workspaceId: "workspace_default",
    threadId,
    runId,
    attemptId: `attempt_${runId}`,
    toolCallId: `tool_${id}`,
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: "Run command",
    summary: command,
    targetRefs: [{ type: "command", label: command }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    commandEvidence: {
      command,
      cwd,
      startedAt,
      completedAt,
      durationMs,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      latestEventSeq: 3,
      outputTail: [{ eventSeq: 2, stream: "stdout", text: "ok\n", byteCount: 3, redacted: false, ts: completedAt }],
      outputByteCount: 3,
      outputLineCount: 1,
      outputTruncated: false,
    },
    createdAt: startedAt,
    updatedAt: completedAt,
    executedAt: startedAt,
    completedAt,
  };
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
    const iconRect = element.querySelector(".ling-ui-menu-item-icon svg")?.getBoundingClientRect();
    const labelRect = element.querySelector(".sidebar-section-menu-item-label")?.getBoundingClientRect();
    const disabled = element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled");

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
  expect(Math.round(alignment.iconWidth)).toBe(16);
  expect(Math.round(alignment.iconHeight)).toBe(16);
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

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const primaryNav = navigation.locator(".primary-nav");
  const newConversationButton = navigation.getByRole("button", { name: "New conversation" });
  await expect(newConversationButton).toBeVisible();
  const commandButtonWidth = await newConversationButton.evaluate((button) => Math.round(button.getBoundingClientRect().width));
  expect(commandButtonWidth).toBeGreaterThan(100);
  expect(commandButtonWidth).toBeLessThan(320);
  await expect(primaryNav.getByRole("button")).toHaveText(["Media Production", "Plugin Manager", "Automations"]);
  await expect(primaryNav.getByRole("button", { name: "Inbox" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Recent conversations", exact: true })).toBeVisible();
  const teammateAvatarGeometry = await navigation.getByRole("button", { name: "Designer", exact: true }).evaluate((row) => {
    const avatar = row.querySelector<HTMLElement>(".teammate-avatar-image.compact");
    const label = row.querySelector<HTMLElement>('[data-ling-button-slot="label"]');
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
  await expect(selectedTeammateRow).toHaveCSS("background-color", "rgb(217, 216, 213)");
  expect(await selectedTeammateRow.evaluate((row) => getComputedStyle(row, "::before").content)).toBe("none");
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
});

test("app shell keeps offline data visible and reconnects from persistent feedback", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { healthResponses: [false, false, true] });
  await page.goto("/");

  const feedback = page.getByRole("alert").filter({ hasText: "Local service is unavailable" });
  await expect(feedback).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toBeVisible();
  await expect(feedback).toContainText("Some information may be out of date");
  await feedback.getByRole("button", { name: "Reconnect" }).click();
  await expect(feedback).toHaveCount(0);
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

  const engineerRow = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Ling Engineer", exact: true });
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

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5", lastCheck: readyProviderCheck })];
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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
  await expect(page.locator(".archived-items-settings-panel")).toBeVisible();

  const archivedList = page.locator(".archived-item-list");
  await expect(archivedList).toContainText("Archive me");

  await archivedList.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => state.threads.find((thread) => thread.kind === "conversation" && thread.title === "Archive me")?.archivedAt ?? "").toBe("");

  await page.locator(".archived-items-settings-panel").getByRole("tab", { name: /AI Teammates/ }).click();
  await expect(archivedList).toContainText("Designer");
  await archivedList.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => state.aiTeammates.find((teammate) => teammate.id === "teammate_sidebar_designer")?.hidden).toBe(false);
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(navigation.locator(".sidebar-recent-row").filter({ hasText: "Archive me" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Designer", exact: true })).toBeVisible();
});

test("recent conversations only show records created from the conversation home", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5", lastCheck: readyProviderCheck })];
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.authorizationMode : undefined;
  }).toBe("smart");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.workspaceAccessMode : undefined;
  }).toBe("workspace_write");
  const conversationPage = page.getByLabel("Conversation page");
  await expect(conversationPage).toBeVisible();
  const conversationToolbar = page.locator("[data-desktop-window-titlebar-surface='true']")
    .getByLabel("Conversation workspace toolbar");
  await expect(conversationToolbar).toBeVisible();
  await expect(conversationToolbar).toHaveClass(/workspace-top-right-toolbar/);
  await expect(conversationToolbar.locator(".workspace-toolbar-action-label")).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: "Search" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: "Summary", exact: true })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: "Terminal" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(conversationToolbar.getByRole("button", { name: /^Review/ })).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: /^Evidence/ })).toHaveCount(0);
  await expect(conversationToolbar.getByRole("button", { name: /^Files/ })).toHaveCount(0);
  const conversationDetailsButtonBox = await conversationToolbar.getByRole("button", { name: "Show details" }).boundingBox();
  expect(conversationDetailsButtonBox?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(conversationDetailsButtonBox?.height ?? 0).toBeGreaterThanOrEqual(32);
  await conversationToolbar.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(page.locator(".normal-conversation-summary-popover")).toContainText("Workspace");
  await conversationToolbar.getByRole("button", { name: "Show details" }).click();
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
  await conversationToolbar.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(conversationPage).toHaveClass(/summary-panel-collapsed/);
  await expect(conversationSummaryPanel).toHaveClass(/is-popover-collapsed/);
  await expect(conversationSummaryPanel).toHaveCount(0);
  await conversationToolbar.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(conversationSummaryPanel).toBeVisible();
  await conversationToolbar.getByRole("button", { name: "Hide details" }).click();
  const conversationTopSummary = page.locator(".normal-conversation-summary-popover");
  await expect(conversationTopSummary).toBeVisible();
  await expect(conversationTopSummary).toHaveAttribute("data-summary-placement-motion", "main->header");
  await expect(conversationDock).toHaveCount(0);
  await expect(conversationTopSummary).toContainText("Workspace");
  await conversationToolbar.getByRole("button", { name: "Summary", exact: true }).click();
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
  await expect(assistantRow.locator(".conversation-work-cell")).toHaveCount(0);
  const assistantActions = (await timelineResponseFooter(assistantRow)).locator(".normal-conversation-message-actions.message-action-bar");
  await expect(assistantActions).toHaveCount(1);
  await expect(assistantActions.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  await expect(assistantActions.getByRole("button", { name: "Like response", exact: true })).toHaveCount(1);
  await expect(assistantActions.getByRole("button", { name: "Dislike response", exact: true })).toHaveCount(1);
  await expect(assistantActions.getByRole("button", { name: "Reply in topic", exact: true })).toHaveCount(0);
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

for (const earlyMeasurement of [false, true]) {
test(`normal conversation virtualizes a long canonical timeline without adding a nested scroll owner${earlyMeasurement ? " (scroll before measurement commit)" : ""}`, async ({ page }, testInfo) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_normal_virtualized_history";
  const turnCount = 60;
  const startedAtMs = Date.parse("2026-09-05T02:00:00.000Z");
  const isoAt = (index: number): string => new Date(startedAtMs + index * 60_000).toISOString();
  const turns = Array.from({ length: turnCount }, (_, index) => {
    const number = index + 1;
    const timestamp = isoAt(index);
    return {
      id: `turn_normal_virtual_${number}`,
      workspaceId: "workspace_default",
      threadId,
      kind: index === 0 ? "initial_request" : "follow_up",
      status: "succeeded",
      title: `Normal history user ${number}`,
      userInstruction: `Normal history user ${number}`,
      activeRunId: `run_normal_virtual_${number}`,
      lastRunId: `run_normal_virtual_${number}`,
      createdByActor: "local-user",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    };
  });
  const runs = turns.map((turn, index) => ({
    id: `run_normal_virtual_${index + 1}`,
    status: "succeeded",
    cwd,
    taskId: `task_normal_virtual_${index + 1}`,
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: `task_normal_virtual_${index + 1}`, title: turn.title },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/run_normal_virtual_${index + 1}.jsonl`,
    threadId,
    turnId: turn.id,
    createdAt: turn.createdAt,
    startedAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    endedAt: turn.updatedAt,
  }));
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Virtualized normal history",
    objective: "Verify the shared Timeline windows long normal conversations.",
    status: "succeeded",
    lastRunId: runs.at(-1)?.id,
    createdAt: isoAt(0),
    updatedAt: isoAt(turnCount - 1),
  }];
  state.turns = turns;
  state.turnRunLinks = turns.map((turn, index) => ({
    turnId: turn.id,
    runId: runs[index]!.id,
    attemptNumber: 1,
    role: "primary",
    createdAt: turn.createdAt,
  }));
  state.runs = [...runs, ...state.runs];
  for (const [index, run] of runs.entries()) {
    state.eventsByRun[run.id] = [{
      id: `event_normal_virtual_${index + 1}`,
      runId: run.id,
      seq: 1,
      ts: run.updatedAt,
      type: "assistant_text_delta",
      data: { text: `Normal history assistant ${index + 1}` },
    }];
  }

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .locator(".sidebar-recent-row")
    .filter({ hasText: "Virtualized normal history" })
    .click();

  const conversationPage = page.getByLabel("Conversation page");
  const feed = conversationPage.getByLabel("Conversation messages", { exact: true });
  const timeline = feed.locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]');
  await expect(timeline).toHaveClass(/virtualized/);
  await expect(conversationPage.getByText("Normal history assistant 60", { exact: true })).toBeVisible();
  await expect(conversationPage.getByText("Normal history user 1", { exact: true })).toHaveCount(0);

  const mountedAtBottom = await timeline.locator(".conversation-timeline-virtual-row").count();
  expect(mountedAtBottom).toBeGreaterThan(0);
  expect(mountedAtBottom).toBeLessThan(60);
  const scrollOwners = await conversationPage.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>("*"))
    .filter((element) => {
      const style = getComputedStyle(element);
      return (style.overflowY === "auto" || style.overflowY === "scroll")
        && element.scrollHeight > element.clientHeight + 1;
    })
    .map((element) => element.className));
  expect(scrollOwners).toEqual([expect.stringContaining("normal-conversation-feed")]);

  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(conversationPage.getByText("Normal history user 1", { exact: true })).toBeVisible();
  await expect(conversationPage.getByText("Normal history assistant 60", { exact: true })).toHaveCount(0);
  const mountedAtTop = await timeline.locator(".conversation-timeline-virtual-row").count();
  expect(mountedAtTop).toBeGreaterThan(0);
  expect(mountedAtTop).toBeLessThan(60);

  await feed.evaluate((element) => {
    element.scrollTop = Math.round(element.scrollHeight * 0.45);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  const readFirstVisibleAnchor = async (): Promise<{ id: string; offsetTop: number } | undefined> => feed.evaluate((element) => {
    const feedRect = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll<HTMLElement>(
      '.conversation-timeline-virtual-row[data-feed-item-id]',
    )).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > feedRect.top + 12 && rect.top < feedRect.bottom - 12;
    });
    return row?.dataset.feedItemId
      ? { id: row.dataset.feedItemId, offsetTop: Math.round(row.getBoundingClientRect().top - feedRect.top) }
      : undefined;
  });
  let anchorBefore = await readFirstVisibleAnchor();
  await expect.poll(async () => {
    const next = await readFirstVisibleAnchor();
    const stable = Boolean(next && anchorBefore && next.id === anchorBefore.id && Math.abs(next.offsetTop - anchorBefore.offsetTop) <= 1);
    anchorBefore = next;
    return stable;
  }).toBe(true);
  if (!anchorBefore) throw new Error("Normal conversation anchor did not stabilize");
  if (earlyMeasurement) {
    await installEarlyMeasurementScroll(feed);
    await page.screenshot({ path: testInfo.outputPath("reading-before-remeasurement.png") });
  }
  const expandedAboveAnchor = await feed.evaluate((element) => {
    const feedRect = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll<HTMLElement>(".conversation-timeline-virtual-row"))
      .filter((candidate) => candidate.getBoundingClientRect().bottom <= feedRect.top + 8)
      .at(-1);
    if (!row) return false;
    row.style.paddingBottom = "120px";
    return true;
  });
  expect(expandedAboveAnchor).toBe(true);
  if (earlyMeasurement) await expect.poll(() => feed.getAttribute("data-test-early-measurement-scrolls")).not.toBe("0");
  await expect.poll(async () => {
    const anchorAfter = await readFirstVisibleAnchor();
    return Boolean(
      anchorAfter
      && anchorAfter.id === anchorBefore?.id
      && Math.abs(anchorAfter.offsetTop - (anchorBefore?.offsetTop ?? 0)) <= 4
    );
  }).toBe(true);
  if (earlyMeasurement) await page.screenshot({ path: testInfo.outputPath("reading-after-remeasurement.png") });
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect(conversationPage.getByText("Normal history assistant 60", { exact: true })).toBeVisible();
});
}

test("normal conversation queues approvals in its composer gate", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_normal_inline_approvals";
  const turnId = "turn_normal_inline_approvals";
  const runId = "run_normal_inline_approvals";
  const timestamp = "2026-07-20T02:00:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Normal inline approvals",
    objective: "Verify normal conversation approvals.",
    status: "waiting_for_approval",
    activeRunId: runId,
    lastRunId: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "waiting_for_approval",
    title: "Normal inline approvals",
    userInstruction: "Run the gated command.",
    activeRunId: runId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp }];
  state.runs.unshift({
    id: runId,
    status: "waiting_for_approval",
    cwd,
    taskId: "task_normal_inline_approvals",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_normal_inline_approvals", title: "Normal inline approvals" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    workUnitId: "work_unit_normal_inline_approvals",
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
  });
  state.workUnits = [{
    id: "work_unit_normal_inline_approvals",
    workspaceId: "workspace_default",
    kind: "conversation_run",
    ownerType: "conversation_turn",
    ownerId: turnId,
    teammateId: "ling_agent",
    idempotencyKey: "work_unit_normal_inline_approvals",
    status: "waiting_for_approval",
    priority: 0,
    attemptCount: 1,
    createdByActor: "local-user",
    request: {},
    timeoutPolicy: {
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 45_000,
      idleTimeoutMs: 600_000,
      hardTimeoutMs: 3_600_000,
      cancelGraceMs: 15_000,
    },
    linkedRunId: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: timestamp,
    type: "assistant_text_delta",
    data: { text: "Waiting for approval.\n\nThen I will run `node --test`." },
  }];
  state.approvals = [
    {
      id: "approval_normal_shell",
      runId,
      actionType: "bash",
      risk: "medium",
      title: "Approve normal shell command",
      description: "echo normal",
      payload: { type: "bash", command: "echo normal" },
      status: "pending",
      createdAt: timestamp,
      availableDecisions: ["approve_once", "approve_command_rule", "deny"],
      proposedCommandRule: {
        prefix: ["echo"],
        display: "echo",
        fingerprint: "fingerprint_echo",
        version: 1,
      },
    },
    {
      id: "approval_normal_whois",
      runId,
      actionType: "bash",
      risk: "medium",
      title: "Approve normal whois command",
      description: "whois example.com",
      payload: { type: "bash", command: "whois example.com" },
      status: "pending",
      createdAt: "2026-07-20T02:00:00.500Z",
      availableDecisions: ["approve_once", "approve_command_rule", "deny"],
      proposedCommandRule: {
        prefix: ["whois"],
        display: "whois",
        fingerprint: "fingerprint_whois",
        version: 1,
      },
    },
    {
      id: "approval_normal_edit",
      runId,
      actionType: "edit",
      risk: "low",
      title: "Approve normal file edit",
      description: "README.md",
      payload: { type: "file_edit", path: "README.md" },
      status: "pending",
      createdAt: "2026-07-20T02:00:01.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.route(/\/approvals\/approval_normal_edit\/deny(?:\?.*)?$/u, async (route) => {
    const approval = state.approvals.find((item) => item.id === "approval_normal_edit");
    const thread = state.threads.find((item) => item.id === threadId);
    if (!approval || !thread) {
      await route.fulfill({ status: 404, json: { error: "fixture_not_found" } });
      return;
    }
    approval.status = "denied";
    approval.resolvedAt = "2026-07-20T02:00:02.000Z";
    approval.resolvedBy = "local-user";
    setTimeout(() => {
      thread.status = "failed";
      thread.activeRunId = undefined;
      thread.updatedAt = approval.resolvedAt;
    }, 150);
    await route.fulfill({ json: { approval } });
  });
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const recentShell = navigation.locator(".sidebar-recent-row-shell").filter({ hasText: "Normal inline approvals" });
  const recentRow = recentShell.locator(".sidebar-recent-row");
  await expect(recentShell).toContainText("Waiting for approval");
  await recentRow.click();
  const conversation = page.getByLabel("Conversation page");
  const gate = conversation.getByRole("region", { name: "Allow this action?" });
  await expect(gate).toBeVisible();
  await expect(conversation.getByLabel("New conversation composer")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Allow this action?" })).toHaveCount(0);
  await expect(gate).toContainText("Run command: echo normal");
  await expect(gate).not.toContainText("Approve normal shell command");
  await expect(gate).not.toContainText("pending approvals");
  await expect(gate).not.toContainText("Approve normal file edit");
  await expect(gate.getByRole("button", { name: "Allow options" })).toBeVisible();
  const splitButton = gate.locator('[data-ling-split-button="true"]');
  const splitPrimary = splitButton.getByRole("button", { name: "Allow once" });
  const splitTrigger = splitButton.getByRole("button", { name: "Allow options" });
  const splitGeometry = await Promise.all([
    splitButton.boundingBox(),
    splitPrimary.boundingBox(),
    splitTrigger.boundingBox(),
  ]);
  expect(splitGeometry.every(Boolean)).toBe(true);
  expect(splitGeometry[1]!.y).toBe(splitGeometry[2]!.y);
  expect(splitGeometry[1]!.height).toBe(splitGeometry[2]!.height);
  expect(splitGeometry[1]!.x + splitGeometry[1]!.width).toBe(splitGeometry[2]!.x);
  expect(splitGeometry[0]!.height).toBe(splitGeometry[1]!.height + 2);
  await expect(splitButton).toHaveCSS("overflow", "hidden");
  await expect(splitPrimary).toHaveCSS("border-radius", "0px");
  await expect(splitTrigger).toHaveCSS("border-radius", "0px");
  const pendingMessage = conversation.locator(".normal-conversation-message-row.ai-teammate")
    .filter({ hasText: "Waiting for approval." });
  await expect(pendingMessage).toBeVisible();
  await expect(pendingMessage).not.toHaveClass(/message-bubble-chat-blocked/u);
  await expect(conversation.locator(".message-bubble-chat-blocked")).toHaveCount(0);
  await expect(conversation.locator(".normal-conversation-message-row.local-user")).not.toHaveClass(/message-bubble-chat-blocked/u);
  await expect(conversation.getByText("Run the gated command.", { exact: true })).toHaveCount(1);
  await expect(conversation.locator(".normal-conversation-message-error")).toHaveCount(0);
  await expect(pendingMessage.locator(".message-body-paragraph")).toHaveCount(2);
  await expect(pendingMessage.locator(".message-body-paragraph code")).toHaveText("node --test");
  await expect(pendingMessage.locator(".normal-conversation-message-actions")).toHaveCount(0);
  const pendingMessageContent = pendingMessage.locator(":scope > .message-content");
  await expect(pendingMessageContent).toHaveCSS("padding-top", "0px");
  await expect(pendingMessageContent).toHaveCSS("padding-left", "0px");
  const pendingMessageTrailingSpace = await pendingMessageContent.evaluate((content) => {
    const contentStyle = getComputedStyle(content);
    const visibleFlowChildren = Array.from(content.children).filter((child) => {
      const style = getComputedStyle(child);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity) > 0
        && style.position !== "absolute";
    });
    const contentRect = content.getBoundingClientRect();
    const lastVisibleChildRect = visibleFlowChildren.at(-1)?.getBoundingClientRect();
    return {
      actual: contentRect.bottom - (lastVisibleChildRect?.bottom ?? contentRect.top),
      expected: Number.parseFloat(contentStyle.paddingBottom) + Number.parseFloat(contentStyle.borderBottomWidth),
    };
  });
  expect(Math.abs(pendingMessageTrailingSpace.actual - pendingMessageTrailingSpace.expected)).toBeLessThanOrEqual(1);
  await expect(pendingMessage).toContainText("Waiting for approval.");
  await expect(conversation.locator('[data-approval-presentation-owner="composer_gate"]')).toHaveCount(0);
  await expect(conversation.locator(".conversation-work-cell")).toHaveCount(0);
  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByLabel("Conversation home")).toBeVisible();
  await recentRow.click();
  await expect(gate).toBeVisible();

  await gate.getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_normal_shell")?.status).toBe("approved");
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_normal_shell")?.decisionKind).toBe("approve_once");
  expect(state.approvalCommandRules).toHaveLength(0);
  await expect(gate).toContainText("Run command: whois example.com");
  await gate.getByRole("button", { name: "Allow options" }).click();
  const allowSimilarCommand = page.getByRole("menuitem", { name: /Allow similar commands/ });
  await expect(allowSimilarCommand).toContainText("this workspace");
  await allowSimilarCommand.click();
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_normal_whois")?.decisionKind).toBe("approve_command_rule");
  await expect.poll(() => state.approvalCommandRules.find((rule) => !rule.revokedAt)?.display).toBe("whois");
  expect(state.approvalDecisionRequests.find((request) => request.approvalId === "approval_normal_whois")?.body).toEqual({
    decisionKind: "approve_command_rule",
    proposedRuleFingerprint: "fingerprint_whois",
  });
  await expect(gate).toContainText("Modify file: README.md");
  await expect(gate).not.toContainText("Approve normal file edit");
  await expect(gate).not.toContainText("pending approvals");
  await expect(gate.getByRole("button", { name: "Allow options" })).toHaveCount(0);

  await gate.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_normal_edit")?.status).toBe("denied");
  await expect(gate).toHaveCount(0);
  await expect(conversation.getByLabel("New conversation composer")).toBeVisible();
  await expect(recentShell).not.toContainText("Waiting for approval");

  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Default authorization" }).click();
  const commandRules = page.getByRole("region", { name: "Terminal command rules" });
  await expect(commandRules).toContainText("whois");
  await commandRules.getByRole("button", { name: "Revoke" }).click();
  await expect(commandRules).toContainText("No saved command rules");
  await expect.poll(() => state.approvalCommandRules.find((rule) => rule.display === "whois")?.revokedAt).toBeTruthy();
});

test("teammate private chat resolves its runtime approval through its composer gate", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_private_approval";
  const runId = "run_private_approval";
  const directThreadId = `tdthread_${teammateId}`;
  const executionThreadId = "thread_private_approval";
  const sourceMessageId = "tdmsg_private_approval_source";
  const replyMessageId = "tdmsg_private_approval_reply";
  const workUnitId = "work_unit_private_approval";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Private Approver" })];
  state.runs.unshift({
    ...state.runs[0],
    id: runId,
    channelId: undefined,
    taskId: undefined,
    teammateId,
    threadId: executionThreadId,
    workUnitId,
    status: "waiting_for_approval",
    updatedAt: "2026-07-20T03:00:00.000Z",
  });
  state.workUnits = [{
    id: workUnitId,
    workspaceId: "workspace_default",
    kind: "teammate_direct_reply",
    ownerType: "teammate_direct_message",
    ownerId: sourceMessageId,
    teammateId,
    idempotencyKey: workUnitId,
    status: "waiting_for_approval",
    priority: 0,
    attemptCount: 1,
    createdByActor: "user",
    request: { sourceMessageId },
    timeoutPolicy: {
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 45_000,
      idleTimeoutMs: 600_000,
      hardTimeoutMs: 3_600_000,
      cancelGraceMs: 15_000,
    },
    linkedRunId: runId,
    linkedMessageId: replyMessageId,
    createdAt: "2026-07-20T03:00:00.000Z",
    updatedAt: "2026-07-20T03:00:00.000Z",
  }];
  state.teammateDirectMessages = [
    {
      id: sourceMessageId,
      workspaceId: "workspace_default",
      threadId: directThreadId,
      teammateId,
      authorType: "local-user",
      authorId: "local-user",
      body: "Please update the private notes.",
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-20T02:59:59.000Z",
      updatedAt: "2026-07-20T02:59:59.000Z",
    },
    {
      id: replyMessageId,
      workspaceId: "workspace_default",
      threadId: directThreadId,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "Waiting for the private approval.",
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "pending",
      linkedRunId: runId,
      createdAt: "2026-07-20T03:00:00.000Z",
      updatedAt: "2026-07-20T03:00:00.000Z",
    },
  ];
  state.approvals = [{
    id: "approval_private_bash",
    runId,
    actionType: "bash",
    risk: "medium",
    title: "Approve private command",
    description: "whois private.example",
    payload: { type: "bash", command: "whois private.example" },
    status: "pending",
    createdAt: "2026-07-20T03:00:00.000Z",
    availableDecisions: ["approve_once", "approve_command_rule", "deny"],
    proposedCommandRule: {
      prefix: ["whois"],
      display: "whois",
      fingerprint: "fingerprint_private_whois",
      version: 1,
    },
  }];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Private Approver" }).click();
  const gate = page.getByRole("region", { name: "Allow this action?" });
  const composerOwner = page.locator(".teammate-private-chat > .teammate-private-composer-owner");
  await expect(composerOwner).toContainText("Allow this action?");
  const gateBounds = await gate.boundingBox();
  const feedBounds = await page.locator(".teammate-private-feed-owner").boundingBox();
  expect(gateBounds).not.toBeNull();
  expect(feedBounds).not.toBeNull();
  expect(gateBounds!.x).toBeGreaterThanOrEqual(feedBounds!.x);
  expect(gateBounds!.x + gateBounds!.width).toBeLessThanOrEqual(feedBounds!.x + feedBounds!.width + 1);
  await expect(page.locator(".teammate-direct-composer")).toHaveCount(0);
  await expect(gate).toContainText("Run command: whois private.example");
  await expect(gate).not.toContainText("Approve private command");
  const pendingMessage = page.locator(".teammate-private-feed-owner .teammate-message-row.ai-teammate")
    .filter({ hasText: "Waiting for the private approval." });
  await expect(pendingMessage).toBeVisible();
  await expect(pendingMessage.locator(".teammate-message-actions")).toHaveCount(0);
  await expect(pendingMessage).toContainText("Waiting for the private approval.");
  await expect(page.locator('.teammate-private-feed-owner [data-approval-presentation-owner="composer_gate"]')).toHaveCount(0);
  await expect(page.locator(".teammate-private-feed-owner .conversation-work-cell")).toHaveCount(0);
  await gate.getByRole("button", { name: "Allow options" }).click();
  await page.getByRole("menuitem", { name: /Allow similar commands/ }).click();
  await expect.poll(() => state.approvals[0]?.decisionKind).toBe("approve_command_rule");
  await expect.poll(() => state.approvalCommandRules[0]?.display).toBe("whois");
  await expect(gate).toHaveCount(0);
  await expect(page.locator(".teammate-direct-composer")).toBeVisible();
});

test("normal conversation full access confirms before creating the run", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5", lastCheck: readyProviderCheck })];
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "always",
    defaultWorkspaceAccessMode: "full_access",
    defaultPermissionMode: "full_access",
    defaultPermissionPreset: "full_access",
  };
  state.runs = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  await expect(home.getByRole("button", { name: /Selected permission preset Full access/ })).toBeVisible();
  await home.getByRole("textbox", { name: "Conversation message" }).fill("Inspect trusted files");
  await home.getByRole("button", { name: "Send" }).click();

  const confirmSheet = page.getByRole("dialog", { name: "Confirm full access" });
  await expect(confirmSheet).toBeVisible();
  await expect(confirmSheet).toHaveClass(/ling-ui-dialog-content/u);
  await confirmSheet.getByRole("button", { name: "Cancel" }).last().click();
  await expect(confirmSheet).toHaveCount(0);
  expect(state.runs).toHaveLength(0);
  await expect(home.getByRole("textbox", { name: "Conversation message" })).toHaveAttribute("data-value", "Inspect trusted files");

  await home.getByRole("button", { name: "Send" }).click();
  await page.getByRole("dialog", { name: "Confirm full access" }).getByRole("button", { name: "Start with full access" }).click();
  await expect.poll(() => state.runs.length).toBe(1);
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.permissionConfirmation : undefined;
  }).toMatchObject({
    mode: "full_access",
    confirmed: true,
    reason: "user_confirmed_full_access",
  });
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? [snapshot.authorizationMode, snapshot.workspaceAccessMode] : [];
  }).toEqual(["always", "full_access"]);
  await expect(page.getByRole("dialog", { name: "Allow this action?" })).toHaveCount(0);
});

test("normal conversation composer sends and replays uploaded attachments", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5", lastCheck: readyProviderCheck })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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
  const conversationToolbar = page.locator("[data-desktop-window-titlebar-surface='true']")
    .getByLabel("Conversation workspace toolbar");
  await expect(conversationToolbar.getByRole("button", { name: /^Files/ })).toHaveCount(0);
  await conversationToolbar.getByRole("button", { name: "Show details" }).click();
  const conversationDock = page.getByLabel("Conversation workspace dock");
  await expect(conversationDock).toBeVisible();
  await conversationDock.getByRole("button", { name: "Files" }).click();
  await expect(conversationDock.locator(".right-dock-head-page")).toContainText("Files");
  await expect(conversationDock).toContainText("brief.txt");
});

test("normal conversation renders the shared GFM, Mermaid, and math pipeline", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_normal_rich_content";
  const turnId = "turn_normal_rich_content";
  const runId = "run_normal_rich_content";
  const createdAt = "2026-07-12T03:00:00.000Z";
  const completedAt = "2026-07-12T03:01:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Shared rich content",
    objective: "Verify shared rich content",
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
    title: "Shared rich content",
    userInstruction: "Show the shared rich content fixture.",
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
    taskId: "task_normal_rich_content",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_normal_rich_content", title: "Shared rich content" },
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
    id: "event_normal_rich_content",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: `${sharedConversationRichBody}\n\nReference: apps/web/src/features/workspace/ConversationHome.tsx#L260` },
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: "Shared rich content" }).click();

  const pageSurface = page.getByLabel("Conversation page");
  const assistantRow = pageSurface.locator(".normal-conversation-message-row.ai-teammate");
  await expect(assistantRow).toHaveCount(1);
  await expect(assistantRow.locator(".teammate-avatar-image, .teammate-avatar-stack")).toHaveCount(0);
  await expectSharedConversationRichBody(assistantRow);
  const displayOnlyFileRef = assistantRow.locator("span.message-local-file-link")
    .filter({ hasText: "ConversationHome.tsx" });
  await expect(displayOnlyFileRef).toBeVisible();
  await expect(displayOnlyFileRef).toHaveAttribute("title", "apps/web/src/features/workspace/ConversationHome.tsx#L260");
  await expect(assistantRow.getByRole("button", { name: /ConversationHome\.tsx/ })).toHaveCount(0);
  await expect(page.getByLabel("Conversation workspace dock")).toHaveCount(0);
});

test("latest normal conversation prompt edits in place and hides the superseded response", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_normal_edit";
  const turnId = "turn_normal_edit";
  const runId = "run_normal_edit";
  const createdAt = "2026-07-12T03:10:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Editable normal prompt",
    objective: "Original normal prompt",
    status: "succeeded",
    lastRunId: runId,
    createdAt,
    updatedAt: createdAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title: "Original normal prompt",
    userInstruction: "Original normal prompt",
    activeRunId: runId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt }];
  state.runs = [{
    id: runId,
    status: "succeeded",
    cwd,
    taskId: "task_normal_edit",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_normal_edit", title: "Original normal prompt" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
    endedAt: createdAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_normal_edit_old",
    runId,
    seq: 1,
    ts: createdAt,
    type: "assistant_text_delta",
    data: { text: "Old normal response should disappear." },
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: "Editable normal prompt" }).click();

  const conversationPage = page.getByLabel("Conversation page");
  const userRow = conversationPage.locator(".normal-conversation-message-row.local-user");
  await userRow.hover();
  await userRow.getByRole("button", { name: "Edit message" }).click();
  const editor = conversationPage.getByLabel("Edit message");
  await editor.fill("Revised normal prompt");
  await conversationPage.getByRole("button", { name: "Save and resend" }).click();

  await expect(conversationPage).toContainText("Revised normal prompt");
  await expect(conversationPage).toContainText("Ling Agent response: Revised normal prompt");
  await expect(conversationPage).not.toContainText("Original normal prompt");
  await expect(conversationPage).not.toContainText("Old normal response should disappear.");
  await expect.poll(() => state.lastConversationMessageEditRequest?.surface).toBe("normal_conversation");
  await expect.poll(() => state.lastConversationMessageEditRequest?.messageId).toBe(`conversation-user:${turnId}`);
  const revisedUserRow = conversationPage.locator(".normal-conversation-message-row.local-user");
  await expect(revisedUserRow).toContainText("Edited");
  await revisedUserRow.hover();
  await expect(revisedUserRow.getByRole("button", { name: "Edit message" })).toBeVisible();
  await revisedUserRow.getByRole("button", { name: "Edit message" }).click();
  await conversationPage.getByLabel("Edit message").fill("Revised normal prompt again");
  await conversationPage.getByRole("button", { name: "Save and resend" }).click();

  await expect(conversationPage).toContainText("Revised normal prompt again");
  await expect.poll(() => state.lastConversationMessageEditRequest?.expectedRevision).toBe(2);
});

test("executed normal conversation retains one useful supplemental terminal report", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`${message.text()} @ ${message.location().url || "unknown"}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1000, height: 360 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_terminal_report_conversation";
  const turnId = "turn_terminal_report_conversation";
  const runId = "run_terminal_report_conversation";
  const priorRunId = "run_terminal_report_conversation_prior";
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
  state.turnRunLinks = [
    { turnId, runId, attemptNumber: 2, role: "primary", createdAt: "2026-07-11T03:00:30.000Z" },
    { turnId, runId: priorRunId, attemptNumber: 1, role: "retry", createdAt },
  ];
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
    createdAt: "2026-07-11T03:00:30.000Z",
    startedAt: "2026-07-11T03:00:30.000Z",
    updatedAt: completedAt,
    endedAt: completedAt,
  }, {
    id: priorRunId,
    status: "failed",
    cwd,
    taskId: "task_terminal_report_conversation_prior",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_terminal_report_conversation_prior", title: "旧尝试" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${priorRunId}.jsonl`,
    threadId,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: "2026-07-11T03:00:20.000Z",
    endedAt: "2026-07-11T03:00:20.000Z",
    errorMessage: "prior attempt failed",
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_terminal_report_assistant_text",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "旧的执行总结不应和结构化报告重复展示。" },
  }];
  state.artifactsByRun[runId] = [{
    id: "artifact_terminal_report_conversation",
    runId,
    type: "markdown",
    title: "ConversationHome.tsx",
    path: `${runId}/001-conversation-home.md`,
    contentType: "text/markdown",
    createdAt: completedAt,
  }];
  state.executionActions = [
    mockCommandExecutionAction("normal_typecheck", threadId, runId, "corepack pnpm --filter @ling-stack/web typecheck", "2026-07-11T03:00:40.000Z", 1200),
    mockCommandExecutionAction("normal_i18n", threadId, runId, "corepack pnpm --filter @ling-stack/web check:i18n", "2026-07-11T03:00:42.000Z", 700),
    mockCommandExecutionAction("normal_diff", threadId, runId, "git diff --check", "2026-07-11T03:00:44.000Z", 300),
    mockCommandExecutionAction("normal_prior", threadId, priorRunId, "echo prior attempt", "2026-07-11T03:00:10.000Z", 200),
    ...state.executionActions,
  ];
  state.terminalReports = [{
    schemaVersion: 1,
    id: "terminal_report_conversation",
    generation: 1,
    resultItemId: "result_terminal_report_conversation",
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
      corrections: [{
        id: "correction_terminal_report_conversation",
        originalAssumption: "Only provider narration contains the final file evidence.",
        correctedFact: "Committed report evidence owns the final file summary.",
        confidence: "high",
        sourceRefs: [],
      }],
      sourceRefs: [{ kind: "turn", id: turnId, visibility: "conversation" }],
    },
    changes: Array.from({ length: 12 }, (_, index) => ({
      id: `change_terminal_report_conversation_${index}`,
      kind: "code" as const,
      title: index === 0
        ? "apps/web/src/features/workspace/ConversationHome-1.tsx"
        : index === 1
          ? "保留有意义的变更说明"
          : `${runId}/${String(index).padStart(3, "0")}-read-content.md`,
      summary: index === 0
        ? "已更新 apps/web/src/features/workspace/ConversationHome-1.tsx"
        : "普通会话读取执行轮关联的结构化报告，并在展开后保持完整滚动能力。",
      paths: [index === 0
        ? "apps/web/src/features/workspace/ConversationHome-1.tsx"
        : index === 1
          ? "apps/web/src/features/workspace/ConversationHome-2.tsx"
          : `${runId}/${String(index).padStart(3, "0")}-read-content.md`],
      addedLines: 18 + index,
      deletedLines: 2,
      sourceRefs: [],
    })),
    verification: [{
      id: "check_terminal_report_conversation",
      title: "Web typecheck",
      status: "passed",
      command: "corepack pnpm --filter @ling-stack/web typecheck",
      sourceRefs: [],
    }],
    participants: [],
    artifacts: [
      {
        id: "artifact_terminal_report_conversation",
        kind: "file",
        title: "ConversationHome.tsx",
        path: `${runId}/001-conversation-home.md`,
        sourceRefs: [{
          kind: "file",
          id: "apps/web/src/features/workspace/ConversationHome-1.tsx",
          visibility: "conversation",
        }],
      },
      {
        id: "artifact_terminal_report_metadata",
        kind: "other",
        title: "Generated file metadata: ConversationHome.tsx",
        path: `${runId}/generated-file-metadata.txt`,
        sourceRefs: [],
      },
      {
        id: "artifact_terminal_report_action_preview",
        kind: "other",
        title: "Action preview: bash",
        path: `${runId}/actions/approval_1/preview.json`,
        sourceRefs: [],
      },
    ],
    risks: [],
    references: [
      { kind: "turn", id: turnId, label: "User task", visibility: "conversation" },
      { kind: "run", id: runId, label: "Ling Agent run", visibility: "conversation" },
      { kind: "artifact", id: "artifact_terminal_report_metadata", label: "Generated file metadata: ConversationHome.tsx", visibility: "conversation" },
      { kind: "file", id: "apps/web/src/features/workspace/ConversationHome-1.tsx", label: "ConversationHome.tsx", visibility: "conversation" },
    ],
    evidenceSnapshotId: "snapshot_terminal_report_conversation",
    evidenceFingerprint: "fingerprint_terminal_report_conversation",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: completedAt,
    committedAt: completedAt,
  }];
  state.conversationContextSnapshotsByThreadId = {
    ...(state.conversationContextSnapshotsByThreadId ?? {}),
    [threadId]: [{
      id: "snapshot_terminal_report_conversation_context",
      threadId,
      segmentId: "segment_terminal_report_conversation",
      projectionVersion: "terminal-report-conversation-v1",
      throughItemSequence: 3,
      summaryIds: [],
      sourceRefs: [
        { type: "conversation_item", id: `conversation-user:${turnId}` },
        { type: "conversation_item", id: `conversation-assistant:${turnId}` },
        { type: "conversation_item", id: "result_terminal_report_conversation" },
      ],
      policyVersion: "terminal-report-conversation-v1",
      createdAt: completedAt,
    }],
  };

  await mockDaemon(page, state);
  await page.route(/\/workspace-files\/preview(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ref: {
          id: `workspace:${path}`,
          source: "workspace_file",
          scope: "workspace",
          label: path.split("/").at(-1) ?? path,
          displayPath: path,
          previewable: true,
        },
        kind: "code",
        text: "export const terminalReportWorkspacePreview = true;\n",
        truncated: false,
        redactionNotes: [],
      }),
    });
  });
  await page.route(new RegExp(`/turns/${turnId}/workspace-changes(?:\\?.*)?$`, "u"), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd,
        threadId,
        turnId,
        runIds: [runId],
        state: "unavailable",
        canUndo: false,
        canReapply: false,
        files: [],
        summary: {
          fileCount: 0,
          addCount: 0,
          updateCount: 0,
          deleteCount: 0,
          moveCount: 0,
          addedLines: 0,
          removedLines: 0,
        },
        provenanceComplete: false,
        unavailableReason: "Recovery evidence is outside this rendering fixture.",
        updatedAt: completedAt,
      }),
    });
  });
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.locator(".sidebar-recent-row").filter({ hasText: "实现结构化终局报告" }).click();

  const conversationPage = page.getByLabel("对话页面");
  const timeline = conversationPage.locator('[data-conversation-timeline-depth="0"]').first();
  const assistantRow = conversationPage.locator(".normal-conversation-message-row.ai-teammate");
  await expect(assistantRow).toHaveCount(1);
  // The provider text is narration only. Commands and the committed result
  // remain sibling typed items in the single canonical Timeline.
  await expect(assistantRow).toContainText("旧的执行总结不应和结构化报告重复展示。");
  await expect(assistantRow).not.toContainText("ConversationHome.tsx");
  await expect(assistantRow.locator(".terminal-report-block")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await timeline.locator('[data-conversation-process-header][aria-expanded="false"]').click();
  const commandBatch = timeline.locator('[data-conversation-timeline-kind="commandBatch"]');
  await expect(commandBatch).toHaveCount(1);
  await expect(commandBatch.locator(".conversation-command-batch-header")).toContainText("已运行 3 个命令");
  await commandBatch.locator(".conversation-command-batch-header").click();
  await expect((await timelineBatchGroup(commandBatch)).locator('[data-conversation-timeline-kind="commandExecution"]')).toHaveCount(3);
  const typedCommand = (await timelineBatchGroup(commandBatch)).locator('[data-conversation-timeline-kind="commandExecution"]').first();
  await expect(typedCommand).toContainText("已运行命令 git diff --check");
  await typedCommand.locator(".conversation-timeline-activity-main").press("Enter");
  await expect(typedCommand.locator(".conversation-timeline-activity-main strong")).toHaveAttribute("title", "git diff --check");
  await expect(timeline).not.toContainText("echo prior attempt");

  const terminalResponse = timeline.locator(".conversation-timeline-terminal-response");
  const terminalReport = terminalResponse.locator('[data-conversation-timeline-kind="terminalReport"]');
  await expect(terminalResponse).toHaveCount(1);
  await expect(terminalResponse).toContainText("执行详情");
  await expect(terminalResponse).not.toContainText("结构化终局报告已接入普通会话");
  await terminalReport.locator(".conversation-timeline-activity-main").click();
  await expect(terminalResponse).toContainText("Committed report evidence owns the final file summary.");
  await expect(terminalResponse).toContainText("执行过程保留在工作记录中，最终结果由 TerminalReport 独立展示。");
  await expect(terminalResponse).toContainText("Web typecheck");
  await expect(terminalResponse).toContainText("ConversationHome-1.tsx");
  await expect(terminalResponse).toContainText("ConversationHome-2.tsx");
  await expect(terminalResponse).not.toContainText("Generated file metadata");
  await expect(terminalResponse).not.toContainText("Action preview");
  await expect(conversationPage.locator(".conversation-work-cell")).toHaveCount(0);
  const feed = page.locator(".normal-conversation-feed");
  const expandedMetrics = await feed.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(expandedMetrics.scrollHeight).toBeGreaterThan(expandedMetrics.clientHeight);
  await feed.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBe(0);
  await feed.evaluate((element) => {
    element.scrollTop = 120;
  });
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(runtimeErrors).toEqual([]);
});

test("persisted normal conversation without work evidence renders only the assistant reply", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_persisted_chat_only";
  const turnId = "turn_persisted_chat_only";
  const runId = "run_persisted_chat_only";
  const createdAt = "2026-07-11T04:00:00.000Z";
  const completedAt = "2026-07-11T04:00:09.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "欧哈呦",
    objective: "欧哈呦",
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
    title: "欧哈呦",
    userInstruction: "欧哈呦",
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
    taskId: "task_persisted_chat_only",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_persisted_chat_only", title: "欧哈呦" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    createdAt,
    startedAt: createdAt,
    updatedAt: completedAt,
    endedAt: completedAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_persisted_chat_only_assistant_text",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "欧哈呦！需要我帮你处理什么任务？" },
  }];
  state.terminalReports = [{
    schemaVersion: 1,
    id: "terminal_report_persisted_chat_only",
    workspaceId: "workspace_default",
    threadId,
    turnId,
    source: { kind: "turn", id: turnId },
    status: "fallback",
    language: "zh-CN",
    outcome: {
      status: "succeeded",
      title: "欧哈呦",
      summary: "任务已完成。",
      corrections: [],
      sourceRefs: [{ kind: "run", id: runId, visibility: "conversation" }],
    },
    changes: [],
    verification: [{
      id: "generic_check_persisted_chat_only",
      title: "欧哈呦",
      status: "passed",
      sourceRefs: [{ kind: "run", id: runId, visibility: "conversation" }],
    }],
    participants: [],
    artifacts: [],
    risks: [],
    references: [
      { kind: "turn", id: turnId, visibility: "conversation" },
      { kind: "run", id: runId, visibility: "conversation" },
    ],
    evidenceSnapshotId: "snapshot_persisted_chat_only",
    evidenceFingerprint: "fingerprint_persisted_chat_only",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: completedAt,
    committedAt: completedAt,
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.locator(".sidebar-recent-row").filter({ hasText: "欧哈呦" }).click();

  const assistantRow = page.getByLabel("对话页面").locator(".normal-conversation-message-row.ai-teammate");
  await expect(assistantRow).toContainText("欧哈呦！需要我帮你处理什么任务？");
  await expect(assistantRow.locator(".conversation-work-cell")).toHaveCount(0);
});

test("conversation home follows user language and shows thinking as off", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5", lastCheck: readyProviderCheck })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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
  await expect(navigation.getByRole("button", { name: "收件箱" })).toHaveCount(0);
});

test("sidebar text entries route to context-aware inspectors", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const primaryNav = navigation.locator(".primary-nav");
  await expect(navigation.getByRole("button", { name: "Search or start" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(primaryNav.getByRole("button")).toHaveText(["Media Production", "Plugin Manager", "Automations"]);
  await expect(primaryNav.getByRole("button", { name: "Inbox" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Profile" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "Plugin Manager" })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByLabel("Conversation home")).toBeVisible();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: [] });

  await primaryNav.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.locator(".plugin-manager-page .settings-plugin-manager")).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toBeVisible();

  await navigation.getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Plugin Manager" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await settingsSections.getByRole("button", { name: "Council Workspace" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  await expect(page.locator(".council-workspace-page[aria-label='Council Workspace']")).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: /^User profile$/ })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: /Interface preferences/ })).toBeVisible();
  await settingsSections.getByRole("button", { name: /^User profile$/ }).click();
  await expect(page.locator("[data-desktop-window-titlebar-surface='true']").getByRole("heading", { name: "User profile", level: 1 })).toBeVisible();
  await expect(page.locator(".settings-content-stack").getByRole("heading", { name: "User profile", level: 1 })).toHaveCount(0);
  await expect(page.locator('[data-profile-section="identity"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Identity information" })).toHaveCount(0);
  await expect(page.getByLabel("Handle")).toHaveCount(0);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Display preview" })).toHaveCount(0);
  await expect(page.getByLabel("Profile display preview")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Usage summary" })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await settingsSections.getByRole("button", { name: "Teammate Management" }).click();
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await page.getByRole("button", { name: "Back to app" }).click();

  await navigation.getByRole("button", { name: "Media Production" }).click();
  await expect(page.getByRole("navigation", { name: "Media production views" }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".media-production-canvas-toolbar")).toContainText("Production studio");
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await primaryNav.getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();

});

test("conversation home uses plus as the single attachment entry and keeps slash commands text-driven", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
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
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5", lastCheck: readyProviderCheck })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "New conversation" }).click();

  const home = page.getByLabel("Conversation home");
  await expect(home).toBeVisible();
  await expect(page.locator(".conversation-folder-popover")).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Select folder" })).toHaveCount(0);

  await home.getByRole("textbox", { name: "Conversation message" }).fill("Project scoped conversation");
  await home.getByRole("button", { name: "Send" }).click();

  const recentRow = navigation.locator(".sidebar-recent-row").first();
  await expect(recentRow).toContainText("Project scoped conversation");

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

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  const defaultUses = page.locator(".provider-default-purpose-bar");
  await defaultUses.getByLabel("Chat model").selectOption("provider_gemini");
  await expect(defaultUses.getByLabel("Chat model")).toHaveValue("provider_gemini");
  await expect(page.locator(".provider-row").getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to app" }).click();

  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  await expect(home.getByRole("button", { name: "Selected model gemini-2.5-pro" })).toBeVisible();
  const modelTrigger = home.getByRole("button", { name: "Selected model gemini-2.5-pro" });
  await expect(modelTrigger).toContainText("Off");
  await modelTrigger.click();
  const reasoning = page.getByRole("dialog", { name: "Thinking mode" });
  await expect(reasoning.getByRole("slider")).toHaveAttribute("max", "5");
  await reasoning.getByRole("button", { name: "Model options" }).click();
  const modelMenu = page.getByRole("dialog", { name: "Model options" });
  await expect(modelMenu.locator(".conversation-model-option")).toHaveCount(4);
  await expect(modelMenu.locator(".conversation-model-option").first()).toContainText("gemini-2.5-pro");
  await expect(modelMenu.locator(".conversation-model-default-option")).toContainText("Default");
  await expect(modelMenu).not.toContainText("gpt-image-2");
  const modelSearch = modelMenu.getByRole("textbox", { name: "Search models" });
  await expect(modelSearch).toBeFocused();
  await modelSearch.fill("gpt-4o");
  await expect(modelMenu.locator(".conversation-model-option")).toHaveCount(1);
  await modelMenu.getByRole("button", { name: /cliproxy-gpt-4o/ }).click();
  await expect(home.getByRole("button", { name: "Selected model cliproxy-gpt-4o" })).toBeVisible();
  await home.getByRole("button", { name: "Selected model cliproxy-gpt-4o" }).click();
  await expect(modelMenu).toBeVisible();
  await expect(modelMenu.getByRole("slider")).toHaveCount(0);
  await modelSearch.fill("sonnet");
  await modelMenu.getByRole("button", { name: /claude-sonnet-4/ }).click();
  const sonnet = home.getByRole("button", { name: "Selected model claude-sonnet-4" });
  await sonnet.click();
  await reasoning.getByRole("slider").focus();
  await reasoning.getByRole("slider").press("End");
  await reasoning.getByRole("slider").press("ArrowLeft");
  await expect(sonnet).toContainText("High");
  await page.keyboard.press("Escape");

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
  await expect(conversationPage.getByRole("button", { name: "Selected model claude-sonnet-4" })).toContainText("High");
});

test("settings keeps configuration tools embedded while Work Board stays hidden from global navigation", async ({ page }) => {
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

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Plugin Manager" })).toHaveCount(0);

  await settingsSections.getByRole("button", { name: "Model Workbench" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.locator(".provider-workbench[aria-label='Model Workbench']")).toBeVisible();
  await expect(page.locator("[data-desktop-window-titlebar-surface='true']").getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.locator(".provider-workbench").getByRole("heading", { name: "Model Workbench", level: 1 })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections).toBeVisible();

  await settingsSections.getByRole("button", { name: "Teammate Management" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.locator("[data-desktop-window-titlebar-surface='true']").getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.locator(".settings-content-stack").getByRole("heading", { name: "AI Teammates", level: 1 })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections).toBeVisible();

  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to app" }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toBeVisible();
  await expect(page.locator(".plugin-manager-page")).toBeVisible();
});
