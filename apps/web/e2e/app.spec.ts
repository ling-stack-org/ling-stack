import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const cwd = "/tmp/ling-stack-workspace";

interface MockState {
  providers: unknown[];
  channels: unknown[];
  tasks: unknown[];
  runs: MockRun[];
  approvals: MockApproval[];
  mediaJobs: MockMediaJob[];
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
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
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

test("workspace readiness surfaces missing provider, expired approval, and failed run repair", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Workspace readiness" })).toBeVisible();
  await expect(page.getByText("No model presets")).toBeVisible();
  await expect(page.getByText("1 expired approval need review")).toBeVisible();
  await expect(page.getByText(/Latest failed run needs review: run_failed/)).toBeVisible();

  await expect(page.getByLabel("Task detail")).toContainText("Task detail");
  await expect(page.getByLabel("Task detail")).toContainText("run_failed");
  await expect(page.getByLabel("Task detail").getByText("Inspect run failure")).toBeVisible();
});

test("language switcher toggles Chinese and English UI labels", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ling-stack.locale")) {
      localStorage.setItem("ling-stack.locale", "en-US");
    }
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Workspace readiness" })).toBeVisible();

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "工作区就绪状态" })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "审批" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.locale"))).toBe("zh-CN");

  await page.reload();
  await expect(page.getByRole("heading", { name: "工作区就绪状态" })).toBeVisible();

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("heading", { name: "Workspace readiness" })).toBeVisible();
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

test("workspace defaults do not hardcode personal machine paths", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const e2eSource = await readFile(new URL("./app.spec.ts", import.meta.url), "utf8");
  const personalPath = ["/Users", "tianxiao", "ling-stack"].join("/");

  expect(appSource).not.toContain(personalPath);
  expect(e2eSource).not.toContain(personalPath);
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
  await mockDaemon(page, state);
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
  await expect(page.getByLabel("Display name")).toHaveValue("Custom OpenAI-compatible");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(page.getByLabel("API key ref")).toHaveValue("env:CUSTOM_MODEL_API_KEY");
  await expect(page.getByLabel("Capabilities")).toHaveValue("chat, tool_call, reasoning");

  await page.getByRole("button", { name: "Create preset" }).click();
  const customProviderRow = page.locator(".provider-row").filter({ hasText: "Custom OpenAI-compatible" });
  await expect(customProviderRow).toContainText("env:CUSTOM_MODEL_API_KEY");
  await expect(customProviderRow).toContainText("key missing");
  await expect.poll(() => state.providers.some((provider) => isRecord(provider) && provider.displayName === "Custom OpenAI-compatible")).toBe(true);
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

  const providerSelect = page.locator("label.field").filter({ hasText: "Run provider" }).locator("select");
  await expect(providerSelect.locator("option").filter({ hasText: "Ready Local Relay" })).toHaveCount(1);
  await expect(providerSelect.locator("option").filter({ hasText: "Missing Key Gateway" })).toHaveCount(1);
  await expect(providerSelect.locator("option").filter({ hasText: "Seedream Image" })).toHaveCount(0);
  await expect(page.getByText("Media providers stay in Media Jobs and cannot run coding tasks.").first()).toBeVisible();

  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect(page.locator(".task-detail")).toContainText("run_2");
  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.currentRunId === "run_2")).toBe(true);
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Approvals" }).click();
  await expect(page.getByRole("heading", { name: "Approval requests" })).toBeVisible();
  await expect(page.locator(".approval-row")).toContainText("expired");
  await expect(page.locator(".approval-row")).toContainText("expired ");
  await expect(page.locator(".approval-row").getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(page.locator(".approval-row").getByRole("button", { name: /Deny/ })).toHaveCount(0);
});

test("approval inbox resolves pending approvals and refreshes state", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Approvals" }).click();
  await expect(page.locator(".approval-row")).toContainText("pending");

  await page.locator(".approval-row").getByRole("button", { name: "Deny" }).click();
  await expect(page.locator(".approval-row")).toContainText("denied");
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Approvals" }).click();
  const mediaApproval = page.locator(".approval-row").filter({ hasText: "Approve media job cost" });
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
        boundPath: cwd,
        allowedTools: ["read", "grep", "find", "ls"],
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
      },
    ],
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
    mediaJobs: [],
    artifactsByRun: {},
    artifactsByMediaJob: {},
  };
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

function createProviderFromBody(body: Record<string, unknown>, id: string): Record<string, unknown> {
  const apiKeyRef = typeof body.apiKeyRef === "string" ? body.apiKeyRef : undefined;
  return {
    id,
    kind: typeof body.kind === "string" ? body.kind : "openai-compatible",
    displayName: typeof body.displayName === "string" ? body.displayName : "Custom Provider",
    providerId: typeof body.providerId === "string" ? body.providerId : "custom-provider",
    model: typeof body.model === "string" ? body.model : "custom-model",
    api: typeof body.api === "string" ? body.api : "openai-completions",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    apiKeyRef,
    apiKeyConfigured: apiKeyRef === "env:LOCAL_RELAY_API_KEY",
    headers: {},
    authHeader: body.authHeader === true,
    reasoning: body.reasoning === true,
    input: Array.isArray(body.input) ? body.input : ["text"],
    compat: {},
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : ["chat"],
    enabled: body.enabled === true,
    contextWindow: typeof body.contextWindow === "number" ? body.contextWindow : undefined,
    maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
    createdAt: "2026-05-25T00:10:00.000Z",
    updatedAt: "2026-05-25T00:10:00.000Z",
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
  options: { readonly defaultWorkspaceCwd?: string } = {},
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
    await route.fulfill({ json: { templates: [] } });
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
      ? { ...existing, ...createProviderFromBody(body, providerId), id: providerId, updatedAt: "2026-05-25T00:10:00.000Z" }
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
  if (request.method() === "GET" && path === "/tasks") {
    await route.fulfill({ json: { cwd, tasks: state.tasks } });
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
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: ready\ndata: ${JSON.stringify({ runId })}`,
        `event: message\ndata: ${JSON.stringify({
          id: `evt_${runId}_end`,
          runId,
          seq: 1,
          ts: run.updatedAt,
          type: "run_end",
          data: { status: "succeeded" },
        })}`,
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
    await route.fulfill({
      json: {
        runId,
        nextSeq: 2,
        events: [
          {
            id: "evt_run_error",
            runId,
            seq: 1,
            ts: "2026-05-22T00:01:00.000Z",
            type: "run_error",
            data: { message: "Tool failed while reading workspace state." },
          },
        ],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
