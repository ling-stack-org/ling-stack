import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const cwd = "/tmp/ling-stack-workspace";
const defaultRuntimePolicy = {
  maxConcurrentRuns: 1,
  executionMode: "serial",
  writeLockScope: "boundPath",
  allowReadOnlyParallel: true,
  queueOnConflict: true,
};

interface MockState {
  providers: unknown[];
  channels: unknown[];
  channelMessages: unknown[];
  channelAttachments: unknown[];
  channelLinkPreviews: unknown[];
  channelBriefs: Record<string, unknown>;
  channelDecisions: unknown[];
  channelHandoffs: unknown[];
  channelContextSummaries: unknown[];
  channelWorkflows: unknown[];
  channelWorkflowSteps: unknown[];
  tasks: unknown[];
  runs: MockRun[];
  eventsByRun: Record<string, MockRunEvent[]>;
  nextStreamEvents?: MockRunEvent[];
  providerCheckDelayMs?: number;
  runResponseDelayMs?: number;
  channelMessageDelayMs?: number;
  failNextChannelMessage?: boolean;
  linkPreviewDelayMs?: number;
  approvals: MockApproval[];
  approvalPolicy: MockApprovalPolicy;
  lastApprovalPolicyPatch?: Record<string, unknown>;
  mediaJobs: MockMediaJob[];
  resourceLeases: unknown[];
  stateTransitions: unknown[];
  artifactsByRun: Record<string, MockArtifact[]>;
  artifactsByMediaJob: Record<string, MockArtifact[]>;
}

interface MockRun {
  id: string;
  status: string;
  cwd: string;
  taskId: string;
  channelId?: string;
  providerPresetId?: string;
  providerName: string;
  providerModel: string;
  taskSnapshot: unknown;
  providerSnapshot: unknown;
  requestSnapshot: unknown;
  eventLogPath: string;
  summaryPath?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface MockRunEvent {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}

interface MockApproval {
  id: string;
  runId?: string;
  taskId?: string;
  mediaJobId?: string;
  actionType: string;
  risk: string;
  title: string;
  description: string;
  payload: unknown;
  status: string;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: "local-user";
  decisionReason?: string;
}

interface MockApprovalPolicy {
  workspaceId: string;
  toolDecisions: Record<string, string>;
  allowedWritePaths: string[];
  createdAt: string;
  updatedAt: string;
}

interface MockArtifact {
  id: string;
  runId?: string;
  mediaJobId?: string;
  type: string;
  path: string;
  title?: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt: string;
}

interface MockMediaJob {
  id: string;
  workspaceId: string;
  providerPresetId: string;
  operation: string;
  prompt: string;
  input: Record<string, unknown>;
  artifactIds: string[];
  status: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

test("workspace opens as a task workbench with task context in the inspector", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Workspace task toolbar")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await expect(page.getByLabel("Task inspector")).toContainText("Task context");
  await expect(page.getByLabel("Task inspector")).toContainText("run_failed");
  await openChannelTasksTab(page);
  const taskDetail = page.locator("article.task-detail");
  await expect(taskDetail).toContainText("Task detail");
  await expect(taskDetail).toContainText("run_failed");
});

test("channel runtime policy and default teammate are visible and used when creating channels", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  const openAiTemplate = {
    templateId: "openai-gpt",
    description: "Official OpenAI endpoint.",
    kind: "openai",
    displayName: "OpenAI GPT",
    providerId: "openai",
    model: "gpt-5.4",
    api: "openai-completions",
    apiKeyRef: "env:OPENAI_API_KEY",
    capabilities: ["chat", "tool_call", "reasoning"],
    input: ["text"],
    enabled: false,
    authHeader: true,
    reasoning: true,
  };
  await mockDaemon(page, state, { templates: [openAiTemplate] });
  await page.goto("/");

  await expect(page.getByText("active · serial · boundPath lock")).toBeVisible();
  await expect(page.locator(".channel-header-actions")).toContainText("Engineer");

  const details = page.locator(".channel-options");
  await details.locator("summary").click();
  await details.getByLabel("Name").fill("Release");
  await details.getByLabel("Status").selectOption("paused");
  await details.getByLabel("Default AI teammate").selectOption("designer");
  await details.getByLabel("Execution mode").selectOption("parallel");
  await details.getByLabel("Write lock").selectOption("workspace");
  await details.getByLabel("Max runs").fill("2");
  await details.getByLabel("Queue on conflict").uncheck();
  await details.getByRole("button", { name: "Create channel" }).click();

  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Release")).toBe(true);
  const created = state.channels.find((channel) => isRecord(channel) && channel.name === "Release");
  expect(created).toBeTruthy();
  expect(isRecord(created) ? created.status : undefined).toBe("paused");
  expect(isRecord(created) ? created.defaultTeammateId : undefined).toBe("designer");
  const runtimePolicy = isRecord(created) && isRecord(created.runtimePolicy) ? created.runtimePolicy : {};
  expect(runtimePolicy.executionMode).toBe("parallel");
  expect(runtimePolicy.writeLockScope).toBe("workspace");
  expect(runtimePolicy.maxConcurrentRuns).toBe(2);
  expect(runtimePolicy.queueOnConflict).toBe(false);
  await expect(page.locator(".channel-header-actions")).toContainText("Designer");
});

test("paused channels disable task run actions", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = state.channels.map((channel) => isRecord(channel) ? { ...channel, status: "paused" } : channel);
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelTasksTab(page);
  const taskCard = page.locator("article.task-detail");
  await expect(taskCard).toContainText("Channel is not active");
  await expect(taskCard.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
});

test("channel activity supports mentions, messages, files, links, and task creation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessageDelayMs = 150;
  state.linkPreviewDelayMs = 150;
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await page.locator(".mention-chip").filter({ hasText: "@Engineer" }).click();
  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("@Engineer please refine the channel requirements https://example.com");
  await page.getByPlaceholder("Paste URL").fill("https://example.com");
  await page.getByRole("button", { name: "Preview link" }).click();
  await expect(page.getByText("Fetching link preview...")).toBeVisible();
  await expect(page.locator(".channel-tab.active")).toContainText("Activity");
  await expect(page.getByText("Example Domain").first()).toBeVisible();
  await page.locator("input[type=file]").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("channel brief"),
  });
  await expect(page.getByText("brief.txt")).toBeVisible();
  await expect(page.locator(".channel-tab.active")).toContainText("Activity");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Sending message...")).toBeVisible();
  await expect(page.getByText("AI teammate is replying...")).toBeVisible();

  await expect(page.getByText("@Engineer please refine the channel requirements")).toBeVisible();
  await expect(page.getByText("收到，我会按频道上下文推进。")).toBeVisible();
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByText("brief.txt")).toBeVisible();
  await expect(page.getByText("Example Domain")).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Create task" }).first().click();
  await expect(page.getByText("Task created")).toBeVisible();
  await expect.poll(() => {
    const created = state.tasks.find((task) => isRecord(task) && task.id === "task_2");
    return isRecord(created) ? created.assigneeTeammateId : undefined;
  }).toBe("engineer");
  await page.getByRole("button", { name: "Open in Tasks" }).click();
  await expect(page.locator(".channel-tab.active")).toContainText("Tasks");
  await expect(page.locator("article.task-detail")).toContainText("@Engineer please refine the channel requirements");
});

test("channel activity keeps the composer visible while the message feed scrolls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = Array.from({ length: 36 }, (_, index) => ({
    id: `msg_scroll_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: `Scrollable channel message ${index + 1}. This message keeps the Activity feed tall enough to scroll independently.`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 4, 25, 0, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 4, 25, 0, index, 0)).toISOString(),
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  const scrollState = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollState.max).toBeGreaterThan(0);
  const tabsBefore = await page.locator(".channel-tabs").boundingBox();
  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const tabsAfter = await page.locator(".channel-tabs").boundingBox();
  expect(Math.round(tabsAfter?.y ?? 0)).toBe(Math.round(tabsBefore?.y ?? 0));
  await expect(page.getByLabel("Channel composer")).toBeVisible();
});

test("channel composer preserves failed sends and can retry", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.failNextChannelMessage = true;
  await mockDaemon(page, state);
  await page.goto("/");

  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await composerInput.fill("Retryable channel message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Message failed")).toBeVisible();
  await expect(composerInput).toHaveValue("Retryable channel message");

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Channel message feed").getByText("Retryable channel message")).toBeVisible();
  await expect(composerInput).toHaveValue("");
  await expect(page.getByText("Message failed")).toHaveCount(0);
});

test("channel URL preview blocked state stays in Activity and still allows sending text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Please remember this blocked reference.");
  await page.getByPlaceholder("Paste URL").fill("http://127.0.0.1/private");
  await page.getByRole("button", { name: "Preview link" }).click();
  await expect(page.getByText("Private network previews are blocked.")).toBeVisible();
  await expect(page.locator(".channel-tab.active")).toContainText("Activity");

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Please remember this blocked reference.")).toBeVisible();
});

test("channel files tab supports PDF and Office uploads without AI ingestion", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  const initialMessageCount = state.channelMessages.length;
  const initialTaskCount = state.tasks.length;
  await expect(page.getByPlaceholder("Message this channel or @ an AI teammate")).toBeVisible();
  await page.locator("input[type=file]").setInputFiles([
    {
      name: "requirements.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7"),
    },
    {
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("docx"),
    },
    {
      name: "budget.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("xlsx"),
    },
    {
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("pptx"),
    },
  ]);

  await expect.poll(() => state.channelAttachments.length).toBe(4);
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByRole("button", { name: "Files" })).toHaveClass(/active/);
  for (const fileName of ["requirements.pdf", "notes.docx", "budget.xlsx", "deck.pptx"]) {
    const card = page.locator(".file-card").filter({ hasText: fileName });
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/attachments\/att_.*\/content/);
  }
  expect(state.channelAttachments.filter((attachment) => isRecord(attachment)).map((attachment) => attachment.fileName).sort()).toEqual([
    "budget.xlsx",
    "deck.pptx",
    "notes.docx",
    "requirements.pdf",
  ]);
  expect(state.channelAttachments.every((attachment) => isRecord(attachment) && (attachment.kind === "pdf" || attachment.kind === "office"))).toBe(true);
  expect(state.channelMessages.length).toBe(initialMessageCount);
  expect(state.tasks.length).toBe(initialTaskCount);
});

test("channel files tab aggregates run artifacts and keeps other channel artifacts isolated", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  });
  state.tasks.push({
    id: "task_design",
    workspaceId: "workspace_default",
    channelId: "channel_design",
    title: "Design artifact task",
    prompt: "Produce design artifacts.",
    status: "done",
    currentRunId: "run_design",
    createdAt: "2026-05-25T00:10:00.000Z",
    updatedAt: "2026-05-25T00:20:00.000Z",
  });
  state.runs = [
    {
      ...state.runs[0],
      status: "succeeded",
      summaryPath: ".ling-stack/summaries/run_failed.json",
      errorMessage: undefined,
      updatedAt: "2026-05-25T00:20:30.000Z",
    },
    {
      id: "run_design",
      status: "succeeded",
      cwd,
      taskId: "task_design",
      channelId: "channel_design",
      providerPresetId: "provider_local",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      taskSnapshot: { id: "task_design", title: "Design artifact task" },
      providerSnapshot: { provider: "local-relay", model: "gpt-5.5" },
      requestSnapshot: { cwd, providerPresetId: "provider_local" },
      eventLogPath: ".ling-stack/sessions/run_design.jsonl",
      summaryPath: ".ling-stack/summaries/run_design.json",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:20:00.000Z",
    },
  ];
  state.artifactsByRun.run_failed = [
    {
      id: "artifact_channel_report",
      runId: "run_failed",
      type: "markdown",
      path: "run_failed/001-channel-report.md",
      title: "Channel report",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 512,
      createdAt: "2026-05-25T00:20:31.000Z",
    },
    {
      id: "artifact_channel_image",
      runId: "run_failed",
      type: "image",
      path: "run_failed/002-channel-image.png",
      title: "Channel image",
      contentType: "image/png",
      sizeBytes: 2048,
      createdAt: "2026-05-25T00:20:32.000Z",
    },
  ];
  state.artifactsByRun.run_design = [
    {
      id: "artifact_design_report",
      runId: "run_design",
      type: "markdown",
      path: "run_design/001-design-report.md",
      title: "Other channel report",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 128,
      createdAt: "2026-05-25T00:20:33.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByText("Loading run artifacts...")).toHaveCount(0);
  await expect(page.getByText("Run artifacts")).toBeVisible();
  await expect(page.locator(".run-artifact-group")).toHaveCount(1);
  const runGroup = page.locator(".run-artifact-group").filter({ hasText: "run_failed" });
  await expect(runGroup).toContainText("Inspect workspace");
  await expect(runGroup).toContainText(".ling-stack/sessions/run_failed.jsonl");
  await expect(runGroup).toContainText(".ling-stack/summaries/run_failed.json");
  await expect(runGroup.locator(".artifact-row").first()).toContainText("Channel report");
  await expect(runGroup.locator(".artifact-row").first()).toHaveAttribute(
    "href",
    /\/artifacts\/artifact_channel_report\/content\?cwd=%2Ftmp%2Fling-stack-workspace/,
  );
  const imageRow = runGroup.locator(".artifact-row").filter({ hasText: "Channel image" });
  await expect(imageRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_channel_image\/content/);
  await expect(imageRow.getByRole("link", { name: "Download" })).toHaveAttribute("href", /\/artifacts\/artifact_channel_image\/content/);
  await expect(page.getByText("Other channel report")).toHaveCount(0);
});

test("channel v1.1 protocol supports brief, decisions, handoffs, and context task creation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  const briefLoaded = page.waitForResponse((response) => response.url().includes("/channels/channel_engineering/brief") && response.request().method() === "GET");
  await page.goto("/");
  await briefLoaded;

  await expect(page.getByText("Loading protocol...")).toHaveCount(0);
  await expect(page.getByLabel("Objective")).toHaveCount(0);
  await page.getByRole("button", { name: "Channel protocol" }).click();
  await page.getByLabel("Objective").fill("Ship channel v1.1 protocol");
  await page.getByLabel("Scope").fill("Brief, decisions, handoffs, context summaries");
  await page.getByLabel("Acceptance criteria").fill("Brief saves\nActivity shows protocol items");
  await page.getByRole("button", { name: "Save brief" }).click();
  await expect.poll(() => {
    const brief = state.channelBriefs.channel_engineering;
    return isRecord(brief) ? brief.objective : undefined;
  }).toBe("Ship channel v1.1 protocol");

  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Keep v1.1 handoffs manual and visible.");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Record decision" }).first().click();
  await expect.poll(() => state.channelDecisions.length).toBe(1);
  await expect(page.getByText("Decision log")).toBeVisible();

  await page.getByRole("button", { name: "Supersede" }).first().click();
  await expect.poll(() => state.channelDecisions.filter((decision) => isRecord(decision) && decision.status === "active").length).toBe(1);
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.status === "superseded")).toBe(true);

  await page.getByRole("button", { name: "Create handoff" }).first().click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);
  await expect(page.getByText("Handoff", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Complete" }).first().click();
  await expect.poll(() => isRecord(state.channelHandoffs[0]) ? state.channelHandoffs[0].status : undefined).toBe("completed");
  await expect.poll(() => isRecord(state.tasks.find((task) => isRecord(task) && task.id === "task_inspect")) ? state.tasks.find((task) => isRecord(task) && task.id === "task_inspect")?.status : undefined).toBe("failed");

  const taskCount = state.tasks.length;
  await page.getByRole("button", { name: "Create task with context" }).first().click();
  await expect.poll(() => state.channelContextSummaries.length).toBe(1);
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await expect(page.getByText("Context summary", { exact: true }).first()).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Channel protocol" }).click();
  await expect(page.getByLabel("Objective")).toHaveValue("Ship channel v1.1 protocol");
});

test("channel v1.2 handoff workflows can start steps and surface runtime context", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider()];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Hand this implementation to Engineer.");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Create handoff" }).first().click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);

  await page.getByRole("button", { name: "Start workflow" }).first().click();
  await expect.poll(() => state.channelWorkflows.length).toBe(1);
  await expect.poll(() => state.channelWorkflowSteps.length).toBe(1);
  await page.getByRole("button", { name: "Channel protocol" }).click();
  await page.getByRole("button", { name: "Runtime" }).click();
  await expect(page.getByText("Workflow queue")).toBeVisible();
  await expect(page.getByText("Active decisions: 0")).toBeVisible();

  const taskCount = state.tasks.length;
  await page.getByRole("button", { name: "Start step" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await expect.poll(() => {
    const step = state.channelWorkflowSteps[0];
    return isRecord(step) ? step.status : undefined;
  }).toBe("succeeded");
  await openChannelTasksTab(page);
  await expect(page.locator("article.task-detail")).toContainText("Source workflow");

  const blockedStep = {
    id: "workflow_step_blocked",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    workflowId: isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].id : "workflow_1",
    position: 2,
    title: "Blocked follow-up",
    prompt: "Needs provider recovery.",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    status: "blocked",
    blocker: "Provider preflight failed.",
    createdAt: "2026-05-25T00:35:00.000Z",
    updatedAt: "2026-05-25T00:35:00.000Z",
  };
  state.channelWorkflowSteps.push(blockedStep);
  const workflow = state.channelWorkflows[0];
  if (isRecord(workflow)) {
    workflow.status = "running";
  }
  await page.reload();
  await page.getByRole("button", { name: "Channel protocol" }).click();
  await page.getByRole("button", { name: "Runtime" }).click();
  await expect(page.locator(".workflow-step-card").filter({ hasText: "Blocked follow-up" })).toContainText("Provider preflight failed.");
});

test("channel v1.2 workflow start and run uses the existing run surface", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider()];
  state.channelWorkflows = [
    {
      id: "workflow_seed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Seed workflow",
      objective: "Create and run a task from a workflow step.",
      status: "ready",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:34:00.000Z",
      updatedAt: "2026-05-25T00:34:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_seed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_seed",
      position: 1,
      title: "Run seeded step",
      prompt: "Run this workflow step.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "queued",
      createdAt: "2026-05-25T00:34:00.000Z",
      updatedAt: "2026-05-25T00:34:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("button", { name: "Channel protocol" }).click();
  await page.getByRole("button", { name: "Runtime" }).click();
  await page.getByRole("button", { name: "Start + run" }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect.poll(() => {
    const step = state.channelWorkflowSteps.find((item) => isRecord(item) && item.id === "workflow_step_seed");
    return isRecord(step) ? step.runId : undefined;
  }).toBe("run_2");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "run_2" })).toContainText("succeeded");
});

test("channel activity derives task run approval transition and workflow events", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_timeline",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Timeline source message",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  });
  state.tasks.push({
    id: "task_design_timeline",
    workspaceId: "workspace_default",
    channelId: "channel_design",
    title: "Other channel task leak",
    prompt: "Should not appear in Engineering.",
    status: "done",
    currentRunId: "run_design_timeline",
    createdAt: "2026-05-25T00:02:00.000Z",
    updatedAt: "2026-05-25T00:03:00.000Z",
  });
  state.runs.push({
    id: "run_design_timeline",
    status: "succeeded",
    cwd,
    taskId: "task_design_timeline",
    channelId: "channel_design",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_design_timeline", title: "Other channel task leak" },
    providerSnapshot: { provider: "local-relay" },
    requestSnapshot: { cwd },
    eventLogPath: ".ling-stack/sessions/run_design_timeline.jsonl",
    createdAt: "2026-05-25T00:02:00.000Z",
    updatedAt: "2026-05-25T00:03:00.000Z",
  });
  state.approvals.push({
    id: "approval_design_timeline",
    runId: "run_design_timeline",
    taskId: "task_design_timeline",
    actionType: "bash",
    risk: "medium",
    title: "Other channel approval leak",
    description: "echo design",
    payload: {},
    status: "pending",
    createdAt: "2026-05-25T00:03:00.000Z",
    expiresAt: "2099-01-01T00:01:00.000Z",
  });
  state.channelWorkflows = [
    {
      id: "workflow_activity",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Timeline workflow",
      objective: "Show workflow in Activity.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:05:00.000Z",
      updatedAt: "2026-05-25T00:06:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_activity",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_activity",
      position: 1,
      title: "Blocked timeline step",
      prompt: "Wait for runtime recovery.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "blocked",
      blocker: "Runtime policy is waiting.",
      createdAt: "2026-05-25T00:06:00.000Z",
      updatedAt: "2026-05-25T00:07:00.000Z",
    },
  ];
  state.stateTransitions = [
    {
      id: "transition_task_timeline",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_inspect",
      fromStatus: "todo",
      toStatus: "failed",
      event: "task_failed",
      actor: "runner",
      createdAt: "2026-05-25T00:03:00.000Z",
    },
    {
      id: "transition_design_timeline",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_design_timeline",
      fromStatus: "todo",
      toStatus: "done",
      event: "other_channel_done",
      actor: "runner",
      createdAt: "2026-05-25T00:04:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByText("Timeline source message")).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toContainText("failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "run_failed" })).toContainText("failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" })).toContainText("pending");
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toContainText("Runtime policy is waiting.");
  await expect(page.getByText("Other channel task leak")).toHaveCount(0);
  await expect(page.getByText("Other channel approval leak")).toHaveCount(0);
  await expect(page.getByText("other_channel_done")).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();

  const activityFilters = page.getByLabel("Activity filters");
  const activityFeed = page.getByLabel("Channel message feed");
  const searchInput = activityFilters.getByPlaceholder("Search activity");
  const savedViews = activityFilters.getByLabel("Saved views");
  const savedViewChip = (label: string) => savedViews.getByRole("button", { name: new RegExp(`^${label}(?:\\s+\\d+)?$`) });
  const categoryChip = (label: string) => activityFilters.getByLabel("Activity categories").locator(".activity-filter-chip").filter({ hasText: label });
  const attentionChip = (label: string) => activityFilters.getByLabel("Activity attention filters").locator(".activity-filter-chip").filter({ hasText: label });

  await expect(activityFilters).toBeVisible();
  await expect(savedViewChip("All")).toContainText("7");
  await expect(savedViewChip("Needs attention")).toContainText("5");
  await expect(savedViewChip("Blocked")).toContainText("1");
  await expect(savedViewChip("Failed")).toContainText("3");
  await expect(savedViewChip("Pending approvals")).toContainText("1");
  await expect(savedViewChip("Failed work")).toContainText("2");
  await expect(savedViewChip("Runtime")).toContainText("3");
  await expect(categoryChip("All")).toContainText("7");
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("2");
  await expect(categoryChip("Approvals")).toContainText("1");
  await expect(categoryChip("Protocol")).toContainText("0");
  await expect(categoryChip("Runtime")).toContainText("3");

  const attentionQueue = page.getByLabel("Attention queue");
  await expect(attentionQueue).toContainText("5 items need attention");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Blocked 1");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Failed 3");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Pending 1");
  await attentionQueue.locator(".attention-queue-summary").click();
  await expect(attentionQueue.getByLabel("Top attention items").getByRole("button")).toHaveCount(5);
  await expect(attentionQueue.getByLabel("Top attention items").getByRole("button").first()).toContainText("Blocked timeline step");
  const expandQueueIfNeeded = async () => {
    if (await attentionQueue.locator(".attention-queue-item").count() === 0) {
      await attentionQueue.locator(".attention-queue-summary").click();
    }
  };
  await attentionQueue.locator(".attention-queue-item").filter({ hasText: "Blocked timeline step" }).click();
  await expect(page.locator(".channel-tab.active")).toContainText("Channel protocol");
  await page.getByRole("button", { name: "Activity" }).click();
  await expandQueueIfNeeded();
  await attentionQueue.locator(".attention-queue-item").filter({ hasText: "Run run_failed" }).click();
  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expandQueueIfNeeded();
  await attentionQueue.locator(".attention-queue-item").filter({ hasText: "Approve shell command" }).click();
  await expect(page.getByLabel("Approval requests")).toContainText("Approve shell command");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expandQueueIfNeeded();
  await attentionQueue.locator(".attention-queue-item").filter({ hasText: "Inspect workspace" }).filter({ hasText: "Task" }).click();
  await expect(page.locator(".channel-tab.active")).toContainText("Tasks");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");
  await page.getByRole("button", { name: "Activity" }).click();

  await savedViewChip("Blocked").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await savedViewChip("Pending approvals").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toHaveCount(0);
  await savedViewChip("Failed work").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "run_failed" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toHaveCount(0);
  await savedViewChip("Runtime").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await activityFilters.getByRole("button", { name: /Clear/ }).click();

  await searchInput.fill("Timeline source");
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();
  await expect(activityFeed.getByText("Inspect workspace")).toHaveCount(0);
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("0");

  await searchInput.fill("Inspect the repo");
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);

  await searchInput.fill("run_failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "run_failed" })).toBeVisible();

  await searchInput.fill("Approve shell command");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toBeVisible();

  await searchInput.fill("Wait for runtime recovery");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();

  await searchInput.fill("task_failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();

  await searchInput.fill("");
  await categoryChip("Messages").click();
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();
  await expect(activityFeed.getByText("Inspect workspace")).toHaveCount(0);
  await categoryChip("Runtime").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await activityFilters.getByRole("button", { name: /Clear/ }).click();

  await attentionChip("Needs attention").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await attentionChip("Failed").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "failed" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toHaveCount(0);
  await attentionChip("Pending").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "failed" })).toHaveCount(0);
  await activityFilters.getByRole("button", { name: /Clear/ }).click();

  await searchInput.fill("definitely-not-present");
  await expect(page.getByText("No activity matches these filters")).toBeVisible();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await searchInput.fill("run_failed");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Saved view name");
    await dialog.accept("Run failures");
  });
  await activityFilters.getByRole("button", { name: "Save view" }).click();
  await expect(savedViewChip("Run failures")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(savedViewChip("Run failures")).toBeVisible();
  await savedViewChip("Run failures").click();
  await expect(searchInput).toHaveValue("run_failed");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Rename saved view");
    await dialog.accept("Run problems");
  });
  await activityFilters.getByRole("button", { name: "Rename" }).click();
  await expect(savedViewChip("Run problems")).toBeVisible();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await expect(searchInput).toHaveValue("");
  await expect(savedViewChip("Run problems")).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(savedViewChip("Run problems")).toBeVisible();
  await savedViewChip("Run problems").click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Delete saved view?");
    await dialog.accept();
  });
  await activityFilters.getByRole("button", { name: "Delete view" }).click();
  await expect(savedViewChip("Run problems")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await expect(searchInput).toHaveValue("");
  await expect(activityFeed.getByText("Other channel task leak").first()).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await expect(page.getByText("No activity matches these filters")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(searchInput).toHaveValue("");
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();

  await page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Open task" }).click();
  await expect(page.locator(".channel-tab.active")).toContainText("Tasks");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");

  await page.getByRole("button", { name: "Activity" }).click();
  await page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "run_failed" }).getByRole("button", { name: "Open run" }).click();
  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(page.getByText("run_failed").first()).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" }).getByRole("button", { name: "Open approval" }).click();
  await expect(page.getByLabel("Approval requests")).toContainText("Approve shell command");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" }).getByRole("button", { name: "Open protocol" }).click();
  await expect(page.locator(".channel-tab.active")).toContainText("Channel protocol");
});

test("channel activity attention queue keeps an empty state compact", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.approvals = [];
  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "done", updatedAt: "2026-05-25T00:02:00.000Z" } : task,
  );
  state.runs = state.runs.map((run) => ({
    ...run,
    status: "succeeded",
    endedAt: "2026-05-25T00:02:00.000Z",
    updatedAt: "2026-05-25T00:02:00.000Z",
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  const attentionQueue = page.getByLabel("Attention queue");
  await expect(attentionQueue).toContainText("No attention items");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Blocked 0");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Failed 0");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Pending 0");
  await attentionQueue.locator(".attention-queue-summary").click();
  await expect(attentionQueue.locator(".attention-queue-empty")).toContainText("No attention items");
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});

test("run detail renders state transitions from daemon timeline API", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.stateTransitions = [
    {
      id: "transition_task_claim",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_inspect",
      fromStatus: "todo",
      toStatus: "claimed",
      event: "claim",
      actor: "system",
      createdAt: "2026-05-22T00:00:10.000Z",
    },
    {
      id: "transition_run_failed",
      workspaceId: "workspace_default",
      entityType: "run",
      entityId: "run_failed",
      fromStatus: "running",
      toStatus: "failed",
      event: "runner_failed",
      actor: "runner",
      createdAt: "2026-05-22T00:01:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  await expect(page.getByRole("heading", { name: "State machine" })).toBeVisible();
  await expect(page.getByText("runner_failed: running -> failed")).toBeVisible();
  await expect(page.getByText("claim: todo -> claimed")).toBeVisible();
});

test("language switcher toggles Chinese and English UI labels", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ling-stack.locale")) {
      localStorage.setItem("ling-stack.locale", "en-US");
    }
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "收件箱" })).toBeVisible();
  await expect(page.locator(".channel-tabs").getByRole("button", { name: "动态" })).toBeVisible();
  await expect(page.getByPlaceholder("搜索动态")).toBeVisible();
  await expect(page.getByLabel("保存的视图").getByRole("button", { name: /需要关注/ })).toBeVisible();
  await expect(page.getByLabel("动态类别").getByRole("button", { name: /全部/ })).toBeVisible();
  await expect(page.getByLabel("动态关注筛选").getByRole("button", { name: /需要关注/ })).toBeVisible();
  await expect(page.getByLabel("关注队列")).toBeVisible();
  await expect(page.getByPlaceholder("给频道发消息，或 @ 一个 AI 队友")).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "发送" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.locale"))).toBe("zh-CN");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Workspace" })).toBeVisible();
  await expect(page.locator(".channel-tabs").getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(page.getByPlaceholder("Search activity")).toBeVisible();
  await expect(page.getByLabel("Saved views").getByRole("button", { name: /Needs attention/ })).toBeVisible();
  await expect(page.getByLabel("Activity categories").getByRole("button", { name: /Messages/ })).toBeVisible();
  await expect(page.getByLabel("Activity attention filters").getByRole("button", { name: /Needs attention/ })).toBeVisible();
  await expect(page.getByLabel("Attention queue")).toBeVisible();
  await expect(page.getByPlaceholder("Message this channel or @ an AI teammate")).toBeVisible();
});

test("AI teammates page creates a local teammate through the wizard", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_local",
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "gpt-5.5",
      api: "openai-completions",
      apiKeyConfigured: true,
      headers: {},
      authHeader: true,
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      compat: {},
      capabilities: ["chat", "tool_call", "reasoning"],
      enabled: true,
      lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI Teammates" }).first().click();
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByText("Ling Engineer")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add teammate" })).toBeVisible();
  await expect(page.getByLabel("Teammate setup steps")).toBeVisible();
  await page.getByLabel("Teammate template chooser").getByRole("button", { name: /Engineer/ }).click();
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByLabel("Model choices").getByRole("button", { name: /Local Relay/ })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  await page.getByLabel("Teammate name").fill("Ling Engineer");
  await page.getByLabel("Description").fill("Owns scoped implementation in the Engineering channel.");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByLabel("Channel choices").getByRole("button", { name: /Engineering/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Create teammate" }).click();

  await expect(page.getByLabel("Local teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" })).toBeVisible();
  const localTeammate = page.getByLabel("Local teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" });
  await localTeammate.getByLabel("Pin Ling Engineer").click();
  await localTeammate.getByLabel("Hide Ling Engineer").click();
  await expect(localTeammate).toHaveClass(/hidden-row/);
  await expect(page.getByLabel("Workflow").getByRole("heading", { name: "Autoplan Lite" })).toBeVisible();
  await expect(page.getByText("Strict approval").first()).toBeVisible();
});

test("workspace path initializes from daemon default and persists edits", async ({ page }) => {
  const daemonCwd = "/tmp/daemon-default-workspace";
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), { defaultWorkspaceCwd: daemonCwd });
  await page.goto("/");

  const workspaceInput = page.getByLabel("Workspace path").first();
  await expect(workspaceInput).toHaveValue(daemonCwd);

  await workspaceInput.fill("/tmp/custom-workspace");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.workspaceCwd"))).toBe("/tmp/custom-workspace");

  await page.reload();
  await expect(page.getByLabel("Workspace path").first()).toHaveValue("/tmp/custom-workspace");
});

test("saved workspace path wins over daemon default", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.workspaceCwd", "/tmp/saved-workspace");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    defaultWorkspaceCwd: "/tmp/daemon-default-workspace",
  });
  await page.goto("/");

  await expect(page.getByLabel("Workspace path").first()).toHaveValue("/tmp/saved-workspace");
});

test("settings approval policy loads, edits, and saves tool decisions and write paths", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const settingsPanel = page.locator(".settings-panel");
  await expect(page.getByRole("heading", { name: "Approval policy" })).toBeVisible();
  await expect(settingsPanel).toContainText("workspace_default");

  const bashDecision = settingsPanel.locator(".policy-tool-row").filter({ hasText: "bash" }).locator("select");
  await expect(bashDecision).toHaveValue("ask");
  await bashDecision.selectOption("deny");
  await settingsPanel.getByLabel("Allowed write paths").fill(".\n/tmp/ling-stack-workspace\n  ");
  await settingsPanel.getByRole("button", { name: "Save policy" }).click();

  await expect.poll(() => {
    const toolDecisions = state.lastApprovalPolicyPatch?.toolDecisions;
    return isRecord(toolDecisions) ? toolDecisions.bash : undefined;
  }).toBe("deny");
  await expect.poll(() => state.lastApprovalPolicyPatch?.allowedWritePaths).toEqual([".", "/tmp/ling-stack-workspace"]);
  await expect.poll(() => state.approvalPolicy.toolDecisions.bash).toBe("deny");
  await expect(bashDecision).toHaveValue("deny");
  await expect(settingsPanel.getByLabel("Allowed write paths")).toHaveValue(".\n/tmp/ling-stack-workspace");
});

test("workspace defaults do not hardcode personal machine paths", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const e2eSource = await readFile(new URL("./app.spec.ts", import.meta.url), "utf8");
  const personalPath = ["/Users", "tianxiao", "ling-stack"].join("/");

  expect(appSource).not.toContain(personalPath);
  expect(e2eSource).not.toContain(personalPath);
});

test("sidebar selection is exclusive and conversation lists no longer live in global navigation", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["Workspace"], selectedRows: [] });

  await navigation.getByRole("button", { name: "Tasks" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["Tasks"], selectedRows: [] });

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await expect(navigation.getByText("Ada")).toHaveCount(0);
  await expect(navigation.getByText("Tian")).toHaveCount(0);
  await navigation.getByRole("button", { name: "AI Teammates" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["AI Teammates"], selectedRows: [] });
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
});

test("sidebar text entries route to context-aware inspectors", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.locator(".primary-nav .nav-item").filter({ hasText: "Model Workbench" })).toHaveCount(1);
  await expect(navigation.locator(".config-grid").getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Media Jobs" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();

  await navigation.locator(".primary-nav .nav-item").filter({ hasText: "Model Workbench" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["Model Workbench"], selectedRows: [] });
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Model Workbench context")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings preview")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Media Jobs" }).click();
  await expect(page.getByLabel("Media job context")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
});

test("workspace new task panel creates and selects the new task", async ({ page }) => {
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

  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("New task").getByLabel("Title").fill("Design inspector behavior");
  await page.getByLabel("New task").getByLabel("Prompt").fill("Make the inspector follow the selected task.");
  await page.getByLabel("New task").getByRole("button", { name: "Create task" }).click();

  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.title === "Design inspector behavior")).toBe(true);
  await expect(page.locator("article.task-detail")).toContainText("Design inspector behavior");
  await expect(page.getByLabel("Task inspector")).toContainText("Design inspector behavior");
});

test("model workbench creates custom OpenAI-compatible presets and surfaces readiness", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_missing_key",
      displayName: "Missing Key Gateway",
      apiKeyConfigured: false,
      apiKeyRef: "env:MISSING_GATEWAY_KEY",
    }),
    createChatProvider({
      id: "provider_unchecked",
      displayName: "Unchecked Domestic Gateway",
      providerId: "domestic-gateway",
      model: "domestic-chat",
      baseUrl: "https://domestic.example.com/v1",
    }),
    createChatProvider({
      id: "provider_failed",
      displayName: "Auth Failed Gateway",
      lastCheck: {
        ok: false,
        code: "auth_failed",
        message: "Invalid API key.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
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
    createMediaProvider(),
  ];
  await mockDaemon(page, state, {
    templates: [
      {
        templateId: "openai-gpt",
        description: "Official OpenAI endpoint.",
        kind: "openai",
        displayName: "OpenAI GPT",
        providerId: "openai",
        model: "gpt-5.4",
        api: "openai-completions",
        apiKeyRef: "env:OPENAI_API_KEY",
        capabilities: ["chat", "tool_call", "reasoning"],
        input: ["text"],
        enabled: false,
        authHeader: true,
        reasoning: true,
      },
    ],
  });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByText("Chat-capable")).toBeVisible();
  await expect(page.getByText("Coding ready")).toBeVisible();

  await expect(page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" })).toContainText("key missing");
  await expect(page.locator(".provider-row").filter({ hasText: "Unchecked Domestic Gateway" })).toContainText("unchecked");
  await expect(page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" })).toContainText("auth failed");
  await expect(page.locator(".provider-row").filter({ hasText: "Ready Local Relay" })).toContainText("check ready");
  await expect(page.locator(".provider-row").filter({ hasText: "Seedream Image" })).toContainText("Coding task: blocked");

  await page.getByRole("button", { name: /Custom OpenAI-compatible/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("Custom OpenAI-compatible");
  await page.getByRole("button", { name: /OpenAI GPT/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("OpenAI GPT");
  await expect(page.getByLabel("Enabled")).toBeChecked();
  await page.getByRole("button", { name: /Custom OpenAI-compatible/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("Custom OpenAI-compatible");
  await expect(page.getByLabel("Display name")).toHaveValue("Custom OpenAI-compatible");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("API key", { exact: true }).fill("test-visible-key");
  await page.getByRole("button", { name: "Show API key" }).click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await page.getByText("Advanced env/keychain").click();
  await page.getByLabel("API key ref").fill("env:CUSTOM_MODEL_API_KEY");
  await expect(page.getByText("API key input wins over env/keychain on save.")).toBeVisible();
  await expect(page.getByLabel("Capabilities")).toHaveValue("chat, tool_call, reasoning");

  await page.getByRole("button", { name: "Save & Check" }).click();
  const customProviderRow = page.locator(".provider-row").filter({ hasText: "Custom OpenAI-compatible" });
  await expect(customProviderRow).toContainText("Saved locally");
  await expect(customProviderRow).toContainText("key ready");
  await expect(customProviderRow).toContainText("check ready");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("test-visible-key");
  await expect.poll(() =>
    state.providers.some((provider) =>
      isRecord(provider) &&
      provider.displayName === "Custom OpenAI-compatible" &&
      provider.apiKeyRef === "local:provider_created_6" &&
      provider.apiKeyConfigured === true &&
      !("apiKey" in provider)
    )
  ).toBe(true);

  await customProviderRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Clear key" }).click();
  await expect(customProviderRow).toContainText("key missing");
});

test("workspace task runs only expose preflight-ready coding providers", async ({ page }) => {
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

  await openChannelTasksTab(page);
  const providerSelect = page.locator("label.field").filter({ hasText: "Run provider" }).locator("select");
  await expect(providerSelect.locator("option").filter({ hasText: "Ready Local Relay" })).toHaveCount(1);
  await expect(providerSelect.locator("option").filter({ hasText: "Missing Key Gateway" })).toHaveCount(1);
  await expect(providerSelect.locator("option").filter({ hasText: "Seedream Image" })).toHaveCount(0);
  await page.getByRole("button", { name: "New task" }).click();
  await expect(page.getByText("Media providers stay in Media Jobs and cannot run coding tasks.").first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect(page.locator(".task-detail")).toContainText("run_2");
  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.currentRunId === "run_2")).toBe(true);
});

test("workspace task run uses the displayed ready provider fallback", async ({ page }) => {
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

  await openChannelTasksTab(page);
  const providerSelect = page.locator("label.field").filter({ hasText: "Run provider" }).locator("select");
  await expect(providerSelect).toHaveValue("provider_ready");

  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();

  await expect.poll(() => state.runs[0]?.providerPresetId).toBe("provider_ready");
  await expect(page.locator(".task-detail")).toContainText("run_1");
});

test("workspace task actions only show a spinner on the clicked task action", async ({ page }) => {
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
  state.tasks = [
    ...state.tasks.map((task) =>
      isRecord(task) ? { ...task, status: "todo", currentRunId: undefined } : task
    ),
    {
      id: "task_second",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Second task",
      prompt: "Run the second task only.",
      status: "todo",
      createdAt: "2026-05-25T00:05:00.000Z",
      updatedAt: "2026-05-25T00:05:00.000Z",
    },
  ];
  state.runs = [];
  state.runResponseDelayMs = 2000;
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelTasksTab(page);
  const firstTask = page.locator(".workbench-task-list .client-task-card").filter({ hasText: "Inspect workspace" });
  const secondTask = page.locator(".workbench-task-list .client-task-card").filter({ hasText: "Second task" });
  await secondTask.click();
  const taskDetail = page.locator("article.task-detail");
  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();

  await expect(taskDetail.getByRole("button", { name: "Run", exact: true }).locator(".spin")).toHaveCount(1);
  await expect(taskDetail.getByRole("button", { name: "Check run", exact: true }).locator(".spin")).toHaveCount(0);
  await expect(firstTask.locator(".task-actions .spin")).toHaveCount(0);
  await expect(page.locator(".task-actions .spin")).toHaveCount(1);

  await expect.poll(() => state.runs[0]?.taskId).toBe("task_second");

  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "todo", currentRunId: undefined } : task
  );
  state.runs = [];
  state.providerCheckDelayMs = 2000;
  await taskDetail.getByRole("button", { name: "Check run", exact: true }).click();

  await expect(taskDetail.getByRole("button", { name: "Check run", exact: true }).locator(".spin")).toHaveCount(1);
  await expect(taskDetail.getByRole("button", { name: "Run", exact: true }).locator(".spin")).toHaveCount(0);
  await expect(firstTask.locator(".task-actions .spin")).toHaveCount(0);
});

test("succeeded workspace tasks show a clear result action", async ({ page }) => {
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
  state.eventsByRun.run_failed = createVerboseRunEvents("run_failed");
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelTasksTab(page);
  await expect(page.getByText("Task complete").first()).toBeVisible();

  const taskDetail = page.locator("article.task-detail");
  await expect(taskDetail).toContainText("Task complete");
  await expect(taskDetail.getByRole("button", { name: "View result" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run activity" })).toBeVisible();
  await expect(page.getByText("AI is analyzing the task").first()).toBeVisible();
  await expect(page.getByText("Read package.json")).toBeVisible();
});

test("workspace run timeline summarizes activity and keeps raw events contained", async ({ page }) => {
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
  state.nextStreamEvents = createVerboseRunEvents("run_1");
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelTasksTab(page);
  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Run activity" })).toBeVisible();
  await expect(page.getByText("AI is analyzing the task").first()).toBeVisible();
  await expect(page.getByText("Read package.json")).toBeVisible();
  await expect(page.getByText("Generated artifact: read content")).toBeVisible();
  await expect(page.getByText("Tool failed: grep")).toBeVisible();
  await expect(page.getByText("Approval requested: bash")).toBeVisible();
  await expect(page.getByText("Run completed")).toBeVisible();
  await expect(page.locator(".timeline-activity-list")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".timeline")).not.toHaveCSS("overflow-y", "auto");
  await expect.poll(() => readScrollState(page, ".timeline-activity-list")).toMatchObject({ atBottom: true });

  const visibleThinkingRows = page.locator(".timeline-activity-list").getByText("assistant_thinking_delta");
  await expect(visibleThinkingRows).toHaveCount(0);

  const rawEvents = page.locator("details.raw-event-panel");
  await expect(rawEvents).toHaveCount(1);
  await expect(rawEvents).not.toHaveAttribute("open", /.+/);
  await rawEvents.locator(":scope > summary").click();
  await expect(rawEvents.locator(".raw-event-list")).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => readScrollState(page, ".raw-event-list")).toMatchObject({ atBottom: true });
  await expect(rawEvents.getByText("assistant_thinking_delta").first()).toBeVisible();
});

test("save and check enables a disabled provider before checking", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_disabled",
      displayName: "Disabled Relay",
      enabled: false,
      apiKeyRef: undefined,
      apiKeyConfigured: false,
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const disabledRow = page.locator(".provider-row").filter({ hasText: "Disabled Relay" });
  await disabledRow.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("API key", { exact: true }).fill("disabled-provider-key");
  await page.getByRole("button", { name: "Save & Check" }).click();

  await expect(disabledRow).toContainText("enabled");
  await expect(disabledRow).toContainText("check ready");
  await expect.poll(() => {
    const provider = state.providers.find((item) => isRecord(item) && item.id === "provider_disabled");
    return isRecord(provider) ? { enabled: provider.enabled, apiKeyRef: provider.apiKeyRef, checked: isRecord(provider.lastCheck) && provider.lastCheck.ok } : undefined;
  }).toEqual({ enabled: true, apiKeyRef: "local:provider_disabled", checked: true });
});

test("row check enables a configured disabled chat provider before checking", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_disabled",
      displayName: "Configured Disabled Relay",
      enabled: false,
      apiKeyRef: "local:provider_disabled",
      apiKeyConfigured: true,
      lastCheck: {
        ok: false,
        code: "provider_disabled",
        message: "Provider is disabled.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const disabledRow = page.locator(".provider-row").filter({ hasText: "Configured Disabled Relay" });
  await disabledRow.getByRole("button", { name: "Check" }).click();

  await expect(disabledRow).toContainText("enabled");
  await expect(disabledRow).toContainText("check ready");
  await expect.poll(() => {
    const provider = state.providers.find((item) => isRecord(item) && item.id === "provider_disabled");
    return isRecord(provider) ? { enabled: provider.enabled, checked: isRecord(provider.lastCheck) && provider.lastCheck.ok } : undefined;
  }).toEqual({ enabled: true, checked: true });
});

test("failed provider runs route repair back to Model Workbench", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_failed",
      displayName: "Auth Failed Gateway",
      lastCheck: {
        ok: false,
        code: "auth_failed",
        message: "Invalid API key.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
  ];
  state.runs = state.runs.map((run) => ({
    ...run,
    providerPresetId: "provider_failed",
    providerName: "auth-failed-gateway",
    providerModel: "domestic-chat",
    requestSnapshot: { cwd, providerPresetId: "provider_failed" },
    errorMessage: "Provider auth failed for configured endpoint.",
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: /run_failed/ }).click();
  const providerRepair = page.locator(".run-repair-hint.providers");
  await expect(providerRepair).toContainText("Provider repair needed");
  await providerRepair.getByRole("button", { name: "Model Workbench" }).click();

  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Auth Failed Gateway");
  await expect(page.getByLabel("Provider run repair")).toContainText("run_failed");
});

test("approval inbox shows expired approvals without decision buttons", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Approval requests" })).toBeVisible();
  const approvalRows = page.getByLabel("Approval requests").locator(".approval-row");
  await expect(approvalRows).toContainText("expired");
  await expect(approvalRows).toContainText("expired ");
  await expect(approvalRows.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(approvalRows.getByRole("button", { name: /Deny/ })).toHaveCount(0);
});

test("approval inbox resolves pending approvals and refreshes state", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const approvalRows = page.getByLabel("Approval requests").locator(".approval-row");
  await expect(approvalRows).toContainText("pending");

  await approvalRows.getByRole("button", { name: "Deny" }).click();
  await expect(approvalRows).toContainText("denied");
  await expect.poll(() => state.approvals[0]?.status).toBe("denied");
});

test("run detail renders artifact rows from the daemon API", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.artifactsByRun.run_failed = [
    {
      id: "artifact_report",
      runId: "run_failed",
      type: "markdown",
      path: "run_failed/001-generated-report.md",
      title: "Generated report",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 128,
      createdAt: "2026-05-22T00:01:30.000Z",
    },
    {
      id: "artifact_patch",
      runId: "run_failed",
      type: "diff",
      path: "run_failed/002-edit.diff",
      title: "edit diff",
      contentType: "text/x-diff; charset=utf-8",
      sizeBytes: 256,
      createdAt: "2026-05-22T00:01:31.000Z",
    },
    {
      id: "artifact_image",
      runId: "run_failed",
      type: "image",
      path: "run_failed/003-seedream-image.png",
      title: "Seedream image 1",
      contentType: "image/png",
      sizeBytes: 2048,
      createdAt: "2026-05-22T00:01:32.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: /run_failed/ }).click();

  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(page.locator(".artifact-row")).toHaveCount(3);
  await expect(page.locator(".artifact-row").first()).toContainText("Generated report");
  await expect(page.locator(".artifact-row").first()).toHaveAttribute("href", /\/artifacts\/artifact_report\/content/);
  const imageRow = page.locator(".artifact-row").filter({ hasText: "Seedream image 1" });
  await expect(imageRow).toContainText("image");
  await expect(imageRow).toContainText("2.0 KB");
  await expect(imageRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_image\/content/);
  const downloadLink = imageRow.getByRole("link", { name: "Download" });
  await expect(downloadLink).toHaveAttribute("href", /\/artifacts\/artifact_image\/content/);
  await expect(downloadLink).toHaveAttribute("download", "003-seedream-image.png");
});

test("media jobs page lists, runs, and creates media jobs", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: false,
      headers: {},
      input: ["text", "image"],
      compat: {},
      capabilities: ["image_generate", "image_edit"],
      enabled: true,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
    {
      id: "provider_local",
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "dpv4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyRef: "env:LOCAL_RELAY_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      authHeader: true,
      reasoning: true,
      input: ["text"],
      compat: {},
      capabilities: ["chat", "tool_call"],
      enabled: true,
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable and accepted the configured model.",
        checkedAt: "2026-05-23T00:00:00.000Z",
      },
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
  ];
  state.mediaJobs = [
    {
      id: "media_job_live_failed",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Live gated product mockup.",
      input: {},
      artifactIds: [],
      status: "failed",
      errorMessage: "Seedream image generation failed with HTTP 429 Too Many Requests. rate limited",
      createdAt: "2026-05-23T00:00:30.000Z",
      updatedAt: "2026-05-23T00:01:00.000Z",
    },
    {
      id: "media_job_succeeded_image",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Generated Seedream image artifact.",
      input: {},
      artifactIds: ["artifact_media_image"],
      status: "succeeded",
      createdAt: "2026-05-23T00:00:45.000Z",
      updatedAt: "2026-05-23T00:01:15.000Z",
    },
    {
      id: "media_job_existing",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Existing product mockup.",
      input: {},
      artifactIds: [],
      status: "queued",
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
  ];
  state.artifactsByMediaJob.media_job_succeeded_image = [
    {
      id: "artifact_media_image",
      mediaJobId: "media_job_succeeded_image",
      type: "image",
      path: "media_jobs/media_job_succeeded_image/001-seedream-image.png",
      title: "Seedream image 1",
      contentType: "image/png",
      sizeBytes: 4096,
      createdAt: "2026-05-23T00:01:15.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Media jobs", level: 1 })).toBeVisible();
  const failedJob = page.locator(".media-job-row").filter({ hasText: "Live gated product mockup." });
  await expect(failedJob).toContainText("failed");
  await expect(failedJob).toContainText("Seedream image generation failed with HTTP 429");
  const imageJob = page.locator(".media-job-row").filter({ hasText: "Generated Seedream image artifact." });
  const imageArtifactRow = imageJob.locator(".artifact-row").filter({ hasText: "Seedream image 1" });
  await expect(imageArtifactRow).toContainText("image");
  await expect(imageArtifactRow).toContainText("4.0 KB");
  await expect(imageArtifactRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_media_image\/content/);
  const mediaDownloadLink = imageArtifactRow.getByRole("link", { name: "Download" });
  await expect(mediaDownloadLink).toHaveAttribute("href", /\/artifacts\/artifact_media_image\/content/);
  await expect(mediaDownloadLink).toHaveAttribute("download", "001-seedream-image.png");

  const existingJob = page.locator(".media-job-row").filter({ hasText: "Existing product mockup." });
  await expect(existingJob).toContainText("Existing product mockup.");
  await existingJob.getByRole("button", { name: "Run" }).click();
  await expect(existingJob).toContainText("succeeded");
  await expect(existingJob.locator(".artifact-row")).toContainText("Image generate static result");
  await expect(existingJob.locator(".artifact-row")).toHaveAttribute("href", /\/artifacts\/artifact_media_job_existing\/content/);

  await page.getByRole("textbox", { name: "Prompt" }).fill("New campaign image.");
  await page.getByRole("button", { name: "Create media job" }).click();

  await expect(page.locator(".media-job-row").first()).toContainText("New campaign image.");
  await expect.poll(() => state.mediaJobs.length).toBe(4);
});

test("media jobs page surfaces live media cost approvals", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      input: ["text", "image"],
      compat: { mediaVendorTransport: { mode: "live" } },
      capabilities: ["image_generate"],
      enabled: true,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  state.mediaJobs = [
    {
      id: "media_job_live_pending",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Approval gated product mockup.",
      input: {},
      artifactIds: [],
      status: "queued",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Jobs" }).click();
  const jobRow = page.locator(".media-job-row").filter({ hasText: "Approval gated product mockup." });
  await jobRow.getByRole("button", { name: "Run" }).click();
  await expect(jobRow).toContainText("waiting_for_approval");
  await expect(jobRow).toContainText("Approval required before live execution");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const mediaApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve media job cost" });
  await expect(mediaApproval).toContainText("media_cost");
  await expect(mediaApproval).toContainText("media job media_job_live_pending");
  await expect(mediaApproval.getByLabel("Media cost approval summary")).toContainText("provider provider_seedream");
  await expect(mediaApproval.getByLabel("Media cost approval summary")).toContainText("Approval gated product mockup.");

  await mediaApproval.getByLabel("Decision reason").fill("Approved for local smoke.");
  await mediaApproval.getByRole("button", { name: "Approve" }).click();
  await mediaApproval.getByRole("button", { name: "Confirm approve" }).click();
  await expect(mediaApproval).toContainText("approved");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Jobs" }).click();
  await jobRow.getByRole("button", { name: "Run" }).click();
  await expect(jobRow).toContainText("succeeded");
  await expect(jobRow.locator(".artifact-row")).toContainText("Image generate live result");
});

async function readSidebarSelection(page: Page): Promise<{ readonly activeNav: string[]; readonly selectedRows: string[] }> {
  return await page.evaluate(() => {
    const navLabel = (element: Element): string => element.querySelector("span")?.textContent?.trim() ?? "";
    const rowLabel = (element: Element): string =>
      element.querySelector("span:not(.avatar-initial)")?.textContent?.trim() ?? "";

    return {
      activeNav: [...document.querySelectorAll(".nav-item.active")].map(navLabel),
      selectedRows: [...document.querySelectorAll(".sidebar-row.selected")].map(rowLabel),
    };
  });
}

async function openChannelTasksTab(page: Page): Promise<void> {
  await page.locator(".channel-tabs").getByRole("button", { name: "Tasks" }).click();
}

async function readScrollState(page: Page, selector: string): Promise<{ readonly atBottom: boolean; readonly top: number; readonly max: number }> {
  return await page.locator(selector).evaluate((element) => {
    const max = element.scrollHeight - element.clientHeight;
    return {
      atBottom: Math.abs(element.scrollTop - max) <= 2,
      top: element.scrollTop,
      max,
    };
  });
}

function createBaseState(options: { approvalStatus: "pending" | "expired" }): MockState {
  const run: MockRun = {
    id: "run_failed",
    status: "failed",
    cwd,
    taskId: "task_inspect",
    channelId: "channel_engineering",
    providerPresetId: "provider_local",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_inspect", title: "Inspect workspace" },
    providerSnapshot: { provider: "local-relay", model: "gpt-5.5" },
    requestSnapshot: { cwd, providerPresetId: "provider_local" },
    eventLogPath: ".ling-stack/sessions/run_failed.jsonl",
    errorMessage: "Tool failed while reading workspace state.",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:01:00.000Z",
  };
  return {
    providers: [],
    channels: [
      {
        id: "channel_engineering",
        workspaceId: "workspace_default",
        name: "Engineering",
        status: "active",
        boundPath: cwd,
        defaultTeammateId: "engineer",
        allowedTools: ["read", "grep", "find", "ls"],
        runtimePolicy: defaultRuntimePolicy,
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
      },
    ],
    channelMessages: [],
    channelAttachments: [],
    channelLinkPreviews: [],
    channelBriefs: {},
    channelDecisions: [],
    channelHandoffs: [],
    channelContextSummaries: [],
    channelWorkflows: [],
    channelWorkflowSteps: [],
    tasks: [
      {
        id: "task_inspect",
        workspaceId: "workspace_default",
        channelId: "channel_engineering",
        title: "Inspect workspace",
        prompt: "Inspect the repo and report next steps.",
        status: "failed",
        currentRunId: run.id,
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:01:00.000Z",
      },
    ],
    runs: [run],
    eventsByRun: {},
    approvals: [
      {
        id: "approval_1",
        runId: run.id,
        taskId: run.taskId,
        actionType: "bash",
        risk: "medium",
        title: options.approvalStatus === "expired" ? "Approval expired" : "Approve shell command",
        description: "echo inspect",
        payload: { type: "bash", cwd, command: "echo inspect", riskFlags: [] },
        status: options.approvalStatus,
        createdAt: "2026-05-22T00:00:00.000Z",
        expiresAt: options.approvalStatus === "expired" ? "2000-01-01T00:01:00.000Z" : "2099-01-01T00:01:00.000Z",
        resolvedAt: options.approvalStatus === "expired" ? "2000-01-01T00:01:00.000Z" : undefined,
        decisionReason: options.approvalStatus === "expired" ? "Approval request expired before a decision was received." : undefined,
      },
    ],
    approvalPolicy: {
      workspaceId: "workspace_default",
      toolDecisions: {
        read: "allow",
        grep: "allow",
        find: "allow",
        ls: "allow",
        bash: "ask",
        edit: "ask",
        write: "ask",
      },
      allowedWritePaths: ["."],
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
    mediaJobs: [],
    resourceLeases: [],
    stateTransitions: [],
    artifactsByRun: {},
    artifactsByMediaJob: {},
  };
}

function createEmptyMockBrief(channelId: string): Record<string, unknown> {
  return {
    id: `brief_${channelId}`,
    workspaceId: "workspace_default",
    channelId,
    objective: "",
    scope: "",
    acceptanceCriteria: [],
    openQuestions: [],
    risks: [],
    decisionIds: [],
    attachmentIds: [],
    linkPreviewIds: [],
    updatedBy: "system",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}

function createVerboseRunEvents(runId: string): MockRunEvent[] {
  const thinkingEvents = Array.from({ length: 12 }, (_, index) => ({
    id: `evt_thinking_${index + 1}`,
    runId,
    seq: index + 2,
    ts: "2026-05-25T00:20:01.000Z",
    type: "assistant_thinking_delta",
    data: { type: "assistant_thinking_delta", text: index === 0 ? "I will inspect" : " the workspace" },
  }));
  return [
    {
      id: "evt_run_start",
      runId,
      seq: 1,
      ts: "2026-05-25T00:20:00.000Z",
      type: "run_start",
      data: { type: "run_start", taskId: "task_inspect", cwd, provider: "local-relay", model: "dpv4" },
    },
    ...thinkingEvents,
    {
      id: "evt_tool_start_read",
      runId,
      seq: 14,
      ts: "2026-05-25T00:20:02.000Z",
      type: "tool_start",
      data: { type: "tool_start", toolCallId: "call_read", toolName: "read", args: { path: "package.json", limit: 200 } },
    },
    {
      id: "evt_tool_end_read",
      runId,
      seq: 15,
      ts: "2026-05-25T00:20:02.250Z",
      type: "tool_end",
      data: { type: "tool_end", toolCallId: "call_read", toolName: "read", result: { content: [{ type: "text", text: "{}" }] }, isError: false },
    },
    {
      id: "evt_artifact_read",
      runId,
      seq: 16,
      ts: "2026-05-25T00:20:02.300Z",
      type: "artifact_created",
      data: {
        toolCallId: "call_read",
        toolName: "read",
        artifact: {
          id: "artifact_read",
          runId,
          type: "markdown",
          path: `${runId}/001-read-content.md`,
          title: "read content",
          contentType: "text/markdown; charset=utf-8",
          sizeBytes: 128,
          createdAt: "2026-05-25T00:20:02.300Z",
        },
      },
    },
    {
      id: "evt_tool_start_grep",
      runId,
      seq: 17,
      ts: "2026-05-25T00:20:03.000Z",
      type: "tool_start",
      data: { type: "tool_start", toolCallId: "call_grep", toolName: "grep", args: { path: "src", pattern: "TODO" } },
    },
    {
      id: "evt_tool_end_grep",
      runId,
      seq: 18,
      ts: "2026-05-25T00:20:03.250Z",
      type: "tool_end",
      data: { type: "tool_end", toolCallId: "call_grep", toolName: "grep", result: { error: "No such file or directory" }, isError: true },
    },
    {
      id: "evt_approval_requested",
      runId,
      seq: 19,
      ts: "2026-05-25T00:20:04.000Z",
      type: "approval_requested",
      data: { approvalId: "approval_activity", actionType: "bash", risk: "medium", title: "Approve shell command" },
    },
    {
      id: "evt_run_end",
      runId,
      seq: 20,
      ts: "2026-05-25T00:20:30.000Z",
      type: "run_end",
      data: { type: "run_end", taskId: "task_inspect", status: "succeeded" },
    },
  ];
}

function createChatProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "provider_local",
    kind: "openai-compatible",
    displayName: "Local Relay",
    providerId: "local-relay",
    model: "dpv4",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKeyRef: "env:LOCAL_RELAY_API_KEY",
    apiKeyConfigured: true,
    headers: {},
    authHeader: true,
    reasoning: true,
    input: ["text"],
    compat: {},
    capabilities: ["chat", "tool_call", "reasoning"],
    enabled: true,
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

function createMediaProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "provider_seedream",
    kind: "seedream",
    displayName: "Seedream Image",
    providerId: "seedream",
    model: "doubao-seedream-5-0-260128",
    api: "media-job",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    headers: {},
    input: ["text", "image"],
    compat: {},
    capabilities: ["image_generate"],
    enabled: true,
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

function createProviderFromBody(body: Record<string, unknown>, id: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const apiKeyRef = typeof body.apiKey === "string" && body.apiKey.trim()
    ? `local:${id}`
    : body.clearApiKey === true
      ? undefined
      : typeof body.apiKeyRef === "string"
        ? body.apiKeyRef
        : typeof existing.apiKeyRef === "string"
          ? existing.apiKeyRef
          : undefined;
  const apiKeyConfigured = apiKeyRef?.startsWith("local:")
    ? body.clearApiKey !== true
    : apiKeyRef === "env:LOCAL_RELAY_API_KEY" || existing.apiKeyConfigured === true && body.clearApiKey !== true;
  return {
    id,
    kind: typeof body.kind === "string" ? body.kind : typeof existing.kind === "string" ? existing.kind : "openai-compatible",
    displayName: typeof body.displayName === "string" ? body.displayName : typeof existing.displayName === "string" ? existing.displayName : "Custom Provider",
    providerId: typeof body.providerId === "string" ? body.providerId : typeof existing.providerId === "string" ? existing.providerId : "custom-provider",
    model: typeof body.model === "string" ? body.model : typeof existing.model === "string" ? existing.model : "custom-model",
    api: typeof body.api === "string" ? body.api : typeof existing.api === "string" ? existing.api : "openai-completions",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : typeof existing.baseUrl === "string" ? existing.baseUrl : undefined,
    apiKeyRef,
    apiKeyConfigured,
    headers: isRecord(existing.headers) ? existing.headers : {},
    authHeader: typeof body.authHeader === "boolean" ? body.authHeader : existing.authHeader === true,
    reasoning: typeof body.reasoning === "boolean" ? body.reasoning : existing.reasoning === true,
    input: Array.isArray(body.input) ? body.input : Array.isArray(existing.input) ? existing.input : ["text"],
    compat: isRecord(existing.compat) ? existing.compat : {},
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : Array.isArray(existing.capabilities) ? existing.capabilities : ["chat"],
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled === true,
    contextWindow: typeof body.contextWindow === "number" ? body.contextWindow : typeof existing.contextWindow === "number" ? existing.contextWindow : undefined,
    maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : typeof existing.maxTokens === "number" ? existing.maxTokens : undefined,
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : "2026-05-25T00:10:00.000Z",
    updatedAt: "2026-05-25T00:10:00.000Z",
  };
}

function createChannelFromBody(body: Record<string, unknown>, id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    name: typeof body.name === "string" ? body.name : "Engineering",
    status: body.status === "paused" || body.status === "archived" ? body.status : "active",
    boundPath: typeof body.boundPath === "string" ? body.boundPath : cwd,
    defaultProviderPresetId: typeof body.defaultProviderPresetId === "string" ? body.defaultProviderPresetId : undefined,
    defaultTeammateId: typeof body.defaultTeammateId === "string" ? body.defaultTeammateId : undefined,
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : ["read", "grep", "find", "ls"],
    runtimePolicy: isRecord(body.runtimePolicy) ? { ...defaultRuntimePolicy, ...body.runtimePolicy } : defaultRuntimePolicy,
    createdAt: "2026-05-25T00:15:00.000Z",
    updatedAt: "2026-05-25T00:15:00.000Z",
  };
}

function buildProviderCheckResult(provider: Record<string, unknown>): Record<string, unknown> {
  const checkedAt = "2026-05-25T00:11:00.000Z";
  if (provider.enabled === false) {
    return { ok: false, code: "provider_disabled", message: "Provider is disabled.", checkedAt };
  }
  if (provider.apiKeyRef && provider.apiKeyConfigured !== true) {
    return { ok: false, code: "secret_missing", message: `${String(provider.apiKeyRef)} is not configured.`, checkedAt };
  }
  if (String(provider.displayName).includes("Auth Failed")) {
    return { ok: false, code: "auth_failed", message: "Invalid API key.", checkedAt };
  }
  return { ok: true, code: "ready", message: "Provider is reachable and accepted the configured model.", checkedAt };
}

async function mockDaemon(
  page: Page,
  state: MockState,
  options: { readonly defaultWorkspaceCwd?: string; readonly templates?: readonly unknown[] } = {},
): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    await handleDaemonRoute(route, state, options);
  });
}

async function handleDaemonRoute(
  route: Route,
  state: MockState,
  options: { readonly defaultWorkspaceCwd?: string },
): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;

  if (request.method() === "GET" && path === "/health") {
    await route.fulfill({
      json: {
        ok: true,
        service: "ling-stack-daemon",
        defaultWorkspaceCwd: options.defaultWorkspaceCwd ?? cwd,
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/provider-templates") {
    await route.fulfill({ json: { templates: options.templates ?? [] } });
    return;
  }
  if (request.method() === "GET" && path === "/providers") {
    await route.fulfill({ json: { cwd, providers: state.providers } });
    return;
  }
  if (request.method() === "POST" && path === "/providers") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const provider = createProviderFromBody(body, `provider_created_${state.providers.length + 1}`);
    state.providers.push(provider);
    await route.fulfill({ status: 201, json: { provider } });
    return;
  }
  const providerMatch = /^\/providers\/([^/]+)$/.exec(path);
  if (providerMatch && request.method() === "PATCH") {
    const providerId = decodeURIComponent(providerMatch[1]);
    const providerIndex = state.providers.findIndex((item) => isRecord(item) && item.id === providerId);
    if (providerIndex === -1) {
      await route.fulfill({ status: 404, json: { error: "provider_not_found" } });
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    const existing = state.providers[providerIndex];
    const provider = isRecord(existing)
      ? { ...existing, ...createProviderFromBody(body, providerId, existing), id: providerId, updatedAt: "2026-05-25T00:10:00.000Z" }
      : createProviderFromBody(body, providerId);
    state.providers[providerIndex] = provider;
    await route.fulfill({ json: { provider } });
    return;
  }
  const providerCheckMatch = /^\/providers\/([^/]+)\/check$/.exec(path);
  if (providerCheckMatch && request.method() === "POST") {
    const providerId = decodeURIComponent(providerCheckMatch[1]);
    const provider = state.providers.find((item) => isRecord(item) && item.id === providerId);
    if (!provider || !isRecord(provider)) {
      await route.fulfill({ status: 404, json: { error: "provider_not_found" } });
      return;
    }
    if (state.providerCheckDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.providerCheckDelayMs));
    }
    const result = buildProviderCheckResult(provider);
    provider.lastCheck = result;
    provider.updatedAt = result.checkedAt;
    await route.fulfill({ json: result });
    return;
  }
  if (request.method() === "GET" && path === "/channels") {
    await route.fulfill({ json: { cwd, channels: state.channels } });
    return;
  }
  if (request.method() === "POST" && path === "/channels") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const channel = createChannelFromBody(body, `channel_created_${state.channels.length + 1}`);
    state.channels.unshift(channel);
    await route.fulfill({ status: 201, json: { channel } });
    return;
  }
  const channelMessagesMatch = /^\/channels\/([^/]+)\/messages$/.exec(path);
  if (channelMessagesMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelMessagesMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        messages: state.channelMessages.filter((message) => isRecord(message) && message.channelId === channelId),
      },
    });
    return;
  }
  if (channelMessagesMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelMessagesMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    if (state.channelMessageDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.channelMessageDelayMs));
    }
    if (state.failNextChannelMessage) {
      state.failNextChannelMessage = false;
      await route.fulfill({ status: 500, json: { error: "mock_send_failed", message: "Mock message send failed." } });
      return;
    }
    const message = {
      id: `msg_${state.channelMessages.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      kind: typeof body.kind === "string" ? body.kind : "message",
      intent: typeof body.intent === "string" ? body.intent : "discuss",
      authorType: typeof body.authorType === "string" ? body.authorType : "local-user",
      authorId: typeof body.authorId === "string" ? body.authorId : "tian",
      body: typeof body.body === "string" ? body.body : "",
      mentions: Array.isArray(body.mentions) ? body.mentions : [],
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
      linkPreviewIds: Array.isArray(body.linkPreviewIds) ? body.linkPreviewIds : [],
      linkedTaskId: typeof body.linkedTaskId === "string" ? body.linkedTaskId : undefined,
      linkedRunId: typeof body.linkedRunId === "string" ? body.linkedRunId : undefined,
      status: "ready",
      createdAt: "2026-05-25T00:18:00.000Z",
      updatedAt: "2026-05-25T00:18:00.000Z",
    };
    state.channelMessages.push(message);
    const aiReply = body.requestAiReply === true
      ? {
          id: `msg_${state.channelMessages.length + 1}`,
          workspaceId: "workspace_default",
          channelId,
          threadId: message.id,
          kind: "ai_reply",
          intent: "discuss",
          authorType: "ai-teammate",
          authorId: "engineer",
          body: "收到，我会按频道上下文推进。",
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          status: "ready",
          createdAt: "2026-05-25T00:18:01.000Z",
          updatedAt: "2026-05-25T00:18:01.000Z",
        }
      : undefined;
    if (aiReply) {
      state.channelMessages.push(aiReply);
    }
    await route.fulfill({ status: 201, json: aiReply ? { message, aiReply } : { message } });
    return;
  }
  const channelAttachmentsMatch = /^\/channels\/([^/]+)\/attachments$/.exec(path);
  if (channelAttachmentsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelAttachmentsMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        attachments: state.channelAttachments.filter((attachment) => isRecord(attachment) && attachment.channelId === channelId),
      },
    });
    return;
  }
  if (channelAttachmentsMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelAttachmentsMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const fileName = typeof body.fileName === "string" ? body.fileName : "upload.txt";
    const inferred = inferMockChannelAttachment(fileName);
    const attachment = {
      id: `att_${state.channelAttachments.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      kind: inferred.kind,
      fileName,
      contentType: inferred.contentType,
      sizeBytes: typeof body.contentBase64 === "string" ? body.contentBase64.length : 0,
      path: `${channelId}/${fileName}`,
      createdAt: "2026-05-25T00:18:02.000Z",
    };
    state.channelAttachments.unshift(attachment);
    await route.fulfill({ status: 201, json: { attachment } });
    return;
  }
  const channelLinkPreviewMatch = /^\/channels\/([^/]+)\/link-previews$/.exec(path);
  if (channelLinkPreviewMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelLinkPreviewMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        linkPreviews: state.channelLinkPreviews.filter((preview) => isRecord(preview) && preview.channelId === channelId),
      },
    });
    return;
  }
  if (channelLinkPreviewMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelLinkPreviewMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const rawUrl = typeof body.url === "string" ? body.url : "https://example.com";
    if (state.linkPreviewDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.linkPreviewDelayMs));
    }
    const preview = {
      id: `link_${state.channelLinkPreviews.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      url: rawUrl,
      normalizedUrl: rawUrl,
      title: rawUrl.includes("example.com") ? "Example Domain" : rawUrl,
      description: rawUrl.includes("127.0.0.1") ? undefined : "Mock link preview",
      siteName: "example.com",
      status: rawUrl.includes("127.0.0.1") ? "blocked" : "ready",
      errorMessage: rawUrl.includes("127.0.0.1") ? "Private network previews are blocked." : undefined,
      createdAt: "2026-05-25T00:18:03.000Z",
      updatedAt: "2026-05-25T00:18:03.000Z",
    };
    state.channelLinkPreviews.unshift(preview);
    await route.fulfill({ status: 201, json: { linkPreview: preview } });
    return;
  }
  const channelBriefMatch = /^\/channels\/([^/]+)\/brief$/.exec(path);
  if (channelBriefMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelBriefMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        brief: state.channelBriefs[channelId] ?? createEmptyMockBrief(channelId),
      },
    });
    return;
  }
  if (channelBriefMatch && request.method() === "PATCH") {
    const channelId = decodeURIComponent(channelBriefMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const existing = state.channelBriefs[channelId];
    const brief = {
      ...(isRecord(existing) ? existing : createEmptyMockBrief(channelId)),
      objective: typeof body.objective === "string" ? body.objective : "",
      scope: typeof body.scope === "string" ? body.scope : "",
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
      openQuestions: Array.isArray(body.openQuestions) ? body.openQuestions : [],
      risks: Array.isArray(body.risks) ? body.risks : [],
      decisionIds: Array.isArray(body.decisionIds) ? body.decisionIds : [],
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
      linkPreviewIds: Array.isArray(body.linkPreviewIds) ? body.linkPreviewIds : [],
      updatedBy: typeof body.updatedBy === "string" ? body.updatedBy : "local-user",
      updatedAt: "2026-05-25T00:21:00.000Z",
    };
    state.channelBriefs[channelId] = brief;
    await route.fulfill({ json: { brief } });
    return;
  }
  const channelDecisionsMatch = /^\/channels\/([^/]+)\/decisions$/.exec(path);
  if (channelDecisionsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelDecisionsMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        decisions: state.channelDecisions.filter((decision) => isRecord(decision) && decision.channelId === channelId),
      },
    });
    return;
  }
  if (channelDecisionsMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelDecisionsMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    if (typeof body.supersedesDecisionId === "string") {
      state.channelDecisions = state.channelDecisions.map((decision) =>
        isRecord(decision) && decision.id === body.supersedesDecisionId ? { ...decision, status: "superseded" } : decision
      );
    }
    const decision = {
      id: `decision_${state.channelDecisions.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      sourceMessageId: typeof body.sourceMessageId === "string" ? body.sourceMessageId : undefined,
      sourceTaskId: typeof body.sourceTaskId === "string" ? body.sourceTaskId : undefined,
      sourceRunId: typeof body.sourceRunId === "string" ? body.sourceRunId : undefined,
      title: typeof body.title === "string" ? body.title : "Decision",
      decision: typeof body.decision === "string" ? body.decision : "",
      rationale: typeof body.rationale === "string" ? body.rationale : "",
      alternatives: Array.isArray(body.alternatives) ? body.alternatives : [],
      status: "active",
      supersedesDecisionId: typeof body.supersedesDecisionId === "string" ? body.supersedesDecisionId : undefined,
      createdBy: typeof body.createdBy === "string" ? body.createdBy : "local-user",
      createdAt: "2026-05-25T00:22:00.000Z",
      updatedAt: "2026-05-25T00:22:00.000Z",
    };
    state.channelDecisions.unshift(decision);
    await route.fulfill({ status: 201, json: { decision } });
    return;
  }
  const decisionMatch = /^\/decisions\/([^/]+)$/.exec(path);
  if (decisionMatch && request.method() === "PATCH") {
    const decisionId = decodeURIComponent(decisionMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    let updated;
    state.channelDecisions = state.channelDecisions.map((decision) => {
      if (isRecord(decision) && decision.id === decisionId) {
        updated = { ...decision, ...body, updatedAt: "2026-05-25T00:23:00.000Z" };
        return updated;
      }
      return decision;
    });
    await route.fulfill({ json: { decision: updated } });
    return;
  }
  const channelHandoffsMatch = /^\/channels\/([^/]+)\/handoffs$/.exec(path);
  if (channelHandoffsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelHandoffsMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        handoffs: state.channelHandoffs.filter((handoff) => isRecord(handoff) && handoff.channelId === channelId),
      },
    });
    return;
  }
  if (channelHandoffsMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelHandoffsMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const handoff = {
      id: `handoff_${state.channelHandoffs.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      ...body,
      status: typeof body.status === "string" ? body.status : "proposed",
      createdAt: "2026-05-25T00:24:00.000Z",
      updatedAt: "2026-05-25T00:24:00.000Z",
    };
    state.channelHandoffs.unshift(handoff);
    await route.fulfill({ status: 201, json: { handoff } });
    return;
  }
  const handoffMatch = /^\/handoffs\/([^/]+)$/.exec(path);
  if (handoffMatch && request.method() === "PATCH") {
    const handoffId = decodeURIComponent(handoffMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    let updated;
    state.channelHandoffs = state.channelHandoffs.map((handoff) => {
      if (isRecord(handoff) && handoff.id === handoffId) {
        updated = { ...handoff, ...body, updatedAt: "2026-05-25T00:25:00.000Z" };
        return updated;
      }
      return handoff;
    });
    await route.fulfill({ json: { handoff: updated } });
    return;
  }
  const handoffWorkflowMatch = /^\/handoffs\/([^/]+)\/workflow$/.exec(path);
  if (handoffWorkflowMatch && request.method() === "POST") {
    const handoffId = decodeURIComponent(handoffWorkflowMatch[1]);
    const handoff = state.channelHandoffs.find((item) => isRecord(item) && item.id === handoffId);
    if (!isRecord(handoff)) {
      await route.fulfill({ status: 404, json: { error: "handoff_not_found" } });
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    const workflow = {
      id: `workflow_${state.channelWorkflows.length + 1}`,
      workspaceId: "workspace_default",
      channelId: handoff.channelId,
      sourceHandoffId: handoff.id,
      title: typeof body.title === "string" ? body.title : `${String(handoff.reason ?? "Handoff")} workflow`,
      objective: typeof body.objective === "string" ? body.objective : String(handoff.expectedOutput ?? handoff.reason ?? ""),
      status: "draft",
      createdBy: typeof body.createdBy === "string" ? body.createdBy : "local-user",
      createdAt: "2026-05-25T00:32:00.000Z",
      updatedAt: "2026-05-25T00:32:00.000Z",
    };
    const workflowStep = {
      id: `workflow_step_${state.channelWorkflowSteps.length + 1}`,
      workspaceId: "workspace_default",
      channelId: handoff.channelId,
      workflowId: workflow.id,
      sourceHandoffId: handoff.id,
      contextSummaryId: typeof body.contextSummaryId === "string" ? body.contextSummaryId : undefined,
      position: 1,
      title: typeof handoff.reason === "string" ? handoff.reason : "Complete handoff",
      prompt: typeof handoff.requiredInput === "string" ? handoff.requiredInput : String(handoff.reason ?? ""),
      toParticipantId: typeof handoff.toParticipantId === "string" ? handoff.toParticipantId : "engineer",
      toParticipantLabel: typeof handoff.toParticipantLabel === "string" ? handoff.toParticipantLabel : "Engineer",
      status: "queued",
      createdAt: "2026-05-25T00:32:00.000Z",
      updatedAt: "2026-05-25T00:32:00.000Z",
    };
    state.channelWorkflows.unshift(workflow);
    state.channelWorkflowSteps.unshift(workflowStep);
    await route.fulfill({ status: 201, json: { workflow, workflowStep } });
    return;
  }
  const channelWorkflowsMatch = /^\/channels\/([^/]+)\/workflows$/.exec(path);
  if (channelWorkflowsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelWorkflowsMatch[1]);
    const status = url.searchParams.get("status");
    const workflows = state.channelWorkflows.filter((workflow) =>
      isRecord(workflow) &&
      workflow.channelId === channelId &&
      (!status || workflow.status === status)
    );
    await route.fulfill({ json: { cwd, channelId, workflows } });
    return;
  }
  const workflowMatch = /^\/workflows\/([^/]+)$/.exec(path);
  if (workflowMatch && request.method() === "GET") {
    const workflowId = decodeURIComponent(workflowMatch[1]);
    const workflow = state.channelWorkflows.find((item) => isRecord(item) && item.id === workflowId);
    await route.fulfill({ status: workflow ? 200 : 404, json: workflow ? { workflow } : { error: "workflow_not_found" } });
    return;
  }
  if (workflowMatch && request.method() === "PATCH") {
    const workflowId = decodeURIComponent(workflowMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    let updated;
    state.channelWorkflows = state.channelWorkflows.map((workflow) => {
      if (isRecord(workflow) && workflow.id === workflowId) {
        updated = { ...workflow, ...body, updatedAt: "2026-05-25T00:33:00.000Z" };
        return updated;
      }
      return workflow;
    });
    await route.fulfill({ status: updated ? 200 : 404, json: updated ? { workflow: updated } : { error: "workflow_not_found" } });
    return;
  }
  const workflowStepsMatch = /^\/workflows\/([^/]+)\/steps$/.exec(path);
  if (workflowStepsMatch && request.method() === "GET") {
    const workflowId = decodeURIComponent(workflowStepsMatch[1]);
    const status = url.searchParams.get("status");
    const workflowSteps = state.channelWorkflowSteps.filter((step) =>
      isRecord(step) &&
      step.workflowId === workflowId &&
      (!status || step.status === status)
    );
    await route.fulfill({ json: { cwd, workflowId, workflowSteps } });
    return;
  }
  const workflowStepStartMatch = /^\/workflow-steps\/([^/]+)\/start$/.exec(path);
  if (workflowStepStartMatch && request.method() === "POST") {
    const stepId = decodeURIComponent(workflowStepStartMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const stepIndex = state.channelWorkflowSteps.findIndex((step) => isRecord(step) && step.id === stepId);
    if (stepIndex === -1 || !isRecord(state.channelWorkflowSteps[stepIndex])) {
      await route.fulfill({ status: 404, json: { error: "workflow_step_not_found" } });
      return;
    }
    const step = state.channelWorkflowSteps[stepIndex] as Record<string, unknown>;
    const workflowIndex = state.channelWorkflows.findIndex((workflow) => isRecord(workflow) && workflow.id === step.workflowId);
    const workflow = workflowIndex >= 0 && isRecord(state.channelWorkflows[workflowIndex])
      ? state.channelWorkflows[workflowIndex] as Record<string, unknown>
      : undefined;
    const task = {
      id: `task_${state.tasks.length + 1}`,
      workspaceId: "workspace_default",
      channelId: typeof step.channelId === "string" ? step.channelId : "channel_engineering",
      title: typeof body.taskTitle === "string" ? body.taskTitle : String(step.title ?? "Workflow task"),
      prompt: typeof body.taskPrompt === "string" ? body.taskPrompt : String(step.prompt ?? ""),
      status: body.mode === "create_and_run_task" ? "done" : "todo",
      assigneeTeammateId: typeof body.assigneeTeammateId === "string" ? body.assigneeTeammateId : step.toParticipantId,
      createdAt: "2026-05-25T00:36:00.000Z",
      updatedAt: "2026-05-25T00:36:00.000Z",
    };
    state.tasks.unshift(task);
    const runId = body.mode === "create_and_run_task" ? `run_${state.runs.length + 1}` : undefined;
    const updatedStep = {
      ...step,
      status: "succeeded",
      taskId: task.id,
      runId,
      resultSummary: runId ? "Run succeeded." : "Task created from workflow step.",
      updatedAt: "2026-05-25T00:36:30.000Z",
    };
    state.channelWorkflowSteps[stepIndex] = updatedStep;
    if (workflow) {
      const updatedWorkflow = { ...workflow, status: "succeeded", updatedAt: "2026-05-25T00:36:30.000Z" };
      state.channelWorkflows[workflowIndex] = updatedWorkflow;
      if (runId) {
        const run: MockRun = {
          id: runId,
          status: "succeeded",
          cwd,
          taskId: task.id,
          channelId: typeof task.channelId === "string" ? task.channelId : "channel_engineering",
          providerPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : "provider_local",
          providerName: "local-relay",
          providerModel: "dpv4",
          taskSnapshot: { id: task.id, title: task.title, prompt: task.prompt },
          providerSnapshot: { providerPresetId: body.providerPresetId ?? "provider_local" },
          requestSnapshot: body,
          eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
          createdAt: "2026-05-25T00:36:00.000Z",
          updatedAt: "2026-05-25T00:36:30.000Z",
        };
        state.runs.unshift(run);
        state.eventsByRun[runId] = [
          {
            id: `evt_${runId}_end`,
            runId,
            seq: 1,
            ts: run.updatedAt,
            type: "run_end",
            data: { status: "succeeded" },
          },
        ];
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            `event: ready\ndata: ${JSON.stringify({ runId })}`,
            `event: message\ndata: ${JSON.stringify(state.eventsByRun[runId][0])}`,
            "",
          ].join("\n\n"),
        });
        return;
      }
      await route.fulfill({ json: { workflow: updatedWorkflow, workflowStep: updatedStep, task } });
      return;
    }
    await route.fulfill({ json: { workflowStep: updatedStep, task } });
    return;
  }
  const workflowStepMatch = /^\/workflow-steps\/([^/]+)$/.exec(path);
  if (workflowStepMatch && request.method() === "PATCH") {
    const stepId = decodeURIComponent(workflowStepMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    let updated;
    state.channelWorkflowSteps = state.channelWorkflowSteps.map((step) => {
      if (isRecord(step) && step.id === stepId) {
        updated = { ...step, ...body, updatedAt: "2026-05-25T00:37:00.000Z" };
        return updated;
      }
      return step;
    });
    const workflow = isRecord(updated)
      ? state.channelWorkflows.find((item) => isRecord(item) && item.id === updated.workflowId)
      : undefined;
    await route.fulfill({ status: updated ? 200 : 404, json: updated ? { workflowStep: updated, workflow } : { error: "workflow_step_not_found" } });
    return;
  }
  const channelSummariesMatch = /^\/channels\/([^/]+)\/context-summaries$/.exec(path);
  if (channelSummariesMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelSummariesMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        contextSummaries: state.channelContextSummaries.filter((summary) => isRecord(summary) && summary.channelId === channelId),
      },
    });
    return;
  }
  if (channelSummariesMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelSummariesMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const contextSummary = {
      id: `summary_${state.channelContextSummaries.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      targetType: typeof body.targetType === "string" ? body.targetType : "thread",
      targetId: typeof body.targetId === "string" ? body.targetId : "msg_1",
      sourceMessageIds: Array.isArray(body.sourceMessageIds) ? body.sourceMessageIds : [],
      decisionIds: Array.isArray(body.decisionIds) ? body.decisionIds : [],
      summary: typeof body.summary === "string" ? body.summary : "",
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
      openQuestions: Array.isArray(body.openQuestions) ? body.openQuestions : [],
      authorType: typeof body.authorType === "string" ? body.authorType : "local-user",
      authorId: typeof body.authorId === "string" ? body.authorId : undefined,
      createdAt: "2026-05-25T00:26:00.000Z",
      updatedAt: "2026-05-25T00:26:00.000Z",
    };
    state.channelContextSummaries.unshift(contextSummary);
    await route.fulfill({ status: 201, json: { contextSummary } });
    return;
  }
  const summaryMatch = /^\/context-summaries\/([^/]+)$/.exec(path);
  if (summaryMatch && request.method() === "PATCH") {
    const summaryId = decodeURIComponent(summaryMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    let updated;
    state.channelContextSummaries = state.channelContextSummaries.map((summary) => {
      if (isRecord(summary) && summary.id === summaryId) {
        updated = { ...summary, ...body, updatedAt: "2026-05-25T00:27:00.000Z" };
        return updated;
      }
      return summary;
    });
    await route.fulfill({ json: { contextSummary: updated } });
    return;
  }
  const attachmentContentMatch = /^\/attachments\/([^/]+)\/content$/.exec(path);
  if (attachmentContentMatch && request.method() === "GET") {
    await route.fulfill({ body: "mock attachment content", contentType: "text/plain" });
    return;
  }
  const attachmentMatch = /^\/attachments\/([^/]+)$/.exec(path);
  if (attachmentMatch && request.method() === "DELETE") {
    const attachmentId = decodeURIComponent(attachmentMatch[1]);
    state.channelAttachments = state.channelAttachments.filter((attachment) => !isRecord(attachment) || attachment.id !== attachmentId);
    await route.fulfill({ json: { ok: true } });
    return;
  }
  const channelMatch = /^\/channels\/([^/]+)$/.exec(path);
  if (channelMatch && request.method() === "PATCH") {
    const channelId = decodeURIComponent(channelMatch[1]);
    const channelIndex = state.channels.findIndex((item) => isRecord(item) && item.id === channelId);
    if (channelIndex === -1) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found" } });
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    const existing = state.channels[channelIndex];
    const channel = isRecord(existing)
      ? { ...existing, ...createChannelFromBody(body, channelId), id: channelId, updatedAt: "2026-05-25T00:16:00.000Z" }
      : createChannelFromBody(body, channelId);
    state.channels[channelIndex] = channel;
    await route.fulfill({ json: { channel } });
    return;
  }
  if (request.method() === "GET" && path === "/runtime/leases") {
    const status = url.searchParams.get("status");
    const leases = status ? state.resourceLeases.filter((lease) => isRecord(lease) && lease.status === status) : state.resourceLeases;
    await route.fulfill({ json: { cwd, leases } });
    return;
  }
  if (request.method() === "GET" && path === "/state-transitions") {
    const entityType = url.searchParams.get("entityType");
    const entityId = url.searchParams.get("entityId");
    const transitions = state.stateTransitions.filter((transition) =>
      isRecord(transition) &&
      (!entityType || transition.entityType === entityType) &&
      (!entityId || transition.entityId === entityId)
    );
    await route.fulfill({ json: { cwd, transitions } });
    return;
  }
  if (request.method() === "GET" && path === "/tasks") {
    const channelId = url.searchParams.get("channelId");
    const tasks = channelId
      ? state.tasks.filter((task) => isRecord(task) && task.channelId === channelId)
      : state.tasks;
    await route.fulfill({ json: { cwd, tasks } });
    return;
  }
  if (request.method() === "POST" && path === "/tasks") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const task = {
      id: `task_${state.tasks.length + 1}`,
      workspaceId: "workspace_default",
      channelId: typeof body.channelId === "string" ? body.channelId : "channel_engineering",
      title: typeof body.title === "string" ? body.title : "New task",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      status: "todo",
      assigneeTeammateId: typeof body.assigneeTeammateId === "string" ? body.assigneeTeammateId : undefined,
      createdAt: "2026-05-25T00:19:00.000Z",
      updatedAt: "2026-05-25T00:19:00.000Z",
    };
    state.tasks.unshift(task);
    await route.fulfill({ status: 201, json: { task } });
    return;
  }
  if (request.method() === "GET" && path === "/runs") {
    await route.fulfill({ json: { cwd, runs: state.runs } });
    return;
  }
  if (request.method() === "POST" && path === "/runs") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const task = isRecord(body.task) ? body.task : {};
    const taskId = typeof task.id === "string" ? task.id : "task_generated";
    const providerPresetId = typeof body.providerPresetId === "string" ? body.providerPresetId : undefined;
    const provider = state.providers.find((item) => isRecord(item) && item.id === providerPresetId);
    const runId = `run_${state.runs.length + 1}`;
    const run: MockRun = {
      id: runId,
      status: "succeeded",
      cwd,
      taskId,
      channelId: typeof body.channelId === "string" ? body.channelId : "channel_engineering",
      providerPresetId,
      providerName: isRecord(provider) && typeof provider.providerId === "string" ? provider.providerId : "unknown-provider",
      providerModel: isRecord(provider) && typeof provider.model === "string" ? provider.model : "unknown-model",
      taskSnapshot: { id: taskId, title: typeof task.title === "string" ? task.title : "Generated task" },
      providerSnapshot: provider ?? {},
      requestSnapshot: body,
      eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
      createdAt: "2026-05-25T00:20:00.000Z",
      updatedAt: "2026-05-25T00:20:30.000Z",
    };
    state.runs.unshift(run);
    state.tasks = state.tasks.map((item) =>
      isRecord(item) && item.id === taskId
        ? { ...item, status: "done", currentRunId: runId, updatedAt: run.updatedAt }
        : item
    );
    const streamEvents = state.nextStreamEvents && state.nextStreamEvents.length > 0
      ? state.nextStreamEvents.map((event) => ({ ...event, runId }))
      : [
          {
            id: `evt_${runId}_end`,
            runId,
            seq: 1,
            ts: run.updatedAt,
            type: "run_end",
            data: { status: "succeeded" },
          },
        ];
    state.eventsByRun[runId] = streamEvents;
    if (state.runResponseDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.runResponseDelayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: ready\ndata: ${JSON.stringify({ runId })}`,
        ...streamEvents.map((event) => `event: message\ndata: ${JSON.stringify(event)}`),
        "",
      ].join("\n\n"),
    });
    return;
  }
  if (request.method() === "GET" && path === "/approvals") {
    const runId = url.searchParams.get("runId");
    const mediaJobId = url.searchParams.get("mediaJobId");
    const approvals = state.approvals.filter((approval) =>
      (!runId || approval.runId === runId) && (!mediaJobId || approval.mediaJobId === mediaJobId)
    );
    await route.fulfill({ json: { cwd, approvals } });
    return;
  }
  if (request.method() === "GET" && path === "/approval-policy") {
    await route.fulfill({ json: { cwd, policy: state.approvalPolicy } });
    return;
  }
  if (request.method() === "PATCH" && path === "/approval-policy") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    state.lastApprovalPolicyPatch = body;
    state.approvalPolicy = {
      ...state.approvalPolicy,
      toolDecisions: isRecord(body.toolDecisions) ? Object.fromEntries(
        Object.entries(body.toolDecisions).map(([tool, decision]) => [tool, String(decision)])
      ) : state.approvalPolicy.toolDecisions,
      allowedWritePaths: Array.isArray(body.allowedWritePaths)
        ? body.allowedWritePaths.filter((item): item is string => typeof item === "string")
        : state.approvalPolicy.allowedWritePaths,
      updatedAt: "2026-05-25T00:30:00.000Z",
    };
    await route.fulfill({ json: { cwd, policy: state.approvalPolicy } });
    return;
  }
  if (request.method() === "GET" && path === "/media-jobs") {
    await route.fulfill({ json: { cwd, mediaJobs: state.mediaJobs } });
    return;
  }
  if (request.method() === "POST" && path === "/media-jobs") {
    const body = (await request.postDataJSON()) as {
      providerPresetId: string;
      operation: string;
      prompt: string;
      input?: Record<string, unknown>;
    };
    const provider = state.providers.find((item) => isRecord(item) && item.id === body.providerPresetId);
    if (!provider || !isRecord(provider) || provider.api !== "media-job") {
      await route.fulfill({ status: 400, json: { error: "unsupported_capability" } });
      return;
    }
    const job: MockMediaJob = {
      id: `media_job_${state.mediaJobs.length + 1}`,
      workspaceId: "workspace_default",
      providerPresetId: body.providerPresetId,
      operation: body.operation,
      prompt: body.prompt,
      input: body.input ?? {},
      artifactIds: [],
      status: "queued",
      createdAt: "2026-05-23T00:02:00.000Z",
      updatedAt: "2026-05-23T00:02:00.000Z",
    };
    state.mediaJobs.unshift(job);
    await route.fulfill({ status: 201, json: { mediaJob: job } });
    return;
  }

  const mediaJobRunMatch = /^\/media-jobs\/([^/]+)\/run$/.exec(path);
  if (request.method() === "POST" && mediaJobRunMatch) {
    const job = state.mediaJobs.find((item) => item.id === decodeURIComponent(mediaJobRunMatch[1]));
    if (!job) {
      await route.fulfill({ status: 404, json: { error: "media_job_not_found" } });
      return;
    }
    if (job.status !== "queued" && job.status !== "failed" && job.status !== "cancelled") {
      if (job.status !== "waiting_for_approval") {
        await route.fulfill({ status: 409, json: { error: "media_job_not_runnable" } });
        return;
      }
    }
    const provider = state.providers.find((item) => isRecord(item) && item.id === job.providerPresetId);
    const liveGate = isRecord(provider) &&
      isRecord(provider.compat) &&
      isRecord(provider.compat.mediaVendorTransport) &&
      provider.compat.mediaVendorTransport.mode === "live";
    if (liveGate) {
      const existingApproval = state.approvals.find((approval) => approval.mediaJobId === job.id && approval.actionType === "media_cost");
      if (!existingApproval) {
        const approval: MockApproval = {
          id: `approval_${job.id}`,
          mediaJobId: job.id,
          actionType: "media_cost",
          risk: "high",
          title: "Approve media job cost",
          description: "Seedream Image image_generate requires approval before live media execution.",
          payload: {
            type: "media_cost",
            providerPresetId: job.providerPresetId,
            model: "seedream",
            operation: job.operation,
            promptPreview: job.prompt,
          },
          status: "pending",
          createdAt: "2026-05-24T00:01:00.000Z",
          expiresAt: "2099-01-01T00:01:00.000Z",
        };
        state.approvals.unshift(approval);
        job.status = "waiting_for_approval";
        job.updatedAt = "2026-05-24T00:01:00.000Z";
        await route.fulfill({ json: { mediaJob: job, approval, artifacts: [] } });
        return;
      }
      if (existingApproval.status === "pending") {
        job.status = "waiting_for_approval";
        await route.fulfill({ json: { mediaJob: job, approval: existingApproval, artifacts: [] } });
        return;
      }
      if (existingApproval.status === "denied" || existingApproval.status === "expired") {
        job.status = "failed";
        job.errorMessage = `Media cost approval ${existingApproval.status} before live media execution.`;
        await route.fulfill({ json: { mediaJob: job, approval: existingApproval, artifacts: [] } });
        return;
      }
    }
    const artifact: MockArtifact = {
      id: `artifact_${job.id}`,
      mediaJobId: job.id,
      type: "markdown",
      path: `media_jobs/${job.id}/static-result.md`,
      title: liveGate ? "Image generate live result" : "Image generate static result",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 192,
      createdAt: "2026-05-23T00:03:00.000Z",
    };
    job.status = "succeeded";
    job.artifactIds = [artifact.id];
    job.updatedAt = "2026-05-23T00:03:00.000Z";
    state.artifactsByMediaJob[job.id] = [artifact];
    await route.fulfill({ json: { mediaJob: job, artifacts: [artifact] } });
    return;
  }

  const mediaJobArtifactsMatch = /^\/media-jobs\/([^/]+)\/artifacts$/.exec(path);
  if (request.method() === "GET" && mediaJobArtifactsMatch) {
    const mediaJobId = decodeURIComponent(mediaJobArtifactsMatch[1]);
    await route.fulfill({ json: { mediaJobId, artifacts: state.artifactsByMediaJob[mediaJobId] ?? [] } });
    return;
  }

  const runMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (request.method() === "GET" && runMatch) {
    const run = state.runs.find((item) => item.id === decodeURIComponent(runMatch[1]));
    await route.fulfill({ status: run ? 200 : 404, json: run ?? { error: "not_found" } });
    return;
  }

  const runEventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
  if (request.method() === "GET" && runEventsMatch) {
    const runId = decodeURIComponent(runEventsMatch[1]);
    const events = state.eventsByRun[runId] ?? [
      {
        id: "evt_run_error",
        runId,
        seq: 1,
        ts: "2026-05-22T00:01:00.000Z",
        type: "run_error",
        data: { message: "Tool failed while reading workspace state." },
      },
    ];
    await route.fulfill({
      json: {
        runId,
        nextSeq: events.length + 1,
        events,
      },
    });
    return;
  }

  const runArtifactsMatch = /^\/runs\/([^/]+)\/artifacts$/.exec(path);
  if (request.method() === "GET" && runArtifactsMatch) {
    const runId = decodeURIComponent(runArtifactsMatch[1]);
    await route.fulfill({ json: { runId, artifacts: state.artifactsByRun[runId] ?? [] } });
    return;
  }

  const approvalDecisionMatch = /^\/approvals\/([^/]+)\/(approve|deny)$/.exec(path);
  if (request.method() === "POST" && approvalDecisionMatch) {
    const approval = state.approvals.find((item) => item.id === decodeURIComponent(approvalDecisionMatch[1]));
    if (!approval || approval.status !== "pending") {
      await route.fulfill({ status: 400, json: { error: "approval_not_pending", message: "Approval request is not pending." } });
      return;
    }
    approval.status = approvalDecisionMatch[2] === "approve" ? "approved" : "denied";
    approval.resolvedAt = "2026-05-22T00:02:00.000Z";
    approval.resolvedBy = "local-user";
    approval.decisionReason = "Resolved from Playwright";
    await route.fulfill({ json: { approval } });
    return;
  }

  await route.fulfill({ status: 404, json: { error: "not_found", path } });
}

function inferMockChannelAttachment(fileName: string): { readonly kind: string; readonly contentType: string } {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    return { kind: "image", contentType: extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : `image/${extension.slice(1)}` };
  }
  if (extension === ".pdf") {
    return { kind: "pdf", contentType: "application/pdf" };
  }
  if (extension === ".docx") {
    return { kind: "office", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  if (extension === ".xlsx") {
    return { kind: "office", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  }
  if (extension === ".pptx") {
    return { kind: "office", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  }
  if (extension === ".json") {
    return { kind: "text", contentType: "application/json; charset=utf-8" };
  }
  if (extension === ".csv") {
    return { kind: "text", contentType: "text/csv; charset=utf-8" };
  }
  if (extension === ".md") {
    return { kind: "text", contentType: "text/markdown; charset=utf-8" };
  }
  return { kind: "text", contentType: "text/plain; charset=utf-8" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
