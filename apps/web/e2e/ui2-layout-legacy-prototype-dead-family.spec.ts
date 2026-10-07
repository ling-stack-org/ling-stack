import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../packages/", import.meta.url));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/layout-legacy-prototype-dead-family/",
  import.meta.url,
));

const deadClassTokens = [
  "glass-chip",
  "client-main",
  "conversation-panel",
  "workspace-config-dock",
  "conversation-placeholder-body",
  "run-provider-field",
  "composer-title",
  "segmented-control",
  "mention-row",
  "composer-assets",
  "mention-chip",
  "mention-picker",
  "link-preview-input",
  "ask-ai-toggle",
  "session-file-list",
  "artifact-empty-state",
  "file-card",
  "link-card",
  "file-icon",
  "client-provider-notice",
  "composer-footer",
  "tool-token-list",
  "tool-token",
  "dock-card",
  "mini-channel-list",
  "mini-channel",
  "toggle-row",
  "config-disclosure",
] as const;

const liveMixedClassTokens = [
  "pending-assets",
  "mention-picker-popover",
  "mention-suggestion",
] as const;

test("static gate removes all 28 legacy prototype families while preserving live mixed branches", async () => {
  expect(deadClassTokens).toHaveLength(28);
  const files = await readProductionFiles();
  const productionFiles = files.filter((file) => file.kind === "production");
  const cssFiles = files.filter((file) => file.kind === "css");

  for (const token of deadClassTokens) {
    expect(
      findExactTokenOccurrences(productionFiles, token),
      `${token} must have no production source consumer`,
    ).toEqual([]);
    expect(
      findExactClassSelectorOccurrences(cssFiles, token),
      `.${token} must have no production CSS writer`,
    ).toEqual([]);
  }

  for (const token of liveMixedClassTokens) {
    expect(
      findExactTokenOccurrences(productionFiles, token).length,
      `${token} must retain a production consumer`,
    ).toBeGreaterThan(0);
    expect(
      findExactClassSelectorOccurrences(cssFiles, token).length,
      `.${token} must retain a CSS writer`,
    ).toBeGreaterThan(0);
  }

  expect(
    findExactClassSelectorOccurrences(cssFiles, "channel-option-actions").length,
    ".channel-option-actions is a protected mixed CSS branch in the O.29 contract",
  ).toBeGreaterThan(0);
});

test("1440x960 Ling Light keeps Channel pending attachments and mention picker reachable", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installChannelTeammate(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const input = composer.getByRole("textbox", {
    name: "Message this channel or @ an AI teammate",
    exact: true,
  });
  await composer.locator('input[type="file"]').setInputFiles({
    name: "layout-owner.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  });

  const pendingAssets = composer.getByLabel("Pending message assets");
  await expect(pendingAssets).toBeVisible();
  await expect(pendingAssets.locator(".composer-preview-thumbnail[alt='layout-owner.png']")).toBeVisible();
  await input.fill("@Eng");
  const mentionPicker = composer.getByRole("listbox", { name: "Mention teammate" });
  await expect(mentionPicker).toBeVisible();
  await expect(mentionPicker.locator(".mention-suggestion")).toHaveCount(1);
  await expect(mentionPicker.getByRole("option", { name: /@Engineer/u })).toBeVisible();

  await expectFocusedControlContained(
    input,
    composer.locator(".conversation-composer-input-zone"),
    composer,
  );
  await expectNoHorizontalOverflow(pendingAssets);
  await expectNoHorizontalOverflow(mentionPicker);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-channel-composer.png");
  runtime.expectClean();
});

test("1280x800 Ling Dark keeps Normal and Teammate command menus and focus contained", async ({ page }) => {
  await prepareSurface(page, { height: 800, reducedMotion: true, theme: "dark", width: 1280 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const normalTitle = installNormalWorkCellFixture(state);
  const teammateName = installDarkTeammate(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openNormalConversation(page, normalTitle);

  const normalComposer = page.getByLabel("New conversation composer");
  const normalInput = normalComposer.getByRole("textbox", { name: "Conversation message" });
  await normalInput.fill("/rev");
  const normalCommands = normalComposer.getByRole("listbox", { name: "Slash command" });
  await expect(normalCommands).toBeVisible();
  await expect(normalCommands.getByRole("option", { name: /^\/review\b/u })).toBeVisible();
  await expectFocusedControlContained(
    normalInput,
    normalComposer.locator(".conversation-composer-input-zone"),
    normalComposer,
  );
  await normalCommands.getByRole("option", { name: /^\/review\b/u }).click();
  await expect(normalInput).toHaveAttribute("data-value", "/review ");

  const normalPermission = normalComposer.getByRole("button", { name: /Selected permission preset/u });
  await normalPermission.click();
  const normalMenu = permissionMenu(page);
  await expect(normalMenu).toBeVisible();
  await expectOverlayContained(page, normalMenu);
  await page.keyboard.press("Escape");
  await expect(normalMenu).toHaveCount(0);
  await expect(normalPermission).toBeFocused();

  await openTeammate(page, teammateName);
  const teammateComposer = page.getByLabel("Private chat composer", { exact: true });
  const teammateInput = teammateComposer.getByRole("textbox");
  await teammateInput.fill("/rev");
  const teammateCommands = teammateComposer.getByRole("listbox", { name: "Slash command" });
  await expect(teammateCommands).toBeVisible();
  await expect(teammateCommands.getByRole("option", { name: /^\/review\b/u })).toBeVisible();
  await expectFocusedControlContained(
    teammateInput,
    teammateComposer.locator(".conversation-composer-input-zone"),
    teammateComposer,
  );
  await teammateCommands.getByRole("option", { name: /^\/review\b/u }).click();
  await expect(teammateInput).toHaveAttribute("data-value", "/review ");

  const teammatePermission = teammateComposer.getByRole("button", { name: /Selected permission preset/u });
  await teammatePermission.click();
  const teammateMenu = permissionMenu(page);
  await expect(teammateMenu).toBeVisible();
  await expectOverlayContained(page, teammateMenu);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoHorizontalOverflow(teammateComposer);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-normal-teammate-composers.png");
  runtime.expectClean();
});

test("1440x960 imported Quiet Ocean keeps Channel Create bounded and theme-owned", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = [];
  state.channelBranches = [];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_ui2_create_layout",
    displayName: "Layout Reviewer",
  })];
  await mockDaemon(page, state);

  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "No channel yet" }).click();

  const dialog = page.getByRole("dialog", { name: "New channel" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  await expect(dialog.locator(".channel-create-teammates")).toBeVisible();
  await expect(dialog.locator(".channel-create-teammate")).toHaveCount(1);

  const nameInput = dialog.getByLabel("Name");
  const inputShell = nameInput.locator("xpath=ancestor::div[contains(@class, 'channel-create-fields')][1]");
  await nameInput.focus();
  await expect(nameInput).toBeFocused();
  await expectNoHorizontalOverflow(inputShell);
  await expectOverlayContained(page, dialog);
  await expectNoHorizontalOverflow(dialog.locator(".ling-ui-dialog-body"));
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-quiet-ocean-channel-create.png");
  runtime.expectClean();
});

interface SourceFile {
  readonly content: string;
  readonly kind: "css" | "production";
  readonly path: string;
}

async function readProductionFiles(): Promise<readonly SourceFile[]> {
  const roots = [webSourceDirectory, ...await packageSourceDirectories()];
  const paths = (await Promise.all(roots.map((root) => collectSourcePaths(root)))).flat();
  return Promise.all(paths.map(async (path) => ({
    content: await readFile(path, "utf8"),
    kind: extname(path) === ".css" ? "css" as const : "production" as const,
    path: relative(repositoryDirectory, path),
  })));
}

async function packageSourceDirectories(): Promise<readonly string[]> {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = fileURLToPath(new URL(`../../../packages/${entry.name}/src/`, import.meta.url));
    if (await pathExists(source)) directories.push(source);
  }
  return directories;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSourcePaths(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<readonly string[]> => {
    const path = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return collectSourcePaths(path);
    return [".css", ".js", ".jsx", ".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

function findExactTokenOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegularExpression(token)}(?![A-Za-z0-9_-])`, "gu");
  return findOccurrences(files, pattern);
}

function findExactClassSelectorOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  const pattern = new RegExp(`\\.${escapeRegularExpression(token)}(?![A-Za-z0-9_-])`, "gu");
  return findOccurrences(files, pattern);
}

function findOccurrences(files: readonly SourceFile[], pattern: RegExp): readonly string[] {
  const results: string[] = [];
  for (const file of files) {
    pattern.lastIndex = 0;
    for (const match of file.content.matchAll(pattern)) {
      const line = file.content.slice(0, match.index).split("\n").length;
      results.push(`${file.path}:${line}`);
    }
  }
  return results;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function installChannelTeammate(state: MockState): void {
  state.aiTeammates = [createMockTeammate({
    id: "engineer",
    displayName: "Engineer",
  })];
  state.teammateChannelMemberships = [{
    teammateId: "engineer",
    channelId: "channel_engineering",
    role: "member",
    isDefault: true,
    enabled: true,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  }];
}

function installDarkTeammate(state: MockState): string {
  const teammateId = "teammate_ui2_layout_dark";
  const displayName = "Layout Command Engineer";
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName,
    providerPresetId: "provider_ui2_work_cell",
  })];
  state.teammateSkillBindings = [{
    teammateId,
    skillId: "review",
    source: "user",
    enabled: true,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  }];
  state.teammateDirectMessages = [{
    id: "message_ui2_layout_dark",
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "Dark composer command fixture is ready.",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  }];
  return displayName;
}

async function prepareSurface(page: Page, options: {
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly theme: "dark" | "light";
  readonly width: number;
}): Promise<void> {
  await page.setViewportSize({ height: options.height, width: options.width });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript(({ theme }) => {
    if (sessionStorage.getItem("ling-stack.e2eThemeSelection")) return;
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { theme: options.theme });
}

async function openNormalConversation(page: Page, title: string): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function openTeammate(page: Page, displayName: string): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: displayName }).click();
  await expect(page.getByRole("heading", { name: displayName, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
}

function permissionMenu(page: Page): Locator {
  return page.locator('[data-ling-overlay="menu"]').filter({
    has: page.getByRole("menuitemradio", { name: /Read only/u }),
  });
}

async function expectFocusedControlContained(
  control: Locator,
  shell: Locator,
  stableRegion: Locator,
): Promise<void> {
  await expect(control).toBeVisible();
  await expect(shell).toBeVisible();
  const regionBefore = await stableRegion.boundingBox();
  await control.focus();
  await expect(control).toBeFocused();
  const regionAfter = await stableRegion.boundingBox();
  const controlBox = await control.boundingBox();
  const shellBox = await shell.boundingBox();
  expect(regionBefore).not.toBeNull();
  expect(regionAfter).not.toBeNull();
  expect(controlBox).not.toBeNull();
  expect(shellBox).not.toBeNull();
  expect(Math.abs(regionAfter!.width - regionBefore!.width)).toBeLessThanOrEqual(1);
  expect(controlBox!.x).toBeGreaterThanOrEqual(shellBox!.x - 1);
  expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(shellBox!.x + shellBox!.width + 1);
  expect(controlBox!.y).toBeGreaterThanOrEqual(shellBox!.y - 1);
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(shellBox!.y + shellBox!.height + 1);
}

async function expectOverlayContained(page: Page, overlay: Locator): Promise<void> {
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const geometry = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1);
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
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}
