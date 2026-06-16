import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createVerboseRunEvents,
  cwd,
  isRecord,
  type MockRun,
} from "./support/mock-state";
import {
  openChannelContextPanel,
  readHorizontalOverflow,
} from "./support/test-helpers";

async function openRunDiagnostics(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Developer/ }).click();
  await page.getByRole("button", { name: "Open Run Diagnostics" }).click();
}

test("runtime diagnostics surface supervisor state and work unit controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = state.runs.map((run) => ({ ...run, workUnitId: "wu_running" }));
  const timeoutPolicy = {
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 45_000,
    idleTimeoutMs: 600_000,
    hardTimeoutMs: 3_600_000,
    cancelGraceMs: 15_000,
  };
  state.workUnits = [
    {
      id: "wu_running",
      workspaceId: "workspace_default",
      kind: "task_run",
      ownerType: "task",
      ownerId: "task_inspect",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      providerPresetId: "provider_local",
      runnerId: "pi-coding-agent",
      idempotencyKey: "run-active",
      status: "running",
      priority: 0,
      attemptCount: 1,
      activeAttemptId: "attempt_running",
      createdByActor: "user",
      request: { prompt: "Inspect workspace" },
      timeoutPolicy,
      linkedRunId: "run_failed",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:12:00.000Z",
      startedAt: "2026-05-25T00:10:05.000Z",
      lastEventAt: "2026-05-25T00:12:00.000Z",
      lastHeartbeatAt: "2026-05-25T00:12:00.000Z",
      errorCode: "runtime_stuck",
    },
    {
      id: "wu_queue",
      workspaceId: "workspace_default",
      kind: "channel_ai_reply",
      ownerType: "channel",
      ownerId: "channel_engineering",
      channelId: "channel_engineering",
      providerPresetId: "provider_local",
      runnerId: "pi-coding-agent",
      idempotencyKey: "reply-queued",
      status: "queued",
      priority: 0,
      attemptCount: 1,
      activeAttemptId: "attempt_queue",
      createdByActor: "system",
      request: { body: "Queued reply" },
      timeoutPolicy,
      createdAt: "2026-05-25T00:13:00.000Z",
      updatedAt: "2026-05-25T00:13:00.000Z",
      lastEventAt: "2026-05-25T00:13:00.000Z",
    },
    {
      id: "wu_stale",
      workspaceId: "workspace_default",
      kind: "media_job",
      ownerType: "media_job",
      ownerId: "media_job_1",
      runnerId: "media-provider",
      idempotencyKey: "media-stale",
      status: "stale",
      priority: 0,
      attemptCount: 1,
      activeAttemptId: "attempt_stale",
      createdByActor: "system",
      request: { prompt: "Generate image" },
      timeoutPolicy,
      createdAt: "2026-05-25T00:09:00.000Z",
      updatedAt: "2026-05-25T00:14:00.000Z",
      endedAt: "2026-05-25T00:14:00.000Z",
      lastEventAt: "2026-05-25T00:14:00.000Z",
      errorMessage: "runtime lost heartbeat",
    },
  ];
  state.workUnitAttemptsByWorkUnit = Object.fromEntries(state.workUnits.map((unit) => [unit.id, [{
    id: unit.activeAttemptId ?? `attempt_${unit.id}`,
    workUnitId: unit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_e2e_shared",
    runnerId: unit.runnerId,
    providerPresetId: unit.providerPresetId,
    status: unit.status === "stale" ? "lost" : unit.status === "queued" ? "created" : "started",
    createdAt: unit.createdAt,
    startedAt: unit.startedAt,
    lastEventAt: unit.lastEventAt,
    lastHeartbeatAt: unit.lastHeartbeatAt,
  }]]));
  state.runtimeEventsByWorkUnit = {
    wu_running: [{ id: "runtime_event_running_1", workUnitId: "wu_running", attemptId: "attempt_running", seq: 1, ts: "2026-05-25T00:12:00.000Z", type: "work_unit_progress", actor: "runner", data: {} }],
    wu_queue: [{ id: "runtime_event_queue_1", workUnitId: "wu_queue", attemptId: "attempt_queue", seq: 1, ts: "2026-05-25T00:13:00.000Z", type: "work_unit_queued", actor: "system", data: {} }],
    wu_stale: [{ id: "runtime_event_stale_1", workUnitId: "wu_stale", attemptId: "attempt_stale", seq: 1, ts: "2026-05-25T00:14:00.000Z", type: "work_unit_stale", actor: "system", data: {} }],
  };
  state.resourceLeases = [{
    id: "lease_running",
    workspaceId: "workspace_default",
    resourceType: "bound_path",
    resourceKey: cwd,
    ownerType: "run",
    ownerId: "run_failed",
    workUnitId: "wu_running",
    attemptId: "attempt_running",
    status: "active",
    acquiredAt: "2026-05-25T00:10:05.000Z",
    lastRenewedAt: "2026-05-25T00:12:00.000Z",
    expiresAt: "2026-05-25T01:12:00.000Z",
  }];
  state.runtimeSemaphoreSlots = [{
    id: "slot_provider",
    workspaceId: "workspace_default",
    resourceType: "provider",
    resourceKey: "provider_local",
    ownerType: "work_unit_attempt",
    ownerId: "attempt_running",
    workUnitId: "wu_running",
    attemptId: "attempt_running",
    status: "active",
    acquiredAt: "2026-05-25T00:10:05.000Z",
    lastRenewedAt: "2026-05-25T00:12:00.000Z",
    expiresAt: "2026-05-25T01:12:00.000Z",
  }];
  state.channelContextSummaries = [
    {
      id: "summary_runtime_context",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      targetType: "thread",
      targetId: "thread_runtime_context",
      sourceMessageIds: [],
      decisionIds: [],
      summary: "Runtime diagnostics context for channel inspector deep-link.",
      acceptanceCriteria: [],
      openQuestions: [],
      authorType: "system",
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Runtime" }).click();

  const diagnostics = page.getByLabel("Runtime diagnostics");
  await expect(diagnostics).toContainText("runtime_e2e_shared");
  await expect(diagnostics.locator(".runtime-kpi-grid")).toContainText("Active");
  await expect(diagnostics.locator(".runtime-kpi-grid")).toContainText("Queued");
  await expect(diagnostics.locator(".runtime-kpi-grid")).toContainText("Stuck");
  await expect(diagnostics.locator(".runtime-kpi-grid")).toContainText("Stale");
  await expect(diagnostics.locator(".runtime-work-unit-row").filter({ hasText: "wu_running" })).toContainText("running");
  await expect(diagnostics.locator(".runtime-work-unit-row").filter({ hasText: "wu_queue" })).toContainText("queued");
  await expect(diagnostics.locator(".runtime-work-unit-row").filter({ hasText: "wu_stale" })).toContainText("runtime lost heartbeat");
  await expect(diagnostics.locator(".runtime-resource-row").filter({ hasText: "bound_path" })).toBeVisible();
  await expect(diagnostics.locator(".runtime-resource-row").filter({ hasText: "provider_local" })).toBeVisible();

  await diagnostics.locator(".runtime-work-unit-row").filter({ hasText: "wu_queue" }).getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => state.workUnits.find((unit) => unit.id === "wu_queue")?.status).toBe("cancelled");
});

test("run detail renders state transitions from daemon timeline API", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.memoryObjects = [
    {
      id: "memory_run_scope",
      workspaceId: "workspace_default",
      scopeType: "run",
      ownerId: "run_failed",
      title: "Run acceptance memory",
      body: "Run detail should show memory provenance.",
      tags: ["run-detail"],
      sourceRefs: [],
      reviewState: "active",
      enabled: true,
      sensitivity: "normal",
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
  ];
  state.usedMemoryEvents = [
    {
      id: "used_memory_run_detail",
      workspaceId: "workspace_default",
      memoryIds: ["memory_run_scope"],
      intent: "task-run",
      recallQuery: "inspect workspace",
      taskId: "task_inspect",
      runId: "run_failed",
      responseId: "run_failed",
      policyVersion: "ling-memory-v1-lexical",
      createdAt: "2026-05-22T00:00:30.000Z",
    },
  ];
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

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  await page.getByLabel("Evidence").getByRole("button", { name: "Used memory" }).click();
  await expect(page.getByLabel("Used memory").filter({ hasText: "Run acceptance memory" })).toBeVisible();
  await page.locator(".run-detail-panel").getByText("Debug details").click();
  await expect(page.getByRole("heading", { name: "State machine" })).toBeVisible();
  await expect(page.getByText("runner_failed: running -> failed")).toBeVisible();
  await expect(page.getByText("claim: todo -> claimed")).toBeVisible();
});

test("run detail keeps debug event timeline contained", async ({ page }) => {
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
  state.eventsByRun.run_failed = createVerboseRunEvents("run_failed");
  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run activity" })).toHaveCount(0);

  const debugDetails = page.locator("details.debug-details");
  await expect(debugDetails).toHaveCount(1);
  await expect(debugDetails).not.toHaveAttribute("open", /.+/);
  await debugDetails.locator(":scope > summary").click();
  await expect(page.getByRole("heading", { name: "Tool activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Event timeline" })).toBeVisible();
  await expect(debugDetails.getByText("assistant_thinking_delta").first()).toBeVisible();
  await expect(debugDetails.getByText("tool_start").first()).toBeVisible();
  await expect.poll(() => readHorizontalOverflow(page, ".run-detail-events, .tool-event-list, .debug-details")).toEqual([]);
});

test("run detail can queue guidance and cancel queued intervention", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = state.runs.map((run) => ({
    ...run,
    status: "running",
    endedAt: undefined,
    errorMessage: undefined,
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  const guidancePanel = page.locator(".run-guidance-panel");
  await expect(guidancePanel.getByRole("heading", { name: "Run guidance" })).toBeVisible();
  await guidancePanel.getByPlaceholder("Tell this run what to do next...").fill("After this finishes, inspect the memory audit UI.");
  await guidancePanel.getByRole("button", { name: "Queue guidance" }).click();

  await expect.poll(() => state.runInterventions.length).toBe(1);
  await expect(guidancePanel).toContainText("After this finishes, inspect the memory audit UI.");
  await expect(guidancePanel).toContainText("Queued");

  await guidancePanel.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => state.runInterventions[0]?.status).toBe("cancelled");
  await expect(guidancePanel).toContainText("Cancelled");
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

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();
  const providerRepair = page.locator(".run-repair-hint.providers");
  await expect(providerRepair).toContainText("Provider repair needed");
  await providerRepair.getByRole("button", { name: "Model Workbench" }).click();

  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByText("Next: repair Auth Failed Gateway check failure")).toBeVisible();
  const failedProviderRow = page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" });
  await expect(failedProviderRow).toContainText("auth failed");
  await expect(failedProviderRow.getByRole("button", { name: "Edit" })).toBeVisible();
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

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(page.locator(".artifact-row")).toHaveCount(3);
  await expect(page.locator(".artifact-row").first()).toContainText("Generated report");
  await expect(page.locator(".artifact-row").first().locator(".artifact-main-link")).toHaveAttribute("href", /\/artifacts\/artifact_report\/content/);
  const imageRow = page.locator(".artifact-row").filter({ hasText: "Seedream image 1" });
  await expect(imageRow).toContainText("image");
  await expect(imageRow).toContainText("2.0 KB");
  await expect(imageRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_image\/content/);
  const downloadLink = imageRow.getByRole("link", { name: "Download" });
  await expect(downloadLink).toHaveAttribute("href", /\/artifacts\/artifact_image\/content/);
  await expect(downloadLink).toHaveAttribute("download", "003-seedream-image.png");
});

test("run history opens a thread-first detail with evidence and resume preview", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const sourceRun: MockRun = {
    ...state.runs[0],
    id: "run_thread_source",
    status: "failed",
    threadId: "thread_audit",
    taskSnapshot: {
      id: "task_thread_audit",
      title: "Thread-first execution audit",
      prompt: "Inspect thread-level evidence before resuming.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_thread_audit",
        title: "Thread-first execution audit",
        prompt: "Inspect thread-level evidence before resuming.",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_thread_source.jsonl",
    errorMessage: "Previous implementation stopped before thread audit.",
    createdAt: "2026-05-25T00:35:00.000Z",
    updatedAt: "2026-05-25T00:36:00.000Z",
    endedAt: "2026-05-25T00:36:00.000Z",
  };
  state.runs = [sourceRun];
  state.threads = [
    {
      id: "thread_audit",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_thread_audit",
      title: "Thread-first execution audit",
      objective: "Inspect thread-level evidence before resuming.",
      status: "failed",
      lastRunId: sourceRun.id,
      createdAt: "2026-05-25T00:35:00.000Z",
      updatedAt: "2026-05-25T00:36:00.000Z",
    },
  ];
  state.eventsByRun[sourceRun.id] = [
    {
      id: "evt_thread_source_error",
      runId: sourceRun.id,
      seq: 1,
      ts: "2026-05-25T00:36:00.000Z",
      type: "run_error",
      data: { message: "Previous implementation stopped before thread audit." },
    },
  ];
  state.artifactsByRun[sourceRun.id] = [
    {
      id: "artifact_action_preview",
      runId: sourceRun.id,
      type: "diff",
      path: "run_thread_source/action-preview.diff",
      title: "Action preview diff",
      contentType: "text/x-diff; charset=utf-8",
      sizeBytes: 512,
      createdAt: "2026-05-25T00:35:30.000Z",
    },
    {
      id: "artifact_action_result",
      runId: sourceRun.id,
      type: "markdown",
      path: "run_thread_source/action-result.md",
      title: "Action result summary",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 256,
      createdAt: "2026-05-25T00:36:00.000Z",
    },
  ];
  state.executionActions = [
    {
      id: "execution_action_thread_patch",
      workspaceId: "workspace_default",
      threadId: "thread_audit",
      runId: sourceRun.id,
      actionType: "bash",
      risk: "medium",
      status: "succeeded",
      title: "Apply thread audit patch",
      summary: "Patch was previewed and then applied.",
      targetRefs: [{ type: "file", path: "apps/web/src/features/runs/RunHistory.tsx" }],
      previewArtifactIds: ["artifact_action_preview"],
      resultArtifactIds: ["artifact_action_result"],
      createdAt: "2026-05-25T00:35:30.000Z",
      updatedAt: "2026-05-25T00:36:00.000Z",
      executedAt: "2026-05-25T00:36:00.000Z",
    },
  ];
  state.runInterventions = [
    {
      id: "intervention_followup_thread",
      workspaceId: "workspace_default",
      sourceRunId: sourceRun.id,
      mode: "queue_followup",
      status: "queued",
      instruction: "Follow up with browser smoke evidence.",
      requestedBy: "local-user",
      idempotencyKey: "thread_followup",
      createdAt: "2026-05-25T00:36:10.000Z",
      updatedAt: "2026-05-25T00:36:10.000Z",
    },
  ];
  state.stateTransitions = [
    {
      id: "transition_thread_source_failed",
      workspaceId: "workspace_default",
      entityType: "run",
      entityId: sourceRun.id,
      fromStatus: "running",
      toStatus: "failed",
      event: "run_failed",
      actor: "runner",
      reason: "Previous implementation stopped before thread audit.",
      createdAt: "2026-05-25T00:36:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.locator(".thread-list").getByRole("button", { name: /Thread-first execution audit/ }).click();

  const detail = page.getByLabel("Thread detail");
  await expect(detail.getByRole("heading", { name: "Thread detail" })).toBeVisible();
  await expect(detail).toContainText("Inspect thread-level evidence before resuming.");
  await expect(detail).toContainText("Thread lineage");
  await expect(detail).toContainText("Execution actions");
  await expect(detail).toContainText("Action preview diff");
  await expect(detail).toContainText("Action result summary");
  await expect(detail).toContainText("Follow up with browser smoke evidence.");
  await expect(detail).toContainText("run_failed: running -> failed");

  await detail.getByRole("button", { name: "Preview resume" }).click();
  await expect(detail.locator(".compact-json").filter({ hasText: "Resume context preview" })).toContainText("Source run");
  await expect(detail.locator(".compact-json").filter({ hasText: "Resume context preview" })).toContainText("artifact_action_preview");

  await detail.getByRole("button", { name: "Resume thread" }).click();
  await expect.poll(() => state.runs.some((run) => run.id.startsWith("run_resume_"))).toBe(true);
  await expect(detail).toContainText("Resume run");
});

test("run history groups durable Ling turn attempts and keeps run detail selected", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const primaryRun: MockRun = {
    ...state.runs[0],
    id: "run_turn_primary",
    status: "failed",
    threadId: "thread_work_history",
    taskId: "task_turn_primary",
    taskSnapshot: {
      id: "task_turn_primary",
      title: "Primary durable turn attempt",
      prompt: "Build the first Work History attempt.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_turn_primary",
        title: "Primary durable turn attempt",
        prompt: "Build the first Work History attempt.",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_turn_primary.jsonl",
    createdAt: "2026-05-25T01:00:00.000Z",
    updatedAt: "2026-05-25T01:01:00.000Z",
    endedAt: "2026-05-25T01:01:00.000Z",
  };
  const retryRun: MockRun = {
    ...primaryRun,
    id: "run_turn_retry",
    status: "succeeded",
    taskId: "task_turn_retry",
    taskSnapshot: {
      id: "task_turn_retry",
      title: "Retry durable turn grouping",
      prompt: "Finish the durable Work History grouping.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_turn_retry",
        title: "Retry durable turn grouping",
        prompt: "Finish the durable Work History grouping.",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_turn_retry.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T01:02:00.000Z",
    updatedAt: "2026-05-25T01:03:00.000Z",
    endedAt: "2026-05-25T01:03:00.000Z",
  };
  state.runs = [primaryRun, retryRun];
  state.threads = [
    {
      id: "thread_work_history",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_turn_retry",
      title: "Thread wrapper title",
      objective: "Group durable Work History attempts.",
      status: "succeeded",
      lastRunId: retryRun.id,
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:03:00.000Z",
    },
  ];
  state.turns = [
    {
      id: "turn_work_history",
      workspaceId: "workspace_default",
      threadId: "thread_work_history",
      kind: "manual_followup",
      status: "succeeded",
      title: "Refactor durable Work History",
      userInstruction: "Group retries under the same Work History turn.",
      channelId: "channel_engineering",
      taskId: "task_turn_retry",
      lastRunId: retryRun.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:03:00.000Z",
      completedAt: "2026-05-25T01:03:00.000Z",
    },
  ];
  state.turnRunLinks = [
    {
      turnId: "turn_work_history",
      runId: primaryRun.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: "2026-05-25T01:00:00.000Z",
    },
    {
      turnId: "turn_work_history",
      runId: retryRun.id,
      attemptNumber: 2,
      role: "retry",
      createdAt: "2026-05-25T01:02:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  const workList = page.locator(".thread-list");
  await expect(workList.getByRole("button", { name: /Refactor durable Work History/ })).toBeVisible();
  await expect(workList).toContainText("Durable turn");
  await expect(workList).toContainText("2 attempts");
  await expect(workList.getByRole("button", { name: /Attempt 1/ })).toBeVisible();
  await expect(workList.getByRole("button", { name: /Attempt 2/ })).toBeVisible();
  await expect(page.getByText("No run-only records for this workspace")).toBeVisible();

  const resumePreviewRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/threads/thread_work_history/resume-preview")) {
      resumePreviewRequests.push(request.postData() ?? "");
    }
  });

  await workList.getByRole("button", { name: /Refactor durable Work History/ }).click();
  const detail = page.getByLabel("Run detail");
  await expect(detail.getByRole("heading", { name: "Run detail" })).toBeVisible();
  await expect(detail).toContainText("Turn");
  await expect(detail).toContainText("Refactor durable Work History");
  await expect(detail).toContainText("Retry durable turn grouping");
  await expect(detail).toContainText("Attempt 1");
  await expect(detail).toContainText("Attempt 2");

  await detail.getByRole("button", { name: "Preview resume" }).click();
  await expect.poll(() => resumePreviewRequests.length).toBe(1);
  expect(resumePreviewRequests[0]).toContain("\"turnId\":\"turn_work_history\"");
  const resumePreview = detail.locator(".compact-json").filter({ hasText: "Resume context preview" });
  await expect(resumePreview).toContainText("Source turn");
  await expect(resumePreview).toContainText("turn_work_history");
  await expect(resumePreview).toContainText("Source run");
  await expect(resumePreview).toContainText(retryRun.id);
  await expect(resumePreview).toContainText("Prior turns");

  await detail.getByRole("button", { name: "Resume thread" }).click();
  await expect.poll(() => state.turns.find((turn) => turn.sourceTurnId === "turn_work_history")?.id).toMatch(/^turn_resume_/);
  await expect.poll(() => {
    const childTurn = state.turns.find((turn) => turn.sourceTurnId === "turn_work_history");
    return childTurn ? state.turnRunLinks.some((link) => link.turnId === childTurn.id && link.role === "resume") : false;
  }).toBe(true);

  await detail.getByRole("button", { name: "Open attempt" }).click();
  await expect(detail).toContainText("Primary durable turn attempt");
  await expect(detail.getByRole("button", { name: "Current run", exact: true })).toBeVisible();
});

test("fork lineage creates child thread in work history while channel page hides branch chrome", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const sourceRun: MockRun = {
    ...state.runs[0],
    id: "run_fork_source",
    status: "succeeded",
    threadId: "thread_fork_source",
    taskId: "task_fork_source",
    taskSnapshot: {
      id: "task_fork_source",
      title: "Fork lineage source",
      prompt: "Create a completed work thread that can branch.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_fork_source",
        title: "Fork lineage source",
        prompt: "Create a completed work thread that can branch.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_fork_source.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T01:20:00.000Z",
    updatedAt: "2026-05-25T01:21:00.000Z",
    endedAt: "2026-05-25T01:21:00.000Z",
  };
  state.runs = [sourceRun];
  state.threads = [
    {
      id: "thread_fork_source",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_fork_source",
      title: "Fork lineage source",
      objective: "Create a completed work thread that can branch.",
      status: "succeeded",
      lastRunId: sourceRun.id,
      createdAt: "2026-05-25T01:20:00.000Z",
      updatedAt: "2026-05-25T01:21:00.000Z",
    },
  ];
  state.turns = [
    {
      id: "turn_fork_source",
      workspaceId: "workspace_default",
      threadId: "thread_fork_source",
      kind: "manual_followup",
      status: "succeeded",
      title: "Complete fork source turn",
      userInstruction: "Finish source work before branching.",
      channelId: "channel_engineering",
      taskId: "task_fork_source",
      lastRunId: sourceRun.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T01:20:00.000Z",
      updatedAt: "2026-05-25T01:21:00.000Z",
      completedAt: "2026-05-25T01:21:00.000Z",
    },
  ];
  state.turnRunLinks = [];

  await mockDaemon(page, state);
  await page.goto("/");
  await openRunDiagnostics(page);

  const workList = page.locator(".thread-list");
  await workList.getByRole("button", { name: /Fork lineage source/ }).click();
  const detail = page.getByLabel("Thread detail");
  await expect(detail).toContainText("Fork lineage");
  await detail.getByLabel("Resume source turn").selectOption("turn_fork_source");
  await expect(detail.getByLabel("Resume source turn")).toHaveValue("turn_fork_source");
  await detail.getByRole("button", { name: "Fork" }).click();

  await expect.poll(() => state.threads.find((thread) => thread.parentThreadId === "thread_fork_source")?.id).toMatch(/^thread_fork_/);
  const childThread = state.threads.find((thread) => thread.parentThreadId === "thread_fork_source");
  expect(childThread).toBeTruthy();
  expect(childThread?.parentTurnId).toBe("turn_fork_source");
  expect(childThread?.forkedFromRunId).toBe(sourceRun.id);
  expect(childThread?.channelId).toBe("channel_engineering");
  expect(state.runs.filter((run) => run.threadId === childThread?.id)).toHaveLength(0);

  await expect(detail).toContainText("Forked from");
  await expect(detail).toContainText("thread_fork_source");
  await expect(detail).toContainText("turn_fork_source");
  await expect(workList).toContainText(childThread?.title ?? "Fork");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.locator(".channel-work-thread-tree")).toHaveCount(0);
  await expect(page.locator(".channel-left-drawer .sidebar-branch-list")).toHaveCount(0);
  await expect(page.getByText("Conversation branches")).toHaveCount(0);
});

test("empty channel hides default branch chrome without creating a task or run", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [];
  state.eventsByRun = {};
  state.approvals = [];
  state.threads = [];
  state.turns = [];
  state.turnRunLinks = [];

  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.locator(".channel-work-thread-tree")).toHaveCount(0);
  await expect(page.locator(".channel-left-drawer .sidebar-branch-list")).toHaveCount(0);
  await expect(page.getByText("Conversation branches")).toHaveCount(0);
  await expect(page.getByText("Main branch")).toHaveCount(0);
  await expect(page.getByText("Default channel branch")).toHaveCount(0);
  expect(state.threads).toHaveLength(0);
  expect(state.tasks).toHaveLength(0);
  expect(state.runs).toHaveLength(0);
});

test("channel branches hide ordinary workflow step execution threads", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const workflowRun: MockRun = {
    ...state.runs[0],
    id: "run_workflow_step_review",
    status: "succeeded",
    threadId: "thread_workflow_step_review",
    taskId: "task_workflow_step_review",
    workflowStepId: "workflow_step_review",
    taskSnapshot: {
      id: "task_workflow_step_review",
      title: "Docs: Review",
      prompt: "Review generated documentation.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      workflowStepId: "workflow_step_review",
      task: {
        id: "task_workflow_step_review",
        title: "Docs: Review",
        prompt: "Review generated documentation.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_workflow_step_review.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T01:25:00.000Z",
    updatedAt: "2026-05-25T01:26:00.000Z",
    endedAt: "2026-05-25T01:26:00.000Z",
  };
  state.tasks = [
    {
      id: "task_workflow_step_review",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Docs: Review",
      prompt: "Review generated documentation.",
      status: "succeeded",
      currentRunId: workflowRun.id,
      createdAt: "2026-05-25T01:25:00.000Z",
      updatedAt: "2026-05-25T01:26:00.000Z",
    },
  ];
  state.runs = [workflowRun];
  state.threads = [
    {
      id: "thread_workflow_step_review",
      workspaceId: "workspace_default",
      kind: "workflow_step",
      channelId: "channel_engineering",
      taskId: "task_workflow_step_review",
      teammateId: "docs",
      workflowId: "workflow_docs_review",
      workflowStepId: "workflow_step_review",
      title: "Docs: Review",
      objective: "Review generated documentation.",
      status: "succeeded",
      lastRunId: workflowRun.id,
      createdAt: "2026-05-25T01:25:00.000Z",
      updatedAt: "2026-05-25T01:26:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.locator(".channel-work-thread-tree")).toHaveCount(0);
  await expect(page.locator(".channel-work-thread-tree", { hasText: "Docs: Review" })).toHaveCount(0);
});

test("fork and run starts an explicit child branch run from work history", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const sourceRun: MockRun = {
    ...state.runs[0],
    id: "run_fork_run_source",
    status: "succeeded",
    threadId: "thread_fork_run_source",
    taskId: "task_fork_run_source",
    taskSnapshot: {
      id: "task_fork_run_source",
      title: "Fork and run source",
      prompt: "Create a completed source thread for immediate child work.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_fork_run_source",
        title: "Fork and run source",
        prompt: "Create a completed source thread for immediate child work.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_fork_run_source.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T01:30:00.000Z",
    updatedAt: "2026-05-25T01:31:00.000Z",
    endedAt: "2026-05-25T01:31:00.000Z",
  };
  state.runs = [sourceRun];
  state.threads = [
    {
      id: "thread_fork_run_source",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_fork_run_source",
      title: "Fork and run source",
      objective: "Create a completed source thread for immediate child work.",
      status: "succeeded",
      lastRunId: sourceRun.id,
      createdAt: "2026-05-25T01:30:00.000Z",
      updatedAt: "2026-05-25T01:31:00.000Z",
    },
  ];
  state.turns = [
    {
      id: "turn_fork_run_source",
      workspaceId: "workspace_default",
      threadId: "thread_fork_run_source",
      kind: "manual_followup",
      status: "succeeded",
      title: "Complete fork-run source turn",
      userInstruction: "Finish source work before branching.",
      channelId: "channel_engineering",
      taskId: "task_fork_run_source",
      lastRunId: sourceRun.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T01:30:00.000Z",
      updatedAt: "2026-05-25T01:31:00.000Z",
      completedAt: "2026-05-25T01:31:00.000Z",
    },
  ];
  state.turnRunLinks = [];

  await mockDaemon(page, state);
  await page.goto("/");
  await openRunDiagnostics(page);

  const workList = page.locator(".thread-list");
  const sourceRow = workList.locator(".work-history-branch-row").filter({ hasText: "Fork and run source" }).first();
  await sourceRow.click();
  await expect(sourceRow).toHaveClass(/selected/);
  const detail = page.getByLabel("Thread detail");
  await expect(detail).toContainText("Fork and run");
  await detail.getByLabel("Child instruction").fill("Implement child branch immediately.");
  await detail.getByRole("button", { name: "Start child branch" }).click();

  await expect.poll(() => state.threads.find((thread) => thread.parentThreadId === "thread_fork_run_source")?.id).toMatch(/^thread_fork_/);
  const childThread = state.threads.find((thread) => thread.parentThreadId === "thread_fork_run_source");
  expect(childThread).toBeTruthy();
  const childTurn = state.turns.find((turn) => turn.threadId === childThread?.id);
  expect(childTurn).toBeTruthy();
  const childRun = state.runs.find((run) => run.threadId === childThread?.id);
  expect(childRun).toBeTruthy();
  expect(childThread?.parentTurnId).toBe("turn_fork_run_source");
  expect(childThread?.forkedFromRunId).toBe(sourceRun.id);
  expect(childThread?.activeRunId).toBe(childRun?.id);
  expect(childTurn?.userInstruction).toBe("Implement child branch immediately.");
  expect(state.turnRunLinks.some((link) => link.turnId === childTurn?.id && link.runId === childRun?.id && link.role === "primary")).toBe(true);

  await expect(detail).toContainText("Forked from");
  await expect(detail).toContainText("thread_fork_run_source");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.locator(".channel-work-thread-tree")).toHaveCount(0);
  await expect(page.locator(".channel-left-drawer .sidebar-branch-list")).toHaveCount(0);
  const workCell = page.locator(".conversation-work-cell").filter({ hasText: "Task in progress" });
  await expect(workCell).toBeVisible();
  await expect(workCell).toContainText("Implement child branch immediately.");
});

test("run history archives restores pins and filters channel branches", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const activeRun: MockRun = {
    ...state.runs[0],
    id: "run_visibility_active",
    status: "succeeded",
    threadId: "thread_visibility_active",
    taskId: "task_visibility_active",
    taskSnapshot: {
      id: "task_visibility_active",
      title: "Visibility active branch",
      prompt: "Archive and restore this branch.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_visibility_active",
        title: "Visibility active branch",
        prompt: "Archive and restore this branch.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_visibility_active.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T02:00:00.000Z",
    updatedAt: "2026-05-25T02:01:00.000Z",
    endedAt: "2026-05-25T02:01:00.000Z",
  };
  const archivedRun: MockRun = {
    ...activeRun,
    id: "run_visibility_archived",
    threadId: "thread_visibility_archived",
    taskId: "task_visibility_archived",
    taskSnapshot: {
      id: "task_visibility_archived",
      title: "Visibility archived branch",
      prompt: "Keep this branch hidden by default.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_visibility_archived",
        title: "Visibility archived branch",
        prompt: "Keep this branch hidden by default.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_visibility_archived.jsonl",
    createdAt: "2026-05-25T01:50:00.000Z",
    updatedAt: "2026-05-25T01:51:00.000Z",
    endedAt: "2026-05-25T01:51:00.000Z",
  };
  state.runs = [activeRun, archivedRun];
  state.threads = [
    {
      id: "thread_visibility_active",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_visibility_active",
      title: "Visibility active branch",
      objective: "Archive and restore this branch.",
      status: "succeeded",
      lastRunId: activeRun.id,
      createdAt: "2026-05-25T02:00:00.000Z",
      updatedAt: "2026-05-25T02:01:00.000Z",
    },
    {
      id: "thread_visibility_archived",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_visibility_archived",
      title: "Visibility archived branch",
      objective: "Keep this branch hidden by default.",
      status: "succeeded",
      lastRunId: archivedRun.id,
      archivedAt: "2026-05-25T01:52:00.000Z",
      archivedReason: "Finished branch",
      createdAt: "2026-05-25T01:50:00.000Z",
      updatedAt: "2026-05-25T01:52:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openRunDiagnostics(page);

  const workList = page.locator(".thread-list");
  await expect(workList).toContainText("Visibility active branch");
  await expect(workList).not.toContainText("Visibility archived branch");
  const workSearch = page.getByLabel("Search thread bindings");
  await workSearch.fill("archived");
  await expect(workList).not.toContainText("Visibility active branch");
  await expect(workList).not.toContainText("Visibility archived branch");
  const filter = page.getByLabel("Thread binding visibility");
  await filter.getByRole("button", { name: "All" }).click();
  await expect(workList).toContainText("Visibility archived branch");
  await workSearch.fill("active");
  await expect(workList).toContainText("Visibility active branch");
  await expect(workList).not.toContainText("Visibility archived branch");
  await workSearch.fill("");
  await filter.getByRole("button", { name: "Active" }).click();
  await expect(workList).toContainText("Visibility active branch");

  await workList.getByRole("button", { name: /Visibility active branch/ }).click();
  const detail = page.getByLabel("Thread detail");
  await detail.getByRole("button", { name: "Pin" }).click();
  await expect.poll(() => state.threads.find((thread) => thread.id === "thread_visibility_active")?.pinnedAt).toBeTruthy();
  await expect(detail).toContainText("Pinned");

  await detail.getByRole("button", { name: "Archive" }).click();
  await expect.poll(() => state.threads.find((thread) => thread.id === "thread_visibility_active")?.archivedAt).toBeTruthy();
  await expect(workList).not.toContainText("Visibility active branch");

  await filter.getByRole("button", { name: "Archived" }).click();
  await expect(workList).toContainText("Visibility active branch");
  await expect(workList).toContainText("Visibility archived branch");

  await detail.getByRole("button", { name: "Unarchive" }).click();
  await expect.poll(() => state.threads.find((thread) => thread.id === "thread_visibility_active")?.archivedAt).toBeFalsy();
  await filter.getByRole("button", { name: "Active" }).click();
  await expect(workList).toContainText("Visibility active branch");
  await expect(workList).not.toContainText("Visibility archived branch");

  await filter.getByRole("button", { name: "All" }).click();
  await expect(workList).toContainText("Visibility active branch");
  await expect(workList).toContainText("Visibility archived branch");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.locator(".channel-work-thread-tree")).toHaveCount(0);
  await expect(page.locator(".channel-left-drawer .sidebar-branch-list")).toHaveCount(0);
});

test("run history falls back to legacy thread rows when Ling turn loading fails", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const sourceRun: MockRun = {
    ...state.runs[0],
    id: "run_turn_fallback",
    status: "failed",
    threadId: "thread_turn_fallback",
    taskSnapshot: {
      id: "task_turn_fallback",
      title: "Legacy fallback thread",
      prompt: "Keep Work History visible when turns fail.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_turn_fallback",
        title: "Legacy fallback thread",
        prompt: "Keep Work History visible when turns fail.",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_turn_fallback.jsonl",
    createdAt: "2026-05-25T01:10:00.000Z",
    updatedAt: "2026-05-25T01:11:00.000Z",
    endedAt: "2026-05-25T01:11:00.000Z",
  };
  state.runs = [sourceRun];
  state.threads = [
    {
      id: "thread_turn_fallback",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_turn_fallback",
      title: "Legacy fallback thread",
      objective: "Keep Work History visible when turns fail.",
      status: "failed",
      lastRunId: sourceRun.id,
      createdAt: "2026-05-25T01:10:00.000Z",
      updatedAt: "2026-05-25T01:11:00.000Z",
    },
  ];
  state.failThreadTurnsForThreadIds = ["thread_turn_fallback"];

  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.locator(".thread-list").getByRole("button", { name: /Legacy fallback thread/ }).click();

  const detail = page.getByLabel("Thread detail");
  await expect(detail.getByRole("heading", { name: "Thread detail" })).toBeVisible();
  await expect(detail).toContainText("Keep Work History visible when turns fail.");
});

test("thread detail keeps resume disabled while the thread has an active run", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const activeRun: MockRun = {
    ...state.runs[0],
    id: "run_thread_active",
    status: "running",
    threadId: "thread_active",
    taskSnapshot: {
      id: "task_thread_active",
      title: "Active thread audit",
      prompt: "Keep the active thread guarded.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      task: {
        id: "task_thread_active",
        title: "Active thread audit",
        prompt: "Keep the active thread guarded.",
      },
    },
    errorMessage: undefined,
    createdAt: "2026-05-25T00:37:00.000Z",
    startedAt: "2026-05-25T00:37:05.000Z",
    updatedAt: "2026-05-25T00:37:10.000Z",
    endedAt: undefined,
  };
  state.runs = [activeRun];
  state.threads = [
    {
      id: "thread_active",
      workspaceId: "workspace_default",
      kind: "task",
      channelId: "channel_engineering",
      taskId: "task_thread_active",
      title: "Active thread audit",
      objective: "Keep the active thread guarded.",
      status: "running",
      activeRunId: activeRun.id,
      lastRunId: activeRun.id,
      createdAt: "2026-05-25T00:37:00.000Z",
      updatedAt: "2026-05-25T00:37:10.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.locator(".thread-list").getByRole("button", { name: /Active thread audit/ }).click();

  const detail = page.getByLabel("Thread detail");
  await expect(detail.getByRole("heading", { name: "Thread detail" })).toBeVisible();
  await expect(detail).toContainText("Thread has an active run; resume is disabled until it reaches a terminal state.");
  await expect(detail.getByRole("button", { name: "Resume thread" })).toBeDisabled();
  await detail.getByRole("button", { name: "Preview resume" }).click();
  await expect(detail.locator(".compact-json").filter({ hasText: "Resume context preview" })).toContainText("Thread already has an active run: run_thread_active");
});

test("run detail can stop an active run and keeps the permission snapshot visible", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.workUnitActionDelayMs = 1_000;
  state.runs = state.runs.map((run) => ({
    ...run,
    status: "running",
    workUnitId: "wu_running",
    errorMessage: undefined,
    requestSnapshot: {
      ...(isRecord(run.requestSnapshot) ? run.requestSnapshot : {}),
      permissionPreset: "workspace_collaboration",
      permissionMode: "workspace_write",
      effectivePolicySnapshot: {
        mode: "workspace_write",
        label: "Workspace write",
        allowedWritePaths: [cwd],
        toolDecisions: { read: "allow", bash: "ask", write: "allow" },
        approvalRequiredFor: ["bash"],
        mcpToolCount: 0,
        riskNotes: ["Writes stay inside the channel path."],
      },
    },
  }));
  state.workUnits = [
    {
      id: "wu_running",
      workspaceId: "workspace_default",
      kind: "run",
      ownerType: "task",
      ownerId: "task_inspect",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      providerPresetId: "provider_local",
      idempotencyKey: "test-running-unit",
      status: "running",
      priority: 0,
      attemptCount: 1,
      activeAttemptId: "attempt_running",
      createdByActor: "local-user",
      request: {},
      timeoutPolicy: { claimTtlMs: 60_000, heartbeatTtlMs: 60_000, cancelGraceMs: 15_000 },
      linkedRunId: "run_failed",
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:01:00.000Z",
      startedAt: "2026-05-22T00:01:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  const detail = page.getByLabel("Run detail");
  await expect(detail).toContainText("Workspace collaboration");
  await expect(detail).toContainText("Workspace write");
  await detail.getByRole("button", { name: "Stop" }).click();
  await expect(detail.getByRole("button", { name: "Stopping" })).toBeVisible();
  await expect.poll(() => state.workUnits.find((unit) => unit.id === "wu_running")?.status).toBe("cancelled");
  await expect.poll(() => state.runs.find((run) => run.id === "run_failed")?.status).toBe("cancelled");
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_1")?.status).toBe("cancelled");
});

test("run detail shows stored permission preset and full access confirmation evidence", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = state.runs.map((run) => ({
    ...run,
    requestSnapshot: {
      ...(isRecord(run.requestSnapshot) ? run.requestSnapshot : {}),
      permissionPreset: "full_access",
      permissionMode: "full_access",
      permissionConfirmation: {
        mode: "full_access",
        confirmed: true,
        confirmedAt: "2026-06-07T00:00:00.000Z",
        reason: "user_confirmed_full_access",
      },
      effectivePolicySnapshot: {
        mode: "full_access",
        allowedWritePaths: ["/"],
        toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "allow", edit: "allow", write: "allow" },
        riskNotes: [],
      },
    },
  }));

  await mockDaemon(page, state);
  await page.goto("/");

  await openRunDiagnostics(page);
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  const detail = page.getByLabel("Run detail");
  const summary = detail.locator(".run-detail-summary");
  await expect(summary.getByText("Permission preset", { exact: true })).toBeVisible();
  await expect(detail).toContainText("Full access");
  await expect(summary.getByText("Full access confirmation", { exact: true })).toBeVisible();
  await expect(detail).toContainText("user_confirmed_full_access");
  await expect(detail).toContainText("Write scope: /");
});
