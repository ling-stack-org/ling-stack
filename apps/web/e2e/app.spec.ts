import { expect, test, type Page, type Route } from "@playwright/test";

const cwd = "/Users/tianxiao/ling-stack";

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
  await expect(page.getByText("No provider presets")).toBeVisible();
  await expect(page.getByText("1 expired approval need review")).toBeVisible();
  await expect(page.getByText(/Latest failed run needs review: run_failed/)).toBeVisible();

  await expect(page.getByLabel("Task detail")).toContainText("Task detail");
  await expect(page.getByLabel("Task detail")).toContainText("run_failed");
  await expect(page.getByLabel("Task detail").getByText("Inspect run failure")).toBeVisible();
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
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: /run_failed/ }).click();

  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(page.locator(".artifact-row")).toHaveCount(2);
  await expect(page.locator(".artifact-row").first()).toContainText("Generated report");
  await expect(page.locator(".artifact-row").first()).toHaveAttribute("href", /\/artifacts\/artifact_report\/content/);
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
      errorMessage: "Seedream live vendor HTTP adapter is not implemented yet. No vendor HTTP request was made.",
      createdAt: "2026-05-23T00:00:30.000Z",
      updatedAt: "2026-05-23T00:01:00.000Z",
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
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Media jobs", level: 1 })).toBeVisible();
  const failedJob = page.locator(".media-job-row").filter({ hasText: "Live gated product mockup." });
  await expect(failedJob).toContainText("failed");
  await expect(failedJob).toContainText("live vendor HTTP adapter is not implemented yet");

  const existingJob = page.locator(".media-job-row").filter({ hasText: "Existing product mockup." });
  await expect(existingJob).toContainText("Existing product mockup.");
  await existingJob.getByRole("button", { name: "Run" }).click();
  await expect(existingJob).toContainText("succeeded");
  await expect(existingJob.locator(".artifact-row")).toContainText("Image generate static result");
  await expect(existingJob.locator(".artifact-row")).toHaveAttribute("href", /\/artifacts\/artifact_media_job_existing\/content/);

  await page.getByRole("textbox", { name: "Prompt" }).fill("New campaign image.");
  await page.getByRole("button", { name: "Create media job" }).click();

  await expect(page.locator(".media-job-row").first()).toContainText("New campaign image.");
  await expect.poll(() => state.mediaJobs.length).toBe(3);
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

async function mockDaemon(page: Page, state: MockState): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    await handleDaemonRoute(route, state);
  });
}

async function handleDaemonRoute(route: Route, state: MockState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;

  if (request.method() === "GET" && path === "/health") {
    await route.fulfill({ json: { ok: true, service: "ling-stack-daemon" } });
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
