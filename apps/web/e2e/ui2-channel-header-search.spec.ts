import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-header-search/",
  import.meta.url,
));

test("channel header search keeps the toolbar stable and searches channel activity", async ({ page }) => {
  await useEnglishLightSurface(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels.push({
    ...(state.channels[0] as Record<string, unknown>),
    id: "channel_operations",
    name: "Operations",
    defaultTeammateId: undefined,
    createdAt: "2026-07-19T07:59:00.000Z",
    updatedAt: "2026-07-19T07:59:00.000Z",
  });
  state.channelMessages = [
    channelMessage({
      id: "message_release_checklist",
      body: "Release checklist is ready for review.",
      createdAt: "2026-07-19T08:00:00.000Z",
    }),
    channelMessage({
      id: "message_architecture_attachment",
      body: "The supporting document is attached.",
      attachmentIds: ["attachment_architecture_notes"],
      createdAt: "2026-07-19T08:01:00.000Z",
    }),
  ];
  state.channelAttachments = [
    {
      id: "attachment_architecture_notes",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      messageId: "message_architecture_attachment",
      kind: "pdf",
      fileName: "architecture-notes.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      path: ".ling-stack/attachments/architecture-notes.pdf",
      createdAt: "2026-07-19T08:01:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const header = page.locator(".task-workbench-header");
  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  const actionIds = await toolbar.locator("[data-conversation-action]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-action")),
  );
  expect(actionIds).toEqual(["search", "refresh", "teammates", "summary", "terminal", "details"]);

  const searchButton = toolbar.getByRole("button", { name: "Search" });
  const refreshButton = toolbar.getByRole("button", { name: "Refresh" });
  await expect(searchButton).toHaveAttribute("data-icon-only", "true");
  await expect(refreshButton).toHaveAttribute("data-icon-only", "true");
  await expectMinimumHitArea(searchButton);
  await expectMinimumHitArea(refreshButton);

  const headerHeight = Math.round((await header.boundingBox())?.height ?? 0);
  await searchButton.click();
  const searchInput = page.getByRole("textbox", { name: "Search channel activity" });
  await expect(searchInput).toBeFocused();
  await expect(header).toHaveClass(/channel-header-searching/u);
  expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(headerHeight);
  await expect(page.getByLabel("Channel event filters")).toHaveCount(0);

  await searchInput.fill("Release checklist");
  await expect(page.getByLabel("Channel message feed")).toContainText("Release checklist is ready for review.");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("The supporting document is attached.");

  await searchInput.fill("architecture-notes.pdf");
  await expect(page.getByLabel("Channel message feed")).toContainText("The supporting document is attached.");
  await expect(page.getByLabel("Channel message feed")).not.toContainText("Release checklist is ready for review.");

  await searchInput.fill("Inspect workspace");
  await expect(page.getByLabel("Channel message feed")).toContainText("Inspect workspace");

  await searchInput.fill("no matching channel activity");
  await expect(page.getByLabel("Channel message feed")).toContainText("No activity matches these filters");
  await expect(page.getByLabel("Channel composer")).toBeVisible();

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(searchInput).toHaveValue("");
  await expect(searchInput).toBeFocused();
  await expect(header).toHaveClass(/channel-header-searching/u);

  await searchInput.fill("Release checklist");
  await searchInput.press("Escape");
  await expect(searchInput).toHaveCount(0);
  await expect(searchButton).not.toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Channel message feed")).toContainText("Release checklist is ready for review.");
  await expect(page.getByLabel("Channel message feed")).toContainText("The supporting document is attached.");

  await searchButton.click();
  await page.getByRole("textbox", { name: "Search channel activity" }).fill("Release checklist");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Operations" }).click();
  await expect(page.getByRole("textbox", { name: "Search channel activity" })).toHaveCount(0);
  await expect(page.locator(".channel-title-line h1")).toHaveText("Operations");
  await expect(page.getByLabel("Channel message feed")).toContainText("No channel messages yet");
  await expectNoDocumentOverflow(page);
});

test("channel header refresh and search keep local state and overlays independent", async ({ page }) => {
  await useEnglishLightSurface(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [channelMessage({
    id: "message_refresh_source",
    body: "Refresh source message.",
    createdAt: "2026-07-19T08:05:00.000Z",
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const header = page.locator(".task-workbench-header");
  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  const searchButton = toolbar.getByRole("button", { name: "Search" });
  const refreshButton = toolbar.getByRole("button", { name: "Refresh" });
  const summaryButton = toolbar.getByRole("button", { name: "Summary" });
  const teammateButton = toolbar.getByRole("button", { name: "AI teammate management" });

  await summaryButton.click();
  await expect(page.locator(".channel-progress-popover")).toBeVisible();
  await searchButton.click();
  await expect(page.getByRole("textbox", { name: "Search channel activity" })).toBeFocused();
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);

  await searchButton.click();
  await expect(page.getByRole("textbox", { name: "Search channel activity" })).toHaveCount(0);
  await teammateButton.click();
  await expect(page.locator(".channel-teammate-dock")).toBeVisible();
  await searchButton.click();
  await expect(page.locator(".channel-teammate-dock")).toHaveCount(0);
  const searchInput = page.getByRole("textbox", { name: "Search channel activity" });
  await searchInput.fill("Refresh source");
  await searchButton.click();
  await expect(searchInput).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed")).toContainText("Refresh source message.");

  await page.route("**/channels/channel_engineering/messages?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fallback();
  });
  const initialQueryCount = state.channelMessageQueries?.length ?? 0;
  const headerHeight = Math.round((await header.boundingBox())?.height ?? 0);
  await refreshButton.click();
  await expect(refreshButton).toHaveAttribute("aria-busy", "true");
  await expect(refreshButton).toBeDisabled();
  await expect(summaryButton).toBeEnabled();
  await expect(toolbar).not.toHaveAttribute("aria-busy", "true");
  expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(headerHeight);
  await expect.poll(() => state.channelMessageQueries?.length ?? 0).toBeGreaterThan(initialQueryCount);
  await expect(refreshButton).not.toHaveAttribute("aria-busy", "true");
  await expect(refreshButton).toBeEnabled();
});

for (const fixture of [
  { theme: "light" as const, width: 1440, height: 960 },
  { theme: "dark" as const, width: 1280, height: 800 },
]) {
  test(`channel header search keeps long identity and controls separate at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const state = createBaseState({ approvalStatus: "expired" });
    state.channels = state.channels.map((channel) => ({
      ...(channel as Record<string, unknown>),
      name: "Engineering release coordination and architecture review workspace",
    }));
    state.aiTeammates = [
      createMockTeammate({ id: "teammate_header_engineer", displayName: "Engineer" }),
      createMockTeammate({ id: "teammate_header_designer", displayName: "Designer" }),
      createMockTeammate({ id: "teammate_header_qa", displayName: "QA" }),
    ];
    state.teammateChannelMemberships = state.aiTeammates.map((teammate) => ({
      teammateId: String(teammate.id),
      channelId: "channel_engineering",
      isDefault: false,
      createdAt: "2026-07-19T08:10:00.000Z",
      updatedAt: "2026-07-19T08:10:00.000Z",
    }));
    state.channelMessages = [channelMessage({
      id: "message_visual_search",
      body: "Architecture review is ready.",
      createdAt: "2026-07-19T08:10:00.000Z",
    })];
    await mockDaemon(page, state);
    await page.goto("/");
    await page.getByLabel("Ling Stack navigation").getByRole("button", {
      name: "Engineering release coordination and architecture review workspace",
    }).click();

    const header = page.locator(".task-workbench-header");
    const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
    await toolbar.getByRole("button", { name: "Search" }).click();
    const search = page.getByRole("search", { name: "Search channel activity" });
    await search.getByRole("textbox").fill("Architecture review");

    await expect.poll(async () => Math.round((await header.boundingBox())?.height ?? 0)).toBe(48);
    await expect.poll(async () => {
      const headerBox = await header.boundingBox();
      const inputBox = await search.getByRole("textbox").boundingBox();
      return headerBox && inputBox
        ? inputBox.y >= headerBox.y && inputBox.y + inputBox.height <= headerBox.y + headerBox.height
        : false;
    }).toBe(true);
    await expect.poll(async () => {
      const searchBox = await search.boundingBox();
      const toolbarBox = await toolbar.boundingBox();
      return searchBox && toolbarBox ? Math.round(toolbarBox.x - (searchBox.x + searchBox.width)) : -1;
    }).toBeGreaterThanOrEqual(8);
    await expect(page.locator(".channel-title-line h1")).toHaveCSS("text-overflow", "ellipsis");
    await expect(page.getByLabel("Channel message feed")).toContainText("Architecture review is ready.");
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-channel-header-search.png`);
    expect(runtimeErrors).toEqual([]);
  });
}

function channelMessage(input: {
  readonly id: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly createdAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: input.body,
    mentions: [],
    attachmentIds: input.attachmentIds ?? [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

async function expectMinimumHitArea(button: import("@playwright/test").Locator): Promise<void> {
  const box = await button.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(32);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(32);
}

async function useEnglishLightSurface(page: Page): Promise<void> {
  await prepareSurface(page, "light", 1440, 960);
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
