import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  cwd,
  isRecord,
  type MockState,
} from "./support/mock-state";

const teammateId = "teammate_tasks_reviewer";
const teammateName = "Task Systems Reviewer";
const taskStatuses = ["todo", "claimed", "running", "blocked", "review", "done", "failed", "cancelled"] as const;
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-tasks/",
  import.meta.url,
));

test("Tasks navigation exposes the eight states and routes each task to its truthful owner", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.tasks = taskStatuses.map((status, index) => createTaskFixture({
    id: `task_state_${status}`,
    status,
    title: `State ${index + 1}: ${status}`,
    currentRunId: status === "running" ? "run_task_state_running" : undefined,
  }));
  state.runs = [{
    ...state.runs[0],
    id: "run_task_state_running",
    taskId: "task_state_running",
    status: "running",
    taskSnapshot: { id: "task_state_running", title: "State 3: running" },
  }];
  await mockDaemon(page, state);
  await routeTeammateTaskList(page, state);
  await page.goto("/");

  let tasks = await openTasks(page);
  await expectTasksToolbar(tasks);
  await expect(tasks.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
  const refreshAction = tasks.getByRole("button", { name: "Refresh tasks" });
  const openRunAction = tasks.locator('[data-task-id="task_state_running"]').getByRole("button", { name: "Open run" });
  const openWorkBoardAction = tasks.locator('[data-task-id="task_state_todo"]').getByRole("button", { name: "Open in Work Board" });
  await expectTypedIconButton(refreshAction, "Refresh tasks");
  await expectIconButtonTooltip(refreshAction, "Refresh tasks");
  await expectTypedIconButton(openRunAction, "Open run");
  await expectIconButtonTooltip(openRunAction, "Open run");
  await expectTypedIconButton(openWorkBoardAction, "Open in Work Board");
  await expectIconButtonTooltip(openWorkBoardAction, "Open in Work Board");
  await openRunAction.focus();
  await expect(openRunAction).toBeFocused();
  await expectTypedIconButton(openRunAction, "Open run");
  await expect(tasks.getByRole("button", { name: "Open Work Board", exact: true })).not.toHaveAttribute("data-ling-icon-button-contract");
  const rows = tasks.locator("[data-task-id]");
  await expect(rows).toHaveCount(taskStatuses.length);
  for (const status of taskStatuses) {
    const row = tasks.locator(`[data-task-id="task_state_${status}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(".ling-ui-status-indicator")).toHaveCount(1);
  }
  await captureEvidence(page, "1440x960-ling-light-mixed-states.png");

  await openRunAction.click();
  await expect(page.locator(".runs-panel")).toBeVisible();
  await expect(page.locator(".runs-panel")).toContainText("State 3: running");

  tasks = await openTasks(page);
  await tasks.locator('[data-task-id="task_state_todo"]').focus();
  await tasks.locator('[data-task-id="task_state_todo"]').press("Enter");
  await expect(page.locator(".work-board-page")).toBeVisible();
  await expect(page.locator(".work-board-page")).toContainText("State 1: todo");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Tasks keeps authoritative rows through initial delay and retained refresh failure", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.tasks = [createTaskFixture({ id: "task_retained", title: "Retained task truth" })];
  const initialGate = deferred<void>();
  let failRefresh = false;
  await mockDaemon(page, state);
  await page.route(new RegExp(`/teammates/${teammateId}/tasks(?:\\?.*)?$`, "u"), async (route) => {
    if (failRefresh) await route.fulfill({ status: 503, json: { error: "tasks_unavailable" } });
    else {
      await initialGate.promise;
      await route.fulfill({ json: { cwd, tasks: state.tasks } });
    }
  });
  await page.goto("/");

  const tasks = await openTasks(page);
  const refreshAction = tasks.getByRole("button", { name: "Refresh tasks" });
  await expect(tasks.getByLabel("Loading recent tasks")).toBeVisible();
  await expect(refreshAction).toBeDisabled();
  await expectTypedIconButton(refreshAction, "Refresh tasks");
  initialGate.resolve();
  await expect(tasks.locator('[data-task-id="task_retained"]')).toBeVisible();
  failRefresh = true;
  await tasks.getByRole("button", { name: "Refresh tasks" }).click();
  await expect(tasks.locator('[data-task-id="task_retained"]')).toBeVisible();
  await expect(tasks.locator(".ling-ui-inline-feedback")).toContainText("Recent tasks could not be loaded. Try again.");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Create invalidates an older in-flight task refresh", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.tasks = [createTaskFixture({ id: "task_before_refresh", title: "Task before refresh" })];
  const refreshGate = deferred<void>();
  let holdRefresh = false;
  await mockDaemon(page, state);
  await page.route(new RegExp(`/teammates/${teammateId}/tasks(?:\\?.*)?$`, "u"), async (route) => {
    const snapshot = [...state.tasks];
    if (holdRefresh) await refreshGate.promise;
    await route.fulfill({ json: { cwd, tasks: snapshot } });
  });
  await routeTaskCreate(page, async (route, body) => {
    const task = createTaskFixture({
      id: "task_created_during_refresh",
      channelId: String(body.channelId),
      title: String(body.title),
      prompt: String(body.prompt),
    });
    state.tasks.unshift(task);
    await route.fulfill({ status: 201, json: { task } });
  });
  await page.goto("/");

  const tasks = await openTasks(page);
  await expect(tasks.locator('[data-task-id="task_before_refresh"]')).toBeVisible();
  holdRefresh = true;
  const refreshAction = tasks.getByRole("button", { name: "Refresh tasks" });
  await refreshAction.click();
  await expect(refreshAction).toBeDisabled();
  await expect(refreshAction).toHaveAttribute("aria-busy", "true");
  await expectTypedIconButton(refreshAction, "Refresh tasks");
  await tasks.getByRole("button", { name: "Create task", exact: true }).click();
  const createPanel = tasks.locator("[data-ui2-teammate-task-create]");
  await createPanel.getByLabel("Task prompt").fill("Create while an older refresh is pending.");
  await createPanel.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(tasks.locator('[data-task-id="task_created_during_refresh"]')).toBeVisible();
  refreshGate.resolve();
  await expect(tasks.locator('[data-task-id="task_created_during_refresh"]')).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("A delayed task response cannot cross a teammate switch", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  const secondTeammateId = "teammate_tasks_switch_target";
  const secondTeammateName = "Task Switch Reviewer";
  state.aiTeammates = [
    createMockTeammate({ id: teammateId, displayName: teammateName }),
    createMockTeammate({ id: secondTeammateId, displayName: secondTeammateName }),
  ];
  state.teammateChannelMemberships = [
    createMembershipFixture("channel_tasks"),
    createMembershipFixture("channel_tasks", secondTeammateId),
  ];
  const firstTask = createTaskFixture({ id: "task_old_teammate", title: "Old teammate task" });
  const secondTask = createTaskFixture({
    id: "task_new_teammate",
    title: "Current teammate task",
    assigneeTeammateId: secondTeammateId,
  });
  state.tasks = [firstTask, secondTask];
  const oldRequestStarted = deferred<void>();
  const oldResponseGate = deferred<void>();
  await mockDaemon(page, state);
  await page.route(/\/teammates\/([^/]+)\/tasks(?:\?.*)?$/u, async (route) => {
    const match = /\/teammates\/([^/]+)\/tasks/u.exec(new URL(route.request().url()).pathname);
    const requestedTeammateId = match ? decodeURIComponent(match[1]) : "";
    if (requestedTeammateId === teammateId) {
      oldRequestStarted.resolve();
      await oldResponseGate.promise;
    }
    await route.fulfill({
      json: {
        cwd,
        tasks: state.tasks.filter((task) => isRecord(task) && task.assigneeTeammateId === requestedTeammateId),
      },
    });
  });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  await oldRequestStarted.promise;
  const tasks = await openTasks(page, secondTeammateName);
  await expect(tasks.locator('[data-task-id="task_new_teammate"]')).toBeVisible();
  oldResponseGate.resolve();
  await expect(tasks.locator('[data-task-id="task_old_teammate"]')).toHaveCount(0);
  await expect(tasks.locator('[data-task-id="task_new_teammate"]')).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Tasks search and status filter keep the exact 100-row recent boundary inside a scroll owner", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.tasks = Array.from({ length: 100 }, (_, index) => createTaskFixture({
    id: `task_dense_${String(index).padStart(3, "0")}`,
    status: taskStatuses[index % taskStatuses.length],
    title: `Recent task ${String(index).padStart(3, "0")} with a deliberately long title for truncation coverage`,
    updatedAt: new Date(Date.UTC(2026, 6, 21, 0, index)).toISOString(),
  }));
  await mockDaemon(page, state);
  await routeTeammateTaskList(page, state);
  await page.goto("/");

  const tasks = await openTasks(page);
  await expect(tasks).toContainText("Recent tasks");
  const list = tasks.locator("[data-ui2-teammate-task-list]");
  await expect(list.locator("[data-task-id]")).toHaveCount(100);
  const scrollState = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(["auto", "scroll"]).toContain(scrollState.overflowY);
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);

  const search = tasks.getByRole("searchbox", { name: "Search tasks" });
  await search.fill("task 099");
  await expect(list.locator("[data-task-id]")).toHaveCount(1);
  await expect(list).toContainText("Recent task 099");
  await search.clear();
  await tasks.getByRole("combobox", { name: "Status" }).selectOption({ label: "Needs attention" });
  const filteredCount = await list.locator("[data-task-id]").count();
  expect(filteredCount).toBeGreaterThan(0);
  expect(filteredCount).toBeLessThan(100);
  await captureEvidence(page, "1280x800-ling-dark-dense-scroll.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Create task refuses paused memberships and unrelated active channels", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.channels = [
    createChannelFixture({ id: "channel_paused_member", name: "Paused member channel", status: "paused" }),
    createChannelFixture({ id: "channel_active_outsider", name: "Active unrelated channel", status: "active" }),
  ];
  state.teammateChannelMemberships = [createMembershipFixture("channel_paused_member")];
  state.tasks = [];
  await mockDaemon(page, state);
  await routeTeammateTaskList(page, state);
  await page.goto("/");

  const tasks = await openTasks(page);
  await tasks.getByRole("button", { name: "Create task", exact: true }).click();
  const createPanel = tasks.locator("[data-ui2-teammate-task-create]");
  await expect(createPanel).toBeVisible();
  await expect(createPanel.getByLabel("Task channel")).toBeDisabled();
  await expect(createPanel).not.toContainText("Paused member channel");
  await expect(createPanel).not.toContainText("Active unrelated channel");
  await expect(createPanel.locator(".ling-ui-inline-feedback")).toContainText(/join this teammate to an active channel/iu);
  await expect(createPanel.getByRole("button", { name: "Create task", exact: true })).toBeDisabled();
  await captureEvidence(page, "1280x800-ling-dark-no-active-channel.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Task form retains its draft when creation fails", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.tasks = [];
  await mockDaemon(page, state);
  await routeTeammateTaskList(page, state);
  await routeTaskCreate(page, async (route) => {
    await route.fulfill({ status: 503, json: { message: "Task creation is temporarily unavailable." } });
  });
  await page.goto("/");

  const tasks = await openTasks(page);
  await tasks.getByRole("button", { name: "Create task", exact: true }).click();
  const createPanel = tasks.locator("[data-ui2-teammate-task-create]");
  await createPanel.getByLabel("Task title").fill("Retain this failed draft");
  await createPanel.getByLabel("Task prompt").fill("Keep this prompt after the request fails.");
  await createPanel.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(createPanel.locator(".ling-ui-inline-feedback")).toContainText("Task could not be created. Try again.");
  await expect(createPanel.getByLabel("Task title")).toHaveValue("Retain this failed draft");
  await expect(createPanel.getByLabel("Task prompt")).toHaveValue("Keep this prompt after the request fails.");
  await captureEvidence(page, "1280x800-ling-light-create-failure.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Task form succeeds without auto-run and reports the result through Toast", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.channels = [
    createChannelFixture({ id: "channel_active_member", name: "Active member channel", status: "active" }),
    createChannelFixture({ id: "channel_paused_member", name: "Paused member channel", status: "paused" }),
    createChannelFixture({ id: "channel_active_outsider", name: "Active unrelated channel", status: "active" }),
  ];
  state.teammateChannelMemberships = [
    createMembershipFixture("channel_active_member"),
    createMembershipFixture("channel_paused_member"),
  ];
  state.tasks = [];
  const initialRunCount = state.runs.length;
  const requests: Record<string, unknown>[] = [];
  await mockDaemon(page, state);
  await routeTeammateTaskList(page, state);
  await routeTaskCreate(page, async (route, body) => {
    requests.push(body);
    const task = createTaskFixture({
      id: "task_created_from_form",
      channelId: String(body.channelId),
      title: String(body.title),
      prompt: String(body.prompt),
    });
    state.tasks.unshift(task);
    await route.fulfill({ status: 201, json: { task } });
  });
  await page.goto("/");

  const tasks = await openTasks(page);
  await tasks.getByRole("button", { name: "Create task", exact: true }).click();
  const createPanel = tasks.locator("[data-ui2-teammate-task-create]");
  const channel = createPanel.getByLabel("Task channel");
  await expect(channel.locator("option")).toHaveCount(1);
  await expect(channel.locator("option")).toHaveText("Active member channel");
  await createPanel.getByLabel("Task title").fill("Verify focused task creation");
  await createPanel.getByLabel("Task prompt").fill("Create this task without starting a run.");
  await createPanel.getByRole("button", { name: "Create task", exact: true }).click();

  const toast = page.locator('[data-ling-overlay="toast"]').filter({ hasText: "Task created" });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "View task" })).toBeVisible();
  await expect(tasks.locator('[data-task-id="task_created_from_form"]')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    assigneeTeammateId: teammateId,
    channelId: "channel_active_member",
    prompt: "Create this task without starting a run.",
    title: "Verify focused task creation",
  });
  expect(requests[0]).not.toHaveProperty("autoRun");
  expect(requests[0]).not.toHaveProperty("run");
  expect(requests[0]).not.toHaveProperty("startRun");
  expect(state.runs).toHaveLength(initialRunCount);
  await captureEvidence(page, "1440x960-ling-dark-create-success-toast.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Create task from message scopes busy and failure to the triggering row", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTasksState();
  state.channels = [createChannelFixture({ id: "channel_message_tasks", name: "Message tasks", status: "active" })];
  state.teammateChannelMemberships = [createMembershipFixture("channel_message_tasks")];
  state.tasks = [];
  state.teammateDirectMessages = [
    createDirectMessageFixture("message_task_success", "Turn this first private message into a task."),
    createDirectMessageFixture("message_task_failure", "Turn this second private message into a task."),
  ];
  const firstRequestGate = deferred<void>();
  let createAttempt = 0;
  await mockDaemon(page, state);
  await routeTeammateTaskList(page, state);
  await routeTaskCreate(page, async (route, body) => {
    createAttempt += 1;
    if (createAttempt === 1) {
      await firstRequestGate.promise;
      const task = createTaskFixture({
        id: "task_created_from_message",
        channelId: String(body.channelId),
        title: String(body.title),
        prompt: String(body.prompt),
      });
      state.tasks.unshift(task);
      await route.fulfill({ status: 201, json: { task } });
      return;
    }
    await route.fulfill({ status: 503, json: { message: "Message task could not be created." } });
  });
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();

  const feed = page.getByLabel("Private message feed", { exact: true });
  const firstRow = feed.locator(".teammate-message-row").filter({ hasText: "Turn this first private message into a task." });
  const secondRow = feed.locator(".teammate-message-row").filter({ hasText: "Turn this second private message into a task." });
  await firstRow.hover();
  const firstCreate = firstRow.getByRole("button", { name: /Create task/ });
  const secondCreate = secondRow.getByRole("button", { name: /Create task/ });
  await expect(firstCreate).not.toHaveAttribute("data-ling-icon-button-contract");
  await expect(secondCreate).not.toHaveAttribute("data-ling-icon-button-contract");
  await firstCreate.click();
  await expect(firstCreate).toBeDisabled();
  await expect(firstCreate).toHaveAttribute("aria-busy", "true");
  await expect(secondCreate).toBeEnabled();
  firstRequestGate.resolve();

  const toast = page.locator('[data-ling-overlay="toast"]').filter({ hasText: "Task created" });
  await expect(toast.getByRole("button", { name: "View task" })).toBeVisible();
  await expect(firstCreate).toBeEnabled();
  await secondRow.hover();
  await secondCreate.click();
  await expect(secondRow.locator(".ling-ui-inline-feedback")).toContainText("Task could not be created. Try again.");
  await expect(firstRow.locator(".ling-ui-inline-feedback")).toHaveCount(0);
  expect(state.runs.filter((run) => run.taskId === "task_created_from_message")).toHaveLength(0);
  await captureEvidence(page, "1280x800-ling-dark-message-failure.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createTasksState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: teammateName })];
  state.channels = [createChannelFixture({ id: "channel_tasks", name: "Task planning", status: "active" })];
  state.teammateChannelMemberships = [createMembershipFixture("channel_tasks")];
  state.tasks = [];
  return state;
}

function createTaskFixture(overrides: {
  readonly id: string;
  readonly channelId?: string;
  readonly currentRunId?: string;
  readonly prompt?: string;
  readonly status?: typeof taskStatuses[number];
  readonly title?: string;
  readonly updatedAt?: string;
  readonly assigneeTeammateId?: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    workspaceId: "workspace_default",
    channelId: overrides.channelId ?? "channel_tasks",
    title: overrides.title ?? overrides.id,
    prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
    status: overrides.status ?? "todo",
    assigneeTeammateId: overrides.assigneeTeammateId ?? teammateId,
    attachmentIds: [],
    ...(overrides.currentRunId ? { currentRunId: overrides.currentRunId } : {}),
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-21T00:10:00.000Z",
  };
}

function createChannelFixture(input: {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "paused";
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    name: input.name,
    status: input.status,
    boundPath: cwd,
    autoReplyMode: "mentions_only",
    allowedTools: ["read", "grep"],
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

function createMembershipFixture(channelId: string, membershipTeammateId: string = teammateId): Record<string, unknown> {
  return {
    workspaceId: "workspace_default",
    teammateId: membershipTeammateId,
    channelId,
    isDefault: false,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

function createDirectMessageFixture(id: string, body: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "local-user",
    authorId: "local-user",
    body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: `2026-07-21T00:0${id.endsWith("success") ? "1" : "2"}:00.000Z`,
    updatedAt: `2026-07-21T00:0${id.endsWith("success") ? "1" : "2"}:00.000Z`,
  };
}

async function routeTeammateTaskList(page: Page, state: MockState): Promise<void> {
  await page.route(new RegExp(`/teammates/${teammateId}/tasks(?:\\?.*)?$`, "u"), async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const tasks = state.tasks
      .filter((task) => isRecord(task) && task.assigneeTeammateId === teammateId)
      .slice(0, 100);
    await route.fulfill({ json: { cwd, tasks } });
  });
}

async function routeTaskCreate(
  page: Page,
  handler: (route: Route, body: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  await page.route(/\/tasks(?:\?.*)?$/u, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/tasks") {
      await route.fallback();
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    await handler(route, body);
  });
}

async function openTasks(page: Page, targetTeammateName: string = teammateName): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: targetTeammateName }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  if (await page.getByLabel("Private chat workspace dock").count() === 0) {
    await header.getByRole("button", { name: "Show details" }).click();
  }
  await page.getByLabel("Private chat workspace dock").getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  const tasksNavigation = settingsSections.getByRole("button", { name: /^Tasks(?:\s|$)/u });
  await expect(tasksNavigation).toBeVisible();
  await tasksNavigation.click();
  const tasks = page.locator("[data-ui2-teammate-tasks]");
  await expect(tasks).toBeVisible();
  return tasks;
}

async function expectTasksToolbar(tasks: Locator): Promise<void> {
  await expect(tasks.getByRole("searchbox", { name: "Search tasks" })).toBeVisible();
  await expect(tasks.getByRole("combobox", { name: "Status" })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Create task", exact: true })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Open Work Board", exact: true })).toBeVisible();
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await page.addInitScript((theme) => {
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, options.theme);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function expectTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
}

async function expectIconButtonTooltip(button: Locator, label: string): Promise<void> {
  const page = button.page();
  await button.hover();
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toHaveCount(0);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
