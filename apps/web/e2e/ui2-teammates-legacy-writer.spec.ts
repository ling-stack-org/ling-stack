import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { openEngineeringChannel } from "./support/test-helpers";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/teammates-legacy-writer/",
  import.meta.url,
));

test.describe("T13-O.21 Teammates legacy writer release", () => {
  test("stage 1 keeps the 1440x960 Ling Light management surface and cross-domain avatars contained", async ({ page }) => {
    await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
    const runtime = watchRuntime(page);
    await mockDaemon(page, createTeammatesState());
    await page.goto("/");

    const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
    const sidebarTeammate = navigation.getByRole("button", {
      name: "Ling Interface Architect with an intentionally long identity",
      exact: true,
    });
    const sidebarAvatar = sidebarTeammate.locator(".teammate-avatar-image.compact");
    await expectAvatarGeometry(sidebarAvatar, 22);

    const surface = await openTeammateManagement(page);
    const pageRoot = surface.locator(".teammates-page");
    const grid = surface.locator(".teammate-management-grid");
    const list = surface.getByLabel("Teammate list");
    const longRow = list.locator(".teammate-management-row").filter({
      hasText: "Ling Interface Architect with an intentionally long identity",
    });
    await expect(pageRoot).toBeVisible();
    await expect(grid).toBeVisible();
    await expect(longRow).toBeVisible();
    await expectAvatarGeometry(longRow.locator(".teammate-avatar-image.compact"), 36);
    await expect(longRow.locator(".teammate-draft-copy strong")).toHaveCSS("text-overflow", "ellipsis");
    await expect(longRow.locator(".teammate-draft-copy strong")).toHaveCSS("white-space", "nowrap");

    const geometry = await longRow.evaluate((row) => {
      const rowRect = row.getBoundingClientRect();
      const listRect = row.parentElement?.getBoundingClientRect();
      const actionsRect = row.querySelector<HTMLElement>(".teammate-row-actions")?.getBoundingClientRect();
      return {
        actionsInside: Boolean(actionsRect && actionsRect.right <= rowRect.right + 1),
        rowInsideList: Boolean(listRect && rowRect.left >= listRect.left - 1 && rowRect.right <= listRect.right + 1),
      };
    });
    expect(geometry).toEqual({ actionsInside: true, rowInsideList: true });
    await expectBounded(surface);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1440x960-ling-light-management-avatar-contract.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 1 keeps 1280x800 Ling Dark private search, feed, dock, and reduced motion contained", async ({ page }) => {
    await prepareSurface(page, { width: 1280, height: 800, theme: "dark", reducedMotion: "reduce" });
    const runtime = watchRuntime(page);
    const state = createTeammatesState();
    installPrivateChatMessage(state);
    await mockDaemon(page, state);
    await page.goto("/");

    await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", {
      name: "Ling Interface Architect with an intentionally long identity",
      exact: true,
    }).click();
    await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);

    const chat = page.getByLabel("Private chat", { exact: true });
    const header = page.locator("[data-ui2-teammate-chat-header='true']");
    const toolbar = header.getByRole("toolbar", { name: "Private chat actions" });
    const feed = chat.getByLabel("Private message feed", { exact: true });
    await expect(header).toBeVisible();
    await expect(feed).toBeVisible();
    await expectAvatarGeometry(header.locator(".teammate-avatar-image"), 26);

    await toolbar.getByRole("button", { name: "Search" }).click();
    const search = header.getByRole("search", { name: "Search private messages" });
    const input = search.getByRole("textbox", { name: "Search private messages" });
    await expect(input).toBeFocused();
    await expectContained(input, search);
    await expectContained(search, header);
    await input.fill("legacy writer");
    await expect(feed.getByText("Legacy writer release keeps private history readable.", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);

    await toolbar.getByRole("button", { name: "Summary" }).click();
    const summary = page.locator(".teammate-chat-summary-popover");
    await expect(summary).toBeVisible();
    await toolbar.getByRole("button", { name: "Show details" }).click();
    const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
    const dockFrame = page.locator(".teammate-private-right-dock-frame");
    await expect(dock).toBeVisible();
    await expect(summary).toBeVisible();
    await expectReducedMotion(summary);
    await expectReducedMotion(dockFrame);
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expect.poll(() => feed.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    await expectBounded(chat);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1280x800-ling-dark-private-search-dock-reduced-motion.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 2 lets imported Quiet Ocean tokens own the embedded management surface", async ({ page }) => {
    await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
    const runtime = watchRuntime(page);
    await mockDaemon(page, createTeammatesState());
    await page.goto("/");
    await seedImportedQuietOcean(page);
    await page.reload();

    const surface = await openTeammateManagement(page);
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "quiet-ocean");
    await expectUsesColorToken(page.locator(".settings-section-nav"), "backgroundColor", "--ling-bg-sidebar");
    await expectUsesColorToken(
      surface.locator(".teammate-management-list-panel"),
      "backgroundColor",
      "--surface-panel",
    );
    await expectUsesColorToken(
      surface.locator(".teammate-management-row").first().locator(".teammate-draft-copy strong"),
      "color",
      "--ling-text-strong",
    );
    const search = surface.getByRole("textbox", { name: "Search teammates" });
    await search.fill("Theme Reviewer");
    await expect(surface.locator(".teammate-management-row")).toHaveCount(1);
    await expectContained(search, surface.locator(".teammate-management-list-toolbar"));
    await expectBounded(surface);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1440x960-quiet-ocean-management-surface.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 2 keeps the 1280x800 Ling Dark empty management state contained", async ({ page }) => {
    await prepareSurface(page, { width: 1280, height: 800, theme: "dark" });
    const runtime = watchRuntime(page);
    const state = createTeammatesState();
    state.aiTeammates = [];
    await mockDaemon(page, state);
    await page.goto("/");

    const surface = await openTeammateManagement(page);
    const empty = surface.getByText("No workspace teammates", { exact: true });
    await expect(empty).toBeVisible();
    await expectUsesColorToken(
      page.locator(".settings-section-nav"),
      "backgroundColor",
      "--ling-bg-sidebar",
    );
    await expectBounded(surface);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1280x800-ling-dark-management-empty.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 2 keeps imported Quiet Ocean teammate permissions reachable without an empty MCP section", async ({ page }) => {
    await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
    const runtime = watchRuntime(page);
    await mockDaemon(page, createTeammatesState());
    await page.goto("/");
    await seedImportedQuietOcean(page);
    await page.reload();

    await openTeammateSettings(page, "Ling Interface Architect with an intentionally long identity");
    await page.getByLabel("Settings sections").getByRole("button", { name: "Tools and permissions" }).click();
    await expect(page.getByLabel("Tools and permissions")).toBeVisible();
    await expect(page.getByLabel("External tools")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "quiet-ocean");
    await expectUsesColorToken(page.locator(".teammate-settings-nav"), "backgroundColor", "--ling-bg-panel");
    await expect(page.locator(".teammate-settings-summary-panel")).toHaveCount(0);
    await expectBounded(page.locator(".teammate-workspace.settings-mode"));
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1440x960-quiet-ocean-private-mcp-settings.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 2 keeps channel teammate stack avatars circular and contained", async ({ page }) => {
    await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
    const runtime = watchRuntime(page);
    const state = createTeammatesState();
    installChannelMemberships(state);
    await mockDaemon(page, state);
    await page.goto("/");
    await openEngineeringChannel(page);

    const stackButton = page.locator(".channel-team-stack-button");
    const avatars = stackButton.locator(".channel-team-stack-avatar .teammate-avatar-image.compact");
    await expect(avatars).toHaveCount(2);
    await expectAvatarGeometry(avatars.first(), 28);
    await expectAvatarGeometry(avatars.nth(1), 28);
    await expectContained(stackButton.locator(".channel-team-stack"), stackButton);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1440x960-ling-light-channel-teammate-stack.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 2 keeps Council Members teammate avatars circular and contained", async ({ page }) => {
    await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
    const runtime = watchRuntime(page);
    const state = createTeammatesState();
    installCouncilMembers(state);
    await mockDaemon(page, state);
    await page.goto("/");

    await openSettingsTool(page, "Council Workspace");
    const members = page.getByLabel("Council members");
    const architect = members.locator(".council-members-row").filter({
      hasText: "Ling Interface Architect with an intentionally long identity",
    });
    await expect(architect).toBeVisible();
    await expectAvatarGeometry(architect.locator(".teammate-avatar-image.compact"), 34);
    await expectContained(architect.locator(".council-members-avatar"), architect);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1440x960-ling-light-council-members-avatar.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("stage 2 keeps teammate Profile avatar settings circular and contained", async ({ page }) => {
    await prepareSurface(page, { width: 1280, height: 800, theme: "dark" });
    const runtime = watchRuntime(page);
    await mockDaemon(page, createTeammatesState());
    await page.goto("/");

    await openTeammateSettings(page, "Ling Interface Architect with an intentionally long identity");
    const profile = page.getByLabel("Teammate profile");
    const avatarFrame = profile.getByLabel("Avatar", { exact: true });
    const avatar = avatarFrame.locator(".teammate-avatar-image");
    await expect(profile).toBeVisible();
    await expectAvatarGeometry(avatar, 72);
    await expectContained(avatar, avatarFrame);
    const avatarOptions = avatarFrame.getByRole("button", { name: "Avatar options" });
    await expect(avatarOptions).toBeVisible();
    await avatarOptions.click();
    await expect(page.getByRole("menuitem", { name: "Change avatar" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1280x800-ling-dark-teammate-profile-avatar.png");
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });
});

function createTeammatesState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_teammates_legacy_writer",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-24T00:00:00.000Z" },
  })];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_legacy_writer_architect",
      displayName: "Ling Interface Architect with an intentionally long identity",
      description: "Owns the Teammates CSS release boundary.",
      providerPresetId: "provider_teammates_legacy_writer",
    }),
    createMockTeammate({
      id: "teammate_legacy_writer_reviewer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Theme Reviewer",
      providerPresetId: "provider_teammates_legacy_writer",
    }),
  ];
  return state;
}

function installPrivateChatMessage(state: MockState): void {
  const teammateId = "teammate_legacy_writer_architect";
  const timestamp = "2026-07-24T01:00:00.000Z";
  state.teammateDirectMessages = [{
    id: "message_teammates_legacy_writer",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "Legacy writer release keeps private history readable.",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
}

function installChannelMemberships(state: MockState): void {
  state.teammateChannelMemberships = state.aiTeammates.map((teammate, index) => ({
    teammateId: String((teammate as Record<string, unknown>).id),
    channelId: "channel_engineering",
    isDefault: index === 0,
    createdAt: "2026-07-24T02:00:00.000Z",
    updatedAt: "2026-07-24T02:00:00.000Z",
  }));
}

function installCouncilMembers(state: MockState): void {
  state.aiCouncilMembers = state.aiTeammates.map((teammate, index) => ({
    councilId: "council_builtin_development",
    teammateId: String((teammate as Record<string, unknown>).id),
    slotKey: index === 0 ? "implementation" : "review",
    label: index === 0 ? "Implementation" : "Review",
    position: index,
    enabled: true,
    createdAt: "2026-07-24T02:00:00.000Z",
    updatedAt: "2026-07-24T02:00:00.000Z",
  }));
}

async function openTeammateManagement(page: Page): Promise<Locator> {
  await openSettingsTool(page, "Teammate Management");
  const surface = page.locator("[data-ui2-settings-workspace-tool][data-settings-workspace-tool='teammates']");
  await expect(surface).toBeVisible();
  return surface;
}

async function openSettingsTool(page: Page, name: string): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name }).click();
}

async function openTeammateSettings(page: Page, teammateName: string): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: teammateName, exact: true }).click();
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await expect(header).toBeVisible();
  await header.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
}

async function prepareSurface(page: Page, input: {
  readonly width: number;
  readonly height: number;
  readonly theme: "light" | "dark";
  readonly reducedMotion?: "no-preference" | "reduce";
}): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ colorScheme: input.theme, reducedMotion: input.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ theme }) => {
    if (sessionStorage.getItem("ling-stack.e2eThemeSelection")) return;
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { theme: input.theme });
}

async function expectAvatarGeometry(avatar: Locator, expectedSize: number): Promise<void> {
  await expect(avatar).toBeVisible();
  const geometry = await avatar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderRadius: Number.parseFloat(style.borderRadius),
      height: Math.round(rect.height),
      objectFit: style.objectFit,
      width: Math.round(rect.width),
    };
  });
  expect(geometry.width).toBe(expectedSize);
  expect(geometry.height).toBe(expectedSize);
  expect(geometry.objectFit).toBe("cover");
  expect(geometry.borderRadius).toBeGreaterThanOrEqual(expectedSize / 2);
}

async function expectContained(inner: Locator, outer: Locator): Promise<void> {
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(outerBox!.x + outerBox!.width + 1);
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
}

async function expectReducedMotion(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const durations = await locator.evaluate((element) => getComputedStyle(element).transitionDuration
    .split(",")
    .map((duration) => Number.parseFloat(duration)));
  expect(durations).toEqual(durations.map(() => 0));
}

async function expectUsesColorToken(
  locator: Locator,
  property: "backgroundColor" | "color",
  token: string,
): Promise<void> {
  const colors = await locator.evaluate((element, input) => {
    const probe = document.createElement("span");
    probe.style[input.property] = `var(${input.token})`;
    element.append(probe);
    const expected = getComputedStyle(probe)[input.property];
    probe.remove();
    return { actual: getComputedStyle(element)[input.property], expected };
  }, { property, token });
  expect(colors.actual).toBe(colors.expected);
}

async function expectBounded(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

function watchRuntime(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const runtime = { consoleErrors: [] as string[], pageErrors: [] as string[] };
  page.on("console", (message) => {
    if (message.type() === "error") runtime.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtime.pageErrors.push(error.message));
  return runtime;
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}
