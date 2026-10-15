import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, isRecord, type MockState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

for (const theme of ["light", "dark"] as const) {
  for (const locale of ["en-US", "zh-CN"] as const) {
    test(`home model warning keeps its text aligned in ${theme} ${locale}`, async ({ page }, testInfo) => {
      await prepareSurface(page, theme, 1280, 800, locale);
      const runtimeErrors = collectRuntimeErrors(page);
      await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
      await page.goto("/");
      await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
        .getByRole("button", { name: locale === "zh-CN" ? "新建对话" : "New conversation", exact: true }).click();

      const home = page.locator(".conversation-home");
      const warning = home.locator(".normal-conversation-model-status");
      const title = warning.locator(".conversation-status-title > strong");
      const description = warning.locator(".conversation-status-main > p");
      const meta = warning.locator(".conversation-status-meta");
      const configure = warning.getByRole("button", { name: locale === "zh-CN" ? "配置模型" : "Configure model" });
      await expect(title).toHaveText(locale === "zh-CN" ? "模型需要配置" : "Model needs setup");
      await expect(description).toHaveText(locale === "zh-CN" ? "请先配置聊天模型再发送。" : "Please configure a chat model before sending.");
      await expect(description).toHaveCSS("text-align", "start");
      await expect(home.getByRole("heading", { level: 1 })).toHaveCSS("text-align", "center");
      await expect(meta).toBeVisible();
      await expect(configure).toBeEnabled();
      const titleBox = await title.boundingBox();
      const descriptionBox = await description.boundingBox();
      const metaBox = await meta.boundingBox();
      const warningBox = await warning.boundingBox();
      const actionBox = await configure.boundingBox();
      expect(Math.abs(titleBox!.x - descriptionBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(titleBox!.x - metaBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(actionBox!.y + actionBox!.height / 2 - warningBox!.y - warningBox!.height / 2)).toBeLessThanOrEqual(1);
      await expectContained(warning, home);
      await expectNoDocumentOverflow(page);
      const screenshot = testInfo.outputPath("model-setup-alignment.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("model-setup-alignment", { path: screenshot, contentType: "image/png" });

      await configure.click();
      await expect(page.getByRole("heading", { name: locale === "zh-CN" ? "模型工作台" : "Model Workbench", exact: true })).toBeVisible();
      expect(runtimeErrors).toEqual([]);
    });
  }
}

test("channel runtime status and guidance use shared controls with a keyboard-safe menu", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = channelRuntimeFeedbackState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator(".channel-active-status-strip")).toHaveCount(0);
  await expect(page.getByLabel("Channel composer").getByRole("button", { name: "Stop reply" })).toBeVisible();

  const guidance = page.getByLabel("Run guidance");
  const row = guidance.locator(".conversation-guidance-row");
  await expect(row).toContainText("KeepThisLongQueuedGuidanceContained");
  const rowActions = row.getByRole("button");
  await expect(rowActions).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expectMinimumHitArea(rowActions.nth(index), 32);
  }

  const more = row.getByRole("button", { name: "More guidance actions" });
  await more.focus();
  await more.press("Enter");
  const menu = page.getByRole("menu");
  const edit = menu.getByRole("menuitem", { name: "Edit message" });
  const close = menu.getByRole("menuitem", { name: "Close queue" });
  await expect(edit).toBeVisible();
  await expect(edit).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  await more.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("textbox", { name: "Message this channel or @ an AI teammate" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);

  await expectContained(row, guidance);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("channel removes accepted guidance from the queue while its continuation runs", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = channelRuntimeFeedbackState();
  state.runInterventions[0]!.status = "starting_continuation";
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByLabel("Run guidance")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation sends active-run guidance as one ordinary user message", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = normalRuntimeFeedbackState();
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: "Normal runtime feedback" }).click();

  const conversation = page.getByLabel("Conversation page");
  const composer = conversation.locator(".normal-conversation-composer");
  await expect(composer.getByRole("button", { name: "Stop" })).toBeVisible();
  const input = composer.getByLabel("Conversation message");
  await input.fill("Continue with the visible test results.");
  const send = composer.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();

  const guidanceRows = conversation.locator("[data-conversation-message-row].local-user").filter({
    hasText: "Continue with the visible test results.",
  });
  await expect(guidanceRows).toHaveCount(1);
  await expect(guidanceRows).toHaveAttribute("data-has-avatar", "false");
  await expect(input).toHaveText("");
  await expect(conversation.getByLabel("Run guidance")).toHaveCount(0);
  expect(state.runInterventions).toHaveLength(1);
  expect(state.runInterventions[0]?.messagePayload?.body).toBe("Continue with the visible test results.");
  expect(runtimeErrors).toEqual([]);
});

test("teammate runtime status and queued guidance stay contained in dark reduced motion", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = teammateRuntimeFeedbackState();
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Ling Engineer" }).click();
  const privateHeader = page.locator(".teammate-chat-header");
  const privateComposer = page.locator(".teammate-private-composer-owner");
  const modelWarning = privateComposer.locator(".teammate-model-status-strip");
  await expect(privateHeader.getByRole("button", { name: "Model needs setup" })).toHaveCount(0);
  await expect(modelWarning).toBeVisible();
  await expect(modelWarning).toContainText("Model needs setup");
  await expect(modelWarning).toContainText("No model selected");
  await expect(modelWarning.getByRole("button", { name: "Configure model" })).toBeVisible();
  await expect(page.locator(".teammate-chat-status-row")).toHaveCount(0);

  const guidance = page.getByLabel("Private guidance");
  const row = guidance.locator(".conversation-guidance-row");
  await expect(row).toContainText("Use the queued guidance before any new message");
  const rowActions = row.getByRole("button");
  await expect(rowActions).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expectMinimumHitArea(rowActions.nth(index), 32);
  }

  const more = row.getByRole("button", { name: "More guidance actions" });
  await more.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectContained(modelWarning, privateComposer);
  await expectContained(row, guidance);
  await expectNoDocumentOverflow(page);
  await modelWarning.getByRole("button", { name: "Configure model" }).click();
  await expect(page.getByLabel("Model assignment")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

function channelRuntimeFeedbackState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_local",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-23T09:00:00.000Z" },
  })];
  const run = state.runs[0];
  run.status = "running";
  run.errorMessage = undefined;
  run.workflowStepId = undefined;
  run.startedAt = "2026-07-23T09:00:00.000Z";
  run.updatedAt = "2026-07-23T09:01:00.000Z";
  run.threadId = "thread_channel_channel_engineering";
  run.teammateId = "ling_agent";
  run.workUnitId = "work_unit_ui2_runtime_feedback";
  run.requestSnapshot = { sourceMessageId: "message_ui2_runtime_feedback_source" };
  state.channelMessages = [{
    id: "message_ui2_runtime_feedback_source",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Start the runtime feedback reply.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-23T08:59:59.000Z",
    updatedAt: "2026-07-23T08:59:59.000Z",
  }];
  state.workUnits = [{
    id: "work_unit_ui2_runtime_feedback",
    workspaceId: "workspace_default",
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: "message_ui2_runtime_feedback_source",
    channelId: "channel_engineering",
    teammateId: "ling_agent",
    providerPresetId: "provider_local",
    idempotencyKey: "ui2-runtime-feedback-reply",
    status: "running",
    priority: 0,
    attemptCount: 1,
    createdByActor: "system",
    request: { sourceMessageId: "message_ui2_runtime_feedback_source" },
    timeoutPolicy: { claimTtlMs: 60_000, heartbeatTtlMs: 60_000, cancelGraceMs: 15_000 },
    linkedRunId: run.id,
    linkedMessageId: "message_ui2_runtime_feedback_reply",
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T09:01:00.000Z",
    startedAt: "2026-07-23T09:00:00.000Z",
  }];
  state.approvals = [];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === run.taskId
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  state.runInterventions = [{
    id: "intervention_ui2_runtime_feedback",
    workspaceId: "workspace_default",
    sourceRunId: run.id,
    mode: "queue_followup",
    status: "queued",
    instruction: `KeepThisLongQueuedGuidanceContained${"WithoutOverflow".repeat(24)}`,
    requestedBy: "local-user",
    idempotencyKey: "ui2-runtime-feedback",
    createdAt: "2026-07-23T09:01:10.000Z",
    updatedAt: "2026-07-23T09:01:10.000Z",
  }];
  return state;
}

function teammateRuntimeFeedbackState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateDirectThreads[teammateId] = {
    id: threadId,
    workspaceId: "workspace_default",
    teammateId,
    title: "Ling Engineer",
    createdAt: "2026-07-23T09:10:00.000Z",
    updatedAt: "2026-07-23T09:10:00.000Z",
  };
  state.teammateDirectInterventions = [{
    id: "tdint_ui2_runtime_feedback",
    workspaceId: "workspace_default",
    teammateId,
    threadId,
    sourceMessageId: "tdmsg_ui2_runtime_feedback",
    mode: "queue_followup",
    status: "queued",
    instruction: `Use the queued guidance before any new message ${"LongAttachmentName".repeat(18)}`,
    idempotencyKey: "ui2-runtime-feedback-private",
    requestedBy: "local-user",
    createdAt: "2026-07-23T09:10:01.000Z",
    updatedAt: "2026-07-23T09:10:01.000Z",
  }];
  return state;
}

function normalRuntimeFeedbackState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const cwd = state.runs[0]?.cwd ?? "/tmp/ling-stack";
  const threadId = "thread_normal_runtime_feedback";
  const turnId = "turn_normal_runtime_feedback";
  const runId = "run_normal_runtime_feedback";
  const createdAt = "2026-07-23T09:20:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Normal runtime feedback",
    objective: "Normal runtime feedback",
    status: "running",
    lastRunId: runId,
    createdAt,
    updatedAt: createdAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "running",
    title: "Normal runtime feedback",
    userInstruction: "Start the visible test run.",
    activeRunId: runId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt,
    updatedAt: createdAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt }];
  state.runs = [{
    id: runId,
    status: "running",
    cwd,
    taskId: "task_normal_runtime_feedback",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_normal_runtime_feedback", title: "Normal runtime feedback" },
    providerSnapshot: {},
    requestSnapshot: { providerPresetId: "provider_local" },
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [];
  state.runInterventions = [];
  return state;
}

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
  locale = "en-US",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ themeId, locale }) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, { themeId: theme, locale });
}

async function expectMinimumHitArea(locator: Locator, size: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(size);
  expect(box!.height).toBeGreaterThanOrEqual(size);
}

async function expectContained(child: Locator, owner: Locator): Promise<void> {
  const childBox = await child.boundingBox();
  const ownerBox = await owner.boundingBox();
  expect(childBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThanOrEqual(ownerBox!.x - 1);
  expect(childBox!.y).toBeGreaterThanOrEqual(ownerBox!.y - 1);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(ownerBox!.x + ownerBox!.width + 1);
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(ownerBox!.y + ownerBox!.height + 1);
  expect(await child.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
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
