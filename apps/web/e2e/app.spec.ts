import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";
import {
  readSidebarSelection,
} from "./support/test-helpers";

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

test("sidebar selection is exclusive and conversation sections stay below primary navigation", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const primaryNav = navigation.locator(".primary-nav");
  const newConversationButton = navigation.getByRole("button", { name: "New conversation" });
  await expect(newConversationButton).toBeVisible();
  const commandButtonWidth = await newConversationButton.evaluate((button) => Math.round(button.getBoundingClientRect().width));
  expect(commandButtonWidth).toBeGreaterThan(140);
  expect(commandButtonWidth).toBeLessThan(220);
  await expect(primaryNav.getByRole("button")).toHaveText(["Inbox", "Image Generation", "Automations", "AI Councils"]);
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Recent conversations", exact: true })).toBeVisible();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: [] });

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await expect(navigation.getByText("Ada")).toHaveCount(0);
  await expect(navigation.getByText("Tian")).toHaveCount(0);
  await expect(navigation).toHaveClass(/channel-left-drawer/);
  await expect(page.locator(".channel-sidebar-toolbar")).toBeHidden();
  await expect(page.locator(".channel-left-drawer .primary-nav")).toHaveCSS("border-bottom-width", "0px");
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await navigation.locator('.sidebar-row:has(.avatar-initial):has-text("Designer")').click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Designer"] });
  const selectedTeammateRow = page.locator(".channel-left-drawer .sidebar-row.selected");
  await expect(selectedTeammateRow).toHaveCSS("background-color", "rgb(245, 245, 245)");
  expect(await selectedTeammateRow.evaluate((row) => getComputedStyle(row, "::before").content)).toBe("none");
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
});

test("sidebar sections collapse locally and keep group action menus", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
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
  await expect(navigation.locator('.sidebar-row:has(.avatar-initial):has-text("Designer")')).toHaveCount(0);
  await navigation.getByRole("button", { name: "AI Teammates" }).click();
  await expect(navigation.locator('.sidebar-row:has(.avatar-initial):has-text("Designer")')).toBeVisible();

  await navigation.getByRole("button", { name: "Recent conversations", exact: true }).click();
  await expect(recentConversationRow).toHaveCount(0);
  await navigation.getByRole("button", { name: "Recent conversations", exact: true }).click();
  await expect(recentConversationRow).toBeVisible();

  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await expect(page.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await navigation.getByRole("button", { name: "Teammate actions" }).click();
  await expect(page.getByRole("menuitem", { name: "New teammate" })).toBeVisible();
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
  await home.getByRole("textbox", { name: "Conversation message" }).fill("Plan launch");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(home.getByText("Conversation saved to recent conversations.")).toHaveCount(0);
  await expect(home.getByRole("textbox", { name: "Conversation message" })).toHaveValue("");
  await expect(home.getByLabel("Conversation messages")).toContainText("Plan launch");
  await expect(home.locator(".conversation-home-message.assistant")).toHaveCount(1);
  const messageThread = home.getByLabel("Conversation messages");
  const threadWidthBeforeHover = await messageThread.evaluate((element) => element.getBoundingClientRect().width);
  await expect.poll(() => messageThread.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe("thin");
  await messageThread.hover();
  await expect.poll(() => messageThread.evaluate((element) => element.getBoundingClientRect().width)).toBe(threadWidthBeforeHover);

  const recentRow = navigation.locator(".sidebar-recent-row").first();
  await expect(recentRow).toBeVisible();
  await expect(recentRow).toContainText("Plan launch");
  await expect(recentRow).toHaveClass(/selected/);
  await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible();
  await expect(navigation.locator('.sidebar-recent-row:has-text("Engineering")')).toHaveCount(0);
  await expect(navigation.locator('.sidebar-recent-row:has-text("Designer")')).toHaveCount(0);

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await home.getByRole("textbox", { name: "Conversation message" }).fill("Second local conversation");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(home.locator(".conversation-home-message.assistant")).toHaveCount(1);
  await expect(navigation.locator(".sidebar-recent-row").first()).toContainText("Second local conversation");
});

test("conversation home follows user language and shows thinking as off", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "Local Relay", model: "gpt-5.5" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "新建对话" }).click();
  const home = page.getByLabel("对话首页");
  await expect(home.getByText("思考关闭")).toBeVisible();
  await home.getByRole("textbox", { name: "对话内容" }).fill("你好");
  await home.getByRole("button", { name: "发送" }).click();
  await expect(home.locator(".conversation-home-message.assistant")).toHaveCount(1);
  await expect(home.getByText("Ling Agent 回复：你好")).toBeVisible();

  await navigation.getByRole("button", { name: "新建对话" }).click();
  await home.getByRole("textbox", { name: "对话内容" }).fill("hello");
  await home.getByRole("button", { name: "发送" }).click();
  await expect(home.locator(".conversation-home-message.assistant")).toHaveCount(1);
  await expect(home.getByText("Ling Agent response: hello")).toBeVisible();
});

test("sidebar text entries route to context-aware inspectors", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const primaryNav = navigation.locator(".primary-nav");
  await expect(navigation.getByRole("button", { name: "Search or start" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(primaryNav.getByRole("button")).toHaveText(["Inbox", "Image Generation", "Automations", "AI Councils"]);
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
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Account and profile/ })).toBeVisible();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Account and profile/ }).click();
  await expect(page.getByRole("heading", { name: "Ling User", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
  await page.getByLabel("Settings sections").getByRole("button", { name: /Configuration/ }).click();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();
  await page.getByRole("button", { name: "Open AI Teammates" }).click();
  await expect(page.locator(".teammates-page-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to configuration" })).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();

  await navigation.getByRole("button", { name: "Image Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Generation task status")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await primaryNav.getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();

  await primaryNav.getByRole("button", { name: "AI Councils" }).click();
  await expect(page.getByRole("heading", { name: "Council Workspace", level: 1 })).toBeVisible();
});

test("conversation home skill popover opens only from plus hover or focus", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Ling Stack" }).click();

  const home = page.getByLabel("Conversation home");
  await expect(home).toBeVisible();
  await expect(page.locator(".conversation-skill-popover")).toHaveCount(0);

  const skillButton = home.getByRole("button", { name: "Skills" });
  await skillButton.focus();
  await expect(page.locator(".conversation-skill-popover")).toBeVisible();

  await home.getByRole("textbox", { name: "Conversation message" }).focus();
  await expect(page.locator(".conversation-skill-popover")).toHaveCount(0);

  await skillButton.hover();
  const popover = page.locator(".conversation-skill-popover");
  await expect(popover).toBeVisible();
  await expect.poll(() => popover.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);

  const firstSkill = popover.locator(".conversation-skill-list button").first();
  const commandText = await firstSkill.locator("span").innerText();
  await firstSkill.click();
  await expect(home.getByRole("textbox", { name: "Conversation message" })).toHaveValue(commandText);
  await expect(page.locator(".conversation-skill-popover")).toHaveCount(0);
});

test("conversation home folder picker stores selected project paths on conversations", async ({ page }) => {
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

  await home.getByRole("button", { name: "Select folder" }).click();
  const folderMenu = page.getByRole("menu", { name: "Project folder options" });
  await expect(folderMenu).toBeVisible();
  await expect(folderMenu.getByText("Recent")).toHaveCount(0);
  await expect(folderMenu.getByRole("menuitem", { name: /Workspace default/ })).toHaveCount(0);
  await expect(folderMenu.getByRole("menuitem", { name: "Choose new project" })).toBeVisible();
  await expect(folderMenu.getByRole("menuitem", { name: "No project needed" })).toHaveCount(0);
  await expect.poll(() => folderMenu.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);

  await folderMenu.getByRole("menuitem", { name: "Choose new project" }).click();
  await expect(page.locator(".conversation-folder-popover")).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Selected folder projects" })).toBeVisible();

  await home.getByRole("button", { name: "Selected folder projects" }).click();
  await expect(folderMenu.getByText("Recent")).toBeVisible();
  await expect(folderMenu.getByRole("menuitem", { name: /projects/ })).toBeVisible();
  await expect(folderMenu.getByRole("menuitem", { name: /Workspace default/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await home.getByRole("textbox", { name: "Conversation message" }).fill("Project scoped conversation");
  await home.getByRole("button", { name: "Send" }).click();

  const recentRow = navigation.locator(".sidebar-recent-row").first();
  await expect(recentRow).toContainText("Project scoped conversation");
  await expect(recentRow).toContainText("Conversation");

  await home.getByRole("button", { name: "Selected folder projects" }).click();
  await expect(folderMenu.getByRole("menuitem", { name: "No project needed" })).toHaveCount(0);
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
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open Model Workbench" }).click();
  const geminiRow = page.locator(".provider-row").filter({ hasText: "Gemini Pro" });
  await geminiRow.getByRole("button", { name: "Set default" }).click();
  await expect(geminiRow.getByRole("button", { name: "Clear default" })).toBeVisible();

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

  await navigation.getByRole("button", { name: "New conversation" }).click();
  await expect(home.getByRole("button", { name: "Selected model gemini-2.5-pro" })).toBeVisible();

  await navigation.locator(".sidebar-recent-row").filter({ hasText: "Use Sonnet for this conversation" }).click();
  await expect(home.getByRole("button", { name: "Selected model claude-sonnet-4" })).toBeVisible();
  await expect(home.getByRole("button", { name: "Selected thinking mode High" })).toBeVisible();
});

test("settings workspace tools provide a clear return path from nested tool pages", async ({ page }) => {
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
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();

  await page.getByRole("button", { name: "Open Model Workbench" }).click();
  await expect(page.locator(".provider-workbench-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to configuration" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to configuration" }).click();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();

  await page.getByRole("button", { name: "Open AI Teammates" }).click();
  await expect(page.locator(".teammates-page-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to configuration" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toHaveCount(0);
  await page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Designer" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
  await expect(page.locator(".teammate-chat-header.has-toolbar-start .settings-tool-return-row").getByRole("button", { name: "Back to configuration" })).toBeVisible();
  await page.getByRole("button", { name: "Back to configuration" }).click();
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toBeVisible();

  await page.getByRole("button", { name: "Open Work Board" }).click();
  await expect(page.locator(".work-board-settings-toolbar .settings-tool-return-row").getByRole("button", { name: "Back to configuration" })).toBeVisible();
  await expect(page.locator(".work-board-page").getByRole("heading", { name: "Needs action" })).toHaveCount(0);
  await page.locator(".work-board-page").getByRole("button", { name: "Back to configuration" }).click();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();

  await navigation.getByRole("button", { name: "Designer" }).click();
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to configuration" })).toHaveCount(0);
});
