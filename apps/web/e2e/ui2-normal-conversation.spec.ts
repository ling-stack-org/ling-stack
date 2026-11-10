import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/normal-conversation/",
  import.meta.url,
));

for (const fixture of [
  { theme: "light" as const, width: 1440, height: 960 },
  { theme: "dark" as const, width: 1280, height: 800 },
]) {
  test(`normal conversation header and search match the channel contract at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider({
      id: "provider_ui2_normal_conversation",
      displayName: "Local Relay",
      model: "gpt-5.5",
    })];
    const threadId = installNormalConversationFixture(state);
    await mockDaemon(page, state);

    let detailReads = 0;
    await page.route(new RegExp(`/conversations/${threadId}(?:\\?.*)?$`, "u"), async (route) => {
      detailReads += 1;
      if (detailReads > 1) await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fallback();
    });

    await page.goto("/");
    await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: "Deployment readiness" }).click();

    const conversation = page.getByLabel("Conversation page");
    const header = page.locator("[data-ui2-normal-conversation-header='true']");
    const toolbar = header.getByRole("toolbar", { name: "Conversation workspace toolbar" });
    const identity = header.locator(".normal-conversation-identity");
    const feed = conversation.getByLabel("Conversation messages", { exact: true });
    const composer = conversation.locator(".normal-conversation-composer-stack");

    await expect(header).toBeVisible();
    await expect(identity).toContainText("Deployment readiness conversation");
    await expectToolbarActions(toolbar, ["search", "summary", "terminal", "details"]);
    expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(48);
    await expectAlignedConversationColumns(feed, composer);
    await expectHeaderSlotsDoNotOverlap(identity, toolbar);

    const searchTrigger = toolbar.getByRole("button", { name: "Search" });
    await searchTrigger.click();
    const search = header.getByRole("search", { name: "Search conversation messages" });
    const searchInput = search.getByRole("textbox", { name: "Search conversation messages" });
    await expect(searchInput).toBeFocused();
    await expectSearchContained(search, header);

    await searchInput.fill("needle-body");
    await expect(feed.locator(".normal-conversation-message-row")).toHaveCount(1);
    await expect(feed).toContainText("needle-body");

    await searchInput.fill("architecture-notes.pdf");
    await expect(feed.locator(".normal-conversation-message-row")).toHaveCount(1);
    await expect(feed).toContainText("architecture-notes.pdf");

    await searchInput.fill("Deployment readiness run");
    await expect(feed.locator(".normal-conversation-message-row")).toHaveCount(1);
    await expect(feed).toContainText("Ling Agent response for the deployment fixture");

    await searchInput.fill("no-result-fixture");
    await expect(feed.getByText("No matching conversation messages", { exact: true })).toBeVisible();

    await search.getByRole("button", { name: "Clear search" }).click();
    await expect(searchInput).toHaveValue("");
    await expect(searchInput).toBeFocused();
    await expect(feed.locator(".normal-conversation-message-row")).toHaveCount(2);

    await searchInput.fill("needle-body");
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(searchTrigger).toBeFocused();
    expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(48);

    await searchTrigger.click();
    await expect(header.getByRole("textbox", { name: "Search conversation messages" })).toHaveValue("");
    await page.keyboard.press("Escape");

    await expect(toolbar.getByRole("button", { name: "Refresh" })).toHaveCount(0);
    await expect(toolbar.getByRole("button", { name: "Summary", exact: true })).toBeEnabled();

    await searchTrigger.click();
    const evidenceSearch = header.getByRole("search", { name: "Search conversation messages" });
    await evidenceSearch.getByRole("textbox", { name: "Search conversation messages" }).fill("architecture-notes.pdf");
    await expectSearchContained(evidenceSearch, header);
    await expect(feed).toContainText("architecture-notes.pdf");

    const titlebarSurface = page.locator("[data-desktop-window-titlebar-surface='true']");
    const headerTheme = await titlebarSurface.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-panel");
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(element).backgroundColor, expected };
    });
    expect(headerTheme.actual).toBe(headerTheme.expected);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-normal-header-search.png`);
    expect(runtimeErrors).toEqual([]);
  });
}

function installNormalConversationFixture(state: MockState): string {
  const threadId = "thread_ui2_normal_conversation";
  const turnId = "turn_ui2_normal_conversation";
  const runId = "run_ui2_normal_conversation";
  const createdAt = "2026-07-19T02:00:00.000Z";
  const completedAt = "2026-07-19T02:01:00.000Z";
  const title = "Deployment readiness conversation with a deliberately long identity for containment";

  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title,
    objective: "Verify the UI 2.0 normal conversation header and search contract.",
    status: "succeeded",
    lastRunId: runId,
    createdAt,
    updatedAt: completedAt,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title,
    userInstruction: "Find the needle-body message and inspect the attached architecture notes.",
    activeRunId: runId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt,
    updatedAt: completedAt,
    completedAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt }];
  state.runs = [{
    id: runId,
    status: "succeeded",
    cwd,
    taskId: "task_ui2_normal_conversation",
    providerPresetId: "provider_ui2_normal_conversation",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_ui2_normal_conversation", title: "Deployment readiness run" },
    providerSnapshot: {},
    requestSnapshot: { conversationAttachmentIds: ["attachment_ui2_normal_conversation"] },
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    createdAt,
    startedAt: createdAt,
    updatedAt: completedAt,
    endedAt: completedAt,
  }, ...state.runs];
  state.eventsByRun[runId] = [{
    id: "event_ui2_normal_conversation",
    runId,
    seq: 1,
    ts: completedAt,
    type: "assistant_text_delta",
    data: { text: "Ling Agent response for the deployment fixture" },
  }];
  state.conversationAttachments = [{
    id: "attachment_ui2_normal_conversation",
    workspaceId: "workspace_default",
    threadId,
    turnId,
    kind: "document",
    fileName: "architecture-notes.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    path: `conversations/${threadId}/architecture-notes.pdf`,
    createdAt,
  }];
  return threadId;
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
