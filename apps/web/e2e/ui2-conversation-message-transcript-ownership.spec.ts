import { mkdir, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
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

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/message-transcript-ownership/",
  import.meta.url,
));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const packageSourceDirectory = fileURLToPath(new URL(
  "../../../packages/conversation-ui-react/src/",
  import.meta.url,
));

test("1440x960 Ling Light owns a complete Channel turn, transcript disclosure, terminal blocks, and action feedback", async ({ page }) => {
  await prepareSurface(page, {
    height: 960,
    theme: "light",
    width: 1440,
    workCellDemo: true,
  });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installChannelTranscriptFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const turn = feed.locator("[data-conversation-turn-id]").filter({
    hasText: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去",
  });
  await expect(turn).toHaveCount(1);
  const sourceRow = turn.locator("[data-conversation-message-row]").filter({
    hasText: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去",
  });
  const assistantRow = turn.locator("[data-conversation-message-row].conversation-turn-assistant-row");
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
  await expectMessageInteractionPolicy(blockedRow, "state", "Copy message");

  const operationBlock = assistantRow.locator(".conversation-turn-operation");
  const terminalBlock = assistantRow.locator(".terminal-report-block");
  await expect(operationBlock).toBeVisible();
  await expect(terminalBlock).toBeVisible();

  const transcript = feed.locator("[data-conversation-transcript-block]").filter({
    hasText: "Clarify the message and transcript ownership boundary",
  });
  await expect(transcript).toHaveCount(1);
  const collapseTranscript = transcript.getByRole("button", { name: "Collapse transcript block" });
  await expect(collapseTranscript).toHaveAttribute("aria-expanded", "true");
  await collapseTranscript.click();
  const expandTranscript = transcript.getByRole("button", { name: "Expand transcript block" });
  await expect(expandTranscript).toHaveAttribute("aria-expanded", "false");
  await expandTranscript.focus();
  await expandTranscript.press("Enter");
  await expect(collapseTranscript).toBeFocused();
  await expect(collapseTranscript).toHaveAttribute("aria-expanded", "true");

  const action = await exerciseActionBar(assistantRow, "Copy message");
  await expectActionHitArea(action);
  await expectNoHorizontalOverflow(page, [feed, turn, sourceRow, assistantRow, transcript]);
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
  await expect(own).toHaveClass(/message-bubble-own/u);
  await expectOwnMessageBubble(own);
  await expect(own).toHaveAttribute("data-has-avatar", "false");
  await expect(own.locator(":scope > :is(.user-profile-avatar, .avatar-initial, img)")).toHaveCount(0);
  await expect(ready).toHaveClass(/message-bubble-peer/u);
  await expect(ready).toHaveAttribute("data-has-avatar", "false");
  await expect(ready.locator(":scope > :is(.user-profile-avatar, .avatar-initial, img)")).toHaveCount(0);
  await expect(ready.locator(":scope > .message-content > header")).toBeHidden();
  await expect(pending).toHaveClass(/message-bubble-pending/u);
  await expect(pending.locator(".message-pending-spinner")).toBeVisible();
  await expect(failed).toHaveClass(/failed/u);
  await expect(failed.locator('.normal-conversation-message-error[data-tone="danger"]')).toBeVisible();
  await expectMessageInteractionPolicy(own, "user", "Copy message");
  await expectMessageInteractionPolicy(ready, "assistant", "Copy message");
  const workCells = feed.locator(".conversation-work-cell");
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
  await expect(blocked).toHaveClass(/message-bubble-chat-blocked/u);
  await expect(blocked.getByRole("alert")).toContainText("Private ownership request is blocked");
  await expect(peer.getByRole("link", { name: "message-ownership-notes.md" })).toBeVisible();
  await expectMessageInteractionPolicy(own, "user", "Copy message");
  await expectMessageInteractionPolicy(peer, "assistant", "Copy message");
  await expectMessageInteractionPolicy(blocked, "state", "Copy message");

  const memoryToggle = peer.locator(".conversation-evidence-toggle");
  await memoryToggle.click();
  await expect(peer.getByText("Message ownership memory", { exact: true })).toBeVisible();
  await expectMessageFrameContained(own);
  await expectMessageFrameContained(peer);
  await expectMessageFrameContained(blocked);
  await expectAuthorTimeBaseline(peer);

  const copy = await exerciseActionBar(peer, "Copy message");
  await expectActionHitArea(copy);
  await expectNoHorizontalOverflow(page, [chat, feed, rows, peer.locator(".message-evidence-panel")]);
  await positionForCapture(peer);
  await copy.hover();
  await expectRadixTooltip(page, "Copy message");
  await captureEvidence(page, "1440x960-quiet-ocean-teammate-message-states.png");
  runtime.expectClean();
});

function installChannelTranscriptFixture(state: MockState): void {
  const createdAt = "2026-07-24T03:00:00.000Z";
  state.channelMessages = [
    {
      id: "message_ui2_transcript_contract",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "local-user",
      body: "Clarify the message and transcript ownership boundary.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt,
      updatedAt: createdAt,
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
      createdAt: "2026-07-24T03:01:00.000Z",
      updatedAt: "2026-07-24T03:01:00.000Z",
    },
  ];
  state.channelExecutionProposals = [{
    id: "proposal_ui2_transcript_contract",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    sourceMessageId: "message_ui2_transcript_contract",
    proposedByTeammateId: "ling_agent",
    title: "Clarify the message and transcript ownership boundary",
    prompt: "Clarify the message and transcript ownership boundary.",
    assigneeTeammateId: "ling_agent",
    acceptanceCriteria: ["Channel transcript ownership remains explicit."],
    collaborationSteps: [{
      teammateId: "ling_agent",
      action: "coordinated",
      summary: "Clarify the ownership boundary before changing the transcript.",
    }],
    requiredTools: ["read"],
    riskSummary: "Do not mix shared message chrome with Channel transcript ownership.",
    shaping: {
      status: "needs_user_clarification",
      summary: "Clarify the message and transcript ownership boundary",
      openQuestions: ["Which transcript state should remain expanded?"],
      clarifications: [{
        id: "clarification_ui2_transcript_contract",
        authorType: "local-user",
        authorId: "local-user",
        body: "Keep the focused block expanded for evidence.",
        sourceMessageId: "message_ui2_transcript_contract",
        createdAt,
      }],
      sourceRefs: [{ type: "message", id: "message_ui2_transcript_contract" }],
      updatedAt: createdAt,
    },
    status: "draft",
    createdAt,
    updatedAt: createdAt,
  }];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
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
  state.turns.push({
    id: turnId,
    workspaceId: "workspace_default",
    threadId: input.threadId,
    kind: "manual_followup",
    status: "succeeded",
    title: input.prompt,
    userInstruction: input.prompt,
    activeRunId: input.status === "running" ? runId : undefined,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    completedAt: input.status === "succeeded" || input.status === "failed" ? input.timestamp : undefined,
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
    createdAt: input.timestamp,
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
    endedAt: input.status === "succeeded" || input.status === "failed" ? input.timestamp : undefined,
  });
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: input.timestamp,
    type: "assistant_text_delta",
    data: { text: input.body },
  }];
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
  await page.getByLabel("Ling Stack navigation").locator(".sidebar-recent-row").filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function openTeammate(page: Page, displayName: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: displayName }).click();
  await expect(page.getByRole("heading", { name: displayName, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
}

async function exerciseActionBar(row: Locator, actionLabel: string): Promise<Locator> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const actionBar = row.locator(".message-action-bar");
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

async function expectAuthorTimeBaseline(row: Locator): Promise<void> {
  const layout = await row.evaluate((element) => {
    const header = element.querySelector<HTMLElement>(":scope > .message-content > header");
    const author = header?.querySelector<HTMLElement>("strong");
    const time = header?.querySelector<HTMLElement>("time");
    if (!header || !author || !time) return undefined;
    const authorBox = author.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    return {
      centerDelta: Math.abs(
        (authorBox.top + authorBox.height / 2) - (timeBox.top + timeBox.height / 2),
      ),
      gap: timeBox.left - authorBox.right,
      overflow: header.scrollWidth - header.clientWidth,
      verticalOverlap: Math.min(authorBox.bottom, timeBox.bottom) - Math.max(authorBox.top, timeBox.top),
    };
  });
  expect(layout, "author and time header").toBeDefined();
  expect(layout?.centerDelta ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2);
  expect(layout?.gap ?? 0).toBeGreaterThanOrEqual(4);
  expect(layout?.overflow ?? 1).toBeLessThanOrEqual(1);
  expect(layout?.verticalOverlap ?? 0).toBeGreaterThan(0);
}

async function expectOwnMessageBubble(row: Locator): Promise<void> {
  const appearance = await row.locator(":scope > .message-content").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      justifySelf: style.justifySelf,
      padding: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
    };
  });
  expect(appearance.backgroundColor).not.toBe("transparent");
  expect(appearance.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(appearance.borderRadius).toBeGreaterThan(0);
  expect(appearance.justifySelf).toBe("end");
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
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
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
