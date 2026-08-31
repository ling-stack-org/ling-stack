import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProposedPlanArtifact } from "@ling-stack/contracts";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { mockDaemon, type MockExecutionAction } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  isRecord,
  type MockState,
} from "./support/mock-state";
import {
  channelEventFilterToggle,
  channelEventFilters,
  openEngineeringChannel,
  openChannelChatTools,
  openTaskFromAttentionQueue,
  readScrollState,
} from "./support/test-helpers";
import {
  expectSharedConversationRichBody,
  sharedConversationRichBody,
} from "./support/rich-content";

async function expectComposerValue(composer: Locator, value: string): Promise<void> {
  if (value.length === 0) {
    await expect.poll(async () => (await composer.getAttribute("data-value"))?.trim() ?? "").toBe("");
    return;
  }
  await expect.poll(() => composer.getAttribute("data-value")).toBe(value);
}

function channelComposerTextbox(scope: Page | Locator): Locator {
  return scope.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });
}

async function openTaskProposalGate(page: Page, title: string): Promise<Locator> {
  const gate = page.locator('[data-conversation-decision-kind="task_proposal"]');
  const summary = page.getByLabel("Task proposal summary").filter({ hasText: title });
  await expect.poll(async () => await gate.isVisible() || await summary.isVisible()).toBe(true);
  if (!await gate.isVisible() || !(await gate.innerText()).includes(title)) {
    await summary.getByRole("button", { name: "View task" }).click();
  }
  await expect(gate).toBeVisible();
  await expect(gate).toContainText(title);
  return gate;
}

function createLineagePlan(overrides: Partial<ProposedPlanArtifact>): ProposedPlanArtifact {
  return {
    id: "plan_lineage",
    workspaceId: "workspace_default",
    threadId: "thread_channel_main_channel_engineering",
    channelId: "channel_engineering",
    goalId: "goal_ship_plan_modes",
    planGroupId: "plan_group_ship_plan_modes",
    version: 1,
    title: "Plan lineage",
    bodyMarkdown: "Plan body",
    status: "draft",
    createdAt: "2026-05-25T00:40:00.000Z",
    updatedAt: "2026-05-25T00:40:00.000Z",
    ...overrides,
  };
}

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

function mockRetryCommandAction(
  id: string,
  threadId: string,
  runId: string,
  command: string,
  startedAt: string,
  exitCode: number,
): MockExecutionAction {
  const completedAt = new Date(Date.parse(startedAt) + 200).toISOString();
  const status = exitCode === 0 ? "succeeded" : "failed";
  return {
    id,
    workspaceId: "workspace_default",
    threadId,
    runId,
    attemptId: `attempt_${runId}`,
    toolCallId: `tool_${id}`,
    actionType: "bash",
    risk: "low",
    status,
    title: "Run command",
    summary: command,
    targetRefs: [{ type: "command", label: command }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    commandEvidence: {
      command,
      cwd,
      startedAt,
      completedAt,
      durationMs: 200,
      exitCode,
      latestEventSeq: 3,
      outputTail: [],
      outputByteCount: 0,
      outputTruncated: false,
    },
    createdAt: startedAt,
    updatedAt: completedAt,
    executedAt: startedAt,
    completedAt,
  };
}

function configureReadyConversationModel(state: MockState): void {
  const provider = createChatProvider({
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-30T00:00:00.000Z" },
  });
  state.providers = [provider];
  state.workspaceSettings.defaultProviderPresetId = "provider_local";
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: channel.defaultProviderPresetId ?? "provider_local" }
    : channel);
}

function configureConcurrentChannelReplyRuns(state: MockState): {
  readonly designerRunId: string;
  readonly designerWorkUnitId: string;
  readonly engineerRunId: string;
  readonly engineerWorkUnitId: string;
} {
  const seed = state.runs[0];
  const fixtures = [
    {
      teammateId: "designer",
      runId: "run_channel_reply_designer",
      workUnitId: "wu_channel_reply_designer",
      createdAt: "2026-05-22T00:01:00.000Z",
      updatedAt: "2026-05-22T00:01:01.000Z",
    },
    {
      teammateId: "engineer",
      runId: "run_channel_reply_engineer",
      workUnitId: "wu_channel_reply_engineer",
      createdAt: "2026-05-22T00:01:02.000Z",
      updatedAt: "2026-05-22T00:01:03.000Z",
    },
  ] as const;

  state.aiTeammates = [
    createMockTeammate({ id: "designer", displayName: "Designer", roleKey: "designer", avatarTone: "blue" }),
    createMockTeammate({ id: "engineer", displayName: "Engineer", roleKey: "engineer", avatarTone: "teal" }),
  ];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [{
    id: "message_source",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Start the active channel replies.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-05-22T00:00:59.000Z",
    updatedAt: "2026-05-22T00:00:59.000Z",
  }];
  state.runs = fixtures.map((fixture) => ({
    ...seed,
    id: fixture.runId,
    status: "running",
    taskId: "message_source",
    threadId: "thread_channel_channel_engineering",
    teammateId: fixture.teammateId,
    workUnitId: fixture.workUnitId,
    requestSnapshot: { sourceMessageId: "message_source" },
    errorMessage: undefined,
    createdAt: fixture.createdAt,
    startedAt: fixture.createdAt,
    updatedAt: fixture.updatedAt,
  }));
  state.workUnits = fixtures.map((fixture) => ({
    id: fixture.workUnitId,
    workspaceId: "workspace_default",
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: "message_source",
    channelId: "channel_engineering",
    teammateId: fixture.teammateId,
    providerPresetId: "provider_local",
    idempotencyKey: `channel-reply:${fixture.runId}`,
    status: "running",
    priority: 0,
    attemptCount: 1,
    activeAttemptId: `attempt_${fixture.runId}`,
    createdByActor: "system",
    request: { sourceMessageId: "message_source" },
    timeoutPolicy: { claimTtlMs: 60_000, heartbeatTtlMs: 60_000, cancelGraceMs: 15_000 },
    linkedRunId: fixture.runId,
    linkedMessageId: `reply_${fixture.teammateId}`,
    createdAt: fixture.createdAt,
    updatedAt: fixture.updatedAt,
    startedAt: fixture.createdAt,
  }));
  state.turns = [{
    id: "turn_channel_reply",
    workspaceId: "workspace_default",
    threadId: "thread_channel_channel_engineering",
    kind: "initial_request",
    status: "running",
    title: "Ordinary channel replies",
    userInstruction: "Reply to the channel message.",
    channelId: "channel_engineering",
    sourceItemId: "message_source",
    activeRunId: fixtures[1].runId,
    createdByActor: "local-user",
    createdAt: fixtures[0].createdAt,
    updatedAt: fixtures[1].updatedAt,
  }];
  state.turnRunLinks = fixtures.map((fixture, index) => ({
    turnId: "turn_channel_reply",
    runId: fixture.runId,
    attemptNumber: index + 1,
    role: "primary",
    createdAt: fixture.createdAt,
  }));

  return {
    designerRunId: fixtures[0].runId,
    designerWorkUnitId: fixtures[0].workUnitId,
    engineerRunId: fixtures[1].runId,
    engineerWorkUnitId: fixtures[1].workUnitId,
  };
}

async function expectConversationReviewSurface(page: Page): Promise<void> {
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const progressPopover = page.locator(".channel-progress-popover");
  if ((await progressPopover.count()) > 0) {
    await expect(progressPopover).toBeVisible();
    await page.locator(".task-toolbar-progress").click();
    await expect(progressPopover).toHaveCount(0);
  }
}

async function expectApprovalDetailOverlay(page: Page, title: string): Promise<void> {
  const overlay = page.locator(".conversation-detail-overlay").filter({ hasText: "Approval details" });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(title);
}

async function readFirstVisibleFeedAnchor(page: Page): Promise<{ id: string; offsetTop: number; scrollTop: number } | undefined> {
  return page.locator(".activity-shell .message-feed").evaluate((feed) => {
    const feedRect = feed.getBoundingClientRect();
    const row = Array.from(feed.querySelectorAll<HTMLElement>("[data-feed-item-id]"))
      .filter((element) => element.dataset.feedItemKind !== "older-loader")
      .find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > feedRect.top + 12 && rect.top < feedRect.bottom - 12;
      });
    if (!row?.dataset.feedItemId) {
      return undefined;
    }
    return {
      id: row.dataset.feedItemId,
      offsetTop: Math.round(row.getBoundingClientRect().top - feedRect.top),
      scrollTop: Math.round(feed.scrollTop),
    };
  });
}

async function readStableFirstVisibleFeedAnchor(
  page: Page,
): Promise<{ id: string; offsetTop: number; scrollTop: number }> {
  let previous = await readFirstVisibleFeedAnchor(page);
  await expect.poll(async () => {
    const current = await readFirstVisibleFeedAnchor(page);
    const stable = Boolean(
      current
      && previous
      && current.id === previous.id
      && Math.abs(current.offsetTop - previous.offsetTop) <= 1
    );
    previous = current;
    return stable;
  }).toBe(true);
  if (!previous) throw new Error("Visible feed anchor did not stabilize");
  return previous;
}

async function readOverlappingVirtualFeedRows(page: Page): Promise<string[]> {
  return page.getByLabel("Channel message feed").locator(".message-feed-virtual-row").evaluateAll((rows) => {
    const geometry = rows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          id: row.getAttribute("data-feed-item-id") ?? "unknown",
          top: rect.top,
          bottom: rect.bottom,
        };
      })
      .sort((left, right) => left.top - right.top);
    return geometry.slice(0, -1).flatMap((row, index) => {
      const next = geometry[index + 1];
      return next && row.bottom > next.top + 1 ? [`${row.id} -> ${next.id}`] : [];
    });
  });
}

test("channel governance notifications stay in the header review queue", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.governanceNotifications = [
    {
      id: "gov_memory_candidate_1",
      workspaceId: "workspace_default",
      surface: { kind: "channel", channelId: "channel_engineering" },
      kind: "memory_candidate",
      severity: "action_required",
      title: "Memory candidate ready",
      summary: "A candidate from this channel is waiting for review.",
      sourceRefs: [{ type: "memory", id: "memory_candidate_1", label: "Memory candidate" }],
      targetRoute: { page: "memory_promotion_inbox", memoryId: "memory_candidate_1", channelId: "channel_engineering" },
      status: "unread",
      deliveryStatus: "pending",
      dedupeKey: "memory:memory_candidate_1:channel:channel_engineering",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:01:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator(".channel-governance-button")).toHaveAttribute("aria-label", "Review queue: 1");
  await expect(page.getByLabel("Workspace task toolbar").locator('[data-conversation-count="true"]')).toContainText("1");
  await expect(page.getByLabel("Channel message feed").getByText("No channel messages yet")).toBeVisible();

  await page.locator(".channel-governance-button").click();
  const reviewQueue = page.getByRole("dialog", { name: "Governance notifications" });
  await expect(reviewQueue).toBeVisible();
  await expect(reviewQueue).toContainText("Memory candidate ready");
  await expect(reviewQueue).toContainText("A candidate from this channel is waiting for review.");

  await reviewQueue.getByRole("button", { name: "Seen" }).click();
  await expect(reviewQueue.getByRole("button", { name: "Seen" })).toHaveCount(0);
  expect(isRecord(state.governanceNotifications[0]) ? state.governanceNotifications[0].status : undefined).toBe("seen");

  await reviewQueue.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".channel-governance-button")).toHaveCount(0);
  expect(isRecord(state.governanceNotifications[0]) ? state.governanceNotifications[0].status : undefined).toBe("dismissed");
});

test("channel header hides empty governance review queue while notifications load", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.governanceNotifications = [];
  state.governanceNotificationDelayMs = 1_000;
  let requestStarted = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/governance-notifications") {
      requestStarted = true;
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect.poll(() => requestStarted).toBe(true);
  await page.waitForTimeout(100);
  await expect(page.locator(".channel-governance-button")).toHaveCount(0, { timeout: 250 });
  await expect(page.getByLabel("Channel message feed").getByText("No channel messages yet")).toBeVisible();
});

test("terminal bottom panel runs commands in the channel workspace", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.eventsByRun = {};

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const channelToolbar = page.getByLabel("Workspace task toolbar");
  await expect(channelToolbar).toHaveClass(/workspace-top-right-toolbar/);
  await expect(channelToolbar.locator(".task-toolbar-bottom-panel")).toHaveCount(1);
  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".channel-side-panel.right-dock");
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Terminal" }).click();
  const sideTerminal = dock.locator(".channel-side-terminal");
  await expect(sideTerminal).toBeVisible();
  const workspacePromptLabel = `tianxiao@tianxiaodeMacBook-Pro ${cwd.split("/").filter(Boolean).at(-1) ?? cwd} %`;
  await expect(sideTerminal.locator(".workspace-terminal-prompt")).toContainText(workspacePromptLabel);

  await page.getByRole("button", { name: "Toggle bottom panel" }).click();
  const terminal = page.locator(".channel-bottom-terminal");
  await expect(terminal).toBeVisible();
  await expect(terminal.locator(".workspace-terminal-tab")).toContainText("ling-stack");
  await expect(page.locator(".channel-side-panel .workspace-terminal-panel")).toHaveCount(1);
  await expect(terminal.locator(".workspace-terminal-prompt")).toContainText(workspacePromptLabel);
  await expect.poll(async () => terminal.locator(".workspace-terminal-prompt").evaluate((node) => {
    const element = node as HTMLElement;
    return element.scrollWidth - element.clientWidth;
  })).toBeLessThanOrEqual(1);

  const terminalResizeHandle = page.getByRole("separator", { name: "Resize terminal panel" });
  await expect(terminalResizeHandle).toBeVisible();
  await expect(terminalResizeHandle).toHaveCSS("cursor", "row-resize");
  const initialTerminalBox = await terminal.boundingBox();
  const initialHandleBox = await terminalResizeHandle.boundingBox();
  expect(initialTerminalBox).not.toBeNull();
  expect(initialHandleBox).not.toBeNull();
  await page.mouse.move(initialHandleBox!.x + initialHandleBox!.width / 2, initialHandleBox!.y + 5);
  await page.mouse.down();
  await page.mouse.move(initialHandleBox!.x + initialHandleBox!.width / 2, initialHandleBox!.y - 140, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await terminal.boundingBox())?.height ?? 0)).toBeGreaterThan(Math.round((initialTerminalBox?.height ?? 0) + 40));

  const expandedHandleBox = await terminalResizeHandle.boundingBox();
  expect(expandedHandleBox).not.toBeNull();
  await page.mouse.move(expandedHandleBox!.x + expandedHandleBox!.width / 2, expandedHandleBox!.y + 5);
  await page.mouse.down();
  await page.mouse.move(expandedHandleBox!.x + expandedHandleBox!.width / 2, expandedHandleBox!.y - 500, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const terminalBox = await terminal.boundingBox();
    const maxHeight = await page.evaluate(() => {
      const workbench = document.querySelector<HTMLElement>(".task-workbench-window");
      return Math.floor((workbench?.getBoundingClientRect().height ?? window.innerHeight) / 2);
    });
    return Math.round((terminalBox?.height ?? 0) - maxHeight);
  }).toBeLessThanOrEqual(2);

  const commandInput = terminal.getByRole("textbox", { name: "Command" });
  await expect(commandInput).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(commandInput).toHaveCSS("box-shadow", "none");
  await commandInput.fill("pwd");
  await commandInput.press("Enter");

  await expect.poll(() => state.terminalCommandRequests.length).toBe(1);
  expect(state.terminalCommandRequests[0]).toEqual({ cwd, command: "pwd" });
  await expect(terminal.locator(".workspace-terminal-output")).toContainText(cwd);
  await expect(sideTerminal.locator(".workspace-terminal-output")).toContainText(cwd);
});

test("channel team metrics stay in settings without a conversation expert summary", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    {
      id: "msg_team_source",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "请审阅多 agent 协作边界。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:00.000Z",
      updatedAt: "2026-05-25T00:18:00.000Z",
    },
    {
      id: "msg_team_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_team_source",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "主回复保持干净，团队证据不重复展示。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:01.000Z",
      updatedAt: "2026-05-25T00:18:01.000Z",
    },
    {
      id: "msg_team_followup",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "继续讨论部署边界。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:19:00.000Z",
      updatedAt: "2026-05-25T00:19:00.000Z",
    },
    {
      id: "msg_team_followup_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_team_followup",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "后续回复没有团队证据。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:19:01.000Z",
      updatedAt: "2026-05-25T00:19:01.000Z",
    },
  ];
  state.channelTeamExpertsByTurn["channel_engineering:msg_team_source"] = {
    channelId: "channel_engineering",
    turnId: "msg_team_source",
    totalCount: 4,
    activeCount: 1,
    completedCount: 2,
    delayedCount: 0,
    unavailableCount: 1,
    adoptedCount: 0,
    rejectedCount: 0,
    statusCounts: { pending: 1, completed: 2, unavailable: 1 },
    chips: [
      { agentId: "architect", status: "completed", evidenceCount: 1, evidenceGrade: "inspected", latestSummary: "Architect checked boundaries.", updatedAt: "2026-05-25T00:18:02.000Z" },
      { agentId: "designer", status: "pending", evidenceCount: 1, evidenceGrade: "observed", latestSummary: "Designer is reviewing interaction edge cases.", updatedAt: "2026-05-25T00:18:03.000Z" },
      { agentId: "security", status: "unavailable", evidenceCount: 1, evidenceGrade: "observed", latestSummary: "Security provider is temporarily unavailable.", updatedAt: "2026-05-25T00:18:04.000Z" },
      { agentId: "qa", status: "completed", evidenceCount: 1, evidenceGrade: "verified", latestSummary: "QA verified folded presentation.", updatedAt: "2026-05-25T00:18:05.000Z" },
    ],
    entries: [
      {
        id: "evidence_architect",
        agentId: "architect",
        kind: "specialist_note",
        status: "completed",
        visibility: "folded_evidence",
        evidenceGrade: "inspected",
        summary: "Architect checked boundaries.",
        concerns: [],
        recommendations: ["Keep Ling Agent as decision owner."],
        sourceRefs: [{ type: "message", id: "msg_team_source" }],
        createdAt: "2026-05-25T00:18:02.000Z",
        updatedAt: "2026-05-25T00:18:02.000Z",
      },
    ],
    latestUpdatedAt: "2026-05-25T00:18:05.000Z",
  };
  state.channelTeamMetricsByChannel.channel_engineering = {
    channelId: "channel_engineering",
    generatedAt: "2026-05-25T00:18:06.000Z",
    summary: {
      healthState: "attention_needed",
      totalEvidenceCount: 4,
      activeEvidenceCount: 1,
      delayedEvidenceCount: 0,
      unavailableEvidenceCount: 1,
      reliabilityIncidentCount: 0,
      availabilityIncidentCount: 1,
      latestUpdatedAt: "2026-05-25T00:18:05.000Z",
    },
    agents: [
      {
        agentId: "architect",
        evidenceCount: 1,
        completedCount: 1,
        delayedCount: 0,
        unavailableCount: 0,
        adoptedCount: 0,
        rejectedCount: 0,
        reliabilityIncidentCount: 0,
        latestSummary: "Architect checked boundaries.",
        latestUpdatedAt: "2026-05-25T00:18:02.000Z",
      },
    ],
    attention: {
      activeAgentCount: 4,
      evidenceKindCounts: { specialist_note: 4 },
      evidenceStatusCounts: { pending: 1, completed: 2, unavailable: 1 },
    },
    riskReview: {
      riskSignalCount: 1,
      dissentSignalCount: 0,
      openReliabilityIncidentCount: 0,
      openCriticalReliabilityIncidentCount: 0,
    },
    learningQueue: {
      recommendationEvidenceCount: 1,
      adoptedEvidenceCount: 0,
      rejectedEvidenceCount: 0,
      provisionalRuleCount: 0,
      note: "Pattern Store is inspect-only here.",
    },
  };
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByText("主回复保持干净，团队证据不重复展示。")).toBeVisible();
  await expect(feed.getByText("后续回复没有团队证据。")).toBeVisible();
  await expect(feed.locator(".channel-team-experts-summary")).toHaveCount(0);
  await expect.poll(() => state.channelTeamExpertsRequests.length).toBe(0);
  await expect(feed.getByText("Architect checked boundaries.")).toHaveCount(0);
  const assistantTranscript = feed.locator(".conversation-turn-assistant-transcript").filter({ hasText: "主回复保持干净，团队证据不重复展示。" });
  await expect(assistantTranscript.locator(".message-action-bar.channel-message-ai-actions")).toHaveCount(1);
  const assistantTurnOrder = await assistantTranscript.evaluate((element) =>
    Array.from(element.children).map((child) => (child as HTMLElement).className)
  );
  expect(assistantTurnOrder.some((className) => className.includes("channel-team-experts-summary"))).toBe(false);
  expect(assistantTurnOrder.at(-1)).toContain("channel-message-row-footer-stack");

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Health" }).click();
  const teamMetrics = page.getByRole("region", { name: "Team metrics" });
  await expect(teamMetrics).toHaveAttribute("data-health-state", "attention_needed");
  await expect(teamMetrics.locator(".channel-team-metrics-health")).toHaveCount(0);
  await expect(teamMetrics.getByRole("region", { name: "Risk review" })).toContainText("Risk1");
  await expect(teamMetrics.getByRole("region", { name: "Learning queue" })).toContainText("Recommendation1");
  await expect(teamMetrics).toContainText("Architect checked boundaries.");
});

test("global sidebar keeps fixed chrome, scrollable recents, and a true compact rail", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_drawer_designer", displayName: "Designer" }),
    createMockTeammate({ id: "teammate_drawer_research", displayName: "Research" }),
    createMockTeammate({ id: "teammate_drawer_runtime", displayName: "Runtime" }),
  ];
  state.threads = Array.from({ length: 5 }, (_, index) => {
    const timestamp = `2026-05-29T00:0${index}:00.000Z`;
    return {
      id: `thread_recent_${index}`,
      workspaceId: "workspace_default",
      kind: "conversation",
      teammateId: "ling_agent",
      title: `Recent conversation ${index + 1}`,
      objective: "Keep the sidebar recent conversation list populated.",
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        schemaVersion: 1,
        lastActivityAt: timestamp,
      },
    };
  });
  for (let index = 0; index < 28; index += 1) {
    state.channels.push({
      id: `channel_recent_${index}`,
      workspaceId: "workspace_default",
      name: `Recent ${index}`,
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "",
      allowedTools: ["read", "grep"],
      runtimePolicy: defaultRuntimePolicy,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    });
  }
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.locator(".sidebar-fixed-top")).toBeVisible();
  await expect(navigation.locator(".sidebar-scroll-region")).toBeVisible();
  await expect(navigation.locator(".sidebar-bottom")).toBeVisible();
  await expect(page.locator(".channel-sidebar-toolbar")).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Search or start" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Inbox" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Media Production" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Plugin Manager" })).toBeVisible();
  await expect(navigation.locator(".primary-nav").getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Automations" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Profile" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect.poll(async () => page.locator(".channel-left-drawer").evaluate((drawer) => {
    const fixedTop = drawer.querySelector(".sidebar-fixed-top");
    const drawerTop = drawer.getBoundingClientRect().top;
    const fixedTopOffset = (fixedTop?.getBoundingClientRect().top ?? drawerTop) - drawerTop;
    return Math.round(drawer.getBoundingClientRect().width) === 292 && fixedTopOffset >= 10;
  })).toBe(true);

  const expanded = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const fixedTop = document.querySelector(".channel-left-drawer .sidebar-fixed-top");
    const scrollRegion = document.querySelector(".channel-left-drawer .sidebar-scroll-region");
    const bottom = document.querySelector(".channel-left-drawer .sidebar-bottom");
    const selectedChannel = document.querySelector(".channel-left-drawer .sidebar-channel-group > .sidebar-row-shell.selected");
    const primaryNav = document.querySelector(".channel-left-drawer .primary-nav");
    const firstSectionTitle = document.querySelector(".channel-left-drawer .sidebar-section-title");
    const settings = document.querySelector(".channel-left-drawer .config-button");
    const scrollRegionElement = scrollRegion as HTMLElement | null;
    if (scrollRegionElement) {
      scrollRegionElement.scrollTop = scrollRegionElement.scrollHeight;
    }
    const recentRows = [...document.querySelectorAll(".channel-left-drawer .sidebar-recent-row-shell")];
    const lastRecent = recentRows.at(-1);
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      firstColumnWidth: Math.round(Number.parseFloat(shell ? getComputedStyle(shell).gridTemplateColumns : "0")),
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      leftTop: Math.round(leftDrawer?.getBoundingClientRect().top ?? -1),
      leftBackground: leftDrawer ? getComputedStyle(leftDrawer).backgroundColor : "",
      fixedTopTop: Math.round(fixedTop?.getBoundingClientRect().top ?? -1),
      scrollOverflowY: scrollRegion ? getComputedStyle(scrollRegion).overflowY : "",
      scrollTop: Math.round(scrollRegion?.getBoundingClientRect().top ?? -1),
      scrollBottom: Math.round(scrollRegion?.getBoundingClientRect().bottom ?? -1),
      scrollClientHeight: Math.round(scrollRegionElement?.clientHeight ?? 0),
      scrollHeight: Math.round(scrollRegionElement?.scrollHeight ?? 0),
      scrollTopAfterSet: Math.round(scrollRegionElement?.scrollTop ?? 0),
      bottomBottomGap: leftDrawer && bottom ? Math.round(leftDrawer.getBoundingClientRect().bottom - bottom.getBoundingClientRect().bottom) : -1,
      bottomTop: Math.round(bottom?.getBoundingClientRect().top ?? -1),
      selectedChannelText: selectedChannel?.textContent?.trim() ?? "",
      selectedChannelBackground: selectedChannel ? getComputedStyle(selectedChannel).backgroundColor : "",
      recentRowCount: recentRows.length,
      lastRecentText: lastRecent?.textContent?.trim() ?? "",
      lastRecentTop: Math.round(lastRecent?.getBoundingClientRect().top ?? -1),
      lastRecentBottom: Math.round(lastRecent?.getBoundingClientRect().bottom ?? -1),
      primaryNavBorderBottom: primaryNav ? getComputedStyle(primaryNav).borderBottomWidth : "",
      sectionTitleColor: firstSectionTitle ? getComputedStyle(firstSectionTitle).color : "",
      sectionTitleFontSize: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontSize : "",
      sectionTitleFontWeight: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontWeight : "",
      settingsText: settings?.textContent?.trim() ?? "",
      globalRightPanels: document.querySelectorAll(".right-panel").length,
    };
  });
  expect(expanded.firstColumnWidth).toBe(292);
  expect(expanded.leftWidth).toBe(292);
  expect(expanded.leftBackground).toBe("rgb(230, 228, 223)");
  expect(expanded.fixedTopTop - expanded.leftTop).toBeGreaterThanOrEqual(10);
  expect(expanded.scrollOverflowY).toBe("auto");
  expect(expanded.scrollTop).toBeGreaterThan(expanded.fixedTopTop);
  expect(expanded.scrollHeight).toBeGreaterThan(expanded.scrollClientHeight);
  expect(expanded.scrollTopAfterSet).toBeGreaterThan(0);
  expect(expanded.scrollBottom).toBeLessThan(expanded.bottomTop);
  expect(expanded.recentRowCount).toBe(5);
  expect(expanded.lastRecentText).toContain("Recent conversation");
  expect(expanded.lastRecentTop).toBeGreaterThanOrEqual(expanded.scrollTop);
  expect(expanded.lastRecentBottom).toBeLessThanOrEqual(expanded.scrollBottom + 1);
  expect(expanded.bottomBottomGap).toBeGreaterThanOrEqual(8);
  expect(expanded.selectedChannelText).toContain("Engineering");
  expect(expanded.selectedChannelBackground).toBe("rgb(217, 216, 213)");
  expect(expanded.primaryNavBorderBottom).toBe("0px");
  expect(expanded.sectionTitleColor).toBe("rgb(134, 134, 137)");
  expect(expanded.sectionTitleFontSize).toBe("10px");
  expect(Number(expanded.sectionTitleFontWeight)).toBeGreaterThanOrEqual(700);
  expect(expanded.settingsText).toBe("Settings");
  expect(expanded.globalRightPanels).toBe(0);
  await navigation.locator(".sidebar-scroll-region").evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expect(navigation).toHaveAttribute("data-sidebar-mode", "compact");
  const leftCollapsed = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".sidebar-compact-rail");
    const objectRows = document.querySelectorAll(".sidebar-row-shell");
    const railLaunchers = document.querySelectorAll(".sidebar-compact-rail .sidebar-rail-launcher");
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      firstColumnWidth: Math.round(Number.parseFloat(shell ? getComputedStyle(shell).gridTemplateColumns : "0")),
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      leftDrawerCount: leftDrawer ? 1 : 0,
      objectRowCount: objectRows.length,
      railLauncherCount: railLaunchers.length,
    };
  });
  expect(leftCollapsed.firstColumnWidth).toBe(48);
  expect(leftCollapsed.leftWidth).toBe(48);
  expect(leftCollapsed.leftDrawerCount).toBe(1);
  expect(leftCollapsed.objectRowCount).toBe(0);
  expect(leftCollapsed.railLauncherCount).toBe(3);

  await page.getByRole("button", { name: "Show navigation" }).click();
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? 0)).toBe(292);
  await navigation.getByRole("button", { name: "Media Production" }).click();
  await expect(page.getByRole("radiogroup", { name: "Media production views" })).toBeVisible();
  await navigation.getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Configuration overview" })).toHaveCount(0);
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to app" }).click();

  await expect.poll(async () => Math.round((await page.locator(".channel-left-drawer").boundingBox())?.width ?? 0)).toBe(292);
  const restored = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
    };
  });
  expect(restored.columns.startsWith("292px ")).toBe(true);
  expect(restored.leftWidth).toBe(292);
});

test("narrow channel viewport keeps the conversation column usable", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const feed = page.getByLabel("Channel message feed");
  await expect(feed).toBeVisible();
  await expect.poll(async () => Math.round(
    await page.locator(".workspace-client-surface").evaluate((element) => element.getBoundingClientRect().width),
  )).toBeGreaterThanOrEqual(330);

  const layout = await page.evaluate(() => {
    const readRect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        return undefined;
      }
      const rect = element.getBoundingClientRect();
      return {
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        x: Math.round(rect.x),
      };
    };
    const shell = document.querySelector(".app-shell");
    return {
      viewportWidth: window.innerWidth,
      shellColumns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      drawer: readRect(".channel-left-drawer"),
      workspace: readRect(".workspace-client-surface"),
      workbenchWindow: readRect(".task-workbench-window"),
      channelChatPanel: readRect(".channel-chat-panel"),
      feed: readRect("[aria-label='Channel message feed']"),
      rightPanelCount: document.querySelectorAll(".right-panel").length,
      channelSidePanelCount: document.querySelectorAll(".channel-side-panel").length,
    };
  });

  expect(layout.workspace?.width).toBeGreaterThanOrEqual(330);
  expect(layout.workspace?.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.workbenchWindow?.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.channelChatPanel?.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.feed?.width).toBeGreaterThanOrEqual(300);
  expect(layout.feed?.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.rightPanelCount).toBe(0);
  expect(layout.channelSidePanelCount).toBe(0);
});

test("progress popover shows active context source groups and opens source detail", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      runtimeErrors.push(`console:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror:${error.message}`));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    {
      id: "msg_source_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      authorType: "local-user",
      authorId: "local-user",
      kind: "message",
      intent: "chat",
      body: "Use the v3 transcript style.",
      status: "sent",
      attachmentIds: [],
      linkPreviewIds: [],
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:00:00.000Z",
    },
    {
      id: "msg_source_2",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      authorType: "local-user",
      authorId: "local-user",
      kind: "message",
      intent: "chat",
      body: "Keep details out of the main transcript.",
      status: "sent",
      attachmentIds: [],
      linkPreviewIds: [],
      createdAt: "2026-05-25T01:01:00.000Z",
      updatedAt: "2026-05-25T01:01:00.000Z",
    },
  ];
  state.channelDecisions = [
    {
      id: "decision_source_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Conversation UI boundary",
      decision: "Sources stay in the active popover and detail surfaces.",
      rationale: "Avoid duplicating the main transcript.",
      alternatives: [],
      status: "accepted",
      createdAt: "2026-05-25T01:02:00.000Z",
      updatedAt: "2026-05-25T01:02:00.000Z",
    },
  ];
  state.channelContextSummaries = [
    {
      id: "summary_sources",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      targetType: "thread",
      targetId: "msg_source_1",
      sourceMessageIds: ["msg_source_1", "msg_source_2"],
      decisionIds: ["decision_source_1"],
      summary: "Source summary fixture for active workflow progress.",
      acceptanceCriteria: ["Show source groups in the progress popover."],
      openQuestions: [],
      authorType: "system",
      createdAt: "2026-05-25T01:03:00.000Z",
      updatedAt: "2026-05-25T01:03:00.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_sources",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Update conversation sources",
      objective: "Validate active source summary rendering.",
      status: "running",
      createdBy: "system",
      createdAt: "2026-05-25T01:04:00.000Z",
      updatedAt: "2026-05-25T01:04:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_sources",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_sources",
      contextSummaryId: "summary_sources",
      position: 1,
      title: "Render source summary",
      prompt: "Show compact context source groups in the active progress popover.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "running",
      metadata: {
        proposalStepSources: [
          {
            kind: "council",
            councilId: "council_builtin_development",
            councilDisplayName: "Development Council",
            slotKey: "engineer",
            label: "Implementation",
          },
        ],
      },
      createdAt: "2026-05-25T01:04:00.000Z",
      updatedAt: "2026-05-25T01:05:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const workCell = page.locator(".conversation-work-cell").filter({ hasText: "Render source summary" });
  await expect(workCell).toBeVisible();
  const activeMotion = await workCell.evaluate((element) => {
    const runningText = element.querySelector(".conversation-work-cell-row.running .conversation-work-cell-row-copy strong");
    return {
      cellAnimation: getComputedStyle(element).animationName,
      runningAnimation: runningText ? getComputedStyle(runningText).animationName : "",
    };
  });
  expect(activeMotion.cellAnimation).toContain("conversation-settle-in");
  expect(activeMotion.runningAnimation).toContain("conversation-active-shimmer");
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await workCell.locator(".conversation-work-cell-active-stream .conversation-work-cell-row-main").click();
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("From Development Council");

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Summary" }).click();

  const popover = page.locator(".channel-progress-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Sources used");
  await expect(popover).toContainText("3 sources");
  await expect(popover).toContainText("Messages");
  await expect(popover).toContainText("2 items");
  await expect(popover).toContainText("Decisions");
  await expect(popover).toContainText("1 item");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);

  await popover.getByRole("button", { name: "Open Messages sources" }).click();

  const sourceOverlay = page.locator(".conversation-detail-overlay");
  await expect(sourceOverlay).toBeVisible();
  await expect(sourceOverlay).toHaveAttribute("aria-label", "Context sources");
  await expect(sourceOverlay).toContainText("Sources used");
  await expect(sourceOverlay).toContainText("Messages");
  await expect(sourceOverlay).toContainText("2 items");
  await expect(sourceOverlay).toContainText("Message msg_source_1");
  await expect(sourceOverlay).toContainText("Message msg_source_2");
  await expect(sourceOverlay).not.toContainText("Progress");
  await expect(sourceOverlay).not.toContainText("Update conversation sources");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect.poll(() => sourceOverlay.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(runtimeErrors).toEqual([]);
});

test("channel AI replies use the standard full conversation width", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    {
      id: "msg_wide_table_source",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Summarize the available AI news sources.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
    {
      id: "msg_wide_table_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_wide_table_source",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "| Source | Coverage | URL |\n|---|---|---|\n| AI Daily | Product and research news | https://example.com/daily |",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-13T00:00:01.000Z",
      updatedAt: "2026-07-13T00:00:01.000Z",
    },
    {
      id: "msg_regular_source",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Give me a one-sentence status.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-13T00:00:02.000Z",
      updatedAt: "2026-07-13T00:00:02.000Z",
    },
    {
      id: "msg_regular_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_regular_source",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "The system is healthy.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-13T00:00:03.000Z",
      updatedAt: "2026-07-13T00:00:03.000Z",
    },
    {
      id: "msg_standalone_ai_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "This standalone AI reply must use the full channel conversation width instead of wrapping at the legacy 680 pixel limit.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-13T00:00:04.000Z",
      updatedAt: "2026-07-13T00:00:04.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const chatLayout = page.locator(".activity-chat-layout");
  const composer = page.locator(".activity-shell .channel-composer");
  const wideTurn = page.locator(".conversation-turn").filter({ has: page.locator(".message-body-table-scroll") });
  const sourceMessage = wideTurn.locator(".channel-message-row.local-user");
  const sourceMessageContent = sourceMessage.locator(":scope > .message-content");
  const sourceMessageActions = sourceMessage.locator(":scope > .message-row-own-actions");
  const sourceMessageActionBar = sourceMessageActions.locator(".channel-message-user-actions");
  const assistantReply = wideTurn.locator(".conversation-turn-assistant-row");
  const assistantContent = assistantReply.locator(":scope > .message-content");
  const regularTurn = page.locator(".conversation-turn").filter({ hasText: "The system is healthy." });
  const regularAssistantReply = regularTurn.locator(".conversation-turn-assistant-row");
  const standaloneAssistantReply = page.locator(".channel-message-row.ai-teammate:not(.conversation-turn-assistant-row)");
  const standaloneAssistantContent = standaloneAssistantReply.locator(":scope > .message-content");
  await expect.poll(async () => Math.round((await chatLayout.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await chatLayout.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect.poll(async () => Math.round((await composer.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await composer.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect(wideTurn).toHaveCount(1);
  await expect.poll(async () => Math.round((await sourceMessage.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await sourceMessage.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect(sourceMessageContent.locator(".channel-message-user-actions")).toHaveCount(0);
  await expect(sourceMessageActionBar).toHaveCount(1);
  await expect(sourceMessageActionBar).toHaveCSS("opacity", "0");
  await sourceMessage.hover();
  await expect(sourceMessageActionBar).toHaveCSS("opacity", "1");
  await expect.poll(async () => {
    const contentBox = await sourceMessageContent.boundingBox();
    const actionsBox = await sourceMessageActions.boundingBox();
    return contentBox && actionsBox ? Math.round(actionsBox.y - (contentBox.y + contentBox.height)) : -1;
  }).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => Math.round((await assistantReply.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await assistantReply.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect.poll(async () => Math.round((await assistantContent.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(740);
  await expect.poll(async () => Math.round((await assistantContent.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(780);
  await expect(regularTurn).toHaveCount(1);
  await expect.poll(async () => Math.round((await regularTurn.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await regularTurn.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect.poll(async () => Math.round((await regularAssistantReply.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await regularAssistantReply.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect(standaloneAssistantReply).toHaveCount(1);
  await expect.poll(async () => Math.round((await standaloneAssistantReply.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await standaloneAssistantReply.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect.poll(async () => Math.round((await standaloneAssistantContent.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(740);
  await expect.poll(async () => Math.round((await standaloneAssistantContent.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(780);
});

test("channel environment surface shows read-only context and opens review", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 2160, height: 1200 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [
    {
      id: "run_environment",
      status: "succeeded",
      cwd,
      taskId: "task_environment",
      channelId: "channel_engineering",
      providerPresetId: "provider_local",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      taskSnapshot: { id: "task_environment", title: "Prepare environment diff" },
      providerSnapshot: { provider: "local-relay", model: "gpt-5.5" },
      requestSnapshot: { cwd, providerPresetId: "provider_local" },
      eventLogPath: ".ling-stack/sessions/run_environment.jsonl",
      createdAt: "2026-06-29T00:00:30.000Z",
      startedAt: "2026-06-29T00:00:31.000Z",
      endedAt: "2026-06-29T00:00:59.000Z",
      updatedAt: "2026-06-29T00:00:59.000Z",
    },
  ];
  state.approvals = [];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? {
          ...channel,
          workspaceBinding: {
            mode: "managed_worktree",
            status: "ready",
            executionPath: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
            worktreePath: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
            branchName: "ling/channel-environment",
            baseBranch: "main",
            updatedAt: "2026-06-29T00:00:00.000Z",
            checkedAt: "2026-06-29T00:00:00.000Z",
          },
        }
      : channel
  );
  state.artifactsByRun = {
    run_environment: [
      {
        id: "artifact_environment_diff",
        runId: "run_environment",
        type: "diff",
        path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
        title: "Workspace environment diff",
        contentType: "text/x-diff; charset=utf-8",
        contentText: [
          "diff --git a/apps/web/src/features/workspace/WorkspaceClientView.tsx b/apps/web/src/features/workspace/WorkspaceClientView.tsx",
          "index 1111111..2222222 100644",
          "--- a/apps/web/src/features/workspace/WorkspaceClientView.tsx",
          "+++ b/apps/web/src/features/workspace/WorkspaceClientView.tsx",
          "@@ -10,3 +10,4 @@",
          " import React from \"react\";",
          "-const oldLabel = \"Environment\";",
          "+const newLabel = \"Environment\";",
          "+const reviewPreview = true;",
          " export function WorkspaceClientView() {",
          "   return null;",
          " }",
        ].join("\n"),
        createdAt: "2026-06-29T00:01:00.000Z",
      },
    ],
  };
  state.channelWorkspaceGitStatusByChannel.channel_engineering = {
    state: "dirty",
    cwd: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
    repoRoot: `${cwd}/.ling-stack/worktrees/channels/channel_engineering`,
    branchName: "ling/channel-environment",
    upstream: "main",
    headSha: "abc1234",
    changedFileCount: 1,
    stagedFileCount: 0,
    unstagedFileCount: 1,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    additions: 12,
    deletions: 3,
    files: [
      {
        path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
        indexStatus: " ",
        worktreeStatus: "M",
        kind: "modified",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    checkedAt: "2026-06-29T00:01:00.000Z",
  };

  await mockDaemon(page, state);
  await page.route(/\/workspace\/changes(?:\?.*)?$/, async (route) => {
    const worktreeCwd = `${cwd}/.ling-stack/worktrees/channels/channel_engineering`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: worktreeCwd,
        state: "dirty",
        repoRoot: worktreeCwd,
        branchName: "ling/channel-environment",
        upstream: "main",
        headSha: "abc1234",
        additions: 12,
        deletions: 3,
        files: [{
          path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
          kind: "modified",
          staged: false,
          unstaged: true,
          untracked: false,
          additions: 12,
          deletions: 3,
          diff: state.artifactsByRun.run_environment?.[0]?.contentText,
          truncated: false,
        }],
        totalFileCount: 1,
        truncated: false,
        checkedAt: "2026-06-29T00:01:00.000Z",
      }),
    });
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveAttribute("data-sidebar-mode", "compact");
  await expect.poll(async () => Math.round((await page.locator(".activity-chat-layout").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await page.locator(".activity-chat-layout").boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(780);
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeLessThanOrEqual(820);
  const readChatLayoutSnapshot = async () => page.evaluate(() => {
    const chatLayout = document.querySelector<HTMLElement>(".activity-chat-layout");
    const composer = document.querySelector<HTMLElement>(".activity-shell .channel-composer");
    const main = document.querySelector<HTMLElement>(".task-workbench-main");
    const chatPanel = document.querySelector<HTMLElement>(".channel-chat-panel");
    const chatBox = chatLayout?.getBoundingClientRect();
    const composerBox = composer?.getBoundingClientRect();
    return {
      chatHeight: Math.round(chatBox?.height ?? 0),
      chatTransform: chatLayout ? getComputedStyle(chatLayout).transform : "",
      chatWidth: Math.round(chatBox?.width ?? 0),
      chatX: Math.round(chatBox?.x ?? 0),
      chatY: Math.round(chatBox?.y ?? 0),
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      composerWidth: Math.round(composerBox?.width ?? 0),
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      panelMarginRight: chatPanel ? getComputedStyle(chatPanel).marginRight : "",
    };
  });

  const summaryButton = page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Summary" });
  await summaryButton.click();
  const popover = page.locator(".channel-progress-popover");
  await expect(popover).toBeVisible();
  await expect.poll(async () => Math.round((await popover.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(270);
  await expect.poll(async () => Math.round((await popover.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(290);
  await expect(popover).toContainText("Environment");
  await expect(popover).toContainText("Changes");
  await expect(popover).toContainText("Review");
  await expect(popover).toContainText("Local environment");
  await expect(popover).toContainText("Working branch");
  await expect(popover).toContainText("Commit or push");
  await expect(popover).toContainText("1 changed file");
  await expect(popover).toContainText("+12");
  await expect(popover).toContainText("-3");
  await popover.getByRole("button", { name: "Local environment" }).click();
  const quickEnvironmentPage = page.locator(".channel-environment-page");
  await expect(quickEnvironmentPage).toBeVisible();
  await expect(quickEnvironmentPage).toContainText("Local environment");
  await expect(quickEnvironmentPage).toContainText("Worktree");
  await expect(quickEnvironmentPage).toContainText("ling/channel-environment");
  await page.getByRole("button", { name: "Back to channel" }).click();
  await expect(quickEnvironmentPage).toHaveCount(0);
  await summaryButton.click();
  await expect(popover).toBeVisible();

  const dock = page.locator(".channel-side-panel");
  const chatLayout = page.locator(".activity-chat-layout");
  const messageFeed = page.getByLabel("Channel message feed");
  const feedScrollBeforeDock = await messageFeed.evaluate((node) => {
    node.dataset.remountProbe = "right-dock-stable";
    return Math.round(node.scrollTop);
  });
  const chatLayoutBeforeDock = await chatLayout.boundingBox();
  expect(chatLayoutBeforeDock).not.toBeNull();
  const chatSnapshotBeforeDock = await readChatLayoutSnapshot();
  expect(chatSnapshotBeforeDock.chatWidth).toBeGreaterThanOrEqual(780);
  expect(chatSnapshotBeforeDock.chatWidth).toBeLessThanOrEqual(820);
  expect(chatSnapshotBeforeDock.composerWidth).toBeGreaterThanOrEqual(780);
  expect(chatSnapshotBeforeDock.composerWidth).toBeLessThanOrEqual(820);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(chatSnapshotBeforeDock.chatTransform);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(chatSnapshotBeforeDock.composerTransform);
  expect(chatSnapshotBeforeDock.mainPaddingRight).toBe("0px");
  expect(chatSnapshotBeforeDock.panelMarginRight).toBe("0px");
  await page.locator(".task-toolbar-panel").click();
  await page.waitForTimeout(160);
  const chatLayoutDuringDockOpen = await chatLayout.boundingBox();
  expect(chatLayoutDuringDockOpen).not.toBeNull();
  expect(Math.abs((chatLayoutDuringDockOpen?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutDuringDockOpen?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  await expect(dock).toBeVisible();
  const chatLayoutAfterDockOpen = await chatLayout.boundingBox();
  expect(chatLayoutAfterDockOpen).not.toBeNull();
  expect(Math.abs((chatLayoutAfterDockOpen?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutAfterDockOpen?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  await expect(popover).toBeVisible();
  await expect.poll(async () => {
    const popoverBox = await popover.boundingBox();
    const dockBox = await dock.boundingBox();
    if (!popoverBox || !dockBox) {
      return 999;
    }
    return Math.round(popoverBox.x + popoverBox.width - dockBox.x);
  }).toBeLessThanOrEqual(-8);
  await expect.poll(async () => {
    const popoverBox = await popover.boundingBox();
    const chatBox = await chatLayout.boundingBox();
    if (!popoverBox || !chatBox) {
      return -999;
    }
    return Math.round(popoverBox.x - (chatBox.x + chatBox.width));
  }).toBeGreaterThanOrEqual(8);
  expect(await messageFeed.evaluate((node) => node.dataset.remountProbe)).toBe("right-dock-stable");
  expect(Math.abs(await messageFeed.evaluate((node) => Math.round(node.scrollTop)) - feedScrollBeforeDock)).toBeLessThanOrEqual(1);
  await page.locator(".task-toolbar-panel").click();
  await page.waitForTimeout(80);
  await expect(dock).toHaveCount(1);
  const closingDockFrameBox = await page.locator(".channel-side-panel-frame").boundingBox();
  expect(closingDockFrameBox).not.toBeNull();
  expect(closingDockFrameBox?.width ?? 0).toBeGreaterThan(0);
  expect(closingDockFrameBox?.width ?? 0).toBeLessThan(304);
  const chatLayoutDuringDockClose = await chatLayout.boundingBox();
  expect(chatLayoutDuringDockClose).not.toBeNull();
  expect(Math.abs((chatLayoutDuringDockClose?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutDuringDockClose?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  await expect(dock).toHaveCount(0);
  const chatLayoutAfterDockClose = await chatLayout.boundingBox();
  expect(chatLayoutAfterDockClose).not.toBeNull();
  expect(Math.abs((chatLayoutAfterDockClose?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutAfterDockClose?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);
  const dockCloseHorizontalTolerance = 28;
  await expect.poll(async () => {
    const snapshot = await readChatLayoutSnapshot();
    return Math.abs(snapshot.chatX - chatSnapshotBeforeDock.chatX);
  }).toBeLessThanOrEqual(dockCloseHorizontalTolerance);
  const chatSnapshotAfterDockClose = await readChatLayoutSnapshot();
  expect(Math.abs(chatSnapshotAfterDockClose.chatX - chatSnapshotBeforeDock.chatX)).toBeLessThanOrEqual(dockCloseHorizontalTolerance);
  expect(Math.abs(chatSnapshotAfterDockClose.chatY - chatSnapshotBeforeDock.chatY)).toBeLessThanOrEqual(1);
  expect(Math.abs(chatSnapshotAfterDockClose.chatWidth - chatSnapshotBeforeDock.chatWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(chatSnapshotAfterDockClose.chatHeight - chatSnapshotBeforeDock.chatHeight)).toBeLessThanOrEqual(1);
  expect(chatSnapshotAfterDockClose.chatTransform).toBe(chatSnapshotBeforeDock.chatTransform);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(chatSnapshotAfterDockClose.composerTransform);
  expect(chatSnapshotAfterDockClose.mainPaddingRight).toBe("0px");
  expect(chatSnapshotAfterDockClose.panelMarginRight).toBe("0px");
  expect(await messageFeed.evaluate((node) => node.dataset.remountProbe)).toBe("right-dock-stable");
  expect(Math.abs(await messageFeed.evaluate((node) => Math.round(node.scrollTop)) - feedScrollBeforeDock)).toBeLessThanOrEqual(1);
  await expect(popover).toBeVisible();

  await page.locator(".task-toolbar-panel").click();
  await expect(dock).toBeVisible();
  await page.locator(".task-toolbar-panel").click();
  await page.waitForTimeout(80);
  await page.locator(".task-toolbar-panel").click();
  await expect.poll(async () => Math.round((await page.locator(".channel-side-panel-frame").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  await expect(dock).toBeVisible();
  await expect(page.locator(".task-toolbar-panel")).toHaveAttribute("aria-expanded", "true");
  const chatLayoutAfterReopen = await chatLayout.boundingBox();
  expect(chatLayoutAfterReopen).not.toBeNull();
  expect(Math.abs((chatLayoutAfterReopen?.y ?? 0) - (chatLayoutBeforeDock?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((chatLayoutAfterReopen?.height ?? 0) - (chatLayoutBeforeDock?.height ?? 0))).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Show navigation" }).click();
  await page.setViewportSize({ width: 1984, height: 1200 });
  await page.waitForTimeout(200);

  await popover.getByRole("button", { name: "Review" }).click();
  await expect(dock).toBeVisible();
  await expect(dock.locator(".right-dock-head-page")).toContainText("Review");
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(320);
  await expect(popover).toBeVisible();
  await expect.poll(async () => {
    const popoverBox = await popover.boundingBox();
    const dockBox = await dock.boundingBox();
    if (!popoverBox || !dockBox) {
      return 999;
    }
    return Math.round(popoverBox.x + popoverBox.width - dockBox.x);
  }).toBeLessThanOrEqual(-8);
  await expect.poll(async () => {
    const popoverBox = await popover.boundingBox();
    const chatBox = await chatLayout.boundingBox();
    if (!popoverBox || !chatBox) {
      return -999;
    }
    return Math.round(popoverBox.x - (chatBox.x + chatBox.width));
  }).toBeGreaterThanOrEqual(8);
  const defaultPopoverWithDockBox = await popover.boundingBox();
  const defaultDockWithPopoverBox = await dock.boundingBox();
  expect(defaultPopoverWithDockBox).not.toBeNull();
  expect(defaultDockWithPopoverBox).not.toBeNull();
  expect((defaultPopoverWithDockBox?.x ?? 0) + (defaultPopoverWithDockBox?.width ?? 0)).toBeLessThanOrEqual((defaultDockWithPopoverBox?.x ?? 0) - 8);
  const resizeHandle = page.getByRole("separator", { name: "Resize workspace dock" });
  await expect(resizeHandle).toBeVisible();
  await expect(resizeHandle).toHaveCSS("cursor", "col-resize");
  const initialDockBox = await dock.boundingBox();
  expect(initialDockBox).not.toBeNull();
  const resizeHandleBox = await resizeHandle.boundingBox();
  expect(resizeHandleBox).not.toBeNull();
  await page.mouse.move(resizeHandleBox!.x + resizeHandleBox!.width / 2, resizeHandleBox!.y + 40);
  await page.mouse.down();
  await page.mouse.move(resizeHandleBox!.x - 130, resizeHandleBox!.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThan((initialDockBox?.width ?? 0) + 80);
  await expect(dock).toContainText("ling/channel-environment");
  const changedFileSection = dock.locator('.workspace-change-file-section[data-workspace-change-path="apps/web/src/features/workspace/WorkspaceClientView.tsx"]');
  await expect(changedFileSection).toBeVisible();
  await expect(changedFileSection).toContainText("WorkspaceClientView.tsx");
  await expect(changedFileSection.locator(".diff-viewer")).toContainText("reviewPreview");
  await expect(changedFileSection.getByRole("button", { name: "Open with" })).toBeVisible();
  await changedFileSection.getByRole("button", { name: "Collapse code preview: WorkspaceClientView.tsx" }).click();
  await expect(changedFileSection).toHaveClass(/collapsed/u);
  await expect(changedFileSection.locator(".diff-viewer")).toHaveCount(0);
  const expandedResizeHandleBox = await resizeHandle.boundingBox();
  expect(expandedResizeHandleBox).not.toBeNull();
  await page.mouse.move(expandedResizeHandleBox!.x + expandedResizeHandleBox!.width / 2, expandedResizeHandleBox!.y + 40);
  await page.mouse.down();
  await page.mouse.move(860, expandedResizeHandleBox!.y + 40, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(840);
  await expect(popover).toBeHidden();
  await expect(summaryButton).toHaveAttribute("aria-pressed", "true");
  await expect(summaryButton).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(560);
  await page.locator(".task-toolbar-panel").click();
  await expect(dock).toHaveCount(0);
  await expect(popover).toBeVisible();
  await expect(summaryButton).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  const environmentPage = page.locator(".channel-environment-page");
  await expect(environmentPage).toBeVisible();
  await expect(page.locator(".channel-settings-top-title small")).toHaveCount(0);
  await expect(environmentPage.locator(".channel-environment-page-header > div")).toHaveCount(0);
  await expect(environmentPage).not.toContainText("#Engineering");
  await expect(environmentPage).toContainText("Local environment");
  await expect(environmentPage).toContainText("Worktree");
  await expect(environmentPage).toContainText("ling/channel-environment");
  await expect(environmentPage).toContainText("1 changed file");
  await expect(environmentPage).toContainText("+12");
  await expect(environmentPage).toContainText("-3");
  await expect(environmentPage).toContainText("1 review item");
  await expect(environmentPage).toContainText("No browser evidence");
  await expect(environmentPage).toContainText("No sources");
  await expect(environmentPage).toContainText("1 artifact");
  await expect(environmentPage.locator(".channel-environment-metric")).toHaveCount(3);
  await expect(environmentPage.locator('[data-environment-row="commit"]')).toBeVisible();
  const environmentRows = environmentPage.locator(".channel-environment-list > .ling-ui-data-row");
  const summaryLeftEdges = await environmentRows.locator(".ling-ui-data-row-summary").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().left)),
  );
  const statusLeftEdges = await environmentRows.locator(".ling-ui-data-row-status").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.querySelector(".ling-ui-status-indicator")!.getBoundingClientRect().left)),
  );
  const actionRightEdges = await environmentRows.locator(".ling-ui-data-row-actions").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().right)),
  );
  expect(new Set(summaryLeftEdges).size, `summary columns: ${summaryLeftEdges.join(", ")}`).toBe(1);
  expect(
    Math.max(...statusLeftEdges) - Math.min(...statusLeftEdges),
    `status columns: ${statusLeftEdges.join(", ")}`,
  ).toBeLessThanOrEqual(1);
  expect(statusLeftEdges).toHaveLength(5);
  expect(new Set(actionRightEdges).size, `action columns: ${actionRightEdges.join(", ")}`).toBe(1);

  const selectedEnvironmentPath = "/Users/example/workspace/projects";
  await environmentPage.getByRole("button", { name: "Change directory" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    if (!isRecord(channel) || !isRecord(channel.workspaceBinding)) {
      return undefined;
    }
    return {
      boundPath: channel.boundPath,
      mode: channel.workspaceBinding.mode,
      executionPath: channel.workspaceBinding.executionPath,
    };
  }).toEqual({
    boundPath: selectedEnvironmentPath,
    mode: "local",
    executionPath: selectedEnvironmentPath,
  });
  const localEnvironment = environmentPage.locator('[data-environment-row="workspace"]');
  await expect(localEnvironment).toContainText("Local");
  await expect(localEnvironment).toContainText(selectedEnvironmentPath);
  const environmentPath = localEnvironment.locator(".channel-environment-path");
  await expect(environmentPath).toHaveAttribute("title", selectedEnvironmentPath);
  await expect(environmentPath).toHaveCSS("white-space", "nowrap");
  await expect(environmentPath).toHaveCSS("text-overflow", "ellipsis");
  await expect(environmentPath).toHaveCSS("font-family", /mono/u);
  await expect.poll(async () => {
    const box = await environmentPath.boundingBox();
    return Math.round(box?.height ?? 0);
  }).toBeLessThanOrEqual(20);
  await expect(localEnvironment.getByRole("button", { name: "Change directory" })).toBeVisible();

  await environmentPage.locator('[data-environment-row="commit"]').getByRole("button", { name: "Open" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit or push" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(dialog).toContainText("first version is read-only");
  const includeUnstagedSwitch = dialog.getByRole("switch", { name: "Include unstaged changes" });
  await expect(includeUnstagedSwitch).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Commit and push" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Push", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await environmentPage.getByRole("button", { name: "View review" }).click();
  await expect(page.locator(".channel-environment-page")).toHaveCount(0);
  const rightDock = page.locator(".channel-side-panel");
  await expect(rightDock.locator(".right-dock-head-page")).toContainText("Review");
  await expect(rightDock.locator(".right-dock-filter-row")).toHaveCount(0);
  await expect(rightDock.locator(".right-dock-review-status-card")).toHaveCount(0);
  await expect(rightDock.locator(".workspace-change-review-page")).toBeVisible();
  await expect(rightDock.locator(".workspace-change-review-page")).not.toContainText("Risk");
  await expect(rightDock.locator(".workspace-change-review-page")).not.toContainText("Runtime");
});

test("channel environment labels review-only items as review instead of changes", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [];
  state.artifactsByRun = {};
  state.runs = [
    {
      id: "run_environment_failed",
      status: "failed",
      cwd,
      taskId: "task_environment_failed",
      channelId: "channel_engineering",
      providerPresetId: "provider_local",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      errorMessage: "Provider overloaded",
      taskSnapshot: { id: "task_environment_failed", title: "Review runtime issue" },
      providerSnapshot: { provider: "local-relay", model: "gpt-5.5" },
      requestSnapshot: { cwd, providerPresetId: "provider_local" },
      eventLogPath: ".ling-stack/sessions/run_environment_failed.jsonl",
      createdAt: "2026-06-29T00:02:30.000Z",
      startedAt: "2026-06-29T00:02:31.000Z",
      endedAt: "2026-06-29T00:02:59.000Z",
      updatedAt: "2026-06-29T00:02:59.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Summary" }).click();
  const environmentSection = page.locator(".channel-progress-popover .attention-environment-section");
  await expect(environmentSection).toBeVisible();
  await expect(environmentSection).toContainText("Review");
  await expect(environmentSection).toContainText("1 review item");
  await expect(environmentSection).not.toContainText("Changes");
  await expect(environmentSection).not.toContainText("+0 -0");
});

test("channel environment shows clean git state without review rows", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.channelMessages = [];
  state.artifactsByRun = {};

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Summary" }).click();
  const environmentSection = page.locator(".channel-progress-popover .attention-environment-section");
  await expect(environmentSection).toBeVisible();
  await expect(environmentSection).not.toContainText("Changes");
  await expect(environmentSection).not.toContainText("Review");

  await page.locator(".task-toolbar-panel").click();
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  const environmentPage = page.locator(".channel-environment-page");
  await expect(environmentPage).toContainText("No code changes");
  await expect(environmentPage).toContainText("No review items");
  await expect(environmentPage.locator('[data-environment-row="review"]')).toBeVisible();
  await expect(environmentPage.locator(".channel-environment-page-header .ling-ui-status-indicator")).toContainText("Ready");
});

test("channel environment shows not-git-repo without fake clean state", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.channelMessages = [];
  state.artifactsByRun = {};
  state.channelWorkspaceGitStatusByChannel.channel_engineering = {
    state: "not_git_repo",
    cwd,
    changedFileCount: 0,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    files: [],
    checkedAt: "2026-06-29T00:03:00.000Z",
    unavailableReason: "Selected channel workspace is not a Git repository.",
  };

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  const environmentPage = page.locator(".channel-environment-page");
  await expect(environmentPage).toContainText("Not a Git repository");
  await expect(environmentPage).not.toContainText("No code changes");
  await expect(environmentPage.locator(".ling-ui-data-row")).toHaveCount(5);
  await expect(environmentPage.locator('[data-environment-row="workspace"]')).toBeVisible();
  await expect(environmentPage.locator('[data-environment-row="changes"]')).toBeVisible();
  await expect(environmentPage.locator('[data-environment-row="review"]')).toBeVisible();
  await expect(environmentPage.locator('[data-environment-row="branch"]')).toBeVisible();
  await expect(environmentPage.locator('[data-environment-row="commit"]')).toBeVisible();
  await expect(environmentPage.locator(".channel-environment-page-header .ling-ui-status-indicator")).toContainText("Ready");
  await environmentPage.getByText("Evidence and output", { exact: true }).click();
  await expect(environmentPage.locator(".channel-environment-evidence-grid")).toBeVisible();
  await expect(environmentPage).toContainText("No linked resources");
});

test("channel environment treats git transport failure as unavailable", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.channelMessages = [];
  state.artifactsByRun = {};
  state.channelWorkspaceGitStatusByChannel.channel_engineering = {
    fail: true,
    status: 503,
    message: "Git status overloaded",
  };

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  const environmentPage = page.locator(".channel-environment-page");
  await expect(environmentPage).toContainText("Git status unavailable");
  await expect(environmentPage).not.toContainText("No code changes");
  await expect(environmentPage.locator(".channel-environment-page-header .ling-ui-status-indicator")).toContainText("Needs attention");
  await expect(environmentPage.locator('[data-environment-row="changes"]')).toBeVisible();
  await expect(environmentPage.locator('[data-environment-row="branch"]')).toBeVisible();
});

test("conversation motion respects reduced motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelWorkflows = [
    {
      id: "workflow_motion",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Reduced motion workflow",
      objective: "Verify motion preferences.",
      status: "running",
      createdBy: "system",
      createdAt: "2026-05-25T01:04:00.000Z",
      updatedAt: "2026-05-25T01:04:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_motion",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_motion",
      position: 1,
      title: "Render reduced motion state",
      prompt: "Verify reduced motion.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "running",
      createdAt: "2026-05-25T01:04:00.000Z",
      updatedAt: "2026-05-25T01:05:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const workCell = page.locator(".conversation-work-cell.active").first();
  await expect(workCell).toBeVisible();
  const reducedMotion = await workCell.evaluate((element) => {
    const runningText = element.querySelector(".conversation-work-cell-row.running .conversation-work-cell-row-copy strong, .conversation-work-cell-evidence-summary span");
    return {
      cellAnimation: getComputedStyle(element).animationName,
      runningAnimation: runningText ? getComputedStyle(runningText).animationName : "",
      runningColor: runningText ? getComputedStyle(runningText).color : "",
    };
  });
  expect(reducedMotion.cellAnimation).toBe("none");
  expect(reducedMotion.runningAnimation).toBe("none");
  expect(reducedMotion.runningColor).not.toBe("rgba(0, 0, 0, 0)");
  await maybeCaptureConversationScreenshots(page, "p10-reduced-motion-active-work", [
    { suffix: "desktop-reduced", width: 1440, height: 960 },
  ]);
});

test("approval event opens approval detail inside the conversation page", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const approvalBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approval expired" });
  await expect(approvalBubble).toBeVisible();
  await approvalBubble.getByRole("button", { name: "Open approval" }).click();

  const approvalOverlay = page.locator(".conversation-detail-overlay");
  await expect(approvalOverlay).toBeVisible();
  await expect(approvalOverlay).toHaveAttribute("aria-label", "Approval details");
  await expect(approvalOverlay.locator(".channel-approval-detail-panel")).toContainText("Approval expired");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

test("channel drawer does not flash legacy create labels in section headers", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const drawer = page.locator(".channel-left-drawer");
  await expect(drawer.getByRole("button", { name: "New channel" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Channel actions" })).toBeVisible();
  await expect(drawer.locator(".sidebar-section-toggle small")).toHaveCount(0);
  await expect(drawer.getByText("Create", { exact: true })).toHaveCount(0);
  await expect(drawer.locator(".sidebar-section:first-of-type .sidebar-section-action")).toHaveAttribute("data-icon-only", "true");
  await drawer.getByRole("button", { name: "Channel actions" }).click();
  await expect(page.getByRole("menuitem", { name: "New channel" })).toBeVisible();
});

test("empty channel drawer opens the new channel dialog", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyConversationModel(state);
  state.channels = [];
  state.channelBranches = [];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "No channel yet" })).toBeVisible();
  await navigation.getByRole("button", { name: "No channel yet" }).click();

  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel).toBeVisible();
  await createChannelPanel.getByLabel("Name").fill("Launch Ops");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Launch Ops")).toBe(true);
  await expect(createChannelPanel).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Launch Ops" })).toBeVisible();
});

test("new channel dialog selects a project folder before create", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyConversationModel(state);
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "New channel" }).click();

  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  const selectedPath = "/Users/example/workspace/projects";
  const projectTrigger = createChannelPanel.getByRole("button", { name: "Project directory" });
  await expect(projectTrigger).toContainText("ling-stack-workspace");
  await projectTrigger.click();

  const projectMenu = createChannelPanel.getByRole("menu", { name: "Project folder options" });
  await expect(projectMenu).toBeVisible();
  await expect(projectMenu.getByRole("menuitemradio", { name: /ling-stack-workspace/ })).toBeVisible();
  await projectMenu.getByRole("menuitem", { name: /Use existing folder/ }).click();

  await expect(projectTrigger).toContainText("projects");
  await expect(projectTrigger).toContainText(selectedPath);
  await createChannelPanel.getByLabel("Name").fill("Project Source");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.name === "Project Source");
    return isRecord(channel) ? channel.boundPath : "";
  }).toBe(selectedPath);
  await expect(createChannelPanel).toHaveCount(0);
});

test("new channel dialog shows create failures inline", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyConversationModel(state);
  state.failNextChannelCreate = {
    error: "channel_create_failed",
    message: "Channel creation failed.",
  };
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await page.getByRole("menuitem", { name: "New channel" }).click();

  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel).toContainText("Git repositories use isolated channel workspaces; other folders run directly from the selected folder.");
  await createChannelPanel.getByLabel("Name").fill("Broken Repo");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

  await expect(createChannelPanel).toBeVisible();
  await expect(createChannelPanel.getByRole("alert")).toContainText("Channel creation failed.");
  expect(state.channels.some((channel) => isRecord(channel) && channel.name === "Broken Repo")).toBe(false);
});

test("channel drawer promotes pending approvals to one waiting status until resolved", async ({ page }) => {
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
  const engineering = drawer.locator(".sidebar-channel-group").filter({ hasText: "Engineering" }).locator(".sidebar-row-shell").first();
  const research = drawer.locator(".sidebar-channel-group").filter({ hasText: "Research" }).locator(".sidebar-row-shell").first();
  await expect(engineering.locator(".channel-mention")).toHaveCount(0);
  await expect(engineering.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator(".channel-mention")).toHaveCount(0);
  await expect(research.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator('[data-sidebar-primary-status="waiting"]')).toHaveCount(1);
  await expect(research.getByRole("status", { name: "1 pending approvals" })).toBeVisible();

  await research.locator(".sidebar-row-main").click();
  await expect(research).toHaveClass(/selected/);
  await expect(research.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator('[data-sidebar-primary-status="waiting"]')).toHaveCount(1);
});

test("channel composer does not render the resource lease active work strip", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.resourceLeases = [
    {
      id: "lease_active_work_strip",
      workspaceId: "workspace_default",
      ownerType: "run",
      ownerId: "run_background",
      workUnitId: "work_unit_background",
      attemptId: "attempt_background",
      resourceType: "bound_path",
      resourceKey: cwd,
      status: "active",
      acquiredAt: "2026-05-25T00:03:00.000Z",
      lastRenewedAt: "2026-05-25T00:03:30.000Z",
      expiresAt: "2099-01-01T00:03:00.000Z",
      createdAt: "2026-05-25T00:03:00.000Z",
      updatedAt: "2026-05-25T00:03:30.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  await expect(composer).toBeVisible();
  await expect(composer).not.toContainText("Active work");
  await expect(composer).not.toContainText("Resource leases");
});

test("wide channel progress popover does not resize the conversation", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 2048, height: 1140 });
  const state = createBaseState({ approvalStatus: "expired" });
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
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.locator(".task-toolbar-progress").click();
  await page.waitForTimeout(200);

  const spacing = await page.evaluate(() => {
    const main = document.querySelector(".task-workbench-main");
    const chat = document.querySelector(".activity-chat-layout");
    const composer = document.querySelector(".channel-composer");
    const attention = document.querySelector(".channel-progress-popover");
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
  expect(spacing.chatWidth).toBe(800);
  expect(spacing.composerWidth).toBe(800);
  expect(spacing.attentionWidth).toBeGreaterThanOrEqual(270);
  expect(spacing.attentionWidth).toBeLessThanOrEqual(290);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(spacing.chatTransform);
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(spacing.composerTransform);
  expect(spacing.gap).toBeGreaterThanOrEqual(48);
  expect(spacing.overlapX).toBe(0);

  const summaryButton = page.locator(".task-toolbar-progress");
  await summaryButton.click();
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await expect(summaryButton).not.toHaveAttribute("aria-pressed", "true");
});

test("channel runtime policy is visible while preferred specialist controls stay hidden", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyConversationModel(state);
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "designer", roleKey: "designer", displayName: "Ling Designer" }),
  ];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, autoReplyMode: "auto_route" }
      : channel
  );
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
  await openEngineeringChannel(page);

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByText("active channel")).toHaveCount(0);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settingsTabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await expect(settingsTabs.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  await expect(settingsTabs.getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByLabel("Channel workspace settings")).toHaveCount(0);
  await expect(page.getByLabel("Channel teammates")).toHaveCount(0);
  await expect(page.getByLabel("Channel AI councils")).toHaveCount(0);
  const currentManagement = page.getByLabel("Channel management");
  await expect(currentManagement.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(currentManagement).not.toContainText("Preferred specialist");
  await expect(currentManagement.getByLabel("Ling reply")).toHaveCount(0);
  const currentNameSave = currentManagement.getByRole("button", { name: "Save channel" });
  await expect(currentNameSave).toBeVisible();
  await expect(currentNameSave).toBeDisabled();
  await expect(currentManagement.locator(".channel-autosave-status")).toHaveCount(0);
  await expect(page.locator(".channel-notification-panel > .channel-settings-section-head > small")).toHaveCount(0);
  await currentManagement.getByLabel("Name").fill("Engineering QA");
  const legacyRenameRequest = page.waitForRequest((request) =>
    request.method() === "PATCH" && new URL(request.url()).pathname === "/channels/channel_engineering"
  );
  await currentNameSave.click();
  const legacyRenameBody = await (await legacyRenameRequest).postDataJSON();
  expect(legacyRenameBody).not.toHaveProperty("autoReplyMode");
  expect(legacyRenameBody).not.toHaveProperty("defaultTeammateId");
  await expect.poll(() => {
    const updated = state.channels.find((channel) => isRecord(channel) && channel.id === "channel_engineering");
    return isRecord(updated) ? [updated.name, updated.autoReplyMode] : [];
  }).toEqual(["Engineering QA", "auto_route"]);

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await expect(page.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await page.getByRole("menuitem", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel).toBeVisible();
  await expect(createChannelPanel.getByLabel("Execution path")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Ling reply")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(createChannelPanel).not.toContainText("Preferred specialist");
  await expect(createChannelPanel.getByText("Invite teammates", { exact: true })).toBeVisible();
  await expect(createChannelPanel.getByLabel("Ling Agent model")).toBeVisible();
  await createChannelPanel.getByLabel("Name").fill("Release");
  await createChannelPanel.getByText("Advanced settings").click();
  await expect(createChannelPanel.getByLabel("Ling Agent model")).toBeVisible();
  await expect(createChannelPanel.getByLabel("Status")).toHaveCount(0);
  await expect(createChannelPanel).not.toContainText("Queue on conflict");
  await expect(createChannelPanel.getByLabel("Max runs")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Smart scheduling", { exact: true })).toBeVisible();
  await expect(createChannelPanel.getByText("Ling Agent decides when safe steps can run together. Writes, unknown tools, approvals, and resource locks stay protected.")).toBeVisible();
  await createChannelPanel.getByLabel("Write lock").selectOption("workspace");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Release")).toBe(true);
  const created = state.channels.find((channel) => isRecord(channel) && channel.name === "Release");
  expect(created).toBeTruthy();
  expect(isRecord(created) ? created.status : undefined).toBe("active");
  expect(isRecord(created) ? created.defaultTeammateId : undefined).toBeUndefined();
  const runtimePolicy = isRecord(created) && isRecord(created.runtimePolicy) ? created.runtimePolicy : {};
  expect(runtimePolicy.schedulingMode).toBe("smart");
  expect(runtimePolicy.writeLockScope).toBe("workspace");
  expect(runtimePolicy.maxConcurrentRuns).toBe(1);
  expect(runtimePolicy.queueOnConflict).toBe(true);
  await expect(createChannelPanel).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Release" })).toBeVisible();
  await navigation.getByRole("button", { name: "Release" }).click();
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const details = page.getByLabel("Channel management");
  await expect(details.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(details).not.toContainText("Preferred specialist");
  await expect(details.getByLabel("Ling reply")).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Create channel" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Create default" })).toHaveCount(0);
  const releaseNameSave = details.getByRole("button", { name: "Save channel" });
  await expect(releaseNameSave).toBeVisible();
  await expect(releaseNameSave).toBeDisabled();
  await details.getByLabel("Name").fill("Release QA");
  await expect(releaseNameSave).toBeEnabled();
  await releaseNameSave.click();
  await expect.poll(() => {
    const updated = state.channels.find((channel) => isRecord(channel) && channel.id === (isRecord(created) ? created.id : ""));
    return isRecord(updated) ? updated.name : "";
  }).toBe("Release QA");
  await expect(details.locator(".channel-autosave-status")).toHaveCount(0);
});

test("channel reply routing mode is not exposed in ordinary settings", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureReadyConversationModel(state);
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "designer", roleKey: "designer", displayName: "Ling Designer" }),
  ];
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const currentManagement = page.getByLabel("Channel management");
  await expect(currentManagement.getByLabel("Ling reply")).toHaveCount(0);
  await expect(currentManagement.getByText("Auto route")).toHaveCount(0);
  await expect(currentManagement.getByText("Ling Agent decides", { exact: true })).toHaveCount(0);

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await expect(page.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await page.getByRole("menuitem", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel.getByLabel("Ling reply")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Auto route")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Ling Agent decides", { exact: true })).toHaveCount(0);
  await createChannelPanel.getByLabel("Name").fill("Auto Route");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();
  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Auto Route")).toBe(true);
});

test("multi-role channel messages create workflow proposals instead of AI replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer", autoReplyMode: "default_teammate" }
      : channel,
  );
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_architect",
      templateId: "architect",
      roleKey: "architect",
      displayName: "Architect",
      allowedTools: ["read", "grep"],
    }),
    createMockTeammate({
      id: "teammate_builtin_engineer",
      displayName: "Engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    }),
    createMockTeammate({
      id: "teammate_builtin_qa",
      templateId: "qa",
      roleKey: "qa",
      displayName: "QA",
      allowedTools: ["read", "grep", "find", "ls", "bash"],
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await channelComposerTextbox(page).fill("Architect 先拆，Engineer 实现，QA 验证，可以吗？");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.lastChannelTurnRequest?.requestAiReply).toBe(true);
  expect(state.lastChannelTurnRequest).not.toHaveProperty("providerPresetId");
  await expect.poll(() => state.channelExecutionProposals.length).toBe(1);
  await expect.poll(() => state.channelMessages.filter((message) => isRecord(message) && message.kind === "ai_reply").length).toBe(0);
  const proposal = await openTaskProposalGate(page, "Architect 先拆，Engineer 实现，QA 验证，可以吗？");
  await expect(proposal).toContainText("Architect 先拆，Engineer 实现，QA 验证，可以吗？");
  await expect(proposal).toContainText("Engineer");
  await expect(proposal).toContainText("Read files");
  await expect(proposal).toContainText("Run commands");
  await expect(proposal).toContainText("Modify files");
  await expect(proposal).not.toContainText("Collaboration");
  await expect(proposal).not.toContainText("Non-direct multi-agent collaboration waits for confirmation");
  await expect(proposal).not.toContainText("Starting this task does not approve future runtime actions");
  await expect(proposal.getByRole("button")).toHaveCount(2);
  await expect(proposal.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Task confirmation" })).toHaveCount(0);
  await expect(page.getByText("AI teammate is preparing a reply...")).toHaveCount(0);
  await expect.poll(() => {
    const decision = state.channelIntentDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy].join("|") : "";
  }).toBe("workflow_proposal|accepted|deterministic");
});

test("task proposal gate uses one sentence and direct deny or allow actions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] })];
  state.channelMessages = [
    {
      id: "msg_permission_confirmations",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "帮我创建 README、编辑 docs，再跑 pnpm test",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_permission_write",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_permission_confirmations",
      proposedByTeammateId: "ling_agent",
      title: "Create README.md",
      prompt: "Create /tmp/example/README.md.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["README.md is created."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Create the requested file." }],
      requiredTools: ["write"],
      riskSummary: "Need write permission for /tmp/example/README.md.",
      status: "draft",
      createdAt: "2026-05-25T00:10:01.000Z",
      updatedAt: "2026-05-25T00:10:01.000Z",
    },
    {
      id: "proposal_permission_edit",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_permission_confirmations",
      proposedByTeammateId: "ling_agent",
      title: "Edit docs/guide.md",
      prompt: "Update docs/guide.md with the new workflow note.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["docs/guide.md is updated."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Edit the requested file." }],
      requiredTools: ["edit"],
      riskSummary: "Need edit permission for docs/guide.md.",
      status: "draft",
      createdAt: "2026-05-25T00:10:02.000Z",
      updatedAt: "2026-05-25T00:10:02.000Z",
    },
    {
      id: "proposal_permission_bash",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_permission_confirmations",
      proposedByTeammateId: "ling_agent",
      title: "Run pnpm test",
      prompt: "Command requested by user: pnpm test",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Test command completes."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Run the requested command." }],
      requiredTools: ["bash"],
      riskSummary: "Need bash permission to run pnpm test.",
      status: "draft",
      createdAt: "2026-05-25T00:10:03.000Z",
      updatedAt: "2026-05-25T00:10:03.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const summaries = page.getByLabel("Task proposal summary");
  await expect(summaries).toHaveCount(3);
  const createCard = await openTaskProposalGate(page, "Create README.md");
  await expect(createCard).toContainText("Modify files");
  await expect(createCard).toContainText("Ling Agent");
  await expect(createCard).not.toContainText("Need write permission");
  await expect(createCard).not.toContainText("/tmp/example/README.md");
  await expect(createCard).not.toContainText(/\bwrite\b/u);
  await expect(createCard.locator("dl")).toHaveCount(0);

  const editCard = await openTaskProposalGate(page, "Edit docs/guide.md");
  await expect(editCard).toContainText("Modify files");
  await expect(editCard).not.toContainText("Need edit permission");

  const commandCard = await openTaskProposalGate(page, "Run pnpm test");
  await expect(commandCard).toContainText("Run commands");
  await expect(commandCard).not.toContainText("Need bash permission");
  await expect(commandCard).not.toContainText(/\bbash\b/u);

  await expect(commandCard).not.toContainText("Starting this task does not approve future runtime actions");
  await expect(commandCard.getByRole("button")).toHaveCount(2);
  await expect(commandCard.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(commandCard.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(commandCard.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(commandCard.getByRole("button", { name: "Cancel proposal" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Task confirmation" })).toHaveCount(0);
  await maybeCaptureViewportScreenshot(page, "task-proposal-composer-gate.png");
});

test("task proposal gate blocks only its owning channel and deny restores the Composer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent" })];
  state.channels.push({
    id: "channel_general",
    workspaceId: "workspace_default",
    name: "General",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "ling_agent",
    autoReplyMode: "mentions_only",
    allowedTools: ["read", "grep", "find", "ls"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-25T00:12:00.000Z",
    updatedAt: "2026-05-25T00:12:00.000Z",
  });
  state.channelExecutionProposals = [{
    id: "proposal_channel_owned",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    sourceMessageId: "msg_channel_owned",
    proposedByTeammateId: "ling_agent",
    title: "Review channel ownership",
    prompt: "Review only the Engineering channel.",
    assigneeTeammateId: "ling_agent",
    acceptanceCriteria: ["The owning channel is preserved."],
    collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Review channel ownership." }],
    requiredTools: ["read"],
    status: "draft",
    createdAt: "2026-05-25T00:12:01.000Z",
    updatedAt: "2026-05-25T00:12:01.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const gate = await openTaskProposalGate(page, "Review channel ownership");
  await expect(page.getByLabel("Channel composer")).toHaveCount(0);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(gate).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();

  await page.getByRole("button", { name: "Engineering", exact: true }).click();
  const restoredGate = await openTaskProposalGate(page, "Review channel ownership");
  await restoredGate.getByRole("button", { name: "Deny" }).click();
  await expect(restoredGate).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect.poll(() => state.channelExecutionProposals[0]?.status).toBe("cancelled");
});

test("Ling Agent session acceptance matrix auto-starts executable messages", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"] })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await channelComposerTextbox(page).fill("在 /tmp/example 下创建 README.md");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.lastChannelTurnRequest?.requestAiReply).toBe(true);
  await expect.poll(() => state.channelExecutionProposals.length).toBe(1);
  await expect.poll(() => state.channelWorkflows.length).toBe(1);
  await expect.poll(() => state.channelMessages.filter((message) => isRecord(message) && message.kind === "ai_reply").length).toBe(0);
  const feed = page.locator(".activity-shell");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const createWorkCell = feed.locator(".conversation-work-cell");
  await expect(createWorkCell).toBeVisible();
  await expect(createWorkCell).toHaveAttribute("data-operation-source", "workflow");
  await expect(createWorkCell).not.toContainText("workflow_");
  await expect(createWorkCell).not.toContainText("Work in progress");
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].status : undefined).toBe("accepted");
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].linkedWorkflowId : undefined).toBe(
    isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].id : undefined,
  );
  await expect(feed.getByText("AI teammate is preparing a reply...")).toHaveCount(0);

  await channelComposerTextbox(page).fill("在 README.md 中添加一句测试语句");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.channelExecutionProposals.length).toBe(2);
  await expect.poll(() => state.channelWorkflows.length).toBe(2);
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(2);
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].status : undefined).toBe("accepted");
  expect(isRecord(state.channelExecutionProposals[0]) ? state.channelExecutionProposals[0].linkedWorkflowId : undefined).toBe(
    isRecord(state.channelWorkflows[0]) ? state.channelWorkflows[0].id : undefined,
  );
  await expect.poll(() => {
    const decision = state.channelIntentDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy].join("|") : "";
  }).toBe("execute|accepted|deterministic");
});

test("Ling Agent session keeps ordinary questions on chat routing", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: "teammate_builtin_engineer", autoReplyMode: "default_teammate" }
      : channel,
  );
  state.aiTeammates = [createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Engineer" })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await channelComposerTextbox(page).fill("这个 workspace 里面都有谁？");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.channelExecutionProposals.length).toBe(0);
  await expect.poll(() => state.channelMessageRouteDecisions.length).toBe(1);
  await expect.poll(() => {
    const decision = state.channelMessageRouteDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy, decision.selectedTeammateId].join("|") : "";
  }).toBe("reply|accepted|explicit_mention|ling_agent");
  const feed = page.locator(".activity-shell");
  await expect(feed.getByText("收到，我会按频道上下文推进。")).toBeVisible();
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
});

test("ordinary channel feed hides routing and intent decision internals", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", allowedTools: ["read", "grep", "find", "ls", "edit", "write"] })];
  state.channelMessages = [
    {
      id: "msg_suppressed_greeting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "晚上好",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
    {
      id: "msg_execute",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "在 README.md 中添加一句测试语句",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:11:00.000Z",
      updatedAt: "2026-05-25T00:11:00.000Z",
    },
  ];
  state.channelMessageRouteDecisions = [
    {
      schemaVersion: 1,
      id: "route_suppressed_greeting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_suppressed_greeting",
      mode: "auto_route",
      action: "no_reply",
      reason: "Mock suppressed greeting.",
      alternativesConsidered: [],
      status: "suppressed",
      createdBy: "model",
      createdAt: "2026-05-25T00:10:00.500Z",
      updatedAt: "2026-05-25T00:10:00.500Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_execute",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_execute",
      proposedByTeammateId: "ling_agent",
      title: "Edit README.md",
      prompt: "Edit README.md with one test sentence.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["README.md is updated."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Edit the requested file." }],
      requiredTools: ["edit"],
      riskSummary: "Need edit permission for README.md.",
      responseLanguage: "zh-CN",
      status: "draft",
      createdAt: "2026-05-25T00:11:01.000Z",
      updatedAt: "2026-05-25T00:11:01.000Z",
    },
  ];
  state.channelIntentDecisions = [
    {
      schemaVersion: 2,
      id: "intent_execute",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceTurnId: "turn_msg_execute",
      sourceItemId: "msg_execute",
      contextSegmentId: "segment_channel_engineering",
      contextProjectionVersion: "ctxv2_mock_msg_execute",
      action: "execute",
      selectedTeammateIds: [],
      proposalId: "proposal_execute",
      resultItemIds: [],
      execution: { kind: "file_edit", targetKind: "file" },
      reason: "Direct workflow proposal created by mock intent selector.",
      status: "accepted",
      createdBy: "deterministic",
      createdAt: "2026-05-25T00:11:00.500Z",
      updatedAt: "2026-05-25T00:11:00.500Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const proposalGate = page.locator('[data-conversation-decision-kind="task_proposal"]');
  await expect(proposalGate).toContainText("Edit README.md");
  await expect(page.getByRole("dialog", { name: /Task confirmation|任务确认/u })).toHaveCount(0);
  const feed = page.locator(".activity-shell");
  await expect(feed.getByText("晚上好")).toBeVisible();
  await expect(page.getByLabel(/Task proposal summary|任务提案摘要/u).filter({ hasText: "Edit README.md" })).toBeVisible({ timeout: 10_000 });
  await expect(feed.getByText("未自动回复")).toHaveCount(0);
  await expect(feed.getByText("为什么没回复")).toHaveCount(0);
  await expect(feed.getByText("Ling 未回复")).toHaveCount(0);
  await expect(feed.getByText("Ling did not reply")).toHaveCount(0);
  await expect(feed.getByText("Why no reply?")).toHaveCount(0);
  await expect(feed.getByText("直接工作流提案")).toHaveCount(0);
  await expect(feed.getByText("Direct workflow proposal")).toHaveCount(0);
  await expect(feed.getByText("为什么这样处理")).toHaveCount(0);
  await expect(feed.getByText("Why this handling?")).toHaveCount(0);
  expect(state.channelMessageRouteDecisions).toHaveLength(1);
  expect(state.channelIntentDecisions).toHaveLength(1);
});

test("channel context inspector exposes safe metadata and recovers from a stale segment correction", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const channelId = "channel_engineering";
  const threadId = "thread_context_inspect";
  const turnId = "turn_msg_context_inspect";
  const sourceItemId = "msg_context_inspect";
  const engineeringSegmentId = "segment_engineering";
  const researchSegmentId = "segment_research";
  const operationsSegmentId = "segment_operations";
  state.channelMessages = [
    {
      id: sourceItemId,
      workspaceId: "workspace_default",
      channelId,
      threadId,
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Continue the deployment architecture review.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-08-10T08:00:00.000Z",
      updatedAt: "2026-08-10T08:00:00.000Z",
    },
  ];
  state.channelIntentDecisions = [
    {
      schemaVersion: 2,
      id: "intent_context_inspect",
      workspaceId: "workspace_default",
      channelId,
      sourceTurnId: turnId,
      sourceItemId,
      contextSegmentId: engineeringSegmentId,
      contextProjectionVersion: "ctxv2_context_inspect_r1",
      action: "reply",
      selectedTeammateIds: ["engineer"],
      resultItemIds: [],
      reason: "Continue the current deployment architecture discussion.",
      status: "accepted",
      createdBy: "model_policy",
      createdAt: "2026-08-10T08:00:00.500Z",
      updatedAt: "2026-08-10T08:00:00.500Z",
    },
  ];
  const thread = {
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    channelId,
    title: "Engineering channel root",
    objective: "Coordinate engineering work",
    status: "active",
    conversationMode: { mode: "chat" },
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T08:00:00.000Z",
  };
  const turn = {
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    channelId,
    kind: "manual_followup",
    status: "succeeded",
    title: "Continue the deployment architecture review.",
    userInstruction: "Continue the deployment architecture review.",
    sourceItemId,
    createdByActor: "local-user",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T08:00:01.000Z",
    completedAt: "2026-08-10T08:00:01.000Z",
  };
  const segments = [
    {
      id: engineeringSegmentId,
      threadId,
      state: "active",
      label: "Engineering",
      createdFromTurnId: turnId,
      lastActiveTurnId: turnId,
      revision: 1,
      createdAt: "2026-08-10T07:00:00.000Z",
      updatedAt: "2026-08-10T08:00:00.000Z",
    },
    {
      id: researchSegmentId,
      threadId,
      state: "active",
      label: "Research",
      createdFromTurnId: "turn_research",
      lastActiveTurnId: "turn_research",
      revision: 1,
      createdAt: "2026-08-10T07:10:00.000Z",
      updatedAt: "2026-08-10T07:10:00.000Z",
    },
    {
      id: operationsSegmentId,
      threadId,
      state: "active",
      label: "Operations",
      createdFromTurnId: "turn_operations",
      lastActiveTurnId: "turn_operations",
      revision: 1,
      createdAt: "2026-08-10T07:20:00.000Z",
      updatedAt: "2026-08-10T07:20:00.000Z",
    },
  ];
  state.channelTurnContexts[turnId] = {
    thread,
    turn,
    sourceItemId,
    segment: segments[0],
    segments,
    assignment: {
      id: "assignment_context_inspect_r1",
      turnId,
      segmentId: engineeringSegmentId,
      status: "committed",
      revision: 1,
      decisionSource: "model_policy",
      confidence: 0.93,
      evidenceRefs: [{ type: "conversation_item", id: sourceItemId }],
      policyVersion: "continuity-v2-segmentation-v1",
      createdAt: "2026-08-10T08:00:00.100Z",
    },
    projection: {
      projectionVersion: "ctxv2_context_inspect_r1",
      sourceStateFingerprint: "source_context_inspect_r1",
      threadId,
      turnId,
      segmentId: engineeringSegmentId,
      throughItemSequence: 8,
      summaryIds: ["summary_context_inspect"],
      sourceRefs: [
        { type: "conversation_item", id: sourceItemId },
        { type: "context_summary", id: "summary_context_inspect" },
      ],
      policyVersion: "continuity-v2-projector-v1",
      visibilityFingerprint: "visibility_context_inspect",
    },
    summaries: [
      {
        id: "summary_context_inspect",
        threadId,
        segmentId: engineeringSegmentId,
        scope: "segment",
        status: "active",
        version: 1,
        coveredFromSequence: 1,
        coveredThroughSequence: 6,
        decisions: [],
        constraints: [],
        openQuestions: [],
        activeWorkRefs: [],
        sourceRefs: [{ type: "conversation_item", id: sourceItemId }],
        policyVersion: "continuity-v2-summary-v1",
        createdAt: "2026-08-10T07:50:00.000Z",
      },
    ],
    sourceRefs: [
      { type: "conversation_item", id: sourceItemId },
      { type: "context_summary", id: "summary_context_inspect" },
    ],
    droppedItemCount: 2,
    redactedItemCount: 1,
    safety: {
      rawPromptTextIncluded: false,
      hiddenReasoningIncluded: false,
      privateMemoryBodiesIncluded: false,
      secretValuesIncluded: false,
    },
  };
  state.staleNextChannelTurnContextCorrection = { segmentId: researchSegmentId };

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".channel-side-panel.right-dock");
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Activity" }).click();
  await dock.getByRole("button", { name: "Routing" }).click();
  const intentRow = dock.locator(".routing-evidence-row").filter({ hasText: "Reply" });
  await expect(intentRow).toBeVisible();
  await intentRow.getByRole("button", { name: "Inspect" }).click();
  const detail = intentRow.locator(".routing-evidence-detail");
  const contextSection = detail.locator(".channel-route-inspect-section").filter({ hasText: "Context inspect summary" });
  await expect(contextSection).toContainText(threadId);
  await expect(contextSection).toContainText(turnId);
  await expect(contextSection).toContainText(engineeringSegmentId);
  await expect(contextSection).toContainText("ctxv2_context_inspect_r1");
  await expect(contextSection).toContainText("Item watermark8");
  await expect(contextSection).toContainText("Summary coverage1-6");
  await expect(contextSection.getByText("conversation_item:msg_context_inspect", { exact: true })).toBeVisible();
  await expect(contextSection.getByText("context_summary:summary_context_inspect", { exact: true })).toBeVisible();
  await expect(contextSection).toContainText("Dropped items2");
  await expect(contextSection).toContainText("Redacted items1");
  await expect(detail).not.toContainText("RAW_PROMPT_SENTINEL");
  await expect(detail).not.toContainText("HIDDEN_REASONING_SENTINEL");
  await expect(detail).not.toContainText("PRIVATE_MEMORY_SENTINEL");
  await expect(detail).not.toContainText("SECRET_VALUE_SENTINEL");

  const segmentSelect = contextSection.getByLabel("Correct context segment");
  await segmentSelect.selectOption(operationsSegmentId);
  await contextSection.getByRole("button", { name: "Apply context correction" }).click();
  await expect(contextSection.getByRole("alert")).toContainText("Context changed while you were editing");
  await expect(segmentSelect).toHaveValue(researchSegmentId);
  expect(state.channelTurnContextCorrectionRequests[0]).toEqual({
    channelId,
    turnId,
    segmentId: operationsSegmentId,
    expectedAssignmentRevision: 1,
  });

  await segmentSelect.selectOption(operationsSegmentId);
  await contextSection.getByRole("button", { name: "Apply context correction" }).click();
  await expect(contextSection.getByRole("alert")).toHaveCount(0);
  await expect(segmentSelect).toHaveValue(operationsSegmentId);
  await expect(contextSection.getByText(operationsSegmentId, { exact: true })).toBeVisible();
  expect(state.channelTurnContextCorrectionRequests[1]).toEqual({
    channelId,
    turnId,
    segmentId: operationsSegmentId,
    expectedAssignmentRevision: 2,
  });
});

test("channel settings can add and remove teammates without preferred specialist controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
  const initialDefaultTeammateId = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering")?.defaultTeammateId;
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "AI teammate management" }).click();
  let manager = page.getByLabel("Channel teammates");
  await expect(manager).toContainText("No teammates in this channel");
  const teammateDock = page.locator(".channel-teammate-dock");
  await expect.poll(async () => Math.round((await teammateDock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(760);
  await expect(manager).toHaveCSS("padding-left", "16px");
  await expect(manager).toHaveCSS("padding-right", "16px");
  await page.getByRole("button", { name: "AI teammate management" }).click();
  await expect(manager).toHaveCount(0);
  await page.getByRole("button", { name: "AI teammate management" }).click();
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
  await expect(engineerChip).toHaveCSS("border-top-width", "1px");
  const engineerAvatar = engineerChip.locator(".teammate-avatar-image");
  await expect(engineerAvatar).toHaveCSS("border-top-width", "0px");
  await expect(engineerAvatar).toHaveCSS("box-shadow", "none");
  await expect(engineerChip.getByRole("button", { name: "Remove from channel" })).toHaveCount(1);
  await expect(engineerChip.getByRole("button", { name: "Ling Engineer" })).toHaveCount(0);
  await expect(engineerChip).not.toHaveClass(/default/);

  await engineerChip.locator(".channel-teammate-chip-main").click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultTeammateId : undefined;
  }).toBe(initialDefaultTeammateId);
  await expect(engineerChip).not.toHaveClass(/default/);

  await manager.getByLabel("Add teammate").selectOption("teammate_builtin_designer");
  await manager.getByRole("button", { name: "Add", exact: true }).click();
  const designerChip = manager.locator(".channel-teammate-chip").filter({ hasText: "Ling Designer" });
  await expect(designerChip).toBeVisible();
  await expect(designerChip.getByRole("button", { name: "Ling Designer" })).toHaveCount(0);
  await designerChip.locator(".channel-teammate-chip-main").click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultTeammateId : undefined;
  }).toBe(initialDefaultTeammateId);
  await expect(designerChip).not.toHaveClass(/default/);

  await engineerChip.getByRole("button", { name: "Remove from channel" }).click({ force: true });
  await expect.poll(() => state.teammateChannelMemberships.some((membership) =>
    isRecord(membership) &&
    membership.teammateId === "teammate_builtin_engineer" &&
    membership.channelId === "channel_engineering"
  )).toBe(false);
  await expect(engineerChip).toHaveCount(0);
  await expect(designerChip).toBeVisible();
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const notifications = page.getByLabel("Channel notifications");
  await notifications.getByRole("radio", { name: "Muted" }).click();
  await expect(notifications.getByRole("radio", { name: "Muted" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => {
    const channelNotifications = state.workspaceSettings.channelNotifications;
    return isRecord(channelNotifications) ? channelNotifications.channel_engineering : undefined;
  }).toBe("muted");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.channelNotifications.%2Ftmp%2Fling-stack-workspace.channel_engineering"))).toBeNull();

  await page.reload();
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByLabel("Channel notifications").getByRole("radio", { name: "Muted" })).toHaveAttribute("aria-checked", "true");
});

test("channel settings attaches an AI council by reference", async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    consoleMessages.push(`pageerror: ${error.message}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
    createMockTeammate({
      id: "teammate_builtin_qa",
      templateId: "qa",
      roleKey: "qa",
      displayName: "Ling QA",
      description: "Owns verification.",
    }),
    createMockTeammate({
      id: "ling_agent",
      templateId: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      displayName: "Ling Agent",
      roleKey: "custom",
    }),
  ];
  state.aiCouncilMembers = [
    ...state.aiCouncilMembers,
    {
      councilId: "council_builtin_development",
      teammateId: "ling_agent",
      slotKey: "coordination",
      label: "Coordination",
      position: 99,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
  state.teammateChannelMemberships = [
    {
      teammateId: "teammate_builtin_engineer",
      channelId: "channel_engineering",
      isDefault: false,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settingsTabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await settingsTabs.getByRole("tab", { name: "Councils" }).click();
  const councils = page.getByLabel("Channel AI councils");
  await expect(councils).toContainText("No AI councils attached");
  await councils.getByLabel("Attach AI council").selectOption("council_builtin_development");
  await councils.getByRole("button", { name: "Attach" }).click();

  await expect.poll(() => {
    const policy = state.channelCouncilPolicies.find((item) => isRecord(item) && item.channelId === "channel_engineering");
    return isRecord(policy) && Array.isArray(policy.attachedCouncilIds) ? policy.attachedCouncilIds.join(",") : "";
  }).toBe("council_builtin_development");
  await expect(councils).toContainText("Development Council");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Parallel review");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Max active 4");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Reference collection");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Policy narrows authority");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Cannot bypass approvals");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Cannot grant tools");
  await expect(councils.getByLabel("Council boundaries")).toContainText("Cannot grant credentials");
  await expect(councils.getByLabel("Council health", { exact: true })).toContainText("1 warning finding(s)");
  await expect(councils.getByLabel("Projected council specialists")).toContainText("Ling Designer");
  await expect(councils.getByLabel("Projected council specialists")).toContainText("Ling QA");
  await expect(councils.getByLabel("Projected council specialists")).toContainText("Development Council · Product design");
  await expect(councils.getByLabel("Projected council specialists")).toContainText("Development Council · Verification");
  await expect(councils.getByLabel("Projected council specialists")).not.toContainText("Ling Agent");

  await settingsTabs.getByRole("tab", { name: "Members" }).click();
  const directTeammates = page.getByLabel("Channel teammates");
  await expect(directTeammates.locator(".channel-teammate-chip")).toHaveCount(1);
  await expect(directTeammates).toContainText("Ling Engineer");
  await expect(directTeammates.locator(".channel-teammate-chip").filter({ hasText: "Ling Designer" })).toHaveCount(0);
  expect(state.teammateChannelMemberships.filter((item) => isRecord(item) && item.channelId === "channel_engineering")).toHaveLength(1);

  await settingsTabs.getByRole("tab", { name: "Councils" }).click();
  await councils.getByRole("button", { name: "Detach council" }).click();
  await expect.poll(() => {
    const policy = state.channelCouncilPolicies.find((item) => isRecord(item) && item.channelId === "channel_engineering");
    return isRecord(policy) && Array.isArray(policy.attachedCouncilIds) ? policy.attachedCouncilIds.length : -1;
  }).toBe(0);
  await expect(councils).toContainText("No AI councils attached");
  expect(state.teammateChannelMemberships.filter((item) => isRecord(item) && item.channelId === "channel_engineering")).toHaveLength(1);
  expect(consoleMessages.filter((message) => !message.includes("Failed to load resource"))).toEqual([]);
});

test("channel council settings hide clear health and redundant compact status dots", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "teammate_builtin_designer", displayName: "Ling Designer" }),
    createMockTeammate({ id: "teammate_builtin_qa", displayName: "Ling QA" }),
  ];
  state.channelCouncilPolicies = [{
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    attachedCouncilIds: ["council_builtin_development"],
    preferredCouncilId: "council_builtin_development",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  }];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settingsTabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await settingsTabs.getByRole("tab", { name: "Councils" }).click();
  const councils = page.getByLabel("Channel AI councils");
  const council = councils.locator(".channel-council-card").filter({ hasText: "Development Council" });

  await expect(council).toBeVisible();
  await expect.poll(() => state.aiCouncilHealthRequestCount ?? 0).toBeGreaterThan(0);
  await expect(councils.getByText("Health clear", { exact: true })).toHaveCount(0);
  await expect(councils.getByLabel("Council health", { exact: true })).toHaveCount(0);
  await expect(councils.locator(".channel-settings-section-head .ling-ui-status-indicator")).toHaveCount(0);
  await expect(council.locator(".ling-ui-data-row-status")).toHaveCount(0);
  await expect(council.getByRole("button", { name: "Preferred" })).toBeVisible();
});

test("channel message feed renders AI teammate avatar images", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      avatarImageAttachmentId: "tpatt_designer_avatar",
    }),
    createMockTeammate({
      id: "teammate_builtin_engineer",
      templateId: "engineer",
      roleKey: "engineer",
      displayName: "Ling Engineer",
      avatarImageAttachmentId: "tpatt_missing_engineer_avatar",
    }),
  ];
  state.teammatePrivateAttachments = [
    {
      id: "tpatt_designer_avatar",
      workspaceId: "workspace_default",
      teammateId: "teammate_builtin_designer",
      scope: "teammate_profile_avatar",
      kind: "image",
      fileName: "designer.png",
      contentType: "image/png",
      sizeBytes: 67,
      path: "teammates/teammate_builtin_designer/avatar/mock",
      createdAt: "2026-06-04T00:11:00.000Z",
    },
  ];
  state.teammateChannelMemberships = [
    {
      teammateId: "teammate_builtin_designer",
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_designer_avatar_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_designer",
      body: "Designer reply with profile avatar.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:01.000Z",
      updatedAt: "2026-05-25T00:18:01.000Z",
    },
    {
      id: "msg_engineer_missing_avatar_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_engineer",
      body: "Engineer reply with a missing profile avatar.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:18:02.000Z",
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const designerReply = page.getByLabel("Channel message feed").locator(".channel-message-row").filter({ hasText: "Designer reply with profile avatar." });
  await expect(designerReply).toBeVisible();
  await expect(designerReply.locator(".teammate-avatar-image")).toBeVisible();
  await expect(designerReply.locator(".avatar-initial")).toHaveCount(0);
  await expect(designerReply.locator(".teammate-avatar-image")).toHaveAttribute("src", /\/attachments\/tpatt_designer_avatar\/content/);

  const engineerReply = page.getByLabel("Channel message feed").locator(".channel-message-row").filter({ hasText: "Engineer reply with a missing profile avatar." });
  await expect(engineerReply).toBeVisible();
  await expect(engineerReply.locator(".teammate-avatar-image-default")).toBeVisible();
  await expect(engineerReply.locator(".teammate-avatar-image-default")).toHaveAttribute(
    "src",
    /^(?:\.\/|\/)avatars\/teammates\/engineer\.png$/u,
  );
  await expect(engineerReply.locator(".avatar-initial")).toHaveCount(0);
});

test("channel message feed shows usable web sources and keeps diagnostics in the right dock", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Ling Engineer" })];
  state.channelMessages = [
    {
      id: "msg_web_evidence_available",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "engineer",
      body: "Web-backed reply with source.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      webEvidence: {
        status: "available",
        query: "latest Ling Stack release",
        provider: {
          adapterId: "openai-responses-web-search",
          providerPresetId: "provider_openai_responses",
          displayName: "OpenAI Responses + Web Search",
        },
        sources: [
          {
            url: "https://example.com/ling-release",
            title: "Ling release note",
            snippet: "Release evidence snippet.",
          },
        ],
        readUrls: [
          {
            url: "https://example.com/ling-release",
            status: "available",
            finalUrl: "https://example.com/ling-release",
          },
        ],
        updatedAt: "2026-06-24T00:20:00.000Z",
      },
      createdAt: "2026-06-24T00:20:00.000Z",
      updatedAt: "2026-06-24T00:20:00.000Z",
    },
    {
      id: "msg_web_evidence_degraded",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "engineer",
      body: "Degraded web reply.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      webEvidence: {
        status: "degraded",
        query: "AI news today",
        queries: ["查一下今天热门 AI 的新闻", "AI news today", "latest AI news"],
        provider: {
          adapterId: "openai-chat-completions-web-search",
          providerPresetId: "provider_chat_search",
          displayName: "Chat Completions Search Relay",
        },
        reason: "web_search backend returned a summary but no source URLs.",
        sources: [],
        readUrls: [],
        updatedAt: "2026-06-24T00:20:30.000Z",
      },
      createdAt: "2026-06-24T00:20:30.000Z",
      updatedAt: "2026-06-24T00:20:30.000Z",
    },
    {
      id: "msg_web_evidence_blocked",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "engineer",
      body: "Blocked web reply.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      webEvidence: {
        status: "blocked",
        query: "latest Ling Stack release",
        reason: "Current selected Ling provider does not support realtime web search.",
        sources: [],
        readUrls: [],
        updatedAt: "2026-06-24T00:21:00.000Z",
      },
      createdAt: "2026-06-24T00:21:00.000Z",
      updatedAt: "2026-06-24T00:21:00.000Z",
    },
    {
      id: "msg_web_evidence_configured_only",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "engineer",
      body: "Configured web search but no actual evidence.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      webEvidence: {
        status: "available",
        query: "OpenAI news today",
        provider: {
          adapterId: "openai-chat-completions-web-search",
          providerPresetId: "provider_chat_search",
          displayName: "Custom OpenAI-compatible",
        },
        sources: [],
        readUrls: [],
        updatedAt: "2026-06-24T00:21:30.000Z",
      },
      createdAt: "2026-06-24T00:21:30.000Z",
      updatedAt: "2026-06-24T00:21:30.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();

  const feed = page.getByLabel("Channel message feed");
  const sourcedReply = feed.locator(".channel-message-row").filter({ hasText: "Web-backed reply with source." });
  const sourcedActions = sourcedReply.locator(".channel-message-ai-actions");
  await expect(sourcedActions.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  await expect(sourcedActions.getByRole("button", { name: "Like response", exact: true })).toHaveCount(1);
  await expect(sourcedActions.getByRole("button", { name: "Dislike response", exact: true })).toHaveCount(1);
  await expect(sourcedActions.getByRole("button", { name: "Reply in topic", exact: true })).toHaveCount(1);
  const sourcedEvidence = sourcedReply.getByLabel("Message evidence");
  const sourcedToggle = sourcedEvidence.getByRole("button");
  await expect(sourcedToggle).toBeVisible();
  await expect(sourcedToggle.locator(".source-icon-stack")).toHaveCount(1);
  await expect(sourcedToggle.locator(".source-icon-stack a")).toHaveCount(0);
  await sourcedToggle.click();
  await expect(sourcedEvidence).toContainText("Ling release note");
  await expect(sourcedEvidence).toContainText("example.com");
  await expect(sourcedEvidence).toContainText("open_url");
  await expect(sourcedEvidence).not.toContainText("latest Ling Stack release");
  await expect(sourcedEvidence).not.toContainText("OpenAI Responses + Web Search");

  const degradedReply = feed.locator(".channel-message-row").filter({ hasText: "Degraded web reply." });
  await expect(degradedReply.getByLabel("Message evidence")).toHaveCount(0);
  await expect(degradedReply).not.toContainText("web_search backend returned a summary but no source URLs.");

  const blockedReply = feed.locator(".channel-message-row").filter({ hasText: "Blocked web reply." });
  await expect(blockedReply.getByLabel("Message evidence")).toHaveCount(0);
  await expect(blockedReply).not.toContainText("Current selected Ling provider does not support realtime web search.");

  const configuredOnlyReply = feed.locator(".channel-message-row").filter({ hasText: "Configured web search but no actual evidence." });
  await expect(configuredOnlyReply).toBeVisible();
  await expect(configuredOnlyReply.getByLabel("Message evidence")).toHaveCount(0);
  await expect(configuredOnlyReply.locator(".source-icon-stack")).toHaveCount(0);
  await expect(configuredOnlyReply).not.toContainText("OpenAI news today");
  await expect(configuredOnlyReply).not.toContainText("Custom OpenAI-compatible");
  await expect(configuredOnlyReply).not.toContainText("openai-chat-completions-web-search");

  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".channel-side-panel.right-dock");
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Browser" }).click();
  const degradedDiagnostic = dock.locator(".right-dock-evidence-row").filter({ hasText: "web_search backend returned a summary but no source URLs." });
  await expect(degradedDiagnostic).toBeVisible();
  await expect(degradedDiagnostic).toContainText("Degraded");
  await degradedDiagnostic.click();
  const degradedDetail = dock.locator(".right-dock-detail-list");
  await expect(degradedDetail).toContainText("Failure reason");
  await expect(degradedDetail).toContainText("web_search backend returned a summary but no source URLs.");
  await expect(degradedDetail).toContainText("web_search");
});

test("right dock browser evidence exposes failed read URL detail", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Ling Engineer" })];
  state.channelMessages = [
    {
      id: "msg_web_evidence_failed_read_url",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "engineer",
      body: "Failed read URL reply.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      webEvidence: {
        status: "degraded",
        query: "read failed source",
        reason: "One requested URL could not be read.",
        provider: {
          adapterId: "openai-responses-web-search",
          providerPresetId: "provider_openai_responses",
          displayName: "OpenAI Responses + Web Search",
        },
        sources: [],
        readUrls: [
          {
            url: "https://example.com/private-report",
            status: "blocked",
            reason: "HTTP 403 Forbidden",
          },
        ],
        updatedAt: "2026-06-24T00:22:00.000Z",
      },
      createdAt: "2026-06-24T00:22:00.000Z",
      updatedAt: "2026-06-24T00:22:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".channel-side-panel.right-dock");
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Browser" }).click();

  const failedRow = dock.locator(".right-dock-evidence-row").filter({ hasText: "https://example.com/private-report" });
  await expect(failedRow).toBeVisible();
  await expect(failedRow).toContainText("Failed");
  await expect(failedRow).toContainText("Read URL");
  await failedRow.click();

  const detail = dock.locator(".right-dock-detail-list");
  await expect(detail).toContainText("Status");
  await expect(detail).toContainText("Failed");
  await expect(detail).toContainText("Link");
  await expect(detail).toContainText("https://example.com/private-report");
  await expect(detail).toContainText("Failure reason");
  await expect(detail).toContainText("HTTP 403 Forbidden");
  await expect(detail.locator("a.right-dock-evidence-link")).toHaveAttribute("href", "https://example.com/private-report");
});

test("conversation turn transcript omits web diagnostics without usable sources", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    {
      id: "msg_web_turn_user",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "帮我整理一下今天热门 AI 的新闻",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-06-24T00:22:00.000Z",
      updatedAt: "2026-06-24T00:22:00.000Z",
    },
    {
      id: "msg_web_turn_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_web_turn_user",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "Here is the AI news summary.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      webEvidence: {
        status: "degraded",
        query: "AI news today",
        queries: ["帮我整理一下今天热门 AI 的新闻", "AI latest news", "AI news today", "今日 AI 新闻"],
        provider: {
          adapterId: "openai-chat-completions-web-search",
          providerPresetId: "provider_chat_search",
          displayName: "Chat Completions Search Relay",
        },
        reason: "web_search backend returned text but no citation/source metadata.",
        sources: [],
        readUrls: [],
        updatedAt: "2026-06-24T00:22:30.000Z",
      },
      createdAt: "2026-06-24T00:22:30.000Z",
      updatedAt: "2026-06-24T00:22:30.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();

  const turn = page.locator('[data-conversation-turn-id="conversation-turn:msg_web_turn_user"]');
  await expect(turn).toBeVisible();
  await expect(turn).toContainText("Here is the AI news summary.");
  await expect(turn.getByLabel("Message evidence")).toHaveCount(0);
  await expect(turn).not.toContainText("web_search backend returned text but no citation/source metadata.");
});

test("channel settings manage workspace binding", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator(".channel-workspace-badge")).toHaveCount(0);

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settingsTabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await settingsTabs.getByRole("tab", { name: "Workspace" }).click();
  const workspaceSettings = page.getByLabel("Channel workspace settings");
  const workspaceControl = workspaceSettings.getByLabel("Channel workspace");
  const workspaceMode = workspaceControl.locator(".channel-workspace-mode-label");
  await expect(workspaceMode).toHaveText("Local");
  await expect(workspaceControl.locator(".ling-ui-status-indicator")).toHaveCount(0);
  await expect(workspaceControl.locator(".channel-workspace-summary")).toHaveCount(0);
  const executionPathInput = workspaceSettings.getByLabel("Execution path");
  const manualExecutionPath = "/tmp/manual-channel-path";
  await executionPathInput.fill(manualExecutionPath);
  await expect(workspaceSettings.getByRole("button", { name: "Save" })).toBeEnabled();
  await workspaceSettings.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    if (!isRecord(channel) || !isRecord(channel.workspaceBinding)) {
      return undefined;
    }
    return [channel.boundPath, channel.workspaceBinding.mode, channel.workspaceBinding.executionPath];
  }).toEqual([manualExecutionPath, "local", manualExecutionPath]);

  const selectedExecutionPath = "/Users/example/workspace/projects";
  await workspaceSettings.getByRole("button", { name: "Change directory" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    if (!isRecord(channel) || !isRecord(channel.workspaceBinding)) {
      return undefined;
    }
    return [channel.boundPath, channel.workspaceBinding.mode, channel.workspaceBinding.executionPath];
  }).toEqual([selectedExecutionPath, "local", selectedExecutionPath]);
  await expect(executionPathInput).toHaveValue(selectedExecutionPath);
  const openWorkspaceRequest = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/channels/channel_engineering/workspace/open"
  );
  await workspaceControl.getByRole("button", { name: "Open path" }).click();
  await openWorkspaceRequest;
  await expect(workspaceControl).not.toContainText("Opening workspace path.");
  await expect(workspaceControl.locator(".inline-success")).toHaveCount(0);
  await expect(workspaceControl.getByRole("button", { name: "Open path" })).toBeEnabled();
  await workspaceControl.getByRole("button", { name: "Create worktree" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.mode : "";
  }).toBe("managed_worktree");
  await expect(workspaceMode).toHaveText("Worktree");

  await workspaceControl.getByPlaceholder("External workspace path").fill("/tmp/external-channel-workspace");
  await workspaceControl.getByRole("button", { name: "Hand off to External" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.executionPath : "";
  }).toBe("/tmp/external-channel-workspace");
  await expect(workspaceMode).toHaveText("External");

  await workspaceControl.getByRole("button", { name: "Hand off to Local" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.mode : "";
  }).toBe("local");
  await expect(workspaceMode).toHaveText("Local");
});

test("channel more menu renames the selected channel", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  const menu = page.getByRole("menu", { name: "More channel views" });
  await menu.getByRole("menuitem", { name: "Rename channel" }).click();

  const dialog = page.getByRole("dialog", { name: "Rename channel" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Channel name")).toHaveValue("Engineering");
  await dialog.getByLabel("Channel name").fill("v0.1 Smoke");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.name : "";
  }).toBe("v0.1 Smoke");
  await expect(page.getByRole("heading", { name: "v0.1 Smoke", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "v0.1 Smoke" })).toBeVisible();
});

test("paused channels disable task run actions", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
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
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-05-25T00:11:00.000Z",
    },
  })];
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
  state.channelMessageDelayMs = 150;
  state.linkPreviewDelayMs = 150;
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator('.channel-composer [aria-label="Composer mode"]')).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Task" })).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByText("Discuss")).toHaveCount(0);
  await expect(page.locator(".channel-composer").getByText("@ teammates, drop files, or paste links")).toHaveCount(0);
  const composerInput = channelComposerTextbox(page);
  await expect(page.getByLabel("Message tools").getByRole("button", { name: "Add" })).toBeVisible();
  await page.getByLabel("Message tools").getByRole("button", { name: "Add" }).click();
  const addMenu = page.getByRole("menu", { name: "Add" });
  await expect(addMenu.getByRole("menuitem", { name: /Attach files/ })).toBeVisible();
  await expect(addMenu.locator(".composer-add-menu-row small")).toHaveCount(0);
  await expect(addMenu).not.toContainText("Add files or folders to this message");
  await expect(addMenu).not.toContainText("Plan first, then implement after review");
  await expect(addMenu).not.toContainText("Set a thread goal");
  await page.getByLabel("Message tools").getByRole("button", { name: "Add" }).click();
  await expect(page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" })).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Send" })).toBeVisible();
  await page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" }).click();
  await expectComposerValue(composerInput, "@");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composerInput.fill("@Eng");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await page.getByRole("option", { name: /@Engineer/ }).click();
  await expect(page.locator(".channel-composer .composer-inline-token.mention").filter({ hasText: "Engineer" })).toBeVisible();
  await expectComposerValue(composerInput, "@Engineer ");
  await composerInput.fill("please refine without mention");
  await expectComposerValue(composerInput, "please refine without mention");
  await composerInput.fill("@Engineer please refine the channel requirements https://example.com");
  await expectComposerValue(composerInput, "@Engineer please refine the channel requirements https://example.com");
  await expect(page.getByText("Example Domain").first()).toBeVisible({ timeout: 3_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["channel brief"], "brief.txt", { type: "text/plain" }));
    return transfer;
  });
  const dropZone = page.locator(
    '[data-conversation-composer="true"][data-surface="channel"] .conversation-composer-input-zone',
  );
  await dropZone.dispatchEvent("dragover", { dataTransfer });
  await expect(page.getByText("Drop files to attach")).toBeVisible();
  await dropZone.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  const pendingAssets = page.getByLabel("Pending message assets");
  await expect(pendingAssets).toContainText("brief.txt");
  const previewLayout = await page.locator(".channel-composer").evaluate((element) => {
    const preview = element.querySelector(".composer-preview-strip");
    const input = element.querySelector(".tokenized-composer-input");
    if (!preview || !input) {
      return null;
    }
    return {
      previewTop: preview.getBoundingClientRect().top,
      inputTop: input.getBoundingClientRect().top,
    };
  });
  if (!previewLayout) {
    throw new Error("Expected composer pending assets to render before the composer input.");
  }
  expect(previewLayout.previewTop).toBeLessThan(previewLayout.inputTop);
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
  await expect(page.getByText("收到，我会按频道上下文推进。")).toBeVisible();
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
  await expect.poll(() => state.lastChannelTurnRequest?.providerPresetId).toBe("provider_local");
  const sentMessage = page.locator(".message-bubble").filter({ hasText: "@Engineer please refine the channel requirements" });
  await expect(sentMessage.getByRole("link", { name: /brief\.txt/ })).toBeVisible();
  await expect(sentMessage.getByRole("link", { name: /shot\.png/ })).toBeVisible();
  expect(state.channelLinkPreviews.some((preview) => isRecord(preview) && preview.title === "Example Domain")).toBe(true);
  const sentReferences = sentMessage.getByLabel("References");
  const webReference = sentReferences.getByRole("link", { name: /Example Domain/ });
  await expect(webReference).toBeVisible();
  await webReference.hover();
  await expect(sentReferences.getByRole("tooltip")).toContainText("Example Domain");
  await page.mouse.move(4, 4);
  await expect(sentReferences.getByRole("tooltip")).toHaveCount(0);
  await page.getByRole("button", { name: "More channel views" }).click();
  const viewMenu = page.getByRole("menu", { name: "More channel views" });
  await expect(viewMenu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(viewMenu.getByRole("menuitem", { name: "Files" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(viewMenu).toHaveCount(0);

  const teammateReply = page.locator(".message-bubble").filter({ hasText: "收到，我会按频道上下文推进。" });
  const sentMessageContent = sentMessage.locator(".message-content");
  const teammateReplyContent = teammateReply.locator(".message-content");
  await expect(sentMessage).toBeVisible();
  await expect(teammateReply).toBeVisible();
  await expect(sentMessage).toHaveClass(/message-bubble-chat/);
  await expect(sentMessage).toHaveClass(/message-bubble-own/);
  await expect(teammateReply).toHaveClass(/message-bubble-chat/);
  await expect(teammateReply).toHaveClass(/message-bubble-peer/);
  await expect(sentMessage.locator(".message-mention-token")).toContainText("@Engineer");
  const [feedRect, ownRect, peerRect] = await Promise.all([
    page.locator(".message-feed").boundingBox(),
    sentMessageContent.boundingBox(),
    teammateReplyContent.boundingBox(),
  ]);
  if (!feedRect || !ownRect || !peerRect) {
    throw new Error("Expected own and peer chat bubbles to render in the message feed.");
  }
  const messageLayout = {
    feedLeft: feedRect.x,
    feedRight: feedRect.x + feedRect.width,
    ownLeft: ownRect.x,
    ownRight: ownRect.x + ownRect.width,
    peerLeft: peerRect.x,
    peerRight: peerRect.x + peerRect.width,
  };
  expect(messageLayout.ownRight).toBeGreaterThan(messageLayout.feedRight - 64);
  expect(messageLayout.peerLeft).toBeLessThan(messageLayout.feedLeft + 48);
  expect(messageLayout.ownLeft).toBeGreaterThan(messageLayout.peerLeft);
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
  await expect(sentMessageContent).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(sentMessageContent).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(sentMessageContent).toHaveCSS("padding-top", "8px");
  await expect(sentMessageContent).toHaveCSS("border-radius", "8px");
  await teammateReply.hover();
  await expect(teammateReplyContent).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(teammateReplyContent).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(teammateReplyContent).toHaveCSS("padding-top", "0px");
  await page.mouse.move(8, 8);
  await expect(sentMessage.locator(".message-meta-action")).toHaveCount(0);
  await expect(sentMessage.getByRole("button", { name: "Reply in topic" })).toHaveCount(0);
  const topicReplyButton = teammateReply.getByRole("button", { name: "Reply in topic", exact: true });
  const topicReplyTooltip = page.locator('[data-ling-overlay="tooltip"]').filter({ hasText: "Reply in topic" });
  await teammateReply.hover();
  await topicReplyButton.hover();
  await expect(topicReplyTooltip).toHaveCount(1);
  await expect(topicReplyTooltip).toBeVisible();
  await page.mouse.move(8, 8);
  await topicReplyButton.focus();
  await expect(topicReplyTooltip).toHaveCount(1);
  await expect(topicReplyTooltip).toBeVisible();
  await topicReplyButton.click();
  const topicPanel = page.getByLabel("Topic replies");
  await expect(topicPanel).toBeVisible();
  await expect(topicPanel).toContainText("收到，我会按频道上下文推进。");
  await topicPanel.getByLabel("Topic reply input").fill("Thread follow-up from the topic panel");
  await topicPanel.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({
    kind: "thread",
    threadId: "thread_topic_channel_engineering_msg_1",
  });
  await expect(topicPanel).toContainText("Thread follow-up from the topic panel");
});

test("channel composer snapshots restore draft assets and topic replies across channel switches", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.linkPreviewDelayMs = 50;
  state.channels = [
    ...state.channels,
    {
      id: "channel_design",
      workspaceId: "workspace_default",
      name: "Design",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "designer",
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls"],
      runtimePolicy: defaultRuntimePolicy,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_snapshot_root",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Snapshot source message",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:20:00.000Z",
      updatedAt: "2026-05-25T00:20:00.000Z",
    },
    {
      id: "msg_snapshot_reply",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_snapshot_root",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: `Snapshot reply ready.\n\n${sharedConversationRichBody}`,
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:20:01.000Z",
      updatedAt: "2026-05-25T00:20:01.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const navigation = page.getByLabel("Ling Stack navigation");
  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("Engineering snapshot draft https://example.com");
  await expect(page.getByText("Example Domain").first()).toBeVisible({ timeout: 3_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["snapshot brief"], "snapshot.txt", { type: "text/plain" }));
    return transfer;
  });
  await page.locator(
    '[data-conversation-composer="true"][data-surface="channel"] .conversation-composer-input-zone',
  ).dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByLabel("Pending message assets")).toContainText("snapshot.txt");

  const teammateReply = page.locator(".message-bubble").filter({ hasText: "Snapshot reply ready." });
  await teammateReply.hover();
  await teammateReply.getByRole("button", { name: "Reply in topic" }).click();
  const topicPanel = page.getByLabel("Topic replies");
  await expect(topicPanel).toBeVisible();
  await expectSharedConversationRichBody(topicPanel);
  await topicPanel.getByLabel("Topic reply input").fill("Engineering topic reply draft");

  await navigation.getByRole("button", { name: "Design" }).click();
  await expect(page.getByRole("heading", { name: "Design", level: 1 })).toBeVisible();
  await expectComposerValue(composerInput, "");
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
  await expect(page.getByLabel("Topic replies")).toHaveCount(0);
  await composerInput.fill("Design snapshot draft");

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expectComposerValue(composerInput, "Engineering snapshot draft https://example.com");
  await expect(page.getByLabel("Pending message assets")).toContainText("snapshot.txt");
  await expect(page.getByText("Example Domain").first()).toBeVisible();
  await expect(topicPanel).toBeVisible();
  await expect(topicPanel.getByLabel("Topic reply input")).toHaveValue("Engineering topic reply draft");

  await navigation.getByRole("button", { name: "Design" }).click();
  await expect(page.getByRole("heading", { name: "Design", level: 1 })).toBeVisible();
  await expectComposerValue(composerInput, "Design snapshot draft");
});

test("latest channel prompt edits in place and hides its superseded reply", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [{
    id: "msg_channel_edit_source",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Original channel prompt",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:20:00.000Z",
    updatedAt: "2026-07-12T03:20:00.000Z",
  }, {
    id: "msg_channel_edit_old_reply",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "msg_channel_edit_source",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: "Old channel response should disappear.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:20:01.000Z",
    updatedAt: "2026-07-12T03:20:01.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const userRow = feed.locator(".channel-message-row.local-user");
  await userRow.hover();
  await userRow.getByRole("button", { name: "Edit message" }).click();
  await feed.getByLabel("Edit message").fill("Revised channel prompt");
  await feed.getByRole("button", { name: "Save and resend" }).click();

  await expect(feed).toContainText("Revised channel prompt");
  await expect(feed).toContainText("Edited reply: Revised channel prompt");
  await expect(feed).not.toContainText("Original channel prompt");
  await expect(feed).not.toContainText("Old channel response should disappear.");
  await expect.poll(() => state.lastConversationMessageEditRequest?.surface).toBe("channel_root");
  await expect.poll(() => state.lastConversationMessageEditRequest?.messageId).toBe("msg_channel_edit_source");
  await expect.poll(() => state.channelMessages.find((message) =>
    isRecord(message) && message.body === "Edited reply: Revised channel prompt"
  )).toMatchObject({
    threadId: "thread_channel_channel_engineering",
    sourceItemId: "msg_channel_edit_source",
  });
});

test("pending channel replacement survives refresh and retries with the original idempotency key", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [{
    id: "msg_channel_edit_pending",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Revised prompt waiting for a response",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    revision: 2,
    editedAt: "2026-07-12T03:22:00.000Z",
    pendingReplacement: {
      supersessionId: "supersession_channel_pending",
      idempotencyKey: "channel-edit-pending-key",
      failureReason: "Provider temporarily unavailable",
    },
    createdAt: "2026-07-12T03:20:00.000Z",
    updatedAt: "2026-07-12T03:22:00.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const userRow = feed.locator(".channel-message-row.local-user");
  await expect(userRow).toContainText("Edited");
  await expect(userRow).toContainText("Provider temporarily unavailable");
  await userRow.hover();
  await expect(userRow.getByRole("button", { name: "Edit message" })).toHaveCount(0);
  await userRow.getByRole("button", { name: "Retry response" }).click();

  await expect(feed).toContainText("Edited reply: Revised prompt waiting for a response");
  await expect(userRow.getByRole("button", { name: "Retry response" })).toHaveCount(0);
  await expect.poll(() => state.lastConversationMessageEditRequest?.idempotencyKey).toBe("channel-edit-pending-key");
  await expect.poll(() => state.lastConversationMessageEditRequest?.expectedRevision).toBe(2);
});

test("latest topic reply edits in place without creating a second topic", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [{
    id: "msg_topic_edit_root",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: "Topic root response",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:25:00.000Z",
    updatedAt: "2026-07-12T03:25:00.000Z",
  }, {
    id: "msg_topic_edit_user",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "msg_topic_edit_root",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Original topic follow-up",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:25:01.000Z",
    updatedAt: "2026-07-12T03:25:01.000Z",
  }, {
    id: "msg_topic_edit_old_reply",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "msg_topic_edit_root",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: "Old topic response should disappear.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:25:02.000Z",
    updatedAt: "2026-07-12T03:25:02.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const rootMessage = page.getByLabel("Channel message feed").locator(".channel-message-row.ai-teammate").filter({ hasText: "Topic root response" });
  await rootMessage.hover();
  await rootMessage.getByRole("button", { name: "Reply in topic" }).click();
  const topicPanel = page.getByLabel("Topic replies");
  const userReply = topicPanel.locator(".thread-reply-item.thread-reply-own");
  await userReply.hover();
  await userReply.getByRole("button", { name: "Edit message" }).click();
  await topicPanel.getByLabel("Edit message").fill("Revised topic follow-up");
  await topicPanel.getByRole("button", { name: "Save and resend" }).click();

  await expect(topicPanel).toContainText("Revised topic follow-up");
  await expect(topicPanel).toContainText("Edited reply: Revised topic follow-up");
  await expect(topicPanel).not.toContainText("Original topic follow-up");
  await expect(topicPanel).not.toContainText("Old topic response should disappear.");
  await expect(page.getByLabel("Topic replies")).toHaveCount(1);
  await expect.poll(() => state.lastConversationMessageEditRequest?.surface).toBe("topic_reply");
  await expect.poll(() => state.lastConversationMessageEditRequest?.messageId).toBe("msg_topic_edit_user");
  await expect.poll(() => state.channelMessages.find((message) =>
    isRecord(message) && message.body === "Edited reply: Revised topic follow-up"
  )).toMatchObject({
    threadId: "thread_topic_channel_engineering_msg_topic_edit_root",
    sourceItemId: "msg_topic_edit_user",
  });
});

test("latest channel branch prompt reruns inside the same branch lane", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const branchId = "channel_branch_edit";
  const rootThreadId = "thread_channel_branch_edit";
  state.channelBranches = [{
    id: branchId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    name: "Implementation branch",
    status: "active",
    rootThreadId,
    createdAt: "2026-07-12T03:27:00.000Z",
    updatedAt: "2026-07-12T03:27:00.000Z",
  }];
  state.channelMessages = [{
    id: "msg_branch_edit_source",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: rootThreadId,
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Original branch prompt",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:27:01.000Z",
    updatedAt: "2026-07-12T03:27:01.000Z",
  }, {
    id: "msg_branch_edit_old_reply",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: rootThreadId,
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: "Old branch response should disappear.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:27:02.000Z",
    updatedAt: "2026-07-12T03:27:02.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Implementation branch" }).click();

  const feed = page.getByLabel("Channel message feed");
  const userRow = feed.locator(".channel-message-row.local-user");
  await userRow.hover();
  await userRow.getByRole("button", { name: "Edit message" }).click();
  await feed.getByLabel("Edit message").fill("Revised branch prompt");
  await feed.getByRole("button", { name: "Save and resend" }).click();

  await expect(feed).toContainText("Revised branch prompt");
  await expect(feed).toContainText("Edited reply: Revised branch prompt");
  await expect(feed).not.toContainText("Original branch prompt");
  await expect(feed).not.toContainText("Old branch response should disappear.");
  await expect(navigation.locator(".sidebar-branch-row-shell.selected")).toContainText("Implementation branch");
  await expect.poll(() => state.lastConversationMessageEditRequest?.surface).toBe("channel_branch");
  await expect.poll(() => state.lastConversationMessageEditRequest?.messageId).toBe("msg_branch_edit_source");
  await expect.poll(() => state.channelMessages.find((message) =>
    isRecord(message) && message.body === "Edited reply: Revised branch prompt"
  )).toMatchObject({
    threadId: rootThreadId,
    sourceItemId: "msg_branch_edit_source",
  });
});

test("channel message body renders safe markdown, highlighted code, folded logs, and structured diffs", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __lingCopiedText?: string }).__lingCopiedText = text;
        },
      },
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const longJson = [
    "{",
    ...Array.from({ length: 32 }, (_, index) => `  "item${index + 1}": ${index + 1},`),
    '  "done": true',
    "}",
  ].join("\n");
  const largeCode = Array.from({ length: 320 }, (_, index) => `export const deferredLine${index + 1} = ${index + 1};`).join("\n");
  const largeDiff = [
    "diff --git a/src/large.ts b/src/large.ts",
    "index 1111111..2222222 100644",
    "--- a/src/large.ts",
    "+++ b/src/large.ts",
    "@@ -1,1 +1,190 @@",
    "-export const oldValue = 0;",
    ...Array.from({ length: 190 }, (_, index) => `+export const deferredDiffLine${index + 1} = ${index + 1};`),
  ].join("\n");
  const longMixedLabel = "超长需求确认标签需要在移动端自然换行不压住按钮 SuperLongEnglishLabelWithoutSpacesForConversationEvidenceAndArtifactRows1234567890";
  state.channelMessages = [{
    id: "msg_rich_markdown",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: [
      "Rich rendering probe <script>window.__ling_p5_xss = true</script>",
      "",
      `Long label probe: ${longMixedLabel}`,
      "",
      "## Shared rich blocks",
      "",
      "> Keep the conversation surface compact while preserving structured content.",
      "",
      "| Capability | State |",
      "| :--- | ---: |",
      "| Mermaid | Ready |",
      "| Math | Ready |",
      "",
      "- [x] Parse GFM",
      "- [ ] Finish reference previews",
      "",
      "Inline math: $E = mc^2$.",
      "",
      "$$",
      "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      "$$",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[Plan] --> B[Implement]",
      "  B --> C[Verify]",
      "```",
      "",
      "```mermaid",
      "this is not valid mermaid syntax ???",
      "```",
      "",
      "```ts",
      "const answer = 42;",
      "function format(value: string) {",
      "  return `Result: ${value}`;",
      "}",
      "```",
      "",
      "```bash",
      "<html lang=\"zh-CN\">",
      "<head>",
      "<style>",
      "body{margin:0;background:#111;color:white}",
      "</style>",
      "</head>",
      "```",
      "",
      "```diff",
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "@@ -20,2 +20,2 @@",
      " export const stable = true;",
      "-export const other = 1;",
      "+export const other = 2;",
      "```",
      "",
      "```diff",
      "not actually a patch",
      "```",
      "",
      "```weirdlang",
      "plain fallback block",
      "```",
      "",
      "```json",
      longJson,
      "```",
      "",
      "```ts",
      largeCode,
      "```",
      "",
      "```diff",
      largeDiff,
      "```",
    ].join("\n"),
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-05-25T00:18:00.000Z",
    updatedAt: "2026-05-25T00:18:00.000Z",
  }, {
    id: "msg_streaming_code",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: [
      "Streaming code stays plain while the reply is pending.",
      "",
      "```ts",
      "const streaming = true;",
      "```",
    ].join("\n"),
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "pending",
    createdAt: "2026-05-25T00:18:01.000Z",
    updatedAt: "2026-05-25T00:18:01.000Z",
  }];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const message = feed.locator(".message-bubble").filter({ hasText: "Rich rendering probe" });
  await expect(message).toBeVisible();
  await expect(message).toHaveClass(/message-bubble-chat/);
  await expectMessageFrameContained(message);
  await expect(message).toContainText(longMixedLabel);
  await expect(message).toContainText("<script>window.__ling_p5_xss = true</script>");
  await expect(message.locator("script")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ling_p5_xss?: boolean }).__ling_p5_xss === true)).toBe(false);
  await expect(message.getByRole("heading", { name: "Shared rich blocks", level: 2 })).toBeVisible();
  await expect(message.locator(".message-body-quote")).toContainText("preserving structured content");
  const richTable = message.locator(".message-body-table");
  await expect(richTable).toContainText("Capability");
  await expect(richTable).toContainText("Mermaid");
  await expect(message.locator(".message-body-task-item input[type=checkbox]")).toHaveCount(2);
  await expect(message.locator(".message-inline-math .katex")).toBeVisible();
  await expect(message.locator(".message-math-block .katex-display")).toBeVisible();
  const deferredMermaidBlock = message.locator('.message-mermaid-block[data-render-status="deferred"]').filter({ hasText: "flowchart LR" });
  await deferredMermaidBlock.scrollIntoViewIfNeeded();
  const mermaidBlock = message.locator('.message-mermaid-block[data-render-status="rendered"]');
  const mermaidSvg = mermaidBlock.locator(".message-mermaid-canvas svg");
  await expect(mermaidSvg).toBeVisible();
  await expect(mermaidSvg).toContainText("Plan");
  const lightMermaidId = await mermaidSvg.getAttribute("id");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => mermaidSvg.getAttribute("id")).not.toBe(lightMermaidId);
  await expect(mermaidSvg).toContainText("Verify");
  await page.emulateMedia({ colorScheme: "light" });
  await mermaidBlock.hover();
  await mermaidBlock.getByRole("button", { name: "Expand diagram" }).click();
  const diagramDialog = page.getByRole("dialog", { name: "Diagram" });
  await expect(diagramDialog.locator(".message-mermaid-expanded > svg")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(diagramDialog).toHaveCount(0);
  const invalidMermaidBlock = message.locator(".message-mermaid-block").filter({ hasText: "this is not valid mermaid syntax" });
  await invalidMermaidBlock.scrollIntoViewIfNeeded();
  await expect(invalidMermaidBlock.getByText("Diagram preview unavailable")).toBeVisible();
  const copyMessageButton = message.getByRole("button", { name: "Copy message" });
  await copyMessageButton.focus();
  await page.keyboard.press("Enter");
  await expect(message.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lingCopiedText?: string }).__lingCopiedText ?? "")).toContain("Rich rendering probe");
  await expect(feed).not.toContainText("Copy message completed");

  const codeBlock = message.locator(".message-code-block").filter({ hasText: "const answer = 42;" });
  await expect(codeBlock.getByText("ts")).toBeVisible();
  await expect(codeBlock).toHaveAttribute("data-highlight-engine", "shiki");
  await expect(codeBlock.locator(".code-token.shiki").filter({ hasText: "const" })).toBeVisible();
  await expect(codeBlock.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect.poll(() => codeBlock.evaluate((element) => {
    const resolveBackground = (tokenName: string): string => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${tokenName})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    const styles = getComputedStyle(element);
    return {
      actual: styles.backgroundColor,
      expected: resolveBackground("--conversation-code-bg"),
    };
  })).toEqual({ actual: "rgb(247, 247, 247)", expected: "rgb(247, 247, 247)" });

  const htmlInBashBlock = message.locator(".message-code-block").filter({ hasText: "<html" });
  await expect(htmlInBashBlock.getByText("bash")).toBeVisible();
  await expect(htmlInBashBlock).toHaveAttribute("data-highlight-engine", "shiki");
  await expect(htmlInBashBlock.locator(".code-token.shiki").filter({ hasText: "lang" })).toBeVisible();
  await expect(htmlInBashBlock.locator(".code-token.shiki").filter({ hasText: "zh-CN" })).toBeVisible();
  await expect(htmlInBashBlock.locator(".code-token.shiki").filter({ hasText: "background" })).toBeVisible();
  await expect(htmlInBashBlock.locator(".code-token.shiki").filter({ hasText: "#111" })).toBeVisible();

  const diffBlock = message.locator(".message-diff-block").filter({ hasText: "src/example.ts" });
  await expect(diffBlock).toHaveCount(1);
  await expect(diffBlock).toContainText("Edited 1 file");
  await expect(diffBlock).toContainText("src/example.ts");
  await expect(diffBlock.locator(".diff-line.delete .diff-gutter").first()).toHaveText("-");
  await expect(diffBlock.locator(".diff-line.delete code").first()).toContainText("export const value = 1;");
  await expect(diffBlock.locator(".diff-line.add .diff-gutter").first()).toHaveText("+");
  await expect(diffBlock.locator(".diff-line.add code").first()).toContainText("export const value = 2;");
  await expect(diffBlock.locator(".diff-fold")).toContainText("18 unmodified lines");
  await expect(diffBlock.getByRole("button", { name: "Copy diff" })).toBeVisible();
  await expect.poll(() => diffBlock.locator(".diff-viewer").evaluate((element) => {
    const resolveBackground = (tokenName: string): string => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${tokenName})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    const styles = getComputedStyle(element);
    return {
      actual: styles.backgroundColor,
      expected: resolveBackground("--conversation-code-bg"),
    };
  })).toEqual({ actual: "rgb(247, 247, 247)", expected: "rgb(247, 247, 247)" });
  await expect(message.locator(".message-code-block").filter({ hasText: "not actually a patch" })).toBeVisible();
  const unknownLanguageBlock = message.locator(".message-code-block").filter({ hasText: "plain fallback block" });
  await expect(unknownLanguageBlock.getByText("weirdlang")).toBeVisible();
  await expect(unknownLanguageBlock.locator(".code-token")).toHaveCount(0);

  const foldedJson = message.locator(".message-code-block").filter({ hasText: '"item1": 1' });
  await expect(foldedJson).toHaveAttribute("data-highlight-engine", "shiki");
  await expect(foldedJson.locator(".code-token.shiki").filter({ hasText: '"item1"' })).toBeVisible();
  await expect(foldedJson.getByRole("button", { name: /Show full code/ })).toBeVisible();
  await expect(foldedJson).not.toContainText('"done": true');
  await foldedJson.getByRole("button", { name: /Show full code/ }).click();
  await expect(foldedJson.getByRole("button", { name: "Collapse code" })).toBeVisible();
  await expect(foldedJson).toContainText('"done": true');

  const deferredCode = message.locator(".message-code-block.deferred");
  await expect(deferredCode).toContainText("Large code block deferred");
  await expect(deferredCode).toContainText("320 lines");
  await expect(deferredCode.locator("pre")).toHaveCount(0);
  await expect(deferredCode).not.toContainText("deferredLine320");
  await deferredCode.getByRole("button", { name: "Show full code" }).click();
  const expandedDeferredCode = message.locator(".message-code-block").filter({ hasText: "deferredLine320" });
  await expect(expandedDeferredCode).toBeVisible();
  await expect(expandedDeferredCode.locator("pre")).toBeVisible();
  await expect(expandedDeferredCode).toHaveAttribute("data-highlight-engine", "shiki");
  await expect(expandedDeferredCode.locator(".code-token.shiki").filter({ hasText: "deferredLine320" })).toBeVisible();
  await expect(expandedDeferredCode.getByRole("button", { name: "Collapse code" })).toBeVisible();
  await expandedDeferredCode.getByRole("button", { name: "Collapse code" }).click();
  await expect(deferredCode).toContainText("Large code block deferred");
  await expect(deferredCode.locator("pre")).toHaveCount(0);

  const deferredDiff = message.locator(".message-diff-block.deferred");
  await expect(deferredDiff).toContainText("Large diff deferred");
  await expect(deferredDiff).toContainText("196 lines");
  await expect(deferredDiff.locator(".diff-viewer")).toHaveCount(0);
  await expect(deferredDiff).not.toContainText("deferredDiffLine190");
  await deferredDiff.getByRole("button", { name: "Show diff details" }).click();
  const expandedDeferredDiff = message.locator(".message-diff-block.expanded-deferred");
  await expect(expandedDeferredDiff).toContainText("src/large.ts");
  await expect(expandedDeferredDiff.locator(".diff-viewer")).toBeVisible();
  await expect(expandedDeferredDiff).not.toContainText("deferredDiffLine190");
  await expect(expandedDeferredDiff.getByRole("button", { name: /Show remaining diff ranges/ })).toBeVisible();
  await expandedDeferredDiff.getByRole("button", { name: /Show remaining diff ranges/ }).click();
  await expect(expandedDeferredDiff).toContainText("deferredDiffLine190");
  await expandedDeferredDiff.getByRole("button", { name: "Collapse diff details" }).click();
  await expect(message.locator(".message-diff-block.deferred")).toContainText("Large diff deferred");

  const streamingMessage = feed.locator(".message-bubble").filter({ hasText: "Streaming code stays plain" });
  await expect(streamingMessage).toBeVisible();
  await expect(streamingMessage.locator(".message-code-block").filter({ hasText: "const streaming = true;" }).locator(".code-token")).toHaveCount(0);
  const richLayout = await message.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overflowing = Array.from(element.querySelectorAll<HTMLElement>(".message-code-block, .message-diff-block, .message-body-renderer"))
      .filter((node) => node.scrollWidth > Math.ceil(node.clientWidth) + 1)
      .map((node) => ({ className: node.className, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    return { width: Math.round(bounds.width), overflowing };
  });
  expect(richLayout.width).toBeGreaterThan(300);
  expect(richLayout.overflowing).toEqual([]);
  for (const viewport of [{ width: 820, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await mermaidBlock.scrollIntoViewIfNeeded();
    const responsiveOverflow = await message.locator(".message-body-renderer").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(responsiveOverflow.scrollWidth).toBeLessThanOrEqual(responsiveOverflow.clientWidth + 1);
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    )).toBeLessThanOrEqual(1);
  }
  await maybeCaptureConversationScreenshots(page, "p9-long-labels", [
    { suffix: "narrow", width: 820, height: 900 },
    { suffix: "mobile", width: 390, height: 844 },
  ]);
  await maybeCaptureConversationScreenshots(page, "p10-rich-code-diff", [
    { suffix: "desktop", width: 1440, height: 960 },
    { suffix: "narrow", width: 820, height: 900 },
    { suffix: "mobile", width: 390, height: 844 },
  ]);
});

test("channel composer sends workspace file refs as native message payload", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("Please inspect apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await expect(page.locator(".channel-composer .composer-inline-token.file-reference").filter({ hasText: "apps/web/src/features/workspace/WorkspaceClientView.tsx" })).toHaveCount(1);
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() => state.lastChannelTurnRequest?.fileRefs).toEqual([
    {
      path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      label: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      source: "composer",
    },
  ]);
  const references = page.getByLabel("References");
  const fileReference = references.getByRole("button", { name: /WorkspaceClientView\.tsx/ });
  await expect(fileReference).toBeVisible();
  await fileReference.focus();
  await expect(references.getByRole("tooltip")).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await fileReference.click();
  const filesDock = page.locator(".channel-side-panel.right-dock");
  await expect(filesDock).toHaveAttribute("aria-label", "Channel workspace dock");
  await expect(filesDock).toContainText("WorkspaceClientView.tsx");
  await expect(page.locator(".channel-composer .composer-inline-token.file-reference")).toHaveCount(0);
});

test("channel composer preserves IME composition until committed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.evaluate((node) => {
    const editor = node as HTMLElement;
    editor.focus();
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    editor.textContent = "k";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "k", inputType: "insertCompositionText", isComposing: true }));
  });
  await expectComposerValue(composerInput, "");
  await expect.poll(() => composerInput.evaluate((node) => node.textContent)).toBe("k");

  await composerInput.evaluate((node) => {
    const editor = node as HTMLElement;
    editor.textContent = "ke";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ke", inputType: "insertCompositionText", isComposing: true }));
  });
  await expectComposerValue(composerInput, "");
  await expect.poll(() => composerInput.evaluate((node) => node.textContent)).toBe("ke");

  await composerInput.evaluate((node) => {
    const editor = node as HTMLElement;
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "可" }));
    editor.textContent = "可";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "可", inputType: "insertCompositionText", isComposing: false }));
  });
  await expectComposerValue(composerInput, "可");
  await expect.poll(() => composerInput.evaluate((node) => node.textContent)).toBe("可");
});

test("channel composer does not render multi-agent slash command tokens as file refs", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("@Engineer @Designer /review apps/web");

  const composer = page.locator(".channel-composer");
  const commandToken = composer.locator(".composer-inline-token.command").filter({ hasText: "Code Review" });
  await expect(commandToken).toContainText("@Engineer @Designer");
  await expect(commandToken).toContainText("/review");
  await expect(composer.locator(".composer-inline-token.file-reference").filter({ hasText: "/review" })).toHaveCount(0);
  await expect(composer.locator(".composer-inline-token.file-reference").filter({ hasText: "apps/web" })).toHaveCount(1);
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Create task" })).toBeEnabled();
});

test("channel composer applies plan mode session commands without creating slash tasks", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const channelRoots = (): readonly typeof state.threads[number][] =>
    state.threads.filter((thread) =>
      thread.kind === "channel_discussion" &&
      thread.channelId === "channel_engineering" &&
      !thread.parentThreadId
    );
  const planMode = (): string | undefined =>
    channelRoots()[0]?.conversationMode?.mode;

  const composer = page.locator(".channel-composer");
  const composerInput = channelComposerTextbox(page);
  const planChip = composer.locator(".conversation-mode-chip.plan");
  const planButton = planChip.getByRole("button", { name: "Plan Mode" });
  await expect(planChip).toHaveCount(0);
  await expect.poll(() => channelRoots().length).toBe(1);
  const rootThreadId = channelRoots()[0]?.id;

  await composer.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("menu", { name: "Add" })).toBeVisible();
  await composerInput.click();
  await expect(page.getByRole("menu", { name: "Add" })).toHaveCount(0);

  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: "Plan Mode" }).click();
  await expect.poll(() => channelRoots().length).toBe(1);
  expect(channelRoots()[0]?.id).toBe(rootThreadId);
  await expect.poll(planMode).toBe("plan");
  await expect(planChip).toBeVisible();
  await expect(planChip).toHaveClass(/active/);
  await expect(composer).not.toContainText("Plan Mode enabled");
  await expect.poll(() => state.tasks).toHaveLength(0);
  await composer.getByRole("button", { name: "Add" }).click();
  const addMenu = page.getByRole("menu", { name: "Add" });
  await expect(addMenu.getByRole("menuitem", { name: "Plan Mode" })).toBeVisible();
  await expect(addMenu.getByRole("menuitem", { name: "Exit Plan Mode" })).toHaveCount(0);
  await addMenu.getByRole("menuitem", { name: "Plan Mode" }).click();
  await expect.poll(planMode).toBe("plan");
  await expect(planChip).toBeVisible();
  await expect(planChip).toHaveClass(/active/);

  await composerInput.fill("/review apps/web");
  await composer.getByRole("button", { name: "Create task" }).click();
  await expect(composer).toContainText("Exit Plan Mode before creating implementation tasks.");
  await expect.poll(() => state.tasks).toHaveLength(0);

  await planChip.hover();
  await planChip.getByRole("button", { name: "Exit and hide Plan Mode" }).click();
  await expect.poll(planMode).toBe("default");
  await expect.poll(() => state.tasks).toHaveLength(0);
  await expect(planChip).toHaveCount(0);

  await composerInput.fill("/pla");
  await expect(page.getByRole("listbox", { name: "Slash command" })).toBeVisible();
  await page.getByRole("option", { name: "/plan Plan Mode" }).click();
  await expect(planChip).toBeVisible();
  await expect(planChip).not.toHaveClass(/active/);
  await expectComposerValue(composerInput, "/plan ");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(planMode).toBe("plan");
  await expect(planChip).toHaveClass(/active/);

  await composerInput.fill("/plan off");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(planMode).toBe("default");
  await expect(planChip).toBeVisible();
  await expect(planChip).not.toHaveClass(/active/);
  await expect(composer).not.toContainText("Plan Mode disabled");

  await composerInput.fill("/plan status");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:composer"]'))
    .toContainText("Plan Mode is off");
  await expect(composer).not.toContainText("Plan Mode is off");
  await expect.poll(planMode).toBe("default");
  await expect.poll(() => state.tasks).toHaveLength(0);
});

test("channel composer manages goal lifecycle from the floating panel", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const channelRoots = (): readonly typeof state.threads[number][] =>
    state.threads.filter((thread) =>
      thread.kind === "channel_discussion" &&
      thread.channelId === "channel_engineering" &&
      !thread.parentThreadId
    );
  const planMode = (): string | undefined =>
    channelRoots()[0]?.conversationMode?.mode;
  const activeGoal = () => state.goals.find((goal) => goal.threadId === channelRoots()[0]?.id && ["active", "paused", "blocked", "usage_limited", "budget_limited"].includes(goal.status));

  const composer = page.locator(".channel-composer");
  const composerInput = channelComposerTextbox(page);
  const goalChip = composer.locator(".conversation-mode-chip.goal");
  await expect(goalChip).toHaveCount(0);
  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: /Goal/ }).click();
  await expect(goalChip).toBeVisible();
  await expectComposerValue(composerInput, "");
  await goalChip.hover();
  await goalChip.getByRole("button", { name: "Hide goal" }).click();
  await expect(goalChip).toHaveCount(0);
  await expectComposerValue(composerInput, "");

  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: /Goal/ }).click();
  await expect(goalChip).toBeVisible();
  await expectComposerValue(composerInput, "");
  await composerInput.fill("/goal Finish PR4 with a visible goal panel");
  await expectComposerValue(composerInput, "/goal Finish PR4 with a visible goal panel");
  await composer.getByRole("button", { name: "Apply command" }).click();

  const goalPanel = composer.locator(".goal-floating-panel");
  await expect.poll(() => activeGoal()?.objective).toBe("Finish PR4 with a visible goal panel");
  await expect(goalPanel).toBeVisible();
  await expect(goalPanel).toContainText("Finish PR4 with a visible goal panel");
  await expect(goalPanel).toContainText("Active");
  await expect(goalChip).toHaveClass(/active/);

  await goalPanel.getByRole("button", { name: "Expand goal details" }).click();
  await expect(goalPanel).toContainText("Status: Active");
  await goalPanel.getByRole("button", { name: "Collapse goal details" }).click();

  await goalPanel.getByRole("button", { name: "Run goal" }).click();
  await expect.poll(() => String(state.lastChannelTurnRequest?.body ?? "")).toBe("Continue working toward goal: Finish PR4 with a visible goal panel");
  await expect(page.getByLabel("Channel message feed").getByText("Continue working toward goal: Finish PR4 with a visible goal panel")).toBeVisible();

  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: "Plan Mode" }).click();
  await expect.poll(planMode).toBe("plan");
  const previousGoalContinuation = state.lastChannelTurnRequest;
  await goalPanel.getByRole("button", { name: "Run goal" }).click();
  await expect(composer).toContainText("Exit Plan Mode before continuing a goal.");
  await expect.poll(() => state.lastChannelTurnRequest).toBe(previousGoalContinuation);

  await composerInput.fill("/plan off");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(planMode).toBe("default");

  const goalWithStopMetadata = activeGoal();
  if (!goalWithStopMetadata) {
    throw new Error("Expected active goal before injecting continuation stop metadata");
  }
  state.goals = state.goals.map((goal) => goal.id === goalWithStopMetadata.id
    ? {
        ...goal,
        continuationDepth: 2,
        noEvidenceContinuationCount: 2,
        lastContinuationStopReason: "no_evidence_threshold",
        lastContinuationStoppedAt: "2026-05-25T00:46:00.000Z",
        lastContinuationEvidenceDelta: {
          newEvidenceRefs: 0,
          changedFiles: 0,
          acceptedPlans: 0,
          artifacts: 0,
          statusChanged: false,
        },
      }
    : goal);
  await goalPanel.getByRole("button", { name: "Pause goal" }).click();
  await expect.poll(() => activeGoal()?.status).toBe("paused");
  await expect(goalPanel).toContainText("Paused");
  await goalPanel.getByRole("button", { name: "Expand goal details" }).click();
  await expect(goalPanel).toContainText("Continuation: 2 / 3");
  await expect(goalPanel).toContainText("Last auto-stop: No new evidence");
  await expect(goalPanel).toContainText("Evidence delta: 0 refs, 0 files, 0 artifacts");
  await goalPanel.getByRole("button", { name: "Collapse goal details" }).click();
  await expect(goalPanel.getByRole("button", { name: "Run goal" })).toBeDisabled();
  await goalPanel.getByRole("button", { name: "Resume goal" }).click();
  await expect.poll(() => activeGoal()?.status).toBe("active");
  await expect(goalPanel.getByRole("button", { name: "Run goal" })).toBeEnabled();

  await goalPanel.getByRole("button", { name: "Edit goal" }).click();
  await expectComposerValue(composerInput, "/goal edit Finish PR4 with a visible goal panel");
  await composerInput.evaluate((editor) => {
    editor.textContent = "";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }));
  });
  await expectComposerValue(composerInput, "");
  await composerInput.fill("/goal edit Finish PR4, PR5, and local QA");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(() => activeGoal()?.objective).toBe("Finish PR4, PR5, and local QA");
  await expect(goalPanel).toContainText("Finish PR4, PR5, and local QA");

  await goalChip.hover();
  await goalChip.getByRole("button", { name: "Clear and hide goal" }).click();
  await expect.poll(() => activeGoal()).toBeUndefined();
  await expect(goalPanel).toHaveCount(0);
  await expect(goalChip).toHaveCount(0);
});

test("channel feed renders proposed_plan blocks as proposed plan cards", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [
    {
      id: "thread_channel_main_channel_engineering",
      workspaceId: "workspace_default",
      kind: "channel_discussion",
      channelId: "channel_engineering",
      title: "Main branch",
      objective: "Main conversation branch for Engineering.",
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: "2026-05-25T00:40:00.000Z",
      updatedAt: "2026-05-25T00:40:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_user_proposed_plan_example",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_main_channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      body: "Use `<proposed_plan title=\"Do not render\">not a card</proposed_plan>` as literal syntax.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:40:30.000Z",
      updatedAt: "2026-05-25T00:40:30.000Z",
    },
    {
      id: "msg_proposed_plan",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_main_channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: [
        "I drafted the first slice.",
        "",
        "<proposed_plan title=\"PR1 + PR2 implementation\">",
        "1. Add Plan/Goal contracts and read routes.",
        "2. Render Plan Mode controls in the composer.",
        "3. Verify `/plan` does not create a task.",
        "</proposed_plan>",
        "",
        "Review before implementation.",
      ].join("\n"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:41:00.000Z",
      updatedAt: "2026-05-25T00:41:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const channelRoots = (): readonly typeof state.threads[number][] =>
    state.threads.filter((thread) =>
      thread.kind === "channel_discussion" &&
      thread.channelId === "channel_engineering" &&
      !thread.parentThreadId
    );
  const planMode = (): string | undefined =>
    channelRoots()[0]?.conversationMode?.mode;

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByText("I drafted the first slice.")).toBeVisible();
  const plan = feed.getByLabel("Proposed plan");
  await expect(plan).toHaveCount(1);
  await expect(plan).toContainText("PR1 + PR2 implementation");
  await expect(plan).toContainText("Add Plan/Goal contracts and read routes.");
  await expect(plan.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Convert to workflow" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Refine plan" })).toBeVisible();
  await expect(plan.getByRole("button", { name: "Implement" })).toBeVisible();
  await expect(plan).not.toContainText("Do not render");
  await expect(feed.getByText("<proposed_plan title=\"Do not render\">")).toBeVisible();
  await expect(feed.getByText("<proposed_plan title=\"PR1 + PR2 implementation\">")).toHaveCount(0);

  await plan.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.proposedPlans.find((item) => item.id === "proposed_plan_msg_proposed_plan")?.savedAt ?? "").not.toBe("");

  await plan.getByRole("button", { name: "Convert to workflow" }).click();
  await expect.poll(() => state.proposedPlans.find((item) => item.id === "proposed_plan_msg_proposed_plan")?.acceptedWorkflowId ?? "").toBe("");
  const preview = page.getByRole("dialog", { name: "Workflow conversion preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Saving creates a draft workflow only.");
  await preview.getByRole("button", { name: "Edit draft" }).click();
  await preview.getByLabel("Draft title").fill("PR1 + PR2 workflow draft");
  await preview.getByLabel("Draft workflow steps").fill("Confirm contracts\nWire Plan Mode controls");
  await preview.getByRole("button", { name: "Save draft workflow" }).click();
  await expect.poll(() => state.proposedPlans.find((item) => item.id === "proposed_plan_msg_proposed_plan")?.acceptedWorkflowId ?? "").not.toBe("");
  await expect.poll(() => state.channelWorkflows.find((workflow) => isRecord(workflow) && workflow.title === "PR1 + PR2 workflow draft")?.status).toBe("draft");
  await expect.poll(() => state.channelWorkflowSteps.find((step) => isRecord(step) && step.prompt.includes("Source proposed plan: proposed_plan_msg_proposed_plan"))?.status).toBe("queued");
  await expect.poll(() => state.channelWorkflowSteps.find((step) => isRecord(step) && step.prompt.includes("Wire Plan Mode controls"))?.status).toBe("queued");
  await expect(page.getByRole("dialog", { name: "Workflow conversion preview" })).toHaveCount(0);

  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".channel-side-panel.right-dock");
  await dock.getByRole("button", { name: /Plans/ }).click();
  await expect(dock).toContainText("Plan history");
  await expect(dock).toContainText("PR1 + PR2 implementation");
  await dock.getByRole("button", { name: "PR1 + PR2 implementation" }).click();
  await expect(dock).toContainText("Source message");
  await dock.getByRole("button", { name: "Archive" }).click();
  await expect.poll(() => state.proposedPlans.find((item) => item.id === "proposed_plan_msg_proposed_plan")?.status).toBe("archived");
  await dock.getByRole("button", { name: "Back" }).click();
  await expect(dock).not.toContainText("PR1 + PR2 implementation");
  await dock.getByLabel("Plan status").selectOption("archived");
  await expect(dock).toContainText("PR1 + PR2 implementation");
  await page.getByRole("button", { name: "Hide details" }).click();

  await plan.getByRole("button", { name: "Refine plan" }).click();
  await expect.poll(planMode).toBe("plan");
  await expect.poll(() => String(state.lastChannelTurnRequest?.body ?? "")).toContain("Refine this plan before implementation: PR1 + PR2 implementation");
  await expect(feed.getByText("Refine this plan before implementation: PR1 + PR2 implementation")).toBeVisible();

  await plan.getByRole("button", { name: "Implement" }).click();
  await expect.poll(planMode).toBe("default");
  await expect.poll(() => String(state.lastChannelTurnRequest?.body ?? "")).toContain("Implement accepted plan: PR1 + PR2 implementation");
  await expect.poll(() => state.tasks.find((task) => task.title === "Implement accepted plan: PR1 + PR2 implementation")?.requestedSkillId).toBe("plan-acceptance");
  await expect.poll(() => state.tasks.find((task) => task.title === "Implement accepted plan: PR1 + PR2 implementation")?.prompt ?? "").toContain("Source proposed plan: proposed_plan_msg_proposed_plan");
  await expect(feed.getByText("Implement accepted plan: PR1 + PR2 implementation")).toBeVisible();
});

test("workflow conversion preview infers owners without mutating until save", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_builtin_docs", displayName: "Docs Lead", roleKey: "docs", description: "Owns documentation updates." }),
    createMockTeammate({ id: "teammate_builtin_qa", displayName: "Ling QA", roleKey: "qa" }),
    createMockTeammate({ id: "teammate_builtin_quality", displayName: "Quality Partner", roleKey: "qa" }),
  ];
  state.teammateChannelMemberships = state.aiTeammates.map((teammate) => ({
    teammateId: String(teammate.id),
    channelId: "channel_engineering",
    isDefault: false,
    createdAt: "2026-05-25T00:39:00.000Z",
    updatedAt: "2026-05-25T00:39:00.000Z",
  }));
  state.threads = [
    {
      id: "thread_channel_main_channel_engineering",
      workspaceId: "workspace_default",
      kind: "channel_discussion",
      channelId: "channel_engineering",
      title: "Main branch",
      objective: "Main conversation branch for Engineering.",
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: "2026-05-25T00:40:00.000Z",
      updatedAt: "2026-05-25T00:40:00.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_owner_preview_plan",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_main_channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: [
        "<proposed_plan title=\"Owner preview workflow\">",
        "1. Owner: Ling Engineer; implement daemon contract.",
        "2. Update docs/design/conversation-plan-and-goal-modes.md.",
        "3. Run test verification.",
        "4. Summarize launch notes.",
        "</proposed_plan>",
      ].join("\n"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:41:00.000Z",
      updatedAt: "2026-05-25T00:41:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const plan = page.getByLabel("Proposed plan");
  await plan.getByRole("button", { name: "Convert to workflow" }).click();
  const preview = page.getByRole("dialog", { name: "Workflow conversion preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByLabel("Owner for step 1")).toHaveValue("teammate_builtin_engineer");
  await expect(preview.getByLabel("Owner for step 2")).toHaveValue("teammate_builtin_docs");
  await expect(preview.getByLabel("Owner for step 3")).toHaveValue("");
  await expect(preview.getByLabel("Owner for step 4")).toHaveValue("");
  await expect(preview).toContainText("Explicit owner \"Ling Engineer\" in the plan.");
  await expect(preview).toContainText("docs/ matched documentation ownership.");
  await expect(preview).toContainText("Owner signal was ambiguous across teammates.");
  await expect(preview).toContainText("No owner signal found.");

  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Workflow conversion preview" })).toHaveCount(0);
  await expect.poll(() => state.channelWorkflows.length).toBe(0);
  await expect.poll(() => state.channelWorkflowSteps.length).toBe(0);

  await plan.getByRole("button", { name: "Convert to workflow" }).click();
  const reopened = page.getByRole("dialog", { name: "Workflow conversion preview" });
  await reopened.getByLabel("Owner for step 4").selectOption("teammate_builtin_docs");
  await reopened.getByRole("button", { name: "Save draft workflow" }).click();

  await expect.poll(() => state.channelWorkflows.find((workflow) => isRecord(workflow) && workflow.title === "Owner preview workflow")?.status).toBe("draft");
  await expect.poll(() => state.channelWorkflowSteps.filter((step) => isRecord(step) && step.workflowId === state.channelWorkflows[0]?.id).length).toBe(4);
  await expect.poll(() => state.channelWorkflowSteps.find((step) => isRecord(step) && step.title.includes("implement daemon contract"))?.toParticipantId).toBe("teammate_builtin_engineer");
  await expect.poll(() => state.channelWorkflowSteps.find((step) => isRecord(step) && step.title.includes("docs/design"))?.toParticipantId).toBe("teammate_builtin_docs");
  await expect.poll(() => state.channelWorkflowSteps.find((step) => isRecord(step) && step.title.includes("Run test verification"))?.toParticipantLabel).toBe("Unassigned");
  await expect.poll(() => state.channelWorkflowSteps.find((step) => isRecord(step) && step.title.includes("Summarize launch notes"))?.toParticipantId).toBe("teammate_builtin_docs");
  await expect(page.getByRole("dialog", { name: "Workflow conversion preview" })).toHaveCount(0);
});

test("plan history groups lineage versions across thread and channel scopes", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [
    {
      id: "thread_channel_main_channel_engineering",
      workspaceId: "workspace_default",
      kind: "channel_discussion",
      channelId: "channel_engineering",
      title: "Main branch",
      objective: "Main conversation branch for Engineering.",
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: "2026-05-25T00:40:00.000Z",
      updatedAt: "2026-05-25T00:40:00.000Z",
    },
    {
      id: "thread_channel_plan_sibling",
      workspaceId: "workspace_default",
      kind: "channel_discussion",
      channelId: "channel_engineering",
      parentThreadId: "thread_channel_main_channel_engineering",
      title: "Plan sibling",
      objective: "Sibling thread for accepted plan version.",
      status: "open",
      conversationMode: { mode: "default" },
      createdAt: "2026-05-25T00:40:10.000Z",
      updatedAt: "2026-05-25T00:40:10.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "msg_lineage_source",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_main_channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "local-user",
      body: "Prepare the accepted lineage plan.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:41:00.000Z",
      updatedAt: "2026-05-25T00:41:00.000Z",
    },
    {
      id: "msg_lineage_v3",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_main_channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "Accepted lineage source message.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T00:42:00.000Z",
      updatedAt: "2026-05-25T00:42:00.000Z",
    },
  ];
  state.proposedPlans = [
    createLineagePlan({
      id: "plan_lineage_v4",
      threadId: "thread_channel_main_channel_engineering",
      title: "Plan v4 latest",
      bodyMarkdown: "Latest draft body",
      status: "draft",
      version: 4,
      updatedAt: "2026-05-25T00:46:00.000Z",
    }),
    createLineagePlan({
      id: "plan_lineage_v3",
      threadId: "thread_channel_plan_sibling",
      title: "Plan v3 accepted",
      bodyMarkdown: "Accepted body",
      status: "accepted",
      version: 3,
      sourceMessageId: "msg_lineage_v3",
      updatedAt: "2026-05-25T00:45:00.000Z",
    }),
    createLineagePlan({
      id: "plan_lineage_v2",
      threadId: "thread_channel_main_channel_engineering",
      title: "Plan v2 superseded",
      bodyMarkdown: "Second body",
      status: "superseded",
      version: 2,
      supersededByPlanId: "plan_lineage_v3",
      updatedAt: "2026-05-25T00:44:00.000Z",
    }),
    createLineagePlan({
      id: "plan_lineage_v1",
      threadId: "thread_channel_main_channel_engineering",
      title: "Plan v1 superseded",
      bodyMarkdown: "First body",
      status: "superseded",
      version: 1,
      supersededByPlanId: "plan_lineage_v2",
      updatedAt: "2026-05-25T00:43:00.000Z",
    }),
    createLineagePlan({
      id: "plan_lineage_archived",
      threadId: "thread_channel_main_channel_engineering",
      planGroupId: "plan_group_archived",
      title: "Archived lineage version",
      bodyMarkdown: "Archived body",
      status: "archived",
      version: 1,
      archivedAt: "2026-05-25T00:47:00.000Z",
      updatedAt: "2026-05-25T00:47:00.000Z",
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.locator(".channel-side-panel.right-dock");
  await dock.getByRole("button", { name: /Plans/ }).click();
  await expect(dock).toContainText("Plan history");
  await expect(dock).toContainText("Plan v4 latest");
  await expect(dock).not.toContainText("Plan v3 accepted");
  await expect(dock).not.toContainText("Plan v2 superseded");
  await expect(dock).toContainText("2 superseded versions hidden");

  await dock.getByRole("button", { name: "Expand versions" }).click();
  await expect(dock).toContainText("Plan v2 superseded");
  await expect(dock).toContainText("Plan v1 superseded");

  await dock.getByRole("radio", { name: "This channel" }).click();
  await expect(dock).toContainText("Plan v3 accepted");
  const acceptedRow = dock.locator(".right-dock-plan-row").filter({ hasText: "Plan v3 accepted" });
  await acceptedRow.getByRole("button", { name: "Open source" }).click();
  const locatedSourceMessage = page.locator('[data-feed-item-id="conversation-turn:msg_lineage_source"]');
  await expect(locatedSourceMessage).toHaveClass(/conversation-work-cell-locate-pulse/);
  await expect.poll(() => locatedSourceMessage.evaluate((element) => ({
    duration: getComputedStyle(element).animationDuration,
    name: getComputedStyle(element).animationName,
  }))).toEqual({ duration: "0.6s", name: "conversation-locate-pulse" });
  await expect(locatedSourceMessage).not.toHaveClass(/conversation-work-cell-locate-pulse/, { timeout: 2_000 });

  const latestRow = dock.locator(".right-dock-plan-row").filter({ hasText: "Plan v4 latest" });
  await latestRow.getByRole("button", { name: "Open plan detail" }).click();
  await expect(dock.locator(".right-dock-plan-detail")).toContainText("Plan v4 latest");
  await expect(dock.locator(".right-dock-plan-detail")).toContainText("Latest draft body");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByLabel("Plan status").selectOption("archived");
  await expect(dock).toContainText("Archived lineage version");
  await expect(dock).not.toContainText("Plan v4 latest");
});

test("channel composer supports spaced teammate names before slash commands", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent" })];
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("@Ling Agent /rev");
  await expect(page.getByRole("listbox", { name: "Slash command" })).toBeVisible();
  await page.getByRole("option", { name: /^\/review\b/ }).click();
  await expectComposerValue(composerInput, "@Ling Agent /review ");
  await composerInput.evaluate((node) => {
    const editor = node as HTMLElement;
    editor.replaceChildren();
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }));
  });
  await expectComposerValue(composerInput, "");
  await composerInput.fill("@Ling Agent /review apps/web");

  const composer = page.locator(".channel-composer");
  await expect(composer.locator(".composer-inline-token.mention").filter({ hasText: "Ling Agent" })).toHaveCount(1);
  const commandToken = composer.locator(".composer-inline-token.command").filter({ hasText: "Code Review" });
  await expect(commandToken).toContainText("/review");
  await expect(composer.locator(".composer-inline-token.file-reference").filter({ hasText: "/review" })).toHaveCount(0);
  await page.locator(".channel-composer").getByRole("button", { name: "Create task" }).click();

  await expect.poll(() => state.tasks[0]).toMatchObject({
    assigneeTeammateId: "ling_agent",
    requestedSkillId: "review",
    prompt: "apps/web",
  });
});

test("channel composer opens slash picker for later slash tokens without multi-dispatch", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("/office-hours summarize this channel /rev");
  await expect(page.getByRole("listbox", { name: "Slash command" })).toBeVisible();
  await page.getByRole("option", { name: /^\/review\b/ }).click();
  await expectComposerValue(composerInput, "/office-hours summarize this channel /review ");

  const composer = page.locator(".channel-composer");
  const commandTokens = composer.locator(".composer-inline-token.command");
  await expect(commandTokens).toHaveCount(2);
  await expect(commandTokens.nth(0)).toContainText("Office Hours");
  await expect(commandTokens.nth(1)).toContainText("Code Review");
  await expect(composer.locator(".composer-inline-token.file-reference").filter({ hasText: "/review" })).toHaveCount(0);

  await page.locator(".channel-composer").getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks).toHaveLength(1);
  await expect.poll(() => state.tasks[0]).toMatchObject({
    requestedSkillId: "office-hours",
    prompt: "summarize this channel /review",
  });
});

test("channel composer renders GitHub URLs as inline repo tokens", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("Compare https://github.com/openai/openai-agents-python with our agent design");

  const composer = page.locator(".channel-composer");
  await expect(composer.locator(".composer-inline-token.url-reference").filter({ hasText: "openai/openai-agents-python" })).toBeVisible();
  await expect(composer.getByLabel("Pending message assets")).toHaveCount(0);
  await expect(composer.locator(".composer-preview-card.link")).toHaveCount(0);
});

test("channel screenshot request shows materialization clarify reply instead of hidden routing", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.locator("input[type=file]").setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("Please fix the UI from this screenshot");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("Please fix the UI from this screenshot")).toBeVisible();
  await expect(channelFeed.getByText("could not read image content from screenshot.png")).toBeVisible();
  await expect(page.getByText("routeDecision")).toHaveCount(0);
  await expect(page.getByText("workflow_proposal")).toHaveCount(0);
  await expect(page.getByText("image content is not available")).toHaveCount(0);
  await expect(page.getByText("metadata_only")).toHaveCount(0);
  await expect(page.getByText("unsupported")).toHaveCount(0);
  await expect(page.getByText("extractor")).toHaveCount(0);
  await expect(page.getByText("SSRF")).toHaveCount(0);
  await expect.poll(() => state.channelIntentDecisions.some((decision) =>
    isRecord(decision) && decision.action === "clarify" && /Mock attachment content is not materialized/.test(String(decision.reason))
  )).toBe(true);
  await expect.poll(() => state.channelMessages.find((message) =>
    isRecord(message) && message.authorType === "ai-teammate" && String(message.body).includes("could not read image content")
  )).toMatchObject({
    threadId: "thread_channel_channel_engineering",
    sourceItemId: "msg_1",
  });
});

test("channel local link request shows natural clarify copy without debug vocabulary", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("Please summarize this link http://127.0.0.1/private");
  await expect(page.getByText("Private network previews are blocked.")).toBeVisible({ timeout: 3_000 });
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("Please summarize this link")).toBeVisible();
  await expect(channelFeed.getByRole("link", { name: "127.0.0.1" })).toBeVisible();
  await expect(channelFeed.getByText("will not open local/private links automatically")).toBeVisible();
  await expect(channelFeed.getByText("Paste the content")).toBeVisible();
  await expect(page.getByText("body extraction is blocked")).toHaveCount(0);
  await expect(page.getByText("metadata_only")).toHaveCount(0);
  await expect(page.getByText("extractor")).toHaveCount(0);
  await expect(page.getByText("SSRF")).toHaveCount(0);
  await expect.poll(() => state.channelIntentDecisions.some((decision) =>
    isRecord(decision) && decision.action === "clarify" && /Mock link body materialization is blocked/.test(String(decision.reason))
  )).toBe(true);
});

test("channel short follow-up uses recent context without visible routing diagnostics", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "auto_route";
  }
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_context_topic",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "右侧进度浮窗只保留任务摘要，不展示调试行。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
    {
      id: "msg_context_ling",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "我会把默认 UI 收敛成任务摘要，详细 context 放到 Inspect。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:11:00.000Z",
      updatedAt: "2026-05-25T00:11:00.000Z",
    },
  ];
  state.channelAiReplyBody = "接上前面的频道上下文：继续收敛右侧进度浮窗，默认不展示 route/context/token 调试信息。";
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("继续");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("继续", { exact: true })).toBeVisible();
  await expect(channelFeed.getByText("接上前面的频道上下文")).toBeVisible();
  await expect.poll(() => {
    const decision = state.channelMessageRouteDecisions.find((item) =>
      isRecord(item) && item.sourceMessageId === "msg_3"
    );
    return isRecord(decision) ? decision.action : "";
  }).toBe("reply");
  await expect(page.getByText("routeDecision")).toHaveCount(0);
  await expect(page.getByText("selector_view")).toHaveCount(0);
  await expect(page.getByText("contextPack")).toHaveCount(0);
  await expect(page.getByText("estimatedInputTokens")).toHaveCount(0);
});

test("channel materialized PDF and DOCX inputs show simple chips and a natural Ling answer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "auto_route";
  }
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelAiReplyBody = "我读到了 PDF 的 Q2 风险和 DOCX 的验收项：先收敛默认展示，再保留 Inspect context。";
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.locator("input[type=file]").setInputFiles([
    {
      name: "risk-brief.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 materialized risk brief"),
    },
    {
      name: "acceptance.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("docx materialized acceptance"),
    },
  ]);
  const pendingAssets = page.getByLabel("Pending message assets");
  await expect(pendingAssets).toContainText("risk-brief.pdf");
  await expect(pendingAssets).toContainText("acceptance.docx");
  for (const attachment of state.channelAttachments) {
    if (isRecord(attachment) && (attachment.fileName === "risk-brief.pdf" || attachment.fileName === "acceptance.docx")) {
      attachment.materializationStatus = "available";
      attachment.previewStatus = "available";
      attachment.previewText = `${attachment.fileName} extracted content is available.`;
    }
  }

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("Summarize these attachments?");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("Summarize these attachments?")).toBeVisible();
  await expect(channelFeed.getByRole("link", { name: "risk-brief.pdf" })).toBeVisible();
  await expect(channelFeed.getByRole("link", { name: "acceptance.docx" })).toBeVisible();
  await channelFeed.getByRole("button", { name: "Preview: risk-brief.pdf" }).click();
  const pdfPreview = page.getByLabel("File preview");
  await expect(pdfPreview).toContainText("mock preview for risk-brief.pdf");
  await pdfPreview.getByRole("button", { name: "Close preview" }).click();
  await channelFeed.getByRole("button", { name: "Preview: acceptance.docx" }).click();
  const documentPreview = page.getByLabel("File preview");
  await expect(documentPreview).toContainText("mock preview for acceptance.docx");
  await documentPreview.getByRole("button", { name: "Close preview" }).click();
  await expect(channelFeed.getByText("我读到了 PDF 的 Q2 风险和 DOCX 的验收项")).toBeVisible();
  await expect(page.getByLabel("Pending message assets")).toHaveCount(0);
  await expect(channelFeed.getByText("metadata_only")).toHaveCount(0);
  await expect(channelFeed.getByText("not_loaded")).toHaveCount(0);
  await expect(channelFeed.getByText("unsupported")).toHaveCount(0);
  await expect(channelFeed.getByText("blocked")).toHaveCount(0);
  await expect(channelFeed.getByText("extractor")).toHaveCount(0);
  await expect(channelFeed.getByText("fingerprint")).toHaveCount(0);
});

test("channel execution proposal confirms into a multi-step workflow", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      runtimeErrors.push(`console:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror:${error.message}`));
  const state = createBaseState({ approvalStatus: "expired" });
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
    createMockTeammate({
      id: "teammate_builtin_qa",
      templateId: "qa",
      roleKey: "qa",
      displayName: "Ling QA",
      description: "Validates regression checks.",
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
    {
      teammateId: "teammate_builtin_designer",
      channelId: "channel_engineering",
      isDefault: false,
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:10:00.000Z",
    },
    {
      teammateId: "teammate_builtin_qa",
      channelId: "channel_engineering",
      isDefault: false,
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
      prompt: "The user message looks like a coordinated workflow request. Original request: 所有的队友，都回复我一下 Proposed collaboration: 1. QA: Validate the expected behavior and regression checks. 2. 产品策略: Clarify product scope and acceptance before execution. 3. Security: Review trust boundaries and approval-sensitive publication steps. Non-direct multi-agent collaboration waits for user confirmation before starting.",
      assigneeTeammateId: "teammate_builtin_engineer",
      acceptanceCriteria: [
        "Task is created only after confirmation, with every visible long acceptance criterion wrapping inside the proposal card.",
        "Run uses the assignee provider and keeps selector, handoff, run, approval, and artifact evidence expandable.",
      ],
      collaborationSteps: [
        { teammateId: "teammate_builtin_engineer", action: "coordinated", summary: "Summarized discussion into one execution proposal. Preserved approval-sensitive context for the implementation path." },
        {
          teammateId: "teammate_builtin_designer",
          action: "reviewed",
          summary: "Checked visual hierarchy before execution. Verified long collaboration summaries stay inside the card.",
          sources: [{ kind: "council", councilId: "council_builtin_development", councilDisplayName: "Development Council", slotKey: "designer", label: "Design review" }],
        },
      ],
      requiredTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      riskSummary: "Provider must be ready before execution and approval-sensitive publication steps must stay explicitly gated.",
      status: "draft",
      createdAt: "2026-05-25T00:18:02.000Z",
      updatedAt: "2026-05-25T00:18:02.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const proposalSummary = page.getByLabel("Task proposal summary").filter({ hasText: "Refine channel workspace copy" });
  await expect(proposalSummary).toBeVisible();
  await expect(proposalSummary.locator("xpath=..").locator(".channel-execution-proposal-summary-avatar")).toHaveAttribute("aria-label", "Ling Engineer");
  await maybeCaptureViewportScreenshot(page, "task-proposal-compact-summary-with-avatar.png");

  const proposal = await openTaskProposalGate(page, "Refine channel workspace copy");
  await expect(proposal).toContainText("Refine channel workspace copy");
  await expect(proposal).toContainText("Ling Engineer");
  await expect(proposal).toContainText("Read files");
  await expect(proposal).toContainText("Run commands");
  await expect(proposal).toContainText("Modify files");
  await expect(proposal).not.toContainText("Ling is shaping the task");
  await expect(proposal).not.toContainText("Participants");
  await expect(proposal).not.toContainText("Boundary");
  await expect(proposal).not.toContainText("Ling Designer");
  await expect(proposal.locator("dl, .channel-proposal-details, .channel-proposal-collaboration")).toHaveCount(0);
  await expect(proposal.getByRole("button")).toHaveCount(2);
  await expect(proposal.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Task confirmation" })).toHaveCount(0);
  await maybeCaptureViewportScreenshot(page, "task-proposal-composer-gate.png");
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
  await proposal.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(proposal).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();

  await expect.poll(() => {
    const workflow = state.channelWorkflows.find((item) => isRecord(item) && item.title === "Refine channel workspace copy");
    return isRecord(workflow) ? workflow.status : undefined;
  }).toBe("running");
  await expect.poll(() => state.channelWorkflowSteps.filter((item) => isRecord(item) && item.workflowId === "workflow_1").length).toBe(2);
  await expect.poll(() => {
    const steps = state.channelWorkflowSteps.filter((item) => isRecord(item) && item.workflowId === "workflow_1");
    return steps.map((step) => isRecord(step) ? step.toParticipantId : "").join("|");
  }).toBe("teammate_builtin_engineer|teammate_builtin_designer");
  await expect.poll(() => {
    const secondStep = state.channelWorkflowSteps.find((item) => isRecord(item) && item.workflowId === "workflow_1" && item.position === 2);
    return isRecord(secondStep) && isRecord(secondStep.metadata) && Array.isArray(secondStep.metadata.dependsOnStepIds)
      ? secondStep.metadata.dependsOnStepIds.join(",")
      : "";
  }).toBe("workflow_step_1");
  await expect.poll(() => {
    const secondStep = state.channelWorkflowSteps.find((item) => isRecord(item) && item.workflowId === "workflow_1" && item.position === 2);
    return isRecord(secondStep) && isRecord(secondStep.metadata) && Array.isArray(secondStep.metadata.proposalStepSources)
      ? `sources:${secondStep.metadata.proposalStepSources.length}`
      : "sources:none";
  }).toBe("sources:1");
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_1");
    return isRecord(updated) ? [updated.status, updated.linkedWorkflowId].join("|") : "";
  }).toBe("accepted|workflow_1");
  const feed = page.locator(".message-feed");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).not.toContainText("Work in progress");
  await expect(workCell).not.toContainText("Task in progress");
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toBeVisible();
  await expect(workCell.locator(".conversation-work-cell-agent-spans")).toBeVisible();
  await expect(workCell).toContainText("Ling Engineer");
  await expect(workCell).toContainText("Ling Designer");
  await expect(workCell).not.toContainText("Agent branches");
  const designerSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Ling Designer" });
  await expect(designerSpan).toContainText("Checked visual hierarchy before execution.");
  await expect(designerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Checked visual hierarchy before execution.");
  await expect(designerSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toHaveCount(0);

  await openChannelChatTools(page);
  const acceptedProposal = feed.getByLabel("Task proposal summary").filter({ hasText: "Refine channel workspace copy" });
  await expect(acceptedProposal).toBeVisible();
  await expect(acceptedProposal.getByRole("button", { name: "View task" })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("requirement shaping stays compact while its task decision uses the Composer gate", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = { mode: "fixed", themeId: "ling-dark" };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", "dark");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent" })];
  state.channelMessages = [
    {
      id: "msg_shaping_request",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Refine the workspace copy after clarifying scope.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:21:00.000Z",
      updatedAt: "2026-05-25T00:21:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_shaping",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_shaping_request",
      proposedByTeammateId: "ling_agent",
      title: "Refine workspace copy",
      prompt: "Refine the workspace copy after clarifying scope.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Workspace copy changes are scoped before execution."],
      collaborationSteps: [
        { teammateId: "ling_agent", action: "coordinated", summary: "Clarify the task, then prepare an executable proposal." },
        { teammateId: "observer", action: "consulted", summary: "Synced on availability only." },
      ],
      requiredTools: ["read", "edit"],
      riskSummary: "Copy scope must be confirmed before file edits.",
      shaping: {
        status: "needs_user_clarification",
        summary: "Clarify workspace copy scope before execution.",
        openQuestions: ["Which copy sections are in scope?"],
        clarifications: [
          {
            id: "clarification_1",
            authorType: "local-user",
            authorId: "tian",
            body: "Only workspace drawer copy is in scope.",
            sourceMessageId: "msg_shaping_request",
            createdAt: "2026-05-25T00:21:10.000Z",
          },
        ],
        sourceRefs: [{ type: "message", id: "msg_shaping_request" }],
        updatedAt: "2026-05-25T00:21:10.000Z",
      },
      status: "draft",
      createdAt: "2026-05-25T00:21:01.000Z",
      updatedAt: "2026-05-25T00:21:10.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await expect(page.getByRole("dialog", { name: "Task confirmation" })).toHaveCount(0);

  const transcript = page.locator(".conversation-turn-assistant-transcript");
  const shapingBlock = transcript.locator(".transcript-block-view.kind-requirement_shaping");
  await expect(shapingBlock).toHaveCount(0);
  const decisionBlock = transcript.locator(".transcript-block-view.kind-decision_needed");
  await expect(decisionBlock).toBeVisible();
  await expect(decisionBlock).toHaveAttribute("aria-label", "Decision needed");
  await expect(decisionBlock).toContainText("Which copy sections are in scope?");
  const summary = page.getByLabel("Task proposal summary").filter({ hasText: "Refine workspace copy" });
  await expect(summary).toHaveCount(1);
  await expect(summary).toContainText("Ling Agent · Needs input");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("Requirement shaping");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("coordinated");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("ling_agent");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("Only workspace drawer copy is in scope.");

  const proposal = await openTaskProposalGate(page, "Refine workspace copy");
  await expect(proposal).toContainText("Refine workspace copy");
  await expect(proposal).toContainText("Ling Agent");
  await expect(proposal).toContainText("Read files");
  await expect(proposal).toContainText("Modify files");
  await expect(proposal).not.toContainText("Needs user clarification");
  await expect(proposal).not.toContainText("Which copy sections are in scope?");
  await expect(proposal).not.toContainText("Only workspace drawer copy is in scope.");
  await expect(proposal.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(proposal.getByRole("button")).toHaveCount(2);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.reload();
  await openEngineeringChannel(page);
  await openTaskProposalGate(page, "Refine workspace copy");
  await expect(proposal).not.toContainText("Needs user clarification");
  await expect(proposal).not.toContainText("Which copy sections are in scope?");
  await expect(proposal).not.toContainText("Only workspace drawer copy is in scope.");

  await proposal.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_shaping");
    return isRecord(updated) && isRecord(updated.shaping) ? updated.shaping.status : "";
  }).toBe("converted_to_task");
});

test("completed workflow hides accepted proposal and leaves final result in default chat", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const completedAt = "2026-05-25T00:31:00.000Z";
  const workflowRun = {
    ...state.runs[0],
    id: "run_completed_workflow",
    status: "succeeded",
    threadId: "thread_completed_workflow_step",
    taskId: "task_completed_workflow",
    workflowStepId: "workflow_step_completed",
    taskSnapshot: {
      id: "task_completed_workflow",
      title: "Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      workflowStepId: "workflow_step_completed",
      task: {
        id: "task_completed_workflow",
        title: "Create README.md",
        prompt: "Create /Users/example/ling-stack-test/README.md.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_completed_workflow.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T00:30:00.000Z",
    startedAt: "2026-05-25T00:30:05.000Z",
    endedAt: completedAt,
    updatedAt: completedAt,
  };
  state.channelMessages = [
    {
      id: "msg_create_readme",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "/Users/example/ling-stack-test 下面，帮我创建一个 README.md",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:29:00.000Z",
      updatedAt: "2026-05-25T00:29:00.000Z",
    },
    {
      id: "msg_create_readme_start",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_create_readme",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "确认需求：「Create README.md」。开始处理。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:29:02.000Z",
      updatedAt: "2026-05-25T00:29:02.000Z",
    },
    {
      id: "msg_create_readme_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_create_readme",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "完成：「Create README.md」。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:31:00.000Z",
      updatedAt: "2026-05-25T00:31:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_completed_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_create_readme",
      proposedByTeammateId: "docs",
      title: "Create /Users/example/ling-stack-test/README.md",
      prompt: "Create the requested README file with the declared file tool scope.",
      assigneeTeammateId: "docs",
      acceptanceCriteria: ["Target file is created."],
      collaborationSteps: [{ teammateId: "docs", action: "coordinated", summary: "Created the requested file." }],
      requiredTools: ["write"],
      status: "accepted",
      linkedWorkflowId: "workflow_completed",
      createdAt: "2026-05-25T00:29:01.000Z",
      updatedAt: "2026-05-25T00:29:05.000Z",
    },
  ];
  state.tasks = [
    {
      id: "task_completed_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
      status: "done",
      currentRunId: workflowRun.id,
      createdAt: "2026-05-25T00:30:00.000Z",
      updatedAt: completedAt,
    },
  ];
  state.runs = [workflowRun];
  state.channelWorkflows = [
    {
      id: "workflow_completed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create /Users/example/ling-stack-test/README.md",
      objective: "Create the requested README file with the declared file tool scope.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:29:05.000Z",
      updatedAt: completedAt,
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_completed",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_completed",
      taskId: "task_completed_workflow",
      runId: workflowRun.id,
      position: 1,
      title: "Docs: Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
      toParticipantId: "docs",
      toParticipantLabel: "Docs",
      status: "succeeded",
      resultSummary: "Created the requested README file.",
      createdAt: "2026-05-25T00:29:05.000Z",
      updatedAt: completedAt,
    },
  ];
  state.artifactsByRun[workflowRun.id] = [
    {
      id: "artifact_completed_readme",
      runId: workflowRun.id,
      type: "file",
      path: "/Users/example/ling-stack-test/README.md",
      title: "README.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 0,
      createdAt: completedAt,
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).not.toContainText("Work complete");
  await expect(workCell).not.toContainText("Completed: Created the requested README file.");
  await expect(workCell).not.toContainText("Create /Users/example/ling-stack-test/README.md");
  await expect(feed).not.toContainText("确认需求：");
  await expect(feed).not.toContainText("完成：");
  await expect(workCell).not.toContainText("Ling summary");
  await expect(workCell).not.toContainText("Outcome");
  await expect(workCell).not.toContainText("Validated");
  await expect(workCell).not.toContainText("Blockers / risks");
  await expect(workCell).not.toContainText("Next action");
  const evidenceSummary = workCell.locator(".conversation-work-cell-evidence-summary");
  await expect(evidenceSummary).toHaveText("1 reference");
  await expect(evidenceSummary).not.toContainText("Changed");
  await expect(evidenceSummary).not.toContainText("check");
  await evidenceSummary.click();
  await expect(workCell.locator(".conversation-work-cell-group")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-evidence-links")).toContainText("README.md");
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("Created the requested README file.");
  await expect(workCell.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toHaveCount(0);
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);

  await openChannelChatTools(page);
  await expect(feed.getByLabel("Task proposal summary")).toContainText("Create /Users/example/ling-stack-test/README.md");
});

test("terminal workflow step suppresses stale running run surfaces", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const completedAt = "2026-05-25T00:41:00.000Z";
  const staleRun = {
    ...state.runs[0],
    id: "run_stale_running_workflow",
    status: "running",
    threadId: "thread_stale_running_workflow",
    taskId: "task_stale_running_workflow",
    workflowStepId: "workflow_step_stale_terminal",
    taskSnapshot: {
      id: "task_stale_running_workflow",
      title: "Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      workflowStepId: "workflow_step_stale_terminal",
      task: {
        id: "task_stale_running_workflow",
        title: "Create README.md",
        prompt: "Create /Users/example/ling-stack-test/README.md.",
        channelId: "channel_engineering",
      },
    },
    eventLogPath: ".ling-stack/sessions/run_stale_running_workflow.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T00:40:00.000Z",
    startedAt: "2026-05-25T00:40:05.000Z",
    endedAt: undefined,
    updatedAt: completedAt,
  };
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_stale_running_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "/Users/example/ling-stack-test 下面，帮我创建一个 README.md",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:39:00.000Z",
      updatedAt: "2026-05-25T00:39:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_stale_running_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_stale_running_workflow",
      proposedByTeammateId: "docs",
      title: "Create /Users/example/ling-stack-test/README.md",
      prompt: "Create the requested README file with the declared file tool scope.",
      assigneeTeammateId: "docs",
      acceptanceCriteria: ["Target file is created."],
      collaborationSteps: [{ teammateId: "docs", action: "coordinated", summary: "Created the requested file." }],
      requiredTools: ["write"],
      status: "accepted",
      linkedWorkflowId: "workflow_stale_terminal",
      createdAt: "2026-05-25T00:39:01.000Z",
      updatedAt: "2026-05-25T00:39:05.000Z",
    },
  ];
  state.tasks = [
    {
      id: "task_stale_running_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
      status: "done",
      currentRunId: staleRun.id,
      createdAt: "2026-05-25T00:40:00.000Z",
      updatedAt: completedAt,
    },
  ];
  state.runs = [staleRun];
  state.channelWorkflows = [
    {
      id: "workflow_stale_terminal",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create /Users/example/ling-stack-test/README.md",
      objective: "Create the requested README file with the declared file tool scope.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:39:05.000Z",
      updatedAt: completedAt,
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_stale_terminal",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_stale_terminal",
      taskId: "task_stale_running_workflow",
      position: 1,
      title: "Docs: Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
      toParticipantId: "docs",
      toParticipantLabel: "Docs",
      status: "succeeded",
      resultSummary: "Created the requested README file.",
      createdAt: "2026-05-25T00:39:05.000Z",
      updatedAt: completedAt,
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).not.toContainText("Work complete");
  await expect(workCell).not.toContainText("Completed: Created the requested README file.");
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("Created the requested README file.");
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);
  await expect(page.getByLabel("Replying")).toHaveCount(0);
  const composer = page.getByLabel("Channel composer");
  await expect(composer.getByRole("button", { name: "Stop reply" })).toHaveCount(0);
  await expect(composer).not.toContainText("Task in progress");
  await expect(composer).not.toContainText("Run in progress");
});

test("phase 1 active single-agent transcript keeps one assistant turn while latest operation changes", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Engineer", roleKey: "engineer", avatarTone: "teal" }),
    createMockTeammate({ id: "qa", displayName: "QA", roleKey: "qa", avatarTone: "blue" }),
  ];
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_r32_active_single_request",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Create login.html with email and password fields.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:10:00.000Z",
      updatedAt: "2026-05-25T01:10:00.000Z",
    },
    {
      id: "msg_r32_active_single_start",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r32_active_single_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "确认需求：「Create login.html」。开始处理。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:10:01.000Z",
      updatedAt: "2026-05-25T01:10:01.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_r32_active_single",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_r32_active_single_request",
      proposedByTeammateId: "ling_agent",
      title: "Create login.html",
      prompt: "Create login.html with email and password fields.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["login.html exists."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Create login.html." }],
      requiredTools: ["read", "write"],
      status: "accepted",
      linkedWorkflowId: "workflow_r32_active_single",
      createdAt: "2026-05-25T01:10:00.500Z",
      updatedAt: "2026-05-25T01:10:01.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_r32_active_single",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create login.html",
      objective: "Create login.html with email and password fields.",
      status: "running",
      createdBy: "local-user",
      createdAt: "2026-05-25T01:10:01.000Z",
      updatedAt: "2026-05-25T01:10:05.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_r32_active_single_read",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r32_active_single",
      position: 1,
      title: "Ling Agent: Read project structure",
      prompt: "Read project structure before creating login.html.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "running",
      createdAt: "2026-05-25T01:10:01.000Z",
      updatedAt: "2026-05-25T01:10:05.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".message-feed");
  let assistantTranscript = await expectSingleAssistantTranscript(feed);
  let workCell = assistantTranscript.locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(1);
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("Read project structure");
  await expectPhase1MainFeedClean(feed);

  state.channelWorkflowSteps = [
    {
      ...state.channelWorkflowSteps[0],
      status: "succeeded",
      resultSummary: "Project structure inspected.",
      updatedAt: "2026-05-25T01:10:10.000Z",
    },
    {
      id: "workflow_step_r32_active_single_create",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r32_active_single",
      position: 2,
      title: "Ling Agent: Create login.html",
      prompt: "Create login.html with email and password fields.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "running",
      createdAt: "2026-05-25T01:10:10.000Z",
      updatedAt: "2026-05-25T01:10:20.000Z",
    },
  ];
  state.channelWorkflows = state.channelWorkflows.map((workflow) =>
    isRecord(workflow) && workflow.id === "workflow_r32_active_single"
      ? { ...workflow, updatedAt: "2026-05-25T01:10:20.000Z" }
      : workflow,
  );
  await page.reload();
  await openEngineeringChannel(page);

  assistantTranscript = await expectSingleAssistantTranscript(feed);
  workCell = assistantTranscript.locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(1);
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("Create login.html");
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("Project structure inspected.");
  await workCell.locator(".conversation-work-cell-active-stream .conversation-work-cell-row-main").filter({ hasText: "Project structure inspected." }).click();
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("Project structure inspected.");
  await expectPhase1MainFeedClean(feed);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

test("phase 1 completed main-agent transcript keeps committed operation rows folded", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_r32_completed_single_request",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Create login.html.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:12:00.000Z",
      updatedAt: "2026-05-25T01:12:00.000Z",
    },
    {
      id: "msg_r32_completed_single_start",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r32_completed_single_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "确认需求：「Create login.html」。开始处理。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:12:01.000Z",
      updatedAt: "2026-05-25T01:12:01.000Z",
    },
    {
      id: "msg_r32_completed_single_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r32_completed_single_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "完成：「Create login.html」。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:12:30.000Z",
      updatedAt: "2026-05-25T01:12:30.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_r32_completed_single",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_r32_completed_single_request",
      proposedByTeammateId: "ling_agent",
      title: "Create login.html",
      prompt: "Create login.html.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["login.html exists."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Create login.html." }],
      requiredTools: ["write"],
      status: "accepted",
      linkedWorkflowId: "workflow_r32_completed_single",
      createdAt: "2026-05-25T01:12:00.500Z",
      updatedAt: "2026-05-25T01:12:01.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_r32_completed_single",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create login.html",
      objective: "Create login.html.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T01:12:01.000Z",
      updatedAt: "2026-05-25T01:12:30.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_r32_completed_single_create",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r32_completed_single",
      position: 1,
      title: "Ling Agent: Create login.html",
      prompt: "Create login.html.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "succeeded",
      resultSummary: "login.html was created.",
      createdAt: "2026-05-25T01:12:01.000Z",
      updatedAt: "2026-05-25T01:12:30.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".message-feed");
  const assistantTranscript = await expectSingleAssistantTranscript(feed);
  await expect(feed).not.toContainText("确认需求：");
  await expect(feed).not.toContainText("完成：");
  await expect(feed).not.toContainText("Confirm requirement");
  await expect(feed).not.toContainText("Completed:");

  const workCell = assistantTranscript.locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(1);
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("login.html was created.");
  await expect(workCell.locator(".conversation-work-cell-group")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toHaveCount(0);
  await expectPhase1MainFeedClean(feed);

  await expect(workCell.getByLabel("Checks")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-detail-copy")).toHaveCount(0);
  await expectNoCompletedWorkCellAnimations(workCell);
  await workCell.evaluate((node) => {
    node.dataset.remountProbe = "completed-work-cell-stable";
  });
  const feedScrollBeforeDock = await feed.evaluate((node) => Math.round(node.scrollTop));
  await page.locator(".task-toolbar-panel").click();
  await expect(page.locator(".channel-side-panel")).toBeVisible();
  await page.waitForTimeout(220);
  await expectNoCompletedWorkCellAnimations(workCell);
  expect(await workCell.evaluate((node) => node.dataset.remountProbe)).toBe("completed-work-cell-stable");
  expect(Math.abs(await feed.evaluate((node) => Math.round(node.scrollTop)) - feedScrollBeforeDock)).toBeLessThanOrEqual(1);
  await maybeCaptureR32Screenshot(page, "completed-single-agent-expanded");
});

test("phase 1 parallel multi-agent active transcript shows latest action per agent without drawer surfaces", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Engineer", roleKey: "engineer", avatarTone: "teal" }),
    createMockTeammate({ id: "qa", displayName: "QA", roleKey: "qa", avatarTone: "blue" }),
  ];
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_r32_parallel_request",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Build login UI and prepare QA checks in parallel.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:15:00.000Z",
      updatedAt: "2026-05-25T01:15:00.000Z",
    },
    {
      id: "msg_r32_parallel_start",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r32_parallel_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "Build login UI and prepare QA checks in parallel.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:15:01.000Z",
      updatedAt: "2026-05-25T01:15:01.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_r32_parallel",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_r32_parallel_request",
      proposedByTeammateId: "ling_agent",
      title: "Build login UI",
      prompt: "Build login UI and prepare QA checks in parallel.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Engineer implements UI.", "QA prepares checks."],
      collaborationSteps: [
        { teammateId: "engineer", action: "coordinated", summary: "Implement login form." },
        { teammateId: "qa", action: "reviewed", summary: "Prepare QA checklist." },
      ],
      requiredTools: ["read", "write"],
      status: "accepted",
      linkedWorkflowId: "workflow_r32_parallel",
      createdAt: "2026-05-25T01:15:00.500Z",
      updatedAt: "2026-05-25T01:15:01.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_r32_parallel",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Build login UI",
      objective: "Build login UI and prepare QA checks in parallel.",
      status: "running",
      createdBy: "local-user",
      createdAt: "2026-05-25T01:15:01.000Z",
      updatedAt: "2026-05-25T01:15:20.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_r32_parallel_engineer_read",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r32_parallel",
      position: 1,
      title: "Inspect existing login flow",
      prompt: "Inspect existing login flow.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "succeeded",
      resultSummary: "Existing login flow inspected.",
      metadata: { branchGroupId: "branch_engineer" },
      createdAt: "2026-05-25T01:15:02.000Z",
      updatedAt: "2026-05-25T01:15:10.000Z",
    },
    {
      id: "workflow_step_r32_parallel_engineer_build",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r32_parallel",
      position: 2,
      title: "Implement login form",
      prompt: [
        "Confirmed proposal:",
        "Build login UI",
        "",
        "Assigned teammate: Engineer",
        "",
        "Step summary:",
        "Implement the login form.",
        "",
        "Acceptance criteria:",
        "- login.html has email and password fields.",
      ].join("\n"),
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "running",
      metadata: { branchGroupId: "branch_engineer" },
      createdAt: "2026-05-25T01:15:10.000Z",
      updatedAt: "2026-05-25T01:15:20.000Z",
    },
    {
      id: "workflow_step_r32_parallel_qa",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r32_parallel",
      position: 3,
      title: "Prepare QA checklist",
      prompt: "Prepare QA checklist for login form.",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "queued",
      metadata: { branchGroupId: "branch_qa" },
      createdAt: "2026-05-25T01:15:05.000Z",
      updatedAt: "2026-05-25T01:15:05.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".message-feed");
  const assistantTranscript = await expectSingleAssistantTranscript(feed);
  const workCell = assistantTranscript.locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(1);
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toHaveCount(0);
  await expect(workCell.locator('[data-conversation-work-stream="primary"]')).toHaveCount(0);
  await expect(workCell.locator('[data-conversation-work-stream="agent"]')).toHaveCount(2);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(2);

  const engineerSpan = workCell.locator('.conversation-work-cell-agent-span[data-agent-participant-id="engineer"]');
  await expect(engineerSpan.locator(".conversation-work-cell-agent-avatar")).toHaveCount(1);
  await expect(engineerSpan.locator(".conversation-work-cell-agent-avatar .teammate-avatar-image-default")).toHaveCount(1);
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-head .conversation-work-cell-row-icon")).toHaveCount(0);
  await expect(engineerSpan).toContainText("Implement login form");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await maybeCaptureR32Screenshot(page, "parallel-multi-agent-active");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Existing login flow inspected.");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail .conversation-work-cell-row-icon")).toHaveCount(1);
  await engineerSpan.locator(".conversation-work-cell-agent-span-detail .conversation-work-cell-row-main").filter({ hasText: "Implement login form" }).click();
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Implement the login form.");

  const qaSpan = workCell.locator('.conversation-work-cell-agent-span[data-agent-participant-id="qa"]');
  await expect(qaSpan.locator(".conversation-work-cell-agent-avatar")).toHaveCount(1);
  await expect(qaSpan.locator(".conversation-work-cell-agent-avatar .teammate-avatar-image-default")).toHaveCount(1);
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-head .conversation-work-cell-row-icon")).toHaveCount(0);
  await expect(qaSpan).toContainText("Prepare QA checklist");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toBeVisible();
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await expectPhase1MainFeedClean(feed);
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

test("workflow context inspect details stay out of main feed expansion", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      runtimeErrors.push(`console:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror:${error.message}`));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const contextRun = {
    ...state.runs[0],
    id: "run_context_inspect",
    threadId: undefined,
    status: "succeeded",
    eventLogPath: ".ling-stack/sessions/run_context_inspect.jsonl",
    errorMessage: undefined,
    createdAt: "2026-05-25T00:50:00.000Z",
    startedAt: "2026-05-25T00:50:05.000Z",
    endedAt: "2026-05-25T00:52:00.000Z",
    updatedAt: "2026-05-25T00:52:00.000Z",
    taskSnapshot: {
      id: "task_context_inspect",
      title: "Implement inspect summary",
      prompt: "Expose safe context inspect metadata.",
    },
  };
  state.runs = [contextRun];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_context_inspect",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Implement context inspect without default debug rows.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:49:00.000Z",
      updatedAt: "2026-05-25T00:49:00.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_context_inspect",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Context inspect workflow",
      objective: "Expose context evidence only after explicit expansion.",
      status: "succeeded",
      createdBy: "local-user",
      metadata: {
        sourceMessageId: "msg_context_inspect",
      },
      createdAt: "2026-05-25T00:50:00.000Z",
      updatedAt: "2026-05-25T00:52:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_context_inspect",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_context_inspect",
      position: 1,
      title: "Engineer: Implement inspect summary",
      prompt: "Expose safe context inspect metadata.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "succeeded",
      resultSummary: "Context inspect metadata is available on demand.",
      runId: contextRun.id,
      metadata: {
        contextArtifactId: "artifact_context_inspect",
        outputArtifactId: "artifact_context_output",
        outputArtifactIds: ["artifact_context_output", "artifact_context_extra_output"],
        fanInSummaryArtifactId: "artifact_context_fanin",
        providerPresetId: "provider_local",
      },
      createdAt: "2026-05-25T00:50:00.000Z",
      updatedAt: "2026-05-25T00:52:00.000Z",
    },
  ];
  state.approvals = [
    {
      id: "approval_context_checkpoint",
      runId: contextRun.id,
      taskId: "task_context_inspect",
      workflowStepId: "workflow_step_context_inspect",
      channelId: "channel_engineering",
      actionType: "bash",
      risk: "medium",
      title: "Resume workflow execution",
      description: "Run focused workflow evidence checks.",
      payload: { type: "bash", command: "pnpm --filter @ling-stack/web test", hidden: "raw_resume_payload" },
      status: "approved",
      createdAt: "2026-05-25T00:50:20.000Z",
      resolvedAt: "2026-05-25T00:50:25.000Z",
      resolvedBy: "local-user",
    },
  ];
  state.approvalCheckpoints = [
    {
      id: "checkpoint_context_resume",
      approvalId: "approval_context_checkpoint",
      runId: contextRun.id,
      taskId: "task_context_inspect",
      workflowStepId: "workflow_step_context_inspect",
      channelId: "channel_engineering",
      actionType: "bash",
      risk: "medium",
      title: "Resume workflow execution",
      description: "Run focused workflow evidence checks.",
      status: "resumed",
      sideEffect: { type: "bash", command: "pnpm --filter @ling-stack/web test", hidden: "raw_resume_payload" },
      previewArtifactIds: [],
      resultArtifactIds: ["artifact_context_inspect_file"],
      runnerResumeHandle: {
        kind: "ling_continuation",
        runId: contextRun.id,
        handleRef: "runner_handle_context_secret",
        verified: true,
        payload: { hidden: "raw_resume_payload" },
      },
      createdAt: "2026-05-25T00:50:20.000Z",
      updatedAt: "2026-05-25T00:52:00.000Z",
      resolvedAt: "2026-05-25T00:50:25.000Z",
      resumedAt: "2026-05-25T00:50:30.000Z",
    },
  ];
  state.workflowHandoffIntents = [
    {
      schemaVersion: 1,
      id: "handoff_intent_context",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_context_inspect",
      sourceWorkflowStepId: "workflow_step_context_inspect",
      sourceRunId: contextRun.id,
      fromParticipantId: "engineer",
      fromParticipantLabel: "Engineer",
      toParticipantId: "reviewer",
      toParticipantLabel: "Reviewer",
      reason: "Review the bounded evidence projection before release.",
      requiredInput: "Inspect the workflow evidence rows and confirm raw internals stay hidden.",
      expectedOutput: "A reviewer verdict with any blocker called out.",
      riskSummary: "Requires reviewer confirmation before shipping.",
      sourceRefs: [],
      status: "validated",
      validation: {
        targetTeammateExists: true,
        targetTeammateActive: true,
        skillExecutable: true,
        providerRunnable: true,
        approvalProfileCompatible: true,
        resourceLeaseAvailable: true,
        blockers: [],
      },
      createdBy: "orchestrator",
      createdAt: "2026-05-25T00:50:40.000Z",
      updatedAt: "2026-05-25T00:50:50.000Z",
    },
  ];
  state.artifactsByRun[contextRun.id] = [
    {
      id: "artifact_context_inspect_file",
      runId: contextRun.id,
      type: "file",
      path: "apps/web/src/lib/workflow-progress.ts",
      title: "workflow-progress.ts",
      contentType: "text/typescript; charset=utf-8",
      sizeBytes: 720,
      createdAt: "2026-05-25T00:51:00.000Z",
    },
  ];
  state.executionActions = [
    {
      id: "execution_action_workflow_read",
      workspaceId: "workspace_default",
      runId: contextRun.id,
      actionType: "read",
      risk: "low",
      status: "succeeded",
      title: "Read workflow evidence projection",
      summary: "Inspect the current workflow evidence projection.",
      targetRefs: [{ type: "file", path: "apps/web/src/lib/workflow-progress.ts" }],
      previewArtifactIds: [],
      resultArtifactIds: [],
      scopeSummary: "read_only",
      createdAt: "2026-05-25T00:50:20.000Z",
      updatedAt: "2026-05-25T00:50:25.000Z",
      executedAt: "2026-05-25T00:50:20.000Z",
    },
    {
      id: "execution_action_workflow_edit",
      workspaceId: "workspace_default",
      runId: contextRun.id,
      actionType: "edit",
      risk: "medium",
      status: "succeeded",
      title: "Update workflow evidence projection",
      summary: "Workflow evidence rows include bounded action detail.",
      targetRefs: [{ type: "file", path: "apps/web/src/lib/workflow-progress.ts" }],
      previewArtifactIds: [],
      resultArtifactIds: ["artifact_context_inspect_file"],
      scopeSummary: "workspace_write",
      createdAt: "2026-05-25T00:50:30.000Z",
      updatedAt: "2026-05-25T00:51:10.000Z",
      executedAt: "2026-05-25T00:50:35.000Z",
    },
    {
      id: "execution_action_workflow_check",
      workspaceId: "workspace_default",
      runId: contextRun.id,
      actionType: "bash",
      risk: "medium",
      status: "succeeded",
      title: "Run focused workflow UI test",
      summary: "Validate workflow detail rows.",
      targetRefs: [{ type: "command", label: "pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow" }],
      previewArtifactIds: [],
      resultArtifactIds: [],
      scopeSummary: "workspace_write",
      createdAt: "2026-05-25T00:51:20.000Z",
      updatedAt: "2026-05-25T00:51:50.000Z",
      executedAt: "2026-05-25T00:51:20.000Z",
    },
  ];
  const workflowEvidenceRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/workflows/workflow_context_inspect/evidence")) {
      workflowEvidenceRequests.push(request.url());
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(1);
  await expect(workCell).toBeVisible();
  const operationBubble = workCell.locator(".conversation-operation-bubble");
  await expect(operationBubble).toBeVisible();
  await expect(operationBubble.locator(".conversation-operation-shell-status")).toContainText("Edited 1 file");
  await expect(operationBubble.locator(".conversation-operation-shell-summary")).toHaveCount(0);
  await expect(operationBubble.getByRole("button", { name: "Copy summary" })).toHaveCount(0);
  await expect(operationBubble).toHaveClass(/collapsed/);
  await expect(operationBubble.getByRole("button", { name: "Expand operation" })).toHaveCount(1);
  const packetSummary = feed.locator(".transcript-block-view.kind-workflow_packet_summary");
  await expect(packetSummary).toHaveCount(0);
  await expect(workCell).not.toContainText("Context inspect workflow");
  await expect(workCell).not.toContainText("workflow_runtime_boundary");
  await expect(workCell).not.toContainText("old_verbose_log_tail");
  await expect(workCell).not.toContainText("raw prompt text excluded");
  await expect(workCell).not.toContainText("Context Pack");
  await expect(workCell).not.toContainText("provider_local");
  await expect(workCell).not.toContainText("tokens");
  await expect(workCell.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(operationBubble).toHaveClass(/expanded/);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  const activeStream = workCell.locator(".conversation-work-cell-active-stream");
  await expect(activeStream).toContainText("Read workflow-progress.ts");
  await expect(activeStream).toContainText("Ran command");
  await expect(activeStream).not.toContainText("read_only");
  await expect(activeStream).not.toContainText("workspace_write");
  await expect(activeStream).not.toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  const engineerShellRow = activeStream.locator(".conversation-work-cell-row.shell").filter({ hasText: "Ran command" });
  await expect(engineerShellRow.locator(".conversation-work-cell-shell-card")).toHaveCount(0);
  await engineerShellRow.locator(".conversation-work-cell-row-main").click();
  await expect(engineerShellRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Run focused workflow UI test");
  await expect(engineerShellRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  await expect(engineerShellRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Validate workflow detail rows.");

  await workCell.locator(".conversation-work-cell-evidence-summary").click();
  await expect(workCell.getByLabel("Checks")).toContainText("Engineer: Implement inspect summary");
  await expect(workCell.getByLabel("Checks")).not.toContainText("Context inspect metadata is available on demand.");
  await expect(workCell).not.toContainText("Kept sections");
  await expect(workCell).not.toContainText("workflow_runtime_boundary");
  await expect(workCell).not.toContainText("Dropped sections");
  await expect(workCell).not.toContainText("old_verbose_log_tail");
  await expect(workCell).not.toContainText("Source refs");
  await expect(workCell).not.toContainText("Compactions");
  await expect(workCell).not.toContainText("raw prompt text excluded");
  await expect(workCell).not.toContainText("raw logs excluded");
  await expect(workCell).not.toContainText("raw artifact bodies excluded");
  await expect(workCell).not.toContainText("Context Pack");
  await expect(workCell).not.toContainText("Provider");
  await expect(workCell).not.toContainText("Model");
  await expect(workCell).not.toContainText("Budget");
  await expect(workCell).not.toContainText("provider_local");
  await expect(workCell).not.toContainText("tokens");
  await expect(workCell).not.toContainText("Workflow step runtime boundary:");
  const evidenceRegion = workCell.getByRole("region", { name: "Evidence" });
  await expect(evidenceRegion).toContainText("Read workflow-progress.ts");
  await expect(evidenceRegion).toContainText("Edited workflow-progress.ts");
  await expect(evidenceRegion).toContainText("Ran command");
  await expect(evidenceRegion).not.toContainText("read_only");
  await expect(evidenceRegion).not.toContainText("workspace_write");
  await expect(evidenceRegion).toContainText("Handoff: Engineer -> Reviewer");
  await expect(evidenceRegion).not.toContainText("Approval checkpoint: Resume workflow execution");
  await expect(evidenceRegion).not.toContainText("Resume workflow execution");
  await expect(evidenceRegion).not.toContainText("execution_action_workflow_edit");
  await expect(evidenceRegion).not.toContainText("handoff_intent_context");
  await expect(evidenceRegion).not.toContainText("checkpoint_context_resume");
  await expect(evidenceRegion).not.toContainText("approval_context_checkpoint");
  const editActionRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Edited workflow-progress.ts" });
  await editActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Update workflow evidence projection");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("apps/web/src/lib/workflow-progress.ts");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("1 output recorded");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("artifact_context_inspect_file");
  const handoffRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Handoff: Engineer -> Reviewer" });
  await handoffRow.locator(".conversation-work-cell-row-main").click();
  await expect(handoffRow.locator(".conversation-work-cell-row-detail")).toContainText("Required input: Inspect the workflow evidence rows");
  await expect(handoffRow.locator(".conversation-work-cell-row-detail")).toContainText("Expected output: A reviewer verdict");
  await expect(handoffRow.locator(".conversation-work-cell-row-detail")).toContainText("Risk: Requires reviewer confirmation before shipping.");
  const commandActionRow = evidenceRegion.locator(".conversation-work-cell-row.shell").filter({ hasText: "Ran command" });
  await expect(commandActionRow.locator(".conversation-work-cell-shell-card")).toHaveCount(0);
  await commandActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(commandActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Run focused workflow UI test");
  await expect(commandActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  await maybeCaptureR32Screenshot(page, "workflow-action-details-expanded");
  expect(workflowEvidenceRequests).toHaveLength(1);
  await expect.poll(() => workCell.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(runtimeErrors).toEqual([]);
});

test("blocked workflow hides accepted proposal and leaves blocker report in default chat", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const blockedAt = "2026-05-25T00:41:00.000Z";
  state.channelMessages = [
    {
      id: "msg_blocked_readme",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "/Users/example/ling-stack-test 下面，帮我创建一个 README.md",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:39:00.000Z",
      updatedAt: "2026-05-25T00:39:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_blocked_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_blocked_readme",
      proposedByTeammateId: "ling_agent",
      title: "Create README.md",
      prompt: "Create the requested README file.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Target file is created."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Create the requested file." }],
      requiredTools: ["write"],
      status: "accepted",
      linkedWorkflowId: "workflow_blocked",
      createdAt: "2026-05-25T00:39:01.000Z",
      updatedAt: "2026-05-25T00:39:05.000Z",
    },
  ];
  state.runs = [];
  state.tasks = [];
  state.channelWorkflows = [
    {
      id: "workflow_blocked",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      objective: "Create the requested README file.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:39:05.000Z",
      updatedAt: blockedAt,
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_blocked_readme",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_blocked",
      position: 1,
      title: "Ling Agent: Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "blocked",
      blocker: "Write permission was not granted.",
      createdAt: "2026-05-25T00:39:05.000Z",
      updatedAt: blockedAt,
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByLabel("Task confirmation")).toHaveCount(0);
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expect(workCell).not.toContainText("Work blocked");
  await expect(workCell).not.toContainText("Blocked: Write permission was not granted.");
  await expect(workCell).not.toContainText("Ling summary");
  await expect(workCell).not.toContainText("Blockers / risks");
  await expect(workCell).not.toContainText("Blocker: Write permission was not granted.");
  await expect(workCell).not.toContainText("Next action");
  await workCell.locator(".conversation-work-cell-active-stream .conversation-work-cell-row-main").first().click();
  await expect(workCell).toContainText("Write permission was not granted.");
  await expect(workCell).not.toContainText("No changed files recorded. Evidence recorded: 0.");
  await expect(workCell).not.toContainText("No validation commands recorded.");

  await openChannelChatTools(page);
  await expect(feed.getByLabel("Task proposal summary")).toContainText("Create README.md");
});

test("resolved approval-only workflow stays out of the conversation", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    {
      id: "msg_approval_only_recovery",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Review the high-risk shell command.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-06-29T07:55:00.000Z",
      updatedAt: "2026-06-29T07:55:00.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_approval_only_recovery",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_approval_only_recovery",
      proposedByTeammateId: "ling_agent",
      title: "Review shell command",
      prompt: "Review the high-risk shell command.",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["The approval decision is recorded."],
      collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Request approval." }],
      requiredTools: ["bash"],
      status: "accepted",
      linkedWorkflowId: "workflow_approval_only_recovery",
      createdAt: "2026-06-29T07:55:01.000Z",
      updatedAt: "2026-06-29T07:55:02.000Z",
    },
  ];
  state.runs = [];
  state.tasks = [];
  state.channelWorkflows = [
    {
      id: "workflow_approval_only_recovery",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Review shell command",
      objective: "Review the high-risk shell command.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-06-29T07:55:02.527Z",
      updatedAt: "2026-07-11T05:29:19.652Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_approval_only_recovery",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_approval_only_recovery",
      position: 1,
      title: "Review high-risk shell command",
      prompt: "Review the high-risk shell command.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "succeeded",
      resultSummary: "Recovered completed approval-only workflow step.",
      createdAt: "2026-06-29T07:55:02.620Z",
      updatedAt: "2026-07-11T05:29:19.652Z",
    },
  ];
  state.approvals = [
    {
      id: "approval_approval_only_recovery",
      workflowStepId: "workflow_step_approval_only_recovery",
      channelId: "channel_engineering",
      actionType: "workflow_step",
      risk: "high",
      title: "Review high-risk shell command",
      description: "Review the high-risk shell command.",
      payload: { type: "workflow_step" },
      status: "approved",
      createdAt: "2026-06-29T07:55:02.000Z",
      resolvedAt: "2026-06-29T08:32:58.247Z",
      resolvedBy: "local-user",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByText("Review the high-risk shell command.", { exact: true })).toBeVisible();
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(0);
  await expect(feed).not.toContainText("285h 34m");
  await expect(feed).not.toContainText("Recovered completed approval-only workflow step.");
});

test("progress popover owns workflow status while the right drawer avoids duplicate progress cards", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelWorkflows = [
    {
      id: "workflow_running_ui",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Ship workflow UI",
      objective: "Render workflow status in the floating progress popover.",
      status: "running",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:45:00.000Z",
      updatedAt: "2026-05-25T00:47:00.000Z",
    },
    {
      id: "workflow_blocked_ui",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Create README.md",
      objective: "Create the requested README file.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:44:00.000Z",
      updatedAt: "2026-05-25T00:48:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_design_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 1,
      title: "Design right panel card",
      prompt: "Design the right panel task card.",
      toParticipantId: "designer",
      toParticipantLabel: "Designer",
      status: "succeeded",
      resultSummary: "Card shape accepted.",
      metadata: {
        branchGroupId: "branch_design",
      },
      createdAt: "2026-05-25T00:45:00.000Z",
      updatedAt: "2026-05-25T00:46:00.000Z",
    },
    {
      id: "workflow_step_engineer_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 2,
      title: "Inspect existing implementation",
      prompt: "Inspect the existing right panel task card.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "succeeded",
      resultSummary: "Existing task card behavior inspected.",
      metadata: {
        branchGroupId: "branch_engineer",
      },
      createdAt: "2026-05-25T00:46:00.000Z",
      updatedAt: "2026-05-25T00:46:30.000Z",
    },
    {
      id: "workflow_step_engineer_active",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 3,
      title: "Implement card UI",
      prompt: [
        "Confirmed proposal:",
        "Ship workflow UI",
        "",
        "Overall scope:",
        "Render workflow status in the floating progress popover.",
        "",
        "Assigned teammate: Engineer",
        "",
        "Step action: coordinated",
        "",
        "Step summary:",
        "Implement the collaboration card UI.",
        "",
        "Acceptance criteria:",
        "- Keep the main conversation as transcript rows.",
      ].join("\n"),
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "running",
      metadata: {
        branchGroupId: "branch_engineer",
      },
      createdAt: "2026-05-25T00:46:00.000Z",
      updatedAt: "2026-05-25T00:47:00.000Z",
    },
    {
      id: "workflow_step_qa_waiting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 4,
      title: "Validate progress panel",
      prompt: "Validate the right panel task card.",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "waiting_for_approval",
      metadata: {
        branchGroupId: "branch_qa",
      },
      createdAt: "2026-05-25T00:47:00.000Z",
      updatedAt: "2026-05-25T00:49:00.000Z",
    },
    {
      id: "workflow_step_security_waiting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 5,
      title: "Review trust boundary",
      prompt: "Review approval and trust boundary behavior.",
      toParticipantId: "security",
      toParticipantLabel: "Security",
      status: "queued",
      metadata: {
        branchGroupId: "branch_security",
      },
      createdAt: "2026-05-25T00:47:30.000Z",
      updatedAt: "2026-05-25T00:48:00.000Z",
    },
    {
      id: "workflow_step_docs_waiting",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_running_ui",
      position: 6,
      title: "Document release note",
      prompt: "Document the release note.",
      toParticipantId: "docs",
      toParticipantLabel: "Docs",
      status: "queued",
      metadata: {
        branchGroupId: "branch_docs",
      },
      createdAt: "2026-05-25T00:47:15.000Z",
      updatedAt: "2026-05-25T00:47:30.000Z",
    },
    {
      id: "workflow_step_blocked_ui",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_blocked_ui",
      position: 1,
      title: "Ling Agent: Create README.md",
      prompt: "Create /Users/example/ling-stack-test/README.md.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "blocked",
      blocker: "Write permission was not granted.",
      createdAt: "2026-05-25T00:44:00.000Z",
      updatedAt: "2026-05-25T00:48:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const feedWorkCell = feed.locator('.conversation-work-cell[data-thread-id="workflow:workflow_running_ui"]');
  await expect(feedWorkCell).toHaveAttribute("data-operation-source", "workflow");
  await expect(feedWorkCell.getByRole("button", { name: "Expand operation" })).toHaveCount(0);
  await expect(feedWorkCell.locator(".conversation-work-cell-agent-spans")).toBeVisible();
  await expect(feedWorkCell).not.toContainText("Agent branches");
  await expect(feedWorkCell).toContainText("Engineer");
  await expect(feedWorkCell).toContainText("QA");
  await expect(feedWorkCell).toContainText("Security");
  await expect(feedWorkCell).not.toContainText("Engineer branch");
  await expect(feedWorkCell).not.toContainText("QA branch");
  await expect(feedWorkCell).not.toContainText("branch_engineer");
  await expect(feedWorkCell).not.toContainText("hidden agent spans");
  await expect(feedWorkCell).not.toContainText("previous actions");
  await expect(feedWorkCell).not.toContainText("Confirmed proposal");
  await expect(feedWorkCell).not.toContainText("Acceptance criteria");
  await expect(feedWorkCell.locator(".conversation-work-cell-agent-span")).toHaveCount(5);
  const engineerSpan = feedWorkCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Engineer" });
  await expect(engineerSpan).toContainText("Implement card UI");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Existing task card behavior inspected.");
  const inspectedStep = engineerSpan
    .locator(".conversation-work-cell-agent-span-detail .conversation-work-cell-row")
    .filter({ hasText: "Existing task card behavior inspected." });
  await expect(inspectedStep).toBeVisible();
  const docsSpan = feedWorkCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Docs" });
  await expect(docsSpan).toContainText("Document release note");
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Document release note");
  const qaSpan = feedWorkCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "QA" });
  await expect(qaSpan).toContainText("Waiting for approval");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Waiting for approval: Validate progress panel");

  const summaryButton = page.locator(".task-toolbar-progress");
  await summaryButton.click();
  const progressPopover = page.locator(".channel-progress-popover");
  await expect(progressPopover).toHaveCount(1);
  await expect(progressPopover).toContainText("Ship workflow UI");
  await expect(progressPopover).toContainText("Create README.md");
  await expect(progressPopover).not.toContainText("Run settings");
  await expect(progressPopover).not.toContainText("Provider");
  await expect(progressPopover).not.toContainText("Permission mode");
  await expect(progressPopover).not.toContainText("Latest run");
  await expect(progressPopover).not.toContainText("workflow_running_ui");
  await expect(progressPopover).not.toContainText("branch_engineer");

  await page.locator(".task-toolbar-panel").click();
  await expect(progressPopover).toBeHidden();
  await expect(summaryButton).toHaveAttribute("aria-pressed", "true");
  await expect(summaryButton).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(".channel-side-panel.right-dock");
  await expect(panel).toHaveAttribute("aria-label", "Channel workspace dock");
  await expect(panel).toContainText("Workspace tools");
  await expect(panel).toContainText("Review");
  await expect(panel.getByRole("button", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Files");
  await expect(panel).not.toContainText("Settings");
  await expect(panel.locator(".collaboration-task-card")).toHaveCount(0);
  await expect(panel).not.toContainText("Workflow evidence");
  await expect(panel).not.toContainText("Ship workflow UI");
});

test("completed multi-agent transcript reveals all agent process rows from the parent shell", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const productRun = {
    ...state.runs[0],
    id: "run_r31_product",
    status: "succeeded",
    taskId: "task_r31_product",
    channelId: "channel_engineering",
    workflowStepId: "workflow_step_r31_product_acceptance",
    threadId: "thread_r31_product",
    createdAt: "2026-05-25T00:55:10.000Z",
    startedAt: "2026-05-25T00:55:10.000Z",
    updatedAt: "2026-05-25T00:55:20.000Z",
    endedAt: "2026-05-25T00:55:20.000Z",
    taskSnapshot: { id: "task_r31_product", title: "产品策略分析登录页 smoke" },
  };
  const qaRun = {
    ...state.runs[0],
    id: "run_r31_qa",
    status: "succeeded",
    taskId: "task_r31_qa",
    channelId: "channel_engineering",
    workflowStepId: "workflow_step_r31_qa_no_write",
    threadId: "thread_r31_qa",
    createdAt: "2026-05-25T00:55:18.000Z",
    startedAt: "2026-05-25T00:55:18.000Z",
    updatedAt: "2026-05-25T00:55:30.000Z",
    endedAt: "2026-05-25T00:55:30.000Z",
    taskSnapshot: { id: "task_r31_qa", title: "QA 验证登录页 smoke" },
  };
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_r31_request",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "分析登录页 smoke 的目标范围，仅输出结论。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:55:00.000Z",
      updatedAt: "2026-05-25T00:55:00.000Z",
    },
    {
      id: "msg_r31_start",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r31_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: [
        "**这条用户消息是一个多参与者可执行 workflow。**",
        "",
        "原始请求:",
        "@Engineer @QA 请协作完成一个真实的频道执行任务：Engineer 必须在当前工作区创建 r5-packaged-restart-proof.txt，内容为 PACKAGED_RESTART_OK_20260823；QA 必须在 Engineer 完成后验证文件内容。",
        "",
        "执行任务: Engineer 必须在当前工作区创建文件，QA 必须在 Engineer 完成后验证文件内容。",
        "",
        "已物化的执行操作:",
        "- create_file: file_create -> r5-packaged-restart-proof.txt; owner Engineer",
        "- verify_target: run_command -> verify target; owner QA; depends on create_file",
        "",
        "参与者操作归属:",
        "- Engineer: create_file",
        "- QA: verify_target",
      ].join("\n"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:55:01.000Z",
      updatedAt: "2026-05-25T00:55:01.000Z",
    },
    {
      id: "msg_r31_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r31_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "完成：「开始 workflow：产品策略分析登录页 smoke 的目标范围，仅输出结论。Smoke ID: single-product-20260615-2241。」。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T00:55:30.000Z",
      updatedAt: "2026-05-25T00:55:30.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_r31",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_r31_request",
      proposedByTeammateId: "ling_agent",
      title: "开始 workflow：产品策略分析登录页 smoke 的目标范围，仅输出结论。Smoke ID: single-product-20260615-2241。",
      prompt: "分析登录页 smoke 的目标范围，仅输出结论。",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Only analysis is produced."],
      collaborationSteps: [
        { teammateId: "product", action: "consulted", summary: "梳理登录页 smoke 的目标范围。" },
        { teammateId: "qa", action: "reviewed", summary: "验证验收口径覆盖登录页目标。" },
      ],
      requiredTools: ["read"],
      status: "accepted",
      linkedWorkflowId: "workflow_r31",
      createdAt: "2026-05-25T00:55:00.500Z",
      updatedAt: "2026-05-25T00:55:01.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_r31",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "开始 workflow：产品策略分析登录页 smoke 的目标范围，仅输出结论。Smoke ID: single-product-20260615-2241。",
      objective: "分析登录页 smoke 的目标范围，仅输出结论。",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:55:01.000Z",
      updatedAt: "2026-05-25T00:55:30.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_r31_product_scope",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r31",
      position: 1,
      title: "Consult",
      prompt: "梳理登录页 smoke 的目标范围。",
      toParticipantId: "product",
      toParticipantLabel: "产品策略",
      status: "succeeded",
      metadata: { branchGroupId: "branch_product" },
      createdAt: "2026-05-25T00:55:02.000Z",
      updatedAt: "2026-05-25T00:55:10.000Z",
    },
    {
      id: "workflow_step_r31_product_acceptance",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r31",
      position: 2,
      title: "Review",
      prompt: "输出验收口径。",
      toParticipantId: "product",
      toParticipantLabel: "产品策略",
      status: "succeeded",
      metadata: { branchGroupId: "branch_product" },
      createdAt: "2026-05-25T00:55:10.000Z",
      updatedAt: "2026-05-25T00:55:20.000Z",
    },
    {
      id: "workflow_step_r31_qa_validate",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r31",
      position: 3,
      title: "Review",
      prompt: "验证验收口径覆盖登录页目标。",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "succeeded",
      metadata: { branchGroupId: "branch_qa" },
      createdAt: "2026-05-25T00:55:05.000Z",
      updatedAt: "2026-05-25T00:55:18.000Z",
    },
    {
      id: "workflow_step_r31_qa_no_write",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r31",
      position: 4,
      title: "Review",
      prompt: "确认不需要修改文件。",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "succeeded",
      metadata: { branchGroupId: "branch_qa" },
      createdAt: "2026-05-25T00:55:18.000Z",
      updatedAt: "2026-05-25T00:55:30.000Z",
    },
  ];
  state.runs = [productRun, qaRun];
  state.artifactsByRun[productRun.id] = [
    {
      id: "artifact_r31_product_scope",
      runId: productRun.id,
      type: "file",
      path: "docs/login-smoke-scope.md",
      title: "login-smoke-scope.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 720,
      createdAt: "2026-05-25T00:55:16.000Z",
    },
  ];
  state.executionActions = [
    {
      id: "execution_action_r31_product_read",
      workspaceId: "workspace_default",
      runId: productRun.id,
      actionType: "read",
      risk: "low",
      status: "succeeded",
      title: "读取 smoke 范围笔记",
      summary: "产品策略读取登录页 smoke 范围笔记。",
      targetRefs: [{ type: "file", path: "docs/login-smoke-scope.md" }],
      previewArtifactIds: [],
      resultArtifactIds: ["artifact_r31_product_scope"],
      createdAt: "2026-05-25T00:55:12.000Z",
      updatedAt: "2026-05-25T00:55:16.000Z",
      executedAt: "2026-05-25T00:55:12.000Z",
      completedAt: "2026-05-25T00:55:16.000Z",
    },
    {
      id: "execution_action_r31_qa_check",
      workspaceId: "workspace_default",
      runId: qaRun.id,
      actionType: "bash",
      risk: "medium",
      status: "succeeded",
      title: "运行 smoke 验收检查",
      summary: "QA 运行登录页 smoke 验收检查。",
      targetRefs: [{ type: "command", label: "pnpm --filter @ling-stack/web test:e2e -- login-smoke" }],
      previewArtifactIds: [],
      resultArtifactIds: [],
      createdAt: "2026-05-25T00:55:22.000Z",
      updatedAt: "2026-05-25T00:55:28.000Z",
      executedAt: "2026-05-25T00:55:22.000Z",
      completedAt: "2026-05-25T00:55:28.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".message-feed");
  const turn = feed.locator(".conversation-turn");
  await expect(turn).toHaveCount(1);
  const assistantTranscript = turn.locator(".conversation-turn-assistant-row");
  await expect(assistantTranscript).toHaveCount(1);
  await expect(assistantTranscript).toContainText("分析登录页 smoke 的目标范围，仅输出结论");
  await expect(assistantTranscript).toContainText("协作队友：产品策略、QA");
  await expect(assistantTranscript.locator(".channel-team-experts-summary")).toHaveCount(0);
  const transcriptArtifacts = assistantTranscript.locator(".conversation-turn-artifacts");
  await expect(transcriptArtifacts).toContainText("login-smoke-scope.md");
  await expect.poll(() =>
    assistantTranscript.locator(".conversation-turn-assistant-transcript").evaluate((element) => {
      const childClasses = Array.from(element.children).map((child) => child.className.toString());
      const terminalIndex = childClasses.findIndex((className) => className.includes("conversation-turn-assistant-copy terminal"));
      const artifactsIndex = childClasses.findIndex((className) => className.includes("conversation-turn-artifacts"));
      const actionsIndex = childClasses.findIndex((className) => className.includes("channel-message-row-footer-stack"));
      return {
        actionsIsLast: actionsIndex === childClasses.length - 1,
        terminalBeforeArtifacts: terminalIndex >= 0 && artifactsIndex > terminalIndex,
        artifactsBeforeActions: actionsIndex > artifactsIndex,
      };
    }),
  ).toEqual({
    actionsIsLast: true,
    terminalBeforeArtifacts: true,
    artifactsBeforeActions: true,
  });
  await expect(feed).not.toContainText("确认需求：");
  await expect(feed).not.toContainText("完成：");
  await expect(feed).not.toContainText("Confirm requirement");
  await expect(feed).not.toContainText("Completed:");
  await expect(feed).not.toContainText("该任务交给 产品策略、QA 处理。");
  await expect(feed).not.toContainText("Smoke ID");
  await expect(feed).not.toContainText("开始 workflow");
  await expect(feed).not.toContainText("原始请求:");
  await expect(feed).not.toContainText("已物化的执行操作:");
  await expect(feed).not.toContainText("参与者操作归属:");
  await expect(feed).not.toContainText("r5-packaged-restart-proof.txt");

  const workCell = assistantTranscript.locator(".conversation-work-cell").first();
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expect(workCell.locator(".conversation-work-cell-artifact-row")).toHaveCount(0);
  await expect(workCell).toContainText("产品策略");
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(2);
  await expect(workCell).toContainText("已读取 login-smoke-scope.md");
  await expect(workCell).toContainText("已运行命令");
  await expect(workCell).not.toContainText("Consult");
  await expect(workCell).not.toContainText("Review");
  await expect(workCell).not.toContainText("branch_product");

  const productSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "产品策略" });
  await expect(productSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("梳理登录页 smoke 的目标范围");
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("输出验收口径");
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("已读取 login-smoke-scope.md");
  const productActionRow = productSpan.locator(".conversation-work-cell-row").filter({ hasText: "已读取 login-smoke-scope.md" });
  await productActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(productActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("读取 smoke 范围笔记");
  await expect(productActionRow.locator(".conversation-work-cell-row-detail")).toContainText("docs/login-smoke-scope.md");

  const qaSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "QA" });
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("验证验收口径覆盖登录页目标");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("确认不需要修改文件");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("已运行命令");
  const qaActionRow = qaSpan.locator(".conversation-work-cell-row").filter({ hasText: "已运行命令" });
  await qaActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(qaActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("运行 smoke 验收检查");
  await expect(qaActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm --filter @ling-stack/web test:e2e -- login-smoke");
  await maybeCaptureR32Screenshot(page, "serial-multi-agent-expanded");
});

test("channel-root thread metadata still folds internal coordinator prompts into the transcript", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const rootThreadId = "thread_channel_channel_engineering";
  state.threads = [{
    id: rootThreadId,
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Main branch",
    objective: "Main conversation branch for Engineering.",
    status: "open",
    surfaceKind: "channel_root",
    relationKind: "root",
    conversationMode: { mode: "default" },
    createdAt: "2026-05-25T01:10:00.000Z",
    updatedAt: "2026-05-25T01:10:00.000Z",
  }];
  state.channelMessages = [
    {
      id: "msg_channel_root_metadata",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: rootThreadId,
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "请完成一次真实的频道执行任务。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T01:10:01.000Z",
      updatedAt: "2026-05-25T01:10:01.000Z",
    },
    {
      id: "msg_channel_root_internal_prompt",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: rootThreadId,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: [
        "**这条用户消息是一个多参与者可执行 workflow。**",
        "",
        "原始请求:",
        "请完成一次真实的频道执行任务。",
        "",
        "执行任务: 这是内部协调器 prompt，不应作为普通正文展示。",
        "",
        "已物化的执行操作:",
        "- create_file: file_create -> proof.txt; owner Engineer",
      ].join("\n"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-05-25T01:10:02.000Z",
      updatedAt: "2026-05-25T01:10:02.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".message-feed");
  await expect(feed).toContainText("请完成一次真实的频道执行任务。");
  await expect(feed).not.toContainText("这条用户消息是一个多参与者可执行 workflow");
  await expect(feed).not.toContainText("原始请求:");
  await expect(feed).not.toContainText("内部协调器 prompt");
});

test("completed single-step agent span without branch metadata keeps expandable process detail inside one assistant transcript", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [
    {
      id: "msg_r31_single_request",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "让 QA 验证登录页 smoke 目标范围。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:05:00.000Z",
      updatedAt: "2026-05-25T01:05:00.000Z",
    },
    {
      id: "msg_r31_single_start",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r31_single_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "确认需求：「开始 workflow：让 QA 验证登录页 smoke 目标范围。Smoke ID: single-step-agent。」。开始处理。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:05:01.000Z",
      updatedAt: "2026-05-25T01:05:01.000Z",
    },
    {
      id: "msg_r31_single_done",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "msg_r31_single_request",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "完成：「开始 workflow：让 QA 验证登录页 smoke 目标范围。Smoke ID: single-step-agent。」。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:05:30.000Z",
      updatedAt: "2026-05-25T01:05:30.000Z",
    },
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_r31_single",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_r31_single_request",
      proposedByTeammateId: "ling_agent",
      title: "开始 workflow：让 QA 验证登录页 smoke 目标范围。Smoke ID: single-step-agent。",
      prompt: "让 QA 验证登录页 smoke 目标范围。",
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["QA scope is verified."],
      collaborationSteps: [
        { teammateId: "qa", action: "reviewed", summary: "验证登录页 smoke 目标范围。" },
      ],
      requiredTools: ["read"],
      status: "accepted",
      linkedWorkflowId: "workflow_r31_single",
      createdAt: "2026-05-25T01:05:00.500Z",
      updatedAt: "2026-05-25T01:05:01.000Z",
    },
  ];
  state.channelWorkflows = [
    {
      id: "workflow_r31_single",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "开始 workflow：让 QA 验证登录页 smoke 目标范围。Smoke ID: single-step-agent。",
      objective: "让 QA 验证登录页 smoke 目标范围。",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T01:05:01.000Z",
      updatedAt: "2026-05-25T01:05:30.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_r31_single_qa",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_r31_single",
      position: 1,
      title: "Review",
      prompt: "验证登录页 smoke 目标范围。",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "succeeded",
      createdAt: "2026-05-25T01:05:02.000Z",
      updatedAt: "2026-05-25T01:05:30.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".message-feed");
  const turn = feed.locator(".conversation-turn");
  await expect(turn).toHaveCount(1);
  const assistantTranscript = turn.locator(".conversation-turn-assistant-row");
  await expect(assistantTranscript).toHaveCount(1);
  await expect(assistantTranscript).toContainText("让 QA 验证登录页 smoke 目标范围");
  await expect(assistantTranscript).toContainText("验证登录页 smoke 目标范围");
  await expect(assistantTranscript).toContainText("协作队友：QA");
  await expect(feed).not.toContainText("确认需求：");
  await expect(feed).not.toContainText("完成：");
  await expect(feed).not.toContainText("Confirm requirement");
  await expect(feed).not.toContainText("Completed:");
  await expect(feed).not.toContainText("Smoke ID");
  await expect(feed).not.toContainText("开始 workflow");
  await expect(feed).not.toContainText("Review");
  await expect(feed).not.toContainText("复核范围");
  await expect(feed).not.toContainText("协调任务");

  const workCell = assistantTranscript.locator(".conversation-work-cell").first();
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toContainText("验证登录页 smoke 目标范围");
});

test("progress surfaces fold completed workflow steps behind summaries", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelWorkflows = [
    {
      id: "workflow_current_blocked",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Current implementation",
      objective: "Fix the active progress projection.",
      status: "blocked",
      createdBy: "local-user",
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:03:00.000Z",
    },
    {
      id: "workflow_completed_history",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Completed docs review",
      objective: "Keep completed details behind evidence.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:55:00.000Z",
      updatedAt: "2026-05-25T01:02:00.000Z",
    },
    {
      id: "workflow_completed_older",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Older completed review",
      objective: "This terminal workflow should stay behind history.",
      status: "succeeded",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:40:00.000Z",
      updatedAt: "2026-05-25T00:45:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_current_blocked",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_current_blocked",
      position: 1,
      title: "Resolve active blocker",
      prompt: "Resolve the current blocker.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      status: "blocked",
      blocker: "Waiting for write permission.",
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:03:00.000Z",
    },
    {
      id: "workflow_step_completed_docs",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_completed_history",
      position: 1,
      title: "Docs: Draft completed summary",
      prompt: "Draft a completed summary.",
      toParticipantId: "docs",
      toParticipantLabel: "Docs",
      status: "succeeded",
      resultSummary: "Drafted the completed summary.",
      createdAt: "2026-05-25T00:55:00.000Z",
      updatedAt: "2026-05-25T01:00:00.000Z",
    },
    {
      id: "workflow_step_completed_qa",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_completed_history",
      position: 2,
      title: "QA: Check completed summary",
      prompt: "Check the completed summary.",
      toParticipantId: "qa",
      toParticipantLabel: "QA",
      status: "succeeded",
      resultSummary: "Checked the completed summary.",
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:02:00.000Z",
    },
    {
      id: "workflow_step_completed_older",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_completed_older",
      position: 1,
      title: "Docs: Older completed step",
      prompt: "Keep this older completed step out of Progress.",
      toParticipantId: "docs",
      toParticipantLabel: "Docs",
      status: "succeeded",
      resultSummary: "Older completion.",
      createdAt: "2026-05-25T00:40:00.000Z",
      updatedAt: "2026-05-25T00:45:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.locator(".task-toolbar-progress").click();

  const progressPopover = page.locator(".channel-progress-popover");
  await expect(progressPopover).toHaveCount(1);
  await expect(progressPopover).toContainText("Current implementation");
  await expect(progressPopover).not.toContainText("Run settings");
  await expect(progressPopover).not.toContainText("Provider");
  await expect(progressPopover).not.toContainText("Permission mode");
  await expect(progressPopover).not.toContainText("Completed docs review");
  await expect(progressPopover).not.toContainText("Older completed review");
  await page.locator(".task-toolbar-panel").click();
  const panel = page.locator(".channel-side-panel.right-dock");
  await expect(panel).toHaveAttribute("aria-label", "Channel workspace dock");
  await expect(panel).not.toContainText("Current implementation");
  await expect(panel).not.toContainText("Completed docs review");
  await expect(panel).not.toContainText("Older completed review");
  await expect(panel).not.toContainText("Docs: Draft completed summary");
  await expect(panel).not.toContainText("QA: Check completed summary");
  await expect(panel).not.toContainText("Docs: Older completed step");
  await expect(panel).not.toContainText("Waiting for proposal confirmation");
  await expect(panel.locator(".collaboration-task-card")).toHaveCount(0);
});

test("progress popover prefers daemon collaboration card payload", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelWorkflows = [
    {
      id: "workflow_daemon_card_source",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Local fallback workflow title",
      daemonCardTitle: "Daemon collaboration card title",
      objective: "Local fallback objective.",
      daemonCardObjective: "Daemon-projected objective.",
      status: "running",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:50:00.000Z",
      updatedAt: "2026-05-25T00:51:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_daemon_card_active",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_daemon_card_source",
      position: 1,
      title: "Use daemon card",
      prompt: "Render the daemon card payload.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "running",
      createdAt: "2026-05-25T00:50:00.000Z",
      updatedAt: "2026-05-25T00:51:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.locator(".task-toolbar-progress").click();

  const progressPopover = page.locator(".channel-progress-popover");
  await expect(progressPopover).toHaveCount(1);
  await expect(progressPopover).toContainText("Daemon collaboration card title");
  await expect(progressPopover).toContainText("Ling Agent");
  await expect(progressPopover).not.toContainText("Local fallback workflow title");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

test("progress popover falls back to local collaboration card derivation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelWorkflows = [
    {
      id: "workflow_local_card_fallback",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Local fallback workflow title",
      daemonCardTitle: "Hidden daemon-only title",
      objective: "Local fallback objective.",
      daemonCardObjective: "Hidden daemon-only objective.",
      status: "running",
      createdBy: "local-user",
      createdAt: "2026-05-25T00:52:00.000Z",
      updatedAt: "2026-05-25T00:53:00.000Z",
    },
  ];
  state.channelWorkflowSteps = [
    {
      id: "workflow_step_local_card_fallback",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      workflowId: "workflow_local_card_fallback",
      position: 1,
      title: "Use local fallback",
      prompt: "Render the local fallback card.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "running",
      createdAt: "2026-05-25T00:52:00.000Z",
      updatedAt: "2026-05-25T00:53:00.000Z",
    },
  ];

  await mockDaemon(page, state, { collaborationCardsUnsupported: true });
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.locator(".task-toolbar-progress").click();

  const progressPopover = page.locator(".channel-progress-popover");
  await expect(progressPopover).toHaveCount(1);
  await expect(progressPopover).toContainText("Local fallback workflow title");
  await expect(progressPopover).toContainText("Ling Agent");
  await expect(progressPopover).not.toContainText("Hidden daemon-only title");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

test("channel workspace utility panel follows dark theme surfaces", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  const viewMenu = page.getByRole("menu", { name: "More channel views" });
  await expect(viewMenu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(viewMenu.getByRole("menuitem", { name: "Files" })).toHaveCount(0);
  await viewMenu.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator(".channel-settings-page")).toBeVisible();
  const utilityPanelLayout = await page.evaluate(() => {
    const panel = document.querySelector(".channel-settings-page");
    const settings = document.querySelector(".channel-settings-stack");
    if (!panel || !settings) {
      return null;
    }
    return {
      settingsHeight: settings.getBoundingClientRect().height,
      panelHeight: panel.getBoundingClientRect().height,
    };
  });
  if (!utilityPanelLayout) {
    throw new Error("Settings utility panel layout was not rendered");
  }
  expect(utilityPanelLayout.settingsHeight).toBeGreaterThan(0);
  const utilityPanelDarkSurfaces = await page.evaluate(() => {
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
    const selectors = [".channel-settings-card", ".channel-settings-stack"];
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
  expect(utilityPanelDarkSurfaces.length).toBeGreaterThan(0);
  for (const surface of utilityPanelDarkSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should follow dark theme tokens`).toBeLessThanOrEqual(45);
  }
});

test("channel activity filter chips follow dark theme tokens", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const activityFilters = channelEventFilters(page);
  await channelEventFilterToggle(activityFilters).click();
  await expect(activityFilters.locator(".activity-filter-panel")).toBeVisible();
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
    expect(surface.maxChannel, `${surface.selector} should follow dark theme tokens`).toBeLessThanOrEqual(60);
  }
});

test("channel activity keeps the composer visible while the message feed scrolls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
  state.channelMessages.push({
    id: "msg_scroll_pending_reply",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "Pending reply keeps background refresh active.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "pending",
    createdAt: "2026-05-25T00:40:00.000Z",
    updatedAt: "2026-05-25T00:40:00.000Z",
  });
  state.channels.push({
    id: "channel_general",
    workspaceId: "workspace_default",
    name: "General",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "engineer",
    autoReplyMode: "mentions_only",
    allowedTools: ["read", "grep", "find", "ls"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-25T00:41:00.000Z",
    updatedAt: "2026-05-25T00:41:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await expect(page.locator('[aria-label="Channel activity"] > .panel-title')).toHaveCount(0);
  const messageFeed = page.locator(".activity-shell .message-feed");
  const scrollState = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollState.max).toBeGreaterThan(0);
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  const latestButton = page.getByRole("button", { name: "Jump to latest message" });
  await expect(latestButton).toHaveCount(0);
  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
  });
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
  await messageFeed.hover();
  await page.mouse.wheel(0, -1_200);
  await messageFeed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: false });
  await expect(latestButton).toBeVisible();
  await expect.poll(async () => {
    const latestButtonBox = await latestButton.boundingBox();
    return {
      width: Math.round(latestButtonBox?.width ?? 0),
      height: Math.round(latestButtonBox?.height ?? 0),
    };
  }).toMatchObject({ width: 42, height: 42 });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect(latestButton).toHaveCount(0);
  await page.waitForTimeout(1_100);
  await messageFeed.hover();
  await page.mouse.wheel(0, -1_200);
  await messageFeed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: false });
  await expect(latestButton).toBeVisible();
  state.channelMessages.push({
    id: "msg_scroll_background_failed",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "Background failed update while the user is reading older messages.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "failed",
    createdAt: "2026-05-25T01:00:00.000Z",
    updatedAt: "2026-05-25T01:00:00.000Z",
  });
  await expect(page.getByRole("button", { name: /Background work needs attention/ })).toHaveCount(0);
  await expect(latestButton).toBeVisible();
  await latestButton.click();
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect(latestButton).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
});

test("channel message feed supports focused block shortcuts and safe action menu", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __lingCopiedText?: string }).__lingCopiedText = text;
        },
      },
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    {
      id: "msg_focus_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Focused block alpha.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:10:00.000Z",
      updatedAt: "2026-05-25T01:10:00.000Z",
    },
    {
      id: "msg_focus_2",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "engineer",
      body: "Focused block beta with **markdown**.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:11:00.000Z",
      updatedAt: "2026-05-25T01:11:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed).not.toHaveAttribute("title");
  await feed.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-feed-item-id") ?? "")).toBe("conversation-turn:msg_focus_1");
  await page.keyboard.press("Control+Shift+C");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lingCopiedText?: string }).__lingCopiedText ?? "")).toContain("Focused block alpha.");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="message:conversation-turn:msg_focus_1:copy"]'))
    .toContainText("Copied focused block");

  const firstRow = page.locator('[data-feed-item-id="conversation-turn:msg_focus_1"]');
  await firstRow.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Conversation block actions" });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Conversation turn");
  await expect(menu.getByRole("menuitem", { name: "Copy block" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Focus block" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy block" })).toBeFocused();
  await expect(menu).not.toContainText("Approve");
  await expect(menu).not.toContainText("Cancel");
  await expect(menu).not.toContainText("Delete");
  await expect(menu).not.toContainText("Stop");
  await menu.getByRole("menuitem", { name: "Copy block" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lingCopiedText?: string }).__lingCopiedText ?? "")).toContain("Focused block alpha.");

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(firstRow).toBeFocused();
  const secondRow = page.locator("[data-conversation-focus-block='true']").filter({ hasText: "Focused block beta" });
  const secondBox = await secondRow.boundingBox();
  await secondRow.dispatchEvent("pointerdown", {
    pointerId: 42,
    pointerType: "touch",
    clientX: Math.round((secondBox?.x ?? 80) + 20),
    clientY: Math.round((secondBox?.y ?? 120) + 20),
    bubbles: true,
  });
  await page.waitForTimeout(620);
  await expect(page.getByRole("menu", { name: "Conversation block actions" })).toBeVisible();
  await secondRow.dispatchEvent("pointerup", {
    pointerId: 42,
    pointerType: "touch",
    clientX: Math.round((secondBox?.x ?? 80) + 20),
    clientY: Math.round((secondBox?.y ?? 120) + 20),
    bubbles: true,
  });
});

test("channel message feed stays pinned while AI reply text streams", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "auto_route";
  }
  state.channelMessages = Array.from({ length: 36 }, (_, index) => ({
    id: `msg_stream_scroll_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: `Streaming scroll seed message ${index + 1}.`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 4, 25, 1, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 4, 25, 1, index, 0)).toISOString(),
  }));
  state.channelAiReplyBody = Array.from({ length: 40 }, (_, index) => `Auto-scroll proof paragraph ${index + 1}.`).join("\n\n");
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });

  await channelComposerTextbox(page).fill("Who owns the streaming scroll follow-up?");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expect.poll(() =>
    state.channelMessages.some((message) =>
      isRecord(message) && typeof message.body === "string" && message.body.includes("Auto-scroll proof paragraph 40.")
    )
  ).toBe(true);
  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect.poll(() => readOverlappingVirtualFeedRows(page)).toEqual([]);
});

test("channel message feed measures long turns without overlapping the next row", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const longReply = (label: string) => Array.from(
    { length: 18 },
    (_, index) => `${label} paragraph ${index + 1} contains enough text to create a variable-height conversation row.`,
  ).join("\n\n");
  const historyMessages = Array.from({ length: 20 }, (_, index) => ([
    {
      id: `msg_measure_history_user_${index}`,
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: `Historical request ${index + 1}.`,
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: new Date(Date.UTC(2026, 4, 24, 1, index, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 4, 24, 1, index, 0)).toISOString(),
    },
    {
      id: `msg_measure_history_agent_${index}`,
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: `Historical response ${index + 1} keeps a realistic two-message turn in the virtualized channel history.`,
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: new Date(Date.UTC(2026, 4, 24, 1, index, 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 4, 24, 1, index, 1)).toISOString(),
    },
  ])).flat();
  state.channelMessages = [
    ...historyMessages,
    {
      id: "msg_measure_user_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Please write the first detailed response.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:00:00.000Z",
    },
    {
      id: "msg_measure_agent_1",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: longReply("First response"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:01:00.000Z",
      updatedAt: "2026-05-25T01:01:00.000Z",
    },
    {
      id: "msg_measure_user_2",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: "Please write the second detailed response.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:02:00.000Z",
      updatedAt: "2026-05-25T01:02:00.000Z",
    },
    {
      id: "msg_measure_agent_2",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: longReply("Second response"),
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-25T01:03:00.000Z",
      updatedAt: "2026-05-25T01:03:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByText("Second response paragraph 18")).toBeVisible();
  await expect.poll(() => readOverlappingVirtualFeedRows(page)).toEqual([]);
});

test("channel message feed preserves the visible anchor while active content grows above it", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    ...Array.from({ length: 36 }, (_, index) => ({
      id: `msg_anchor_${index + 1}`,
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: `Anchor seed message ${index + 1}.`,
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: new Date(Date.UTC(2026, 4, 25, 2, index, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 4, 25, 2, index, 0)).toISOString(),
    })),
    {
      id: "msg_anchor_pending",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "Pending reply keeps the feed refreshing.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "pending",
      createdAt: "2026-05-25T02:40:00.000Z",
      updatedAt: "2026-05-25T02:40:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.locator(".activity-shell .message-feed");
  await feed.hover();
  await page.mouse.wheel(0, -1_200);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  const anchorBefore = await readStableFirstVisibleFeedAnchor(page);
  const expandedMessage = state.channelMessages.find((message) => isRecord(message) && message.id === "msg_anchor_1");
  if (!isRecord(expandedMessage)) {
    throw new Error("Anchor fixture message missing");
  }
  expandedMessage.body = Array.from({ length: 18 }, (_, index) => `Expanded history line ${index + 1}.`).join("\n\n");
  expandedMessage.updatedAt = "2026-05-25T02:41:00.000Z";

  await expect.poll(async () => {
    const anchorAfter = await readFirstVisibleFeedAnchor(page);
    return Boolean(
      anchorAfter &&
      anchorAfter.id === anchorBefore.id &&
      Math.abs(anchorAfter.offsetTop - anchorBefore.offsetTop) <= 4
    );
  }).toBe(true);
});

test("channel activity paginates long message history and virtualizes visible rows", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
  await openEngineeringChannel(page);

  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 3000")).toBeVisible();
  await expect(page.getByLabel("Channel message feed").getByText("Long channel message 1")).toHaveCount(0);
  expect(state.channelMessageQueries?.[0]).toMatchObject({
    channelId: "channel_engineering",
    limit: 200,
    beforeSequence: undefined,
    threadId: undefined,
  });

  const renderedBefore = await page.locator(".activity-shell .message-feed .message-bubble").count();
  expect(renderedBefore).toBeGreaterThan(0);
  expect(renderedBefore).toBeLessThan(100);
  const scrollBefore = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollBefore.atBottom).toBe(true);

  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => state.channelMessageQueries?.some((query) => query.beforeSequence === 2801 && query.threadId === undefined)).toBe(true);
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
  const state = createBaseState({ approvalStatus: "expired" });
  state.failNextChannelMessage = true;
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  const composer = page.getByLabel("Channel composer");
  await expect(composerInput).toHaveAttribute("title", "Enter sends. Shift+Enter inserts a newline. Esc closes menus.");
  await expect(composer.getByRole("button", { name: "Send" })).toHaveAttribute("title", "Send (Enter)");
  await composerInput.fill("Retryable channel message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Message failed")).toBeVisible();
  await expectComposerValue(composerInput, "Retryable channel message");

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Channel message feed").getByText("Retryable channel message")).toBeVisible();
  await expectComposerValue(composerInput, "");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:composer"]'))
    .toContainText("Message sent");
  await expect(composer.locator(".composer-status-row.success")).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).not.toContainText("Message sent");
  await expect(page.getByText("Message failed")).toHaveCount(0);
});

test("channel composer moves sent messages into the feed while routing is pending", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "auto_route";
  }
  state.channelMessageDelayMs = 1_000;
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  const channelFeed = page.getByLabel("Channel message feed");
  await composerInput.fill("Who owns the release checklist?");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();

  await expectComposerValue(composerInput, "");
  await expect(channelFeed.getByText("Who owns the release checklist?")).toBeVisible();
  await expect(channelFeed.getByText("Thinking...")).toBeVisible();
  await expect(channelFeed.getByText("收到，我会按频道上下文推进。")).toBeVisible({ timeout: 3_000 });
  await expect(channelFeed.getByText("Thinking...")).toHaveCount(0);
  await expect(channelFeed.getByText("AI teammate is replying...")).toHaveCount(0);
});

test("channel composer keeps thinking visible for acknowledged sends before completion", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "mentions_only";
  }
  const body = "你不可以直接帮我写到里面吗？";
  state.channelMessages.push({
    id: "msg_acknowledged_without_reply",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-05-25T00:18:00.000Z",
    updatedAt: "2026-05-25T00:18:00.000Z",
  });
  state.channelMessageDelayMs = 1_000;
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = page.getByRole("textbox", { name: "给频道发消息，或 @ 一个 AI 队友", exact: true });
  const channelFeed = page.getByLabel("频道消息列表");
  await composerInput.fill(body);
  await page.locator(".channel-composer").getByRole("button", { name: "发送" }).click();

  await expectComposerValue(composerInput, "");
  await expect(channelFeed.getByText(body)).toBeVisible();
  await expect(channelFeed.getByText("正在思考...")).toBeVisible();
  await expect(channelFeed.getByText("正在思考...")).toHaveCount(0, { timeout: 3_000 });
});

test("pending channel reply polling refreshes messages without refreshing global activity", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [{
    id: "msg_pending_background_poll",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "等待审批中的回复。",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "pending",
    createdAt: "2026-05-25T00:40:00.000Z",
    updatedAt: "2026-05-25T00:40:00.000Z",
  }];
  await mockDaemon(page, state);
  const daemonPaths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.port === "17891") {
      daemonPaths.push(url.pathname);
    }
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.waitForTimeout(250);
  daemonPaths.length = 0;

  await expect.poll(() => daemonPaths.filter((path) => path === "/channels/channel_engineering/items").length).toBeGreaterThan(0);
  expect(daemonPaths).not.toContain("/tasks");
  expect(daemonPaths).not.toContain("/work-items");
});

test("channel conversation turn shows thinking for empty pending ai replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
  if (isRecord(channel)) {
    channel.autoReplyMode = "default_teammate";
    channel.defaultTeammateId = "ling_agent";
  }
  state.keepChannelAiReplyPending = true;
  await mockDaemon(page, state, { channelAutoRouteEnabled: true });
  await page.goto("/");
  await openEngineeringChannel(page);

  const body = "你现在可以帮我写在本地里面了吗？";
  const composerInput = page.getByRole("textbox", { name: "给频道发消息，或 @ 一个 AI 队友", exact: true });
  const channelFeed = page.getByLabel("频道消息列表");
  await composerInput.fill(body);
  await page.locator(".channel-composer").getByRole("button", { name: "发送" }).click();

  await expect(channelFeed.getByText(body)).toBeVisible();
  await expect(channelFeed.locator(".channel-send-thinking-row")).toHaveCount(0);
  const thinkingBlock = channelFeed.locator(".conversation-turn-assistant-copy.message-body-with-spinner");
  const thinkingMessage = thinkingBlock.getByText("正在思考...");
  await expect(thinkingMessage).toBeVisible();
  await expect(thinkingMessage).toHaveCSS("font-size", "15px");
  await expect(thinkingMessage).toHaveCSS("font-weight", "550");
  await expect(thinkingMessage).toHaveCSS("color", "rgb(25, 28, 31)");
  await expect(thinkingBlock.locator(".message-pending-spinner")).toHaveCSS("margin-top", "5px");
  const virtualTailClearance = await channelFeed.locator(".message-feed-virtualizer").evaluate((virtualizer) => {
    const lastRow = virtualizer.querySelector<HTMLElement>(".message-feed-virtual-row:last-child");
    return lastRow ? Math.round(virtualizer.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom) : 0;
  });
  expect(virtualTailClearance).toBeGreaterThanOrEqual(37);
});

test("channel URL preview blocked state stays in Activity and still allows sending text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await channelComposerTextbox(page).fill("Please remember this blocked reference http://127.0.0.1/private");
  await expect(page.getByText("Private network previews are blocked.")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByLabel("Channel message feed")).toBeVisible();

  await page.getByRole("button", { name: "Send" }).click();
  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("Please remember this blocked reference")).toBeVisible();
  await expect(channelFeed.getByRole("link", { name: "127.0.0.1" })).toHaveAttribute("href", "http://127.0.0.1/private");
});

test("channel attachment uploads support PDF and Office files without AI ingestion", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const initialMessageCount = state.channelMessages.length;
  const initialTaskCount = state.tasks.length;
  await expect(channelComposerTextbox(page)).toBeVisible();
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
  await expect(page.getByLabel("Pending message assets")).toContainText("requirements.pdf");
  await expect(page.getByLabel("Pending message assets")).toContainText("notes.docx");
  await expect(page.getByLabel("Pending message assets")).toContainText("budget.xlsx");
  await expect(page.getByLabel("Pending message assets")).toContainText("deck.pptx");
  for (const fileName of ["requirements.pdf", "notes.docx", "budget.xlsx", "deck.pptx"]) {
    await expect(page.getByLabel("Pending message assets")).toContainText(fileName);
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

test("channel run artifacts stay isolated without default drawer leakage", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  const viewMenu = page.getByRole("menu", { name: "More channel views" });
  await expect(viewMenu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(viewMenu.getByRole("menuitem", { name: "Files" })).toHaveCount(0);
  await expect(page.getByText("Loading run artifacts...")).toHaveCount(0);
  await expect(page.getByText("Run artifacts")).toHaveCount(0);
  await expect(page.getByText("Channel report")).toHaveCount(0);
  await expect(page.getByText("Channel image")).toHaveCount(0);
  await expect(page.getByText("Other channel report")).toHaveCount(0);
  expect(state.artifactsByRun.run_failed.filter((artifact) => isRecord(artifact)).map((artifact) => artifact.title)).toEqual([
    "Channel report",
    "Channel image",
  ]);
  expect(state.artifactsByRun.run_design.filter((artifact) => isRecord(artifact)).map((artifact) => artifact.title)).toEqual([
    "Other channel report",
  ]);
});

test("channel review source stays in conversation instead of the legacy context drawer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelContextSummaries = [
    {
      id: "summary_seed_context",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      targetType: "thread",
      targetId: "thread_seed_context",
      sourceMessageIds: [],
      decisionIds: [],
      summary: "Seed context summary for channel inspector deep-link.",
      acceptanceCriteria: [],
      openQuestions: [],
      authorType: "system",
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "More channel views" }).click();
  const viewMenu = page.getByRole("menu", { name: "More channel views" });
  await expect(viewMenu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(viewMenu.getByRole("menuitem", { name: "Files" })).toHaveCount(0);
  await expect(viewMenu.getByRole("menuitem", { name: "Review" })).toHaveCount(0);
  await expect(viewMenu.getByRole("menuitem", { name: "Context" })).toBeVisible();
  await expect(viewMenu.getByRole("menuitem", { name: "Progress" })).toHaveCount(0);
  await viewMenu.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator(".channel-settings-page")).toBeVisible();
  await page.getByRole("button", { name: "Back to channel" }).click();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();

  await openChannelChatTools(page);
  const summaryBubble = page.locator(".message-bubble").filter({ hasText: "Context summary" }).filter({ hasText: "Seed context summary" });
  await expect(summaryBubble).toBeVisible();
  await expect(summaryBubble).toHaveClass(/message-bubble-protocol/);
  const taskCount = state.tasks.length;
  await summaryBubble.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await summaryBubble.getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);
});

test("handoff activity starts workflows without restoring the legacy context drawer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider()];
  await mockDaemon(page, state);
  await page.goto("/");

  await openTaskFromAttentionQueue(page, "Inspect workspace");
  await page.locator("article.task-detail").getByRole("button", { name: "Create handoff" }).click();
  await expect.poll(() => state.channelHandoffs.length).toBe(1);

  await openChannelChatTools(page);
  const handoffBubble = page.locator(".message-bubble").filter({ hasText: "Handoff" }).filter({ hasText: "Inspect workspace" });
  await expect(handoffBubble).toBeVisible();
  await handoffBubble.getByRole("button", { name: "Start workflow" }).click();
  await expect.poll(() => state.channelWorkflows.length).toBe(1);
  await expect.poll(() => state.channelWorkflowSteps.length).toBe(1);
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow" }).filter({ hasText: "Inspect workspace workflow" })).toBeVisible();
  await handoffBubble.getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);

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
  await openChannelChatTools(page);
  const blockedStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked follow-up" });
  await expect(blockedStepBubble).toContainText("Provider preflight failed.");
  await blockedStepBubble.getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);
});

test("workflow activity uses review source instead of the legacy context run surface", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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

  await openChannelChatTools(page);
  const workflowBubble = page.locator(".message-bubble").filter({ hasText: "Workflow" }).filter({ hasText: "Seed workflow" });
  await expect(workflowBubble).toBeVisible();
  await expect(workflowBubble.getByRole("button", { name: "Review source" })).toBeVisible();
  await workflowBubble.getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);
});

test("a terminal report published after workflow completion appears without reloading the channel", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    const subscribers = new Set<EventTarget>();
    class TestEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = TestEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        subscribers.add(this);
      }

      close(): void {
        this.readyState = TestEventSource.CLOSED;
        subscribers.delete(this);
      }
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource });
    Object.defineProperty(globalThis, "__emitLateTerminalReportInvalidation", {
      configurable: true,
      value: () => {
        const events = [
          {
            seq: 999,
            workspaceId: "workspace_default",
            cwd: "/workspace",
            ts: "2026-08-10T00:01:04.000Z",
            domain: "runs",
            entityType: "workflow",
            entityId: "workflow_late_terminal_report",
            action: "workflow.completed",
            data: {},
          },
          {
            seq: 1000,
            workspaceId: "workspace_default",
            cwd: "/workspace",
            ts: "2026-08-10T00:01:05.000Z",
            domain: "work_units",
            entityType: "terminal_report",
            entityId: "terminal_report_late_terminal_report",
            action: "terminal_report.published",
            data: {},
          },
        ];
        for (const data of events) {
          const event = new MessageEvent("control_plane_event", { data: JSON.stringify(data) });
          subscribers.forEach((subscriber) => subscriber.dispatchEvent(event));
        }
      },
    });
    Object.defineProperty(globalThis, "__readyLateTerminalReportControlPlane", {
      configurable: true,
      value: () => {
        const ready = new MessageEvent("control_plane_replay_ready", {
          data: JSON.stringify({
            disposition: "complete",
            requestedAfterSeq: 0,
            replayFloorSeq: 0,
            upperBoundSeq: 0,
            nextAfterSeq: 0,
          }),
        });
        subscribers.forEach((subscriber) => subscriber.dispatchEvent(ready));
      },
    });
    Object.defineProperty(globalThis, "__lateTerminalReportSubscriberCount", {
      configurable: true,
      value: () => subscribers.size,
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const sourceMessageId = "message_late_terminal_report";
  const workflowId = "workflow_late_terminal_report";
  const stepId = "workflow_step_late_terminal_report";
  const runId = "run_late_terminal_report";
  const reportId = "terminal_report_late_terminal_report";
  const sourceCreatedAt = "2026-08-10T00:00:00.000Z";
  const terminalAt = "2026-08-10T00:01:00.000Z";
  const reportAt = "2026-08-10T00:01:05.000Z";
  const runSeed = state.runs[0];
  if (!runSeed) throw new Error("Base run fixture is missing");

  state.channelMessages = [{
    id: sourceMessageId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Create and verify late-result.txt.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: sourceCreatedAt,
    updatedAt: sourceCreatedAt,
  }];
  state.channelWorkflows = [{
    id: workflowId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: "Late terminal result",
    objective: "Create and verify late-result.txt.",
    status: "succeeded",
    createdBy: "ling_agent",
    metadata: { sourceMessageId },
    createdAt: sourceCreatedAt,
    updatedAt: terminalAt,
  }];
  state.channelWorkflowSteps = [{
    id: stepId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    workflowId,
    runId,
    position: 1,
    title: "Create and verify",
    prompt: "Create and verify late-result.txt.",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    status: "succeeded",
    resultSummary: "late-result.txt was created and verified.",
    createdAt: sourceCreatedAt,
    updatedAt: terminalAt,
  }];
  state.runs = [{
    ...runSeed,
    id: runId,
    channelId: "channel_engineering",
    workflowStepId: stepId,
    status: "succeeded",
    errorMessage: undefined,
    createdAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    endedAt: terminalAt,
    updatedAt: terminalAt,
  }];
  state.approvals = [];
  state.tasks = [];
  state.terminalReports = [];
  state.terminalReportResponseDelaysMs = [1_000];

  await mockDaemon(page, state);
  await page.route(/\/control-plane\/snapshot(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        cwd,
        workspaceId: "workspace_default",
        generatedAt: "2026-08-10T00:00:00.000Z",
        latestEventSeq: 0,
        domains: {
          runs: { ok: true, revision: 0, data: { activeRuns: [], recentRuns: [], stuck: { count: 0, workUnitIds: [] }, links: {} } },
        },
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __lateTerminalReportSubscriberCount: () => number })
      .__lateTerminalReportSubscriberCount()
  )).toBe(1);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __readyLateTerminalReportControlPlane: () => void })
      .__readyLateTerminalReportControlPlane();
  });
  await openEngineeringChannel(page);

  const turn = page.locator(".conversation-turn").filter({ hasText: "Create and verify late-result.txt." });
  await expect(turn.locator(".conversation-work-cell")).toBeVisible();
  await expect(turn.locator(".terminal-report-block")).toHaveCount(0);
  await expect.poll(() => state.terminalReportQueryCount ?? 0).toBeGreaterThan(0);
  const queriesBeforePublication = state.terminalReportQueryCount ?? 0;
  const itemQueriesBeforePublication = state.channelMessageQueries?.length ?? 0;

  state.terminalReports.push({
    schemaVersion: 1,
    id: reportId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    sourceMessageId,
    source: { kind: "workflow", id: workflowId },
    status: "fallback",
    language: "en-US",
    outcome: {
      status: "succeeded",
      title: "Late terminal result rendered",
      summary: "The report arrived after workflow completion.",
      corrections: [],
      sourceRefs: [{ kind: "workflow", id: workflowId, visibility: "conversation" }],
    },
    changes: [],
    verification: [],
    participants: [{
      agentId: "engineer",
      displayName: "Engineer",
      status: "completed",
      contribution: "Created and verified late-result.txt.",
      sourceRefs: [{ kind: "workflow_step", id: stepId, visibility: "conversation" }],
    }],
    artifacts: [],
    risks: [],
    references: [],
    evidenceSnapshotId: "snapshot_late_terminal_report",
    evidenceFingerprint: "fingerprint_late_terminal_report",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: reportAt,
    committedAt: reportAt,
  });
  state.channelMessages.push({
    id: `message_${reportId}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    sourceItemId: sourceMessageId,
    body: "Late terminal result rendered\n\nThe report arrived after workflow completion.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: reportAt,
    updatedAt: reportAt,
  });

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __emitLateTerminalReportInvalidation: () => void })
      .__emitLateTerminalReportInvalidation();
  });

  await expect.poll(() => state.terminalReportQueryCount ?? 0).toBeGreaterThan(queriesBeforePublication);
  await expect.poll(() => state.channelMessageQueries?.length ?? 0).toBe(itemQueriesBeforePublication + 1);
  await expect(turn.locator(".terminal-report-block")).toContainText("Late terminal result rendered");
  await page.waitForTimeout(1_100);
  await expect(turn.locator(".terminal-report-block")).toContainText("Late terminal result rendered");
});

test("control-plane reconnect replays from the last applied cursor and refreshes the selected channel once", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    const subscribers = new Set<EventTarget>();
    const urls: string[] = [];
    class TestEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = TestEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        urls.push(this.url);
        subscribers.add(this);
      }

      close(): void {
        this.readyState = TestEventSource.CLOSED;
        subscribers.delete(this);
      }
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource });
    Object.defineProperty(globalThis, "__disconnectControlPlane", {
      configurable: true,
      value: () => {
        for (const subscriber of [...subscribers]) {
          subscriber.dispatchEvent(new Event("error"));
        }
      },
    });
    Object.defineProperty(globalThis, "__controlPlaneStreamUrls", {
      configurable: true,
      value: urls,
    });
    Object.defineProperty(globalThis, "__readyControlPlane", {
      configurable: true,
      value: (upperBoundSeq: number) => {
        const ready = new MessageEvent("control_plane_replay_ready", {
          data: JSON.stringify({
            disposition: "complete",
            requestedAfterSeq: upperBoundSeq,
            replayFloorSeq: 0,
            upperBoundSeq,
            nextAfterSeq: upperBoundSeq,
          }),
        });
        subscribers.forEach((subscriber) => subscriber.dispatchEvent(ready));
      },
    });
    const emitInvalidation = (seq: number, domain: "runs" | "work_units" | "approvals", action: string) => {
      const data = {
        seq,
        workspaceId: "workspace_default",
        cwd: "/workspace",
        ts: "2026-08-10T00:01:05.000Z",
        domain,
        entityType: domain === "runs" ? "run" : domain === "work_units" ? "work_unit" : "approval",
        entityId: `approval_resume_${domain}`,
        action,
        data: {},
      };
      subscribers.forEach((subscriber) => subscriber.dispatchEvent(
        new MessageEvent("control_plane_event", { data: JSON.stringify(data) }),
      ));
    };
    Object.defineProperty(globalThis, "__emitReconnectInvalidations", {
      configurable: true,
      value: () => {
        emitInvalidation(11, "runs", "run.approval_resume_finalized");
        emitInvalidation(12, "work_units", "work_unit.approval_resume_finalized");
        emitInvalidation(13, "approvals", "approval.resume_finalized");
      },
    });
    Object.defineProperty(globalThis, "__emitApprovalOnlyInvalidation", {
      configurable: true,
      value: () => emitInvalidation(14, "approvals", "approval.resume_blocked"),
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const controlPlaneRun = state.runs[0];
  if (!controlPlaneRun) throw new Error("Base run fixture is missing");
  state.stateTransitions.push({
    id: "transition_control_plane_cursor_10",
    workspaceId: "workspace_default",
    entityType: "run",
    entityId: controlPlaneRun.id,
    fromStatus: "queued",
    toStatus: "running",
    event: "control_plane_cursor_10_applied",
    actor: "runtime",
    createdAt: "2026-08-10T00:00:10.000Z",
  });
  await mockDaemon(page, state);
  await page.route(/\/control-plane\/snapshot(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        cwd,
        workspaceId: "workspace_default",
        generatedAt: "2026-08-10T00:00:00.000Z",
        latestEventSeq: 10,
        domains: {
          runs: { ok: true, revision: 10, data: { activeRuns: [], recentRuns: [], stuck: { count: 0, workUnitIds: [] }, links: {} } },
          work_units: { ok: true, revision: 10, data: { active: [], queued: [], stale: [], counts: {} } },
        },
      },
    });
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls.length
  )).toBe(1);
  const itemQueriesBeforeInitialReady = state.channelMessageQueries?.length ?? 0;
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __readyControlPlane: (upperBoundSeq: number) => void })
      .__readyControlPlane(10);
  });
  await expect.poll(() => state.channelMessageQueries?.length ?? 0)
    .toBeGreaterThan(itemQueriesBeforeInitialReady);
  await openChannelChatTools(page);
  await expect(page.locator(".message-bubble").filter({ hasText: "control_plane_cursor_10_applied" }))
    .toBeVisible();
  state.stateTransitions.push({
    id: "transition_control_plane_cursor_13",
    workspaceId: "workspace_default",
    entityType: "run",
    entityId: controlPlaneRun.id,
    fromStatus: "running",
    toStatus: "waiting_for_approval",
    event: "control_plane_cursor_13_applied",
    actor: "runtime",
    createdAt: "2026-08-10T00:00:13.000Z",
  });
  const itemQueriesBeforeReconnect = state.channelMessageQueries?.length ?? 0;
  const approvalPolicyQueriesBeforeReconnect = state.approvalPolicyQueryCount ?? 0;

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __disconnectControlPlane: () => void }).__disconnectControlPlane();
  });
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls.length
  ), { timeout: 5_000 }).toBe(2);
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __emitReconnectInvalidations: () => void;
      __readyControlPlane: (upperBoundSeq: number) => void;
    };
    scope.__emitReconnectInvalidations();
    scope.__readyControlPlane(13);
  });
  await expect.poll(() => state.channelMessageQueries?.length ?? 0, { timeout: 5_000 }).toBe(itemQueriesBeforeReconnect + 1);
  await expect.poll(() => state.approvalPolicyQueryCount ?? 0, { timeout: 5_000 })
    .toBe(approvalPolicyQueriesBeforeReconnect + 1);
  await expect(page.locator(".message-bubble").filter({ hasText: "control_plane_cursor_13_applied" }))
    .toBeVisible();
  const streamUrls = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls
  );
  expect(new URL(streamUrls[0] ?? "http://invalid").searchParams.get("afterSeq")).toBe("10");
  expect(new URL(streamUrls[1] ?? "http://invalid").searchParams.get("afterSeq")).toBe("10");

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __disconnectControlPlane: () => void }).__disconnectControlPlane();
  });
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls.length
  ), { timeout: 5_000 }).toBe(3);
  const finalStreamUrls = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls
  );
  expect(new URL(finalStreamUrls[2] ?? "http://invalid").searchParams.get("afterSeq")).toBe("13");

  const approvalQueriesBeforeBlocker = state.approvalQueryCount ?? 0;
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __emitApprovalOnlyInvalidation: () => void;
      __readyControlPlane: (upperBoundSeq: number) => void;
    };
    scope.__emitApprovalOnlyInvalidation();
    scope.__readyControlPlane(14);
  });
  await expect.poll(() => state.approvalQueryCount ?? 0, { timeout: 5_000 }).toBe(approvalQueriesBeforeBlocker + 1);

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __disconnectControlPlane: () => void }).__disconnectControlPlane();
  });
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls.length
  ), { timeout: 5_000 }).toBe(4);
  const blockerStreamUrls = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __controlPlaneStreamUrls: string[] }).__controlPlaneStreamUrls
  );
  expect(new URL(blockerStreamUrls[3] ?? "http://invalid").searchParams.get("afterSeq")).toBe("14");
});

test("control-plane snapshot-required subscribes before refresh and applies an event committed after S", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    const subscribers = new Set<EventTarget>();
    const urls: string[] = [];
    class TestEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = TestEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        urls.push(this.url);
        subscribers.add(this);
      }
      close(): void {
        this.readyState = TestEventSource.CLOSED;
        subscribers.delete(this);
      }
    }
    const emit = (name: string, data: unknown) => {
      const event = new MessageEvent(name, { data: JSON.stringify(data) });
      subscribers.forEach((subscriber) => subscriber.dispatchEvent(event));
    };
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource });
    Object.defineProperty(globalThis, "__snapshotHandoff", {
      configurable: true,
      value: {
        urls,
        snapshotRequired: () => emit("control_plane_snapshot_required", {
          disposition: "snapshot_required",
          requestedAfterSeq: 5,
          replayFloorSeq: 6,
          upperBoundSeq: 8,
          nextAfterSeq: 8,
          reason: "retention_gap",
        }),
        eventAfterSnapshot: () => emit("control_plane_event", {
          seq: 9,
          workspaceId: "workspace_default",
          cwd: "/workspace",
          ts: "2026-08-10T00:01:09.000Z",
          domain: "work_units",
          entityType: "terminal_report",
          entityId: "terminal_report_after_snapshot",
          action: "terminal_report.published",
          data: {},
        }),
        replayReady: () => emit("control_plane_replay_ready", {
          disposition: "complete",
          requestedAfterSeq: 8,
          replayFloorSeq: 6,
          upperBoundSeq: 8,
          nextAfterSeq: 8,
        }),
        disconnect: () => subscribers.forEach((subscriber) => subscriber.dispatchEvent(new Event("error"))),
      },
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  let snapshotSeq = 5;
  await mockDaemon(page, state);
  await page.route(/\/control-plane\/snapshot(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: {
        cwd,
        workspaceId: "workspace_default",
        generatedAt: "2026-08-10T00:00:00.000Z",
        latestEventSeq: snapshotSeq,
        domains: {
          runs: { ok: true, revision: snapshotSeq, data: { activeRuns: [], recentRuns: [], stuck: { count: 0, workUnitIds: [] }, links: {} } },
          work_units: { ok: true, revision: snapshotSeq, data: { active: [], queued: [], stale: [], counts: {} } },
        },
      },
    });
  });

  await page.goto("/");
  await openEngineeringChannel(page);
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __snapshotHandoff: { urls: string[] } }).__snapshotHandoff.urls.length
  )).toBe(1);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __snapshotHandoff: { snapshotRequired: () => void } })
      .__snapshotHandoff.snapshotRequired();
  });
  snapshotSeq = 8;
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __snapshotHandoff: { urls: string[] } }).__snapshotHandoff.urls.length
  )).toBe(2);
  const itemQueriesBeforeHandoff = state.channelMessageQueries?.length ?? 0;
  state.channelMessages.push({
    id: "msg_snapshot_handoff_seq_9",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: "Snapshot handoff seq 9 applied",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: "2026-08-10T00:01:09.000Z",
    updatedAt: "2026-08-10T00:01:09.000Z",
  });
  await page.evaluate(() => {
    const handoff = (globalThis as typeof globalThis & {
      __snapshotHandoff: { eventAfterSnapshot: () => void; replayReady: () => void };
    }).__snapshotHandoff;
    handoff.eventAfterSnapshot();
    handoff.replayReady();
  });
  await expect.poll(() => state.channelMessageQueries?.length ?? 0, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(itemQueriesBeforeHandoff + 2);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Snapshot handoff seq 9 applied")).toBeVisible();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __snapshotHandoff: { disconnect: () => void } })
      .__snapshotHandoff.disconnect();
  });
  await expect.poll(() => page.evaluate(() =>
    (globalThis as typeof globalThis & { __snapshotHandoff: { urls: string[] } }).__snapshotHandoff.urls.length
  ), { timeout: 5_000 }).toBe(3);
  const urls = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __snapshotHandoff: { urls: string[] } }).__snapshotHandoff.urls
  );
  expect(new URL(urls[0] ?? "http://invalid").searchParams.get("afterSeq")).toBe("5");
  expect(new URL(urls[1] ?? "http://invalid").searchParams.get("afterSeq")).toBe("8");
  expect(new URL(urls[2] ?? "http://invalid").searchParams.get("afterSeq")).toBe("9");
});

test("local channel work-cell demo fixture renders a realistic multi-agent operation record", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`${message.text()} @ ${message.location().url || "unknown"}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.workCellDemo", "true");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [{
    id: "message_after_work_cell_demo",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: [
      "继续检查历史会话里的文件操作。",
      "这一条测试消息让上面的产物记录成为历史内容。",
      "菜单向下展开时仍然必须覆盖后续会话行。",
      "Visual Studio Code、TextEdit 和下载入口都应该可以点击。",
      "虚拟列表不能拦截弹层的指针事件。",
      "滚动后菜单也不能改变消息流高度。",
      "完成验证后继续保留简约的会话布局。",
    ].join("\n"),
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-10T09:15:00.000Z",
    updatedAt: "2026-07-10T09:15:00.000Z",
  }];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.channelExecutionProposals = [];
  state.channelWorkflows = [];
  state.channelWorkflowSteps = [];
  state.executionActions = [];
  state.artifactsByRun = {};
  state.aiTeammates = [
    createMockTeammate({ id: "ling_agent", templateId: "ling_agent", kind: "system_teammate", systemRole: "ling_agent", roleKey: "custom", displayName: "Ling Agent", avatarTone: "violet" }),
    createMockTeammate({ id: "teammate_builtin_architect", templateId: "architect", roleKey: "architect", displayName: "Ling Architect" }),
    createMockTeammate({ id: "teammate_builtin_designer", templateId: "designer", roleKey: "designer", displayName: "Ling Designer" }),
    createMockTeammate({ id: "teammate_builtin_engineer", templateId: "engineer", roleKey: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "teammate_builtin_qa", templateId: "qa", roleKey: "qa", displayName: "Ling QA" }),
  ];

  await mockDaemon(page, state);
  await page.route(/\/artifacts\/demo_work_cell_[^/]+\/preview(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("maxBytes") !== "96000") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 304, body: "" });
  });
  await page.route(/\/workspace\/changes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 304, body: "" });
  });
  let demoRecoveryState: "applied" | "undone" = "applied";
  await page.route(/\/(?:runs|workflows)\/demo_work_cell_[^/]+\/workspace-changes(?:\/(?:undo|reapply))?(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/undo")) {
      demoRecoveryState = "undone";
    } else if (url.pathname.endsWith("/reapply")) {
      demoRecoveryState = "applied";
    }
    const recoveryId = url.pathname.split("/")[2] ?? "demo_work_cell_recovery";
    const workflowRecovery = url.pathname.startsWith("/workflows/");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: url.searchParams.get("cwd") ?? "/repo",
        ...(workflowRecovery ? { workflowId: recoveryId, runIds: ["demo_work_cell_run_engineer", "demo_work_cell_run_qa"] } : { runId: recoveryId }),
        state: demoRecoveryState,
        canUndo: demoRecoveryState === "applied",
        canReapply: demoRecoveryState === "undone",
        files: [],
        summary: {
          fileCount: 5,
          addCount: 0,
          updateCount: 5,
          deleteCount: 0,
          moveCount: 0,
          addedLines: 15,
          removedLines: 4,
        },
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
    });
  });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.route(/\/channels\/channel_engineering\/protocol(?:\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fallback();
  });
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);

  const feed = page.locator(".message-feed");
  await expect(feed).toContainText("讨论一下：多 Agent 讨论问题时");
  const discussionReplies = feed.locator(".channel-message-row.ai-teammate").filter({ hasText: /讨论阶段应该保留|普通会话行最清晰|不创建 workflow|限制可见参与人数/u });
  await expect(discussionReplies).toHaveCount(4);
  for (const name of ["Ling Architect", "Ling Designer", "Ling Engineer", "Ling QA"]) {
    const reply = discussionReplies.filter({ has: page.locator("strong", { hasText: name }) });
    await expect(reply).toHaveCount(1);
    await expect(reply.locator(".teammate-avatar-image.compact")).toHaveCount(1);
    await expect(reply).not.toContainText("已处理");
  }
  await expect(discussionReplies.locator(".conversation-work-cell")).toHaveCount(0);
  await expect(discussionReplies.locator(".terminal-report-block")).toHaveCount(0);
  const demoTurn = feed.locator(".conversation-turn").filter({ hasText: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去" });
  await expect(demoTurn).toHaveCount(1);
  const sourceMessage = demoTurn.locator(".channel-message-row.local-user");
  await expect(sourceMessage).toHaveCount(1);
  const sourceMessageSpacing = await sourceMessage.evaluate((element) => {
    const paragraph = element.querySelector<HTMLElement>(".message-body-paragraph");
    const avatar = element.querySelector<HTMLElement>(":scope > .user-profile-avatar, :scope > .avatar-initial");
    const shell = element.querySelector<HTMLElement>(".message-body-shell");
    if (!paragraph || !avatar || !shell) {
      return null;
    }
    return {
      textToAvatar: Math.round(avatar.getBoundingClientRect().left - paragraph.getBoundingClientRect().right),
      paragraphPaddingRight: getComputedStyle(paragraph).paddingRight,
      shellPaddingRight: getComputedStyle(shell).paddingRight,
    };
  });
  expect(sourceMessageSpacing).not.toBeNull();
  expect(sourceMessageSpacing?.textToAvatar).toBeLessThanOrEqual(24);
  expect(sourceMessageSpacing?.paragraphPaddingRight).toBe("0px");
  expect(sourceMessageSpacing?.shellPaddingRight).toBe("0px");
  const assistantTranscript = demoTurn.locator(".conversation-turn-assistant-row");
  await expect(assistantTranscript.locator(":scope > .teammate-avatar-image-default")).toHaveAttribute(
    "src",
    /^(?:\.\/|\/)avatars\/teammates\/ling-agent\.png$/u,
  );
  await expect(assistantTranscript.locator(":scope > .avatar-initial")).toHaveCount(0);
  const workCell = assistantTranscript.locator(".conversation-work-cell").first();
  await expect(workCell).toBeVisible();
  const operationWidth = await assistantTranscript.locator(".conversation-turn-operation").evaluate((element) => Math.round(element.getBoundingClientRect().width));
  expect(operationWidth).toBeGreaterThan(680);
  await expect.poll(async () => Math.round((await workCell.boundingBox())?.width ?? 0)).toBe(operationWidth);
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expect(workCell.locator(".conversation-operation-shell-head")).toHaveAttribute("aria-expanded", "false");
  await expect(workCell.locator(".terminal-report-block")).toHaveCount(0);
  const terminalReport = assistantTranscript.locator(".terminal-report-block");
  await expect(terminalReport).toBeVisible();
  await expect.poll(() => terminalReport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(terminalReport).toContainText("多 Agent 操作记录已接入频道会话");
  await expect(terminalReport).toContainText("Architect");
  await expect(terminalReport).toContainText("Designer");
  await expect(terminalReport).toContainText("Engineer");
  await expect(terminalReport).toContainText("QA");
  await expect(terminalReport.locator(".terminal-report-participants .terminal-report-participant-avatar .teammate-avatar-image-default")).toHaveCount(4);
  await expect(workCell).not.toContainText("正在思考");
  await expect(workCell).not.toContainText("Ling runtime");
  const terminalSummary = assistantTranscript.locator(".conversation-turn-assistant-copy.terminal");
  await expect(terminalSummary).toHaveCount(0);
  await expect(assistantTranscript).not.toContainText("完成：「频道 work-cell 操作记录样例」");
  const terminalReportSummary = terminalReport.locator(".terminal-report-summary");
  await expect(terminalReportSummary).not.toHaveAttribute("aria-expanded");
  await expect(terminalReport.locator(".terminal-report-toggle")).toHaveCount(0);
  await expect(terminalReport).toContainText("重构操作记录展示");
  await expect(terminalReport).toContainText("Web typecheck");
  await expect(terminalReport).toContainText("确认 workflow、run、action 和 artifact 的会话投影边界");
  await expect(terminalReport.getByRole("button", { name: "ConversationWorkCell.tsx", exact: true })).toBeVisible();
  await expect(terminalReport.getByRole("button", { name: "components.css", exact: true })).toBeVisible();
  await expect(terminalReport.getByRole("button", { name: "conversation-work-cell-operation-records.md", exact: true })).toBeVisible();
  await expect(terminalReport.locator('.terminal-report-file-type-icon[data-file-kind="react"]')).toBeVisible();
  await expect(terminalReport.locator('.terminal-report-file-type-icon[data-file-kind="css"]')).toBeVisible();
  await expect(terminalReport.locator('.terminal-report-file-type-icon[data-file-kind="markdown"]')).toBeVisible();
  await expect(terminalReport.locator(".terminal-report-participant-copy > strong").first()).toHaveCSS("color", "rgb(29, 78, 216)");
  const teamSummary = assistantTranscript.locator(".channel-team-experts-summary");
  await expect(teamSummary).toHaveCount(0);
  const transcriptArtifacts = assistantTranscript.locator(".conversation-turn-artifacts");
  await expect(transcriptArtifacts).toHaveCount(0);
  const reportChangedFiles = terminalReport.locator(".terminal-report-section.kind-change .terminal-report-file-reference");
  await expect(reportChangedFiles).toHaveCount(3);
  await expect(reportChangedFiles.nth(0)).toContainText("ConversationWorkCell.tsx");
  await expect(reportChangedFiles.nth(1)).toContainText("components.css");
  await expect(reportChangedFiles.nth(2)).toContainText("conversation-work-cell-operation-records.md");
  await expect.poll(() =>
    assistantTranscript.locator(".conversation-turn-assistant-transcript").evaluate((element) => {
      const childClasses = Array.from(element.children).map((child) => child.className.toString());
      const operationIndex = childClasses.findIndex((className) => className.includes("conversation-turn-operation"));
      const reportIndex = childClasses.findIndex((className) => className.includes("terminal-report-block"));
      const artifactsIndex = childClasses.findIndex((className) => className.includes("conversation-turn-artifacts"));
      const actionsIndex = childClasses.findIndex((className) => className.includes("channel-message-row-footer-stack"));
      return {
        operationBeforeReport: operationIndex >= 0 && reportIndex > operationIndex,
        noDuplicateArtifacts: artifactsIndex === -1,
        actionsAreLast: actionsIndex === childClasses.length - 1,
      };
    }),
  ).toEqual({
    operationBeforeReport: true,
    noDuplicateArtifacts: true,
    actionsAreLast: true,
  });

  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(4);
  await expect(workCell.locator(".conversation-work-cell-artifact-row")).toHaveCount(0);
  const workCellReferences = workCell.locator(".conversation-work-cell-evidence-summary");
  await expect(workCellReferences).toContainText("引用");
  await expect(workCellReferences).not.toContainText("变更");
  await expect(workCellReferences).not.toContainText("检查");
  await workCellReferences.click();
  await expect(workCell.locator(".conversation-work-cell-group")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-evidence-links > *")).not.toHaveCount(0);
  await workCellReferences.click();
  await expect(workCell).toContainText("Architect");
  await expect(workCell).toContainText("Designer");
  await expect(workCell).toContainText("Engineer");
  await expect(workCell).toContainText("QA");
  await expect(workCell.locator(".conversation-work-cell-agent-span-copy small")).toHaveCount(0);

  const engineerSpan = workCell.locator('.conversation-work-cell-agent-span[data-agent-participant-id="engineer"]');
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-copy strong")).toHaveCSS("color", "rgb(29, 78, 216)");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(0);
  await expect(engineerSpan.locator("button.conversation-work-cell-agent-span-head")).toHaveCount(0);
  const engineerDetail = engineerSpan.locator(".conversation-work-cell-agent-span-detail");
  await expect(engineerDetail).toHaveCSS("padding-left", "0px");
  await expect(engineerDetail).toContainText("完成频道 work-cell 操作记录投影");
  await expect(engineerDetail).toContainText("主要任务已完成");
  await expect(engineerDetail).toContainText("先把 agent 内部工作流拆成可扫描的步骤");
  await expect(engineerDetail).toContainText("然后收紧视觉噪音");
  await expect(engineerDetail).toContainText("改完后先跑类型检查");
  await expect(engineerDetail).toContainText("已编辑 ConversationWorkCell.tsx");
  await expect(engineerDetail).toContainText("已编辑 conversation-work-cell-operation-records.md");
  await expect(engineerDetail).toContainText("已运行命令");
  await expect(engineerDetail.locator(".conversation-work-cell-shell-card")).toHaveCount(0);
  const engineerStepNoteRow = engineerDetail.locator(".conversation-work-cell-row.note").filter({ hasText: "完成频道 work-cell 操作记录投影" });
  await expect(engineerStepNoteRow).toHaveCount(1);
  await expect(engineerStepNoteRow.locator(".conversation-work-cell-row-icon")).toHaveCount(0);
  const engineerNoteRow = engineerDetail.locator(".conversation-work-cell-row.note").filter({ hasText: "先把 agent 内部工作流拆成可扫描的步骤" });
  await expect(engineerNoteRow).toHaveCount(1);
  await expect(engineerNoteRow.locator(".conversation-work-cell-row-icon")).toHaveCount(0);
  await expect(engineerNoteRow.locator(".conversation-work-cell-row-toggle")).toHaveCount(0);
  await expect(engineerNoteRow.locator(".conversation-work-cell-row-main")).toHaveCSS("padding-left", "0px");
  const thoughtColor = await engineerNoteRow.locator(".conversation-work-cell-row-copy strong").evaluate((element) => getComputedStyle(element).color);
  const conversationColor = await terminalReport.locator(".terminal-report-rich-copy").evaluate((element) => getComputedStyle(element).color);
  expect(thoughtColor).toBe(conversationColor);
  await expect(engineerNoteRow.locator(".conversation-work-cell-row-copy strong")).toHaveCSS("font-size", "13px");
  await expect(engineerNoteRow.locator(".conversation-work-cell-row-copy strong")).toHaveCSS("font-weight", "550");
  const editActionRow = engineerDetail.locator(".conversation-work-cell-row").filter({ hasText: "已编辑 ConversationWorkCell.tsx" });
  await expect(editActionRow.locator(".conversation-work-cell-row-copy strong")).toHaveCSS("font-size", "12px");
  await expect(editActionRow.locator(".conversation-work-cell-row-copy strong")).toHaveCSS("font-weight", "400");
  await expect(editActionRow.locator(".conversation-work-cell-change-stat .add")).toHaveText("+4");
  await expect(editActionRow.locator(".conversation-work-cell-change-stat .delete")).toHaveText("-1");
  const editIconColor = await editActionRow.locator(".conversation-work-cell-row-icon").evaluate((element) => getComputedStyle(element).color);
  const editTitleColor = await editActionRow.locator(".conversation-work-cell-row-copy strong").evaluate((element) => getComputedStyle(element).color);
  expect(editIconColor).toBe(editTitleColor);
  await editActionRow.locator(".conversation-work-cell-row-main").hover();
  const editHoverIconColor = await editActionRow.locator(".conversation-work-cell-row-icon").evaluate((element) => getComputedStyle(element).color);
  const editHoverTitleColor = await editActionRow.locator(".conversation-work-cell-row-copy strong").evaluate((element) => getComputedStyle(element).color);
  expect(editHoverIconColor).toBe(editHoverTitleColor);
  expect(editHoverIconColor).not.toBe(editIconColor);
  await editActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toHaveCSS("padding-left", "0px");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Engineer 修改 work-cell 行展示");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("接入 agent 操作记录行");
  await expect(editActionRow.locator(".conversation-work-cell-change-preview")).toBeVisible();
  await expect(editActionRow.locator(".conversation-work-cell-change-preview .diff-line.add")).toHaveCount(4);
  await expect(editActionRow.locator(".conversation-work-cell-change-preview .diff-line.delete")).toHaveCount(1);
  await expect(editActionRow.locator(".conversation-work-cell-change-preview .diff-line.context")).toHaveCount(6);
  await expect(editActionRow.locator(".conversation-work-cell-change-preview .diff-fold")).toHaveCount(0);
  await expect(editActionRow.locator(".conversation-work-cell-change-preview")).toContainText("const operationRows = visibleOperationRows(model);");

  const commandRow = engineerDetail.locator(".conversation-work-cell-row.shell").filter({ hasText: "已运行命令" }).first();
  const commandRowMain = commandRow.locator(".conversation-work-cell-row-main");
  const commandRowToggle = commandRow.locator(".conversation-work-cell-row-toggle");
  await page.mouse.move(0, 0);
  await expect(commandRowToggle).toHaveCSS("opacity", "0");
  await commandRowMain.hover();
  await expect(commandRowToggle).toHaveCSS("opacity", "1");
  await commandRowMain.click();
  await expect(commandRowToggle).toHaveCSS("opacity", "1");
  await expect(commandRow.locator(".conversation-work-cell-row-detail")).not.toContainText("运行 Web typecheck");
  await expect(commandRow.locator(".conversation-work-cell-row-detail")).toContainText("$ corepack pnpm --filter @ling-stack/web typecheck");

  const commandBatch = engineerDetail.locator(".conversation-command-batch");
  await expect(commandBatch).toHaveCount(1);
  await expect(commandBatch.locator(".conversation-command-batch-header")).toContainText("已运行 3 个命令");
  await expect(commandBatch).toHaveClass(/collapsed/u);
  await expect(commandBatch.locator(".conversation-command-batch-list")).toHaveCount(0);
  await commandBatch.locator(".conversation-command-batch-header").click();
  await expect(commandBatch).toHaveClass(/expanded/u);
  await expect(commandBatch.locator(".conversation-command-batch-list .conversation-work-cell-row")).toHaveCount(3);
  await expect(commandBatch).toContainText("corepack pnpm --filter @ling-stack/web typecheck");
  await expect(commandBatch).toContainText("corepack pnpm --filter @ling-stack/web check:i18n");
  await expect(commandBatch).toContainText("git diff --check");
  const firstBatchedCommand = commandBatch.locator(".conversation-work-cell-row").first();
  await expect(firstBatchedCommand).toContainText("exit 0");
  await firstBatchedCommand.locator(".conversation-work-cell-row-main").click();
  await expect(firstBatchedCommand.locator(".conversation-work-cell-row-detail")).toContainText("Completed successfully.");

  const docEditActionRow = engineerDetail.locator(".conversation-work-cell-row").filter({ hasText: "已编辑 conversation-work-cell-operation-records.md" });
  await expect(docEditActionRow.locator(".conversation-work-cell-change-stat .add")).toHaveText("+3");
  await expect(docEditActionRow.locator(".conversation-work-cell-change-stat .delete")).toHaveText("-2");
  await docEditActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(docEditActionRow.locator(".conversation-work-cell-change-preview")).toBeVisible();
  await expect(docEditActionRow.locator(".conversation-work-cell-change-preview .diff-line.add")).toHaveCount(3);
  await expect(docEditActionRow.locator(".conversation-work-cell-change-preview .diff-line.delete")).toHaveCount(2);

  const qaSpan = workCell.locator('.conversation-work-cell-agent-span[data-agent-participant-id="qa"]');
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-head")).not.toContainText("$ corepack pnpm");
  const qaDetail = qaSpan.locator(".conversation-work-cell-agent-span-detail");
  await expect(qaDetail).toContainText("通过频道工作记录样例回归");
  const qaCommandRow = qaDetail.locator(".conversation-work-cell-row.shell").filter({ hasText: "已运行命令" });
  await qaCommandRow.locator(".conversation-work-cell-row-main").click();
  await expect(qaCommandRow.locator(".conversation-work-cell-row-detail")).not.toContainText("运行频道 work-cell 回归");
  const qaCommand = qaCommandRow.locator(".conversation-work-cell-shell-command");
  await expect(qaCommand).toHaveText('$ corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts -g "work cell"');
  await expect(qaCommand).toHaveCSS("text-overflow", "clip");
  await expect(qaCommand).toHaveCSS("white-space", "pre-wrap");
  const qaCommandLayout = await qaCommand.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      contentHeight: element.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
      lineHeight: Number.parseFloat(style.lineHeight),
      overflowsHorizontally: element.scrollWidth > element.clientWidth,
    };
  });
  expect(qaCommandLayout.overflowsHorizontally).toBe(false);
  expect(qaCommandLayout.contentHeight).toBeGreaterThan(qaCommandLayout.lineHeight * 1.5);

  expect(runtimeErrors).toEqual([]);
});

test("durable Ling thread runs render as collapsed conversation work cells", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const compareBeforeImageUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23f5f5f5'/%3E%3Ctext x='160' y='92' text-anchor='middle' font-size='18'%3EBefore%3C/text%3E%3C/svg%3E";
  const compareAfterImageUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e8f4ff'/%3E%3Ctext x='160' y='92' text-anchor='middle' font-size='18'%3EAfter%3C/text%3E%3C/svg%3E";
  const run = state.runs[0];
  run.threadId = "thread_inspect";
  run.status = "succeeded";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-25T00:20:00.000Z";
  run.endedAt = "2026-05-25T00:22:00.000Z";
  run.updatedAt = "2026-05-25T00:22:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect" ? { ...task, status: "done", updatedAt: run.updatedAt } : task);
  state.approvals = [];
  state.artifactsByRun[run.id] = [
    {
      id: "artifact_thread_diff",
      runId: run.id,
      type: "diff",
      path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      title: "WorkspaceClientView.tsx",
      contentType: "text/x-diff; charset=utf-8",
      sizeBytes: 512,
      createdAt: "2026-05-25T00:21:00.000Z",
    },
    {
      id: "artifact_thread_screenshot",
      runId: run.id,
      type: "image",
      path: "screenshots/channel-transcript.png",
      title: "channel-transcript.png",
      contentType: "image/png",
      sizeBytes: 4096,
      compareBeforeImageUrl,
      compareAfterImageUrl,
      compareBeforeLabel: "Previous screenshot",
      compareAfterLabel: "Current screenshot",
      createdAt: "2026-05-25T00:21:05.000Z",
    },
    {
      id: "artifact_thread_context",
      runId: run.id,
      type: "json",
      path: "run_failed/context.json",
      title: "Context Pack",
      contentType: "application/json",
      sizeBytes: 1024,
      createdAt: "2026-05-25T00:21:10.000Z",
    },
    {
      id: "artifact_thread_output",
      runId: run.id,
      type: "json",
      path: "run_failed/output.json",
      title: "output.json",
      contentType: "application/json",
      sizeBytes: 1024,
      createdAt: "2026-05-25T00:21:11.000Z",
    },
    {
      id: "artifact_thread_log",
      runId: run.id,
      type: "log",
      path: ".ling-stack/sessions/run_failed.jsonl",
      title: ".ling-stack/sessions/run_failed.jsonl",
      contentType: "application/jsonl",
      sizeBytes: 2048,
      createdAt: "2026-05-25T00:21:12.000Z",
    },
  ];
  state.approvals = [
    {
      id: "approval_thread_checkpoint",
      runId: run.id,
      taskId: run.taskId,
      channelId: "channel_engineering",
      actionType: "bash",
      risk: "medium",
      title: "Approve typecheck",
      description: "pnpm typecheck",
      payload: { type: "bash", command: "pnpm typecheck", hidden: "raw_thread_resume_payload" },
      status: "approved",
      createdAt: "2026-05-25T00:20:10.000Z",
      resolvedAt: "2026-05-25T00:20:15.000Z",
      resolvedBy: "local-user",
    },
  ];
  state.approvalCheckpoints = [
    {
      id: "checkpoint_thread_resume",
      approvalId: "approval_thread_checkpoint",
      runId: run.id,
      taskId: run.taskId,
      channelId: "channel_engineering",
      actionType: "bash",
      risk: "medium",
      title: "Approve typecheck",
      description: "pnpm typecheck",
      status: "resumed",
      sideEffect: { type: "bash", command: "pnpm typecheck", hidden: "raw_thread_resume_payload" },
      previewArtifactIds: [],
      resultArtifactIds: [],
      runnerResumeHandle: {
        kind: "ling_continuation",
        runId: run.id,
        handleRef: "runner_handle_thread_secret",
        verified: true,
        payload: { hidden: "raw_thread_resume_payload" },
      },
      createdAt: "2026-05-25T00:20:10.000Z",
      updatedAt: "2026-05-25T00:21:00.000Z",
      resolvedAt: "2026-05-25T00:20:15.000Z",
      resumedAt: "2026-05-25T00:20:20.000Z",
    },
  ];
  state.executionActions = [
    {
      id: "execution_action_thread_ui",
      workspaceId: "workspace_default",
      threadId: "thread_inspect",
      runId: run.id,
      actionType: "edit",
      risk: "medium",
      status: "succeeded",
      title: "Render conversation work cell",
      summary: "Conversation work cell was rendered from thread-backed run data.",
      targetRefs: [{ type: "file", path: "apps/web/src/features/workspace/WorkspaceClientView.tsx" }],
      previewArtifactIds: [],
      resultArtifactIds: ["artifact_thread_diff"],
      createdAt: "2026-05-25T00:20:30.000Z",
      updatedAt: "2026-05-25T00:22:00.000Z",
      executedAt: "2026-05-25T00:21:30.000Z",
    },
    {
      id: "execution_action_thread_check",
      workspaceId: "workspace_default",
      threadId: "thread_inspect",
      runId: run.id,
      actionType: "bash",
      risk: "medium",
      status: "succeeded",
      title: "Run typecheck",
      summary: "Validate the workspace client rendering.",
      targetRefs: [{ type: "command", label: "pnpm typecheck" }],
      previewArtifactIds: [],
      resultArtifactIds: [],
      createdAt: "2026-05-25T00:21:35.000Z",
      updatedAt: "2026-05-25T00:21:50.000Z",
      executedAt: "2026-05-25T00:21:35.000Z",
      completedAt: "2026-05-25T00:21:50.000Z",
    },
  ];
  state.turns = [
    {
      id: "turn_thread_inspect",
      workspaceId: "workspace_default",
      threadId: "thread_inspect",
      kind: "initial_request",
      status: "succeeded",
      title: "Inspect workspace",
      userInstruction: "Inspect the workspace and summarize the result.",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      activeRunId: undefined,
      lastRunId: run.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T00:20:00.000Z",
      updatedAt: "2026-05-25T00:22:00.000Z",
      completedAt: "2026-05-25T00:22:00.000Z",
    },
  ];
  state.turnRunLinks = [
    {
      turnId: "turn_thread_inspect",
      runId: run.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: "2026-05-25T00:20:00.000Z",
    },
  ];
  const threadEvidenceRequests: string[] = [];
  const traceListRequests: string[] = [];
  const traceDetailRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/threads/thread_inspect/evidence")) {
      threadEvidenceRequests.push(request.url());
    }
    if (request.url().includes("/traces?") && request.url().includes("threadId=thread_inspect")) {
      traceListRequests.push(request.url());
    }
    if (request.url().includes("/traces/trace_thread_thread_inspect")) {
      traceDetailRequests.push(request.url());
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const workCell = page.getByLabel("Channel message feed").locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "run_thread");
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).not.toContainText("Task completed");
  await expect(workCell).not.toContainText("Completed: Inspect workspace.");
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toContainText("1 artifact");
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toContainText("Edited 1 file");
  const artifactStrip = workCell.getByLabel("Artifacts");
  await expect(artifactStrip.locator(".conversation-work-cell-artifact-row")).toHaveCount(1);
  await expect(artifactStrip.locator(".conversation-work-cell-artifact-row").filter({ hasText: "WorkspaceClientView.tsx" })).toHaveCount(0);
  await expect(artifactStrip).toContainText("channel-transcript.png");
  await expect(workCell.getByRole("button", { name: /Preview: channel-transcript\.png/ })).toBeVisible();
  await expect(workCell.locator(".conversation-work-cell-artifact-thumb img")).toHaveCount(1);
  const changedSummary = artifactStrip.locator(".conversation-work-cell-change-summary");
  await expect(changedSummary.locator(":scope > svg")).toHaveCount(0);
  await expect(changedSummary).not.toHaveAttribute("aria-expanded");
  await expect(artifactStrip.locator(".conversation-work-cell-change-file")).toContainText("WorkspaceClientView.tsx");
  const defaultOperationStream = workCell.locator(".conversation-work-cell-active-stream");
  await expect(defaultOperationStream).toContainText("Edited WorkspaceClientView.tsx");
  await expect(defaultOperationStream).toContainText("Ran command");
  const defaultCommandActionRow = defaultOperationStream.locator(".conversation-work-cell-row.shell").filter({ hasText: "Ran command" });
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-shell-card")).toHaveCount(0);
  await defaultCommandActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Run typecheck");
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm typecheck");
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Validate the workspace client rendering.");
  await expect(workCell.locator(".conversation-work-cell-group")).toHaveCount(0);
  await expect(workCell).not.toContainText(".ling-stack/sessions/run_failed.jsonl");
  await expect(workCell).not.toContainText("Context Pack");
  await expect(workCell).not.toContainText("context.json");
  await expect(workCell).not.toContainText("output.json");
  expect(threadEvidenceRequests).toHaveLength(0);
  expect(traceListRequests).toHaveLength(0);
  expect(traceDetailRequests).toHaveLength(0);

  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toHaveAttribute("aria-expanded", "false");
  const workBlock = page.locator("[data-conversation-focus-block='true']:has(.conversation-work-cell)").first();
  await workBlock.focus();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-conversation-focus-block") ?? "")).toBe("true");
  await page.keyboard.press("Enter");
  await expect(workCell.getByLabel("Changed")).toContainText("WorkspaceClientView.tsx");
  await expect(workCell.getByLabel("Checks")).toContainText("Inspect workspace");
  await expect(workCell.getByLabel("Checks")).not.toContainText("succeeded");
  const evidenceRegion = workCell.getByRole("region", { name: "Evidence" });
  await expect(evidenceRegion).toContainText("WorkspaceClientView.tsx");
  await expect(evidenceRegion).toContainText("Edited WorkspaceClientView.tsx");
  await expect(evidenceRegion).toContainText("Ran command");
  await expect(evidenceRegion).toContainText("Trace: Agent run");
  await expect(evidenceRegion).toContainText("Trace: Tool call");
  await expect(evidenceRegion).not.toContainText("Approval checkpoint: Approve typecheck");
  await expect(evidenceRegion).not.toContainText("Approve typecheck");
  await expect(evidenceRegion).not.toContainText("artifact_thread_diff");
  await expect(evidenceRegion).not.toContainText("trace_thread_thread_inspect");
  await expect(evidenceRegion).not.toContainText("span_trace_thread_thread_inspect");
  await expect(evidenceRegion).not.toContainText("checkpoint_thread_resume");
  await expect(evidenceRegion).not.toContainText("approval_thread_checkpoint");
  await expect(evidenceRegion).not.toContainText("run_failed");
  const editActionRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Edited WorkspaceClientView.tsx" });
  await editActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Render conversation work cell");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("1 output recorded");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("artifact_thread_diff");
  const commandActionRow = evidenceRegion.locator(".conversation-work-cell-row.shell").filter({ hasText: "Ran command" });
  await expect(commandActionRow.locator(".conversation-work-cell-shell-card")).toHaveCount(0);
  await commandActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(commandActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("Run typecheck");
  await expect(commandActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm typecheck");
  const traceToolRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Trace: Tool call" }).first();
  await traceToolRow.locator(".conversation-work-cell-row-main").click();
  await expect(traceToolRow.locator(".conversation-work-cell-row-detail")).toContainText("Tool namespace: core");
  await expect(traceToolRow.locator(".conversation-work-cell-row-detail")).toContainText("Tool materialization: recorded");
  await maybeCaptureR32Screenshot(page, "thread-action-details-expanded");
  await expect(workCell.locator(".conversation-work-cell-group.attention")).toHaveCount(0);
  await expect(workCell).not.toContainText("No items recorded");
  await expect(workCell).not.toContainText(".ling-stack/sessions/run_failed.jsonl");
  await expect(workCell).not.toContainText("Context Pack");
  await expect(workCell).not.toContainText("context.json");
  await expect(workCell).not.toContainText("output.json");
  await expect(workCell).not.toContainText("provider_local");
  await expect(workCell).not.toContainText("tokens");
  const screenshotPreviewButton = workCell.getByRole("button", { name: /Preview: channel-transcript\.png/ });
  await screenshotPreviewButton.click();
  const compactPreview = page.locator(".conversation-artifact-hover-preview");
  await expect(compactPreview).toBeVisible();
  await expect(compactPreview).toContainText("channel-transcript.png");
  await expect(compactPreview.locator(".conversation-artifact-hover-preview-image")).toHaveAttribute("src", /\/artifacts\/artifact_thread_screenshot\/content/);
  await expect(page.locator(".artifact-preview-lightbox")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(compactPreview).toHaveCount(0);
  await expect(workCell).not.toContainText("Run typecheck");
  expect(threadEvidenceRequests).toHaveLength(1);
  expect(traceListRequests).toHaveLength(1);
  expect(traceDetailRequests).toHaveLength(1);

  await workCell.locator(".conversation-work-cell-evidence-summary").click();
  await workCell.locator(".conversation-work-cell-evidence-summary").click();
  await expect(workCell.getByLabel("Changed")).toContainText("WorkspaceClientView.tsx");
  expect(threadEvidenceRequests).toHaveLength(1);
  expect(traceListRequests).toHaveLength(1);
  expect(traceDetailRequests).toHaveLength(1);

  await expect(workCell.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
});

test("durable Ling turns drive conversation work cell title, status, and attempts", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const firstAttempt = {
    ...state.runs[0],
    threadId: "thread_durable_turn",
    status: "failed",
    startedAt: "2026-05-25T00:10:00.000Z",
    endedAt: "2026-05-25T00:11:00.000Z",
    updatedAt: "2026-05-25T00:11:00.000Z",
    errorMessage: "First attempt failed before retry.",
  };
  const secondAttempt = {
    ...firstAttempt,
    id: "run_durable_retry",
    status: "succeeded",
    errorMessage: undefined,
    eventLogPath: ".ling-stack/sessions/run_durable_retry.jsonl",
    createdAt: "2026-05-25T00:12:00.000Z",
    startedAt: "2026-05-25T00:12:30.000Z",
    endedAt: "2026-05-25T00:14:00.000Z",
    updatedAt: "2026-05-25T00:14:00.000Z",
  };
  state.runs = [secondAttempt, firstAttempt];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "done", currentRunId: secondAttempt.id, updatedAt: secondAttempt.updatedAt }
    : task);
  state.turns = [
    {
      id: "turn_durable_inspect",
      workspaceId: "workspace_default",
      threadId: "thread_durable_turn",
      kind: "initial_request",
      status: "succeeded",
      title: "Durable inspect turn",
      userInstruction: "Inspect the repo and report next steps.",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      activeRunId: undefined,
      lastRunId: secondAttempt.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T00:10:00.000Z",
      updatedAt: "2026-05-25T00:14:00.000Z",
      completedAt: "2026-05-25T00:14:00.000Z",
    },
  ];
  state.turnRunLinks = [
    {
      turnId: "turn_durable_inspect",
      runId: firstAttempt.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: "2026-05-25T00:10:00.000Z",
    },
    {
      turnId: "turn_durable_inspect",
      runId: secondAttempt.id,
      attemptNumber: 2,
      role: "retry",
      createdAt: "2026-05-25T00:12:00.000Z",
    },
  ];
  state.artifactsByRun[secondAttempt.id] = [
    {
      id: "artifact_durable_retry_diff",
      runId: secondAttempt.id,
      type: "diff",
      path: "packages/core/src/storage/sqlite-run-store.ts",
      title: "sqlite-run-store.ts",
      contentType: "text/x-diff; charset=utf-8",
      sizeBytes: 1024,
      createdAt: "2026-05-25T00:13:00.000Z",
    },
  ];
  state.artifactsByRun[firstAttempt.id] = [
    {
      id: "artifact_durable_old_attempt",
      runId: firstAttempt.id,
      type: "file",
      path: "old-attempt.txt",
      title: "old-attempt.txt",
      contentType: "text/plain",
      createdAt: "2026-05-25T00:10:30.000Z",
    },
  ];
  state.executionActions = [
    mockRetryCommandAction("durable_old_attempt", "thread_durable_turn", firstAttempt.id, "echo old attempt evidence", "2026-05-25T00:10:30.000Z", 7),
    mockRetryCommandAction("durable_retry_command", "thread_durable_turn", secondAttempt.id, "node retry-once.cjs", "2026-05-25T00:13:00.000Z", 0),
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(1);
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "run_thread");
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).not.toContainText("Task completed");
  await expect(workCell).not.toContainText("Completed: Durable inspect turn.");
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);

  await workCell.locator(".conversation-work-cell-evidence-summary").click();
  await expect(workCell.getByLabel("Checks")).toContainText("Inspect workspace");
  await expect(workCell.getByLabel("Checks")).not.toContainText("succeeded");
  await expect(workCell.getByLabel("Checks")).not.toContainText("failed");
  await expect(workCell).not.toContainText("First attempt failed before retry.");
  await expect(workCell).toContainText("Earlier tries");
  await workCell.locator(".conversation-work-cell-row.command-execution .conversation-work-cell-row-main").first().click();
  await expect(workCell).toContainText("node retry-once.cjs");
  await expect(workCell).not.toContainText("echo old attempt evidence");
  await expect(workCell).not.toContainText("old-attempt.txt");
  await expect(workCell.getByRole("region", { name: "Evidence" })).toContainText("sqlite-run-store.ts");
});

test("conversation work cell is hidden when Ling turn loading fails", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.threadId = "thread_turn_failure";
  run.status = "succeeded";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-25T00:20:00.000Z";
  run.endedAt = "2026-05-25T00:22:00.000Z";
  run.updatedAt = "2026-05-25T00:22:00.000Z";
  state.failThreadTurnsForThreadIds = ["thread_turn_failure"];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const workCell = page.getByLabel("Channel message feed").locator(".conversation-work-cell");
  await expect(workCell).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).not.toContainText("Inspect workspace");
});

test("failed conversation work cell does not label terminal rows as working", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.threadId = "thread_failed_run";
  run.status = "failed";
  run.errorMessage = "Command exited with code 1.";
  run.startedAt = "2026-05-25T00:20:00.000Z";
  run.endedAt = "2026-05-25T00:22:00.000Z";
  run.updatedAt = "2026-05-25T00:22:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "failed", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  state.turns = [
    {
      id: "turn_failed_run",
      workspaceId: "workspace_default",
      threadId: "thread_failed_run",
      kind: "initial_request",
      status: "failed",
      title: "Inspect workspace",
      userInstruction: "Inspect the repo and report next steps.",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      activeRunId: undefined,
      lastRunId: run.id,
      createdByActor: "local-user",
      createdAt: "2026-05-25T00:20:00.000Z",
      updatedAt: "2026-05-25T00:22:00.000Z",
      completedAt: "2026-05-25T00:22:00.000Z",
    },
  ];
  state.turnRunLinks = [
    {
      turnId: "turn_failed_run",
      runId: run.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: "2026-05-25T00:20:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const workCell = page.getByLabel("Channel message feed").locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).not.toContainText("Failed: Command exited with code 1.");
  await expect(workCell.getByLabel("Active work stream")).toContainText("Could not finish Inspect workspace");
  await workCell.getByLabel("Active work stream").locator(".conversation-work-cell-row-main").filter({ hasText: "Could not finish Inspect workspace" }).click();
  await expect(workCell.getByLabel("Active work stream")).toContainText("Command exited with code 1.");
  await expect(workCell.getByLabel("Active work stream")).toContainText("Failed");
  await expect(workCell.getByLabel("Active work stream")).not.toContainText("Working");
});

test("active conversation work cell stays sparse while runtime approval replaces its composer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable.",
      checkedAt: "2026-05-22T00:00:00.000Z",
    },
  })];
  const run = state.runs[0];
  run.threadId = "thread_active_approval";
  run.status = "waiting_for_approval";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-22T00:00:30.000Z";
  run.updatedAt = "2026-05-22T00:01:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  state.turns = [
    {
      id: "turn_active_approval",
      workspaceId: "workspace_default",
      threadId: "thread_active_approval",
      kind: "initial_request",
      status: "waiting_for_approval",
      title: "Inspect workspace",
      userInstruction: "Inspect the repo and report next steps.",
      channelId: "channel_engineering",
      taskId: "task_inspect",
      activeRunId: run.id,
      lastRunId: undefined,
      createdByActor: "local-user",
      createdAt: "2026-05-22T00:00:30.000Z",
      updatedAt: "2026-05-22T00:01:00.000Z",
    },
  ];
  state.turnRunLinks = [
    {
      turnId: "turn_active_approval",
      runId: run.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: "2026-05-22T00:00:30.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-operation-source", "run_thread");
  await expect(workCell).toHaveAttribute("data-approval-presentation-owner", "composer_gate");
  await expect(workCell).not.toContainText("Task waiting for approval");
  await expect(workCell).not.toContainText("Waiting for approval to continue.");
  await expect(workCell).toContainText("Waiting for approval");
  await expect(workCell).toContainText("Run command: echo inspect");
  await expect(workCell).not.toContainText("Approve shell command");
  await expect(workCell.locator(".conversation-operation-shell-body")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
  const pendingShellBox = await workCell.locator(".conversation-operation-shell").boundingBox();
  const pendingMarkerBox = await workCell.locator(".conversation-composer-gate-approval-marker").boundingBox();
  expect((pendingMarkerBox?.x ?? 0) - (pendingShellBox?.x ?? 0)).toBeGreaterThanOrEqual(11);
  expect(
    ((pendingShellBox?.x ?? 0) + (pendingShellBox?.width ?? 0)) -
      ((pendingMarkerBox?.x ?? 0) + (pendingMarkerBox?.width ?? 0)),
  ).toBeGreaterThanOrEqual(11);

  const gate = page.getByRole("region", { name: "Allow this action?" });
  await expect(page.getByLabel("Channel composer")).toHaveCount(0);
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("Run command: echo inspect");
  await expect(gate).not.toContainText("medium");
  await expect(gate).not.toContainText("Approve shell command");
  await expect(gate.getByRole("button", { name: "Allow options" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await maybeCaptureViewportScreenshot(page, "runtime-approval-composer-gate.png");

  await gate.getByRole("button", { name: "Allow once" }).click();
  await expect(gate).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  expect(state.approvals.find((approval) => isRecord(approval) && approval.id === "approval_1")?.status).toBe("approved");
  expect(state.approvalPolicy.toolDecisions.bash).toBe("ask");
  expect(state.approvalPolicy.toolDecisions.write).toBe("ask");
});

test("active command remains standalone and streams its bounded output expanded", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.threadId = "thread_active_command";
  run.status = "running";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-22T00:00:30.000Z";
  run.updatedAt = "2026-05-22T00:01:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  state.turns = [{
    id: "turn_active_command",
    workspaceId: "workspace_default",
    threadId: run.threadId,
    kind: "initial_request",
    status: "running",
    title: "Run focused checks",
    userInstruction: "Run the focused checks.",
    channelId: "channel_engineering",
    taskId: "task_inspect",
    activeRunId: run.id,
    createdByActor: "local-user",
    createdAt: run.startedAt,
    updatedAt: run.updatedAt,
  }];
  state.turnRunLinks = [{
    turnId: "turn_active_command",
    runId: run.id,
    attemptNumber: 1,
    role: "primary",
    createdAt: run.startedAt,
  }];
  state.executionActions = [{
    id: "active_command_action",
    workspaceId: "workspace_default",
    threadId: run.threadId,
    runId: run.id,
    toolCallId: "tool_active_command",
    actionType: "bash",
    risk: "low",
    status: "executing",
    title: "Run focused checks",
    summary: "pnpm test",
    targetRefs: [{ type: "command", label: "pnpm test" }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    commandEvidence: {
      command: "pnpm test",
      cwd,
      startedAt: run.startedAt,
      latestEventSeq: 5,
      outputTail: [{
        eventSeq: 5,
        stream: "stdout",
        text: "Running focused conversation tests...\n",
        byteCount: 38,
        redacted: false,
        ts: run.updatedAt,
      }],
      outputByteCount: 38,
      outputLineCount: 1,
      outputTruncated: false,
    },
    createdAt: run.startedAt,
    updatedAt: run.updatedAt,
    executedAt: run.startedAt,
  }];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const workCell = page.getByLabel("Channel message feed").locator(".conversation-work-cell");
  const activeStream = workCell.getByLabel("Active work stream");
  await expect(activeStream.locator(".conversation-command-batch")).toHaveCount(0);
  const commandRow = activeStream.locator(".conversation-work-cell-row.command-execution");
  await expect(commandRow).toHaveClass(/expanded/u);
  await expect(commandRow).toContainText("Running command");
  await expect(commandRow.locator(".conversation-work-cell-shell-command")).toContainText("pnpm test");
  await expect(commandRow.locator(".conversation-work-cell-row-detail")).toContainText("Running focused conversation tests...");
});

test("Ling Agent session active run guidance queues follow-up from composer and stops the run", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.status = "running";
  run.errorMessage = undefined;
  run.startedAt = "2026-05-22T00:00:30.000Z";
  run.updatedAt = "2026-05-22T00:01:00.000Z";
  run.threadId = "thread_channel_channel_engineering";
  run.teammateId = "ling_agent";
  run.workUnitId = "wu_active_channel_reply";
  run.requestSnapshot = { sourceMessageId: "message_active_reply_source" };
  state.approvals = [];
  state.channelMessages = [{
    id: "message_active_reply_source",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: "Start the active Ling Agent reply.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-05-22T00:00:29.000Z",
    updatedAt: "2026-05-22T00:00:29.000Z",
  }];
  state.workUnits = [{
    id: "wu_active_channel_reply",
    workspaceId: "workspace_default",
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: "message_active_reply_source",
    channelId: "channel_engineering",
    teammateId: "ling_agent",
    providerPresetId: "provider_local",
    idempotencyKey: "channel-reply:message_active_reply_source",
    status: "running",
    priority: 0,
    attemptCount: 1,
    createdByActor: "system",
    request: { sourceMessageId: "message_active_reply_source" },
    timeoutPolicy: { claimTtlMs: 60_000, heartbeatTtlMs: 60_000, cancelGraceMs: 15_000 },
    linkedRunId: run.id,
    createdAt: "2026-05-22T00:00:30.000Z",
    updatedAt: "2026-05-22T00:01:00.000Z",
    startedAt: "2026-05-22T00:00:30.000Z",
  }];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  await expect(page.getByLabel("Replying")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Guide whom" })).toHaveCount(0);
  await expect(composer).not.toContainText("Run in progress");
  const composerInput = channelComposerTextbox(composer);
  await expect(composerInput).toHaveAttribute("title", "Enter sends. Shift+Enter inserts a newline. Esc closes menus.");
  await composerInput.fill("完成后也更新 docs");
  await composerInput.press("Enter");

  await expect.poll(() => state.runInterventions.length).toBe(1);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:composer"]')).toHaveCount(0);
  await expect(composer.locator(".composer-status-row.success")).toHaveCount(0);
  await expect(page.getByLabel("Run guidance")).toHaveCount(1);
  expect(state.runInterventions[0]).toMatchObject({
    sourceRunId: run.id,
    mode: "queue_followup",
    status: "queued",
    instruction: "完成后也更新 docs",
  });
  const firstGuidanceMessage = page.locator(".conversation-guidance-row").filter({ hasText: "完成后也更新 docs" });
  await expect(firstGuidanceMessage).toBeVisible();
  await expect(firstGuidanceMessage).not.toContainText("Guidance");
  await expect(page.locator(".channel-message-row").filter({ hasText: "完成后也更新 docs" })).toHaveCount(0);
  await expect(page.locator(".conversation-work-cell")).toHaveCount(0);
  expect(state.channelMessages.map((message) => message.body)).toEqual([
    "Start the active Ling Agent reply.",
    "完成后也更新 docs",
  ]);
  expect(state.channelExecutionProposals).toHaveLength(0);

  await expectComposerValue(composerInput, "");
  await composerInput.fill("停，改用 daemon API");
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(composer.getByRole("button", { name: "Send" })).toHaveAttribute("title", "Send (Enter)");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => state.runInterventions.map((item) => item.instruction)).toEqual([
    "完成后也更新 docs",
    "停，改用 daemon API",
  ]);
  const redirectedGuidanceMessage = page.locator(".conversation-guidance-row").filter({ hasText: "停，改用 daemon API" });
  await expect(redirectedGuidanceMessage).toBeVisible();
  await expect(redirectedGuidanceMessage).not.toContainText("Guidance");
  await expect(page.locator(".channel-message-row").filter({ hasText: "停，改用 daemon API" })).toHaveCount(0);
  await expectComposerValue(composerInput, "");
  await composer.getByRole("button", { name: "Stop reply" }).click();

  await expect.poll(() => state.runs.find((item) => item.id === run.id)?.status).toBe("cancelled");
  expect(state.runInterventions).toHaveLength(2);
  expect(state.channelMessages.map((message) => message.body)).toEqual([
    "Start the active Ling Agent reply.",
    "完成后也更新 docs",
    "停，改用 daemon API",
  ]);
  expect(state.channelExecutionProposals).toHaveLength(0);
});

test("channel composer accepts a second queued guidance while the first request is still pending", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.status = "running";
  run.errorMessage = undefined;
  run.startedAt = "2026-08-06T08:00:00.000Z";
  run.updatedAt = "2026-08-06T08:00:01.000Z";
  state.approvals = [];
  state.channelMessageDelayMs = 750;

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const input = channelComposerTextbox(composer);
  await input.fill("First queued guidance");
  await input.press("Enter");
  await expect.poll(() => state.lastChannelTurnRequest?.body).toBe("First queued guidance");
  await expectComposerValue(input, "");

  await input.fill("Second queued guidance");
  await input.press("Enter");

  await expect.poll(() => state.runInterventions.map((item) => item.instruction), { timeout: 4_000 }).toEqual([
    "First queued guidance",
    "Second queued guidance",
  ]);
  await expectComposerValue(input, "");
  expect(state.channelMessages.map((message) => message.body)).toEqual([
    "First queued guidance",
    "Second queued guidance",
  ]);
});

test("second send never flashes in the transcript while the first reply lane is still unclassified", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessageDelayMs = 2_000;

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const input = channelComposerTextbox(composer);
  await input.fill("Start the first ordinary reply");
  await input.press("Enter");
  await expectComposerValue(input, "");

  await input.fill("Queue this second message without transcript flicker");
  await input.press("Enter");

  const queued = page.locator(".conversation-guidance-row").filter({ hasText: "Queue this second message without transcript flicker" });
  const transcript = page.locator(".channel-message-row").filter({ hasText: "Queue this second message without transcript flicker" });
  await expect(queued).toBeVisible({ timeout: 500 });
  await expect(transcript).toHaveCount(0);
});

test("ordinary channel send unlocks the composer at run linkage before the reply stream finishes", async ({ page }) => {
  await useEnglishLocale(page);
  await page.addInitScript(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    let streamCalls = 0;
    (globalThis as typeof globalThis & { __channelReplyStreamCalls?: () => number }).__channelReplyStreamCalls = () => streamCalls;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/channels/channel_engineering/turns/stream")) {
        return originalFetch(input, init);
      }
      if (streamCalls > 0) {
        return originalFetch(input, init);
      }
      streamCalls += 1;
      const body = await request.clone().json() as Record<string, unknown>;
      const createdAt = "2026-08-05T08:00:00.000Z";
      const thread = {
        id: "thread_channel_channel_engineering",
        workspaceId: "workspace_default",
        kind: "channel_discussion",
        channelId: "channel_engineering",
        title: "Engineering conversation",
        objective: "Root conversation for Engineering.",
        status: "open",
        conversationMode: { mode: "default" },
        surfaceKind: "channel_root",
        relationKind: "root",
        nextItemSequence: 3,
        createdAt,
        updatedAt: createdAt,
      };
      const turn = {
        id: "turn_chunked_channel_reply",
        workspaceId: "workspace_default",
        threadId: thread.id,
        kind: "manual_followup",
        status: "running",
        title: String(body.body ?? ""),
        userInstruction: String(body.body ?? ""),
        channelId: "channel_engineering",
        sourceItemId: "message_chunked_channel_reply",
        createdByActor: "local-user",
        createdAt,
        updatedAt: createdAt,
      };
      const userItem = {
        schemaVersion: 1,
        id: "message_chunked_channel_reply",
        workspaceId: "workspace_default",
        channelId: "channel_engineering",
        threadId: thread.id,
        turnId: turn.id,
        sequence: 1,
        kind: "user_message",
        status: "committed",
        actorType: "local_user",
        actorId: "local-user",
        visibility: "channel",
        payload: {
          body: String(body.body ?? ""),
          format: "plain_text",
          mentions: Array.isArray(body.mentions) ? body.mentions : [],
          attachmentIds: [],
          linkPreviewIds: [],
          fileRefs: [],
        },
        domainRefs: [],
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        committedAt: createdAt,
      };
      const pendingItem = {
        schemaVersion: 1,
        id: "reply_chunked_channel_reply",
        workspaceId: "workspace_default",
        channelId: "channel_engineering",
        threadId: thread.id,
        turnId: turn.id,
        sequence: 2,
        kind: "assistant_message",
        status: "pending",
        actorType: "teammate",
        actorId: "engineer",
        visibility: "channel",
        payload: { body: "", format: "markdown", streaming: true, deliveryStatus: "pending" },
        domainRefs: [
          { type: "conversation_item", id: userItem.id },
          { type: "run", id: "run_chunked_channel_reply" },
        ],
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      const readyItem = {
        ...pendingItem,
        status: "committed",
        payload: { body: "First reply completed.", format: "markdown", streaming: false, deliveryStatus: "ready" },
        committedAt: createdAt,
      };
      const decorations = [{ itemId: pendingItem.id, linkedRunId: "run_chunked_channel_reply" }];
      const encoder = new TextEncoder();
      const timers: number[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: string, data: unknown): void => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          emit("ready", { thread, turn, userItem, decorations: [] });
          timers.push(globalThis.setTimeout(() => emit("ready", { thread, turn, userItem, assistantItems: [pendingItem], decorations }), 100));
          timers.push(globalThis.setTimeout(() => emit("run_linked", {
            itemId: pendingItem.id,
            linkedRunId: "run_chunked_channel_reply",
            activeReply: {
              runId: "run_chunked_channel_reply",
              sourceRunId: "run_chunked_channel_reply",
              workUnitId: "wu_chunked_channel_reply",
              channelId: "channel_engineering",
              threadId: thread.id,
              sourceMessageId: userItem.id,
              teammateId: "engineer",
              status: "running",
              createdAt,
              updatedAt: createdAt,
            },
          }), 400));
          timers.push(globalThis.setTimeout(() => emit("delta", {
            itemId: pendingItem.id,
            delta: readyItem.payload.body,
            body: readyItem.payload.body,
          }), 1_400));
          timers.push(globalThis.setTimeout(() => {
            emit("done", { thread, turn: { ...turn, status: "succeeded", completedAt: createdAt }, userItem, assistantItems: [readyItem], decorations });
            controller.close();
          }, 1_800));
        },
        cancel() {
          timers.forEach((timer) => globalThis.clearTimeout(timer));
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
  });

  const state = createBaseState({ approvalStatus: "expired" });
  const runSeed = state.runs[0];
  state.runs = [];
  state.workUnits = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const input = channelComposerTextbox(composer);
  await input.fill("@Eng");
  await composer.getByRole("option", { name: /@Engineer/u }).click();
  await page.keyboard.insertText(" start the long reply");
  await composer.getByRole("button", { name: "Send" }).click();

  state.runs.push({
    ...runSeed,
    id: "run_chunked_channel_reply",
    status: "running",
    taskId: "message_chunked_channel_reply",
    channelId: "channel_engineering",
    teammateId: "engineer",
    threadId: "message_chunked_channel_reply",
    workUnitId: "wu_chunked_channel_reply",
    errorMessage: undefined,
    createdAt: "2026-08-05T08:00:00.000Z",
    startedAt: "2026-08-05T08:00:00.000Z",
    updatedAt: "2026-08-05T08:00:00.000Z",
  });
  state.workUnits.push({
    id: "wu_chunked_channel_reply",
    workspaceId: "workspace_default",
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: "message_chunked_channel_reply",
    channelId: "channel_engineering",
    teammateId: "engineer",
    providerPresetId: "provider_local",
    idempotencyKey: "channel-reply:message_chunked_channel_reply",
    status: "running",
    priority: 0,
    attemptCount: 1,
    createdByActor: "system",
    request: { sourceMessageId: "message_chunked_channel_reply" },
    timeoutPolicy: { claimTtlMs: 60_000, heartbeatTtlMs: 60_000, cancelGraceMs: 15_000 },
    linkedRunId: "run_chunked_channel_reply",
    linkedMessageId: "reply_chunked_channel_reply",
    createdAt: "2026-08-05T08:00:00.000Z",
    updatedAt: "2026-08-05T08:00:00.000Z",
    startedAt: "2026-08-05T08:00:00.000Z",
  });

  await expect(composer.getByRole("combobox", { name: "Guide whom" })).toHaveCount(0);
  await input.fill("@Eng");
  await composer.getByRole("option", { name: /@Engineer/u }).click();
  await page.keyboard.insertText("Add the failure-path test too");
  await input.press("Enter");
  await expect.poll(() => state.runInterventions.length).toBe(1);
  expect(state.runInterventions[0]).toMatchObject({
    sourceRunId: "run_chunked_channel_reply",
    mode: "queue_followup",
    instruction: "@Engineer Add the failure-path test too",
  });
  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __channelReplyStreamCalls?: () => number }).__channelReplyStreamCalls?.() ?? 0
  ))).toBe(1);
});

test("every message joins the channel FIFO while any teammate reply is active", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  configureConcurrentChannelReplyRuns(state);

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator(".conversation-work-cell")).toHaveCount(0);
  const composer = page.getByLabel("Channel composer");
  await expect(page.getByLabel("Replying")).toHaveCount(0);
  await expect(composer).not.toContainText("Run in progress");
  await expect(composer.getByRole("combobox", { name: "Guide whom" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Stop reply" })).toBeEnabled();

  const input = channelComposerTextbox(composer);
  await input.fill("只补充错误处理");
  await input.press("Enter");
  await expect.poll(() => state.lastChannelTurnRequest?.body).toBe("只补充错误处理");
  expect(state.lastChannelTurnRequest?.teammateId).toBeUndefined();
  await expect.poll(() => state.runInterventions.length).toBe(1);
  expect(state.runInterventions[0]).toMatchObject({
    sourceRunId: "run_channel_reply_designer",
    mode: "queue_followup",
    instruction: "只补充错误处理",
    messagePayload: { targetTeammateId: "ling_agent" },
  });
  await expect(page.locator(".conversation-guidance-row").filter({ hasText: "只补充错误处理" })).toBeVisible();
  await expect(page.locator(".channel-message-row").filter({ hasText: "只补充错误处理" })).toHaveCount(0);

  await input.fill("@Eng");
  await composer.getByRole("option", { name: /@Engineer/u }).click();
  await page.keyboard.insertText("只补充 Engineer 的错误处理");
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
  await input.press("Enter");
  await expect.poll(() => state.runInterventions.length).toBe(2);
  expect(state.runInterventions[1]).toMatchObject({
    sourceRunId: "run_channel_reply_designer",
    mode: "queue_followup",
    instruction: "@Engineer 只补充 Engineer 的错误处理",
    messagePayload: { targetTeammateId: "engineer" },
  });
  const guidanceMessage = page.locator(".conversation-guidance-row").filter({ hasText: "只补充 Engineer 的错误处理" });
  await expect(guidanceMessage).toBeVisible();
  await expect(page.locator(".channel-message-row").filter({ hasText: "只补充 Engineer 的错误处理" })).toHaveCount(0);
  expect(state.channelMessages.some((message) => message.authorType === "local-user" && message.body === "@Engineer 只补充 Engineer 的错误处理")).toBe(true);
  expect(state.lastChannelTurnRequest?.teammateId).toBeUndefined();
  expect(state.lastChannelTurnRequest?.mentions).toEqual([
    expect.objectContaining({ id: "engineer", kind: "ai-teammate" }),
  ]);

});

test("channel stop cancels the single active reply", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const activeReplies = configureConcurrentChannelReplyRuns(state);
  state.runs = state.runs
    .filter((run) => run.id === activeReplies.engineerRunId)
    .map((run) => ({ ...run, teammateId: "ling_agent" }));
  state.workUnits = state.workUnits
    .filter((workUnit) => workUnit.id === activeReplies.engineerWorkUnitId)
    .map((workUnit) => ({ ...workUnit, teammateId: "ling_agent" }));

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  await expect(composer.getByRole("combobox", { name: "Guide whom" })).toHaveCount(0);

  const stopButton = composer.getByRole("button", { name: "Stop reply" });
  await expect(stopButton).toBeEnabled();
  await stopButton.click();

  await expect.poll(() => state.runs.find((run) => run.id === activeReplies.engineerRunId)?.status).toBe("cancelled");
  await expect.poll(() => state.workUnits.find((unit) => unit.id === activeReplies.engineerWorkUnitId)?.status).toBe("cancelled");
  expect(state.eventsByRun[activeReplies.engineerRunId]?.some((event) => event.type === "run_cancelled")).toBe(true);
  expect(state.runInterventions).toHaveLength(0);
});

test("retained channel activity does not flash a loading notice during background refresh", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs[0].status = "running";
  state.runs[0].updatedAt = "2026-08-06T08:00:01.000Z";

  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();

  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __channelActivityLoadingFlashes?: number;
      __channelActivityLoadingObserver?: MutationObserver;
    };
    runtime.__channelActivityLoadingFlashes = 0;
    runtime.__channelActivityLoadingObserver?.disconnect();
    runtime.__channelActivityLoadingObserver = new MutationObserver(() => {
      const visible = [...document.querySelectorAll<HTMLElement>(".activity-feed-status")]
        .some((element) => element.offsetParent !== null && element.textContent?.includes("Loading activity events"));
      if (visible) runtime.__channelActivityLoadingFlashes = (runtime.__channelActivityLoadingFlashes ?? 0) + 1;
    });
    runtime.__channelActivityLoadingObserver.observe(document.body, { childList: true, subtree: true });
  });

  const composer = page.getByLabel("Channel composer");
  const input = channelComposerTextbox(composer);
  await input.fill("Refresh retained activity without flashing");
  await input.press("Enter");
  await expect.poll(() => state.runInterventions.length).toBe(1);
  await page.waitForTimeout(800);

  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __channelActivityLoadingFlashes?: number }).__channelActivityLoadingFlashes ?? 0
  ))).toBe(0);
});

test("runtime composer gate queues multiple local approvals and excludes review queue actions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const run = state.runs[0];
  state.approvals.push(
    {
      id: "approval_write_overlay",
      runId: run.id,
      taskId: run.taskId,
      actionType: "write",
      risk: "high",
      title: "Approve file write",
      description: "Write report.md",
      payload: { type: "file_write", path: "report.md" },
      status: "pending",
      createdAt: "2026-05-22T00:00:30.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    },
    {
      id: "approval_external_overlay",
      channelId: "channel_engineering",
      externalWorkActionId: "external_action_overlay",
      actionType: "external_send",
      risk: "critical",
      title: "Approve external send",
      description: "Post external update",
      payload: { type: "external_action", actionKind: "comment" },
      status: "pending",
      createdAt: "2026-05-22T00:00:40.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    },
  );
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const gate = page.getByRole("region", { name: "Allow this action?" });
  await expect(gate).toContainText("Create file:");
  await expect(gate).not.toContainText("Approve file write");
  await expect(gate).not.toContainText("pending approvals");
  await expect(gate).not.toContainText("Approve shell command");
  await expect(gate).not.toContainText("Approve external send");
  await gate.getByRole("button", { name: "Deny" }).click();
  await expect(gate).toContainText("Run command:");
  await expect(gate).not.toContainText("Approve shell command");
  await expect(gate).not.toContainText("pending approvals");
});

test("channel activity derives task run approval transition and workflow events", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
    status: "expired",
    createdAt: "2026-05-25T00:03:00.000Z",
    expiresAt: "2000-01-01T00:01:00.000Z",
    resolvedAt: "2000-01-01T00:01:00.000Z",
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
  await openEngineeringChannel(page);

  const messageBubble = page.locator(".channel-message-row").filter({ hasText: "Timeline source message" });
  const taskEventBubble = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" });
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approval expired" });
  const stateTransitionBubble = page.locator(".message-bubble").filter({ hasText: "State change" }).filter({ hasText: "task_failed" });
  const workflowStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" });
  const activityDetails = page.getByLabel("Activity details");
  const clickActivityDetailsAction = async (name: string) => {
    const button = activityDetails.getByRole("button", { name });
    await expect(button).toBeVisible();
    await button.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await button.click();
  };
  const openDetailsFrom = async (bubble: Locator, expectedText: string) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const detailsButton = bubble.getByRole("button", { name: "Details" });
        await expect(detailsButton).toBeVisible();
        await detailsButton.click({ timeout: 1_000 });
        break;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await page.waitForTimeout(50);
      }
    }
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
  await expect(approvalEventBubble).toContainText("expired");
  await expect(stateTransitionBubble).toBeVisible();
  await expect(workflowStepBubble).toContainText("Runtime policy is waiting.");
  await expect(taskEventBubble).toHaveClass(/message-bubble-work/);
  await expect(runEventBubble).toHaveClass(/message-bubble-work/);
  await expect(approvalEventBubble).toHaveClass(/message-bubble-approval/);
  await expect(stateTransitionBubble).toHaveClass(/message-bubble-runtime/);
  await expect(workflowStepBubble).toHaveClass(/message-bubble-runtime/);
  await expect(page.getByText("Other channel task leak")).toHaveCount(0);
  await expect(page.getByText("Other channel approval leak")).toHaveCount(0);
  await expect(page.getByText("other_channel_done")).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  const composer = page.getByLabel("Channel composer");
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("button", { name: "More" })).toHaveCount(0);
  await channelComposerTextbox(composer).fill("@Eng");
  await expect(composer.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composer.getByRole("option", { name: /@Engineer/ }).click();
  await expect(composer.locator(".composer-inline-token.mention").filter({ hasText: "Engineer" })).toBeVisible();

  await openDetailsFrom(taskEventBubble, "Inspect workspace");
  await openDetailsFrom(runEventBubble, "Run run_failed");
  await openDetailsFrom(approvalEventBubble, "Approval expired");
  await openDetailsFrom(stateTransitionBubble, "task_failed");
  await openDetailsFrom(workflowStepBubble, "Blocked timeline step");

  await taskEventBubble.getByRole("button", { name: "Details" }).click();
  await clickActivityDetailsAction("Show task in transcript");
  await expectConversationReviewSurface(page);
  await expect(activityDetails).toHaveCount(0);

  await openChannelChatTools(page);
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await clickActivityDetailsAction("Show run in transcript");
  await expectConversationReviewSurface(page);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);

  await approvalEventBubble.getByRole("button", { name: "Details" }).click();
  await clickActivityDetailsAction("Open approval");
  await expect(page.locator(".conversation-detail-overlay").filter({ hasText: "Approval details" })).toContainText("No pending approval");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);

  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await clickActivityDetailsAction("Review source");
  await expectConversationReviewSurface(page);
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await expect(activityDetails).toHaveCount(0);

  await openChannelChatTools(page);
  const activityFilters = channelEventFilters(page);
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
    if (await activityFilters.locator(".activity-filter-panel").count() === 0) {
      await channelEventFilterToggle(activityFilters).click();
    }
  };
  const categoryChip = (label: string) => activityFilters.getByLabel("Activity categories").locator(".activity-filter-chip").filter({ hasText: label });
  const attentionChip = (label: string) => activityFilters.getByLabel("Activity attention filters").locator(".activity-filter-chip").filter({ hasText: label });

  await expect(activityFilters).toBeVisible();
  await expect(activityFilters.locator(".activity-saved-views")).toHaveCount(0);
  await expect(savedViewSelect).toContainText("All (7)");
  await expect(savedViewSelect).toContainText("Needs attention (5)");
  await expect(savedViewSelect).toContainText("Blocked (1)");
  await expect(savedViewSelect).toContainText("Failed (4)");
  await expect(savedViewSelect).toContainText("Pending approvals (0)");
  await expect(savedViewSelect).toContainText("Failed work (2)");
  await expect(savedViewSelect).toContainText("Runtime (3)");
  await expect(activityFilters.getByLabel("Activity categories")).toHaveCount(0);
  await openFilterPanel();
  await expect(activityFilters.locator(".activity-filter-panel")).toBeVisible();
  await expect(categoryChip("All")).toContainText("7");
  await expect(categoryChip("Messages")).toContainText("1");
  await expect(categoryChip("Work")).toContainText("2");
  await expect(categoryChip("Approvals")).toContainText("1");
  await expect(categoryChip("Protocol")).toContainText("0");
  await expect(categoryChip("Runtime")).toContainText("3");

  await page.locator(".task-toolbar-progress").click();
  await expect(page.locator(".channel-progress-popover")).toHaveCount(1);
  await page.getByRole("button", { name: "Show details" }).click();
  const summaryButton = page.locator(".task-toolbar-progress");
  await expect(page.locator(".channel-progress-popover")).toBeHidden();
  await expect(summaryButton).toHaveAttribute("aria-pressed", "true");
  await expect(summaryButton).toHaveAttribute("aria-expanded", "false");
  const contextPanel = page.locator(".channel-side-panel.right-dock");
  await expect(contextPanel).toHaveAttribute("aria-label", "Channel workspace dock");
  await expect(contextPanel.getByLabel("Attention counts")).toHaveCount(0);
  await expect(contextPanel.getByLabel("Top attention items")).toHaveCount(0);
  await expect(contextPanel.locator(".attention-queue-item")).toHaveCount(0);
  await expect(contextPanel.locator(".collaboration-task-card")).toHaveCount(0);

  await selectSavedView("Blocked");
  await expect(page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" })).toBeVisible();
  await expect(activityFeed.getByText("Timeline source message")).toHaveCount(0);
  await selectSavedView("Pending approvals");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" })).toHaveCount(0);
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

  await searchInput.fill("Approval expired");
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "expired" })).toBeVisible();

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
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "expired" })).toBeVisible();
  await attentionChip("Pending").click();
  await expect(page.locator(".message-bubble").filter({ hasText: "Approval event" })).toHaveCount(0);
  await expect(page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "failed" })).toHaveCount(0);
  await activityFilters.getByRole("button", { name: /Clear/ }).click();

  await searchInput.fill("definitely-not-present");
  await expect(page.getByText("No activity matches these filters")).toBeVisible();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await searchInput.fill("run_failed");
  await expect(runEventBubble).toBeVisible();
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await expect(activityDetails).toContainText("Run run_failed");
  await expect(searchInput).toHaveValue("run_failed");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("run_failed");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await activityFilters.getByRole("button", { name: "Save view" }).click();
  const saveViewDialog = page.getByRole("dialog", { name: "Save view" });
  await saveViewDialog.getByRole("textbox", { name: "Saved view name" }).fill("Run failures");
  await saveViewDialog.getByRole("button", { name: "Save view" }).click();
  await expect(savedViewOption("Run failures")).toHaveCount(1);

  await page.reload();
  await openEngineeringChannel(page);
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await openChannelChatTools(page);
  await expect(savedViewOption("Run failures")).toHaveCount(1);
  await selectSavedView("Run failures");
  await expect(searchInput).toHaveValue("run_failed");
  await openFilterPanel();
  await activityFilters.getByRole("button", { name: "Rename" }).click();
  const renameViewDialog = page.getByRole("dialog", { name: "Rename saved view" });
  await renameViewDialog.getByRole("textbox", { name: "Saved view name" }).fill("Run problems");
  await renameViewDialog.getByRole("button", { name: "Rename" }).click();
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
  await activityFilters.getByRole("button", { name: "Delete view" }).click();
  const deleteViewDialog = page.getByRole("dialog", { name: "Delete saved view Run problems?" });
  await deleteViewDialog.getByRole("button", { name: "Delete view" }).click();
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

  await page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Show in transcript" }).click();
  await expectConversationReviewSurface(page);

  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Show in transcript" }).click();
  await expectConversationReviewSurface(page);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approval expired" }).getByRole("button", { name: "Open approval" }).click();
  await expectApprovalDetailOverlay(page, "Approval expired");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" }).getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);
});

test("channel activity triage actions create follow-up records and preserve local state", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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
  await openEngineeringChannel(page);

  const activityDetails = page.getByLabel("Activity details");
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const workflowStepBubble = page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked triage step" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approval expired" });
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
  await activityDetails.getByRole("button", { name: "Show created task in transcript" }).click();
  await expectConversationReviewSurface(page);

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create handoff" }).click();
  await activityDetails.getByLabel("Reason").fill("Escalate blocked triage step");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelHandoffs.some((handoff) => isRecord(handoff) && handoff.reason === "Escalate blocked triage step")).toBe(true);
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await activityDetails.getByRole("button", { name: "Review created source" }).click();
  await expectConversationReviewSurface(page);

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  await approvalEventBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Record decision" }).click();
  await activityDetails.getByLabel("Triage title").fill("Decision: review the expired approval");
  await activityDetails.getByLabel("Decision text").fill("Review why the shell command approval expired before retrying.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.title === "Decision: review the expired approval")).toBe(true);
  await activityDetails.getByRole("button", { name: "Review created source" }).click();
  await expectConversationReviewSurface(page);

  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await openChannelChatTools(page);
  const activityFilters = channelEventFilters(page);
  const searchInput = activityFilters.getByPlaceholder("Search activity");
  const composer = channelComposerTextbox(page);
  await searchInput.fill("Blocked triage");
  await composer.fill("Composer draft survives triage");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await workflowStepBubble.getByRole("button", { name: "Details" }).click();
  await openTriageActions();
  await activityDetails.getByRole("button", { name: "Create context summary" }).click();
  await activityDetails.getByLabel("Summary").fill("Summary from Blocked triage step.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelContextSummaries.some((summary) => isRecord(summary) && summary.summary === "Summary from Blocked triage step.")).toBe(true);
  await expect(activityDetails.getByRole("status")).toContainText("Triage action created");
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("Blocked triage");
  await expectComposerValue(composer, "Composer draft survives triage");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  const summaryBubble = page.locator(".message-bubble").filter({ hasText: "Context summary" }).filter({ hasText: "Summary from Blocked triage step" });
  await expect(summaryBubble).toBeVisible();
  const taskCount = state.tasks.length;
  await summaryBubble.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => state.tasks.length).toBe(taskCount + 1);
  await expect(page.locator("article.task-detail")).toHaveCount(0);
});

test("channel activity does not auto-render the progress popover before explicit open", async ({ page }) => {
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
  await openEngineeringChannel(page);

  await expect(page.locator(".task-toolbar-progress .toolbar-count")).toHaveCount(0);
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.locator("article.task-detail")).toHaveCount(0);

  await page.locator(".task-toolbar-progress").click();
  await expect(page.locator(".channel-progress-popover")).toHaveCount(1);
  await expect(page.locator(".channel-progress-popover")).toContainText("Local environment");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

async function expectSingleAssistantTranscript(feed: Locator): Promise<Locator> {
  const transcriptTurn = feed.locator(".conversation-turn");
  await expect(transcriptTurn).toHaveCount(1);
  const assistantTranscript = transcriptTurn.locator(".conversation-turn-assistant-row");
  await expect(assistantTranscript).toHaveCount(1);
  return assistantTranscript;
}

async function expectPhase1MainFeedClean(feed: Locator): Promise<void> {
  await expect(feed).not.toContainText("Agent branches");
  await expect(feed).not.toContainText("previous actions");
  await expect(feed).not.toContainText("hidden agent spans");
  await expect(feed).not.toContainText("Confirmed proposal");
  await expect(feed).not.toContainText("Acceptance criteria");
  await expect(feed).not.toContainText("Smoke ID");
  await expect(feed).not.toContainText("开始 workflow");
  await expect(feed).not.toContainText("Confirm requirement");
  await expect(feed).not.toContainText("Completed:");
  await expect(feed).not.toContainText("provider_local");
  await expect(feed).not.toContainText("tokens");
  await expect(feed).not.toContainText("workflow_runtime_boundary");
  await expect(feed).not.toContainText("raw prompt text excluded");
  await expect(feed).not.toContainText(".ling-stack/sessions");
  await expect(feed).not.toContainText("context.json");
  await expect(feed).not.toContainText("output.json");
  await expect(feed).not.toContainText("branch_engineer");
}

async function expandOperationBubbleIfCollapsed(workCell: Locator): Promise<void> {
  const expandButton = workCell.locator(".conversation-operation-shell-head[aria-expanded='false'], .conversation-operation-bubble-toggle[aria-expanded='false']");
  if (await expandButton.count() > 0) {
    await expandButton.first().click();
  }
}

async function expectNoCompletedWorkCellAnimations(workCell: Locator): Promise<void> {
  const animatedNodes = await workCell.evaluate((element) => {
    const nodes = [
      element,
      ...Array.from(element.querySelectorAll<HTMLElement>(
        ".conversation-work-cell-row, .conversation-work-cell-agent-span, .conversation-work-cell-artifact-row",
      )),
    ];
    return nodes
      .map((node) => ({
        className: node.className.toString(),
        animationName: getComputedStyle(node).animationName,
        animationDuration: getComputedStyle(node).animationDuration,
      }))
      .filter((item) => item.animationName !== "none" && item.animationDuration !== "0s");
  });
  expect(animatedNodes).toEqual([]);
}

interface ConversationScreenshotViewport {
  readonly suffix: string;
  readonly width: number;
  readonly height: number;
}

async function maybeCaptureR32Screenshot(page: Page, name: string): Promise<void> {
  await maybeCaptureConversationScreenshots(page, name, [
    { suffix: "desktop", width: 1440, height: 960 },
  ]);
}

async function maybeCaptureConversationScreenshots(
  page: Page,
  name: string,
  viewports: readonly ConversationScreenshotViewport[],
): Promise<void> {
  const outputDir = process.env.LING_R32_SCREENSHOTS_DIR;
  if (!outputDir) {
    return;
  }

  await mkdir(outputDir, { recursive: true });
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(250);
    const feedBox = await page.locator(".message-feed").boundingBox();
    await page.screenshot({
      path: join(outputDir, `${name}-${viewport.suffix}.png`),
      clip: feedBox ? {
        x: Math.max(0, feedBox.x),
        y: Math.max(0, feedBox.y),
        width: Math.max(1, Math.min(feedBox.width, viewport.width - Math.max(0, feedBox.x))),
        height: Math.max(1, Math.min(feedBox.height, viewport.height - Math.max(0, feedBox.y))),
      } : undefined,
    });
  }
}

async function maybeCaptureViewportScreenshot(page: Page, name: string): Promise<void> {
  const outputDir = process.env.LING_R32_SCREENSHOTS_DIR;
  if (!outputDir) {
    return;
  }
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(outputDir, name),
  });
}
