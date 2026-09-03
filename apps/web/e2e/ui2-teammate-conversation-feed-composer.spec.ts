import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { expectCompactMutedComposerControl } from "./support/composer-control-assertions";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { createBaseState, createChatProvider, createMockTeammate, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/teammate-conversation-feed-composer/",
  import.meta.url,
));

for (const fixture of [
  { theme: "light" as const, width: 1440, height: 960 },
  { theme: "dark" as const, width: 1280, height: 800 },
]) {
  test(`AI teammate feed owns virtual history and message states at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const runtimeErrors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    const teammateId = installFeedFixture(state);
    await mockDaemon(page, state);

    await page.goto("/");
    await openTeammate(page, "UI2 Feed Engineer");

    const chat = page.getByLabel("Private chat", { exact: true });
    const feedOwner = chat.locator('[data-ui2-teammate-private-feed="true"]');
    const composerOwner = chat.locator('[data-ui2-teammate-private-composer="true"]');
    const feed = feedOwner.getByLabel("Private message feed", { exact: true });
    const composer = composerOwner.getByLabel("Private chat composer", { exact: true });

    await expect(feedOwner).toBeVisible();
    await expect(composerOwner).toBeVisible();
    await expect(feed.locator(".message-feed-virtualizer")).toBeVisible();
    const feedGeometry = await Promise.all([
      feedOwner.boundingBox(),
      feed.boundingBox(),
    ]).then(([ownerBox, feedBox]) => ({
      bottomDelta: ownerBox && feedBox
        ? Math.abs(ownerBox.y + ownerBox.height - (feedBox.y + feedBox.height))
        : Number.POSITIVE_INFINITY,
      heightDelta: ownerBox && feedBox
        ? Math.abs(ownerBox.height - feedBox.height)
        : Number.POSITIVE_INFINITY,
    }));
    expect(feedGeometry.bottomDelta).toBeLessThanOrEqual(1);
    expect(feedGeometry.heightDelta).toBeLessThanOrEqual(1);
    await expect(feed.getByText("AI teammate is replying...", { exact: true })).toBeVisible();
    await expect(feed.getByText("Reply stopped", { exact: true })).toBeVisible();
    await expect(feed.getByRole("alert").filter({ hasText: "Provider failed after the request started." })).toBeVisible();
    const memoryRow = feed.locator(".teammate-message-row.ai-teammate").filter({ hasText: "Memory-backed private response." });
    await expect(memoryRow.getByRole("link", { name: "private-feed-evidence.md" })).toBeVisible();
    await expectAvatarTopAligned(
      memoryRow.locator(":scope > .teammate-avatar-image"),
      memoryRow.locator(":scope > .message-content > header"),
    );
    const blockedRow = feed.locator(".teammate-message-row.ai-teammate.message-bubble-chat-blocked").filter({ hasText: "Provider failed after the request started." });
    await expectAvatarTopAligned(
      blockedRow.locator(":scope > .teammate-avatar-image"),
      blockedRow,
    );
    const queuedGuidanceRow = feed.locator('[data-feed-item-id="message_ui2_teammate_guidance"] .teammate-message-row');
    await expect(queuedGuidanceRow).toBeVisible();
    await expect(queuedGuidanceRow).toHaveClass(/local-user/);
    await expect(queuedGuidanceRow).toHaveClass(/message-bubble-own/);
    await expect(queuedGuidanceRow).toContainText("Continue with the user's weather question.");
    await expect(queuedGuidanceRow).not.toContainText("排队引导");
    await expect(queuedGuidanceRow).not.toContainText("System");
    await memoryRow.locator(".conversation-evidence-toggle").click();
    await expect(memoryRow.getByText("Private feed memory", { exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-teammate-feed-states.png`);

    const pending = feed.locator(".teammate-message-row.ai-teammate").filter({ hasText: "AI teammate is replying..." });
    const failed = feed.locator(".teammate-message-row.ai-teammate").filter({ hasText: "Provider failed after the request started." });
    const cancelled = feed.locator(".teammate-message-row.ai-teammate").filter({ hasText: "Reply stopped" });
    await expect(pending).toHaveClass(/message-bubble-pending/);
    await expect(pending.locator(".message-pending-spinner")).toBeVisible();
    await expect(failed).toHaveClass(/message-bubble-chat-blocked/);
    await expect(cancelled).toHaveClass(/message-bubble-chat-blocked/);

    await expectAlignedConversationColumns(feed, composer);
    await expect.poll(() => feed.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    await expect.poll(() => chat.evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");

    await feed.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const latest = chat.getByRole("button", { name: "Jump to latest message" });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect.poll(() => feed.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
    )).toBeLessThanOrEqual(2);

    const pendingReplacement = feed.locator(".teammate-message-row.local-user").filter({ hasText: "Retry the private replacement" });
    await expect(pendingReplacement).toHaveClass(/message-bubble-chat/);
    await expect(pendingReplacement).toHaveClass(/message-bubble-own/);
    await expect(memoryRow).toHaveClass(/message-bubble-chat/);
    await expect(memoryRow).toHaveClass(/message-bubble-peer/);
    await expectMessageFrameContained(pendingReplacement);
    await expectMessageFrameContained(memoryRow);
    await pendingReplacement.getByRole("button", { name: "Retry response" }).click();
    await expect.poll(() => state.lastConversationMessageEditRequest?.idempotencyKey).toBe("ui2-private-replacement-key");

    await expectNoDocumentOverflow(page);
    expect(runtimeErrors).toEqual([]);
    expect(state.aiTeammates.some((item) => isRecord(item) && item.id === teammateId)).toBe(true);
  });
}

test("AI teammate composer preserves slash, permission, attachment, and send behavior", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = installComposerFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openTeammate(page, "UI2 Composer Engineer");

  const chat = page.getByLabel("Private chat", { exact: true });
  const composerOwner = chat.locator('[data-ui2-teammate-private-composer="true"]');
  const composer = composerOwner.getByLabel("Private chat composer", { exact: true });
  const input = composer.getByRole("textbox");
  await expect(composerOwner).toBeVisible();
  await expect(composer).toHaveClass(/conversation-composer/);

  const permission = composer.getByRole("button", { name: /Selected permission preset/ });
  await expectCompactMutedComposerControl(permission);
  await permission.click();
  const permissionMenu = page.locator('[data-ling-overlay="menu"]').filter({ has: page.getByRole("menuitemradio", { name: /Read only/ }) });
  await expect(permissionMenu).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-teammate-composer-permission-menu.png");
  await permissionMenu.getByRole("menuitemradio", { name: /Read only/ }).click();
  await expect(permission).toContainText("Read only");

  await input.fill("/rev");
  const slashPicker = page.getByRole("listbox", { name: "Slash command" });
  await expect(slashPicker).toBeVisible();
  await slashPicker.getByRole("option", { name: /^\/review\b/ }).click();
  await expect(input).toHaveAttribute("data-value", "/review ");

  await composer.locator('input[type="file"]').setInputFiles({
    name: "private-guidance.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(composer.locator(".composer-preview-thumbnail[alt='private-guidance.png']")).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-teammate-composer-attachment.png");

  await replaceTokenizedComposerValue(input, "Send this UI2 private message with the image.");
  await input.press("Enter");
  await expect.poll(() => state.lastTeammateDirectMessageRequest?.workspaceAccessMode).toBe("read_only");
  await expect.poll(() => state.lastTeammateDirectMessageRequest?.attachmentIds).toEqual(["tpatt_1"]);
  await expect(chat.getByText("Send this UI2 private message with the image.", { exact: true })).toBeVisible();
  await expect(input).toHaveAttribute("data-value", "");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
  expect(teammateId).toBe("teammate_ui2_composer");
});

test("AI teammate composer preserves active guidance, locked permission, and stop behavior", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installActiveComposerFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openTeammate(page, "UI2 Guidance Engineer");

  const chat = page.getByLabel("Private chat", { exact: true });
  const composerOwner = chat.locator('[data-ui2-teammate-private-composer="true"]');
  const composer = composerOwner.getByLabel("Private chat composer", { exact: true });
  const input = composer.getByRole("textbox");
  await expect(composer.getByRole("button", { name: /Selected permission preset/ })).toBeDisabled();

  await input.fill("/rev");
  const slashPicker = page.getByRole("listbox", { name: "Slash command" });
  await expect(slashPicker).toBeVisible();
  await slashPicker.getByRole("option", { name: /^\/review\b/ }).click();
  await expect(input).toHaveAttribute("data-value", "/review ");

  await composer.locator('input[type="file"]').setInputFiles({
    name: "private-guidance.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(composer.locator(".composer-preview-thumbnail[alt='private-guidance.png']")).toBeVisible();
  await replaceTokenizedComposerValue(input, "Queue this UI2 guidance with the image.");
  await input.press("Enter");

  const guidance = page.getByLabel("Replying");
  await expect(guidance).toContainText("Queue this UI2 guidance with the image.");
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.messagePayload?.attachmentIds).toEqual(["tpatt_1"]);
  await expect(input).toHaveAttribute("data-value", "");
  await captureEvidence(page, "1280x800-ling-dark-teammate-guidance-active.png");

  const stop = composer.getByRole("button", { name: "Stop reply" });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect.poll(() => state.workUnits.find((item) => item.id === "wu_ui2_teammate_active")?.status).toBe("cancelled");
  await expect(chat.getByText("Reply stopped", { exact: true })).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("AI teammate removes accepted guidance from the queue before its reply completes", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installActiveComposerFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openTeammate(page, "UI2 Guidance Engineer");

  const composer = page.getByLabel("Private chat composer", { exact: true });
  const input = composer.getByRole("textbox");
  await replaceTokenizedComposerValue(input, "Send this queued guidance next.");
  await input.press("Enter");

  const queuedGuidance = page.locator(".conversation-guidance-row").filter({ hasText: "Send this queued guidance next." });
  await expect(queuedGuidance).toBeVisible();
  state.workUnits = [];
  await queuedGuidance.getByRole("button", { name: "Run this guidance now" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("starting_continuation");
  await expect(queuedGuidance).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

function installFeedFixture(state: MockState): string {
  const teammateId = "teammate_ui2_feed";
  const threadId = `tdthread_${teammateId}`;
  const timestamp = "2026-07-19T09:00:00.000Z";
  state.providers = [createChatProvider({
    id: "provider_ui2_teammate_feed",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "UI2 Feed Engineer",
    providerPresetId: "provider_ui2_teammate_feed",
  })];
  state.teammatePrivateAttachments = [{
    id: "attachment_ui2_teammate_feed",
    workspaceId: "workspace_default",
    teammateId,
    threadId,
    messageId: "message_ui2_teammate_memory",
    scope: "teammate_direct_thread",
    kind: "document",
    fileName: "private-feed-evidence.md",
    contentType: "text/markdown",
    sizeBytes: 512,
    path: `teammates/${teammateId}/direct/${threadId}/private-feed-evidence.md`,
    createdAt: timestamp,
  }];
  state.memoryObjects = [{
    id: "memory_ui2_teammate_feed",
    workspaceId: "workspace_default",
    scopeType: "teammate",
    ownerId: teammateId,
    title: "Private feed memory",
    body: "Keep the UI2 teammate feed compact and scannable.",
    tags: ["ui2"],
    sourceRefs: [],
    reviewState: "active",
    enabled: true,
    sensitivity: "private",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.usedMemoryEvents = [{
    id: "used_memory_ui2_teammate_feed",
    workspaceId: "workspace_default",
    memoryIds: ["memory_ui2_teammate_feed"],
    intent: "private-chat",
    recallQuery: "UI2 feed",
    teammateId,
    responseId: "message_ui2_teammate_memory",
    policyVersion: "ling-memory-v1-lexical",
    createdAt: timestamp,
  }];
  const history = Array.from({ length: 32 }, (_, index) => directMessage({
    id: `message_ui2_teammate_history_${index}`,
    teammateId,
    threadId,
    authorType: index % 2 === 0 ? "local-user" : "ai-teammate",
    body: `UI2 private history ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 6, 19, 8, index)).toISOString(),
  }));
  state.teammateDirectMessages = [
    ...history,
    directMessage({ id: "message_ui2_teammate_pending", teammateId, threadId, authorType: "ai-teammate", body: "", status: "pending", createdAt: "2026-07-19T09:01:00.000Z" }),
    directMessage({ id: "message_ui2_teammate_failed", teammateId, threadId, authorType: "ai-teammate", body: "Provider failed after the request started.", status: "failed", errorMessage: "Provider failed after the request started.", createdAt: "2026-07-19T09:02:00.000Z" }),
    directMessage({ id: "message_ui2_teammate_cancelled", teammateId, threadId, authorType: "ai-teammate", body: "", status: "cancelled", createdAt: "2026-07-19T09:03:00.000Z" }),
    {
      ...directMessage({ id: "message_ui2_teammate_replacement", teammateId, threadId, authorType: "local-user", body: "Retry the private replacement", createdAt: "2026-07-19T09:04:00.000Z" }),
      revision: 2,
      editedAt: "2026-07-19T09:04:00.000Z",
      pendingReplacement: {
        supersessionId: "supersession_ui2_teammate",
        idempotencyKey: "ui2-private-replacement-key",
        failureReason: "Provider temporarily unavailable",
      },
    },
    directMessage({
      id: "message_ui2_teammate_guidance",
      teammateId,
      threadId,
      authorType: "system",
      body: "排队引导：Continue with the user's weather question.",
      createdAt: "2026-07-19T09:04:30.000Z",
    }),
    {
      ...directMessage({ id: "message_ui2_teammate_memory", teammateId, threadId, authorType: "ai-teammate", body: "Memory-backed private response.", createdAt: "2026-07-19T09:05:00.000Z" }),
      attachmentIds: ["attachment_ui2_teammate_feed"],
    },
  ];
  return teammateId;
}

function installActiveComposerFixture(state: MockState): string {
  const teammateId = "teammate_ui2_guidance";
  const threadId = `tdthread_${teammateId}`;
  state.providers = [createChatProvider({
    id: "provider_ui2_teammate_guidance",
    displayName: "Local Relay",
    model: "gpt-5.5",
    input: ["text", "image"],
    capabilities: ["chat", "vision"],
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "UI2 Guidance Engineer",
    providerPresetId: "provider_ui2_teammate_guidance",
  })];
  state.teammateSkillBindings = [{
    teammateId,
    skillId: "review",
    source: "user",
    enabled: true,
    createdAt: "2026-07-19T09:00:00.000Z",
    updatedAt: "2026-07-19T09:00:00.000Z",
  }];
  state.teammateDirectMessages = [directMessage({
    id: "message_ui2_teammate_active",
    teammateId,
    threadId,
    authorType: "ai-teammate",
    body: "",
    status: "pending",
    createdAt: "2026-07-19T09:00:00.000Z",
  })];
  state.workUnits = [{
    id: "wu_ui2_teammate_active",
    workspaceId: "workspace_default",
    kind: "teammate_direct_reply",
    ownerType: "teammate",
    ownerId: teammateId,
    teammateId,
    idempotencyKey: "ui2-teammate-active",
    status: "running",
    priority: 50,
    attemptCount: 1,
    activeAttemptId: "wua_ui2_teammate_active",
    createdByActor: "user",
    request: { sourceMessageId: "message_ui2_teammate_source" },
    timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
    linkedMessageId: "message_ui2_teammate_active",
    createdAt: "2026-07-19T08:59:00.000Z",
    updatedAt: "2026-07-19T09:00:00.000Z",
    startedAt: "2026-07-19T09:00:00.000Z",
  }];
  return teammateId;
}

function installComposerFixture(state: MockState): string {
  const teammateId = "teammate_ui2_composer";
  const threadId = `tdthread_${teammateId}`;
  state.providers = [createChatProvider({
    id: "provider_ui2_teammate_composer",
    displayName: "Local Relay",
    model: "gpt-5.5",
    input: ["text", "image"],
    capabilities: ["chat", "vision"],
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "UI2 Composer Engineer",
    providerPresetId: "provider_ui2_teammate_composer",
  })];
  state.teammateSkillBindings = [{
    teammateId,
    skillId: "review",
    source: "user",
    enabled: true,
    createdAt: "2026-07-19T09:00:00.000Z",
    updatedAt: "2026-07-19T09:00:00.000Z",
  }];
  state.teammateDirectMessages = [directMessage({
    id: "message_ui2_teammate_composer_ready",
    teammateId,
    threadId,
    authorType: "ai-teammate",
    body: "Composer ready.",
    createdAt: "2026-07-19T09:00:00.000Z",
  })];
  return teammateId;
}

function directMessage(input: {
  readonly id: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly authorType: "local-user" | "ai-teammate" | "system";
  readonly body: string;
  readonly status?: "pending" | "ready" | "blocked" | "failed" | "cancelled";
  readonly errorMessage?: string;
  readonly createdAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    threadId: input.threadId,
    teammateId: input.teammateId,
    authorType: input.authorType,
    authorId: input.authorType === "ai-teammate" ? input.teammateId : input.authorType === "system" ? "system" : "local-user",
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

async function openTeammate(page: Page, name: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
}

async function expectAlignedConversationColumns(feed: Locator, composer: Locator): Promise<void> {
  await expect.poll(async () => {
    const feedBox = await feed.boundingBox();
    const composerBox = await composer.boundingBox();
    if (!feedBox || !composerBox) return false;
    return Math.abs(feedBox.x - composerBox.x) <= 1 && Math.abs(feedBox.width - composerBox.width) <= 1;
  }).toBe(true);
}

async function expectAvatarTopAligned(avatar: Locator, anchor: Locator): Promise<void> {
  const [avatarBox, anchorBox] = await Promise.all([avatar.boundingBox(), anchor.boundingBox()]);
  expect(avatarBox).not.toBeNull();
  expect(anchorBox).not.toBeNull();
  expect(Math.abs((avatarBox?.y ?? 0) - (anchorBox?.y ?? 0))).toBeLessThanOrEqual(1);
}

async function replaceTokenizedComposerValue(input: Locator, value: string): Promise<void> {
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.pressSequentially(value);
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  const sessionDirectory = process.env.LING_SESSION_VALIDATION_DIR?.replace(/\/$/u, "");
  if (sessionDirectory) {
    await mkdir(sessionDirectory, { recursive: true });
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${sessionDirectory}/${filename}` });
    return;
  }
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
