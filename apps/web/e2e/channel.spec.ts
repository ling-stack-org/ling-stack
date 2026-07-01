import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProposedPlanArtifact } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  isRecord,
} from "./support/mock-state";
import {
  channelEventFilterToggle,
  channelEventFilters,
  openEngineeringChannel,
  openChannelChatTools,
  openTaskFromAttentionQueue,
  readScrollState,
} from "./support/test-helpers";

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

test("channel governance notifications stay in the header review queue", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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

  await expect(page.locator(".channel-governance-button")).toContainText("Review");
  await expect(page.locator(".channel-governance-button")).toContainText("1");
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
  const state = createBaseState({ approvalStatus: "pending" });
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

test("channel team experts fold into latest turn and metrics stay in settings", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
      body: "主回复保持干净，团队证据折叠展示。",
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
  await expect(feed.getByText("主回复保持干净，团队证据折叠展示。")).toBeVisible();
  await expect(feed.getByText("后续回复没有团队证据。")).toBeVisible();
  const experts = feed.locator(".channel-team-experts-summary");
  await expect(experts).toHaveCount(1);
  await expect(experts).toContainText("1 active");
  await expect(experts).toContainText("2 done");
  await expect.poll(() => state.channelTeamExpertsRequests.some((request) =>
    request.channelId === "channel_engineering" &&
    request.turnId === "msg_team_source" &&
    request.includeExpired === true
  )).toBe(true);
  await expect.poll(() => state.channelTeamExpertsRequests.some((request) =>
    request.channelId === "channel_engineering" &&
    request.turnId === "msg_team_followup" &&
    request.includeExpired === true
  )).toBe(true);
  await expect(feed.getByText("Architect checked boundaries.")).toHaveCount(0);
  const assistantTranscript = feed.locator(".conversation-turn-assistant-transcript").filter({ hasText: "主回复保持干净，团队证据折叠展示。" });
  await expect(assistantTranscript.locator(".message-action-bar.channel-message-ai-actions")).toHaveCount(1);
  const assistantTurnOrder = await assistantTranscript.evaluate((element) =>
    Array.from(element.children).map((child) => (child as HTMLElement).className)
  );
  expect(assistantTurnOrder.some((className) => className.includes("channel-team-experts-summary"))).toBe(true);
  expect(assistantTurnOrder.at(-1)).toContain("channel-message-row-footer-stack");

  await experts.getByRole("button", { name: /Teammates/ }).click();
  await expect(feed.getByText("Architect checked boundaries.")).toBeVisible();

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const teamMetrics = page.getByRole("region", { name: "Team metrics" });
  await expect(teamMetrics).toContainText("attention needed");
  await expect(teamMetrics).toContainText("Architect checked boundaries.");
});

test("global sidebar keeps fixed chrome, scrollable recents, and a true compact rail", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_drawer_designer", displayName: "Designer" })];
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
  await expect(navigation.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Image Generation" })).toBeVisible();
  await expect(navigation.locator(".primary-nav").getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Automations" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Profile" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await navigation.getByRole("button", { name: "Engineering" }).click();

  const expanded = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const fixedTop = document.querySelector(".channel-left-drawer .sidebar-fixed-top");
    const scrollRegion = document.querySelector(".channel-left-drawer .sidebar-scroll-region");
    const bottom = document.querySelector(".channel-left-drawer .sidebar-bottom");
    const selectedChannel = document.querySelector(".channel-left-drawer .sidebar-channel-group > .sidebar-row-shell.selected");
    const primaryNav = document.querySelector(".channel-left-drawer .primary-nav");
    const firstSectionTitle = document.querySelector(".channel-left-drawer .sidebar-section-title");
    const sidebarSwitch = document.querySelector(".channel-sidebar-switch");
    const settings = document.querySelector(".channel-left-drawer .config-button");
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      firstColumnWidth: Math.round(Number.parseFloat(shell ? getComputedStyle(shell).gridTemplateColumns : "0")),
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      leftBackground: leftDrawer ? getComputedStyle(leftDrawer).backgroundColor : "",
      fixedTopTop: Math.round(fixedTop?.getBoundingClientRect().top ?? -1),
      scrollOverflowY: scrollRegion ? getComputedStyle(scrollRegion).overflowY : "",
      scrollTop: Math.round(scrollRegion?.getBoundingClientRect().top ?? -1),
      bottomBottomGap: leftDrawer && bottom ? Math.round(leftDrawer.getBoundingClientRect().bottom - bottom.getBoundingClientRect().bottom) : -1,
      selectedChannelText: selectedChannel?.textContent?.trim() ?? "",
      selectedChannelBackground: selectedChannel ? getComputedStyle(selectedChannel).backgroundColor : "",
      primaryNavBorderBottom: primaryNav ? getComputedStyle(primaryNav).borderBottomWidth : "",
      sectionTitleColor: firstSectionTitle ? getComputedStyle(firstSectionTitle).color : "",
      sectionTitleFontSize: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontSize : "",
      sectionTitleFontWeight: firstSectionTitle ? getComputedStyle(firstSectionTitle).fontWeight : "",
      sidebarSwitchBorderWidth: sidebarSwitch ? getComputedStyle(sidebarSwitch).borderTopWidth : "",
      settingsText: settings?.textContent?.trim() ?? "",
      globalRightPanels: document.querySelectorAll(".right-panel").length,
    };
  });
  expect(expanded.firstColumnWidth).toBe(240);
  expect(expanded.leftWidth).toBe(240);
  expect(expanded.leftBackground).toBe("rgb(255, 255, 255)");
  expect(expanded.fixedTopTop).toBeGreaterThanOrEqual(10);
  expect(expanded.scrollOverflowY).toBe("auto");
  expect(expanded.scrollTop).toBeGreaterThan(expanded.fixedTopTop);
  expect(expanded.bottomBottomGap).toBeGreaterThanOrEqual(8);
  expect(expanded.selectedChannelText).toContain("Engineering");
  expect(expanded.selectedChannelBackground).toBe("rgb(245, 245, 245)");
  expect(expanded.primaryNavBorderBottom).toBe("0px");
  expect(expanded.sectionTitleColor).toBe("rgb(138, 138, 138)");
  expect(expanded.sectionTitleFontSize).toBe("10px");
  expect(Number(expanded.sectionTitleFontWeight)).toBeGreaterThanOrEqual(700);
  expect(expanded.sidebarSwitchBorderWidth).toBe("0px");
  expect(expanded.settingsText).toBe("Settings");
  expect(expanded.globalRightPanels).toBe(0);

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.mouse.move(22, 22);
  await expect.poll(async () => Math.round((await page.locator(".channel-left-drawer").boundingBox())?.width ?? 0)).toBe(48);
  const leftCollapsed = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    const brandCopy = document.querySelector(".channel-left-drawer .sidebar-brand-copy");
    const firstNavText = document.querySelector(".channel-left-drawer .primary-nav .nav-item span");
    const settingsLabel = document.querySelector(".channel-left-drawer .config-button-label");
    const selectedChannelAvatar = document.querySelector(".channel-left-drawer .sidebar-row-shell.selected .sidebar-channel-avatar");
    const selectedChannelHash = document.querySelectorAll(".channel-left-drawer .sidebar-row-shell.selected .sidebar-hash");
    const selectedChannelButton = document.querySelector(".channel-left-drawer .sidebar-row-shell.selected .sidebar-row-main");
    const teammateButton = document.querySelector('.channel-left-drawer .sidebar-row[title="Designer"]');
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      firstColumnWidth: Math.round(Number.parseFloat(shell ? getComputedStyle(shell).gridTemplateColumns : "0")),
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
      leftX: Math.round(leftDrawer?.getBoundingClientRect().x ?? -1),
      leftOpacity: leftDrawer ? getComputedStyle(leftDrawer).opacity : "",
      transform: leftDrawer ? getComputedStyle(leftDrawer).transform : "",
      brandCopyDisplay: brandCopy ? getComputedStyle(brandCopy).display : "",
      firstNavTextDisplay: firstNavText ? getComputedStyle(firstNavText).display : "",
      settingsLabelDisplay: settingsLabel ? getComputedStyle(settingsLabel).display : "",
      selectedChannelAvatarDisplay: selectedChannelAvatar ? getComputedStyle(selectedChannelAvatar).display : "",
      selectedChannelAvatarText: selectedChannelAvatar?.textContent?.trim() ?? "",
      selectedChannelAvatarWidth: Math.round(selectedChannelAvatar?.getBoundingClientRect().width ?? 0),
      selectedChannelHashCount: selectedChannelHash.length,
      selectedChannelTitle: selectedChannelButton?.getAttribute("title") ?? "",
      teammateTitle: teammateButton?.getAttribute("title") ?? "",
    };
  });
  expect(leftCollapsed.firstColumnWidth).toBe(48);
  expect(leftCollapsed.leftWidth).toBe(48);
  expect(leftCollapsed.leftX).toBe(0);
  expect(leftCollapsed.leftOpacity).toBe("1");
  expect(leftCollapsed.transform).toBe("none");
  expect(leftCollapsed.brandCopyDisplay).toBe("none");
  expect(leftCollapsed.firstNavTextDisplay).toBe("none");
  expect(leftCollapsed.settingsLabelDisplay).toBe("none");
  expect(leftCollapsed.selectedChannelAvatarDisplay).toBe("grid");
  expect(leftCollapsed.selectedChannelAvatarText).toBe("EN");
  expect(leftCollapsed.selectedChannelAvatarWidth).toBe(26);
  expect(leftCollapsed.selectedChannelHashCount).toBe(0);
  expect(leftCollapsed.selectedChannelTitle).toBe("Engineering");
  expect(leftCollapsed.teammateTitle).toBe("Designer");

  const sidebarTooltip = page.locator(".sidebar-hover-tooltip");
  await navigation.locator(".sidebar-row-shell.selected .sidebar-row-main").hover();
  await expect(sidebarTooltip).toHaveText("Engineering");
  await expect.poll(async () => sidebarTooltip.evaluate((node) => Math.round(node.getBoundingClientRect().left))).toBeGreaterThan(45);
  await navigation.getByRole("button", { name: "Settings" }).hover();
  await expect(sidebarTooltip).toHaveText("Settings");

  await navigation.getByRole("button", { name: "Image Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  await navigation.getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Configuration overview" })).toBeVisible();
  await page.getByRole("button", { name: "Open AI Teammates" }).click();
  await expect(page.locator(".teammates-page-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to configuration" })).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();

  await page.getByRole("button", { name: "Show navigation" }).click();
  await expect.poll(async () => Math.round((await page.locator(".channel-left-drawer").boundingBox())?.width ?? 0)).toBe(240);
  const restored = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const leftDrawer = document.querySelector(".channel-left-drawer");
    return {
      columns: shell ? getComputedStyle(shell).gridTemplateColumns : "",
      leftWidth: Math.round(leftDrawer?.getBoundingClientRect().width ?? 0),
    };
  });
  expect(restored.columns.startsWith("240px ")).toBe(true);
  expect(restored.leftWidth).toBe(240);
});

test("narrow channel viewport keeps the conversation column usable", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed).toBeVisible();

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

  const workCell = page.locator(".conversation-work-cell").filter({ hasText: "Engineer" });
  await expect(workCell).toBeVisible();
  const activeMotion = await workCell.evaluate((element) => {
    const runningText = element.querySelector(".conversation-work-cell-agent-span.running .conversation-work-cell-agent-span-copy small, .conversation-work-cell-row.running .conversation-work-cell-row-copy strong");
    return {
      cellAnimation: getComputedStyle(element).animationName,
      runningAnimation: runningText ? getComputedStyle(runningText).animationName : "",
    };
  });
  expect(activeMotion.cellAnimation).toContain("conversation-settle-in");
  expect(activeMotion.runningAnimation).toContain("conversation-active-shimmer");
  await workCell.locator(".conversation-work-cell-agent-span-head").click();
  await expect(workCell.locator(".conversation-work-cell-agent-span-detail")).toContainText("From Development Council");

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Progress" }).click();

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
          "@@ -1,3 +1,4 @@",
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
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.waitForTimeout(200);
  await expect.poll(async () => Math.round((await page.locator(".channel-left-drawer").boundingBox())?.width ?? 0)).toBeLessThanOrEqual(250);
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
    return {
      chatHeight: Math.round(chatBox?.height ?? 0),
      chatTransform: chatLayout ? getComputedStyle(chatLayout).transform : "",
      chatWidth: Math.round(chatBox?.width ?? 0),
      chatX: Math.round(chatBox?.x ?? 0),
      chatY: Math.round(chatBox?.y ?? 0),
      composerTransform: composer ? getComputedStyle(composer).transform : "",
      mainPaddingRight: main ? getComputedStyle(main).paddingRight : "",
      panelMarginRight: chatPanel ? getComputedStyle(chatPanel).marginRight : "",
    };
  });

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Progress" }).click();
  const popover = page.locator(".channel-progress-popover");
  await expect(popover).toBeVisible();
  await expect.poll(async () => Math.round((await popover.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(360);
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
  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Progress" }).click();
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
  expect(chatSnapshotBeforeDock.chatTransform).toBe("matrix(1, 0, 0, 1, 32, 0)");
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
  await page.waitForTimeout(160);
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
  const chatSnapshotAfterDockClose = await readChatLayoutSnapshot();
  expect(Math.abs(chatSnapshotAfterDockClose.chatX - chatSnapshotBeforeDock.chatX)).toBeLessThanOrEqual(1);
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
  await expect(dock).toContainText("Workspace environment diff");
  const reviewSummaryRow = dock.locator(".right-dock-review-row", { hasText: "Workspace environment diff" });
  const codePreview = dock.locator(".right-dock-code-preview");
  await expect(codePreview).toBeVisible();
  await expect(reviewSummaryRow).toHaveCount(0);
  await expect(dock.locator(".right-dock-review-row")).toHaveCount(0);
  await expect(codePreview.locator("pre")).toContainText("reviewPreview");
  await codePreview.getByRole("button", { name: "Collapse code preview" }).click();
  await expect(codePreview).toHaveClass(/collapsed/u);
  await expect(codePreview.locator("pre")).toHaveCount(0);
  await expect(codePreview).toContainText("Workspace environment diff");
  const expandedResizeHandleBox = await resizeHandle.boundingBox();
  expect(expandedResizeHandleBox).not.toBeNull();
  await page.mouse.move(expandedResizeHandleBox!.x + expandedResizeHandleBox!.width / 2, expandedResizeHandleBox!.y + 40);
  await page.mouse.down();
  await page.mouse.move(860, expandedResizeHandleBox!.y + 40, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(840);
  await expect(popover).toHaveCount(0);
  await expect.poll(async () => Math.round((await page.locator(".activity-shell .channel-composer").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(560);
  await page.locator(".task-toolbar-panel").click();
  await expect(dock).toHaveCount(0);
  await expect(popover).toBeVisible();

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Environment" }).click();
  const environmentPage = page.locator(".channel-environment-page");
  await expect(environmentPage).toBeVisible();
  await expect(environmentPage).toContainText("Local environment");
  await expect(environmentPage).toContainText("Worktree");
  await expect(environmentPage).toContainText("ling/channel-environment");
  await expect(environmentPage).toContainText("1 changed file");
  await expect(environmentPage).toContainText("+12");
  await expect(environmentPage).toContainText("-3");
  await expect(environmentPage).toContainText("1 review item");
  await expect(environmentPage).toContainText("No browser evidence");
  await expect(environmentPage).toContainText("No sources");

  await environmentPage.locator(".channel-environment-section.commit").getByRole("button", { name: "Open" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit or push" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("first version is read-only");
  await expect(dialog.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Commit and push" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Push", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await environmentPage.getByRole("button", { name: "View review" }).click();
  await expect(page.locator(".channel-environment-page")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel .right-dock-head-page")).toContainText("Review");
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

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Progress" }).click();
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

  await page.getByLabel("Workspace task toolbar").getByRole("button", { name: "Progress" }).click();
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
    const runningText = element.querySelector(".conversation-work-cell-row.running .conversation-work-cell-row-copy strong, .conversation-work-cell-agent-span.running .conversation-work-cell-agent-span-copy small");
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
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const approvalBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" });
  await expect(approvalBubble).toBeVisible();
  await approvalBubble.getByRole("button", { name: "Open approval" }).click();

  const approvalOverlay = page.locator(".conversation-detail-overlay");
  await expect(approvalOverlay).toBeVisible();
  await expect(approvalOverlay).toHaveAttribute("aria-label", "Approval details");
  await expect(approvalOverlay.locator(".channel-approval-detail-panel")).toContainText("Approve shell command");
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
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
  await expect(drawer.getByRole("button", { name: "New channel" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Channel actions" })).toBeVisible();
  await expect(drawer.locator(".sidebar-section-title small")).toHaveCount(0);
  await expect(drawer.getByText("Create", { exact: true })).toHaveCount(0);
  await expect(drawer.locator(".sidebar-section:first-of-type .sidebar-section-action")).toHaveText("");
  await drawer.getByRole("button", { name: "Channel actions" }).click();
  await expect(page.getByRole("menuitem", { name: "New channel" })).toBeVisible();
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
  const engineering = drawer.locator(".sidebar-channel-group").filter({ hasText: "Engineering" }).locator(".sidebar-row-shell").first();
  const research = drawer.locator(".sidebar-channel-group").filter({ hasText: "Research" }).locator(".sidebar-row-shell").first();
  await expect(engineering.locator(".channel-mention")).toHaveCount(0);
  await expect(engineering.locator(".channel-unread")).toHaveCount(0);
  await expect(research.locator(".channel-mention")).toHaveCount(0);
  await expect(research.locator(".channel-unread")).toBeVisible();

  await research.locator(".sidebar-row-main").click();
  await expect(research).toHaveClass(/selected/);
  await expect(research.locator(".channel-unread")).toHaveCount(0);
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

test("wide channel progress popover keeps the accepted HTML spacing", async ({ page }) => {
  await useEnglishLocale(page);
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
  expect(spacing.chatWidth).toBe(960);
  expect(spacing.composerWidth).toBe(960);
  expect(spacing.attentionWidth).toBe(340);
  expect(spacing.chatTransform).not.toBe("none");
  expect(spacing.composerTransform).not.toBe("none");
  expect(spacing.gap).toBeGreaterThanOrEqual(48);
  expect(spacing.gap).toBeLessThanOrEqual(80);
  expect(spacing.overlapX).toBe(0);
});

test("channel runtime policy is visible while preferred specialist controls stay hidden", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "designer", roleKey: "designer", displayName: "Ling Designer" }),
  ];
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
  const currentManagement = page.getByLabel("Channel management");
  await expect(currentManagement.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(currentManagement).not.toContainText("Preferred specialist");
  await expect(currentManagement.getByLabel("Ling reply")).toHaveCount(0);
  await currentManagement.getByRole("button", { name: "Save channel" }).click();

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await expect(navigation.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await navigation.getByRole("menuitem", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel).toBeVisible();
  await expect(createChannelPanel.getByLabel("Execution path")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Ling reply")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(createChannelPanel).not.toContainText("Preferred specialist");
  await createChannelPanel.getByLabel("Name").fill("Release");
  await createChannelPanel.getByLabel("Status").selectOption("paused");
  await createChannelPanel.getByLabel("Execution mode").selectOption("parallel");
  await createChannelPanel.getByLabel("Write lock").selectOption("workspace");
  await createChannelPanel.getByLabel("Max runs").fill("2");
  await createChannelPanel.getByLabel("Queue on conflict").uncheck();
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();

  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Release")).toBe(true);
  const created = state.channels.find((channel) => isRecord(channel) && channel.name === "Release");
  expect(created).toBeTruthy();
  expect(isRecord(created) ? created.status : undefined).toBe("paused");
  expect(isRecord(created) ? created.defaultTeammateId : undefined).toBeUndefined();
  const runtimePolicy = isRecord(created) && isRecord(created.runtimePolicy) ? created.runtimePolicy : {};
  expect(runtimePolicy.executionMode).toBe("parallel");
  expect(runtimePolicy.writeLockScope).toBe("workspace");
  expect(runtimePolicy.maxConcurrentRuns).toBe(2);
  expect(runtimePolicy.queueOnConflict).toBe(false);
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
  await details.getByLabel("Name").fill("Release QA");
  await details.getByRole("button", { name: "Save channel" }).click();
  await expect.poll(() => {
    const updated = state.channels.find((channel) => isRecord(channel) && channel.id === (isRecord(created) ? created.id : ""));
    return isRecord(updated) ? updated.name : "";
  }).toBe("Release QA");
});

test("channel reply routing mode is not exposed in ordinary settings", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect(currentManagement.getByText("Ling Agent decides")).toHaveCount(0);

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Channel actions" }).click();
  await expect(navigation.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await navigation.getByRole("menuitem", { name: "New channel" }).click();
  const createChannelPanel = page.getByRole("dialog", { name: "New channel" });
  await expect(createChannelPanel.getByLabel("Ling reply")).toHaveCount(0);
  await expect(createChannelPanel.getByLabel("Preferred specialist")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Auto route")).toHaveCount(0);
  await expect(createChannelPanel.getByText("Ling Agent decides")).toHaveCount(0);
  await createChannelPanel.getByLabel("Name").fill("Auto Route");
  await createChannelPanel.getByRole("button", { name: "Create channel" }).click();
  await expect.poll(() => state.channels.some((channel) => isRecord(channel) && channel.name === "Auto Route")).toBe(true);
});

test("multi-role channel messages create workflow proposals instead of AI replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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

  await expect.poll(() => state.lastChannelMessageRequest?.requestAiReply).toBe(false);
  await expect.poll(() => state.channelExecutionProposals.length).toBe(1);
  await expect.poll(() => state.channelMessages.filter((message) => isRecord(message) && message.kind === "ai_reply").length).toBe(0);
  const proposal = page.getByLabel("Task confirmation");
  await expect(proposal).toContainText("Architect 先拆，Engineer 实现，QA 验证，可以吗？");
  await expect(proposal).toContainText("Engineer");
  await expect(proposal.locator(".channel-proposal-collaboration")).toContainText("Collaboration 1 records");
  await expect(proposal).toContainText("Non-direct multi-agent collaboration waits for confirmation");
  await expect(proposal).toContainText("Starting this task does not approve future runtime actions");
  await expect(proposal.getByRole("button", { name: "Authorize and start task" })).toBeVisible();
  await expect(page.getByText("AI teammate is preparing a reply...")).toHaveCount(0);
  await expect.poll(() => {
    const decision = state.channelIntentDecisions[0];
    return isRecord(decision) ? [decision.action, decision.status, decision.createdBy].join("|") : "";
  }).toBe("workflow_proposal|accepted|deterministic");
});

test("task confirmation cards explain bounded tool permission and target", async ({ page }) => {
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

  const confirmations = page.getByLabel("Task confirmation");
  await expect(confirmations).toHaveCount(3);
  const createCard = confirmations.filter({ hasText: "Create README.md" });
  await expect(createCard).toContainText("Need write permission to create /tmp/example/README.md for this task.");
  await expect(createCard).toContainText("Required tool");
  await expect(createCard).toContainText("write");
  await expect(createCard).toContainText("Target");
  await expect(createCard).toContainText("/tmp/example/README.md");
  await expect(createCard).toContainText("Executor");
  await expect(createCard).toContainText("Ling Agent");

  const editCard = confirmations.filter({ hasText: "Edit docs/guide.md" });
  await expect(editCard).toContainText("Need edit permission to update docs/guide.md for this task.");
  await expect(editCard).toContainText("edit");

  const commandCard = confirmations.filter({ hasText: "Run pnpm test" });
  await expect(commandCard).toContainText("Need bash permission to run pnpm test for this task.");
  await expect(commandCard).toContainText("bash");

  await expect(commandCard).toContainText("Starting this task does not approve future runtime actions");
  await expect(commandCard.getByRole("button", { name: "Authorize and start task" })).toBeVisible();
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

  await expect.poll(() => state.lastChannelMessageRequest?.requestAiReply).toBe(false);
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
  }).toBe("direct_workflow|accepted|deterministic");
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
  }).toBe("reply|accepted|deterministic|teammate_builtin_engineer");
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
      id: "msg_direct_workflow",
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
      id: "proposal_direct_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_direct_workflow",
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
      schemaVersion: 1,
      id: "intent_direct_workflow",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_direct_workflow",
      action: "direct_workflow",
      proposalId: "proposal_direct_workflow",
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

  const feed = page.locator(".activity-shell");
  await expect(feed.getByText("晚上好")).toBeVisible();
  await expect(feed.locator(".channel-execution-proposal").filter({ hasText: "Edit README.md" })).toBeVisible();
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

test("channel settings can add and remove teammates without preferred specialist controls", async ({ page }) => {
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
  const initialDefaultTeammateId = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering")?.defaultTeammateId;
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "AI teammate management" }).click();
  let manager = page.getByLabel("Channel teammates");
  await expect(manager).toContainText("No teammates in this channel");
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

  const directTeammates = page.getByLabel("Channel teammates");
  await expect(directTeammates.locator(".channel-teammate-chip")).toHaveCount(1);
  await expect(directTeammates).toContainText("Ling Engineer");
  await expect(directTeammates.locator(".channel-teammate-chip").filter({ hasText: "Ling Designer" })).toHaveCount(0);
  expect(state.teammateChannelMemberships.filter((item) => isRecord(item) && item.channelId === "channel_engineering")).toHaveLength(1);

  await councils.getByRole("button", { name: "Detach council" }).click();
  await expect.poll(() => {
    const policy = state.channelCouncilPolicies.find((item) => isRecord(item) && item.channelId === "channel_engineering");
    return isRecord(policy) && Array.isArray(policy.attachedCouncilIds) ? policy.attachedCouncilIds.length : -1;
  }).toBe(0);
  await expect(councils).toContainText("No AI councils attached");
  expect(state.teammateChannelMemberships.filter((item) => isRecord(item) && item.channelId === "channel_engineering")).toHaveLength(1);
  expect(consoleMessages.filter((message) => !message.includes("Failed to load resource"))).toEqual([]);
});

test("channel message feed renders AI teammate avatar images", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_builtin_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      avatarImageAttachmentId: "tpatt_designer_avatar",
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
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const designerReply = page.getByLabel("Channel message feed").locator(".channel-message-row").filter({ hasText: "Designer reply with profile avatar." });
  await expect(designerReply).toBeVisible();
  await expect(designerReply.locator(".teammate-avatar-image")).toBeVisible();
  await expect(designerReply.locator(".avatar-initial")).toHaveCount(0);
  await expect(designerReply.locator(".teammate-avatar-image")).toHaveAttribute("src", /\/attachments\/tpatt_designer_avatar\/content/);
});

test("channel message feed renders web evidence inline with sources and blocked reasons", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect(sourcedActions.locator('[data-tooltip="Copy message"]')).toHaveCount(1);
  await expect(sourcedActions.locator('[data-tooltip="Like response"]')).toHaveCount(1);
  await expect(sourcedActions.locator('[data-tooltip="Dislike response"]')).toHaveCount(1);
  await expect(sourcedActions.locator('[data-tooltip="Reply in topic"]')).toHaveCount(1);
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
  const degradedEvidence = degradedReply.getByLabel("Message evidence");
  const degradedToggle = degradedEvidence.getByRole("button");
  await expect(degradedToggle).toBeVisible();
  await expect(degradedToggle).toHaveAttribute("aria-expanded", "true");
  await expect(degradedEvidence).toContainText("Degraded reason");
  await expect(degradedEvidence).toContainText("web_search backend returned a summary but no source URLs.");
  await expect(degradedEvidence).not.toContainText("Search queries");
  await expect(degradedEvidence).not.toContainText("AI news today");
  await expect(degradedEvidence).not.toContainText("Provider");
  await expect(degradedEvidence).not.toContainText("Chat Completions Search Relay");

  const blockedReply = feed.locator(".channel-message-row").filter({ hasText: "Blocked web reply." });
  const blockedEvidence = blockedReply.getByLabel("Message evidence");
  const blockedToggle = blockedEvidence.getByRole("button");
  await expect(blockedToggle).toBeVisible();
  await expect(blockedToggle).toHaveAttribute("aria-expanded", "true");
  await expect(blockedEvidence).toContainText("Blocked reason");
  await expect(blockedEvidence).toContainText("Current selected Ling provider does not support realtime web search.");
  await expect(blockedEvidence).not.toContainText("latest Ling Stack release");

  const configuredOnlyReply = feed.locator(".channel-message-row").filter({ hasText: "Configured web search but no actual evidence." });
  await expect(configuredOnlyReply).toBeVisible();
  await expect(configuredOnlyReply.getByLabel("Message evidence")).toHaveCount(0);
  await expect(configuredOnlyReply.locator(".source-icon-stack")).toHaveCount(0);
  await expect(configuredOnlyReply).not.toContainText("OpenAI news today");
  await expect(configuredOnlyReply).not.toContainText("Custom OpenAI-compatible");
  await expect(configuredOnlyReply).not.toContainText("openai-chat-completions-web-search");
});

test("conversation turn transcript renders coordinator web evidence in the main chat", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
  const evidence = turn.getByLabel("Message evidence");
  const toggle = evidence.getByRole("button");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(evidence).toContainText("Degraded reason");
  await expect(evidence).toContainText("web_search backend returned text but no citation/source metadata.");
  await expect(evidence).not.toContainText("Search queries");
  await expect(evidence).not.toContainText("AI latest news");
  await expect(evidence).not.toContainText("Provider");
  await expect(evidence).not.toContainText("Chat Completions Search Relay");
  await expect(evidence).not.toContainText("0 sources");
});

test("channel settings manage workspace binding", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator(".channel-workspace-badge")).toHaveCount(0);

  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const details = page.getByLabel("Channel management");
  const workspaceControl = details.getByLabel("Channel workspace");
  await expect(workspaceControl).toContainText("Local");
  await workspaceControl.getByRole("button", { name: "Create worktree" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.mode : "";
  }).toBe("managed_worktree");
  await expect(workspaceControl).toContainText("Worktree");

  await workspaceControl.getByPlaceholder("External workspace path").fill("/tmp/external-channel-workspace");
  await workspaceControl.getByRole("button", { name: "Hand off to External" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.executionPath : "";
  }).toBe("/tmp/external-channel-workspace");
  await expect(workspaceControl).toContainText("External");

  await workspaceControl.getByRole("button", { name: "Hand off to Local" }).click();
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) && isRecord(channel.workspaceBinding) ? channel.workspaceBinding.mode : "";
  }).toBe("local");
  await expect(workspaceControl).toContainText("Local");
});

test("channel more menu renames the selected channel", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect(page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: /Attach files/ })).toBeVisible();
  await page.getByLabel("Message tools").getByRole("button", { name: "Add" }).click();
  await expect(page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" })).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "Send" })).toBeVisible();
  await page.getByLabel("Message tools").getByRole("button", { name: "Mention teammate" }).click();
  await expectComposerValue(composerInput, "@");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composerInput.type("Eng");
  await expect(page.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await page.getByRole("option", { name: /@Engineer/ }).click();
  await expect(page.locator(".channel-composer .composer-inline-token.mention").filter({ hasText: "Engineer" })).toBeVisible();
  await expectComposerValue(composerInput, "@Engineer ");
  await composerInput.fill("please refine without mention");
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
  await expect.poll(() => state.lastChannelMessageRequest?.providerPresetId).toBe("provider_local");
  const sentMessage = page.locator(".message-bubble").filter({ hasText: "@Engineer please refine the channel requirements" });
  await expect(sentMessage.getByRole("link", { name: /brief\.txt/ })).toBeVisible();
  await expect(sentMessage.getByRole("link", { name: /shot\.png/ })).toBeVisible();
  expect(state.channelLinkPreviews.some((preview) => isRecord(preview) && preview.title === "Example Domain")).toBe(true);
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
  await expect(sentMessage.locator(".message-meta-action")).toHaveCount(0);
  await expect(sentMessage.getByRole("button", { name: "Reply in topic" })).toHaveCount(0);
  const topicReplyButton = teammateReply.getByRole("button", { name: "Reply in topic" });
  await expect(topicReplyButton).toHaveAttribute("data-tooltip", "Reply in topic");
  await topicReplyButton.click();
  const topicPanel = page.getByLabel("Topic replies");
  await expect(topicPanel).toBeVisible();
  await expect(topicPanel).toContainText("收到，我会按频道上下文推进。");
  await topicPanel.getByLabel("Topic reply input").fill("Thread follow-up from the topic panel");
  await topicPanel.getByRole("button", { name: "Send reply" }).click();
  await expect.poll(() => state.lastChannelMessageRequest?.threadId).toBe("msg_1");
  await expect(topicPanel).toContainText("Thread follow-up from the topic panel");
});

test("channel composer snapshots restore draft assets and topic replies across channel switches", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
      body: "Snapshot reply ready.",
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
  await page.locator(".composer-drop-zone").dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByLabel("Pending message assets")).toContainText("snapshot.txt");

  const teammateReply = page.locator(".message-bubble").filter({ hasText: "Snapshot reply ready." });
  await teammateReply.hover();
  await teammateReply.getByRole("button", { name: "Reply in topic" }).click();
  const topicPanel = page.getByLabel("Topic replies");
  await expect(topicPanel).toBeVisible();
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
  const state = createBaseState({ approvalStatus: "pending" });
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
      "```ts",
      "const answer = 42;",
      "function format(value: string) {",
      "  return `Result: ${value}`;",
      "}",
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
  await expect(message).toContainText(longMixedLabel);
  await expect(message).toContainText("<script>window.__ling_p5_xss = true</script>");
  await expect(message.locator("script")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ling_p5_xss?: boolean }).__ling_p5_xss === true)).toBe(false);
  const copyMessageButton = message.getByRole("button", { name: "Copy message" });
  await copyMessageButton.focus();
  await page.keyboard.press("Enter");
  await expect(message.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lingCopiedText?: string }).__lingCopiedText ?? "")).toContain("Rich rendering probe");
  await expect(feed).not.toContainText("Copy message completed");

  const codeBlock = message.locator(".message-code-block").filter({ hasText: "const answer = 42;" });
  await expect(codeBlock.getByText("ts")).toBeVisible();
  await expect(codeBlock.locator(".code-token.keyword").filter({ hasText: "const" })).toBeVisible();
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

  const diffBlock = message.locator(".message-diff-block").filter({ hasText: "src/example.ts" });
  await expect(diffBlock).toHaveCount(1);
  await expect(diffBlock).toContainText("src/example.ts");
  await expect(diffBlock.locator(".diff-line.delete")).toContainText("-export const value = 1;");
  await expect(diffBlock.locator(".diff-line.add")).toContainText("+export const value = 2;");
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
  await expect(expandedDeferredCode.locator(".code-token")).toHaveCount(0);
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
  await expect(expandedDeferredDiff.getByRole("button", { name: /Show full diff/ })).toBeVisible();
  await expandedDeferredDiff.getByRole("button", { name: /Show full diff/ }).click();
  await expect(expandedDeferredDiff).toContainText("deferredDiffLine190");
  await expandedDeferredDiff.getByRole("button", { name: "Collapse diff details" }).click();
  await expect(message.locator(".message-diff-block.deferred")).toContainText("Large diff deferred");

  const streamingMessage = feed.locator(".message-bubble").filter({ hasText: "Streaming code stays plain" });
  await expect(streamingMessage).toBeVisible();
  await expect(streamingMessage.locator(".message-code-block").filter({ hasText: "const streaming = true;" }).locator(".code-token")).toHaveCount(0);
  const richLayout = await message.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overflowing = Array.from(element.querySelectorAll<HTMLElement>(".message-code-block, .message-diff-block, .message-body-renderer"))
      .some((node) => node.scrollWidth > Math.ceil(node.clientWidth) + 1);
    return { width: Math.round(bounds.width), overflowing };
  });
  expect(richLayout.width).toBeGreaterThan(300);
  expect(richLayout.overflowing).toBe(false);
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
  const state = createBaseState({ approvalStatus: "pending" });
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

  await expect.poll(() => state.lastChannelMessageRequest?.fileRefs).toEqual([
    {
      path: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      label: "apps/web/src/features/workspace/WorkspaceClientView.tsx",
      source: "composer",
    },
  ]);
  await expect(page.getByLabel("Workspace file references").getByText("apps/web/src/features/workspace/WorkspaceClientView.tsx")).toBeVisible();
  await expect(page.locator(".channel-composer .composer-inline-token.file-reference")).toHaveCount(0);
});

test("channel composer preserves IME composition until committed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const planButton = composer.getByRole("button", { name: "Plan Mode" });
  await expect(planButton).toBeVisible();
  await expect.poll(() => channelRoots().length).toBe(0);

  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: "Plan Mode" }).click();
  await expect.poll(() => channelRoots().length).toBe(1);
  await expect.poll(planMode).toBe("plan");
  await expect(planButton).toHaveClass(/active/);
  await expect.poll(() => state.tasks).toHaveLength(0);
  await composer.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: "Exit Plan Mode" })).toBeVisible();
  await composer.getByRole("button", { name: "Add" }).click();

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("/review apps/web");
  await composer.getByRole("button", { name: "Create task" }).click();
  await expect(composer).toContainText("Exit Plan Mode before creating implementation tasks.");
  await expect.poll(() => state.tasks).toHaveLength(0);

  await composerInput.fill("/plan off");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(planMode).toBe("default");
  await expect.poll(() => state.tasks).toHaveLength(0);
  await expectComposerValue(composerInput, "");

  await composerInput.fill("/plan status");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect(composer).toContainText("Plan Mode is off");
  await expect.poll(planMode).toBe("default");
  await expect.poll(() => state.tasks).toHaveLength(0);
});

test("channel composer manages goal lifecycle from the floating panel", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: /Goal/ }).click();
  await expectComposerValue(composerInput, "/goal ");
  await composerInput.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.insertText("Finish PR4 with a visible goal panel");
  await expectComposerValue(composerInput, "/goal Finish PR4 with a visible goal panel");
  await composer.getByRole("button", { name: "Apply command" }).click();

  const goalPanel = composer.locator(".goal-floating-panel");
  await expect.poll(() => activeGoal()?.objective).toBe("Finish PR4 with a visible goal panel");
  await expect(goalPanel).toBeVisible();
  await expect(goalPanel).toContainText("Finish PR4 with a visible goal panel");
  await expect(goalPanel).toContainText("Active");
  await expect(composer.getByRole("button", { name: "Goal", exact: true })).toHaveClass(/active/);

  await goalPanel.getByRole("button", { name: "Expand goal details" }).click();
  await expect(goalPanel).toContainText("Status: Active");
  await goalPanel.getByRole("button", { name: "Collapse goal details" }).click();

  await goalPanel.getByRole("button", { name: "Run goal" }).click();
  await expect.poll(() => String(state.lastChannelMessageRequest?.body ?? "")).toBe("Continue working toward goal: Finish PR4 with a visible goal panel");
  await expect(page.getByLabel("Channel message feed").getByText("Continue working toward goal: Finish PR4 with a visible goal panel")).toBeVisible();

  await composer.getByRole("button", { name: "Add" }).click();
  await page.getByRole("menu", { name: "Add" }).getByRole("menuitem", { name: "Plan Mode" }).click();
  await expect.poll(planMode).toBe("plan");
  const previousGoalContinuation = state.lastChannelMessageRequest;
  await goalPanel.getByRole("button", { name: "Run goal" }).click();
  await expect(composer).toContainText("Exit Plan Mode before continuing a goal.");
  await expect.poll(() => state.lastChannelMessageRequest).toBe(previousGoalContinuation);

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

  await goalPanel.getByRole("button", { name: "Clear goal" }).click();
  await expect.poll(() => activeGoal()).toBeUndefined();
  await expect(goalPanel).toHaveCount(0);
});

test("channel feed renders proposed_plan blocks as proposed plan cards", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect.poll(() => String(state.lastChannelMessageRequest?.body ?? "")).toContain("Refine this plan before implementation: PR1 + PR2 implementation");
  await expect(feed.getByText("Refine this plan before implementation: PR1 + PR2 implementation")).toBeVisible();

  await plan.getByRole("button", { name: "Implement" }).click();
  await expect.poll(planMode).toBe("default");
  await expect.poll(() => String(state.lastChannelMessageRequest?.body ?? "")).toContain("Implement accepted plan: PR1 + PR2 implementation");
  await expect.poll(() => state.tasks.find((task) => task.title === "Implement accepted plan: PR1 + PR2 implementation")?.requestedSkillId).toBe("plan-acceptance");
  await expect.poll(() => state.tasks.find((task) => task.title === "Implement accepted plan: PR1 + PR2 implementation")?.prompt ?? "").toContain("Source proposed plan: proposed_plan_msg_proposed_plan");
  await expect(feed.getByText("Implement accepted plan: PR1 + PR2 implementation")).toBeVisible();
});

test("workflow conversion preview infers owners without mutating until save", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
      id: "msg_lineage_v3",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_plan_sibling",
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

  await dock.getByRole("button", { name: "This channel" }).click();
  await expect(dock).toContainText("Plan v3 accepted");
  const acceptedRow = dock.locator(".right-dock-plan-row").filter({ hasText: "Plan v3 accepted" });
  await acceptedRow.getByRole("button", { name: "Open source" }).click();
  await expect(page.locator('[data-feed-item-id="message:msg_lineage_v3"]')).toHaveClass(/conversation-work-cell-locate-pulse/);

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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
});

test("channel local link request shows natural clarify copy without debug vocabulary", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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

  const proposal = page.getByLabel("Task confirmation");
  await expect(proposal).toContainText("Refine channel workspace copy");
  await expect(proposal).toContainText("Ling is shaping the task");
  await expect(proposal).toContainText("Goal");
  await expect(proposal).toContainText("Participants");
  await expect(proposal).toContainText("Boundary");
  await expect(proposal).toContainText("Ling Engineer");
  await expect(proposal).toContainText("Ling Designer");
  const collaboration = proposal.locator(".channel-proposal-collaboration");
  await expect(collaboration).not.toHaveAttribute("open", /.+/);
  await expect(collaboration.locator("summary")).toContainText("Collaboration 2 records");
  await expect(collaboration.locator("summary")).toContainText("Ling Engineer Summarized discussion into one execution proposal.");
  await expect(collaboration.locator("summary")).toContainText("Ling Designer Checked visual hierarchy before execution.");
  const overflowingProposalSections = await proposal.evaluate((element) => {
    const proposalRect = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll(":scope > p, .channel-proposal-meta, .channel-proposal-criteria, .channel-proposal-risk, .channel-proposal-collaboration summary"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left < proposalRect.left - 1 || rect.right > proposalRect.right + 1;
      })
      .map((node) => node.className || node.tagName.toLowerCase());
  });
  expect(overflowingProposalSections).toEqual([]);
  await expect(collaboration.locator("li").first()).not.toBeVisible();
  await collaboration.locator("summary").click();
  await expect(collaboration.locator("li").first()).toBeVisible();
  await expect(collaboration).toContainText("Coordinated");
  await expect(collaboration).toContainText("Reviewed");
  await expect(collaboration.locator(".channel-proposal-step-source")).toContainText("From Development Council");
  await proposal.getByRole("button", { name: "Edit" }).click();
  const editForm = proposal.locator(".channel-proposal-edit-form");
  await editForm.getByLabel("Scope").fill("Refine the channel workspace copy, then run focused QA checks.");
  const editSteps = editForm.locator(".channel-proposal-edit-step");
  await editSteps.nth(1).locator("select").first().selectOption("teammate_builtin_qa");
  await editSteps.nth(1).locator("textarea").fill("Run focused regression checks before execution.");
  await proposal.getByRole("button", { name: "Save" }).click();
  await expect(editForm).toHaveCount(0);
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_1");
    if (!isRecord(updated) || !Array.isArray(updated.collaborationSteps)) {
      return "";
    }
    const secondStep = updated.collaborationSteps[1];
    const sourceState = isRecord(secondStep) && Array.isArray(secondStep.sources) ? `sources:${secondStep.sources.length}` : "sources:none";
    return isRecord(secondStep) ? `${updated.prompt}|${secondStep.teammateId}|${secondStep.summary}|${sourceState}` : "";
  }).toBe("Refine the channel workspace copy, then run focused QA checks.|teammate_builtin_qa|Run focused regression checks before execution.|sources:none");
  await proposal.getByRole("button", { name: "Authorize and start task" }).click();

  await expect.poll(() => {
    const workflow = state.channelWorkflows.find((item) => isRecord(item) && item.title === "Refine channel workspace copy");
    return isRecord(workflow) ? workflow.status : undefined;
  }).toBe("running");
  await expect.poll(() => state.channelWorkflowSteps.filter((item) => isRecord(item) && item.workflowId === "workflow_1").length).toBe(2);
  await expect.poll(() => {
    const steps = state.channelWorkflowSteps.filter((item) => isRecord(item) && item.workflowId === "workflow_1");
    return steps.map((step) => isRecord(step) ? step.toParticipantId : "").join("|");
  }).toBe("teammate_builtin_engineer|teammate_builtin_qa");
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
  }).toBe("sources:none");
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
  await expect(workCell).toContainText("Ling QA");
  await expect(workCell).not.toContainText("Agent branches");
  const qaSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Ling QA" });
  await expect(qaSpan).toContainText("Run focused regression checks before execution.");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await qaSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Run focused regression checks before execution.");
  await expect(workCell.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toHaveCount(0);

  await openChannelChatTools(page);
  const acceptedProposal = feed.getByLabel("Task confirmation").filter({ hasText: "Refine channel workspace copy" });
  await expect(acceptedProposal).toBeVisible();
  await expect(acceptedProposal.getByRole("button", { name: "Open workflow" })).toHaveCount(0);
});

test("requirement shaping proposal persists clarifications before confirmation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
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

  const transcript = page.locator(".conversation-turn-assistant-transcript");
  const shapingBlock = transcript.locator(".transcript-block-view.kind-requirement_shaping");
  await expect(shapingBlock).toBeVisible();
  await expect(shapingBlock).toHaveAttribute("aria-label", "Requirement shaping");
  await expect(shapingBlock.getByRole("button", { name: "Collapse transcript block" })).toHaveAttribute("aria-expanded", "true");
  await expect(shapingBlock).toContainText("Clarify workspace copy scope before execution.");
  await expect(shapingBlock).toContainText("Needs user clarification");
  await expect(shapingBlock).toContainText("ling_agent: Clarify the task, then prepare an executable proposal.");
  await expect(shapingBlock).not.toContainText("Synced on availability only.");
  await expect(shapingBlock).toContainText("Only workspace drawer copy is in scope.");
  const decisionBlock = transcript.locator(".transcript-block-view.kind-decision_needed");
  await expect(decisionBlock).toBeVisible();
  await expect(decisionBlock).toHaveAttribute("aria-label", "Decision needed");
  await expect(decisionBlock).toContainText("Which copy sections are in scope?");

  const proposal = page.getByLabel("Task confirmation");
  await expect(proposal).toContainText("Needs user clarification");
  await expect(proposal).toContainText("Which copy sections are in scope?");
  await expect(proposal).toContainText("Only workspace drawer copy is in scope.");

  await page.reload();
  await openEngineeringChannel(page);
  await expect(proposal).toContainText("Needs user clarification");
  await expect(proposal).toContainText("Which copy sections are in scope?");
  await expect(proposal).toContainText("Only workspace drawer copy is in scope.");

  await proposal.getByRole("button", { name: "Edit" }).click();
  const editForm = proposal.locator(".channel-proposal-edit-form");
  await editForm.getByLabel("Open questions").fill("Which copy sections are in scope?\nShould QA cover accessibility?");
  await editForm.getByLabel("User clarifications").fill("Only workspace drawer copy is in scope.\nKeep provider checks out of this task.");
  await proposal.getByRole("button", { name: "Save" }).click();
  await expect(editForm).toHaveCount(0);
  await expect(proposal).toContainText("Should QA cover accessibility?");
  await expect(proposal).toContainText("Keep provider checks out of this task.");
  await expect.poll(() => {
    const updated = state.channelExecutionProposals.find((item) => isRecord(item) && item.id === "proposal_shaping");
    if (!isRecord(updated) || !isRecord(updated.shaping)) {
      return "";
    }
    const openQuestions = Array.isArray(updated.shaping.openQuestions) ? updated.shaping.openQuestions.length : 0;
    const clarifications = Array.isArray(updated.shaping.clarifications) ? updated.shaping.clarifications.length : 0;
    return `${updated.shaping.status}|${openQuestions}|${clarifications}`;
  }).toBe("needs_user_clarification|2|2");

  await proposal.getByRole("button", { name: "Authorize and start task" }).click();
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      workflowStepId: "workflow_step_completed",
      task: {
        id: "task_completed_workflow",
        title: "Create README.md",
        prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
      body: "/Users/tianxiao/ling-stack-test 下面，帮我创建一个 README.md",
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
      title: "Create /Users/tianxiao/ling-stack-test/README.md",
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
      title: "Create /Users/tianxiao/ling-stack-test/README.md",
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
      path: "/Users/tianxiao/ling-stack-test/README.md",
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
  await expect(workCell).not.toContainText("Create /Users/tianxiao/ling-stack-test/README.md");
  await expect(feed).not.toContainText("确认需求：");
  await expect(feed).not.toContainText("完成：");
  await expect(workCell).not.toContainText("Ling summary");
  await expect(workCell).not.toContainText("Outcome");
  await expect(workCell).not.toContainText("Validated");
  await expect(workCell).not.toContainText("Blockers / risks");
  await expect(workCell).not.toContainText("Next action");
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toContainText("Changed 1 file");
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toHaveCount(0);
  const docsSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Docs" });
  await expect(docsSpan).toContainText("Created the requested README file.");
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await docsSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Created the requested README file.");
  await expect(workCell.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toHaveCount(0);
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);

  await openChannelChatTools(page);
  await expect(feed.getByLabel("Task confirmation")).toContainText("Create /Users/tianxiao/ling-stack-test/README.md");
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
    },
    requestSnapshot: {
      cwd,
      providerPresetId: "provider_local",
      workflowStepId: "workflow_step_stale_terminal",
      task: {
        id: "task_stale_running_workflow",
        title: "Create README.md",
        prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
      body: "/Users/tianxiao/ling-stack-test 下面，帮我创建一个 README.md",
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
      title: "Create /Users/tianxiao/ling-stack-test/README.md",
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
      title: "Create /Users/tianxiao/ling-stack-test/README.md",
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
  await expect(workCell.locator(".conversation-work-cell-active-stream")).toHaveCount(0);
  const docsSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Docs" });
  await expect(docsSpan).toContainText("Created the requested README file.");
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await docsSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Created the requested README file.");
  await expect(feed.locator(".conversation-work-cell")).toHaveCount(1);
  await expect(page.getByLabel("Run guidance")).toHaveCount(0);
  const composer = page.getByLabel("Channel composer");
  await expect(composer.getByRole("button", { name: "Stop run" })).toHaveCount(0);
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
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toContainText("1 check passed");
  await expectPhase1MainFeedClean(feed);

  await workCell.locator(".conversation-work-cell-evidence-summary").click();
  await expect(workCell.getByLabel("Checks")).toContainText("Create login.html");
  await expect(workCell.getByLabel("Checks")).not.toContainText("succeeded");
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
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(2);

  const engineerSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Engineer" });
  await expect(engineerSpan.locator(".conversation-work-cell-agent-avatar")).toHaveCount(1);
  await expect(engineerSpan.locator(".conversation-work-cell-agent-avatar .avatar-initial")).toHaveCount(1);
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-head .conversation-work-cell-row-icon")).toHaveCount(0);
  await expect(engineerSpan).toContainText("Implement login form");
  await expect(engineerSpan).not.toContainText("Implement the login form.");
  await expect(engineerSpan).not.toContainText("Inspect existing login flow");
  await maybeCaptureR32Screenshot(page, "parallel-multi-agent-active");
  await engineerSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Existing login flow inspected.");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail .conversation-work-cell-row-icon")).toHaveCount(0);
  await engineerSpan.locator(".conversation-work-cell-agent-span-detail .conversation-work-cell-row-main").filter({ hasText: "Implement login form" }).click();
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Implement the login form.");

  const qaSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "QA" });
  await expect(qaSpan.locator(".conversation-work-cell-agent-avatar")).toHaveCount(1);
  await expect(qaSpan.locator(".conversation-work-cell-agent-avatar .avatar-initial")).toHaveCount(1);
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-head .conversation-work-cell-row-icon")).toHaveCount(0);
  await expect(qaSpan).toContainText("Prepare QA checklist");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await expect(workCell.locator(".conversation-work-cell-row-icon")).toHaveCount(0);
  await expectPhase1MainFeedClean(feed);
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
});

test("workflow context inspect details stay out of main feed expansion", async ({ page }) => {
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
  await expect(operationBubble.locator(".conversation-operation-bubble-source")).toContainText("Workflow");
  await expect(operationBubble.locator(".conversation-operation-bubble-status")).toContainText("Done");
  await expect(operationBubble.getByRole("button", { name: "Copy summary" })).toHaveCount(1);
  await expect(operationBubble).toHaveClass(/collapsed/);
  await expect(operationBubble.getByRole("button", { name: "Expand operation" })).toHaveCount(1);
  const packetSummary = feed.locator(".transcript-block-view.kind-workflow_packet_summary");
  await expect(packetSummary).toBeVisible();
  await expect(packetSummary).toContainText("Workflow packet summary");
  await expect(packetSummary).toContainText("1 context · 2 output · 1 summary");
  await packetSummary.locator(".transcript-block-view-head").click();
  await expect(packetSummary).toContainText("Context packet");
  await expect(packetSummary).toContainText("Output packet");
  await expect(packetSummary).toContainText("Fan-in summary");
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
  const engineerSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Engineer" });
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-head")).toContainText("Run focused workflow UI test");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-head")).toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  await engineerSpan.locator(".conversation-work-cell-agent-span-head").click();
  const engineerShellCard = engineerSpan.locator(".conversation-work-cell-row.shell").filter({ hasText: "Run focused workflow UI test" });
  await expect(engineerShellCard.locator(".conversation-work-cell-shell-card")).toContainText("Shell");
  await expect(engineerShellCard.locator(".conversation-work-cell-shell-card")).toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  await expect(engineerShellCard.locator(".conversation-work-cell-shell-card")).toContainText("Validate workflow detail rows.");

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
  await expect(evidenceRegion).toContainText("Update workflow evidence projection");
  await expect(evidenceRegion).toContainText("Run focused workflow UI test");
  await expect(evidenceRegion).toContainText("Handoff: Engineer -> Reviewer");
  await expect(evidenceRegion).toContainText("Approval checkpoint: Resume workflow execution");
  await expect(evidenceRegion).not.toContainText("execution_action_workflow_edit");
  await expect(evidenceRegion).not.toContainText("handoff_intent_context");
  await expect(evidenceRegion).not.toContainText("checkpoint_context_resume");
  await expect(evidenceRegion).not.toContainText("approval_context_checkpoint");
  const editActionRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Update workflow evidence projection" });
  await editActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("apps/web/src/lib/workflow-progress.ts");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("1 output recorded");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("artifact_context_inspect_file");
  const handoffRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Handoff: Engineer -> Reviewer" });
  await handoffRow.locator(".conversation-work-cell-row-main").click();
  await expect(handoffRow.locator(".conversation-work-cell-row-detail")).toContainText("Required input: Inspect the workflow evidence rows");
  await expect(handoffRow.locator(".conversation-work-cell-row-detail")).toContainText("Expected output: A reviewer verdict");
  await expect(handoffRow.locator(".conversation-work-cell-row-detail")).toContainText("Risk: Requires reviewer confirmation before shipping.");
  const checkpointRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Approval checkpoint: Resume workflow execution" });
  await checkpointRow.locator(".conversation-work-cell-row-main").click();
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).toContainText("Action: bash");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).toContainText("Resume handle: verified");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).not.toContainText("runner_handle_context_secret");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).not.toContainText("raw_resume_payload");
  const commandActionRow = evidenceRegion.locator(".conversation-work-cell-row.shell").filter({ hasText: "Run focused workflow UI test" });
  await expect(commandActionRow.locator(".conversation-work-cell-shell-card")).toContainText("Shell");
  await expect(commandActionRow.locator(".conversation-work-cell-shell-card")).toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  await commandActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(commandActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm --filter @ling-stack/web exec playwright test e2e/channel.spec.ts -g workflow");
  await maybeCaptureR32Screenshot(page, "workflow-action-details-expanded");
  expect(workflowEvidenceRequests).toHaveLength(1);
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
      body: "/Users/tianxiao/ling-stack-test 下面，帮我创建一个 README.md",
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
  await expect(feed.getByLabel("Task confirmation")).toContainText("Create README.md");
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
      prompt: "Create /Users/tianxiao/ling-stack-test/README.md.",
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
  await expect(engineerSpan).not.toContainText("Implement the collaboration card UI.");
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-toggle")).toHaveCount(1);
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await engineerSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(engineerSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Existing task card behavior inspected.");
  const inspectedStep = engineerSpan
    .locator(".conversation-work-cell-agent-span-detail .conversation-work-cell-row")
    .filter({ hasText: "Existing task card behavior inspected." });
  await expect(inspectedStep).toBeVisible();
  const docsSpan = feedWorkCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "Docs" });
  await expect(docsSpan).toContainText("Document release note");
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await docsSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(docsSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Document release note");
  const qaSpan = feedWorkCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "QA" });
  await expect(qaSpan).toContainText("Waiting for approval");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("Waiting for approval: Validate progress panel");

  await page.locator(".task-toolbar-progress").click();
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
  await expect(progressPopover).toHaveCount(0);
  const panel = page.locator(".channel-side-panel.right-dock");
  await expect(panel).toHaveAttribute("aria-label", "Channel workspace dock");
  await expect(panel).toContainText("Workspace tools");
  await expect(panel).toContainText("Review");
  await expect(panel).toContainText("Evidence");
  await expect(panel).toContainText("Files");
  await expect(panel).not.toContainText("Settings");
  await expect(panel.locator(".collaboration-task-card")).toHaveCount(0);
  await expect(panel).not.toContainText("Workflow evidence");
  await expect(panel).not.toContainText("Ship workflow UI");
});

test("completed multi-agent transcript keeps folded agent process and semantic coordinator copy", async ({ page }) => {
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
      body: "确认需求：「开始 workflow：产品策略分析登录页 smoke 的目标范围，仅输出结论。Smoke ID: single-product-20260615-2241。」。开始处理。",
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
  await expect(assistantTranscript).toContainText("产品策略分析登录页 smoke 的目标范围，仅输出结论");
  await expect(assistantTranscript).toContainText("协作队友：产品策略、QA");
  await expect.poll(() =>
    assistantTranscript.locator(".conversation-turn-assistant-transcript").evaluate((element) => {
      const childClasses = Array.from(element.children).map((child) => child.className.toString());
      const expertIndex = childClasses.findIndex((className) => className.includes("channel-team-experts-summary"));
      const actionsIndex = childClasses.findIndex((className) => className.includes("channel-message-row-footer-stack"));
      return {
        actionsIsLast: actionsIndex === childClasses.length - 1,
        expertBeforeActions: expertIndex < 0 || (actionsIndex >= 0 && expertIndex < actionsIndex),
      };
    }),
  ).toEqual({ actionsIsLast: true, expertBeforeActions: true });
  await expect(feed).not.toContainText("确认需求：");
  await expect(feed).not.toContainText("完成：");
  await expect(feed).not.toContainText("Confirm requirement");
  await expect(feed).not.toContainText("Completed:");
  await expect(feed).not.toContainText("该任务交给 产品策略、QA 处理。");
  await expect(feed).not.toContainText("Smoke ID");
  await expect(feed).not.toContainText("开始 workflow");

  const workCell = assistantTranscript.locator(".conversation-work-cell").first();
  await expandOperationBubbleIfCollapsed(workCell);
  await expect(workCell).toHaveAttribute("data-operation-source", "workflow");
  await expect(workCell).toContainText("产品策略");
  await expect(workCell.locator(".conversation-work-cell-agent-span")).toHaveCount(2);
  await expect(workCell).toContainText("读取 smoke 范围笔记");
  await expect(workCell).toContainText("运行 smoke 验收检查");
  await expect(workCell).not.toContainText("Consult");
  await expect(workCell).not.toContainText("Review");
  await expect(workCell).not.toContainText("branch_product");

  const productSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "产品策略" });
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await expect(productSpan).not.toContainText("梳理登录页 smoke 的目标范围");
  await productSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("梳理登录页 smoke 的目标范围");
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("输出验收口径");
  await expect(productSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("读取 smoke 范围笔记");
  const productActionRow = productSpan.locator(".conversation-work-cell-row").filter({ hasText: "读取 smoke 范围笔记" });
  await productActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(productActionRow.locator(".conversation-work-cell-row-detail")).toContainText("docs/login-smoke-scope.md");

  const qaSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "QA" });
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await expect(qaSpan).not.toContainText("验证验收口径覆盖登录页目标");
  await qaSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("验证验收口径覆盖登录页目标");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("确认不需要修改文件");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("运行 smoke 验收检查");
  const qaActionRow = qaSpan.locator(".conversation-work-cell-row").filter({ hasText: "运行 smoke 验收检查" });
  await qaActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(qaActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm --filter @ling-stack/web test:e2e -- login-smoke");
  await maybeCaptureR32Screenshot(page, "serial-multi-agent-expanded");
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
  const qaSpan = workCell.locator(".conversation-work-cell-agent-span").filter({ hasText: "QA" });
  await expect(qaSpan).toContainText("验证登录页 smoke 目标范围");
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toHaveCount(0);
  await qaSpan.locator(".conversation-work-cell-agent-span-head").click();
  await expect(qaSpan.locator(".conversation-work-cell-agent-span-detail")).toContainText("验证登录页 smoke 目标范围");
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.locator("article.task-detail")).toHaveCount(0);
  await expect(page.locator('[aria-label="Channel activity"] > .panel-title')).toHaveCount(0);
  const scrollState = await readScrollState(page, ".activity-shell .message-feed");
  expect(scrollState.max).toBeGreaterThan(0);
  await page.locator(".activity-shell .message-feed").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
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
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(latestButton).toBeVisible();
  await expect.poll(async () => {
    const latestButtonBox = await latestButton.boundingBox();
    return {
      width: Math.round(latestButtonBox?.width ?? 0),
      height: Math.round(latestButtonBox?.height ?? 0),
    };
  }).toMatchObject({ width: 42, height: 42 });
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
  const backgroundToast = page.getByRole("button", { name: /Background work needs attention/ });
  await expect(backgroundToast).toBeVisible();
  await expect(backgroundToast).toContainText("Jump to latest");
  await backgroundToast.click();
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect(feed).toHaveAttribute("title", /Alt\+Up\/Down/);
  await feed.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-feed-item-id") ?? "")).toBe("conversation-turn:msg_focus_1");
  await page.keyboard.press("Control+Shift+C");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lingCopiedText?: string }).__lingCopiedText ?? "")).toContain("Focused block alpha.");
  await expect(page.locator(".conversation-block-feedback")).toContainText("Copied focused block");

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
  const state = createBaseState({ approvalStatus: "pending" });
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
});

test("channel message feed preserves the visible anchor while active content grows above it", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  await feed.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    element.scrollTop = 520;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await expect.poll(async () => (await readFirstVisibleFeedAnchor(page))?.id ?? "").not.toBe("");
  const anchorBefore = await readFirstVisibleFeedAnchor(page);
  if (!anchorBefore) {
    throw new Error("Visible feed anchor missing before content growth");
  }
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
  await openEngineeringChannel(page);

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
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
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
  await expect(composer.locator(".composer-status-row.success")).toContainText("Message sent");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("Message sent");
  await expect(page.getByText("Message failed")).toHaveCount(0);
});

test("channel composer moves sent messages into the feed while routing is pending", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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

test("channel conversation turn shows thinking for empty pending ai replies", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect(channelFeed.locator(".conversation-turn-assistant-copy").getByText("正在思考...")).toBeVisible();
});

test("channel URL preview blocked state stays in Activity and still allows sending text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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
  const state = createBaseState({ approvalStatus: "pending" });
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

  await openChannelChatTools(page);
  const workflowBubble = page.locator(".message-bubble").filter({ hasText: "Workflow" }).filter({ hasText: "Seed workflow" });
  await expect(workflowBubble).toBeVisible();
  await expect(workflowBubble.getByRole("button", { name: "Review source" })).toBeVisible();
  await workflowBubble.getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);
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
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toContainText("2 artifacts");
  await expect(workCell.locator(".conversation-work-cell-evidence-summary")).toContainText("Changed 1 file");
  await expect(workCell.getByLabel("Artifacts")).toContainText("WorkspaceClientView.tsx");
  await expect(workCell.getByLabel("Artifacts")).toContainText("channel-transcript.png");
  await expect(workCell.getByRole("button", { name: /Preview: WorkspaceClientView\.tsx/ })).toBeVisible();
  await expect(workCell.getByRole("button", { name: /Preview: channel-transcript\.png/ })).toBeVisible();
  await expect(workCell.locator(".conversation-work-cell-artifact-thumb img")).toHaveCount(1);
  const defaultOperationStream = workCell.locator(".conversation-work-cell-active-stream");
  await expect(defaultOperationStream).toContainText("Render conversation work cell");
  await expect(defaultOperationStream).toContainText("Run typecheck");
  const defaultCommandActionRow = defaultOperationStream.locator(".conversation-work-cell-row.shell").filter({ hasText: "Run typecheck" });
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-shell-card")).toContainText("Shell");
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-shell-card")).toContainText("$ pnpm typecheck");
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-shell-card")).toContainText("Validate the workspace client rendering.");
  await defaultCommandActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(defaultCommandActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm typecheck");
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
  await expect(evidenceRegion).toContainText("Render conversation work cell");
  await expect(evidenceRegion).toContainText("Run typecheck");
  await expect(evidenceRegion).toContainText("Trace: Agent run");
  await expect(evidenceRegion).toContainText("Trace: Tool call");
  await expect(evidenceRegion).toContainText("Approval checkpoint: Approve typecheck");
  await expect(evidenceRegion).not.toContainText("artifact_thread_diff");
  await expect(evidenceRegion).not.toContainText("trace_thread_thread_inspect");
  await expect(evidenceRegion).not.toContainText("span_trace_thread_thread_inspect");
  await expect(evidenceRegion).not.toContainText("checkpoint_thread_resume");
  await expect(evidenceRegion).not.toContainText("approval_thread_checkpoint");
  await expect(evidenceRegion).not.toContainText("run_failed");
  const editActionRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Render conversation work cell" });
  await editActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).toContainText("1 output recorded");
  await expect(editActionRow.locator(".conversation-work-cell-row-detail")).not.toContainText("artifact_thread_diff");
  const commandActionRow = evidenceRegion.locator(".conversation-work-cell-row.shell").filter({ hasText: "Run typecheck" });
  await expect(commandActionRow.locator(".conversation-work-cell-shell-card")).toContainText("$ pnpm typecheck");
  await commandActionRow.locator(".conversation-work-cell-row-main").click();
  await expect(commandActionRow.locator(".conversation-work-cell-row-detail")).toContainText("$ pnpm typecheck");
  const checkpointRow = evidenceRegion.locator(".conversation-work-cell-row").filter({ hasText: "Approval checkpoint: Approve typecheck" });
  await checkpointRow.locator(".conversation-work-cell-row-main").click();
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).toContainText("Action: bash");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).toContainText("Status: Resumed");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).toContainText("Resume handle: verified");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).not.toContainText("runner_handle_thread_secret");
  await expect(checkpointRow.locator(".conversation-work-cell-row-detail")).not.toContainText("raw_thread_resume_payload");
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
  const lightbox = page.locator(".artifact-preview-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole("button", { name: "Close preview" })).toBeFocused();
  await expect(lightbox).toContainText("channel-transcript.png");
  await expect(lightbox.locator(".image-compare-frame img")).toHaveAttribute("src", /\/artifacts\/artifact_thread_screenshot\/content/);
  await expect(lightbox.getByRole("button", { name: "Single" })).toHaveAttribute("aria-pressed", "true");
  await lightbox.getByRole("button", { name: "Side by side" }).click();
  await expect(lightbox.locator(".image-compare-side-by-side")).toContainText("Before");
  await expect(lightbox.locator(".image-compare-side-by-side")).toContainText("After");
  await expect(lightbox.locator(".image-compare-side-by-side img")).toHaveCount(2);
  await lightbox.getByRole("button", { name: "Slider" }).click();
  await expect(lightbox.locator(".image-compare-slider-stage img")).toHaveCount(2);
  await expect(lightbox.locator(".image-compare-slider input[type='range']")).toHaveValue("50");
  await lightbox.getByRole("button", { name: "Diff overlay" }).click();
  await expect(lightbox.locator(".image-compare-diff-overlay img")).toHaveCount(2);
  const openedPagePromise = page.context().waitForEvent("page");
  await lightbox.getByRole("link", { name: "Open" }).click();
  const openedPage = await openedPagePromise;
  await expect(lightbox.locator(".artifact-preview-action-feedback")).toContainText("Opened");
  await openedPage.close();
  await lightbox.getByRole("link", { name: "Download file" }).evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), { capture: true, once: true });
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await expect(lightbox.locator(".artifact-preview-action-feedback")).toContainText("Download started");
  await expect(workCell).toContainText("Run typecheck");
  await lightbox.getByRole("button", { name: "Close preview" }).click();
  await expect(lightbox).toHaveCount(0);
  await expect(screenshotPreviewButton).toBeFocused();
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

test("active conversation work cell renders sparse rows while runtime approvals stay in composer overlay", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
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
  await expect(workCell).not.toContainText("Task waiting for approval");
  await expect(workCell).not.toContainText("Waiting for approval to continue.");
  await expect(workCell.getByLabel("Active work stream")).toContainText("Waiting for approval");
  await expect(workCell.getByLabel("Active work stream")).toContainText("Approve shell command");
  await expect(workCell.getByRole("button", { name: "Open workflow evidence" })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(workCell.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);

  const composer = page.getByLabel("Channel composer");
  const overlay = composer.getByLabel("Composer approval overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Runtime approval needed");
  await expect(overlay).toContainText("Highest risk: medium");
  await expect(overlay).toContainText("Approve shell command");
  await expect(workCell.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await overlay.getByRole("button", { name: "Approve" }).click();
  await expect(composer.getByLabel("Composer approval overlay")).toHaveCount(0);
  await expect(composer).not.toContainText("Approve shell command");
  expect(state.approvals.find((approval) => isRecord(approval) && approval.id === "approval_1")?.status).toBe("approved");
  expect(state.approvalPolicy.toolDecisions.bash).toBe("ask");
  expect(state.approvalPolicy.toolDecisions.write).toBe("ask");
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
  state.approvals = [];
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "running", currentRunId: run.id, updatedAt: run.updatedAt }
    : task);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const guidance = page.getByLabel("Run guidance");
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("Type guidance in the message box and press Enter to queue it.");
  const composer = page.getByLabel("Channel composer");
  const composerInput = channelComposerTextbox(composer);
  await expect(composerInput).toHaveAttribute("title", "Enter queues guidance. Shift+Enter inserts a newline. Esc closes menus.");
  await composerInput.fill("完成后也更新 docs");
  await composerInput.press("Enter");

  await expect.poll(() => state.runInterventions.length).toBe(1);
  await expect(composer.locator(".composer-status-row.success")).toContainText("Guidance queued");
  await expect(guidance).toContainText("完成后也更新 docs");
  expect(state.runInterventions[0]).toMatchObject({
    sourceRunId: run.id,
    mode: "queue_followup",
    status: "queued",
    instruction: "完成后也更新 docs",
  });
  expect(state.channelMessages).toHaveLength(0);
  expect(state.channelExecutionProposals).toHaveLength(0);

  await expectComposerValue(composerInput, "");
  await composerInput.fill("停，改用 daemon API");
  await expect(composer.getByRole("button", { name: "Queue guidance" })).toBeEnabled();
  await expect(composer.getByRole("button", { name: "Queue guidance" })).toHaveAttribute("title", "Queue guidance (Enter)");
  await composer.getByRole("button", { name: "Queue guidance" }).click();
  await expect.poll(() => state.runInterventions.map((item) => item.instruction)).toEqual([
    "完成后也更新 docs",
    "停，改用 daemon API",
  ]);
  await expectComposerValue(composerInput, "");
  await composer.getByRole("button", { name: "Stop run" }).click();

  await expect.poll(() => state.runs.find((item) => item.id === run.id)?.status).toBe("cancelled");
  expect(state.runInterventions).toHaveLength(2);
  expect(state.channelMessages).toHaveLength(0);
  expect(state.channelExecutionProposals).toHaveLength(0);
});

test("composer approval overlay groups multiple local approvals and excludes review queue actions", async ({ page }) => {
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

  const overlay = page.getByLabel("Channel composer").getByLabel("Composer approval overlay");
  await expect(overlay).toContainText("Runtime approvals needed");
  await expect(overlay).toContainText("Highest risk: high");
  const primaryApproval = overlay.locator(".inline-approval-item.primary");
  await expect(primaryApproval).toContainText("Approve file write");
  await expect(primaryApproval).not.toContainText("Approve shell command");
  await expect(overlay).not.toContainText("Approve external send");

  await overlay.getByText("Show other approvals").click();
  await expect(overlay).toContainText("Approve shell command");
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
  await openEngineeringChannel(page);

  const messageBubble = page.locator(".channel-message-row").filter({ hasText: "Timeline source message" });
  const taskEventBubble = page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" });
  const runEventBubble = page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" });
  const approvalEventBubble = page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" });
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
  await channelComposerTextbox(composer).fill("@Eng");
  await expect(composer.getByRole("option", { name: /@Engineer/ })).toBeVisible();
  await composer.getByRole("option", { name: /@Engineer/ }).click();
  await expect(composer.locator(".composer-inline-token.mention").filter({ hasText: "Engineer" })).toBeVisible();

  await openDetailsFrom(taskEventBubble, "Inspect workspace");
  await openDetailsFrom(runEventBubble, "Run run_failed");
  await openDetailsFrom(approvalEventBubble, "Approve shell command");
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
  await expectApprovalDetailOverlay(page, "Approve shell command");
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
  await expect(savedViewSelect).toContainText("Failed (3)");
  await expect(savedViewSelect).toContainText("Pending approvals (1)");
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
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
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
  await expect(runEventBubble).toBeVisible();
  await runEventBubble.getByRole("button", { name: "Details" }).click();
  await expect(activityDetails).toContainText("Run run_failed");
  await expect(searchInput).toHaveValue("run_failed");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await activityDetails.getByLabel("Close details").click();
  await expect(searchInput).toHaveValue("run_failed");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Saved view name");
    await dialog.accept("Run failures");
  });
  await activityFilters.getByRole("button", { name: "Save view" }).click();
  await expect(savedViewOption("Run failures")).toHaveCount(1);

  await page.reload();
  await openEngineeringChannel(page);
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

  await page.locator(".message-bubble").filter({ hasText: "Task event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Show in transcript" }).click();
  await expectConversationReviewSurface(page);

  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Run event" }).filter({ hasText: "Inspect workspace" }).getByRole("button", { name: "Show in transcript" }).click();
  await expectConversationReviewSurface(page);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Approval event" }).filter({ hasText: "Approve shell command" }).getByRole("button", { name: "Open approval" }).click();
  await expectApprovalDetailOverlay(page, "Approve shell command");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  await page.locator(".message-bubble").filter({ hasText: "Workflow step" }).filter({ hasText: "Blocked timeline step" }).getByRole("button", { name: "Review source" }).click();
  await expectConversationReviewSurface(page);
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
  await openEngineeringChannel(page);

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
  await activityDetails.getByLabel("Triage title").fill("Decision: approval stays pending");
  await activityDetails.getByLabel("Decision text").fill("Keep the approval pending until the user reviews the shell command.");
  await activityDetails.getByRole("button", { name: "Run triage action" }).click();
  await expect.poll(() => state.channelDecisions.some((decision) => isRecord(decision) && decision.title === "Decision: approval stays pending")).toBe(true);
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
  const expandButton = workCell.locator(".conversation-operation-bubble-toggle[aria-expanded='false']");
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
