import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMediaProvider,
  cwd,
  isRecord,
  type MockState,
} from "./support/mock-state";
import {
  openChannelContextPanel,
  openEngineeringChannel,
  openTaskFromAttentionQueue,
} from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-task-environment/",
  import.meta.url,
));

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
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

function configureReadyProvider(state: MockState): void {
  state.providers = [
    createChatProvider({
      id: "provider_ui2_channel_task",
      displayName: "Ready Local Relay",
      model: "gpt-5.5",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-07-19T01:00:00.000Z",
      },
    }),
  ];
  state.workspaceSettings.defaultProviderPresetId = "provider_ui2_channel_task";
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ui2_channel_task" } : channel
  );
}

function configureWorkspaceBinding(state: MockState): void {
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? {
          ...channel,
          workspaceBinding: {
            mode: "managed_worktree",
            status: "ready",
            executionPath: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
            worktreePath: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
            branchName: "ling/ui2-task-environment",
            baseBranch: "main",
            updatedAt: "2026-07-19T01:00:00.000Z",
            checkedAt: "2026-07-19T01:00:00.000Z",
          },
        }
      : channel
  );
}

async function openEnvironment(page: Page): Promise<void> {
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  await expect(page.getByRole("region", { name: "Environment", exact: true })).toBeVisible();
}

test("channel task detail uses the UI 2.0 inspector contract", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyProvider(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await waitForChannelDockSettled(page);

  const dock = page.locator(".channel-side-panel");
  const task = page.getByRole("article", { name: "Task detail", exact: true });
  await expect(task).toHaveAttribute("data-ui2-channel-task", "detail");
  await expect(task.locator(".channel-task-detail-header > .ling-ui-status-indicator")).toHaveCount(1);
  await expect(task.locator(".ling-ui-inspector-section")).toHaveCount(2);
  await expect(task.locator(".ling-ui-segmented-control")).not.toBeVisible();
  await task.getByText("Permissions", { exact: true }).click();
  await expect(task.locator(".ling-ui-segmented-control")).toBeVisible();
  await expect(task.getByRole("radio")).toHaveCount(4);
  for (const label of ["Read only", "Workspace write", "Full access", "Custom"]) {
    await expect(task.getByRole("radio", { name: label })).toBeVisible();
  }
  await expect(task.getByRole("button", { name: "Run", exact: true })).toHaveClass(/ling-ui-button/u);
  await expect(task.locator(".ling-ui-inline-feedback[data-tone='danger']")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>(".channel-side-panel")?.getBoundingClientRect();
    const task = document.querySelector<HTMLElement>("[data-ui2-channel-task='detail']")?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dockHeight: dock?.height ?? 0,
      taskHeight: task?.height ?? 0,
      taskWidth: task?.width ?? 0,
      taskScrollWidth: document.querySelector<HTMLElement>("[data-ui2-channel-task='detail']")?.scrollWidth ?? 0,
    };
  });
  expect(geometry.documentOverflow).toBe(0);
  expect(geometry.taskHeight).toBeLessThanOrEqual(geometry.dockHeight + 1);
  expect(geometry.taskScrollWidth).toBeLessThanOrEqual(geometry.taskWidth + 1);
  await captureEvidence(page, "1440x960-ling-light-channel-task-detail.png");
  expect(runtimeErrors).toEqual([]);
});

test("channel new task keeps fields and advanced context inside the dock at 1280", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyProvider(state);
  state.providers.push(createMediaProvider());
  await mockDaemon(page, state);
  await page.goto("/");
  await openChannelContextPanel(page);
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  const newTask = dock.getByRole("button", { name: "New task" });
  const refresh = dock.getByRole("button", { name: "Refresh" });
  await expectTypedIconAction(page, newTask, "New task");
  await expectTypedIconAction(page, refresh, "Refresh");
  await expect(refresh).not.toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeEnabled();
  await newTask.focus();
  await expect(newTask).toBeFocused();
  await newTask.click();
  await waitForChannelDockSettled(page);

  const task = page.getByLabel("New task");
  await expect(task).toHaveAttribute("data-ui2-channel-task", "create");
  await expect(task.locator(".ling-ui-field")).toHaveCount(3);
  const providerSelect = task.getByRole("combobox", { name: "Run provider" });
  await expect(providerSelect).toHaveClass(/ling-ui-select-native/u);
  const providerShell = providerSelect.locator("xpath=..");
  await expect(providerShell).toHaveClass(/ling-ui-select/u);
  await expect(providerShell).toHaveAttribute("data-size", "md");
  expect(await providerShell.evaluate((element) => element.hasAttribute("data-select-control"))).toBe(false);
  await expect(task.locator(".ling-ui-inspector-section")).toHaveCount(1);
  await expect(task.getByText("Execution context", { exact: true })).toBeVisible();
  await expect(task.getByText("Generation-only models cannot run coding tasks.")).not.toBeVisible();
  await task.getByText("Execution context", { exact: true }).click();
  await expect(task.locator(".ling-ui-inline-feedback")).toContainText("Generation-only models cannot run coding tasks.");
  await expect(task.getByRole("button", { name: "Create task" })).toHaveClass(/ling-ui-button/u);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await captureEvidence(page, "1280x800-ling-dark-channel-new-task.png");
  expect(runtimeErrors).toEqual([]);
});

test("channel workflow preview uses the shared dialog without the removed environment overlay", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_ui2_workflow_preview",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_main_channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: [
        "<proposed_plan title=\"UI 2.0 workflow preview\">",
        "1. Update the channel task surface.",
        "2. Verify the shared dialog and evidence.",
        "</proposed_plan>",
      ].join("\n"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-19T01:03:00.000Z",
      updatedAt: "2026-07-19T01:03:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const trigger = page.getByLabel("Proposed plan").getByRole("button", { name: "Convert to workflow" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Workflow conversion preview" });
  await expect(dialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(dialog.locator(".ling-ui-dialog-body")).toBeVisible();
  await expect(dialog.locator(".ling-ui-dialog-footer")).toBeVisible();
  await expect(page.locator(".environment-commit-dialog-backdrop")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await captureEvidence(page, "1440x960-ling-light-channel-workflow-preview.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("channel environment presents dirty conflict state as a data-first surface", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureWorkspaceBinding(state);
  state.channelWorkspaceGitStatusByChannel.channel_engineering = {
    state: "dirty",
    cwd: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
    repoRoot: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
    branchName: "ling/ui2-task-environment",
    upstream: "main",
    headSha: "ui2a3",
    changedFileCount: 3,
    stagedFileCount: 1,
    unstagedFileCount: 2,
    untrackedFileCount: 1,
    conflictedFileCount: 1,
    additions: 42,
    deletions: 9,
    files: [],
    checkedAt: "2026-07-19T01:02:00.000Z",
  };
  await mockDaemon(page, state);
  await page.goto("/");
  await openEnvironment(page);

  const environment = page.getByRole("region", { name: "Environment", exact: true });
  await expect(environment).toHaveAttribute("data-ui2-channel-environment", "true");
  await expect(environment.locator(".ling-ui-data-row")).toHaveCount(5);
  await expect(environment.locator(".ling-ui-status-indicator[data-tone='danger']").first()).toContainText("Needs attention");
  await expect(environment).toContainText("3 changed files");
  await expect(environment).toContainText("1 conflicted");
  await expect(environment.locator(".channel-environment-section")).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-channel-environment-conflict.png");

  const openCommit = environment.getByRole("button", { name: "Open" });
  await openCommit.click();
  const dialog = page.getByRole("dialog", { name: "Commit or push" });
  await expect(dialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(dialog.locator(".ling-ui-field")).toHaveCount(1);
  await captureEvidence(page, "1440x960-ling-light-channel-environment-commit-preview.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(openCommit).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("channel environment keeps Git transport failure persistent in dark mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureWorkspaceBinding(state);
  state.channelWorkspaceGitStatusByChannel.channel_engineering = {
    fail: true,
    status: 503,
    message: "Git bridge is unavailable.",
  };
  await mockDaemon(page, state);
  await page.goto("/");
  await openEnvironment(page);

  const environment = page.getByRole("region", { name: "Environment", exact: true });
  const failure = environment.locator(".ling-ui-inline-feedback[data-tone='danger']");
  await expect(failure).toContainText("Git status unavailable");
  await expect(environment).not.toContainText("No code changes");
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await captureEvidence(page, "1280x800-ling-dark-channel-environment-unavailable.png");
  expect(runtimeErrors).toEqual([]);
});

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

async function waitForChannelDockSettled(page: Page): Promise<void> {
  await expect.poll(() => page.locator(".task-workbench-main").evaluate((element) => {
    const value = getComputedStyle(element).getPropertyValue("--channel-right-dock-layout-width");
    return Number.parseFloat(value) || 0;
  })).toBeGreaterThanOrEqual(303.5);
}

async function expectTypedIconAction(page: Page, action: Locator, label: string): Promise<void> {
  await expect(action).toHaveAttribute("data-icon-only", "true");
  await expect(action).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(action).toHaveAttribute("aria-label", label);
  await expect(action).toHaveAttribute("title", label);
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(32);
  await action.hover();
  await expect(page.getByRole("tooltip", { name: label })).toBeVisible();
  await page.mouse.move(0, 0);
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
