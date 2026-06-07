import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  cwd,
  type MockRun,
  type MockState,
} from "./support/mock-state";

test("automations page creates, previews, runs, links runs, and controls the local scheduler", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider()];
  await mockDaemon(page, state);
  const automationState = await mockAutomationRoutes(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Templates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manual setup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create through chat" })).toBeVisible();
  await expect(page.getByLabel("Automation scheduler status")).toContainText("Stopped");

  await page.getByRole("button", { name: "Templates" }).click();
  const templateDialog = page.getByRole("dialog", { name: "Templates" });
  await expect(templateDialog.getByRole("button", { name: /Daily Brief/ })).toBeVisible();
  await expect(templateDialog.getByRole("button", { name: /Weekly Review/ })).toBeVisible();
  await templateDialog.getByRole("button", { name: /Daily Brief/ }).click();
  await expect.poll(() => automationState.drafts.length).toBe(1);
  await expect.poll(() => automationState.automations.length).toBe(0);
  await expect(page.locator(".automation-detail-panel").getByRole("heading", { name: "Draft review" })).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".automation-preview pre")).toContainText("Ship automations P0 and P1");

  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => automationState.automations.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Daily Brief" })).toBeVisible();
  await expect(page.getByText("No runs yet")).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".automation-preview pre")).toContainText("Ship automations P0 and P1");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => automationState.runs.length).toBe(1);
  await expect(page.getByText("Recent automation runs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open run" })).toBeVisible();
  await page.getByRole("button", { name: "Open run" }).click();
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Automation context: Daily Brief/ })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Automations" }).click();
  await page.getByRole("button", { name: "Daily 09:00" }).click();
  await page.getByLabel("Automation scheduler status").getByRole("button", { name: "Start" }).click();
  await expect.poll(() => automationState.schedulerStartCalls).toBe(1);
  await expect(page.getByLabel("Automation scheduler status")).toContainText("running");
  await page.getByLabel("Automation scheduler status").getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => automationState.schedulerStopCalls).toBe(1);
  await expect(page.getByLabel("Automation scheduler status")).toContainText("stopped");
});

interface MockAutomation {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly title: string;
  readonly description: string;
  readonly kind: string;
  readonly status: string;
  readonly trigger: Record<string, unknown>;
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
  readonly channelId: string;
  readonly source: string;
  readonly status: string;
  readonly draft: Partial<MockAutomation>;
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAutomationId?: string;
}

interface MockAutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly workspaceId: string;
  readonly channelId: string;
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
  schedulerStartCalls: number;
  schedulerStopCalls: number;
}

async function mockAutomationRoutes(page: Parameters<typeof mockDaemon>[0], state: MockState): Promise<MockAutomationRouteState> {
  const routeState: MockAutomationRouteState = {
    automations: [],
    drafts: [],
    runs: [],
    schedulers: [],
    schedulerStartCalls: 0,
    schedulerStopCalls: 0,
  };
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path === "/automations") {
      await route.fulfill({ json: { cwd, automations: routeState.automations, templates: createAutomationTemplates() } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-drafts") {
      const status = url.searchParams.get("status");
      const includeTerminal = url.searchParams.get("includeTerminal") === "true";
      await route.fulfill({
        json: {
          cwd,
          drafts: routeState.drafts.filter((draft) => {
            if (status) {
              return draft.status === status;
            }
            return includeTerminal || (draft.status !== "confirmed" && draft.status !== "discarded");
          }),
          templates: createAutomationTemplates(),
        },
      });
      return;
    }
    if (request.method() === "POST" && path === "/automation-drafts") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const draft = createAutomationDraft(routeState, body);
      routeState.drafts.unshift(draft);
      await route.fulfill({ status: 201, json: { cwd, draft } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: routeState.runs } });
      return;
    }
    if (request.method() === "GET" && path === "/automations/scheduler") {
      await route.fulfill({ json: { cwd, schedulers: routeState.schedulers } });
      return;
    }
    if (request.method() === "POST" && path === "/automations/scheduler/start") {
      routeState.schedulerStartCalls += 1;
      const scheduler = createAutomationScheduler(routeState, "running");
      routeState.schedulers = [scheduler];
      await route.fulfill({ json: { cwd, scheduler, duplicate: false } });
      return;
    }
    if (request.method() === "POST" && path === "/automations/scheduler/stop") {
      routeState.schedulerStopCalls += 1;
      const scheduler = createAutomationScheduler(routeState, "stopped");
      routeState.schedulers = [scheduler];
      await route.fulfill({ json: { cwd, scheduler } });
      return;
    }
    const draftRoute = /^\/automation-drafts\/([^/]+)(?:\/(preview|confirm))?$/.exec(path);
    if (draftRoute) {
      const draft = routeState.drafts.find((item) => item.id === decodeURIComponent(draftRoute[1]));
      const action = draftRoute[2];
      if (!draft) {
        await route.fulfill({ status: 404, json: { error: "automation_draft_not_found" } });
        return;
      }
      if (request.method() === "POST" && action === "preview") {
        await route.fulfill({ json: { cwd, draft, context: createAutomationContext(draft.draft.title ?? "Daily Brief") } });
        return;
      }
      if (request.method() === "POST" && action === "confirm") {
        const automation = createAutomationFromDraft(routeState, draft);
        routeState.automations.unshift(automation);
        routeState.drafts = routeState.drafts.map((item) =>
          item.id === draft.id ? { ...item, status: "confirmed", confirmedAutomationId: automation.id, updatedAt: "2026-06-06T00:13:00.000Z" } : item
        );
        await route.fulfill({ status: 201, json: { cwd, draft: routeState.drafts.find((item) => item.id === draft.id), automation, thread: createAutomationThread(automation) } });
        return;
      }
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
        await route.fulfill({ json: { cwd, automation: updatedAutomation, thread: createAutomationThread(updatedAutomation) } });
        return;
      }
    }
    await route.fallback();
  });
  return routeState;
}

function createAutomationTemplates(): readonly Record<string, unknown>[] {
  return [
    {
      id: "daily_brief",
      kind: "daily_brief",
      title: "Daily Brief",
      description: "Summarize channel state every morning.",
      tags: ["daily", "status"],
      defaultChannelId: "channel_engineering",
    },
    {
      id: "weekly_review",
      kind: "weekly_review",
      title: "Weekly Review",
      description: "Review weekly progress and risks.",
      tags: ["weekly", "review"],
      defaultChannelId: "channel_engineering",
    },
  ];
}

function createAutomationDraft(routeState: MockAutomationRouteState, body: Record<string, unknown>): MockAutomationDraft {
  const templateId = typeof body.templateId === "string" ? body.templateId : "daily_brief";
  const title = templateId === "weekly_review" ? "Weekly Review" : "Daily Brief";
  return {
    id: `automation_draft_${routeState.drafts.length + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    source: "template",
    status: "ready",
    draft: {
      title,
      description: `${title} automation draft.`,
      kind: templateId,
      trigger: { type: "manual" },
      target: { scope: "channel", workspaceId: "workspace_default", channelId: "channel_engineering", cwd },
      promptTemplate: {
        templateVersion: 1,
        systemPurpose: "Run a confirmed automation from supplied Ling context only.",
        promptMarkdown: "Ship automations P0 and P1 with evidence.",
        contextSelectors: [{ kind: "channel_brief", channelId: "channel_engineering" }],
        maxContextItems: 32,
      },
      executionPolicy: { providerPresetId: "provider_local", runnerId: "pi" },
      outputPolicy: { destinations: [{ type: "automation_thread" }, { type: "markdown_artifact" }], artifactFormat: "markdown" },
    },
    missingFields: [],
    warnings: [],
    createdAt: "2026-06-06T00:12:00.000Z",
    updatedAt: "2026-06-06T00:12:00.000Z",
  };
}

function createAutomationFromDraft(routeState: MockAutomationRouteState, draft: MockAutomationDraft): MockAutomation {
  const id = `automation_${routeState.automations.length + 1}`;
  return {
    id,
    workspaceId: "workspace_default",
    channelId: draft.channelId,
    threadId: `thread_${id}`,
    title: String(draft.draft.title ?? "Daily Brief"),
    description: String(draft.draft.description ?? "Automation draft."),
    kind: String(draft.draft.kind ?? "daily_brief"),
    status: "enabled",
    trigger: draft.draft.trigger ?? { type: "manual" },
    target: draft.draft.target ?? { scope: "channel", workspaceId: "workspace_default", channelId: draft.channelId, cwd },
    promptTemplate: draft.draft.promptTemplate ?? {
      templateVersion: 1,
      systemPurpose: "Run a confirmed automation from supplied Ling context only.",
      promptMarkdown: "Ship automations P0 and P1 with evidence.",
      contextSelectors: [{ kind: "channel_brief", channelId: draft.channelId }],
      maxContextItems: 32,
    },
    executionPolicy: draft.draft.executionPolicy ?? { providerPresetId: "provider_local", runnerId: "pi" },
    outputPolicy: draft.draft.outputPolicy ?? { destinations: [{ type: "automation_thread" }, { type: "markdown_artifact" }], artifactFormat: "markdown" },
    createdAt: "2026-06-06T00:13:00.000Z",
    updatedAt: "2026-06-06T00:13:00.000Z",
  };
}

function createAutomationThread(automation: MockAutomation): Record<string, unknown> {
  return {
    id: automation.threadId,
    workspaceId: automation.workspaceId,
    kind: "automation",
    channelId: automation.channelId,
    title: automation.title,
    objective: "Ship automations P0 and P1 with evidence.",
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
    "Ship automations P0 and P1 with evidence.",
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
  const contextArtifact = {
    id: `artifact_${automationRunId}_context`,
    runId,
    type: "markdown",
    path: `automation-context/${runId}-${automationRunId}.md`,
    title: `Automation context: ${automation.title}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 512,
    createdAt: now,
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
    contextPreviewArtifactId: contextArtifact.id,
    outputArtifactIds: [contextArtifact.id],
  };
  state.runs.unshift(run);
  state.artifactsByRun[runId] = [contextArtifact];
  routeState.runs.unshift(automationRun);
  const updatedAutomation = { ...automation, lastRunId: automationRun.id, updatedAt: now };
  routeState.automations = routeState.automations.map((item) => item.id === automation.id ? updatedAutomation : item);
  return { automation: updatedAutomation, automationRun, context };
}

function createAutomationScheduler(routeState: MockAutomationRouteState, status: "running" | "stopped"): MockAutomationScheduler {
  const scheduled = routeState.automations.filter((automation) => automation.status === "enabled" && automation.trigger.type === "schedule");
  return {
    id: routeState.schedulers[0]?.id ?? "automation_scheduler_1",
    cwd,
    status,
    startedAt: "2026-06-06T00:20:00.000Z",
    stoppedAt: status === "stopped" ? "2026-06-06T00:21:00.000Z" : undefined,
    automationCount: scheduled.length,
    tickCount: 0,
    nextRunAt: status === "running" && scheduled.length > 0 ? "2026-06-06T00:21:00.000Z" : undefined,
    items: scheduled.map((automation) => ({
      automationId: automation.id,
      title: automation.title,
      nextRunAt: status === "running" ? "2026-06-06T00:21:00.000Z" : undefined,
    })),
  };
}
