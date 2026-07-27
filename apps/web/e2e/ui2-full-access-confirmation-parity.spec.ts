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

test("channel permission selection is immediate and run activation confirms exactly once", async ({ page }) => {
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
  await selectFullAccess(page, permissionTrigger);
  await expect(permissionTrigger).toContainText("Full access");
  await expect(fullAccessDialog(page)).toHaveCount(0);

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const runButton = page.locator("article.task-detail").getByRole("button", { name: "Run", exact: true });
  await runButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(1);
  await expect(fullAccessDialog(page).locator('button[data-variant="secondary"]')).toBeFocused();
  await captureP6FeedbackEvidence(
    page,
    "shell/full-access-confirmation-parity",
    "1440x960-ling-light-channel-confirm-draft.png",
  );
  await page.keyboard.press("Escape");
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(runButton).toBeFocused();
  await expect(channelDraft).toHaveAttribute("data-value", "Keep this channel draft while starting the task");
  expect(state.runs).toHaveLength(0);

  await runButton.click();
  const dialog = fullAccessDialog(page);
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(1);
  expect(readPermissionConfirmation(state.runs[0]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation cancel preserves draft and confirm sends one evidenced run", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New conversation" }).click();

  const home = page.getByLabel("Conversation home");
  const permissionTrigger = home.getByRole("button", { name: /Selected permission preset/ });
  await selectFullAccess(page, permissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(0);

  const input = home.getByRole("textbox", { name: "Conversation message" });
  const sendButton = home.getByRole("button", { name: "Send" });
  await input.fill("Inspect one trusted workspace");
  await sendButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(sendButton).toBeFocused();
  await expect(input).toHaveAttribute("data-value", "Inspect one trusted workspace");
  expect(state.runs).toHaveLength(0);
  await captureP6FeedbackEvidence(
    page,
    "shell/full-access-confirmation-parity",
    "1280x800-ling-dark-normal-cancel-preserves-draft.png",
  );

  await sendButton.click();
  const dialog = fullAccessDialog(page);
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.runs.length).toBe(1);
  expect(readPermissionConfirmation(state.runs[0]?.requestSnapshot)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("teammate private chat cancel is mutation-free and confirm sends one evidenced request", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createFullAccessState();
  const teammateId = "teammate_full_access";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "Full Access Teammate",
    providerPresetId: "provider_full_access",
  })];
  state.teammateDirectMessages = [];
  let directSendCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/teammates/${teammateId}/direct-messages/stream`)) {
      directSendCount += 1;
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Full Access Teammate" }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });

  const chat = page.getByLabel("Private chat", { exact: true });
  const composer = chat.getByLabel("Private chat composer", { exact: true });
  const permissionTrigger = composer.getByRole("button", { name: /Selected permission preset/ });
  await selectFullAccess(page, permissionTrigger);
  await expect(fullAccessDialog(page)).toHaveCount(0);

  const input = composer.getByRole("textbox");
  const sendButton = composer.getByRole("button", { name: "Send" });
  await input.fill("Inspect private trusted files");
  await sendButton.click();
  await expect(fullAccessDialog(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(fullAccessDialog(page)).toHaveCount(0);
  await expect(sendButton).toBeFocused();
  await expect(input).toHaveAttribute("data-value", "Inspect private trusted files");
  expect(directSendCount).toBe(0);
  expect(state.lastTeammateDirectMessageRequest).toBeUndefined();
  expect(state.teammateDirectMessages).toHaveLength(0);

  await sendButton.click();
  const dialog = fullAccessDialog(page);
  await expect(dialog).toHaveCount(1);
  await expect(dialog.locator('button[data-variant="secondary"]')).toBeFocused();
  await captureP6FeedbackEvidence(
    page,
    "shell/full-access-confirmation-parity",
    "1440x960-ling-light-teammate-confirm-draft.png",
  );
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => directSendCount).toBe(1);
  await expect.poll(() => state.teammateDirectMessages.length).toBe(2);
  expect(state.lastTeammateDirectMessageRequest?.permissionPreset).toBe("full_access");
  expect(state.lastTeammateDirectMessageRequest?.workspaceAccessMode).toBe("full_access");
  expect(readPermissionConfirmation(state.lastTeammateDirectMessageRequest)).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
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
