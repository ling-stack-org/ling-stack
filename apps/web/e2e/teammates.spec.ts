import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { mockDaemon, type MockExecutionAction } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  isRecord,
} from "./support/mock-state";
import {
  readSidebarSelection,
} from "./support/test-helpers";
import {
  expectSharedConversationRichBody,
  sharedConversationRichBody,
} from "./support/rich-content";

async function openAiTeammatesFromSettings(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
}

function mockPrivateCommandAction(
  id: string,
  threadId: string,
  runId: string,
  command: string,
  startedAt: string,
  durationMs: number,
): MockExecutionAction {
  const completedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  return {
    id,
    workspaceId: "workspace_default",
    threadId,
    runId,
    attemptId: `attempt_${runId}`,
    toolCallId: `tool_${id}`,
    actionType: "bash",
    risk: "low",
    status: "succeeded",
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
      durationMs,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      latestEventSeq: 3,
      outputTail: [{ eventSeq: 2, stream: "stdout", text: "ok\n", byteCount: 3, redacted: false, ts: completedAt }],
      outputByteCount: 3,
      outputLineCount: 1,
      outputTruncated: false,
    },
    createdAt: startedAt,
    updatedAt: completedAt,
    executedAt: startedAt,
    completedAt,
  };
}

async function openChannelTeammateManager(page: Page): Promise<void> {
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await page.locator(".channel-header-actions").getByRole("button", { name: /channel teammates|AI teammate management/ }).click();
}

async function openPrivateChatSettings(page: Page): Promise<void> {
  if (await page.getByLabel("Private chat workspace dock").count() === 0) {
    await page.getByLabel("AI teammate private chat").getByRole("button", { name: "Show details" }).click();
  }
  await page.getByLabel("Private chat workspace dock").getByRole("button", { name: "Settings" }).click();
}

async function openSidebarSectionMenu(page: Page, label: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: label }).click();
}

async function readMessageFeedEmptyStateVisuals(page: Page, feedLabel: string): Promise<Record<string, string>> {
  return page.getByLabel(feedLabel).locator(".message-feed-empty-state").evaluate((element) => {
    const style = getComputedStyle(element);
    const icon = element.querySelector("svg");
    const iconStyle = icon ? getComputedStyle(icon) : undefined;
    return {
      className: element.className,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      gap: style.gap,
      minHeight: style.minHeight,
      iconWidth: iconStyle?.width ?? "",
      iconHeight: iconStyle?.height ?? "",
      iconStrokeWidth: iconStyle?.strokeWidth ?? "",
    };
  });
}

async function readMessageFeedEmptyStateGeometry(page: Page, feedLabel: string): Promise<{ deltaX: number; deltaY: number }> {
  return page.getByLabel(feedLabel).evaluate((feed) => {
    const emptyState = feed.querySelector<HTMLElement>(".message-feed-empty-state");
    if (!emptyState) {
      return { deltaX: Number.NaN, deltaY: Number.NaN };
    }
    const feedRect = feed.getBoundingClientRect();
    const emptyRect = emptyState.getBoundingClientRect();
    return {
      deltaX: Math.round((emptyRect.left + emptyRect.width / 2) - (feedRect.left + feedRect.width / 2)),
      deltaY: Math.round((emptyRect.top + emptyRect.height / 2) - (feedRect.top + feedRect.height / 2)),
    };
  });
}

async function readComposerGeometry(page: Page, selector: string): Promise<{ backgroundColor: string; borderRadius: string; boxShadow: string; height: number; inputHeight: number; padding: string; width: number }> {
  return page.locator(selector).evaluate((composer) => {
    const input = composer.querySelector<HTMLElement>(".tokenized-composer-input");
    const rect = composer.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    const style = getComputedStyle(composer);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      inputHeight: Math.round(inputRect?.height ?? 0),
      padding: style.padding,
    };
  });
}

async function replaceTokenizedComposerValue(input: Locator, value: string): Promise<void> {
  await input.evaluate((element, nextValue) => {
    element.textContent = nextValue;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
  }, value);
  await expect(input).toHaveAttribute("data-value", value);
  await input.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element as HTMLElement).focus();
  });
}

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
  state.providerCheckDelayMs = 120;
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await openSidebarSectionMenu(page, "Teammate actions");
  await expect(page.getByRole("menuitem", { name: /New AI teammate/ })).toBeVisible();
  await expect(navigation.getByText("Choose a role and model. You can adjust details before creating.")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Quick create default teammate/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /More configuration/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "New teammate" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /New AI teammate/ }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toHaveCount(0);
  await expect(page.locator(".teammate-create-overlay")).toBeVisible();
  await expect(page.locator(".teammate-create-sheet")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toBeVisible();
  await expect(page.getByText("Recommended role and model are prefilled. Review them, then create.")).toBeVisible();
  await expect(page.getByLabel("Teammate template chooser").getByRole("button", { name: /Engineer/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog", { name: "Create AI teammate" }).getByLabel("Base model")).toHaveValue("provider_local");
  await page.getByRole("dialog", { name: "Create AI teammate" }).getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toHaveCount(0);
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "No teammate yet" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toBeVisible();
  await page.getByRole("dialog", { name: "Create AI teammate" }).getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toHaveCount(0);

  await openAiTeammatesFromSettings(page);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.locator(".teammate-management-grid")).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.getByLabel("Teammate templates")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByText("Ling Engineer")).toHaveCount(0);
  await expect(page.locator(".teammate-command-strip")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
  await expect(page.getByLabel("AI teammate context")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates").getByRole("button", { name: /New AI teammate/ })).toBeVisible();
  await expect(page.getByLabel("Teammate templates").getByRole("button", { name: /New AI teammate/ })).toHaveCount(0);
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
  await page.getByRole("dialog", { name: "Create AI teammate" }).getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toHaveCount(0);
  await page.getByLabel("Workspace teammates").getByRole("button", { name: /New AI teammate/ }).click();
  const creator = page.getByRole("dialog", { name: "Create AI teammate" });
  await expect(creator).toBeVisible();
  await expect(page.getByLabel("Teammate setup steps")).toHaveCount(0);
  await expect(page.getByLabel("Teammate preview")).toHaveCount(0);
  await page.getByLabel("Teammate template chooser").getByRole("button", { name: /Engineer/ }).click();

  await page.getByLabel("Teammate name").fill("Ling Engineer");
  await expect(creator.getByLabel("Join channels")).toHaveValue("channel_engineering");
  await expect(creator.getByLabel("Base model")).toBeVisible();
  await creator.getByLabel("Base model").selectOption("provider_local");
  await expect(creator.getByText("Advanced settings")).toHaveCount(0);
  await expect(creator.getByText("Default memory scopes")).toHaveCount(0);
  await expect(creator.getByRole("button", { name: "Private chat summary" })).toHaveCount(0);
  await expect(page.getByLabel("Channel choices")).toHaveCount(0);
  await page.getByRole("button", { name: "Create teammate" }).click();
  const templateProgress = page.getByLabel("Teammate setup progress");
  await expect(templateProgress).toBeVisible();
  await expect(templateProgress).toContainText("Workspace");
  await expect(templateProgress).toContainText("Model check");
  await expect(templateProgress).toContainText("Create teammate");
  await expect(templateProgress).toContainText("Upload avatar");
  await expect(templateProgress).toContainText("Join channel");
  await expect(templateProgress).toContainText("Prepare memory");
  await expect(templateProgress).toContainText("Refresh workspace");
  await expect(creator).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row-shell.selected")).toContainText("Ling Engineer");
  await expect(page.getByLabel("Private chat", { exact: true })).toBeVisible();
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.displayName === "Ling Engineer")).toBe(true);
  await expect.poll(() => state.teammateChannelMemberships.some((item) => isRecord(item) && item.teammateId === "teammate_created_1" && item.channelId === "channel_engineering")).toBe(true);

  await openAiTeammatesFromSettings(page);
  await expect(page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" })).toBeVisible();
  const lingEngineerRow = page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" });
  await expect(lingEngineerRow.locator(".teammate-row-status.ready")).toContainText("Ready teammate");
  await expect(lingEngineerRow.getByLabel("Teammate actions")).toBeVisible();
  await expect(lingEngineerRow.locator(".teammate-row-primary-action")).toContainText("Open chat");
  const lingEngineerRowLayout = await lingEngineerRow.evaluate((row) => {
    const model = row.querySelector<HTMLElement>(".teammate-model-pill");
    const channel = row.querySelector<HTMLElement>(".teammate-channel-pill");
    const updated = row.querySelector<HTMLElement>(".teammate-updated-time");
    const primaryAction = row.querySelector<HTMLElement>(".teammate-row-primary-action");
    const menuTrigger = row.querySelector<HTMLElement>(".teammate-row-menu-trigger");
    const modelRect = model?.getBoundingClientRect();
    const channelRect = channel?.getBoundingClientRect();
    const updatedRect = updated?.getBoundingClientRect();
    const primaryRect = primaryAction?.getBoundingClientRect();
    const menuRect = menuTrigger?.getBoundingClientRect();
    return {
      rowOverflow: row.scrollWidth - row.clientWidth,
      modelAboveMetadata: modelRect && channelRect ? modelRect.bottom <= channelRect.top + 1 : false,
      channelBeforeUpdated: channelRect && updatedRect ? channelRect.right <= updatedRect.left : false,
      actionBeforeMenu: primaryRect && menuRect ? primaryRect.right <= menuRect.left : false,
    };
  });
  expect(lingEngineerRowLayout.rowOverflow).toBeLessThanOrEqual(1);
  expect(lingEngineerRowLayout.modelAboveMetadata).toBe(true);
  expect(lingEngineerRowLayout.channelBeforeUpdated).toBe(true);
  expect(lingEngineerRowLayout.actionBeforeMenu).toBe(true);
  await expect(page.getByLabel("Workflow")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);

  await lingEngineerRow.getByLabel("Teammate actions").click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.displayName === "Ling Engineer");
    return isRecord(teammate) ? `${String(teammate.status)}:${String(teammate.hidden)}` : "missing";
  }).toBe("disabled:true");
  await expect(lingEngineerRow).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toContainText("No workspace teammates");
});

test("sidebar new teammate action supports custom setup with verified progress", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_local",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.providerCheckDelayMs = 120;
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const initialTeammateCount = state.aiTeammates.length;
  await openSidebarSectionMenu(page, "Teammate actions");
  await expect(page.getByRole("menuitem", { name: /New AI teammate/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Quick create default teammate/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /New AI teammate/ }).click();

  const creator = page.getByRole("dialog", { name: "Create AI teammate" });
  await expect(creator).toBeVisible();
  await expect(page.getByText("Recommended role and model are prefilled. Review them, then create.")).toBeVisible();
  await expect(page.getByLabel("Teammate template chooser").getByRole("button", { name: /Engineer/ })).toHaveAttribute("aria-pressed", "true");
  await expect(creator.getByLabel("Base model")).toHaveValue("provider_local");
  await expect.poll(() => state.aiTeammates.length).toBe(initialTeammateCount);

  await creator.getByRole("button", { name: /Start from blank/ }).click();
  await expect(creator.getByLabel("Custom teammate setup")).toBeVisible();
  await expect(creator.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(creator.getByLabel("Avatar color", { exact: true })).toBeVisible();
  await creator.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Teammate template chooser")).toBeVisible();
  await creator.getByRole("button", { name: /Start from blank/ }).click();
  await creator.getByLabel("Upload avatar").setInputFiles({
    name: "custom-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(creator.getByText("custom-avatar.png")).toBeVisible();
  await expect(creator.getByRole("button", { name: "Remove avatar" })).toBeVisible();
  await creator.getByLabel("Teammate name").fill("Custom Researcher");
  await creator.getByLabel("Brief description").fill("Researches product questions and keeps notes short.");
  await creator.getByLabel("Base model").selectOption("provider_local");
  await creator.getByRole("button", { name: "Create and verify" }).click();

  const progress = page.getByLabel("Teammate setup progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Model check");
  await expect(progress).toContainText("Upload avatar");
  await expect(creator).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Custom Researcher", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Private chat", { exact: true })).toBeVisible();
  await expect.poll(() => state.aiTeammates.some((item) =>
    isRecord(item) &&
    item.displayName === "Custom Researcher" &&
    item.roleKey === "custom" &&
    item.providerPresetId === "provider_local" &&
    typeof item.avatarImageAttachmentId === "string",
  )).toBe(true);
  await expect.poll(() => state.teammatePrivateAttachments.some((item) =>
    isRecord(item) &&
    item.teammateId === "teammate_created_1" &&
    item.scope === "teammate_profile_avatar" &&
    item.fileName === "custom-avatar.png",
  )).toBe(true);
});

test("custom teammate model check failure stops before teammate creation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_broken",
    displayName: "Broken Relay",
    providerId: "broken-relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  await mockDaemon(page, state, { providerCheckModelUnsupportedProviderIds: ["broken-relay"] });
  await page.goto("/");

  const initialTeammateCount = state.aiTeammates.length;
  await openSidebarSectionMenu(page, "Teammate actions");
  await page.getByRole("menuitem", { name: /New AI teammate/ }).click();
  const creator = page.getByRole("dialog", { name: "Create AI teammate" });
  await creator.getByRole("button", { name: /Start from blank/ }).click();
  await creator.getByLabel("Teammate name").fill("Blocked Custom");
  await creator.getByLabel("Base model").selectOption("provider_broken");
  await creator.getByRole("button", { name: "Create and verify" }).click();

  const progress = page.getByLabel("Teammate setup progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Setup needs attention");
  await expect(progress).toContainText("Provider rejected the endpoint or model");
  await expect.poll(() => state.aiTeammates.length).toBe(initialTeammateCount);
  await creator.getByRole("button", { name: "Back to setup" }).click();
  await expect(creator.getByLabel("Custom teammate setup")).toBeVisible();
});

test("sidebar teammate create offers model workbench when no ready model exists", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await openSidebarSectionMenu(page, "Teammate actions");
  await expect(page.getByRole("menuitem", { name: /Quick create default teammate/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /New AI teammate/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Configure model/ })).toBeVisible();
  await expect(navigation.getByText("Configure a ready chat model before creating.")).toHaveCount(0);
  await page.getByRole("menuitem", { name: /Configure model/ }).click();

  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect.poll(() => state.aiTeammates.length).toBe(0);
});

test("channel and private chat empty message states share conversation visuals", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_empty_private", displayName: "Empty Private" })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  const channelFeed = page.getByLabel("Channel message feed");
  await expect(channelFeed.getByText("No channel messages yet")).toBeVisible();
  const channelEmptyVisuals = await readMessageFeedEmptyStateVisuals(page, "Channel message feed");
  const channelEmptyGeometry = await readMessageFeedEmptyStateGeometry(page, "Channel message feed");
  const channelComposerGeometry = await readComposerGeometry(page, ".channel-composer");
  expect(Math.abs(channelEmptyGeometry.deltaX)).toBeLessThanOrEqual(1);
  expect(Math.abs(channelEmptyGeometry.deltaY)).toBeLessThanOrEqual(1);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Empty Private" }).click();
  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  await expect(privateFeed.getByText("No private messages yet")).toBeVisible();
  const privateEmptyVisuals = await readMessageFeedEmptyStateVisuals(page, "Private message feed");
  const privateEmptyGeometry = await readMessageFeedEmptyStateGeometry(page, "Private message feed");
  const privateComposerGeometry = await readComposerGeometry(page, ".teammate-direct-composer");
  expect(Math.abs(privateEmptyGeometry.deltaX)).toBeLessThanOrEqual(1);
  expect(Math.abs(privateEmptyGeometry.deltaY)).toBeLessThanOrEqual(1);

  expect(privateEmptyVisuals).toEqual(channelEmptyVisuals);
  expect(Math.abs(privateComposerGeometry.width - channelComposerGeometry.width)).toBeLessThanOrEqual(24);
  expect(privateComposerGeometry.backgroundColor).toBe(channelComposerGeometry.backgroundColor);
  expect(privateComposerGeometry.borderRadius).toBe(channelComposerGeometry.borderRadius);
  expect(privateComposerGeometry.padding).toBe(channelComposerGeometry.padding);
  expect(privateComposerGeometry.inputHeight).toBe(channelComposerGeometry.inputHeight);
  expect(privateComposerGeometry.height).toBeLessThanOrEqual(channelComposerGeometry.height);
  expect(privateComposerGeometry.width).toBeLessThanOrEqual(960);
  expect(channelComposerGeometry.boxShadow).not.toBe("none");
  expect(privateComposerGeometry.boxShadow).not.toBe("none");
});

test("Ling Agent private chat renders workspace governance digest without source body", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_local",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [
    createMockTeammate({
      id: "ling_agent",
      templateId: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      protectedProfile: true,
      displayName: "Ling Agent",
      roleKey: "custom",
    }),
  ];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_ling_digest",
      workspaceId: "workspace_default",
      threadId: "tdthread_ling_agent",
      teammateId: "ling_agent",
      authorType: "system",
      authorId: "system",
      body: [
        "Workspace review digest: 2 items need attention.",
        "- Warning: Memory candidate needs review: Workspace review memory (Memory Review)",
        "Open the relevant review surface before approving, rejecting, or publishing anything.",
      ].join("\n"),
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      createdAt: "2026-06-21T00:10:00.000Z",
      updatedAt: "2026-06-21T00:10:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Agent" }).click();
  await expect(page.getByRole("heading", { name: "Ling Agent", level: 1 })).toBeVisible();
  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  await expect(privateFeed).toBeVisible();
  const digestRow = page.locator(".teammate-message-row.system").filter({ hasText: "Workspace review digest" });
  await expect(digestRow).toBeVisible();
  await expect(digestRow).toHaveClass(/message-bubble-system/);
  await expectMessageFrameContained(digestRow);
  await expect(digestRow).toContainText("Memory Review");
  await expect(digestRow).not.toContainText("Workspace governance body must not be copied");
});

test("AI teammate private chat renders the shared GFM, Mermaid, and math pipeline", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_private_rich_content";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Rich Content Engineer",
  })];
  state.teammateDirectMessages = [{
    id: "tdmsg_private_rich_content",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body: sharedConversationRichBody,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:00:00.000Z",
    updatedAt: "2026-07-12T03:00:00.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Rich Content Engineer" }).click();

  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  const teammateRow = privateFeed.locator(".teammate-message-row.ai-teammate");
  await expect(teammateRow).toHaveCount(1);
  await expect(teammateRow.locator(".teammate-avatar-image.compact")).toHaveCount(1);
  await expectSharedConversationRichBody(teammateRow);
  await expect(teammateRow.locator(".terminal-report-participants")).toHaveCount(0);
});

test("latest private prompt edits in place and hides its superseded reply", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_private_edit";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Editable Engineer",
  })];
  state.teammateDirectMessages = [{
    id: "tdmsg_private_edit_source",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "local-user",
    authorId: "local-user",
    body: "Original private prompt",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:30:00.000Z",
    updatedAt: "2026-07-12T03:30:00.000Z",
  }, {
    id: "tdmsg_private_edit_old_reply",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "Old private response should disappear.",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-12T03:30:01.000Z",
    updatedAt: "2026-07-12T03:30:01.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Editable Engineer" }).click();

  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  const userRow = privateFeed.locator(".teammate-message-row.local-user");
  await userRow.hover();
  await userRow.getByRole("button", { name: "Edit message" }).click();
  await privateFeed.getByLabel("Edit message").fill("Revised private prompt");
  await privateFeed.getByRole("button", { name: "Save and resend" }).click();

  await expect(privateFeed).toContainText("Revised private prompt");
  await expect(privateFeed).toContainText("Edited private reply: Revised private prompt");
  await expect(privateFeed).not.toContainText("Original private prompt");
  await expect(privateFeed).not.toContainText("Old private response should disappear.");
  await expect.poll(() => state.lastConversationMessageEditRequest?.surface).toBe("teammate_direct");
  await expect.poll(() => state.lastConversationMessageEditRequest?.messageId).toBe("tdmsg_private_edit_source");
});

test("pending private replacement retries without exposing Participants", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_private_pending_edit";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Pending Edit Engineer",
  })];
  state.teammateDirectMessages = [{
    id: "tdmsg_private_pending_edit",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "local-user",
    authorId: "local-user",
    body: "Revised private prompt waiting for a response",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    revision: 2,
    editedAt: "2026-07-12T03:35:00.000Z",
    pendingReplacement: {
      supersessionId: "supersession_private_pending",
      idempotencyKey: "private-edit-pending-key",
      failureReason: "Provider temporarily unavailable",
    },
    createdAt: "2026-07-12T03:30:00.000Z",
    updatedAt: "2026-07-12T03:35:00.000Z",
  }];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Pending Edit Engineer" }).click();

  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  const userRow = privateFeed.locator(".teammate-message-row.local-user");
  await expect(userRow).toContainText("Edited");
  await userRow.getByRole("button", { name: "Retry response" }).click();

  await expect(privateFeed).toContainText("Edited private reply: Revised private prompt waiting for a response");
  await expect(privateFeed.locator(".terminal-report-participants")).toHaveCount(0);
  await expect.poll(() => state.lastConversationMessageEditRequest?.idempotencyKey).toBe("private-edit-pending-key");
});

test("private structured references preview safely and open the private Files dock", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_private_references";
  const linkPreviewId = "tdlink_private_reference";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Reference Engineer",
  })];
  state.teammateDirectLinkPreviews = [{
    id: linkPreviewId,
    workspaceId: "workspace_default",
    teammateId,
    threadId: `tdthread_${teammateId}`,
    messageId: "tdmsg_private_references",
    url: "https://example.com/reference",
    normalizedUrl: "https://example.com/reference",
    title: "Reference guide",
    description: "A structured private-chat link preview.",
    siteName: "Example Docs",
    status: "ready",
    createdAt: "2026-07-12T03:40:00.000Z",
    updatedAt: "2026-07-12T03:40:00.000Z",
  }];
  state.teammateDirectMessages = [{
    id: "tdmsg_private_references",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "local-user",
    authorId: "local-user",
    body: "Review [the inline target](apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx:540) and the attached structured references.",
    attachmentIds: [],
    linkPreviewIds: [linkPreviewId],
    fileRefs: [{ path: "apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx", label: "TeammatePrivateChatSurface.tsx", line: 540 }],
    status: "ready",
    createdAt: "2026-07-12T03:40:00.000Z",
    updatedAt: "2026-07-12T03:40:00.000Z",
  }];

  await mockDaemon(page, state);
  await page.route(/\/workspace-files\/preview(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    const lines = Array.from({ length: 620 }, (_, index) => index === 539
      ? "export const privateTargetLine = true;"
      : `// private preview line ${index + 1}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ref: {
          id: `workspace:${path}`,
          source: "workspace_file",
          scope: "workspace",
          label: "TeammatePrivateChatSurface.tsx",
          displayPath: path,
          previewable: true,
        },
        kind: "code",
        text: lines.join("\n"),
        truncated: false,
        redactionNotes: [],
      }),
    });
  });
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Reference Engineer" }).click();

  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  const references = privateFeed.getByLabel("References");
  const webReference = references.getByRole("link", { name: /Reference guide/ });
  await webReference.hover();
  await expect(references.getByRole("tooltip")).toContainText("A structured private-chat link preview.");
  await page.mouse.move(4, 4);
  await expect(references.getByRole("tooltip")).toHaveCount(0);

  const inlineFileReference = privateFeed.locator(".message-local-file-link").filter({ hasText: "TeammatePrivateChatSurface.tsx" });
  await inlineFileReference.click();
  const dock = page.getByLabel("Private chat workspace dock");
  await expect(dock).toContainText("apps/web/src/features/teammates/TeammatePrivateChatSurface.tsx");
  await expect(dock.locator(".right-dock-code-line.focused")).toContainText("privateTargetLine");

  const fileReference = references.getByRole("button", { name: /TeammatePrivateChatSurface\.tsx/ });
  await fileReference.click();
  await expect(dock).toBeVisible();
  await expect(dock.locator(".right-dock-code-line.focused")).toContainText("privateTargetLine");
});

test("AI teammates page links council management to Council Workspace", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_local",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_builtin_designer", displayName: "Ling Designer", roleKey: "designer" }),
    createMockTeammate({ id: "teammate_builtin_qa", displayName: "Ling QA", roleKey: "qa" }),
    createMockTeammate({
      id: "ling_agent",
      templateId: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      protectedProfile: true,
      displayName: "Ling Agent",
      roleKey: "custom",
    }),
  ];
  state.aiCouncilMembers = [
    {
      councilId: "council_builtin_development",
      teammateId: "teammate_builtin_engineer",
      slotKey: "implementation",
      label: "Implementation",
      position: 0,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
  const originalChannelMembershipCount = state.teammateChannelMemberships.length;
  const originalChannelCouncilPolicyCount = state.channelCouncilPolicies.length;

  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await openSidebarSectionMenu(page, "Teammate actions");
  await page.getByRole("menuitem", { name: /New AI teammate/ }).click();
  await page.getByRole("dialog", { name: "Create AI teammate" }).getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toHaveCount(0);

  await openAiTeammatesFromSettings(page);
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.getByRole("button", { name: /New AI teammate/ })).toHaveCount(1);
  const teammateListSize = await page.getByLabel("Workspace teammates").locator(".teammate-draft-list").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(teammateListSize.scrollWidth).toBeLessThanOrEqual(teammateListSize.clientWidth + 1);
  await expect(page.locator(".teammate-council-panel")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "AI Councils" })).toHaveCount(0);
  await expect(page.locator(".teammate-council-home")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import council to channel" })).toHaveCount(0);

  const councilEntry = page.getByLabel("Workspace teammates").getByRole("button", { name: "Open Council Workspace" });
  await expect(councilEntry).toBeVisible();
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);
  expect(state.channelCouncilPolicies).toHaveLength(originalChannelCouncilPolicyCount);

  await councilEntry.click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.locator(".council-workspace-page[aria-label='Council Workspace']")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Council Workspace", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Council members" })).toContainText("Ling Engineer");
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" })).toHaveClass(/active/);
  expect(state.aiCouncilMembers).toHaveLength(1);
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);
});

test("AI teammate sidebar menu keeps create action without bulk archive", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_local",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_archive_engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "teammate_archive_designer", displayName: "Ling Designer", roleKey: "designer" }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "Ling Engineer" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Ling Designer" })).toBeVisible();
  await openSidebarSectionMenu(page, "Teammate actions");
  await expect(page.getByRole("menuitem", { name: /New AI teammate/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Quick create default teammate/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /More configuration/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Archive all chats" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Ling Engineer" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Ling Designer" })).toBeVisible();
  await expect.poll(() => state.aiTeammates.length).toBe(2);
});

test("AI teammate private workspace sends blocked chat replies and persists settings", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`${message.text()} @ ${message.location().url || "unknown"}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  state.providers = [
    createChatProvider({
      id: "provider_local",
      displayName: "Local Relay",
      model: "dpv4",
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-05-29T00:00:00.000Z" },
    }),
    createChatProvider({
      id: "provider_alt",
      displayName: "Model Shuttle",
      model: "qwen-plus",
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-05-29T00:00:00.000Z" },
    }),
  ];
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
  state.runs = [
    {
      id: "run_private_acceptance",
      status: "succeeded",
      cwd,
      taskId: "direct:private_acceptance",
      providerPresetId: "provider_local",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      taskSnapshot: {
        id: "direct:private_acceptance",
        title: "Private acceptance criteria",
        prompt: "Summarize private workspace acceptance criteria.",
      },
      providerSnapshot: {},
      requestSnapshot: {},
      eventLogPath: ".ling-stack/sessions/run_private_acceptance.jsonl",
      threadId: "thread_private_acceptance",
      createdAt: "2026-05-29T00:09:00.000Z",
      startedAt: "2026-05-29T00:09:00.000Z",
      updatedAt: "2026-05-29T00:09:30.000Z",
      endedAt: "2026-05-29T00:09:30.000Z",
    },
    ...state.runs,
  ];
  state.executionActions = [
    mockPrivateCommandAction("private_typecheck", "thread_private_acceptance", "run_private_acceptance", "pnpm typecheck", "2026-05-29T00:09:10.000Z", 900),
    mockPrivateCommandAction("private_lint", "thread_private_acceptance", "run_private_acceptance", "pnpm lint", "2026-05-29T00:09:12.000Z", 600),
    mockPrivateCommandAction("private_test", "thread_private_acceptance", "run_private_acceptance", "pnpm test", "2026-05-29T00:09:14.000Z", 1500),
    ...state.executionActions,
  ];
  state.terminalReports = [{
    schemaVersion: 1,
    id: "terminal_report_private_acceptance",
    workspaceId: "workspace_default",
    threadId: "thread_private_acceptance",
    source: { kind: "run", id: "run_private_acceptance" },
    status: "committed",
    language: "en-US",
    outcome: {
      status: "succeeded",
      title: "Private acceptance criteria verified",
      summary: "The run completed with a structured result and retained its operation history.",
      corrections: [],
      sourceRefs: [{ kind: "run", id: "run_private_acceptance", visibility: "conversation" }],
    },
    changes: [{
      id: "change_private_acceptance",
      kind: "documentation",
      title: "Refined private acceptance criteria",
      summary: "Updated the private workspace acceptance notes.",
      paths: ["docs/private-acceptance.md"],
      addedLines: 8,
      deletedLines: 1,
      sourceRefs: [],
    }],
    verification: [{
      id: "check_private_acceptance",
      title: "Acceptance review",
      status: "passed",
      sourceRefs: [],
    }],
    participants: [],
    artifacts: [{
      id: "artifact_private_acceptance",
      kind: "document",
      title: "private-acceptance.md",
      path: "docs/private-acceptance.md",
      sourceRefs: [{ kind: "file", id: "docs/private-acceptance.md", visibility: "conversation" }],
    }],
    risks: [],
    references: [],
    evidenceSnapshotId: "snapshot_private_acceptance",
    evidenceFingerprint: "fingerprint_private_acceptance",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: "2026-05-29T00:09:30.000Z",
    committedAt: "2026-05-29T00:09:30.000Z",
  }];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_2",
      workspaceId: "workspace_default",
      threadId: `tdthread_${teammateId}`,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "Private acceptance criteria summary.",
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "ready",
      linkedRunId: "run_private_acceptance",
      createdAt: "2026-05-29T00:09:30.000Z",
      updatedAt: "2026-05-29T00:09:30.000Z",
    },
    {
      id: "tdmsg_pending_reply",
      workspaceId: "workspace_default",
      threadId: `tdthread_${teammateId}`,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      attachmentIds: [],
      status: "pending",
      createdAt: "2026-05-29T00:09:58.000Z",
      updatedAt: "2026-05-29T00:09:58.000Z",
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
  const privateChatHeader = page.locator(".teammate-chat-header");
  await expect(privateChatHeader.getByRole("button", { name: "Model needs setup" })).toHaveCount(0);
  const modelNotice = page.locator(".teammate-private-composer-owner > .teammate-model-status-strip");
  await expect(modelNotice).toBeVisible();
  await expect(modelNotice).toContainText("Model needs setup");
  await expect(modelNotice.getByRole("button", { name: "Configure model" })).toBeVisible();
  await expect(privateChatHeader).not.toContainText("Model ready");
  await expect(privateChatHeader).not.toContainText("Memory on");
  const privateChatDarkSurfaces = await page.evaluate(() => {
    const selectors = [
      ".workspace-teammate-private-surface",
      ".teammate-workspace.chat-mode",
      ".teammate-chat-header",
      ".teammate-private-chat",
      ".teammate-message-list",
      ".teammate-direct-composer",
    ];
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      const color = element ? getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [] : [];
      return {
        selector,
        exists: Boolean(element),
        maxChannel: color.length > 0 ? Math.max(...color) : 255,
      };
    });
  });
  for (const surface of privateChatDarkSurfaces) {
    expect(surface.exists, `${surface.selector} should render`).toBe(true);
    expect(surface.maxChannel, `${surface.selector} should stay on dark console tokens`).toBeLessThanOrEqual(45);
  }

  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  await expect(privateFeed).toBeVisible();
  await expect(privateFeed.locator(".message-feed-virtualizer")).toBeVisible();
  // The final assistant message is the single completion narration. The
  // terminal report is typed evidence attached to that row and must not be
  // used as the row's identity (its title may be intentionally compact).
  const linkedRunPrivateRow = page.locator(".teammate-message-row.ai-teammate").filter({ hasText: "Private acceptance criteria summary." });
  await expect(linkedRunPrivateRow.locator("[data-conversation-typed-transcript]")).toHaveCount(1);
  const privateWorkCell = linkedRunPrivateRow.locator("[data-conversation-typed-transcript]");
  await expect(privateWorkCell.locator('[data-conversation-timeline][data-conversation-timeline-scope="primary"]')).toBeVisible();
  const privateCommandBatch = privateWorkCell.locator(".conversation-command-batch");
  await expect(privateCommandBatch.locator(".conversation-command-batch-header")).toContainText("Ran 3 commands");
  await privateCommandBatch.locator(".conversation-command-batch-header").click();
  await expect(privateCommandBatch.locator(".conversation-command-batch-list [data-conversation-timeline-activity]")).toHaveCount(3);
  await expect(privateCommandBatch).toContainText("pnpm test");
  await expect(linkedRunPrivateRow.getByText("Private acceptance criteria summary.", { exact: true })).toHaveCount(1);
  // A successful final message owns completion narration. TerminalReport stays
  // in the audit model and is not rendered as a second summary card here.
  const privateTerminalReport = linkedRunPrivateRow.locator(".terminal-report-block");
  await expect(privateTerminalReport).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(linkedRunPrivateRow).not.toContainText("Acceptance review");
  await expect(linkedRunPrivateRow.locator(".conversation-work-cell-artifact-row").getByRole("button", { name: "Open with" })).toBeVisible();
  await expect(linkedRunPrivateRow.locator(".message-reply-button")).toHaveCount(0);
  const privateToolbar = page.getByLabel("Private chat actions");
  await expect(privateToolbar).toHaveClass(/workspace-top-right-toolbar/);
  await expect(privateToolbar.locator(".workspace-toolbar-action-label")).toHaveCount(0);
  await expect(privateToolbar.getByRole("button", { name: "Search" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(privateToolbar.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(privateToolbar.getByRole("button", { name: "Summary" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(privateToolbar.getByRole("button", { name: "Terminal" })).toHaveClass(/workspace-toolbar-icon-button/);
  await expect(privateToolbar.getByRole("button", { name: "Settings" })).toHaveCount(0);
  await expect(privateToolbar.getByRole("button", { name: /^Review/ })).toHaveCount(0);
  await expect(privateToolbar.getByRole("button", { name: /^Evidence/ })).toHaveCount(0);
  await expect(privateToolbar.getByRole("button", { name: /^Files/ })).toHaveCount(0);
  await expect(privateToolbar.getByRole("button", { name: /^Private attachments:/ })).toHaveCount(0);
  await privateToolbar.getByRole("button", { name: "Summary" }).click();
  await expect(page.locator(".teammate-chat-summary-popover")).toContainText("Private workspace");
  await expect(page.locator(".teammate-chat-summary-popover")).toContainText("Memory on");
  await expect(page.getByLabel("Conversation context")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show details" })).toBeVisible();
  await page.getByRole("button", { name: "Show details" }).click();
  const privateDock = page.getByLabel("Private chat workspace dock");
  const privateSummaryPanel = page.locator(".teammate-private-summary-panel");
  const privateChatSurface = page.locator(".teammate-private-chat");
  await expect(privateSummaryPanel).toBeVisible();
  await expect(privateSummaryPanel).toHaveAttribute("data-summary-placement-motion", "header->main");
  await expect(privateDock).toContainText("Workspace tools");
  await expect(privateDock.getByRole("button", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(privateSummaryPanel).toContainText("Environment");
  await expect(privateSummaryPanel.getByText("Evidence", { exact: true })).toHaveCount(0);
  await expect(privateChatSurface).toHaveClass(/summary-panel-expanded/);
  await expect(privateSummaryPanel).toHaveClass(/is-popover-expanded/);
  await expect.poll(async () => {
    const summaryBox = await privateSummaryPanel.boundingBox();
    const dockFrameBox = await page.locator(".teammate-private-right-dock-frame").boundingBox();
    return summaryBox && dockFrameBox ? summaryBox.x + summaryBox.width <= dockFrameBox.x + 1 : false;
  }).toBe(true);
  await privateToolbar.getByRole("button", { name: "Summary" }).click();
  await expect(privateChatSurface).toHaveClass(/summary-panel-collapsed/);
  await expect(privateSummaryPanel).toHaveClass(/is-popover-collapsed/);
  await expect(privateSummaryPanel).toHaveCount(0);
  await privateToolbar.getByRole("button", { name: "Summary" }).click();
  await expect(privateSummaryPanel).toBeVisible();
  await privateToolbar.getByRole("button", { name: "Hide details" }).click();
  const privateTopSummary = page.locator(".teammate-chat-summary-popover");
  await expect(privateTopSummary).toBeVisible();
  await expect(privateTopSummary).toHaveAttribute("data-summary-placement-motion", "main->header");
  await expect(privateDock).toHaveCount(0);
  await expect(privateTopSummary).toContainText("Private workspace");
  await privateToolbar.getByRole("button", { name: "Summary" }).click();
  await privateToolbar.getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByLabel("Terminal session")).toBeVisible();
  await page.getByRole("button", { name: "Close terminal panel" }).click();
  await page.getByRole("button", { name: "Show details" }).click();
  await expect(privateDock).toContainText("Workspace tools");
  await page.getByRole("button", { name: "Context" }).click();
  await expect(page.getByLabel("Conversation context")).toBeVisible();
  const privateContextDarkSurfaces = await page.evaluate(() => {
    const selectors = [".teammate-private-context-page", ".teammate-private-context-page .ling-ui-data-row"];
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
  expect(privateContextDarkSurfaces.length).toBeGreaterThan(0);
  for (const surface of privateContextDarkSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on dark console tokens`).toBeLessThanOrEqual(45);
  }
  const pendingPrivateRow = page.locator(".teammate-message-row.ai-teammate").filter({ hasText: "AI teammate is replying..." });
  await expect(pendingPrivateRow).toBeVisible();
  await expect(pendingPrivateRow).toHaveClass(/message-bubble/);
  await expect(pendingPrivateRow).toHaveClass(/message-bubble-peer/);
  await expect(pendingPrivateRow).toHaveClass(/message-bubble-pending/);
  await expect(pendingPrivateRow.locator(".message-pending-spinner")).toBeVisible();
  await expect(pendingPrivateRow.locator(".status-badge")).toHaveCount(0);
  await page.locator(".teammate-direct-composer input[type=file]").setInputFiles({
    name: "private-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# private notes"),
  });
  await expect.poll(() => state.teammatePrivateAttachments.length).toBe(1);
  await expect(privateToolbar.getByRole("button", { name: "Private attachments: 1" })).toBeVisible();

  const privateComposer = page.locator(".teammate-direct-composer");
  await privateComposer.getByRole("button", { name: /Selected permission preset Workspace write/ }).click();
  await page.getByRole("menuitemradio", { name: /Read only/ }).click();
  await page.getByPlaceholder("Message this AI teammate privately").fill("Please refine the private workspace acceptance criteria.");
  await page.getByPlaceholder("Message this AI teammate privately").press("Enter");
  await expect.poll(() => state.lastTeammateDirectMessageRequest?.authorizationMode).toBe("smart");
  await expect.poll(() => state.lastTeammateDirectMessageRequest?.workspaceAccessMode).toBe("read_only");
  await expect(page.getByText("Please refine the private workspace acceptance criteria.")).toBeVisible();
  await expect(privateFeed.getByText("AI teammate is blocked: No provider preset is selected for this teammate.")).toBeVisible();
  const privateMessageRow = page.locator(".teammate-message-row").filter({ hasText: "Please refine the private workspace acceptance criteria." });
  await expect(privateMessageRow).toHaveClass(/message-bubble-inline/);
  await expect(privateMessageRow).toHaveClass(/message-bubble-own/);
  await expect(privateMessageRow.locator("header")).toHaveCount(0);
  await expect(privateMessageRow.locator(".status-badge")).toHaveCount(0);
  await expect(privateMessageRow.getByRole("link", { name: "private-notes.md" })).toHaveAttribute("href", /\/attachments\/tpatt_1\/content/);
  const privateActions = privateMessageRow.locator(".teammate-message-actions.message-action-bar");
  await expect(privateActions.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  await expect(privateActions.getByRole("button", { name: "Create task", exact: true })).toHaveCount(1);
  await expect(privateActions.getByRole("button", { name: "Like response", exact: true })).toHaveCount(0);
  await expect(privateActions.getByRole("button", { name: "Dislike response", exact: true })).toHaveCount(0);
  await expect(privateActions.getByRole("button", { name: "Reply in topic", exact: true })).toHaveCount(0);
  const blockedPrivateRow = page.locator(".teammate-message-row.ai-teammate").filter({ hasText: "AI teammate is blocked: No provider preset is selected for this teammate." });
  await expect(blockedPrivateRow).toHaveClass(/message-bubble-chat-blocked/);
  await expect(blockedPrivateRow).toHaveClass(/message-bubble-peer/);
  await expect(blockedPrivateRow.locator(".status-badge")).toHaveCount(0);
  await expect(blockedPrivateRow.locator(".teammate-message-actions.message-action-bar")).toHaveCount(0);
  await expect(page.getByLabel("Conversation context").getByText("Private acceptance memory")).toBeVisible();
  await expect.poll(() => state.teammateDirectMessages.length).toBe(4);
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) =>
      isRecord(item) && item.body === "Please refine the private workspace acceptance criteria."
    );
    return isRecord(message) && Array.isArray(message.attachmentIds) ? message.attachmentIds : [];
  }).toEqual(["tpatt_1"]);

  await privateMessageRow.hover();
  await privateMessageRow.getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => {
    const created = state.tasks.find((task) =>
      isRecord(task) &&
      task.prompt === "Please refine the private workspace acceptance criteria." &&
      task.assigneeTeammateId === teammateId
    );
    return isRecord(created) ? created.channelId : undefined;
  }).toBe("channel_engineering");

  await openPrivateChatSettings(page);
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: /^Tasks(?:\s|$)/u })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: /^Activity(?:\s|$)/u })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: /^Memory(?:\s|$)/u })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Danger zone", exact: true })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Tools and permissions", exact: true })).toBeVisible();
  await expect(page.locator("[data-ui2-teammate-tasks], [data-ui2-teammate-activity]")).toHaveCount(0);
  await settingsSections.getByRole("button", { name: /Channels/ }).click();
  await expect(page.getByText("Engineering").first()).toBeVisible();
  const designRow = page.locator(".teammate-channel-row").filter({ hasText: "Design" });
  await expect(designRow).toContainText("Not joined");
  await designRow.getByRole("button", { name: "Join" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
  )).toBe(true);
  await expect(designRow.getByRole("button", { name: "Set default" })).toBeEnabled();
  await expect.poll(() => {
    const membership = state.teammateChannelMemberships.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
    );
    return isRecord(membership) ? membership.isDefault : false;
  }).toBe(false);
  const engineeringRow = page.locator(".teammate-channel-row").filter({ hasText: "Engineering" });
  await engineeringRow.getByRole("button", { name: "Leave" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_engineering"
  )).toBe(false);

  await settingsSections.getByRole("button", { name: /Skills/ }).click();
  const skillsPanel = page.locator("[data-ui2-teammate-skills]");
  await expect(skillsPanel).toContainText("Implementation");
  await expect(skillsPanel.getByRole("button", { name: "Import skill" })).toHaveCount(0);
  await expect(skillsPanel.getByText("Advanced binding", { exact: true })).toHaveCount(0);
  const codeReviewSkillRow = skillsPanel.locator('[data-skill-id="review"]');
  await codeReviewSkillRow.click();
  const skillDetail = page.getByRole("dialog").filter({ hasText: "Code Review" });
  await skillDetail.getByText("Technical information", { exact: true }).click();
  await expect(skillDetail).toContainText("skill_source_review_mock");
  await expect(skillDetail).toContainText("sha256:review-mock");
  const skillsDarkSurfaces = await page.evaluate(() => {
    const selectors = [".teammate-skill-list", ".teammate-skill-detail-drawer"];
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
  await page.keyboard.press("Escape");
  await expect(skillDetail).toHaveCount(0);
  await skillsPanel.getByPlaceholder("Search skills or purposes").fill("Engineering Plan Review");
  const engineeringReviewRow = skillsPanel.locator('[data-skill-id="plan-eng-review"]');
  const engineeringReviewSwitch = engineeringReviewRow.getByRole("switch", { name: "Use skill for teammate: Engineering Plan Review" });
  await expect(engineeringReviewSwitch).not.toBeChecked();
  await engineeringReviewSwitch.click();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.skillId === "plan-eng-review" && item.enabled === true
  )).toBe(true);
  await expect(page.getByText("Skill enabled for teammate", { exact: true })).toBeVisible();
  await skillsPanel.getByPlaceholder("Search skills or purposes").fill("");
  const implementationRow = skillsPanel.locator('[data-skill-id="implement"]');
  await implementationRow.getByRole("switch", { name: "Use skill for teammate: Implementation" }).click();
  await expect.poll(() => {
    const binding = state.teammateSkillBindings.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.skillId === "implement"
    );
    return isRecord(binding) ? binding.enabled : undefined;
  }).toBe(false);

  await settingsSections.getByRole("button", { name: /Profile/ }).click();
  const profilePanel = page.getByLabel("Teammate profile");
  await profilePanel.getByLabel("Teammate name").fill("Renamed Engineer");
  await profilePanel.getByLabel("Description").fill("Updated teammate description from settings.");
  await profilePanel.getByText("Advanced profile", { exact: true }).click();
  await profilePanel.getByLabel("System prompt").fill("Updated teammate system prompt from settings.");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Teammate profile saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Single agent settings").getByRole("heading", { name: "Teammate settings", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Single agent settings")).not.toContainText("Renamed Engineer");
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate)
      ? {
          displayName: teammate.displayName,
          description: teammate.description,
          systemPrompt: teammate.systemPrompt,
        }
      : undefined;
  }).toEqual({
    displayName: "Renamed Engineer",
    description: "Updated teammate description from settings.",
    systemPrompt: "Updated teammate system prompt from settings.",
  });

  await settingsSections.getByRole("button", { name: /Model/ }).click();
  const modelPanel = page.getByLabel("Model assignment");
  const assignedModel = modelPanel.getByLabel("Assigned model");
  await assignedModel.selectOption("provider_alt");
  await expect(assignedModel.locator("option:checked")).toContainText("qwen-plus");
  await expect(modelPanel.getByLabel("Model summary")).toHaveCount(0);
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save model" }).click();
  await expect(page.getByText("Teammate model saved", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.providerPresetId : undefined;
  }).toBe("provider_alt");

  await page.getByRole("button", { name: "Back to private chat" }).click();
  await expect(page.getByRole("heading", { name: "Renamed Engineer", level: 1 })).toBeVisible();
  await privateComposer.getByRole("button", { name: /Selected permission preset/ }).click();
  await page.getByRole("menuitemradio", { name: /Read only/ }).click();
  await page.getByPlaceholder("Message this AI teammate privately").fill("Use the newly saved model.");
  await page.getByPlaceholder("Message this AI teammate privately").press("Enter");
  await expect(page.getByLabel("Private chat", { exact: true }).getByText("Private reply: I will refine this into a scoped task.")).toBeVisible();
  await expect.poll(() => state.lastTeammateDirectMessageRequest?.permissionPreset).toBe("read_only");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await openChannelTeammateManager(page);
  const channelTeammateManager = page.getByLabel("Channel teammates");
  const renamedEngineerChip = channelTeammateManager.locator(".channel-teammate-chip").filter({ hasText: "Renamed Engineer" });
  await expect(renamedEngineerChip).toBeVisible();
  await expect(renamedEngineerChip).not.toHaveClass(/default/);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Renamed Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Renamed Engineer", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Private chat", { exact: true }).getByText("AI teammate is blocked: No provider preset is selected for this teammate.")).toBeVisible();

  await openPrivateChatSettings(page);
  const teammateProfile = page.getByLabel("Teammate profile");
  await teammateProfile.getByText("Advanced profile", { exact: true }).click();
  await teammateProfile.getByRole("button", { name: "Import role profile" }).click();
  const personaPanel = page.getByRole("dialog", { name: "Import role profile" });
  await personaPanel.getByRole("radio", { name: "Paste content" }).click();
  await personaPanel.getByLabel("Role profile content").fill([
    "# Imported QA Persona",
    "Review private workspace changes carefully.",
    "Do not grant tools, approvals, secrets, or external send permissions.",
  ].join("\n"));
  await personaPanel.getByRole("button", { name: "Check content" }).click();
  await expect(personaPanel.getByLabel("Role profile preview")).toBeVisible();
  await expect(personaPanel.getByText("Permission-like persona text was ignored for authority changes.")).toBeVisible();
  await personaPanel.getByRole("button", { name: "Apply to profile" }).click();
  await expect(teammateProfile.getByLabel("Teammate name")).toHaveValue("Imported QA Persona");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? [teammate.displayName, teammate.appendSystemPrompt, teammate.allowedTools, teammate.approvalProfile] : undefined;
  }).toEqual(["Imported QA Persona", [], ["read", "grep", "find", "ls"], { mode: "standard", risk: "medium" }]);
  await expect(page.getByLabel("Single agent settings").getByRole("heading", { name: "Teammate settings", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Single agent settings")).not.toContainText("Imported QA Persona");

  await page.getByLabel("Upload avatar").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  const cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  await expect(cropDialog).toBeVisible();
  await cropDialog.getByRole("button", { name: "Use avatar" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : undefined;
  }).toBe("tpatt_2");
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image")).toBeVisible();
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image-default")).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row-shell.selected .teammate-avatar-image")).toBeVisible();

  await openAiTeammatesFromSettings(page);
  const rosterRowWithAvatar = page.locator(".teammate-draft-row").filter({ hasText: "Imported QA Persona" });
  await expect(rosterRowWithAvatar.locator(".teammate-avatar-image")).toBeVisible();
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await openChannelTeammateManager(page);
  const channelChipWithAvatar = page.getByLabel("Channel teammates").locator(".channel-teammate-chip").filter({ hasText: "Imported QA Persona" });
  await expect(channelChipWithAvatar.locator(".teammate-avatar-image")).toBeVisible();
  await expect(channelChipWithAvatar).not.toHaveClass(/default/);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Imported QA Persona" }).click();
  await openPrivateChatSettings(page);

  await page.getByLabel("Teammate profile").getByRole("button", { name: "Avatar options" }).click();
  await page.getByRole("menuitem", { name: "Restore default avatar" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : "missing";
  }).toBeUndefined();
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image-default")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row-shell.selected .teammate-avatar-image-default")).toBeVisible();

  const manageTeammate = page.locator("[data-ui2-teammate-danger]");
  await expect(manageTeammate.getByRole("heading", { name: "Manage teammate" })).toBeVisible();
  await manageTeammate.getByRole("button", { name: "Hard delete" }).click();
  const hardDeleteDialog = page.getByRole("dialog", { name: "Hard delete private data" });
  await expect(hardDeleteDialog).toBeVisible();
  await hardDeleteDialog.getByLabel("Reason").fill("owner request");
  await hardDeleteDialog.getByRole("button", { name: "Hard delete" }).click();
  await expect.poll(() => state.retentionTombstones.length).toBe(1);
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.id === teammateId)).toBe(false);
  await expect.poll(() => state.teammatePrivateAttachments.some((item) => isRecord(item) && item.teammateId === teammateId)).toBe(false);
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Renamed Engineer" })).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  const deletedHistoryMessage = page.locator(".message-group").filter({ hasText: "Historical channel reply from a teammate that will be deleted." });
  await expect(deletedHistoryMessage).toContainText("Deleted teammate");
  await expect(deletedHistoryMessage).not.toContainText(teammateId);
  expect(runtimeErrors).toEqual([]);
});

test("AI teammate settings save status and visibility fields", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const teammateId = "teammate_builtin_engineer";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  await openPrivateChatSettings(page);
  await page.getByLabel("Settings sections").getByRole("button", { name: /Profile/ }).click();
  const profilePanel = page.getByLabel("Teammate profile");
  await profilePanel.getByLabel("Status").selectOption("paused");
  await profilePanel.getByLabel("Sidebar display").selectOption("hidden");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[data-ling-overlay="toast"]').filter({ hasText: "Teammate profile saved" })).toBeVisible();

  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? [teammate.status, teammate.pinned, teammate.hidden] : undefined;
  }).toEqual(["paused", false, true]);
  await expect(page.getByRole("heading", { name: "Teammate settings", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Single agent settings")).not.toContainText("Ling Engineer");
});

test("AI teammate private chat previews image attachments and keeps them in message history", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  state.providers = [
    createChatProvider({
      id: "provider_local",
      displayName: "Local Relay",
      model: "vision-chat",
      input: ["text", "image"],
      capabilities: ["chat", "vision"],
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-06-04T00:00:00.000Z" },
    }),
  ];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: "provider_local" })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const privateComposer = page.locator(".teammate-direct-composer");
  await privateComposer.locator("input[type=file]").setInputFiles({
    name: "direct-shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(privateComposer.locator(".composer-preview-thumbnail[alt='direct-shot.png']")).toBeVisible();
  await expect.poll(() => {
    const attachment = state.teammatePrivateAttachments.find((item) => isRecord(item) && item.fileName === "direct-shot.png");
    return isRecord(attachment) ? attachment.kind : undefined;
  }).toBe("image");

  const privateInput = privateComposer.getByRole("textbox");
  await privateInput.fill("Please read this private image.");
  await privateInput.press("Enter");

  const privateChat = page.getByLabel("Private chat", { exact: true });
  const userMessage = privateChat.locator(".teammate-message-row.local-user").filter({ hasText: "Please read this private image." });
  await expect(userMessage).toContainText("direct-shot.png");
  await expect(privateChat.getByText("Private reply: I can see the image attachment direct-shot.png.")).toBeVisible();
  await expect(privateComposer.getByLabel("Pending message assets")).toHaveCount(0);
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) => isRecord(item) && item.body === "Please read this private image.");
    return isRecord(message) ? message.attachmentIds : [];
  }).toEqual(["tpatt_1"]);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const reloadedMessage = page.getByLabel("Private chat", { exact: true }).locator(".teammate-message-row.local-user").filter({ hasText: "Please read this private image." });
  await expect(reloadedMessage).toContainText("direct-shot.png");
});

test("AI teammate private chat opens latest messages and loads older history from the top", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_designer";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Designer" })];
  state.teammateDirectMessages = Array.from({ length: 106 }, (_, index) => ({
    id: `tdmsg_history_${index + 1}`,
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: index % 2 === 0 ? "local-user" : "ai-teammate",
    authorId: index % 2 === 0 ? "local-user" : teammateId,
    body: `private history ${index + 1}`,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 5, 16, 0, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 5, 16, 0, index, 0)).toISOString(),
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Designer" }).click();
  const privateChat = page.getByLabel("Private chat", { exact: true });
  await expect(privateChat.getByText("private history 106", { exact: true })).toBeVisible();
  await expect(privateChat.getByText("private history 1", { exact: true })).toHaveCount(0);

  const feed = privateChat.getByLabel("Private message feed");
  await feed.hover();
  await expect.poll(async () => {
    await page.mouse.wheel(0, -1800);
    await feed.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    return privateChat.getByText("private history 1", { exact: true }).count();
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(privateChat.getByText("private history 1", { exact: true })).toBeVisible();
});

test("AI teammate private chat demotes recovered provider preflight history", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const provider = createChatProvider({
    id: "provider_relay",
    displayName: "中转站",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-06-09T00:00:00.000Z",
    },
  });
  state.providers = [provider];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: "provider_relay" })];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_old_timeout",
      workspaceId: "workspace_default",
      threadId: `tdthread_${teammateId}`,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "AI teammate is blocked: 中转站: provider check failed (network_failed). Provider network check failed: The operation was aborted due to timeout",
      errorMessage: "中转站: provider check failed (network_failed). Provider network check failed: The operation was aborted due to timeout",
      attachmentIds: [],
      status: "blocked",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.getByText("正在加载队友工作区...")).toHaveCount(0, { timeout: 15_000 });
  const privateChat = page.locator(".teammate-private-chat");
  await expect(privateChat).toContainText("历史模型检查失败，当前模型已恢复。可以重新发送或继续对话。");
  await expect(privateChat).not.toContainText("AI teammate is blocked");
  await expect(privateChat).not.toContainText("Provider network check failed");
});

test("AI teammate private chat exposes direct reply guidance and stop controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateSkillBindings = [
    {
      teammateId,
      skillId: "review",
      source: "user",
      enabled: true,
      createdAt: "2026-05-29T00:08:00.000Z",
      updatedAt: "2026-05-29T00:08:00.000Z",
    },
  ];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_pending_reply",
      workspaceId: "workspace_default",
      threadId,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      attachmentIds: [],
      status: "pending",
      createdAt: "2026-05-29T00:09:58.000Z",
      updatedAt: "2026-05-29T00:09:58.000Z",
    },
  ];
  state.workUnits = [
    {
      id: "wu_direct_pending",
      workspaceId: "workspace_default",
      kind: "teammate_direct_reply",
      ownerType: "teammate",
      ownerId: teammateId,
      teammateId,
      idempotencyKey: "direct-reply:pending",
      status: "running",
      priority: 50,
      attemptCount: 1,
      activeAttemptId: "wua_direct_pending",
      createdByActor: "user",
      request: { sourceMessageId: "tdmsg_user_source" },
      timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
      linkedMessageId: "tdmsg_pending_reply",
      createdAt: "2026-05-29T00:09:57.000Z",
      updatedAt: "2026-05-29T00:09:58.000Z",
      startedAt: "2026-05-29T00:09:58.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.getByText("正在加载队友工作区...")).toHaveCount(0, { timeout: 15_000 });
  const guidance = page.getByLabel("正在回复");
  const privateComposer = page.locator(".teammate-direct-composer");
  await expect(privateComposer).toBeVisible();
  await expect(privateComposer).toHaveClass(/conversation-composer/);
  await expect(privateComposer.getByRole("button", { name: /选择的权限预设|Selected permission preset/ })).toBeVisible();
  await expect(privateComposer.getByRole("button", { name: /选择的模型|Selected model/ })).toHaveCount(0);
  await expect(privateComposer.getByRole("button", { name: /提及队友|Mention teammate/ })).toHaveCount(0);
  const privateInput = privateComposer.getByRole("textbox", { name: "输入引导，回车加入队列" });
  await expect(guidance).toBeVisible();
  await expect(guidance.locator("textarea")).toHaveCount(0);
  await expect(privateComposer.getByRole("button", { name: "停止回复" })).toBeEnabled();

  await privateInput.fill("/rev");
  await expect(page.getByRole("listbox", { name: /Slash command|命令/ })).toBeVisible();
  await page.getByRole("option", { name: /^\/review\b/ }).click();
  await expect(privateInput).toHaveAttribute("data-value", "/review ");

  await replaceTokenizedComposerValue(privateInput, "Continue with only risks after this reply.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.map((item) => [item.mode, item.status, item.instruction])).toEqual([
    ["queue_followup", "queued", "Continue with only risks after this reply."],
  ]);
  await expect(privateInput).toHaveAttribute("data-value", "");
  await expect(guidance).toContainText("已排队");
  await expect(guidance.getByRole("button", { name: "立即执行这条引导" })).toBeEnabled();
  await expect(guidance.getByRole("button", { name: "删除排队引导" })).toBeEnabled();
  await guidance.getByRole("button", { name: "更多引导操作" }).click();
  await expect(page.getByRole("menuitem", { name: "编辑消息" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "关闭排队" })).toBeVisible();
  await page.getByRole("menuitem", { name: "编辑消息" }).click();
  await expect(privateInput).toHaveAttribute("data-value", "Continue with only risks after this reply.");
  await expect.poll(() => state.teammateDirectInterventions[0]?.status).toBe("cancelled");

  const guidanceAfterCancel = page.getByLabel("正在回复");
  await replaceTokenizedComposerValue(privateInput, "Line one");
  await privateInput.press("Shift+Enter");
  await expect(privateInput).toHaveAttribute("data-value", "Line one\n");
  await expect.poll(() => state.teammateDirectInterventions.filter((item) => item.status === "queued").length).toBe(0);

  await replaceTokenizedComposerValue(privateInput, "Close only this queued guidance.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.filter((item) => item.status === "queued").map((item) => item.instruction)).toEqual([
    "Close only this queued guidance.",
  ]);
  await expect(privateInput).toHaveAttribute("data-value", "");
  await replaceTokenizedComposerValue(privateInput, "Keep this queued guidance.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.filter((item) => item.status === "queued").map((item) => item.instruction)).toEqual([
    "Close only this queued guidance.",
    "Keep this queued guidance.",
  ]);
  const closeOnlyRow = guidanceAfterCancel.locator(".conversation-guidance-row").filter({ hasText: "Close only this queued guidance." });
  await closeOnlyRow.getByRole("button", { name: "更多引导操作" }).click();
  await page.getByRole("menuitem", { name: "关闭排队" }).click();
  await expect.poll(() => {
    const closed = state.teammateDirectInterventions.find((item) => item.instruction === "Close only this queued guidance.");
    const kept = state.teammateDirectInterventions.find((item) => item.instruction === "Keep this queued guidance.");
    return [closed?.status, kept?.status];
  }).toEqual(["cancelled", "queued"]);
  const keptRow = guidanceAfterCancel.locator(".conversation-guidance-row").filter({ hasText: "Keep this queued guidance." });
  await expect(keptRow).toBeVisible();
  await expect(keptRow.getByRole("button", { name: "立即执行这条引导" })).toBeVisible();
  await keptRow.getByRole("button", { name: "删除排队引导" }).click();
  await expect.poll(() => {
    const kept = state.teammateDirectInterventions.find((item) => item.instruction === "Keep this queued guidance.");
    return kept?.status;
  }).toBe("cancelled");

  await replaceTokenizedComposerValue(privateInput, "Run this queued guidance immediately.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("queued");
  await guidanceAfterCancel.locator(".conversation-guidance-row").filter({ hasText: "Run this queued guidance immediately." }).getByRole("button", { name: "立即执行这条引导" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("cancelling_source");
  await expect.poll(() => state.workUnits[0]?.status).toBe("cancelled");
  await expect(page.getByLabel("私聊引导")).toContainText("正在停止");

  state.workUnits[0] = {
    ...state.workUnits[0],
    status: "running",
    endedAt: undefined,
    updatedAt: "2026-06-04T00:33:00.000Z",
  };
  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const resumedComposer = page.locator(".teammate-direct-composer");
  const resumedInput = resumedComposer.getByRole("textbox", { name: "输入引导，回车加入队列" });
  await resumedInput.fill("Keep this draft while stopping.");
  await expect(resumedComposer.getByRole("button", { name: "排队执行" })).toBeEnabled();
  await resumedComposer.getByRole("button", { name: "排队执行" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.instruction).toBe("Keep this draft while stopping.");
  await expect(resumedInput).toHaveAttribute("data-value", "");
  await expect(resumedComposer.getByRole("button", { name: "停止回复" })).toBeEnabled();

  await resumedComposer.getByRole("button", { name: "停止回复" }).click();
  await expect.poll(() => state.workUnits[0]?.status).toBe("cancelled");
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) => isRecord(item) && item.id === "tdmsg_pending_reply");
    return isRecord(message) ? message.status : undefined;
  }).toBe("cancelled");
  await expect(page.locator(".teammate-direct-composer").getByRole("button", { name: "停止回复" })).toHaveCount(0);
  await expect(page.getByLabel("私聊消息流").getByText("回复已停止").first()).toBeVisible();
});

test("AI teammate private chat queues image attachments in direct guidance", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_pending_reply",
      workspaceId: "workspace_default",
      threadId,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "pending",
      createdAt: "2026-06-04T00:45:00.000Z",
      updatedAt: "2026-06-04T00:45:00.000Z",
    },
  ];
  state.workUnits = [
    {
      id: "wu_direct_pending",
      workspaceId: "workspace_default",
      kind: "teammate_direct_reply",
      ownerType: "teammate",
      ownerId: teammateId,
      teammateId,
      idempotencyKey: "direct-reply:pending",
      status: "running",
      priority: 50,
      attemptCount: 1,
      activeAttemptId: "wua_direct_pending",
      createdByActor: "user",
      request: { sourceMessageId: "tdmsg_user_source" },
      timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
      linkedMessageId: "tdmsg_pending_reply",
      createdAt: "2026-06-04T00:44:59.000Z",
      updatedAt: "2026-06-04T00:45:00.000Z",
      startedAt: "2026-06-04T00:45:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const privateComposer = page.locator(".teammate-direct-composer");
  await privateComposer.locator("input[type=file]").setInputFiles({
    name: "queued-shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(privateComposer.locator(".composer-preview-thumbnail[alt='queued-shot.png']")).toBeVisible();
  const privateInput = privateComposer.getByRole("textbox");
  await privateInput.fill("Use this new image before answering.");
  await privateInput.press("Enter");

  const guidance = page.getByLabel("正在回复");
  const queuedRow = guidance.locator(".conversation-guidance-row").filter({ hasText: "Use this new image before answering." });
  await expect(queuedRow).toContainText("queued-shot.png");
  await expect.poll(() => {
    const intervention = state.teammateDirectInterventions.at(-1);
    return intervention?.messagePayload;
  }).toEqual({
    body: "Use this new image before answering.",
    attachmentIds: ["tpatt_1"],
    linkPreviewIds: [],
    fileRefs: [],
  });

  await queuedRow.getByRole("button", { name: "立即执行这条引导" }).click();
  await expect.poll(() => {
    const intervention = state.teammateDirectInterventions.at(-1);
    return [intervention?.status, intervention?.messagePayload?.attachmentIds];
  }).toEqual(["cancelling_source", ["tpatt_1"]]);
});

test("AI teammate private chat keeps queued guidance from bypassing into a new message", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateDirectThreads[teammateId] = {
    id: threadId,
    workspaceId: "workspace_default",
    teammateId,
    title: "Ling Engineer",
    createdAt: "2026-06-04T00:40:00.000Z",
    updatedAt: "2026-06-04T00:40:00.000Z",
  };
  state.teammateDirectInterventions = [
    {
      id: "tdint_orphaned_queue",
      workspaceId: "workspace_default",
      teammateId,
      threadId,
      sourceMessageId: "tdmsg_old_source",
      sourceWorkUnitId: "wu_old_direct_reply",
      mode: "queue_followup",
      status: "queued",
      instruction: "Use the queued guidance before any new message.",
      idempotencyKey: "orphaned-queue",
      requestedBy: "local-user",
      createdAt: "2026-06-04T00:40:01.000Z",
      updatedAt: "2026-06-04T00:40:01.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const guidance = page.getByLabel("私聊引导");
  const queuedRow = guidance.locator(".conversation-guidance-row").filter({ hasText: "Use the queued guidance before any new message." });
  await expect(queuedRow).toBeVisible();
  await expect(queuedRow.getByRole("button", { name: "立即执行这条引导" })).toBeVisible();

  const privateComposer = page.locator(".teammate-direct-composer");
  await expect(privateComposer.getByPlaceholder("已有排队引导，等待执行或点击立即执行")).toBeVisible();
  await expect(privateComposer.getByRole("button", { name: "发送" })).toBeDisabled();
  await privateComposer.getByPlaceholder("已有排队引导，等待执行或点击立即执行").fill("This should not bypass the queued row.");
  await privateComposer.getByPlaceholder("已有排队引导，等待执行或点击立即执行").press("Enter");
  await expect.poll(() => state.teammateDirectMessages.length).toBe(0);
  await expect(page.getByText("已有排队引导，先执行或删除队列消息。")).toBeVisible();
});
