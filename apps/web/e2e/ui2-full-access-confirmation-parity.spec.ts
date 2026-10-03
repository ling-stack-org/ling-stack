import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";
import { openEngineeringChannel, openTaskFromAttentionQueue } from "./support/test-helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    globalThis.confirm = () => {
      throw new Error("Browser confirm must not own Full Access confirmation");
    };
  });
});

test("channel permission selection confirms before changing the preset and run reuses that confirmation", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const channelDraft = composer.getByRole("textbox", {
    name: "Message this channel or @ an AI teammate",
    exact: true,
  });
  await channelDraft.fill("Keep this channel draft while starting the task");
  const permissionTrigger = composer.getByRole("button", { name: /Selected permission preset/ });
  const originalPreset = await permissionTrigger.textContent();
  await selectFullAccess(page, permissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(1);
  await expect(fullAccessDialog(page).locator('button[data-variant="secondary"]')).toBeFocused();
  await captureP6FeedbackEvidence(
    page,
    "shell/full-access-confirmation-parity",
    "1440x960-ling-light-channel-confirm-draft.png",
  );
  await page.keyboard.press("Escape");
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(permissionTrigger).toHaveText(originalPreset ?? "");
  await expect(channelDraft).toHaveAttribute("data-value", "Keep this channel draft while starting the task");
  expect(state.runs).toHaveLength(0);

  await selectFullAccess(page, permissionTrigger);
  await confirmFullAccessSelection(page);
  await expect(permissionTrigger).toContainText("Full access · Confirmed for this conversation");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const runButton = page.locator("article.task-detail").getByRole("button", { name: "Run", exact: true });
  await runButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(1);
  expect(readPermissionConfirmation(state.runs[0]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expect(permissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await runButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(2);
  expect(readPermissionConfirmation(state.runs[1]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation requires explicit confirmation and preserves the preset on cancel", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "New conversation" }).click();

  const home = page.getByLabel("Conversation home");
  const permissionTrigger = home.getByRole("button", { name: /Selected permission preset/ });
  const originalPreset = await permissionTrigger.textContent();
  await selectFullAccess(page, permissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(1);
  await fullAccessDialog(page).getByRole("button", { name: "Cancel" }).last().click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(permissionTrigger).toHaveText(originalPreset ?? "");
  expect(state.runs).toHaveLength(0);
  await selectFullAccess(page, permissionTrigger);
  await confirmFullAccessSelection(page);
  await expect(permissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await captureP6FeedbackEvidence(
    page,
    "shell/full-access-confirmation-parity",
    "1280x800-ling-dark-normal-explicit-selection-confirmed.png",
  );

  const input = home.getByRole("textbox", { name: "Conversation message" });
  const sendButton = home.getByRole("button", { name: "Send" });
  await input.fill("Inspect one trusted workspace");
  await sendButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(1);
  expect(readPermissionConfirmation(state.runs[0]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });

  const activeConversation = page.getByLabel("Conversation page");
  const activePermissionTrigger = activeConversation.getByRole("button", { name: /Selected permission preset/ });
  await expect(activePermissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await activeConversation.getByRole("textbox", { name: "Conversation message" }).fill("Continue in the same trusted conversation");
  await activeConversation.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(2);
  expect(readPermissionConfirmation(state.runs[1]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "New conversation" }).click();
  const nextHome = page.getByLabel("Conversation home");
  const nextPermissionTrigger = nextHome.getByRole("button", { name: /Selected permission preset/ });
  await selectFullAccess(page, nextPermissionTrigger);
  await confirmFullAccessSelection(page);
  await expect(nextPermissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await nextHome.getByRole("textbox", { name: "Conversation message" }).fill("Start another trusted conversation");
  await nextHome.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(3);
  expect(readPermissionConfirmation(state.runs[2]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });

  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /Open recent conversation/ }).first().click();
  const restoredConversation = page.getByLabel("Conversation page");
  const restoredPermissionTrigger = restoredConversation.getByRole("button", { name: /Selected permission preset/ });
  await selectFullAccess(page, restoredPermissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(restoredPermissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await restoredConversation.getByRole("textbox", { name: "Conversation message" }).fill("Continue after restarting the app");
  await restoredConversation.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(4);
  expect(readPermissionConfirmation(state.runs[3]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation confirms inherited full access on the first run", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "always",
    defaultWorkspaceAccessMode: "full_access",
    defaultPermissionMode: "full_access",
    defaultPermissionPreset: "full_access",
  };
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "New conversation" }).click();

  const home = page.getByLabel("Conversation home");
  const permissionTrigger = home.getByRole("button", { name: /Selected permission preset/ });
  await expect(permissionTrigger).toContainText("Full access");
  await expect(permissionTrigger).not.toContainText("Confirmed for this conversation");

  await home.getByRole("textbox", { name: "Conversation message" }).fill("Inspect inherited trusted files");
  await home.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(1);
  expect(state.runs).toHaveLength(0);

  await fullAccessDialog(page).getByRole("button", { name: "Start with full access" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(1);
  expect(readPermissionConfirmation(state.runs[0]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("teammate private chat confirms explicit selection per conversation", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  const teammateId = "teammate_full_access";
  const secondTeammateId = "teammate_full_access_second";
  state.aiTeammates = [
    createMockTeammate({
      id: teammateId,
      displayName: "Full Access Teammate",
      providerPresetId: "provider_full_access",
    }),
    createMockTeammate({
      id: secondTeammateId,
      displayName: "Second Full Access Teammate",
      providerPresetId: "provider_full_access",
    }),
  ];
  state.teammateDirectMessages = [];
  let directSendCount = 0;
  let secondDirectSendCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/teammates/${teammateId}/direct-messages/stream`)) {
      directSendCount += 1;
    }
    if (request.method() === "POST" && request.url().includes(`/teammates/${secondTeammateId}/direct-messages/stream`)) {
      secondDirectSendCount += 1;
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Full Access Teammate", exact: true }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });

  const chat = page.getByLabel("Private chat", { exact: true });
  const composer = chat.getByLabel("Private chat composer", { exact: true });
  const permissionTrigger = composer.getByRole("button", { name: /Selected permission preset/ });
  const originalPreset = await permissionTrigger.textContent();
  await selectFullAccess(page, permissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(permissionTrigger).toHaveText(originalPreset ?? "");
  expect(directSendCount).toBe(0);
  await selectFullAccess(page, permissionTrigger);
  await confirmFullAccessSelection(page);
  await expect(permissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await captureP6FeedbackEvidence(
    page,
    "shell/full-access-confirmation-parity",
    "1440x960-ling-light-teammate-explicit-selection-confirmed.png",
  );

  const input = composer.getByRole("textbox");
  const sendButton = composer.getByRole("button", { name: "Send" });
  await input.fill("Inspect private trusted files");
  await sendButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => directSendCount).toBe(1);
  await expect.poll(() => state.teammateDirectMessages.length).toBe(2);
  expect(state.lastTeammateDirectMessageRequest?.permissionPreset).toBe("full_access");
  expect(state.lastTeammateDirectMessageRequest?.workspaceAccessMode).toBe("full_access");
  expect(readPermissionConfirmation(state.lastTeammateDirectMessageRequest)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });

  await expect(permissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await input.fill("Continue with the same teammate");
  await sendButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => directSendCount).toBe(2);
  expect(readPermissionConfirmation(state.lastTeammateDirectMessageRequest)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });

  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Full Access Teammate", exact: true }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
  const restoredComposer = page.getByLabel("Private chat composer", { exact: true });
  const restoredPermissionTrigger = restoredComposer.getByRole("button", { name: /Selected permission preset/ });
  await selectFullAccess(page, restoredPermissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(restoredPermissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await restoredComposer.getByRole("textbox").fill("Continue after restarting the app");
  await restoredComposer.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => directSendCount).toBe(3);
  expect(readPermissionConfirmation(state.lastTeammateDirectMessageRequest)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Second Full Access Teammate" }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
  const nextComposer = page.getByLabel("Private chat composer", { exact: true });
  const nextPermissionTrigger = nextComposer.getByRole("button", { name: /Selected permission preset/ });
  await selectFullAccess(page, nextPermissionTrigger);
  await confirmFullAccessSelection(page);
  await expect(nextPermissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await nextComposer.getByRole("textbox").fill("Start with the second teammate");
  await nextComposer.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => secondDirectSendCount).toBe(1);
  expect(readPermissionConfirmation(state.lastTeammateDirectMessageRequest)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("teammate private chat confirms inherited full access on the first run", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  const teammateId = "teammate_inherited_full_access";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "Inherited Full Access Teammate",
    providerPresetId: "provider_full_access",
  })];
  state.teammateDirectMessages = [];
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "always",
    defaultWorkspaceAccessMode: "full_access",
    defaultPermissionMode: "full_access",
    defaultPermissionPreset: "full_access",
  };
  let directSendCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/teammates/${teammateId}/direct-messages/stream`)) {
      directSendCount += 1;
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Inherited Full Access Teammate", exact: true }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });

  const composer = page.getByLabel("Private chat composer", { exact: true });
  const permissionTrigger = composer.getByRole("button", { name: /Selected permission preset/ });
  await expect(permissionTrigger).toContainText("Full access");
  await expect(permissionTrigger).not.toContainText("Confirmed for this conversation");

  await composer.getByRole("textbox").fill("Inspect inherited trusted files");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(1);
  expect(directSendCount).toBe(0);
  expect(state.lastTeammateDirectMessageRequest).toBeUndefined();

  await fullAccessDialog(page).getByRole("button", { name: "Start with full access" }).click();
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect.poll(() => directSendCount).toBe(1);
  await expect.poll(() => state.teammateDirectMessages.length).toBe(2);
  expect(readPermissionConfirmation(state.lastTeammateDirectMessageRequest)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expect(permissionTrigger).toContainText("Full access · Confirmed for this conversation");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createFullAccessState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_full_access",
    displayName: "Full Access Relay",
    model: "gpt-5.5",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "ready",
      checkedAt: "2026-07-26T00:00:00.000Z",
    },
  })];
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: "provider_full_access" }
    : channel);
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "todo", currentRunId: undefined }
    : task);
  state.runs = [];
  return state;
}

async function selectFullAccess(page: Page, trigger: Locator): Promise<void> {
  await trigger.click();
  const menu = page.locator('[data-ling-overlay="menu"]').filter({
    has: page.getByRole("menuitemradio", { name: /Full access/ }),
  });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: /Full access/ }).click();
}

async function confirmFullAccessSelection(page: Page): Promise<void> {
  const dialog = fullAccessDialog(page);
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect(dialog).toHaveCount(0);
}

function fullAccessDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Confirm full access" });
}

function readPermissionConfirmation(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.permissionConfirmation) ? value.permissionConfirmation : undefined;
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript((value) => {
    const selection = { mode: "fixed", themeId: `ling-${value}` };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", value);
    localStorage.setItem("ling-stack.themeBootstrapPreference", value);
  }, theme);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console:${message.text()}`);
    }
  });
  return errors;
}
