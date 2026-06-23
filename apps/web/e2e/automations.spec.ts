import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  cwd,
  type MockRun,
  type MockState,
} from "./support/mock-state";

test("automations page uses Codex-style inbox, manual composer, templates, and auto scheduler recovery", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({ id: "provider_local", displayName: "中转站", model: "gpt-test" })];
  await mockDaemon(page, state);
  const automationState = await mockAutomationRoutes(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "自动化" }).click();
  const automationsPage = page.locator(".automations-inbox-page");
  await expect(automationsPage.getByRole("heading", { name: "自动化", level: 1 })).toBeVisible();
  await expect(automationsPage.getByRole("tab", { name: /运行中/ })).toHaveAttribute("aria-selected", "true");
  await expect(automationsPage.getByRole("heading", { name: "当前", level: 2 })).toHaveCount(0);
  const tabOverflow = await automationsPage.locator(".automation-tab-list").evaluate((element) => getComputedStyle(element).overflowX);
  expect(tabOverflow).toBe("visible");
  await expect(automationsPage.getByText("本地服务会自动恢复计划任务。")).toBeVisible();
  await expect(automationsPage.getByRole("button", { name: /通过聊天创建/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);

  await automationsPage.getByRole("button", { name: /通过聊天创建/ }).click();
  const chatDialog = page.getByRole("dialog", { name: "通过聊天创建" });
  await chatDialog.locator("textarea").fill("每分钟给我发一下你好");
  await chatDialog.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByRole("dialog", { name: "通过聊天创建" })).toHaveCount(0);
  const chatDraftRow = automationsPage.locator(".automation-inbox-row.draft", { hasText: "每分钟给我发一下你好" });
  await expect(chatDraftRow).toBeVisible();
  await expect(chatDraftRow.getByText("每 1 分钟")).toBeVisible();
  await chatDraftRow.getByRole("button", { name: "确认启用自动化" }).click();
  await expect.poll(() => automationState.automations.length).toBe(1);
  await expect(chatDraftRow).toHaveCount(0);
  await expect(automationsPage.locator(".automation-inbox-row", { hasText: "每分钟给我发一下你好" })).toBeVisible();
  await expect.poll(() => automationState.schedulers[0]?.status).toBe("running");

  await page.getByLabel("选择创建方式").click();
  await expect(page.getByRole("menuitem", { name: /通过聊天创建/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /使用模板/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /手动创建/ }).click();

  const manualDialog = page.getByRole("dialog", { name: "手动创建" });
  await expect(manualDialog.getByPlaceholder("自动化功能标题")).toBeVisible();
  await expect(manualDialog.getByPlaceholder("添加提示词，例如：在 $sentry 中查找崩溃")).toBeVisible();
  await manualDialog.getByPlaceholder("自动化功能标题").fill("每日检查");
  await manualDialog.getByPlaceholder("添加提示词，例如：在 $sentry 中查找崩溃").fill("每天检查最近运行、审批和风险。");

  await manualDialog.getByRole("button", { name: /工作树/ }).click();
  await expect(manualDialog.getByRole("button", { name: /本地/ })).toBeVisible();
  await expect(manualDialog.getByRole("button", { name: /工作树/ }).nth(1)).toBeVisible();
  await expect(manualDialog.getByRole("button", { name: /对话/ })).toBeVisible();
  await manualDialog.getByRole("button", { name: /本地/ }).click();

  await manualDialog.getByRole("button", { name: /每天 09:00/ }).click();
  await expect(manualDialog.getByLabel("计划")).toBeVisible();
  await expect(manualDialog.getByLabel("时间")).toHaveValue("09:00");

  await manualDialog.locator(".automation-risk-tooltip").focus();
  await expect(manualDialog.getByText("自动化会按计划运行。只读工具风险最低；写入或 Shell 权限应保持显式审批。")).toBeVisible();

  await manualDialog.getByRole("button", { name: "创建" }).click();
  await expect.poll(() => automationState.automations.length).toBe(2);
  await expect(page.getByRole("dialog", { name: "手动创建" })).toHaveCount(0);
  const createdRow = automationsPage.locator(".automation-inbox-row", { hasText: "每日检查" });
  await expect(createdRow).toBeVisible();
  await expect(createdRow.getByText(/本地 ·/)).toBeVisible();
  await expect(createdRow.getByText("每天 09:00")).toBeVisible();
  await expect.poll(() => automationState.schedulers[0]?.status).toBe("running");

  await page.getByLabel("选择创建方式").click();
  await page.getByRole("menuitem", { name: /使用模板/ }).click();
  const templateDialog = page.getByRole("dialog", { name: "自动化模板" });
  await expect(templateDialog.getByRole("button", { name: /Bug 扫描/ })).toBeVisible();
  await expect(templateDialog.getByRole("button", { name: /迷你游戏/ })).toBeVisible();
  await templateDialog.getByRole("button", { name: /迷你游戏/ }).click();
  const filledManualDialog = page.getByRole("dialog", { name: "手动创建" });
  await expect(filledManualDialog.getByPlaceholder("自动化功能标题")).toHaveValue("迷你游戏");
  await expect(filledManualDialog.getByPlaceholder("添加提示词，例如：在 $sentry 中查找崩溃")).toHaveValue(/经典小游戏/);
});

interface MockAutomation {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly automationMode?: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: string;
  readonly status: string;
  readonly trigger: Record<string, unknown>;
  readonly rrule?: string;
  readonly cwds?: readonly string[];
  readonly targetThreadId?: string;
  readonly executionEnvironment?: string;
  readonly reasoningEffort?: string;
  readonly model?: string;
  readonly target: Record<string, unknown>;
  readonly promptTemplate: Record<string, unknown>;
  readonly executionPolicy: Record<string, unknown>;
  readonly outputPolicy: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunId?: string;
  readonly nextRunAt?: string;
}

interface MockAutomationDraft {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly source: string;
  readonly status: string;
  readonly title?: string;
  readonly description?: string;
  readonly kind?: string;
  readonly trigger?: Record<string, unknown>;
  readonly target?: Record<string, unknown>;
  readonly promptTemplate?: Record<string, unknown>;
  readonly executionPolicy?: Record<string, unknown>;
  readonly outputPolicy?: Record<string, unknown>;
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAutomationId?: string;
  readonly discardedAt?: string;
}

interface MockAutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly triggerType: string;
  readonly firedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status: string;
  readonly idempotencyKey: string;
  readonly contextPreviewArtifactId?: string;
  readonly outputArtifactIds: readonly string[];
}

interface MockAutomationScheduler {
  readonly id: string;
  readonly cwd: string;
  readonly status: "running" | "stopped";
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly automationCount: number;
  readonly tickCount: number;
  readonly nextRunAt?: string;
  readonly items: readonly {
    readonly automationId: string;
    readonly title: string;
    readonly nextRunAt?: string;
  }[];
}

interface MockAutomationRouteState {
  automations: MockAutomation[];
  drafts: MockAutomationDraft[];
  runs: MockAutomationRun[];
  schedulers: MockAutomationScheduler[];
}

async function mockAutomationRoutes(page: Parameters<typeof mockDaemon>[0], state: MockState): Promise<MockAutomationRouteState> {
  const routeState: MockAutomationRouteState = {
    automations: [],
    drafts: [],
    runs: [],
    schedulers: [createAutomationScheduler([], "running")],
  };
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path === "/automations") {
      refreshScheduler(routeState);
      await route.fulfill({ json: { cwd, automations: routeState.automations, templates: createAutomationTemplates() } });
      return;
    }
    if (request.method() === "POST" && path === "/automations") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const automation = createAutomationFromRequest(routeState, state, body);
      routeState.automations.unshift(automation);
      refreshScheduler(routeState);
      await route.fulfill({ status: 201, json: { cwd, automation, thread: createAutomationThread(automation) } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-drafts") {
      const includeTerminal = url.searchParams.get("includeTerminal") === "true";
      const drafts = includeTerminal
        ? routeState.drafts
        : routeState.drafts.filter((draft) => draft.status !== "confirmed" && draft.status !== "discarded");
      await route.fulfill({ json: { cwd, drafts, templates: createAutomationTemplates() } });
      return;
    }
    if (request.method() === "POST" && path === "/automation-drafts") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const draft = createAutomationDraft(routeState, body);
      routeState.drafts.unshift(draft);
      await route.fulfill({ status: 201, json: { cwd, draft } });
      return;
    }
    const draftRoute = /^\/automation-drafts\/([^/]+)(?:\/(confirm|preview))?$/.exec(path);
    if (draftRoute) {
      const draft = routeState.drafts.find((item) => item.id === decodeURIComponent(draftRoute[1]));
      const action = draftRoute[2];
      if (!draft) {
        await route.fulfill({ status: 404, json: { error: "automation_draft_not_found" } });
        return;
      }
      if (request.method() === "POST" && action === "preview") {
        await route.fulfill({ json: { cwd, draft, context: createAutomationContext(draft.title ?? "Draft") } });
        return;
      }
      if (request.method() === "POST" && action === "confirm") {
        const existingAutomation = draft.confirmedAutomationId
          ? routeState.automations.find((automation) => automation.id === draft.confirmedAutomationId)
          : undefined;
        const automation = existingAutomation ?? createAutomationFromDraft(routeState, state, draft);
        if (!existingAutomation) {
          routeState.automations.unshift(automation);
        }
        const confirmed = {
          ...draft,
          status: "confirmed",
          confirmedAutomationId: automation.id,
          updatedAt: "2026-06-06T00:17:00.000Z",
        };
        routeState.drafts = routeState.drafts.map((item) => item.id === draft.id ? confirmed : item);
        refreshScheduler(routeState);
        await route.fulfill({ status: existingAutomation ? 200 : 201, json: { cwd, draft: confirmed, automation, thread: createAutomationThread(automation) } });
        return;
      }
      if (request.method() === "DELETE" && !action) {
        const discarded = {
          ...draft,
          status: "discarded",
          discardedAt: "2026-06-06T00:18:00.000Z",
          updatedAt: "2026-06-06T00:18:00.000Z",
        };
        routeState.drafts = routeState.drafts.map((item) => item.id === draft.id ? discarded : item);
        await route.fulfill({ json: { cwd, draft: discarded } });
        return;
      }
    }
    if (request.method() === "GET" && path === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: routeState.runs } });
      return;
    }
    if (request.method() === "GET" && path === "/automations/scheduler") {
      refreshScheduler(routeState);
      await route.fulfill({ json: { cwd, schedulers: routeState.schedulers } });
      return;
    }
    const automationRoute = /^\/automations\/([^/]+)(?:\/(preview|run))?$/.exec(path);
    if (automationRoute) {
      const automation = routeState.automations.find((item) => item.id === decodeURIComponent(automationRoute[1]));
      const action = automationRoute[2];
      if (!automation) {
        await route.fulfill({ status: 404, json: { error: "automation_not_found" } });
        return;
      }
      if (request.method() === "POST" && action === "preview") {
        await route.fulfill({ json: { cwd, automation, context: createAutomationContext(automation.title) } });
        return;
      }
      if (request.method() === "POST" && action === "run") {
        const result = createAutomationRun(routeState, state, automation);
        await route.fulfill({ json: { cwd, ...result } });
        return;
      }
      if (request.method() === "PATCH" && !action) {
        const body = await request.postDataJSON() as Partial<MockAutomation>;
        const updatedAutomation = { ...automation, ...body, updatedAt: "2026-06-06T00:15:00.000Z" };
        routeState.automations = routeState.automations.map((item) => item.id === automation.id ? updatedAutomation : item);
        refreshScheduler(routeState);
        await route.fulfill({ json: { cwd, automation: updatedAutomation, thread: createAutomationThread(updatedAutomation) } });
        return;
      }
      if (request.method() === "DELETE" && !action) {
        const archived = { ...automation, status: "archived", updatedAt: "2026-06-06T00:16:00.000Z" };
        routeState.automations = routeState.automations.map((item) => item.id === automation.id ? archived : item);
        refreshScheduler(routeState);
        await route.fulfill({ json: { cwd, automation: archived, thread: createAutomationThread(archived) } });
        return;
      }
    }
    await route.fallback();
  });
  return routeState;
}

function refreshScheduler(routeState: MockAutomationRouteState): void {
  routeState.schedulers = [createAutomationScheduler(routeState.automations, "running")];
}

function createAutomationTemplates(): readonly Record<string, unknown>[] {
  return [
    {
      id: "daily_brief",
      kind: "daily_brief",
      title: "Daily Brief",
      description: "Summarize the latest channel context, recent runs, approvals, and external work.",
      tags: ["daily", "status"],
      defaultChannelId: "channel_engineering",
      defaultTrigger: { type: "manual" },
      defaultPromptTemplate: { promptMarkdown: "Write today's brief.", contextSelectors: [], maxContextItems: 32, templateVersion: 1 },
      defaultExecutionPolicy: { allowedTools: ["read", "grep", "find", "ls"], approvalProfile: { mode: "none" } },
      defaultOutputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    },
    {
      id: "bug_scan",
      kind: "custom_prompt",
      title: "Bug Scan",
      description: "Inspect recent runs and artifacts for likely regressions with evidence.",
      tags: ["bugs", "risk"],
      defaultChannelId: "channel_engineering",
      defaultTrigger: { type: "manual" },
      defaultPromptTemplate: { promptMarkdown: "Identify likely regressions.", contextSelectors: [], maxContextItems: 32, templateVersion: 1 },
      defaultExecutionPolicy: { allowedTools: ["read", "grep", "find", "ls"], approvalProfile: { mode: "none" } },
      defaultOutputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    },
  ];
}

function createAutomationFromRequest(routeState: MockAutomationRouteState, state: MockState, body: Record<string, unknown>): MockAutomation {
  const id = `automation_${routeState.automations.length + 1}`;
  const target = isRecord(body.target) ? body.target : {};
  const channelId = typeof body.channelId === "string"
    ? body.channelId
    : typeof target.channelId === "string"
      ? target.channelId
      : readFirstChannelId(state);
  const trigger = isRecord(body.trigger) ? body.trigger : { type: "manual" };
  const promptTemplate = isRecord(body.promptTemplate)
    ? body.promptTemplate
    : { templateVersion: 1, systemPurpose: "Run automation.", promptMarkdown: "Run automation.", contextSelectors: [], maxContextItems: 32 };
  return {
    id,
    workspaceId: "workspace_default",
    channelId,
    threadId: `thread_${id}`,
    automationMode: typeof body.automationMode === "string" ? body.automationMode : "cron",
    title: String(body.title ?? "Automation"),
    description: typeof body.description === "string" ? body.description : "Manual automation.",
    kind: String(body.kind ?? "custom_prompt"),
    status: String(body.status ?? "enabled"),
    trigger,
    rrule: typeof body.rrule === "string" ? body.rrule : undefined,
    cwds: Array.isArray(body.cwds) ? body.cwds.filter((item): item is string => typeof item === "string") : [],
    targetThreadId: typeof body.targetThreadId === "string" ? body.targetThreadId : undefined,
    executionEnvironment: typeof body.executionEnvironment === "string" ? body.executionEnvironment : undefined,
    reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    target: Object.keys(target).length > 0 ? target : { scope: channelId ? "channel" : "workspace", workspaceId: "workspace_default", channelId, cwd },
    promptTemplate,
    executionPolicy: isRecord(body.executionPolicy) ? body.executionPolicy : { providerPresetId: "provider_local", allowedTools: ["read", "grep", "find", "ls"], approvalProfile: { mode: "none" } },
    outputPolicy: isRecord(body.outputPolicy) ? body.outputPolicy : { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    nextRunAt: trigger.type === "schedule" ? "2026-06-06T01:00:00.000Z" : undefined,
    createdAt: "2026-06-06T00:13:00.000Z",
    updatedAt: "2026-06-06T00:13:00.000Z",
  };
}

function createAutomationFromDraft(routeState: MockAutomationRouteState, state: MockState, draft: MockAutomationDraft): MockAutomation {
  return createAutomationFromRequest(routeState, state, {
    channelId: draft.channelId,
    title: draft.title,
    description: draft.description,
    kind: draft.kind,
    trigger: draft.trigger,
    target: draft.target,
    promptTemplate: draft.promptTemplate,
    executionPolicy: draft.executionPolicy,
    outputPolicy: draft.outputPolicy,
  });
}

function createAutomationDraft(routeState: MockAutomationRouteState, body: Record<string, unknown>): MockAutomationDraft {
  const partial = isRecord(body.partialAutomation) ? body.partialAutomation : {};
  const source = String(body.source ?? "manual");
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const title = typeof partial.title === "string" ? partial.title : prompt || "Daily Brief";
  const channelId = typeof partial.channelId === "string" ? partial.channelId : "channel_engineering";
  const trigger = isRecord(partial.trigger)
    ? partial.trigger
    : source === "chat"
      ? inferMockChatDraftTrigger(prompt)
      : { type: "manual" };
  return {
    id: `automation_draft_${routeState.drafts.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    source,
    status: "ready_for_confirmation",
    title,
    description: `${title} automation draft.`,
    kind: typeof partial.kind === "string" ? partial.kind : "custom_prompt",
    trigger,
    target: isRecord(partial.target) ? partial.target : { scope: "channel", workspaceId: "workspace_default", channelId, cwd },
    promptTemplate: isRecord(partial.promptTemplate) ? partial.promptTemplate : {
      templateVersion: 1,
      systemPurpose: "Run automation.",
      promptMarkdown: prompt || "Ship automations with evidence.",
      contextSelectors: [],
      maxContextItems: 32,
    },
    executionPolicy: isRecord(partial.executionPolicy) ? partial.executionPolicy : { providerPresetId: "provider_local", runnerId: "pi" },
    outputPolicy: isRecord(partial.outputPolicy) ? partial.outputPolicy : { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    missingFields: [],
    warnings: [],
    createdAt: "2026-06-06T00:12:00.000Z",
    updatedAt: "2026-06-06T00:12:00.000Z",
  };
}

function inferMockChatDraftTrigger(prompt: string): Record<string, unknown> {
  const normalized = prompt.toLowerCase();
  if (/每分钟|每\s*1\s*分钟|一分钟一次|every\s+minute|once\s+a\s+minute/.test(normalized)) {
    return { type: "schedule", timezone: "Asia/Shanghai", schedule: { cadence: "interval", everyMs: 60_000 }, missedRunPolicy: "skip" };
  }
  const zhMinutes = /每\s*(\d{1,3})\s*分钟/.exec(normalized);
  if (zhMinutes) {
    return {
      type: "schedule",
      timezone: "Asia/Shanghai",
      schedule: { cadence: "interval", everyMs: Number.parseInt(zhMinutes[1], 10) * 60_000 },
      missedRunPolicy: "skip",
    };
  }
  if (/\bdaily\b|每天|日报/.test(normalized)) {
    return { type: "schedule", timezone: "Asia/Shanghai", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" };
  }
  return { type: "manual" };
}

function createAutomationThread(automation: MockAutomation): Record<string, unknown> {
  return {
    id: automation.threadId,
    workspaceId: automation.workspaceId,
    kind: "automation",
    channelId: automation.channelId,
    title: automation.title,
    objective: String(automation.promptTemplate.promptMarkdown ?? automation.title),
    status: "open",
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function createAutomationContext(title: string): Record<string, unknown> {
  const contextMarkdown = [
    "# Automation Context",
    "",
    `Automation: ${title}`,
    "Channel: Engineering",
    "",
    "Ship automations with evidence.",
  ].join("\n");
  return {
    contextMarkdown,
    renderedPrompt: `${title}\n\n${contextMarkdown}`,
    selectedRefs: [{ kind: "channel_brief", id: "channel_engineering", label: "Engineering" }],
    estimatedTokens: 128,
  };
}

function createAutomationRun(
  routeState: MockAutomationRouteState,
  state: MockState,
  automation: MockAutomation,
): { readonly automation: MockAutomation; readonly automationRun: MockAutomationRun; readonly context: Record<string, unknown> } {
  const now = "2026-06-06T00:14:00.000Z";
  const context = createAutomationContext(automation.title);
  const runId = `run_automation_${routeState.runs.length + 1}`;
  const automationRunId = `automation_run_${routeState.runs.length + 1}`;
  const run: MockRun = {
    id: runId,
    status: "succeeded",
    cwd,
    taskId: `automation-${automation.id}`,
    channelId: automation.channelId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: `automation-${automation.id}`, title: automation.title },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: {
      cwd,
      threadId: automation.threadId,
      task: { id: `automation-${automation.id}`, title: automation.title, prompt: context.renderedPrompt },
      provider: { provider: "test-provider", model: "test-model" },
      appendSystemPrompt: ["This is a Ling automation run."],
    },
    eventLogPath: "/tmp/automation-run.jsonl",
    threadId: automation.threadId,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    endedAt: now,
  };
  const automationRun: MockAutomationRun = {
    id: automationRunId,
    automationId: automation.id,
    workspaceId: automation.workspaceId,
    channelId: automation.channelId,
    threadId: automation.threadId,
    runId,
    triggerType: "manual",
    firedAt: now,
    startedAt: now,
    completedAt: now,
    status: "succeeded",
    idempotencyKey: `automation:${automation.id}:manual:${routeState.runs.length + 1}`,
    outputArtifactIds: [],
  };
  state.runs.unshift(run);
  routeState.runs.unshift(automationRun);
  const updatedAutomation = { ...automation, lastRunId: automationRun.id, updatedAt: now };
  routeState.automations = routeState.automations.map((item) => item.id === automation.id ? updatedAutomation : item);
  return { automation: updatedAutomation, automationRun, context };
}

function createAutomationScheduler(automations: readonly MockAutomation[], status: "running" | "stopped"): MockAutomationScheduler {
  const scheduled = automations.filter((automation) => automation.status === "enabled" && automation.trigger.type === "schedule");
  return {
    id: "automation_scheduler_1",
    cwd,
    status,
    startedAt: "2026-06-06T00:20:00.000Z",
    stoppedAt: status === "stopped" ? "2026-06-06T00:21:00.000Z" : undefined,
    automationCount: scheduled.length,
    tickCount: 0,
    nextRunAt: status === "running" && scheduled.length > 0 ? "2026-06-06T01:00:00.000Z" : undefined,
    items: scheduled.map((automation) => ({
      automationId: automation.id,
      title: automation.title,
      nextRunAt: status === "running" ? "2026-06-06T01:00:00.000Z" : undefined,
    })),
  };
}

function readFirstChannelId(state: MockState): string | undefined {
  const channel = state.channels.find(isRecord);
  return typeof channel?.id === "string" ? channel.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
