import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  isRecord,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/raw-text-controls/first-wave/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";

test("Channel Create uses shared fields without changing validation, project search, or teammate invites", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-07-24T00:00:00.000Z",
    },
  })];
  state.channels = [];
  state.channelBranches = [];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  const teammateId = "teammate_channel_create_shared_input";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "Channel Input Reviewer",
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const trigger = page.getByLabel("Ling Stack navigation").getByRole("button", { name: "No channel yet" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "New channel" });
  let nameInput = dialog.getByLabel("Name");
  await expect(nameInput).toHaveAttribute("data-ling-control-native", "true");
  await expect(nameInput).toBeFocused();
  await expectInputContained(nameInput, dialog.locator(".channel-create-name-input"));

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "New channel" });
  nameInput = dialog.getByLabel("Name");
  await expect(dialog.getByRole("button", { name: "Create channel" })).toBeDisabled();
  await expect(dialog).toBeVisible();

  const teammate = dialog.locator(".channel-create-teammate").filter({ hasText: "Channel Input Reviewer" });
  await teammate.click();
  await expect(teammate).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Project directory" }).click();
  const projectSearch = dialog.getByRole("textbox", { name: "Search projects" });
  await expect(projectSearch).toHaveAttribute("data-ling-control-native", "true");
  await projectSearch.fill("no-project-matches-this-query");
  await expect(dialog.getByText("No matching projects")).toBeVisible();
  await expectInputContained(projectSearch, dialog.locator(".channel-create-project-search"));
  await projectSearch.fill("");
  const projectOption = dialog.getByRole("menuitemradio").first();
  await expect(projectOption).toBeVisible();
  await projectOption.click();

  await nameInput.fill("Shared utility controls");
  await expectNoOverflow(dialog);
  await captureSurface(page, "1440x960-ling-light-channel-create-inputs.png");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Shared utility controls")).toBe(true);
  const createdChannel = state.channels.find((channel) => isRecord(channel) && channel.name === "Shared utility controls");
  const createdChannelId = isRecord(createdChannel) && typeof createdChannel.id === "string" ? createdChannel.id : "";
  await expect.poll(() => state.teammateChannelMemberships.some((membership) =>
    isRecord(membership) && membership.channelId === createdChannelId && membership.teammateId === teammateId
  )).toBe(true);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("dark reduced-motion Channel terminal and topic reply keep command and keyboard behavior", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800, true);
  const state = createBaseState({ approvalStatus: "expired" });
  state.eventsByRun = {};
  state.channelMessages = [channelMessage({
    id: "message_shared_topic_root",
    body: "Open the shared-control topic reply.",
    authorType: "ai-teammate",
    authorId: "engineer",
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  await page.getByRole("button", { name: "Toggle bottom panel" }).click();
  const terminal = page.locator(".channel-bottom-terminal");
  const commandInput = terminal.getByRole("textbox", { name: "Command" });
  await expect(commandInput).toHaveAttribute("data-ling-control-native", "true");
  await expectInputContained(commandInput, terminal.locator(".workspace-terminal-command-input"));
  await expect(terminal.locator(".workspace-terminal-command-input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(terminal.locator(".workspace-terminal-command-input")).toHaveCSS("box-shadow", "none");
  await commandInput.fill("pwd");
  await commandInput.press("Enter");
  await expect.poll(() => state.terminalCommandRequests.length).toBe(1);
  expect(state.terminalCommandRequests[0]).toEqual({ cwd, command: "pwd" });
  await expect(terminal.locator(".workspace-terminal-output")).toContainText(cwd);
  await expectNoOverflow(terminal);
  await captureSurface(page, "1280x800-ling-dark-channel-terminal-input.png");
  await page.getByRole("button", { name: "Toggle bottom panel" }).click();

  const rootMessage = page.getByLabel("Channel message feed").locator(".channel-message-row.ai-teammate").filter({
    hasText: "Open the shared-control topic reply.",
  });
  await rootMessage.hover();
  await rootMessage.getByRole("button", { name: "Reply in topic" }).click();
  const topicPanel = page.getByLabel("Topic replies");
  const replyInput = topicPanel.getByRole("textbox", { name: "Topic reply input" });
  await expect(replyInput).toHaveAttribute("data-ling-control-native", "true");
  await expectTextareaFocusStable(replyInput, topicPanel);
  await replyInput.fill("First reply line");
  await replyInput.press("Shift+Enter");
  await expect(replyInput).toHaveValue("First reply line\n");
  await replyInput.type("Second reply line");
  await expectNoOverflow(topicPanel);
  await captureSurface(page, "1280x800-ling-dark-channel-topic-reply-input.png");
  await replyInput.press("Enter");
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({
    kind: "thread",
    threadId: "thread_topic_channel_engineering_message_shared_topic_root",
  });
  await expect(topicPanel).toContainText("First reply line");
  await expect(topicPanel).toContainText("Second reply line");
  await topicPanel.getByRole("button", { name: "Close topic" }).click();
  await expect(topicPanel).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Workflow conversion keeps preview, editing, owner selection, and blank-draft fallback on shared controls", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [{
    id: "thread_channel_main_channel_engineering",
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Main branch",
    objective: "Main conversation branch for Engineering.",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: "2026-07-24T01:59:00.000Z",
    updatedAt: "2026-07-24T01:59:00.000Z",
  }];
  const ownerId = "teammate_workflow_shared_input";
  state.aiTeammates = [createMockTeammate({ id: ownerId, displayName: "Workflow Owner" })];
  state.channelMessages = [channelMessage({
    id: "message_shared_workflow_preview",
    body: [
      "<proposed_plan title=\"Shared utility workflow\">",
      "1. Replace reachable raw controls.",
      "2. Verify focus containment.",
      "</proposed_plan>",
    ].join("\n"),
    authorType: "ai-teammate",
    authorId: "ling_agent",
    threadId: "thread_channel_main_channel_engineering",
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const trigger = page.getByLabel("Proposed plan").getByRole("button", { name: "Convert to workflow" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Workflow conversion preview" });
  await expect(dialog.getByRole("textbox", { name: "Draft title" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Edit draft" }).click();

  const titleInput = dialog.getByRole("textbox", { name: "Draft title" });
  const stepsInput = dialog.getByRole("textbox", { name: "Draft workflow steps" });
  await expect(titleInput).toHaveAttribute("data-ling-control-native", "true");
  await expect(stepsInput).toHaveAttribute("data-ling-control-native", "true");
  await expectInputContained(titleInput, dialog.locator(".workflow-preview-title-control"));
  await expectTextareaFocusStable(stepsInput, dialog);
  await titleInput.fill("Edited workflow title");
  await stepsInput.fill("1. Edited first step\n2. Edited second step");
  const firstOwner = dialog.getByRole("combobox", { name: "Owner for step 1" });
  await expect(firstOwner).toHaveClass(/ling-ui-select-native/u);
  const ownerShell = firstOwner.locator("xpath=..");
  await expect(ownerShell).toHaveClass(/ling-ui-select/u);
  await expect(ownerShell).toHaveAttribute("data-size", "sm");
  expect(await ownerShell.evaluate((element) => element.hasAttribute("data-select-control"))).toBe(false);
  await firstOwner.selectOption(ownerId);

  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(titleInput).toHaveCount(0);
  await dialog.getByRole("button", { name: "Edit draft" }).click();
  const restoredTitleInput = dialog.getByRole("textbox", { name: "Draft title" });
  const restoredStepsInput = dialog.getByRole("textbox", { name: "Draft workflow steps" });
  await expect(restoredTitleInput).toHaveValue("Edited workflow title");
  await expect(restoredStepsInput).toHaveValue("1. Edited first step\n2. Edited second step");

  await restoredTitleInput.fill("   ");
  await restoredStepsInput.fill("   ");
  await expectNoOverflow(dialog);
  await captureSurface(page, "1440x960-ling-light-workflow-shared-inputs.png");
  await dialog.getByRole("button", { name: "Save draft workflow" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.channelWorkflows.length).toBeGreaterThan(0);
  expect(isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].title : undefined).toBe("Shared utility workflow");
  expect(isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].objective : undefined).toBe(
    "Replace reachable raw controls.\nVerify focus containment.",
  );
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectInputContained(control: Locator, shell: Locator): Promise<void> {
  await waitForStableHeight(shell);
  const shellHeightBeforeFocus = await shell.evaluate((element) => element.getBoundingClientRect().height);
  await control.focus();
  await expect(control).toBeFocused();
  const geometry = await control.evaluate((element) => {
    const shellElement = element.parentElement;
    if (!shellElement) throw new Error("Shared Input shell is missing");
    const controlBox = element.getBoundingClientRect();
    const shellBox = shellElement.getBoundingClientRect();
    const controlStyle = getComputedStyle(element);
    return {
      controlBottom: controlBox.bottom,
      controlTop: controlBox.top,
      nativeBorder: controlStyle.borderTopWidth,
      nativeOutline: controlStyle.outlineStyle,
      shellBottom: shellBox.bottom,
      shellTop: shellBox.top,
    };
  });
  expect(Math.round(await shell.evaluate((element) => element.getBoundingClientRect().height))).toBe(Math.round(shellHeightBeforeFocus));
  expect(geometry.controlTop).toBeGreaterThanOrEqual(geometry.shellTop);
  expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.shellBottom);
  expect(geometry.nativeBorder).toBe("0px");
  expect(geometry.nativeOutline).toBe("none");
}

async function waitForStableHeight(locator: Locator): Promise<void> {
  let previousHeight = -1;
  let stableSamples = 0;
  await expect.poll(async () => {
    const height = await locator.evaluate((element) => element.getBoundingClientRect().height);
    stableSamples = Math.abs(height - previousHeight) <= 0.01 ? stableSamples + 1 : 0;
    previousHeight = height;
    return stableSamples >= 2;
  }).toBe(true);
}

async function expectTextareaFocusStable(control: Locator, boundary: Locator): Promise<void> {
  const before = await control.boundingBox();
  await control.focus();
  await expect(control).toBeFocused();
  const after = await control.boundingBox();
  expect(Math.round(after?.height ?? 0)).toBe(Math.round(before?.height ?? 0));
  await expect(control).toHaveCSS("outline-style", "none");
  await expectNoOverflow(boundary);
}

async function expectNoOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))).toEqual({ horizontal: 0, vertical: 0 });
}

async function captureSurface(page: Page, filename: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
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

function channelMessage(input: {
  readonly id: string;
  readonly body: string;
  readonly authorType: "ai-teammate" | "local-user";
  readonly authorId: string;
  readonly threadId?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    ...(input.threadId ? { threadId: input.threadId } : {}),
    kind: input.authorType === "ai-teammate" ? "ai_reply" : "message",
    intent: "discuss",
    authorType: input.authorType,
    authorId: input.authorId,
    body: input.body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-24T02:00:00.000Z",
    updatedAt: "2026-07-24T02:00:00.000Z",
  };
}
