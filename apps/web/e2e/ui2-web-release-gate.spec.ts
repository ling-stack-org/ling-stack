import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  createMediaMixedFixture,
  createMediaRouteControl,
  installMediaScenarioRoutes,
  openMediaJobs,
  seedImportedQuietOcean,
} from "./support/media-jobs-fixtures";
import { mockDaemon, openEngineeringChannel, type MockState } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
  createMockTeammate,
  cwd,
  isRecord,
} from "./support/mock-state";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
} from "./support/runs-threads-fixture";
import { createApproval } from "./support/approvals-fixture";
import { openWorkBoardFromInbox } from "./support/open-work-board";
import { openPendingInbox } from "./support/pending-primary-navigation";
import {
  captureUi2ReleaseScenario,
  prepareUi2ReleaseSurface,
  watchUi2ReleaseRuntime,
  type Ui2ReleaseRuntimeMonitor,
  type Ui2ReleaseScenarioDefinition,
} from "./support/ui2-release-evidence";

const scenarios = {
  shell: releaseScenario({
    stableId: "web-release-shell",
    label: "AppShell and global navigation",
    functionIds: ["SHELL-NAV-001"],
    fixture: "base-ready-shell",
    trigger: { summary: "Open the application root", steps: ["Navigate to /", "Confirm Work Board is hidden", "Focus Plugin Manager in global navigation"] },
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Global navigation action accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  channel: releaseScenario({
    stableId: "web-release-channel",
    label: "Channel workspace",
    functionIds: ["CHANNEL-HEADER-001"],
    fixture: "engineering-channel-ready",
    trigger: { summary: "Open Engineering channel", steps: ["Navigate to /", "Activate Engineering", "Focus Summary"] },
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Channel Summary action accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  normalConversation: releaseScenario({
    stableId: "web-release-normal-conversation",
    label: "Normal conversation",
    functionIds: ["CONV-NORMAL-HEADER-001"],
    fixture: "release-normal-conversation",
    trigger: { summary: "Open a recent conversation", steps: ["Navigate to /", "Activate Release readiness conversation", "Focus Search"] },
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Conversation Search action accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  teammateChat: releaseScenario({
    stableId: "web-release-teammate-chat",
    label: "AI teammate private chat",
    functionIds: ["CONV-TEAMMATE-HEADER-001"],
    fixture: "release-teammate-chat",
    trigger: { summary: "Open Release Teammate private chat", steps: ["Navigate to /", "Activate Release Teammate", "Focus Search"] },
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Private-chat Search action accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  settingsImportedTheme: releaseScenario({
    stableId: "web-release-settings-imported-theme",
    label: "Settings with imported Quiet Ocean theme",
    functionIds: ["UI-THEME-PICKER-001"],
    fixture: "imported-quiet-ocean",
    trigger: { summary: "Open Interface preferences after loading an imported theme", steps: ["Seed Quiet Ocean through the existing fixture", "Reload", "Open Settings", "Open Interface preferences"] },
    viewport: { width: 1440, height: 960 },
    theme: "imported:quiet-ocean",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Imported theme radio accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  modelWorkbench: releaseScenario({
    stableId: "web-release-model-workbench",
    label: "Model Workbench",
    functionIds: ["MODEL-LIST-001"],
    fixture: "ready-chat-model",
    trigger: { summary: "Open Model Workbench from Settings", steps: ["Open Settings", "Activate Model Workbench", "Focus the model row Edit action"] },
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Model row Edit action accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  pluginManager: releaseScenario({
    stableId: "web-release-plugin-manager",
    label: "Plugin Manager",
    functionIds: ["PLUGIN-LIST-001"],
    fixture: "managed-plugin-catalog",
    trigger: { summary: "Open Plugin Manager from the primary navigation", steps: ["Open Engineering", "Activate Plugin Manager", "Focus the first row action"] },
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Plugin row action accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  automations: releaseScenario({
    stableId: "web-release-automations",
    label: "Automations",
    functionIds: ["AUTO-LIST-001"],
    fixture: "release-automation-ready",
    trigger: { summary: "Open Automations", steps: ["Navigate to /", "Activate Automations", "Focus Release automation row"] },
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Automation row accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  mediaJobs: releaseScenario({
    stableId: "web-release-media-jobs",
    label: "Media generation jobs",
    functionIds: ["MEDIA-JOB-LIST-001"],
    fixture: "media-mixed-release",
    trigger: { summary: "Open Generation tasks from Media Production", steps: ["Activate Media Production", "Switch to Generation tasks", "Focus the first job row"] },
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Media job row accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  workBoard: releaseScenario({
    stableId: "web-release-work-board",
    label: "Work Board",
    functionIds: ["BOARD-LIST-001"],
    fixture: "release-work-item-ready",
    trigger: { summary: "Open Work Board", steps: ["Navigate to /", "Activate Work Board", "Focus the release work item"] },
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Work item row accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  runs: releaseScenario({
    stableId: "web-release-runs",
    label: "Runs history and detail",
    functionIds: ["RUN-HISTORY-001"],
    fixture: "runs-threads-release",
    trigger: { summary: "Open retained Run Diagnostics fixture", steps: ["Activate pending diagnostics fixture", "Open Run Diagnostics", "Open full diagnostics in app", "Focus a history row"] },
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Run history row accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  approvals: releaseScenario({
    stableId: "web-release-approvals",
    label: "Approval inbox",
    functionIds: ["APPROVAL-LIST-001"],
    fixture: "pending-approval-release",
    trigger: { summary: "Open Inbox", steps: ["Navigate to /", "Activate Inbox", "Focus a pending approval row"] },
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Approval row accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
} as const;

test.describe.configure({ mode: "serial" });

test("WEB-REL-01 Shell representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.shell);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toBeVisible();
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await expect(navigation.getByRole("button", { name: "Inbox" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  const action = navigation.getByRole("button", { name: "Plugin Manager" });
  await exerciseKeyboardFocus(action);
  await finishScenario(page, scenarios.shell, runtime);
});

test("WEB-REL-02 Channel representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.channel);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [releaseChatProvider("provider_release_channel", "Channel Release Relay")];
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: "provider_release_channel" }
    : channel);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const summary = page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Summary" });
  await exerciseKeyboardFocus(summary);
  await finishScenario(page, scenarios.channel, runtime);
});

test("WEB-REL-03 Normal conversation representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.normalConversation);
  const state = createBaseState({ approvalStatus: "expired" });
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: "Release readiness conversation" }).click();
  const header = page.locator("[data-ui2-normal-conversation-header='true']");
  await expect(header).toBeVisible();
  await exerciseKeyboardFocus(header.getByRole("button", { name: "Search" }));
  await finishScenario(page, scenarios.normalConversation, runtime);
});

test("WEB-REL-04 Teammate chat representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.teammateChat);
  const state = createBaseState({ approvalStatus: "expired" });
  installTeammateFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Release Teammate" }).click();
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await expect(header).toBeVisible();
  await exerciseKeyboardFocus(header.getByRole("button", { name: "Search" }));
  await finishScenario(page, scenarios.teammateChat, runtime);
});

test("WEB-REL-05 Settings imported-theme representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.settingsImportedTheme);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await seedImportedQuietOcean(page);
  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();
  const panel = page.locator("[data-ui2-interface-preferences]");
  await expect(panel).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "quiet-ocean");
  const option = panel.getByRole("radio", { name: /Quiet Ocean/ });
  await expect(option).toBeChecked();
  await exerciseKeyboardFocus(option);
  await finishScenario(page, scenarios.settingsImportedTheme, runtime);
});

test("WEB-REL-06 Model Workbench representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.modelWorkbench);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_release_ready",
    displayName: "Release Relay",
    model: "release-model",
    lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-07-23T00:00:00.000Z" },
  })];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  const workbench = page.locator(".provider-workbench");
  await expect(workbench.locator(".provider-row")).toHaveCount(1);
  await exerciseKeyboardFocus(workbench.getByRole("button", { name: "Edit" }));
  await finishScenario(page, scenarios.modelWorkbench, runtime);
});

test("WEB-REL-07 Plugin Manager representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.pluginManager);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  const surface = page.locator(".plugin-manager-page .settings-plugin-manager");
  await expect(surface.locator(".plugin-table-row").first()).toBeVisible();
  await exerciseKeyboardFocus(surface.locator(".plugin-table-row").first().getByRole("button").first());
  await finishScenario(page, scenarios.pluginManager, runtime);
});

test("WEB-REL-08 Automations representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.automations);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await installReleaseAutomationApi(page);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Automations" }).click();
  const surface = page.locator("[data-automation-ui2-page]");
  const row = surface.locator('[data-automation-id="automation_release_gate"]');
  await expect(row).toBeVisible();
  await exerciseKeyboardFocus(row);
  await finishScenario(page, scenarios.automations, runtime);
});

test("WEB-REL-09 Media Jobs representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.mediaJobs);
  const state = createMediaMixedFixture(12);
  state.mediaJobs = state.mediaJobs.filter((job) => job.id !== "media_job_preview_unavailable");
  delete state.artifactsByMediaJob.media_job_preview_unavailable;
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaScenarioRoutes(page, createMediaRouteControl());
  await page.goto("/");
  await openMediaJobs(page);
  const row = page.locator("[data-media-job-row]").first();
  await expect(row).toBeVisible();
  await exerciseKeyboardFocus(row);
  await finishScenario(page, scenarios.mediaJobs, runtime);
});

test("WEB-REL-10 Work Board representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.workBoard);
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.workItems = [releaseWorkItem()];
  await mockDaemon(page, state);
  await page.goto("/");
  await openWorkBoardFromInbox(page);
  const board = page.locator(".work-board-page");
  const row = board.getByRole("option", { name: /Release evidence work item/ });
  await expect(row).toBeVisible();
  await exerciseKeyboardFocus(row);
  await finishScenario(page, scenarios.workBoard, runtime);
});

test("WEB-REL-11 Runs representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.runs);
  const state = createRunsThreadsFixture(8);
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page);
  const shell = page.locator(".runs-page-shell");
  const row = shell.locator(".work-history-branch-row").first();
  await expect(row).toBeVisible();
  await exerciseKeyboardFocus(row);
  await finishScenario(page, scenarios.runs, runtime);
});

test("WEB-REL-12 Approvals representative surface", async ({ page }) => {
  const runtime = await beginScenario(page, scenarios.approvals);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.approvals = [createApproval({
    id: "approval_release_gate",
    title: "Release approval review",
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  const surface = await openPendingInbox(page);
  const row = surface.getByRole("listbox", { name: "Inbox" }).getByRole("option").first();
  await expect(row).toBeVisible();
  await exerciseKeyboardFocus(row);
  await finishScenario(page, scenarios.approvals, runtime);
});

function releaseScenario(definition: Ui2ReleaseScenarioDefinition): Ui2ReleaseScenarioDefinition {
  return definition;
}

async function beginScenario(
  page: Page,
  scenario: Ui2ReleaseScenarioDefinition,
): Promise<Ui2ReleaseRuntimeMonitor> {
  await prepareUi2ReleaseSurface(page, scenario);
  return watchUi2ReleaseRuntime(page);
}

async function finishScenario(
  page: Page,
  scenario: Ui2ReleaseScenarioDefinition,
  runtime: Ui2ReleaseRuntimeMonitor,
): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loaded");
  expect(runtime.consoleErrors, `${scenario.stableId} console errors`).toEqual([]);
  expect(runtime.pageErrors, `${scenario.stableId} page errors`).toEqual([]);
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document, `${scenario.stableId} document overflow`).toBeLessThanOrEqual(1);
  expect(overflow.body, `${scenario.stableId} body overflow`).toBeLessThanOrEqual(1);
  await captureUi2ReleaseScenario({ page, scenario, runtime });
}

async function exerciseKeyboardFocus(target: Locator): Promise<void> {
  await target.focus();
  await expect(target).toBeFocused();
}

function installNormalConversationFixture(state: MockState): void {
  const threadId = "thread_release_normal";
  const turnId = "turn_release_normal";
  const runId = "run_release_normal";
  const createdAt = "2026-07-23T03:00:00.000Z";
  state.providers = [releaseChatProvider("provider_release_normal", "Release Relay")];
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Release readiness conversation",
    objective: "Review the Web release evidence gate.",
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
    title: "Release readiness conversation",
    userInstruction: "Review the representative Web surfaces.",
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt }];
  state.runs.unshift({
    ...state.runs[0],
    id: runId,
    status: "succeeded",
    taskId: "task_release_normal",
    threadId,
    turnId,
    providerPresetId: "provider_release_normal",
    taskSnapshot: { id: "task_release_normal", title: "Release readiness run" },
    createdAt,
    updatedAt: createdAt,
    endedAt: createdAt,
  });
  state.eventsByRun[runId] = [{
    id: "event_release_normal",
    runId,
    seq: 1,
    ts: createdAt,
    type: "assistant_text_delta",
    data: { text: "Representative release response." },
  }];
}

function installTeammateFixture(state: MockState): void {
  const teammateId = "teammate_release_gate";
  const threadId = `tdthread_${teammateId}`;
  const createdAt = "2026-07-23T03:10:00.000Z";
  state.providers = [releaseChatProvider("provider_release_teammate", "Release Relay")];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "Release Teammate",
    providerPresetId: "provider_release_teammate",
  })];
  state.teammateDirectMessages = [{
    id: "message_release_teammate",
    workspaceId: "workspace_default",
    threadId,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "Representative private chat response.",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt,
    updatedAt: createdAt,
  }];
}

async function installReleaseAutomationApi(page: Page): Promise<void> {
  const automation = {
    id: "automation_release_gate",
    workspaceId: "workspace_default",
    automationMode: "cron",
    title: "Release automation",
    description: "Representative automation for the Web release gate.",
    kind: "custom_prompt",
    status: "enabled",
    trigger: { type: "manual" },
    target: { scope: "workspace", workspaceId: "workspace_default", cwd },
    promptTemplate: { templateVersion: 1, systemPurpose: "Verify release evidence.", promptMarkdown: "Review representative surfaces.", contextSelectors: [], maxContextItems: 32 },
    executionPolicy: { providerPresetId: "provider_local", allowedTools: ["read"], approvalProfile: { mode: "none" } },
    outputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    threadId: "thread_automation_release_gate",
    createdAt: "2026-07-23T03:20:00.000Z",
    updatedAt: "2026-07-23T03:20:00.000Z",
  };
  await page.route("http://127.0.0.1:17891/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/automations") {
      await route.fulfill({ json: { cwd, automations: [automation], templates: [] } });
      return;
    }
    if (request.method() === "GET" && pathname === "/automation-drafts") {
      await route.fulfill({ json: { cwd, drafts: [], templates: [] } });
      return;
    }
    if (request.method() === "GET" && pathname === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: [] } });
      return;
    }
    if (request.method() === "GET" && pathname === "/automations/scheduler") {
      await route.fulfill({ json: { cwd, schedulers: [] } });
      return;
    }
    await route.fallback();
  });
}

function releaseChatProvider(id: string, displayName: string): Record<string, unknown> {
  return createChatProvider({
    id,
    displayName,
    model: "release-model",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable.",
      checkedAt: "2026-07-23T03:00:00.000Z",
    },
  });
}

function releaseWorkItem(): MockState["workItems"][number] {
  return {
    id: "work_item_release_gate",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    sourceType: "manual",
    sourceId: "work_item_release_gate",
    title: "Release evidence work item",
    status: "ready",
    priority: "high",
    labels: ["release"],
    artifactIds: [],
    proofArtifactIds: [],
    dependencyIds: [],
    attemptCount: 0,
    retryBudget: 2,
    createdAt: "2026-07-23T03:30:00.000Z",
    updatedAt: "2026-07-23T03:30:00.000Z",
  };
}
