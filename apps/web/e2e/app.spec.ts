import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { buildEffectiveTeammateSkills } from "@ling-stack/core";
import { gstackDefaultSkillPack } from "@ling-stack/core/builtin-skill-packs";

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
  providerSecrets: Record<string, string>;
  mcpServers: MockMcpServer[];
  mcpTools: MockMcpTool[];
  mcpServerSecrets: Record<string, Record<string, string>>;
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
  workUnits: MockWorkUnit[];
  workUnitActionDelayMs?: number;
  runtimeSemaphoreSlots: MockRuntimeSemaphoreSlot[];
  runtimeEventsByWorkUnit: Record<string, MockRuntimeEvent[]>;
  workUnitAttemptsByWorkUnit: Record<string, MockWorkUnitAttempt[]>;
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
  workUnitId?: string;
  parentRunId?: string;
  interventionId?: string;
  continuationReason?: string;
  summaryPath?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface MockRunIntervention {
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
  externalWorkId?: string;
  type: string;
  path: string;
  title?: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt: string;
}

interface MockExternalWorkAction {
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

interface MockExternalWorkCiTriageRecord {
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

interface MockExternalWorkCiTriageView {
  triage: MockExternalWorkCiTriageRecord;
  externalWork?: Record<string, unknown>;
  task?: unknown;
  run?: MockRun;
  artifacts: MockArtifact[];
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

interface MockWorkUnit {
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

interface MockWorkUnitAttempt {
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

interface MockRuntimeEvent {
  id: string;
  workUnitId: string;
  attemptId?: string;
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: unknown;
}

interface MockRuntimeSemaphoreSlot {
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

interface MockMcpServer {
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

interface MockMcpTool {
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

interface MockTeammateMcpBinding {
  teammateId: string;
  serverId: string;
  mode: "selected" | "all_current_tools";
  selectedToolNames: string[];
  approvalOverrides: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

test("workspace opens as a task workbench with task context in the inspector", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Workspace task toolbar")).toBeVisible();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const sidePanel = page.locator(".channel-side-panel");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(sidePanel).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});

test("channel drawers match the accepted HTML layout", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_drawer_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");
  await expect(page.locator(".channel-left-drawer .sidebar-row.selected")).toContainText("Engineering");
  await expect(page.getByLabel("Channel message feed").getByText("No channel messages yet")).toBeVisible();
  await expect(page.locator(".channel-attention-popover")).toHaveCount(0);
  await page.locator(".task-toolbar-attention").click();
  await expect(page.locator(".channel-attention-popover")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Progress");
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await page.mouse.move(640, 120);
  await page.waitForTimeout(200);

  const expanded = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const leftToolbar = document.querySelector(".channel-sidebar-toolbar");
    const rightDrawer = document.querySelector(".channel-side-panel");
    const header = document.querySelector(".task-workbench-header");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const activityShell = document.querySelector(".activity-shell");
    const activityMain = document.querySelector(".activity-chat-main");
    const workbenchMain = document.querySelector(".task-workbench-main");
    const workbenchWindow = document.querySelector(".task-workbench-window");
    const workspace = document.querySelector(".workspace");
    const composer = document.querySelector(".channel-composer");
    const feed = document.querySelector(".message-feed");
    const emptyState = document.querySelector(".message-feed-empty-state");
    const selectedChannel = document.querySelector(".channel-left-drawer .sidebar-row.selected");
    const selectedChannelBefore = selectedChannel ? getComputedStyle(selectedChannel, "::before") : undefined;
    const primaryNav = document.querySelector(".channel-left-drawer .primary-nav");
    const drawerSections = Array.from(document.querySelectorAll(".channel-left-drawer .sidebar-section"));
    const firstSection = drawerSections[0];
    const teammateSection = drawerSections[1];
    const firstSectionTitle = firstSection?.querySelector(".sidebar-section-title");
    const teammateSectionTitle = teammateSection?.querySelector(".sidebar-section-title");
    const teammateRows = Array.from(teammateSection?.querySelectorAll(".sidebar-row") ?? []);
    const teammateFirstRow = teammateSection?.querySelector(".sidebar-row");
    const teammateSecondRow = teammateRows[1];
    const sidebarAction = firstSection?.querySelector(".sidebar-section-action");
    const sidebarActionSvg = sidebarAction?.querySelector("svg");
    const sidebarSwitchSvg = document.querySelector(".channel-sidebar-switch svg");
    const titleIcon = document.querySelector(".channel-title-icon");
    const channelMoreButton = document.querySelector(".channel-more-button");
    const toolbarButton = document.querySelector(".task-toolbar-attention");
    const toolbarButtonSvg = toolbarButton?.querySelector("svg");
    const sidebarSwitch = document.querySelector(".channel-sidebar-switch");
    const toolbarCount = toolbarButton?.querySelector(".toolbar-count");
    const sidePanelActions = document.querySelector(".channel-side-panel-actions");
    const sidebarBottom = document.querySelector(".channel-left-drawer .sidebar-bottom");
    const approvals = document.querySelector(".channel-left-drawer .sidebar-inbox-alert");
    const settings = document.querySelector(".channel-left-drawer .config-button");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const feedRect = feed?.getBoundingClientRect();
    const emptyStateRect = emptyState?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      leftToolbarWidth: Math.round(leftToolbar?.getBoundingClientRect().width ?? 0),
      selectedChannelText: selectedChannel?.textContent?.trim() ?? "",
      selectedChannelBackground: selectedChannel ? getComputedStyle(selectedChannel).backgroundColor : "",
      selectedChannelBeforeContent: selectedChannelBefore?.content ?? "",
      primaryNavBorderBottom: primaryNav ? getComputedStyle(primaryNav).borderBottomWidth : "",
      primaryNavSectionGap: primaryNav && firstSectionTitle
        ? Math.round(firstSectionTitle.getBoundingClientRect().top - primaryNav.getBoundingClientRect().bottom)
        : -1,
      teammateTitleListGap: teammateSectionTitle && teammateFirstRow
        ? Math.round(teammateFirstRow.getBoundingClientRect().top - teammateSectionTitle.getBoundingClientRect().bottom)
        : -1,
      teammateRowGap: teammateFirstRow && teammateSecondRow
        ? Math.round(teammateSecondRow.getBoundingClientRect().top - teammateFirstRow.getBoundingClientRect().bottom)
        : -1,
      sectionTitleColor: firstSectionTitle ? getComputedStyle(firstSectionTitle).color : "",
      sectionTitleFontSize: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontSize : "",
      sectionTitleFontWeight: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontWeight : "",
      sidebarActionWidth: Math.round(sidebarAction?.getBoundingClientRect().width ?? 0),
      sidebarActionHeight: Math.round(sidebarAction?.getBoundingClientRect().height ?? 0),
      sidebarActionColor: sidebarAction ? getComputedStyle(sidebarAction).color : "",
      sidebarActionSvgStroke: sidebarActionSvg ? getComputedStyle(sidebarActionSvg).strokeWidth : "",
      sidebarSwitchBorderWidth: sidebarSwitch ? getComputedStyle(sidebarSwitch).borderTopWidth : "",
      sidebarSwitchColor: sidebarSwitch ? getComputedStyle(sidebarSwitch).color : "",
      sidebarSwitchSvgWidth: Math.round(sidebarSwitchSvg?.getBoundingClientRect().width ?? 0),
      sidebarSwitchSvgHeight: Math.round(sidebarSwitchSvg?.getBoundingClientRect().height ?? 0),
      sidebarSwitchSvgStroke: sidebarSwitchSvg ? getComputedStyle(sidebarSwitchSvg).strokeWidth : "",
      titleIconText: titleIcon?.textContent?.trim() ?? "",
      titleIconBorderWidth: titleIcon ? getComputedStyle(titleIcon).borderTopWidth : "",
      titleIconColor: titleIcon ? getComputedStyle(titleIcon).color : "",
      titleIconFontSize: titleIcon ? getComputedStyle(titleIcon).fontSize : "",
      titleIconFontWeight: titleIcon ? getComputedStyle(titleIcon).fontWeight : "",
      titleIconWidth: Math.round(titleIcon?.getBoundingClientRect().width ?? 0),
      titleIconHeight: Math.round(titleIcon?.getBoundingClientRect().height ?? 0),
      channelMoreButtonColor: channelMoreButton ? getComputedStyle(channelMoreButton).color : "",
      channelMoreButtonBorderWidth: channelMoreButton ? getComputedStyle(channelMoreButton).borderTopWidth : "",
      channelMoreButtonWidth: Math.round(channelMoreButton?.getBoundingClientRect().width ?? 0),
      toolbarButtonBorderWidth: toolbarButton ? getComputedStyle(toolbarButton).borderTopWidth : "",
      toolbarButtonColor: toolbarButton ? getComputedStyle(toolbarButton).color : "",
      toolbarButtonWidth: Math.round(toolbarButton?.getBoundingClientRect().width ?? 0),
      toolbarButtonSvgWidth: Math.round(toolbarButtonSvg?.getBoundingClientRect().width ?? 0),
      toolbarButtonSvgHeight: Math.round(toolbarButtonSvg?.getBoundingClientRect().height ?? 0),
      toolbarButtonSvgStroke: toolbarButtonSvg ? getComputedStyle(toolbarButtonSvg).strokeWidth : "",
      toolbarCountText: toolbarCount?.textContent?.trim() ?? "",
      selectedChannelMentionText: selectedChannel?.querySelector(".channel-mention")?.textContent?.trim() ?? "",
      selectedChannelUnreadCount: selectedChannel?.querySelectorAll(".channel-unread").length ?? 0,
      channelMentionCount: document.querySelectorAll(".channel-left-drawer .sidebar-section:first-of-type .channel-mention").length,
      selectedChannelHashText: selectedChannel?.querySelector(".sidebar-hash")?.textContent?.trim() ?? "",
      teammateAvatarCount: document.querySelectorAll(".channel-left-drawer .sidebar-section .avatar-initial").length,
      teammateNotificationCount: Array.from(document.querySelectorAll(".channel-left-drawer .sidebar-row")).filter((row) =>
        row.querySelector(".avatar-initial") && (
          row.querySelector(".channel-mention") ||
          row.querySelector(".channel-unread") ||
          row.querySelector(".status-dot")
        )
      ).length,
      rightY: Math.round(rightDrawer?.getBoundingClientRect().y ?? -1),
      rightHeight: Math.round(rightDrawer?.getBoundingClientRect().height ?? 0),
      viewportHeight: window.innerHeight,
      headerRight: Math.round(header?.getBoundingClientRect().right ?? 0),
      rightLeft: Math.round(rightDrawer?.getBoundingClientRect().left ?? 0),
      sidePanelActions: document.querySelectorAll(".channel-side-panel-actions .icon-button").length,
      sidePanelActionsOpacity: sidePanelActions ? getComputedStyle(sidePanelActions).opacity : "",
      sidePanelActionsVisibility: sidePanelActions ? getComputedStyle(sidePanelActions).visibility : "",
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      composerCenterDelta: chatPanelRect && composerRect ? Math.round((composerRect.left + composerRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      chatPanelWidth: Math.round(chatPanelRect?.width ?? 0),
      chatWidth: Math.round(chatRect?.width ?? 0),
      composerWidth: Math.round(composerRect?.width ?? 0),
      workspaceHeight: Math.round(workspace?.getBoundingClientRect().height ?? 0),
      workbenchWindowHeight: Math.round(workbenchWindow?.getBoundingClientRect().height ?? 0),
      workbenchMainHeight: Math.round(workbenchMain?.getBoundingClientRect().height ?? 0),
      chatPanelHeight: Math.round(chatPanelRect?.height ?? 0),
      activityShellHeight: Math.round(activityShell?.getBoundingClientRect().height ?? 0),
      chatHeight: Math.round(chatRect?.height ?? 0),
      activityMainHeight: Math.round(activityMain?.getBoundingClientRect().height ?? 0),
      emptyStateText: emptyState?.textContent?.trim() ?? "",
      emptyStateCenterDelta: feedRect && emptyStateRect
        ? Math.round((emptyStateRect.top + emptyStateRect.height / 2) - (feedRect.top + feedRect.height / 2))
        : 999,
      emptyStateIconCount: emptyState?.querySelectorAll("svg").length ?? 0,
      composerBottomGap: chatPanelRect && composerRect ? Math.round(chatPanelRect.bottom - composerRect.bottom) : 999,
      feedHeight: Math.round(feedRect?.height ?? 0),
      feedBottomComposerGap: feedRect && composerRect ? Math.round(composerRect.top - feedRect.bottom) : 999,
      sidebarBottomDisplay: sidebarBottom ? getComputedStyle(sidebarBottom).display : "",
      sidebarBottomBorderTop: sidebarBottom ? getComputedStyle(sidebarBottom).borderTopWidth : "",
      approvalsText: approvals?.textContent?.trim() ?? "",
      approvalsHeight: Math.round(approvals?.getBoundingClientRect().height ?? 0),
      approvalsColumns: approvals ? getComputedStyle(approvals).gridTemplateColumns : "",
      settingsText: settings?.textContent?.trim() ?? "",
      settingsHeight: Math.round(settings?.getBoundingClientRect().height ?? 0),
      settingsColumns: settings ? getComputedStyle(settings).gridTemplateColumns : "",
      globalRightPanels: document.querySelectorAll(".right-panel").length,
    };
  });
  expect(expanded.columns.startsWith("232px ")).toBe(true);
  expect(expanded.leftWidth).toBe(232);
  expect(expanded.leftToolbarWidth).toBe(232);
  expect(expanded.selectedChannelText).toContain("Engineering");
  expect(expanded.selectedChannelBackground).toBe("rgb(245, 245, 245)");
  expect(expanded.selectedChannelBeforeContent).toBe("none");
  expect(expanded.primaryNavBorderBottom).toBe("0px");
  expect(expanded.primaryNavSectionGap).toBeLessThanOrEqual(16);
  expect(expanded.teammateTitleListGap).toBeLessThanOrEqual(6);
  expect(expanded.teammateRowGap).toBeLessThanOrEqual(6);
  expect(expanded.sectionTitleColor).toBe("rgb(107, 107, 107)");
  expect(expanded.sectionTitleFontSize).toBe("12px");
  expect(expanded.sectionTitleFontWeight).toBe("500");
  expect(expanded.sidebarActionWidth).toBe(20);
  expect(expanded.sidebarActionHeight).toBe(20);
  expect(expanded.sidebarActionColor).toBe("rgb(17, 17, 17)");
  expect(expanded.sidebarActionSvgStroke).toBe("2.4px");
  expect(expanded.sidebarSwitchBorderWidth).toBe("0px");
  expect(expanded.sidebarSwitchColor).toBe("rgb(17, 17, 17)");
  expect(expanded.sidebarSwitchSvgWidth).toBe(18);
  expect(expanded.sidebarSwitchSvgHeight).toBe(18);
  expect(expanded.sidebarSwitchSvgStroke).toBe("2.4px");
  expect(expanded.titleIconText).toBe("#");
  expect(expanded.titleIconBorderWidth).toBe("0px");
  expect(expanded.titleIconColor).toBe("rgb(17, 17, 17)");
  expect(expanded.titleIconFontSize).toBe("18px");
  expect(expanded.titleIconFontWeight).toBe("600");
  expect(expanded.titleIconWidth).toBe(30);
  expect(expanded.titleIconHeight).toBe(30);
  expect(expanded.channelMoreButtonColor).toBe("rgb(17, 17, 17)");
  expect(expanded.channelMoreButtonBorderWidth).toBe("0px");
  expect(expanded.channelMoreButtonWidth).toBe(30);
  expect(expanded.toolbarButtonBorderWidth).toBe("0px");
  expect(expanded.toolbarButtonColor).toBe("rgb(17, 17, 17)");
  expect(expanded.toolbarButtonWidth).toBe(34);
  expect(expanded.toolbarButtonSvgWidth).toBe(18);
  expect(expanded.toolbarButtonSvgHeight).toBe(18);
  expect(expanded.toolbarButtonSvgStroke).toBe("2.4px");
  expect(expanded.toolbarCountText).toBe("");
  expect(expanded.selectedChannelHashText).toBe("#");
  expect(expanded.selectedChannelMentionText).toBe("");
  expect(expanded.selectedChannelUnreadCount).toBe(0);
  expect(expanded.channelMentionCount).toBe(0);
  expect(expanded.teammateAvatarCount).toBeGreaterThan(0);
  expect(expanded.teammateNotificationCount).toBe(0);
  expect(expanded.rightY).toBe(0);
  expect(expanded.rightHeight).toBe(expanded.viewportHeight);
  expect(expanded.headerRight).toBeLessThanOrEqual(expanded.rightLeft);
  expect(expanded.sidePanelActions).toBe(2);
  expect(Number(expanded.sidePanelActionsOpacity)).toBeLessThanOrEqual(0.05);
  expect(expanded.sidePanelActionsVisibility).toBe("hidden");
  expect(Math.abs(expanded.chatCenterDelta)).toBeLessThanOrEqual(1);
  expect(Math.abs(expanded.composerCenterDelta)).toBeLessThanOrEqual(1);
  expect(expanded.chatPanelWidth - expanded.chatWidth).toBe(48);
  expect(expanded.composerWidth).toBe(expanded.chatWidth);
  expect(expanded.emptyStateText).toBe("No channel messages yet");
  expect(expanded.emptyStateIconCount).toBe(1);
  expect(Math.abs(expanded.emptyStateCenterDelta)).toBeLessThanOrEqual(2);
  expect(expanded.composerBottomGap).toBeLessThanOrEqual(18);
  expect(expanded.feedHeight).toBeGreaterThan(300);
  expect(expanded.feedBottomComposerGap).toBe(0);
  expect(expanded.sidebarBottomDisplay).toBe("grid");
  expect(expanded.sidebarBottomBorderTop).toBe("1px");
  expect(expanded.approvalsText).toContain("pending approvals");
  expect(expanded.approvalsHeight).toBe(38);
  expect(expanded.approvalsColumns.startsWith("24px ")).toBe(true);
  expect(expanded.settingsText).toBe("Settings");
  expect(expanded.settingsHeight).toBe(38);
  expect(expanded.settingsColumns.startsWith("24px ")).toBe(true);
  expect(expanded.globalRightPanels).toBe(0);

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.mouse.move(640, 120);
  await page.waitForTimeout(200);
  const leftCollapsed = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const leftToolbar = document.querySelector(".channel-sidebar-toolbar");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftX: Math.round(leftDrawer?.getBoundingClientRect().x ?? 0),
      leftOpacity: leftDrawer ? getComputedStyle(leftDrawer).opacity : "",
      toolbarWidth: Math.round(leftToolbar?.getBoundingClientRect().width ?? 0),
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      composerCenterDelta: chatPanelRect && composerRect ? Math.round((composerRect.left + composerRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
    };
  });
  expect(leftCollapsed.columns.startsWith("48px ")).toBe(true);
  expect(leftCollapsed.leftX).toBe(-184);
  expect(leftCollapsed.leftOpacity).toBe("0");
  expect(leftCollapsed.toolbarWidth).toBe(48);
  expect(Math.abs(leftCollapsed.chatCenterDelta)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftCollapsed.composerCenterDelta)).toBeLessThanOrEqual(1);

  await page.mouse.move(22, 22);
  await page.waitForTimeout(200);
  const leftPeek = await page.evaluate(() => {
    const leftDrawer = document.querySelector(".channel-left-drawer");
    return {
      leftX: Math.round(leftDrawer?.getBoundingClientRect().x ?? -999),
      leftOpacity: leftDrawer ? getComputedStyle(leftDrawer).opacity : "",
    };
  });
  expect(leftPeek.leftX).toBe(0);
  expect(leftPeek.leftOpacity).toBe("1");
  await page.mouse.move(640, 120);
  await page.waitForTimeout(200);

  await page.getByRole("button", { name: "Hide details" }).click();
  await page.waitForTimeout(200);
  const rightCollapsed = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const main = document.querySelector(".task-workbench-main");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const attention = document.querySelector(".channel-attention-popover");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      sidePanelCount: document.querySelectorAll(".channel-side-panel").length,
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      composerCenterDelta: chatPanelRect && composerRect ? Math.round((composerRect.left + composerRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      chatTransform: chat ? getComputedStyle(chat).transform : "",
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      attentionCount: document.querySelectorAll(".channel-attention-popover").length,
      attentionTop: Math.round(attention?.getBoundingClientRect().top ?? 0),
      chatLeft: Math.round(chatRect?.left ?? 0),
      attentionLeft: Math.round(attention?.getBoundingClientRect().left ?? 0),
      composerRight: Math.round(composerRect?.right ?? 0),
      composerAttentionGap: composerRect && attention
        ? Math.round(attention.getBoundingClientRect().left - composerRect.right)
        : 0,
      composerAttentionOverlapX: composerRect && attention
        ? Math.max(0, Math.round(Math.min(composerRect.right, attention.getBoundingClientRect().right) - Math.max(composerRect.left, attention.getBoundingClientRect().left)))
        : 0,
    };
  });
  expect(rightCollapsed.columns.startsWith("48px ")).toBe(true);
  expect(rightCollapsed.sidePanelCount).toBe(0);
  expect(rightCollapsed.mainPaddingRight).toBe("0px");
  expect(rightCollapsed.chatTransform).toBe("none");
  expect(rightCollapsed.composerTransform).toBe("none");
  expect(rightCollapsed.attentionCount).toBe(0);
  expect(rightCollapsed.chatLeft).toBeGreaterThanOrEqual(70);
  expect(rightCollapsed.composerAttentionOverlapX).toBe(0);

  await page.getByRole("button", { name: "Show details" }).click();
  await page.getByRole("button", { name: "Show navigation" }).click();
  await page.waitForTimeout(200);
  await expect(page.locator(".channel-side-panel")).toHaveCount(1);
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Progress");
  const restored = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const chatPanel = document.querySelector(".channel-chat-panel");
    const chat = document.querySelector(".activity-chat-layout");
    const chatPanelRect = chatPanel?.getBoundingClientRect();
    const chatRect = chat?.getBoundingClientRect();
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      sidePanelCount: document.querySelectorAll(".channel-side-panel").length,
      chatCenterDelta: chatPanelRect && chatRect ? Math.round((chatRect.left + chatRect.width / 2) - (chatPanelRect.left + chatPanelRect.width / 2)) : 999,
      attentionCount: document.querySelectorAll(".channel-attention-popover").length,
    };
  });
  expect(restored.columns.startsWith("232px ")).toBe(true);
  expect(restored.leftWidth).toBe(232);
  expect(restored.sidePanelCount).toBe(1);
  expect(Math.abs(restored.chatCenterDelta)).toBeLessThanOrEqual(1);
  expect(restored.attentionCount).toBe(0);
});

test("channel drawer does not flash legacy create labels in section headers", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const drawer = page.locator(".channel-left-drawer");
  await expect(drawer.getByRole("button", { name: "New channel" })).toBeVisible();
  await expect(drawer.locator(".sidebar-section-title small")).toHaveCount(0);
  await expect(drawer.getByText("Create", { exact: true })).toHaveCount(0);
  await expect(drawer.locator(".sidebar-section:first-of-type .sidebar-section-action")).toHaveText("");
});

test("channel drawer uses unread dots instead of count badges and clears on channel open", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels.push({
    id: "channel_research",
    workspaceId: "workspace_default",
    name: "Research",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  });
  state.approvals.push({
    id: "approval_research",
    channelId: "channel_research",
    actionType: "channel_message",
    risk: "low",
    title: "Review new channel note",
    description: "Unread channel item",
    payload: { type: "channel_message" },
    status: "pending",
    createdAt: "2026-05-22T00:02:00.000Z",
    expiresAt: "2099-01-01T00:01:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  const drawer = page.locator(".channel-left-drawer");
  const engineering = drawer.locator(".sidebar-row").filter({ hasText: "Engineering" });
  const research = drawer.locator(".sidebar-row").filter({ hasText: "Research" });
  await expect(engineering.locator(".channel-mention")).toHaveCount(0);
  await expect(engineering.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator(".channel-mention")).toHaveCount(0);
  await expect(research.locator(".channel-unread")).toBeVisible();

  await research.click();
  await expect(research).toHaveClass(/selected/);
  await expect(research.locator(".channel-unread")).toHaveCount(0);
});

test("wide channel attention popover keeps the accepted HTML spacing", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1140 });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_attention_layout",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Kick off the attention layout discussion.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.waitForTimeout(200);

  const spacing = await page.evaluate(() => {
    const main = document.querySelector(".task-workbench-main");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const attention = document.querySelector(".channel-attention-popover");
    const composerRect = composer?.getBoundingClientRect();
    const attentionRect = attention?.getBoundingClientRect();
    return {
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      chatWidth: Math.round(chat?.getBoundingClientRect().width ?? 0),
      composerWidth: Math.round(composerRect?.width ?? 0),
      attentionWidth: Math.round(attentionRect?.width ?? 0),
      chatTransform: chat ? getComputedStyle(chat).transform : "",
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      gap: composerRect && attentionRect ? Math.round(attentionRect.left - composerRect.right) : -1,
      overlapX: composerRect && attentionRect
        ? Math.max(0, Math.round(Math.min(composerRect.right, attentionRect.right) - Math.max(composerRect.left, attentionRect.left)))
        : -1,
    };
  });
  expect(spacing.mainPaddingRight).toBe("0px");
  expect(spacing.chatWidth).toBe(960);
  expect(spacing.composerWidth).toBe(960);
  expect(spacing.attentionWidth).toBe(390);
  expect(spacing.chatTransform).not.toBe("none");
  expect(spacing.composerTransform).not.toBe("none");
  expect(spacing.gap).toBeGreaterThanOrEqual(48);
  expect(spacing.gap).toBeLessThanOrEqual(80);
  expect(spacing.overlapX).toBe(0);
});

test("workspace task detail panel stays bounded without growing the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.eventsByRun.run_failed = createVerboseRunEvents("run_failed");
  await mockDaemon(page, state);
  await page.goto("/");
  await openTaskFromAttentionQueue(page, "Inspect workspace");

  await expect(page.locator(".workbench-task-list")).toHaveCount(0);
  await expect(page.locator("article.task-detail .client-task-kicker")).toHaveCount(0);
  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Channel management")).toBeVisible();
  const metrics = await page.evaluate(() => {
    const sidePanel = document.querySelector(".channel-side-panel");
    const taskDetail = document.querySelector("article.task-detail");
    return {
      viewportHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      sidePanelHeight: sidePanel?.getBoundingClientRect().height ?? 0,
      taskDetailHeight: taskDetail?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 2);
  expect(metrics.sidePanelHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.taskDetailHeight).toBeLessThanOrEqual(metrics.sidePanelHeight);
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

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByText("active channel")).toHaveCount(0);
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Channel management").getByLabel("Default AI teammate")).toHaveValue("engineer");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("region", { name: "New channel" });
  await expect(createChannelPanel).toBeVisible();
  await createChannelPanel.getByLabel("Name").fill("Release");
  await createChannelPanel.getByLabel("Status").selectOption("paused");
  await createChannelPanel.getByLabel("Default AI teammate").selectOption("designer");
  await createChannelPanel.getByLabel("Execution mode").selectOption("parallel");
  await createChannelPanel.getByLabel("Write lock").selectOption("workspace");
  await createChannelPanel.getByLabel("Max runs").fill("2");
  await createChannelPanel.getByLabel("Queue on conflict").uncheck();
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

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
  await expect(createChannelPanel).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Release" })).toBeVisible();
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  const details = page.getByLabel("Channel management");
  await expect(details.getByLabel("Default AI teammate")).toHaveValue("designer");
  await expect(details.getByRole("button", { name: "Create channel" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Create default" })).toHaveCount(0);
  await details.getByLabel("Name").fill("Release QA");
  await details.getByRole("button", { name: "Save channel" }).click();
  await expect.poll(() => {
    const updated = state.channels.find((channel) => isRecord(channel) && channel.id === (isRecord(created) ? created.id : ""));
    return isRecord(updated) ? updated.name : "";
  }).toBe("Release QA");
});

test("channel settings can add remove and set default teammates", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: undefined }
      : channel,
  );
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer" }),
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      description: "Owns channel design review.",
    }),
  ];
  state.teammateChannelMemberships = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  let manager = page.getByLabel("Channel teammates");
  await expect(manager).toContainText("No teammates in this channel");
  await page.getByLabel("Channel message feed").click();
  await expect(manager).toHaveCount(0);
  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  manager = page.getByLabel("Channel teammates");
  await expect(manager).toContainText("No teammates in this channel");
  await manager.click();
  await expect(manager).toBeVisible();
  await manager.getByLabel("Add teammate").selectOption("teammate_builtin_engineer");
  await manager.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((membership) =>
    isRecord(membership) &&
    membership.teammateId === "teammate_builtin_engineer" &&
    membership.channelId === "channel_engineering"
  )).toBe(true);
  const engineerChip = manager.locator(".channel-teammate-chip").filter({ hasText: "Ling Engineer" });
  await expect(engineerChip).toBeVisible();
  await expect(engineerChip.locator(".channel-teammate-remove-button")).toHaveCSS("opacity", "0");
  await engineerChip.hover();
  await expect(engineerChip.locator(".channel-teammate-remove-button")).toHaveCSS("opacity", "1");

  await engineerChip.locator(".channel-teammate-chip-main").click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultTeammateId : undefined;
  }).toBe("teammate_builtin_engineer");
  await expect(engineerChip).toHaveClass(/default/);

  await manager.getByLabel("Add teammate").selectOption("teammate_builtin_designer");
  await manager.getByRole("button", { name: "Add", exact: true }).click();
  const designerChip = manager.locator(".channel-teammate-chip").filter({ hasText: "Ling Designer" });
  await expect(designerChip).toBeVisible();
  await designerChip.locator(".channel-teammate-chip-main").click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultTeammateId : undefined;
  }).toBe("teammate_builtin_designer");
  await expect(designerChip).toHaveClass(/default/);

  await engineerChip.hover();
  await engineerChip.getByRole("button", { name: "Remove from channel" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((membership) =>
    isRecord(membership) &&
    membership.teammateId === "teammate_builtin_engineer" &&
    membership.channelId === "channel_engineering"
  )).toBe(false);
  await expect(engineerChip).toHaveCount(0);
  await expect(designerChip).toBeVisible();
  await page.locator(".channel-header-actions").getByRole("button", { name: "Settings" }).click();
  const notifications = page.getByLabel("Channel notifications");
  await notifications.getByRole("radio", { name: "Muted" }).click();
  await expect(notifications.getByRole("radio", { name: "Muted" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.channelNotifications.%2Ftmp%2Fling-stack-workspace.channel_engineering"))).toBe("muted");
});

test("paused channels disable task run actions", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = state.channels.map((channel) => isRecord(channel) ? { ...channel, status: "paused" } : channel);
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskCard = page.locator("article.task-detail");
  await expect(taskCard).toContainText("Channel is not active");
  await expect(taskCard.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
});

test("channel activity supports mentions, messages, files, links, and topic replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-05-25T00:11:00.000Z",
    },
  })];
  state.channelMessageDelayMs = 150;
  state.linkPreviewDelayMs = 150;
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator('.channel-composer [aria-label="Composer mode"]')).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Task" })).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByText("Discuss")).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByText("@ teammates, drop files, or paste links")).toHaveCount(0);
  const composerInput = page.getByPlaceholder("Message this channel or @ an AI teammate");
  await expect(page.getByLabel("Message tools").getByLabel("Attach files")).toBeVisible();
  await expect(page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" })).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Send" })).toBeVisible();
  await page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" }).click();
  await expect(composerInput).toHaveValue("@");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composerInput.fill("@Eng");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await page.getByRole("option", { name: /@Engineer/ }).click();
  await expect(page.getByLabel("Pending message assets")).toContainText("@Engineer");
  await expect(composerInput).toHaveValue("@Engineer ");
  await composerInput.fill("please refine without mention");
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
  await composerInput.fill("@Engineer please refine the channel requirements https://example.com");
  await expect(page.getByText("Example Domain").first()).toBeVisible({ timeout: 3_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["channel brief"], "brief.txt", { type: "text/plain" }));
    return transfer;
  });
  const dropZone = page.locator(".composer-drop-zone");
  await dropZone.dispatchEvent("dragover", { dataTransfer });
  await expect(page.getByText("Drop files to attach")).toBeVisible();
  await dropZone.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  const pendingAssets = page.getByLabel("Pending message assets");
  await expect(pendingAssets).toContainText("brief.txt");
  const previewLayout = await page.locator(".channel-composer").evaluate((element) => {
    const preview = element.querySelector(".composer-preview-strip");
    const textarea = element.querySelector("textarea");
    if (!preview || !textarea) {
      return null;
    }
    return {
      previewTop: preview.getBoundingClientRect().top,
      textareaTop: textarea.getBoundingClientRect().top,
    };
  });
  if (!previewLayout) {
    throw new Error("Expected composer pending assets to render before the textarea.");
  }
  expect(previewLayout.previewTop).toBeLessThan(previewLayout.textareaTop);
  const imageTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    const binary = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    transfer.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    return transfer;
  });
  await dropZone.dispatchEvent("drop", { dataTransfer: imageTransfer });
  await imageTransfer.dispose();
  await expect(page.locator(".composer-preview-thumbnail[alt='shot.png']")).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Send" })).toBeEnabled();
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("@Engineer please refine the channel requirements")).toBeVisible();
  await expect(page.locator(".channel-composer .composer-status-row.loading")).toHaveCount(0);
  const pendingReply = page.locator(".message-bubble").filter({ hasText: "AI teammate is replying..." });
  await expect(pendingReply).toBeVisible();
  await expect(pendingReply).toHaveClass(/message-bubble-peer/);
  await expect(page.getByText("收到，我会按频道上下文推进。")).toBeVisible();
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
  await expect.poll(() => state.lastChannelMessageRequest?.providerPresetId).toBe("provider_local");
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Files" }).click();
  await expect(page.getByText("brief.txt")).toBeVisible();
  await expect(page.getByText("shot.png")).toBeVisible();
  await expect(page.getByText("Example Domain")).toBeVisible();

  const sentMessage = page.locator(".message-bubble").filter({ hasText: "@Engineer please refine the channel requirements" });
  const teammateReply = page.locator(".message-bubble").filter({ hasText: "收到，我会按频道上下文推进。" });
  const sentMessageContent = sentMessage.locator(".message-content");
  const teammateReplyContent = teammateReply.locator(".message-content");
  await expect(sentMessage).toBeVisible();
  await expect(teammateReply).toBeVisible();
  await expect(sentMessage).toHaveClass(/message-bubble-own/);
  await expect(teammateReply).toHaveClass(/message-bubble-peer/);
  const messageLayout = await page.locator(".message-feed").evaluate((feed) => {
    const own = feed.querySelector(".message-bubble-own .message-content");
    const peer = feed.querySelector(".message-bubble-peer .message-content");
    if (!own || !peer) {
      return null;
    }
    const feedRect = feed.getBoundingClientRect();
    const ownRect = own.getBoundingClientRect();
    const peerRect = peer.getBoundingClientRect();
    return {
      feedLeft: feedRect.left,
      feedRight: feedRect.right,
      ownLeft: ownRect.left,
      ownRight: ownRect.right,
      peerLeft: peerRect.left,
      peerRight: peerRect.right,
    };
  });
  if (!messageLayout) {
    throw new Error("Expected own and peer chat bubbles to render in the message feed.");
  }
  expect(messageLayout.ownRight).toBeGreaterThan(messageLayout.feedRight - 64);
  expect(messageLayout.peerLeft).toBeLessThan(messageLayout.feedLeft + 48);
  expect(messageLayout.ownLeft).toBeGreaterThan(messageLayout.peerLeft);
  expect(messageLayout.ownRight).toBeGreaterThan(messageLayout.peerRight);
  await expect(sentMessage.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);
  await expect(sentMessage.locator(".message-meta")).toHaveCount(0);
  await expect(teammateReply.locator(".message-meta time")).toHaveCount(0);
  const sentMessageTypography = await sentMessage.evaluate((element) => {
    const body = element.querySelector(".message-content p");
    return {
      bodyColor: body ? getComputedStyle(body).color : "",
      bodyFontWeight: body ? Number(getComputedStyle(body).fontWeight) : 0,
    };
  });
  expect(sentMessageTypography.bodyColor).not.toBe("");
  expect(sentMessageTypography.bodyFontWeight).toBeGreaterThanOrEqual(550);
  await expect(sentMessageContent).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(sentMessageContent).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(sentMessageContent).toHaveCSS("padding-top", "0px");
  await teammateReply.hover();
  await expect(teammateReplyContent).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(teammateReplyContent).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(teammateReplyContent).toHaveCSS("padding-top", "0px");
  await page.mouse.move(8, 8);
  await expect(sentMessage.locator(".message-meta-action")).toHaveCSS("opacity", "0");
  const replyActionLayout = await sentMessage.evaluate((element) => {
    const action = element.querySelector(".message-meta-action");
    const content = element.querySelector(".message-content");
    if (!action || !content) {
      return null;
    }
    const actionRect = action.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      actionHeight: actionRect.height,
      actionRightInset: contentRect.right - actionRect.right,
    };
  });
  expect(replyActionLayout).toEqual({
    actionHeight: expect.any(Number),
    actionRightInset: expect.any(Number),
  });
  expect(replyActionLayout?.actionHeight).toBeLessThanOrEqual(20);
  expect(replyActionLayout?.actionRightInset).toBeLessThanOrEqual(12);
  await sentMessage.hover();
  await expect(sentMessage.locator(".message-meta-action")).toHaveCSS("opacity", "1");
  await expect(sentMessage.getByRole("button", { name: "Reply in topic" })).toHaveAttribute("data-tooltip", "Reply in topic");
  await sentMessage.getByRole("button", { name: "Reply in topic" }).click();
  const topicPanel = page.getByLabel("Topic replies");
  await expect(topicPanel).toBeVisible();
  await expect(topicPanel).toContainText("收到，我会按频道上下文推进。");
  await topicPanel.getByLabel("Topic reply input").fill("Thread follow-up from the topic panel");
  await topicPanel.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => state.lastChannelMessageRequest?.threadId).toBe("msg_1");
  await expect(topicPanel).toContainText("Thread follow-up from the topic panel");
});

test("channel execution proposal confirms into a task run with the assignee provider", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Relay",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-05-25T00:11:00.000Z" },
    }),
  ];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_engineer",
      displayName: "Ling Engineer",
      providerPresetId: "provider_ready",
      allowedTools: ["read", "bash"],
      approvalProfile: { mode: "standard", risk: "medium", requiredForTools: ["bash"] },
    }),
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      description: "Reviews visual flow and interaction risks.",
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer" }
      : channel,
  );
  state.teammateChannelMemberships = [
    {
      teammateId: "teammate_builtin_engineer",
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_user_proposal",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Can we turn this into an execution task?",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:00.000Z",
      updatedAt: "2026-05-25T00:18:00.000Z",
    },
    {
      id: "msg_ai_proposal",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_user_proposal",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_engineer",
      body: "I can handle this as an execution task after confirmation.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:01.000Z",
      updatedAt: "2026-05-25T00:18:01.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_ai_proposal",
      proposedByTeammateId: "teammate_builtin_engineer",
      title: "Refine channel workspace copy",
      prompt: "Refine the channel workspace copy and verify the visible chat flow.",
      assigneeTeammateId: "teammate_builtin_engineer",
      acceptanceCriteria: ["Task is created only after confirmation", "Run uses the assignee provider"],
      collaborationSteps: [
        { teammateId: "teammate_builtin_engineer", action: "coordinated", summary: "Summarized discussion into one execution proposal." },
        { teammateId: "teammate_builtin_designer", action: "reviewed", summary: "Checked visual hierarchy before execution." },
      ],
      requiredTools: ["read", "grep"],
      riskSummary: "Provider must be ready before execution.",
      status: "draft",
      createdAt: "2026-05-25T00:18:02.000Z",
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const proposal = page.getByLabel("Execution proposal");
  await expect(proposal).toContainText("Refine channel workspace copy");
  await expect(proposal).toContainText("Ling Engineer");
  const collaboration = proposal.locator(".channel-proposal-collaboration");
  await expect(collaboration).not.toHaveAttribute("open", /.+/);
  await expect(collaboration.locator("summary")).toContainText("Collaboration 2 records");
  await expect(collaboration.locator("summary")).toContainText("Ling Engineer Summarized discussion into one execution proposal.");
  await expect(collaboration.locator("summary")).toContainText("Ling Designer Checked visual hierarchy before execution.");
  await expect(collaboration.locator("li").first()).not.toBeVisible();
  await collaboration.locator("summary").click();
  await expect(collaboration.locator("li").first()).toBeVisible();
  await expect(collaboration).toContainText("Coordinated");
  await expect(collaboration).toContainText("Reviewed");
  await proposal.getByRole("button", { name: "Start handling" }).click();

  await expect.poll(() => {
    const task = state.tasks.find((item) => isRecord(item) && item.title === "Refine channel workspace copy");
    return isRecord(task) ? task.assigneeTeammateId : undefined;
  }).toBe("teammate_builtin_engineer");
  await expect.poll(() => state.runs[0]?.providerPresetId).toBe("provider_ready");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) && Array.isArray(snapshot.tools) ? snapshot.tools.join(",") : "";
  }).toBe("read,bash");
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) && isRecord(snapshot.approvalProfile) ? snapshot.approvalProfile.mode : "";
  }).toBe("standard");
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_1");
    return isRecord(updated) ? [updated.status, updated.linkedTaskId, updated.linkedRunId].join("|") : "";
  }).toMatch(/^accepted\|task_\d+\|run_\d+$/);
  await expect(proposal.getByRole("button", { name: "Open run" })).toBeVisible();
});

test("channel files tab keeps daylight surfaces even when the app theme is dark", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelFilesPanel(page);
  await expect(page.getByText("No attachments in this channel")).toBeVisible();
  await expect(page.getByText("No shared links in this channel")).toBeVisible();
  await expect(page.getByText("No run artifacts in this channel")).toBeVisible();
  const fileTabLayout = await page.evaluate(() => {
    const panel = document.querySelector(".task-list-panel");
    const files = document.querySelector(".channel-files");
    if (!panel || !files) {
      return null;
    }
    return {
      filesHeight: files.getBoundingClientRect().height,
      panelHeight: panel.getBoundingClientRect().height,
    };
  });
  if (!fileTabLayout) {
    throw new Error("Files tab layout was not rendered");
  }
  expect(fileTabLayout.filesHeight).toBeGreaterThan(fileTabLayout.panelHeight - 96);
  const fileTabDaylightSurfaces = await page.evaluate(() => {
    function effectiveBackgroundColor(element: Element): number[] {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        const channels = color.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        const alpha = channels.length >= 4 ? channels[3] : 1;
        if (channels.length >= 3 && alpha > 0) {
          return channels.slice(0, 3);
        }
        current = current.parentElement;
      }
      return [255, 255, 255];
    }
    const selectors = [".file-section", ".channel-files .client-empty-state"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const color = effectiveBackgroundColor(element);
        return {
          selector,
          maxChannel: color.length > 0 ? Math.max(...color) : 255,
        };
      }),
    );
  });
  expect(fileTabDaylightSurfaces).toHaveLength(6);
  for (const surface of fileTabDaylightSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on the accepted daylight channel surface`).toBeGreaterThanOrEqual(245);
  }
});

test("channel activity filter chips keep daylight channel tokens", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const activityFilters = page.getByLabel("Activity filters");
  await activityFilters.getByRole("button", { name: "Filter activity" }).click();
  await expect(activityFilters.getByLabel("Filter panel")).toBeVisible();
  await activityFilters.getByLabel("Activity attention filters").locator(".activity-filter-chip").filter({ hasText: "Failed" }).click();
  const filterChipSurfaces = await page.evaluate(() => {
    const selectors = [".activity-filter-chip", ".activity-filter-chip.attention.active"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const color = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
        return {
          selector,
          maxChannel: color.length > 0 ? Math.max(...color) : 255,
        };
      }),
    );
  });
  expect(filterChipSurfaces.length).toBeGreaterThan(0);
  for (const surface of filterChipSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on daylight channel tokens`).toBeGreaterThanOrEqual(245);
  }
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
  await expect(page.locator('[aria-label="Channel activity"] > .panel-title')).toHaveCount(0);
  const scrollState = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollState.max).toBeGreaterThan(0);
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  const latestButton = page.getByRole("button", { name: "Jump to latest message" });
  await expect(latestButton).toHaveCount(0);
  const feedChrome = await page.locator(".activity-shell .message-feed").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
    };
  });
  expect(feedChrome).toEqual({
    overflowY: "auto",
    scrollbarWidth: "none",
  });
  await expect(page.locator(".activity-chat-layout")).toHaveCSS("padding-top", "0px");
  const panelBox = await page.locator(".task-list-panel.activity-tab-panel").boundingBox();
  const feedBox = await page.locator(".activity-shell .message-feed").boundingBox();
  const composerBox = await page.getByLabel("Channel composer").boundingBox();
  expect(feedBox?.height ?? 0).toBeGreaterThan(180);
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeGreaterThan((panelBox?.y ?? 0) + (panelBox?.height ?? 0) - 36);
  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(latestButton).toBeVisible();
  const latestButtonBox = await latestButton.boundingBox();
  expect(latestButtonBox?.width ?? 0).toBeGreaterThanOrEqual(40);
  expect(latestButtonBox?.height ?? 0).toBeGreaterThanOrEqual(40);
  await latestButton.click({ force: true });
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect(latestButton).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
});

test("channel activity paginates long message history and virtualizes visible rows", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = Array.from({ length: 3000 }, (_, index) => ({
    id: `msg_long_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: index % 2 === 0 ? "local-user" : "ai-teammate",
    authorId: index % 2 === 0 ? "tian" : "engineer",
    body: `Long channel message ${index + 1}`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 4, 26, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 4, 26, 0, 0, index)).toISOString(),
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 3000")).toBeVisible();
  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 1")).toHaveCount(0);
  expect(state.channelMessageQueries?.[0]).toMatchObject({
    channelId: "channel_engineering",
    limit: 200,
    beforeMessageId: undefined,
  });

  const renderedBefore = await page.locator(".activity-shell .message-feed .message-bubble").count();
  expect(renderedBefore).toBeGreaterThan(0);
  expect(renderedBefore).toBeLessThan(100);
  const scrollBefore = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollBefore.atBottom).toBe(true);

  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => state.channelMessageQueries?.some((query) => query.beforeMessageId === "msg_long_2801")).toBe(true);
  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 2801")).toBeVisible();
  const renderedAfter = await page.locator(".activity-shell .message-feed .message-bubble").count();
  expect(renderedAfter).toBeLessThan(120);
  const scrollAfter = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollAfter.top).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
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

  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Please remember this blocked reference http://127.0.0.1/private");
  await expect(page.getByText("Private network previews are blocked.")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByLabel("Channel message feed")).toBeVisible();

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Channel message feed").getByText("Please remember this blocked reference http://127.0.0.1/private")).toBeVisible();
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
  await openChannelFilesPanel(page);
  await expect(page.locator(".channel-side-panel")).toContainText("Files");
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

  await openChannelFilesPanel(page);
  await expect(page.getByText("Loading run artifacts...")).toHaveCount(0);
  await expect(page.getByText("Run artifacts")).toBeVisible();
  await expect(page.locator(".run-artifact-group")).toHaveCount(1);
  const runGroup = page.locator(".run-artifact-group").filter({ hasText: "Inspect workspace" });
  await expect(runGroup).toContainText("Inspect workspace");
  await expect(runGroup.locator(".session-file-list")).not.toBeVisible();
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
  await openChannelContextPanel(page);
  await page.getByLabel("Objective").fill("Ship channel v1.1 protocol");
  await page.getByLabel("Scope").fill("Brief, decisions, handoffs, context summaries");
  await page.getByLabel("Acceptance criteria").fill("Brief saves\nActivity shows protocol items");
  await page.getByRole("button", { name: "Save brief" }).click();
  await expect.poll(() => {
    const brief = state.channelBriefs.channel_engineering;
    return isRecord(brief) ? brief.objective : undefined;
  }).toBe("Ship channel v1.1 protocol");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await page.getByPlaceholder("Message this channel or @ an AI teammate").fill("Keep v1.1 handoffs manual and visible.");
  await page.getByRole("button", { name: "Send" }).click();
  const plainMessage = page.locator(".message-bubble").filter({ hasText: "Keep v1.1 handoffs manual and visible." });
  await expect(plainMessage).toBeVisible();
  await expect(plainMessage.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);

  const taskEventBubble = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" });
  const activityDetails = page.getByLabel("Activity details");
  const openTriageActions = async () => {
    const triageSection = activityDetails.locator(".activity-triage-section");
    await expect(triageSection).toBeVisible();
    if ((await triageSection.getAttribute("open")) === null) {
      await triageSection.locator("summary").click();
    }
  };

  await openChannelChatTools(page);
  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Record decision" }).click();
  await activityDetails.getByLabel("Triage title").fill("Decision: Keep v1.1 handoffs manual");
  await activityDetails.getByLabel("Decision text").fill("Keep v1.1 handoffs manual and visible.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelDecisions.length).toBe(1);
  await activityDetails.getByLabel("Close details").click();
  await expect(page.getByText("Decision log")).toBeVisible();

  await page.getByRole("button", { name: "Supersede" }).first().click();
  await expect.poll(() => state.channelDecisions.filter((decision) => isRecord(decision) && decision.status === "active").length).toBe(1);
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.status === "superseded")).toBe(true);

  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create handoff" }).click();
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);
  await activityDetails.getByLabel("Close details").click();
  await expect(page.getByText("Handoff", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Complete" }).first().click();
  await expect.poll(() => isRecord(state.channelHandoffs[0]) ? state.channelHandoffs[0].status : undefined).toBe("completed");
  await expect.poll(() => isRecord(state.tasks.find((task) => isRecord(task) && task.id === "task_inspect")) ? state.tasks.find((task) => isRecord(task) && task.id === "task_inspect")?.status : undefined).toBe("failed");

  const taskCount = state.tasks.length;
  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create context summary" }).click();
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelContextSummaries.length).toBe(1);
  await activityDetails.getByLabel("Close details").click();
  const summaryBubble = page.locator(".message-bubble").filter({ hasText: "Context summary" }).first();
  await expect(summaryBubble).toBeVisible();
  await summaryBubble.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);

  await page.reload();
  await openChannelContextPanel(page);
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

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator("article.task-detail").getByRole("button", { name: "Create handoff" }).click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);

  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Handoffs" }).click();
  await page.getByRole("button", { name: "Start workflow" }).first().click();
  await expect.poll(() => state.channelWorkflows.length).toBe(1);
  await expect.poll(() => state.channelWorkflowSteps.length).toBe(1);
  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Runtime" }).click();
  await expect(page.getByText("Workflow queue")).toBeVisible();
  await expect(page.getByText("Active decisions: 0")).toBeVisible();
  const workflowStepLayout = await page.locator(".workflow-step-card").first().evaluate((element) => {
    const cardRect = element.getBoundingClientRect();
    const actionRow = element.querySelector(".activity-action-row");
    const actionRect = actionRow?.getBoundingClientRect();
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>(".activity-action-row .compact-button")).map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        whiteSpace: getComputedStyle(button).whiteSpace,
      };
    });
    return {
      cardLeft: Math.round(cardRect.left),
      cardRight: Math.round(cardRect.right),
      actionLeft: Math.round(actionRect?.left ?? 0),
      actionRight: Math.round(actionRect?.right ?? 0),
      gridColumns: getComputedStyle(element).gridTemplateColumns,
      buttons,
    };
  });
  expect(workflowStepLayout.gridColumns.split(" ").length).toBe(1);
  expect(workflowStepLayout.actionLeft).toBeGreaterThanOrEqual(workflowStepLayout.cardLeft);
  expect(workflowStepLayout.actionRight).toBeLessThanOrEqual(workflowStepLayout.cardRight);
  for (const button of workflowStepLayout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(workflowStepLayout.cardLeft);
    expect(button.right).toBeLessThanOrEqual(workflowStepLayout.cardRight);
    expect(button.width).toBeGreaterThanOrEqual(58);
    expect(button.whiteSpace).toBe("nowrap");
  }

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
  await openChannelContextPanel(page);
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

  await openChannelContextPanel(page);
  await page.getByRole("button", { name: "Runtime" }).click();
  await page.getByRole("button", { name: "Start + run" }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect.poll(() => {
    const step = state.channelWorkflowSteps.find((item) => isRecord(item) && item.id === "workflow_step_seed");
    return isRecord(step) ? step.runId : undefined;
  }).toBe("run_2");
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Run seeded step" })).toContainText("succeeded");
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

  const messageBubble = page.locator(".message-bubble").filter({ hasText: "Timeline source message" });
  const taskEventBubble = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" });
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" });
  const stateTransitionBubble = page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" });
  const workflowStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" });
  const activityDetails = page.getByLabel("Activity details");
  const openDetailsFrom = async (bubble: Locator, expectedText: string) => {
    await bubble.getByRole("button", { name: "Details" }).click();
    await expect(activityDetails).toBeVisible();
    await expect(activityDetails).toContainText(expectedText);
    await expect(activityDetails).toContainText("Source summary");
    await expect(activityDetails).toContainText("Source metadata");
    await expect(activityDetails).toContainText("Related objects");
    await activityDetails.getByLabel("Close details").click();
    await expect(activityDetails).toHaveCount(0);
  };

  await expect(messageBubble).toBeVisible();
  await expect(messageBubble.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);
  await expect(taskEventBubble).toHaveCount(0);
  await expect(runEventBubble).toHaveCount(0);
  await expect(approvalEventBubble).toHaveCount(0);
  await expect(stateTransitionBubble).toHaveCount(0);
  await expect(workflowStepBubble).toHaveCount(0);
  await openChannelChatTools(page);
  await expect(taskEventBubble).toContainText("failed");
  await expect(runEventBubble).toContainText("failed");
  await expect(approvalEventBubble).toContainText("pending");
  await expect(stateTransitionBubble).toBeVisible();
  await expect(workflowStepBubble).toContainText("Runtime policy is waiting.");
  await expect(page.getByText("Other channel task leak")).toHaveCount(0);
  await expect(page.getByText("Other channel approval leak")).toHaveCount(0);
  await expect(page.getByText("other_channel_done")).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const composer = page.getByLabel("Channel composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "More" })).toHaveCount(0);
  await composer.getByPlaceholder("Message this channel or @ an AI teammate").fill("@Eng");
  await expect(composer.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composer.getByRole("option", { name: /@Engineer/ }).click();
  await expect(composer.getByLabel("Pending message assets")).toContainText("@Engineer");

  await openDetailsFrom(taskEventBubble, "Inspect workspace");
  await openDetailsFrom(runEventBubble, "Run run_failed");
  await openDetailsFrom(approvalEventBubble, "Approve shell command");
  await openDetailsFrom(stateTransitionBubble, "task_failed");
  await openDetailsFrom(workflowStepBubble, "Blocked timeline step");

  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open task" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");
  await expect(activityDetails).toHaveCount(0);

  await openChannelChatTools(page);
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open run" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);

  await approvalEventBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open approval" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Approval details");
  await expect(page.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);

  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await activityDetails.getByRole("button", { name: "Open context" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await expect(activityDetails).toHaveCount(0);

  await openChannelChatTools(page);
  const activityFilters = page.getByLabel("Activity filters");
  const activityFeed = page.getByLabel("Channel message feed");
  const searchInput = activityFilters.getByPlaceholder("Search activity");
  const savedViewSelect = activityFilters.locator('select[aria-label="Saved views"]');
  const savedViewOption = (label: string) => savedViewSelect.locator("option").filter({ hasText: label });
  const selectSavedView = async (label: string) => {
    await openChannelChatTools(page);
    const value = await savedViewOption(label).getAttribute("value");
    expect(value).toBeTruthy();
    await savedViewSelect.selectOption(value ?? "");
  };
  const openFilterPanel = async () => {
    if (await activityFilters.getByLabel("Filter panel").count() === 0) {
      await activityFilters.getByRole("button", { name: "Filter activity" }).click();
    }
  };
  const categoryChip = (label: string) => activityFilters.getByLabel("Activity categories").locator(".activity-filter-chip").filter({ hasText: label });
  const attentionChip = (label: string) => activityFilters.getByLabel("Activity attention filters").locator(".activity-filter-chip").filter({ hasText: label });

  await expect(activityFilters).toBeVisible();
  await expect(activityFilters.locator(".activity-saved-views")).toHaveCount(0);
  await expect(savedViewSelect).toContainText("All (7)");
  await expect(savedViewSelect).toContainText("Needs attention (5)");
  await expect(savedViewSelect).toContainText("Blocked (1)");
  await expect(savedViewSelect).toContainText("Failed (3)");
  await expect(savedViewSelect).toContainText("Pending approvals (1)");
  await expect(savedViewSelect).toContainText("Failed work (2)");
  await expect(savedViewSelect).toContainText("Runtime (3)");
  await expect(activityFilters.getByLabel("Activity categories")).toHaveCount(0);
  await openFilterPanel();
  await expect(activityFilters.getByLabel("Filter panel")).toBeVisible();
  await expect(categoryChip("All")).toContainText("7");
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("2");
  await expect(categoryChip("Approvals")).toContainText("1");
  await expect(categoryChip("Protocol")).toContainText("0");
  await expect(categoryChip("Runtime")).toContainText("3");

  const attentionQueue = page.getByRole("region", { name: "Attention queue" });
  await expect(attentionQueue).toContainText("Attention");
  await expect(attentionQueue).toContainText("5");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Blocked 1");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Failed 3");
  await expect(attentionQueue.getByLabel("Attention counts")).toContainText("Pending 1");
  const topAttentionItems = attentionQueue.getByLabel("Top attention items");
  await expect(topAttentionItems.locator(".attention-queue-item")).toHaveCount(5);
  await expect(topAttentionItems.locator(".attention-queue-item-open").first()).toContainText("Blocked timeline step");
  const attentionTypography = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const style = getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    };
    const readIcon = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        strokeWidth: style.strokeWidth,
      };
    };
    return {
      progressTitle: read(".attention-progress-head strong"),
      progressRow: read(".attention-progress-list small"),
      progressIcon: readIcon(".attention-progress-list svg"),
      attentionTitle: read(".attention-queue-head strong"),
      attentionCount: read(".attention-queue-head small"),
      countChip: read(".attention-queue-counts small"),
      itemTitle: read(".attention-queue-item-main strong"),
      itemCopy: read(".attention-queue-item-main small"),
      itemMetaChipCount: document.querySelector(".attention-queue-item-meta")?.querySelectorAll("small").length ?? 0,
      itemTimeCount: document.querySelectorAll(".attention-queue-item-meta time").length,
      detailsButtonCount: document.querySelectorAll(".attention-queue-details").length,
    };
  });
  expect(attentionTypography.progressTitle).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "20px" });
  expect(attentionTypography.progressRow).toEqual({ fontSize: "12px", fontWeight: "500", lineHeight: "17px" });
  expect(attentionTypography.progressIcon).toEqual({ width: 18, height: 18, strokeWidth: "2.4px" });
  expect(attentionTypography.attentionTitle).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "20px" });
  expect(attentionTypography.attentionCount).toEqual({ fontSize: "12px", fontWeight: "500", lineHeight: "17px" });
  expect(attentionTypography.countChip).toEqual({ fontSize: "11px", fontWeight: "600", lineHeight: "16px" });
  expect(attentionTypography.itemTitle).toEqual({ fontSize: "13px", fontWeight: "600", lineHeight: "18px" });
  expect(attentionTypography.itemCopy).toEqual({ fontSize: "12px", fontWeight: "400", lineHeight: "17px" });
  expect(attentionTypography.itemMetaChipCount).toBe(1);
  expect(attentionTypography.itemTimeCount).toBe(0);
  expect(attentionTypography.detailsButtonCount).toBe(0);
  const expandQueueIfNeeded = async () => {
    const hideDetails = page.getByRole("button", { name: "Hide details" });
    if (await hideDetails.isVisible().catch(() => false)) {
      await hideDetails.click();
    }
    await openChannelChatTools(page);
    await expect(attentionQueue.locator(".attention-queue-item").first()).toBeVisible();
  };
  const attentionQueueItemByTitle = (title: string) =>
    attentionQueue.locator(".attention-queue-item").filter({
      has: page.locator(".attention-queue-item-main strong").filter({ hasText: title }),
    });
  const blockedQueueItem = attentionQueueItemByTitle("Blocked timeline step");
  await blockedQueueItem.locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
  await expandQueueIfNeeded();
  await attentionQueueItemByTitle("Run run_failed").locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expandQueueIfNeeded();
  await attentionQueueItemByTitle("Approve shell command").locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Approval details");
  await expect(page.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expandQueueIfNeeded();
  await attentionQueueItemByTitle("Inspect workspace").locator(".attention-queue-item-open").click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");

  await selectSavedView("Blocked");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await selectSavedView("Pending approvals");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toHaveCount(0);
  await selectSavedView("Failed work");
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toHaveCount(0);
  await selectSavedView("Runtime");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await activityFilters.getByRole("button", { name: /Clear/ }).click();
  await openFilterPanel();

  await searchInput.fill("Timeline source");
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();
  await expect(activityFeed.getByText("Inspect workspace")).toHaveCount(0);
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("0");

  await searchInput.fill("Inspect the repo");
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);

  await searchInput.fill("run_failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" })).toBeVisible();

  await searchInput.fill("Approve shell command");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "pending" })).toBeVisible();

  await searchInput.fill("Wait for runtime recovery");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();

  await searchInput.fill("task_failed");
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();

  await searchInput.fill("");
  await openFilterPanel();
  await categoryChip("Messages").click();
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();
  await expect(activityFeed.getByText("Inspect workspace")).toHaveCount(0);
  await categoryChip("Runtime").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await activityFilters.getByRole("button", { name: /Clear/ }).click();
  await openFilterPanel();

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
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await searchInput.fill("run_failed");
  await expandQueueIfNeeded();
  await expect(runEventBubble).toBeVisible();
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await expect(activityDetails).toContainText("Run run_failed");
  await expect(searchInput).toHaveValue("run_failed");
  await expect(attentionQueue.locator(".attention-queue-item")).toHaveCount(5);
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("run_failed");
  await expect(attentionQueue.locator(".attention-queue-item")).toHaveCount(5);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Saved view name");
    await dialog.accept("Run failures");
  });
  await activityFilters.getByRole("button", { name: "Save view" }).click();
  await expect(savedViewOption("Run failures")).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await openChannelChatTools(page);
  await expect(savedViewOption("Run failures")).toHaveCount(1);
  await selectSavedView("Run failures");
  await expect(searchInput).toHaveValue("run_failed");
  await openFilterPanel();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Rename saved view");
    await dialog.accept("Run problems");
  });
  await activityFilters.getByRole("button", { name: "Rename" }).click();
  await expect(savedViewOption("Run problems")).toHaveCount(1);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await openChannelChatTools(page);
  await expect(searchInput).toHaveValue("");
  await expect(savedViewOption("Run problems")).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await expect(savedViewOption("Run problems")).toHaveCount(1);
  await selectSavedView("Run problems");
  await openFilterPanel();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Delete saved view?");
    await dialog.accept();
  });
  await activityFilters.getByRole("button", { name: "Delete view" }).click();
  await expect(savedViewOption("Run problems")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await openChannelChatTools(page);
  await expect(searchInput).toHaveValue("");
  await expect(activityFeed.getByText("Other channel task leak").first()).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await expect(page.getByText("No activity matches these filters")).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await expect(searchInput).toHaveValue("");
  await expect(activityFeed.getByText("Timeline source message")).toBeVisible();

  await page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Open task" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Inspect workspace");

  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Open run" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Latest run");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" }).getByRole("button", { name: "Open approval" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Approval details");
  await expect(page.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" }).getByRole("button", { name: "Open context" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
});

test("channel activity triage actions create follow-up records and preserve local state", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [
    {
      id: "msg_triage",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Timeline source message for triage",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:02:00.000Z",
      updatedAt: "2026-05-25T00:02:00.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_triage",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Triage workflow",
      objective: "Show blocked workflow step triage.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:05:00.000Z",
      updatedAt: "2026-05-25T00:06:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_triage",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_triage",
      position: 1,
      title: "Blocked triage step",
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
      id: "transition_triage_task",
      workspaceId: "workspace_default",
      entityType: "task",
      entityId: "task_inspect",
      fromStatus: "todo",
      toStatus: "failed",
      event: "task_failed",
      actor: "runner",
      createdAt: "2026-05-25T00:03:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const activityDetails = page.getByLabel("Activity details");
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const workflowStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked triage step" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" });
  const messageBubble = page.locator(".message-bubble").filter({ hasText: "Timeline source message for triage" });
  const openTriageActions = async () => {
    const triageSection = activityDetails.locator(".activity-triage-section");
    await expect(triageSection).toBeVisible();
    if ((await triageSection.getAttribute("open")) === null) {
      await triageSection.locator("summary").click();
    }
  };

  await expect(messageBubble).toBeVisible();
  await expect(messageBubble.getByRole("button", { name: /Create task|Record decision|Create handoff|Create task with context|Details/ })).toHaveCount(0);

  await openChannelChatTools(page);
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await expect(activityDetails).toContainText("Triage actions");
  await expect(activityDetails.getByLabel("Triage title")).toHaveCount(0);
  await openTriageActions();
  await expect(activityDetails.getByText("Choose a triage action to continue.")).toBeVisible();
  await activityDetails.getByRole("button", { name: "Create follow-up task" }).click();
  await activityDetails.getByLabel("Triage title").fill("Investigate failed run triage");
  state.failNextTaskCreate = true;
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect(activityDetails.getByRole("alert")).toContainText("Triage action failed");
  await expect(activityDetails.getByLabel("Triage title")).toHaveValue("Investigate failed run triage");
  await expect(activityDetails.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(activityDetails.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await activityDetails.getByRole("button", { name: "Retry" }).click();
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.title === "Investigate failed run triage")).toBe(true);
  await activityDetails.getByRole("button", { name: "Open in Tasks" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Task detail");
  await expect(page.locator("article.task-detail")).toContainText("Investigate failed run triage");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create handoff" }).click();
  await activityDetails.getByLabel("Reason").fill("Escalate blocked triage step");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelHandoffs.some((handoff) => isRecord(handoff) && handoff.reason === "Escalate blocked triage step")).toBe(true);
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await activityDetails.getByRole("button", { name: "Open in Context" }).click();
  await expect(page.locator(".channel-side-panel")).toContainText("Context");
  await expect(page.getByRole("region", { name: "Channel inspector" })).toContainText("Escalate blocked triage step");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await approvalEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Record decision" }).click();
  await activityDetails.getByLabel("Triage title").fill("Decision: approval stays pending");
  await activityDetails.getByLabel("Decision text").fill("Keep the approval pending until the user reviews the shell command.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.title === "Decision: approval stays pending")).toBe(true);
  await activityDetails.getByRole("button", { name: "Open in Context" }).click();
  await expect(page.getByRole("region", { name: "Channel inspector" })).toContainText("Decision: approval stays pending");

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  const activityFilters = page.getByLabel("Activity filters");
  const searchInput = activityFilters.getByPlaceholder("Search activity");
  const composer = page.getByPlaceholder("Message this channel or @ an AI teammate");
  const attentionQueue = page.getByLabel("Attention queue");
  await searchInput.fill("Blocked triage");
  await composer.fill("Composer draft survives triage");
  await expect(attentionQueue.locator(".attention-queue-item").first()).toBeVisible();
  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create context summary" }).click();
  await activityDetails.getByLabel("Summary").fill("Summary from Blocked triage step.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelContextSummaries.some((summary) => isRecord(summary) && summary.summary === "Summary from Blocked triage step.")).toBe(true);
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("Blocked triage");
  await expect(composer).toHaveValue("Composer draft survives triage");
  await expect(attentionQueue.locator(".attention-queue-item").first()).toBeVisible();
  const summaryBubble = page.locator(".message-bubble").filter({ hasText: "Context summary" }).filter({ hasText: "Summary from Blocked triage step" });
  await expect(summaryBubble).toBeVisible();
  const taskCount = state.tasks.length;
  await summaryBubble.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});

test("channel activity hides the attention queue when no items need attention", async ({ page }) => {
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

  await expect(page.getByRole("button", { name: "Attention queue" }).locator(".toolbar-count")).toHaveCount(0);
  await expect(page.locator(".channel-attention-popover")).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  await expect(page.getByLabel("Used memory").filter({ hasText: "Run acceptance memory" })).toBeVisible();
  await page.locator(".run-detail-panel").getByText("Debug details").click();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await expect(page.getByRole("heading", { name: "Interface preferences" })).toBeVisible();
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "界面偏好" })).toBeVisible();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "收件箱" })).toBeVisible();
  await expect(page.getByLabel("频道动态")).toBeVisible();
  await openChannelChatTools(page);
  await expect(page.getByPlaceholder("搜索动态")).toBeVisible();
  await expect(page.locator('select[aria-label="保存的视图"]')).toContainText("需要关注");
  await page.getByRole("button", { name: "筛选动态" }).click();
  await expect(page.getByLabel("动态类别").getByRole("button", { name: /全部/ })).toBeVisible();
  await expect(page.getByLabel("动态关注筛选").getByRole("button", { name: /需要关注/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "关注队列" })).toBeVisible();
  await page.locator(".message-bubble").filter({ hasText: "任务事件" }).first().getByRole("button", { name: "详情" }).click();
  const chineseDetails = page.getByRole("complementary", { name: "动态详情" });
  await expect(chineseDetails).toContainText("来源摘要");
  await expect(chineseDetails).toContainText("关联对象");
  await expect(chineseDetails).toContainText("分诊动作");
  await chineseDetails.locator(".activity-triage-section summary").click();
  await expect(chineseDetails).toContainText("创建跟进任务");
  await chineseDetails.getByLabel("关闭详情").click();
  await expect(page.getByPlaceholder("给频道发消息，或 @ 一个 AI 队友")).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "发送" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.locale"))).toBe("zh-CN");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /界面偏好/ }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByLabel("Channel activity")).toBeVisible();
  await openChannelChatTools(page);
  await expect(page.getByPlaceholder("Search activity")).toBeVisible();
  await expect(page.locator('select[aria-label="Saved views"]')).toContainText("Needs attention");
  await page.getByRole("button", { name: "Filter activity" }).click();
  await expect(page.getByLabel("Activity categories").getByRole("button", { name: /Messages/ })).toBeVisible();
  await expect(page.getByLabel("Activity attention filters").getByRole("button", { name: /Needs attention/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Attention queue" })).toBeVisible();
  await page.locator(".message-bubble").filter({ hasText: "Task event" }).first().getByRole("button", { name: "Details" }).click();
  const englishDetails = page.getByRole("complementary", { name: "Activity details" });
  await expect(englishDetails).toContainText("Source summary");
  await expect(englishDetails).toContainText("Related objects");
  await expect(englishDetails).toContainText("Triage actions");
  await englishDetails.locator(".activity-triage-section summary").click();
  await expect(englishDetails).toContainText("Create follow-up task");
  await expect(page.getByPlaceholder("Message this channel or @ an AI teammate")).toBeVisible();
});

test("Chinese mode localizes workspace settings, runtime policy, and teammate setup labels", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByLabel("任务检查器")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "任务上下文" })).toHaveCount(0);
  await expect(page.getByText("Task context")).toHaveCount(0);
  await expect(page.getByText("No task selected")).toHaveCount(0);
  await expect(page.getByText("active · serial · boundPath lock")).toHaveCount(0);
  await expect(page.getByText(/已启用 频道/)).toHaveCount(0);
  await expect(page.getByText("Daemon ready")).toHaveCount(0);
  await expect(page.getByText("本地服务已就绪")).toHaveCount(0);
  await page.locator(".channel-header-actions").getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("频道管理")).toContainText("运行模型预设");
  await expect(page.getByLabel("频道运行策略")).toBeVisible();
  await expect(page.getByLabel("频道管理").getByRole("button", { name: "创建频道" })).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI 队友" }).click();
  await expect(page.getByRole("heading", { name: "AI 队友", level: 1 })).toBeVisible();
  await expect(page.getByLabel("AI 队友上下文")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
  await page.getByLabel("队友模板").getByRole("button", { name: /产品策略/ }).click();
  const roleDetail = page.getByRole("dialog", { name: "角色详情" });
  await expect(roleDetail).toBeVisible();
  await expect(roleDetail.getByText("这个队友能做什么")).toBeVisible();
  await expect(roleDetail.getByText("系统提示词")).toBeHidden();
  await roleDetail.getByRole("button", { name: "关闭角色详情" }).click();
  await expect(page.getByText("Role", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Pick a default teammate or start blank")).toHaveCount(0);
  await expect(page.getByText("标准 · medium")).toHaveCount(0);
  await page.getByLabel("队友模板").getByRole("button", { name: "添加队友" }).click();
  const createDialog = page.getByRole("dialog", { name: "创建 AI 队友" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByText("选择角色", { exact: true })).toBeVisible();
  await expect(createDialog.getByText("选择模型", { exact: true })).toBeVisible();
  await expect(createDialog.getByText("基础信息", { exact: true })).toBeVisible();
  await expect(createDialog.getByLabel("队友设置步骤")).toHaveCount(0);
  await expect(createDialog.getByLabel("队友预览")).toHaveCount(0);
  await expect(createDialog.getByText("系统提示词")).toHaveCount(0);
  await createDialog.getByText("高级设置").click();
  await expect(page.getByText("Project files")).toHaveCount(0);
  await expect(page.getByText("Skill pack")).toHaveCount(0);
  await expect(createDialog.getByText("技能包")).toBeVisible();
});

test("theme switcher supports system, light, and dark preferences", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ling-stack.themeTestInitialized")) {
      localStorage.setItem("ling-stack.locale", "en-US");
      localStorage.removeItem("ling-stack.themePreference");
      sessionStorage.setItem("ling-stack.themeTestInitialized", "true");
    }
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "system");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await expect(page.getByRole("heading", { name: "Interface preferences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveAttribute("data-theme-preference", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBe("light");

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBe("dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("button", { name: "System" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "system");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("model workbench Chinese mode localizes setup copy and uses an add model sheet", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_missing_key",
      displayName: "Missing Key Gateway",
      apiKeyConfigured: false,
      apiKeyRef: "env:MISSING_GATEWAY_KEY",
    }),
  ];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await expect(page.getByRole("heading", { name: "模型工作台" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型工作台" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "模型预设" })).toHaveCount(0);
  await expect(page.locator(".provider-table")).toBeVisible();
  const workbenchBounds = await page.locator(".provider-workbench").evaluate((workbench) => {
    const workspaceElement = workbench.closest(".workspace");
    const workspace = workspaceElement?.getBoundingClientRect();
    const rect = workbench.getBoundingClientRect();
    const style = workspaceElement ? getComputedStyle(workspaceElement) : undefined;
    const contentLeft = workspace && style ? workspace.left + Number.parseFloat(style.paddingLeft) : undefined;
    const contentRight = workspace && style ? workspace.right - Number.parseFloat(style.paddingRight) : undefined;
    return contentLeft !== undefined && contentRight !== undefined
      ? {
        workspaceContent: { left: contentLeft, right: contentRight },
        workbench: { left: rect.left, right: rect.right },
      }
      : undefined;
  });
  expect(workbenchBounds).toBeDefined();
  expect(workbenchBounds?.workbench.left).toBeGreaterThanOrEqual((workbenchBounds?.workspaceContent.left ?? 0) - 1.5);
  expect(workbenchBounds?.workbench.right).toBeLessThanOrEqual((workbenchBounds?.workspaceContent.right ?? 0) + 1.5);
  expect(workbenchBounds ? workbenchBounds.workspaceContent.right - workbenchBounds.workbench.right : 0).toBeLessThanOrEqual(1.5);
  await expect(page.locator(".workspace-head .status-badge")).toHaveCount(0);
  await expect(page.getByText("聊天能力")).toBeVisible();
  await expect(page.getByText("Chat-capable")).toHaveCount(0);
  await expect(page.getByText(/个聊天 \/ .*个媒体/)).toBeVisible();
  await expect(page.getByRole("button", { name: "添加模型" })).toBeVisible();
  await expect(page.getByText("修复队列")).toHaveCount(0);
  await expect(page.getByText("Repair queue")).toHaveCount(0);
  await expect(page.getByText("MISSING_GATEWAY_KEY")).toHaveCount(0);
  await expect(page.getByText("env:", { exact: false })).toHaveCount(0);
  await expect(page.getByText("New preset")).toHaveCount(0);
  await expect(page.getByLabel("Model Workbench context")).toHaveCount(0);
  const missingKeyGatewayRow = page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" });
  await expect(missingKeyGatewayRow.getByRole("button", { name: "启用" })).toBeVisible();
  await expect(missingKeyGatewayRow.getByRole("button", { name: "使用" })).toHaveCount(0);
  const tableLayout = await missingKeyGatewayRow.evaluate((row) => {
    const cells = Array.from(row.children).map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return cells;
  });
  for (let index = 0; index < tableLayout.length - 1; index += 1) {
    expect(tableLayout[index].right).toBeLessThanOrEqual(tableLayout[index + 1].left + 0.5);
  }
  await missingKeyGatewayRow.hover();
  const actionLayout = await missingKeyGatewayRow.evaluate((row) => {
    const actionCell = row.children[row.children.length - 1]?.getBoundingClientRect();
    const actions = row.querySelector(".provider-actions")?.getBoundingClientRect();
    return actionCell && actions
      ? {
        actionCell: { left: actionCell.left, right: actionCell.right },
        actions: { left: actions.left, right: actions.right },
      }
      : undefined;
  });
  expect(actionLayout).toBeDefined();
  expect(actionLayout?.actions.left).toBeGreaterThanOrEqual((actionLayout?.actionCell.left ?? 0) - 0.5);
  expect(actionLayout?.actions.right).toBeLessThanOrEqual((actionLayout?.actionCell.right ?? 0) + 0.5);

  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await expect(editor).toBeVisible();
  const editorBox = await editor.boundingBox();
  const viewport = page.viewportSize();
  expect(editorBox).not.toBeNull();
  expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeGreaterThan(1240);
  expect(editorBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((editorBox?.y ?? 0) + (editorBox?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 720);
  await expect(editor.locator(".provider-sheet-header")).toHaveCSS("border-bottom-width", "0px");
  await expect(editor.locator(".provider-sheet-footer")).toHaveCSS("border-top-width", "0px");
  const editorBody = editor.locator(".provider-sheet-body");
  const editorTitle = editor.getByRole("heading", { name: "新建预设" });
  const editorCloseButton = editor.getByRole("button", { name: "关闭模型预设编辑器" });
  const savePresetButton = editor.getByRole("button", { name: "保存" });
  const templatePanel = editor.locator(".provider-template-panel");

  await expect(editor.getByRole("tab", { name: /自定义接入/ })).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("自定义 OpenAI-compatible");
  await expect(editor).not.toContainText("本地 OpenAI-compatible Relay");
  await expect(editor.getByRole("tab", { name: /OpenAI-compatible 中转/ })).toHaveCount(0);

  await editor.getByRole("tab", { name: /^GPT/ }).click();
  await expect(templatePanel).toContainText("OpenAI GPT");
  await expect(templatePanel).not.toContainText("Claude");
  await page.getByRole("button", { name: /OpenAI GPT/ }).click();
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await editor.getByRole("tab", { name: /^Claude/ }).click();
  await expect(templatePanel).toContainText("Claude");
  await expect(templatePanel).not.toContainText("OpenAI GPT");
  await page.getByRole("button", { name: /Claude/ }).click();
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await editor.getByRole("tab", { name: /国内模型/ }).click();
  await expect(editor).toContainText("豆包 Ark");
  await expect(editor).toContainText("智谱 GLM");
  await expect(editor).not.toContainText("Seedream 图片");
  await expect(page.getByLabel("提供商名称")).toHaveValue("豆包 Ark");
  await expect(page.getByLabel("提供商 ID")).toHaveValue("doubao");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await editor.getByRole("tab", { name: /媒体/ }).click();
  await expect(editor).toContainText("Seedream 图片");
  await expect(editor).toContainText("Seedance 视频");
  await expect(editor).not.toContainText("豆包 Ark");
  await expect(page.getByLabel("提供商名称")).toHaveValue("Seedream 图片");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://ark.cn-beijing.volces.com/api/v3");
  await expect(page.getByLabel("API 协议")).toBeDisabled();

  await editor.getByRole("tab", { name: /自定义接入/ }).click();
  await page.getByRole("button", { name: /自定义 OpenAI-compatible/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("自定义 OpenAI-compatible");
  await expect(page.getByLabel("提供商名称")).toHaveValue("自定义 OpenAI-compatible");
  await expect(page.getByLabel("API 协议")).toBeEnabled();
  await expect(page.getByText("高级 env/keychain")).toHaveCount(0);
  await expect(page.getByText("env:OPENAI_API_KEY")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
    })),
  ).toEqual({ bodyOverflow: "hidden", htmlOverflow: "hidden" });

  const titleBeforeScroll = await editorTitle.boundingBox();
  const closeBeforeScroll = await editorCloseButton.boundingBox();
  const saveBeforeScroll = await savePresetButton.boundingBox();
  await editorBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(editorTitle).toBeVisible();
  await expect(editorCloseButton).toBeVisible();
  await expect(savePresetButton).toBeVisible();
  const titleAfterScroll = await editorTitle.boundingBox();
  const closeAfterScroll = await editorCloseButton.boundingBox();
  const saveAfterScroll = await savePresetButton.boundingBox();
  expect(titleBeforeScroll).not.toBeNull();
  expect(closeBeforeScroll).not.toBeNull();
  expect(saveBeforeScroll).not.toBeNull();
  expect(titleAfterScroll).not.toBeNull();
  expect(closeAfterScroll).not.toBeNull();
  expect(saveAfterScroll).not.toBeNull();
  expect(Math.abs((titleAfterScroll?.y ?? 0) - (titleBeforeScroll?.y ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((closeAfterScroll?.y ?? 0) - (closeBeforeScroll?.y ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((saveAfterScroll?.y ?? 0) - (saveBeforeScroll?.y ?? 0))).toBeLessThanOrEqual(2);
  await expect(editor).not.toContainText("Local OpenAI-Compatible Relay");
  await expect(editor).not.toContainText("Doubao Ark");
  await expect(editor).not.toContainText("GLM Zhipu");
  await expect(editor).not.toContainText("Jimeng Image");
  await expect(editor).not.toContainText("Seedream Image");
  await expect(editor).not.toContainText("Seedance Video");
  await expect(editor).not.toContainText("Official Anthropic Messages API endpoint.");
  await expect(editor).not.toContainText("Volcengine Ark OpenAI-compatible chat endpoint for Doubao models.");
  await expect(page.getByText("Check provider")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存" })).toHaveCount(1);
  await expect(editor.getByRole("button", { name: "创建预设" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存修改" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "保存并检查" })).toHaveCount(0);
});

test("model workbench localizes unsupported daemon model discovery errors", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    templates: createDefaultProviderTemplates(),
    providerModelsUnsupported: true,
  });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await page.getByRole("button", { name: "添加模型" }).first().click();
  await page.getByRole("button", { name: /自定义 OpenAI-compatible/ }).click();
  await page.getByLabel("API Key", { exact: true }).fill("test-visible-key");
  await page.getByRole("button", { name: "获取模型" }).click();

  await expect(page.getByText("当前本地服务版本不支持获取模型，请停止旧服务后重新启动项目。")).toBeVisible();
  await expect(page.getByText("No route for POST /provider-models")).toHaveCount(0);
});

test("model workbench save validates before persisting and keeps errors inside the sheet", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "模型工作台" }).click();
  await page.getByRole("button", { name: "添加模型" }).first().click();
  const editor = page.getByRole("dialog", { name: "新建预设" });
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: /自定义 OpenAI-compatible/ }).click();
  await page.getByRole("button", { name: "保存" }).click();

  await expect(editor.getByText("请填写 API Key 后再保存。")).toBeVisible();
  await expect(editor.getByText("API key missing. Add an API key before running a live check.")).toHaveCount(0);
  await expect(page.locator(".provider-list-panel > .inline-error")).toHaveCount(0);
  await expect.poll(() =>
    state.providers.some((provider) => isRecord(provider) && provider.displayName === "Custom OpenAI-compatible")
  ).toBe(false);
});

test("MCP tool access page creates servers without exposing secret values", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "工具接入" }).click();
  await expect(page.getByRole("heading", { name: "工具接入", level: 1 })).toBeVisible();
  await expect(page.getByText("统一管理 MCP 工具服务，并按 AI 队友单独授权。").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "添加 MCP 服务" })).toBeVisible();
  await expect(page.getByText("没有 MCP 服务")).toBeVisible();

  await page.getByRole("button", { name: "添加 MCP 服务" }).click();
  const sheet = page.getByRole("dialog", { name: "添加 MCP 服务" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("服务名称").fill("GitHub MCP");
  await sheet.getByLabel("服务标识").fill("github");
  await sheet.getByLabel("传输方式").selectOption("streamable-http");
  await sheet.getByLabel("服务地址").fill("https://api.githubcopilot.com/mcp");
  await sheet.getByLabel("Header 密钥名称").fill("X-Goog-Api-Key");
  await sheet.getByLabel("Header 密钥值").fill("AQ.test-secret-token");
  await sheet.getByRole("button", { name: "保存服务" }).click();

  const serverRow = page.locator(".mcp-server-row").filter({ hasText: "GitHub MCP" });
  await expect(serverRow).toBeVisible();
  await expect(serverRow).toContainText("HTTP");
  await expect(serverRow).toContainText("密钥已配置");
  await expect(page.locator("body")).not.toContainText("AQ.test-secret-token");
  await expect.poll(() => state.mcpServerSecrets.github?.["X-Goog-Api-Key"]).toBe("AQ.test-secret-token");

  await serverRow.getByRole("button", { name: "检查连接" }).click();
  await expect(serverRow).toContainText("就绪");
  await expect(serverRow).toContainText("连接检查成功");
  await expect.poll(async () => {
    const box = await serverRow.boundingBox();
    return box?.height ?? 0;
  }).toBeLessThan(180);

  await serverRow.getByRole("button", { name: "编辑" }).click();
  const editSheet = page.getByRole("dialog", { name: "编辑 MCP 服务" });
  await expect(editSheet).toBeVisible();
  await expect(editSheet.getByText("Required for assigned teammates")).toHaveCount(0);
  await expect(editSheet.getByRole("switch", { name: "启用服务" })).toBeVisible();
  const secretInput = editSheet.getByLabel("Header 密钥值", { exact: true });
  await expect(secretInput).toHaveAttribute("placeholder", "粘贴密钥");
  await expect(secretInput).toHaveAttribute("type", "password");
  await expect(secretInput).toHaveValue("AQ.test-secret-token");
  await editSheet.getByRole("button", { name: "显示 Header 密钥值" }).click();
  await expect(secretInput).toHaveAttribute("type", "text");
  await editSheet.getByRole("button", { name: "隐藏 Header 密钥值" }).click();
  await expect(secretInput).toHaveAttribute("type", "password");
  await editSheet.getByText("高级设置").click();
  await expect(editSheet.getByText("设为关键依赖")).toBeVisible();
  await expect(editSheet.getByText("开启后，已授权队友在该服务不可用时将停止执行，避免缺少关键工具时继续运行。")).toBeVisible();
  await editSheet.getByRole("button", { name: "清除输入" }).click();
  await expect(secretInput).toHaveValue("");
  await editSheet.getByRole("button", { name: "保存服务" }).click();
  await expect.poll(() => state.mcpServerSecrets.github?.["X-Goog-Api-Key"]).toBeUndefined();
  await expect(serverRow).toContainText("未配置密钥");

  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toHaveCount(0);
  await serverRow.getByRole("button", { name: "同步工具列表" }).click();
  await expect(serverRow).toContainText("工具列表已同步");
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toBeVisible();
  await serverRow.getByRole("button", { name: "收起工具" }).click();
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toHaveCount(0);
  await serverRow.getByRole("button", { name: "展开工具" }).click();
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toBeVisible();
});

test("AI teammate MCP tab groups tools by server with filters", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_engineer", displayName: "工程队友" })];
  state.mcpServers = [createMockMcpServer({ id: "mcp_github", displayName: "GitHub MCP", serverKey: "github" })];
  state.mcpTools = [
    createMockMcpTool({ id: "mcp_tool_search", serverId: "mcp_github", name: "search_repositories", title: "Search repositories" }),
    createMockMcpTool({ id: "mcp_tool_issue", serverId: "mcp_github", name: "create_issue", title: "Create issue", sideEffectLevel: "write" }),
    ...Array.from({ length: 32 }, (_, index) =>
      createMockMcpTool({
        id: `mcp_tool_extra_${index + 1}`,
        serverId: "mcp_github",
        name: `extra_tool_${index + 1}`,
        title: `Extra tool ${index + 1}`,
      })
    ),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "工程队友" }).click();
  const tabNames = await page.getByLabel("AI 队友工作区标签").getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) =>
      Array.from(button.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim()
    )
  );
  expect(tabNames.slice(-2)).toEqual(["设置", "MCP"]);

  await page.getByLabel("AI 队友工作区标签").getByRole("button", { name: "设置" }).click();
  const settingsPanel = page.getByLabel("队友设置");
  await expect(settingsPanel).toBeVisible();
  await expect(settingsPanel).not.toContainText("MCP 工具授权");

  await page.getByLabel("AI 队友工作区标签").getByRole("button", { name: "MCP" }).click();
  const mcpPanel = page.getByLabel("MCP 工具授权");
  await expect(mcpPanel).toBeVisible();
  await expect(mcpPanel).toContainText("只授权这个队友确实需要的 MCP 工具");
  const githubServer = mcpPanel.locator(".teammate-mcp-server-row").filter({ hasText: "GitHub MCP" });
  await expect(githubServer).toBeVisible();
  await expect(githubServer).toContainText("34 个工具");
  await expect(githubServer).toContainText("0 个已授权");
  await expect(mcpPanel.getByLabel("Search repositories")).toHaveCount(0);
  const collapsedMcpLayout = await page.evaluate(() => {
    const pageScroller = document.scrollingElement ?? document.documentElement;
    const panel = document.querySelector(".teammate-mcp-panel");
    const serverRow = document.querySelector(".teammate-mcp-server-row");
    return {
      pageScrolls: pageScroller.scrollHeight > pageScroller.clientHeight + 2,
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : "",
      panelBorderWidth: panel ? getComputedStyle(panel).borderTopWidth : "",
      panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      serverRowHeight: serverRow ? Math.round(serverRow.getBoundingClientRect().height) : 0,
    };
  });
  expect(collapsedMcpLayout.pageScrolls).toBe(false);
  expect(collapsedMcpLayout.panelBackground).toBe("rgba(0, 0, 0, 0)");
  expect(collapsedMcpLayout.panelBorderWidth).toBe("0px");
  expect(collapsedMcpLayout.panelHeight).toBeLessThan(180);
  expect(collapsedMcpLayout.serverRowHeight).toBeLessThan(72);
  await githubServer.getByRole("button", { name: "展开工具" }).click();
  await expect(mcpPanel.getByLabel("Search repositories")).toBeVisible();
  await expect(githubServer.locator(".teammate-toggle.inline-toggle")).toHaveCount(0);
  await expect(githubServer.locator(".teammate-mcp-tool-row")).toHaveCount(34);
  await expect(githubServer.locator(".teammate-mcp-tool-check")).toHaveCount(34);
  const mcpLayout = await page.evaluate(() => {
    const pageScroller = document.scrollingElement ?? document.documentElement;
    const workspace = document.querySelector(".teammate-workspace");
    const list = document.querySelector(".teammate-mcp-server-list");
    const toolTree = document.querySelector(".teammate-mcp-tool-tree");
    const toolList = document.querySelector(".teammate-mcp-tool-list");
    const serverRow = document.querySelector(".teammate-mcp-server-row");
    const serverHeader = document.querySelector(".teammate-mcp-server-header");
    const firstTool = document.querySelector(".teammate-mcp-tool-row");
    const serverHeaderLeft = serverHeader?.getBoundingClientRect().left ?? 0;
    const firstToolLeft = firstTool?.getBoundingClientRect().left ?? 0;
    return {
      pageScrolls: pageScroller.scrollHeight > pageScroller.clientHeight + 2,
      workspaceOverflow: workspace ? getComputedStyle(workspace).overflow : "",
      listOverflowY: list ? getComputedStyle(list).overflowY : "",
      listScrolls: list ? list.scrollHeight > list.clientHeight + 2 : false,
      toolTreeBorderLeftWidth: toolTree ? getComputedStyle(toolTree).borderLeftWidth : "",
      toolIndent: Math.round(firstToolLeft - serverHeaderLeft),
      toolListOverflowY: toolList ? getComputedStyle(toolList).overflowY : "",
      toolListScrolls: toolList ? toolList.scrollHeight > toolList.clientHeight + 2 : false,
      serverRowHeight: serverRow ? Math.round(serverRow.getBoundingClientRect().height) : 0,
    };
  });
  expect(mcpLayout.pageScrolls).toBe(false);
  expect(mcpLayout.workspaceOverflow).toBe("hidden");
  expect(mcpLayout.listOverflowY).toBe("auto");
  expect(mcpLayout.toolTreeBorderLeftWidth).toBe("1px");
  expect(mcpLayout.toolIndent).toBeGreaterThanOrEqual(40);
  expect(mcpLayout.toolListOverflowY).toBe("auto");
  expect(mcpLayout.toolListScrolls).toBe(true);
  expect(mcpLayout.serverRowHeight).toBeLessThan(500);
  const checkboxLayout = await githubServer.locator(".teammate-mcp-tool-row").evaluateAll((rows) =>
    rows.slice(0, 5).map((row) => {
      const cell = row.querySelector(".teammate-mcp-tool-check");
      const checkbox = row.querySelector("input[type='checkbox']");
      const visual = row.querySelector(".teammate-mcp-tool-check-visual");
      const cellBox = cell?.getBoundingClientRect();
      const checkboxBox = checkbox?.getBoundingClientRect();
      const visualBox = visual?.getBoundingClientRect();
      const visualStyle = visual ? getComputedStyle(visual) : undefined;
      return {
        cellWidth: cellBox?.width ?? 0,
        cellHeight: cellBox?.height ?? 0,
        checkboxWidth: checkboxBox?.width ?? 0,
        checkboxHeight: checkboxBox?.height ?? 0,
        visualWidth: visualBox?.width ?? 0,
        visualHeight: visualBox?.height ?? 0,
        visualBorderWidth: visualStyle?.borderTopWidth ?? "",
        visualBackground: visualStyle?.backgroundColor ?? "",
        checkboxInsideCell: Boolean(cellBox && checkboxBox &&
          checkboxBox.left >= cellBox.left &&
          checkboxBox.top >= cellBox.top &&
          checkboxBox.right <= cellBox.right &&
          checkboxBox.bottom <= cellBox.bottom),
        visualInsideCell: Boolean(cellBox && visualBox &&
          visualBox.left >= cellBox.left &&
          visualBox.top >= cellBox.top &&
          visualBox.right <= cellBox.right &&
          visualBox.bottom <= cellBox.bottom),
      };
    })
  );
  for (const item of checkboxLayout) {
    expect(item.cellWidth).toBeGreaterThanOrEqual(24);
    expect(item.cellHeight).toBeGreaterThanOrEqual(24);
    expect(item.checkboxWidth).toBeGreaterThanOrEqual(16);
    expect(item.checkboxHeight).toBeGreaterThanOrEqual(16);
    expect(item.checkboxInsideCell).toBe(true);
    expect(item.visualWidth).toBeGreaterThanOrEqual(16);
    expect(item.visualHeight).toBeGreaterThanOrEqual(16);
    expect(item.visualBorderWidth).toBe("1px");
    expect(item.visualBackground).toBe("rgb(255, 255, 255)");
    expect(item.visualInsideCell).toBe(true);
  }
  await githubServer.getByRole("button", { name: "全选当前 MCP" }).click();
  await expect(githubServer).toContainText("34 个已授权");
  await expect(githubServer.locator(".teammate-mcp-tool-row input:checked")).toHaveCount(34);
  const selectedCheckboxLayout = await githubServer.locator(".teammate-mcp-tool-row.selected").evaluateAll((rows) =>
    rows.slice(0, 5).map((row) => {
      const cell = row.querySelector(".teammate-mcp-tool-check");
      const checkbox = row.querySelector("input[type='checkbox']");
      const visual = row.querySelector(".teammate-mcp-tool-check-visual");
      const cellBox = cell?.getBoundingClientRect();
      const checkboxBox = checkbox?.getBoundingClientRect();
      const visualBox = visual?.getBoundingClientRect();
      const visualStyle = visual ? getComputedStyle(visual) : undefined;
      const tolerance = 0.5;
      return Boolean(checkbox instanceof HTMLInputElement &&
        checkbox.checked &&
        cellBox &&
        checkboxBox &&
        visualBox &&
        checkboxBox.left >= cellBox.left - tolerance &&
        checkboxBox.top >= cellBox.top - tolerance &&
        checkboxBox.right <= cellBox.right + tolerance &&
        checkboxBox.bottom <= cellBox.bottom + tolerance &&
        visualBox.left >= cellBox.left - tolerance &&
        visualBox.top >= cellBox.top - tolerance &&
        visualBox.right <= cellBox.right + tolerance &&
        visualBox.bottom <= cellBox.bottom + tolerance &&
        visualStyle?.backgroundColor === "rgb(14, 122, 99)");
    })
  );
  expect(selectedCheckboxLayout.every(Boolean)).toBe(true);
  await githubServer.getByRole("button", { name: "清空授权" }).click();
  await expect(githubServer).toContainText("0 个已授权");
  await expect(githubServer.locator(".teammate-mcp-tool-row input:checked")).toHaveCount(0);
  await mcpPanel.getByLabel("Search repositories").check();
  await expect(githubServer).toContainText("1 个已授权");
  await githubServer.getByRole("button", { name: "全选当前 MCP" }).click();
  await expect(githubServer).toContainText("34 个已授权");
  await githubServer.getByRole("button", { name: "清空授权" }).click();
  await expect(githubServer).toContainText("0 个已授权");
  await mcpPanel.getByLabel("Search repositories").check();
  await expect(githubServer).toContainText("1 个已授权");
  await githubServer.getByRole("button", { name: "已授权" }).click();
  await expect(mcpPanel.getByLabel("Search repositories")).toBeVisible();
  await expect(mcpPanel.getByLabel("Create issue")).toHaveCount(0);
  await githubServer.getByRole("button", { name: "写入或外部动作" }).click();
  await expect(mcpPanel.getByLabel("Search repositories")).toHaveCount(0);
  await expect(mcpPanel.getByLabel("Create issue")).toBeVisible();
  await githubServer.getByRole("button", { name: "全部" }).click();
  await mcpPanel.getByRole("button", { name: "更新工具授权" }).click();

  await expect(mcpPanel).toContainText("已保存");
  await expect.poll(() =>
    state.teammateMcpBindings.some((binding) =>
      binding.teammateId === "teammate_engineer" &&
      binding.serverId === "mcp_github" &&
      binding.mode === "selected" &&
      binding.selectedToolNames.includes("search_repositories") &&
      binding.enabled
    )
  ).toBe(true);
  expect(state.teammateMcpBindings.some((binding) => binding.selectedToolNames.includes("create_issue"))).toBe(false);
});

test("AI teammates page creates a durable teammate and opens its private workspace", async ({ page }) => {
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
  await expect(page.locator(".teammate-management-grid")).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.getByLabel("Teammate templates")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByText("Ling Engineer")).toHaveCount(0);
  await expect(page.locator(".teammate-command-strip")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
  await expect(page.getByLabel("AI teammate context")).toHaveCount(0);
  await expect(page.getByLabel("Teammate templates").getByRole("button", { name: "Add teammate" })).toBeVisible();
  await page.getByLabel("Teammate templates").getByRole("button", { name: /Product Strategist/ }).click();
  const roleDetail = page.getByRole("dialog", { name: "Role detail" });
  await expect(roleDetail).toBeVisible();
  await expect(roleDetail.getByRole("heading", { name: "Product Strategist" })).toBeVisible();
  await expect(roleDetail.getByText("System prompt")).toBeHidden();
  await expect(roleDetail.locator(".teammate-advanced-detail")).not.toHaveAttribute("open", "");
  await roleDetail.getByRole("button", { name: "Use this role" }).click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toBeVisible();
  await expect(page.getByLabel("Teammate setup steps")).toHaveCount(0);
  await expect(page.getByLabel("Teammate preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Close teammate creator" }).click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toHaveCount(0);
  await page.getByLabel("Teammate templates").getByRole("button", { name: "Add teammate" }).click();
  const creator = page.getByRole("dialog", { name: "Create AI teammate" });
  await expect(creator).toBeVisible();
  await expect(page.getByLabel("Teammate setup steps")).toHaveCount(0);
  await expect(page.getByLabel("Teammate preview")).toHaveCount(0);
  await page.getByLabel("Teammate template chooser").getByRole("button", { name: /Engineer/ }).click();

  await expect(page.getByLabel("Model choices").getByRole("button", { name: /Local Relay/ })).toBeVisible();

  await page.getByLabel("Teammate name").fill("Ling Engineer");
  await page.getByLabel("Description").fill("Owns scoped implementation in the Engineering channel.");
  await creator.getByText("Advanced settings").click();
  await expect(page.getByLabel("Channel choices").getByRole("button", { name: /Engineering/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Create teammate" }).click();

  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row.selected")).toContainText("Ling Engineer");
  await expect(page.getByRole("button", { name: /Private chat/ })).toBeVisible();
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.displayName === "Ling Engineer")).toBe(true);
  await expect.poll(() => state.teammateChannelMemberships.some((item) => isRecord(item) && item.teammateId === "teammate_created_1" && item.channelId === "channel_engineering")).toBe(true);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI Teammates" }).first().click();
  await expect(page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" })).toBeVisible();
  await expect(page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" }).locator(".teammate-status-dot.ready")).toBeVisible();
  await expect(page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" }).getByLabel("Teammate actions")).toBeVisible();
  await expect(page.getByLabel("Workflow")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
});

test("AI teammate private workspace sends blocked chat replies and persists settings", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: teammateId }
      : channel,
  );
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  });
  state.teammateChannelMemberships = [
    {
      teammateId,
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.teammateSkillBindings = [
    {
      teammateId,
      skillId: "implement",
      source: "template",
      enabled: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.teammateMemoryScopes = [
    {
      id: "memory_private",
      teammateId,
      kind: "private-chat-summary",
      enabled: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.memoryObjects = [
    {
      id: "memory_private_acceptance",
      workspaceId: "workspace_default",
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Private acceptance memory",
      body: "Private workspace replies should keep acceptance criteria concise.",
      tags: ["private-chat"],
      sourceRefs: [],
      reviewState: "active",
      enabled: true,
      sensitivity: "private",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.usedMemoryEvents = [
    {
      id: "used_memory_private_acceptance",
      workspaceId: "workspace_default",
      memoryIds: ["memory_private_acceptance"],
      intent: "private-chat",
      recallQuery: "private workspace acceptance criteria",
      teammateId,
      responseId: "tdmsg_2",
      policyVersion: "ling-memory-v1-lexical",
      createdAt: "2026-05-29T00:10:01.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "chmsg_deleted_teammate_history",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "Historical channel reply from a teammate that will be deleted.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-29T00:00:30.000Z",
      updatedAt: "2026-05-29T00:00:30.000Z",
    },
    ...state.channelMessages,
  ];
  state.tasks = [
    {
      id: "task_teammate",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Private workspace task",
      prompt: "Verify teammate private workspace.",
      status: "todo",
      assigneeTeammateId: teammateId,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
    ...state.tasks,
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Ling Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.locator(".brand-mark")).toHaveCount(0);
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Ling Engineer"] });
  await expect(page.getByText("No provider is bound. Private chat will record messages but AI replies may be blocked.")).toBeVisible();
  const privateChatDarkSurfaces = await page.evaluate(() => {
    const selectors = [
      ".teammate-workspace-hero",
      ".teammate-workspace-tabs",
      ".teammate-private-chat",
      ".teammate-empty",
      ".teammate-chat-composer",
      ".teammate-chat-composer .primary-button:disabled",
    ];
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      const color = element ? getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [] : [];
      return {
        selector,
        maxChannel: color.length > 0 ? Math.max(...color) : 255,
      };
    });
  });
  for (const surface of privateChatDarkSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on dark console tokens`).toBeLessThanOrEqual(45);
  }

  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
  await page.locator(".teammate-chat-composer-actions input[type=file]").setInputFiles({
    name: "private-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# private notes"),
  });
  await expect.poll(() => state.teammatePrivateAttachments.length).toBe(1);

  await page.getByPlaceholder("Message this AI teammate privately").fill("Please refine the private workspace acceptance criteria.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Please refine the private workspace acceptance criteria.")).toBeVisible();
  await expect(page.getByText("AI teammate is blocked: No provider preset is selected for this teammate.")).toBeVisible();
  const privateMessageRow = page.locator(".teammate-message-row").filter({ hasText: "Please refine the private workspace acceptance criteria." });
  await expect(privateMessageRow.getByRole("link", { name: "private-notes.md" })).toHaveAttribute("href", /\/attachments\/tpatt_1\/content/);
  await expect(page.getByLabel("Used memory").filter({ hasText: "Private acceptance memory" })).toBeVisible();
  await expect.poll(() => state.teammateDirectMessages.length).toBe(2);
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) =>
      isRecord(item) && item.body === "Please refine the private workspace acceptance criteria."
    );
    return isRecord(message) && Array.isArray(message.attachmentIds) ? message.attachmentIds : [];
  }).toEqual(["tpatt_1"]);

  await page.locator(".teammate-message-row").filter({ hasText: "Please refine the private workspace acceptance criteria." }).getByRole("button", { name: "Create task" }).click();
  await expect(page.locator(".teammate-workspace-tabs").getByRole("button", { name: /Tasks/ })).toHaveClass(/active/);
  await expect.poll(() => {
    const created = state.tasks.find((task) =>
      isRecord(task) &&
      task.prompt === "Please refine the private workspace acceptance criteria." &&
      task.assigneeTeammateId === teammateId
    );
    return isRecord(created) ? created.channelId : undefined;
  }).toBe("channel_engineering");

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: /Tasks/ }).click();
  await expect(page.getByText("Private workspace task")).toBeVisible();
  const taskPanel = page.locator(".teammate-task-create-panel");
  await expect(taskPanel).toContainText("Assigned to Ling Engineer");
  await taskPanel.getByLabel("Task title").fill("Follow up from private workspace");
  await taskPanel.getByLabel("Task prompt").fill("Convert private workspace notes into a scoped implementation task.");
  await taskPanel.getByRole("button", { name: "Create task" }).click();
  await expect(taskPanel).toContainText("Task created for Ling Engineer");
  await expect(page.getByText("Follow up from private workspace")).toBeVisible();
  await expect.poll(() => {
    const created = state.tasks.find((task) =>
      isRecord(task) &&
      task.title === "Follow up from private workspace" &&
      task.assigneeTeammateId === teammateId
    );
    return isRecord(created) ? created.channelId : undefined;
  }).toBe("channel_engineering");

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: /Channels/ }).click();
  await expect(page.getByText("Engineering").first()).toBeVisible();
  const designRow = page.locator(".teammate-channel-row").filter({ hasText: "Design" });
  await expect(designRow).toContainText("Not joined");
  await designRow.getByRole("button", { name: "Join" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
  )).toBe(true);
  await designRow.getByRole("button", { name: "Set default" }).click();
  await expect.poll(() => {
    const design = state.channels.find((channel) => isRecord(channel) && channel.id === "channel_design");
    return isRecord(design) ? design.defaultTeammateId : undefined;
  }).toBe(teammateId);
  await expect.poll(() => {
    const membership = state.teammateChannelMemberships.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
    );
    return isRecord(membership) ? membership.isDefault : false;
  }).toBe(true);
  const engineeringRow = page.locator(".teammate-channel-row").filter({ hasText: "Engineering" });
  await engineeringRow.getByRole("button", { name: "Leave" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_engineering"
  )).toBe(false);

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: /Skills/ }).click();
  const skillsPanel = page.locator(".teammate-skills-panel");
  await expect(skillsPanel).toContainText("1 bound");
  const skillsDarkSurfaces = await page.evaluate(() => {
    const selectors = [".teammate-skill-add-row", ".teammate-skill-row", ".teammate-skills-panel .phase-token"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const color = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
        return {
          selector,
          maxChannel: color.length > 0 ? Math.max(...color) : 255,
        };
      }),
    );
  });
  expect(skillsDarkSurfaces.length).toBeGreaterThan(0);
  for (const surface of skillsDarkSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on dark console tokens`).toBeLessThanOrEqual(45);
  }
  const engineeringReviewRow = skillsPanel.locator(".teammate-skill-row").filter({ has: page.getByText("Engineering Plan Review", { exact: true }) });
  await expect(engineeringReviewRow).toContainText("Available skill");
  await engineeringReviewRow.getByRole("button", { name: "Bind skill" }).click();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.skillId === "plan-eng-review" && item.enabled === true
  )).toBe(true);
  await expect(skillsPanel).toContainText("Skills updated");
  const implementationRow = skillsPanel.locator(".teammate-skill-row").filter({ has: page.getByText("Implementation", { exact: true }) });
  await expect(implementationRow.getByRole("button", { name: "Delete skill" })).toHaveCount(0);
  await implementationRow.getByRole("button", { name: "Disable skill" }).click();
  await expect.poll(() => {
    const binding = state.teammateSkillBindings.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.skillId === "implement"
    );
    return isRecord(binding) ? binding.enabled : undefined;
  }).toBe(false);
  await skillsPanel.getByLabel("Draft name").fill("Custom QA Pack");
  await skillsPanel.getByLabel("Source path").fill("skills/custom-qa/SKILL.md");
  await skillsPanel.getByLabel("Skill content").fill([
    "# Custom QA Drill",
    "id: custom-qa-drill",
    "summary: Run a focused QA pass for private workspace changes.",
    "Keep approval and secret instructions as review-only text.",
  ].join("\n"));
  await skillsPanel.getByRole("button", { name: "Preview draft" }).click();
  await expect(skillsPanel).toContainText("custom-qa-drill");
  await expect(skillsPanel).toContainText("Permission-like instruction");
  await skillsPanel.getByRole("button", { name: "Publish to registry" }).click();
  await expect.poll(() => state.skillRegistryEntries.some((item) =>
    isRecord(item) && item.id === "custom-qa-drill" && item.reviewStatus === "published"
  )).toBe(true);
  await expect(skillsPanel).toContainText("Published 1 skills");
  await skillsPanel.getByLabel("Bind registry skill").fill("custom-qa-drill");
  await skillsPanel.locator(".teammate-skill-add-row").getByRole("button", { name: "Bind skill" }).click();
  await expect.poll(() => {
    const binding = state.teammateSkillBindings.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.skillId === "custom-qa-drill"
    );
    return isRecord(binding) ? [binding.source, binding.enabled] : undefined;
  }).toEqual(["user", true]);
  const customSkillRow = skillsPanel.locator(".teammate-skill-row").filter({ has: page.getByText("Custom QA Drill", { exact: true }) });
  await expect(customSkillRow).toContainText("User skill");
  await customSkillRow.getByRole("button", { name: "Delete skill" }).click();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.skillId === "custom-qa-drill"
  )).toBe(false);
  await expect(customSkillRow).toContainText("Registry skill");
  await customSkillRow.getByRole("button", { name: "Archive skill" }).click();
  await expect.poll(() => state.skillRegistryEntries.some((item) =>
    isRecord(item) && item.id === "custom-qa-drill" && item.reviewStatus === "archived"
  )).toBe(true);

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: /Tasks/ }).click();
  await taskPanel.getByLabel("Task title").fill("Skill aware follow up");
  await taskPanel.getByLabel("Requested skill").selectOption("plan-eng-review");
  await taskPanel.getByLabel("Task prompt").fill("Use the selected skill for this teammate task.");
  await taskPanel.getByRole("button", { name: "Create task" }).click();
  await expect(taskPanel).toContainText("Skill plan-eng-review");
  await expect.poll(() => {
    const created = state.tasks.find((task) =>
      isRecord(task) &&
      task.title === "Skill aware follow up" &&
      task.assigneeTeammateId === teammateId
    );
    return isRecord(created) ? created.requestedSkillId : undefined;
  }).toBe("plan-eng-review");

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: /Memory/ }).click();
  await expect(page.getByText("Private chat summary")).toBeVisible();

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Teammate name").fill("Renamed Engineer");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.displayName : "";
  }).toBe("Renamed Engineer");

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Renamed Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Renamed Engineer", level: 1 })).toBeVisible();
  await expect(page.getByText("AI teammate is blocked: No provider preset is selected for this teammate.")).toBeVisible();

  await page.locator(".teammate-workspace-tabs").getByRole("button", { name: "Settings" }).click();
  const personaPanel = page.getByLabel("Persona import");
  await personaPanel.getByLabel("Source path").fill("AGENTS.md");
  await personaPanel.getByLabel("Persona content").fill([
    "# Imported QA Persona",
    "Review private workspace changes carefully.",
    "Do not grant tools, approvals, secrets, or external send permissions.",
  ].join("\n"));
  await personaPanel.getByRole("button", { name: "Preview draft" }).click();
  await expect(personaPanel.getByText("Draft ready")).toBeVisible();
  await expect(personaPanel.getByText("Permission-like persona text was ignored for authority changes.")).toBeVisible();
  await personaPanel.getByRole("button", { name: "Apply persona draft" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? [teammate.displayName, teammate.allowedTools, teammate.approvalProfile] : undefined;
  }).toEqual(["Imported QA Persona", ["read", "grep", "find", "ls"], { mode: "standard", risk: "medium" }]);
  await expect(page.getByRole("heading", { name: "Imported QA Persona", level: 1 })).toBeVisible();

  await page.getByLabel("Avatar").locator("input[type=file]").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("png"),
  });
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : undefined;
  }).toBe("tpatt_2");
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image")).toBeVisible();

  await page.getByRole("button", { name: "Remove avatar" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : "missing";
  }).toBeUndefined();
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image")).toHaveCount(0);

  await page.getByPlaceholder("Reason").fill("owner request");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Hard delete this teammate");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Hard delete" }).click();
  await expect.poll(() => state.retentionTombstones.length).toBe(1);
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.id === teammateId)).toBe(false);
  await expect.poll(() => state.teammatePrivateAttachments.some((item) => isRecord(item) && item.teammateId === teammateId)).toBe(false);
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Renamed Engineer" })).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  const deletedHistoryMessage = page.locator(".message-group").filter({ hasText: "Historical channel reply from a teammate that will be deleted." });
  await expect(deletedHistoryMessage).toContainText("Deleted teammate");
  await expect(deletedHistoryMessage).not.toContainText(teammateId);
});

test("workspace path initializes from daemon default without showing the path field", async ({ page }) => {
  const daemonCwd = "/tmp/daemon-default-workspace";
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), { defaultWorkspaceCwd: daemonCwd });
  await page.goto("/");

  await expect(page.getByLabel("Workspace path")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
});

test("saved workspace path wins over daemon default", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.workspaceCwd", "/tmp/saved-workspace");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), {
    defaultWorkspaceCwd: "/tmp/daemon-default-workspace",
  });
  await page.goto("/");

  await expect(page.getByLabel("Workspace path")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.workspaceCwd"))).toBe("/tmp/saved-workspace");
});

test("settings approval policy loads, edits, and saves tool decisions and write paths", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Approval policy/ }).click();
  const settingsPanel = page.locator(".settings-panel").filter({ hasText: "Approval policy" });
  await expect(page.getByRole("heading", { name: "Approval policy" })).toBeVisible();
  await expect(settingsPanel).not.toContainText("workspace_default");

  const bashDecision = settingsPanel.locator(".policy-tool-row").filter({ hasText: "bash" }).locator("select");
  await expect(bashDecision).toHaveValue("ask");
  await bashDecision.selectOption("deny");
  await settingsPanel.getByText("Advanced settings").click();
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

test("settings external work status shows setup and explicit controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("External work");
  await expect(panel).toContainText("openclaw/openclaw");
  await expect(panel).toContainText("configured");
  await expect(panel).toContainText("not_configured");
  await expect.poll(() => state.externalWorkPollCalls.github ?? 0).toBe(0);
  await expect.poll(() => state.externalWorkBackgroundStartCalls).toBe(0);
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(0);
  await expect.poll(() => state.externalActionExecuteCalls.external_work_action_1 ?? 0).toBe(0);

  await panel.getByRole("button", { name: "Poll once" }).click();
  await expect.poll(() => state.externalWorkPollCalls.github ?? 0).toBe(1);

  await panel.getByRole("button", { name: "Reconcile" }).click();
  await expect.poll(() => state.externalWorkReconcileCalls).toBe(1);

  await panel.getByRole("button", { name: "Start background" }).click();
  await expect.poll(() => state.externalWorkBackgroundStartCalls).toBe(1);
  await expect(panel).toContainText("running");
  await expect(panel.getByRole("button", { name: "Stop background" })).toBeVisible();

  await panel.getByRole("button", { name: "Stop background" }).click();
  await expect.poll(() => state.externalWorkBackgroundStopCalls).toBe(1);
  await expect(panel).toContainText("stopped");

  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);
  await expect(panel).toContainText("openclaw/openclaw");
});

test("settings external work token setup saves to daemon and clears the input", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({ secretStatus: "missing" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("External token");
  await expect(panel).toContainText("env:GITHUB_TOKEN");
  await expect.poll(() => state.externalWorkSecretConfigureCalls).toBe(0);
  await expect.poll(() => state.externalWorkSecretDeleteCalls).toBe(0);

  const tokenInput = panel.getByLabel("Token");
  await tokenInput.fill("test-github-token");
  await panel.getByRole("button", { name: "Save GitHub token" }).click();

  await expect.poll(() => state.externalWorkSecretConfigureCalls).toBe(1);
  await expect.poll(() => state.lastExternalWorkSecretConfigure?.channelId).toBe("channel_engineering");
  await expect.poll(() => state.lastExternalWorkSecretConfigure?.tokenLength).toBe("test-github-token".length);
  await expect(tokenInput).toHaveValue("");
  await expect(panel).toContainText("keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");
  await expect(panel).toContainText("configured");

  await panel.getByRole("button", { name: "Remove token" }).click();
  await expect.poll(() => state.externalWorkSecretDeleteCalls).toBe(1);
  await expect(panel).toContainText("missing");
  await expect(panel).toContainText("Secret is not configured: keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");
});

test("settings external work status renders invalid, missing, and Linear states", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({
    workflowValid: false,
    workflowError: "source.kind is required",
    secretStatus: "missing",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("invalid");
  await expect(panel).toContainText("source.kind is required");
  await expect(panel).toContainText("Secret is not configured");
  await expect(panel).toContainText("Create WORKFLOW.md");
  await expect(panel.getByRole("button", { name: "Poll once" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Save GitHub token" })).toBeDisabled();
  await panel.getByRole("button", { name: "Repair WORKFLOW.md" }).click();
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(1);
  await expect.poll(() => state.lastExternalWorkWorkflowConfigure?.repository).toBe("openclaw/openclaw");
  await expect(panel.getByLabel("Token")).toBeEnabled();

  state.externalWorkStatus = createExternalWorkStatus({ workflowExists: false, workflowValid: false, sourceKind: "unknown", workflowError: "WORKFLOW.md was not found" });
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel).toContainText("missing");
  await expect(panel).toContainText("WORKFLOW.md was not found");
  await panel.getByLabel("Repository").fill("https://github.com/owner/repo");
  await panel.getByRole("button", { name: "Create WORKFLOW.md" }).click();
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(2);
  await expect.poll(() => state.lastExternalWorkWorkflowConfigure?.repository).toBe("owner/repo");
  await expect(panel.getByLabel("Token")).toBeEnabled();

  state.externalWorkStatus = createExternalWorkStatus({ sourceKind: "linear" });
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel).toContainText("linear");
  await expect(panel).toContainText("ling-stack");
  await expect(panel).toContainText("unsupported");
  await expect(panel.getByRole("button", { name: "Start background" })).toHaveCount(0);

  await panel.getByRole("button", { name: "Poll once" }).click();
  await expect.poll(() => state.externalWorkPollCalls.linear ?? 0).toBe(1);
});

test("workspace defaults do not hardcode personal machine paths", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const e2eSource = await readFile(new URL("./app.spec.ts", import.meta.url), "utf8");
  const personalPath = ["/Users", "tianxiao", "ling-stack"].join("/");

  expect(appSource).not.toContain(personalPath);
  expect(e2eSource).not.toContain(personalPath);
});

test("sidebar selection is exclusive and conversation lists no longer live in global navigation", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await expect(navigation.getByText("Ada")).toHaveCount(0);
  await expect(navigation.getByText("Tian")).toHaveCount(0);
  await navigation.getByRole("button", { name: "AI Teammates" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["AI Teammates"], selectedRows: [] });
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(navigation).toHaveClass(/channel-left-drawer/);
  await expect(page.locator(".channel-sidebar-toolbar")).toBeVisible();
  await expect(page.locator(".channel-left-drawer .primary-nav")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".channel-left-drawer .sidebar-row.selected")).toHaveCount(0);

  await navigation.locator('.sidebar-row:has(.avatar-initial):has-text("Designer")').click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Designer"] });
  const selectedTeammateRow = page.locator(".channel-left-drawer .sidebar-row.selected");
  await expect(selectedTeammateRow).toHaveCSS("background-color", "rgb(245, 245, 245)");
  expect(await selectedTeammateRow.evaluate((row) => getComputedStyle(row, "::before").content)).toBe("none");
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
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
  await expect(page.getByLabel("Model Workbench context")).toHaveCount(0);
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByRole("heading", { name: "External work" })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Media Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Media jobs", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Media job status")).toBeVisible();
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

  await openNewTaskPanel(page);
  await page.getByLabel("New task").getByLabel("Title").fill("Design inspector behavior");
  await page.getByLabel("New task").getByLabel("Prompt").fill("Make the inspector follow the selected task.");
  await page.getByLabel("New task").getByRole("button", { name: "Create task" }).click();

  await expect.poll(() => state.tasks.some((task) => isRecord(task) && task.title === "Design inspector behavior")).toBe(true);
  await expect(page.locator("article.task-detail")).toContainText("Design inspector behavior");
  await expect(page.locator("article.task-detail")).toContainText("Design inspector behavior");
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
    createChatProvider({
      id: "provider_legacy_openai",
      kind: "openai",
      displayName: "Legacy OpenAI Without Stored Endpoint",
      providerId: "openai",
      model: "gpt-5.4",
      api: "openai-completions",
      baseUrl: undefined,
    }),
    createChatProvider({
      id: "provider_openai_proxy",
      kind: "openai",
      displayName: "OpenAI Proxy Custom Endpoint",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "http://192.168.80.114:8317/v1",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
    }),
    createMediaProvider(),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
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
        baseUrl: "https://api.openai.com/v1",
        apiKeyRef: "env:OPENAI_API_KEY",
        capabilities: ["chat", "tool_call", "reasoning"],
        input: ["text"],
        enabled: false,
        authHeader: true,
        reasoning: true,
      },
      {
        templateId: "anthropic-claude",
        description: "Official Anthropic endpoint.",
        kind: "anthropic",
        displayName: "Claude",
        providerId: "anthropic",
        model: "claude-sonnet-4-5",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyRef: "env:ANTHROPIC_API_KEY",
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
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const missingKeyGatewayRow = page.locator(".provider-row").filter({ hasText: "Missing Key Gateway" });
  await expect(missingKeyGatewayRow).toContainText("key missing");
  await expect(missingKeyGatewayRow.locator(".provider-state.enabled")).toHaveCount(0);
  await expect(missingKeyGatewayRow.locator(".provider-state.key-missing")).toHaveCount(1);
  await expect(missingKeyGatewayRow.locator(".provider-state.run-blocked")).toHaveCount(0);
  await expect(missingKeyGatewayRow.locator(".provider-state.check-bad")).toHaveCount(0);
  await expect(page.locator(".provider-row").filter({ hasText: "Unchecked Domestic Gateway" })).toContainText("unchecked");
  await expect(page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" })).toContainText("auth failed");
  const readyLocalRelayRow = page.locator(".provider-row").filter({ hasText: "Ready Local Relay" });
  await expect(readyLocalRelayRow).toContainText("check ready");
  await expect(readyLocalRelayRow.getByRole("button", { name: "Stop using" })).toBeVisible();
  await readyLocalRelayRow.getByRole("button", { name: "Stop using" }).click();
  await expect(readyLocalRelayRow.getByRole("button", { name: "Use" })).toBeVisible();
  await expect.poll(() =>
    state.channels.every((channel) => !isRecord(channel) || channel.defaultProviderPresetId === undefined)
  ).toBe(true);
  await expect(readyLocalRelayRow.locator(".provider-state.enabled")).toHaveCount(0);
  await expect(readyLocalRelayRow.locator(".provider-state.disabled")).toHaveCount(1);
  await expect(page.locator(".provider-row").filter({ hasText: "Seedream Image" })).toContainText("Coding task: blocked");
  const legacyOpenAiRow = page.locator(".provider-row").filter({ hasText: "Legacy OpenAI Without Stored Endpoint" });
  await expect(legacyOpenAiRow).toContainText("https://api.openai.com/v1");
  await legacyOpenAiRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.openai.com/v1");
  await expect(page.getByLabel("Provider ID")).toBeDisabled();
  await expect(page.getByLabel("API protocol")).toBeDisabled();
  await page.getByRole("button", { name: "Close model preset editor" }).click();
  const openAiProxyRow = page.locator(".provider-row").filter({ hasText: "OpenAI Proxy Custom Endpoint" });
  await openAiProxyRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Base URL")).toHaveValue("http://192.168.80.114:8317/v1");
  await expect(page.getByLabel("Provider ID")).toBeEnabled();
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await page.getByRole("button", { name: "Close model preset editor" }).click();
  await expect(openAiProxyRow.getByRole("button", { name: "Use" })).toBeVisible();
  await openAiProxyRow.getByRole("button", { name: "Use" }).click();
  await expect.poll(() =>
    state.channels.some((channel) =>
      isRecord(channel) &&
      channel.id === "channel_engineering" &&
      channel.defaultProviderPresetId === "provider_openai_proxy"
    )
  ).toBe(true);
  await expect(openAiProxyRow.getByRole("button", { name: "Stop using" })).toBeVisible();
  await expect(openAiProxyRow.locator(".provider-state.enabled")).toHaveCount(1);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Model Workbench" }).click();
  const reloadedOpenAiProxyRow = page.locator(".provider-row").filter({ hasText: "OpenAI Proxy Custom Endpoint" });
  await expect(reloadedOpenAiProxyRow.getByRole("button", { name: "Stop using" })).toBeVisible();
  await expect(reloadedOpenAiProxyRow.locator(".provider-state.enabled")).toHaveCount(1);
  await expect(page.getByText(/Ready: .* passed preflight/)).toHaveCount(0);
  await expect(page.getByText("All saved chat providers are either preflight-ready or intentionally out of the run path.")).toHaveCount(0);

  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("dialog", { name: "New preset" })).toBeVisible();
  await page.getByRole("button", { name: /Custom OpenAI-compatible/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("Custom OpenAI-compatible");
  await expect(page.getByRole("tab", { name: /OpenAI-compatible relay/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^GPT/ }).click();
  await page.getByRole("button", { name: /OpenAI GPT/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("OpenAI GPT");
  await expect(page.locator(".provider-template-panel")).not.toContainText("Claude");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.openai.com/v1");
  await expect(page.getByLabel("API protocol")).toBeDisabled();
  await page.getByRole("tab", { name: /^Claude/ }).click();
  await page.getByRole("button", { name: /Claude/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("Claude");
  await expect(page.locator(".provider-template-panel")).not.toContainText("OpenAI GPT");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.anthropic.com/v1");
  await expect(page.getByLabel("API protocol")).toBeDisabled();
  await expect(page.getByLabel("Enabled")).toBeChecked();
  await page.getByRole("tab", { name: /Custom access/ }).click();
  await page.getByRole("button", { name: /Custom OpenAI-compatible/ }).click();
  await expect(page.locator(".provider-template-card.selected")).toContainText("Custom OpenAI-compatible");
  await expect(page.getByLabel("Provider name")).toHaveValue("Custom OpenAI-compatible");
  await expect(page.getByLabel("Provider ID")).toHaveValue("custom-openai-compatible");
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await page.getByLabel("API key", { exact: true }).fill("test-visible-key");
  const apiKeyVisibilityButton = page.getByRole("button", { name: "Hide API key" });
  await expect(apiKeyVisibilityButton.locator(".lucide-eye")).toBeVisible();
  await apiKeyVisibilityButton.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  const showApiKeyButton = page.getByRole("button", { name: "Show API key" });
  await expect(showApiKeyButton.locator(".lucide-eye-off")).toBeVisible();
  await showApiKeyButton.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Clear API key" })).toHaveCount(0);
  const inlineClearButton = page.locator(".provider-secret-input .provider-secret-clear");
  await expect(inlineClearButton).toBeVisible();
  await expect(page.getByText("Advanced env/keychain")).toHaveCount(0);
  await expect(page.getByText("env:CUSTOM_MODEL_API_KEY")).toHaveCount(0);
  await page.getByRole("button", { name: "Fetch models" }).click();
  const modelCards = page.locator(".provider-model-card");
  await expect(modelCards).toHaveCount(2);
  await expect(modelCards.filter({ hasText: "Custom model" })).toHaveCount(0);
  await expect(modelCards.filter({ hasText: "cliproxy-gpt-4o" })).toBeVisible();
  await modelCards.filter({ hasText: "cliproxy-claude-sonnet" }).click();
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveValue("cliproxy-claude-sonnet");
  await expect(page.getByLabel("Capabilities")).toHaveValue("chat, tool_call, reasoning");

  await page.getByRole("button", { name: "Save" }).click();
  const customProviderRow = page.locator(".provider-row").filter({ hasText: "Custom OpenAI-compatible" });
  await expect(customProviderRow).not.toContainText("Saved locally");
  await expect(customProviderRow).toContainText("key ready");
  await expect(customProviderRow).toContainText("check ready");
  await expect(customProviderRow.locator(".provider-meta-line").first()).toContainText("Model:");
  await expect(customProviderRow.locator(".provider-meta-line").first()).toContainText("API protocol:");
  await expect(customProviderRow.locator(".provider-meta-line").first()).not.toContainText("custom-openai-compatible");
  await expect(customProviderRow.getByRole("button", { name: "Stop using" })).toBeVisible();
  await customProviderRow.getByRole("button", { name: "Stop using" }).click();
  await expect(customProviderRow.getByRole("button", { name: "Use" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New preset" })).toHaveCount(0);
  await expect.poll(() =>
    state.providers.some((provider) =>
      isRecord(provider) &&
      provider.displayName === "Custom OpenAI-compatible" &&
      typeof provider.apiKeyRef === "string" &&
      provider.apiKeyRef.startsWith("local:provider_created_") &&
      provider.apiKeyConfigured === true &&
      !("apiKey" in provider)
    )
  ).toBe(true);

  await customProviderRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
  await expect(page.getByLabel("Provider ID")).toBeEnabled();
  await expect(page.getByLabel("API protocol")).toBeEnabled();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("test-visible-key");
  await expect(page.getByRole("button", { name: "Hide API key" }).locator(".lucide-eye")).toBeVisible();
  await page.locator(".provider-secret-input .provider-secret-clear").click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog", { name: "Edit preset" }).getByText("API key missing. Add an API key before running a live check.")).toBeVisible();
  await expect(customProviderRow).toContainText("key ready");
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

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await openNewTaskPanel(page);
  const providerSelect = page.locator("label.field").filter({ hasText: "Run provider" }).locator("select");
  await expect(providerSelect.locator("option").filter({ hasText: "Ready Local Relay" })).toHaveCount(1);
  await expect(providerSelect.locator("option").filter({ hasText: "Missing Key Gateway" })).toHaveCount(1);
  await expect(providerSelect.locator("option").filter({ hasText: "Seedream Image" })).toHaveCount(0);
  await expect(page.getByText("Media providers stay in Media Jobs and cannot run coding tasks.").first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.runs.some((run) => run.id === "run_2")).toBe(true);
  await expect(page.locator(".task-detail")).toContainText("Latest run");
  await expect(page.locator(".task-detail")).not.toContainText("run_2");
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

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await openNewTaskPanel(page);
  const providerSelect = page.locator("label.field").filter({ hasText: "Run provider" }).locator("select");
  await expect(providerSelect).toHaveValue("provider_ready");
  await page.getByRole("button", { name: "Cancel" }).click();

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator(".task-detail").getByRole("button", { name: "Run", exact: true }).click();

  await expect.poll(() => state.runs[0]?.providerPresetId).toBe("provider_ready");
  await expect(page.locator(".task-detail")).toContainText("Latest run");
  await expect(page.locator(".task-detail")).not.toContainText("run_1");
});

test("workspace task detail actions only show a spinner on the clicked action", async ({ page }) => {
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
  state.runResponseDelayMs = 2000;
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskDetail = page.locator("article.task-detail");
  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();

  await expect(taskDetail.getByRole("button", { name: "Run", exact: true }).locator(".spin")).toHaveCount(1);
  await expect(taskDetail.getByRole("button", { name: "Check & run", exact: true }).locator(".spin")).toHaveCount(0);
  await expect(page.locator(".task-actions .spin")).toHaveCount(1);

  await expect.poll(() => state.runs[0]?.taskId).toBe("task_inspect");

  state.tasks = state.tasks.map((task) =>
    isRecord(task) ? { ...task, status: "todo", currentRunId: undefined } : task
  );
  state.runs = [];
  state.providerCheckDelayMs = 2000;
  await taskDetail.getByRole("button", { name: "Check & run", exact: true }).click();

  await expect(taskDetail.getByRole("button", { name: "Check & run", exact: true }).locator(".spin")).toHaveCount(1);
  await expect(taskDetail.getByRole("button", { name: "Run", exact: true }).locator(".spin")).toHaveCount(0);
  await expect(page.locator(".task-actions .spin")).toHaveCount(1);
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

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await expect(page.getByText("Task complete").first()).toBeVisible();

  const taskDetail = page.locator("article.task-detail");
  await expect(taskDetail).toContainText("Task complete");
  await expect(taskDetail.getByRole("button", { name: "View result" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run activity" })).toHaveCount(0);
  await expect(taskDetail).not.toContainText("AI is analyzing the task");
  await expect(taskDetail).not.toContainText("Read package.json");
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
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
  await page.getByRole("button", { name: "Save" }).click();

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

  await expect(disabledRow.locator(".provider-state.enabled")).toHaveCount(0);
  await expect(disabledRow.getByRole("button", { name: "Use" })).toBeVisible();
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
  await page.getByRole("button", { name: /Inspect workspace/ }).click();
  const providerRepair = page.locator(".run-repair-hint.providers");
  await expect(providerRepair).toContainText("Provider repair needed");
  await providerRepair.getByRole("button", { name: "Model Workbench" }).click();

  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Provider name")).toHaveValue("Auth Failed Gateway");
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

test("external action approval card requires explicit execute after approval", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const { action } = addExternalActionApproval(state);
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub comment" });
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_comment");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("tianxiaochannel-oss88/ling-stack");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_pull_request #42");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("Looks good from Ling.");
  await expect(externalApproval.getByLabel("External action artifacts")).toContainText("Approval preview");
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);

  await externalApproval.getByRole("button", { name: "Approve" }).click();
  await expect(externalApproval).toContainText("approved");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(0);
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toBeVisible();

  await externalApproval.getByRole("button", { name: "Execute action" }).click();
  await expect(externalApproval).toContainText("succeeded");
  await expect(externalApproval.getByLabel("External action artifacts")).toContainText("GitHub action execution result");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(1);
});

test("external action approval card shows strict GitHub PR review audit", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const { action } = addExternalActionApproval(state, {
    kind: "github_pr_review",
    reviewEvent: "REQUEST_CHANGES",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub PR review" });
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_pr_review");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("REQUEST_CHANGES");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("Please fix the failing CI before merge.");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_pull_request #42");
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);

  await externalApproval.getByRole("button", { name: "Approve" }).click();
  await externalApproval.getByLabel("Decision reason").fill("Strict PR review approved.");
  await externalApproval.getByRole("button", { name: "Confirm approve" }).click();
  await expect(externalApproval).toContainText("approved");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(0);
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toBeVisible();
});

test("external action approval card can cancel without executing", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const { action } = addExternalActionApproval(state);
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub comment" });
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);

  await externalApproval.getByRole("button", { name: "Cancel proposal" }).click();
  await expect(externalApproval).toContainText("cancelled");
  await expect(externalApproval).toContainText("Action cancelled");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(0);
});

test("external action approval card shows stale target audit as read-only", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  addExternalActionApproval(state, { status: "stale_target", approvalStatus: "approved" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub comment" });
  await expect(externalApproval.getByLabel("External action audit")).toContainText("stale_target");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("PR head SHA changed before execution.");
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);
  await expect(externalApproval.getByRole("button", { name: "Cancel proposal" })).toHaveCount(0);
});

test("workspace surfaces GitHub CI triage records without starting runs", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const linkedTriage = addExternalWorkCiTriage(state);
  addExternalWorkCiTriage(state, {
    id: "ci_triage_stale",
    status: "stale",
    taskId: "task_other",
    runId: "run_other",
    checkName: "integration-tests",
    lastErrorMessage: "PR head moved before the fix task was reviewed.",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const workspaceTriage = page.locator(".channel-activity-tools .ci-triage-panel").first();
  await expect(workspaceTriage).toContainText("GitHub CI triage");
  await expect(workspaceTriage).toContainText("unit-tests");
  await expect(workspaceTriage).toContainText("tianxiaochannel-oss88/ling-stack");
  await expect(workspaceTriage).toContainText("PR #42");
  await expect(workspaceTriage).toContainText("corepack pnpm test");
  await expect(workspaceTriage).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await expect(workspaceTriage).toContainText("CI failure log");
  await expect(workspaceTriage).toContainText("stale");

  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(workspaceTriage.getByRole("button", { name: "Open run" }).first()).toBeVisible();
  await expect.poll(() => state.ciTriageRunCalls[linkedTriage.triage.id] ?? 0).toBe(0);
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
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

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

test("workspace task run sends the selected session permission mode", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Relay",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-05-25T00:11:00.000Z" },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  state.runs = [];
  state.tasks = state.tasks.map((task) =>
    isRecord(task) && task.id === "task_inspect"
      ? { ...task, status: "todo", currentRunId: undefined }
      : task
  );
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskDetail = page.locator("article.task-detail");
  await expect(taskDetail.getByLabel("Permission mode")).toBeVisible();
  await taskDetail.getByLabel("Permission mode").selectOption("workspace_write");
  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();

  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.permissionMode : undefined;
  }).toBe("workspace_write");
});

test("workspace full access task run requires confirmation and sends confirmation evidence", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready",
      displayName: "Ready Relay",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-05-25T00:11:00.000Z" },
    }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) ? { ...channel, defaultProviderPresetId: "provider_ready" } : channel
  );
  state.runs = [];
  state.tasks = state.tasks.map((task) =>
    isRecord(task) && task.id === "task_inspect"
      ? { ...task, status: "todo", currentRunId: undefined }
      : task
  );
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const taskDetail = page.locator("article.task-detail");
  await taskDetail.getByLabel("Permission mode").selectOption("full_access");
  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();

  const confirmSheet = page.getByRole("dialog", { name: "Confirm full access" });
  await expect(confirmSheet).toBeVisible();
  await confirmSheet.getByRole("button", { name: "Cancel" }).last().click();
  await expect(confirmSheet).toHaveCount(0);
  expect(state.runs).toHaveLength(0);

  await taskDetail.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("dialog", { name: "Confirm full access" }).getByRole("button", { name: "Start with full access" }).click();

  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.permissionConfirmation : undefined;
  }).toMatchObject({
    mode: "full_access",
    confirmed: true,
    reason: "user_confirmed_full_access",
  });
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: /Inspect workspace/ }).click();

  const detail = page.getByLabel("Run detail");
  await expect(detail).toContainText("Workspace write");
  await detail.getByRole("button", { name: "Stop" }).click();
  await expect(detail.getByRole("button", { name: "Stopping" })).toBeVisible();
  await expect.poll(() => state.workUnits.find((unit) => unit.id === "wu_running")?.status).toBe("cancelled");
  await expect.poll(() => state.runs.find((run) => run.id === "run_failed")?.status).toBe("cancelled");
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_1")?.status).toBe("cancelled");
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
  await expect(mediaApproval).toContainText("media job");
  await expect(mediaApproval.getByLabel("Media cost approval summary")).not.toContainText("provider_seedream");
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
      element.querySelector("span:not(.avatar-initial):not(.sidebar-hash):not(.channel-mention):not(.channel-unread)")?.textContent?.trim() ?? "";

    return {
      activeNav: [...document.querySelectorAll(".nav-item.active")].map(navLabel),
      selectedRows: [...document.querySelectorAll(".sidebar-row.selected")].map(rowLabel),
    };
  });
}

async function openChannelTasksTab(page: Page): Promise<void> {
  await openChannelSidePanel(page, "Progress");
}

async function openTaskFromAttentionQueue(page: Page, title: string): Promise<void> {
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

async function openNewTaskPanel(page: Page): Promise<void> {
  await openChannelTasksTab(page);
  await page.locator(".channel-side-panel").hover();
  await page.getByRole("button", { name: "New task" }).click();
}

async function openChannelFilesPanel(page: Page): Promise<void> {
  await openChannelSidePanel(page, "Files");
}

async function openChannelContextPanel(page: Page): Promise<void> {
  await openChannelSidePanel(page, "Context");
}

async function openChannelSidePanel(page: Page, name: "Progress" | "Files" | "Context" | "Settings"): Promise<void> {
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

async function openChannelChatTools(page: Page): Promise<void> {
  const searchInput = page.getByPlaceholder(/Search activity|搜索动态/).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await searchInput.isVisible().catch(() => false)) {
      return;
    }
    await page.locator(".channel-more-button").click();
    await page.locator(".channel-more-item").filter({ hasText: /Activity filters|动态筛选/ }).click();
    await page.waitForTimeout(50);
  }
  await expect(searchInput).toBeVisible();
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

async function readHorizontalOverflow(page: Page, selector: string): Promise<string[]> {
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
    providerSecrets: {},
    mcpServers: [],
    mcpTools: [],
    mcpServerSecrets: {},
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
    workUnits: [],
    runtimeSemaphoreSlots: [],
    runtimeEventsByWorkUnit: {},
    workUnitAttemptsByWorkUnit: {},
    resourceLeases: [],
    stateTransitions: [],
    artifactsByRun: {},
    artifactsByMediaJob: {},
  };
}

function buildMockSkillRegistryEntries(): unknown[] {
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

function buildMockEffectiveSkills(state: MockState, teammateId: string): unknown[] {
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

function createMockSkillImportDraft(state: MockState, body: Record<string, unknown>): Record<string, unknown> {
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

function createMockPersonaDraft(teammateId: string, body: Record<string, unknown>): Record<string, unknown> {
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

function createExternalWorkStatus(overrides: {
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

function createMockRuntime() {
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

function createMockWorkUnitDetail(state: MockState, workUnit: MockWorkUnit) {
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

function isActiveMockWorkUnit(status: string): boolean {
  return status === "claimed" || status === "running" || status === "waiting_for_approval" || status === "cancelling";
}

function addExternalActionApproval(
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

function addExternalWorkCiTriage(
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

function createDefaultProviderTemplates(): readonly Record<string, unknown>[] {
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

function createProviderTemplate(overrides: Record<string, unknown>): Record<string, unknown> {
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

function createMockMcpServer(overrides: Partial<MockMcpServer> = {}): MockMcpServer {
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

function createMockMcpTool(overrides: Partial<MockMcpTool>): MockMcpTool {
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

function createMockMcpServerFromBody(body: Record<string, unknown>, id: string, existing?: MockMcpServer): MockMcpServer {
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
    secretNames: Array.isArray(transportRecord.secretHeaderNames)
      ? transportRecord.secretHeaderNames.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : Array.isArray(transportRecord.secretEnvNames)
        ? transportRecord.secretEnvNames.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : existing?.secretNames ?? [],
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing?.enabled ?? true,
    status: typeof body.enabled === "boolean" && !body.enabled ? "disabled" : existing?.status ?? "unknown",
    lastCheck: existing?.lastCheck,
    updatedAt: "2026-06-03T00:08:00.000Z",
  });
}

function collectMockMcpSecrets(state: MockState, serverId: string, serverKey: string, body: Record<string, unknown>): void {
  const secrets = isRecord(body.secrets)
    ? Object.fromEntries(Object.entries(body.secrets).filter(([, value]) => typeof value === "string" && value.trim().length > 0)) as Record<string, string>
    : {};
  if (Object.keys(secrets).length === 0) {
    return;
  }
  state.mcpServerSecrets[serverId] = { ...(state.mcpServerSecrets[serverId] ?? {}), ...secrets };
  state.mcpServerSecrets[serverKey] = state.mcpServerSecrets[serverId];
}

function toPublicMockMcpServer(server: MockMcpServer, state: MockState): Record<string, unknown> {
  const configuredSecrets = state.mcpServerSecrets[server.id] ?? state.mcpServerSecrets[server.serverKey] ?? {};
  const transport = server.transport === "stdio"
    ? {
      type: "stdio",
      command: server.command ?? "",
      args: server.args,
      env: server.env,
      secretEnvNames: server.secretNames,
    }
    : {
      type: "streamable-http",
      url: server.url ?? "",
      headers: server.headers,
      envHeaders: {},
      secretHeaderNames: server.secretNames,
    };
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
    secretNames: [...new Set([...server.secretNames, ...Object.keys(configuredSecrets)])],
    secretConfigured: Object.fromEntries(Object.keys(configuredSecrets).map((key) => [key, true])),
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

function createMockTeammate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function createTeammateFromBody(body: Record<string, unknown>, id: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
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

function buildMockExternalActionView(state: MockState, action: MockExternalWorkAction): Record<string, unknown> {
  return {
    action,
    approval: action.approvalId ? state.approvals.find((approval) => approval.id === action.approvalId) : undefined,
    artifacts: state.artifactsByExternalAction[action.id] ?? [],
  };
}

async function mockDaemon(
  page: Page,
  state: MockState,
  options: {
    readonly defaultWorkspaceCwd?: string;
    readonly templates?: readonly unknown[];
    readonly providerModelsUnsupported?: boolean;
  } = {},
): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    await handleDaemonRoute(route, state, options);
  });
}

async function handleDaemonRoute(
  route: Route,
  state: MockState,
  options: {
    readonly defaultWorkspaceCwd?: string;
    readonly templates?: readonly unknown[];
    readonly providerModelsUnsupported?: boolean;
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
    collectMockMcpSecrets(state, server.id, server.serverKey, body);
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
      const clearSecretNames = Array.isArray(body.clearSecretNames)
        ? body.clearSecretNames.filter((item): item is string => typeof item === "string")
        : [];
      for (const secretName of clearSecretNames) {
        delete state.mcpServerSecrets[updated.id]?.[secretName];
        delete state.mcpServerSecrets[updated.serverKey]?.[secretName];
      }
      collectMockMcpSecrets(state, updated.id, updated.serverKey, body);
      await route.fulfill({ json: { server: toPublicMockMcpServer(updated, state) } });
      return;
    }
    if (!action && request.method() === "DELETE") {
      state.mcpServers = state.mcpServers.filter((item) => item.id !== server.id);
      state.mcpTools = state.mcpTools.filter((tool) => tool.serverId !== server.id);
      state.teammateMcpBindings = state.teammateMcpBindings.filter((binding) => binding.serverId !== server.id);
      delete state.mcpServerSecrets[server.id];
      delete state.mcpServerSecrets[server.serverKey];
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
      await route.fulfill({ json: { server: toPublicMockMcpServer(server, state) } });
      return;
    }
    if (action === "sync-tools" && request.method() === "POST") {
      const discovered = [
        createMockMcpTool({ id: `${server.id}_search_repositories`, serverId: server.id, name: "search_repositories", title: "Search repositories" }),
        createMockMcpTool({ id: `${server.id}_create_issue`, serverId: server.id, name: "create_issue", title: "Create issue" }),
      ];
      state.mcpTools = [...state.mcpTools.filter((tool) => tool.serverId !== server.id), ...discovered];
      await route.fulfill({ json: { server: toPublicMockMcpServer(server, state), tools: discovered } });
      return;
    }
    if (action === "secret" && request.method() === "GET") {
      const secretName = url.searchParams.get("name") ?? "";
      const configuredSecrets = state.mcpServerSecrets[server.id] ?? state.mcpServerSecrets[server.serverKey] ?? {};
      const secretValue = configuredSecrets[secretName] ?? "";
      await route.fulfill({
        json: {
          serverId: server.id,
          secretName,
          secretValue,
          configured: secretValue.length > 0,
        },
      });
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
    await route.fulfill({ json: buildProviderCheckResult(createProviderFromBody(body, "provider_draft_check")) });
    return;
  }
  if (request.method() === "POST" && path === "/provider-models") {
    if (options.providerModelsUnsupported) {
      await route.fulfill({ status: 404, json: { error: "not_found", message: "No route for POST /provider-models" } });
      return;
    }
    const body = await request.postDataJSON() as Record<string, unknown>;
    if (body.baseUrl !== "https://api.example.com/v1" || body.apiKey !== "test-visible-key") {
      await route.fulfill({ status: 400, json: { error: "unexpected_model_probe", body } });
      return;
    }
    await route.fulfill({
      json: {
        source: "https://api.example.com/v1/models",
        models: [
          { id: "cliproxy-gpt-4o", ownedBy: "cliproxy" },
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

function getOrCreateMockTeammateThread(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}
