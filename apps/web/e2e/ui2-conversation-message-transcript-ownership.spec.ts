import { readFile, readdir } from "node:fs/promises";
import { timelineBatchGroup } from "./support/timeline-batch-group";
import { timelineResponseFooter } from "./support/timeline-response-footer";
import { expandTimelineProcesses } from "./support/timeline-process";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { expectMessageInteractionPolicy } from "./support/message-interaction-policy";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const packageSourceDirectory = fileURLToPath(new URL(
  "../../../packages/conversation-ui-react/src/",
  import.meta.url,
));

test("1440x960 Ling Light owns a complete Channel Timeline and action feedback", async ({ page }) => {
  await prepareSurface(page, {
    height: 960,
    theme: "light",
    width: 1440,
    workCellDemo: true,
  });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = installChannelTranscriptFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const timeline = feed.locator(`[data-conversation-timeline="true"][data-conversation-thread-id="${threadId}"][data-conversation-timeline-depth="0"]`);
  await expect(timeline).toBeVisible();
  const sourceRow = timeline.locator('[data-conversation-timeline-message][data-conversation-timeline-depth="0"]').filter({
    hasText: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去",
  }).locator("[data-conversation-message-row]").first();
  const assistantRow = timeline.locator('[data-conversation-timeline-message][data-conversation-timeline-depth="0"]').filter({
    hasText: "频道操作已完成，并保留 Host evidence。",
  }).locator("[data-conversation-message-row].channel-message-row.ai-teammate").first();
  const blockedRow = feed.locator(".channel-message-row.blocked").filter({
    hasText: "Blocked channel response remains visible",
  });
  await expect(sourceRow).toHaveCount(1);
  await expect(assistantRow).toHaveCount(1);
  await expect(blockedRow).toHaveCount(1);
  await expectMessageFrameContained(sourceRow);
  await expectMessageFrameContained(assistantRow);
  await expectOwnMessageBubble(sourceRow);
  await expectMessageInteractionPolicy(sourceRow, "user", "Copy message");
  await expectMessageInteractionPolicy(assistantRow, "assistant", "Copy message");
  await expect(blockedRow).toContainText("Blocked channel response remains visible");
  await expect(blockedRow.getByRole("alert")).toHaveCount(0);
  await expect(blockedRow.locator(".message-action-bar")).toHaveCount(0);

  await expandTimelineProcesses(timeline);
  const commandBatch = timeline.locator('[data-conversation-timeline-kind="commandBatch"][data-conversation-timeline-depth="0"]');
  await expect(commandBatch).toBeVisible();
  await expect(commandBatch).toHaveAttribute("data-conversation-batch-count", "3");
  await commandBatch.locator(".conversation-command-batch-header").click();
  await expect((await timelineBatchGroup(commandBatch)).locator('[data-conversation-timeline-kind="commandExecution"]')).toHaveCount(3);

  const action = await exerciseActionBar(assistantRow, "Copy message");
  await expectActionHitArea(action);
  await expectNoHorizontalOverflow(page, [feed, timeline, sourceRow, assistantRow]);
  await positionForCapture(assistantRow);
  await action.hover();
  await expectRadixTooltip(page, "Copy message");
  await captureEvidence(page, "1440x960-ling-light-channel-turn-transcript.png");
  await expectAggregateAndDeadSelectorsReleased();
  runtime.expectClean();
});

test("1280x800 Ling Dark keeps Normal message states independent from Channel ownership", async ({ page }) => {
  await prepareSurface(page, {
    height: 800,
    reducedMotion: true,
    theme: "dark",
    width: 1280,
  });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalOwnershipFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openNormalConversation(page, title);

  const conversation = page.getByLabel("Conversation page");
  const feed = conversation.getByLabel("Conversation messages", { exact: true });
  const rows = feed.locator("[data-conversation-message-row].normal-conversation-message-row");
  await expect(rows).toHaveCount(8);
  expect(await rows.evaluateAll((elements) => elements.every((element) =>
    !element.classList.contains("channel-message-row")
  ))).toBe(true);

  const own = rows.filter({ hasText: "Normal ownership ready prompt" });
  const ready = rows.filter({ hasText: "Normal ownership ready response" });
  const pending = rows.filter({ hasText: "Normal ownership response is still streaming" });
  const failed = rows.filter({ hasText: "Normal ownership provider failed" });
  for (const state of ["ready", "pending", "failed"]) {
    const ordered = await rows.evaluateAll((elements, state) => elements
      .map(element => element.textContent ?? "").filter(text => text.includes(`Normal ownership ${state} prompt`)
        || text.includes(state === "pending" ? "Normal ownership response is still streaming"
          : state === "failed" ? "Normal ownership provider failed" : "Normal ownership ready response")), state);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toContain(`Normal ownership ${state} prompt`);
  }
  await expect(own).toHaveClass(/message-bubble-own/u);
  await expectOwnMessageBubble(own);
  await expect(own).toHaveAttribute("data-has-avatar", "false");
  await expect(own.locator(":scope > :is(.user-profile-avatar, .avatar-initial, img)")).toHaveCount(0);
  await expect(ready).toHaveClass(/message-bubble-peer/u);
  await expect(ready).toHaveAttribute("data-has-avatar", "false");
  await expect(ready.locator(":scope > :is(.user-profile-avatar, .avatar-initial, img)")).toHaveCount(0);
  await expect(ready).toHaveClass(/message-row-identity-sr-only/u);
  await expect(ready.locator(":scope > .message-content > header")).toHaveCSS("clip-path", "inset(50%)");
  await expectSharedConversationBodyTypography(ready);
  await expect(pending).toHaveClass(/message-bubble-pending/u);
  await expect(pending.locator(".message-pending-spinner")).toBeVisible();
  await expect(failed).toHaveClass(/failed/u);
  await expect(failed.locator(".normal-conversation-message-error")).toHaveCount(0);
  await expectMessageInteractionPolicy(own, "user", "Copy message");
  await expectMessageInteractionPolicy(ready, "assistant", "Copy message");
  await expectMessageInteractionPolicy(failed, "assistant", "Copy message");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await (await exerciseActionBar(failed, "Copy message")).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Normal ownership provider failed");
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain("Normal ownership ready response");
  const workCells = feed.locator('[data-conversation-timeline="true"]');
  expect(await workCells.count()).toBeGreaterThanOrEqual(1);
  await expect(workCells.first()).toBeVisible();

  await expectMessageFrameContained(own);
  await expectMessageFrameContained(ready);
  await expectMessageFrameContained(pending);
  await expectMessageFrameContained(failed);
  const like = await exerciseActionBar(ready, "Like response");
  await like.click();
  await expect(like).toHaveClass(/selected/u);
  await like.focus();
  await expect(like).toBeFocused();
  await expectActionHitArea(like);
  await expectReducedMotion(page, [rows, feed.locator(".message-action-bar")]);
  await expectNoHorizontalOverflow(page, [conversation, feed, rows, workCells]);
  await positionForCapture(ready);
  await ready.hover();
  await like.hover();
  await expectRadixTooltip(page, "Like response");
  await captureEvidence(page, "1280x800-ling-dark-normal-message-states.png");
  runtime.expectClean();
});

test("1440x960 imported Quiet Ocean keeps Teammate identity, attachments, Memory, blocked state, and actions aligned", async ({ page }) => {
  await prepareSurface(page, {
    height: 960,
    theme: "light",
    width: 1440,
  });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammate = installTeammateOwnershipFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await openTeammate(page, teammate.displayName);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);

  const chat = page.getByLabel("Private chat", { exact: true });
  const feed = chat.getByLabel("Private message feed", { exact: true });
  const rows = feed.locator("[data-conversation-message-row].teammate-message-row");
  await expect(rows).toHaveCount(3);
  const own = rows.filter({ hasText: "Own private ownership note" });
  const peer = rows.filter({ hasText: "Peer response with attachment and Memory" });
  const blocked = rows.filter({ hasText: "Private ownership request is blocked" });
  await expect(own).toHaveClass(/message-bubble-own/u);
  await expectOwnMessageBubble(own);
  await expect(peer).toHaveClass(/message-bubble-peer/u);
  await expectSharedConversationBodyTypography(peer);
  await expect(blocked).toHaveClass(/message-bubble-chat-blocked/u);
  await expect(blocked.getByRole("alert")).toContainText("Private ownership request is blocked");
  await expect(peer.getByRole("link", { name: "message-ownership-notes.md" })).toBeVisible();
  await expectMessageInteractionPolicy(own, "user", "Copy message");
  await expectMessageInteractionPolicy(peer, "assistant", "Copy message");
  await expect(blocked.locator(".message-action-bar")).toHaveCount(0);

  const memoryToggle = peer.locator(".conversation-evidence-toggle");
  await memoryToggle.click();
  await expect(peer.getByText("Message ownership memory", { exact: true })).toBeVisible();
  await expectMessageFrameContained(own);
  await expectMessageFrameContained(peer);
  await expectMessageFrameContained(blocked);
  await expectPeerContentTopAligned(peer);

  const copy = await exerciseActionBar(peer, "Copy message");
  await expectActionHitArea(copy);
  await expectNoHorizontalOverflow(page, [chat, feed, rows, peer.locator(".message-evidence-panel")]);
  await positionForCapture(peer);
  await copy.hover();
  await expectRadixTooltip(page, "Copy message");
  await captureEvidence(page, "1440x960-quiet-ocean-teammate-message-states.png");
  runtime.expectClean();
});

function installChannelTranscriptFixture(state: MockState): string {
  const { threadId } = installChannelWorkCellFixture(state, "transcript_contract");
  const source = state.channelMessages.find((message) => message.threadId === threadId);
  if (!source) throw new Error("Channel Timeline fixture did not create a source message.");
  const createdAt = "2026-07-24T03:00:00.000Z";
  Object.assign(source, {
    body: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去",
    intent: "task",
    createdAt,
    updatedAt: createdAt,
  });
  state.channelMessages = [
    ...state.channelMessages,
    {
      id: "message_ui2_transcript_coordinator_result",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: source.id,
      kind: "ai_reply",
      intent: "task",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "频道操作已完成，并保留 Host evidence。",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-07-24T03:01:00.000Z",
      updatedAt: "2026-07-24T03:01:00.000Z",
    },
    {
      id: "message_ui2_blocked_visual_contract",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "Blocked channel response remains visible",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "blocked",
      createdAt: "2026-07-24T03:02:00.000Z",
      updatedAt: "2026-07-24T03:02:00.000Z",
    },
  ];
  state.channelExecutionProposals = [];
  state.tasks = [];
  state.approvals = [];
  return threadId;
}

async function expectSharedConversationBodyTypography(row: Locator): Promise<void> {
  const body = row.locator(".message-body-renderer").first();
  await expect(body).toBeVisible();
  const styles = await body.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      color: computed.color,
      fontSize: computed.fontSize,
      fontWeight: Number(computed.fontWeight),
    };
  });
  expect(styles.color).not.toBe("transparent");
  expect(styles.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.fontSize).toBe("15px");
  expect(styles.fontWeight).toBe(550);
}

function installNormalOwnershipFixture(state: MockState): string {
  const title = installNormalWorkCellFixture(state);
  const thread = state.threads[0];
  if (!thread) throw new Error("Normal WorkCell fixture did not create a thread.");
  const threadId = thread.id;
  addNormalTurn(state, {
    body: "Normal ownership ready response",
    id: "ready",
    prompt: "Normal ownership ready prompt",
    status: "succeeded",
    timestamp: "2026-07-24T03:02:00.000Z",
    threadId,
  });
  addNormalTurn(state, {
    body: "Normal ownership response is still streaming",
    id: "pending",
    prompt: "Normal ownership pending prompt",
    status: "running",
    timestamp: "2026-07-24T03:03:00.000Z",
    threadId,
  });
  addNormalTurn(state, {
    body: "Normal ownership provider failed",
    id: "failed",
    prompt: "Normal ownership failed prompt",
    status: "failed",
    timestamp: "2026-07-24T03:04:00.000Z",
    threadId,
  });
  Object.assign(thread, {
    activeRunId: "run_ui2_normal_ownership_pending",
    lastRunId: "run_ui2_normal_ownership_failed",
    status: "running",
    updatedAt: "2026-07-24T03:04:00.000Z",
  });
  return title;
}

function addNormalTurn(state: MockState, input: {
  readonly body: string;
  readonly id: "ready" | "pending" | "failed";
  readonly prompt: string;
  readonly status: "succeeded" | "running" | "failed";
  readonly threadId: string;
  readonly timestamp: string;
}): void {
  const template = state.runs[0];
  if (!template) throw new Error("Normal WorkCell fixture did not create a run template.");
  const turnId = `turn_ui2_normal_ownership_${input.id}`;
  const runId = `run_ui2_normal_ownership_${input.id}`;
  const runTimestamp = new Date(Date.parse(input.timestamp) + 1).toISOString();
  state.turns.push({
    id: turnId,
    workspaceId: "workspace_default",
    threadId: input.threadId,
    kind: "manual_followup",
    status: input.status,
    title: input.prompt,
    userInstruction: input.prompt,
    activeRunId: input.status === "running" ? runId : undefined,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: input.timestamp,
    updatedAt: runTimestamp,
    completedAt: input.status === "succeeded" || input.status === "failed" ? runTimestamp : undefined,
  });
  state.turnRunLinks.push({
    turnId,
    runId,
    attemptNumber: 1,
    role: "primary",
    createdAt: input.timestamp,
  });
  state.runs.unshift({
    ...template,
    id: runId,
    status: input.status,
    taskId: `task_ui2_normal_ownership_${input.id}`,
    taskSnapshot: { id: `task_ui2_normal_ownership_${input.id}`, title: input.prompt },
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId: input.threadId,
    turnId,
    createdAt: runTimestamp,
    startedAt: runTimestamp,
    updatedAt: runTimestamp,
    endedAt: input.status === "succeeded" || input.status === "failed" ? runTimestamp : undefined,
  });
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: runTimestamp,
    type: "assistant_text_delta",
    data: { text: input.body },
  }];
  if (input.status === "failed") {
    // Failure narration remains commentary; its committed Host report owns final copy.
    const report = completedTerminalReport({ id: `report_${runId}`, threadId: input.threadId,
      turnId, runId, title: "Provider execution failed" });
    state.terminalReports.push({ ...report, createdAt: runTimestamp, committedAt: runTimestamp,
      outcome: { ...report.outcome, status: "failed", summary: "The provider stopped after producing partial output." } });
  }
}

function installTeammateOwnershipFixture(state: MockState): {
  readonly displayName: string;
  readonly teammateId: string;
} {
  const teammateId = "teammate_ui2_message_ownership";
  const displayName = "UI2 Message Engineer";
  const threadId = `tdthread_${teammateId}`;
  const timestamp = "2026-07-24T03:10:00.000Z";
  state.providers = [createChatProvider({
    id: "provider_ui2_message_ownership",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName,
    providerPresetId: "provider_ui2_message_ownership",
  })];
  state.teammatePrivateAttachments = [{
    id: "attachment_ui2_message_ownership",
    workspaceId: "workspace_default",
    teammateId,
    threadId,
    messageId: "message_ui2_message_ownership_peer",
    scope: "teammate_direct_thread",
    kind: "document",
    fileName: "message-ownership-notes.md",
    contentType: "text/markdown",
    sizeBytes: 768,
    path: `teammates/${teammateId}/direct/${threadId}/message-ownership-notes.md`,
    createdAt: timestamp,
  }];
  state.memoryObjects = [{
    id: "memory_ui2_message_ownership",
    workspaceId: "workspace_default",
    scopeType: "teammate",
    ownerId: teammateId,
    title: "Message ownership memory",
    body: "Keep author, time, attachments, Memory, and actions inside the shared row contract.",
    tags: ["ui2", "message"],
    sourceRefs: [],
    reviewState: "active",
    enabled: true,
    sensitivity: "private",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.usedMemoryEvents = [{
    id: "used_memory_ui2_message_ownership",
    workspaceId: "workspace_default",
    memoryIds: ["memory_ui2_message_ownership"],
    intent: "private-chat",
    recallQuery: "message ownership",
    teammateId,
    responseId: "message_ui2_message_ownership_peer",
    policyVersion: "ling-memory-v1-lexical",
    createdAt: timestamp,
  }];
  state.teammateDirectMessages = [
    teammateMessage({
      authorType: "local-user",
      body: "Own private ownership note",
      createdAt: timestamp,
      id: "message_ui2_message_ownership_own",
      teammateId,
      threadId,
    }),
    {
      ...teammateMessage({
        authorType: "ai-teammate",
        body: "Peer response with attachment and Memory",
        createdAt: "2026-07-24T03:11:00.000Z",
        id: "message_ui2_message_ownership_peer",
        teammateId,
        threadId,
      }),
      attachmentIds: ["attachment_ui2_message_ownership"],
    },
    teammateMessage({
      authorType: "ai-teammate",
      body: "Private ownership request is blocked",
      createdAt: "2026-07-24T03:12:00.000Z",
      errorMessage: "Private ownership request is blocked",
      id: "message_ui2_message_ownership_blocked",
      status: "blocked",
      teammateId,
      threadId,
    }),
  ];
  return { displayName, teammateId };
}

function teammateMessage(input: {
  readonly authorType: "local-user" | "ai-teammate";
  readonly body: string;
  readonly createdAt: string;
  readonly errorMessage?: string;
  readonly id: string;
  readonly status?: "ready" | "blocked";
  readonly teammateId: string;
  readonly threadId: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    threadId: input.threadId,
    teammateId: input.teammateId,
    authorType: input.authorType,
    authorId: input.authorType === "ai-teammate" ? input.teammateId : "local-user",
    body: input.body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: input.status ?? "ready",
    errorMessage: input.errorMessage,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

async function prepareSurface(page: Page, options: {
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly theme: "light" | "dark";
  readonly width: number;
  readonly workCellDemo?: boolean;
}): Promise<void> {
  await page.setViewportSize({ height: options.height, width: options.width });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript(({ theme, workCellDemo }) => {
    const override = sessionStorage.getItem("ling-stack.e2eThemeSelection");
    const selection = override
      ? JSON.parse(override)
      : { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
    if (workCellDemo) localStorage.setItem("ling-stack.workCellDemo", "true");
  }, { theme: options.theme, workCellDemo: options.workCellDemo });
}

async function openNormalConversation(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function openTeammate(page: Page, displayName: string): Promise<void> {
  await page.getByRole("button", { name: displayName, exact: true }).click();
  await expect(page.getByRole("heading", { name: displayName, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
}

async function exerciseActionBar(row: Locator, actionLabel: string): Promise<Locator> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const actionBar = (await timelineResponseFooter(row)).locator(".message-action-bar");
  await (await timelineResponseFooter(row)).hover();
  await expect(actionBar).toBeVisible();
  await expect.poll(() => actionBar.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeGreaterThan(0.99);
  const action = actionBar.getByRole("button", { name: actionLabel, exact: true });
  await action.hover();
  await expectRadixTooltip(row.page(), actionLabel);
  await action.focus();
  await expect(action).toBeFocused();
  await expectRadixTooltip(row.page(), actionLabel);
  return action;
}

async function expectRadixTooltip(page: Page, label: string): Promise<void> {
  const tooltip = page.locator('[data-ling-overlay="tooltip"]').filter({ hasText: label });
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toBeVisible({ timeout: 2_500 });
}

async function expectActionHitArea(action: Locator): Promise<void> {
  const box = await action.boundingBox();
  expect(box, "message action bounding box").not.toBeNull();
  expect(box!.height, "message action height").toBeGreaterThanOrEqual(32);
  expect(box!.width, "message action width").toBeGreaterThanOrEqual(32);
}

async function expectPeerContentTopAligned(row: Locator): Promise<void> {
  const layout = await row.evaluate((element) => {
    const avatar = element.querySelector<HTMLElement>(":scope > :is(img, .avatar-initial, .user-profile-avatar)");
    const content = element.querySelector<HTMLElement>(":scope > .message-content");
    const firstVisibleContent = content?.querySelector<HTMLElement>(":scope > :not(.message-row-peer-identity)");
    if (!avatar || !content || !firstVisibleContent) return undefined;
    const avatarBox = avatar.getBoundingClientRect();
    const contentBox = firstVisibleContent.getBoundingClientRect();
    return {
      topDelta: Math.abs(avatarBox.top - contentBox.top),
      gap: contentBox.left - avatarBox.right,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(layout, "peer avatar and content").toBeDefined();
  expect(layout?.topDelta ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2);
  expect(layout?.gap ?? 0).toBeGreaterThanOrEqual(4);
  expect(layout?.overflow ?? 1).toBeLessThanOrEqual(1);
}

async function expectOwnMessageBubble(row: Locator): Promise<void> {
  const appearance = await row.locator(":scope > .message-content").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      justifySelf: style.justifySelf,
      padding: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
    };
  });
  // User messages keep a stable muted bubble while Agent narrative is unboxed.
  expect(appearance.justifySelf).toBe("end");
  expect(appearance.borderRadius).toBeGreaterThan(0);
  expect(appearance.padding).toBeGreaterThan(0);
}

async function expectReducedMotion(page: Page, locators: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  for (const locator of locators) {
    const activeMotion = await locator.evaluateAll((elements) => elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const animations = style.animationName === "none" || style.animationDuration === "0s"
        ? []
        : [`animation:${style.animationName}:${style.animationDuration}`];
      const transitions = style.transitionProperty === "none" || style.transitionDuration === "0s"
        ? []
        : [`transition:${style.transitionProperty}:${style.transitionDuration}`];
      return [...animations, ...transitions];
    }));
    expect(activeMotion).toEqual([]);
  }
}

async function expectNoHorizontalOverflow(page: Page, regions: readonly Locator[]): Promise<void> {
  const documentOverflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(documentOverflow.document).toBeLessThanOrEqual(1);
  expect(documentOverflow.body).toBeLessThanOrEqual(1);
  for (const region of regions) {
    const overflows = await region.evaluateAll((elements) => elements.map((element) => ({
      className: element.className,
      overflow: element.scrollWidth - element.clientWidth,
    })));
    for (const entry of overflows) {
      expect(entry.overflow, String(entry.className)).toBeLessThanOrEqual(1);
    }
  }
}

async function positionForCapture(row: Locator): Promise<void> {
  await row.evaluate((element) => {
    const scrollOwner = element.closest<HTMLElement>(
      ".message-feed, [data-ui2-teammate-private-feed='true'], .normal-conversation-feed",
    );
    if (!scrollOwner) return;
    const ownerBox = scrollOwner.getBoundingClientRect();
    const rowBox = element.getBoundingClientRect();
    scrollOwner.scrollTop += rowBox.top - ownerBox.top - 80;
  });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: test.info().outputPath(filename),
  });
}

function watchRuntime(page: Page): { readonly expectClean: () => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

async function expectAggregateAndDeadSelectorsReleased(): Promise<void> {
  const aggregateFiles = [
    fileURLToPath(new URL("../src/styles/components.css", import.meta.url)),
    fileURLToPath(new URL("../src/styles/strict-console.css", import.meta.url)),
  ];
  const aggregateSelectors = [
    ".conversation-message-row",
    ".message-action-bar",
    ".message-action-bar-action",
    ".channel-message-row",
    ".conversation-turn",
    ".conversation-turn-assistant-row",
    ".conversation-turn-assistant-transcript",
    ".transcript-block-view",
  ] as const;
  for (const file of aggregateFiles) {
    const css = await readFile(file, "utf8");
    for (const selector of aggregateSelectors) {
      expect(cssDefinesSelector(css, selector), `${selector} remains in ${file}`).toBe(false);
    }
  }

  const deadSelectors = [
    ".conversation-message-tag",
    ".channel-message-row-actions",
    ".conversation-turn-segment",
  ] as const;
  const productionFiles = [
    ...await listSourceFiles(webSourceDirectory),
    ...await listSourceFiles(packageSourceDirectory),
  ];
  for (const selector of deadSelectors) {
    const className = selector.slice(1);
    const token = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(className)}(?![A-Za-z0-9_-])`, "u");
    const owners: string[] = [];
    for (const file of productionFiles) {
      if (token.test(await readFile(file, "utf8"))) owners.push(file);
    }
    expect(owners, `${selector} production owners`).toEqual([]);
  }
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return listSourceFiles(resolved);
    return /\.(?:css|ts|tsx)$/u.test(entry.name) ? [resolved] : [];
  }));
  return files.flat();
}

function cssDefinesSelector(css: string, selector: string): boolean {
  const token = new RegExp(`${escapeRegex(selector)}(?![A-Za-z0-9_-])`, "u");
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((prelude) => prelude && !prelude.startsWith("@"))
    .some((prelude) => token.test(prelude));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
