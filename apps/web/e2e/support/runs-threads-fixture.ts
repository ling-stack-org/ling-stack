import type { Page } from "@playwright/test";
import { mockDaemon, type MockArtifact, type MockLingThread, type MockRun, type MockState } from "./mock-daemon";
import { createBaseState, createVerboseRunEvents, cwd } from "./mock-state";

export function createRunsThreadsFixture(visibleThreadCount = 4): MockState {
  const state = createBaseState({ approvalStatus: "pending" });
  const seed = state.runs[0];
  const failed = runFixture(seed, "run_ui2_failed", "thread_ui2_main", "failed", "Failed provider repair run", "2026-07-23T01:00:00.000Z");
  failed.errorMessage = "Provider route unavailable for focused repair evidence.";
  failed.providerPresetId = undefined;
  failed.requestSnapshot = { cwd, task: { id: failed.taskId, title: "Failed provider repair run", prompt: "Inspect repair state." } };
  const retry = runFixture(seed, "run_ui2_retry", "thread_ui2_main", "succeeded", "Retry completed with evidence", "2026-07-23T01:05:00.000Z");
  const running = runFixture(seed, "run_ui2_running", "thread_ui2_active", "running", "Running approval audit", "2026-07-23T02:00:00.000Z");
  running.workUnitId = "wu_ui2_running";
  state.runs = [running, retry, failed];
  state.workUnits = [{
    id: running.workUnitId,
    workspaceId: "workspace_default",
    kind: "run",
    ownerType: "task",
    ownerId: running.taskId,
    taskId: running.taskId,
    providerPresetId: "provider_local",
    idempotencyKey: "ui2-running-approval-audit",
    status: "running",
    priority: 0,
    attemptCount: 1,
    activeAttemptId: "attempt_ui2_running",
    createdByActor: "local-user",
    request: { taskId: running.taskId, runId: running.id },
    timeoutPolicy: { claimTtlMs: 60_000, heartbeatTtlMs: 60_000, cancelGraceMs: 15_000 },
    linkedRunId: running.id,
    createdAt: running.createdAt,
    updatedAt: running.updatedAt,
    startedAt: running.startedAt,
    lastEventAt: running.updatedAt,
    lastHeartbeatAt: running.updatedAt,
  }];
  state.threads = [
    threadFixture("thread_ui2_main", "Main evidence lineage", "succeeded", retry.id, "2026-07-23T01:05:00.000Z"),
    { ...threadFixture("thread_ui2_child", "Child lineage branch", "succeeded", retry.id, "2026-07-23T01:06:00.000Z"), parentThreadId: "thread_ui2_main", parentTurnId: "turn_ui2_main", forkedFromRunId: retry.id },
    { ...threadFixture("thread_ui2_active", "Active thread audit", "running", running.id, "2026-07-23T02:00:00.000Z"), activeRunId: running.id },
    threadFixture("thread_ui2_archived", "Archived audit branch", "archived", failed.id, "2026-07-23T00:30:00.000Z", "2026-07-23T00:31:00.000Z"),
  ];
  for (let index = state.threads.length; index < visibleThreadCount + 1; index += 1) {
    state.threads.push(threadFixture(`thread_ui2_${String(index).padStart(3, "0")}`, `Long history row ${String(index).padStart(3, "0")}`, "succeeded", undefined, `2026-07-22T${String(index % 24).padStart(2, "0")}:00:00.000Z`));
  }
  state.turns = [
    { id: "turn_ui2_main", workspaceId: "workspace_default", threadId: "thread_ui2_main", kind: "manual_followup", status: "succeeded", title: "Durable retry grouping", userInstruction: "Keep attempts grouped.", lastRunId: retry.id, createdByActor: "local-user", createdAt: failed.createdAt, updatedAt: retry.updatedAt, completedAt: retry.updatedAt },
    { id: "turn_ui2_active", workspaceId: "workspace_default", threadId: "thread_ui2_active", kind: "initial_request", status: "running", title: "Active guarded turn", userInstruction: "Wait for authority.", activeRunId: running.id, lastRunId: running.id, createdByActor: "local-user", createdAt: running.createdAt, updatedAt: running.updatedAt },
  ];
  state.turnRunLinks = [
    { turnId: "turn_ui2_main", runId: failed.id, attemptNumber: 1, role: "primary", createdAt: failed.createdAt },
    { turnId: "turn_ui2_main", runId: retry.id, attemptNumber: 2, role: "retry", createdAt: retry.createdAt },
    { turnId: "turn_ui2_active", runId: running.id, attemptNumber: 1, role: "primary", createdAt: running.createdAt },
  ];
  state.eventsByRun[failed.id] = [
    ...createVerboseRunEvents(failed.id).filter((event) => event.type !== "approval_requested"),
    { id: "evt_ui2_long", runId: failed.id, seq: 999, ts: failed.updatedAt, type: "run_error", data: { message: "x".repeat(1200), nested: { payload: "y".repeat(1800) } } },
  ];
  state.eventsByRun[retry.id] = createVerboseRunEvents(retry.id);
  state.eventsByRun[running.id] = createVerboseRunEvents(running.id);
  const artifact: MockArtifact = { id: "artifact_ui2_recording", runId: failed.id, type: "markdown", path: `${failed.id}/evidence.md`, title: "Focused recording evidence", contentType: "text/markdown", sizeBytes: 512, createdAt: failed.updatedAt };
  state.artifactsByRun[failed.id] = [artifact];
  state.artifactsByRun[retry.id] = [];
  state.artifactsByRun[running.id] = [];
  state.approvals = state.approvals.map((approval) => ({ ...approval, runId: running.id, status: "pending", title: "Approve running audit" }));
  state.stateTransitions = [
    { id: "transition_ui2_failed", workspaceId: "workspace_default", entityType: "run", entityId: failed.id, fromStatus: "running", toStatus: "failed", event: "provider_failed", actor: "runner", createdAt: failed.updatedAt },
  ];
  state.executionActions = [{ id: "action_ui2", workspaceId: "workspace_default", threadId: "thread_ui2_main", runId: retry.id, actionType: "edit", risk: "medium", status: "succeeded", title: "Apply focused migration", summary: "Focused action evidence", targetRefs: [{ type: "file", path: "apps/web/src/features/runs/RunHistory.tsx" }], previewArtifactIds: [], resultArtifactIds: [], createdAt: retry.createdAt, updatedAt: retry.updatedAt, executedAt: retry.updatedAt }];
  return state;
}

export async function installRunsThreadsFixture(page: Page, state: MockState): Promise<void> {
  await mockDaemon(page, state);
  await installThreadsContextEntry(page);
}

export async function openMainRunHistory(page: Page, taskTitle?: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Startup and diagnostics|启动与诊断/ }).click();
  await page.getByRole("button", { name: /Open Run Diagnostics|打开运行诊断/ }).click();
  const diagnostics = page.locator(".settings-run-diagnostics-panel");
  if (taskTitle) {
    const row = diagnostics.locator(".settings-run-row").filter({ hasText: taskTitle }).first();
    if (await row.isVisible().catch(() => false)) await row.click();
  }
  await diagnostics.getByRole("button", { name: /Open full diagnostics in app|在主应用打开完整诊断/ }).click();
}

export async function openThreadsPage(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /Automations|自动化/ }).click();
  await page.locator('[data-automation-id="automation_ui2_threads_entry"]')
    .getByRole("button", { name: /Thread|会话/, exact: true })
    .click();
}

async function installThreadsContextEntry(page: Page): Promise<void> {
  const automation = {
    id: "automation_ui2_threads_entry",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "thread_ui2_main",
    automationMode: "cron",
    title: "Runs and Threads evidence",
    description: "Existing object-context entry for the focused Threads view.",
    kind: "custom_prompt",
    status: "enabled",
    trigger: { type: "manual" },
    target: { scope: "workspace", workspaceId: "workspace_default", cwd },
    promptTemplate: {
      templateVersion: 1,
      systemPurpose: "Open focused thread evidence.",
      promptMarkdown: "Inspect the focused thread evidence.",
      contextSelectors: [],
      maxContextItems: 32,
    },
    executionPolicy: { providerPresetId: "provider_local", allowedTools: ["read"], approvalProfile: { mode: "none" } },
    outputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/automations") {
      await route.fulfill({ json: { cwd, automations: [automation], templates: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-drafts") {
      await route.fulfill({ json: { cwd, drafts: [], templates: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/automations/scheduler") {
      await route.fulfill({ json: { cwd, schedulers: [] } });
      return;
    }
    const shellSnapshotsMatch = /^\/runs\/([^/]+)\/shell-snapshots$/u.exec(path);
    if (request.method() === "GET" && shellSnapshotsMatch) {
      await route.fulfill({ json: { runId: decodeURIComponent(shellSnapshotsMatch[1]), snapshots: [] } });
      return;
    }
    await route.fallback();
  });
}

function runFixture(seed: MockRun, id: string, threadId: string, status: string, title: string, updatedAt: string): MockRun {
  return { ...seed, id, threadId, status, taskId: `task_${id}`, taskSnapshot: { id: `task_${id}`, title, prompt: `${title} prompt` }, requestSnapshot: { cwd, providerPresetId: "provider_local", task: { id: `task_${id}`, title, prompt: `${title} prompt` } }, eventLogPath: `.ling-stack/sessions/${id}.jsonl`, errorMessage: undefined, createdAt: updatedAt, startedAt: updatedAt, updatedAt, endedAt: status === "running" ? undefined : updatedAt };
}

function threadFixture(id: string, title: string, status: string, lastRunId: string | undefined, updatedAt: string, archivedAt?: string): MockLingThread {
  return { id, workspaceId: "workspace_default", kind: "task", title, objective: `${title} objective`, status, ...(lastRunId ? { lastRunId } : {}), ...(archivedAt ? { archivedAt, archivedReason: "focused-fixture" } : {}), createdAt: updatedAt, updatedAt };
}
