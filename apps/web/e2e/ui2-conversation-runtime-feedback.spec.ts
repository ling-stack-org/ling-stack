import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, isRecord, type MockState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("channel runtime status and guidance use shared controls with a keyboard-safe menu", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = channelRuntimeFeedbackState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const status = page.locator(".channel-active-status-strip");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Run in progress");
  const statusActions = status.getByRole("button");
  await expect(statusActions).toHaveCount(2);
  await expectMinimumHitArea(statusActions.nth(0), 32);
  await expectMinimumHitArea(statusActions.nth(1), 32);

  const guidance = page.getByLabel("Run guidance");
  const row = guidance.locator(".conversation-guidance-row");
  await expect(row).toContainText("KeepThisLongQueuedGuidanceContained");
  const rowActions = row.getByRole("button");
  await expect(rowActions).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
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

  await expectContained(status, page.locator(".channel-composer"));
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

  const guidance = page.getByLabel("Run guidance");
  await expect(guidance).toBeVisible();
  await expect(guidance.locator(".conversation-guidance-row").filter({ hasText: "KeepThisLongQueuedGuidanceContained" })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("teammate runtime status and queued guidance stay contained in dark reduced motion", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = teammateRuntimeFeedbackState();
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const modelWarning = page.locator(".teammate-chat-header").getByRole("button", { name: "Model needs setup" });
  await expect(modelWarning).toBeVisible();
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
  await expectContained(modelWarning, page.locator(".teammate-chat-header"));
  await expectContained(row, guidance);
  await expectNoDocumentOverflow(page);
  await modelWarning.click();
  await expect(page.getByLabel("Model assignment")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

function channelRuntimeFeedbackState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.status = "running";
  run.errorMessage = undefined;
  run.workflowStepId = undefined;
  run.startedAt = "2026-07-23T09:00:00.000Z";
  run.updatedAt = "2026-07-23T09:01:00.000Z";
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

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
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
