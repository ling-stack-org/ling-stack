import { mkdir, readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";
import { openChannelContextPanel, openEngineeringChannel } from "./support/test-helpers";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../packages/", import.meta.url));
const e2eDirectory = fileURLToPath(new URL("./", import.meta.url));
const currentSpecName = "ui2-channel-route-explanation-dead-css.spec.ts";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-route-explanation-dead-css/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";

const deadClassTokens = [
  "channel-route-pill",
  "channel-route-explanation",
  "channel-route-explanation-toggle",
  "channel-route-explanation-popover",
] as const;

const liveInspectTokens = [
  "channel-route-inspect-grid",
  "channel-route-inspect-section",
] as const;

interface SourceFile {
  readonly content: string;
  readonly path: string;
}

test("T13-O.33 four route explanation roots have no emitter while live Inspect owners remain", async () => {
  const [webSources, packageSources, ordinaryE2eSources, inspectorSource] = await Promise.all([
    readSourceTree(webSourceDirectory),
    readSourceTree(packageDirectory),
    readSourceTree(e2eDirectory, (path) => !path.endsWith(`/${currentSpecName}`)),
    readRepositoryFile("apps/web/src/features/workspace/ChannelInspectorPanels.tsx"),
  ]);
  const productionSources = [...webSources, ...packageSources];
  const cssSources = productionSources.filter((file) => extname(file.path) === ".css");

  expect(deadClassTokens).toHaveLength(4);
  for (const token of deadClassTokens) {
    expect(
      findExactTokenOccurrences(productionSources, token),
      `${token} must have no Web or package production emitter`,
    ).toEqual([]);
    expect(
      findExactTokenOccurrences(ordinaryE2eSources, token),
      `${token} must not be restored by an ordinary E2E fixture`,
    ).toEqual([]);
    expect(
      findExactClassSelectorOccurrences(cssSources, token),
      `.${token} must have no CSS writer`,
    ).toEqual([]);
  }

  for (const token of liveInspectTokens) {
    expect(
      findExactClassSelectorOccurrences(cssSources, token),
      `.${token} must retain a production CSS owner`,
    ).toContain(`apps/web/src/styles/components.css:.${token}`);
    expect(
      countExactClassNameToken(inspectorSource, token),
      `${token} must retain a ChannelInspectorPanels consumer`,
    ).toBeGreaterThan(0);
  }
});

test("T13-O.33 Light 1440 keeps route evidence Inspect keyboard-reachable, wrapped, and bounded", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = installRouteDecisionFixture(createBaseState({ approvalStatus: "expired" }));
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  const surface = await openRoutingInspector(page);
  const row = surface.inspector.locator(".routing-evidence-row").filter({ hasText: "Reply decision" });
  await expect(row).toHaveCount(1);

  const inspect = row.getByRole("button", { name: "Inspect", exact: true });
  await inspect.focus();
  await expect(inspect).toBeFocused();
  await page.keyboard.press("Enter");

  const hide = row.getByRole("button", { name: "Hide details", exact: true });
  await expect(hide).toBeFocused();
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  const detail = row.locator(".routing-evidence-detail");
  await expectRouteDetailContract(detail);
  await expectNoDeadRouteRoots(page);
  await expectNoOverflow(page, [surface.dock, surface.inspector, row, detail]);
  await captureIfEnabled(page, "1440x960-ling-light-route-inspect.png");

  await page.keyboard.press("Space");
  await expect(row.locator(".routing-evidence-detail")).toHaveCount(0);
  const reopen = row.getByRole("button", { name: "Inspect", exact: true });
  await expect(reopen).toBeFocused();
  await expect(reopen).toHaveAttribute("aria-expanded", "false");
  expectRuntime(runtime);
});

test("T13-O.33 Dark 1280 reduced motion keeps route detail independent from removed prototype roots", async ({ page }) => {
  await prepareSurface(page, {
    height: 800,
    reducedMotion: true,
    theme: "dark",
    width: 1280,
  });
  const runtime = watchRuntime(page);
  const state = installRouteDecisionFixture(createBaseState({ approvalStatus: "expired" }));
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  const surface = await openRoutingInspector(page);
  const row = surface.inspector.locator(".routing-evidence-row").filter({ hasText: "Reply decision" });
  const inspect = row.getByRole("button", { name: "Inspect", exact: true });
  await inspect.focus();
  await page.keyboard.press("Enter");

  const detail = row.locator(".routing-evidence-detail");
  await expectRouteDetailContract(detail);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
    .toBe(true);
  await expectReducedMotion([surface.dock, row.getByRole("button", { name: "Hide details" }), detail]);
  await expectNoDeadRouteRoots(page);
  await expectNoOverflow(page, [surface.dock, surface.inspector, row, detail]);
  await captureIfEnabled(page, "1280x800-ling-dark-route-inspect-reduced-motion.png");
  expectRuntime(runtime);
});

function installRouteDecisionFixture(state: MockState): MockState {
  const longId = "route-source-message-with-long-unbroken-identity-".repeat(7);
  const longProvider = "provider-preset-with-long-unbroken-routing-owner-".repeat(6);
  const longModel = "model-with-long-unbroken-context-identity-".repeat(7);
  state.channelMessageRouteDecisions = [{
    schemaVersion: 1,
    id: "route_ui2_dead_css_contract",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    sourceMessageId: longId,
    replyMessageId: "reply-message-ui2-route-inspect",
    mode: "auto_route",
    action: "reply",
    selectedTeammateId: "designer",
    selectedProviderPresetId: longProvider,
    confidence: 0.94,
    reason: "The channel selected one teammate using current workspace context.",
    alternativesConsidered: [{
      teammateId: "engineer",
      label: "Engineering alternative",
      reason: "Alternative reason with long wrapping evidence ".repeat(14),
    }],
    contextPack: {
      schemaVersion: 1,
      kind: "auto_route_selector",
      providerPresetId: longProvider,
      modelId: longModel,
      sectionIds: ["channel_collaboration_protocol", "auto_route_recent_context"],
      droppedSectionIds: [],
      sourceRefCounts: { channel: 1, message: 18, memory: 5 },
      compactionIds: ["compaction-ui2-route-001", "compaction-ui2-route-002"],
    },
    status: "accepted",
    createdBy: "model",
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:01.000Z",
  }];
  state.channelIntentDecisions = [];
  return state;
}

async function openRoutingInspector(page: Page): Promise<{
  readonly dock: Locator;
  readonly inspector: Locator;
}> {
  await openChannelContextPanel(page);
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await expect(dock).toBeVisible();
  const modes = page.getByLabel("Channel inspector modes");
  if (!await modes.isVisible().catch(() => false)) {
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
  }
  await expect(modes).toBeVisible();
  const routing = modes.getByRole("button", { name: "Routing", exact: true });
  await routing.focus();
  await page.keyboard.press("Enter");
  await expect(routing).toHaveClass(/active/u);
  const inspector = page.getByRole("region", { name: "Channel inspector" });
  await expect(inspector).toBeVisible();
  await expect(inspector.locator(".routing-evidence-index")).toContainText("1 decisions");
  return { dock, inspector };
}

async function expectRouteDetailContract(detail: Locator): Promise<void> {
  await expect(detail).toBeVisible();
  const grids = detail.locator(".channel-route-inspect-grid");
  const sections = detail.locator(".channel-route-inspect-section");
  await expect(grids).toHaveCount(2);
  await expect(sections).toHaveCount(2);
  await expect(detail.getByText("Alternatives considered", { exact: true })).toBeVisible();
  await expect(detail.getByText("Context source metadata", { exact: true })).toBeVisible();
  await expect(detail.getByText(/Alternative reason with long wrapping evidence/u)).toBeVisible();
  await expect(detail.getByText(/provider-preset-with-long-unbroken-routing-owner/u)).toBeVisible();
  await expect(detail.getByText(/model-with-long-unbroken-context-identity/u)).toBeVisible();

  const wrappingNodes = detail.locator("dd, li strong, li small");
  expect(await wrappingNodes.count()).toBeGreaterThan(10);
  const wrapping = await wrappingNodes.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const owner = element.closest(".routing-evidence-detail")?.getBoundingClientRect();
    return {
      bottom: box.bottom,
      left: box.left,
      overflowWrap: style.overflowWrap,
      ownerBottom: owner?.bottom ?? 0,
      ownerLeft: owner?.left ?? 0,
      ownerRight: owner?.right ?? 0,
      right: box.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  }));
  expect(wrapping.every((item) => item.overflowWrap === "anywhere")).toBe(true);
  expect(wrapping.every((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
  expect(wrapping.every((item) => item.left >= item.ownerLeft - 1)).toBe(true);
  expect(wrapping.every((item) => item.right <= item.ownerRight + 1)).toBe(true);
  expect(wrapping.every((item) => item.bottom <= item.ownerBottom + 1)).toBe(true);
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
    sessionStorage.setItem("ling-stack.e2eThemeSelection", JSON.stringify(selection));
  }, { theme: options.theme });
}

async function expectNoDeadRouteRoots(page: Page): Promise<void> {
  const selectors = deadClassTokens.map((token) => `.${token}`).join(", ");
  await expect(page.locator(selectors)).toHaveCount(0);
}

async function expectNoOverflow(page: Page, regions: readonly Locator[]): Promise<void> {
  const documentOverflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(documentOverflow.x).toBeLessThanOrEqual(1);
  expect(documentOverflow.y).toBeLessThanOrEqual(1);
  for (const region of regions) {
    await expect(region).toBeVisible();
    const geometry = await region.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  }
}

async function expectReducedMotion(locators: readonly Locator[]): Promise<void> {
  const snapshots = await Promise.all(locators.map((locator) => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      animationName: style.animationName,
      identity: `${element.tagName.toLowerCase()}.${element.className}`,
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
    };
  })));
  const activeMotion = snapshots.filter((snapshot) => (
    hasNonInstantDuration(snapshot.animationDuration) && snapshot.animationName !== "none"
  ) || (
    hasNonInstantMovementTransition(snapshot.transitionDuration, snapshot.transitionProperty)
  ));
  expect(activeMotion, "reduced-motion surfaces must not retain active animation or movement transitions").toEqual([]);
}

function hasNonInstantDuration(value: string): boolean {
  return value.split(",").some((part) => {
    const amount = Number.parseFloat(part);
    const seconds = part.trim().endsWith("ms") ? amount / 1000 : amount;
    return seconds > 0.01;
  });
}

function hasNonInstantMovementTransition(durations: string, properties: string): boolean {
  const movementProperty = /^(?:bottom|height|left|right|rotate|scale|top|transform|translate|width)$/u;
  const durationList = durations.split(",");
  return properties.split(",").some((property, index) => (
    movementProperty.test(property.trim()) &&
    hasNonInstantDuration(durationList[index] ?? durationList[durationList.length - 1] ?? "0s")
  ));
}

function watchRuntime(page: Page): { readonly consoleErrors: string[]; readonly pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const source = message.location().url;
    consoleErrors.push(source ? `${message.text()} ${source}` : message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

function expectRuntime(runtime: { readonly consoleErrors: string[]; readonly pageErrors: string[] }): void {
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
}

async function captureIfEnabled(page: Page, fileName: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: `${evidenceDirectory}${fileName}`,
  });
}

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(`${repositoryDirectory}${relativePath}`, "utf8");
}

async function readSourceTree(
  directory: string,
  include: (path: string) => boolean = () => true,
): Promise<readonly SourceFile[]> {
  const paths = await collectSourcePaths(directory);
  return Promise.all(paths.filter(include).map(async (path) => ({
    content: await readFile(path, "utf8"),
    path: relative(repositoryDirectory, path),
  })));
}

async function collectSourcePaths(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<readonly string[]> => {
    if (["coverage", "dist", "node_modules", "test-results"].includes(entry.name)) return [];
    const path = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return collectSourcePaths(path);
    return [".css", ".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

function findExactTokenOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegularExpression(token)}(?![A-Za-z0-9_-])`, "u");
  return files.flatMap((file) => pattern.test(file.content) ? [file.path] : []);
}

function findExactClassSelectorOccurrences(files: readonly SourceFile[], token: string): readonly string[] {
  return files.flatMap((file) => extractCssSelectors(file.content).flatMap((selectorGroup) => (
    selectorGroup.split(",").some((branch) => branch.trim() === `.${token}`)
      ? [`${file.path}:.${token}`]
      : []
  )));
}

function extractCssSelectors(css: string): readonly string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  return Array.from(withoutComments.matchAll(/([^{}]+)\{/gu), (match) => match[1]?.trim() ?? "")
    .filter((selector) => selector.length > 0 && !selector.startsWith("@"));
}

function countExactClassNameToken(source: string, token: string): number {
  const classNamePattern = /className="([^"]+)"/gu;
  return Array.from(source.matchAll(classNamePattern), (match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/u).includes(token)).length;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
