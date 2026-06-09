import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { buildEffectiveTeammateSkills } from "@ling-stack/core";
import { gstackDefaultSkillPack } from "@ling-stack/core/builtin-skill-packs";

export const cwd = "/tmp/ling-stack-workspace";
export const defaultRuntimePolicy = {
  maxConcurrentRuns: 1,
  executionMode: "serial",
  writeLockScope: "boundPath",
  allowReadOnlyParallel: true,
  queueOnConflict: true,
};

export interface MockState {
  providers: unknown[];
  providerSecrets: Record<string, string>;
  managedPlugins: MockManagedPlugin[];
  mcpServers: MockMcpServer[];
  mcpTools: MockMcpTool[];
  teammateMcpBindings: MockTeammateMcpBinding[];
  channels: unknown[];
  channelMessages: unknown[];
  channelExecutionProposals: unknown[];
  channelAttachments: unknown[];
  channelLinkPreviews: unknown[];
  channelBriefs: Record<string, unknown>;
  channelDecisions: unknown[];
  channelHandoffs: unknown[];
  channelContextSummaries: unknown[];
  channelWorkflows: unknown[];
  channelWorkflowSteps: unknown[];
  aiTeammates: unknown[];
  skillRegistryEntries: unknown[];
  skillImportDrafts: unknown[];
  teammateChannelMemberships: unknown[];
  teammateSkillBindings: unknown[];
  teammateMemoryScopes: unknown[];
  memoryObjects: unknown[];
  usedMemoryEvents: unknown[];
  teammateDirectThreads: Record<string, unknown>;
  teammateDirectMessages: unknown[];
  teammatePrivateAttachments: unknown[];
  retentionTombstones: unknown[];
  tasks: unknown[];
  runs: MockRun[];
  eventsByRun: Record<string, MockRunEvent[]>;
  runInterventions: MockRunIntervention[];
  nextStreamEvents?: MockRunEvent[];
  providerCheckDelayMs?: number;
  runResponseDelayMs?: number;
  channelMessageDelayMs?: number;
  failNextChannelMessage?: boolean;
  lastChannelMessageRequest?: Record<string, unknown>;
  channelMessageQueries?: Record<string, unknown>[];
  pendingChannelAiReplies?: Record<string, string>;
  failNextTaskCreate?: boolean;
  linkPreviewDelayMs?: number;
  approvals: MockApproval[];
  approvalPolicy: MockApprovalPolicy;
  lastApprovalPolicyPatch?: Record<string, unknown>;
  externalWorkActions: MockExternalWorkAction[];
  artifactsByExternalAction: Record<string, MockArtifact[]>;
  externalActionExecuteCalls: Record<string, number>;
  externalWorkCiTriage: MockExternalWorkCiTriageView[];
  ciTriageRunCalls: Record<string, number>;
  externalWorkStatus: Record<string, unknown>;
  externalWorkPollCalls: Record<string, number>;
  externalWorkReconcileCalls: number;
  externalWorkBackgroundStartCalls: number;
  externalWorkBackgroundStopCalls: number;
  externalWorkSecretConfigureCalls: number;
  externalWorkSecretDeleteCalls: number;
  lastExternalWorkSecretConfigure?: Record<string, unknown>;
  externalWorkWorkflowConfigureCalls: number;
  lastExternalWorkWorkflowConfigure?: Record<string, unknown>;
  mediaJobs: MockMediaJob[];
  workItems: MockWorkItem[];
  workUnits: MockWorkUnit[];
  workUnitActionDelayMs?: number;
  runtimeSemaphoreSlots: MockRuntimeSemaphoreSlot[];
  runtimeEventsByWorkUnit: Record<string, MockRuntimeEvent[]>;
  workUnitAttemptsByWorkUnit: Record<string, MockWorkUnitAttempt[]>;
  resourceLeases: unknown[];
  stateTransitions: unknown[];
  artifactsByRun: Record<string, MockArtifact[]>;
  artifactsByMediaJob: Record<string, MockArtifact[]>;
  threads: MockLingThread[];
  turns: MockLingTurn[];
  turnRunLinks: MockLingTurnRun[];
  failThreadTurnsForThreadIds: string[];
  executionActions: MockExecutionAction[];
}

export interface MockLingThread {
  id: string;
  workspaceId: string;
  kind: string;
  channelId?: string;
  taskId?: string;
  teammateId?: string;
  workflowId?: string;
  workflowStepId?: string;
  externalWorkId?: string;
  title: string;
  objective: string;
  status: string;
  activeRunId?: string;
  lastRunId?: string;
  parentThreadId?: string;
  parentTurnId?: string;
  forkedFromRunId?: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  archivedReason?: string;
}

export interface MockLingTurn {
  id: string;
  workspaceId: string;
  threadId: string;
  kind: string;
  status: string;
  title: string;
  userInstruction: string;
  channelId?: string;
  taskId?: string;
  teammateId?: string;
  workflowStepId?: string;
  externalWorkId?: string;
  automationId?: string;
  sourceMessageId?: string;
  sourceTurnId?: string;
  interventionId?: string;
  activeRunId?: string;
  lastRunId?: string;
  createdByActor: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MockLingTurnRun {
  turnId: string;
  runId: string;
  attemptNumber: number;
  role: string;
  createdAt: string;
}

export interface MockRun {
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
  threadId?: string;
  turnId?: string;
  workUnitId?: string;
  parentRunId?: string;
  interventionId?: string;
  continuationReason?: string;
  summaryPath?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
}

export interface MockExecutionAction {
  id: string;
  workspaceId: string;
  threadId?: string;
  runId?: string;
  workUnitId?: string;
  approvalId?: string;
  toolCallId?: string;
  actionType: string;
  risk: string;
  status: string;
  title: string;
  summary: string;
  targetRefs: Array<{ type: string; id?: string; label?: string; path?: string }>;
  previewArtifactIds: string[];
  resultArtifactIds: string[];
  policySnapshot?: unknown;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  executedAt?: string;
  failureReason?: string;
}

export interface MockRunIntervention {
  id: string;
  workspaceId: string;
  sourceRunId: string;
  sourceWorkUnitId?: string;
  sourceAttemptId?: string;
  continuationRunId?: string;
  continuationWorkUnitId?: string;
  mode: "queue_followup" | "interrupt_redirect";
  status: "queued" | "cancelling_source" | "starting_continuation" | "started" | "failed" | "cancelled";
  instruction: string;
  requestedBy: "local-user" | "system";
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface MockRunEvent {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}

export interface MockApproval {
  id: string;
  runId?: string;
  taskId?: string;
  mediaJobId?: string;
  externalWorkActionId?: string;
  channelId?: string;
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

export interface MockApprovalPolicy {
  workspaceId: string;
  toolDecisions: Record<string, string>;
  allowedWritePaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MockArtifact {
  id: string;
  runId?: string;
  mediaJobId?: string;
  externalWorkId?: string;
  type: string;
  path: string;
  title?: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt: string;
}

export interface MockExternalWorkAction {
  id: string;
  workspaceId: string;
  channelId: string;
  externalWorkId: string;
  sourceKind: string;
  actionKind: string;
  status: string;
  approvalId?: string;
  idempotencyKey: string;
  target: {
    sourceKind: string;
    repository: string;
    subjectKind: string;
    number: number;
    url?: string;
    expectedState: string;
    expectedHeadSha?: string;
    expectedUpdatedAt?: string;
    expectedLabels: string[];
  };
  payload:
    | { type: "github_comment"; body: string }
    | { type: "github_label"; labels: string[] }
    | { type: "github_pr_review"; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string };
  approvalRequirement: string;
  artifactIds: string[];
  executionAttemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
  executedAt?: string;
}

export interface MockExternalWorkCiTriageRecord {
  id: string;
  workspaceId: string;
  channelId: string;
  externalWorkId: string;
  sourceKind: string;
  repository: string;
  subjectKind: string;
  subjectNumber: number;
  headSha: string;
  failureKey: string;
  status: string;
  checkName: string;
  workflowName?: string;
  jobName?: string;
  conclusion: string;
  htmlUrl?: string;
  firstFailingCommand?: string;
  reproductionCommand?: string;
  suspectedSourcePath?: string;
  taskId?: string;
  runId?: string;
  artifactIds: string[];
  failure: Record<string, unknown>;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MockExternalWorkCiTriageView {
  triage: MockExternalWorkCiTriageRecord;
  externalWork?: Record<string, unknown>;
  task?: unknown;
  run?: MockRun;
  artifacts: MockArtifact[];
}

export interface MockMediaJob {
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

export interface MockWorkItem {
  id: string;
  workspaceId: string;
  channelId?: string;
  sourceType: string;
  sourceId: string;
  title: string;
  description?: string;
  status: string;
  waitingReason?: string;
  priority: string;
  labels: string[];
  assigneeTeammateId?: string;
  taskId?: string;
  runId?: string;
  workflowId?: string;
  workflowStepId?: string;
  externalWorkId?: string;
  externalWorkActionId?: string;
  approvalId?: string;
  artifactIds: string[];
  proofArtifactIds: string[];
  dependencyIds: string[];
  claim?: {
    ownerId: string;
    token: string;
    claimedAt: string;
    heartbeatAt: string;
    expiresAt: string;
  };
  attemptCount: number;
  retryBudget: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface MockManagedPlugin {
  id: string;
  displayName: string;
  version: string;
  sourceKind: string;
  status: string;
  description?: string;
  homepageUrl?: string;
  trustSummary: string;
  contributions: MockManagedPluginContribution[];
  requiredSecrets?: unknown[];
  defaultApprovals?: unknown[];
  health?: {
    pluginId: string;
    checkedAt: string;
    expiresAt: string;
    status: string;
    message?: string;
    details?: unknown;
  };
  linkedResources: Array<{
    kind: string;
    id: string;
    present: boolean;
    enabled?: boolean;
    displayName?: string;
  }>;
  package?: MockManagedPluginPackage;
  runtimePreview?: MockManagedPluginRuntimePreview;
  events?: MockManagedPluginEvent[];
  disabledReason?: string;
  actions: {
    canEnable: boolean;
    canDisable: boolean;
    canCheck: boolean;
    canApplyPreset: boolean;
    canInstall?: boolean;
    canUninstall?: boolean;
    canRefreshPackage?: boolean;
    canRuntimePreview?: boolean;
  };
}

export interface MockManagedPluginPackage {
  pluginId: string;
  sourceKind: string;
  version: string;
  status: string;
  cacheRef: string;
  packageHash?: string;
  installedAt: string;
  updatedAt: string;
  uninstalledAt?: string;
}

export interface MockManagedPluginRuntimePreview {
  pluginId: string;
  status: string;
  package?: MockManagedPluginPackage;
  mcpServers: Array<{
    kind: string;
    id: string;
    present: boolean;
    enabled?: boolean;
    displayName?: string;
  }>;
  skillPacks: unknown[];
  apps: unknown[];
  hooks: unknown[];
  policyOverlays: Array<{
    id: string;
    pluginId: string;
    contributionId: string;
    targetKind: string;
    targetId: string;
    defaultApproval: string;
    sideEffectLevel: string;
    reason: string;
  }>;
  blockers: string[];
}

export interface MockManagedPluginContribution {
  kind: string;
  id: string;
  label: string;
  capabilities: string[];
  sideEffectLevel?: string;
  defaultApproval?: string;
  linkedResourceId?: string;
  linkedResourcePresent?: boolean;
  enabled: boolean;
}

export interface MockManagedPluginEvent {
  id: string;
  pluginId: string;
  type: string;
  actor: string;
  message?: string;
  data?: unknown;
  createdAt: string;
}

export interface MockWorkUnit {
  id: string;
  workspaceId: string;
  kind: string;
  ownerType: string;
  ownerId: string;
  channelId?: string;
  taskId?: string;
  providerPresetId?: string;
  runnerId?: string;
  idempotencyKey: string;
  status: string;
  priority: number;
  attemptCount: number;
  activeAttemptId?: string;
  createdByActor: string;
  request: unknown;
  timeoutPolicy: Record<string, number>;
  linkedRunId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MockWorkUnitAttempt {
  id: string;
  workUnitId: string;
  attemptNumber: number;
  runtimeInstanceId: string;
  runnerId?: string;
  providerPresetId?: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
}

export interface MockRuntimeEvent {
  id: string;
  workUnitId: string;
  attemptId?: string;
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: unknown;
}

export interface MockRuntimeSemaphoreSlot {
  id: string;
  workspaceId: string;
  resourceType: string;
  resourceKey: string;
  ownerType: string;
  ownerId: string;
  workUnitId?: string;
  attemptId?: string;
  status: string;
  acquiredAt: string;
  lastRenewedAt: string;
  expiresAt: string;
}

export interface MockMcpServer {
  id: string;
  workspaceId: string;
  displayName: string;
  serverKey: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  secretNames: string[];
  secretRefs: Record<string, string>;
  enabled: boolean;
  status: "unknown" | "ready" | "failed" | "disabled";
  lastCheck?: {
    ok: boolean;
    message: string;
    checkedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MockMcpTool {
  id: string;
  serverId: string;
  name: string;
  rawName: string;
  displayName: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  callableNamespace: string;
  callableName: string;
  sideEffectLevel: string;
  defaultApproval: string;
  enabled: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface MockTeammateMcpBinding {
  teammateId: string;
  serverId: string;
  mode: "selected" | "all_current_tools";
  selectedToolNames: string[];
  approvalOverrides: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function readSidebarSelection(page: Page): Promise<{ readonly activeNav: string[]; readonly selectedRows: string[] }> {
  return await page.evaluate(() => {
    const navLabel = (element: Element): string => element.querySelector("span")?.textContent?.trim() ?? "";
    const rowLabel = (element: Element): string =>
      element.querySelector("span:not(.avatar-initial):not(.sidebar-hash):not(.channel-mention):not(.channel-unread)")?.textContent?.trim() ?? "";

    return {
      activeNav: [...document.querySelectorAll(".nav-item.active")].map(navLabel),
      selectedRows: [...document.querySelectorAll(".sidebar-row.selected")].map(rowLabel),
    };
  });
}

export async function openChannelTasksTab(page: Page): Promise<void> {
  await openChannelSidePanel(page, "Progress");
}

export async function openTaskFromAttentionQueue(page: Page, title: string): Promise<void> {
  const hideDetails = page.getByRole("button", { name: "Hide details" });
  if (await hideDetails.count() > 0 && await hideDetails.isVisible().catch(() => false)) {
    await hideDetails.click();
    await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  }
  await openChannelChatTools(page);
  const taskEvent = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: title }).first();
  await expect(taskEvent).toBeVisible();
  await taskEvent.getByRole("button", { name: "Open task" }).click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Task detail");
}

export async function openNewTaskPanel(page: Page): Promise<void> {
  await openChannelTasksTab(page);
  await page.locator(".channel-side-panel").hover();
  await page.getByRole("button", { name: "New task" }).click();
}

export async function openChannelFilesPanel(page: Page): Promise<void> {
  await openChannelSidePanel(page, "Files");
}

export async function openChannelContextPanel(page: Page): Promise<void> {
  await openChannelSidePanel(page, "Context");
}

export async function openChannelSidePanel(page: Page, name: "Progress" | "Files" | "Context" | "Settings"): Promise<void> {
  const expectedLabels = [name];
  const panel = page.locator(".channel-side-panel");
  const panelVisible = (await panel.count()) > 0 && await panel.isVisible().catch(() => false);
  const panelLabel = panelVisible ? await panel.getAttribute("aria-label") : "";
  if (panelVisible && panelLabel && expectedLabels.includes(panelLabel)) {
    await panel.hover();
    return;
  }
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name }).click();
  await expect(panel).toBeVisible();
  await panel.hover();
}

export const channelEventFiltersLabel = /Activity filters|Channel event filters|动态筛选|频道事件筛选/;
export const channelEventFilterToggleLabel = /Filter activity|Filter channel events|筛选动态|筛选频道事件/;

export function channelEventFilters(page: Page): Locator {
  return page.getByLabel(channelEventFiltersLabel);
}

export function channelEventFilterToggle(scope: Page | Locator): Locator {
  return scope.getByRole("button", { name: channelEventFilterToggleLabel });
}

export async function openChannelChatTools(page: Page): Promise<void> {
  const searchInput = page.getByPlaceholder(/Search activity|搜索动态/).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await searchInput.isVisible().catch(() => false)) {
      return;
    }
    await page.locator(".channel-more-button").click();
    await page.getByRole("menuitem", { name: channelEventFilterToggleLabel }).click();
    await page.waitForTimeout(50);
  }
  await expect(searchInput).toBeVisible();
}

export async function readScrollState(page: Page, selector: string): Promise<{ readonly atBottom: boolean; readonly top: number; readonly max: number }> {
  return await page.locator(selector).evaluate((element) => {
    const max = element.scrollHeight - element.clientHeight;
    return {
      atBottom: Math.abs(element.scrollTop - max) <= 2,
      top: element.scrollTop,
      max,
    };
  });
}

export async function readHorizontalOverflow(page: Page, selector: string): Promise<string[]> {
  return await page.evaluate((selectorText) =>
    [...document.querySelectorAll(selectorText)]
      .filter((element) => {
        const overflowX = getComputedStyle(element).overflowX;
        const canExposeHorizontalOverflow = overflowX === "auto" || overflowX === "scroll" || overflowX === "visible";
        return canExposeHorizontalOverflow && element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => {
        const className = typeof element.className === "string" ? element.className : "";
        return `${element.tagName.toLowerCase()}.${className.replace(/\\s+/g, ".")}`;
      }),
  selector);
}

export function createBaseState(options: { approvalStatus: "pending" | "expired" }): MockState {
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
    providerSecrets: {},
    managedPlugins: createMockManagedPlugins(),
    mcpServers: [],
    mcpTools: [],
    teammateMcpBindings: [],
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
    channelMessageQueries: [],
    channelExecutionProposals: [],
    channelAttachments: [],
    channelLinkPreviews: [],
    channelBriefs: {},
    channelDecisions: [],
    channelHandoffs: [],
    channelContextSummaries: [],
    channelWorkflows: [],
    channelWorkflowSteps: [],
    aiTeammates: [],
    skillRegistryEntries: buildMockSkillRegistryEntries(),
    skillImportDrafts: [],
    teammateChannelMemberships: [],
    teammateSkillBindings: [],
    teammateMemoryScopes: [],
    memoryObjects: [],
    usedMemoryEvents: [],
    teammateDirectThreads: {},
    teammateDirectMessages: [],
    teammatePrivateAttachments: [],
    retentionTombstones: [],
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
    runInterventions: [],
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
    externalWorkActions: [],
    artifactsByExternalAction: {},
    externalActionExecuteCalls: {},
    externalWorkCiTriage: [],
    ciTriageRunCalls: {},
    externalWorkStatus: createExternalWorkStatus(),
    externalWorkPollCalls: {},
    externalWorkReconcileCalls: 0,
    externalWorkBackgroundStartCalls: 0,
    externalWorkBackgroundStopCalls: 0,
    externalWorkSecretConfigureCalls: 0,
    externalWorkSecretDeleteCalls: 0,
    externalWorkWorkflowConfigureCalls: 0,
    mediaJobs: [],
    workItems: [],
    workUnits: [],
    runtimeSemaphoreSlots: [],
    runtimeEventsByWorkUnit: {},
    workUnitAttemptsByWorkUnit: {},
    resourceLeases: [],
    stateTransitions: [],
    artifactsByRun: {},
    artifactsByMediaJob: {},
    threads: [],
    turns: [],
    turnRunLinks: [],
    failThreadTurnsForThreadIds: [],
    executionActions: [],
  };
}

export function filterOptionalSearchParam(url: URL, key: string, value: string | undefined): boolean {
  const expected = url.searchParams.get(key);
  return !expected || value === expected;
}

export function deriveMockThreadFromRuns(state: MockState, threadId: string): MockLingThread | undefined {
  const threadRuns = state.runs.filter((run) => run.threadId === threadId);
  if (threadRuns.length === 0) {
    return undefined;
  }
  const orderedRuns = [...threadRuns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const latestRun = orderedRuns[0];
  const oldestRun = [...threadRuns].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  return {
    id: threadId,
    workspaceId: "workspace_default",
    kind: "task",
    channelId: latestRun.channelId,
    taskId: latestRun.taskId,
    title: readMockTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
    objective: readMockTaskPrompt(latestRun.taskSnapshot) || readMockTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
    status: isMockRunActive(latestRun) ? latestRun.status : latestRun.status === "succeeded" ? "succeeded" : latestRun.status === "cancelled" ? "cancelled" : "failed",
    activeRunId: isMockRunActive(latestRun) ? latestRun.id : undefined,
    lastRunId: latestRun.id,
    createdAt: oldestRun.createdAt,
    updatedAt: latestRun.updatedAt,
  };
}

export function buildMockThreadEvidence(state: MockState, thread: MockLingThread) {
  const linkedRunIds = new Set([thread.activeRunId, thread.lastRunId].filter((value): value is string => Boolean(value)));
  const threadRuns = state.runs
    .filter((run) => run.threadId === thread.id || linkedRunIds.has(run.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const runIds = new Set(threadRuns.map((run) => run.id));
  const actionIds = new Set<string>();
  const actions = state.executionActions.filter((action) => {
    const linked = action.threadId === thread.id || Boolean(action.runId && runIds.has(action.runId));
    if (linked) {
      actionIds.add(action.id);
    }
    return linked;
  });
  return {
    cwd,
    thread,
    generatedAt: "2026-05-25T00:39:00.000Z",
    runs: threadRuns.map((run) => ({
      run,
      events: state.eventsByRun[run.id] ?? [],
      approvals: state.approvals.filter((approval) => approval.runId === run.id),
      artifacts: state.artifactsByRun[run.id] ?? [],
      runtimeEvents: run.workUnitId ? state.runtimeEventsByWorkUnit[run.workUnitId] ?? [] : [],
    })),
    actions,
    transitions: state.stateTransitions.filter((transition) =>
      isRecord(transition) &&
      (
        transition.entityId === thread.id ||
        (typeof transition.entityId === "string" && runIds.has(transition.entityId)) ||
        (thread.workflowStepId !== undefined && transition.entityId === thread.workflowStepId) ||
        (typeof transition.entityId === "string" && actionIds.has(transition.entityId))
      )
    ),
  };
}

export function buildMockResumeContext(
  state: MockState,
  thread: MockLingThread,
  sourceTurn: MockLingTurn | undefined,
  sourceRun: MockRun,
  body: Record<string, unknown>,
  hasActiveRun: boolean,
  hasActiveTurn = false,
) {
  const evidence = buildMockThreadEvidence(state, thread);
  const scopedEvidenceRuns = sourceTurn ? evidence.runs.filter((item) => isMockRunInTurn(state, sourceTurn, item.run)) : evidence.runs;
  const includeArtifacts = body.includeArtifacts === true;
  const artifacts = includeArtifacts ? scopedEvidenceRuns.flatMap((item) => item.artifacts) : [];
  const instruction = typeof body.instruction === "string" && body.instruction.trim()
    ? body.instruction.trim()
    : "Resume this Ling thread from durable evidence.";
  const pendingActionIds = evidence.actions
    .filter((action) => action.status === "proposed" || action.status === "waiting_for_approval" || action.status === "executing")
    .map((action) => action.id);
  const warnings = [
    ...(hasActiveRun ? [`Thread already has an active run: ${thread.activeRunId}`] : []),
    ...(hasActiveTurn && sourceTurn ? [`Selected turn is not terminal: ${sourceTurn.id}`] : []),
  ];
  const priorTurnIds = sourceTurn ? resolveMockPriorTurns(state, thread, sourceTurn).map((turn) => turn.id) : undefined;
  return {
    title: `Resume: ${thread.title}`,
    instruction,
    sourceRunId: sourceRun.id,
    sourceTurnId: sourceTurn?.id,
    priorRunIds: scopedEvidenceRuns.map((item) => item.run.id),
    priorTurnIds,
    includedTurnCount: priorTurnIds?.length,
    includedEventCount: scopedEvidenceRuns.reduce((count, item) => count + item.events.length, 0),
    includedApprovalCount: scopedEvidenceRuns.reduce((count, item) => count + item.approvals.length, 0),
    includedArtifactIds: artifacts.map((artifact) => artifact.id),
    pendingActionIds,
    redactionNotes: includeArtifacts && artifacts.length > 0 ? ["Artifact contents are omitted; preview includes artifact ids only."] : [],
    warnings,
    contextText: [
      `Thread: ${thread.title}`,
      `Objective: ${thread.objective}`,
      sourceTurn ? `Source turn: ${sourceTurn.id}` : undefined,
      `Source run: ${sourceRun.id}`,
      `Instruction: ${instruction}`,
      priorTurnIds ? `Prior turns: ${priorTurnIds.join(", ") || "none"}` : undefined,
      `Prior runs: ${scopedEvidenceRuns.map((item) => item.run.id).join(", ") || "none"}`,
      `Artifacts: ${artifacts.map((artifact) => artifact.id).join(", ") || "none"}`,
      `Pending actions: ${pendingActionIds.join(", ") || "none"}`,
    ].filter((line): line is string => Boolean(line)).join("\n"),
  };
}

function resolveMockResumeAnchor(
  state: MockState,
  thread: MockLingThread,
  body: Record<string, unknown>,
): { sourceTurn?: MockLingTurn; sourceRun: MockRun } | { status: number; error: string; message: string } {
  const turnId = typeof body.turnId === "string" ? body.turnId : undefined;
  const requestedRunId = typeof body.sourceRunId === "string" ? body.sourceRunId : undefined;
  if (!turnId) {
    const sourceRunId = requestedRunId ?? thread.lastRunId;
    const sourceRun = sourceRunId ? state.runs.find((run) => run.id === sourceRunId) : undefined;
    if (!sourceRun) {
      return { status: 404, error: "source_run_not_found", message: `Thread source run was not found: ${sourceRunId ?? "-"}` };
    }
    if (sourceRun.threadId !== thread.id) {
      return { status: 400, error: "source_run_not_in_thread", message: `Source run does not belong to thread: ${sourceRun.id}` };
    }
    return { sourceRun };
  }

  const sourceTurn = state.turns.find((turn) => turn.id === turnId);
  if (!sourceTurn) {
    return { status: 404, error: "turn_not_found", message: `Ling turn not found: ${turnId}` };
  }
  if (sourceTurn.threadId !== thread.id) {
    return { status: 400, error: "turn_not_in_thread", message: `Ling turn does not belong to thread: ${turnId}` };
  }

  const sourceRun = requestedRunId
    ? state.runs.find((run) => run.id === requestedRunId)
    : resolveMockSourceRunFromTurn(state, sourceTurn);
  if (!sourceRun) {
    return { status: 404, error: "source_run_not_found", message: `Ling turn has no source run to resume: ${sourceTurn.id}` };
  }
  if (sourceRun.threadId !== thread.id) {
    return { status: 400, error: "source_run_not_in_thread", message: `Source run does not belong to thread: ${sourceRun.id}` };
  }
  if (!isMockRunInTurn(state, sourceTurn, sourceRun)) {
    return { status: 400, error: "source_run_not_in_turn", message: `Source run does not belong to turn: ${sourceRun.id}` };
  }
  return { sourceTurn, sourceRun };
}

function resolveMockSourceRunFromTurn(state: MockState, turn: MockLingTurn): MockRun | undefined {
  const candidateIds = [
    turn.lastRunId,
    ...state.turnRunLinks
      .filter((link) => link.turnId === turn.id)
      .sort((left, right) => right.attemptNumber - left.attemptNumber || right.createdAt.localeCompare(left.createdAt))
      .map((link) => link.runId),
  ].filter((runId): runId is string => Boolean(runId));
  for (const runId of candidateIds) {
    const run = state.runs.find((item) => item.id === runId);
    if (run && isMockRunInTurn(state, turn, run)) {
      return run;
    }
  }
  return undefined;
}

function findMockTurnForRun(state: MockState, runId: string): MockLingTurn | undefined {
  const linkedTurnId = state.turnRunLinks.find((link) => link.runId === runId)?.turnId;
  return state.turns.find((turn) => turn.id === linkedTurnId || turn.activeRunId === runId || turn.lastRunId === runId);
}

function resolveMockPriorTurns(state: MockState, thread: MockLingThread, sourceTurn: MockLingTurn): MockLingTurn[] {
  const turns = state.turns
    .filter((turn) => turn.threadId === thread.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const index = turns.findIndex((turn) => turn.id === sourceTurn.id);
  return index >= 0 ? turns.slice(0, index + 1) : [sourceTurn];
}

function isMockRunInTurn(state: MockState, turn: MockLingTurn, run: MockRun): boolean {
  return run.turnId === turn.id ||
    run.id === turn.activeRunId ||
    run.id === turn.lastRunId ||
    state.turnRunLinks.some((link) => link.turnId === turn.id && link.runId === run.id);
}

function isMockTurnActiveForResume(state: MockState, turn: MockLingTurn): boolean {
  const activeRun = turn.activeRunId ? state.runs.find((run) => run.id === turn.activeRunId) : undefined;
  if (activeRun && isMockRunActive(activeRun)) {
    return true;
  }
  return turn.status === "open" || turn.status === "running" || turn.status === "waiting_for_approval" || turn.status === "blocked";
}

function resolveMockForkAnchor(
  state: MockState,
  thread: MockLingThread,
  body: Record<string, unknown>,
): { sourceTurn?: MockLingTurn; sourceRun?: MockRun } | { status: number; error: string; message: string } {
  if (thread.status === "archived" || thread.archivedAt) {
    return { status: 409, error: "source_thread_archived", message: `Cannot fork archived thread: ${thread.id}` };
  }
  const turnId = typeof body.turnId === "string" ? body.turnId : undefined;
  const requestedRunId = typeof body.sourceRunId === "string" ? body.sourceRunId : undefined;
  if (turnId) {
    const sourceTurn = state.turns.find((turn) => turn.id === turnId);
    if (!sourceTurn) {
      return { status: 404, error: "turn_not_found", message: `Ling turn not found: ${turnId}` };
    }
    if (sourceTurn.threadId !== thread.id) {
      return { status: 400, error: "turn_not_in_thread", message: `Ling turn does not belong to thread: ${turnId}` };
    }
    if (!isMockTurnTerminalForFork(state, sourceTurn)) {
      return { status: 409, error: "turn_active", message: `Selected turn is not terminal: ${sourceTurn.id}` };
    }
    const sourceRun = requestedRunId
      ? state.runs.find((run) => run.id === requestedRunId)
      : resolveMockSourceRunFromTurn(state, sourceTurn);
    if (requestedRunId && !sourceRun) {
      return { status: 404, error: "source_run_not_found", message: `Source run was not found: ${requestedRunId}` };
    }
    if (sourceRun && sourceRun.threadId !== thread.id) {
      return { status: 400, error: "source_run_not_in_thread", message: `Source run does not belong to thread: ${sourceRun.id}` };
    }
    if (sourceRun && !isMockRunInTurn(state, sourceTurn, sourceRun)) {
      return { status: 400, error: "source_run_not_in_turn", message: `Source run does not belong to turn: ${sourceRun.id}` };
    }
    return { sourceTurn, sourceRun };
  }
  if (requestedRunId) {
    const sourceRun = state.runs.find((run) => run.id === requestedRunId);
    if (!sourceRun) {
      return { status: 404, error: "source_run_not_found", message: `Source run was not found: ${requestedRunId}` };
    }
    if (sourceRun.threadId !== thread.id) {
      return { status: 400, error: "source_run_not_in_thread", message: `Source run does not belong to thread: ${sourceRun.id}` };
    }
    const sourceTurn = findMockTurnForRun(state, sourceRun.id);
    return sourceTurn && isMockTurnTerminalForFork(state, sourceTurn) ? { sourceTurn, sourceRun } : { sourceRun };
  }
  const sourceTurn = resolveLatestMockTerminalTurn(state, thread.id);
  return {
    sourceTurn,
    sourceRun: sourceTurn ? resolveMockSourceRunFromTurn(state, sourceTurn) : undefined,
  };
}

function isMockTurnTerminalForFork(state: MockState, turn: MockLingTurn): boolean {
  const activeRun = turn.activeRunId ? state.runs.find((run) => run.id === turn.activeRunId) : undefined;
  if (activeRun && isMockRunActive(activeRun)) {
    return false;
  }
  return turn.status === "succeeded" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "superseded";
}

function resolveLatestMockTerminalTurn(state: MockState, threadId: string): MockLingTurn | undefined {
  return [...state.turns]
    .filter((turn) => turn.threadId === threadId && isMockTurnTerminalForFork(state, turn))
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      (right.completedAt ?? "").localeCompare(left.completedAt ?? "") ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id))
    [0];
}

function deterministicMockForkThreadId(threadId: string, sourceTurnId: string | undefined, sourceRunId: string | undefined, idempotencyKey: string): string {
  return `thread_fork_${sanitizeMockId([threadId, sourceTurnId, sourceRunId, idempotencyKey].filter(Boolean).join("_")).slice(0, 64)}`;
}

function deterministicMockForkRunTurnId(operationKey: string): string {
  return `turn_fork_run_${sanitizeMockId(operationKey).slice(0, 64)}`;
}

function deterministicMockForkRunRunId(operationKey: string): string {
  return `run_fork_run_${sanitizeMockId(operationKey).slice(0, 64)}`;
}

function titleFromMockInstruction(instruction: string, fallback: string): string {
  const firstLine = instruction.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return fallback;
  }
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
}

function sanitizeMockId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_");
}

type MockArchivedFilter = "exclude" | "include" | "only";

function readMockArchivedFilter(url: URL): { value?: MockArchivedFilter } | { error: string; message: string } {
  const value = url.searchParams.get("archived");
  if (value === null) {
    return {};
  }
  if (value !== "exclude" && value !== "include" && value !== "only") {
    return { error: "bad_archived_filter", message: "archived must be one of: exclude, include, only" };
  }
  return { value };
}

function readMockThreadSearchQuery(url: URL): { value?: string } | { error: string; message: string } {
  const value = url.searchParams.get("q");
  if (value === null) {
    return {};
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2) {
    return { error: "search_query_too_short", message: "q must include at least two visible characters" };
  }
  if (normalized.length > 128) {
    return { error: "search_query_too_long", message: "q must be at most 128 characters" };
  }
  return { value: normalized };
}

function searchMockLingThreads(
  state: MockState,
  threads: readonly MockLingThread[],
  query: string,
): { threads: MockLingThread[]; matches: Array<{ threadId: string; turnId?: string; runId?: string; field: string; snippet: string }> } {
  const normalized = query.toLowerCase();
  const matchesByThreadId = new Map<string, Array<{ threadId: string; turnId?: string; runId?: string; field: string; snippet: string }>>();
  for (const thread of threads) {
    addMockThreadSearchMatch(matchesByThreadId, thread.id, "thread_title", thread.title, normalized);
    addMockThreadSearchMatch(matchesByThreadId, thread.id, "thread_objective", thread.objective, normalized);
    addMockThreadSearchMatch(matchesByThreadId, thread.id, "task_id", thread.taskId, normalized);
  }
  const threadIds = new Set(threads.map((thread) => thread.id));
  for (const turn of state.turns.filter((item) => threadIds.has(item.threadId))) {
    addMockThreadSearchMatch(matchesByThreadId, turn.threadId, "turn_title", turn.title, normalized, { turnId: turn.id });
    addMockThreadSearchMatch(matchesByThreadId, turn.threadId, "turn_instruction", turn.userInstruction, normalized, { turnId: turn.id });
    addMockThreadSearchMatch(matchesByThreadId, turn.threadId, "task_id", turn.taskId, normalized, { turnId: turn.id });
  }
  for (const run of state.runs.filter((item) => item.threadId && threadIds.has(item.threadId))) {
    const threadId = run.threadId;
    if (!threadId) {
      continue;
    }
    addMockThreadSearchMatch(matchesByThreadId, threadId, "task_id", run.taskId, normalized, { runId: run.id });
    addMockThreadSearchMatch(matchesByThreadId, threadId, "task_title", readMockTaskTitle(run.taskSnapshot), normalized, { runId: run.id });
    addMockThreadSearchMatch(matchesByThreadId, threadId, "task_prompt", readMockTaskPrompt(run.taskSnapshot), normalized, { runId: run.id });
  }
  const rankedThreads = threads
    .filter((thread) => (matchesByThreadId.get(thread.id)?.length ?? 0) > 0)
    .sort((left, right) =>
      bestMockThreadSearchRank(left, matchesByThreadId.get(left.id) ?? [], normalized) -
      bestMockThreadSearchRank(right, matchesByThreadId.get(right.id) ?? [], normalized) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id)
    );
  return {
    threads: rankedThreads,
    matches: rankedThreads.flatMap((thread) => (matchesByThreadId.get(thread.id) ?? []).slice(0, 5)),
  };
}

function addMockThreadSearchMatch(
  matchesByThreadId: Map<string, Array<{ threadId: string; turnId?: string; runId?: string; field: string; snippet: string }>>,
  threadId: string,
  field: string,
  value: string | undefined,
  query: string,
  refs: { turnId?: string; runId?: string } = {},
): void {
  if (!value || !value.trim().replace(/\s+/g, " ").toLowerCase().includes(query)) {
    return;
  }
  const current = matchesByThreadId.get(threadId) ?? [];
  if (current.some((match) => match.field === field && match.turnId === refs.turnId && match.runId === refs.runId)) {
    return;
  }
  matchesByThreadId.set(threadId, [
    ...current,
    {
      threadId,
      ...refs,
      field,
      snippet: redactMockSearchSnippet(value),
    },
  ]);
}

function bestMockThreadSearchRank(
  thread: MockLingThread,
  matches: readonly { field: string }[],
  query: string,
): number {
  const archivedPenalty = isMockThreadArchived(thread) ? 100 : 0;
  const pinnedBonus = thread.pinnedAt ? -5 : 0;
  return Math.min(...matches.map((match) => archivedPenalty + pinnedBonus + mockSearchFieldRank(thread, match.field, query)));
}

function mockSearchFieldRank(thread: MockLingThread, field: string, query: string): number {
  const title = thread.title.trim().replace(/\s+/g, " ").toLowerCase();
  if (field === "thread_title" && title === query) {
    return 0;
  }
  if (field === "thread_title" && title.startsWith(query)) {
    return 10;
  }
  if (field === "thread_title" || field === "thread_objective") {
    return 20;
  }
  if (field === "task_id" || field === "task_title" || field === "task_prompt") {
    return 40;
  }
  return 50;
}

function redactMockSearchSnippet(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 160);
}

function matchesMockArchivedFilter(thread: MockLingThread, filter: MockArchivedFilter): boolean {
  if (filter === "include") {
    return true;
  }
  const archived = isMockThreadArchived(thread);
  return filter === "only" ? archived : !archived;
}

function isMockThreadArchived(thread: MockLingThread): boolean {
  return thread.status === "archived" || Boolean(thread.archivedAt);
}

function mutateMockThreadVisibility(
  state: MockState,
  thread: MockLingThread,
  action: string,
  body: Record<string, unknown>,
): { thread: MockLingThread } | { status: number; error: string; message: string } {
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : undefined;
  const now = "2026-05-25T03:00:00.000Z";
  if (action === "archive") {
    if (isMockThreadArchived(thread)) {
      if (idempotencyKey) {
        return { thread };
      }
      return { status: 409, error: "thread_already_archived", message: `Ling thread is already archived: ${thread.id}` };
    }
    const archiveBlock = getMockThreadArchiveBlocker(state, thread);
    if (archiveBlock) {
      return { status: 409, error: "active_thread_archive_blocked", message: archiveBlock };
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined;
    return { thread: upsertMockThread(state, { ...thread, archivedAt: now, archivedReason: reason, updatedAt: now }) };
  }
  if (action === "unarchive") {
    if (!isMockThreadArchived(thread)) {
      if (idempotencyKey) {
        return { thread };
      }
      return { status: 409, error: "thread_not_archived", message: `Ling thread is not archived: ${thread.id}` };
    }
    return {
      thread: upsertMockThread(state, {
        ...thread,
        archivedAt: undefined,
        archivedReason: undefined,
        status: thread.status === "archived" ? "open" : thread.status,
        updatedAt: now,
      }),
    };
  }
  if (action === "pin") {
    if (thread.pinnedAt) {
      if (idempotencyKey) {
        return { thread };
      }
      return { status: 409, error: "thread_already_pinned", message: `Ling thread is already pinned: ${thread.id}` };
    }
    return { thread: upsertMockThread(state, { ...thread, pinnedAt: now, updatedAt: now }) };
  }
  if (!thread.pinnedAt) {
    if (idempotencyKey) {
      return { thread };
    }
    return { status: 409, error: "thread_not_pinned", message: `Ling thread is not pinned: ${thread.id}` };
  }
  return { thread: upsertMockThread(state, { ...thread, pinnedAt: undefined, updatedAt: now }) };
}

function getMockThreadArchiveBlocker(state: MockState, thread: MockLingThread): string | undefined {
  if (thread.activeRunId) {
    const activeRun = state.runs.find((run) => run.id === thread.activeRunId);
    if (!activeRun || isMockRunActive(activeRun)) {
      return `Cannot archive thread with active work: ${thread.id}`;
    }
  }
  const activeTurn = state.turns.find((turn) => turn.threadId === thread.id && isMockTurnActiveForResume(state, turn));
  return activeTurn ? `Cannot archive thread with active turn: ${activeTurn.id}` : undefined;
}

function upsertMockThread(state: MockState, thread: MockLingThread): MockLingThread {
  const index = state.threads.findIndex((item) => item.id === thread.id);
  if (index >= 0) {
    state.threads[index] = thread;
  } else {
    state.threads.unshift(thread);
  }
  return thread;
}

export function isMockRunActive(run: MockRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

export function readMockTaskTitle(snapshot: unknown): string {
  return isRecord(snapshot) && typeof snapshot.title === "string" ? snapshot.title : "";
}

export function readMockTaskPrompt(snapshot: unknown): string {
  return isRecord(snapshot) && typeof snapshot.prompt === "string" ? snapshot.prompt : "";
}

export function buildMockSkillRegistryEntries(): unknown[] {
  const timestamp = new Date(0).toISOString();
  return gstackDefaultSkillPack.skills.map((definition) => ({
    id: definition.id,
    workspaceId: "workspace_default",
    packId: gstackDefaultSkillPack.id,
    source: "builtin",
    version: "builtin",
    definition,
    visibility: {
      workspaceVisible: true,
      promotableToWorkspace: false,
    },
    reviewStatus: "builtin",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

export function buildMockEffectiveSkills(state: MockState, teammateId: string): unknown[] {
  const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
  if (!isRecord(teammate)) {
    return [];
  }
  const bindings = state.teammateSkillBindings.filter((item) => isRecord(item) && item.teammateId === teammateId);
  const definitions = state.skillRegistryEntries
    .filter((item) =>
      isRecord(item) &&
      (item.reviewStatus === "builtin" || item.reviewStatus === "published") &&
      isRecord(item.definition)
    )
    .map((item) => item.definition);
  return buildEffectiveTeammateSkills({
    teammate: teammate as never,
    bindings: bindings as never,
    skills: definitions as never,
  });
}

export function createMockSkillImportDraft(state: MockState, body: Record<string, unknown>): Record<string, unknown> {
  const content = typeof body.content === "string" ? body.content : "";
  const skillId = content.match(/^id:\s*([a-z0-9-]+)/im)?.[1] ?? `custom-skill-${state.skillImportDrafts.length + 1}`;
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const summary = content.match(/^summary:\s*(.+)$/im)?.[1]?.trim() ?? "Imported workspace skill.";
  const warnings = /approval|secret|external/i.test(content)
    ? [
      {
        code: "permission_like_instruction",
        severity: "warning",
        message: "Permission-like instructions were kept as prompt text only.",
      },
    ]
    : [];
  return {
    id: `skill_draft_${state.skillImportDrafts.length + 1}`,
    workspaceId: "workspace_default",
    source: typeof body.source === "string" ? body.source : "custom",
    sourcePath: typeof body.sourcePath === "string" ? body.sourcePath : undefined,
    packId: `skill_pack_${state.skillImportDrafts.length + 1}`,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : heading ?? "Imported skill pack",
    version: "0.1.0",
    description: summary,
    definitions: [
      {
        definition: {
          id: skillId,
          name: heading ?? skillId,
          summary,
          roleAffinity: ["qa"],
          workflowPhase: "test",
          promptFragments: [content],
          requiredTools: ["read", "grep"],
          requiredProviderCapabilities: ["chat"],
          approvalProfile: { mode: "none" },
          stateEffects: ["creates_artifact"],
        },
        visibility: {
          workspaceVisible: true,
          promotableToWorkspace: true,
        },
        warnings,
      },
    ],
    warnings: [],
    createdAt: "2026-06-04T00:20:00.000Z",
    updatedAt: "2026-06-04T00:20:00.000Z",
  };
}

export function createMockPersonaDraft(teammateId: string, body: Record<string, unknown>): Record<string, unknown> {
  const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : "";
  const content = typeof body.content === "string" ? body.content : "";
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Imported teammate persona";
  const description = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !/^id:/i.test(line)) ?? "";
  const sourceKind = /agents?\.md$/i.test(sourcePath)
    ? "agents-md"
    : /persona\.md$/i.test(sourcePath)
      ? "persona-md"
      : "markdown";
  return {
    teammateId,
    sourceKind,
    sourcePath: sourcePath || undefined,
    displayName: heading,
    description,
    systemPrompt: content,
    appendSystemPrompt: [],
    warnings: /tool|approval|secret|external/i.test(content)
      ? ["Permission-like persona text was ignored for authority changes."]
      : [],
  };
}

export function createExternalWorkStatus(overrides: {
  readonly sourceKind?: "github" | "linear" | "unknown";
  readonly workflowExists?: boolean;
  readonly workflowValid?: boolean;
  readonly workflowError?: string;
  readonly secretRef?: string;
  readonly secretStatus?: string;
  readonly backgroundStatus?: string;
} = {}): Record<string, unknown> {
  const sourceKind = overrides.sourceKind ?? "github";
  const workflowExists = overrides.workflowExists ?? true;
  const workflowValid = overrides.workflowValid ?? true;
  const backgroundStatus = overrides.backgroundStatus ?? "not_configured";
  const secretRef = overrides.secretRef ?? (sourceKind === "github" ? "env:GITHUB_TOKEN" : "env:LINEAR_TOKEN");
  return {
    cwd,
    channel: {
      id: "channel_engineering",
      name: "Engineering",
      boundPath: cwd,
    },
    workflow: {
      path: `${cwd}/WORKFLOW.md`,
      exists: workflowExists,
      valid: workflowValid,
      ...(overrides.workflowError ? { error: overrides.workflowError } : {}),
      sourceKind,
      ...(sourceKind === "github" ? { repository: "openclaw/openclaw" } : {}),
      ...(sourceKind === "linear" ? { projectSlug: "ling-stack" } : {}),
      events: sourceKind === "linear" ? ["issue.created"] : sourceKind === "github" ? ["pull_request.opened", "issue.opened"] : [],
      ...(sourceKind === "unknown" ? {} : { secretRef }),
    },
    secret: sourceKind === "unknown"
      ? { status: "not_required" }
      : {
          ref: secretRef,
          purpose: sourceKind === "github" ? "github_token" : "linear_token",
          status: overrides.secretStatus ?? "configured",
          ...(overrides.secretStatus === "missing" ? { message: `Secret is not configured: ${secretRef}` } : {}),
        },
    records: {
      externalWork: { total: 2, ready: 1, blocked: 1, retryWait: 0, terminal: 0 },
      ciTriage: { total: 1, triaged: 0, taskCreated: 1, runRequested: 0, blocked: 0, stale: 0, failed: 0 },
      actions: { total: 1, waitingForApproval: 1, approved: 0, failed: 0, succeeded: 0, cancelled: 0, staleTarget: 0 },
    },
    background: sourceKind === "linear"
      ? { supported: false, running: false, status: "unsupported" }
      : {
          supported: sourceKind === "github",
          running: backgroundStatus === "running",
          ...(backgroundStatus === "running" || backgroundStatus === "stopped" ? { schedulerId: "external_work_background_1" } : {}),
          status: backgroundStatus,
          ...(backgroundStatus === "running" ? { lastTickAt: "2026-06-01T00:00:00.000Z", nextPollAt: "2026-06-01T00:00:30.000Z" } : {}),
        },
    lastErrors: {},
  };
}

export function createMockRuntime() {
  return {
    workspaceId: "workspace_default",
    runtimeInstanceId: "runtime_e2e_shared",
    pid: 17891,
    host: "127.0.0.1",
    port: 17891,
    startedAt: "2026-05-25T00:00:00.000Z",
    version: "0.0.0",
    schemaVersion: 22,
    status: "healthy",
  };
}

export function createMockWorkUnitDetail(state: MockState, workUnit: MockWorkUnit) {
  return {
    cwd,
    workUnit,
    attempts: state.workUnitAttemptsByWorkUnit[workUnit.id] ?? [],
    events: state.runtimeEventsByWorkUnit[workUnit.id] ?? [],
    leases: state.resourceLeases.filter((lease) => isRecord(lease) && lease.workUnitId === workUnit.id),
    semaphoreSlots: state.runtimeSemaphoreSlots.filter((slot) => slot.workUnitId === workUnit.id),
    run: workUnit.linkedRunId ? state.runs.find((run) => run.id === workUnit.linkedRunId) : undefined,
  };
}

export function isActiveMockWorkUnit(status: string): boolean {
  return status === "claimed" || status === "running" || status === "waiting_for_approval" || status === "cancelling";
}

export function safePostDataJson(request: Request): Record<string, unknown> {
  try {
    const value = request.postDataJSON();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function addExternalActionApproval(
  state: MockState,
  options: {
    readonly actionId?: string;
    readonly approvalId?: string;
    readonly status?: string;
    readonly approvalStatus?: string;
    readonly kind?: "github_comment" | "github_label" | "github_pr_review";
    readonly reviewEvent?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    readonly lastErrorCode?: string;
    readonly lastErrorMessage?: string;
  } = {},
): { readonly action: MockExternalWorkAction; readonly approval: MockApproval } {
  const actionId = options.actionId ?? `external_work_action_${state.externalWorkActions.length + 1}`;
  const approvalId = options.approvalId ?? `approval_${actionId}`;
  const kind = options.kind ?? "github_comment";
  const actionStatus = options.status ?? "waiting_for_approval";
  const approvalStatus = options.approvalStatus ?? (actionStatus === "waiting_for_approval" ? "pending" : actionStatus === "approved" || actionStatus === "succeeded" || actionStatus === "stale_target" ? "approved" : "denied");
  const artifact: MockArtifact = {
    id: `artifact_${actionId}_preview`,
    externalWorkId: "external_work_pr_42",
    type: "markdown",
    path: `external-work/external_work_pr_42/actions/${actionId}/approval-preview.md`,
    title: "Approval preview",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 128,
    createdAt: "2026-05-26T00:01:00.000Z",
  };
  const action: MockExternalWorkAction = {
    id: actionId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    externalWorkId: "external_work_pr_42",
    sourceKind: "github",
    actionKind: kind,
    status: actionStatus,
    approvalId,
    idempotencyKey: `github:${actionId}`,
    target: {
      sourceKind: "github",
      repository: "tianxiaochannel-oss88/ling-stack",
      subjectKind: "github_pull_request",
      number: 42,
      url: "https://github.com/tianxiaochannel-oss88/ling-stack/pull/42",
      expectedState: "open",
      expectedHeadSha: "abcdef1234567890",
      expectedUpdatedAt: "2026-05-26T00:00:00.000Z",
      expectedLabels: ["needs-review"],
    },
    payload: kind === "github_comment"
      ? { type: "github_comment", body: "Looks good from Ling." }
      : kind === "github_label"
        ? { type: "github_label", labels: ["agent-ready", "needs-review"] }
        : { type: "github_pr_review", event: options.reviewEvent ?? "REQUEST_CHANGES", body: "Please fix the failing CI before merge." },
    approvalRequirement: kind === "github_pr_review" ? "strict" : "standard",
    artifactIds: [artifact.id],
    executionAttemptCount: actionStatus === "stale_target" ? 1 : 0,
    lastAttemptAt: actionStatus === "stale_target" ? "2026-05-26T00:02:00.000Z" : undefined,
    lastErrorCode: options.lastErrorCode ?? (actionStatus === "stale_target" ? "stale_target" : undefined),
    lastErrorMessage: options.lastErrorMessage ?? (actionStatus === "stale_target" ? "PR head SHA changed before execution." : undefined),
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:01:00.000Z",
    executedAt: actionStatus === "succeeded" ? "2026-05-26T00:03:00.000Z" : undefined,
  };
  const approval: MockApproval = {
    id: approvalId,
    externalWorkActionId: action.id,
    channelId: action.channelId,
    actionType: "external_send",
    risk: kind === "github_pr_review" ? "high" : "medium",
    title: kind === "github_pr_review" ? "Approve GitHub PR review" : "Approve GitHub comment",
    description: kind === "github_pr_review" ? "Submit a GitHub PR review after approval." : "Post a GitHub comment after approval.",
    payload: {
      type: "external_action",
      sourceKind: "github",
      actionKind: action.actionKind,
      target: action.target,
      preview: action.payload.type === "github_comment"
        ? action.payload.body
        : action.payload.type === "github_label"
          ? action.payload.labels.join(", ")
          : `${action.payload.event}: ${action.payload.body}`,
    },
    status: approvalStatus,
    createdAt: "2026-05-26T00:00:00.000Z",
    expiresAt: approvalStatus === "pending" ? "2099-01-01T00:01:00.000Z" : undefined,
    resolvedAt: approvalStatus === "pending" ? undefined : "2026-05-26T00:01:30.000Z",
    resolvedBy: approvalStatus === "pending" ? undefined : "local-user",
  };
  state.externalWorkActions.unshift(action);
  state.artifactsByExternalAction[action.id] = [artifact];
  state.approvals.unshift(approval);
  return { action, approval };
}

export function addExternalWorkCiTriage(
  state: MockState,
  options: {
    readonly id?: string;
    readonly status?: string;
    readonly taskId?: string;
    readonly runId?: string;
    readonly checkName?: string;
    readonly firstFailingCommand?: string;
    readonly reproductionCommand?: string;
    readonly suspectedSourcePath?: string;
    readonly lastErrorMessage?: string;
  } = {},
): MockExternalWorkCiTriageView {
  const triageId = options.id ?? `ci_triage_${state.externalWorkCiTriage.length + 1}`;
  const artifact: MockArtifact = {
    id: `artifact_${triageId}_log`,
    externalWorkId: "external_work_pr_42",
    type: "markdown",
    path: `external-work/external_work_pr_42/ci/${triageId}/failure-log.md`,
    title: "CI failure log",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 256,
    createdAt: "2026-05-27T00:01:00.000Z",
  };
  const taskId = options.taskId ?? "task_inspect";
  const runId = options.runId ?? "run_failed";
  const triage: MockExternalWorkCiTriageRecord = {
    id: triageId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    externalWorkId: "external_work_pr_42",
    sourceKind: "github",
    repository: "tianxiaochannel-oss88/ling-stack",
    subjectKind: "github_pull_request",
    subjectNumber: 42,
    headSha: "abcdef1234567890",
    failureKey: `github:tianxiaochannel-oss88/ling-stack:42:${triageId}`,
    status: options.status ?? "task_created",
    checkName: options.checkName ?? "unit-tests",
    workflowName: "CI",
    jobName: "test",
    conclusion: "failure",
    htmlUrl: "https://github.com/tianxiaochannel-oss88/ling-stack/actions/runs/42",
    firstFailingCommand: options.firstFailingCommand ?? "corepack pnpm test",
    reproductionCommand: options.reproductionCommand ?? "corepack pnpm --filter @ling-stack/web test:e2e",
    suspectedSourcePath: options.suspectedSourcePath ?? "apps/web/src/features/workspace/WorkspaceClientView.tsx",
    taskId,
    runId,
    artifactIds: [artifact.id],
    failure: {
      repository: "tianxiaochannel-oss88/ling-stack",
      subjectKind: "github_pull_request",
      subjectNumber: 42,
      headSha: "abcdef1234567890",
      checkName: options.checkName ?? "unit-tests",
      workflowName: "CI",
      jobName: "test",
      conclusion: "failure",
      htmlUrl: "https://github.com/tianxiaochannel-oss88/ling-stack/actions/runs/42",
      failureKey: `github:tianxiaochannel-oss88/ling-stack:42:${triageId}`,
      firstFailingCommand: options.firstFailingCommand ?? "corepack pnpm test",
      reproductionCommand: options.reproductionCommand ?? "corepack pnpm --filter @ling-stack/web test:e2e",
      suspectedSourcePath: options.suspectedSourcePath ?? "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      logExcerptArtifactId: artifact.id,
      logErrorMessage: options.lastErrorMessage,
    },
    lastErrorCode: options.lastErrorMessage ? "triage_error" : undefined,
    lastErrorMessage: options.lastErrorMessage,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:01:00.000Z",
  };
  const view: MockExternalWorkCiTriageView = {
    triage,
    externalWork: {
      id: triage.externalWorkId,
      channelId: triage.channelId,
      sourceKind: "github",
      workItemKind: "github_pull_request",
      identifier: "PR #42",
    },
    task: state.tasks.find((task) => isRecord(task) && task.id === taskId),
    run: state.runs.find((run) => run.id === runId),
    artifacts: [artifact],
  };
  state.externalWorkCiTriage.unshift(view);
  return view;
}

export function createEmptyMockBrief(channelId: string): Record<string, unknown> {
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

export function createVerboseRunEvents(runId: string): MockRunEvent[] {
  const longPath = `/tmp/${"very-long-segment-".repeat(16)}workspace/src/features/workspace/WorkspaceClientView.tsx`;
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
      data: { type: "tool_start", toolCallId: "call_grep", toolName: "grep", args: { path: longPath, pattern: "TODO_WITH_A_VERY_LONG_UNBROKEN_SEARCH_PATTERN" } },
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

export function createChatProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function createMediaProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function createMockManagedPlugins(): MockManagedPlugin[] {
  return [
    {
      id: "runner:pi",
      displayName: "Pi Runner",
      version: "builtin",
      sourceKind: "built-in",
      status: "enabled",
      trustSummary: "Built into Ling and executed through existing daemon policy boundaries.",
      contributions: [
        {
          kind: "runner",
          id: "runner:pi",
          label: "Pi Runner",
          capabilities: ["run:task"],
          enabled: true,
        },
      ],
      linkedResources: [],
      events: [],
      actions: {
        canEnable: false,
        canDisable: true,
        canCheck: true,
        canApplyPreset: false,
      },
    },
    createMockCuaPlugin(),
    createMockBundledCuaPlugin(),
  ];
}

export function createMockCuaPlugin(overrides: Partial<MockManagedPlugin> = {}): MockManagedPlugin {
  const linked = overrides.linkedResources?.[0];
  const status = overrides.status ?? (linked ? "enabled" : "available");
  const enabled = status === "enabled";
  return {
    id: "trusted-local:cua-driver",
    displayName: "Cua Driver",
    version: "1.0.0",
    sourceKind: "trusted-local-preset",
    status,
    description: "Trusted local macOS computer-use driver exposed through MCP.",
    trustSummary: "Runs a user-installed local binary through MCP. GUI input and screen capture remain approval-gated.",
    contributions: [
      {
        kind: "mcp-server",
        id: "mcp_cua_driver",
        label: "Cua Driver MCP server",
        capabilities: ["mcp:stdio", "computer-use:macos"],
        sideEffectLevel: "external",
        defaultApproval: "ask",
        linkedResourceId: linked?.id,
        linkedResourcePresent: linked?.present,
        enabled,
      },
    ],
    health: overrides.health,
    linkedResources: overrides.linkedResources ?? [],
    events: overrides.events ?? [],
    disabledReason: overrides.disabledReason,
    actions: {
      canEnable: status !== "enabled" && status !== "blocked",
      canDisable: status === "enabled",
      canCheck: true,
      canApplyPreset: status !== "blocked",
      canInstall: false,
      canUninstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
    },
    ...overrides,
  };
}

export function createMockBundledCuaPlugin(overrides: Partial<MockManagedPlugin> = {}): MockManagedPlugin {
  const packageRecord = overrides.package;
  const linkedResources = overrides.linkedResources ?? [];
  const status = overrides.status ?? (packageRecord?.status === "installed" ? "disabled" : "available");
  return {
    id: "bundled:cua-driver",
    displayName: "Cua Driver",
    version: "0.1.0",
    sourceKind: "bundled",
    status,
    description: "Bundled Ling plugin shell for Cua Driver.",
    trustSummary: "Package metadata only; the trusted-local preset connects an installed cua-driver MCP server.",
    contributions: [
      {
        kind: "mcp-server",
        id: "mcp:cua-driver",
        label: "Cua Driver",
        capabilities: ["mcp-server"],
        sideEffectLevel: "external",
        defaultApproval: "ask",
        linkedResourceId: linkedResources[0]?.id,
        linkedResourcePresent: linkedResources[0]?.present,
        enabled: status === "enabled",
      },
    ],
    health: createMockPluginHealth("bundled:cua-driver", "ready", "Bundled plugin package manifest is valid."),
    linkedResources,
    package: packageRecord,
    runtimePreview: overrides.runtimePreview ?? createMockBundledRuntimePreview({
      status: status === "enabled" && packageRecord?.status === "installed" && linkedResources.length > 0 ? "injectable" : status === "enabled" ? "blocked" : "disabled",
      packageRecord,
      linkedResources,
    }),
    events: [],
    ...overrides,
    actions: {
      canEnable: packageRecord?.status === "installed" && status !== "enabled",
      canDisable: status === "enabled",
      canCheck: true,
      canApplyPreset: false,
      canInstall: packageRecord?.status !== "installed",
      canUninstall: packageRecord?.status === "installed",
      canRefreshPackage: packageRecord?.status === "installed",
      canRuntimePreview: true,
    },
  };
}

export function createMockBundledCuaPackageRecord(): MockManagedPluginPackage {
  return {
    pluginId: "bundled:cua-driver",
    sourceKind: "bundled",
    version: "0.1.0",
    status: "installed",
    cacheRef: "bundled/cua-driver/0.1.0/mockhash1234",
    packageHash: "mockhash1234567890",
    installedAt: "2026-06-06T00:20:00.000Z",
    updatedAt: "2026-06-06T00:20:00.000Z",
  };
}

export function createMockBundledRuntimePreview(input: {
  status: string;
  packageRecord?: MockManagedPluginPackage;
  linkedResources?: MockManagedPlugin["linkedResources"];
}): MockManagedPluginRuntimePreview {
  const blockers = input.status === "injectable"
    ? []
    : input.status === "disabled"
      ? [
          "Plugin is disabled.",
          ...(input.packageRecord?.status === "installed" ? [] : ["Plugin package is not installed."]),
        ]
      : ["Linked MCP server is missing for mcp:cua-driver."];
  return {
    pluginId: "bundled:cua-driver",
    status: input.status,
    package: input.packageRecord,
    mcpServers: input.linkedResources ?? [],
    skillPacks: [],
    apps: [],
    hooks: [],
    policyOverlays: input.status === "injectable"
      ? [
          {
            id: "bundled:cua-driver:mcp_cua_driver:list_windows",
            pluginId: "bundled:cua-driver",
            contributionId: "mcp_cua_driver",
            targetKind: "mcp-tool",
            targetId: "mcp_cua_driver:list_windows",
            defaultApproval: "allow",
            sideEffectLevel: "read",
            reason: "Read-only Cua Driver inspection tool.",
          },
          {
            id: "bundled:cua-driver:mcp_cua_driver:click",
            pluginId: "bundled:cua-driver",
            contributionId: "mcp_cua_driver",
            targetKind: "mcp-tool",
            targetId: "mcp_cua_driver:click",
            defaultApproval: "ask",
            sideEffectLevel: "external",
            reason: "Cua Driver screen, app, or input action requires explicit approval.",
          },
        ]
      : [],
    blockers,
  };
}

export function createMockBundledCuaPackage(): Record<string, unknown> {
  return {
    id: "bundled:cua-driver",
    manifest: {
      id: "bundled:cua-driver",
      displayName: "Cua Driver",
      version: "0.1.0",
      lingInterfaceVersion: "1",
      sourceKind: "bundled",
      trustLevel: "trusted-local-preset",
      description: "Connects Ling to an already installed Cua Driver MCP server.",
      trustSummary: "Controls native macOS apps through Accessibility and Screen Recording permissions.",
      platforms: ["darwin"],
      contributions: [{ kind: "mcp-server", id: "mcp:cua-driver", path: "./mcp-server.json" }],
    },
    validation: {
      ok: true,
      errors: [],
      warnings: [],
      compiledDescriptor: {
        id: "bundled:cua-driver",
        displayName: "Cua Driver",
        version: "0.1.0",
        sourceKind: "bundled",
        trustSummary: "Controls native macOS apps through Accessibility and Screen Recording permissions.",
        contributions: [
          {
            kind: "mcp-server",
            id: "mcp:cua-driver",
            label: "Cua Driver",
            capabilities: ["mcp-server"],
            sideEffectLevel: "external",
            defaultApproval: "ask",
          },
        ],
        defaultEnabled: false,
      },
    },
  };
}

export function updateMockPlugin(
  state: MockState,
  pluginId: string,
  patch: Partial<MockManagedPlugin>,
): MockManagedPlugin {
  const pluginIndex = state.managedPlugins.findIndex((plugin) => plugin.id === pluginId);
  if (pluginIndex < 0) {
    throw new Error(`Missing mock plugin: ${pluginId}`);
  }
  const current = state.managedPlugins[pluginIndex];
  const updated = {
    ...current,
    ...patch,
    actions: patch.actions ?? {
      ...current.actions,
      canEnable: patch.status ? patch.status !== "enabled" && patch.status !== "blocked" : current.actions.canEnable,
      canDisable: patch.status ? patch.status === "enabled" : current.actions.canDisable,
      canCheck: current.actions.canCheck,
      canApplyPreset: current.actions.canApplyPreset,
      canInstall: current.actions.canInstall,
      canUninstall: current.actions.canUninstall,
      canRefreshPackage: current.actions.canRefreshPackage,
      canRuntimePreview: current.actions.canRuntimePreview,
    },
  };
  state.managedPlugins[pluginIndex] = updated;
  return updated;
}

export function updateMockCuaPlugin(state: MockState, patch: Partial<MockManagedPlugin>): MockManagedPlugin {
  const linkedResource = patch.linkedResources?.[0];
  const current = state.managedPlugins.find((plugin) => plugin.id === "trusted-local:cua-driver");
  const nextStatus = patch.status ?? current?.status ?? "available";
  const merged = createMockCuaPlugin({
    ...current,
    ...patch,
    linkedResources: patch.linkedResources ?? current?.linkedResources ?? [],
    events: patch.events ?? current?.events ?? [],
    health: patch.health ?? current?.health,
    disabledReason: patch.disabledReason,
    contributions: patch.contributions ?? current?.contributions?.map((contribution) => ({
      ...contribution,
      linkedResourceId: linkedResource?.id ?? contribution.linkedResourceId,
      linkedResourcePresent: linkedResource?.present ?? contribution.linkedResourcePresent,
      enabled: nextStatus === "enabled",
    })),
    actions: {
      canEnable: nextStatus !== "enabled" && nextStatus !== "blocked",
      canDisable: nextStatus === "enabled",
      canCheck: true,
      canApplyPreset: nextStatus !== "blocked",
      canInstall: false,
      canUninstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
    },
  });
  return updateMockPlugin(state, "trusted-local:cua-driver", merged);
}

export function createMockPluginHealth(
  pluginId: string,
  status: string,
  message: string,
): MockManagedPlugin["health"] {
  return {
    pluginId,
    checkedAt: "2026-06-06T00:30:00.000Z",
    expiresAt: "2026-06-06T00:35:00.000Z",
    status,
    message,
    details: status === "ready" ? { binaryFound: true } : { errorCode: `plugin_${status}` },
  };
}

export function appendMockPluginEvent(
  plugin: MockManagedPlugin,
  type: string,
  message: string,
  data: unknown,
): MockManagedPluginEvent[] {
  return [
    ...(plugin.events ?? []),
    {
      id: `plugin_event_${plugin.id.replace(/[^a-z0-9]+/gi, "_")}_${(plugin.events ?? []).length + 1}`,
      pluginId: plugin.id,
      type,
      actor: "local-user",
      message,
      data,
      createdAt: "2026-06-06T00:30:00.000Z",
    },
  ];
}

export function upsertMockCuaMcpServer(state: MockState, enabled: boolean): MockMcpServer {
  const existingIndex = state.mcpServers.findIndex((server) => server.id === "mcp_cua_driver");
  const server = createMockMcpServer({
    id: "mcp_cua_driver",
    displayName: "Cua Driver",
    serverKey: "cua-driver",
    transport: "stdio",
    command: "/usr/local/bin/cua-driver",
    args: ["mcp"],
    enabled,
    status: enabled ? "ready" : "disabled",
    lastCheck: {
      ok: enabled,
      message: enabled ? "MCP server is reachable." : "MCP server is disabled.",
      checkedAt: "2026-06-06T00:30:00.000Z",
    },
    updatedAt: "2026-06-06T00:30:00.000Z",
  });
  if (existingIndex >= 0) {
    state.mcpServers[existingIndex] = server;
  } else {
    state.mcpServers.push(server);
  }
  return server;
}

export function createDefaultProviderTemplates(): readonly Record<string, unknown>[] {
  return [
    createProviderTemplate({
      templateId: "openai-gpt",
      kind: "openai",
      displayName: "OpenAI GPT",
      description: "Official OpenAI endpoint using the built-in OpenAI provider.",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
    }),
    createProviderTemplate({
      templateId: "anthropic-claude",
      kind: "anthropic",
      displayName: "Claude",
      description: "Official Anthropic Messages API endpoint.",
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyRef: "env:ANTHROPIC_API_KEY",
    }),
    createProviderTemplate({
      templateId: "local-openai-compatible-relay",
      kind: "openai-compatible",
      displayName: "Local OpenAI-Compatible Relay",
      description: "Local relay, One API, New API, LiteLLM, OpenRouter-style gateways, or private compatible gateways.",
      providerId: "local-relay",
      model: "dpv4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyRef: "env:LOCAL_RELAY_API_KEY",
    }),
    createProviderTemplate({
      templateId: "doubao-ark",
      kind: "doubao",
      displayName: "Doubao Ark",
      description: "Volcengine Ark OpenAI-compatible chat endpoint for Doubao models.",
      providerId: "doubao",
      model: "doubao-seed-2-0-lite-260215",
      api: "openai-completions",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:ARK_API_KEY",
    }),
    createProviderTemplate({
      templateId: "deepseek-dpv4",
      kind: "deepseek",
      displayName: "DeepSeek V4",
      description: "DeepSeek OpenAI-compatible chat endpoint.",
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      apiKeyRef: "env:DEEPSEEK_API_KEY",
    }),
    createProviderTemplate({
      templateId: "minimax-chat",
      kind: "minimax",
      displayName: "MiniMax",
      description: "MiniMax OpenAI-compatible chat endpoint.",
      providerId: "minimax",
      model: "MiniMax-M2.7",
      api: "openai-completions",
      baseUrl: "https://api.minimax.io/v1",
      apiKeyRef: "env:MINIMAX_API_KEY",
    }),
    createProviderTemplate({
      templateId: "glm-zhipu",
      kind: "glm",
      displayName: "GLM Zhipu",
      description: "Zhipu GLM OpenAI-compatible chat endpoint.",
      providerId: "glm",
      model: "glm-5.1",
      api: "openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKeyRef: "env:ZHIPU_API_KEY",
    }),
    createProviderTemplate({
      templateId: "seedream-image",
      kind: "seedream",
      displayName: "Seedream Image",
      description: "Seedream image provider. image_generate can use live Ark HTTP when mediaVendorTransport.mode is explicitly set to live; image_edit remains deferred.",
      providerId: "seedream",
      model: "doubao-seedream-5-0-260128",
      api: "media-job",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      capabilities: ["image_generate", "image_edit"],
      input: ["text", "image"],
    }),
    createProviderTemplate({
      templateId: "jimeng-image",
      kind: "jimeng",
      displayName: "Jimeng Image",
      description: "Jimeng image generation/editing capability placeholder for the future media job runtime.",
      providerId: "jimeng",
      model: "jimeng-image",
      api: "media-job",
      baseUrl: "https://visual.volcengineapi.com",
      apiKeyRef: "env:JIMENG_API_KEY",
      capabilities: ["image_generate", "image_edit"],
      input: ["text", "image"],
    }),
    createProviderTemplate({
      templateId: "seedance-video",
      kind: "seedance",
      displayName: "Seedance Video",
      description: "Seedance video generation capability placeholder for the future media job runtime.",
      providerId: "seedance",
      model: "seedance",
      api: "media-job",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      capabilities: ["video_generate"],
      input: ["text", "image"],
    }),
  ];
}

export function createProviderTemplate(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    capabilities: ["chat", "tool_call", "reasoning"],
    input: ["text"],
    enabled: false,
    authHeader: true,
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

export function createMockMcpServer(overrides: Partial<MockMcpServer> = {}): MockMcpServer {
  return {
    id: "mcp_server_default",
    workspaceId: "workspace_default",
    displayName: "Filesystem MCP",
    serverKey: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", cwd],
    url: undefined,
    env: {},
    headers: {},
    secretNames: [],
    secretRefs: {},
    enabled: true,
    status: "ready",
    lastCheck: {
      ok: true,
      message: "MCP server is reachable.",
      checkedAt: "2026-06-03T00:08:00.000Z",
    },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

export function createMockMcpTool(overrides: Partial<MockMcpTool>): MockMcpTool {
  const rawName = overrides.rawName ?? overrides.name ?? "read_file";
  const displayName = overrides.displayName ?? overrides.title ?? rawName;
  return {
    id: "mcp_tool_default",
    serverId: "mcp_server_default",
    name: rawName,
    rawName,
    displayName,
    title: displayName,
    description: "Read a file through MCP.",
    inputSchema: { type: "object" },
    callableNamespace: "mcp",
    callableName: rawName,
    sideEffectLevel: "read",
    defaultApproval: "ask",
    enabled: true,
    firstSeenAt: "2026-06-03T00:00:00.000Z",
    lastSeenAt: "2026-06-03T00:00:00.000Z",
    discoveredAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

export function createMockMcpServerFromBody(body: Record<string, unknown>, id: string, existing?: MockMcpServer): MockMcpServer {
  const transportRecord = isRecord(body.transport) ? body.transport : {};
  const transportType = transportRecord.type === "streamable-http"
    ? "http"
    : transportRecord.type === "stdio"
      ? "stdio"
      : existing?.transport ?? "stdio";
  const serverKey = typeof body.id === "string" && body.id.trim()
    ? body.id.trim()
    : existing?.serverKey ?? id;
  return createMockMcpServer({
    ...existing,
    id,
    displayName: typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : existing?.displayName ?? "MCP Server",
    serverKey,
    transport: transportType,
    command: typeof transportRecord.command === "string" ? transportRecord.command : existing?.command,
    args: Array.isArray(transportRecord.args) ? transportRecord.args.filter((item): item is string => typeof item === "string") : existing?.args ?? [],
    url: typeof transportRecord.url === "string" && transportRecord.url.trim() ? transportRecord.url.trim() : existing?.url,
    env: isRecord(transportRecord.env) ? Object.fromEntries(Object.entries(transportRecord.env).filter(([, value]) => typeof value === "string")) as Record<string, string> : existing?.env ?? {},
    headers: isRecord(transportRecord.headers) ? Object.fromEntries(Object.entries(transportRecord.headers).filter(([, value]) => typeof value === "string")) as Record<string, string> : existing?.headers ?? {},
    secretNames: isRecord(transportRecord.secretHeaderRefs)
      ? Object.keys(transportRecord.secretHeaderRefs).filter((item) => item.trim().length > 0)
      : isRecord(transportRecord.secretEnvRefs)
        ? Object.keys(transportRecord.secretEnvRefs).filter((item) => item.trim().length > 0)
        : existing?.secretNames ?? [],
    secretRefs: isRecord(transportRecord.secretHeaderRefs)
      ? Object.fromEntries(Object.entries(transportRecord.secretHeaderRefs).filter(([, value]) => typeof value === "string")) as Record<string, string>
      : isRecord(transportRecord.secretEnvRefs)
        ? Object.fromEntries(Object.entries(transportRecord.secretEnvRefs).filter(([, value]) => typeof value === "string")) as Record<string, string>
        : existing?.secretRefs ?? {},
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing?.enabled ?? true,
    status: typeof body.enabled === "boolean" && !body.enabled ? "disabled" : existing?.status ?? "unknown",
    lastCheck: existing?.lastCheck,
    updatedAt: "2026-06-03T00:08:00.000Z",
  });
}

export function toPublicMockMcpServer(server: MockMcpServer, state: MockState): Record<string, unknown> {
  void state;
  const transport = server.transport === "stdio"
    ? {
      type: "stdio",
      command: server.command ?? "",
      args: server.args,
      env: server.env,
      secretEnvRefs: server.secretRefs,
    }
    : {
      type: "streamable-http",
      url: server.url ?? "",
      headers: server.headers,
      secretHeaderRefs: server.secretRefs,
    };
  const secretStatuses = Object.entries(server.secretRefs).map(([, ref]) => ({
    ref,
    kind: ref.startsWith("keychain:") ? "keychain" : "env",
    configured: true,
  }));
  return {
    id: server.id,
    workspaceId: server.workspaceId,
    displayName: server.displayName,
    transport,
    enabled: server.enabled,
    required: false,
    status: {
      kind: server.status,
      message: server.lastCheck?.message,
      checkedAt: server.lastCheck?.checkedAt,
    },
    startupTimeoutSec: 30,
    toolTimeoutSec: 60,
    enabledTools: undefined,
    disabledTools: [],
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    secretNames: server.secretNames,
    secretConfigured: Object.fromEntries(server.secretNames.map((key) => [key, Boolean(server.secretRefs[key])])),
    secretStatuses,
    statusSnapshot: server.lastCheck
      ? {
        serverId: server.id,
        checkedAt: server.lastCheck.checkedAt,
        expiresAt: "2026-06-03T00:14:00.000Z",
        status: server.status,
        missingSecretRefs: [],
        authStatus: {
          kind: secretStatuses.length > 0 ? "configured" : "not_required",
          refs: secretStatuses.map((status) => status.ref),
          missingRefs: [],
        },
        message: server.lastCheck.message,
      }
      : undefined,
    legacySecretMigrationRequired: false,
  };
}

export function createProviderFromBody(body: Record<string, unknown>, id: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
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

export function createChannelFromBody(body: Record<string, unknown>, id: string): Record<string, unknown> {
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

export function createMockTeammate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "teammate_builtin_engineer",
    workspaceId: "workspace_default",
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Ling Engineer",
    description: "Owns scoped implementation in the Engineering channel.",
    avatarTone: "teal",
    providerPresetId: undefined,
    systemPrompt: "You are the Engineering AI teammate.",
    appendSystemPrompt: [],
    allowedTools: ["read", "grep", "find", "ls"],
    approvalProfile: { mode: "standard", risk: "medium" },
    status: "active",
    pinned: true,
    hidden: false,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

export function createTeammateFromBody(body: Record<string, unknown>, id: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    templateId: typeof body.templateId === "string" ? body.templateId : typeof existing.templateId === "string" ? existing.templateId : undefined,
    roleKey: typeof body.roleKey === "string" ? body.roleKey : typeof existing.roleKey === "string" ? existing.roleKey : "custom",
    displayName: typeof body.displayName === "string" ? body.displayName : typeof existing.displayName === "string" ? existing.displayName : "Custom teammate",
    description: typeof body.description === "string" ? body.description : typeof existing.description === "string" ? existing.description : "",
    avatarTone: typeof body.avatarTone === "string" ? body.avatarTone : typeof existing.avatarTone === "string" ? existing.avatarTone : undefined,
    avatarImageAttachmentId: typeof body.avatarImageAttachmentId === "string" ? body.avatarImageAttachmentId : typeof existing.avatarImageAttachmentId === "string" ? existing.avatarImageAttachmentId : undefined,
    providerPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : typeof existing.providerPresetId === "string" ? existing.providerPresetId : undefined,
    systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : typeof existing.systemPrompt === "string" ? existing.systemPrompt : undefined,
    appendSystemPrompt: Array.isArray(body.appendSystemPrompt) ? body.appendSystemPrompt : Array.isArray(existing.appendSystemPrompt) ? existing.appendSystemPrompt : [],
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : Array.isArray(existing.allowedTools) ? existing.allowedTools : ["read", "grep", "find", "ls"],
    approvalProfile: isRecord(body.approvalProfile) ? body.approvalProfile : isRecord(existing.approvalProfile) ? existing.approvalProfile : { mode: "none" },
    status: body.status === "paused" || body.status === "disabled" ? body.status : typeof existing.status === "string" ? existing.status : "active",
    pinned: typeof body.pinned === "boolean" ? body.pinned : existing.pinned === true,
    hidden: typeof body.hidden === "boolean" ? body.hidden : existing.hidden === true,
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : "2026-05-29T00:05:00.000Z",
    updatedAt: "2026-05-29T00:05:00.000Z",
  };
}

export function buildProviderCheckResult(provider: Record<string, unknown>): Record<string, unknown> {
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
  if (provider.api === "media-job") {
    return {
      ok: true,
      code: "live_image_probe_ready",
      message: "生成真实图片成功",
      checkedAt,
    };
  }
  return { ok: true, code: "ready", message: "Provider is reachable and accepted the configured model.", checkedAt };
}

export function buildMockExternalActionView(state: MockState, action: MockExternalWorkAction): Record<string, unknown> {
  return {
    action,
    approval: action.approvalId ? state.approvals.find((approval) => approval.id === action.approvalId) : undefined,
    artifacts: state.artifactsByExternalAction[action.id] ?? [],
  };
}

export async function mockDaemon(
  page: Page,
  state: MockState,
  options: {
    readonly defaultWorkspaceCwd?: string;
    readonly templates?: readonly unknown[];
    readonly providerModelsUnsupported?: boolean;
    readonly providerCheckModelUnsupportedProviderIds?: readonly string[];
  } = {},
): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    await handleDaemonRoute(route, state, options);
  });
}

export async function handleDaemonRoute(
  route: Route,
  state: MockState,
  options: {
    readonly defaultWorkspaceCwd?: string;
    readonly templates?: readonly unknown[];
    readonly providerModelsUnsupported?: boolean;
    readonly providerCheckModelUnsupportedProviderIds?: readonly string[];
  },
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
  if (request.method() === "GET" && path === "/memory") {
    await route.fulfill({
      json: {
        cwd,
        memories: state.memoryObjects,
        vectorRetrieval: { status: "not_installed", optional: true },
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/memory/review-policy") {
    await route.fulfill({
      json: {
        cwd,
        policy: {
          workspaceId: "workspace_default",
          mode: "balanced",
          autoActiveSameScope: true,
          autoActiveUserExplicit: true,
          requireManualForWorkspace: true,
          requireManualForPersona: true,
          requireManualForCrossScope: true,
          quarantineSecretAdjacent: true,
          updatedAt: "2026-06-04T00:00:00.000Z",
        },
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/memory/promotion-inbox") {
    await route.fulfill({ json: { cwd, items: [] } });
    return;
  }
  if (request.method() === "GET" && path === "/memory/health") {
    await route.fulfill({
      json: {
        cwd,
        report: {
          generatedAt: "2026-06-04T00:00:00.000Z",
          staleCandidateDays: 30,
          summary: {
            total: state.memoryObjects.length,
            active: state.memoryObjects.filter((item) => isRecord(item) && item.reviewState === "active").length,
            candidate: state.memoryObjects.filter((item) => isRecord(item) && item.reviewState === "candidate").length,
            disabled: state.memoryObjects.filter((item) => isRecord(item) && item.enabled === false).length,
            archived: state.memoryObjects.filter((item) => isRecord(item) && item.reviewState === "archived").length,
            rejected: state.memoryObjects.filter((item) => isRecord(item) && item.reviewState === "rejected").length,
            enabled: state.memoryObjects.filter((item) => isRecord(item) && item.enabled !== false).length,
            reviewBacklog: 0,
            staleCandidates: 0,
            verifyBeforeUse: state.memoryObjects.filter((item) => isRecord(item) && item.verifyBeforeUse === true).length,
            findings: { critical: 0, warning: 0, info: 0 },
          },
          findings: [],
        },
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/memory/used") {
    const teammateId = url.searchParams.get("teammateId");
    const responseId = url.searchParams.get("responseId");
    const runId = url.searchParams.get("runId");
    const events = state.usedMemoryEvents.filter((event) =>
      isRecord(event) &&
      (!teammateId || event.teammateId === teammateId) &&
      (!responseId || event.responseId === responseId) &&
      (!runId || event.runId === runId)
    );
    await route.fulfill({ json: { cwd, events } });
    return;
  }
  if (request.method() === "GET" && path === "/skills") {
    await route.fulfill({
      json: {
        cwd,
        skills: state.skillRegistryEntries.filter((item) =>
          isRecord(item) && item.reviewStatus !== "archived" && item.reviewStatus !== "disabled"
        ),
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/plugins") {
    await route.fulfill({ json: { cwd, plugins: state.managedPlugins } });
    return;
  }
  if (request.method() === "GET" && path === "/plugins/sources") {
    await route.fulfill({
      json: {
        cwd,
        sources: [
          {
            id: "bundled",
            sourceKind: "bundled",
            displayName: "Bundled plugins",
            pluginCount: 1,
            pluginIds: ["bundled:cua-driver"],
          },
        ],
      },
    });
    return;
  }
  const pluginPackageMatch = /^\/plugins\/packages\/([^/]+)$/.exec(path);
  if (pluginPackageMatch && request.method() === "GET") {
    const packageId = decodeURIComponent(pluginPackageMatch[1]);
    if (packageId !== "bundled:cua-driver") {
      await route.fulfill({ status: 404, json: { error: "plugin_package_not_found" } });
      return;
    }
    await route.fulfill({ json: { cwd, package: createMockBundledCuaPackage() } });
    return;
  }
  const pluginMatch = /^\/plugins\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (pluginMatch) {
    const pluginId = decodeURIComponent(pluginMatch[1]);
    const action = pluginMatch[2];
    const pluginIndex = state.managedPlugins.findIndex((plugin) => plugin.id === pluginId);
    if (pluginIndex < 0) {
      await route.fulfill({ status: 404, json: { error: "plugin_not_found", message: `Plugin not found: ${pluginId}` } });
      return;
    }
    const plugin = state.managedPlugins[pluginIndex];
    if (!action && request.method() === "GET") {
      await route.fulfill({ json: { plugin } });
      return;
    }
    if (action === "validate-package" && request.method() === "POST") {
      if (plugin.id !== "bundled:cua-driver") {
        await route.fulfill({ status: 404, json: { error: "plugin_package_not_found" } });
        return;
      }
      await route.fulfill({ json: { cwd, plugin, package: createMockBundledCuaPackage(), validation: createMockBundledCuaPackage().validation } });
      return;
    }
    if (action === "install" && request.method() === "POST") {
      if (plugin.id !== "bundled:cua-driver") {
        await route.fulfill({ status: 400, json: { error: "plugin_package_not_installable" } });
        return;
      }
      const packageRecord = plugin.package?.status === "installed" ? plugin.package : createMockBundledCuaPackageRecord();
      const server = upsertMockCuaMcpServer(state, false);
      const linkedResources = [{ kind: "mcp-server", id: server.id, present: true, enabled: false, displayName: server.displayName }];
      const updated = updateMockPlugin(state, plugin.id, createMockBundledCuaPlugin({
        ...plugin,
        status: "disabled",
        package: packageRecord,
        linkedResources,
        runtimePreview: createMockBundledRuntimePreview({ status: "disabled", packageRecord, linkedResources }),
        events: appendMockPluginEvent(plugin, "installed", "Plugin package installed.", { cacheRef: packageRecord.cacheRef }),
      }));
      await route.fulfill({ json: { plugin: updated, package: packageRecord } });
      return;
    }
    if (action === "refresh-package" && request.method() === "POST") {
      if (plugin.id !== "bundled:cua-driver" || plugin.package?.status !== "installed") {
        await route.fulfill({ status: 400, json: { error: "plugin_package_not_installed" } });
        return;
      }
      const packageRecord = { ...plugin.package, updatedAt: "2026-06-06T00:24:00.000Z" };
      const updated = updateMockPlugin(state, plugin.id, createMockBundledCuaPlugin({
        ...plugin,
        package: packageRecord,
        runtimePreview: createMockBundledRuntimePreview({
          status: plugin.status === "enabled" ? "injectable" : "disabled",
          packageRecord,
          linkedResources: plugin.linkedResources,
        }),
        events: appendMockPluginEvent(plugin, "package_refreshed", "Plugin package refreshed.", { cacheRef: packageRecord.cacheRef }),
      }));
      await route.fulfill({ json: { plugin: updated, package: packageRecord } });
      return;
    }
    if (action === "runtime-preview" && request.method() === "GET") {
      const preview = plugin.runtimePreview ?? createMockBundledRuntimePreview({
        status: plugin.status === "enabled" ? "injectable" : "disabled",
        packageRecord: plugin.package,
        linkedResources: plugin.linkedResources,
      });
      const updated = updateMockPlugin(state, plugin.id, {
        runtimePreview: preview,
        events: appendMockPluginEvent(plugin, "runtime_previewed", `Runtime preview ${preview.status}.`, { status: preview.status }),
      });
      await route.fulfill({ json: { cwd, plugin: updated, preview } });
      return;
    }
    if (action === "uninstall" && request.method() === "POST") {
      if (plugin.id !== "bundled:cua-driver") {
        await route.fulfill({ status: 400, json: { error: "plugin_package_not_installed" } });
        return;
      }
      const packageRecord = plugin.package
        ? { ...plugin.package, status: "uninstalled", updatedAt: "2026-06-06T00:25:00.000Z", uninstalledAt: "2026-06-06T00:25:00.000Z" }
        : undefined;
      const server = state.mcpServers.find((item) => item.id === "mcp_cua_driver");
      if (server) {
        server.enabled = false;
        server.status = "disabled";
      }
      const linkedResources = plugin.linkedResources.map((resource) =>
        resource.id === "mcp_cua_driver" ? { ...resource, enabled: false } : resource
      );
      const updated = updateMockPlugin(state, plugin.id, createMockBundledCuaPlugin({
        ...plugin,
        status: "disabled",
        package: packageRecord,
        linkedResources,
        runtimePreview: createMockBundledRuntimePreview({ status: "disabled", packageRecord, linkedResources }),
        events: appendMockPluginEvent(plugin, "uninstalled", "Plugin package uninstalled.", {}),
      }));
      await route.fulfill({ json: { plugin: updated, ...(packageRecord ? { package: packageRecord } : {}) } });
      return;
    }
    if (action === "apply-preset" && request.method() === "POST") {
      if (plugin.id !== "trusted-local:cua-driver") {
        await route.fulfill({ status: 400, json: { error: "plugin_preset_not_applicable", message: "Plugin does not support apply-preset." } });
        return;
      }
      const server = upsertMockCuaMcpServer(state, true);
      const tools = [
        createMockMcpTool({
          id: "mcp_cua_driver_check_permissions",
          serverId: server.id,
          name: "check_permissions",
          title: "Check permissions",
          sideEffectLevel: "read",
          defaultApproval: "allow",
        }),
        createMockMcpTool({
          id: "mcp_cua_driver_click",
          serverId: server.id,
          name: "click",
          title: "Click",
          sideEffectLevel: "external",
          defaultApproval: "ask",
        }),
        createMockMcpTool({
          id: "mcp_cua_driver_list_windows",
          serverId: server.id,
          name: "list_windows",
          title: "List windows",
          sideEffectLevel: "read",
          defaultApproval: "allow",
        }),
      ];
      state.mcpTools = [...state.mcpTools.filter((tool) => tool.serverId !== server.id), ...tools];
      const updated = updateMockCuaPlugin(state, {
        status: "enabled",
        linkedResources: [{ kind: "mcp-server", id: server.id, present: true, enabled: true, displayName: server.displayName }],
        health: createMockPluginHealth("trusted-local:cua-driver", "ready", "3 tools discovered"),
        events: appendMockPluginEvent(plugin, "preset_applied", "Preset applied. 3 MCP tool(s) synced.", { status: "ready", mcpServerId: server.id, toolCount: 3 }),
      });
      await route.fulfill({
        json: {
          plugin: updated,
          linkedMcpServer: toPublicMockMcpServer(server, state),
          statusSnapshot: toPublicMockMcpServer(server, state).statusSnapshot,
          tools,
        },
      });
      return;
    }
    if (action === "check" && request.method() === "POST") {
      const server = state.mcpServers.find((item) => item.id === "mcp_cua_driver");
      const health = server
        ? createMockPluginHealth(plugin.id, server.enabled ? "ready" : "disabled", server.enabled ? "MCP server is reachable." : "MCP server is disabled.")
        : createMockPluginHealth(plugin.id, "ready", plugin.id === "trusted-local:cua-driver"
          ? "cua-driver binary found."
          : plugin.id === "bundled:cua-driver"
            ? "Bundled plugin package manifest is valid."
            : "Built-in plugin metadata is available.");
      const updated = updateMockPlugin(state, plugin.id, {
        health,
        events: appendMockPluginEvent(plugin, "checked", health.message ?? "Plugin checked.", { status: health.status }),
      });
      await route.fulfill({ json: { plugin: updated, health } });
      return;
    }
    if (action === "disable" && request.method() === "POST") {
      const reason = safePostDataJson(request).reason;
      const server = state.mcpServers.find((item) => item.id === "mcp_cua_driver");
      if ((plugin.id === "trusted-local:cua-driver" || plugin.id === "bundled:cua-driver") && server) {
        server.enabled = false;
        server.status = "disabled";
        server.updatedAt = "2026-06-06T00:31:00.000Z";
      }
      const patch = {
        status: "disabled",
        disabledReason: typeof reason === "string" ? reason : undefined,
        linkedResources: plugin.linkedResources.map((resource) =>
          resource.id === "mcp_cua_driver" ? { ...resource, enabled: false } : resource
        ),
        contributions: plugin.contributions.map((contribution) => ({ ...contribution, enabled: false })),
        events: appendMockPluginEvent(plugin, "disabled", "Plugin disabled.", {}),
      };
      const updated = updateMockPlugin(state, plugin.id, plugin.id === "bundled:cua-driver"
        ? createMockBundledCuaPlugin({
            ...plugin,
            ...patch,
            runtimePreview: createMockBundledRuntimePreview({ status: "disabled", packageRecord: plugin.package, linkedResources: patch.linkedResources }),
          })
        : patch);
      await route.fulfill({ json: { plugin: updated } });
      return;
    }
    if (action === "enable" && request.method() === "POST") {
      const server = state.mcpServers.find((item) => item.id === "mcp_cua_driver");
      if ((plugin.id === "trusted-local:cua-driver" || plugin.id === "bundled:cua-driver") && server) {
        server.enabled = true;
        server.status = "ready";
        server.updatedAt = "2026-06-06T00:32:00.000Z";
      }
      const linkedResources = plugin.linkedResources.map((resource) =>
        resource.id === "mcp_cua_driver" ? { ...resource, enabled: true } : resource
      );
      const patch = {
        status: "enabled",
        disabledReason: undefined,
        linkedResources,
        contributions: plugin.contributions.map((contribution) => ({ ...contribution, enabled: true })),
        events: appendMockPluginEvent(plugin, "enabled", "Plugin enabled.", {}),
      };
      const updated = updateMockPlugin(state, plugin.id, plugin.id === "bundled:cua-driver"
        ? createMockBundledCuaPlugin({
            ...plugin,
            ...patch,
            runtimePreview: createMockBundledRuntimePreview({
              status: plugin.package?.status === "installed" && linkedResources.length > 0 ? "injectable" : "blocked",
              packageRecord: plugin.package,
              linkedResources,
            }),
          })
        : patch);
      await route.fulfill({ json: { plugin: updated } });
      return;
    }
  }
  if (request.method() === "POST" && path === "/skills/import-draft") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const draft = createMockSkillImportDraft(state, body);
    state.skillImportDrafts.unshift(draft);
    await route.fulfill({ status: 201, json: { cwd, draft } });
    return;
  }
  const skillDraftMatch = /^\/skills\/import-drafts\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (skillDraftMatch) {
    const draftId = decodeURIComponent(skillDraftMatch[1]);
    const action = skillDraftMatch[2];
    const draft = state.skillImportDrafts.find((item) => isRecord(item) && item.id === draftId);
    if (!isRecord(draft)) {
      await route.fulfill({ status: 404, json: { error: "skill_import_draft_not_found" } });
      return;
    }
    if (!action && request.method() === "GET") {
      await route.fulfill({ json: { cwd, draft } });
      return;
    }
    if (action === "publish" && request.method() === "POST") {
      const definitions = Array.isArray(draft.definitions) ? draft.definitions.filter(isRecord) : [];
      const published = definitions.map((definitionRecord) => {
        const definition = isRecord(definitionRecord.definition) ? definitionRecord.definition : {};
        const skillId = typeof definition.id === "string" ? definition.id : `custom-skill-${state.skillRegistryEntries.length + 1}`;
        return {
          id: skillId,
          workspaceId: "workspace_default",
          packId: typeof draft.packId === "string" ? draft.packId : `skill_pack_${skillId}`,
          source: typeof draft.source === "string" ? draft.source : "custom",
          sourcePath: typeof draft.sourcePath === "string" ? draft.sourcePath : undefined,
          version: typeof draft.version === "string" ? draft.version : undefined,
          definition,
          visibility: isRecord(definitionRecord.visibility)
            ? definitionRecord.visibility
            : { workspaceVisible: true, promotableToWorkspace: true },
          reviewStatus: "published",
          createdAt: "2026-06-04T00:21:00.000Z",
          updatedAt: "2026-06-04T00:21:00.000Z",
        };
      });
      state.skillRegistryEntries = [
        ...published,
        ...state.skillRegistryEntries.filter((entry) =>
          !isRecord(entry) || !published.some((skill) => skill.id === entry.id)
        ),
      ];
      await route.fulfill({ json: { cwd, draftId, skills: published } });
      return;
    }
  }
  const skillMatch = /^\/skills\/([^/]+)$/.exec(path);
  if (skillMatch && request.method() === "DELETE") {
    const skillId = decodeURIComponent(skillMatch[1]);
    let archived: unknown;
    state.skillRegistryEntries = state.skillRegistryEntries.map((entry) => {
      if (isRecord(entry) && entry.id === skillId && entry.source !== "builtin") {
        archived = { ...entry, reviewStatus: "archived", updatedAt: "2026-06-04T00:22:00.000Z" };
        return archived;
      }
      return entry;
    });
    if (!archived) {
      await route.fulfill({ status: 404, json: { error: "skill_not_found" } });
      return;
    }
    await route.fulfill({ json: { cwd, skill: archived } });
    return;
  }
  if (request.method() === "GET" && path === "/mcp/servers") {
    await route.fulfill({ json: { cwd, servers: state.mcpServers.map((server) => toPublicMockMcpServer(server, state)) } });
    return;
  }
  if (request.method() === "POST" && path === "/mcp/servers") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const serverId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : `mcp_server_${state.mcpServers.length + 1}`;
    const server = createMockMcpServerFromBody(body, serverId);
    state.mcpServers.push(server);
    await route.fulfill({ status: 201, json: { server: toPublicMockMcpServer(server, state) } });
    return;
  }
  if (request.method() === "GET" && path === "/mcp/tools") {
    const serverId = url.searchParams.get("serverId");
    await route.fulfill({
      json: {
        cwd,
        serverId: serverId ?? undefined,
        tools: state.mcpTools.filter((tool) => !serverId || tool.serverId === serverId),
      },
    });
    return;
  }
  const mcpServerMatch = /^\/mcp\/servers\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (mcpServerMatch) {
    const serverId = decodeURIComponent(mcpServerMatch[1]);
    const action = mcpServerMatch[2];
    const serverIndex = state.mcpServers.findIndex((server) => server.id === serverId || server.serverKey === serverId);
    const server = serverIndex >= 0 ? state.mcpServers[serverIndex] : undefined;
    if (!server) {
      await route.fulfill({ status: 404, json: { error: "mcp_server_not_found" } });
      return;
    }
    if (!action && request.method() === "GET") {
      await route.fulfill({ json: { server: toPublicMockMcpServer(server, state) } });
      return;
    }
    if (!action && request.method() === "PATCH") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const updated = createMockMcpServerFromBody(body, server.id, server);
      state.mcpServers[serverIndex] = updated;
      await route.fulfill({ json: { server: toPublicMockMcpServer(updated, state) } });
      return;
    }
    if (!action && request.method() === "DELETE") {
      state.mcpServers = state.mcpServers.filter((item) => item.id !== server.id);
      state.mcpTools = state.mcpTools.filter((tool) => tool.serverId !== server.id);
      state.teammateMcpBindings = state.teammateMcpBindings.filter((binding) => binding.serverId !== server.id);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (action === "check" && request.method() === "POST") {
      server.status = server.enabled ? "ready" : "disabled";
      server.lastCheck = {
        ok: server.enabled,
        message: server.enabled ? "MCP server is reachable." : "MCP server is disabled.",
        checkedAt: "2026-06-03T00:09:00.000Z",
      };
      server.updatedAt = server.lastCheck.checkedAt;
      const publicServer = toPublicMockMcpServer(server, state);
      await route.fulfill({ json: { server: publicServer, statusSnapshot: publicServer.statusSnapshot } });
      return;
    }
    if (action === "sync-tools" && request.method() === "POST") {
      const discovered = [
        createMockMcpTool({ id: `${server.id}_search_repositories`, serverId: server.id, name: "search_repositories", title: "Search repositories" }),
        createMockMcpTool({ id: `${server.id}_create_issue`, serverId: server.id, name: "create_issue", title: "Create issue" }),
      ];
      state.mcpTools = [...state.mcpTools.filter((tool) => tool.serverId !== server.id), ...discovered];
      const publicServer = toPublicMockMcpServer(server, state);
      await route.fulfill({ json: { server: publicServer, statusSnapshot: publicServer.statusSnapshot, tools: discovered } });
      return;
    }
    if (action === "status" && request.method() === "GET") {
      const publicServer = toPublicMockMcpServer(server, state);
      await route.fulfill({ json: { server: publicServer, statusSnapshot: publicServer.statusSnapshot ?? null } });
      return;
    }
    if (action === "secret" && request.method() === "GET") {
      await route.fulfill({ status: 410, json: { error: "mcp_secret_endpoint_removed" } });
      return;
    }
  }
  if (request.method() === "GET" && path === "/teammates") {
    const includeHidden = url.searchParams.get("includeHidden") === "true";
    const includeDisabled = url.searchParams.get("includeDisabled") === "true";
    const teammates = state.aiTeammates.filter((item) =>
      isRecord(item) &&
      (includeHidden || item.hidden !== true) &&
      (includeDisabled || item.status !== "disabled")
    );
    await route.fulfill({ json: { cwd, teammates } });
    return;
  }
  if (request.method() === "POST" && path === "/teammates") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const teammate = createTeammateFromBody(body, `teammate_created_${state.aiTeammates.length + 1}`);
    state.aiTeammates.push(teammate);
    await route.fulfill({ status: 201, json: { teammate } });
    return;
  }
  const teammateActionMatch = /^\/teammates\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (teammateActionMatch) {
    const teammateId = decodeURIComponent(teammateActionMatch[1]);
    const action = teammateActionMatch[2];
    const teammateIndex = state.aiTeammates.findIndex((item) => isRecord(item) && item.id === teammateId);
    const teammate = teammateIndex >= 0 && isRecord(state.aiTeammates[teammateIndex])
      ? state.aiTeammates[teammateIndex]
      : undefined;
    if (!teammate) {
      await route.fulfill({ status: 404, json: { error: "teammate_not_found" } });
      return;
    }
    if (!action && request.method() === "GET") {
      await route.fulfill({ json: { teammate } });
      return;
    }
    if (!action && request.method() === "PATCH") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const updated = {
        ...teammate,
        ...createTeammateFromBody(
          Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null)),
          teammateId,
          teammate,
        ),
        providerPresetId: body.providerPresetId === null ? undefined : typeof body.providerPresetId === "string" ? body.providerPresetId : teammate.providerPresetId,
        systemPrompt: body.systemPrompt === null ? undefined : typeof body.systemPrompt === "string" ? body.systemPrompt : teammate.systemPrompt,
        updatedAt: "2026-05-29T00:06:00.000Z",
      };
      state.aiTeammates[teammateIndex] = updated;
      await route.fulfill({ json: { teammate: updated } });
      return;
    }
    if (!action && request.method() === "DELETE") {
      const disabled = { ...teammate, status: "disabled", hidden: true, updatedAt: "2026-05-29T00:06:00.000Z" };
      state.aiTeammates[teammateIndex] = disabled;
      await route.fulfill({ json: { teammate: disabled } });
      return;
    }
    if (action === "hard-delete" && request.method() === "POST") {
      let body: Record<string, unknown> = {};
      try {
        body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      const deletedCounts = {
        aiTeammates: 1,
        directThreads: state.teammateDirectThreads[teammateId] ? 1 : 0,
        directMessages: state.teammateDirectMessages.filter((item) => isRecord(item) && item.teammateId === teammateId).length,
        privateAttachments: state.teammatePrivateAttachments.filter((item) => isRecord(item) && item.teammateId === teammateId).length,
        memoryObjects: state.memoryObjects.filter((item) => isRecord(item) && item.scopeType === "teammate" && item.ownerId === teammateId).length,
        usedMemoryEvents: state.usedMemoryEvents.filter((item) => isRecord(item) && item.teammateId === teammateId).length,
      };
      state.aiTeammates = state.aiTeammates.filter((item) => !isRecord(item) || item.id !== teammateId);
      state.teammateChannelMemberships = state.teammateChannelMemberships.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateSkillBindings = state.teammateSkillBindings.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateMemoryScopes = state.teammateMemoryScopes.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateMcpBindings = state.teammateMcpBindings.filter((item) => item.teammateId !== teammateId);
      state.teammateDirectMessages = state.teammateDirectMessages.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammatePrivateAttachments = state.teammatePrivateAttachments.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.memoryObjects = state.memoryObjects.filter((item) => !isRecord(item) || item.scopeType !== "teammate" || item.ownerId !== teammateId);
      state.usedMemoryEvents = state.usedMemoryEvents.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      delete state.teammateDirectThreads[teammateId];
      state.channels = state.channels.map((channel) =>
        isRecord(channel) && channel.defaultTeammateId === teammateId ? { ...channel, defaultTeammateId: undefined } : channel,
      );
      state.tasks = state.tasks.map((task) =>
        isRecord(task) && task.assigneeTeammateId === teammateId ? { ...task, assigneeTeammateId: undefined } : task,
      );
      const tombstone = {
        id: `tomb_${state.retentionTombstones.length + 1}`,
        workspaceId: "workspace_default",
        entityType: "ai-teammate",
        entityId: teammateId,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        deletedCounts,
        createdAt: "2026-06-04T00:00:00.000Z",
      };
      state.retentionTombstones.push(tombstone);
      await route.fulfill({ json: { tombstone } });
      return;
    }
    if (action === "channels" && request.method() === "GET") {
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          memberships: state.teammateChannelMemberships.filter((item) => isRecord(item) && item.teammateId === teammateId),
        },
      });
      return;
    }
    if (action === "channels" && request.method() === "PUT") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      state.teammateChannelMemberships = state.teammateChannelMemberships.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.channels = state.channels.map((channel) =>
        isRecord(channel) && channel.defaultTeammateId === teammateId
          ? { ...channel, defaultTeammateId: undefined, updatedAt: "2026-05-29T00:07:00.000Z" }
          : channel,
      );
      const memberships = Array.isArray(body.memberships) ? body.memberships : [];
      for (const membership of memberships) {
        if (!isRecord(membership) || typeof membership.channelId !== "string") {
          continue;
        }
        const record = {
          teammateId,
          channelId: membership.channelId,
          isDefault: membership.isDefault === true,
          createdAt: "2026-05-29T00:07:00.000Z",
          updatedAt: "2026-05-29T00:07:00.000Z",
        };
        state.teammateChannelMemberships.push(record);
        if (record.isDefault) {
          state.channels = state.channels.map((channel) =>
            isRecord(channel) && channel.id === record.channelId
              ? { ...channel, defaultTeammateId: teammateId, updatedAt: record.updatedAt }
              : channel,
          );
        }
      }
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          memberships: state.teammateChannelMemberships.filter((item) => isRecord(item) && item.teammateId === teammateId),
        },
      });
      return;
    }
    if (action === "skills" && request.method() === "GET") {
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          bindings: state.teammateSkillBindings.filter((item) => isRecord(item) && item.teammateId === teammateId),
          effectiveSkills: buildMockEffectiveSkills(state, teammateId),
        },
      });
      return;
    }
    if (action === "skills" && request.method() === "PUT") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      state.teammateSkillBindings = state.teammateSkillBindings.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      const bindings = Array.isArray(body.bindings) ? body.bindings : [];
      for (const binding of bindings) {
        if (!isRecord(binding) || typeof binding.skillId !== "string") {
          continue;
        }
        state.teammateSkillBindings.push({
          teammateId,
          skillId: binding.skillId,
          source: typeof binding.source === "string" ? binding.source : "user",
          enabled: binding.enabled !== false,
          createdAt: "2026-05-29T00:08:00.000Z",
          updatedAt: "2026-05-29T00:08:00.000Z",
        });
      }
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          bindings: state.teammateSkillBindings.filter((item) => isRecord(item) && item.teammateId === teammateId),
          effectiveSkills: buildMockEffectiveSkills(state, teammateId),
        },
      });
      return;
    }
    if (action === "mcp" && request.method() === "GET") {
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          bindings: state.teammateMcpBindings.filter((item) => item.teammateId === teammateId),
        },
      });
      return;
    }
    if (action === "mcp" && request.method() === "PUT") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      state.teammateMcpBindings = state.teammateMcpBindings.filter((item) => item.teammateId !== teammateId);
      const bindings = Array.isArray(body.bindings) ? body.bindings : [];
      for (const binding of bindings) {
        if (!isRecord(binding) || typeof binding.serverId !== "string") {
          continue;
        }
        state.teammateMcpBindings.push({
          teammateId,
          serverId: binding.serverId,
          mode: binding.mode === "all_current_tools" ? "all_current_tools" : "selected",
          selectedToolNames: Array.isArray(binding.selectedToolNames)
            ? binding.selectedToolNames.filter((item): item is string => typeof item === "string")
            : [],
          approvalOverrides: isRecord(binding.approvalOverrides)
            ? Object.fromEntries(Object.entries(binding.approvalOverrides).filter(([, value]) => typeof value === "string")) as Record<string, string>
            : {},
          enabled: binding.enabled !== false,
          createdAt: "2026-06-03T00:08:00.000Z",
          updatedAt: "2026-06-03T00:08:00.000Z",
        });
      }
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          bindings: state.teammateMcpBindings.filter((item) => item.teammateId === teammateId),
        },
      });
      return;
    }
    if (action === "memory-scopes" && request.method() === "GET") {
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          scopes: state.teammateMemoryScopes.filter((item) => isRecord(item) && item.teammateId === teammateId),
        },
      });
      return;
    }
    if (action === "memory-scopes" && request.method() === "PUT") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      state.teammateMemoryScopes = state.teammateMemoryScopes.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      const scopes = Array.isArray(body.scopes) ? body.scopes : [];
      for (const [index, scope] of scopes.entries()) {
        if (!isRecord(scope) || typeof scope.kind !== "string") {
          continue;
        }
        state.teammateMemoryScopes.push({
          id: typeof scope.id === "string" ? scope.id : `memory_${teammateId}_${index + 1}`,
          teammateId,
          kind: scope.kind,
          channelId: typeof scope.channelId === "string" ? scope.channelId : undefined,
          enabled: scope.enabled !== false,
          createdAt: "2026-05-29T00:09:00.000Z",
          updatedAt: "2026-05-29T00:09:00.000Z",
        });
      }
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          scopes: state.teammateMemoryScopes.filter((item) => isRecord(item) && item.teammateId === teammateId),
        },
      });
      return;
    }
    if (action === "persona-draft" && request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { cwd, draft: createMockPersonaDraft(teammateId, body) } });
      return;
    }
    if (action === "direct-attachments") {
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      if (request.method() === "GET") {
        await route.fulfill({
          json: {
            cwd,
            teammateId,
            thread,
            attachments: state.teammatePrivateAttachments.filter((item) =>
              isRecord(item) &&
              item.teammateId === teammateId &&
              item.threadId === thread.id &&
              item.scope === "teammate_direct_thread"
            ),
          },
        });
        return;
      }
      if (request.method() === "POST") {
        const body = await request.postDataJSON() as Record<string, unknown>;
        const attachment = {
          id: `tpatt_${state.teammatePrivateAttachments.length + 1}`,
          workspaceId: "workspace_default",
          teammateId,
          threadId: thread.id,
          messageId: typeof body.messageId === "string" ? body.messageId : undefined,
          scope: "teammate_direct_thread",
          kind: "text",
          fileName: typeof body.fileName === "string" ? body.fileName : "attachment.txt",
          contentType: typeof body.contentType === "string" ? body.contentType : "text/plain",
          sizeBytes: typeof body.contentBase64 === "string" ? Buffer.from(body.contentBase64, "base64").byteLength : 0,
          path: `teammates/${teammateId}/direct/${thread.id}/mock`,
          createdAt: "2026-06-04T00:10:00.000Z",
        };
        state.teammatePrivateAttachments.unshift(attachment);
        await route.fulfill({ status: 201, json: { attachment } });
        return;
      }
    }
    if (action === "avatar") {
      if (request.method() === "POST") {
        const body = await request.postDataJSON() as Record<string, unknown>;
        const previousAvatarId = typeof teammate.avatarImageAttachmentId === "string" ? teammate.avatarImageAttachmentId : undefined;
        const attachment = {
          id: `tpatt_${state.teammatePrivateAttachments.length + 1}`,
          workspaceId: "workspace_default",
          teammateId,
          scope: "teammate_profile_avatar",
          kind: "image",
          fileName: typeof body.fileName === "string" ? body.fileName : "avatar.png",
          contentType: typeof body.contentType === "string" ? body.contentType : "image/png",
          sizeBytes: typeof body.contentBase64 === "string" ? Buffer.from(body.contentBase64, "base64").byteLength : 0,
          path: `teammates/${teammateId}/avatar/mock`,
          createdAt: "2026-06-04T00:11:00.000Z",
        };
        state.teammatePrivateAttachments = [
          attachment,
          ...state.teammatePrivateAttachments.filter((item) => !isRecord(item) || item.id !== previousAvatarId),
        ];
        const updated = { ...teammate, avatarImageAttachmentId: attachment.id, updatedAt: "2026-06-04T00:11:00.000Z" };
        state.aiTeammates[teammateIndex] = updated;
        await route.fulfill({ status: 201, json: { teammate: updated, attachment } });
        return;
      }
      if (request.method() === "DELETE") {
        const avatarId = typeof teammate.avatarImageAttachmentId === "string" ? teammate.avatarImageAttachmentId : undefined;
        state.teammatePrivateAttachments = state.teammatePrivateAttachments.filter((item) => !isRecord(item) || item.id !== avatarId);
        const updated = { ...teammate, avatarImageAttachmentId: undefined, updatedAt: "2026-06-04T00:12:00.000Z" };
        state.aiTeammates[teammateIndex] = updated;
        await route.fulfill({ json: { teammate: updated } });
        return;
      }
    }
    if ((action === "direct-thread" || action === "direct-messages") && request.method() === "GET") {
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      const messages = state.teammateDirectMessages.filter((item) => isRecord(item) && item.teammateId === teammateId && item.threadId === thread.id);
      await route.fulfill({
        json: action === "direct-thread"
          ? { cwd, teammateId, thread }
          : { cwd, teammateId, thread, messages },
      });
      return;
    }
    if (action === "direct-messages/stream" && request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      const message = {
        id: `tdmsg_${state.teammateDirectMessages.length + 1}`,
        workspaceId: "workspace_default",
        threadId: thread.id,
        teammateId,
        authorType: "local-user",
        authorId: "local-user",
        body: typeof body.body === "string" ? body.body : "",
        attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
        status: "ready",
        createdAt: "2026-06-04T00:20:00.000Z",
        updatedAt: "2026-06-04T00:20:00.000Z",
      };
      state.teammateDirectMessages.push(message);
      const providerPresetId = typeof body.providerPresetId === "string" ? body.providerPresetId : typeof teammate.providerPresetId === "string" ? teammate.providerPresetId : undefined;
      const provider = providerPresetId ? state.providers.find((item) => isRecord(item) && item.id === providerPresetId) : undefined;
      const blockedReason = teammate.status !== "active"
        ? `Teammate status is ${String(teammate.status)}.`
        : !providerPresetId
          ? "No provider preset is selected for this teammate."
          : !isRecord(provider) || !isRecord(provider.lastCheck) || provider.lastCheck.ok !== true
            ? "Provider preflight is not ready."
            : "";
      const aiReply = {
        id: `tdmsg_${state.teammateDirectMessages.length + 1}`,
        workspaceId: "workspace_default",
        threadId: thread.id,
        teammateId,
        authorType: "ai-teammate",
        authorId: teammateId,
        body: blockedReason ? `AI teammate is blocked: ${blockedReason}` : "Private reply: I will refine this into a scoped task.",
        attachmentIds: [],
        status: blockedReason ? "blocked" : "ready",
        errorMessage: blockedReason || undefined,
        createdAt: "2026-06-04T00:20:01.000Z",
        updatedAt: "2026-06-04T00:20:01.000Z",
      };
      state.teammateDirectMessages.push(aiReply);
      const pendingReply = { ...aiReply, body: "", status: "pending", errorMessage: undefined };
      const events = blockedReason
        ? [
          { event: "ready", data: { message, aiReply: pendingReply } },
          { event: "blocked", data: { message, aiReply, error: blockedReason } },
        ]
        : [
          { event: "ready", data: { message, aiReply: pendingReply } },
          { event: "delta", data: { messageId: aiReply.id, delta: aiReply.body, body: aiReply.body } },
          { event: "done", data: { message, aiReply } },
        ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(""),
      });
      return;
    }
    if (action === "direct-messages" && request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      const message = {
        id: `tdmsg_${state.teammateDirectMessages.length + 1}`,
        workspaceId: "workspace_default",
        threadId: thread.id,
        teammateId,
        authorType: "local-user",
        authorId: "local-user",
        body: typeof body.body === "string" ? body.body : "",
        attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
        status: "ready",
        createdAt: "2026-05-29T00:10:00.000Z",
        updatedAt: "2026-05-29T00:10:00.000Z",
      };
      state.teammateDirectMessages.push(message);
      const providerPresetId = typeof body.providerPresetId === "string" ? body.providerPresetId : typeof teammate.providerPresetId === "string" ? teammate.providerPresetId : undefined;
      const provider = providerPresetId ? state.providers.find((item) => isRecord(item) && item.id === providerPresetId) : undefined;
      const blockedReason = teammate.status !== "active"
        ? `Teammate status is ${String(teammate.status)}.`
        : !providerPresetId
          ? "No provider preset is selected for this teammate."
          : !isRecord(provider) || !isRecord(provider.lastCheck) || provider.lastCheck.ok !== true
            ? "Provider preflight is not ready."
            : "";
      const aiReply = body.requestAiReply === true
        ? {
            id: `tdmsg_${state.teammateDirectMessages.length + 1}`,
            workspaceId: "workspace_default",
            threadId: thread.id,
            teammateId,
            authorType: "ai-teammate",
            authorId: teammateId,
            body: blockedReason ? `AI teammate is blocked: ${blockedReason}` : "Private reply: I will refine this into a scoped task.",
            attachmentIds: [],
            status: blockedReason ? "blocked" : "ready",
            errorMessage: blockedReason || undefined,
            createdAt: "2026-05-29T00:10:01.000Z",
            updatedAt: "2026-05-29T00:10:01.000Z",
          }
        : undefined;
      if (aiReply) {
        state.teammateDirectMessages.push(aiReply);
      }
      await route.fulfill({ status: 201, json: aiReply ? { message, aiReply } : { message } });
      return;
    }
    if (action === "tasks" && request.method() === "GET") {
      const tasks = state.tasks.filter((task) => isRecord(task) && task.assigneeTeammateId === teammateId);
      await route.fulfill({ json: { cwd, tasks } });
      return;
    }
    if (action === "activity" && request.method() === "GET") {
      const directItems = state.teammateDirectMessages
        .filter((item) => isRecord(item) && item.teammateId === teammateId)
        .map((item) => ({
          id: `direct-message:${item.id}`,
          kind: "direct-message",
          title: item.authorType === "ai-teammate" ? "AI teammate replied" : "Private message",
          subtitle: typeof item.body === "string" ? item.body : "",
          status: typeof item.status === "string" ? item.status : "ready",
          createdAt: typeof item.createdAt === "string" ? item.createdAt : "2026-05-29T00:10:00.000Z",
          sourceId: item.id,
        }));
      const taskItems = state.tasks
        .filter((task) => isRecord(task) && task.assigneeTeammateId === teammateId)
        .map((task) => ({
          id: `task:${task.id}`,
          kind: "task",
          title: typeof task.title === "string" ? task.title : "Task",
          subtitle: typeof task.prompt === "string" ? task.prompt : "",
          status: typeof task.status === "string" ? task.status : "todo",
          createdAt: typeof task.createdAt === "string" ? task.createdAt : "2026-05-29T00:10:00.000Z",
          sourceId: task.id,
        }));
      await route.fulfill({
        json: {
          cwd,
          teammateId,
          items: [...directItems, ...taskItems].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
        },
      });
      return;
    }
  }
  if (request.method() === "POST" && path === "/provider-check") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const needsApiKey = body.api === "anthropic-messages" || body.authHeader !== false;
    const hasApiKey = typeof body.apiKey === "string" && body.apiKey.trim().length > 0;
    const hasConfiguredRef = body.apiKeyRef === "env:LOCAL_RELAY_API_KEY";
    if (needsApiKey && !hasApiKey && !hasConfiguredRef) {
      await route.fulfill({
        json: {
          ok: false,
          code: "secret_missing",
          message: "API key missing. Add an API key before running a live check.",
          checkedAt: "2026-05-25T00:11:00.000Z",
        },
      });
      return;
    }
    if (
      typeof body.providerId === "string" &&
      options.providerCheckModelUnsupportedProviderIds?.includes(body.providerId)
    ) {
      await route.fulfill({
        json: {
          ok: false,
          code: "model_unsupported",
          message: "Provider rejected the endpoint or model with HTTP 404. Check baseUrl and model.",
          checkedAt: "2026-05-25T00:11:00.000Z",
        },
      });
      return;
    }
    await route.fulfill({ json: buildProviderCheckResult(createProviderFromBody(body, "provider_draft_check")) });
    return;
  }
  if (request.method() === "POST" && path === "/provider-models") {
    if (options.providerModelsUnsupported) {
      await route.fulfill({ status: 404, json: { error: "not_found", message: "No route for POST /provider-models" } });
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    if (body.providerId === "doubao" && body.apiKey === "ark-test-key") {
      await route.fulfill({
        json: {
          source: "https://ark.cn-beijing.volces.com/api/v3/models",
          models: [
            { id: "doubao-seedream-5-0-260128", ownedBy: "volcengine" },
            { id: "doubao-seedance-1-0-pro-250528", ownedBy: "volcengine" },
            { id: "doubao-1-5-pro-32k-250115", ownedBy: "volcengine" },
          ],
        },
      });
      return;
    }
    if (body.api === "media-job" && body.providerId === "seedream" && body.apiKey === "ark-media-key") {
      await route.fulfill({
        json: {
          source: "https://ark.cn-beijing.volces.com/api/v3/models",
          models: [
            { id: "doubao-seedream-5-0-260128", ownedBy: "volcengine" },
            { id: "doubao-seedream-5-0-turbo-260128", ownedBy: "volcengine" },
            { id: "doubao-seedance-1-0-pro-250528", ownedBy: "volcengine" },
            { id: "doubao-1-5-pro-32k-250115", ownedBy: "volcengine" },
          ],
        },
      });
      return;
    }
    if (body.api === "media-job" && body.providerId === "seedance" && body.apiKey === "ark-media-key") {
      await route.fulfill({
        json: {
          source: "https://ark.cn-beijing.volces.com/api/v3/models",
          models: [
            { id: "doubao-seedream-5-0-260128", ownedBy: "volcengine" },
            { id: "doubao-seedance-1-0-pro-250528", ownedBy: "volcengine" },
            { id: "doubao-1-5-pro-32k-250115", ownedBy: "volcengine" },
          ],
        },
      });
      return;
    }
    if (body.baseUrl !== "https://api.example.com/v1" || body.apiKey !== "test-visible-key") {
      await route.fulfill({ status: 400, json: { error: "unexpected_model_probe", body } });
      return;
    }
    await route.fulfill({
      json: {
        source: "https://api.example.com/v1/models",
        models: [
          { id: "cliproxy-gpt-4o", ownedBy: "cliproxy" },
          { id: "doubao-seedream-5-0-260128", ownedBy: "volcengine" },
          { id: "doubao-seedance-1-0-pro-250528", ownedBy: "volcengine" },
          { id: "doubao-1-5-pro-32k-250115", ownedBy: "volcengine" },
          { id: "cliproxy-claude-sonnet", ownedBy: "cliproxy" },
        ],
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/providers") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const provider = createProviderFromBody(body, `provider_created_${state.providers.length + 1}`);
    state.providers.push(provider);
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      state.providerSecrets[String(provider.id)] = body.apiKey;
    }
    await route.fulfill({ status: 201, json: { provider } });
    return;
  }
  const providerSecretMatch = /^\/providers\/([^/]+)\/secret$/.exec(path);
  if (providerSecretMatch && request.method() === "GET") {
    const providerId = decodeURIComponent(providerSecretMatch[1]);
    const provider = state.providers.find((item) => isRecord(item) && item.id === providerId);
    if (!provider || !isRecord(provider)) {
      await route.fulfill({ status: 404, json: { error: "provider_not_found" } });
      return;
    }
    await route.fulfill({
      json: {
        providerId,
        apiKey: state.providerSecrets[providerId] ?? "",
        apiKeyRef: typeof provider.apiKeyRef === "string" ? provider.apiKeyRef : undefined,
        configured: Boolean(state.providerSecrets[providerId]),
      },
    });
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
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      state.providerSecrets[providerId] = body.apiKey;
    }
    if (body.clearApiKey === true) {
      delete state.providerSecrets[providerId];
    }
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
    if (
      typeof provider.providerId === "string" &&
      options.providerCheckModelUnsupportedProviderIds?.includes(provider.providerId)
    ) {
      const result = {
        ok: false,
        code: "model_unsupported",
        message: "Provider rejected the endpoint or model with HTTP 404. Check baseUrl and model.",
        checkedAt: "2026-05-25T00:11:00.000Z",
      };
      provider.lastCheck = result;
      provider.updatedAt = result.checkedAt;
      await route.fulfill({ json: result });
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
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
    const limit = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : 200, 1), 500);
    const beforeMessageId = url.searchParams.get("beforeMessageId");
    state.channelMessageQueries?.push({
      channelId,
      limit,
      beforeMessageId: beforeMessageId ?? undefined,
    });
    const messages = state.channelMessages
      .filter((message) => isRecord(message) && message.channelId === channelId)
      .sort((left, right) => {
        if (!isRecord(left) || !isRecord(right)) {
          return 0;
        }
        const leftCreatedAt = typeof left.createdAt === "string" ? left.createdAt : "";
        const rightCreatedAt = typeof right.createdAt === "string" ? right.createdAt : "";
        return leftCreatedAt.localeCompare(rightCreatedAt);
      });
    const pendingReplyById = state.pendingChannelAiReplies ?? {};
    for (const message of messages) {
      if (!isRecord(message) || message.status !== "pending") {
        continue;
      }
      const readyBody = typeof message.id === "string" ? pendingReplyById[message.id] : undefined;
      if (readyBody) {
        message.body = readyBody;
        message.status = "ready";
        message.updatedAt = "2026-05-25T00:18:02.000Z";
        delete pendingReplyById[message.id];
      }
    }
    const beforeIndex = beforeMessageId
      ? messages.findIndex((message) => isRecord(message) && message.id === beforeMessageId)
      : messages.length;
    if (beforeMessageId && beforeIndex < 0) {
      await route.fulfill({ status: 400, json: { error: "bad_request", message: `Invalid channel message cursor: ${beforeMessageId}` } });
      return;
    }
    const pageEnd = beforeIndex;
    const pageStart = Math.max(0, pageEnd - limit);
    const pageMessages = messages.slice(pageStart, pageEnd);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        messages: pageMessages,
        hasMore: pageStart > 0,
        nextBeforeMessageId: pageStart > 0 && isRecord(pageMessages[0]) && typeof pageMessages[0].id === "string" ? pageMessages[0].id : undefined,
      },
    });
    return;
  }
  if (channelMessagesMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelMessagesMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    state.lastChannelMessageRequest = body;
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
      threadId: typeof body.threadId === "string" ? body.threadId : undefined,
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
          threadId: message.threadId ?? message.id,
          kind: "ai_reply",
          intent: "discuss",
          authorType: "ai-teammate",
          authorId: "engineer",
          body: "AI teammate is preparing a reply...",
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          status: "pending",
          createdAt: "2026-05-25T00:18:01.000Z",
          updatedAt: "2026-05-25T00:18:01.000Z",
        }
      : undefined;
    if (aiReply) {
      state.channelMessages.push(aiReply);
      state.pendingChannelAiReplies ??= {};
      state.pendingChannelAiReplies[aiReply.id] = "收到，我会按频道上下文推进。";
    }
    await route.fulfill({ status: 201, json: aiReply ? { message, aiReply } : { message } });
    return;
  }
  const channelProposalsMatch = /^\/channels\/([^/]+)\/proposals$/.exec(path);
  if (channelProposalsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelProposalsMatch[1]);
    await route.fulfill({
      json: {
        cwd,
        channelId,
        proposals: state.channelExecutionProposals.filter((proposal) => isRecord(proposal) && proposal.channelId === channelId),
      },
    });
    return;
  }
  if (channelProposalsMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelProposalsMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    const proposal = {
      id: `proposal_${state.channelExecutionProposals.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      sourceMessageId: typeof body.sourceMessageId === "string" ? body.sourceMessageId : "",
      proposedByTeammateId: typeof body.proposedByTeammateId === "string" ? body.proposedByTeammateId : "engineer",
      title: typeof body.title === "string" ? body.title : "Proposed task",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      assigneeTeammateId: typeof body.assigneeTeammateId === "string" ? body.assigneeTeammateId : "engineer",
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [],
      collaborationSteps: Array.isArray(body.collaborationSteps) ? body.collaborationSteps : [],
      requiredTools: Array.isArray(body.requiredTools) ? body.requiredTools : [],
      riskSummary: typeof body.riskSummary === "string" ? body.riskSummary : undefined,
      status: "draft",
      createdAt: "2026-05-25T00:18:03.000Z",
      updatedAt: "2026-05-25T00:18:03.000Z",
    };
    state.channelExecutionProposals.unshift(proposal);
    await route.fulfill({ status: 201, json: { proposal } });
    return;
  }
  const channelProposalMatch = /^\/channel-proposals\/([^/]+)$/.exec(path);
  if (channelProposalMatch && request.method() === "PATCH") {
    const proposalId = decodeURIComponent(channelProposalMatch[1]);
    const body = await request.postDataJSON() as Record<string, unknown>;
    let updated: unknown;
    state.channelExecutionProposals = state.channelExecutionProposals.map((proposal) => {
      if (!isRecord(proposal) || proposal.id !== proposalId) {
        return proposal;
      }
      updated = {
        ...proposal,
        ...body,
        riskSummary: body.riskSummary === null ? undefined : body.riskSummary ?? proposal.riskSummary,
        linkedTaskId: body.linkedTaskId === null ? undefined : body.linkedTaskId ?? proposal.linkedTaskId,
        linkedRunId: body.linkedRunId === null ? undefined : body.linkedRunId ?? proposal.linkedRunId,
        errorMessage: body.errorMessage === null ? undefined : body.errorMessage ?? proposal.errorMessage,
        updatedAt: "2026-05-25T00:18:04.000Z",
      };
      return updated;
    });
    await route.fulfill({ status: updated ? 200 : 404, json: updated ? { proposal: updated } : { error: "proposal_not_found" } });
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
    state.teammatePrivateAttachments = state.teammatePrivateAttachments.filter((attachment) => !isRecord(attachment) || attachment.id !== attachmentId);
    state.aiTeammates = state.aiTeammates.map((teammate) =>
      isRecord(teammate) && teammate.avatarImageAttachmentId === attachmentId ? { ...teammate, avatarImageAttachmentId: undefined } : teammate,
    );
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
  if (request.method() === "GET" && path === "/runtime/supervisor") {
    const active = state.workUnits.filter((unit) => isActiveMockWorkUnit(unit.status));
    await route.fulfill({
      json: {
        cwd,
        runtime: createMockRuntime(),
        active,
        stuck: active.filter((unit) => unit.status === "running" && unit.errorCode === "runtime_stuck"),
        queued: state.workUnits.filter((unit) => unit.status === "queued"),
        stale: state.workUnits.filter((unit) => unit.status === "stale"),
        leases: state.resourceLeases.filter((lease) => isRecord(lease) && lease.status === "active"),
        semaphoreSlots: state.runtimeSemaphoreSlots.filter((slot) => slot.status === "active"),
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/runtime/active") {
    await route.fulfill({ json: { cwd, workUnits: state.workUnits.filter((unit) => isActiveMockWorkUnit(unit.status)) } });
    return;
  }
  if (request.method() === "GET" && path === "/runtime/stuck") {
    await route.fulfill({ json: { cwd, workUnits: state.workUnits.filter((unit) => unit.status === "running" && unit.errorCode === "runtime_stuck") } });
    return;
  }
  if (request.method() === "GET" && path === "/runtime/semaphores") {
    await route.fulfill({ json: { cwd, semaphoreSlots: state.runtimeSemaphoreSlots.filter((slot) => slot.status === "active") } });
    return;
  }
  if (request.method() === "GET" && path === "/work-units") {
    const status = url.searchParams.get("status");
    const kind = url.searchParams.get("kind");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const workUnits = state.workUnits
      .filter((unit) => !status || unit.status === status)
      .filter((unit) => !kind || unit.kind === kind)
      .slice(0, Number.isFinite(limit) ? limit : 100);
    await route.fulfill({ json: { cwd, workUnits } });
    return;
  }
  const workUnitRouteMatch = /^\/work-units\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (workUnitRouteMatch) {
    const workUnitId = decodeURIComponent(workUnitRouteMatch[1]);
    const action = workUnitRouteMatch[2];
    const workUnit = state.workUnits.find((unit) => unit.id === workUnitId);
    if (!workUnit) {
      await route.fulfill({ status: 404, json: { error: "work_unit_not_found" } });
      return;
    }
    if (request.method() === "GET" && action === "events") {
      await route.fulfill({
        json: {
          cwd,
          workUnitId,
          events: state.runtimeEventsByWorkUnit[workUnitId] ?? [],
          nextSeq: (state.runtimeEventsByWorkUnit[workUnitId]?.length ?? 0) + 1,
        },
      });
      return;
    }
    if (request.method() === "GET" && !action) {
      await route.fulfill({ json: createMockWorkUnitDetail(state, workUnit) });
      return;
    }
    if (request.method() === "POST" && (action === "cancel" || action === "retry" || action === "reconcile")) {
      const nextStatus = action === "cancel" ? "cancelled" : action === "retry" ? "queued" : "stale";
      const now = "2026-05-25T00:31:00.000Z";
      const updated = { ...workUnit, status: nextStatus, updatedAt: now, endedAt: action === "retry" ? undefined : now };
      state.workUnits = state.workUnits.map((unit) => unit.id === workUnitId ? updated : unit);
      if (action === "cancel" && workUnit.linkedRunId) {
        state.runs = state.runs.map((run) =>
          run.id === workUnit.linkedRunId
            ? { ...run, status: "cancelled", updatedAt: now, endedAt: now, errorMessage: undefined }
            : run
        );
        state.approvals = state.approvals.map((approval) =>
          approval.runId === workUnit.linkedRunId && approval.status === "pending"
            ? { ...approval, status: "cancelled", resolvedAt: now, resolvedBy: "local-user", decisionReason: "Run cancelled from Web" }
            : approval
        );
        state.eventsByRun[workUnit.linkedRunId] = [
          ...(state.eventsByRun[workUnit.linkedRunId] ?? []),
          {
            id: `evt_${workUnit.linkedRunId}_cancelled`,
            runId: workUnit.linkedRunId,
            seq: (state.eventsByRun[workUnit.linkedRunId]?.length ?? 0) + 1,
            ts: now,
            type: "run_cancelled",
            data: { status: "cancelled", reason: "Run cancelled from Web" },
          },
        ];
      }
      const event = {
        id: `runtime_event_${workUnitId}_${(state.runtimeEventsByWorkUnit[workUnitId]?.length ?? 0) + 1}`,
        workUnitId,
        attemptId: updated.activeAttemptId,
        seq: (state.runtimeEventsByWorkUnit[workUnitId]?.length ?? 0) + 1,
        ts: now,
        type: action === "cancel" ? "work_unit_cancelled" : action === "retry" ? "work_unit_queued" : "work_unit_stale",
        actor: "local-user",
        data: { action },
      };
      state.runtimeEventsByWorkUnit[workUnitId] = [...(state.runtimeEventsByWorkUnit[workUnitId] ?? []), event];
      if (state.workUnitActionDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.workUnitActionDelayMs));
      }
      await route.fulfill({ json: { cwd, workUnit: updated, event } });
      return;
    }
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
  if (request.method() === "GET" && path === "/threads") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const archivedFilter = readMockArchivedFilter(url);
    if ("error" in archivedFilter) {
      await route.fulfill({ status: 400, json: { error: archivedFilter.error, message: archivedFilter.message } });
      return;
    }
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const effectiveArchivedFilter = archivedFilter.value ?? (includeArchived || url.searchParams.has("status") ? "include" : "exclude");
    const searchQuery = readMockThreadSearchQuery(url);
    if ("error" in searchQuery) {
      await route.fulfill({ status: 400, json: { error: searchQuery.error, message: searchQuery.message } });
      return;
    }
    const filteredThreads = state.threads
      .filter((thread) => matchesMockArchivedFilter(thread, effectiveArchivedFilter))
      .filter((thread) => filterOptionalSearchParam(url, "kind", thread.kind))
      .filter((thread) => filterOptionalSearchParam(url, "channelId", thread.channelId))
      .filter((thread) => filterOptionalSearchParam(url, "taskId", thread.taskId))
      .filter((thread) => filterOptionalSearchParam(url, "teammateId", thread.teammateId))
      .filter((thread) => filterOptionalSearchParam(url, "workflowStepId", thread.workflowStepId))
      .filter((thread) => filterOptionalSearchParam(url, "externalWorkId", thread.externalWorkId))
      .filter((thread) => filterOptionalSearchParam(url, "status", thread.status))
      .sort((left, right) =>
        Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) ||
        (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id)
      );
    const search = searchQuery.value ? searchMockLingThreads(state, filteredThreads, searchQuery.value) : undefined;
    const threads = (search?.threads ?? filteredThreads)
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50);
    await route.fulfill({
      json: {
        cwd,
        threads,
        ...(search ? { matches: search.matches.filter((match) => threads.some((thread) => thread.id === match.threadId)) } : {}),
      },
    });
    return;
  }

  const threadRouteMatch = /^\/threads\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (threadRouteMatch) {
    const threadId = decodeURIComponent(threadRouteMatch[1]);
    const action = threadRouteMatch[2];
    const thread = state.threads.find((item) => item.id === threadId) ?? deriveMockThreadFromRuns(state, threadId);
    if (!thread) {
      await route.fulfill({ status: 404, json: { error: "thread_not_found" } });
      return;
    }
    if (request.method() === "GET" && !action) {
      await route.fulfill({ json: { cwd, thread } });
      return;
    }
    if (request.method() === "GET" && action === "evidence") {
      await route.fulfill({ json: buildMockThreadEvidence(state, thread) });
      return;
    }
    if (request.method() === "GET" && action === "turns") {
      if (state.failThreadTurnsForThreadIds.includes(threadId)) {
        await route.fulfill({ status: 500, json: { error: "thread_turns_failed" } });
        return;
      }
      const turns = state.turns.filter((turn) => turn.threadId === threadId);
      const turnIds = new Set(turns.map((turn) => turn.id));
      const runLinks = state.turnRunLinks.filter((link) => turnIds.has(link.turnId));
      await route.fulfill({ json: { cwd, threadId, turns, runLinks } });
      return;
    }
    if (request.method() === "POST" && (action === "archive" || action === "unarchive" || action === "pin" || action === "unpin")) {
      let body: Record<string, unknown> = {};
      try {
        body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      const mutation = mutateMockThreadVisibility(state, thread, action, body);
      if ("error" in mutation) {
        await route.fulfill({ status: mutation.status, json: { error: mutation.error, message: mutation.message } });
        return;
      }
      await route.fulfill({ json: { cwd, thread: mutation.thread } });
      return;
    }
    if (request.method() === "POST" && action === "fork-run") {
      let body: Record<string, unknown> = {};
      try {
        body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
      if (!instruction) {
        await route.fulfill({ status: 400, json: { error: "fork_run_instruction_required", message: "Fork-and-run requires a non-empty instruction." } });
        return;
      }
      const userIdempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : "";
      if (!userIdempotencyKey) {
        await route.fulfill({ status: 400, json: { error: "fork_run_idempotency_required", message: "Fork-and-run requires an idempotency key." } });
        return;
      }
      const anchor = resolveMockForkAnchor(state, thread, body);
      if ("error" in anchor) {
        await route.fulfill({ status: anchor.status, json: { error: anchor.error, message: anchor.message } });
        return;
      }
      if (!anchor.sourceRun && typeof body.providerPresetId !== "string") {
        await route.fulfill({ status: 400, json: { error: "fork_run_snapshot_unavailable", message: "No reusable provider snapshot is available." } });
        return;
      }
      const operationKey = `fork-run:${thread.id}:${anchor.sourceTurn?.id ?? ""}:${anchor.sourceRun?.id ?? ""}:${userIdempotencyKey}`;
      const childId = deterministicMockForkThreadId(thread.id, anchor.sourceTurn?.id, anchor.sourceRun?.id, operationKey);
      const now = "2026-05-25T00:42:00.000Z";
      let childThread = state.threads.find((item) => item.id === childId);
      if (!childThread) {
        childThread = {
          id: childId,
          workspaceId: thread.workspaceId,
          kind: thread.kind,
          channelId: thread.channelId,
          taskId: thread.taskId,
          teammateId: thread.teammateId,
          workflowId: thread.workflowId,
          workflowStepId: thread.workflowStepId,
          externalWorkId: thread.externalWorkId,
          title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : `Fork: ${thread.title}`,
          objective: typeof body.objective === "string" && body.objective.trim()
            ? body.objective.trim()
            : `Forked from ${anchor.sourceTurn?.title || thread.title} (${thread.id}) to explore a separate work branch.`,
          status: "open",
          parentThreadId: thread.id,
          parentTurnId: anchor.sourceTurn?.id,
          forkedFromRunId: anchor.sourceRun?.id,
          createdAt: now,
          updatedAt: now,
        };
        state.threads.unshift(childThread);
      }
      const childTurnId = deterministicMockForkRunTurnId(operationKey);
      let childTurn = state.turns.find((item) => item.id === childTurnId);
      if (childTurn && (childTurn.threadId !== childThread.id || childTurn.userInstruction !== instruction)) {
        await route.fulfill({ status: 409, json: { error: "fork_run_child_turn_conflict", message: `Fork-and-run child turn conflicts with an existing turn: ${childTurnId}` } });
        return;
      }
      if (!childTurn) {
        childTurn = {
          id: childTurnId,
          workspaceId: childThread.workspaceId,
          threadId: childThread.id,
          kind: "initial_request",
          status: "running",
          title: titleFromMockInstruction(instruction, "Fork and run"),
          userInstruction: instruction,
          channelId: childThread.channelId,
          taskId: childThread.taskId,
          teammateId: childThread.teammateId,
          workflowStepId: childThread.workflowStepId,
          externalWorkId: childThread.externalWorkId,
          createdByActor: "local-user",
          createdAt: now,
          updatedAt: now,
        };
        state.turns.unshift(childTurn);
      }
      const runId = deterministicMockForkRunRunId(operationKey);
      let childRun = state.runs.find((item) => item.id === runId);
      if (!childRun) {
        const sourceRun = anchor.sourceRun ?? state.runs[0];
        childRun = {
          ...sourceRun,
          id: runId,
          status: "running",
          threadId: childThread.id,
          turnId: childTurn.id,
          taskId: `task_${runId}`,
          channelId: childThread.channelId,
          taskSnapshot: { id: `task_${runId}`, title: childTurn.title, prompt: instruction, channelId: childThread.channelId },
          requestSnapshot: {
            ...(isRecord(sourceRun?.requestSnapshot) ? sourceRun.requestSnapshot : {}),
            cwd,
            providerPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : sourceRun?.providerPresetId ?? "provider_local",
            runnerId: typeof body.runnerId === "string" ? body.runnerId : undefined,
            threadId: childThread.id,
            turnId: childTurn.id,
            idempotencyKey: operationKey,
            task: { id: `task_${runId}`, title: childTurn.title, prompt: instruction, channelId: childThread.channelId },
          },
          eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
          errorMessage: undefined,
          createdAt: now,
          startedAt: now,
          updatedAt: now,
          endedAt: undefined,
        };
        state.runs.unshift(childRun);
        state.eventsByRun[runId] = [];
        state.turnRunLinks.push({
          turnId: childTurn.id,
          runId,
          attemptNumber: 1,
          role: "primary",
          createdAt: now,
        });
      }
      childTurn = { ...childTurn, status: "running", activeRunId: runId, lastRunId: runId, updatedAt: now };
      state.turns = state.turns.map((item) => item.id === childTurn.id ? childTurn : item);
      childThread = { ...childThread, status: "running", activeRunId: runId, lastRunId: runId, updatedAt: now };
      state.threads = state.threads.map((item) => item.id === childThread.id ? childThread : item);
      await route.fulfill({
        status: 202,
        json: {
          cwd,
          sourceThread: thread,
          sourceTurn: anchor.sourceTurn,
          sourceRun: anchor.sourceRun,
          childThread,
          childTurn,
          childRun,
          runId,
          status: "run_started",
        },
      });
      return;
    }
    if (request.method() === "POST" && action === "fork") {
      let body: Record<string, unknown> = {};
      try {
        body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      const anchor = resolveMockForkAnchor(state, thread, body);
      if ("error" in anchor) {
        await route.fulfill({ status: anchor.status, json: { error: anchor.error, message: anchor.message } });
        return;
      }
      const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : undefined;
      const childId = idempotencyKey
        ? deterministicMockForkThreadId(thread.id, anchor.sourceTurn?.id, anchor.sourceRun?.id, idempotencyKey)
        : `thread_fork_${state.threads.length + 1}`;
      const existing = state.threads.find((item) => item.id === childId);
      if (existing) {
        await route.fulfill({
          status: 200,
          json: {
            cwd,
            sourceThread: thread,
            sourceTurn: anchor.sourceTurn,
            sourceRun: anchor.sourceRun,
            childThread: existing,
            lineage: {
              parentThreadId: thread.id,
              parentTurnId: anchor.sourceTurn?.id,
              forkedFromRunId: anchor.sourceRun?.id,
            },
          },
        });
        return;
      }
      const now = "2026-05-25T00:41:00.000Z";
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : `Fork: ${thread.title}`;
      const objective = typeof body.objective === "string" && body.objective.trim()
        ? body.objective.trim()
        : `Forked from ${anchor.sourceTurn?.title || thread.title} (${thread.id}) to explore a separate work branch.`;
      const childThread: MockLingThread = {
        id: childId,
        workspaceId: thread.workspaceId,
        kind: thread.kind,
        channelId: thread.channelId,
        taskId: thread.taskId,
        teammateId: thread.teammateId,
        workflowId: thread.workflowId,
        workflowStepId: thread.workflowStepId,
        externalWorkId: thread.externalWorkId,
        title,
        objective,
        status: "open",
        parentThreadId: thread.id,
        parentTurnId: anchor.sourceTurn?.id,
        forkedFromRunId: anchor.sourceRun?.id,
        createdAt: now,
        updatedAt: now,
      };
      state.threads.unshift(childThread);
      await route.fulfill({
        status: 201,
        json: {
          cwd,
          sourceThread: thread,
          sourceTurn: anchor.sourceTurn,
          sourceRun: anchor.sourceRun,
          childThread,
          lineage: {
            parentThreadId: thread.id,
            parentTurnId: anchor.sourceTurn?.id,
            forkedFromRunId: anchor.sourceRun?.id,
          },
        },
      });
      return;
    }
    if (request.method() === "POST" && (action === "resume-preview" || action === "resume")) {
      let body: Record<string, unknown> = {};
      try {
        body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      const anchor = resolveMockResumeAnchor(state, thread, body);
      if ("error" in anchor) {
        await route.fulfill({ status: anchor.status, json: { error: anchor.error, message: anchor.message } });
        return;
      }
      const { sourceRun, sourceTurn } = anchor;
      const activeRun = thread.activeRunId ? state.runs.find((item) => item.id === thread.activeRunId) : undefined;
      const hasActiveRun = Boolean(activeRun && isMockRunActive(activeRun));
      const hasActiveTurn = Boolean(sourceTurn && isMockTurnActiveForResume(state, sourceTurn));
      const context = buildMockResumeContext(state, thread, sourceTurn, sourceRun, body, hasActiveRun, hasActiveTurn);
      if (action === "resume-preview") {
        await route.fulfill({ json: { cwd, thread, sourceRun, context } });
        return;
      }
      if (hasActiveRun) {
        await route.fulfill({ status: 400, json: { error: "thread_active", message: `Thread already has an active run: ${activeRun?.id}` } });
        return;
      }
      if (hasActiveTurn) {
        await route.fulfill({ status: 409, json: { error: "turn_active", message: `Selected turn is not terminal: ${sourceTurn?.id}` } });
        return;
      }
      const now = "2026-05-25T00:40:00.000Z";
      const runId = `run_resume_${state.runs.length + 1}`;
      const linkedSourceTurn = sourceTurn ?? findMockTurnForRun(state, sourceRun.id);
      const childTurnId = linkedSourceTurn ? `turn_resume_${state.turns.length + 1}` : undefined;
      const continuationRun: MockRun = {
        ...sourceRun,
        id: runId,
        status: "queued",
        turnId: childTurnId,
        parentRunId: sourceRun.id,
        continuationReason: "manual_resume",
        taskSnapshot: { id: `task_${runId}`, title: `Resume: ${thread.title}`, prompt: context.contextText },
        requestSnapshot: {
          ...(isRecord(sourceRun.requestSnapshot) ? sourceRun.requestSnapshot : {}),
          task: { id: `task_${runId}`, title: `Resume: ${thread.title}`, prompt: context.contextText },
          turnId: childTurnId,
          parentRunId: sourceRun.id,
          continuationReason: "manual_resume",
        },
        eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
        errorMessage: undefined,
        createdAt: now,
        startedAt: undefined,
        updatedAt: now,
        endedAt: undefined,
      };
      state.runs.unshift(continuationRun);
      state.eventsByRun[runId] = [];
      if (linkedSourceTurn && childTurnId) {
        state.turns.unshift({
          id: childTurnId,
          workspaceId: linkedSourceTurn.workspaceId,
          threadId: thread.id,
          kind: "manual_followup",
          status: "running",
          title: `Resume: ${thread.title}`,
          userInstruction: context.contextText,
          channelId: linkedSourceTurn.channelId ?? thread.channelId,
          taskId: linkedSourceTurn.taskId ?? thread.taskId,
          teammateId: linkedSourceTurn.teammateId ?? thread.teammateId,
          workflowStepId: linkedSourceTurn.workflowStepId ?? thread.workflowStepId,
          externalWorkId: linkedSourceTurn.externalWorkId ?? thread.externalWorkId,
          sourceTurnId: linkedSourceTurn.id,
          activeRunId: runId,
          lastRunId: runId,
          createdByActor: "local-user",
          createdAt: now,
          updatedAt: now,
        });
        state.turnRunLinks.push({
          turnId: childTurnId,
          runId,
          attemptNumber: 1,
          role: "resume",
          createdAt: now,
        });
      }
      const updatedThread = { ...thread, status: "running", activeRunId: runId, lastRunId: runId, updatedAt: now };
      state.threads = state.threads.some((item) => item.id === thread.id)
        ? state.threads.map((item) => item.id === thread.id ? updatedThread : item)
        : [updatedThread, ...state.threads];
      await route.fulfill({ status: 202, json: { cwd, thread: updatedThread, sourceRun, runId, continuationReason: "manual_resume" } });
      return;
    }
  }
  if (request.method() === "POST" && path === "/tasks") {
    if (state.failNextTaskCreate) {
      state.failNextTaskCreate = false;
      await route.fulfill({ status: 500, json: { error: "task_create_failed" } });
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    const task = {
      id: `task_${state.tasks.length + 1}`,
      workspaceId: "workspace_default",
      channelId: typeof body.channelId === "string" ? body.channelId : "channel_engineering",
      title: typeof body.title === "string" ? body.title : "New task",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      status: "todo",
      assigneeTeammateId: typeof body.assigneeTeammateId === "string" ? body.assigneeTeammateId : undefined,
      requestedSkillId: typeof body.requestedSkillId === "string" ? body.requestedSkillId : undefined,
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
  if (request.method() === "GET" && path === "/work-items") {
    const channelId = url.searchParams.get("channelId");
    const status = url.searchParams.get("status");
    const sourceType = url.searchParams.get("sourceType");
    const assigneeTeammateId = url.searchParams.get("assigneeTeammateId");
    const limit = Number(url.searchParams.get("limit") ?? "0");
    const workItems = state.workItems
      .filter((item) =>
        (!channelId || item.channelId === channelId) &&
        (!status || item.status === status) &&
        (!sourceType || item.sourceType === sourceType) &&
        (!assigneeTeammateId || item.assigneeTeammateId === assigneeTeammateId)
      )
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);
    await route.fulfill({ json: { cwd, workItems } });
    return;
  }
  const workItemMatch = /^\/work-items\/([^/]+)(?:\/(route|claim|heartbeat|release|complete|fail))?$/.exec(path);
  if (workItemMatch) {
    const workItemId = decodeURIComponent(workItemMatch[1]);
    const action = workItemMatch[2];
    const workItem = state.workItems.find((item) => item.id === workItemId);
    if (!workItem) {
      await route.fulfill({ status: 404, json: { error: "work_item_not_found", message: "Work item not found." } });
      return;
    }
    if (!action && request.method() === "GET") {
      await route.fulfill({ json: { cwd, workItem } });
      return;
    }
    if (request.method() !== "POST") {
      await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = request.postDataJSON();
      body = isRecord(parsed) ? parsed : {};
    } catch {
      body = {};
    }
    const now = "2026-06-07T00:00:00.000Z";
    if (action === "route") {
      if (typeof body.channelId === "string") {
        workItem.channelId = body.channelId;
      }
      if (body.priority === "low" || body.priority === "normal" || body.priority === "high" || body.priority === "urgent") {
        workItem.priority = body.priority;
      }
      if (typeof body.assigneeTeammateId === "string" || body.assigneeTeammateId === null) {
        workItem.assigneeTeammateId = body.assigneeTeammateId ?? undefined;
      }
      workItem.updatedAt = now;
      await route.fulfill({ json: { cwd, workItem } });
      return;
    }
    if (action === "claim") {
      const activeClaim = workItem.claim && workItem.claim.expiresAt > now;
      if (activeClaim) {
        await route.fulfill({
          json: {
            cwd,
            workItem,
            blocker: {
              code: "already_claimed",
              message: "Work item is already claimed.",
              claimedBy: workItem.claim?.ownerId,
              claimExpiresAt: workItem.claim?.expiresAt,
            },
          },
        });
        return;
      }
      const token = `claim_${workItem.id}`;
      workItem.claim = {
        ownerId: typeof body.ownerId === "string" && body.ownerId.trim() ? body.ownerId : "web-user",
        token,
        claimedAt: now,
        heartbeatAt: now,
        expiresAt: "2026-06-07T00:05:00.000Z",
      };
      workItem.status = "running";
      workItem.attemptCount += 1;
      workItem.updatedAt = now;
      await route.fulfill({ json: { cwd, workItem, claimToken: token } });
      return;
    }
    if (action === "heartbeat") {
      if (!workItem.claim || body.claimToken !== workItem.claim.token) {
        await route.fulfill({ status: 409, json: { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." } });
        return;
      }
      workItem.claim = {
        ...workItem.claim,
        heartbeatAt: "2026-06-07T00:01:00.000Z",
        expiresAt: "2026-06-07T00:06:00.000Z",
      };
      workItem.updatedAt = workItem.claim.heartbeatAt;
      await route.fulfill({ json: { cwd, workItem } });
      return;
    }
    if (action === "release") {
      if (!workItem.claim || body.claimToken !== workItem.claim.token) {
        await route.fulfill({ status: 409, json: { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." } });
        return;
      }
      delete workItem.claim;
      workItem.status = "ready";
      workItem.updatedAt = now;
      await route.fulfill({ json: { cwd, workItem } });
      return;
    }
    if (action === "complete") {
      if (!workItem.claim || body.claimToken !== workItem.claim.token) {
        await route.fulfill({ status: 409, json: { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." } });
        return;
      }
      workItem.status = "done";
      workItem.proofArtifactIds = Array.isArray(body.proofArtifactIds) ? body.proofArtifactIds.filter((item): item is string => typeof item === "string") : workItem.proofArtifactIds;
      workItem.completedAt = now;
      workItem.updatedAt = now;
      delete workItem.claim;
      await route.fulfill({ json: { cwd, workItem } });
      return;
    }
    if (action === "fail") {
      if (!workItem.claim || body.claimToken !== workItem.claim.token) {
        await route.fulfill({ status: 409, json: { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." } });
        return;
      }
      workItem.status = body.retry === true ? "ready" : "blocked";
      workItem.failureReason = typeof body.reason === "string" ? body.reason : "failed";
      workItem.failedAt = now;
      workItem.updatedAt = now;
      delete workItem.claim;
      await route.fulfill({ json: { cwd, workItem } });
      return;
    }
  }
  if (request.method() === "GET" && path === "/external-work/status") {
    await route.fulfill({ json: state.externalWorkStatus });
    return;
  }
  if (request.method() === "POST" && path === "/external-work/workflow/configure") {
    let body: unknown = {};
    try {
      body = request.postDataJSON();
    } catch {
      body = {};
    }
    const sourceKind = isRecord(body) && body.sourceKind === "linear" ? "linear" : "github";
    const repository = isRecord(body) && typeof body.repository === "string" ? body.repository : "openclaw/openclaw";
    const projectSlug = isRecord(body) && typeof body.projectSlug === "string" ? body.projectSlug : "ling-stack";
    state.externalWorkWorkflowConfigureCalls += 1;
    state.lastExternalWorkWorkflowConfigure = {
      channelId: isRecord(body) ? body.channelId : undefined,
      sourceKind,
      repository,
      projectSlug,
    };
    state.externalWorkStatus = {
      ...state.externalWorkStatus,
      workflow: {
        path: `${cwd}/WORKFLOW.md`,
        exists: true,
        valid: true,
        sourceKind,
        ...(sourceKind === "linear" ? { projectSlug } : { repository }),
        events: sourceKind === "linear" ? ["issue.created"] : ["pull_request.opened", "pull_request.synchronize", "issue.opened"],
      },
      secret: {
        status: "not_required",
      },
      background: sourceKind === "linear"
        ? { supported: false, running: false, status: "unsupported" }
        : { supported: true, running: false, status: "not_configured" },
    };
    await route.fulfill({
      json: {
        cwd,
        channelId: readNestedString(state.externalWorkStatus, ["channel", "id"]) ?? "channel_engineering",
        sourceKind,
        workflow: state.externalWorkStatus.workflow,
        workflowCreated: true,
        workflowUpdated: true,
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/external-work/secrets/configure") {
    let body: unknown = {};
    try {
      body = request.postDataJSON();
    } catch {
      body = {};
    }
    const sourceKind = readNestedString(state.externalWorkStatus, ["workflow", "sourceKind"]) === "linear" ? "linear" : "github";
    const secretRef = sourceKind === "linear"
      ? "keychain:LING_STACK_LINEAR_LING_STACK_TOKEN"
      : "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN";
    state.externalWorkSecretConfigureCalls += 1;
    state.lastExternalWorkSecretConfigure = {
      channelId: isRecord(body) ? body.channelId : undefined,
      tokenLength: isRecord(body) && typeof body.token === "string" ? body.token.length : 0,
    };
    state.externalWorkStatus = {
      ...state.externalWorkStatus,
      workflow: {
        ...(isRecord(state.externalWorkStatus.workflow) ? state.externalWorkStatus.workflow : {}),
        secretRef,
      },
      secret: {
        ref: secretRef,
        purpose: sourceKind === "linear" ? "linear_token" : "github_token",
        status: "configured",
      },
    };
    await route.fulfill({
      json: {
        cwd,
        channelId: readNestedString(state.externalWorkStatus, ["channel", "id"]) ?? "channel_engineering",
        sourceKind,
        secretRef,
        secret: state.externalWorkStatus.secret,
        workflow: state.externalWorkStatus.workflow,
        workflowUpdated: true,
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/external-work/secrets/delete") {
    const sourceKind = readNestedString(state.externalWorkStatus, ["workflow", "sourceKind"]) === "linear" ? "linear" : "github";
    const secretRef = readNestedString(state.externalWorkStatus, ["secret", "ref"]) ?? readNestedString(state.externalWorkStatus, ["workflow", "secretRef"]) ?? "keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN";
    state.externalWorkSecretDeleteCalls += 1;
    state.externalWorkStatus = {
      ...state.externalWorkStatus,
      secret: {
        ref: secretRef,
        purpose: sourceKind === "linear" ? "linear_token" : "github_token",
        status: "missing",
        message: `Secret is not configured: ${secretRef}`,
      },
    };
    await route.fulfill({
      json: {
        cwd,
        channelId: readNestedString(state.externalWorkStatus, ["channel", "id"]) ?? "channel_engineering",
        sourceKind,
        secretRef,
        secret: state.externalWorkStatus.secret,
        workflow: state.externalWorkStatus.workflow,
        workflowUpdated: false,
      },
    });
    return;
  }
  if (request.method() === "POST" && (path === "/external-work/github/poll" || path === "/external-work/linear/poll")) {
    const source = path.includes("/linear/") ? "linear" : "github";
    state.externalWorkPollCalls[source] = (state.externalWorkPollCalls[source] ?? 0) + 1;
    await route.fulfill({
      json: {
        candidates: 1,
        claimed: 1,
        duplicates: 0,
        blocked: 0,
        retryScheduled: 0,
        terminalIgnored: 0,
        artifacts: [],
        results: [{ action: "claimed", identifier: source === "linear" ? "LIN-123" : "openclaw/openclaw#42" }],
        schedulerStates: [],
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/external-work/reconcile") {
    state.externalWorkReconcileCalls += 1;
    await route.fulfill({ json: { expiredLeases: 0, checked: 1, blocked: 0, retryReady: 0, terminal: 0, schedulerStates: [] } });
    return;
  }
  if (request.method() === "POST" && path === "/external-work/github/background/start") {
    state.externalWorkBackgroundStartCalls += 1;
    state.externalWorkStatus = {
      ...state.externalWorkStatus,
      background: {
        supported: true,
        running: true,
        schedulerId: "external_work_background_1",
        status: "running",
        lastTickAt: "2026-06-01T00:00:00.000Z",
        nextPollAt: "2026-06-01T00:00:30.000Z",
      },
    };
    await route.fulfill({ json: { cwd, scheduler: state.externalWorkStatus.background, duplicate: false } });
    return;
  }
  const backgroundStopMatch = /^\/external-work\/background\/([^/]+)\/stop$/.exec(path);
  if (request.method() === "POST" && backgroundStopMatch) {
    state.externalWorkBackgroundStopCalls += 1;
    state.externalWorkStatus = {
      ...state.externalWorkStatus,
      background: {
        supported: true,
        running: false,
        schedulerId: decodeURIComponent(backgroundStopMatch[1]),
        status: "stopped",
      },
    };
    await route.fulfill({ json: { cwd, scheduler: state.externalWorkStatus.background, duplicate: false } });
    return;
  }
  if (request.method() === "GET" && path === "/external-work/github/ci/triage") {
    const externalWorkId = url.searchParams.get("externalWorkId");
    const channelId = url.searchParams.get("channelId");
    const status = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const records = state.externalWorkCiTriage
      .filter((record) => !externalWorkId || record.triage.externalWorkId === externalWorkId)
      .filter((record) => !channelId || record.triage.channelId === channelId)
      .filter((record) => !status || record.triage.status === status)
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50);
    await route.fulfill({ json: { cwd, records } });
    return;
  }
  const ciTriageRunMatch = /^\/external-work\/github\/ci\/triage\/([^/]+)\/run$/.exec(path);
  if (request.method() === "POST" && ciTriageRunMatch) {
    const triageId = decodeURIComponent(ciTriageRunMatch[1]);
    state.ciTriageRunCalls[triageId] = (state.ciTriageRunCalls[triageId] ?? 0) + 1;
    await route.fulfill({ status: 400, json: { error: "unexpected_ci_run", message: "CI fix runs are not started by this Web smoke." } });
    return;
  }
  const ciTriageDetailMatch = /^\/external-work\/github\/ci\/triage\/([^/]+)$/.exec(path);
  if (request.method() === "GET" && ciTriageDetailMatch) {
    const triageId = decodeURIComponent(ciTriageDetailMatch[1]);
    const record = state.externalWorkCiTriage.find((item) => item.triage.id === triageId);
    await route.fulfill({
      status: record ? 200 : 404,
      json: record ? { cwd, record } : { error: "ci_triage_not_found" },
    });
    return;
  }
  if (request.method() === "GET" && path === "/external-work/actions") {
    const externalWorkId = url.searchParams.get("externalWorkId");
    const channelId = url.searchParams.get("channelId");
    const status = url.searchParams.get("status");
    const actions = state.externalWorkActions
      .filter((action) => !externalWorkId || action.externalWorkId === externalWorkId)
      .filter((action) => !channelId || action.channelId === channelId)
      .filter((action) => !status || action.status === status)
      .map((action) => buildMockExternalActionView(state, action));
    await route.fulfill({ json: { cwd, actions } });
    return;
  }

  const externalActionMatch = /^\/external-work\/actions\/([^/]+)$/.exec(path);
  if (request.method() === "GET" && externalActionMatch) {
    const action = state.externalWorkActions.find((item) => item.id === decodeURIComponent(externalActionMatch[1]));
    await route.fulfill({
      status: action ? 200 : 404,
      json: action ? { cwd, action: buildMockExternalActionView(state, action) } : { error: "external_work_action_not_found" },
    });
    return;
  }

  const externalActionCancelMatch = /^\/external-work\/actions\/([^/]+)\/cancel$/.exec(path);
  if (request.method() === "POST" && externalActionCancelMatch) {
    const action = state.externalWorkActions.find((item) => item.id === decodeURIComponent(externalActionCancelMatch[1]));
    if (!action || !["proposed", "waiting_for_approval", "approved"].includes(action.status)) {
      await route.fulfill({ status: 400, json: { error: "external_action_not_cancellable", message: "External action cannot be cancelled." } });
      return;
    }
    action.status = "cancelled";
    action.updatedAt = "2026-05-26T00:02:00.000Z";
    const artifact: MockArtifact = {
      id: `artifact_${action.id}_cancelled`,
      externalWorkId: action.externalWorkId,
      type: "json",
      path: `external-work/${action.externalWorkId}/actions/${action.id}/cancelled.json`,
      title: "Action cancelled",
      contentType: "application/json; charset=utf-8",
      sizeBytes: 96,
      createdAt: action.updatedAt,
    };
    action.artifactIds = [...action.artifactIds, artifact.id];
    state.artifactsByExternalAction[action.id] = [...(state.artifactsByExternalAction[action.id] ?? []), artifact];
    const approval = action.approvalId ? state.approvals.find((item) => item.id === action.approvalId) : undefined;
    if (approval && approval.status === "pending") {
      approval.status = "denied";
      approval.resolvedAt = action.updatedAt;
      approval.resolvedBy = "local-user";
      approval.decisionReason = "Cancelled from Web";
    }
    await route.fulfill({ json: { cwd, action, approval, artifacts: state.artifactsByExternalAction[action.id] ?? [] } });
    return;
  }

  const externalActionExecuteMatch = /^\/external-work\/actions\/([^/]+)\/execute$/.exec(path);
  if (request.method() === "POST" && externalActionExecuteMatch) {
    const action = state.externalWorkActions.find((item) => item.id === decodeURIComponent(externalActionExecuteMatch[1]));
    if (!action || action.status !== "approved") {
      await route.fulfill({ status: 400, json: { error: "external_action_not_executable", message: "External action is not approved." } });
      return;
    }
    state.externalActionExecuteCalls[action.id] = (state.externalActionExecuteCalls[action.id] ?? 0) + 1;
    action.status = "succeeded";
    action.executionAttemptCount += 1;
    action.lastAttemptAt = "2026-05-26T00:03:00.000Z";
    action.executedAt = "2026-05-26T00:03:00.000Z";
    action.updatedAt = action.executedAt;
    const artifact: MockArtifact = {
      id: `artifact_${action.id}_execution`,
      externalWorkId: action.externalWorkId,
      type: "json",
      path: `external-work/${action.externalWorkId}/actions/${action.id}/execution-result.json`,
      title: "GitHub action execution result",
      contentType: "application/json; charset=utf-8",
      sizeBytes: 192,
      createdAt: action.executedAt,
    };
    action.artifactIds = [...action.artifactIds, artifact.id];
    state.artifactsByExternalAction[action.id] = [...(state.artifactsByExternalAction[action.id] ?? []), artifact];
    const approval = action.approvalId ? state.approvals.find((item) => item.id === action.approvalId) : undefined;
    await route.fulfill({ json: { cwd, action, approval, artifacts: state.artifactsByExternalAction[action.id] ?? [] } });
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
    if (!liveGate) {
      job.status = "failed";
      job.errorMessage = "当前没有可真实生成的媒体模型，请先在模型工作台配置媒体模型。";
      await route.fulfill({
        status: 400,
        json: {
          error: "live_media_transport_required",
          message: job.errorMessage,
          mediaJob: job,
          artifacts: [],
        },
      });
      return;
    }
    const artifact: MockArtifact = {
      id: `artifact_${job.id}`,
      mediaJobId: job.id,
      type: "image",
      path: `media_jobs/${job.id}/seedream-image.png`,
      title: "Seedream image result",
      contentType: "image/png",
      sizeBytes: 4096,
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

  const runInterventionsMatch = /^\/runs\/([^/]+)\/interventions$/.exec(path);
  if (runInterventionsMatch) {
    const sourceRunId = decodeURIComponent(runInterventionsMatch[1]);
    if (request.method() === "GET") {
      await route.fulfill({
        json: {
          cwd,
          interventions: state.runInterventions
            .filter((item) => item.sourceRunId === sourceRunId)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        },
      });
      return;
    }
    if (request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const mode = body.mode === "interrupt_redirect" ? "interrupt_redirect" : "queue_followup";
      const now = "2026-05-25T00:32:00.000Z";
      const sourceRun = state.runs.find((item) => item.id === sourceRunId);
      if (!sourceRun) {
        await route.fulfill({ status: 404, json: { error: "run_not_found" } });
        return;
      }
      const intervention: MockRunIntervention = {
        id: `intervention_${state.runInterventions.length + 1}`,
        workspaceId: "workspace_default",
        sourceRunId,
        sourceWorkUnitId: sourceRun.workUnitId,
        mode,
        status: mode === "interrupt_redirect" ? "cancelling_source" : "queued",
        instruction: typeof body.instruction === "string" ? body.instruction : "",
        requestedBy: "local-user",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `mock_${state.runInterventions.length + 1}`,
        createdAt: now,
        updatedAt: now,
      };
      state.runInterventions.push(intervention);
      if (mode === "interrupt_redirect") {
        const updatedRun = { ...sourceRun, status: "cancelled", updatedAt: now, endedAt: now };
        state.runs = state.runs.map((item) => item.id === sourceRunId ? updatedRun : item);
        await route.fulfill({ status: 201, json: { cwd, intervention, run: updatedRun } });
        return;
      }
      await route.fulfill({ status: 201, json: { cwd, intervention } });
      return;
    }
  }

  const runInterventionMatch = /^\/run-interventions\/([^/]+)(?:\/cancel)?$/.exec(path);
  if (runInterventionMatch) {
    const interventionId = decodeURIComponent(runInterventionMatch[1]);
    const intervention = state.runInterventions.find((item) => item.id === interventionId);
    if (!intervention) {
      await route.fulfill({ status: 404, json: { error: "run_intervention_not_found" } });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/cancel")) {
      intervention.status = "cancelled";
      intervention.updatedAt = "2026-05-25T00:33:00.000Z";
      intervention.completedAt = intervention.updatedAt;
      intervention.failureReason = "cancelled_by_user";
    }
    await route.fulfill({ json: { cwd, intervention } });
    return;
  }

  const runMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (request.method() === "GET" && runMatch) {
    const run = state.runs.find((item) => item.id === decodeURIComponent(runMatch[1]));
    await route.fulfill({ status: run ? 200 : 404, json: run ?? { error: "not_found" } });
    return;
  }

  const runCancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(path);
  if (request.method() === "POST" && runCancelMatch) {
    const runId = decodeURIComponent(runCancelMatch[1]);
    const now = "2026-05-25T00:31:00.000Z";
    const run = state.runs.find((item) => item.id === runId);
    if (!run) {
      await route.fulfill({ status: 404, json: { error: "run_not_found" } });
      return;
    }
    const updated = { ...run, status: "cancelled", updatedAt: now, endedAt: now, errorMessage: undefined };
    state.runs = state.runs.map((item) => item.id === runId ? updated : item);
    state.approvals = state.approvals.map((approval) =>
      approval.runId === runId && approval.status === "pending"
        ? { ...approval, status: "cancelled", resolvedAt: now, resolvedBy: "local-user", decisionReason: "Run cancelled from Web" }
        : approval
    );
    const event = {
      id: `evt_${runId}_cancelled`,
      runId,
      seq: (state.eventsByRun[runId]?.length ?? 0) + 1,
      ts: now,
      type: "run_cancelled",
      data: { status: "cancelled", reason: "Run cancelled from Web" },
    };
    state.eventsByRun[runId] = [...(state.eventsByRun[runId] ?? []), event];
    if (state.workUnitActionDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.workUnitActionDelayMs));
    }
    await route.fulfill({ json: { cancelled: true, active: false, run: updated, event } });
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
    if (approval.externalWorkActionId) {
      const action = state.externalWorkActions.find((item) => item.id === approval.externalWorkActionId);
      if (action && (action.status === "waiting_for_approval" || action.status === "proposed")) {
        action.status = approval.status === "approved" ? "approved" : "denied";
        action.updatedAt = approval.resolvedAt;
      }
    }
    await route.fulfill({ json: { approval } });
    return;
  }

  await route.fulfill({ status: 404, json: { error: "not_found", path } });
}

export function inferMockChannelAttachment(fileName: string): { readonly kind: string; readonly contentType: string } {
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

export function getOrCreateMockTeammateThread(
  state: MockState,
  teammateId: string,
  teammate: Record<string, unknown>,
): Record<string, unknown> {
  const existing = state.teammateDirectThreads[teammateId];
  if (isRecord(existing)) {
    return existing;
  }
  const thread = {
    id: `tdthread_${teammateId}`,
    workspaceId: "workspace_default",
    teammateId,
    title: typeof teammate.displayName === "string" ? teammate.displayName : teammateId,
    createdAt: "2026-05-29T00:09:30.000Z",
    updatedAt: "2026-05-29T00:09:30.000Z",
  };
  state.teammateDirectThreads[teammateId] = thread;
  return thread;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}
