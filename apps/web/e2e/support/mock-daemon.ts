import { mkdir, readFile } from "node:fs/promises";
import { expect, type Locator, type Page, type Request, type Route } from "@playwright/test";
import {
  buildEffectiveTeammateSkills,
  buildMemoryMarkdownExport,
  normalizeMediaProviderCompat,
  parseMemoryMarkdownImport,
  resolveGenerationProviderRuntimeState,
} from "@ling-stack/core";
import { gstackDefaultSkillPack } from "@ling-stack/core/builtin-skill-packs";
import type { MemoryObject } from "@ling-stack/core";
import type { LingApprovalCheckpoint, LingThreadGoal, LingTraceDetailResponse, LingTraceSpan, LingTraceStatus, ProposedPlanArtifact, RunnerListItem, StartupStatusResponse, UserProfile, WorkflowHandoffIntent, WorkspaceGitStatus, WorkspaceRuntimeSettings } from "@ling-stack/contracts";

export const cwd = "/tmp/ling-stack-workspace";
export const defaultRuntimePolicy = {
  maxConcurrentRuns: 1,
  schedulingMode: "smart",
  writeLockScope: "boundPath",
  allowReadOnlyParallel: true,
  queueOnConflict: true,
};

const defaultSkillGovernancePolicy = {
  generationMode: "semi_auto",
  recordingMode: "user_initiated",
  invocationMode: "explicit_only",
  publishMode: "manual_review",
  bindMode: "manual_review",
};

const defaultSkillSourceUpgradePolicy = {
  workspaceId: "workspace_default",
  mode: "prompt",
  approvedRootIds: [],
  allowNewSkills: false,
  allowGlobalGstackUpgrade: false,
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

const mockCreateAiCouncilRequestKeys = new Set(["displayName", "description", "routingPolicy", "members", "pinned"]);
const mockCreateAiCouncilRoutingPolicyKeys = new Set(["defaultMode", "maxActiveMembers", "notes"]);
const mockCloneAiCouncilRequestKeys = new Set(["displayName", "description", "pinned"]);
const mockUpdateAiCouncilRequestKeys = new Set(["displayName", "description", "status", "pinned"]);
const mockReplaceAiCouncilMemberKeys = new Set(["teammateId", "slotKey", "label", "position", "enabled"]);

export interface MockState {
  providers: unknown[];
  providerSecrets: Record<string, string>;
  managedPlugins: MockManagedPlugin[];
  mcpServers: MockMcpServer[];
  mcpTools: MockMcpTool[];
  teammateMcpBindings: MockTeammateMcpBinding[];
  channels: unknown[];
  failNextChannelCreate?: { readonly error: string; readonly message: string; readonly status?: number };
  channelBranches: unknown[];
  channelWorkspaceGitStatusByChannel: Record<string, WorkspaceGitStatus | MockWorkspaceGitStatusFailure>;
  channelMessages: unknown[];
  channelMessageRouteDecisions: unknown[];
  channelIntentDecisions: unknown[];
  channelExecutionProposals: unknown[];
  channelAttachments: unknown[];
  channelLinkPreviews: unknown[];
  channelBriefs: Record<string, unknown>;
  channelDecisions: unknown[];
  channelHandoffs: unknown[];
  workflowHandoffIntents: WorkflowHandoffIntent[];
  channelContextSummaries: unknown[];
  channelWorkflows: unknown[];
  channelWorkflowSteps: unknown[];
  channelProtocolDrafts: unknown[];
  channelPlaybookCandidates: unknown[];
  channelTeamExpertsByTurn: Record<string, unknown>;
  channelTeamExpertsRequests: Array<{ readonly channelId: string; readonly turnId: string; readonly includeExpired?: boolean }>;
  channelTeamMetricsByChannel: Record<string, unknown>;
  aiTeammates: unknown[];
  aiCouncils: unknown[];
  aiCouncilMembers: unknown[];
  channelCouncilPolicies: unknown[];
  skillRegistryEntries: unknown[];
  skillSourceSnapshots: unknown[];
  skillSourceUpgradePolicy: Record<string, unknown>;
  skillImportDrafts: unknown[];
  skillCandidates: unknown[];
  skillCandidateReviewRecords: unknown[];
  procedureObservationClusters: unknown[];
  governanceNotifications: unknown[];
  teammateChannelMemberships: unknown[];
  teammateSkillBindings: unknown[];
  teammateMemoryScopes: unknown[];
  memoryObjects: unknown[];
  usedMemoryEvents: unknown[];
  memoryMarkdownImportCalls: MockMemoryMarkdownImportCall[];
  teammateDirectThreads: Record<string, unknown>;
  teammateDirectMessages: unknown[];
  teammateDirectInterventions: MockTeammateDirectIntervention[];
  teammateDirectLinkPreviews: unknown[];
  teammatePrivateAttachments: unknown[];
  conversationAttachments: unknown[];
  retentionTombstones: unknown[];
  tasks: unknown[];
  runs: MockRun[];
  eventsByRun: Record<string, MockRunEvent[]>;
  runInterventions: MockRunIntervention[];
  nextStreamEvents?: MockRunEvent[];
  providerCheckDelayMs?: number;
  runResponseDelayMs?: number;
  mediaJobRunDelayMs?: number;
  channelMessageDelayMs?: number;
  governanceNotificationDelayMs?: number;
  channelAiReplyBody?: string;
  keepChannelAiReplyPending?: boolean;
  failNextChannelMessage?: boolean;
  lastChannelMessageRequest?: Record<string, unknown>;
  channelMessageQueries?: Record<string, unknown>[];
  pendingChannelAiReplies?: Record<string, string>;
  failNextTaskCreate?: boolean;
  linkPreviewDelayMs?: number;
  approvals: MockApproval[];
  approvalCheckpoints: LingApprovalCheckpoint[];
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
  runtimeRunners: RunnerListItem[];
  runtimeSettings: WorkspaceRuntimeSettings;
  startupStatus: StartupStatusResponse;
  workUnitActionDelayMs?: number;
  runtimeSemaphoreSlots: MockRuntimeSemaphoreSlot[];
  runtimeEventsByWorkUnit: Record<string, MockRuntimeEvent[]>;
  workUnitAttemptsByWorkUnit: Record<string, MockWorkUnitAttempt[]>;
  resourceLeases: unknown[];
  stateTransitions: unknown[];
  artifactsByRun: Record<string, MockArtifact[]>;
  artifactsByMediaJob: Record<string, MockArtifact[]>;
  threads: MockLingThread[];
  goals: LingThreadGoal[];
  proposedPlans: ProposedPlanArtifact[];
  turns: MockLingTurn[];
  turnRunLinks: MockLingTurnRun[];
  failThreadTurnsForThreadIds: string[];
  executionActions: MockExecutionAction[];
  userProfile: UserProfile;
  workspaceSettings: Record<string, unknown>;
  terminalCommandRequests: Array<{ readonly cwd: string; readonly command: string }>;
}

export interface MockWorkspaceGitStatusFailure {
  readonly fail: true;
  readonly status?: number;
  readonly message?: string;
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
  conversationMode?: {
    mode: "default" | "plan";
    updatedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  metadata?: unknown;
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
  resolvedAt?: string;
  executedAt?: string;
  completedAt?: string;
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
  messagePayload?: {
    body: string;
    attachmentIds: string[];
    linkPreviewIds: string[];
    attachments?: Array<{ id: string; fileName: string; kind: string; contentType: string; sizeBytes: number; materializationStatus: string; previewStatus?: string; previewText?: string; reason?: string }>;
    linkPreviews?: Array<{ id: string; url: string; normalizedUrl: string; title?: string; description?: string; siteName?: string; status: string; materializationStatus: string; previewText?: string; reason?: string }>;
    fileRefs?: Array<{ path: string; label?: string; rootRelation: string; kind: string; materializationStatus: string; previewText?: string; blockedReason?: string }>;
  };
  requestedBy: "local-user" | "system";
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface MockTeammateDirectIntervention {
  id: string;
  workspaceId: string;
  teammateId: string;
  threadId: string;
  sourceMessageId: string;
  sourceWorkUnitId?: string;
  mode: "queue_followup" | "interrupt_redirect";
  status: "queued" | "cancelling_source" | "starting_continuation" | "started" | "failed" | "cancelled";
  instruction: string;
  messagePayload?: {
    body: string;
    attachmentIds: string[];
    linkPreviewIds: string[];
    fileRefs?: Array<{ path: string; label?: string; rootRelation: string; kind: string; materializationStatus: string; previewText?: string; blockedReason?: string }>;
  };
  idempotencyKey: string;
  requestedBy: "local-user" | "system";
  continuationMessageId?: string;
  continuationWorkUnitId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface MockMemoryMarkdownImportCall {
  readonly dryRun: boolean;
  readonly sourceLabel?: string;
  readonly candidateCount: number;
  readonly skippedCount: number;
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
  workflowStepId?: string;
  channelId?: string;
  toolCallId?: string;
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
  contentText?: string;
  contentType?: string;
  sizeBytes?: number;
  compareBeforeImageUrl?: string;
  compareAfterImageUrl?: string;
  compareBeforeLabel?: string;
  compareAfterLabel?: string;
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
  linkedMessageId?: string;
  teammateId?: string;
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
      element.querySelector("span:not(.avatar-initial):not(.sidebar-channel-avatar):not(.sidebar-hash):not(.channel-mention):not(.channel-unread)")?.textContent?.trim() ?? "";
    const shellRowLabel = (element: Element): string => {
      const main = element.querySelector(".sidebar-row-main");
      const directSpan = [...(main?.children ?? [])].find((child) => {
        if (child.tagName !== "SPAN") {
          return false;
        }
        return !child.classList.contains("avatar-initial") &&
          !child.classList.contains("teammate-avatar-image") &&
          !child.classList.contains("sidebar-channel-avatar") &&
          !child.classList.contains("sidebar-hash") &&
          !child.classList.contains("channel-mention") &&
          !child.classList.contains("channel-unread");
      });
      return directSpan?.textContent?.trim() ?? "";
    };

    return {
      activeNav: [...document.querySelectorAll(".nav-item.active")].map(navLabel),
      selectedRows: [
        ...[...document.querySelectorAll(".sidebar-row.selected")].map(rowLabel),
        ...[...document.querySelectorAll(".sidebar-row-shell.selected")].map(shellRowLabel),
      ].filter(Boolean),
    };
  });
}

export async function openTaskFromAttentionQueue(page: Page, title: string): Promise<void> {
  const hideDetails = page.getByRole("button", { name: "Hide details" });
  if (await hideDetails.count() > 0 && await hideDetails.isVisible().catch(() => false)) {
    await hideDetails.click();
    await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  }
  await openChannelChatTools(page);
  const workItem = page.getByRole("article", { name: title });
  if ((await workItem.count()) === 0 || !(await workItem.isVisible().catch(() => false))) {
    const taskEvent = page.locator("article").filter({ hasText: `Task ${title}` });
    await expect(taskEvent).toHaveCount(1);
    await taskEvent.getByRole("button", { name: "Details" }).click();
    const activityDetails = page.getByRole("complementary", { name: "Activity details" });
    await expect(activityDetails).toBeVisible();
    const showTaskInTranscript = activityDetails.getByRole("button", { name: "Show task in transcript" });
    if (await showTaskInTranscript.count() > 0) {
      await showTaskInTranscript.click();
    }
    await expectTaskDetailPanel(page);
    return;
  }
  const openTask = workItem.getByRole("button", { name: "Open task" });
  if (await openTask.count() > 0) {
    await openTask.click();
  } else if (await workItem.getByRole("button", { name: "View failure" }).count() > 0) {
    await workItem.getByRole("button", { name: "View failure" }).click();
  } else {
    const handleApproval = workItem.getByRole("button", { name: "Handle approval" });
    await expect(handleApproval).toBeVisible();
    await handleApproval.click();
    const approvalOverlay = page.locator(".conversation-detail-overlay").filter({ hasText: "Approval details" });
    await expect(approvalOverlay).toBeVisible();
    await approvalOverlay.getByRole("button", { name: "Open linked task" }).click();
  }
  await expectTaskDetailPanel(page);
}

async function expectTaskDetailPanel(page: Page): Promise<void> {
  await expect(page.locator(".channel-side-panel")).toBeVisible();
  await expect(page.locator("article.task-detail")).toBeVisible();
}

export async function openNewTaskPanel(page: Page): Promise<void> {
  await openChannelContextPanel(page);
  const panel = page.locator(".channel-side-panel");
  await panel.hover();
  if (await clickVisibleNewTask(page)) {
    return;
  }
  const backButton = panel.getByRole("button", { name: "Back" }).first();
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
  }
  if (await clickVisibleNewTask(page)) {
    return;
  }
  const hideDetails = page.getByRole("button", { name: "Hide details" });
  if (await hideDetails.isVisible().catch(() => false)) {
    await hideDetails.click();
    await expect(panel).toHaveCount(0);
  }
  await openChannelContextPanel(page);
  await page.locator(".channel-side-panel").hover();
  const newTaskButton = page.getByRole("button", { name: "New task" }).first();
  await expect(newTaskButton).toBeVisible();
  await newTaskButton.click();
}

export async function openChannelContextPanel(page: Page): Promise<void> {
  const panel = page.locator(".channel-side-panel");
  const panelVisible = (await panel.count()) > 0 && await panel.isVisible().catch(() => false);
  const panelLabel = panelVisible ? await panel.getAttribute("aria-label") : "";
  const hasNewTaskAction = panelVisible && await panel.getByRole("button", { name: "New task" }).first().isVisible().catch(() => false);
  if (panelVisible && (panelLabel === "Context" || panelLabel === "Task detail" || (panelLabel === "Channel workspace dock" && hasNewTaskAction))) {
    await panel.hover();
    return;
  }
  await openChannelChatTools(page);
  const moreViewsButton = page.getByRole("button", { name: "More channel views" });
  if (await moreViewsButton.isVisible().catch(() => false)) {
    await moreViewsButton.click();
    const contextItem = page.getByRole("menuitem", { name: "Context" });
    if (await contextItem.isVisible().catch(() => false)) {
      await contextItem.click();
      await expect(panel).toBeVisible();
      await panel.hover();
      return;
    }
  }
  const showDetailsButton = page.getByRole("button", { name: "Show details" });
  if (await showDetailsButton.count() > 0 && await showDetailsButton.isVisible().catch(() => false)) {
    await showDetailsButton.click();
    await expect(panel).toBeVisible();
    await panel.hover();
    return;
  }
  const openContextButton = page.getByRole("button", { name: "Open context" }).first();
  await expect(openContextButton).toBeVisible();
  await openContextButton.click();
  await expect(panel).toBeVisible();
  await panel.hover();
}

async function clickVisibleNewTask(page: Page): Promise<boolean> {
  const newTaskButton = page.getByRole("button", { name: "New task" }).first();
  if (!(await newTaskButton.isVisible().catch(() => false))) {
    return false;
  }
  await newTaskButton.click();
  return true;
}

export async function openChannelSidePanel(page: Page, name: "Settings"): Promise<void> {
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

export async function openEngineeringChannel(page: Page): Promise<void> {
  const channelMessageFeed = page.getByLabel(/Channel message feed|频道消息列表/);
  if (await channelMessageFeed.isVisible().catch(() => false)) {
    return;
  }
  const engineeringChannel = page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).first();
  await expect(engineeringChannel).toBeVisible();
  await engineeringChannel.click();
  await expect(channelMessageFeed).toBeVisible();
}

export async function openChannelChatTools(page: Page): Promise<void> {
  await openEngineeringChannel(page);
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
        autoReplyMode: "mentions_only",
        allowedTools: ["read", "grep", "find", "ls"],
        runtimePolicy: defaultRuntimePolicy,
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
      },
    ],
    channelBranches: [],
    channelWorkspaceGitStatusByChannel: {},
    channelMessages: [],
    channelMessageRouteDecisions: [],
    channelIntentDecisions: [],
    channelMessageQueries: [],
    channelExecutionProposals: [],
    channelAttachments: [],
    channelLinkPreviews: [],
    channelBriefs: {},
    channelDecisions: [],
    channelHandoffs: [],
    workflowHandoffIntents: [],
    channelContextSummaries: [],
    channelWorkflows: [],
    channelWorkflowSteps: [],
    channelProtocolDrafts: [],
    channelPlaybookCandidates: [],
    channelTeamExpertsByTurn: {},
    channelTeamExpertsRequests: [],
    channelTeamMetricsByChannel: {},
    aiTeammates: [],
    aiCouncils: [createMockAiCouncil()],
    aiCouncilMembers: createMockAiCouncilMembers(),
    channelCouncilPolicies: [],
    skillRegistryEntries: buildMockSkillRegistryEntries(),
    skillSourceSnapshots: createMockSkillSourceSnapshots(),
    skillSourceUpgradePolicy: { ...defaultSkillSourceUpgradePolicy },
    skillImportDrafts: [],
    skillCandidates: createMockSkillCandidates(),
    skillCandidateReviewRecords: [],
    procedureObservationClusters: createMockProcedureObservationClusters(),
    governanceNotifications: [],
    teammateChannelMemberships: [],
    teammateSkillBindings: [],
    teammateMemoryScopes: [],
    memoryObjects: [],
    usedMemoryEvents: [],
    memoryMarkdownImportCalls: [],
    teammateDirectThreads: {},
    teammateDirectMessages: [],
    teammateDirectInterventions: [],
    teammateDirectLinkPreviews: [],
    teammatePrivateAttachments: [],
    conversationAttachments: [],
    retentionTombstones: [],
    tasks: [
      {
        id: "task_inspect",
        workspaceId: "workspace_default",
        channelId: "channel_engineering",
        title: "Inspect workspace",
        prompt: "Inspect the repo and report next steps.",
        status: "failed",
        attachmentIds: [],
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
    approvalCheckpoints: [],
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
    runtimeRunners: [
      {
        id: "pi",
        displayName: "Pi Runner",
        status: "enabled",
        aliases: ["default"],
        supportedProviderApis: ["openai-responses", "openai-chat-completions"],
        supportedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        capabilities: ["run:task"],
        readiness: {
          status: "ready",
          checkedAt: "2026-05-25T00:00:00.000Z",
          blockingReasons: [],
        },
      },
      {
        id: "codex-app-server",
        displayName: "Codex App Server",
        status: "enabled",
        featureFlag: "runtime.external.codexAppServer",
        supportedProviderApis: ["openai-responses"],
        supportedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        capabilities: ["run:task", "sandbox:session"],
        readiness: {
          status: "blocked",
          checkedAt: "2026-05-25T00:00:00.000Z",
          blockingReasons: [
            {
              code: "sandbox_profile_missing",
              message: "Sandbox profile has not been configured.",
            },
            {
              code: "sandbox_backend_unverified",
              message: "Sandbox backend has not been verified by conformance.",
            },
          ],
        },
      },
    ],
    runtimeSettings: {
      workspaceId: "workspace_default",
      defaultRunnerId: "pi",
      allowedRunnerIds: ["pi"],
      explicitRunnerFallback: "disabled",
      implicitRunnerFallback: "allow_to_default",
      updatedAt: "2026-05-25T00:00:00.000Z",
    },
    startupStatus: {
      startupAttemptId: "startup_e2e_ready",
      cwd,
      state: "ready",
      startedAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:05.000Z",
      effectiveConfigLoadedAt: "2026-05-25T00:00:03.000Z",
      phases: {
        process_config: "ready",
        user_config: "ready",
        workspace_store: "ready",
        effective_config: "ready",
        runtime_policy: "ready",
        secret_resolver: "ready",
        provider_warmup: "ready",
        automation_scheduler: "ready",
        external_work_scheduler: "ready",
        plugin_warmup: "ready",
      },
      diagnostics: [],
    },
    runtimeSemaphoreSlots: [],
    runtimeEventsByWorkUnit: {},
    workUnitAttemptsByWorkUnit: {},
    resourceLeases: [],
    stateTransitions: [],
    artifactsByRun: {},
    artifactsByMediaJob: {},
    threads: [],
    goals: [],
    proposedPlans: [],
    turns: [],
    turnRunLinks: [],
    failThreadTurnsForThreadIds: [],
    executionActions: [],
    userProfile: {
      schemaVersion: 1,
      displayName: "Ling User",
      handle: "ling-local",
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
    workspaceSettings: {
      schemaVersion: 1,
      workspaceCwd: cwd,
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
    terminalCommandRequests: [],
  };
}

export function filterOptionalSearchParam(url: URL, key: string, value: string | undefined): boolean {
  const expected = url.searchParams.get(key);
  return !expected || value === expected;
}

function normalizeWorkspaceSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...settings,
    workspaceCwd: typeof settings.workspaceCwd === "string" ? settings.workspaceCwd : cwd,
    defaultProviderPresetId: typeof settings.defaultProviderPresetId === "string" && settings.defaultProviderPresetId.trim()
      ? settings.defaultProviderPresetId
      : undefined,
    lingConversationTone: normalizeLingConversationTone(settings.lingConversationTone),
    defaultPermissionMode: normalizeDefaultPermissionMode(settings.defaultPermissionMode),
    defaultPermissionPreset: normalizeDefaultPermissionPreset(settings.defaultPermissionPreset),
    skillGovernancePolicy: normalizeSkillGovernancePolicy(settings.skillGovernancePolicy),
    updatedAt: typeof settings.updatedAt === "string" ? settings.updatedAt : "2026-05-22T00:00:00.000Z",
  };
}

function normalizeDefaultPermissionMode(value: unknown): string {
  return value === "ask_everything" || value === "balanced" || value === "workspace_write" || value === "full_access" || value === "custom"
    ? value
    : "workspace_write";
}

function normalizeDefaultPermissionPreset(value: unknown): string {
  return value === "read_only" || value === "workspace_collaboration" || value === "full_access" || value === "custom"
    ? value
    : "workspace_collaboration";
}

function normalizeLingConversationTone(value: unknown): string | undefined {
  return value === "friendly" || value === "pragmatic" || value === "none" ? value : undefined;
}

function normalizeSkillGovernancePolicy(value: unknown): Record<string, string> {
  const record = isRecord(value) ? value : {};
  const generationMode = record.generationMode;
  const recordingMode = record.recordingMode;
  return {
    generationMode: generationMode === "off" || generationMode === "approval_only" || generationMode === "semi_auto" || generationMode === "auto_candidate"
      ? generationMode
      : defaultSkillGovernancePolicy.generationMode,
    recordingMode: recordingMode === "disabled" || recordingMode === "user_initiated"
      ? recordingMode
      : defaultSkillGovernancePolicy.recordingMode,
    invocationMode: "explicit_only",
    publishMode: "manual_review",
    bindMode: "manual_review",
  };
}

function effectiveWorkspaceSettingValue(value: unknown, key: string, builtInValue: string): Record<string, unknown> {
  if (typeof value === "string") {
    return {
      value,
      source: "workspace",
      path: `${cwd}/.ling-stack/ling-stack.sqlite`,
      key,
    };
  }
  return {
    value: builtInValue,
    source: "built_in",
    key,
  };
}

function effectiveWorkspaceObjectSettingValue(value: unknown, key: string, builtInValue: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(value)) {
    return {
      value,
      source: "workspace",
      path: `${cwd}/.ling-stack/ling-stack.sqlite`,
      key,
    };
  }
  return {
    value: builtInValue,
    source: "built_in",
    key,
  };
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
    conversationMode: { mode: "default" },
    createdAt: oldestRun.createdAt,
    updatedAt: latestRun.updatedAt,
  };
}

function mockThreadReadModel(thread: MockLingThread): MockLingThread {
  return {
    ...thread,
    conversationMode: thread.conversationMode ?? { mode: "default" },
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
  const approvalIds = new Set<string>();
  const evidenceRuns = threadRuns.map((run) => {
    const approvals = state.approvals.filter((approval) =>
      approval.runId === run.id ||
      (thread.workflowStepId !== undefined && approval.workflowStepId === thread.workflowStepId)
    );
    for (const approval of approvals) {
      approvalIds.add(approval.id);
    }
    return {
      run,
      events: state.eventsByRun[run.id] ?? [],
      approvals,
      artifacts: state.artifactsByRun[run.id] ?? [],
      runtimeEvents: run.workUnitId ? state.runtimeEventsByWorkUnit[run.workUnitId] ?? [] : [],
    };
  });
  const approvalCheckpoints = state.approvalCheckpoints.filter((checkpoint) =>
    approvalIds.has(checkpoint.approvalId) ||
    (checkpoint.runId !== undefined && runIds.has(checkpoint.runId)) ||
    (thread.workflowStepId !== undefined && checkpoint.workflowStepId === thread.workflowStepId)
  );
  return {
    cwd,
    thread: mockThreadReadModel(thread),
    generatedAt: "2026-05-25T00:39:00.000Z",
    runs: evidenceRuns,
    actions,
    approvalCheckpoints,
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

function buildMockThreadTraceDetail(state: MockState, threadId: string): LingTraceDetailResponse | undefined {
  const thread = state.threads.find((item) => item.id === threadId) ?? deriveMockThreadFromRuns(state, threadId);
  if (!thread) {
    return undefined;
  }
  const evidence = buildMockThreadEvidence(state, thread);
  const traceId = mockTraceId("thread", thread.id);
  const spans = buildMockTraceSpans(traceId, evidence.runs, evidence.actions);
  const status = normalizeMockTraceStatus(thread.status);
  return {
    cwd,
    trace: {
      id: traceId,
      workspaceId: thread.workspaceId,
      subjectKind: "thread",
      subjectId: thread.id,
      title: thread.title,
      startedAt: thread.createdAt,
      endedAt: isTerminalMockTraceStatus(status) ? thread.updatedAt : undefined,
      status,
      generatedAt: "2026-05-25T00:39:30.000Z",
    },
    spans,
  };
}

function buildMockRunTraceDetail(state: MockState, runId: string): LingTraceDetailResponse | undefined {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) {
    return undefined;
  }
  const thread = run.threadId ? state.threads.find((item) => item.id === run.threadId) ?? deriveMockThreadFromRuns(state, run.threadId) : undefined;
  const traceId = mockTraceId("run", run.id);
  const runs = [{
    run,
    events: state.eventsByRun[run.id] ?? [],
    approvals: state.approvals.filter((approval) => approval.runId === run.id),
    artifacts: state.artifactsByRun[run.id] ?? [],
    runtimeEvents: run.workUnitId ? state.runtimeEventsByWorkUnit[run.workUnitId] ?? [] : [],
  }];
  const actions = state.executionActions.filter((action) => action.runId === run.id);
  const spans = buildMockTraceSpans(traceId, runs, actions);
  const status = normalizeMockTraceStatus(run.status);
  return {
    cwd,
    trace: {
      id: traceId,
      workspaceId: thread?.workspaceId ?? "workspace_default",
      subjectKind: "run",
      subjectId: run.id,
      title: thread ? `${thread.title} / ${run.id}` : `Run ${run.id}`,
      startedAt: run.startedAt ?? run.createdAt,
      endedAt: isTerminalMockTraceStatus(status) ? run.endedAt ?? run.updatedAt : undefined,
      status,
      generatedAt: "2026-05-25T00:39:30.000Z",
    },
    spans,
  };
}

function buildMockTraceDetailForId(state: MockState, traceId: string): LingTraceDetailResponse | undefined {
  const threadPrefix = "trace_thread_";
  if (traceId.startsWith(threadPrefix)) {
    return buildMockThreadTraceDetail(state, traceId.slice(threadPrefix.length));
  }
  const runPrefix = "trace_run_";
  if (traceId.startsWith(runPrefix)) {
    return buildMockRunTraceDetail(state, traceId.slice(runPrefix.length));
  }
  return undefined;
}

function buildMockTraceSpans(
  traceId: string,
  runs: ReturnType<typeof buildMockThreadEvidence>["runs"],
  actions: readonly MockExecutionAction[],
): readonly LingTraceSpan[] {
  const runParentSpanIds = new Map<string, string>();
  const spans: LingTraceSpan[] = [];
  for (const item of runs) {
    const run = item.run;
    const spanId = mockTraceSpanId(traceId, "agent_run", run.id);
    runParentSpanIds.set(run.id, spanId);
    spans.push({
      id: spanId,
      traceId,
      kind: "agent_run",
      title: `Run ${run.id}`,
      startedAt: run.startedAt ?? run.createdAt,
      endedAt: run.endedAt,
      status: normalizeMockTraceStatus(run.status),
      refs: {
        threadId: run.threadId,
        runId: run.id,
        workUnitId: run.workUnitId,
        interventionId: run.interventionId,
      },
      redactedAttributes: {
        providerName: run.providerName,
        providerModel: run.providerModel,
        providerPresetId: run.providerPresetId,
        continuationReason: run.continuationReason,
      },
    });
  }

  for (const action of actions) {
    spans.push({
      id: mockTraceSpanId(traceId, action.approvalId ? "approval" : "tool_call", action.id),
      traceId,
      parentSpanId: action.runId ? runParentSpanIds.get(action.runId) : undefined,
      kind: action.approvalId ? "approval" : action.actionType === "external_send" || action.actionType === "deploy" ? "external_action" : "tool_call",
      title: action.title,
      startedAt: action.executedAt ?? action.createdAt,
      endedAt: action.completedAt ?? action.resolvedAt,
      status: normalizeMockExecutionActionTraceStatus(action.status),
      refs: {
        threadId: action.threadId,
        runId: action.runId,
        workUnitId: action.workUnitId,
        approvalId: action.approvalId,
        executionActionId: action.id,
        toolCallId: action.toolCallId,
      },
      redactedAttributes: {
        toolName: action.actionType,
        actionType: action.actionType,
        risk: action.risk,
        status: action.status,
        materializationStatus: "recorded",
        previewArtifactCount: action.previewArtifactIds.length,
        resultArtifactCount: action.resultArtifactIds.length,
      },
    });
  }

  for (const item of runs) {
    for (const artifact of item.artifacts) {
      spans.push({
        id: mockTraceSpanId(traceId, "artifact", artifact.id),
        traceId,
        parentSpanId: runParentSpanIds.get(item.run.id),
        kind: "artifact",
        title: artifact.title ?? artifact.path?.split("/").at(-1) ?? "Artifact",
        startedAt: artifact.createdAt,
        endedAt: artifact.createdAt,
        status: "succeeded",
        refs: {
          runId: artifact.runId,
          artifactId: artifact.id,
        },
        redactedAttributes: {
          type: artifact.type,
          contentType: artifact.contentType,
          sizeBytes: artifact.sizeBytes,
          hasPath: Boolean(artifact.path),
        },
      });
    }
  }

  return spans.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) ||
    left.id.localeCompare(right.id)
  );
}

function mockTraceId(subjectKind: "thread" | "run", subjectId: string): string {
  return `trace_${subjectKind}_${safeMockTraceIdFragment(subjectId)}`;
}

function mockTraceSpanId(traceId: string, kind: string, sourceId: string): string {
  return `span_${safeMockTraceIdFragment(traceId)}_${safeMockTraceIdFragment(kind)}_${safeMockTraceIdFragment(sourceId)}`;
}

function safeMockTraceIdFragment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function normalizeMockTraceStatus(status: string): Exclude<LingTraceStatus, "skipped"> {
  if (status === "queued" || status === "running" || status === "waiting_for_approval" || status === "succeeded" || status === "failed" || status === "cancelled") {
    return status;
  }
  if (status === "open" || status === "blocked") {
    return "running";
  }
  return "failed";
}

function normalizeMockExecutionActionTraceStatus(status: string): LingTraceStatus {
  if (status === "proposed" || status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (status === "approved" || status === "executing") {
    return "running";
  }
  if (status === "denied" || status === "expired" || status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "succeeded";
}

function isTerminalMockTraceStatus(status: Exclude<LingTraceStatus, "skipped">): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
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
  const activeTurn = state.turns.find((turn) => turn.threadId === thread.id && isMockTurnBlockingArchive(state, turn));
  return activeTurn ? `Cannot archive thread with active turn: ${activeTurn.id}` : undefined;
}

function isMockTurnBlockingArchive(state: MockState, turn: MockLingTurn): boolean {
  const activeRun = turn.activeRunId ? state.runs.find((run) => run.id === turn.activeRunId) : undefined;
  if (activeRun && isMockRunActive(activeRun)) {
    return true;
  }
  if (turn.status === "running" || turn.status === "waiting_for_approval" || turn.status === "blocked") {
    return true;
  }
  return turn.status === "open" && Boolean(turn.activeRunId || turn.lastRunId);
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

export function createMockSkillSourceSnapshots(): unknown[] {
  const timestamp = "2026-06-22T00:00:00.000Z";
  return [
    {
      id: "skill_source_review_mock",
      workspaceId: "workspace_default",
      skillId: "review",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-review/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.3.0",
      upstreamSkillPath: "gstack-review/SKILL.md",
      sourceChecksum: "sha256:review-mock",
      rawSkillMarkdown: "---\nname: review\n---\n# Review\nFind concrete issues first.",
      agentMetadata: {
        displayName: "gstack-review",
        shortDescription: "Pre-landing review.",
        allowImplicitInvocation: true,
      },
      referencedFiles: [
        {
          path: "references/checklist.md",
          kind: "reference",
          checksum: "sha256:checklist",
          sizeBytes: 32,
          includedInSnapshot: false,
        },
      ],
      warnings: [],
      reviewStatus: "published",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function createMockSkillSourceSyncPreview(state: MockState, input: Record<string, unknown> = {}): Record<string, unknown> {
  const timestamp = "2026-06-22T00:05:00.000Z";
  const implementDefinition = gstackDefaultSkillPack.skills.find((definition) => definition.id === "implement");
  const reviewDefinition = gstackDefaultSkillPack.skills.find((definition) => definition.id === "review");
  const existingReviewSnapshot = state.skillSourceSnapshots.find((item) => isRecord(item) && item.skillId === "review" && item.reviewStatus === "published");
  const roots = [
    ...Array.isArray(input.roots) ? input.roots.filter(isRecord) : [],
    ...Array.isArray(input.skillRoots)
      ? input.skillRoots
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((rootPath) => ({
          rootPath,
          sourceKind: "gstack-skill-directory",
          label: "Manual skill root",
          upstreamName: "gstack",
          upstreamVersion: "1.58.4.0",
        }))
      : [],
    input.includeDetectedRoots === false
      ? undefined
      : {
          rootPath: "mock-detected-gstack-skills",
          sourceKind: "gstack-skill-directory",
          label: "Detected gstack skills",
          upstreamName: "gstack",
          upstreamVersion: "1.58.4.0",
        },
  ].filter((item): item is Record<string, unknown> => isRecord(item));
  const records = [
    {
      state: "attachable",
      skillId: "implement",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-implement/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.4.0",
      upstreamSkillPath: "gstack-implement/SKILL.md",
      sourceChecksum: "sha256:implement-sync",
      sourceSizeBytes: 428,
      frontMatter: { name: "implement", description: "Implementation workflow" },
      referencedFiles: [
        { path: "references/implementation.md", kind: "reference", checksum: "sha256:impl-ref", sizeBytes: 64, includedInSnapshot: false },
      ],
      warnings: [],
      definitionPreview: implementDefinition,
      contextFindings: [
        {
          kind: "missing_or_weak_routing_description",
          severity: "warning",
          skillId: "implement",
          title: "Missing or weak routing description",
          message: "implement has a weak routing description.",
          evidence: [{ sourceRef: "gstack-implement/SKILL.md", message: "Routing description is too generic for reliable selection." }],
          recommendation: "Add a concise trigger-oriented description before relying on automatic routing.",
        },
      ],
      snapshotPreview: {
        skillId: "implement",
        sourceKind: "gstack-skill-directory",
        sourcePath: "skills/gstack-implement/SKILL.md",
        upstreamName: "gstack",
        upstreamVersion: "1.58.4.0",
        upstreamSkillPath: "gstack-implement/SKILL.md",
        sourceChecksum: "sha256:implement-sync",
        rawSkillMarkdown: "---\nname: implement\n---\n# Implement\nShip the focused code change.",
        agentMetadata: {
          displayName: "gstack-implement",
          shortDescription: "Implementation workflow.",
          allowImplicitInvocation: true,
        },
        referencedFiles: [
          { path: "references/implementation.md", kind: "reference", checksum: "sha256:impl-ref", sizeBytes: 64, includedInSnapshot: false },
        ],
        warnings: [],
        reviewStatus: "reviewed",
      },
      diff: [],
      semanticDiff: [],
    },
    {
      state: "drifted",
      skillId: "review",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-review/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.4.0",
      upstreamSkillPath: "gstack-review/SKILL.md",
      sourceChecksum: "sha256:review-sync",
      sourceSizeBytes: 392,
      frontMatter: { name: "review", description: "Pre-landing review" },
      referencedFiles: [],
      warnings: [{ code: "drifted_upstream", severity: "warning", message: "Upstream source changed since the published snapshot." }],
      definitionPreview: reviewDefinition,
      snapshotPreview: {
        skillId: "review",
        sourceKind: "gstack-skill-directory",
        sourcePath: "skills/gstack-review/SKILL.md",
        upstreamName: "gstack",
        upstreamVersion: "1.58.4.0",
        upstreamSkillPath: "gstack-review/SKILL.md",
        sourceChecksum: "sha256:review-sync",
        rawSkillMarkdown: "---\nname: review\n---\n# Review\nFind concrete issues first, then summarize residual risk.",
        agentMetadata: {
          displayName: "gstack-review",
          shortDescription: "Pre-landing review.",
          allowImplicitInvocation: true,
        },
        referencedFiles: [],
        warnings: [{ code: "drifted_upstream", severity: "warning", message: "Upstream source changed since the published snapshot." }],
        reviewStatus: "reviewed",
      },
      existingSnapshotId: isRecord(existingReviewSnapshot) && typeof existingReviewSnapshot.id === "string" ? existingReviewSnapshot.id : undefined,
      contextFindings: [],
      diff: [
        { field: "sourceChecksum", label: "Checksum", before: "sha256:review-mock", after: "sha256:review-sync", severity: "warning" },
        { field: "upstreamVersion", label: "Upstream version", before: "1.58.3.0", after: "1.58.4.0", severity: "info" },
        { field: "sourceLengthChars", label: "Source length", before: "49", after: "75", severity: "info" },
        { field: "referencedFiles", label: "Referenced files", before: "1 files · sha256:checklist", after: "0 files", severity: "info" },
        { field: "warnings", label: "Warnings", before: "0 warnings", after: "1 warnings · drifted_upstream:warning:", severity: "warning" },
      ],
      semanticDiff: [],
    },
    {
      state: "new",
      skillId: "gstack-design-review",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-design-review/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.4.0",
      upstreamSkillPath: "gstack-design-review/SKILL.md",
      sourceChecksum: "sha256:design-review-sync",
      sourceSizeBytes: 512,
      frontMatter: { name: "design-review", description: "Designer eye QA" },
      referencedFiles: [],
      warnings: [],
      definitionPreview: {
        id: "gstack-design-review",
        name: "Design Review",
        summary: "Visual QA for spacing, hierarchy, and interaction polish.",
        roleAffinity: ["designer"],
        workflowPhase: "review",
        promptFragments: ["Run a focused visual design review and report concrete issues."],
        requiredTools: ["read"],
        requiredProviderCapabilities: [],
        approvalProfile: "standard",
        stateEffects: ["updates_plan"],
      },
      contextFindings: [
        {
          kind: "body_taxonomy_risk",
          severity: "warning",
          skillId: "gstack-design-review",
          title: "Mixed skill body taxonomy",
          message: "gstack-design-review mixes core instructions with examples or references.",
          evidence: [{ sourceRef: "gstack-design-review/SKILL.md", message: "Default body includes background and examples." }],
          recommendation: "Split default runtime instructions from lazy examples before optimization.",
        },
      ],
      snapshotPreview: {
        skillId: "gstack-design-review",
        sourceKind: "gstack-skill-directory",
        sourcePath: "skills/gstack-design-review/SKILL.md",
        upstreamName: "gstack",
        upstreamVersion: "1.58.4.0",
        upstreamSkillPath: "gstack-design-review/SKILL.md",
        sourceChecksum: "sha256:design-review-sync",
        rawSkillMarkdown: "---\nname: design-review\n---\n# Design Review\nAudit the rendered UI for concrete visual issues.",
        agentMetadata: {
          displayName: "gstack-design-review",
          shortDescription: "Visual QA.",
          allowImplicitInvocation: true,
        },
        referencedFiles: [],
        warnings: [],
        reviewStatus: "reviewed",
      },
      diff: [],
      semanticDiff: [],
    },
    {
      state: "blocked",
      skillId: "gstack-danger-demo",
      sourceKind: "gstack-skill-directory",
      sourcePath: "skills/gstack-danger-demo/SKILL.md",
      upstreamName: "gstack",
      upstreamVersion: "1.58.4.0",
      upstreamSkillPath: "gstack-danger-demo/SKILL.md",
      sourceChecksum: "sha256:danger-demo-sync",
      sourceSizeBytes: 256,
      frontMatter: { name: "danger-demo", description: "Blocked sample" },
      referencedFiles: [],
      warnings: [{ code: "destructive_command", severity: "error", message: "Source contains destructive command guidance." }],
      contextFindings: [
        {
          kind: "optimization_unsafe",
          severity: "critical",
          skillId: "gstack-danger-demo",
          title: "Automatic optimization unsafe",
          message: "gstack-danger-demo needs manual review before automatic skill context optimization.",
          evidence: [{ sourceRef: "gstack-danger-demo/SKILL.md", message: "destructive_command: Source contains destructive command guidance." }],
          recommendation: "Keep this skill on manual preview until unsafe claims are reviewed.",
        },
      ],
      diff: [],
      semanticDiff: [],
    },
  ];
  const summary = records.reduce((current, record) => {
    current.totalRecords += 1;
    current[record.state as keyof typeof current] += 1;
    return current;
  }, {
    totalRecords: 0,
    attachable: 0,
    unchanged: 0,
    drifted: 0,
    new: 0,
    missing: 0,
    blocked: 0,
    orphaned: 0,
  });
  return {
    generatedAt: timestamp,
    roots,
    upstreamVersions: ["gstack 1.58.4.0"],
    summary,
    records,
  };
}

function publishMockSkillSourceSync(state: MockState, input: Record<string, unknown> = {}): { readonly preview: Record<string, unknown>; readonly skills: readonly unknown[]; readonly snapshots: readonly unknown[] } {
  const timestamp = "2026-06-22T00:06:00.000Z";
  const selectedSkillIds = new Set(Array.isArray(input.selectedSkillIds) ? input.selectedSkillIds.filter((item): item is string => typeof item === "string") : []);
  const allowNewSkills = input.allowNewSkills === true;
  const preview = createMockSkillSourceSyncPreview(state, input);
  const records = Array.isArray(preview.records) ? preview.records.filter(isRecord) : [];
  const publishedSnapshots: unknown[] = [];
  const publishedSkills: unknown[] = [];
  for (const record of records) {
    const skillId = typeof record.skillId === "string" ? record.skillId : "";
    if (!selectedSkillIds.has(skillId) || !isMockPublishableSyncRecord(record, allowNewSkills) || !isRecord(record.snapshotPreview)) {
      continue;
    }
    if (record.state === "new") {
      if (!isRecord(record.definitionPreview)) {
        continue;
      }
      const existingSkillIndex = state.skillRegistryEntries.findIndex((item) => isRecord(item) && item.id === skillId);
      const nextSkill = {
        id: skillId,
        workspaceId: "workspace_default",
        packId: "skill_pack_gstack_source_sync",
        source: "gstack",
        sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : undefined,
        version: typeof record.upstreamVersion === "string" ? record.upstreamVersion : undefined,
        checksum: typeof record.sourceChecksum === "string" ? record.sourceChecksum : undefined,
        definition: record.definitionPreview,
        visibility: {
          workspaceVisible: true,
          promotableToWorkspace: true,
        },
        reviewStatus: "published",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (existingSkillIndex >= 0) {
        state.skillRegistryEntries[existingSkillIndex] = nextSkill;
      } else {
        state.skillRegistryEntries.unshift(nextSkill);
      }
      publishedSkills.push(nextSkill);
    } else {
      const existingSkill = state.skillRegistryEntries.find((item) => isRecord(item) && item.id === skillId);
      if (existingSkill) {
        publishedSkills.push(existingSkill);
      }
    }
    const existingSnapshot = state.skillSourceSnapshots.find((item) => isRecord(item) && item.skillId === skillId);
    const snapshot = {
      ...record.snapshotPreview,
      id: isRecord(existingSnapshot) && typeof existingSnapshot.id === "string" ? existingSnapshot.id : `skill_source_${skillId}_sync_mock`,
      workspaceId: "workspace_default",
      reviewStatus: "published",
      createdAt: isRecord(existingSnapshot) && typeof existingSnapshot.createdAt === "string" ? existingSnapshot.createdAt : timestamp,
      updatedAt: timestamp,
    };
    const snapshotIndex = state.skillSourceSnapshots.findIndex((item) => isRecord(item) && item.skillId === skillId);
    if (snapshotIndex >= 0) {
      state.skillSourceSnapshots[snapshotIndex] = snapshot;
    } else {
      state.skillSourceSnapshots.unshift(snapshot);
    }
    publishedSnapshots.push(snapshot);
  }
  return { preview, skills: publishedSkills, snapshots: publishedSnapshots };
}

function isMockPublishableSyncRecord(record: Record<string, unknown>, allowNewSkills: boolean): boolean {
  const warnings = Array.isArray(record.warnings) ? record.warnings.filter(isRecord) : [];
  if (warnings.some((warning) => warning.severity === "error")) {
    return false;
  }
  return record.state === "attachable" || record.state === "drifted" || record.state === "unchanged" || (allowNewSkills && record.state === "new");
}

export function createMockSkillCandidates(): unknown[] {
  const timestamp = "2026-06-20T00:05:00.000Z";
  return [
    {
      id: "skill_candidate_channel_canvas_protocol",
      workspaceId: "workspace_default",
      origin: "recording",
      proposedAction: "create",
      status: "pending",
      title: "Channel canvas protocol skill",
      summary: "Codify a repeated channel canvas workflow as a governed Ling skill candidate.",
      definition: {
        workflowPhase: "operate",
        positiveTriggers: [
          "A channel repeatedly follows the same canvas protocol",
          "The user asks to turn a successful workflow into a reusable skill",
        ],
        negativeTriggers: [
          "A built-in, external, or registry skill already owns the same workflow",
          "The flow needs live credentials or irreversible production actions",
        ],
        procedureSteps: [
          {
            title: "Check existing registry skills",
            instruction: "Search for overlapping triggers before drafting a new skill.",
            requiredTools: ["grep"],
          },
          {
            title: "Summarize the channel protocol",
            instruction: "Capture positive triggers, negative triggers, procedure, and validation evidence.",
          },
        ],
        validationSteps: [
          {
            title: "Draft stays unpublished",
            commandOrCheck: "Create a SkillImportDraft and verify no registry entry is published.",
            expectedResult: "Candidate creates a draft only after user approval.",
          },
        ],
        requiredTools: ["read", "grep"],
        requiredProviderCapabilities: ["chat"],
      },
      duplicateAnalysis: {
        decision: "no_overlap",
        similarityScore: 0.18,
        matchedSkillIds: [],
        matchedCandidateIds: [],
        triggerOverlap: [],
        conflictingFields: [],
        rationale: "No existing registry skill owns this channel canvas protocol.",
      },
      safetyFindings: [],
      sourceRefs: [
        {
          type: "message",
          id: "message_skill_canvas_discussion",
          label: "channel canvas discussion",
        },
      ],
      reviewNotes: ["Keep publication separate from candidate approval."],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

export function createMockProcedureObservationClusters(): unknown[] {
  return [
    {
      id: "procedure_cluster_channel_canvas",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      routeKind: "channel_protocol",
      routeReasonCode: "multi_agent_handoff_protocol",
      status: "ready_for_review",
      recommendedAction: "create_channel_protocol_candidate",
      title: "Channel canvas handoff protocol",
      summary: "Repeated channel handoffs should become a reviewable protocol candidate, not a global skill.",
      normalizedGoal: "channel handoff protocol canvas",
      observationCount: 3,
      confidence: "high",
      reusableScore: 78,
      positiveTriggers: ["Channel repeatedly coordinates agents through the same handoff"],
      negativeTriggers: ["A one-off handoff does not need a protocol"],
      routeBlockers: [],
      sourceRefs: [{ type: "message", id: "message_canvas_cluster", label: "channel canvas discussion" }],
      firstObservedAt: "2026-06-20T00:00:00.000Z",
      lastObservedAt: "2026-06-20T00:20:00.000Z",
    },
    {
      id: "procedure_cluster_skill_gate",
      workspaceId: "workspace_default",
      routeKind: "skill",
      routeReasonCode: "repeatable_procedure_missing_gates",
      status: "blocked",
      recommendedAction: "append_evidence",
      title: "Generated skill missing gates",
      summary: "A repeatable procedure exists, but it needs validation and negative triggers before review.",
      normalizedGoal: "generated skill gate review",
      observationCount: 1,
      confidence: "medium",
      reusableScore: 55,
      positiveTriggers: ["The user asks to save a repeated workflow"],
      negativeTriggers: [],
      routeBlockers: ["missing_validation", "missing_negative_trigger"],
      sourceRefs: [{ type: "observation-job", id: "observation_job_mock_skill_gate", label: "Observation job" }],
      firstObservedAt: "2026-06-20T00:10:00.000Z",
      lastObservedAt: "2026-06-20T00:10:00.000Z",
    },
    {
      id: "procedure_cluster_release_playbook",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      routeKind: "playbook",
      routeReasonCode: "channel_scoped_repeatable_playbook",
      status: "ready_for_review",
      recommendedAction: "create_playbook_candidate",
      title: "Release verification playbook",
      summary: "Repeated release checks should become a channel-local playbook, not a global skill.",
      normalizedGoal: "release verification playbook",
      observationCount: 2,
      confidence: "high",
      reusableScore: 74,
      positiveTriggers: ["Channel repeats the same release verification steps"],
      negativeTriggers: ["A docs-only change does not need release verification"],
      routeBlockers: [],
      procedureSteps: [{ title: "Collect release evidence", instruction: "Summarize test, review, and rollout evidence.", requiredTools: ["read"] }],
      validationSteps: [{ title: "Confirm evidence is linked", commandOrCheck: "Review test and PR references.", expectedResult: "Release evidence is attached." }],
      sourceRefs: [{ type: "run", id: "run_release_playbook", label: "Release verification run" }],
      firstObservedAt: "2026-06-20T00:05:00.000Z",
      lastObservedAt: "2026-06-20T00:25:00.000Z",
    },
  ];
}

export function createMockSkillHealthReport(state: MockState, limit = 100): Record<string, unknown> {
  const activeSkills = state.skillRegistryEntries.filter((item) =>
    isRecord(item) &&
    (item.reviewStatus === "builtin" || item.reviewStatus === "published")
  );
  const openCandidates = state.skillCandidates.filter((item) =>
    isRecord(item) &&
    (item.status === "pending" || item.status === "needs_edit" || item.status === "approved_for_draft")
  );
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const entry of activeSkills) {
    if (!isRecord(entry) || !isRecord(entry.definition) || typeof entry.definition.name !== "string") {
      continue;
    }
    const key = entry.definition.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key) {
      continue;
    }
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  const duplicateFindings = [...byName.values()]
    .filter((cluster) => cluster.length > 1)
    .flatMap((cluster) => {
      const skillIds = cluster
        .map((entry) => typeof entry.id === "string" ? entry.id : "")
        .filter(Boolean)
        .sort();
      const duplicate = {
        id: `skill-health:duplicate_clusters:${skillIds.join("+")}`,
        kind: "duplicate_clusters",
        severity: "warning",
        skillIds,
        candidateIds: [],
        title: "Duplicate skill cluster",
        message: "Multiple active skills share the same id or canonical name.",
        recommendation: "Keep one canonical skill and archive or merge the duplicate.",
        recommendedAction: "merge",
      };
      const toolSets = new Set(cluster.map((entry) => {
        const tools = isRecord(entry.definition) && Array.isArray(entry.definition.requiredTools)
          ? entry.definition.requiredTools.map(String).sort()
          : [];
        return tools.join(",");
      }));
      if (toolSets.size <= 1) {
        return [duplicate];
      }
      return [
        duplicate,
        {
          id: `skill-health:conflicting_triggers:${skillIds.join("+")}`,
          kind: "conflicting_triggers",
          severity: "warning",
          skillIds,
          candidateIds: [],
          title: "Conflicting skill triggers",
          message: "Skills overlap in trigger language but differ on requiredTools.",
          recommendation: "Clarify trigger boundaries or merge the overlapping workflow.",
          recommendedAction: "review",
        },
      ];
    });
  const candidateFindings = openCandidates.flatMap((candidate) => {
    const definition = isRecord(candidate.definition) ? candidate.definition : {};
    const candidateId = typeof candidate.id === "string" ? candidate.id : "";
    const findings: Record<string, unknown>[] = [];
    if (!Array.isArray(definition.negativeTriggers) || definition.negativeTriggers.length === 0) {
      findings.push({
        id: `skill-health:missing_negative_triggers:${candidateId}`,
        kind: "missing_negative_triggers",
        severity: "warning",
        skillIds: [],
        candidateIds: [candidateId],
        title: "Missing negative triggers",
        message: "Candidate needs explicit non-trigger boundaries before approval.",
        recommendation: "Add negative triggers before approving the candidate for draft.",
        recommendedAction: "add_negative_triggers",
      });
    }
    if (!Array.isArray(definition.validationSteps) || definition.validationSteps.length === 0) {
      findings.push({
        id: `skill-health:missing_validation_steps:${candidateId}`,
        kind: "missing_validation_steps",
        severity: "warning",
        skillIds: [],
        candidateIds: [candidateId],
        title: "Missing validation",
        message: "Candidate needs a verification step before approval.",
        recommendation: "Add at least one validation check before approving the candidate.",
        recommendedAction: "add_validation",
      });
    }
    if (findings.length === 0 && candidate.status !== "approved_for_draft") {
      findings.push({
        id: `skill-health:stale_candidate:${candidateId}`,
        kind: "stale_candidate",
        severity: "info",
        skillIds: [],
        candidateIds: [candidateId],
        title: "Candidate waiting for review",
        message: "Skill candidate passed basic gates and is waiting for user review.",
        recommendation: "Approve it for draft or reject it from the candidate review panel.",
        recommendedAction: "review",
      });
    }
    return findings;
  });
  const findings = [...duplicateFindings, ...candidateFindings];
  const limitedFindings = findings.slice(0, Math.max(limit, 1));
  return {
    workspaceId: "workspace_default",
    generatedAt: "2026-06-20T00:00:00.000Z",
    staleCandidateDays: 30,
    summary: {
      totalSkills: state.skillRegistryEntries.length,
      activeSkills: activeSkills.length,
      generatedSkills: state.skillRegistryEntries.filter((entry) =>
        isRecord(entry) &&
        entry.source === "custom" &&
        (entry.packId === "ling-generated" || (typeof entry.sourcePath === "string" && entry.sourcePath.includes("ling-generated")))
      ).length,
      pendingCandidates: openCandidates.length,
      duplicateClusters: findings.filter((finding) => finding.kind === "duplicate_clusters").length,
      conflictCount: findings.filter((finding) => finding.kind === "conflicting_triggers").length,
      staleCandidates: findings.filter((finding) => finding.kind === "stale_candidate").length,
      highFailureRateSkills: 0,
      findings: {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        warning: findings.filter((finding) => finding.severity === "warning").length,
        info: findings.filter((finding) => finding.severity === "info").length,
      },
    },
    findings: limitedFindings,
  };
}

export function createMockSkillSourceHealthReport(state: MockState, limit = 100): Record<string, unknown> {
  const activeSkills = state.skillRegistryEntries.filter((item) =>
    isRecord(item) &&
    (item.reviewStatus === "builtin" || item.reviewStatus === "published")
  );
  const publishedSnapshots = state.skillSourceSnapshots.filter((item) =>
    isRecord(item) &&
    item.reviewStatus === "published"
  );
  const activeSkillIds = new Set(activeSkills.map((skill) => isRecord(skill) && typeof skill.id === "string" ? skill.id : "").filter(Boolean));
  const snapshotSkillIds = new Set(publishedSnapshots.map((snapshot) => isRecord(snapshot) && typeof snapshot.skillId === "string" ? snapshot.skillId : "").filter(Boolean));
  const missingSourceFindings = activeSkills
    .filter((skill) => isRecord(skill) && typeof skill.id === "string" && !snapshotSkillIds.has(skill.id))
    .slice(0, Math.max(limit, 1))
    .map((skill) => ({
      kind: "missing_source_snapshot",
      severity: "info",
      skillId: isRecord(skill) && typeof skill.id === "string" ? skill.id : undefined,
      title: "Missing source snapshot",
      message: "This registry skill is metadata-only until a reviewed SKILL.md snapshot is published.",
    }));
  const warningFindings = publishedSnapshots
    .filter((snapshot) => isRecord(snapshot) && Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0)
    .map((snapshot) => ({
      kind: "source_warning",
      severity: "warning",
      skillId: isRecord(snapshot) && typeof snapshot.skillId === "string" ? snapshot.skillId : undefined,
      snapshotId: isRecord(snapshot) && typeof snapshot.id === "string" ? snapshot.id : undefined,
      title: "Source warning",
      message: "Published source snapshot has warnings.",
    }));
  const orphanedFindings = publishedSnapshots
    .filter((snapshot) => isRecord(snapshot) && typeof snapshot.skillId === "string" && !activeSkillIds.has(snapshot.skillId))
    .map((snapshot) => ({
      kind: "orphaned_source_snapshot",
      severity: "warning",
      skillId: isRecord(snapshot) && typeof snapshot.skillId === "string" ? snapshot.skillId : undefined,
      snapshotId: isRecord(snapshot) && typeof snapshot.id === "string" ? snapshot.id : undefined,
      title: "Orphaned skill source snapshot",
      message: "A published source snapshot points to a missing or archived skill.",
    }));
  const contextFindings = publishedSnapshots
    .slice(0, 1)
    .map((snapshot) => ({
      kind: "missing_or_weak_routing_description",
      severity: "warning",
      skillId: isRecord(snapshot) && typeof snapshot.skillId === "string" ? snapshot.skillId : undefined,
      snapshotId: isRecord(snapshot) && typeof snapshot.id === "string" ? snapshot.id : undefined,
      title: "Missing or weak routing description",
      message: "Published source snapshot has a weak routing description.",
      evidence: [{ sourceRef: "SKILL.md", message: "Description is too short for reliable automatic routing." }],
      recommendation: "Add a trigger-oriented description before relying on automatic routing.",
    }));
  const findings = [...warningFindings, ...contextFindings, ...orphanedFindings, ...missingSourceFindings].slice(0, Math.max(limit, 1));
  return {
    workspaceId: "workspace_default",
    generatedAt: "2026-06-22T00:00:00.000Z",
    summary: {
      totalSkills: activeSkills.length,
      sourceBackedSkills: publishedSnapshots.length,
      missingSourceSnapshots: activeSkills.filter((skill) => isRecord(skill) && typeof skill.id === "string" && !snapshotSkillIds.has(skill.id)).length,
      warningSnapshots: publishedSnapshots.filter((snapshot) => isRecord(snapshot) && Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0).length,
      orphanedSnapshots: publishedSnapshots.filter((snapshot) => isRecord(snapshot) && typeof snapshot.skillId === "string" && !activeSkillIds.has(snapshot.skillId)).length,
    },
    findings,
  };
}

function createMockSkillOptimizationPreview(snapshot: Record<string, unknown>, mode = "preview_on_demand"): Record<string, unknown> {
  const skillId = typeof snapshot.skillId === "string" ? snapshot.skillId : "unknown";
  const snapshotId = typeof snapshot.id === "string" ? snapshot.id : "skill_source_unknown";
  return {
    skillId,
    sourceSnapshotId: snapshotId,
    generatedAt: "2026-07-03T00:00:00.000Z",
    mode,
    status: "preview_ready",
    originalTokenEstimate: 96,
    compiledTokenEstimate: 52,
    routingDescription: {
      original: "Pre-landing review.",
      suggested: "Use when the task specifically calls for the review skill workflow.",
      reason: "Source health flagged the routing description as short.",
    },
    compiledView: {
      id: "skill_compiled_preview_mock",
      skillId,
      sourceSnapshotId: snapshotId,
      createdAt: "2026-07-03T00:00:00.000Z",
      compilerVersion: "skill-reducer-preview-v1",
      coreRulesMarkdown: "# Review\nFind concrete issues first.",
      lazyReferences: [
        {
          id: "section-1",
          title: "Checklist",
          kind: "reference",
          sourceRef: "references/checklist.md",
          summary: "Review checklist stays lazy until requested.",
          tokenEstimate: 12,
          loadPolicy: "on_request",
        },
      ],
      sourceMap: [
        {
          compiledRef: "coreRulesMarkdown",
          sourceRef: "SKILL.md",
          sourceStartLine: 1,
          rationale: "Default runtime context keeps core instructions only.",
        },
      ],
      tokenEstimate: 52,
      fallbackPolicy: "original_on_error",
    },
    risks: [
      {
        kind: "context_health",
        severity: "warning",
        title: "Missing or weak routing description",
        message: "Routing description is short.",
        sourceRefs: ["SKILL.md"],
        blocksAutoRuntime: false,
      },
    ],
    authorityBoundary: {
      requiredToolsChanged: false,
      requiredProviderCapabilitiesChanged: false,
      approvalProfileChanged: false,
      teammateBindingsChanged: false,
    },
  };
}

function createMockSkillImportDraftContextFindings(draft: Record<string, unknown>): Record<string, unknown>[] {
  const definitions = Array.isArray(draft.definitions) ? draft.definitions.filter(isRecord) : [];
  const definition = definitions[0];
  const skill = isRecord(definition?.definition) ? definition.definition : {};
  const skillId = typeof skill.id === "string" ? skill.id : "import-draft";
  const warnings = [
    ...(Array.isArray(draft.warnings) ? draft.warnings.filter(isRecord) : []),
    ...(Array.isArray(definition?.warnings) ? definition.warnings.filter(isRecord) : []),
  ];
  return [
    {
      kind: "missing_or_weak_routing_description",
      severity: "warning",
      skillId,
      title: "Missing or weak routing description",
      message: `${skillId} has a weak routing description.`,
      evidence: [{ sourceRef: "SKILL.md", message: "Routing descriptions should identify when the skill should be selected." }],
      recommendation: "Add a concise trigger-oriented description before relying on automatic routing.",
    },
    ...(warnings.length > 0 ? [{
      kind: "optimization_unsafe",
      severity: "warning",
      skillId,
      title: "Automatic optimization unsafe",
      message: `${skillId} needs manual review before automatic skill context optimization.`,
      evidence: warnings.map((warning) => ({
        sourceRef: typeof warning.location === "string" ? warning.location : "SKILL.md",
        message: `${String(warning.code)}: ${String(warning.message)}`,
      })),
      recommendation: "Keep this skill on manual preview until unsafe claims and hidden rules are reviewed.",
    }] : []),
  ];
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

export function createMockSkillCandidateDraft(state: MockState, candidate: Record<string, unknown>): Record<string, unknown> {
  const definition = isRecord(candidate.definition) ? candidate.definition : {};
  const skillDefinition = isRecord(definition.skillDefinition)
    ? definition.skillDefinition
    : {
        id: uniqueMockSkillId(state, slugMockSkillId(typeof candidate.title === "string" ? candidate.title : "skill candidate")),
        name: typeof candidate.title === "string" ? candidate.title : "Skill candidate",
        summary: typeof candidate.summary === "string" ? candidate.summary : "Generated from a skill candidate.",
        roleAffinity: ["qa"],
        workflowPhase: typeof definition.workflowPhase === "string" ? definition.workflowPhase : "operate",
        promptFragments: [mockSkillCandidatePrompt(candidate)],
        requiredTools: Array.isArray(definition.requiredTools) ? definition.requiredTools.map(String) : [],
        requiredProviderCapabilities: Array.isArray(definition.requiredProviderCapabilities) ? definition.requiredProviderCapabilities.map(String) : ["chat"],
        approvalProfile: { mode: "none" },
        stateEffects: [],
      };
  return {
    id: `skill_draft_${state.skillImportDrafts.length + 1}`,
    workspaceId: "workspace_default",
    source: "custom",
    sourcePath: `skill-candidates/${String(candidate.id)}`,
    packId: `skill_pack_candidate_${state.skillImportDrafts.length + 1}`,
    name: typeof candidate.title === "string" ? candidate.title : "Skill candidate draft",
    version: "0.1.0",
    description: typeof candidate.summary === "string" ? candidate.summary : "Generated from a skill candidate.",
    definitions: [
      {
        definition: skillDefinition,
        visibility: {
          workspaceVisible: true,
          promotableToWorkspace: true,
        },
        warnings: [],
      },
    ],
    warnings: [],
    createdAt: "2026-06-20T00:12:00.000Z",
    updatedAt: "2026-06-20T00:12:00.000Z",
  };
}

function mockSkillCandidatePrompt(candidate: Record<string, unknown>): string {
  const definition = isRecord(candidate.definition) ? candidate.definition : {};
  const positiveTriggers = Array.isArray(definition.positiveTriggers) ? definition.positiveTriggers.map(String) : [];
  const negativeTriggers = Array.isArray(definition.negativeTriggers) ? definition.negativeTriggers.map(String) : [];
  const procedureSteps = Array.isArray(definition.procedureSteps) ? definition.procedureSteps.filter(isRecord) : [];
  const validationSteps = Array.isArray(definition.validationSteps) ? definition.validationSteps.filter(isRecord) : [];
  return [
    `# ${typeof candidate.title === "string" ? candidate.title : "Skill candidate"}`,
    "",
    typeof candidate.summary === "string" ? candidate.summary : "Generated from a skill candidate.",
    "",
    "Use when:",
    ...positiveTriggers.map((trigger) => `- ${trigger}`),
    "",
    "Do not use when:",
    ...negativeTriggers.map((trigger) => `- ${trigger}`),
    "",
    "Procedure:",
    ...procedureSteps.map((step, index) => `- ${index + 1}. ${typeof step.title === "string" ? step.title : "Step"}`),
    "",
    "Validation:",
    ...validationSteps.map((step) => `- ${typeof step.title === "string" ? step.title : "Validation"}`),
  ].join("\n");
}

function slugMockSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "skill-candidate";
}

function uniqueMockSkillId(state: MockState, requestedId: string): string {
  const existing = new Set(state.skillRegistryEntries
    .filter(isRecord)
    .map((entry) => typeof entry.id === "string" ? entry.id : "")
    .filter(Boolean));
  if (!existing.has(requestedId)) {
    return requestedId;
  }
  let index = 2;
  while (existing.has(`${requestedId}-${index}`)) {
    index += 1;
  }
  return `${requestedId}-${index}`;
}

function nextMockSkillCandidateStatus(candidate: Record<string, unknown>, action: string, body: Record<string, unknown>): string | undefined {
  if (
    candidate.status === "published" ||
    candidate.status === "rejected" ||
    candidate.status === "quarantined" ||
    candidate.status === "superseded" ||
    candidate.status === "expired"
  ) {
    return undefined;
  }
  if (action === "keep_pending") {
    return "pending";
  }
  if (action === "request_changes") {
    return "needs_edit";
  }
  if (action === "approve_for_draft") {
    return "approved_for_draft";
  }
  if (action === "reject") {
    return "rejected";
  }
  if (action === "quarantine") {
    return "quarantined";
  }
  if (action === "supersede" && typeof body.supersededBy === "string") {
    return "superseded";
  }
  return undefined;
}

function mockSkillCandidateApprovalError(candidate: Record<string, unknown>): string | undefined {
  const definition = isRecord(candidate.definition) ? candidate.definition : {};
  if (!Array.isArray(definition.negativeTriggers) || definition.negativeTriggers.length === 0) {
    return "Skill candidate requires negative triggers before draft approval";
  }
  if (!Array.isArray(definition.validationSteps) || definition.validationSteps.length === 0) {
    return "Skill candidate requires validation steps before draft approval";
  }
  const safetyFindings = Array.isArray(candidate.safetyFindings) ? candidate.safetyFindings.filter(isRecord) : [];
  if (safetyFindings.some((finding) => finding.severity === "critical")) {
    return "Skill candidate has critical safety findings and cannot be approved for draft";
  }
  return undefined;
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
	    thinkingModes: ["off", "minimal", "low", "medium", "high", "xhigh"],
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
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
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
      templateId: "alibaba-bailian-qwen",
      kind: "openai-compatible",
      displayName: "Alibaba Bailian Qwen",
      description: "Alibaba Cloud Model Studio Bailian OpenAI-compatible chat endpoint for Qwen models.",
      providerId: "alibaba-bailian",
      model: "qwen-plus",
      api: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyRef: "env:DASHSCOPE_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "moonshot-kimi",
      kind: "openai-compatible",
      displayName: "Moonshot Kimi",
      description: "Moonshot Kimi OpenAI-compatible chat endpoint.",
      providerId: "moonshot",
      model: "kimi-k2-0711-preview",
      api: "openai-completions",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKeyRef: "env:MOONSHOT_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "baidu-qianfan-ernie",
      kind: "openai-compatible",
      displayName: "Baidu Qianfan ERNIE",
      description: "Baidu Qianfan OpenAI-compatible chat endpoint for ERNIE models.",
      providerId: "baidu-qianfan",
      model: "ernie-4.5-turbo-128k",
      api: "openai-completions",
      baseUrl: "https://qianfan.baidubce.com/v2",
      apiKeyRef: "env:QIANFAN_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "tencent-hunyuan",
      kind: "openai-compatible",
      displayName: "Tencent Hunyuan",
      description: "Tencent Hunyuan OpenAI-compatible chat endpoint.",
      providerId: "tencent-hunyuan",
      model: "hunyuan-turbos-latest",
      api: "openai-completions",
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      apiKeyRef: "env:HUNYUAN_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "siliconflow",
      kind: "openai-compatible",
      displayName: "SiliconFlow",
      description: "SiliconFlow OpenAI-compatible chat endpoint for hosted open models.",
      providerId: "siliconflow",
      model: "Qwen/Qwen3-235B-A22B",
      api: "openai-completions",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKeyRef: "env:SILICONFLOW_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "stepfun",
      kind: "openai-compatible",
      displayName: "StepFun",
      description: "StepFun OpenAI-compatible chat endpoint.",
      providerId: "stepfun",
      model: "step-2-mini",
      api: "openai-completions",
      baseUrl: "https://api.stepfun.com/v1",
      apiKeyRef: "env:STEPFUN_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "baichuan-ai",
      kind: "openai-compatible",
      displayName: "Baichuan AI",
      description: "Baichuan AI OpenAI-compatible chat endpoint.",
      providerId: "baichuan",
      model: "Baichuan4-Turbo",
      api: "openai-completions",
      baseUrl: "https://api.baichuan-ai.com/v1",
      apiKeyRef: "env:BAICHUAN_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "01ai-yi",
      kind: "openai-compatible",
      displayName: "01.AI Yi",
      description: "01.AI Yi OpenAI-compatible chat endpoint.",
      providerId: "01ai",
      model: "yi-lightning",
      api: "openai-completions",
      baseUrl: "https://api.lingyiwanwu.com/v1",
      apiKeyRef: "env:YI_API_KEY",
      capabilities: ["chat", "tool_call"],
      reasoning: false,
      thinkingModes: [],
    }),
    createProviderTemplate({
      templateId: "seedream-image",
      kind: "seedream",
      displayName: "Seedream Image",
      description: "Seedream supplier template for image generation and editing capability.",
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
      description: "Jimeng supplier template for image generation and editing capability.",
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
      description: "Seedance supplier template for video generation capability.",
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
  const provider = {
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
	    thinkingModes: Array.isArray(body.thinkingModes) ? body.thinkingModes : Array.isArray(existing.thinkingModes) ? existing.thinkingModes : [],
	    input: Array.isArray(body.input) ? body.input : Array.isArray(existing.input) ? existing.input : ["text"],
    compat: isRecord(body.compat) ? body.compat : isRecord(existing.compat) ? existing.compat : {},
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : Array.isArray(existing.capabilities) ? existing.capabilities : ["chat"],
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled === true,
    contextWindow: typeof body.contextWindow === "number" ? body.contextWindow : typeof existing.contextWindow === "number" ? existing.contextWindow : undefined,
    maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : typeof existing.maxTokens === "number" ? existing.maxTokens : undefined,
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : "2026-05-25T00:10:00.000Z",
    updatedAt: "2026-05-25T00:10:00.000Z",
  };
  return normalizeMockProviderForGenerationRuntime(provider);
}

function normalizeMockProviderForGenerationRuntime(provider: Record<string, unknown>): Record<string, unknown> {
  const normalizedCompat = normalizeMediaProviderCompat(provider as Parameters<typeof normalizeMediaProviderCompat>[0]);
  if (normalizedCompat === undefined || normalizedCompat === provider.compat) {
    return provider;
  }
  return { ...provider, compat: normalizedCompat };
}

export function createChannelFromBody(body: Record<string, unknown>, id: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    workspaceId: typeof existing.workspaceId === "string" ? existing.workspaceId : "workspace_default",
    name: typeof body.name === "string" ? body.name : typeof existing.name === "string" ? existing.name : "Engineering",
    status: body.status === "paused" || body.status === "archived" || body.status === "active"
      ? body.status
      : existing.status === "paused" || existing.status === "archived" || existing.status === "active"
        ? existing.status
        : "active",
    boundPath: typeof body.boundPath === "string" ? body.boundPath : typeof existing.boundPath === "string" ? existing.boundPath : cwd,
    defaultProviderPresetId: body.defaultProviderPresetId === null || body.defaultProviderPresetId === ""
      ? undefined
      : typeof body.defaultProviderPresetId === "string"
        ? body.defaultProviderPresetId
        : typeof existing.defaultProviderPresetId === "string"
          ? existing.defaultProviderPresetId
          : undefined,
    defaultTeammateId: body.defaultTeammateId === null || body.defaultTeammateId === ""
      ? undefined
      : typeof body.defaultTeammateId === "string"
        ? body.defaultTeammateId
        : typeof existing.defaultTeammateId === "string"
          ? existing.defaultTeammateId
          : undefined,
    autoReplyMode: body.autoReplyMode === null
      ? "mentions_only"
      : body.autoReplyMode !== undefined
        ? readChannelAutoReplyMode(body.autoReplyMode)
        : readChannelAutoReplyMode(existing.autoReplyMode),
    responseLanguage: body.responseLanguage === null
      ? undefined
      : body.responseLanguage !== undefined
        ? readChannelResponseLanguage(body.responseLanguage)
        : readChannelResponseLanguage(existing.responseLanguage),
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools : Array.isArray(existing.allowedTools) ? existing.allowedTools : ["read", "grep", "find", "ls"],
    runtimePolicy: isRecord(body.runtimePolicy)
      ? { ...defaultRuntimePolicy, ...(isRecord(existing.runtimePolicy) ? existing.runtimePolicy : {}), ...body.runtimePolicy }
      : isRecord(existing.runtimePolicy)
        ? existing.runtimePolicy
        : defaultRuntimePolicy,
    workspaceBinding: body.workspaceBinding === null
      ? undefined
      : isRecord(body.workspaceBinding)
        ? body.workspaceBinding
        : isRecord(existing.workspaceBinding)
          ? existing.workspaceBinding
          : undefined,
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : "2026-05-25T00:15:00.000Z",
    updatedAt: "2026-05-25T00:15:00.000Z",
  };
}

function buildMockChannelCollaborationProtocolResponse(channelId: string, channel: Record<string, unknown>): Record<string, unknown> {
  const responseLanguageChannelValue = readChannelResponseLanguage(channel.responseLanguage);
  const responseLanguage = responseLanguageChannelValue === undefined ? "follow_user" : responseLanguageChannelValue === "workspace" ? "follow_user" : responseLanguageChannelValue;
  const autoReplyMode = readChannelAutoReplyMode(channel.autoReplyMode);
  const defaultTeammateId = typeof channel.defaultTeammateId === "string" && channel.defaultTeammateId.trim()
    ? channel.defaultTeammateId
    : undefined;
  const updatedAt = typeof channel.updatedAt === "string" ? channel.updatedAt : "2026-05-25T00:15:00.000Z";
  const protocolOverride = isRecord(channel._protocolOverride) ? channel._protocolOverride : {};
  const protocolVersion = typeof protocolOverride.version === "number" ? protocolOverride.version : undefined;
  const defaultWorkflowPreference = protocolOverride.defaultWorkflowPreference === "architect_engineer_qa" ? "architect_engineer_qa" : "manual";
  const visibleMultiReplyMaxParticipants = typeof protocolOverride.visibleMultiReplyMaxParticipants === "number"
    ? protocolOverride.visibleMultiReplyMaxParticipants
    : 3;
  const privacyRules = Array.isArray(protocolOverride.privacyRules) ? protocolOverride.privacyRules.map(String) : [];
  const reviewRules = Array.isArray(protocolOverride.reviewRules) ? protocolOverride.reviewRules.map(String) : [];
  return {
    cwd,
    protocol: {
      schemaVersion: 1,
      channelId,
      responseLanguage,
      autoReplyMode,
      defaultTeammateId,
      protocolVersion,
      defaultWorkflowPreference,
      visibleMultiReplyMaxParticipants,
      privacyRules,
      reviewRules,
      updatedBy: typeof protocolOverride.updatedBy === "string"
        ? protocolOverride.updatedBy
        : responseLanguageChannelValue || autoReplyMode !== "mentions_only" || defaultTeammateId ? "local-user" : "system_template",
      updatedAt,
    },
    sources: {
      responseLanguage: {
        value: responseLanguage,
        source: responseLanguageChannelValue ? "channel_setting" : "workspace_setting",
        channelValue: responseLanguageChannelValue,
        workspaceValue: "follow_user",
      },
      autoReplyMode: {
        value: autoReplyMode,
        source: autoReplyMode === "mentions_only" ? "default" : "channel_setting",
        channelValue: autoReplyMode === "mentions_only" ? undefined : autoReplyMode,
      },
      defaultTeammateId: {
        value: defaultTeammateId,
        source: defaultTeammateId ? "channel_setting" : "default",
        channelValue: defaultTeammateId,
      },
      defaultWorkflowPreference: {
        value: defaultWorkflowPreference,
        source: protocolVersion ? "protocol_override" : "default",
      },
      visibleMultiReplyMaxParticipants: {
        value: visibleMultiReplyMaxParticipants,
        source: protocolVersion ? "protocol_override" : "default",
      },
      privacyRules: {
        value: privacyRules,
        source: protocolVersion ? "protocol_override" : "default",
      },
      reviewRules: {
        value: reviewRules,
        source: protocolVersion ? "protocol_override" : "default",
      },
    },
    storage: {
      mode: "channel_fields_and_protocol_overrides",
      editableFields: ["responseLanguage", "autoReplyMode", "defaultTeammateId", "defaultWorkflowPreference", "visibleMultiReplyMaxParticipants", "privacyRules", "reviewRules"],
      unsupportedFields: [],
    },
  };
}

function buildMockChannelProtocolCanvasResponse(state: MockState, channelId: string, channel: Record<string, unknown>): Record<string, unknown> {
  const candidateClusters = state.procedureObservationClusters.filter((item) =>
    isRecord(item) &&
    item.channelId === channelId &&
    (item.routeKind === "channel_protocol" || item.routeKind === "playbook")
  );
  const draftCandidates = state.channelProtocolDrafts.filter((item) =>
    isRecord(item) &&
    item.channelId === channelId &&
    item.status === "draft"
  );
  return {
    ...buildMockChannelCollaborationProtocolResponse(channelId, channel),
    candidateClusters,
    draftCandidates,
    sections: [
      {
        kind: "current_protocol",
        title: "Current protocol",
        summary: "Effective channel coordination settings are available.",
        itemCount: 1,
        status: "healthy",
      },
      {
        kind: "candidate_clusters",
        title: "Candidate clusters",
        summary: candidateClusters.length > 0 ? "Observed channel candidates need review." : "No channel candidates need review.",
        itemCount: candidateClusters.length,
        status: candidateClusters.length > 0 ? "needs_review" : "empty",
      },
      {
        kind: "draft_backlog",
        title: "Draft backlog",
        summary: draftCandidates.length > 0 ? "Draft candidates are waiting." : "No draft candidates are waiting.",
        itemCount: draftCandidates.length,
        status: draftCandidates.length > 0 ? "needs_review" : "empty",
      },
    ],
  };
}

function createMockChannelProtocolDraft(state: MockState, channelId: string, body: Record<string, unknown>): Record<string, unknown> {
  const proposedPatch = isRecord(body.proposedPatch) ? body.proposedPatch : {};
  return {
    id: `channel_protocol_draft_${state.channelProtocolDrafts.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    baseVersion: typeof body.baseVersion === "number" ? body.baseVersion : undefined,
    proposedPatch,
    reason: typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "AI drafted channel protocol changes for user review.",
    createdBy: body.createdBy === "local-user" ? "local-user" : "ai-draft",
    sourceRefs: Array.isArray(body.sourceRefs) ? body.sourceRefs.filter(isRecord) : [],
    status: "draft",
    appliedProtocolVersion: undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    createdAt: "2026-06-20T00:30:00.000Z",
    updatedAt: "2026-06-20T00:30:00.000Z",
  };
}

function createMockChannelPlaybookCandidate(state: MockState, channelId: string, cluster: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `channel_playbook_candidate_${state.channelPlaybookCandidates.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : String(cluster.title ?? "Channel playbook"),
    summary: typeof body.summary === "string" && body.summary.trim() ? body.summary.trim() : String(cluster.summary ?? ""),
    normalizedGoal: typeof body.normalizedGoal === "string" && body.normalizedGoal.trim()
      ? body.normalizedGoal.trim()
      : String(cluster.normalizedGoal ?? ""),
    procedureSteps: Array.isArray(body.procedureSteps)
      ? body.procedureSteps.filter(isRecord)
      : Array.isArray(cluster.procedureSteps)
        ? cluster.procedureSteps.filter(isRecord)
        : [],
    validationSteps: Array.isArray(body.validationSteps)
      ? body.validationSteps.filter(isRecord)
      : Array.isArray(cluster.validationSteps)
        ? cluster.validationSteps.filter(isRecord)
        : [],
    positiveTriggers: Array.isArray(body.positiveTriggers) ? body.positiveTriggers.filter((item) => typeof item === "string") : cluster.positiveTriggers,
    negativeTriggers: Array.isArray(body.negativeTriggers) ? body.negativeTriggers.filter((item) => typeof item === "string") : cluster.negativeTriggers,
    sourceRefs: Array.isArray(cluster.sourceRefs) ? cluster.sourceRefs.filter(isRecord) : [],
    reason: typeof body.reason === "string" && body.reason.trim()
      ? body.reason
      : `Created from procedure observation cluster ${String(cluster.id ?? "")}: ${String(cluster.title ?? "")}`,
    createdBy: "ai-draft",
    status: "draft",
    activatedAt: undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    createdAt: "2026-06-20T00:35:00.000Z",
    updatedAt: "2026-06-20T00:35:00.000Z",
  };
}

function applyMockChannelProtocolDraft(channel: Record<string, unknown>, draft: Record<string, unknown>): {
  readonly channel: Record<string, unknown>;
  readonly draft: Record<string, unknown>;
} {
  const currentOverride = isRecord(channel._protocolOverride) ? channel._protocolOverride : {};
  const proposedPatch = isRecord(draft.proposedPatch) ? draft.proposedPatch : {};
  const nextVersion = typeof currentOverride.version === "number" ? currentOverride.version + 1 : 1;
  const nextOverride = {
    ...currentOverride,
    version: nextVersion,
    defaultWorkflowPreference: proposedPatch.defaultWorkflowPreference ?? currentOverride.defaultWorkflowPreference,
    visibleMultiReplyMaxParticipants: proposedPatch.visibleMultiReplyMaxParticipants ?? currentOverride.visibleMultiReplyMaxParticipants,
    privacyRules: Array.isArray(proposedPatch.privacyRules) ? proposedPatch.privacyRules : currentOverride.privacyRules,
    reviewRules: Array.isArray(proposedPatch.reviewRules) ? proposedPatch.reviewRules : currentOverride.reviewRules,
    updatedBy: draft.createdBy === "local-user" ? "local-user" : "ai-draft",
  };
  const nextChannel = createChannelFromBody({
    responseLanguage: proposedPatch.responseLanguage,
    autoReplyMode: proposedPatch.autoReplyMode,
    defaultTeammateId: proposedPatch.defaultTeammateId,
  }, String(channel.id ?? "channel_engineering"), channel);
  const updatedChannel = {
    ...nextChannel,
    _protocolOverride: nextOverride,
  };
  return {
    channel: updatedChannel,
    draft: {
      ...draft,
      status: "applied",
      appliedProtocolVersion: nextVersion,
      updatedAt: "2026-06-20T00:31:00.000Z",
    },
  };
}

export function createChannelBranchFromBody(
  body: Record<string, unknown>,
  id: string,
  channelId: string,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const status = body.status === "archived" || body.status === "active"
    ? body.status
    : existing.status === "archived" || existing.status === "active"
      ? existing.status
      : "active";
  const archivedAt = status === "archived"
    ? typeof existing.archivedAt === "string" ? existing.archivedAt : "2026-05-25T00:17:00.000Z"
    : undefined;
  return {
    id,
    workspaceId: typeof existing.workspaceId === "string" ? existing.workspaceId : "workspace_default",
    channelId,
    name: typeof body.name === "string" ? body.name : typeof existing.name === "string" ? existing.name : "New branch",
    status,
    rootThreadId: typeof existing.rootThreadId === "string"
      ? existing.rootThreadId
      : typeof body.rootThreadId === "string"
        ? body.rootThreadId
        : mockChannelBranchRootThreadId(id),
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : "2026-05-25T00:17:00.000Z",
    updatedAt: "2026-05-25T00:17:00.000Z",
    archivedAt,
  };
}

function mockChannelBranchRootThreadId(branchId: string): string {
  return `thread_${branchId}`;
}

function ensureMockChannelBranchRootThread(
  state: MockState,
  channel: Record<string, unknown>,
  branch: Record<string, unknown>,
): Record<string, unknown> {
  const branchId = typeof branch.id === "string" ? branch.id : `channel_branch_${state.channelBranches.length + 1}`;
  const rootThreadId = typeof branch.rootThreadId === "string" ? branch.rootThreadId : mockChannelBranchRootThreadId(branchId);
  const nextBranch = branch.rootThreadId === rootThreadId ? branch : { ...branch, rootThreadId };
  if (!state.threads.some((thread) => thread.id === rootThreadId && thread.kind === "channel_discussion" && thread.channelId === branch.channelId)) {
    state.threads.unshift(createMockChannelBranchThread(channel, nextBranch, rootThreadId));
  }
  syncMockChannelBranchThreadArchive(state, nextBranch);
  return nextBranch;
}

function createMockChannelBranchThread(
  channel: Record<string, unknown>,
  branch: Record<string, unknown>,
  rootThreadId: string,
): MockLingThread {
  const branchName = typeof branch.name === "string" && branch.name.trim() ? branch.name.trim() : "Channel branch";
  const channelName = typeof channel.name === "string" && channel.name.trim() ? channel.name.trim() : String(branch.channelId ?? "channel");
  const archivedAt = branch.status === "archived"
    ? typeof branch.archivedAt === "string" ? branch.archivedAt : "2026-05-25T00:17:00.000Z"
    : undefined;
  return {
    id: rootThreadId,
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: typeof branch.channelId === "string" ? branch.channelId : undefined,
    title: branchName,
    objective: `Conversation branch "${branchName}" for ${channelName}.`,
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: typeof branch.createdAt === "string" ? branch.createdAt : "2026-05-25T00:17:00.000Z",
    updatedAt: typeof branch.updatedAt === "string" ? branch.updatedAt : "2026-05-25T00:17:00.000Z",
    archivedAt,
    archivedReason: archivedAt ? "channel_branch_archived" : undefined,
  };
}

function syncMockChannelBranchThreadArchive(state: MockState, branch: Record<string, unknown>): void {
  const rootThreadId = typeof branch.rootThreadId === "string" ? branch.rootThreadId : undefined;
  if (!rootThreadId) {
    return;
  }
  const thread = state.threads.find((item) => item.id === rootThreadId);
  if (!thread) {
    return;
  }
  thread.updatedAt = "2026-05-25T00:18:00.000Z";
  if (branch.status === "archived") {
    thread.archivedAt = typeof branch.archivedAt === "string" ? branch.archivedAt : "2026-05-25T00:18:00.000Z";
    thread.archivedReason = "channel_branch_archived";
    return;
  }
  if (thread.status === "archived") {
    thread.status = "open";
  }
  delete thread.archivedAt;
  delete thread.archivedReason;
}

function readChannelAutoReplyMode(value: unknown): string {
  return value === "default_teammate" || value === "auto_route" ? value : "mentions_only";
}

function readChannelResponseLanguage(value: unknown): "workspace" | "follow_user" | "zh-CN" | "en-US" | undefined {
  return value === "workspace" || value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
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

function createMockAiCouncil(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "council_builtin_development",
    workspaceId: "workspace_default",
    source: "builtin",
    templateId: "development",
    displayName: "Development Council",
    description: "Engineering, design, and QA specialists for product development channels.",
    routingPolicy: {
      defaultMode: "parallel_review",
      maxActiveMembers: 4,
      notes: ["Attach by reference; do not copy members into channel memberships."],
    },
    governanceProfile: {
      permissionBoundary: "restrict_only",
      approvalBoundary: "cannot_bypass",
      toolGrantBoundary: "cannot_grant",
      credentialBoundary: "cannot_grant",
      notes: ["Council policy can restrict authority only."],
    },
    status: "active",
    pinned: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

function createMockAiCouncilMembers(councilId = "council_builtin_development"): Record<string, unknown>[] {
  return [
    {
      councilId,
      teammateId: "teammate_builtin_engineer",
      slotKey: "implementation",
      label: "Implementation",
      position: 0,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
    {
      councilId,
      teammateId: "teammate_builtin_designer",
      slotKey: "product_design",
      label: "Product design",
      position: 1,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
    {
      councilId,
      teammateId: "teammate_builtin_qa",
      slotKey: "verification",
      label: "Verification",
      position: 2,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
}

function unsupportedMockKeyMessage(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
): string | undefined {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return `${path}.${key} is not supported`;
    }
  }
  return undefined;
}

function readMockAiCouncilRoutingPolicy(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {
      defaultMode: "advisory",
      notes: ["Attach by reference; do not copy members into channel memberships."],
    };
  }
  return {
    defaultMode: typeof input.defaultMode === "string" ? input.defaultMode : "advisory",
    maxActiveMembers: typeof input.maxActiveMembers === "number" ? input.maxActiveMembers : undefined,
    notes: Array.isArray(input.notes) ? input.notes.filter((note): note is string => typeof note === "string") : ["Attach by reference; do not copy members into channel memberships."],
  };
}

function normalizeMockAiCouncilMembers(councilId: string, input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((member, index) => {
    if (!isRecord(member) || typeof member.teammateId !== "string" || member.teammateId === "ling_agent") {
      return [];
    }
    return [{
      councilId,
      teammateId: member.teammateId,
      slotKey: typeof member.slotKey === "string" ? member.slotKey : undefined,
      label: typeof member.label === "string" ? member.label : undefined,
      position: typeof member.position === "number" ? member.position : index,
      enabled: member.enabled !== false,
      createdAt: "2026-06-20T00:02:00.000Z",
      updatedAt: "2026-06-20T00:02:00.000Z",
    }];
  });
}

function unsupportedMockAiCouncilMemberMessage(input: unknown): string | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  for (const [index, member] of input.entries()) {
    if (!isRecord(member)) {
      continue;
    }
    const unsupported = unsupportedMockKeyMessage(member, mockReplaceAiCouncilMemberKeys, `members[${index}]`);
    if (unsupported) {
      return unsupported;
    }
  }
  return undefined;
}

function detachMockCouncilFromChannels(state: MockState, councilId: string): void {
  state.channelCouncilPolicies = state.channelCouncilPolicies.map((policy) => {
    if (!isRecord(policy) || !Array.isArray(policy.attachedCouncilIds) || !policy.attachedCouncilIds.includes(councilId)) {
      return policy;
    }
    const attachedCouncilIds = policy.attachedCouncilIds.filter((id): id is string => typeof id === "string" && id !== councilId);
    const preferredCouncilId = policy.preferredCouncilId === councilId
      ? attachedCouncilIds[0]
      : typeof policy.preferredCouncilId === "string" ? policy.preferredCouncilId : undefined;
    return {
      ...policy,
      attachedCouncilIds,
      preferredCouncilId,
      updatedAt: "2026-06-20T00:03:00.000Z",
    };
  });
}

function buildMockAiCouncilHealthReport(state: MockState, limit = 500): Record<string, unknown> {
  const findings: Record<string, unknown>[] = [];
  let totalMembers = 0;
  let availableMembers = 0;
  let blockedMembers = 0;

  for (const council of state.aiCouncils) {
    if (!isRecord(council) || typeof council.id !== "string") {
      continue;
    }
    const councilId = council.id;
    const members = state.aiCouncilMembers
      .filter((item) => isRecord(item) && item.councilId === councilId)
      .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
    totalMembers += members.length;
    const councilDisplayName = typeof council.displayName === "string" ? council.displayName : councilId;
    const councilStatus = typeof council.status === "string" ? council.status : "active";

    if (councilStatus !== "active") {
      findings.push(createMockCouncilHealthFinding({
        kind: "council_not_active",
        severity: "warning",
        councilId,
        councilDisplayName,
        title: "Council is not active",
        message: `${councilDisplayName} is ${councilStatus} and will not project specialists into channels.`,
      }));
    }
    if (members.length === 0) {
      findings.push(createMockCouncilHealthFinding({
        kind: "council_empty",
        severity: councilStatus === "active" ? "critical" : "warning",
        councilId,
        councilDisplayName,
        title: "Council has no members",
        message: `${councilDisplayName} has no member projections.`,
      }));
    }

    let availableMembersForCouncil = 0;
    for (const member of members) {
      const teammateId = typeof member.teammateId === "string" ? member.teammateId : "";
      const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
      const blockedReason = mockCouncilMemberBlockedReason(member, teammate);
      if (!blockedReason) {
        availableMembers += 1;
        availableMembersForCouncil += 1;
        continue;
      }
      blockedMembers += 1;
      findings.push(createMockCouncilMemberHealthFinding(councilId, councilDisplayName, member, blockedReason));
    }

    if (councilStatus === "active" && members.length > 0 && availableMembersForCouncil === 0) {
      findings.push(createMockCouncilHealthFinding({
        kind: "council_no_available_members",
        severity: "critical",
        councilId,
        councilDisplayName,
        title: "Council has no available members",
        message: `${councilDisplayName} cannot project any runnable specialists.`,
      }));
    }
  }

  return {
    workspaceId: "workspace_default",
    generatedAt: "2026-06-20T00:02:00.000Z",
    summary: {
      totalCouncils: state.aiCouncils.filter(isRecord).length,
      activeCouncils: state.aiCouncils.filter((item) => isRecord(item) && item.status === "active").length,
      totalMembers,
      availableMembers,
      blockedMembers,
      findings: countMockCouncilHealthFindings(findings),
    },
    findings: findings.slice(0, Math.max(0, Math.min(limit, 500))),
  };
}

function mockCouncilMemberBlockedReason(member: Record<string, unknown>, teammate: unknown): string | undefined {
  if (member.enabled === false) {
    return "member_disabled";
  }
  if (!isRecord(teammate)) {
    return "teammate_missing";
  }
  if (teammate.id === "ling_agent" || teammate.systemRole === "ling_agent") {
    return "system_teammate_excluded";
  }
  if (teammate.status !== "active") {
    return "teammate_not_active";
  }
  if (teammate.hidden === true) {
    return "teammate_hidden";
  }
  return undefined;
}

function createMockCouncilHealthFinding(input: {
  kind: string;
  severity: "info" | "warning" | "critical";
  councilId: string;
  councilDisplayName: string;
  title: string;
  message: string;
}): Record<string, unknown> {
  return {
    id: `ai-council-health:${input.kind}:${input.councilId}`,
    kind: input.kind,
    severity: input.severity,
    councilId: input.councilId,
    councilDisplayName: input.councilDisplayName,
    title: input.title,
    message: input.message,
  };
}

function createMockCouncilMemberHealthFinding(
  councilId: string,
  councilDisplayName: string,
  member: Record<string, unknown>,
  blockedReason: string,
): Record<string, unknown> {
  const kind = mockCouncilHealthKindFromBlockedReason(blockedReason);
  const teammateId = typeof member.teammateId === "string" ? member.teammateId : "";
  const label = typeof member.label === "string"
    ? member.label
    : typeof member.slotKey === "string" ? member.slotKey : teammateId;
  return {
    id: `ai-council-health:${kind}:${councilId}:${teammateId}`,
    kind,
    severity: mockCouncilHealthSeverityFromFindingKind(kind),
    councilId,
    councilDisplayName,
    teammateId,
    slotKey: member.slotKey,
    label: member.label,
    title: mockCouncilHealthTitleFromFindingKind(kind),
    message: `${label} is not available in ${councilDisplayName}: ${blockedReason}.`,
  };
}

function mockCouncilHealthKindFromBlockedReason(blockedReason: string): string {
  if (blockedReason === "member_disabled") {
    return "member_disabled";
  }
  if (blockedReason === "teammate_missing") {
    return "teammate_missing";
  }
  if (blockedReason === "teammate_hidden") {
    return "teammate_hidden";
  }
  if (blockedReason === "system_teammate_excluded") {
    return "system_teammate_excluded";
  }
  return "teammate_not_active";
}

function mockCouncilHealthSeverityFromFindingKind(kind: string): "info" | "warning" | "critical" {
  if (kind === "teammate_missing" || kind === "council_no_available_members" || kind === "council_empty") {
    return "critical";
  }
  if (kind === "member_disabled") {
    return "info";
  }
  return "warning";
}

function mockCouncilHealthTitleFromFindingKind(kind: string): string {
  if (kind === "member_disabled") {
    return "Council member is disabled";
  }
  if (kind === "teammate_missing") {
    return "Council member teammate is missing";
  }
  if (kind === "teammate_hidden") {
    return "Council member teammate is hidden";
  }
  if (kind === "system_teammate_excluded") {
    return "System teammate is excluded";
  }
  return "Council member teammate is not active";
}

function countMockCouncilHealthFindings(
  findings: readonly Record<string, unknown>[],
): Record<"info" | "warning" | "critical", number> {
  return findings.reduce<Record<"info" | "warning" | "critical", number>>(
    (counts, finding) => {
      if (finding.severity === "info" || finding.severity === "warning" || finding.severity === "critical") {
        counts[finding.severity] += 1;
      }
      return counts;
    },
    { info: 0, warning: 0, critical: 0 },
  );
}

function createMockLingAgentTeammate(): Record<string, unknown> {
  return {
    id: "ling_agent",
    workspaceId: "workspace_default",
    templateId: "ling_agent",
    kind: "system_teammate",
    systemRole: "ling_agent",
    roleKey: "custom",
    displayName: "Ling Agent",
    description: "Coordinates scoped channel work.",
    avatarTone: "violet",
    providerPresetId: undefined,
    systemPrompt: "You are Ling Agent.",
    appendSystemPrompt: [],
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    approvalProfile: { mode: "standard", risk: "medium" },
    status: "active",
    pinned: true,
    hidden: false,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  };
}

function mockTeammateCanRunInChannel(state: MockState, channelId: string, teammateId: string): boolean {
  if (teammateId === "ling_agent") {
    return true;
  }
  const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
  if (isRecord(channel) && channel.defaultTeammateId === teammateId) {
    return true;
  }
  if (state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.channelId === channelId && item.teammateId === teammateId
  )) {
    return true;
  }
  const effectiveCouncil = buildMockEffectiveChannelCouncil(state, channelId);
  return Array.isArray(effectiveCouncil.specialists) &&
    effectiveCouncil.specialists.some((specialist) => isRecord(specialist) && specialist.teammateId === teammateId);
}

function readMockChannelCouncilPolicy(state: MockState, channelId: string): Record<string, unknown> {
  const existing = state.channelCouncilPolicies.find((item) => isRecord(item) && item.channelId === channelId);
  if (isRecord(existing)) {
    return existing;
  }
  return {
    workspaceId: "workspace_default",
    channelId,
    attachedCouncilIds: [],
    preferredCouncilId: undefined,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function writeMockChannelCouncilPolicy(state: MockState, channelId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const existing = readMockChannelCouncilPolicy(state, channelId);
  const attachedCouncilIds = Array.isArray(patch.attachedCouncilIds)
    ? patch.attachedCouncilIds.filter((id): id is string => typeof id === "string")
    : Array.isArray(existing.attachedCouncilIds) ? existing.attachedCouncilIds.filter((id): id is string => typeof id === "string") : [];
  const preferredCouncilId = patch.preferredCouncilId === null
    ? undefined
    : typeof patch.preferredCouncilId === "string"
      ? patch.preferredCouncilId
      : typeof existing.preferredCouncilId === "string" ? existing.preferredCouncilId : undefined;
  const next = {
    workspaceId: "workspace_default",
    channelId,
    attachedCouncilIds,
    preferredCouncilId: preferredCouncilId && attachedCouncilIds.includes(preferredCouncilId) ? preferredCouncilId : attachedCouncilIds[0],
    createdAt: typeof existing.createdAt === "string" ? existing.createdAt : "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:01:00.000Z",
  };
  state.channelCouncilPolicies = [
    ...state.channelCouncilPolicies.filter((item) => !isRecord(item) || item.channelId !== channelId),
    next,
  ];
  return next;
}

function buildMockEffectiveChannelCouncil(state: MockState, channelId: string): Record<string, unknown> {
  const policy = readMockChannelCouncilPolicy(state, channelId);
  const attachedCouncilIds = Array.isArray(policy.attachedCouncilIds) ? policy.attachedCouncilIds.filter((id): id is string => typeof id === "string") : [];
  const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
  const specialistById = new Map<string, Record<string, unknown>>();

  function teammateForId(teammateId: string): Record<string, unknown> | undefined {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate : undefined;
  }

  function addSpecialist(teammateId: string, source: Record<string, unknown>, isDefault = false): void {
    const teammate = teammateForId(teammateId);
    if (!teammate || teammateId === "ling_agent" || teammate.systemRole === "ling_agent" || teammate.status === "disabled" || teammate.hidden === true) {
      return;
    }
    const existing = specialistById.get(teammateId);
    if (existing) {
      existing.sources = [...(Array.isArray(existing.sources) ? existing.sources : []), source];
      existing.isDefault = existing.isDefault === true || isDefault;
      return;
    }
    specialistById.set(teammateId, {
      teammateId,
      teammate,
      sources: [source],
      isDefault,
    });
  }

  for (const membership of state.teammateChannelMemberships) {
    if (!isRecord(membership) || membership.channelId !== channelId || typeof membership.teammateId !== "string") {
      continue;
    }
    addSpecialist(membership.teammateId, { kind: "direct", isDefault: membership.isDefault === true }, membership.isDefault === true);
  }
  if (isRecord(channel) && typeof channel.defaultTeammateId === "string") {
    addSpecialist(channel.defaultTeammateId, { kind: "direct", isDefault: true }, true);
  }

  const councils = attachedCouncilIds
    .map((councilId) => state.aiCouncils.find((item) => isRecord(item) && item.id === councilId && item.status === "active"))
    .filter((council): council is Record<string, unknown> => isRecord(council))
    .map((council) => {
      const councilId = String(council.id);
      const members = state.aiCouncilMembers
        .filter((item) => isRecord(item) && item.councilId === councilId)
        .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0))
        .map((member) => {
          const teammateId = typeof member.teammateId === "string" ? member.teammateId : "";
          const teammate = teammateForId(teammateId);
          const enabled = member.enabled !== false && Boolean(teammate) && teammate?.status !== "disabled" && teammate?.hidden !== true;
          if (enabled && teammateId) {
            addSpecialist(teammateId, {
              kind: "council",
              councilId,
              councilDisplayName: council.displayName,
              slotKey: member.slotKey,
              label: member.label,
            });
          }
          return {
            member,
            teammate,
            enabled,
            blockedReason: enabled ? undefined : "teammate_unavailable",
          };
        });
      return { council, members };
    });

  return {
    channelId,
    policy,
    councils,
    specialists: [...specialistById.values()],
  };
}

function maybeCreateMockWorkflowProposal(
  state: MockState,
  channelId: string,
  message: Record<string, unknown>,
  autoReplyMode: string,
): { readonly autoStartedWorkflow?: unknown } | undefined {
  const body = typeof message.body === "string" ? message.body : "";
  const executableProposal = maybeCreateMockSingleStepExecutableProposal(state, channelId, message, body);
  if (executableProposal) {
    return executableProposal;
  }
  const lower = body.toLowerCase();
  const allTeammates = /(所有|全部|全体|每个|每位).{0,8}(队友|agent|teammate|agents)/iu.test(body);
  const orderedWork = /(architect|架构|架构师).{0,80}(engineer|工程|实现|开发|qa|测试|验证|验收)/iu.test(body) ||
    /(engineer|工程|实现|开发).{0,80}(qa|测试|验证|验收)/iu.test(body) ||
    /(先|然后|接着|再).{0,80}(实现|验证|测试|review|qa|工程|架构|拆解)/iu.test(body);
  const roleOrder = ["architect", "engineer", "qa", "designer", "product", "security", "docs", "release"];
  const matchedRoles = roleOrder.filter((role) => mockTextMentionsRole(lower, role));
  if (!allTeammates && !orderedWork && matchedRoles.length < 2) {
    return undefined;
  }

  const effectiveCouncil = buildMockEffectiveChannelCouncil(state, channelId);
  const effectiveSpecialists = Array.isArray(effectiveCouncil.specialists)
    ? effectiveCouncil.specialists.filter(isRecord)
    : [];
  const channelTeammates = effectiveSpecialists
    .map((specialist) => isRecord(specialist.teammate) ? specialist.teammate : undefined)
    .filter((teammate): teammate is Record<string, unknown> => Boolean(teammate));
  const sourcesByTeammateId = new Map(effectiveSpecialists.flatMap((specialist) =>
    typeof specialist.teammateId === "string" && Array.isArray(specialist.sources)
      ? [[specialist.teammateId, specialist.sources.filter(isRecord)] as const]
      : []
  ));
  const selectedTeammates = allTeammates
    ? roleOrder.flatMap((role) => {
        const teammate = channelTeammates.find((item) => item.roleKey === role);
        return teammate ? [teammate] : [];
      }).slice(0, 5)
    : roleOrder.flatMap((role) => {
        if (!matchedRoles.includes(role)) {
          return [];
        }
        const teammate = channelTeammates.find((item) => item.roleKey === role);
        return teammate ? [teammate] : [];
      });
  const finalSelectedTeammates = selectedTeammates.length > 0
    ? selectedTeammates
    : [createMockLingAgentTeammate()];

  const engineer = finalSelectedTeammates.find((teammate) => teammate.roleKey === "engineer");
  const assignee = engineer ?? finalSelectedTeammates[0];
  const assigneeId = typeof assignee?.id === "string" ? assignee.id : "ling_agent";
  const proposal = {
    id: `proposal_${state.channelExecutionProposals.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    sourceMessageId: typeof message.id === "string" ? message.id : "",
    proposedByTeammateId: assigneeId,
    title: body.length > 72 ? `${body.slice(0, 69)}...` : body,
    prompt: `The user message looks like a coordinated workflow request.\n\nOriginal request: ${body}\n\nNon-direct multi-agent collaboration waits for user confirmation before starting.`,
    assigneeTeammateId: assigneeId,
    acceptanceCriteria: [
      "Confirm the collaboration scope before starting execution.",
      "Run each implementation step through the existing channel task/run path.",
      "Keep selector, handoff, run, approval, and artifact evidence expandable.",
    ],
    collaborationSteps: finalSelectedTeammates.map((teammate) => ({
      teammateId: typeof teammate.id === "string" ? teammate.id : "teammate_builtin_engineer",
      action: teammate.roleKey === "qa" || teammate.roleKey === "designer" || teammate.roleKey === "docs" ? "reviewed" : "coordinated",
      summary: mockProposalStepSummary(typeof teammate.roleKey === "string" ? teammate.roleKey : "engineer"),
      ...(typeof teammate.id === "string" && sourcesByTeammateId.get(teammate.id)?.length
        ? { sources: sourcesByTeammateId.get(teammate.id) }
        : {}),
    })),
    requiredTools: Array.from(new Set(finalSelectedTeammates.flatMap((teammate) => Array.isArray(teammate.allowedTools) ? teammate.allowedTools : []))),
    riskSummary: allTeammates
      ? "Converted an all-teammates request into one workflow proposal instead of visible group chat."
      : "Non-direct multi-agent collaboration waits for confirmation and continues through existing workflow/run approvals.",
    shaping: {
      status: "ready_for_confirmation",
      summary: body,
      openQuestions: [],
      clarifications: [],
      sourceRefs: typeof message.id === "string" ? [{ type: "message", id: message.id }] : [],
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
    status: "draft",
    createdAt: "2026-05-25T00:18:02.000Z",
    updatedAt: "2026-05-25T00:18:02.000Z",
  };
  state.channelExecutionProposals.unshift(proposal);
  state.channelIntentDecisions.push({
    schemaVersion: 1,
    id: `intent_${state.channelIntentDecisions.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    sourceMessageId: typeof message.id === "string" ? message.id : "",
    action: "workflow_proposal",
    proposalId: proposal.id,
    reason: "Workflow proposal created from channel intent.",
    status: "accepted",
    createdBy: "deterministic",
    createdAt: "2026-05-25T00:18:00.500Z",
    updatedAt: "2026-05-25T00:18:00.500Z",
  });
  return {};
}

function maybeCreateMockMaterializationClarifyReply(
  state: MockState,
  channelId: string,
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body = typeof message.body === "string" ? message.body : "";
  const attachmentIds = Array.isArray(message.attachmentIds) ? message.attachmentIds.filter((item): item is string => typeof item === "string") : [];
  const linkPreviewIds = Array.isArray(message.linkPreviewIds) ? message.linkPreviewIds.filter((item): item is string => typeof item === "string") : [];
  const wantsAttachmentBody = /(附件|附图|截图|图片|图里|文件内容|这个文件|这个图|这张图|这份文档|attached file|attachment|screenshot|image|this file|this document)/iu.test(body);
  const wantsLinkBody = /(链接|网页|页面|网址|url|link|page|article)/iu.test(body) &&
    /(总结|概括|读取|读一下|提取|分析|看看|summarize|read|extract|analy[sz]e|what.*about)/iu.test(body);
  let replyBody = "";
  let decisionReason = "Mock materialization clarify reply.";
  if (wantsAttachmentBody) {
    const attachment = attachmentIds
      .map((attachmentId) => state.channelAttachments.find((item) => isRecord(item) && item.id === attachmentId && item.channelId === channelId))
      .find((item): item is Record<string, unknown> =>
        isRecord(item) &&
        item.kind !== "text" &&
        item.materializationStatus !== "available" &&
        item.previewStatus !== "available"
      );
    if (attachment) {
      const fileName = typeof attachment.fileName === "string" ? attachment.fileName : "attachment";
      if (attachment.kind === "image") {
        replyBody = `I could not read image content from ${fileName}. Upload a readable image, or paste the relevant details.`;
      } else if (attachment.kind === "pdf") {
        replyBody = `I could not read PDF content from ${fileName}. Upload a readable file, or paste the section to use.`;
      } else {
        replyBody = `I could not read document content from ${fileName}. Upload a readable file, or paste the section that matters.`;
      }
      decisionReason = `Mock attachment content is not materialized: ${fileName}`;
    }
  }
  if (!replyBody && wantsLinkBody) {
    const preview = linkPreviewIds
      .map((previewId) => state.channelLinkPreviews.find((item) => isRecord(item) && item.id === previewId && item.channelId === channelId))
      .find((item): item is Record<string, unknown> => isRecord(item));
    if (preview) {
      const url = typeof preview.url === "string" ? preview.url : "link";
      const title = typeof preview.title === "string" ? preview.title : url;
      replyBody = preview.status === "blocked"
        ? `I will not open local/private links automatically. Paste the content, or ask me to inspect it as a controlled task.`
        : `I can read ${title} first, or you can paste the text you want summarized.`;
      decisionReason = preview.status === "blocked"
        ? `Mock link body materialization is blocked: ${url}${typeof preview.errorMessage === "string" ? ` (${preview.errorMessage})` : ""}`
        : `Mock link body is metadata-only: ${url}`;
    }
  }
  if (!replyBody) {
    return undefined;
  }
  const aiReply = {
    id: `msg_${state.channelMessages.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    threadId: typeof message.id === "string" ? message.id : undefined,
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: replyBody,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-05-25T00:18:01.000Z",
    updatedAt: "2026-05-25T00:18:01.000Z",
  };
  state.channelMessages.push(aiReply);
  state.channelIntentDecisions.push({
    schemaVersion: 1,
    id: `intent_${state.channelIntentDecisions.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    sourceMessageId: typeof message.id === "string" ? message.id : "",
    action: "clarify",
    selectedTeammateId: "ling_agent",
    replyMessageId: aiReply.id,
    reason: decisionReason,
    status: "accepted",
    createdBy: "deterministic",
    createdAt: "2026-05-25T00:18:00.500Z",
    updatedAt: "2026-05-25T00:18:00.500Z",
  });
  return aiReply;
}

function isMockContextualFollowUp(body: string): boolean {
  const trimmed = body.trim();
  return /^(继续|继续吧|接着|接着说|改短点|再短点|400字|下一步|next|continue)$/iu.test(trimmed);
}

function maybeCreateMockSingleStepExecutableProposal(
  state: MockState,
  channelId: string,
  message: Record<string, unknown>,
  body: string,
): { readonly autoStartedWorkflow?: unknown } | undefined {
  if (!body.trim()) {
    return undefined;
  }
  const isCreate = /(创建|新建|生成|写入|保存|create|write|save)/iu.test(body);
  const isEdit = /(修改|编辑|更新|添加|追加|插入|补充|补一句|加上|edit|update|append|insert|add)/iu.test(body);
  if (!isCreate && !isEdit) {
    return undefined;
  }
  const target = mockExecutableFileTarget(state, channelId, body);
  if (!target) {
    return undefined;
  }
  const action = isEdit ? "edit" : "write";
  const verb = isEdit ? "Edit" : "Create";
  const title = `${verb} ${target}`;
  const proposal = {
    id: `proposal_${state.channelExecutionProposals.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    sourceMessageId: typeof message.id === "string" ? message.id : "",
    proposedByTeammateId: "ling_agent",
    title,
    prompt: `${verb} the requested file.\nTarget: ${target}`,
    assigneeTeammateId: "ling_agent",
    acceptanceCriteria: [
      `Target file is ${isEdit ? "updated" : "created"} at ${target}.`,
      "No undeclared files, commands, MCP tools, or external actions are used without a separate runtime permission request.",
    ],
    collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: `${verb} the requested file.` }],
    requiredTools: [action],
    riskSummary: `Need ${action} permission for ${target}. Ling Agent can handle this bounded task now.`,
    responseLanguage: /[\u3400-\u9fff]/u.test(body) ? "zh-CN" : "en-US",
    shaping: {
      status: "ready_for_confirmation",
      summary: `${verb} ${target}`,
      openQuestions: [],
      clarifications: [],
      sourceRefs: typeof message.id === "string" ? [{ type: "message", id: message.id }] : [],
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
    status: "draft",
    createdAt: "2026-05-25T00:18:02.000Z",
    updatedAt: "2026-05-25T00:18:02.000Z",
  };
  state.channelExecutionProposals.unshift(proposal);
  state.channelIntentDecisions.push({
    schemaVersion: 1,
    id: `intent_${state.channelIntentDecisions.length + 1}`,
    workspaceId: "workspace_default",
    channelId,
    sourceMessageId: typeof message.id === "string" ? message.id : "",
    action: "direct_workflow",
    proposalId: proposal.id,
    reason: "Direct single-step executable proposal created by mock intent selector.",
    status: "accepted",
    createdBy: "deterministic",
    createdAt: "2026-05-25T00:18:00.500Z",
    updatedAt: "2026-05-25T00:18:00.500Z",
  });
  const autoStartedWorkflow = mockAutoStartExecutionProposalWorkflow(state, proposal);
  return { autoStartedWorkflow };
}

function mockExecutableFileTarget(state: MockState, channelId: string, body: string): string | undefined {
  const explicitPath = body.match(/(?:^|[\s"'`([{（，。:：])((?:\/(?!\/)|\.{1,2}\/|Users\/)[^\s"'`，。；;：:!?！？)）\]}]*?[\w.-]+\.(?:md|txt|json|ts|tsx|js|jsx|py|css|html|yml|yaml))/iu)?.[1];
  if (explicitPath) {
    return explicitPath.replace(/^Users\//u, "/Users/");
  }
  const fileName = body.match(/([\w.-]+\.(?:md|txt|json|ts|tsx|js|jsx|py|css|html|yml|yaml))/iu)?.[1];
  if (!fileName) {
    return undefined;
  }
  const recentTarget = mockRecentWorkflowFileTarget(state, channelId, fileName);
  if (recentTarget) {
    return recentTarget;
  }
  const basePath = body.match(/(?:在|到|位于|under|in)\s*((?:\/(?!\/)|Users\/)[^\s，。；;:：]*)(?:\s+下|下面|里|中|\/)?/iu)?.[1];
  if (basePath) {
    return `${basePath.replace(/^Users\//u, "/Users/").replace(/\/$/u, "")}/${fileName}`;
  }
  return fileName;
}

function mockAutoStartExecutionProposalWorkflow(state: MockState, proposal: Record<string, unknown>): unknown {
  const collaborationSteps = Array.isArray(proposal.collaborationSteps) && proposal.collaborationSteps.length > 0
    ? proposal.collaborationSteps.filter(isRecord)
    : [{ teammateId: proposal.assigneeTeammateId, action: "coordinated", summary: "Complete the confirmed execution proposal." }];
  const workflow = {
    id: `workflow_${state.channelWorkflows.length + 1}`,
    workspaceId: "workspace_default",
    channelId: proposal.channelId,
    title: typeof proposal.title === "string" ? proposal.title : "Execution proposal workflow",
    objective: typeof proposal.prompt === "string" ? proposal.prompt : "",
    status: "running",
    createdBy: typeof proposal.proposedByTeammateId === "string" ? proposal.proposedByTeammateId : "local-user",
    metadata: {
      sourceProposalId: proposal.id,
      sourceMessageId: proposal.sourceMessageId,
    },
    createdAt: "2026-05-25T00:32:00.000Z",
    updatedAt: "2026-05-25T00:32:00.000Z",
  };
  const workflowSteps = collaborationSteps.map((step, index) => {
    const teammateId = typeof step.teammateId === "string" ? step.teammateId : String(proposal.assigneeTeammateId ?? "engineer");
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return {
      id: `workflow_step_${state.channelWorkflowSteps.length + index + 1}`,
      workspaceId: "workspace_default",
      channelId: proposal.channelId,
      workflowId: workflow.id,
      position: index + 1,
      title: `${isRecord(teammate) && typeof teammate.displayName === "string" ? teammate.displayName : teammateId}: ${typeof step.action === "string" ? step.action : "coordinated"}`,
      prompt: typeof step.summary === "string" ? step.summary : String(proposal.prompt ?? ""),
      toParticipantId: teammateId,
      toParticipantLabel: isRecord(teammate) && typeof teammate.displayName === "string" ? teammate.displayName : teammateId,
      status: index === 0 ? "running" : "queued",
      metadata: {
        sourceProposalId: proposal.id,
        sourceMessageId: proposal.sourceMessageId,
        ...(Array.isArray(step.sources) ? { proposalStepSources: step.sources.filter(isRecord) } : {}),
        dependsOnStepIds: index === 0 ? undefined : [`workflow_step_${state.channelWorkflowSteps.length + index}`],
        autoStart: true,
      },
      createdAt: "2026-05-25T00:32:00.000Z",
      updatedAt: "2026-05-25T00:32:00.000Z",
    };
  });
  const updatedProposal = {
    ...proposal,
    status: "accepted",
    linkedWorkflowId: workflow.id,
    linkedTaskId: undefined,
    linkedRunId: undefined,
    shaping: isRecord(proposal.shaping)
      ? { ...proposal.shaping, status: "converted_to_task", updatedAt: "2026-05-25T00:32:00.000Z" }
      : undefined,
    errorMessage: undefined,
    updatedAt: "2026-05-25T00:32:00.000Z",
  };
  state.channelExecutionProposals = state.channelExecutionProposals.map((item) =>
    isRecord(item) && item.id === proposal.id ? updatedProposal : item
  );
  state.channelWorkflows.unshift(workflow);
  state.channelWorkflowSteps.unshift(...workflowSteps);
  return {
    proposal: updatedProposal,
    workflow,
    workflowSteps,
    orchestration: {
      status: workflowSteps.length > 0 ? "started" : "idle",
      workflow,
      workflowStep: workflowSteps[0],
      taskId: workflowSteps[0]?.id ? `task_${workflowSteps[0].id}` : undefined,
      runId: workflowSteps[0]?.id ? `run_${workflowSteps[0].id}` : undefined,
    },
  };
}

function mockRecentWorkflowFileTarget(state: MockState, channelId: string, fileName: string): string | undefined {
  const wanted = fileName.toLowerCase();
  const texts = [
    ...state.channelExecutionProposals
      .filter((proposal) => isRecord(proposal) && proposal.channelId === channelId)
      .flatMap((proposal) => [proposal.title, proposal.prompt, proposal.riskSummary].filter((value): value is string => typeof value === "string")),
    ...state.channelWorkflowSteps
      .filter((step) => isRecord(step) && step.channelId === channelId)
      .flatMap((step) => [step.title, step.prompt, step.resultSummary].filter((value): value is string => typeof value === "string")),
  ];
  for (const text of texts) {
    const matches = text.matchAll(/((?:\/(?!\/)|Users\/|\.\.?\/)[^\s"'`，。；;：:!?！？)）\]}]*?[\w.-]+\.(?:md|txt|json|ts|tsx|js|jsx|py|css|html|yml|yaml))/giu);
    for (const match of matches) {
      const candidate = match[1].replace(/^Users\//u, "/Users/");
      if (candidate.split("/").filter(Boolean).at(-1)?.toLowerCase() === wanted) {
        return candidate;
      }
    }
  }
  return undefined;
}

function mockTextMentionsRole(text: string, role: string): boolean {
  if (role === "architect") {
    return /(architect|架构|架构师|技术方案|拆解)/iu.test(text);
  }
  if (role === "engineer") {
    return /(engineer|工程|开发|写代码|改代码|修复|执行实现)/iu.test(text);
  }
  if (role === "qa") {
    return /(qa|测试|验证|验收|e2e|回归)/iu.test(text);
  }
  if (role === "designer") {
    return /(designer|design|设计|ui|ux|交互|视觉)/iu.test(text);
  }
  if (role === "product") {
    return /(product|产品|需求|范围|scope|取舍)/iu.test(text);
  }
  if (role === "security") {
    return /(security|安全|审计|威胁|trust boundary)/iu.test(text);
  }
  if (role === "docs") {
    return /(docs|document|文档|说明)/iu.test(text);
  }
  return /(release|ship|push|合并|发布|部署)/iu.test(text);
}

function mockProposalStepSummary(role: string): string {
  if (role === "architect") {
    return "Define implementation boundaries and sequencing before execution.";
  }
  if (role === "engineer") {
    return "Implement the approved step after the boundary is clear.";
  }
  if (role === "qa") {
    return "Validate the expected behavior and regression checks.";
  }
  if (role === "designer") {
    return "Review interaction quality and visible product behavior.";
  }
  if (role === "docs") {
    return "Keep documentation aligned with the shipped behavior.";
  }
  return "Coordinate the requested workflow step.";
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

const defaultPrivateMockMemoryScopeKinds = ["private-chat-summary", "private-notes"] as const;
const defaultChannelMockMemoryScopeKinds = ["channel-brief", "channel-decisions"] as const;

export function ensureMockDefaultTeammateMemoryScopes(state: MockState, teammateId: string): void {
  const teammateExists = state.aiTeammates.some((item) => isRecord(item) && item.id === teammateId);
  if (!teammateExists) {
    return;
  }
  const channelIds = state.teammateChannelMemberships
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.teammateId === teammateId && typeof item.channelId === "string")
    .map((item) => String(item.channelId));
  const currentChannelIds = new Set(channelIds);
  state.teammateMemoryScopes = state.teammateMemoryScopes.filter((item) => {
    if (!isRecord(item) || item.teammateId !== teammateId) {
      return true;
    }
    if (typeof item.channelId !== "string" || !(defaultChannelMockMemoryScopeKinds as readonly string[]).includes(String(item.kind))) {
      return true;
    }
    return currentChannelIds.has(item.channelId);
  });
  for (const kind of defaultPrivateMockMemoryScopeKinds) {
    upsertMockTeammateMemoryScope(state, { teammateId, kind });
  }
  for (const channelId of currentChannelIds) {
    for (const kind of defaultChannelMockMemoryScopeKinds) {
      upsertMockTeammateMemoryScope(state, { teammateId, kind, channelId });
    }
  }
}

function upsertMockTeammateMemoryScope(
  state: MockState,
  input: { readonly teammateId: string; readonly kind: string; readonly channelId?: string },
): void {
  const existingIndex = state.teammateMemoryScopes.findIndex((item) =>
    isRecord(item) &&
    item.teammateId === input.teammateId &&
    item.kind === input.kind &&
    (typeof item.channelId === "string" ? item.channelId : undefined) === input.channelId
  );
  const idSuffix = `${input.kind}_${input.channelId ?? "private"}`.replace(/[^a-z0-9_-]/gi, "_");
  const record = {
    id: `memory_${input.teammateId}_${idSuffix}`,
    teammateId: input.teammateId,
    kind: input.kind,
    channelId: input.channelId,
    enabled: true,
    createdAt: "2026-05-29T00:09:00.000Z",
    updatedAt: "2026-05-29T00:09:00.000Z",
  };
  if (existingIndex >= 0) {
    const existing = state.teammateMemoryScopes[existingIndex];
    state.teammateMemoryScopes[existingIndex] = isRecord(existing)
      ? { ...existing, enabled: true, updatedAt: record.updatedAt }
      : record;
    return;
  }
  state.teammateMemoryScopes.push(record);
}

export function buildProviderCheckResult(provider: Record<string, unknown>): Record<string, unknown> {
  const checkedAt = "2026-05-25T00:11:00.000Z";
  const normalizedProvider = normalizeMockProviderForGenerationRuntime(provider);
  if (normalizedProvider.enabled === false) {
    return { ok: false, code: "provider_disabled", message: "Provider is disabled.", checkedAt };
  }
  if (normalizedProvider.apiKeyRef && normalizedProvider.apiKeyConfigured !== true) {
    return { ok: false, code: "secret_missing", message: `${String(normalizedProvider.apiKeyRef)} is not configured.`, checkedAt };
  }
  if (String(normalizedProvider.displayName).includes("Auth Failed")) {
    return { ok: false, code: "auth_failed", message: "Invalid API key.", checkedAt };
  }
  if (normalizedProvider.api === "media-job") {
    const operation = mockProviderGenerationOperation(normalizedProvider);
    const state = resolveGenerationProviderRuntimeState(
      normalizedProvider as Parameters<typeof resolveGenerationProviderRuntimeState>[0],
      operation,
    );
    if (state.reason === "base_url_missing") {
      return { ok: false, code: "bad_request", message: "baseUrl is required for live generation transport.", checkedAt };
    }
    if (state.reason === "secret_missing") {
      return { ok: false, code: "secret_missing", message: "API key missing. Add an API key before enabling live generation transport.", checkedAt };
    }
    if (state.reason === "live_transport_invalid") {
      return { ok: false, code: "invalid_request", message: "Invalid generation transport configuration.", checkedAt };
    }
    if (!state.canRun) {
      return {
        ok: false,
        code: "unsupported_live_probe",
        message: "This generation model is recognized, but Ling has not connected a real generation adapter for this provider yet.",
        checkedAt,
      };
    }
    if (state.familyId === "openai-images") {
      return {
        ok: true,
        code: "static_check",
        message: "OpenAI Images generation configuration is ready. The check does not create an image.",
        checkedAt,
      };
    }
    if (state.familyId === "volcengine-seedance") {
      return {
        ok: true,
        code: "static_check",
        message: "Seedance video generation configuration is ready. The check does not create a video.",
        checkedAt,
      };
    }
    return {
      ok: true,
      code: "live_image_probe_ready",
      message: "生成真实图片成功",
      checkedAt,
    };
  }
  return { ok: true, code: "ready", message: "Provider is reachable and accepted the configured model.", checkedAt };
}

function mockProviderGenerationOperation(provider: Record<string, unknown>): Parameters<typeof resolveGenerationProviderRuntimeState>[1] {
  const capabilities = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  if (capabilities.includes("image_generate")) {
    return "image_generate";
  }
  if (capabilities.includes("video_generate")) {
    return "video_generate";
  }
  if (capabilities.includes("image_edit")) {
    return "image_edit";
  }
  return undefined;
}

function mockMediaJobOperation(value: unknown): Parameters<typeof resolveGenerationProviderRuntimeState>[1] {
  if (value === "image_generate" || value === "image_edit" || value === "video_generate") {
    return value;
  }
  return undefined;
}

export function buildMockExternalActionView(state: MockState, action: MockExternalWorkAction): Record<string, unknown> {
  return {
    action,
    approval: action.approvalId ? state.approvals.find((approval) => approval.id === action.approvalId) : undefined,
    artifacts: state.artifactsByExternalAction[action.id] ?? [],
  };
}

function buildMockConversationDetail(state: MockState, cwd: string, thread: MockLingThread): Record<string, unknown> {
  const turns = state.turns
    .filter((turn) => turn.threadId === thread.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const runLinks = turns.flatMap((turn) => state.turnRunLinks.filter((link) => link.turnId === turn.id));
  const runs = runLinks
    .map((link) => state.runs.find((run) => run.id === link.runId))
    .filter((run): run is MockRun => Boolean(run));
  const messages = turns.flatMap((turn) => {
    const runLink = state.turnRunLinks.find((link) => link.turnId === turn.id);
    const run = runLink ? state.runs.find((item) => item.id === runLink.runId) : undefined;
    return run
      ? [createMockConversationUserMessage(state, thread, turn, run), createMockConversationAssistantMessageFromRun(state, thread, turn, run)]
      : [createMockConversationUserMessage(state, thread, turn)];
  });
  const latestRun = runs[runs.length - 1];
  const requestSnapshot = isRecord(latestRun?.requestSnapshot) ? latestRun.requestSnapshot : {};
  const latestProjectPath = latestRun?.cwd && latestRun.cwd !== cwd ? latestRun.cwd : undefined;
  return {
    cwd,
    thread,
    turns,
    runs,
    messages,
    defaults: {
      projectPath: typeof requestSnapshot.projectPath === "string" ? requestSnapshot.projectPath : latestProjectPath,
      providerPresetId: latestRun?.providerPresetId,
      thinkingLevel: typeof requestSnapshot.thinkingLevel === "string" ? requestSnapshot.thinkingLevel : undefined,
      permissionPreset: typeof requestSnapshot.permissionPreset === "string" ? requestSnapshot.permissionPreset : undefined,
      permissionMode: typeof requestSnapshot.permissionMode === "string" ? requestSnapshot.permissionMode : undefined,
    },
  };
}

function createMockConversationUserMessage(
  state: MockState,
  thread: MockLingThread,
  turn: MockLingTurn,
  run?: MockRun,
  attachments?: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const resolvedAttachments = attachments ?? findMockConversationAttachmentsForTurn(state, thread.id, turn.id, run);
  return {
    id: `conversation-user:${turn.id}`,
    role: "user",
    content: turn.userInstruction,
    status: turn.status === "failed" ? "failed" : "succeeded",
    threadId: thread.id,
    turnId: turn.id,
    attachments: resolvedAttachments,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

function findMockConversationAttachmentsForTurn(
  state: MockState,
  threadId: string,
  turnId: string,
  run?: MockRun,
): Record<string, unknown>[] {
  const snapshot = isRecord(run?.requestSnapshot) ? run.requestSnapshot : {};
  const snapshotIds = Array.isArray(snapshot.conversationAttachmentIds)
    ? snapshot.conversationAttachmentIds.filter((item): item is string => typeof item === "string")
    : Array.isArray(snapshot.attachmentIds)
      ? snapshot.attachmentIds.filter((item): item is string => typeof item === "string")
      : [];
  return state.conversationAttachments
    .filter((attachment): attachment is Record<string, unknown> => {
      if (!isRecord(attachment)) {
        return false;
      }
      if (snapshotIds.length > 0) {
        return typeof attachment.id === "string" && snapshotIds.includes(attachment.id);
      }
      return attachment.threadId === threadId && attachment.turnId === turnId;
    });
}

function findMockAttachmentById(state: MockState, attachmentId: string): Record<string, unknown> | undefined {
  return [
    ...state.channelAttachments,
    ...state.teammatePrivateAttachments,
    ...state.conversationAttachments,
  ].find((attachment): attachment is Record<string, unknown> => isRecord(attachment) && attachment.id === attachmentId);
}

function createMockConversationAssistantMessageFromRun(
  state: MockState,
  thread: MockLingThread,
  turn: MockLingTurn,
  run: MockRun,
): Record<string, unknown> {
  const content = (state.eventsByRun[run.id] ?? [])
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => isRecord(event.data) && typeof event.data.text === "string" ? event.data.text : "")
    .join("");
  return createMockConversationAssistantMessage(thread, turn, run, content, run.status === "failed" ? "failed" : "succeeded", run.updatedAt);
}

function createMockConversationAssistantMessage(
  thread: MockLingThread,
  turn: MockLingTurn,
  run: MockRun,
  content: string,
  status: string,
  now: string,
): Record<string, unknown> {
  return {
    id: `conversation-assistant:${turn.id}`,
    role: "assistant",
    authorId: "ling_agent",
    authorLabel: "Ling Agent",
    content,
    status,
    threadId: thread.id,
    turnId: turn.id,
    runId: run.id,
    createdAt: run.createdAt,
    updatedAt: now,
  };
}

function summarizeMockConversationTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}...` : oneLine || "New conversation";
}

function buildEmptyMockFoldedExperts(channelId: string, turnId: string): Record<string, unknown> {
  return {
    channelId,
    turnId,
    totalCount: 0,
    activeCount: 0,
    completedCount: 0,
    delayedCount: 0,
    unavailableCount: 0,
    adoptedCount: 0,
    rejectedCount: 0,
    statusCounts: {},
    chips: [],
    entries: [],
  };
}

function buildEmptyMockTeamMetrics(channelId: string): Record<string, unknown> {
  return {
    channelId,
    generatedAt: "2026-05-25T00:18:00.000Z",
    summary: {
      healthState: "healthy",
      totalEvidenceCount: 0,
      activeEvidenceCount: 0,
      delayedEvidenceCount: 0,
      unavailableEvidenceCount: 0,
      reliabilityIncidentCount: 0,
      availabilityIncidentCount: 0,
    },
    agents: [],
    attention: {
      activeAgentCount: 0,
      evidenceKindCounts: {},
      evidenceStatusCounts: {},
    },
    riskReview: {
      riskSignalCount: 0,
      dissentSignalCount: 0,
      openReliabilityIncidentCount: 0,
      openCriticalReliabilityIncidentCount: 0,
    },
    learningQueue: {
      recommendationEvidenceCount: 0,
      adoptedEvidenceCount: 0,
      rejectedEvidenceCount: 0,
      provisionalRuleCount: 0,
      note: "Pattern Store is inspect-only in mock data.",
    },
  };
}

export async function mockDaemon(
  page: Page,
  state: MockState,
  options: {
    readonly defaultWorkspaceCwd?: string;
    readonly channelAutoRouteEnabled?: boolean;
    readonly templates?: readonly unknown[];
    readonly providerModelsUnsupported?: boolean;
    readonly providerCheckModelUnsupportedProviderIds?: readonly string[];
    readonly collaborationCardsUnsupported?: boolean;
  } = {},
): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebSocket", { value: undefined, configurable: true });
  });
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    await handleDaemonRoute(route, state, options);
  });
}

export async function handleDaemonRoute(
  route: Route,
  state: MockState,
  options: {
    readonly defaultWorkspaceCwd?: string;
    readonly channelAutoRouteEnabled?: boolean;
    readonly templates?: readonly unknown[];
    readonly providerModelsUnsupported?: boolean;
    readonly providerCheckModelUnsupportedProviderIds?: readonly string[];
    readonly collaborationCardsUnsupported?: boolean;
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
        features: {
          channels: {
            autoRoute: options.channelAutoRouteEnabled === true,
          },
        },
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/provider-templates") {
    await route.fulfill({ json: { templates: options.templates ?? [] } });
    return;
  }
  if (request.method() === "GET" && path === "/workspace-settings") {
    state.workspaceSettings = normalizeWorkspaceSettings(state.workspaceSettings);
    await route.fulfill({ json: { cwd, settings: state.workspaceSettings } });
    return;
  }
  if (request.method() === "GET" && path === "/startup/status") {
    const requestedCwd = url.searchParams.get("cwd") ?? cwd;
    await route.fulfill({ json: { ...state.startupStatus, cwd: requestedCwd } });
    return;
  }
  if (request.method() === "POST" && path === "/startup/refresh") {
    const requestedCwd = url.searchParams.get("cwd") ?? cwd;
    state.startupStatus = {
      ...state.startupStatus,
      cwd: requestedCwd,
      updatedAt: "2026-05-25T00:00:10.000Z",
    };
    await route.fulfill({ json: state.startupStatus });
    return;
  }
  if (request.method() === "POST" && path === "/workspace-directory/select") {
    await route.fulfill({
      json: {
        cancelled: false,
        path: "/Users/gsx/minimax-agent-cn/projects",
        label: "projects",
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/workspace-terminal/profile") {
    const requestedCwd = url.searchParams.get("cwd") ?? cwd;
    const workspaceLabel = requestedCwd.split("/").filter(Boolean).at(-1) ?? requestedCwd;
    await route.fulfill({
      json: {
        cwd: requestedCwd,
        workspaceLabel,
        promptLabel: `tianxiao@tianxiaodeMacBook-Pro ${workspaceLabel} %`,
        username: "tianxiao",
        hostname: "tianxiaodeMacBook-Pro",
        shell: "/bin/zsh",
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/workspace-terminal/commands") {
    const requestedCwd = url.searchParams.get("cwd") ?? cwd;
    const body = await request.postDataJSON() as { command?: unknown };
    const command = typeof body.command === "string" ? body.command : "";
    state.terminalCommandRequests.push({ cwd: requestedCwd, command });
    await route.fulfill({
      json: {
        id: `terminal_command_${state.terminalCommandRequests.length}`,
        cwd: requestedCwd,
        command,
        status: "succeeded",
        exitCode: 0,
        stdout: command === "pwd" ? `${requestedCwd}\n` : `mock output: ${command}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: "2026-05-25T00:00:00.000Z",
        completedAt: "2026-05-25T00:00:00.012Z",
        durationMs: 12,
      },
    });
    return;
  }
  if (request.method() === "PATCH" && path === "/workspace-settings") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const nextSettings = { ...state.workspaceSettings };
    for (const key of ["workspaceCwd", "theme", "locale", "responseLanguage", "lingConversationTone", "defaultProviderPresetId", "defaultPermissionMode", "defaultPermissionPreset", "channelNotifications", "channelActivityViews", "skillGovernancePolicy"] as const) {
      if (body[key] === null) {
        delete nextSettings[key];
      } else if (body[key] !== undefined) {
        nextSettings[key] = key === "skillGovernancePolicy"
          ? normalizeSkillGovernancePolicy(body[key])
          : key === "lingConversationTone"
            ? normalizeLingConversationTone(body[key])
            : key === "defaultPermissionMode"
              ? normalizeDefaultPermissionMode(body[key])
              : key === "defaultPermissionPreset"
                ? normalizeDefaultPermissionPreset(body[key])
                : body[key];
      }
    }
    state.workspaceSettings = {
      schemaVersion: 1,
      ...nextSettings,
      updatedAt: "2026-05-25T00:18:00.000Z",
    };
    await route.fulfill({ json: { cwd, settings: state.workspaceSettings } });
    return;
  }
  if (request.method() === "GET" && path === "/profile") {
    await route.fulfill({ json: { cwd, profile: state.userProfile } });
    return;
  }
  if (request.method() === "PATCH" && path === "/profile") {
    const body = await request.postDataJSON() as {
      readonly displayName?: unknown;
      readonly handle?: unknown;
      readonly avatarDataUrl?: unknown;
    };
    const nextProfile: UserProfile = {
      ...state.userProfile,
      displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : state.userProfile.displayName,
      updatedAt: "2026-05-25T00:18:00.000Z",
    };
    if (body.handle === null) {
      delete nextProfile.handle;
    } else if (typeof body.handle === "string" && body.handle.trim()) {
      nextProfile.handle = body.handle.trim().replace(/^@+/, "");
    }
    if (body.avatarDataUrl === null) {
      delete nextProfile.avatarDataUrl;
    } else if (typeof body.avatarDataUrl === "string") {
      nextProfile.avatarDataUrl = body.avatarDataUrl;
    }
    state.userProfile = nextProfile;
    await route.fulfill({ json: { cwd, profile: state.userProfile } });
    return;
  }
  if (request.method() === "GET" && path === "/governance-notifications") {
    if (state.governanceNotificationDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.governanceNotificationDelayMs));
    }
    const notifications = state.governanceNotifications
      .filter(isGovernanceNotification)
      .filter((notification) => governanceNotificationMatchesQuery(notification, url.searchParams))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const limit = Number(url.searchParams.get("limit") ?? "0");
    await route.fulfill({
      json: {
        cwd,
        notifications: limit > 0 ? notifications.slice(0, limit) : notifications,
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/governance-notifications/summary") {
    await route.fulfill({ json: { cwd, summary: buildGovernanceNotificationSummary(state.governanceNotifications) } });
    return;
  }
  const governanceNotificationMutationMatch = /^\/governance-notifications\/([^/]+)\/(seen|dismiss)$/.exec(path);
  if (governanceNotificationMutationMatch && request.method() === "POST") {
    const notificationId = decodeURIComponent(governanceNotificationMutationMatch[1]);
    const action = governanceNotificationMutationMatch[2];
    const index = state.governanceNotifications.findIndex((item) => isRecord(item) && item.id === notificationId);
    if (index === -1 || !isRecord(state.governanceNotifications[index])) {
      await route.fulfill({ status: 404, json: { error: "governance_notification_not_found" } });
      return;
    }
    const existing = state.governanceNotifications[index] as Record<string, unknown>;
    const updated = {
      ...existing,
      status: action === "dismiss" ? "dismissed" : existing.status === "unread" ? "seen" : existing.status,
      updatedAt: "2026-05-25T00:30:00.000Z",
    };
    state.governanceNotifications[index] = updated;
    await route.fulfill({ json: { cwd, notification: updated } });
    return;
  }
  if (request.method() === "GET" && path === "/config/effective") {
    state.workspaceSettings = normalizeWorkspaceSettings(state.workspaceSettings);
    await route.fulfill({
      json: {
        cwd,
        paths: {
          user: {
            rootDir: "/Users/test/.ling-stack",
            configPath: "/Users/test/.ling-stack/config.json",
            settingsPath: "/Users/test/.ling-stack/settings.json",
            providerProfilesPath: "/Users/test/.ling-stack/providers/profiles.json",
            pluginCacheDir: "/Users/test/.ling-stack/plugins/cache",
            logsDir: "/Users/test/.ling-stack/logs",
          },
          workspace: {
            rootDir: `${cwd}/.ling-stack`,
            configPath: `${cwd}/.ling-stack/config.json`,
            databasePath: `${cwd}/.ling-stack/ling-stack.sqlite`,
            runtimeSettingsPath: `${cwd}/.ling-stack/runtime-settings.json`,
            sessionsDir: `${cwd}/.ling-stack/sessions`,
            artifactsDir: `${cwd}/.ling-stack/artifacts`,
            attachmentsDir: `${cwd}/.ling-stack/attachments`,
            pluginCacheDir: `${cwd}/.ling-stack/plugins/cache`,
            logsDir: `${cwd}/.ling-stack/logs`,
          },
        },
        values: {
          workspaceCwd: effectiveWorkspaceSettingValue(state.workspaceSettings.workspaceCwd, "workspaceCwd", cwd),
          theme: effectiveWorkspaceSettingValue(state.workspaceSettings.theme, "theme", "system"),
          locale: effectiveWorkspaceSettingValue(state.workspaceSettings.locale, "locale", "zh-CN"),
          responseLanguage: effectiveWorkspaceSettingValue(state.workspaceSettings.responseLanguage, "responseLanguage", "follow_user"),
          lingConversationTone: effectiveWorkspaceSettingValue(state.workspaceSettings.lingConversationTone, "lingConversationTone", "pragmatic"),
          skillGovernancePolicy: effectiveWorkspaceObjectSettingValue(
            state.workspaceSettings.skillGovernancePolicy,
            "skillGovernancePolicy",
            defaultSkillGovernancePolicy,
          ),
          runtime: {
            defaultRunnerId: { value: "pi", source: "built_in", key: "runtime.defaultRunnerId" },
            explicitRunnerFallback: { value: "disabled", source: "built_in", key: "runtime.explicitRunnerFallback" },
            implicitRunnerFallback: { value: "disabled", source: "built_in", key: "runtime.implicitRunnerFallback" },
          },
        },
        layers: {
          workspaceSettings: state.workspaceSettings,
        },
        diagnostics: [],
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/runners") {
    await route.fulfill({ json: { cwd, runners: state.runtimeRunners } });
    return;
  }
  const runnerReadinessMatch = /^\/runners\/([^/]+)\/readiness$/.exec(path);
  if (runnerReadinessMatch && request.method() === "GET") {
    const runnerId = decodeURIComponent(runnerReadinessMatch[1]);
    const runner = state.runtimeRunners.find((item) => item.id === runnerId);
    if (!runner?.readiness) {
      await route.fulfill({ status: 404, json: { error: "runner_not_found", message: `Runner not found: ${runnerId}` } });
      return;
    }
    await route.fulfill({
      json: {
        cwd,
        readiness: {
          runnerId,
          featureFlagEnabled: runner.status === "enabled",
          conformancePassed: runner.readiness.status === "ready",
          ...runner.readiness,
        },
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/runtime/settings") {
    await route.fulfill({ json: { cwd, settings: state.runtimeSettings } });
    return;
  }
  if (request.method() === "PATCH" && path === "/runtime/settings") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    state.runtimeSettings = {
      ...state.runtimeSettings,
      defaultRunnerId: typeof body.defaultRunnerId === "string" ? body.defaultRunnerId : state.runtimeSettings.defaultRunnerId,
      allowedRunnerIds: Array.isArray(body.allowedRunnerIds)
        ? body.allowedRunnerIds.filter((item): item is string => typeof item === "string")
        : state.runtimeSettings.allowedRunnerIds,
      explicitRunnerFallback: body.explicitRunnerFallback === "allow_to_default" || body.explicitRunnerFallback === "disabled"
        ? body.explicitRunnerFallback
        : state.runtimeSettings.explicitRunnerFallback,
      implicitRunnerFallback: body.implicitRunnerFallback === "allow_to_default" || body.implicitRunnerFallback === "disabled"
        ? body.implicitRunnerFallback
        : state.runtimeSettings.implicitRunnerFallback,
      updatedAt: "2026-05-25T00:23:00.000Z",
    };
    await route.fulfill({ json: { cwd, settings: state.runtimeSettings } });
    return;
  }
  if (request.method() === "GET" && path === "/providers") {
    await route.fulfill({
      json: {
        cwd,
        providers: state.providers.map((provider) => isRecord(provider) ? normalizeMockProviderForGenerationRuntime(provider) : provider),
      },
    });
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
  if ((request.method() === "GET" || request.method() === "POST") && path === "/memory/export") {
    const includeSecretAdjacent = url.searchParams.get("includeSecretAdjacent") === "true";
    const generatedAt = url.searchParams.get("generatedAt") ?? "2026-06-18T00:00:00.000Z";
    const body = request.method() === "POST" ? await request.postDataJSON() as Record<string, unknown> : {};
    const result = buildMemoryMarkdownExport({
      memories: state.memoryObjects.filter(isMemoryObject),
      options: {
        workspaceId: "workspace_default",
        generatedAt,
        includeSecretAdjacent,
      },
    });
    const includeMarkdown = request.method() === "GET"
      ? url.searchParams.get("includeMarkdown") === "true"
      : body.includeMarkdown === true;
    const { markdown: _markdown, ...metadataOnlyResult } = result;
    await route.fulfill({
      json: {
        cwd,
        export: includeMarkdown ? result : metadataOnlyResult,
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/memory/import") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    const sourceLabel = typeof body.sourceLabel === "string" ? body.sourceLabel : undefined;
    const dryRun = body.dryRun === true;
    const plan = parseMemoryMarkdownImport(markdown, {
      workspaceId: "workspace_default",
      sourceLabel,
      importedAt: "2026-06-18T00:00:00.000Z",
    });
    state.memoryMarkdownImportCalls.push({
      dryRun,
      sourceLabel,
      candidateCount: plan.candidateCount,
      skippedCount: plan.skippedCount,
    });
    const memories = dryRun
      ? []
      : plan.candidates.map((candidate, index): MemoryObject => ({
          id: `memory_imported_${state.memoryObjects.length + index + 1}`,
          workspaceId: candidate.createInput.workspaceId ?? "workspace_default",
          scopeType: candidate.createInput.scopeType ?? "workspace",
          ownerId: candidate.createInput.ownerId ?? "workspace_default",
          title: candidate.createInput.title,
          body: candidate.createInput.body,
          tags: candidate.createInput.tags ?? [],
          sourceRefs: candidate.createInput.sourceRefs ?? [],
          reviewState: candidate.createInput.reviewState ?? "candidate",
          enabled: candidate.createInput.enabled ?? true,
          sensitivity: candidate.createInput.sensitivity ?? "normal",
          verifyBeforeUse: candidate.createInput.verifyBeforeUse ?? false,
          createdBy: candidate.createInput.createdBy,
          createdAt: "2026-06-18T00:00:00.000Z",
          updatedAt: "2026-06-18T00:00:00.000Z",
        }));
    if (!dryRun) {
      state.memoryObjects.push(...memories);
    }
    await route.fulfill({
      json: {
        cwd,
        dryRun,
        importedCount: dryRun ? 0 : memories.length,
        plan,
        memories,
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
    await route.fulfill({
      json: {
        cwd,
        items: state.memoryObjects.filter(isMemoryObject).filter((memory) => memory.reviewState === "candidate").map((memory) => ({
          memory,
          sourceSummary: memory.sourceRefs.map((ref) => ref.label ?? ref.id).join(", ") || "Candidate memory",
          recommendedAction: memory.sensitivity === "secret-adjacent" ? "quarantine" : "approve",
        })),
      },
    });
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
  if (request.method() === "GET" && path === "/skills/health") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    await route.fulfill({
      json: {
        cwd,
        report: createMockSkillHealthReport(state, Number.isFinite(rawLimit) ? rawLimit : 100),
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/skills/source-health") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    await route.fulfill({
      json: {
        cwd,
        report: createMockSkillSourceHealthReport(state, Number.isFinite(rawLimit) ? rawLimit : 100),
        snapshots: state.skillSourceSnapshots.filter((item) => isRecord(item) && item.reviewStatus === "published"),
      },
    });
    return;
  }
  if (path === "/skills/source-upgrade-policy") {
    if (request.method() === "GET") {
      await route.fulfill({ json: { cwd, policy: state.skillSourceUpgradePolicy } });
      return;
    }
    if (request.method() === "PUT") {
      const body = safePostDataJson(request);
      state.skillSourceUpgradePolicy = {
        ...state.skillSourceUpgradePolicy,
        mode: typeof body.mode === "string" ? body.mode : state.skillSourceUpgradePolicy.mode,
        approvedRootIds: Array.isArray(body.approvedRootIds) ? body.approvedRootIds.map(String) : state.skillSourceUpgradePolicy.approvedRootIds,
        allowNewSkills: typeof body.allowNewSkills === "boolean" ? body.allowNewSkills : state.skillSourceUpgradePolicy.allowNewSkills,
        allowGlobalGstackUpgrade: false,
        updatedAt: "2026-06-22T00:05:00.000Z",
      };
      await route.fulfill({ json: { cwd, policy: state.skillSourceUpgradePolicy } });
      return;
    }
    await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    return;
  }
  if (request.method() === "POST" && path === "/skills/import-draft/optimization-preview") {
    const body = safePostDataJson(request);
    const draft = createMockSkillImportDraft(state, body);
    const definitions = Array.isArray(draft.definitions) ? draft.definitions.filter(isRecord) : [];
    const firstDefinition = definitions[0];
    const definition = isRecord(firstDefinition?.definition) ? firstDefinition.definition : {};
    const skillId = typeof definition.id === "string"
      ? definition.id
      : "import-draft";
    await route.fulfill({
      json: {
        cwd,
        preview: createMockSkillOptimizationPreview({
          id: "skill_source_import_preview_mock",
          skillId,
        }, typeof body.mode === "string" ? body.mode : "preview_on_demand"),
      },
    });
    return;
  }
  const skillOptimizationPreviewMatch = /^\/skills\/([^/]+)\/optimization-preview$/.exec(path);
  if (skillOptimizationPreviewMatch) {
    const skillId = decodeURIComponent(skillOptimizationPreviewMatch[1]);
    if (request.method() !== "POST") {
      await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
      return;
    }
    const snapshot = state.skillSourceSnapshots.find((item) =>
      isRecord(item) && item.skillId === skillId && item.reviewStatus === "published"
    );
    if (!isRecord(snapshot)) {
      await route.fulfill({ status: 404, json: { error: "skill_source_snapshot_not_found", message: `Skill source snapshot not found: ${skillId}` } });
      return;
    }
    const body = safePostDataJson(request);
    await route.fulfill({
      json: {
        cwd,
        preview: createMockSkillOptimizationPreview(snapshot, typeof body.mode === "string" ? body.mode : "preview_on_demand"),
      },
    });
    return;
  }
  const skillSourceMatch = /^\/skills\/([^/]+)\/source(?:\/([^/]+))?$/.exec(path);
  if (skillSourceMatch) {
    const skillId = decodeURIComponent(skillSourceMatch[1]);
    const action = skillSourceMatch[2];
    const skill = state.skillRegistryEntries.find((item) =>
      isRecord(item) && item.id === skillId && item.reviewStatus !== "archived" && item.reviewStatus !== "disabled"
    );
    if (!isRecord(skill)) {
      await route.fulfill({ status: 404, json: { error: "skill_not_found", message: `Skill not found: ${skillId}` } });
      return;
    }
    const snapshot = state.skillSourceSnapshots.find((item) =>
      isRecord(item) && item.skillId === skillId && item.reviewStatus === "published"
    );
    if (action === undefined) {
      if (request.method() !== "GET") {
        await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
        return;
      }
      if (!isRecord(snapshot)) {
        await route.fulfill({ status: 404, json: { error: "skill_source_snapshot_not_found", message: `Skill source snapshot not found: ${skillId}` } });
        return;
      }
      await route.fulfill({ json: { cwd, snapshot } });
      return;
    }
    if (action === "archive") {
      if (request.method() !== "POST") {
        await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
        return;
      }
      if (!isRecord(snapshot)) {
        await route.fulfill({ status: 404, json: { error: "skill_source_snapshot_not_found", message: `Skill source snapshot not found: ${skillId}` } });
        return;
      }
      const archived = { ...snapshot, reviewStatus: "archived", updatedAt: "2026-06-22T00:07:00.000Z" };
      state.skillSourceSnapshots = state.skillSourceSnapshots.map((item) =>
        isRecord(item) && item.id === snapshot.id ? archived : item
      );
      await route.fulfill({ json: { cwd, snapshot: archived } });
      return;
    }
  }
  if (request.method() === "POST" && path === "/skills/sync/gstack/preview") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        cwd,
        preview: createMockSkillSourceSyncPreview(state, body),
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/skills/sync/gstack/refresh") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        cwd,
        refreshedAt: "2026-06-22T00:05:30.000Z",
        preview: createMockSkillSourceSyncPreview(state, body),
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/skills/sync/gstack/publish") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const result = publishMockSkillSourceSync(state, body);
    await route.fulfill({
      json: {
        cwd,
        publishedAt: "2026-06-22T00:06:00.000Z",
        preview: result.preview,
        skills: result.skills,
        snapshots: result.snapshots,
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/skill-recordings/eligibility") {
    const runId = url.searchParams.get("runId") ?? "";
    const run = state.runs.find((item) => item.id === runId);
    if (!run) {
      await route.fulfill({
        status: 404,
        json: { error: "run_not_found", message: `Run not found: ${runId}` },
      });
      return;
    }
    const terminal = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
    await route.fulfill({
      json: {
        cwd,
        runId,
        visible: terminal,
        recommended: run.status === "succeeded",
        reasonCode: terminal ? "available" : "not_terminal",
        actionHint: terminal ? "create_candidate" : "wait_for_terminal",
        generationMode: defaultSkillGovernancePolicy.generationMode,
        recordingMode: defaultSkillGovernancePolicy.recordingMode,
        route: {
          routeKind: "skill",
          reasonCode: "manual_recording",
          rationale: "Mock skill recording eligibility.",
        },
        metadata: {
          source: "mock",
        },
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/skill-recordings") {
    const body = safePostDataJson(request);
    const candidate = {
      id: `skill_candidate_recording_${state.skillCandidates.length + 1}`,
      workspaceId: "workspace_default",
      title: typeof body.title === "string" ? body.title : "Recorded skill candidate",
      summary: typeof body.summary === "string" ? body.summary : "Recorded from mock skill recording.",
      normalizedGoal: typeof body.normalizedGoal === "string" ? body.normalizedGoal : "recorded skill candidate",
      origin: "recording",
      status: "pending_review",
      sourceObservationIds: [],
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    };
    state.skillCandidates = [candidate, ...state.skillCandidates];
    await route.fulfill({
      status: 201,
      json: {
        cwd,
        jobKey: `mock-recording:${String(body.runId ?? "run")}`,
        reusedObservation: false,
        generationMode: defaultSkillGovernancePolicy.generationMode,
        recordingMode: defaultSkillGovernancePolicy.recordingMode,
        observation: {
          id: `procedure_observation_recording_${state.skillCandidates.length}`,
          workspaceId: "workspace_default",
          sourceKind: "recording",
          title: candidate.title,
          summary: candidate.summary,
          normalizedGoal: candidate.normalizedGoal,
          confidence: "medium",
          reusableScore: 65,
          createdAt: "2026-06-23T00:00:00.000Z",
        },
        route: {
          routeKind: typeof body.destinationHint === "string" ? body.destinationHint : "skill",
          reasonCode: "manual_recording",
          rationale: "Mock recording routed to skill candidate.",
        },
        action: "candidate_created",
        candidate,
      },
    });
    return;
  }
  if (request.method() === "GET" && path === "/skill-candidates") {
    const status = url.searchParams.get("status");
    const origin = url.searchParams.get("origin");
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
    const candidates = state.skillCandidates
      .filter((item) =>
        isRecord(item) &&
        (!status || item.status === status) &&
        (!origin || item.origin === origin)
      )
      .slice(0, limit);
    await route.fulfill({ json: { cwd, candidates } });
    return;
  }
  if (request.method() === "GET" && path === "/procedure-observation-clusters") {
    const routeKind = url.searchParams.get("routeKind");
    const status = url.searchParams.get("status");
    const channelId = url.searchParams.get("channelId");
    const rawLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
    const clusters = state.procedureObservationClusters
      .filter((item) =>
        isRecord(item) &&
        (!routeKind || item.routeKind === routeKind) &&
        (!status || item.status === status) &&
        (!channelId || item.channelId === channelId)
      )
      .slice(0, limit);
    await route.fulfill({ json: { cwd, clusters } });
    return;
  }
  const procedureObservationClusterMatch = /^\/procedure-observation-clusters\/([^/]+)$/.exec(path);
  if (request.method() === "GET" && procedureObservationClusterMatch) {
    const clusterId = decodeURIComponent(procedureObservationClusterMatch[1]);
    const cluster = state.procedureObservationClusters.find((item) => isRecord(item) && item.id === clusterId);
    if (!isRecord(cluster)) {
      await route.fulfill({ status: 404, json: { error: "procedure_observation_cluster_not_found", message: `Procedure observation cluster not found: ${clusterId}` } });
      return;
    }
    await route.fulfill({ json: { cwd, cluster, observations: [] } });
    return;
  }
  const skillCandidateMatch = /^\/skill-candidates\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (skillCandidateMatch) {
    const candidateId = decodeURIComponent(skillCandidateMatch[1]);
    const action = skillCandidateMatch[2];
    const candidate = state.skillCandidates.find((item) => isRecord(item) && item.id === candidateId);
    if (!isRecord(candidate)) {
      await route.fulfill({ status: 404, json: { error: "skill_candidate_not_found", message: `Skill candidate not found: ${candidateId}` } });
      return;
    }
    if (!action && request.method() === "GET") {
      await route.fulfill({
        json: {
          cwd,
          candidate,
          reviewRecords: state.skillCandidateReviewRecords.filter((item) => isRecord(item) && item.candidateId === candidateId),
        },
      });
      return;
    }
    if (action === "review" && request.method() === "POST") {
      const body = safePostDataJson(request);
      const reviewAction = typeof body.action === "string" ? body.action : "";
      const nextStatus = nextMockSkillCandidateStatus(candidate, reviewAction, body);
      if (!nextStatus) {
        await route.fulfill({ status: 400, json: { error: "invalid_skill_candidate_review_action" } });
        return;
      }
      if (nextStatus === "approved_for_draft") {
        const approvalError = mockSkillCandidateApprovalError(candidate);
        if (approvalError) {
          await route.fulfill({ status: 400, json: { error: "skill_candidate_review_blocked", message: approvalError } });
          return;
        }
      }
      const updated = {
        ...candidate,
        status: nextStatus,
        supersededBy: nextStatus === "superseded" && typeof body.supersededBy === "string" ? body.supersededBy : candidate.supersededBy,
        updatedAt: "2026-06-20T00:10:00.000Z",
      };
      state.skillCandidates = state.skillCandidates.map((item) => isRecord(item) && item.id === candidateId ? updated : item);
      const reviewRecord = {
        id: `skill_candidate_review_${state.skillCandidateReviewRecords.length + 1}`,
        workspaceId: "workspace_default",
        candidateId,
        action: reviewAction,
        actor: "user",
        previousStatus: candidate.status,
        nextStatus,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        createdAt: "2026-06-20T00:10:00.000Z",
      };
      state.skillCandidateReviewRecords.unshift(reviewRecord);
      await route.fulfill({ json: { cwd, candidate: updated, action: reviewRecord } });
      return;
    }
    if (action === "draft" && request.method() === "POST") {
      if (candidate.status !== "approved_for_draft") {
        await route.fulfill({ status: 400, json: { error: "skill_candidate_draft_blocked", message: "Skill candidate must be approved_for_draft before creating a registry draft" } });
        return;
      }
      const duplicateAnalysis = isRecord(candidate.duplicateAnalysis) ? candidate.duplicateAnalysis : {};
      if (duplicateAnalysis.decision === "update_existing" || duplicateAnalysis.decision === "conflict_review" || duplicateAnalysis.decision === "reject_duplicate") {
        await route.fulfill({ status: 400, json: { error: "skill_candidate_duplicate_review_required" } });
        return;
      }
      const draft = createMockSkillCandidateDraft(state, candidate);
      state.skillImportDrafts.unshift(draft);
      await route.fulfill({ status: 201, json: { cwd, candidate, draft, contextFindings: createMockSkillImportDraftContextFindings(draft) } });
      return;
    }
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
    await route.fulfill({ status: 201, json: { cwd, draft, contextFindings: createMockSkillImportDraftContextFindings(draft) } });
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
      await route.fulfill({ json: { cwd, draft, contextFindings: createMockSkillImportDraftContextFindings(draft) } });
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
  if (request.method() === "GET" && path === "/ai-councils") {
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const councils = state.aiCouncils.filter((item) =>
      isRecord(item) && (includeArchived || item.status !== "archived")
    );
    await route.fulfill({ json: { cwd, councils } });
    return;
  }
  if (request.method() === "POST" && path === "/ai-councils") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const unsupported = unsupportedMockKeyMessage(body, mockCreateAiCouncilRequestKeys, "AI council create request") ??
      (isRecord(body.routingPolicy) ? unsupportedMockKeyMessage(body.routingPolicy, mockCreateAiCouncilRoutingPolicyKeys, "routingPolicy") : undefined) ??
      unsupportedMockAiCouncilMemberMessage(body.members);
    if (unsupported) {
      await route.fulfill({ status: 400, json: { error: "bad_request", message: unsupported } });
      return;
    }
    const councilId = `council_custom_${state.aiCouncils.filter(isRecord).length + 1}`;
    const council = createMockAiCouncil({
      id: councilId,
      source: "user",
      templateId: undefined,
      displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : "Custom council",
      description: typeof body.description === "string" ? body.description.trim() : "",
      routingPolicy: readMockAiCouncilRoutingPolicy(body.routingPolicy),
      governanceProfile: {
        permissionBoundary: "restrict_only",
        approvalBoundary: "cannot_bypass",
        toolGrantBoundary: "cannot_grant",
        credentialBoundary: "cannot_grant",
        notes: ["Custom councils are management collections only."],
      },
      status: "active",
      pinned: body.pinned === true,
      createdAt: "2026-06-20T00:02:00.000Z",
      updatedAt: "2026-06-20T00:02:00.000Z",
    });
    state.aiCouncils = [...state.aiCouncils, council];
    state.aiCouncilMembers = [
      ...state.aiCouncilMembers.filter((item) => !isRecord(item) || item.councilId !== councilId),
      ...normalizeMockAiCouncilMembers(councilId, body.members),
    ];
    await route.fulfill({ status: 201, json: { cwd, council } });
    return;
  }
  if (path === "/ai-councils/health") {
    if (request.method() !== "GET") {
      await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
      return;
    }
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 500;
    await route.fulfill({ json: { cwd, report: buildMockAiCouncilHealthReport(state, limit) } });
    return;
  }
  const aiCouncilMatch = /^\/ai-councils\/([^/]+)(?:\/(members|clone))?$/.exec(path);
  if (aiCouncilMatch) {
    const councilId = decodeURIComponent(aiCouncilMatch[1]);
    const action = aiCouncilMatch[2] ? decodeURIComponent(aiCouncilMatch[2]) : "";
    const council = state.aiCouncils.find((item) => isRecord(item) && item.id === councilId);
    const isMembersRoute = action === "members";
    if (!isRecord(council)) {
      await route.fulfill({ status: 404, json: { error: "ai_council_not_found" } });
      return;
    }
    if (action === "clone" && request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const unsupported = unsupportedMockKeyMessage(body, mockCloneAiCouncilRequestKeys, "AI council clone request");
      if (unsupported) {
        await route.fulfill({ status: 400, json: { error: "bad_request", message: unsupported } });
        return;
      }
      if (council.status === "archived") {
        await route.fulfill({ status: 400, json: { error: "bad_request", message: `Archived AI council cannot be cloned: ${councilId}` } });
        return;
      }
      const clonedCouncilId = `council_clone_${state.aiCouncils.filter(isRecord).length + 1}`;
      const clonedCouncil = createMockAiCouncil({
        id: clonedCouncilId,
        source: "user",
        templateId: undefined,
        displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : `Copy of ${String(council.displayName ?? councilId)}`,
        description: typeof body.description === "string" ? body.description.trim() : typeof council.description === "string" ? council.description : "",
        routingPolicy: isRecord(council.routingPolicy) ? council.routingPolicy : readMockAiCouncilRoutingPolicy(undefined),
        governanceProfile: {
          permissionBoundary: "restrict_only",
          approvalBoundary: "cannot_bypass",
          toolGrantBoundary: "cannot_grant",
          credentialBoundary: "cannot_grant",
          notes: ["Custom councils are management collections only."],
        },
        status: "active",
        pinned: body.pinned === true,
        createdAt: "2026-06-20T00:02:00.000Z",
        updatedAt: "2026-06-20T00:02:00.000Z",
      });
      const clonedMembers = state.aiCouncilMembers
        .filter((item) => isRecord(item) && item.councilId === councilId && item.teammateId !== "ling_agent")
        .map((member) => ({
          ...member,
          councilId: clonedCouncilId,
          createdAt: "2026-06-20T00:02:00.000Z",
          updatedAt: "2026-06-20T00:02:00.000Z",
        }));
      state.aiCouncils = [...state.aiCouncils, clonedCouncil];
      state.aiCouncilMembers = [...state.aiCouncilMembers, ...clonedMembers];
      await route.fulfill({ status: 201, json: { cwd, council: clonedCouncil } });
      return;
    }
    if (!isMembersRoute && request.method() === "GET") {
      await route.fulfill({ json: { cwd, council } });
      return;
    }
    if (!isMembersRoute && request.method() === "PATCH") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const unsupported = unsupportedMockKeyMessage(body, mockUpdateAiCouncilRequestKeys, "AI council update request");
      if (unsupported) {
        await route.fulfill({ status: 400, json: { error: "bad_request", message: unsupported } });
        return;
      }
      if (council.source !== "user") {
        await route.fulfill({ status: 400, json: { error: "bad_request", message: "Built-in and template councils cannot be modified; clone them first." } });
        return;
      }
      const updatedCouncil = {
        ...council,
        displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : council.displayName,
        description: typeof body.description === "string" ? body.description.trim() : council.description,
        status: typeof body.status === "string" ? body.status : council.status,
        pinned: typeof body.pinned === "boolean" ? body.pinned : council.pinned,
        updatedAt: "2026-06-20T00:03:00.000Z",
      };
      state.aiCouncils = state.aiCouncils.map((item) => isRecord(item) && item.id === councilId ? updatedCouncil : item);
      if (updatedCouncil.status === "archived") {
        detachMockCouncilFromChannels(state, councilId);
      }
      await route.fulfill({ json: { cwd, council: updatedCouncil } });
      return;
    }
    if (isMembersRoute && request.method() === "GET") {
      const members = state.aiCouncilMembers
        .filter((item) => isRecord(item) && item.councilId === councilId)
        .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
      await route.fulfill({ json: { cwd, councilId, members } });
      return;
    }
    if (isMembersRoute && request.method() === "PUT") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const unsupported = unsupportedMockAiCouncilMemberMessage(body.members);
      if (unsupported) {
        await route.fulfill({ status: 400, json: { error: "bad_request", message: unsupported } });
        return;
      }
      const inputMembers = Array.isArray(body.members) ? body.members : [];
      state.aiCouncilMembers = state.aiCouncilMembers.filter((item) => !isRecord(item) || item.councilId !== councilId);
      state.aiCouncilMembers.push(...normalizeMockAiCouncilMembers(councilId, inputMembers));
      const members = state.aiCouncilMembers
        .filter((item) => isRecord(item) && item.councilId === councilId)
        .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
      await route.fulfill({ json: { cwd, councilId, members } });
      return;
    }
  }
  if (request.method() === "GET" && path === "/teammates") {
    const includeHidden = url.searchParams.get("includeHidden") === "true";
    const includeDisabled = url.searchParams.get("includeDisabled") === "true";
    for (const teammate of state.aiTeammates) {
      if (isRecord(teammate) && typeof teammate.id === "string") {
        ensureMockDefaultTeammateMemoryScopes(state, teammate.id);
      }
    }
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
    ensureMockDefaultTeammateMemoryScopes(state, String(teammate.id));
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
        directLinkPreviews: state.teammateDirectLinkPreviews.filter((item) => isRecord(item) && item.teammateId === teammateId).length,
        memoryObjects: state.memoryObjects.filter((item) => isRecord(item) && item.scopeType === "teammate" && item.ownerId === teammateId).length,
        usedMemoryEvents: state.usedMemoryEvents.filter((item) => isRecord(item) && item.teammateId === teammateId).length,
      };
      state.aiTeammates = state.aiTeammates.filter((item) => !isRecord(item) || item.id !== teammateId);
      state.aiCouncilMembers = state.aiCouncilMembers.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateChannelMemberships = state.teammateChannelMemberships.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateSkillBindings = state.teammateSkillBindings.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateMemoryScopes = state.teammateMemoryScopes.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateMcpBindings = state.teammateMcpBindings.filter((item) => item.teammateId !== teammateId);
      state.teammateDirectMessages = state.teammateDirectMessages.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
      state.teammateDirectLinkPreviews = state.teammateDirectLinkPreviews.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
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
      ensureMockDefaultTeammateMemoryScopes(state, teammateId);
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
      ensureMockDefaultTeammateMemoryScopes(state, teammateId);
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
      const scopes = Array.isArray(body.scopes) ? body.scopes : [];
      if (scopes.some((scope) => isRecord(scope) && scope.enabled === false)) {
        await route.fulfill({
          status: 400,
          json: { error: "bad_request", message: "Teammate memory is always enabled." },
        });
        return;
      }
      state.teammateMemoryScopes = state.teammateMemoryScopes.filter((item) => !isRecord(item) || item.teammateId !== teammateId);
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
      ensureMockDefaultTeammateMemoryScopes(state, teammateId);
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
        const fileName = typeof body.fileName === "string" ? body.fileName : "attachment.txt";
        const inferred = inferMockChannelAttachment(fileName);
        const attachment = {
          id: `tpatt_${state.teammatePrivateAttachments.length + 1}`,
          workspaceId: "workspace_default",
          teammateId,
          threadId: thread.id,
          messageId: typeof body.messageId === "string" ? body.messageId : undefined,
          scope: "teammate_direct_thread",
          kind: inferred.kind,
          fileName,
          contentType: inferred.contentType,
          sizeBytes: typeof body.contentBase64 === "string" ? Buffer.from(body.contentBase64, "base64").byteLength : 0,
          path: `teammates/${teammateId}/direct/${thread.id}/mock`,
          createdAt: "2026-06-04T00:10:00.000Z",
        };
        state.teammatePrivateAttachments.unshift(attachment);
        await route.fulfill({ status: 201, json: { attachment } });
        return;
      }
    }
    if (action === "direct-link-previews") {
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      if (request.method() === "GET") {
        await route.fulfill({
          json: {
            cwd,
            teammateId,
            thread,
            linkPreviews: state.teammateDirectLinkPreviews.filter((item) =>
              isRecord(item) &&
              item.teammateId === teammateId &&
              item.threadId === thread.id
            ),
          },
        });
        return;
      }
      if (request.method() === "POST") {
        const body = safePostDataJson(request);
        const rawUrl = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "https://example.com";
        if (state.linkPreviewDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, state.linkPreviewDelayMs));
        }
        const preview = {
          id: `tdlink_${state.teammateDirectLinkPreviews.length + 1}`,
          workspaceId: "workspace_default",
          teammateId,
          threadId: typeof thread.id === "string" ? thread.id : `tdthread_${teammateId}`,
          messageId: typeof body.messageId === "string" ? body.messageId : undefined,
          url: rawUrl,
          normalizedUrl: rawUrl,
          title: rawUrl.includes("example.com") ? "Example Domain" : rawUrl,
          description: rawUrl.includes("127.0.0.1") ? undefined : "Mock private link preview",
          siteName: rawUrl.includes("example.com") ? "example.com" : undefined,
          status: rawUrl.includes("127.0.0.1") ? "blocked" : "ready",
          errorMessage: rawUrl.includes("127.0.0.1") ? "Private network previews are blocked." : undefined,
          createdAt: "2026-06-04T00:15:00.000Z",
          updatedAt: "2026-06-04T00:15:00.000Z",
        };
        state.teammateDirectLinkPreviews.unshift(preview);
        await route.fulfill({ status: 201, json: { cwd, teammateId, thread, linkPreview: preview } });
        return;
      }
    }
    if (action === "direct-workspace" || action?.startsWith("direct-workspace/")) {
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      if (request.method() === "GET" && action === "direct-workspace") {
        const binding = readMockDirectWorkspaceBinding(thread);
        await route.fulfill({ json: buildMockDirectWorkspaceResponse(teammateId, thread, binding) });
        return;
      }
      if (request.method() === "POST" && action === "direct-workspace/refresh") {
        const binding = {
          ...readMockDirectWorkspaceBinding(thread),
          checkedAt: "2026-06-04T00:16:00.000Z",
          updatedAt: "2026-06-04T00:16:00.000Z",
        };
        const updated = { ...thread, workspaceBinding: binding, updatedAt: "2026-06-04T00:16:00.000Z" };
        state.teammateDirectThreads[teammateId] = updated;
        await route.fulfill({ json: buildMockDirectWorkspaceResponse(teammateId, updated, binding) });
        return;
      }
      if (request.method() === "POST" && action === "direct-workspace/create-worktree") {
        const binding = buildMockManagedDirectWorktreeBinding(teammateId, typeof thread.id === "string" ? thread.id : `tdthread_${teammateId}`, "2026-06-04T00:16:30.000Z");
        const updated = { ...thread, workspaceBinding: binding, updatedAt: "2026-06-04T00:16:30.000Z" };
        state.teammateDirectThreads[teammateId] = updated;
        await route.fulfill({ status: 201, json: buildMockDirectWorkspaceResponse(teammateId, updated, binding) });
        return;
      }
      if (request.method() === "POST" && action === "direct-workspace/handoff") {
        const body = safePostDataJson(request);
        const threadId = typeof thread.id === "string" ? thread.id : `tdthread_${teammateId}`;
        const existing = readMockDirectWorkspaceBinding(thread);
        const mode = body.mode === "managed_worktree" || body.mode === "external_path" || body.mode === "local" ? body.mode : "managed_worktree";
        const executionPath = mode === "managed_worktree"
          ? typeof existing.worktreePath === "string" ? existing.worktreePath : `${cwd}/.ling-stack/worktrees/teammates/${teammateId}/${threadId}`
          : mode === "external_path" && typeof body.executionPath === "string"
            ? body.executionPath
            : cwd;
        const binding = {
          ...existing,
          mode,
          status: "ready",
          executionPath,
          worktreePath: mode === "managed_worktree" ? executionPath : undefined,
          updatedAt: "2026-06-04T00:17:00.000Z",
          checkedAt: "2026-06-04T00:17:00.000Z",
        };
        const updated = { ...thread, workspaceBinding: binding, updatedAt: "2026-06-04T00:17:00.000Z" };
        state.teammateDirectThreads[teammateId] = updated;
        await route.fulfill({ json: buildMockDirectWorkspaceResponse(teammateId, updated, binding) });
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
      const url = new URL(request.url());
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
      const beforeMessageId = url.searchParams.get("beforeMessageId") ?? undefined;
      const sortedMessages = [...messages].sort((left, right) => {
        const leftCreatedAt = typeof left.createdAt === "string" ? left.createdAt : "";
        const rightCreatedAt = typeof right.createdAt === "string" ? right.createdAt : "";
        return leftCreatedAt.localeCompare(rightCreatedAt) || String(left.id ?? "").localeCompare(String(right.id ?? ""));
      });
      const cursorIndex = beforeMessageId ? sortedMessages.findIndex((item) => item.id === beforeMessageId) : sortedMessages.length;
      const endIndex = cursorIndex >= 0 ? cursorIndex : sortedMessages.length;
      const pageMessages = sortedMessages.slice(Math.max(0, endIndex - limit), endIndex);
      const hasMore = endIndex - limit > 0;
      await route.fulfill({
        json: action === "direct-thread"
          ? { cwd, teammateId, thread }
          : {
            cwd,
            teammateId,
            thread,
            messages: pageMessages,
            hasMore,
            nextBeforeMessageId: hasMore && pageMessages.length > 0 ? pageMessages[0].id : undefined,
          },
      });
      return;
    }
    if (action === "direct-runtime" && request.method() === "GET") {
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      await route.fulfill({ json: buildMockTeammateDirectRuntime(state, teammateId, thread) });
      return;
    }
    if (action === "direct-interventions") {
      const thread = getOrCreateMockTeammateThread(state, teammateId, teammate);
      if (request.method() === "GET") {
        await route.fulfill({
          json: {
            cwd,
            teammateId,
            thread,
            interventions: listOpenMockTeammateDirectInterventions(state, teammateId, thread.id),
          },
        });
        return;
      }
      if (request.method() === "POST") {
        const body = safePostDataJson(request);
        const runtime = buildMockTeammateDirectRuntime(state, teammateId, thread);
        if (!runtime.activeReply) {
          await route.fulfill({ status: 409, json: { error: "direct_reply_not_active", message: "No active direct reply." } });
          return;
        }
        const mode = body.mode === "interrupt_redirect" ? "interrupt_redirect" : "queue_followup";
        const rawPayload = isRecord(body.messagePayload) ? body.messagePayload : undefined;
        const messagePayload = rawPayload
          ? {
              body: typeof rawPayload.body === "string" ? rawPayload.body : "",
              attachmentIds: Array.isArray(rawPayload.attachmentIds) ? rawPayload.attachmentIds.filter((item): item is string => typeof item === "string") : [],
              linkPreviewIds: Array.isArray(rawPayload.linkPreviewIds) ? rawPayload.linkPreviewIds.filter((item): item is string => typeof item === "string") : [],
              fileRefs: Array.isArray(rawPayload.fileRefs) ? rawPayload.fileRefs.filter(isRecord).map(normalizeMockFileRef) : [],
            }
          : undefined;
        const instruction = typeof body.instruction === "string" && body.instruction.trim()
          ? body.instruction.trim()
          : messagePayload?.body ?? "";
        const idempotencyKey = typeof body.idempotencyKey === "string"
          ? body.idempotencyKey
          : `direct-guidance:${runtime.activeReply.workUnitId}:${mode}:${instruction}`;
        const existing = state.teammateDirectInterventions.find((item) => item.idempotencyKey === idempotencyKey);
        const intervention = existing ?? {
          id: `tdint_${state.teammateDirectInterventions.length + 1}`,
          workspaceId: "workspace_default",
          teammateId,
          threadId: thread.id,
          sourceMessageId: runtime.activeReply.sourceMessageId,
          sourceWorkUnitId: runtime.activeReply.workUnitId,
          mode,
          status: mode === "interrupt_redirect" ? "cancelling_source" : "queued",
          instruction,
          ...(messagePayload ? { messagePayload } : {}),
          idempotencyKey,
          requestedBy: "local-user",
          createdAt: "2026-06-04T00:30:00.000Z",
          updatedAt: "2026-06-04T00:30:00.000Z",
        } satisfies MockTeammateDirectIntervention;
        if (!existing) {
          state.teammateDirectInterventions.push(intervention);
        }
        await route.fulfill({
          status: 201,
          json: {
            cwd,
            teammateId,
            intervention,
            runtime: buildMockTeammateDirectRuntime(state, teammateId, thread),
          },
        });
        return;
      }
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
        linkPreviewIds: Array.isArray(body.linkPreviewIds) ? body.linkPreviewIds : [],
        fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs.filter(isRecord).map(normalizeMockFileRef) : [],
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
      const directReplyBody = buildMockDirectReplyBody(state, message.attachmentIds);
      const aiReply = {
        id: `tdmsg_${state.teammateDirectMessages.length + 1}`,
        workspaceId: "workspace_default",
        threadId: thread.id,
        teammateId,
        authorType: "ai-teammate",
        authorId: teammateId,
        body: blockedReason ? `AI teammate is blocked: ${blockedReason}` : directReplyBody,
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
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
        linkPreviewIds: Array.isArray(body.linkPreviewIds) ? body.linkPreviewIds : [],
        fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs.filter(isRecord).map(normalizeMockFileRef) : [],
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
      const directReplyBody = buildMockDirectReplyBody(state, message.attachmentIds);
      const aiReply = body.requestAiReply === true
        ? {
            id: `tdmsg_${state.teammateDirectMessages.length + 1}`,
            workspaceId: "workspace_default",
            threadId: thread.id,
            teammateId,
            authorType: "ai-teammate",
            authorId: teammateId,
            body: blockedReason ? `AI teammate is blocked: ${blockedReason}` : directReplyBody,
            attachmentIds: [],
            linkPreviewIds: [],
            fileRefs: [],
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
  const teammateDirectInterventionCancelMatch = /^\/teammate-direct-interventions\/([^/]+)\/cancel$/.exec(path);
  if (teammateDirectInterventionCancelMatch && request.method() === "POST") {
    const interventionId = decodeURIComponent(teammateDirectInterventionCancelMatch[1]);
    const interventionIndex = state.teammateDirectInterventions.findIndex((item) => item.id === interventionId);
    if (interventionIndex < 0) {
      await route.fulfill({ status: 404, json: { error: "direct_intervention_not_found" } });
      return;
    }
    const intervention = {
      ...state.teammateDirectInterventions[interventionIndex],
      status: "cancelled",
      completedAt: "2026-06-04T00:31:00.000Z",
      updatedAt: "2026-06-04T00:31:00.000Z",
    } satisfies MockTeammateDirectIntervention;
    state.teammateDirectInterventions[interventionIndex] = intervention;
    const thread = state.teammateDirectThreads[intervention.teammateId] ?? getOrCreateMockTeammateThread(state, intervention.teammateId, {});
    await route.fulfill({
      json: {
        cwd,
        teammateId: intervention.teammateId,
        intervention,
        runtime: buildMockTeammateDirectRuntime(state, intervention.teammateId, thread),
      },
    });
    return;
  }
  const teammateDirectInterventionPromoteMatch = /^\/teammate-direct-interventions\/([^/]+)\/promote$/.exec(path);
  if (teammateDirectInterventionPromoteMatch && request.method() === "POST") {
    const interventionId = decodeURIComponent(teammateDirectInterventionPromoteMatch[1]);
    const interventionIndex = state.teammateDirectInterventions.findIndex((item) => item.id === interventionId);
    if (interventionIndex < 0) {
      await route.fulfill({ status: 404, json: { error: "direct_intervention_not_found" } });
      return;
    }
    const current = state.teammateDirectInterventions[interventionIndex];
    if (current.status !== "queued") {
      await route.fulfill({ status: 409, json: { error: "direct_intervention_not_queued", message: "Only queued guidance can run now." } });
      return;
    }
    const thread = state.teammateDirectThreads[current.teammateId] ?? getOrCreateMockTeammateThread(state, current.teammateId, {});
    const activeWorkUnitIndex = state.workUnits.findIndex((unit) =>
      unit.kind === "teammate_direct_reply" &&
      (unit.teammateId === current.teammateId || unit.ownerId === current.teammateId) &&
      isActiveMockWorkUnit(unit.status)
    );
    if (activeWorkUnitIndex < 0) {
      const intervention = {
        ...current,
        status: "starting_continuation",
        startedAt: current.startedAt ?? "2026-06-04T00:32:30.000Z",
        updatedAt: "2026-06-04T00:32:30.000Z",
      } satisfies MockTeammateDirectIntervention;
      state.teammateDirectInterventions[interventionIndex] = intervention;
      await route.fulfill({
        json: {
          cwd,
          teammateId: intervention.teammateId,
          intervention,
          runtime: buildMockTeammateDirectRuntime(state, intervention.teammateId, thread),
          message: "当前回复已结束，已开始执行这条引导。",
        },
      });
      return;
    }
    const intervention = {
      ...current,
      status: "cancelling_source",
      startedAt: "2026-06-04T00:32:30.000Z",
      updatedAt: "2026-06-04T00:32:30.000Z",
    } satisfies MockTeammateDirectIntervention;
    state.teammateDirectInterventions[interventionIndex] = intervention;
    const workUnit = {
      ...state.workUnits[activeWorkUnitIndex],
      status: "cancelled",
      endedAt: "2026-06-04T00:32:30.000Z",
      updatedAt: "2026-06-04T00:32:30.000Z",
    };
    state.workUnits[activeWorkUnitIndex] = workUnit;
    const messageId = workUnit.linkedMessageId;
    const messageIndex = state.teammateDirectMessages.findIndex((message) => isRecord(message) && message.id === messageId);
    if (messageIndex >= 0 && isRecord(state.teammateDirectMessages[messageIndex])) {
      state.teammateDirectMessages[messageIndex] = {
        ...state.teammateDirectMessages[messageIndex],
        status: "cancelled",
        body: "Reply stopped",
        errorMessage: "Reply stopped",
        updatedAt: "2026-06-04T00:32:30.000Z",
      };
    }
    await route.fulfill({
      json: {
        cwd,
        teammateId: intervention.teammateId,
        intervention,
        runtime: buildMockTeammateDirectRuntime(state, intervention.teammateId, thread),
      },
    });
    return;
  }
  const teammateDirectReplyCancelMatch = /^\/teammate-direct-replies\/([^/]+)\/cancel$/.exec(path);
  if (teammateDirectReplyCancelMatch && request.method() === "POST") {
    const workUnitId = decodeURIComponent(teammateDirectReplyCancelMatch[1]);
    const workUnitIndex = state.workUnits.findIndex((unit) => unit.id === workUnitId);
    if (workUnitIndex < 0) {
      await route.fulfill({ status: 404, json: { error: "work_unit_not_found" } });
      return;
    }
    const workUnit = {
      ...state.workUnits[workUnitIndex],
      status: "cancelled",
      endedAt: "2026-06-04T00:32:00.000Z",
      updatedAt: "2026-06-04T00:32:00.000Z",
    };
    state.workUnits[workUnitIndex] = workUnit;
    const messageId = workUnit.linkedMessageId;
    const messageIndex = state.teammateDirectMessages.findIndex((message) => isRecord(message) && message.id === messageId);
    const message = messageIndex >= 0 && isRecord(state.teammateDirectMessages[messageIndex])
      ? {
          ...state.teammateDirectMessages[messageIndex],
          status: "cancelled",
          body: "",
          updatedAt: "2026-06-04T00:32:00.000Z",
        }
      : undefined;
    if (message && messageIndex >= 0) {
      state.teammateDirectMessages[messageIndex] = message;
    }
    await route.fulfill({ json: { cwd, workUnit, ...(message ? { message } : {}) } });
    return;
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
          { id: "gpt-image-2", ownedBy: "openai", api: "media-job", input: ["text", "image"], capabilities: ["image_generate"], capabilitySource: "upstream", capabilityConfidence: "known" },
          { id: "black-forest-labs/flux-2-pro", ownedBy: "black-forest-labs", api: "media-job", input: ["text", "image"], capabilities: ["image_generate"], capabilitySource: "model_catalog", capabilityConfidence: "known" },
          { id: "stability-ai/stable-diffusion-3.5-large", ownedBy: "stability", api: "media-job", input: ["text", "image"], capabilities: ["image_generate"], capabilitySource: "model_catalog", capabilityConfidence: "known" },
          { id: "qwen-image-edit", ownedBy: "alibaba", api: "media-job", input: ["text", "image"], capabilities: ["image_generate", "image_edit"], capabilitySource: "model_catalog", capabilityConfidence: "known" },
          { id: "ideogram-ai/ideogram-v3-quality", ownedBy: "ideogram", api: "media-job", input: ["text", "image"], capabilities: ["image_generate"], capabilitySource: "model_catalog", capabilityConfidence: "known" },
          { id: "doubao-seedream-5-0-260128", ownedBy: "volcengine" },
          { id: "doubao-seedance-1-0-pro-250528", ownedBy: "volcengine" },
          { id: "doubao-1-5-pro-32k-250115", ownedBy: "volcengine" },
          {
            id: "cliproxy-claude-sonnet",
            ownedBy: "cliproxy",
            capabilities: ["chat", "reasoning"],
            thinkingModes: ["off", "low", "medium", "high", "xhigh"],
            thinkingSupport: { levels: ["off", "low", "medium", "high", "xhigh"], maxTokens: 8192 },
            contextWindow: 200000,
            maxTokens: 8192,
            supportedParameters: ["thinking", "tools"],
            capabilitySource: "model_catalog",
            capabilityConfidence: "known",
          },
        ],
      },
    });
    return;
  }
  if (request.method() === "POST" && path === "/providers/import-models") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const models = Array.isArray(body.models) ? body.models.filter(isRecord) : [];
    const providers: Record<string, unknown>[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    for (const model of models) {
      const modelId = typeof model.id === "string" ? model.id : "";
      if (!modelId) {
        continue;
      }
      const modelDisplayName = typeof model.displayName === "string" && model.displayName.trim() ? model.displayName : modelId;
      const displayName = `${typeof body.displayName === "string" ? body.displayName : "Provider"} · ${modelDisplayName}`;
      const modelApi = typeof model.api === "string" ? model.api : body.api;
      const providerIndex = state.providers.findIndex((item) =>
        isRecord(item) &&
        item.providerId === body.providerId &&
        item.api === modelApi &&
        item.baseUrl === body.baseUrl &&
        item.model === modelId
      );
      const providerBody = {
        ...body,
        displayName,
        model: modelId,
        api: modelApi,
        input: Array.isArray(model.input) ? model.input : body.input,
        capabilities: Array.isArray(model.capabilities) ? model.capabilities : body.capabilities,
        thinkingModes: Array.isArray(model.thinkingModes) ? model.thinkingModes : body.thinkingModes,
        reasoning: Array.isArray(model.thinkingModes) ? model.thinkingModes.some((mode) => mode !== "off") : body.reasoning,
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : body.contextWindow,
        maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : body.maxTokens,
        compat: {
          ...(isRecord(body.compat) ? body.compat : {}),
          modelMetadata: {
            id: modelId,
            supportedParameters: Array.isArray(model.supportedParameters) ? model.supportedParameters : undefined,
            thinkingSupport: isRecord(model.thinkingSupport) ? model.thinkingSupport : undefined,
            capabilitySource: typeof model.capabilitySource === "string" ? model.capabilitySource : undefined,
            capabilityConfidence: typeof model.capabilityConfidence === "string" ? model.capabilityConfidence : undefined,
          },
        },
      };
      if (providerIndex >= 0) {
        const existing = state.providers[providerIndex];
        const provider = isRecord(existing)
          ? { ...existing, ...createProviderFromBody(providerBody, String(existing.id), existing), id: existing.id }
          : createProviderFromBody(providerBody, `provider_created_${state.providers.length + 1}`);
        if (provider.api !== "media-job") {
          provider.lastCheck = buildProviderCheckResult(provider);
        }
        state.providers[providerIndex] = provider;
        providers.push(provider);
        updatedCount += 1;
        if (typeof body.apiKey === "string" && body.apiKey.trim()) {
          state.providerSecrets[String(provider.id)] = body.apiKey;
        }
        continue;
      }
      const provider = createProviderFromBody(providerBody, `provider_created_${state.providers.length + 1}`);
      if (provider.api !== "media-job") {
        provider.lastCheck = buildProviderCheckResult(provider);
      }
      state.providers.push(provider);
      providers.push(provider);
      createdCount += 1;
      if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        state.providerSecrets[String(provider.id)] = body.apiKey;
      }
    }
    await route.fulfill({ json: { providers, createdCount, updatedCount, warnings: [] } });
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
    const archived = url.searchParams.get("archived") === "true";
    const channels = state.channels.filter((channel) =>
      isRecord(channel) && (archived ? channel.status === "archived" : channel.status !== "archived")
    );
    const channelIds = new Set(channels.filter(isRecord).map((channel) => channel.id).filter((id): id is string => typeof id === "string"));
    const branches = state.channelBranches
      .filter((branch) =>
        isRecord(branch) &&
        channelIds.has(typeof branch.channelId === "string" ? branch.channelId : "") &&
        (archived ? branch.status === "archived" : branch.status !== "archived")
      )
      .map((branch) => {
        const channel = state.channels.find((item) => isRecord(item) && item.id === branch.channelId);
        return isRecord(channel) ? ensureMockChannelBranchRootThread(state, channel, branch) : branch;
      });
    await route.fulfill({ json: { cwd, channels, branches } });
    return;
  }
  if (request.method() === "POST" && path === "/channels") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    if (state.failNextChannelCreate) {
      const failure = state.failNextChannelCreate;
      state.failNextChannelCreate = undefined;
      await route.fulfill({
        status: failure.status ?? 400,
        json: { error: failure.error, message: failure.message },
      });
      return;
    }
    const channelId = `channel_created_${state.channels.length + 1}`;
    const channel = {
      ...createChannelFromBody(body, channelId),
      workspaceBinding: buildMockManagedChannelWorktreeBinding(channelId),
    };
    state.channels.unshift(channel);
    await route.fulfill({ status: 201, json: { channel } });
    return;
  }
  const channelCouncilPolicyMatch = /^\/channels\/([^/]+)\/council-policy$/.exec(path);
  if (channelCouncilPolicyMatch) {
    const channelId = decodeURIComponent(channelCouncilPolicyMatch[1]);
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found" } });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ json: { cwd, channelId, policy: readMockChannelCouncilPolicy(state, channelId) } });
      return;
    }
    if (request.method() === "PUT") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const policy = writeMockChannelCouncilPolicy(state, channelId, body);
      await route.fulfill({ json: { cwd, channelId, policy } });
      return;
    }
  }
  const channelEffectiveCouncilMatch = /^\/channels\/([^/]+)\/effective-council$/.exec(path);
  if (channelEffectiveCouncilMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelEffectiveCouncilMatch[1]);
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found" } });
      return;
    }
    await route.fulfill({
      json: {
        cwd,
        channelId,
        effectiveCouncil: buildMockEffectiveChannelCouncil(state, channelId),
      },
    });
    return;
  }
  const channelProtocolMatch = /^\/channels\/([^/]+)\/protocol(?:\/([^/]+))?$/.exec(path);
  if (channelProtocolMatch) {
    const channelId = decodeURIComponent(channelProtocolMatch[1]);
    const action = channelProtocolMatch[2] ? decodeURIComponent(channelProtocolMatch[2]) : "";
    const channelIndex = state.channels.findIndex((item) => isRecord(item) && item.id === channelId);
    if (channelIndex === -1 || !isRecord(state.channels[channelIndex])) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const channel = state.channels[channelIndex] as Record<string, unknown>;
    if (request.method() === "GET" && !action) {
      await route.fulfill({ json: buildMockChannelCollaborationProtocolResponse(channelId, channel) });
      return;
    }
    if (request.method() === "GET" && action === "canvas") {
      await route.fulfill({ json: buildMockChannelProtocolCanvasResponse(state, channelId, channel) });
      return;
    }
    if (request.method() === "PATCH" && !action) {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const updated = createChannelFromBody(body, channelId, channel);
      state.channels[channelIndex] = updated;
      await route.fulfill({ json: buildMockChannelCollaborationProtocolResponse(channelId, updated) });
      return;
    }
    if (request.method() === "POST" && action === "revert") {
      const updated = {
        ...channel,
        autoReplyMode: "mentions_only",
        defaultTeammateId: undefined,
        responseLanguage: undefined,
        updatedAt: "2026-05-25T00:15:00.000Z",
      };
      state.channels[channelIndex] = updated;
      await route.fulfill({ json: { ...buildMockChannelCollaborationProtocolResponse(channelId, updated), revertedFields: ["responseLanguage", "autoReplyMode", "defaultTeammateId"] } });
      return;
    }
  }
  const channelProtocolDraftMatch = /^\/channels\/([^/]+)\/protocol\/drafts(?:\/([^/]+)\/apply)?$/.exec(path);
  const channelProtocolCandidateFromClusterMatch = /^\/channels\/([^/]+)\/protocol-candidates\/from-cluster\/([^/]+)$/.exec(path);
  if (channelProtocolCandidateFromClusterMatch) {
    const channelId = decodeURIComponent(channelProtocolCandidateFromClusterMatch[1]);
    const clusterId = decodeURIComponent(channelProtocolCandidateFromClusterMatch[2]);
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const cluster = state.procedureObservationClusters.find((item) => isRecord(item) && item.id === clusterId);
    if (!isRecord(cluster)) {
      await route.fulfill({ status: 404, json: { error: "procedure_observation_cluster_not_found", message: `Procedure observation cluster not found: ${clusterId}` } });
      return;
    }
    if (cluster.channelId !== channelId) {
      await route.fulfill({ status: 400, json: { error: "procedure_observation_cluster_channel_mismatch" } });
      return;
    }
    if (cluster.routeKind !== "channel_protocol") {
      await route.fulfill({ status: 400, json: { error: "unsupported_procedure_observation_cluster_route" } });
      return;
    }
    const routeBlockers = Array.isArray(cluster.routeBlockers) ? cluster.routeBlockers : [];
    if (cluster.status !== "ready_for_review" || routeBlockers.length > 0) {
      await route.fulfill({ status: 400, json: { error: "procedure_observation_cluster_not_ready", blockers: routeBlockers } });
      return;
    }
    const body = request.postData() ? await request.postDataJSON() as Record<string, unknown> : {};
    const sourceRefs = Array.isArray(cluster.sourceRefs)
      ? cluster.sourceRefs.filter(isRecord).map((ref) => ({
        ...ref,
        type: ref.type === "decision" ? "channel_decision" : ref.type,
      }))
      : [];
    const defaultReviewRule = `${String(cluster.title ?? "Channel protocol")}: ${String(cluster.summary ?? "")}`.trim();
    const draft = createMockChannelProtocolDraft(state, channelId, {
      proposedPatch: isRecord(body.proposedPatch) ? body.proposedPatch : { reviewRules: [defaultReviewRule] },
      reason: typeof body.reason === "string" && body.reason.trim()
        ? body.reason
        : `Created from procedure observation cluster ${clusterId}: ${String(cluster.title ?? "")}`,
      expiresAt: body.expiresAt,
      sourceRefs,
    });
    state.channelProtocolDrafts.unshift(draft);
    await route.fulfill({ status: 201, json: { ...buildMockChannelCollaborationProtocolResponse(channelId, channel), draft } });
    return;
  }
  const channelPlaybookCandidateFromClusterMatch = /^\/channels\/([^/]+)\/playbook-candidates\/from-cluster\/([^/]+)$/.exec(path);
  if (channelPlaybookCandidateFromClusterMatch) {
    const channelId = decodeURIComponent(channelPlaybookCandidateFromClusterMatch[1]);
    const clusterId = decodeURIComponent(channelPlaybookCandidateFromClusterMatch[2]);
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const cluster = state.procedureObservationClusters.find((item) => isRecord(item) && item.id === clusterId);
    if (!isRecord(cluster)) {
      await route.fulfill({ status: 404, json: { error: "procedure_observation_cluster_not_found", message: `Procedure observation cluster not found: ${clusterId}` } });
      return;
    }
    if (cluster.channelId !== channelId) {
      await route.fulfill({ status: 400, json: { error: "procedure_observation_cluster_channel_mismatch" } });
      return;
    }
    if (cluster.routeKind !== "playbook") {
      await route.fulfill({ status: 400, json: { error: "unsupported_procedure_observation_cluster_route" } });
      return;
    }
    const routeBlockers = Array.isArray(cluster.routeBlockers) ? cluster.routeBlockers : [];
    if (cluster.status !== "ready_for_review" || routeBlockers.length > 0) {
      await route.fulfill({ status: 400, json: { error: "procedure_observation_cluster_not_ready", blockers: routeBlockers } });
      return;
    }
    const body = request.postData() ? await request.postDataJSON() as Record<string, unknown> : {};
    const candidate = createMockChannelPlaybookCandidate(state, channelId, cluster, body);
    state.channelPlaybookCandidates.unshift(candidate);
    await route.fulfill({ status: 201, json: { cwd, channelId, candidate } });
    return;
  }
  const channelPlaybookCandidateMatch = /^\/channels\/([^/]+)\/playbook-candidates(?:\/([^/]+)\/review)?$/.exec(path);
  if (channelPlaybookCandidateMatch) {
    const channelId = decodeURIComponent(channelPlaybookCandidateMatch[1]);
    const candidateId = channelPlaybookCandidateMatch[2] ? decodeURIComponent(channelPlaybookCandidateMatch[2]) : "";
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    if (!candidateId && request.method() === "GET") {
      const status = url.searchParams.get("status");
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50), 200));
      const candidates = state.channelPlaybookCandidates
        .filter((item) => isRecord(item) && item.channelId === channelId && (!status || item.status === status))
        .slice(0, limit);
      await route.fulfill({ json: { cwd, channelId, candidates } });
      return;
    }
    const candidateIndex = state.channelPlaybookCandidates.findIndex((item) => isRecord(item) && item.id === candidateId && item.channelId === channelId);
    if (candidateIndex === -1 || !isRecord(state.channelPlaybookCandidates[candidateIndex])) {
      await route.fulfill({ status: 404, json: { error: "playbook_candidate_not_found" } });
      return;
    }
    if (request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const candidate = state.channelPlaybookCandidates[candidateIndex] as Record<string, unknown>;
      if (candidate.status !== "draft") {
        await route.fulfill({ status: 409, json: { error: "playbook_candidate_not_reviewable", candidate } });
        return;
      }
      const updated = {
        ...candidate,
        status: body.action === "approve" ? "active" : "cancelled",
        activatedAt: body.action === "approve" ? "2026-06-20T00:40:00.000Z" : undefined,
        updatedAt: "2026-06-20T00:40:00.000Z",
      };
      state.channelPlaybookCandidates[candidateIndex] = updated;
      await route.fulfill({ json: { cwd, channelId, candidate: updated } });
      return;
    }
  }
  const channelProtocolCandidateMatch = /^\/channels\/([^/]+)\/protocol-candidates(?:\/([^/]+)\/review)?$/.exec(path);
  if (channelProtocolDraftMatch || channelProtocolCandidateMatch) {
    const match = channelProtocolDraftMatch ?? channelProtocolCandidateMatch;
    const channelId = decodeURIComponent(match?.[1] ?? "");
    const draftId = match?.[2] ? decodeURIComponent(match[2]) : "";
    const channelIndex = state.channels.findIndex((item) => isRecord(item) && item.id === channelId);
    if (channelIndex === -1 || !isRecord(state.channels[channelIndex])) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const channel = state.channels[channelIndex] as Record<string, unknown>;
    const isCandidateRoute = Boolean(channelProtocolCandidateMatch);
    if (!draftId && request.method() === "GET") {
      const status = url.searchParams.get("status");
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50), 200));
      const drafts = state.channelProtocolDrafts
        .filter((item) => isRecord(item) && item.channelId === channelId && (!status || item.status === status))
        .slice(0, limit);
      await route.fulfill({ json: { cwd, channelId, drafts } });
      return;
    }
    if (!draftId && request.method() === "POST") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const draft = createMockChannelProtocolDraft(state, channelId, body);
      state.channelProtocolDrafts.unshift(draft);
      await route.fulfill({ status: 201, json: { ...buildMockChannelCollaborationProtocolResponse(channelId, channel), draft } });
      return;
    }
    const draftIndex = state.channelProtocolDrafts.findIndex((item) => isRecord(item) && item.id === draftId && item.channelId === channelId);
    if (draftIndex === -1 || !isRecord(state.channelProtocolDrafts[draftIndex])) {
      await route.fulfill({ status: 404, json: { error: isCandidateRoute ? "protocol_candidate_not_found" : "protocol_draft_not_found" } });
      return;
    }
    const draft = state.channelProtocolDrafts[draftIndex] as Record<string, unknown>;
    if (request.method() === "POST" && channelProtocolDraftMatch) {
      const applied = applyMockChannelProtocolDraft(channel, draft);
      state.channels[channelIndex] = applied.channel;
      state.channelProtocolDrafts[draftIndex] = applied.draft;
      await route.fulfill({ json: { ...buildMockChannelCollaborationProtocolResponse(channelId, applied.channel), draft: applied.draft } });
      return;
    }
    if (request.method() === "POST" && channelProtocolCandidateMatch) {
      const body = await request.postDataJSON() as Record<string, unknown>;
      if (body.action === "approve") {
        const applied = applyMockChannelProtocolDraft(channel, draft);
        state.channels[channelIndex] = applied.channel;
        state.channelProtocolDrafts[draftIndex] = applied.draft;
        await route.fulfill({ json: { ...buildMockChannelCollaborationProtocolResponse(channelId, applied.channel), draft: applied.draft } });
        return;
      }
      const cancelled = { ...draft, status: "cancelled", updatedAt: "2026-06-20T00:31:00.000Z" };
      state.channelProtocolDrafts[draftIndex] = cancelled;
      await route.fulfill({ json: { ...buildMockChannelCollaborationProtocolResponse(channelId, channel), draft: cancelled } });
      return;
    }
  }
  const channelTeamExpertsMatch = /^\/channels\/([^/]+)\/team-experts$/.exec(path);
  if (channelTeamExpertsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelTeamExpertsMatch[1]);
    const turnId = url.searchParams.get("turnId");
    if (!turnId) {
      await route.fulfill({ status: 400, json: { error: "bad_request", message: "turnId query parameter is required" } });
      return;
    }
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    state.channelTeamExpertsRequests.push({
      channelId,
      turnId,
      includeExpired: url.searchParams.get("includeExpired") === "true" ? true : url.searchParams.get("includeExpired") === "false" ? false : undefined,
    });
    const experts = state.channelTeamExpertsByTurn[`${channelId}:${turnId}`] ??
      state.channelTeamExpertsByTurn[turnId] ??
      buildEmptyMockFoldedExperts(channelId, turnId);
    await route.fulfill({ json: { cwd, channelId, turnId, experts } });
    return;
  }
  const channelTeamMetricsMatch = /^\/channels\/([^/]+)\/team-metrics$/.exec(path);
  if (channelTeamMetricsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelTeamMetricsMatch[1]);
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const metrics = state.channelTeamMetricsByChannel[channelId] ?? buildEmptyMockTeamMetrics(channelId);
    await route.fulfill({ json: { cwd, channelId, metrics } });
    return;
  }
  const channelBranchesMatch = /^\/channels\/([^/]+)\/branches(?:\/([^/]+))?$/.exec(path);
  if (channelBranchesMatch) {
    const channelId = decodeURIComponent(channelBranchesMatch[1]);
    const branchId = channelBranchesMatch[2] ? decodeURIComponent(channelBranchesMatch[2]) : "";
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    if (request.method() === "GET" && !branchId) {
      const archived = url.searchParams.get("archived") === "true";
      const branches = state.channelBranches
        .filter((branch) =>
          isRecord(branch) &&
          branch.channelId === channelId &&
          (archived ? branch.status === "archived" : branch.status !== "archived")
        )
        .map((branch) => ensureMockChannelBranchRootThread(state, channel, branch));
      await route.fulfill({ json: { cwd, channelId, branches } });
      return;
    }
    if (request.method() === "POST" && !branchId) {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const branch = createChannelBranchFromBody(body, `channel_branch_${state.channelBranches.length + 1}`, channelId);
      ensureMockChannelBranchRootThread(state, channel, branch);
      state.channelBranches.unshift(branch);
      await route.fulfill({ status: 201, json: { branch } });
      return;
    }
    const branchIndex = state.channelBranches.findIndex((item) => isRecord(item) && item.channelId === channelId && item.id === branchId);
    if (branchIndex === -1 || !isRecord(state.channelBranches[branchIndex])) {
      await route.fulfill({ status: 404, json: { error: "channel_branch_not_found", message: `Channel branch not found: ${branchId}` } });
      return;
    }
    const existingBranch = state.channelBranches[branchIndex] as Record<string, unknown>;
    if (request.method() === "GET") {
      const branch = ensureMockChannelBranchRootThread(state, channel, existingBranch);
      state.channelBranches[branchIndex] = branch;
      await route.fulfill({ json: { branch } });
      return;
    }
    if (request.method() === "PATCH") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const branch = createChannelBranchFromBody(body, branchId, channelId, existingBranch);
      ensureMockChannelBranchRootThread(state, channel, branch);
      state.channelBranches[branchIndex] = branch;
      await route.fulfill({ json: { branch } });
      return;
    }
    if (request.method() === "DELETE") {
      if (existingBranch.status !== "archived") {
        await route.fulfill({ status: 409, json: { error: "channel_branch_active", message: "Archive branch before deleting it." } });
        return;
      }
      state.channelBranches = state.channelBranches.filter((item) => !isRecord(item) || item.id !== branchId);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
  }
  const channelWorkspaceMatch = /^\/channels\/([^/]+)\/workspace(?:\/([^/]+))?$/.exec(path);
  if (channelWorkspaceMatch) {
    const channelId = decodeURIComponent(channelWorkspaceMatch[1]);
    const action = channelWorkspaceMatch[2] ? decodeURIComponent(channelWorkspaceMatch[2]) : "";
    const channelIndex = state.channels.findIndex((item) => isRecord(item) && item.id === channelId);
    if (channelIndex === -1 || !isRecord(state.channels[channelIndex])) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const channel = state.channels[channelIndex] as Record<string, unknown>;
    if (request.method() === "GET" && action === "git-status") {
      const binding = readMockChannelWorkspaceBinding(channel);
      const fixture = state.channelWorkspaceGitStatusByChannel[channelId];
      if (isMockWorkspaceGitStatusFailure(fixture)) {
        await route.fulfill({
          status: fixture.status ?? 500,
          json: { error: "mock_git_status_failed", message: fixture.message ?? "Mock Git status failed." },
        });
        return;
      }
      await route.fulfill({ json: buildMockChannelWorkspaceGitStatusResponse(channelId, channel, binding, fixture) });
      return;
    }
    if (request.method() === "GET" && !action) {
      const binding = readMockChannelWorkspaceBinding(channel);
      await route.fulfill({ json: buildMockChannelWorkspaceResponse(channelId, channel, binding) });
      return;
    }
    if (request.method() === "POST" && action === "refresh") {
      const binding = {
        ...readMockChannelWorkspaceBinding(channel),
        status: "ready",
        checkedAt: "2026-05-25T00:18:00.000Z",
        updatedAt: "2026-05-25T00:18:00.000Z",
      };
      const updated = { ...channel, workspaceBinding: binding, updatedAt: "2026-05-25T00:18:00.000Z" };
      state.channels[channelIndex] = updated;
      await route.fulfill({ json: buildMockChannelWorkspaceResponse(channelId, updated, binding) });
      return;
    }
    if (request.method() === "POST" && action === "create-worktree") {
      const binding = buildMockManagedChannelWorktreeBinding(channelId, "2026-05-25T00:18:00.000Z");
      const updated = { ...channel, workspaceBinding: binding, updatedAt: "2026-05-25T00:18:00.000Z" };
      state.channels[channelIndex] = updated;
      await route.fulfill({ status: 201, json: buildMockChannelWorkspaceResponse(channelId, updated, binding) });
      return;
    }
    if (request.method() === "POST" && action === "handoff") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const existing = readMockChannelWorkspaceBinding(channel);
      const mode = body.mode === "managed_worktree" || body.mode === "external_path" ? body.mode : "local";
      const executionPath = mode === "managed_worktree"
        ? typeof existing.worktreePath === "string" ? existing.worktreePath : `${cwd}/.ling-stack/worktrees/channels/${channelId}`
        : mode === "external_path" && typeof body.executionPath === "string"
          ? body.executionPath
          : typeof channel.boundPath === "string" ? channel.boundPath : cwd;
      const binding = {
        ...existing,
        mode,
        status: "ready",
        executionPath,
        worktreePath: mode === "managed_worktree" ? executionPath : undefined,
        updatedAt: "2026-05-25T00:18:00.000Z",
        checkedAt: "2026-05-25T00:18:00.000Z",
      };
      const updated = { ...channel, workspaceBinding: binding, updatedAt: "2026-05-25T00:18:00.000Z" };
      state.channels[channelIndex] = updated;
      await route.fulfill({ json: buildMockChannelWorkspaceResponse(channelId, updated, binding) });
      return;
    }
  }
  const channelMessageStreamMatch = /^\/channels\/([^/]+)\/messages\/stream$/.exec(path);
  if (channelMessageStreamMatch && request.method() === "POST") {
    const channelId = decodeURIComponent(channelMessageStreamMatch[1]);
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
      fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs : [],
      linkedTaskId: typeof body.linkedTaskId === "string" ? body.linkedTaskId : undefined,
      linkedRunId: typeof body.linkedRunId === "string" ? body.linkedRunId : undefined,
      status: "ready",
      createdAt: "2026-05-25T00:18:00.000Z",
      updatedAt: "2026-05-25T00:18:00.000Z",
    };
    state.channelMessages.push(message);
    const materializationClarifyReply = maybeCreateMockMaterializationClarifyReply(state, channelId, message);
    if (materializationClarifyReply) {
      const events = [
        { event: "ready", data: { message } },
        { event: "ready", data: { message, aiReply: materializationClarifyReply, aiReplies: [materializationClarifyReply] } },
        { event: "done", data: { message, aiReply: materializationClarifyReply, aiReplies: [materializationClarifyReply] } },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(""),
      });
      return;
    }
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    const autoReplyMode = isRecord(channel) && typeof channel.autoReplyMode === "string" ? channel.autoReplyMode : "mentions_only";
    const mockWorkflowProposal = body.requestAiReply !== true
      ? maybeCreateMockWorkflowProposal(state, channelId, message, autoReplyMode)
      : undefined;
    if (mockWorkflowProposal) {
      const events = [
        { event: "ready", data: { message } },
        { event: "done", data: { message, ...mockWorkflowProposal } },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(""),
      });
      return;
    }
    const shouldAutoReply = body.requestAiReply === true ||
      (
        typeof message.body === "string" &&
        message.authorType === "local-user" &&
        message.kind === "message" &&
        message.intent === "discuss" &&
        !message.threadId &&
        (message.body.includes("?") || message.body.includes("？") || isMockContextualFollowUp(message.body)) &&
        (autoReplyMode === "default_teammate" || autoReplyMode === "auto_route")
      );
    const routedTeammateId = body.requestAiReply === true
      ? typeof body.teammateId === "string" ? body.teammateId : "engineer"
      : autoReplyMode === "auto_route" ? "designer" : isRecord(channel) && typeof channel.defaultTeammateId === "string" ? channel.defaultTeammateId : undefined;
    const routeDecision = {
      schemaVersion: 1,
      id: `route_${state.channelMessageRouteDecisions.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      sourceMessageId: message.id,
      mode: autoReplyMode,
      action: shouldAutoReply && routedTeammateId ? "reply" : "no_reply",
      selectedTeammateId: shouldAutoReply ? routedTeammateId : undefined,
      selectedProviderPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : undefined,
      confidence: shouldAutoReply ? 1 : undefined,
      reason: shouldAutoReply ? "Mock route accepted." : "Mock route suppressed.",
      alternativesConsidered: [],
      contextPack: shouldAutoReply
        ? {
            schemaVersion: 1,
            kind: autoReplyMode === "auto_route" ? "auto_route_selector" : "channel_reply",
            providerPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : undefined,
            modelId: "mock-model",
            sectionIds: autoReplyMode === "auto_route"
              ? ["auto_route_instructions", "channel_collaboration_protocol", "auto_route_source_message", "auto_route_recent_context", "auto_route_candidates"]
              : ["channel_collaboration_protocol", "channel_discussion"],
            droppedSectionIds: [],
            sourceRefCounts: { channel: 1, message: 1 },
            compactionIds: [],
          }
        : undefined,
      status: shouldAutoReply && routedTeammateId ? "accepted" : "suppressed",
      createdBy: body.requestAiReply === true ? "explicit_mention" : autoReplyMode === "auto_route" ? "model" : "deterministic",
      createdAt: "2026-05-25T00:18:00.500Z",
      updatedAt: "2026-05-25T00:18:00.500Z",
    };
    state.channelMessageRouteDecisions.push(routeDecision);
    const aiReplyBody = state.channelAiReplyBody ?? "收到，我会按频道上下文推进。";
    const aiReply = shouldAutoReply && routedTeammateId
      ? {
          id: `msg_${state.channelMessages.length + 1}`,
          workspaceId: "workspace_default",
          channelId,
          threadId: message.threadId ?? message.id,
          kind: "ai_reply",
          intent: "discuss",
          authorType: "ai-teammate",
          authorId: routedTeammateId,
          body: aiReplyBody,
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          fileRefs: [],
          status: "ready",
          createdAt: "2026-05-25T00:18:01.000Z",
          updatedAt: "2026-05-25T00:18:01.000Z",
        }
      : undefined;
    const pendingReply = aiReply ? { ...aiReply, body: "", status: "pending", errorMessage: undefined } : undefined;
    const storedAiReply = aiReply && state.keepChannelAiReplyPending ? pendingReply ?? aiReply : aiReply;
    if (storedAiReply) {
      state.channelMessages.push(storedAiReply);
      const index = state.channelMessageRouteDecisions.findIndex((decision) => isRecord(decision) && decision.id === routeDecision.id);
      if (index !== -1) {
        state.channelMessageRouteDecisions[index] = { ...routeDecision, replyMessageId: storedAiReply.id, updatedAt: "2026-05-25T00:18:01.000Z" };
      }
    }
    const events = [
      { event: "ready", data: { message } },
      ...(pendingReply ? [{ event: "ready", data: { message, aiReply: pendingReply, aiReplies: [pendingReply] } }] : []),
      ...(aiReply && !state.keepChannelAiReplyPending ? [{ event: "delta", data: { messageId: aiReply.id, delta: aiReply.body, body: aiReply.body } }] : []),
      { event: "done", data: storedAiReply ? { message, aiReply: storedAiReply, aiReplies: [storedAiReply] } : { message } },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(""),
    });
    return;
  }

  const channelMessagesMatch = /^\/channels\/([^/]+)\/messages$/.exec(path);
  if (channelMessagesMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelMessagesMatch[1]);
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
    const limit = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : 200, 1), 500);
    const beforeMessageId = url.searchParams.get("beforeMessageId");
    const threadId = url.searchParams.get("threadId");
    state.channelMessageQueries?.push({
      channelId,
      limit,
      beforeMessageId: beforeMessageId ?? undefined,
      threadId: threadId ?? undefined,
    });
    const messages = state.channelMessages
      .filter((message) =>
        isRecord(message) &&
        message.channelId === channelId &&
        (!threadId || message.threadId === threadId)
      )
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
  const channelRouteDecisionsMatch = /^\/channels\/([^/]+)\/message-route-decisions$/.exec(path);
  if (channelRouteDecisionsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelRouteDecisionsMatch[1]);
    const sourceMessageId = url.searchParams.get("sourceMessageId");
    await route.fulfill({
      json: {
        cwd,
        channelId,
        decisions: state.channelMessageRouteDecisions.filter((decision) =>
          isRecord(decision) &&
          decision.channelId === channelId &&
          (!sourceMessageId || decision.sourceMessageId === sourceMessageId)),
      },
    });
    return;
  }
  const channelIntentDecisionsMatch = /^\/channels\/([^/]+)\/intent-decisions$/.exec(path);
  if (channelIntentDecisionsMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelIntentDecisionsMatch[1]);
    const sourceMessageId = url.searchParams.get("sourceMessageId");
    await route.fulfill({
      json: {
        cwd,
        channelId,
        decisions: state.channelIntentDecisions.filter((decision) =>
          isRecord(decision) &&
          decision.channelId === channelId &&
          (!sourceMessageId || decision.sourceMessageId === sourceMessageId)),
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
      fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs : [],
      linkedTaskId: typeof body.linkedTaskId === "string" ? body.linkedTaskId : undefined,
      linkedRunId: typeof body.linkedRunId === "string" ? body.linkedRunId : undefined,
      status: "ready",
      createdAt: "2026-05-25T00:18:00.000Z",
      updatedAt: "2026-05-25T00:18:00.000Z",
    };
    state.channelMessages.push(message);
    const materializationClarifyReply = maybeCreateMockMaterializationClarifyReply(state, channelId, message);
    if (materializationClarifyReply) {
      await route.fulfill({ status: 201, json: { message, aiReply: materializationClarifyReply } });
      return;
    }
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    const autoReplyMode = isRecord(channel) && typeof channel.autoReplyMode === "string" ? channel.autoReplyMode : "mentions_only";
    const mockWorkflowProposal = body.requestAiReply !== true
      ? maybeCreateMockWorkflowProposal(state, channelId, message, autoReplyMode)
      : undefined;
    if (mockWorkflowProposal) {
      await route.fulfill({ status: 201, json: { message, ...mockWorkflowProposal } });
      return;
    }
    const shouldAutoReply = body.requestAiReply === true ||
      (
        typeof message.body === "string" &&
        message.authorType === "local-user" &&
        message.kind === "message" &&
        message.intent === "discuss" &&
        !message.threadId &&
        (message.body.includes("?") || message.body.includes("？") || isMockContextualFollowUp(message.body)) &&
        (autoReplyMode === "default_teammate" || autoReplyMode === "auto_route")
      );
    const routedTeammateId = body.requestAiReply === true
      ? typeof body.teammateId === "string" ? body.teammateId : "engineer"
      : autoReplyMode === "auto_route" ? "designer" : isRecord(channel) && typeof channel.defaultTeammateId === "string" ? channel.defaultTeammateId : undefined;
    const routeDecision = {
      schemaVersion: 1,
      id: `route_${state.channelMessageRouteDecisions.length + 1}`,
      workspaceId: "workspace_default",
      channelId,
      sourceMessageId: message.id,
      mode: body.requestAiReply === true ? autoReplyMode : autoReplyMode,
      action: shouldAutoReply && routedTeammateId ? "reply" : "no_reply",
      selectedTeammateId: shouldAutoReply ? routedTeammateId : undefined,
      selectedProviderPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : undefined,
      confidence: shouldAutoReply ? 1 : undefined,
      reason: shouldAutoReply ? "Mock route accepted." : "Mock route suppressed.",
      alternativesConsidered: [],
      contextPack: shouldAutoReply
        ? {
            schemaVersion: 1,
            kind: autoReplyMode === "auto_route" ? "auto_route_selector" : "channel_reply",
            providerPresetId: typeof body.providerPresetId === "string" ? body.providerPresetId : undefined,
            modelId: "mock-model",
            sectionIds: autoReplyMode === "auto_route"
              ? ["auto_route_instructions", "channel_collaboration_protocol", "auto_route_source_message", "auto_route_recent_context", "auto_route_candidates"]
              : ["channel_collaboration_protocol", "channel_discussion"],
            droppedSectionIds: [],
            sourceRefCounts: { channel: 1, message: 1 },
            compactionIds: [],
          }
        : undefined,
      status: shouldAutoReply && routedTeammateId ? "accepted" : "suppressed",
      createdBy: body.requestAiReply === true ? "explicit_mention" : autoReplyMode === "auto_route" ? "model" : "deterministic",
      createdAt: "2026-05-25T00:18:00.500Z",
      updatedAt: "2026-05-25T00:18:00.500Z",
    };
    state.channelMessageRouteDecisions.push(routeDecision);
    const aiReply = shouldAutoReply && routedTeammateId
      ? {
          id: `msg_${state.channelMessages.length + 1}`,
          workspaceId: "workspace_default",
          channelId,
          threadId: message.threadId ?? message.id,
          kind: "ai_reply",
          intent: "discuss",
          authorType: "ai-teammate",
          authorId: routedTeammateId,
          body: "AI teammate is preparing a reply...",
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          fileRefs: [],
          status: "pending",
          createdAt: "2026-05-25T00:18:01.000Z",
          updatedAt: "2026-05-25T00:18:01.000Z",
        }
      : undefined;
    if (aiReply) {
      state.channelMessages.push(aiReply);
      const index = state.channelMessageRouteDecisions.findIndex((decision) => isRecord(decision) && decision.id === routeDecision.id);
      if (index !== -1) {
        state.channelMessageRouteDecisions[index] = { ...routeDecision, replyMessageId: aiReply.id, updatedAt: "2026-05-25T00:18:01.000Z" };
      }
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
      shaping: isRecord(body.shaping)
        ? body.shaping
        : {
            status: "ready_for_confirmation",
            summary: typeof body.title === "string" ? body.title : "Proposed task",
            openQuestions: [],
            clarifications: [],
            sourceRefs: typeof body.sourceMessageId === "string" ? [{ type: "message", id: body.sourceMessageId }] : [],
            updatedAt: "2026-05-25T00:18:03.000Z",
          },
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
        shaping: body.shaping === null ? undefined : body.shaping ?? proposal.shaping,
        linkedTaskId: body.linkedTaskId === null ? undefined : body.linkedTaskId ?? proposal.linkedTaskId,
        linkedRunId: body.linkedRunId === null ? undefined : body.linkedRunId ?? proposal.linkedRunId,
        linkedWorkflowId: body.linkedWorkflowId === null ? undefined : body.linkedWorkflowId ?? proposal.linkedWorkflowId,
        errorMessage: body.errorMessage === null ? undefined : body.errorMessage ?? proposal.errorMessage,
        updatedAt: "2026-05-25T00:18:04.000Z",
      };
      return updated;
    });
    await route.fulfill({ status: updated ? 200 : 404, json: updated ? { proposal: updated } : { error: "proposal_not_found" } });
    return;
  }
  const channelProposalWorkflowMatch = /^\/channel-proposals\/([^/]+)\/confirm-workflow$/.exec(path);
  if (channelProposalWorkflowMatch && request.method() === "POST") {
    const proposalId = decodeURIComponent(channelProposalWorkflowMatch[1]);
    const proposal = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === proposalId);
    if (!isRecord(proposal)) {
      await route.fulfill({ status: 404, json: { error: "proposal_not_found" } });
      return;
    }
    const collaborationSteps = Array.isArray(proposal.collaborationSteps) && proposal.collaborationSteps.length > 0
      ? proposal.collaborationSteps.filter(isRecord)
      : [{ teammateId: proposal.assigneeTeammateId, action: "coordinated", summary: "Complete the confirmed execution proposal." }];
    const workflow = {
      id: `workflow_${state.channelWorkflows.length + 1}`,
      workspaceId: "workspace_default",
      channelId: proposal.channelId,
      title: typeof proposal.title === "string" ? proposal.title : "Execution proposal workflow",
      objective: typeof proposal.prompt === "string" ? proposal.prompt : "",
      status: "running",
      createdBy: typeof proposal.proposedByTeammateId === "string" ? proposal.proposedByTeammateId : "local-user",
      metadata: {
        sourceProposalId: proposal.id,
        sourceMessageId: proposal.sourceMessageId,
      },
      createdAt: "2026-05-25T00:32:00.000Z",
      updatedAt: "2026-05-25T00:32:00.000Z",
    };
    const workflowSteps = collaborationSteps.map((step, index) => {
      const teammateId = typeof step.teammateId === "string" ? step.teammateId : String(proposal.assigneeTeammateId ?? "engineer");
      const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
      return {
        id: `workflow_step_${state.channelWorkflowSteps.length + index + 1}`,
        workspaceId: "workspace_default",
        channelId: proposal.channelId,
        workflowId: workflow.id,
        position: index + 1,
        title: `${isRecord(teammate) && typeof teammate.displayName === "string" ? teammate.displayName : teammateId}: ${typeof step.action === "string" ? step.action : "coordinated"}`,
        prompt: typeof step.summary === "string" ? step.summary : String(proposal.prompt ?? ""),
        toParticipantId: teammateId,
        toParticipantLabel: isRecord(teammate) && typeof teammate.displayName === "string" ? teammate.displayName : teammateId,
        status: index === 0 ? "running" : "queued",
        metadata: {
          sourceProposalId: proposal.id,
          sourceMessageId: proposal.sourceMessageId,
          ...(Array.isArray(step.sources) ? { proposalStepSources: step.sources.filter(isRecord) } : {}),
          dependsOnStepIds: index === 0 ? undefined : [`workflow_step_${state.channelWorkflowSteps.length + index}`],
          autoStart: true,
        },
        createdAt: "2026-05-25T00:32:00.000Z",
        updatedAt: "2026-05-25T00:32:00.000Z",
      };
    });
    const updatedProposal = {
      ...proposal,
      status: "accepted",
      linkedWorkflowId: workflow.id,
      linkedTaskId: undefined,
      linkedRunId: undefined,
      shaping: isRecord(proposal.shaping)
        ? { ...proposal.shaping, status: "converted_to_task", updatedAt: "2026-05-25T00:32:00.000Z" }
        : undefined,
      errorMessage: undefined,
      updatedAt: "2026-05-25T00:32:00.000Z",
    };
    state.channelExecutionProposals = state.channelExecutionProposals.map((item) =>
      isRecord(item) && item.id === proposal.id ? updatedProposal : item
    );
    state.channelWorkflows.unshift(workflow);
    state.channelWorkflowSteps.unshift(...workflowSteps);
    await route.fulfill({
      status: 200,
      json: {
        proposal: updatedProposal,
        workflow,
        workflowSteps,
        orchestration: {
          status: workflowSteps.length > 0 ? "started" : "idle",
          workflow,
          workflowStep: workflowSteps[0],
          taskId: workflowSteps[0]?.id ? `task_${workflowSteps[0].id}` : undefined,
          runId: workflowSteps[0]?.id ? `run_${workflowSteps[0].id}` : undefined,
        },
      },
    });
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
  const channelCollaborationCardsMatch = /^\/channels\/([^/]+)\/collaboration-cards$/.exec(path);
  if (channelCollaborationCardsMatch && request.method() === "GET") {
    if (options.collaborationCardsUnsupported) {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
      return;
    }
    const channelId = decodeURIComponent(channelCollaborationCardsMatch[1]);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const cards = state.channelWorkflows
      .filter((workflow) => isRecord(workflow) && workflow.channelId === channelId)
      .map((workflow) => buildMockCollaborationTaskCard(state, workflow))
      .filter((card): card is Record<string, unknown> => Boolean(card))
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 100);
    await route.fulfill({ json: { cwd, channelId, cards } });
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
  const workflowEvidenceMatch = /^\/workflows\/([^/]+)\/evidence$/.exec(path);
  if (workflowEvidenceMatch && request.method() === "GET") {
    const workflowId = decodeURIComponent(workflowEvidenceMatch[1]);
    const workflow = state.channelWorkflows.find((item) => isRecord(item) && item.id === workflowId);
    if (!isRecord(workflow)) {
      await route.fulfill({ status: 404, json: { error: "workflow_not_found" } });
      return;
    }
    await route.fulfill({ json: buildMockWorkflowEvidence(state, workflow) });
    return;
  }
  const workflowCollaborationCardMatch = /^\/workflows\/([^/]+)\/collaboration-card$/.exec(path);
  if (workflowCollaborationCardMatch && request.method() === "GET") {
    if (options.collaborationCardsUnsupported) {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
      return;
    }
    const workflowId = decodeURIComponent(workflowCollaborationCardMatch[1]);
    const workflow = state.channelWorkflows.find((item) => isRecord(item) && item.id === workflowId);
    if (!isRecord(workflow)) {
      await route.fulfill({ status: 404, json: { error: "workflow_not_found" } });
      return;
    }
    await route.fulfill({ json: { cwd, workflowId, card: buildMockCollaborationTaskCard(state, workflow) } });
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
  const attachmentPreviewMatch = /^\/attachments\/([^/]+)\/preview$/.exec(path);
  if (attachmentPreviewMatch && request.method() === "GET") {
    const attachmentId = decodeURIComponent(attachmentPreviewMatch[1]);
    const attachment = findMockAttachmentById(state, attachmentId);
    if (!attachment) {
      await route.fulfill({ status: 404, json: { error: "attachment_not_found" } });
      return;
    }
    const image = typeof attachment.contentType === "string" && attachment.contentType.startsWith("image/");
    await route.fulfill({
      json: {
        ref: {
          id: attachmentId,
          source: "attachment",
          scope: state.conversationAttachments.some((item) => isRecord(item) && item.id === attachmentId)
            ? "conversation"
            : state.teammatePrivateAttachments.some((item) => isRecord(item) && item.id === attachmentId)
              ? "teammate_private"
              : "channel",
          label: typeof attachment.fileName === "string" ? attachment.fileName : attachmentId,
          displayPath: typeof attachment.path === "string" ? attachment.path : undefined,
          contentType: typeof attachment.contentType === "string" ? attachment.contentType : "text/plain; charset=utf-8",
          sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : 0,
          previewable: true,
        },
        kind: image ? "image" : attachment.kind === "json" ? "json" : "plain_text",
        text: image ? undefined : `mock preview for ${String(attachment.fileName ?? attachmentId)}\n`,
        imageUrl: image ? `/attachments/${encodeURIComponent(attachmentId)}/content?cwd=${encodeURIComponent(cwd)}` : undefined,
        truncated: false,
        sizeBytes: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : 0,
        redactionNotes: [],
      },
    });
    return;
  }
  const attachmentMatch = /^\/attachments\/([^/]+)$/.exec(path);
  if (attachmentMatch && request.method() === "DELETE") {
    const attachmentId = decodeURIComponent(attachmentMatch[1]);
    state.channelAttachments = state.channelAttachments.filter((attachment) => !isRecord(attachment) || attachment.id !== attachmentId);
    state.teammatePrivateAttachments = state.teammatePrivateAttachments.filter((attachment) => !isRecord(attachment) || attachment.id !== attachmentId);
    state.conversationAttachments = state.conversationAttachments.filter((attachment) => !isRecord(attachment) || attachment.id !== attachmentId);
    state.aiTeammates = state.aiTeammates.map((teammate) =>
      isRecord(teammate) && teammate.avatarImageAttachmentId === attachmentId ? { ...teammate, avatarImageAttachmentId: undefined } : teammate,
    );
    await route.fulfill({ json: { ok: true } });
    return;
  }
  const channelProposedPlansMatch = /^\/channels\/([^/]+)\/proposed-plans$/.exec(path);
  if (channelProposedPlansMatch && request.method() === "GET") {
    const channelId = decodeURIComponent(channelProposedPlansMatch[1]);
    const scope = url.searchParams.get("scope") ?? "channel";
    const threadId = url.searchParams.get("threadId") ?? undefined;
    const goalId = url.searchParams.get("goalId") ?? undefined;
    const agentId = url.searchParams.get("agentId") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const threadIdsInChannel = new Set(state.threads
      .filter((thread) => thread.channelId === channelId)
      .map((thread) => thread.id));
    const plans = state.proposedPlans
      .filter((plan) => {
        const planChannelId = plan.channelId ?? state.threads.find((thread) => thread.id === plan.threadId)?.channelId;
        if (planChannelId !== channelId && !threadIdsInChannel.has(plan.threadId)) {
          return false;
        }
        if (scope === "thread" && threadId && plan.threadId !== threadId) {
          return false;
        }
        if (goalId && plan.goalId !== goalId) {
          return false;
        }
        if (agentId && plan.ownerAgentId !== agentId && plan.sourceAgentId !== agentId) {
          return false;
        }
        if (status && plan.status !== status) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 100);
    await route.fulfill({ json: { cwd, channelId, plans: plans.map((plan) => hydrateMockProposedPlanSourceState(state, plan)) } });
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
      ? { ...existing, ...createChannelFromBody(body, channelId, existing), id: channelId, updatedAt: "2026-05-25T00:16:00.000Z" }
      : createChannelFromBody(body, channelId);
    state.channels[channelIndex] = channel;
    await route.fulfill({ json: { channel } });
    return;
  }
  if (channelMatch && request.method() === "DELETE") {
    const channelId = decodeURIComponent(channelMatch[1]);
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!isRecord(channel)) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found" } });
      return;
    }
    state.channels = state.channels.filter((item) => !isRecord(item) || item.id !== channelId);
    state.channelBranches = state.channelBranches.filter((item) => !isRecord(item) || item.channelId !== channelId);
    state.channelCouncilPolicies = state.channelCouncilPolicies.filter((item) => !isRecord(item) || item.channelId !== channelId);
    await route.fulfill({ status: 204, body: "" });
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
  if (request.method() === "GET" && path === "/conversations/attachments") {
    const threadId = url.searchParams.get("threadId") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const attachments = state.conversationAttachments
      .filter((attachment): attachment is Record<string, unknown> =>
        isRecord(attachment) && (!threadId || attachment.threadId === threadId)
      )
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 100);
    await route.fulfill({ json: { cwd, threadId, attachments } });
    return;
  }
  if (request.method() === "POST" && path === "/conversations/attachments") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const fileName = typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim() : "upload.txt";
    const inferred = inferMockChannelAttachment(fileName);
    const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
    const threadId = typeof body.threadId === "string" && body.threadId.trim() ? body.threadId.trim() : undefined;
    const attachment = {
      id: `conv_att_${state.conversationAttachments.length + 1}`,
      workspaceId: "workspace_default",
      threadId,
      kind: inferred.kind,
      fileName,
      contentType: typeof body.contentType === "string" && body.contentType.trim() ? body.contentType.trim() : inferred.contentType,
      sizeBytes: contentBase64.length,
      path: `conversations/${threadId ?? "pending"}/${fileName}`,
      createdAt: "2026-05-25T00:18:02.000Z",
    };
    state.conversationAttachments.unshift(attachment);
    await route.fulfill({ status: 201, json: { attachment } });
    return;
  }
  if (request.method() === "POST" && path === "/conversations/stream") {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const providerPresetId = typeof body.providerPresetId === "string" ? body.providerPresetId.trim() : "";
    const provider = state.providers.find((item) => isRecord(item) && item.id === providerPresetId);
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((item): item is string => typeof item === "string")
      : [];
    const conversationAttachments = state.conversationAttachments
      .filter((attachment): attachment is Record<string, unknown> =>
        isRecord(attachment) && typeof attachment.id === "string" && attachmentIds.includes(attachment.id)
      );
    if (!message && conversationAttachments.length === 0) {
      await route.fulfill({ status: 400, json: { error: "message_required", message: "message is required." } });
      return;
    }
    if (!provider) {
      await route.fulfill({ status: 400, json: { error: "provider_not_found", message: "No available chat model is configured." } });
      return;
    }
    const now = new Date(Date.UTC(2026, 4, 25, 1, state.turns.length, 0)).toISOString();
    const requestedThreadId = typeof body.threadId === "string" ? body.threadId : "";
    let thread = requestedThreadId ? state.threads.find((item) => item.id === requestedThreadId && item.kind === "conversation") : undefined;
    const conversationTitle = summarizeMockConversationTitle(message || conversationAttachments.map((attachment) => String(attachment.fileName ?? "attachment")).join(", "));
    if (!thread) {
      thread = {
        id: `thread_conversation_${state.threads.filter((item) => item.kind === "conversation").length + 1}`,
        workspaceId: "workspace_default",
        kind: "conversation",
        teammateId: "ling_agent",
        title: conversationTitle,
        objective: message,
        status: "open",
        createdAt: now,
        updatedAt: now,
        metadata: {
          schemaVersion: 1,
          pendingApprovalCount: 0,
          blockedCount: 0,
          failedAttemptCount: 0,
          artifactCount: 0,
          lastActivityAt: now,
          rebuiltAt: now,
        },
      };
      state.threads.unshift(thread);
    }
    const turnId = `turn_conversation_${state.turns.length + 1}`;
    const runId = `run_conversation_${state.runs.length + 1}`;
    const turn: MockLingTurn = {
      id: turnId,
      workspaceId: "workspace_default",
      threadId: thread.id,
      kind: state.turns.some((item) => item.threadId === thread?.id) ? "manual_followup" : "initial_request",
      status: "succeeded",
      title: conversationTitle,
      userInstruction: message,
      teammateId: "ling_agent",
      activeRunId: undefined,
      lastRunId: runId,
      createdByActor: "local-user",
      createdAt: now,
      updatedAt: now,
    };
    const run: MockRun = {
      id: runId,
      status: "succeeded",
      cwd: typeof body.projectPath === "string" && body.projectPath.trim() ? body.projectPath.trim() : cwd,
      taskId: `conversation:${turnId}`,
      providerPresetId,
      providerName: isRecord(provider) && typeof provider.providerId === "string" ? provider.providerId : "mock-provider",
      providerModel: isRecord(provider) && typeof provider.model === "string" ? provider.model : "mock-model",
      taskSnapshot: { id: `conversation:${turnId}`, title: turn.title, prompt: message },
      providerSnapshot: provider,
      requestSnapshot: { ...body, conversationAttachmentIds: conversationAttachments.map((attachment) => attachment.id) },
      eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
      threadId: thread.id,
      turnId,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      endedAt: now,
    };
    const responseLanguage = body.responseLanguage === "zh-CN" || body.responseLanguage === "en-US"
      ? body.responseLanguage
      : /[\u3400-\u9fff]/u.test(message) ? "zh-CN" : "en-US";
    const attachmentSummary = conversationAttachments.length > 0
      ? ` ${conversationAttachments.map((attachment) => String(attachment.fileName ?? "attachment")).join(", ")}`
      : "";
    const assistantText = responseLanguage === "zh-CN"
      ? `Ling Agent 回复：${message || "已收到附件"}${attachmentSummary}`
      : `Ling Agent response: ${message || "Attachment received"}${attachmentSummary}`;
    const event: MockRunEvent = {
      id: `evt_${runId}_assistant`,
      runId,
      seq: 0,
      ts: now,
      type: "assistant_text_delta",
      data: { text: assistantText },
    };
    state.turns.push(turn);
    state.conversationAttachments = state.conversationAttachments.map((attachment) =>
      isRecord(attachment) && conversationAttachments.some((item) => item.id === attachment.id)
        ? { ...attachment, threadId: thread?.id, turnId }
        : attachment
    );
    const boundConversationAttachments = conversationAttachments.map((attachment) => ({ ...attachment, threadId: thread?.id, turnId }));
    state.runs.unshift(run);
    state.turnRunLinks.push({ turnId, runId, attemptNumber: 1, role: "primary", createdAt: now });
    state.eventsByRun[runId] = [
      event,
      { id: `evt_${runId}_end`, runId, seq: 1, ts: now, type: "run_end", data: { status: "succeeded" } },
    ];
    thread = {
      ...thread,
      status: "succeeded",
      lastRunId: runId,
      updatedAt: now,
      metadata: {
        ...(isRecord(thread.metadata) ? thread.metadata : {}),
        schemaVersion: 1,
        lastTurnId: turnId,
        lastActivityAt: now,
        pendingApprovalCount: 0,
        blockedCount: 0,
        failedAttemptCount: 0,
        artifactCount: 0,
        rebuiltAt: now,
      },
    };
    state.threads = state.threads.map((item) => item.id === thread?.id ? thread as MockLingThread : item);
    const userMessage = createMockConversationUserMessage(state, thread, turn, run, boundConversationAttachments);
    const pendingAssistant = createMockConversationAssistantMessage(thread, turn, run, "", "running", now);
    const assistantMessage = createMockConversationAssistantMessage(thread, turn, run, assistantText, "succeeded", now);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: ready\ndata: ${JSON.stringify({ thread, turn, userMessage, assistantMessage: pendingAssistant, runId })}`,
        `event: run_event\ndata: ${JSON.stringify({ threadId: thread.id, turnId, runId, event, assistantMessage })}`,
        `event: done\ndata: ${JSON.stringify({ thread, turn, run, assistantMessage })}`,
        "",
      ].join("\n\n"),
    });
    return;
  }
  const conversationRouteMatch = /^\/conversations\/([^/]+)$/.exec(path);
  if (request.method() === "GET" && conversationRouteMatch) {
    const threadId = decodeURIComponent(conversationRouteMatch[1]);
    const thread = state.threads.find((item) => item.id === threadId && item.kind === "conversation");
    if (!thread) {
      await route.fulfill({ status: 404, json: { error: "conversation_not_found", message: `Conversation not found: ${threadId}` } });
      return;
    }
    await route.fulfill({ json: buildMockConversationDetail(state, cwd, thread) });
    return;
  }
  if (request.method() === "POST" && path === "/threads") {
    let body: Record<string, unknown> = {};
    try {
      body = request.postDataJSON() as Record<string, unknown>;
    } catch {
      body = {};
    }
    const kind = typeof body.kind === "string" ? body.kind : "channel_discussion";
    if (kind !== "channel_discussion") {
      await route.fulfill({ status: 400, json: { error: "thread_kind_not_supported", message: "Only channel discussion branches can be created from /threads." } });
      return;
    }
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!channelId) {
      await route.fulfill({ status: 400, json: { error: "channel_required", message: "channelId is required." } });
      return;
    }
    const channel = state.channels.find((item) => isRecord(item) && item.id === channelId);
    if (!channel) {
      await route.fulfill({ status: 404, json: { error: "channel_not_found", message: `Channel not found: ${channelId}` } });
      return;
    }
    const existing = state.threads.find((thread) =>
      thread.kind === "channel_discussion" &&
      thread.channelId === channelId &&
      !thread.parentThreadId &&
      !thread.taskId &&
      !thread.teammateId &&
      !thread.workflowId &&
      !thread.workflowStepId &&
      !thread.externalWorkId &&
      !thread.archivedAt &&
      thread.status !== "archived"
    );
    if (existing) {
      await route.fulfill({ status: 200, json: { cwd, thread: mockThreadReadModel(existing) } });
      return;
    }
    const now = "2026-05-25T00:40:00.000Z";
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Main branch";
    const channelName = isRecord(channel) && typeof channel.name === "string" ? channel.name : channelId;
    const objective = typeof body.objective === "string" && body.objective.trim()
      ? body.objective.trim()
      : `Main conversation branch for ${channelName}.`;
    const thread: MockLingThread = {
      id: `thread_channel_main_${channelId}`,
      workspaceId: "workspace_default",
      kind: "channel_discussion",
      channelId,
      title,
      objective,
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: now,
      updatedAt: now,
    };
    state.threads.unshift(thread);
    await route.fulfill({ status: 201, json: { cwd, thread: mockThreadReadModel(thread) } });
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
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50)
      .map(mockThreadReadModel);
    await route.fulfill({
      json: {
        cwd,
        threads,
        ...(search ? { matches: search.matches.filter((match) => threads.some((thread) => thread.id === match.threadId)) } : {}),
      },
    });
    return;
  }

  const proposedPlanRouteMatch = /^\/threads\/([^/]+)\/proposed-plans(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path);
  if (proposedPlanRouteMatch) {
    const threadId = decodeURIComponent(proposedPlanRouteMatch[1]);
    const planId = proposedPlanRouteMatch[2] ? decodeURIComponent(proposedPlanRouteMatch[2]) : undefined;
    const action = proposedPlanRouteMatch[3] ? decodeURIComponent(proposedPlanRouteMatch[3]) : undefined;
    const thread = state.threads.find((item) => item.id === threadId) ?? deriveMockThreadFromRuns(state, threadId);
    if (!thread) {
      await route.fulfill({ status: 404, json: { error: "thread_not_found" } });
      return;
    }
    if (!planId) {
      if (request.method() === "GET") {
        const plans = state.proposedPlans
          .filter((plan) => plan.threadId === threadId)
          .map((plan) => hydrateMockProposedPlanSourceState(state, plan));
        await route.fulfill({ json: { cwd, threadId, plans } });
        return;
      }
      if (request.method() === "POST") {
        const body = readMockPostData(request);
        const plan = upsertMockProposedPlan(state, threadId, undefined, body);
        await route.fulfill({ status: 201, json: { cwd, threadId, plan: hydrateMockProposedPlanSourceState(state, plan) } });
        return;
      }
    }
    if (planId && !action) {
      if (request.method() === "GET") {
        const plan = state.proposedPlans.find((item) => item.id === planId && item.threadId === threadId);
        if (!plan) {
          await route.fulfill({ status: 404, json: { error: "proposed_plan_not_found" } });
          return;
        }
        await route.fulfill({ json: { cwd, threadId, plan: hydrateMockProposedPlanSourceState(state, plan) } });
        return;
      }
      if (request.method() === "PUT") {
        const existing = state.proposedPlans.find((item) => item.id === planId && item.threadId === threadId);
        const body = readMockPostData(request);
        if (mockAcceptedPlanDirectMutationBlocked(existing, body)) {
          await route.fulfill({ status: 409, json: { error: "accepted_plan_immutable" } });
          return;
        }
        const plan = upsertMockProposedPlan(state, threadId, planId, body);
        await route.fulfill({ json: { cwd, threadId, plan: hydrateMockProposedPlanSourceState(state, plan) } });
        return;
      }
      if (request.method() === "PATCH") {
        const existing = state.proposedPlans.find((item) => item.id === planId && item.threadId === threadId);
        if (!existing) {
          await route.fulfill({ status: 404, json: { error: "proposed_plan_not_found" } });
          return;
        }
        const body = readMockPostData(request);
        if (mockAcceptedPlanDirectMutationBlocked(existing, body)) {
          await route.fulfill({ status: 409, json: { error: "accepted_plan_immutable" } });
          return;
        }
        const plan = patchMockProposedPlan(state, existing, body);
        await route.fulfill({ json: { cwd, threadId, plan: hydrateMockProposedPlanSourceState(state, plan) } });
        return;
      }
    }
    if (planId && action && request.method() === "POST") {
      const body = readMockPostData(request);
      const planInput = isRecord(body.plan) ? body.plan : undefined;
      const existing = state.proposedPlans.find((item) => item.id === planId && item.threadId === threadId);
      if (!existing && !planInput) {
        await route.fulfill({ status: 404, json: { error: "proposed_plan_not_found" } });
        return;
      }
      const plan = planInput ? upsertMockProposedPlan(state, threadId, planId, planInput) : existing!;
      const result = applyMockProposedPlanAction(state, thread, plan, action, body);
      await route.fulfill({ json: { cwd, threadId, ...result, plan: hydrateMockProposedPlanSourceState(state, result.plan) } });
      return;
    }
  }

  const goalCompleteRouteMatch = /^\/threads\/([^/]+)\/goal\/complete$/.exec(path);
  if (goalCompleteRouteMatch && request.method() === "POST") {
    const threadId = decodeURIComponent(goalCompleteRouteMatch[1]);
    const existing = state.goals.find((goal) => goal.threadId === threadId && mockActiveGoalStatuses.includes(goal.status));
    if (!existing) {
      await route.fulfill({ status: 404, json: { error: "goal_not_found" } });
      return;
    }
    const body = readMockPostData(request);
    const actor = body.actor === "ling-agent" ? "ling-agent" : "local-user";
    const evidenceRefs = Array.isArray(body.evidenceRefs) ? body.evidenceRefs as LingThreadGoal["completionEvidenceRefs"] : [];
    const summary = readOptionalMockString(body, "completionVerificationSummary");
    if (actor === "ling-agent" && (evidenceRefs.length === 0 || !summary)) {
      await route.fulfill({ status: 400, json: { error: "goal_completion_evidence_required" } });
      return;
    }
    const now = "2026-05-25T00:50:00.000Z";
    const goal = {
      ...existing,
      status: "complete",
      completedAt: now,
      updatedAt: now,
      completedBy: actor,
      completedReason: readOptionalMockString(body, "reason"),
      completionVerificationSummary: summary,
      completionEvidenceRefs: evidenceRefs,
    } satisfies LingThreadGoal;
    state.goals = state.goals.map((item) => item.id === goal.id ? goal : item);
    await route.fulfill({ json: { cwd, threadId, goal } });
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
      await route.fulfill({ json: { cwd, thread: mockThreadReadModel(thread) } });
      return;
    }
    if (action === "mode") {
      if (request.method() === "GET") {
        await route.fulfill({ json: { cwd, threadId, mode: mockThreadReadModel(thread).conversationMode } });
        return;
      }
      if (request.method() === "PATCH") {
        let body: Record<string, unknown> = {};
        try {
          body = request.postDataJSON() as Record<string, unknown>;
        } catch {
          body = {};
        }
        const mode = body.mode === "plan" ? "plan" : body.mode === "default" ? "default" : undefined;
        if (!mode) {
          await route.fulfill({ status: 400, json: { error: "bad_conversation_mode", message: "mode must be one of: default, plan" } });
          return;
        }
        const nextThread = {
          ...mockThreadReadModel(thread),
          conversationMode: { mode, updatedAt: "2026-05-25T00:43:00.000Z" },
          updatedAt: "2026-05-25T00:43:00.000Z",
        } satisfies MockLingThread;
        upsertMockThread(state, nextThread);
        await route.fulfill({ json: { cwd, threadId, mode: nextThread.conversationMode } });
        return;
      }
    }
    if (action === "goal") {
      const activeGoal = () => state.goals.find((goal) => goal.threadId === threadId && mockActiveGoalStatuses.includes(goal.status));
      if (request.method() === "GET") {
        await route.fulfill({ json: { cwd, threadId, goal: activeGoal() ?? null } });
        return;
      }
      if (request.method() === "PUT") {
        const body = readMockPostData(request);
        const objective = typeof body.objective === "string" ? body.objective.trim() : "";
        if (!objective) {
          await route.fulfill({ status: 400, json: { error: "goal_objective_required" } });
          return;
        }
        const existing = activeGoal();
        if (existing && body.replaceExisting !== true) {
          await route.fulfill({ status: 409, json: { error: "goal_replace_required", goal: existing } });
          return;
        }
        const now = "2026-05-25T00:44:00.000Z";
        const id = `goal_${state.goals.length + 1}`;
        if (existing) {
          state.goals = state.goals.map((goal) => goal.id === existing.id
            ? { ...goal, status: "replaced", replacedByGoalId: id, updatedAt: now }
            : goal);
        }
        const goal: LingThreadGoal = {
          id,
          workspaceId: "workspace_default",
          threadId,
          objective,
          status: "active",
          tokenBudget: typeof body.tokenBudget === "number" ? body.tokenBudget : undefined,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
          completionEvidenceRefs: [],
        };
        state.goals.unshift(goal);
        await route.fulfill({ status: existing ? 200 : 201, json: { cwd, threadId, goal } });
        return;
      }
      if (request.method() === "PATCH") {
        const existing = activeGoal();
        if (!existing) {
          await route.fulfill({ status: 404, json: { error: "goal_not_found" } });
          return;
        }
        const body = readMockPostData(request);
        const status = typeof body.status === "string" ? body.status : existing.status;
        if (status === "complete") {
          await route.fulfill({ status: 400, json: { error: "goal_complete_action_required" } });
          return;
        }
        const now = "2026-05-25T00:45:00.000Z";
        const goal = {
          ...existing,
          objective: typeof body.objective === "string" && body.objective.trim() ? body.objective.trim() : existing.objective,
          status,
          tokenBudget: body.tokenBudget === null ? undefined : typeof body.tokenBudget === "number" ? body.tokenBudget : existing.tokenBudget,
          updatedAt: now,
          completedAt: status === "complete" ? now : existing.completedAt,
          clearedAt: status === "cleared" ? now : existing.clearedAt,
          lastRunId: body.lastRunId === null ? undefined : typeof body.lastRunId === "string" ? body.lastRunId : existing.lastRunId,
          blockedReason: body.blockedReason === null ? undefined : typeof body.blockedReason === "string" ? body.blockedReason : existing.blockedReason,
          completionEvidenceRefs: Array.isArray(body.completionEvidenceRefs) ? body.completionEvidenceRefs as LingThreadGoal["completionEvidenceRefs"] : existing.completionEvidenceRefs,
        } satisfies LingThreadGoal;
        state.goals = state.goals.map((item) => item.id === goal.id ? goal : item);
        await route.fulfill({ json: { cwd, threadId, goal } });
        return;
      }
      if (request.method() === "DELETE") {
        const existing = activeGoal();
        if (!existing) {
          await route.fulfill({ json: { cwd, threadId, goal: null } });
          return;
        }
        const now = "2026-05-25T00:46:00.000Z";
        const goal = { ...existing, status: "cleared", clearedAt: now, updatedAt: now } satisfies LingThreadGoal;
        state.goals = state.goals.map((item) => item.id === goal.id ? goal : item);
        await route.fulfill({ json: { cwd, threadId, goal } });
        return;
      }
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
          conversationMode: { mode: "default" },
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
        conversationMode: { mode: "default" },
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
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((item): item is string => typeof item === "string") : [],
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
  if (request.method() === "GET" && path === "/traces") {
    const threadId = url.searchParams.get("threadId");
    const runId = url.searchParams.get("runId");
    const detail = threadId
      ? buildMockThreadTraceDetail(state, threadId)
      : runId ? buildMockRunTraceDetail(state, runId) : undefined;
    if (!detail) {
      await route.fulfill({ status: 404, json: { error: "trace_not_found", message: "Trace source was not found." } });
      return;
    }
    await route.fulfill({ json: { cwd, traces: [detail.trace] } });
    return;
  }
  const traceMatch = /^\/traces\/([^/]+)(?:\/(spans))?$/.exec(path);
  if (traceMatch && request.method() === "GET") {
    const traceId = decodeURIComponent(traceMatch[1]);
    const detail = buildMockTraceDetailForId(state, traceId);
    if (!detail) {
      await route.fulfill({ status: 404, json: { error: "trace_not_found", message: `Trace source was not found: ${traceId}` } });
      return;
    }
    if (traceMatch[2] === "spans") {
      await route.fulfill({ json: { cwd, traceId: detail.trace.id, spans: detail.spans } });
      return;
    }
    await route.fulfill({ json: detail });
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
  if (request.method() === "GET" && path === "/execution-actions") {
    const runId = url.searchParams.get("runId");
    const threadId = url.searchParams.get("threadId");
    const status = url.searchParams.get("status");
    const actionType = url.searchParams.get("actionType");
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const actions = state.executionActions
      .filter((action) =>
        (!runId || action.runId === runId) &&
        (!threadId || action.threadId === threadId) &&
        (!status || action.status === status) &&
        (!actionType || action.actionType === actionType)
      )
      .sort((left, right) =>
        (right.completedAt ?? right.executedAt ?? right.approvedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.executedAt ?? left.approvedAt ?? left.createdAt) ||
        right.id.localeCompare(left.id)
      )
      .slice(0, limit);
    await route.fulfill({ json: { cwd, actions } });
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
    if (state.mediaJobRunDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.mediaJobRunDelayMs));
    }
    const provider = state.providers.find((item) => isRecord(item) && item.id === job.providerPresetId);
    const normalizedProvider = isRecord(provider) ? normalizeMockProviderForGenerationRuntime(provider) : undefined;
    const jobOperation = mockMediaJobOperation(job.operation);
    const runtimeState = normalizedProvider && jobOperation
      ? resolveGenerationProviderRuntimeState(
        normalizedProvider as Parameters<typeof resolveGenerationProviderRuntimeState>[0],
        jobOperation,
      )
      : undefined;
    const canRunGeneration = runtimeState?.canRun === true;
    if (!canRunGeneration) {
      job.status = "failed";
      job.errorMessage = runtimeState?.reason === "base_url_missing"
        ? "生成模型缺少 Base URL，请在模型工作台补充后重试。"
        : runtimeState?.reason === "secret_missing"
          ? "生成模型缺少 API Key，请在模型工作台补充后重试。"
          : "当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。";
      await route.fulfill({
        status: 400,
        json: {
          error: runtimeState?.reason === "base_url_missing" ? "bad_request" : runtimeState?.reason === "secret_missing" ? "secret_missing" : "live_media_transport_required",
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

  const artifactContentMatch = /^\/artifacts\/([^/]+)\/content$/.exec(path);
  if (request.method() === "GET" && artifactContentMatch) {
    const artifact = findMockArtifactById(state, decodeURIComponent(artifactContentMatch[1]));
    if (!artifact) {
      await route.fulfill({ status: 404, json: { error: "artifact_not_found" } });
      return;
    }
    if (artifact.type === "image" || artifact.contentType?.startsWith("image/")) {
      await route.fulfill({
        contentType: artifact.contentType ?? "image/svg+xml",
        body: Buffer.from(mockImageSvg(artifact.title ?? artifact.path ?? artifact.id), "utf8"),
      });
      return;
    }
    await route.fulfill({
      contentType: artifact.contentType ?? "text/plain; charset=utf-8",
      body: artifact.contentText ?? `${artifact.title ?? artifact.path ?? artifact.id}\n`,
    });
    return;
  }

  const artifactPreviewMatch = /^\/artifacts\/([^/]+)\/preview$/.exec(path);
  if (request.method() === "GET" && artifactPreviewMatch) {
    const artifactId = decodeURIComponent(artifactPreviewMatch[1]);
    const artifact = findMockArtifactById(state, artifactId);
    if (!artifact) {
      await route.fulfill({ status: 404, json: { error: "artifact_not_found" } });
      return;
    }
    const image = artifact.type === "image" || artifact.contentType?.startsWith("image/");
    const compare = image && artifact.compareBeforeImageUrl && artifact.compareAfterImageUrl
      ? {
          before: {
            label: artifact.compareBeforeLabel ?? "Before",
            imageUrl: artifact.compareBeforeImageUrl,
          },
          after: {
            label: artifact.compareAfterLabel ?? "After",
            imageUrl: artifact.compareAfterImageUrl,
          },
          defaultMode: "single",
        }
      : undefined;
    await route.fulfill({
      json: {
        ref: {
          id: artifact.id,
          source: "artifact",
          scope: "run",
          label: artifact.title ?? artifact.path ?? artifact.id,
          displayPath: artifact.path,
          contentType: artifact.contentType,
          sizeBytes: artifact.sizeBytes,
          previewable: true,
        },
        kind: image ? "image" : artifact.type === "diff" ? "diff" : artifact.type === "json" ? "json" : "plain_text",
        text: image ? undefined : artifact.contentText ?? `${artifact.title ?? artifact.path ?? artifact.id}\n`,
        imageUrl: image ? `/artifacts/${encodeURIComponent(artifact.id)}/content?cwd=${encodeURIComponent(cwd)}` : undefined,
        compare,
        truncated: false,
        sizeBytes: artifact.sizeBytes,
        redactionNotes: [],
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
    if (approval.mediaJobId && approval.actionType === "media_cost") {
      const mediaJob = state.mediaJobs.find((item) => item.id === approval.mediaJobId);
      if (mediaJob) {
        mediaJob.status = approval.status === "approved" ? "queued" : "failed";
        mediaJob.errorMessage = approval.status === "denied" ? "Media cost approval denied before live media execution." : undefined;
        mediaJob.updatedAt = approval.resolvedAt;
      }
    }
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

function readMockChannelWorkspaceBinding(channel: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(channel.workspaceBinding)) {
    return channel.workspaceBinding;
  }
  const executionPath = typeof channel.boundPath === "string" && channel.boundPath.trim() ? channel.boundPath : cwd;
  return {
    mode: "local",
    status: "ready",
    executionPath,
    updatedAt: typeof channel.updatedAt === "string" ? channel.updatedAt : "2026-05-22T00:00:00.000Z",
  };
}

function buildMockManagedChannelWorktreeBinding(channelId: string, now = "2026-05-25T00:15:00.000Z"): Record<string, unknown> {
  return {
    mode: "managed_worktree",
    status: "ready",
    executionPath: `${cwd}/.ling-stack/worktrees/channels/${channelId}`,
    worktreePath: `${cwd}/.ling-stack/worktrees/channels/${channelId}`,
    branchName: `ling/channel-${channelId}`,
    baseBranch: "main",
    baseCommit: "mock-base-commit",
    createdAt: now,
    updatedAt: now,
    checkedAt: now,
  };
}

function buildMockChannelWorkspaceResponse(
  channelId: string,
  channel: Record<string, unknown>,
  binding: Record<string, unknown>,
): Record<string, unknown> {
  const executionCwd = typeof binding.mode === "string" && binding.mode === "managed_worktree" && typeof binding.worktreePath === "string"
    ? binding.worktreePath
    : typeof binding.executionPath === "string" && binding.executionPath.trim()
      ? binding.executionPath
      : typeof channel.boundPath === "string" && channel.boundPath.trim()
        ? channel.boundPath
        : cwd;
  return {
    cwd,
    channelId,
    binding,
    snapshot: {
      mode: typeof binding.mode === "string" ? binding.mode : "local",
      status: typeof binding.status === "string" ? binding.status : "ready",
      workspaceCwd: cwd,
      executionCwd,
      boundPath: typeof channel.boundPath === "string" ? channel.boundPath : undefined,
      worktreePath: typeof binding.worktreePath === "string" ? binding.worktreePath : undefined,
      branchName: typeof binding.branchName === "string" ? binding.branchName : undefined,
      checkedAt: typeof binding.checkedAt === "string" ? binding.checkedAt : undefined,
    },
  };
}

function buildMockChannelWorkspaceGitStatusResponse(
  channelId: string,
  channel: Record<string, unknown>,
  binding: Record<string, unknown>,
  fixture: WorkspaceGitStatus | MockWorkspaceGitStatusFailure | undefined,
): Record<string, unknown> {
  const workspace = buildMockChannelWorkspaceResponse(channelId, channel, binding);
  const snapshot = workspace.snapshot as Record<string, unknown>;
  const executionCwd = typeof snapshot.executionCwd === "string" ? snapshot.executionCwd : cwd;
  const gitStatus = fixture && !isMockWorkspaceGitStatusFailure(fixture)
    ? {
      ...fixture,
      cwd: fixture.cwd || executionCwd,
      checkedAt: fixture.checkedAt || "2026-06-29T00:00:00.000Z",
    }
    : buildMockCleanWorkspaceGitStatus(executionCwd, binding);
  return {
    ...workspace,
    gitStatus,
  };
}

function buildMockCleanWorkspaceGitStatus(executionCwd: string, binding: Record<string, unknown>): WorkspaceGitStatus {
  return {
    state: "clean",
    cwd: executionCwd,
    repoRoot: executionCwd,
    branchName: typeof binding.branchName === "string" ? binding.branchName : undefined,
    upstream: typeof binding.baseBranch === "string" ? binding.baseBranch : undefined,
    headSha: "mock-head",
    changedFileCount: 0,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    files: [],
    checkedAt: "2026-06-29T00:00:00.000Z",
  };
}

function isMockWorkspaceGitStatusFailure(value: unknown): value is MockWorkspaceGitStatusFailure {
  return isRecord(value) && value.fail === true;
}

function readMockDirectWorkspaceBinding(thread: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(thread.workspaceBinding)) {
    return thread.workspaceBinding;
  }
  return {
    mode: "managed_worktree",
    status: "not_created",
    updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : "2026-05-29T00:09:30.000Z",
  };
}

function buildMockManagedDirectWorktreeBinding(teammateId: string, threadId: string, now = "2026-06-04T00:16:30.000Z"): Record<string, unknown> {
  return {
    mode: "managed_worktree",
    status: "ready",
    executionPath: `${cwd}/.ling-stack/worktrees/teammates/${teammateId}/${threadId}`,
    worktreePath: `${cwd}/.ling-stack/worktrees/teammates/${teammateId}/${threadId}`,
    branchName: `ling/teammate-${teammateId}-${threadId}`,
    baseBranch: "main",
    baseCommit: "mock-base-commit",
    createdAt: now,
    updatedAt: now,
    checkedAt: now,
  };
}

function buildMockDirectWorkspaceResponse(
  teammateId: string,
  thread: Record<string, unknown>,
  binding: Record<string, unknown>,
): Record<string, unknown> {
  const threadId = typeof thread.id === "string" ? thread.id : `tdthread_${teammateId}`;
  const executionCwd = typeof binding.mode === "string" && binding.mode === "managed_worktree" && typeof binding.worktreePath === "string"
    ? binding.worktreePath
    : typeof binding.executionPath === "string" && binding.executionPath.trim()
      ? binding.executionPath
      : cwd;
  return {
    cwd,
    teammateId,
    threadId,
    binding,
    snapshot: {
      mode: typeof binding.mode === "string" ? binding.mode : "managed_worktree",
      status: typeof binding.status === "string" ? binding.status : "not_created",
      workspaceCwd: cwd,
      executionCwd,
      worktreePath: typeof binding.worktreePath === "string" ? binding.worktreePath : undefined,
      branchName: typeof binding.branchName === "string" ? binding.branchName : undefined,
      baseBranch: typeof binding.baseBranch === "string" ? binding.baseBranch : undefined,
      baseCommit: typeof binding.baseCommit === "string" ? binding.baseCommit : undefined,
      checkedAt: typeof binding.checkedAt === "string" ? binding.checkedAt : undefined,
    },
  };
}

function normalizeMockFileRef(value: Record<string, unknown>): {
  path: string;
  label?: string;
  rootRelation: string;
  kind: string;
  materializationStatus: string;
  previewText?: string;
  blockedReason?: string;
} {
  const path = typeof value.path === "string" && value.path.trim() ? value.path.trim() : "unknown";
  return {
    path,
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined,
    rootRelation: typeof value.rootRelation === "string" ? value.rootRelation : "workspace",
    kind: typeof value.kind === "string" ? value.kind : "file",
    materializationStatus: typeof value.materializationStatus === "string" ? value.materializationStatus : "available",
    previewText: typeof value.previewText === "string" ? value.previewText : undefined,
    blockedReason: typeof value.blockedReason === "string" ? value.blockedReason : undefined,
  };
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

function buildMockDirectReplyBody(state: MockState, attachmentIds: readonly unknown[]): string {
  const imageAttachment = attachmentIds
    .filter((attachmentId): attachmentId is string => typeof attachmentId === "string")
    .map((attachmentId) => state.teammatePrivateAttachments.find((item) => isRecord(item) && item.id === attachmentId))
    .find((attachment): attachment is Record<string, unknown> => isRecord(attachment) && attachment.kind === "image");
  if (imageAttachment) {
    const fileName = typeof imageAttachment.fileName === "string" ? imageAttachment.fileName : "image";
    return `Private reply: I can see the image attachment ${fileName}.`;
  }
  return "Private reply: I will refine this into a scoped task.";
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

export function buildMockTeammateDirectRuntime(
  state: MockState,
  teammateId: string,
  thread: Record<string, unknown>,
): Record<string, unknown> {
  const threadId = typeof thread.id === "string" ? thread.id : `tdthread_${teammateId}`;
  const activeWorkUnit = state.workUnits.find((unit) =>
    unit.kind === "teammate_direct_reply" &&
    (unit.teammateId === teammateId || unit.ownerId === teammateId) &&
    isActiveMockWorkUnit(unit.status)
  );
  const message = activeWorkUnit?.linkedMessageId
    ? state.teammateDirectMessages.find((item) => isRecord(item) && item.id === activeWorkUnit.linkedMessageId)
    : undefined;
  const request = isRecord(activeWorkUnit?.request) ? activeWorkUnit.request : {};
  const activeReply = activeWorkUnit
    ? {
        status: activeWorkUnit.status === "cancelling" ? "cancelling" : "running",
        workUnitId: activeWorkUnit.id,
        messageId: typeof activeWorkUnit.linkedMessageId === "string" ? activeWorkUnit.linkedMessageId : "",
        sourceMessageId: typeof request.sourceMessageId === "string"
          ? request.sourceMessageId
          : typeof activeWorkUnit.linkedMessageId === "string"
            ? activeWorkUnit.linkedMessageId
            : "",
        workUnit: activeWorkUnit,
        ...(isRecord(message) ? { message } : {}),
      }
    : undefined;
  return {
    cwd,
    teammateId,
    thread,
    ...(activeReply ? { activeReply } : {}),
    interventions: listOpenMockTeammateDirectInterventions(state, teammateId, threadId),
  };
}

export function listOpenMockTeammateDirectInterventions(
  state: MockState,
  teammateId: string,
  threadId: string,
): MockTeammateDirectIntervention[] {
  return state.teammateDirectInterventions.filter((item) =>
    item.teammateId === teammateId &&
    item.threadId === threadId &&
    (item.status === "queued" || item.status === "cancelling_source" || item.status === "starting_continuation")
  );
}

function buildMockWorkflowEvidence(state: MockState, workflow: Record<string, unknown>): Record<string, unknown> {
  const workflowId = readString(workflow, "id");
  const steps = state.channelWorkflowSteps
    .filter((step) => isRecord(step) && step.workflowId === workflowId)
    .sort((left, right) => readNumber(left, "position") - readNumber(right, "position") || readString(left, "createdAt").localeCompare(readString(right, "createdAt")));
  const stepRunIds = new Set(steps.map((step) => readString(step, "runId")).filter(Boolean));
  const artifacts = Object.entries(state.artifactsByRun)
    .filter(([runId]) => stepRunIds.has(runId))
    .flatMap(([, runArtifacts]) => runArtifacts);
  const actions = state.executionActions.filter((action) => action.runId ? stepRunIds.has(action.runId) : false);
  const approvals = state.approvals.filter((approval) => {
    const approvalRecord = approval as unknown as Record<string, unknown>;
    return steps.some((step) => approval.runId === readString(step, "runId") || readString(approvalRecord, "workflowStepId") === readString(step, "id"));
  });
  const approvalIds = new Set(approvals.map((approval) => approval.id));
  const workflowStepIds = new Set(steps.map((step) => readString(step, "id")).filter(Boolean));
  return {
    workflow,
    steps: steps.map((step) => {
      const runId = readString(step, "runId");
      return {
        step,
        contextInspect: buildMockWorkflowContextInspect(workflow, step),
        packetArtifacts: [],
        linkedArtifacts: runId ? state.artifactsByRun[runId] ?? [] : [],
        diagnostics: [],
      };
    }),
    selectorDecisions: state.channelMessageRouteDecisions.filter((decision) => isRecord(decision) && decision.workflowId === workflowId),
    handoffIntents: state.workflowHandoffIntents.filter((intent) => intent.workflowId === workflowId),
    handoffs: state.channelHandoffs.filter((handoff) => isRecord(handoff) && handoff.workflowId === workflowId),
    approvals,
    approvalCheckpoints: state.approvalCheckpoints.filter((checkpoint) =>
      approvalIds.has(checkpoint.approvalId) ||
      (checkpoint.workflowStepId !== undefined && workflowStepIds.has(checkpoint.workflowStepId))
    ),
    actions,
    artifacts,
    memoryCandidates: [],
  };
}

function findMockArtifactById(state: MockState, artifactId: string): MockArtifact | undefined {
  return [
    ...Object.values(state.artifactsByRun).flat(),
    ...Object.values(state.artifactsByMediaJob).flat(),
    ...Object.values(state.artifactsByExternalAction).flat(),
  ].find((artifact) => artifact.id === artifactId);
}

function mockImageSvg(label: string): string {
  const escapedLabel = label
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" fill="#f5f5f5"/>
  <rect x="1" y="1" width="318" height="178" fill="none" stroke="#d4d4d4"/>
  <text x="160" y="92" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="16" fill="#525252">${escapedLabel}</text>
</svg>`;
}

function buildMockWorkflowContextInspect(workflow: Record<string, unknown>, step: Record<string, unknown>): Record<string, unknown> {
  const contextArtifactId = readNestedString(step.metadata, ["contextArtifactId"]);
  if (!contextArtifactId) {
    return {
      schemaVersion: 1,
      availability: "missing_context_artifact",
      sectionCount: 0,
      sourceRefCount: 0,
      droppedSectionCount: 0,
      compactionCount: 0,
      sections: [],
      droppedSectionIds: [],
      compactionIds: [],
      sourceRefs: [],
      safety: {
        rawPromptTextIncluded: false,
        rawLogsIncluded: false,
        rawArtifactBodiesIncluded: false,
      },
    };
  }
  const stepId = readString(step, "id");
  const workflowId = readString(workflow, "id");
  const providerPresetId = readNestedString(step.metadata, ["providerPresetId"]) || "provider_local";
  return {
    schemaVersion: 1,
    availability: "available",
    contextArtifactId,
    generatedAt: readString(step, "updatedAt") || "2026-05-25T00:40:00.000Z",
    kind: "workflow_step",
    providerPresetId,
    modelId: "mock-model",
    budget: {
      mode: "model_estimated",
      inputBudgetTokens: 116000,
      estimatedInputTokens: 1200,
      overBudget: false,
      tokenizer: "heuristic_chars_v1",
    },
    sectionCount: 2,
    sourceRefCount: 2,
    droppedSectionCount: 1,
    compactionCount: 1,
    sections: [
      {
        id: "workflow_runtime_boundary",
        role: "system",
        priority: "critical",
        estimatedTokens: 220,
        sourceRefIds: [`workflow:${workflowId}`],
        metadataKeys: ["boundary"],
      },
      {
        id: "workflow_step_objective",
        role: "user",
        priority: "high",
        estimatedTokens: 180,
        sourceRefIds: [`workflow_step:${stepId}`],
        metadataKeys: ["stepId"],
      },
    ],
    droppedSectionIds: ["old_verbose_log_tail"],
    compactionIds: ["context_condenser_text_mock"],
    sourceRefs: [
      { type: "workflow", id: workflowId, label: readString(workflow, "title") || "Workflow" },
      { type: "workflow_step", id: stepId, label: readString(step, "title") || "Workflow step" },
    ],
    safety: {
      rawPromptTextIncluded: false,
      rawLogsIncluded: false,
      rawArtifactBodiesIncluded: false,
    },
  };
}

function buildMockCollaborationTaskCard(state: MockState, workflow: Record<string, unknown>): Record<string, unknown> | undefined {
  const workflowId = typeof workflow.id === "string" ? workflow.id : "";
  if (!workflowId) {
    return undefined;
  }
  const steps = state.channelWorkflowSteps
    .filter((step) => isRecord(step) && step.workflowId === workflowId)
    .sort((left, right) => readNumber(left, "position") - readNumber(right, "position") || readString(left, "createdAt").localeCompare(readString(right, "createdAt")));
  if (steps.length === 0) {
    return undefined;
  }
  const stepIds = new Set(steps.map((step) => readString(step, "id")).filter(Boolean));
  const stepRunIds = new Set(steps.map((step) => readString(step, "runId")).filter(Boolean));
  const pendingApprovals = state.approvals.filter((approval) => {
    if (approval.status !== "pending") {
      return false;
    }
    const approvalRecord = approval as unknown as Record<string, unknown>;
    const workflowStepId = readString(approvalRecord, "workflowStepId");
    return (approval.runId ? stepRunIds.has(approval.runId) : false) || (workflowStepId ? stepIds.has(workflowStepId) : false);
  });
  const blockedStep = steps.find((step) => readString(step, "status") === "blocked");
  const failedStep = steps.find((step) => readString(step, "status") === "failed");
  const waitingStep = steps.find((step) => readString(step, "status") === "waiting_for_approval");
  const activeStep = steps.find((step) => readString(step, "status") === "running" || readString(step, "status") === "claimed");
  const queuedStep = steps.find((step) => readString(step, "status") === "queued");
  const focusStep = blockedStep ?? failedStep ?? waitingStep ?? activeStep ?? queuedStep;
  const cardSteps = steps.map((step) => ({
	    id: readString(step, "id"),
	    title: readString(step, "title"),
	    ownerLabel: readString(step, "toParticipantLabel"),
	    state: mockCollaborationStepState(readString(step, "status")),
	    summary: mockCollaborationStepSummary(step),
	    branchGroupId: readNestedString(step.metadata, ["branchGroupId"]),
	    joinGroupId: readNestedString(step.metadata, ["joinGroupId"]),
	    updatedAt: readString(step, "updatedAt"),
  }));
  const executionMode = mockCollaborationExecutionMode(steps);
  const completedStepCount = steps.filter((step) => readString(step, "status") === "succeeded" || readString(step, "status") === "skipped").length;
  const mode = mockCollaborationCardMode(readString(workflow, "status"), steps, pendingApprovals.length);
  return {
    id: `collaboration-task-card:${workflowId}`,
    workflowId,
    title: readOptionalString(workflow, "daemonCardTitle") ?? readString(workflow, "title"),
    objective: readOptionalString(workflow, "daemonCardObjective") ?? readString(workflow, "objective"),
    mode,
    executionMode,
    currentOwnerLabel: focusStep ? readString(focusStep, "toParticipantLabel") : undefined,
    blocker: readOptionalString(blockedStep, "blocker") ?? readOptionalString(failedStep, "blocker"),
    nextAction: mockCollaborationNextAction(mode, focusStep ? readString(focusStep, "status") : "", pendingApprovals.length),
    completedStepCount,
    totalStepCount: steps.length,
    pendingApprovalCount: pendingApprovals.length,
    steps: cardSteps,
    branches: buildMockCollaborationBranches(cardSteps, executionMode),
    updatedAt: readString(workflow, "updatedAt"),
  };
}

function buildMockCollaborationBranches(
  steps: readonly Record<string, unknown>[],
  executionMode: string,
): readonly Record<string, unknown>[] {
  if (executionMode === "serial") {
    return [];
  }
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const step of steps) {
    const joinGroupId = readOptionalString(step, "joinGroupId");
    const branchGroupId = readOptionalString(step, "branchGroupId");
    if (joinGroupId && !branchGroupId) {
      continue;
    }
    const groupId = branchGroupId ?? readString(step, "id");
    groups.set(groupId, [...(groups.get(groupId) ?? []), step]);
  }
  return [...groups.entries()].map(([groupId, groupSteps], index) => {
    const ownerLabels = [...new Set(groupSteps.map((step) => readString(step, "ownerLabel")).filter(Boolean))];
    const completedStepCount = groupSteps.filter((step) => readString(step, "state") === "done").length;
    const focusStep =
      groupSteps.find((step) => readString(step, "state") === "blocked") ??
      groupSteps.find((step) => readString(step, "state") === "failed") ??
      groupSteps.find((step) => readString(step, "state") === "active") ??
      groupSteps.find((step) => readString(step, "state") === "waiting" || readString(step, "state") === "queued") ??
      groupSteps.at(-1);
    return {
      id: `branch:${groupId}`,
      label: ownerLabels.length > 0 ? `${ownerLabels.slice(0, 2).join(", ")} branch` : `Branch ${index + 1}`,
      state: mockCollaborationBranchState(groupSteps),
      summary: readOptionalString(focusStep, "summary") ?? readOptionalString(focusStep, "title"),
      completedStepCount,
      totalStepCount: groupSteps.length,
      ownerLabels,
      steps: groupSteps,
    };
  });
}

function mockCollaborationCardMode(workflowStatus: string, steps: readonly Record<string, unknown>[], pendingApprovalCount: number): string {
  if (workflowStatus === "cancelled") {
    return "cancelled";
  }
  if (workflowStatus === "succeeded") {
    return "completed";
  }
  if (workflowStatus === "failed" || steps.some((step) => readString(step, "status") === "failed")) {
    return "failed";
  }
  if (workflowStatus === "blocked" || steps.some((step) => readString(step, "status") === "blocked")) {
    return "blocked";
  }
  if (workflowStatus === "waiting_for_approval" || pendingApprovalCount > 0 || steps.some((step) => readString(step, "status") === "waiting_for_approval")) {
    return "waiting";
  }
  if (workflowStatus === "draft" || workflowStatus === "ready") {
    return "ready_for_confirmation";
  }
  return "running";
}

function mockCollaborationExecutionMode(steps: readonly Record<string, unknown>[]): string {
  const hasParallelMetadata = steps.some((step) => Boolean(readNestedString(step.metadata, ["branchGroupId"]) || readNestedString(step.metadata, ["joinGroupId"]) || readNestedNumber(step.metadata, ["maxParallelSiblings"])));
  const runningCount = steps.filter((step) => readString(step, "status") === "running" || readString(step, "status") === "claimed").length;
  const hasDependencies = steps.some((step) => Array.isArray(isRecord(step.metadata) ? step.metadata.dependsOnStepIds : undefined));
  if (hasParallelMetadata && hasDependencies) {
    return "mixed";
  }
  if (hasParallelMetadata || runningCount > 1) {
    return "parallel";
  }
  return "serial";
}

function mockCollaborationStepState(status: string): string {
  if (status === "succeeded" || status === "skipped") {
    return "done";
  }
  if (status === "running" || status === "claimed") {
    return "active";
  }
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "blocked" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "queued";
}

function mockCollaborationStepSummary(step: Record<string, unknown>): string | undefined {
  const resultSummary = readOptionalString(step, "resultSummary")?.trim();
  if (resultSummary) {
    return resultSummary;
  }
  const blocker = readOptionalString(step, "blocker")?.trim();
  if (blocker) {
    return blocker;
  }
  return semanticMockPromptSummary(readString(step, "prompt"));
}

function semanticMockPromptSummary(prompt: string): string | undefined {
  const stepSummaryMatch = /(?:^|\n)Step summary:\s*\n([\s\S]*?)(?=\n\n[A-Z][^:\n]{0,80}:\s*\n|$)/u.exec(prompt);
  const extracted = stepSummaryMatch?.[1]?.trim();
  if (extracted) {
    return truncateMockPreview(extracted, 120);
  }
  const trimmed = prompt.trim();
  if (!trimmed || isStructuredMockWorkflowPrompt(trimmed)) {
    return undefined;
  }
  return truncateMockPreview(trimmed, 120);
}

function isStructuredMockWorkflowPrompt(prompt: string): boolean {
  return /\bConfirmed proposal:\b/u.test(prompt) ||
    /\bOverall scope:\b/u.test(prompt) ||
    /\bAssigned teammate:\b/u.test(prompt) ||
    /\bStep action:\b/u.test(prompt) ||
    /\bAcceptance criteria:\b/u.test(prompt) ||
    /\bComplete only this step\./u.test(prompt) ||
    /\bruntime permission\b/iu.test(prompt);
}

function mockCollaborationBranchState(steps: readonly Record<string, unknown>[]): string {
  if (steps.some((step) => readString(step, "state") === "blocked")) {
    return "blocked";
  }
  if (steps.some((step) => readString(step, "state") === "failed")) {
    return "failed";
  }
  if (steps.some((step) => readString(step, "state") === "active")) {
    return "active";
  }
  if (steps.some((step) => readString(step, "state") === "waiting")) {
    return "waiting";
  }
  if (steps.some((step) => readString(step, "state") === "queued")) {
    return "queued";
  }
  if (steps.every((step) => readString(step, "state") === "done")) {
    return "done";
  }
  return "waiting";
}

function mockCollaborationNextAction(mode: string, stepStatus: string, pendingApprovalCount: number): string | undefined {
  if (pendingApprovalCount > 0) {
    return "Review approval request";
  }
  if (mode === "blocked" || stepStatus === "blocked") {
    return "Resolve blocker";
  }
  if (mode === "failed" || stepStatus === "failed") {
    return "Review failed step";
  }
  if (mode === "ready_for_confirmation") {
    return "Start task";
  }
  if (stepStatus === "running" || stepStatus === "claimed") {
    return "Waiting for agent result";
  }
  return undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readOptionalString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function readNestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "number" ? current : undefined;
}

function truncateMockPreview(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isMemoryObject(value: unknown): value is MemoryObject {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.scopeType === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    Array.isArray(value.tags) &&
    Array.isArray(value.sourceRefs) &&
    typeof value.reviewState === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.sensitivity === "string" &&
    typeof value.verifyBeforeUse === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function isGovernanceNotification(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    isRecord(value.surface) &&
    typeof value.kind === "string" &&
    typeof value.severity === "string" &&
    typeof value.status === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string";
}

function governanceNotificationMatchesQuery(notification: Record<string, unknown>, params: URLSearchParams): boolean {
  const surface = isRecord(notification.surface) ? notification.surface : {};
  const requestedSurface = params.get("surface");
  const requestedChannelId = params.get("channelId");
  const requestedTeammateId = params.get("teammateId");
  const requestedThreadId = params.get("threadId");
  const requestedKind = params.get("kind");
  const requestedStatus = params.get("status");
  const includeResolved = params.get("includeResolved") === "true";
  const includeDismissed = params.get("includeDismissed") === "true";

  if (requestedSurface && surface.kind !== requestedSurface) {
    return false;
  }
  if (requestedChannelId && surface.channelId !== requestedChannelId) {
    return false;
  }
  if (requestedTeammateId && surface.teammateId !== requestedTeammateId) {
    return false;
  }
  if (requestedThreadId && surface.threadId !== requestedThreadId) {
    return false;
  }
  if (requestedKind && notification.kind !== requestedKind) {
    return false;
  }
  if (requestedStatus && notification.status !== requestedStatus) {
    return false;
  }
  if (!includeResolved && notification.status === "resolved") {
    return false;
  }
  if (!includeDismissed && notification.status === "dismissed") {
    return false;
  }
  return true;
}

function buildGovernanceNotificationSummary(values: readonly unknown[]): Record<string, unknown> {
  const notifications = values.filter(isGovernanceNotification);
  const buckets = new Map<string, Record<string, unknown>>();
  for (const notification of notifications) {
    const surface = isRecord(notification.surface) ? notification.surface : { kind: "workspace" };
    const surfaceKey = JSON.stringify(surface);
    const existing = buckets.get(surfaceKey) ?? {
      surface,
      total: 0,
      unread: 0,
      seen: 0,
      dismissed: 0,
      resolved: 0,
      pendingDelivery: 0,
      bySeverity: {},
      byKind: {},
      latestUpdatedAt: undefined,
    };
    existing.total = Number(existing.total) + 1;
    existing.unread = Number(existing.unread) + (notification.status === "unread" ? 1 : 0);
    existing.seen = Number(existing.seen) + (notification.status === "seen" ? 1 : 0);
    existing.dismissed = Number(existing.dismissed) + (notification.status === "dismissed" ? 1 : 0);
    existing.resolved = Number(existing.resolved) + (notification.status === "resolved" ? 1 : 0);
    existing.pendingDelivery = Number(existing.pendingDelivery) + (notification.deliveryStatus === "pending" ? 1 : 0);
    incrementCountMap(existing.bySeverity, String(notification.severity));
    incrementCountMap(existing.byKind, String(notification.kind));
    if (typeof notification.updatedAt === "string" && (!existing.latestUpdatedAt || notification.updatedAt > String(existing.latestUpdatedAt))) {
      existing.latestUpdatedAt = notification.updatedAt;
    }
    buckets.set(surfaceKey, existing);
  }

  return {
    workspaceId: "workspace_default",
    generatedAt: "2026-05-25T00:30:00.000Z",
    total: notifications.length,
    actionable: notifications.filter((notification) => notification.status !== "dismissed" && notification.status !== "resolved").length,
    unread: notifications.filter((notification) => notification.status === "unread").length,
    pendingDelivery: notifications.filter((notification) => notification.deliveryStatus === "pending").length,
    bySurface: [...buckets.values()],
  };
}

function incrementCountMap(value: unknown, key: string): void {
  if (!isRecord(value)) {
    return;
  }
  value[key] = Number(value[key] ?? 0) + 1;
}

const mockActiveGoalStatuses: readonly string[] = ["active", "paused", "blocked", "usage_limited", "budget_limited"];

function hydrateMockProposedPlanSourceState(state: MockState, plan: ProposedPlanArtifact): ProposedPlanArtifact {
  if (!plan.sourceMessageId) {
    return plan;
  }
  const sourceMessage = state.channelMessages.find((message) => isRecord(message) && message.id === plan.sourceMessageId);
  return {
    ...plan,
    sourceMessageState: isRecord(sourceMessage) && (!plan.channelId || sourceMessage.channelId === plan.channelId)
      ? "available"
      : "deleted",
  };
}

function upsertMockProposedPlan(
  state: MockState,
  threadId: string,
  forcedPlanId: string | undefined,
  body: Record<string, unknown>,
): ProposedPlanArtifact {
  const now = "2026-05-25T00:47:00.000Z";
  const id = forcedPlanId || (typeof body.id === "string" && body.id.trim() ? body.id.trim() : `proposed_plan_${state.proposedPlans.length + 1}`);
  const existing = state.proposedPlans.find((plan) => plan.id === id);
  const thread = state.threads.find((item) => item.id === threadId);
  const activeGoal = state.goals.find((goal) => goal.threadId === threadId && mockActiveGoalStatuses.includes(goal.status));
  const plan: ProposedPlanArtifact = {
    id,
    workspaceId: "workspace_default",
    threadId,
    channelId: readNullableMockString(body, "channelId", existing?.channelId) ?? thread?.channelId,
    goalId: readNullableMockString(body, "goalId", existing?.goalId) ?? activeGoal?.id,
    sourceAgentId: readNullableMockString(body, "sourceAgentId", existing?.sourceAgentId),
    ownerAgentId: readNullableMockString(body, "ownerAgentId", existing?.ownerAgentId),
    sourceTurnId: readOptionalMockString(body, "sourceTurnId") ?? existing?.sourceTurnId,
    sourceMessageId: readOptionalMockString(body, "sourceMessageId") ?? existing?.sourceMessageId,
    sourceRunId: readOptionalMockString(body, "sourceRunId") ?? existing?.sourceRunId,
    parentPlanId: readNullableMockString(body, "parentPlanId", existing?.parentPlanId),
    supersededByPlanId: readNullableMockString(body, "supersededByPlanId", existing?.supersededByPlanId),
    planGroupId: readNullableMockString(body, "planGroupId", existing?.planGroupId) ?? id,
    version: typeof body.version === "number" && Number.isFinite(body.version) ? body.version : existing?.version ?? 1,
    title: readOptionalMockString(body, "title") ?? existing?.title ?? "Proposed plan",
    bodyMarkdown: readOptionalMockString(body, "bodyMarkdown") ?? existing?.bodyMarkdown ?? "Plan body",
    status: readMockProposedPlanStatus(body.status) ?? existing?.status ?? "draft",
    savedAt: existing?.savedAt,
    acceptedAt: existing?.acceptedAt,
    convertedAt: existing?.convertedAt,
    archivedAt: existing?.archivedAt,
    archivedReason: existing?.archivedReason,
    acceptedTaskId: existing?.acceptedTaskId,
    acceptedWorkflowId: existing?.acceptedWorkflowId,
    acceptedWorkflowStepId: existing?.acceptedWorkflowStepId,
    acceptedRunId: existing?.acceptedRunId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  state.proposedPlans = existing
    ? state.proposedPlans.map((item) => item.id === id ? plan : item)
    : [plan, ...state.proposedPlans];
  return plan;
}

function patchMockProposedPlan(
  state: MockState,
  existing: ProposedPlanArtifact,
  body: Record<string, unknown>,
): ProposedPlanArtifact {
  const now = "2026-05-25T00:48:00.000Z";
  const plan: ProposedPlanArtifact = {
    ...existing,
    channelId: readNullableMockString(body, "channelId", existing.channelId),
    goalId: readNullableMockString(body, "goalId", existing.goalId),
    sourceAgentId: readNullableMockString(body, "sourceAgentId", existing.sourceAgentId),
    ownerAgentId: readNullableMockString(body, "ownerAgentId", existing.ownerAgentId),
    sourceTurnId: readNullableMockString(body, "sourceTurnId", existing.sourceTurnId),
    sourceMessageId: readNullableMockString(body, "sourceMessageId", existing.sourceMessageId),
    sourceRunId: readNullableMockString(body, "sourceRunId", existing.sourceRunId),
    parentPlanId: readNullableMockString(body, "parentPlanId", existing.parentPlanId),
    supersededByPlanId: readNullableMockString(body, "supersededByPlanId", existing.supersededByPlanId),
    planGroupId: readNullableMockString(body, "planGroupId", existing.planGroupId),
    version: typeof body.version === "number" && Number.isFinite(body.version) ? body.version : existing.version,
    title: readOptionalMockString(body, "title") ?? existing.title,
    bodyMarkdown: readOptionalMockString(body, "bodyMarkdown") ?? existing.bodyMarkdown,
    status: readMockProposedPlanStatus(body.status) ?? existing.status,
    savedAt: readNullableMockString(body, "savedAt", existing.savedAt),
    acceptedAt: readNullableMockString(body, "acceptedAt", existing.acceptedAt),
    convertedAt: readNullableMockString(body, "convertedAt", existing.convertedAt),
    archivedAt: readNullableMockString(body, "archivedAt", existing.archivedAt),
    archivedReason: readNullableMockString(body, "archivedReason", existing.archivedReason),
    acceptedTaskId: readNullableMockString(body, "acceptedTaskId", existing.acceptedTaskId),
    acceptedWorkflowId: readNullableMockString(body, "acceptedWorkflowId", existing.acceptedWorkflowId),
    acceptedWorkflowStepId: readNullableMockString(body, "acceptedWorkflowStepId", existing.acceptedWorkflowStepId),
    acceptedRunId: readNullableMockString(body, "acceptedRunId", existing.acceptedRunId),
    updatedAt: now,
  };
  state.proposedPlans = state.proposedPlans.map((item) => item.id === plan.id ? plan : item);
  return plan;
}

function applyMockProposedPlanAction(
  state: MockState,
  thread: MockLingThread,
  plan: ProposedPlanArtifact,
  action: string,
  body: Record<string, unknown>,
): { readonly plan: ProposedPlanArtifact; readonly taskId?: string; readonly workflowId?: string; readonly workflowStepId?: string } {
  const now = "2026-05-25T00:49:00.000Z";
  if (action === "save") {
    return { plan: patchMockProposedPlan(state, plan, { savedAt: now }) };
  }
  if (action === "archive") {
    return { plan: patchMockProposedPlan(state, plan, { status: "archived", archivedAt: now, archivedReason: readOptionalMockString(body, "reason") }) };
  }
  if (action === "refine") {
    return { plan: patchMockProposedPlan(state, plan, { status: "draft" }) };
  }
  if (action === "accept") {
    if (plan.acceptedTaskId) {
      return { plan, taskId: plan.acceptedTaskId };
    }
    const taskId = `task_proposed_plan_${state.tasks.length + 1}`;
    state.tasks.unshift({
      id: taskId,
      workspaceId: "workspace_default",
      channelId: thread.channelId ?? "channel_engineering",
      title: `Implement accepted plan: ${plan.title}`,
      prompt: `${plan.bodyMarkdown}\n\nSource proposed plan: ${plan.id}`,
      status: "todo",
      requestedSkillId: "plan-acceptance",
      attachmentIds: [],
      createdAt: now,
      updatedAt: now,
    });
    return {
      plan: patchMockProposedPlan(state, plan, {
        status: "accepted",
        acceptedAt: now,
        acceptedTaskId: taskId,
      }),
      taskId,
    };
  }
  if (action === "convert-workflow") {
    if (plan.acceptedWorkflowId) {
      return { plan, workflowId: plan.acceptedWorkflowId, workflowStepId: plan.acceptedWorkflowStepId };
    }
    const workflowId = `workflow_proposed_plan_${state.channelWorkflows.length + 1}`;
    const channelId = thread.channelId ?? "channel_engineering";
    const workflowTitle = readOptionalMockString(body, "workflowTitle") ?? plan.title;
    const workflowStepPreviews = readOptionalMockWorkflowStepPreviews(body, "workflowStepPreviews");
    const workflowSteps = readOptionalMockStringArray(body, "workflowSteps") ?? workflowStepPreviews?.map((preview) => preview.title) ?? [plan.bodyMarkdown];
    state.channelWorkflows.unshift({
      id: workflowId,
      workspaceId: "workspace_default",
      channelId,
      title: workflowTitle,
      objective: workflowSteps.join("\n"),
      status: "draft",
      createdBy: readOptionalMockString(body, "createdBy") ?? "local-user",
      metadata: { sourceMessageId: plan.sourceMessageId },
      createdAt: now,
      updatedAt: now,
    });
    const workflowStepRecords = workflowSteps.map((step, index) => {
      const preview = workflowStepPreviews?.[index];
      return {
        id: `workflow_step_proposed_plan_${state.channelWorkflowSteps.length + index + 1}`,
        workspaceId: "workspace_default",
        channelId,
        workflowId,
        position: index + 1,
        title: workflowSteps.length > 1 ? step : `Implement ${workflowTitle}`,
        prompt: `${step}\n\nSource proposed plan: ${plan.id}`,
        toParticipantId: preview?.ownerId ?? readOptionalMockString(body, "toParticipantId") ?? "local-user",
        toParticipantLabel: preview?.ownerLabel ?? readOptionalMockString(body, "toParticipantLabel") ?? "Unassigned",
        status: "queued",
        metadata: { sourceMessageId: plan.sourceMessageId },
        createdAt: now,
        updatedAt: now,
      };
    });
    state.channelWorkflowSteps.unshift(...workflowStepRecords);
    const firstWorkflowStep = workflowStepRecords[0];
    return {
      plan: patchMockProposedPlan(state, plan, {
        status: "accepted",
        acceptedAt: plan.acceptedAt ?? now,
        convertedAt: now,
        acceptedWorkflowId: workflowId,
        acceptedWorkflowStepId: firstWorkflowStep?.id,
      }),
      workflowId,
      workflowStepId: firstWorkflowStep?.id,
    };
  }
  return { plan };
}

function mockAcceptedPlanDirectMutationBlocked(existing: ProposedPlanArtifact | undefined, body: Record<string, unknown>): boolean {
  if (!existing || existing.status !== "accepted") {
    return false;
  }
  if ("title" in body || "bodyMarkdown" in body) {
    return true;
  }
  if ("status" in body && body.status !== "accepted") {
    return true;
  }
  return false;
}

function readOptionalMockString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNullableMockString(record: Record<string, unknown>, key: string, fallback: string | undefined): string | undefined {
  if (!(key in record)) {
    return fallback;
  }
  const value = record[key];
  if (value === null) {
    return undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readOptionalMockStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function readOptionalMockWorkflowStepPreviews(
  record: Record<string, unknown>,
  key: string,
): readonly { readonly title: string; readonly ownerId?: string; readonly ownerLabel?: string }[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const previews = value
    .map((item) => {
      if (!isRecord(item)) {
        return undefined;
      }
      const title = readOptionalMockString(item, "title");
      if (!title) {
        return undefined;
      }
      return {
        title,
        ownerId: readOptionalMockString(item, "ownerId"),
        ownerLabel: readOptionalMockString(item, "ownerLabel"),
      };
    })
    .filter((item): item is { readonly title: string; readonly ownerId?: string; readonly ownerLabel?: string } => Boolean(item));
  return previews.length > 0 ? previews : undefined;
}

function readMockProposedPlanStatus(value: unknown): ProposedPlanArtifact["status"] | undefined {
  return value === "draft" || value === "accepted" || value === "superseded" || value === "archived" ? value : undefined;
}

function readMockPostData(request: Request): Record<string, unknown> {
  try {
    const value = request.postDataJSON();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
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
