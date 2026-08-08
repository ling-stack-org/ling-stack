import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNormalWorkCellFixture,
  installTeammateWorkCellFixture,
} from "./support/conversation-work-cell-fixture";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const conversationPackageSourceDirectory = fileURLToPath(new URL(
  "../../../packages/conversation-ui-react/src/",
  import.meta.url,
));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/conversation-composer-ownership/",
  import.meta.url,
));

const packageShellPath = "packages/conversation-ui-react/src/composer/ConversationComposerShell.tsx";
const packageCssPath = "packages/conversation-ui-react/src/styles/composer/conversation-composer.css";
const sharedCssPath = "apps/web/src/styles/shared/conversation-composer-slots.css";
const channelCssPath = "apps/web/src/styles/channel-feed-composer.css";
const normalCssPath = "apps/web/src/styles/normal-conversation-feed-composer.css";
const teammateCssPath = "apps/web/src/styles/teammate-private-feed-composer.css";

const packageCompatibilityTokens = [
  "composer-panel",
  "composer-drop-zone",
  "composer-primary-actions",
  "composer-tool-row",
] as const;

const deadComposerTokens = [
  "composer-options-panel",
  "composer-preview-mention",
  "pending-asset",
  "composer-status-list",
  "thread-resume-composer",
  "message-composer",
] as const;

const sharedSlotTokens = [
  "pending-assets",
  "composer-preview-strip",
  "composer-preview-card",
  "composer-preview-file-icon",
  "composer-preview-body",
  "composer-preview-state-icon",
  "composer-preview-remove",
  "mention-picker-popover",
  "mention-suggestion",
  "composer-drop-hint",
  "composer-attach-button",
] as const;

test("T13-O.31-E canonical Composer source ownership has no legacy or strict blanket writer", async () => {
  const [sourceFiles, packageShell, packageCss, sharedCss, channelCss, normalCss, teammateCss, styles, strictCss] = await Promise.all([
    readComposerProductionFiles(),
    readRepositoryFile(packageShellPath),
    readRepositoryFile(packageCssPath),
    readRepositoryFile(sharedCssPath),
    readRepositoryFile(channelCssPath),
    readRepositoryFile(normalCssPath),
    readRepositoryFile(teammateCssPath),
    readRepositoryFile("apps/web/src/styles.css"),
    readRepositoryFile("apps/web/src/styles/strict-console.css"),
  ]);

  for (const token of packageCompatibilityTokens) {
    expect(packageShell, `package shell must not emit ${token}`).not.toMatch(exactTokenPattern(token));
  }
  expect(packageShell).toContain('"conversation-composer"');
  expect(packageShell).toContain('data-conversation-composer="true"');
  expect(packageShell).toContain("data-surface={surface}");
  expect(packageShell).toContain("data-density={density}");

  for (const selector of [
    ".conversation-composer",
    ".conversation-composer-input-zone",
    ".conversation-composer-toolbar",
    ".conversation-composer-left-tools",
    ".conversation-composer-right-tools",
    ".tokenized-composer-input",
  ]) {
    expect(packageCss, `${selector} must be package-owned`).toContain(selector);
  }

  for (const token of deadComposerTokens) {
    expect(
      findExactTokenOccurrences(sourceFiles, token),
      `${token} must have no production source or CSS owner`,
    ).toEqual([]);
  }
  await expectPathToBeAbsent("apps/web/src/shared/components/MessageComposer.tsx");
  await expectPathToBeAbsent("apps/web/src/shared/components/ComposerMentionToken.tsx");
  expect(await readRepositoryFile("apps/web/src/shared/components/index.ts")).not.toMatch(/MessageComposer|ComposerMentionToken/u);
  expect(await readRepositoryFile("apps/web/src/shared/components/ComposerFileReferenceToken.tsx")).toContain("ComposerFileReferenceToken");

  for (const token of sharedSlotTokens) {
    const owners = findExactClassSelectorOccurrences(sourceFiles, token);
    expect(owners.length, `.${token} must retain a CSS owner`).toBeGreaterThan(0);
    expect(
      owners.every((owner) => owner.startsWith(`${sharedCssPath}:`)),
      `.${token} must be owned only by ${sharedCssPath}; got ${owners.join(", ")}`,
    ).toBe(true);
    expect(sharedCss).toMatch(exactClassSelectorPattern(token));
  }

  expectCanonicalSurfaceAnchor(channelCss, "channel");
  expectCanonicalSurfaceAnchor(normalCss, "normal_conversation");
  expectCanonicalSurfaceAnchor(teammateCss, "teammate_direct");

  for (const aggregatePath of [
    "apps/web/src/styles/components.css",
    "apps/web/src/styles/layout.css",
  ]) {
    const aggregateCss = await readRepositoryFile(aggregatePath);
    for (const token of [
      ...packageCompatibilityTokens,
      "conversation-composer",
      "conversation-composer-input-zone",
      "tokenized-composer-input",
      ...sharedSlotTokens,
    ]) {
      expect(
        aggregateCss,
        `${aggregatePath} must not remain a Composer writer for .${token}`,
      ).not.toMatch(exactClassSelectorPattern(token));
    }
  }

  const strictComposerSelectors = extractCssSelectors(strictCss)
    .filter((selector) => selector.includes("[data-conversation-composer]"));
  expect(
    strictComposerSelectors.every((selector) => selector.includes(":not(")),
    `strict layer may reference Composer only through exclusions: ${strictComposerSelectors.join(" | ")}`,
  ).toBe(true);
  expect(strictCss).not.toMatch(/\.normal-conversation-composer\s+\.tokenized-composer-input/u);

  expectImportOrder(styles, [
    "@ling-stack/conversation-ui-react/styles.css",
    "./styles/components.css",
    "./styles/shared/conversation-composer-slots.css",
    `./styles/${teammateCssPath.split("/").at(-1)}`,
    `./styles/${normalCssPath.split("/").at(-1)}`,
    `./styles/${channelCssPath.split("/").at(-1)}`,
    "./styles/strict-console.css",
  ]);
});

test("T13-O.31-E Light 1440 Channel keeps mention, pending asset, long text, and focus inside canonical geometry", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const signals = collectBrowserSignals(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installChannelComposerFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const inputZone = composer.locator(".conversation-composer-input-zone");
  const input = composer.getByRole("textbox", {
    name: "Message this channel or @ an AI teammate",
    exact: true,
  });
  await expectCanonicalComposer(composer, "channel", "docked");
  await expectFocusGeometryStable(input, inputZone, composer);

  await composer.locator('input[type="file"]').setInputFiles({
    name: "composer-ownership-pending-asset.png",
    mimeType: "image/png",
    buffer: onePixelPng(),
  });
  const pendingAssets = composer.getByLabel("Pending message assets");
  await expect(pendingAssets).toBeVisible();
  await expect(pendingAssets.locator(".composer-preview-thumbnail[alt='composer-ownership-pending-asset.png']")).toBeVisible();

  await input.fill("@Eng");
  const mentionPicker = composer.getByRole("listbox", { name: "Mention teammate" });
  await expect(mentionPicker).toBeVisible();
  await expect(mentionPicker.getByRole("option", { name: /@Engineer/u })).toBeVisible();
  await expectRegionContained(mentionPicker, composer);

  await input.fill(`Channel-${"ownership".repeat(80)}`);
  await expectTextControlWraps(input);
  await expectNoHorizontalOverflow(page, [composer, inputZone, pendingAssets]);
  await captureIfEnabled(page, "1440x960-ling-light-channel-mention-pending-focus.png");
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("channel mention keyboard navigation keeps the selected teammate after keyup", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const state = createBaseState({ approvalStatus: "expired" });
  installChannelComposerFixture(state);
  state.aiTeammates.push(
    createMockTeammate({ id: "designer", displayName: "Designer" }),
    createMockTeammate({ id: "qa", displayName: "QA" }),
  );
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const input = composer.getByRole("textbox", {
    name: "Message this channel or @ an AI teammate",
    exact: true,
  });
  await input.fill("@");

  const options = composer.getByRole("listbox", { name: "Mention teammate" }).getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  await input.press("ArrowDown");

  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(100);
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");

  await input.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowUp");
  await page.waitForTimeout(100);
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");

  await input.press("Enter");
  await expect(input).toHaveText("@QA ");
});

test("T13-O.31-E Dark 1280 Normal keeps slash, permission, reduced motion, long text, and focus contained", async ({ page }) => {
  await prepareSurface(page, { height: 800, reducedMotion: true, theme: "dark", width: 1280 });
  const signals = collectBrowserSignals(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openNormalConversation(page, title);

  const composer = page.getByLabel("New conversation composer");
  const inputZone = composer.locator(".conversation-composer-input-zone");
  const input = composer.getByRole("textbox", { name: "Conversation message" });
  await expectCanonicalComposer(composer, "normal_conversation", "floating");
  await expectFocusGeometryStable(input, inputZone, composer);
  await expectReducedMotion(composer);

  await input.fill("/rev");
  const slashPicker = composer.getByRole("listbox", { name: "Slash command" });
  await expect(slashPicker).toBeVisible();
  await expect(slashPicker.getByRole("option", { name: /^\/review\b/u })).toBeVisible();
  await expectRegionContained(slashPicker, composer);
  await slashPicker.getByRole("option", { name: /^\/review\b/u }).click();
  await expect(input).toHaveAttribute("data-value", "/review ");

  const permissionTrigger = composer.getByRole("button", { name: /Selected permission preset/u });
  await permissionTrigger.click();
  const permissionOverlay = page.locator('[data-ling-overlay="menu"]').filter({
    has: page.getByRole("menuitemradio", { name: /Read only/u }),
  });
  await expect(permissionOverlay).toBeVisible();
  await expectRegionWithinViewport(page, permissionOverlay);
  await page.keyboard.press("Escape");
  await expect(permissionOverlay).toHaveCount(0);
  await expect(permissionTrigger).toBeFocused();

  const pastedImageName = "normal-pasted-preview.png";
  const pasteWasPrevented = await pasteFilesIntoComposer(input, [{
    name: pastedImageName,
    type: "image/png",
    bytes: [...onePixelPng()],
  }]);
  expect(pasteWasPrevented).toBe(true);
  const pastedAssets = composer.getByLabel("Pending message assets");
  await expect(pastedAssets.locator(`.composer-preview-thumbnail[alt='${pastedImageName}']`)).toBeVisible();
  await expect(input.locator("img")).toHaveCount(0);
  await pastedAssets.getByRole("button", { name: "Remove pending attachment" }).click();
  await expect(pastedAssets).toHaveCount(0);

  await expect(input).toHaveAttribute("contenteditable", "plaintext-only");
  const itemOnlyImageName = "normal-item-only-preview.png";
  const itemOnlyPasteWasPrevented = await pasteItemOnlyFileIntoComposer(input, {
    name: itemOnlyImageName,
    type: "image/png",
    bytes: [...onePixelPng()],
  });
  expect(itemOnlyPasteWasPrevented).toBe(true);
  await expect(pastedAssets.locator(`.composer-preview-thumbnail[alt='${itemOnlyImageName}']`)).toBeVisible();
  await expect(input.locator("img")).toHaveCount(0);
  await pastedAssets.getByRole("button", { name: "Remove pending attachment" }).click();
  await expect(pastedAssets).toHaveCount(0);

  await composer.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 4 }, (_, index) => ({
      name: `normal-preview-${index + 1}.png`,
      mimeType: "image/png",
      buffer: onePixelPng(),
    })),
  );
  const pendingAssets = composer.getByLabel("Pending message assets");
  await expect(pendingAssets.locator(".composer-preview-card")).toHaveCount(4);
  await expect(pendingAssets).toHaveCSS("flex-wrap", "nowrap");
  const normalPreviewGeometry = await pendingAssets.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(normalPreviewGeometry.scrollWidth).toBeGreaterThan(normalPreviewGeometry.clientWidth);
  expect(normalPreviewGeometry.scrollHeight).toBeLessThanOrEqual(normalPreviewGeometry.clientHeight + 1);

  await input.fill(`Normal-${"unbroken".repeat(100)}`);
  await expectTextControlWraps(input);
  await expectNoHorizontalOverflow(page, [composer, inputZone]);
  await captureIfEnabled(page, "1280x800-ling-dark-normal-slash-permission-focus.png");
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-O.31-E Quiet Ocean 1440 Teammate keeps attachment status, focus, and imported theme containment", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const signals = collectBrowserSignals(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammate = installTeammateWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await openTeammate(page, teammate.displayName);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);

  const composer = page.getByLabel("Private chat composer", { exact: true });
  const inputZone = composer.locator(".conversation-composer-input-zone");
  const input = composer.getByRole("textbox");
  await expectCanonicalComposer(composer, "teammate_direct", "docked");
  await expectFocusGeometryStable(input, inputZone, composer);

  const longFileName = `${"quiet-ocean-attachment-".repeat(8)}status.png`;
  await composer.locator('input[type="file"]').setInputFiles([
    { name: longFileName, mimeType: "image/png", buffer: onePixelPng() },
    ...Array.from({ length: 3 }, (_, index) => ({
      name: `teammate-preview-${index + 2}.png`,
      mimeType: "image/png",
      buffer: onePixelPng(),
    })),
  ]);
  const pendingAssets = composer.getByLabel("Pending message assets");
  await expect(pendingAssets.locator(".composer-preview-card")).toHaveCount(4);
  const attachment = pendingAssets.locator(".composer-preview-card").filter({ hasText: longFileName });
  await expect(attachment).toBeVisible();
  await expect(attachment).toHaveClass(/ready/u);
  await expect(attachment.locator(".composer-preview-state-icon.spin")).toHaveCount(0);
  await expect(attachment.locator(".composer-preview-body small")).toContainText("Ready");
  const teammatePreviewGeometry = await pendingAssets.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(teammatePreviewGeometry.scrollWidth).toBeGreaterThan(teammatePreviewGeometry.clientWidth);

  await input.fill(`Teammate-${"context".repeat(90)}`);
  await expectTextControlWraps(input);
  await expectNoHorizontalOverflow(page, [composer, inputZone, attachment]);
  await captureIfEnabled(page, "1440x960-quiet-ocean-teammate-attachment-status-focus.png");
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

interface SourceFile {
  readonly content: string;
  readonly path: string;
}

async function readComposerProductionFiles(): Promise<readonly SourceFile[]> {
  const paths = (await Promise.all([
    collectSourcePaths(webSourceDirectory),
    collectSourcePaths(conversationPackageSourceDirectory),
  ])).flat();
  return Promise.all(paths.map(async (path) => ({
    content: await readFile(path, "utf8"),
    path: relative(repositoryDirectory, path),
  })));
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

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(`${repositoryDirectory}${relativePath}`, "utf8");
}

async function expectPathToBeAbsent(relativePath: string): Promise<void> {
  await expect(access(`${repositoryDirectory}${relativePath}`)).rejects.toThrow();
}

function findExactTokenOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  return findOccurrences(files, exactTokenPattern(token));
}

function findExactClassSelectorOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  return findOccurrences(files.filter((file) => extname(file.path) === ".css"), exactClassSelectorPattern(token));
}

function findOccurrences(files: readonly SourceFile[], pattern: RegExp): readonly string[] {
  const results: string[] = [];
  for (const file of files) {
    pattern.lastIndex = 0;
    for (const match of file.content.matchAll(pattern)) {
      results.push(`${file.path}:${file.content.slice(0, match.index).split("\n").length}`);
    }
  }
  return results;
}

function exactTokenPattern(token: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegularExpression(token)}(?![A-Za-z0-9_-])`, "gu");
}

function exactClassSelectorPattern(token: string): RegExp {
  return new RegExp(`\\.${escapeRegularExpression(token)}(?![A-Za-z0-9_-])`, "gu");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractCssSelectors(css: string): readonly string[] {
  return Array.from(css.matchAll(/([^{}]+)\{/gu), (match) => match[1]?.trim() ?? "")
    .filter((selector) => selector.length > 0 && !selector.startsWith("@"));
}

function expectCanonicalSurfaceAnchor(css: string, surface: "channel" | "normal_conversation" | "teammate_direct"): void {
  const compact = css.replace(/\s+/gu, " ");
  const canonicalDataAnchor = `[data-conversation-composer][data-surface="${surface}"]`;
  const canonicalClassAnchor = `.conversation-composer-surface-${surface}`;
  expect(
    compact.includes(canonicalDataAnchor) || compact.includes(canonicalClassAnchor),
    `${surface} CSS must anchor its root in the canonical package contract`,
  ).toBe(true);
  for (const token of packageCompatibilityTokens) {
    expect(css, `${surface} CSS must not use compatibility selector .${token}`).not.toMatch(exactClassSelectorPattern(token));
  }
}

function expectImportOrder(styles: string, imports: readonly string[]): void {
  const offsets = imports.map((path) => styles.indexOf(path));
  expect(offsets.every((offset) => offset >= 0), `missing Composer import: ${imports.filter((_, index) => offsets[index] === -1).join(", ")}`).toBe(true);
  expect(offsets, `Composer imports must follow package, aggregate, shared, surfaces, strict order`).toEqual([...offsets].sort((a, b) => a - b));
}

function installChannelComposerFixture(state: MockState): void {
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
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
  await page.getByLabel("Ling Stack navigation").locator(".sidebar-recent-row").filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function openTeammate(page: Page, displayName: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: displayName }).click();
  await expect(page.getByRole("heading", { name: displayName, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0, { timeout: 15_000 });
}

async function expectCanonicalComposer(
  composer: Locator,
  surface: "channel" | "normal_conversation" | "teammate_direct",
  density: "docked" | "floating",
): Promise<void> {
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("data-conversation-composer", "true");
  await expect(composer).toHaveAttribute("data-surface", surface);
  await expect(composer).toHaveAttribute("data-density", density);
  await expect(composer).toHaveClass(/conversation-composer/u);
  for (const token of packageCompatibilityTokens) {
    await expect(composer).not.toHaveClass(new RegExp(`(?:^|\\s)${escapeRegularExpression(token)}(?:\\s|$)`, "u"));
  }
}

async function expectFocusGeometryStable(control: Locator, inputZone: Locator, composer: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect(inputZone).toBeVisible();
  const [controlBefore, zoneBefore, composerBefore] = await Promise.all([
    control.boundingBox(),
    inputZone.boundingBox(),
    composer.boundingBox(),
  ]);
  await control.focus();
  await expect(control).toBeFocused();
  const [controlAfter, zoneAfter, composerAfter] = await Promise.all([
    control.boundingBox(),
    inputZone.boundingBox(),
    composer.boundingBox(),
  ]);
  for (const box of [controlBefore, zoneBefore, composerBefore, controlAfter, zoneAfter, composerAfter]) {
    expect(box).not.toBeNull();
  }
  expectGeometryEqual(controlAfter!, controlBefore!);
  expectGeometryEqual(zoneAfter!, zoneBefore!);
  expectGeometryEqual(composerAfter!, composerBefore!);
  expectBoxContained(controlAfter!, zoneAfter!);
  expectBoxContained(zoneAfter!, composerAfter!);
}

function expectGeometryEqual(actual: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>, expected: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${key} changed on focus`).toBeLessThanOrEqual(1);
  }
}

function expectBoxContained(
  inner: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
  outer: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 1);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

async function expectRegionContained(region: Locator, owner: Locator): Promise<void> {
  const [regionBox, ownerBox] = await Promise.all([region.boundingBox(), owner.boundingBox()]);
  expect(regionBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect(regionBox!.x).toBeGreaterThanOrEqual(ownerBox!.x - 1);
  expect(regionBox!.x + regionBox!.width).toBeLessThanOrEqual(ownerBox!.x + ownerBox!.width + 1);
}

async function expectRegionWithinViewport(page: Page, region: Locator): Promise<void> {
  const [box, viewport] = [await region.boundingBox(), page.viewportSize()];
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectTextControlWraps(control: Locator): Promise<void> {
  const geometry = await control.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      overflowWrap: styles.overflowWrap,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(geometry.overflowWrap).toBe("anywhere");
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function expectReducedMotion(locator: Locator): Promise<void> {
  const durations = await locator.evaluate((element) => getComputedStyle(element).transitionDuration
    .split(",")
    .map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 0.001 : 1)));
  expect(durations.length).toBeGreaterThan(0);
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.01);
}

async function expectNoHorizontalOverflow(page: Page, regions: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1);
  for (const region of regions) {
    await expect(region).toBeVisible();
    const overflow = await region.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
}

function collectBrowserSignals(page: Page): { readonly consoleErrors: string[]; readonly pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function captureIfEnabled(page: Page, fileName: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: `${evidenceDirectory}${fileName}`,
  });
}

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );
}

async function pasteFilesIntoComposer(
  input: Locator,
  files: readonly { readonly name: string; readonly type: string; readonly bytes: readonly number[] }[],
): Promise<boolean> {
  return input.evaluate((element, inputFiles) => {
    const dataTransfer = new DataTransfer();
    inputFiles.forEach((file) => {
      dataTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    });
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, files);
}

async function pasteItemOnlyFileIntoComposer(
  input: Locator,
  file: { readonly name: string; readonly type: string; readonly bytes: readonly number[] },
): Promise<boolean> {
  return input.evaluate((element, inputFile) => {
    const pastedFile = new File([new Uint8Array(inputFile.bytes)], inputFile.name, { type: inputFile.type });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        items: [{ kind: "file", type: inputFile.type, getAsFile: () => pastedFile }],
        getData: () => "",
      },
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, file);
}
