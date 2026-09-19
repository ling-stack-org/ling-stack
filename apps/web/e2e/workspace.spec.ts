import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { openWorkBoardFromInbox } from "./support/open-work-board";
import {
  createBaseState,
  createChatProvider,
  createMediaProvider,
  createVerboseRunEvents,
  isRecord,
} from "./support/mock-state";
import {
  openEngineeringChannel,
  openNewTaskPanel,
  openTaskFromAttentionQueue,
} from "./support/test-helpers";

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

test("workspace opens as a task workbench with task context in the inspector", async ({ page }) => {
  await useEnglishLocale(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Workspace task toolbar")).toBeVisible();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const sidePanel = page.locator(".channel-side-panel");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(sidePanel).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});

test("workspace task detail panel stays bounded without growing the page", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.eventsByRun.run_failed = createVerboseRunEvents("run_failed");
  await mockDaemon(page, state);
  await page.goto("/");
  await openTaskFromAttentionQueue(page, "Inspect workspace");

  await expect(page.locator(".workbench-task-list")).toHaveCount(0);
  await expect(page.locator("article.task-detail .client-task-kicker")).toHaveCount(0);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByLabel("Channel management")).toBeVisible();
  const metrics = await page.evaluate(() => {
    const sidePanel = document.querySelector(".channel-side-panel");
    const taskDetail = document.querySelector("article.task-detail");
    return {
      viewportHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      sidePanelHeight: sidePanel?.getBoundingClientRect().height ?? 0,
      taskDetailHeight: taskDetail?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 2);
  expect(metrics.sidePanelHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.taskDetailHeight).toBeLessThanOrEqual(metrics.sidePanelHeight);
});

test("workspace path initializes from daemon default without showing the path field", async ({ page }) => {
  await useEnglishLocale(page);
  const daemonCwd = "/tmp/daemon-default-workspace";
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), { defaultWorkspaceCwd: daemonCwd });
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByLabel("Workspace path")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
});

test("workspace defaults do not hardcode personal machine paths", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const e2eSource = await readFile(new URL("./app.spec.ts", import.meta.url), "utf8");
  const personalPath = ["/Users", "tianxiao", "ling-stack"].join("/");

  expect(appSource).not.toContain(personalPath);
  expect(e2eSource).not.toContain(personalPath);
});

test("workspace new task panel creates and selects the new task", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  await mockDaemon(page, state);
  await page.goto("/");

  await openNewTaskPanel(page);
  await page.getByLabel("New task").getByLabel("Title").fill("Design inspector behavior");
  await page.getByLabel("New task").getByLabel("Prompt").fill("Make the inspector follow the selected task.");
  await page.getByLabel("New task").getByRole("button", { name: "Create task" }).click();

  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.title === "Design inspector behavior")).toBe(true);
  await expect(page.locator("article.task-detail")).toContainText("Design inspector behavior");
  await expect(page.locator("article.task-detail")).toContainText("Design inspector behavior");
});

test("workspace task runs only expose preflight-ready coding providers", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
    createChatProvider({
      id: "provider_missing_key",
      displayName: "Missing Key Gateway",
      apiKeyConfigured: false,
      apiKeyRef: "env:MISSING_GATEWAY_KEY",
    }),
    createMediaProvider(),
  ];
  state.channels = state.channels.map((channel) => isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel);
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await openNewTaskPanel(page);
  const newTaskPanel = page.getByLabel("New task");
  const providerSelect = newTaskPanel.getByRole("combobox", { name: "Run provider" });
  await expect(providerSelect.locator('option[value="provider_ready"]')).toHaveCount(1);
  await expect(providerSelect.locator('option[value="provider_missing_key"]')).toHaveCount(1);
  await expect(providerSelect.locator('option[value="provider_missing_key"]')).toHaveAttribute("disabled", "");
  await expect(providerSelect.locator('option[value="provider_seedream"]')).toHaveCount(0);
  await newTaskPanel.getByText("Execution context", { exact: true }).click();
  await expect(newTaskPanel.getByText("Generation-only models cannot run coding tasks.").first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect(page.locator(".task-detail")).toContainText("Run linked");
  await expect(page.locator(".task-detail")).not.toContainText("run_2");
  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.currentRunId === "run_2")).toBe(true);
});

test("workspace task run uses the displayed ready provider fallback", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: undefined } : channel
  );
  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "todo", currentRunId: undefined } : task
  );
  state.runs = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await openNewTaskPanel(page);
  const providerSelect = page.getByLabel("New task").getByRole("combobox", { name: "Run provider" });
  await expect(providerSelect).toHaveValue("provider_ready");
  await page.getByRole("button", { name: "Cancel" }).click();

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();

  await expect.poll(() => state.runs[0]?.providerPresetId).toBe("provider_ready");
  await expect(page.locator(".task-detail")).toContainText("Task complete");
  await expect(page.locator(".task-detail").getByRole("button", { name: "View result" })).toBeVisible();
  await expect(page.locator(".task-detail")).not.toContainText("run_1");
});

test("workspace task detail actions only show a spinner on the clicked action", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "todo", currentRunId: undefined } : task
  );
  state.runs = [];
  state.runResponseDelayMs = 2000;
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskDetail = page.locator("article.task-detail");
  const runButton = taskDetail.locator(".channel-task-actions .ling-ui-button[data-variant='primary']");
  const checkRunButton = taskDetail.locator(".channel-task-actions .ling-ui-button").filter({ hasText: "Check & run" });
  await runButton.click();

  await expect(runButton).toHaveAttribute("data-loading", "true");
  await expect(checkRunButton).not.toHaveAttribute("data-loading", "true");
  await expect(page.locator(".channel-task-actions .ling-ui-spinner")).toHaveCount(1);

  await expect.poll(() => state.runs[0]?.taskId).toBe("task_inspect");

  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "todo", currentRunId: undefined } : task
  );
  state.runs = [];
  state.providerCheckDelayMs = 2000;
  await checkRunButton.click();

  await expect(checkRunButton).toHaveAttribute("data-loading", "true");
  await expect(runButton).not.toHaveAttribute("data-loading", "true");
  await expect(page.locator(".channel-task-actions .ling-ui-spinner")).toHaveCount(1);
});

test("workspace task run sends the selected session permission mode", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Relay",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-05-25T00:11:00.000Z" },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  state.runs = [];
  state.tasks = state.tasks.map((task) =>
    isRecord(task) && task.id === "task_inspect"
      ? { ...task, status: "todo", currentRunId: undefined }
      : task
  );
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskDetail = page.locator("article.task-detail");
  await taskDetail.getByText("Permissions", { exact: true }).click();
  await expect(taskDetail.getByRole("radiogroup", { name: "Permission preset" })).toBeVisible();
  await taskDetail.getByRole("radio", { name: "Workspace write" }).click();
  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();

  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.authorizationMode : undefined;
  }).toBe("smart");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.workspaceAccessMode : undefined;
  }).toBe("workspace_write");

  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.permissionMode : undefined;
  }).toBe("workspace_write");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.permissionPreset : undefined;
  }).toBe("workspace_collaboration");
});

test("workspace full access task run requires confirmation and sends confirmation evidence", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Relay",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-05-25T00:11:00.000Z" },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  state.runs = [];
  state.tasks = state.tasks.map((task) =>
    isRecord(task) && task.id === "task_inspect"
      ? { ...task, status: "todo", currentRunId: undefined }
      : task
  );
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskDetail = page.locator("article.task-detail");
  await taskDetail.getByText("Permissions", { exact: true }).click();
  await taskDetail.getByRole("radio", { name: "Full access" }).click();
  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();

  const confirmSheet = page.getByRole("dialog", { name: "Confirm full access" });
  await expect(confirmSheet).toBeVisible();
  await expect(confirmSheet).toHaveClass(/ling-ui-dialog-content/u);
  await confirmSheet.getByRole("button", { name: "Cancel" }).last().click();
  await expect(confirmSheet).toHaveCount(0);
  expect(state.runs).toHaveLength(0);

  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("dialog", { name: "Confirm full access" }).getByRole("button", { name: "Start with full access" }).click();

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
    return isRecord(snapshot) ? snapshot.workspaceAccessMode : undefined;
  }).toBe("full_access");
});

test("saved workspace path wins over daemon default", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", "/tmp/saved-workspace");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, {
    defaultWorkspaceCwd: "/tmp/daemon-default-workspace",
  });
  await page.goto("/");

  await expect(page.getByLabel("Workspace path")).toHaveCount(0);
  await expect.poll(() => state.workspaceSettings.workspaceCwd).toBe("/tmp/saved-workspace");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.workspaceCwd"))).toBeNull();
});

test("desktop host ignores a saved workspace path and uses its daemon authority", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", "/tmp/saved-workspace");
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
      },
    });
  });
  const daemonCwd = "/tmp/daemon-default-workspace";
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { defaultWorkspaceCwd: daemonCwd });
  await page.goto("/");

  await expect.poll(() => state.workspaceSettings.workspaceCwd).toBe(daemonCwd);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.workspaceCwd"))).toBeNull();
});

test("succeeded workspace tasks show a clear result action", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Local Relay",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  state.runs = state.runs.map((run) => ({
    ...run,
    status: "succeeded",
    providerPresetId: "provider_ready",
    providerName: "local-relay",
    providerModel: "dpv4",
    errorMessage: undefined,
    updatedAt: "2026-05-25T00:20:30.000Z",
  }));
  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "done", currentRunId: "run_failed", updatedAt: "2026-05-25T00:20:30.000Z" } : task
  );
  state.workItems = [
    {
      id: "work_item_completed_task",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceType: "manual",
      sourceId: "work_item_completed_task",
      title: "Inspect workspace",
      description: "Open the completed task from the work board.",
      status: "done",
      priority: "normal",
      labels: ["result"],
      taskId: "task_inspect",
      artifactIds: [],
      proofArtifactIds: [],
      dependencyIds: [],
      attemptCount: 0,
      retryBudget: 1,
      createdAt: "2026-05-25T00:20:30.000Z",
      updatedAt: "2026-05-25T00:20:30.000Z",
    },
  ];
  state.eventsByRun.run_failed = createVerboseRunEvents("run_failed");
  await mockDaemon(page, state);
  await page.goto("/");

  await openWorkBoardFromInbox(page);
  const workBoard = page.locator(".work-board-page");
  await workBoard.getByLabel("Work board views").getByRole("button", { name: "History" }).click();
  const completedTask = workBoard.locator("[data-work-item-id='work_item_completed_task']");
  await completedTask.getByRole("button", { name: "Open task" }).click();
  await expect(page.getByText("Task complete").first()).toBeVisible();

  const taskDetail = page.locator("article.task-detail");
  await expect(taskDetail).toContainText("Task complete");
  await expect(taskDetail.getByRole("button", { name: "View result" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run activity" })).toHaveCount(0);
  await expect(taskDetail).not.toContainText("AI is analyzing the task");
  await expect(taskDetail).not.toContainText("Read package.json");
});
