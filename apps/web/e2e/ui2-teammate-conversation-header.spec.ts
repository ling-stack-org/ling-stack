import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/teammate-conversation-header/",
  import.meta.url,
));

for (const fixture of [
  { theme: "light" as const, width: 1440, height: 960 },
  { theme: "dark" as const, width: 1280, height: 800 },
]) {
  test(`AI teammate header and search match the channel contract at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const runtimeErrors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    const teammateId = installTeammateHeaderFixture(state);
    await mockDaemon(page, state);

    let messageReads = 0;
    await page.route(new RegExp(`/teammates/${teammateId}/direct-messages(?:\\?.*)?$`, "u"), async (route) => {
      messageReads += 1;
      if (messageReads > 1) await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fallback();
    });

    await page.goto("/");
    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /Ling Research Engineer/ }).click();

    const header = page.locator("[data-ui2-teammate-chat-header='true']");
    const identity = header.locator(".teammate-workspace-identity");
    const toolbar = header.getByRole("toolbar", { name: "Private chat actions" });
    const feed = page.getByLabel("Private message feed", { exact: true });
    const composer = page.locator(".teammate-direct-composer");
    await expect(header).toBeVisible();
    await expect(identity).toContainText("Ling Research Engineer");
    await expect(header.locator(".teammate-chat-alert-row")).toHaveCount(0);
    await expect(header).not.toContainText("Model ready");
    await expect(header).not.toContainText("Memory on");
    const attachments = toolbar.getByRole("button", { name: "Private attachments: 1" });
    await expect(attachments).toBeVisible();
    await expect(attachments.locator("xpath=..").getByText("1", { exact: true })).toBeVisible();
    await expectToolbarActions(toolbar, ["search", "refresh", "summary", "files", "terminal", "details"]);
    expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(48);
    await expectAlignedConversationColumns(feed, composer);
    await expectHeaderSlotsDoNotOverlap(identity, toolbar);

    await toolbar.getByRole("button", { name: "Summary" }).click();
    const summary = page.locator(".teammate-chat-summary-popover");
    await expect(summary).toContainText("Memory");
    await expect(summary).toContainText(/Memory on|Memory preparing/u);
    await toolbar.getByRole("button", { name: "Summary" }).click();

    const searchTrigger = toolbar.getByRole("button", { name: "Search" });
    await searchTrigger.click();
    const search = header.getByRole("search", { name: "Search private messages" });
    const searchInput = search.getByRole("textbox", { name: "Search private messages" });
    await expect(searchInput).toBeFocused();
    await expectSearchContained(search, header);

    await searchInput.fill("needle-body");
    await expect(feed.locator(".teammate-message-row")).toHaveCount(1);
    await expect(feed).toContainText("needle-body");

    await searchInput.fill("private-architecture.pdf");
    await expect(feed.locator(".teammate-message-row")).toHaveCount(1);
    await expect(feed).toContainText("private-architecture.pdf");

    await searchInput.fill("teammate-search-target.tsx");
    await expect(feed.locator(".teammate-message-row")).toHaveCount(1);
    await expect(feed).toContainText("teammate-search-target.tsx");

    await searchInput.fill("Private search reference");
    await expect(feed.locator(".teammate-message-row")).toHaveCount(1);
    await expect(feed).toContainText("Private search reference");

    await searchInput.fill("AI reply search token");
    await expect(feed.locator(".teammate-message-row")).toHaveCount(1);
    await expect(feed).toContainText("AI reply search token");

    await searchInput.fill("no-result-fixture");
    await expect(feed.getByText("No private messages match search", { exact: true })).toBeVisible();

    await search.getByRole("button", { name: "Clear search" }).click();
    await expect(searchInput).toHaveValue("");
    await expect(searchInput).toBeFocused();
    await expect(feed.locator(".teammate-message-row")).toHaveCount(5);

    await searchInput.fill("needle-body");
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(searchTrigger).toBeFocused();
    expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(48);

    const refresh = toolbar.getByRole("button", { name: "Refresh" });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh.locator(".ling-ui-spinner")).toHaveCount(1);
    await expect(toolbar.getByRole("button", { name: "Summary" })).toBeEnabled();
    await expect(feed).toBeVisible();
    await expect(refresh).toBeEnabled();

    await searchTrigger.click();
    await header.getByRole("textbox", { name: "Search private messages" }).fill("private-architecture.pdf");
    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Review Partner" }).click();
    await expect(page.locator("[data-ui2-teammate-chat-header='true']")).toContainText("Review Partner");
    await expect(page.getByRole("search", { name: "Search private messages" })).toHaveCount(0);
    await expect(page.getByLabel("Private chat actions").getByRole("button", { name: /^Private attachments:/u })).toHaveCount(0);

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /Ling Research Engineer/ }).click();
    const restoredHeader = page.locator("[data-ui2-teammate-chat-header='true']");
    await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
    await restoredHeader.getByRole("button", { name: "Search" }).click();
    const restoredSearchInput = restoredHeader.getByRole("textbox", { name: "Search private messages" });
    await expect(restoredSearchInput).toHaveValue("");
    await restoredSearchInput.fill("private-architecture.pdf");
    await expect(feed.locator(".teammate-message-row")).toHaveCount(1);
    await expect(feed).toContainText("private-architecture.pdf");
    await expectSearchContained(restoredHeader.getByRole("search", { name: "Search private messages" }), restoredHeader);

    const headerTheme = await restoredHeader.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-panel");
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(element).backgroundColor, expected };
    });
    expect(headerTheme.actual).toBe(headerTheme.expected);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-teammate-header-search.png`);
    expect(runtimeErrors).toEqual([]);
  });
}

function installTeammateHeaderFixture(state: MockState): string {
  const teammateId = "teammate_ui2_header";
  const threadId = `tdthread_${teammateId}`;
  const timestamp = "2026-07-19T08:00:00.000Z";
  state.providers = [createChatProvider({
    id: "provider_ui2_teammate_header",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: timestamp },
  })];
  state.aiTeammates = [
    createMockTeammate({
      id: teammateId,
      displayName: "Ling Research Engineer with a deliberately long identity for containment",
      providerPresetId: "provider_ui2_teammate_header",
    }),
    createMockTeammate({
      id: "teammate_ui2_review_partner",
      displayName: "Review Partner",
      providerPresetId: "provider_ui2_teammate_header",
    }),
  ];
  state.teammatePrivateAttachments = [{
    id: "attachment_ui2_teammate_header",
    workspaceId: "workspace_default",
    teammateId,
    threadId,
    messageId: "message_ui2_teammate_attachment",
    scope: "teammate_direct_thread",
    kind: "document",
    fileName: "private-architecture.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    path: `teammates/${teammateId}/direct/${threadId}/private-architecture.pdf`,
    createdAt: timestamp,
  }];
  state.teammateDirectLinkPreviews = [{
    id: "link_ui2_teammate_header",
    workspaceId: "workspace_default",
    teammateId,
    threadId,
    messageId: "message_ui2_teammate_link",
    url: "https://example.com/private-search",
    normalizedUrl: "https://example.com/private-search",
    title: "Private search reference",
    description: "Link preview search evidence",
    siteName: "Example Docs",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.teammateDirectMessages = [
    directMessage(teammateId, threadId, "message_ui2_teammate_body", "local-user", "Find the needle-body message.", timestamp),
    { ...directMessage(teammateId, threadId, "message_ui2_teammate_attachment", "local-user", "Inspect the attachment.", timestamp), attachmentIds: ["attachment_ui2_teammate_header"] },
    { ...directMessage(teammateId, threadId, "message_ui2_teammate_file", "local-user", "Inspect the workspace reference.", timestamp), fileRefs: [{ path: "apps/web/src/teammate-search-target.tsx", label: "teammate-search-target.tsx", line: 42 }] },
    { ...directMessage(teammateId, threadId, "message_ui2_teammate_link", "local-user", "Inspect the web reference.", timestamp), linkPreviewIds: ["link_ui2_teammate_header"] },
    directMessage(teammateId, threadId, "message_ui2_teammate_reply", "ai-teammate", "AI reply search token is ready.", timestamp),
  ];
  return teammateId;
}

function directMessage(
  teammateId: string,
  threadId: string,
  id: string,
  authorType: "local-user" | "ai-teammate",
  body: string,
  timestamp: string,
): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    threadId,
    teammateId,
    authorType,
    authorId: authorType === "ai-teammate" ? teammateId : "local-user",
    body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function expectToolbarActions(toolbar: Locator, expected: readonly string[]): Promise<void> {
  await expect(toolbar).toHaveAttribute("data-conversation-toolbar", "true");
  expect(await toolbar.locator("[data-conversation-action]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-action")),
  )).toEqual(expected);
}

async function expectAlignedConversationColumns(feed: Locator, composer: Locator): Promise<void> {
  await expect.poll(async () => {
    const feedBox = await feed.boundingBox();
    const composerBox = await composer.boundingBox();
    if (!feedBox || !composerBox) return false;
    return Math.abs(feedBox.x - composerBox.x) <= 1 && Math.abs(feedBox.width - composerBox.width) <= 1;
  }).toBe(true);
}

async function expectHeaderSlotsDoNotOverlap(identity: Locator, toolbar: Locator): Promise<void> {
  const identityBox = await identity.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  expect(identityBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(identityBox!.x + identityBox!.width).toBeLessThanOrEqual(toolbarBox!.x - 8);
}

async function expectSearchContained(search: Locator, header: Locator): Promise<void> {
  const searchBox = await search.boundingBox();
  const headerBox = await header.boundingBox();
  const inputMetrics = await search.getByRole("textbox").evaluate((element) => {
    const shell = element.closest(".conversation-header-search-input");
    if (!shell) throw new Error("Conversation search Input shell is missing");
    return {
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      shellHeight: shell.getBoundingClientRect().height,
    };
  });
  expect(searchBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(searchBox!.y).toBeGreaterThanOrEqual(headerBox!.y - 1);
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height + 1);
  expect(inputMetrics.lineHeight).toBeLessThanOrEqual(inputMetrics.shellHeight - 8);
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
