import { mkdir, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProposedPlanArtifact } from "@ling-stack/contracts";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-right-dock-legacy-writer/",
  import.meta.url,
));
const webStylesDirectory = fileURLToPath(new URL("../src/styles/", import.meta.url));
const packageStylesDirectory = fileURLToPath(new URL(
  "../../../packages/conversation-ui-react/src/styles/",
  import.meta.url,
));

test.describe.configure({ mode: "serial" });

test("T13-O.25-C light Channel Dock owns launcher, page, resize, and scroll geometry", async ({ page }) => {
  await assertProductionOwnershipContract();
  const signals = collectBrowserSignals(page);
  await initializePage(page, "ling-light", { width: 1440, height: 960 });
  const state = createChannelDockState(28);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  await toolbar.getByRole("button", { name: "Show details" }).click();

  const main = page.locator(".task-workbench-main");
  const frame = page.locator(".channel-side-panel-frame");
  const panel = page.getByRole("complementary", { name: "Channel workspace dock" });
  const handle = page.getByRole("separator", { name: "Resize workspace dock" });
  await expect(panel).toHaveAttribute("data-ui2-right-dock", "true");
  await expect(main).toHaveClass(/with-channel-side-panel/u);
  await expect(panel.locator("[data-ui2-dock-launcher-action]")).toHaveCount(6);
  await assertRuntimeOwnerSheet(page);
  await assertDockGeometry(main, frame, panel, handle);

  await panel.getByRole("button", { name: "Plans" }).click();
  const body = panel.locator(".right-dock-body");
  await expect(body).toHaveAttribute("data-ui2-dock-page", "plans");
  await expect(panel.locator(".right-dock-plan-row")).toHaveCount(28);
  const scroll = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(scroll.overflowY).toBe("auto");
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight + 40);
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(40);

  const widthBefore = (await frame.boundingBox())?.width ?? 0;
  await dragResizeHandle(page, handle, -120);
  await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThan(widthBefore + 70);
  await assertDockGeometry(main, frame, panel, handle);
  await assertNoHorizontalOverflow(page, [
    ".task-workbench-main",
    ".channel-side-panel-frame",
    ".channel-side-panel",
    ".right-dock-head",
    ".right-dock-body",
  ]);
  await captureIfEnabled(page, "1440x960-ling-light-channel-dock-plans-resized.png");

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Show details" })).toHaveAttribute("aria-expanded", "false");
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-O.25-C dark reduced-motion Summary yields to the Channel Dock without overlap", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await initializePage(page, "ling-dark", { width: 1280, height: 800, reducedMotion: "reduce" });
  await mockDaemon(page, createChannelDockState());
  await page.goto("/");
  await openEngineeringChannel(page);

  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  const summaryButton = toolbar.getByRole("button", { name: "Summary" });
  const detailsButton = toolbar.getByRole("button", { name: "Show details" });
  await assertMinimumHitAreas(toolbar.locator("button:visible"));
  await assertFocusedControlContained(detailsButton, toolbar);

  await summaryButton.click();
  const summary = page.locator(".channel-progress-popover");
  await expect(summary).toBeVisible();

  await detailsButton.click();
  const panel = page.getByRole("complementary", { name: "Channel workspace dock" });
  await expect(panel).toBeVisible();
  await expect(summary).toHaveCount(0);
  await expect(summaryButton).not.toHaveAttribute("aria-pressed", "true");
  await captureIfEnabled(page, "1280x800-ling-dark-channel-dock-without-summary-overlap.png");

  await toolbar.getByRole("button", { name: "Hide details" }).click();
  await expect(panel).toHaveCount(0);
  await expect(summary).toBeVisible();
  await expect(summaryButton).toHaveAttribute("aria-pressed", "true");
  await assertReducedMotion(summary);

  await assertNoHorizontalOverflow(page, [
    ".task-workbench-main",
    ".channel-progress-popover",
    ".workspace-top-right-toolbar",
  ]);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-O.25-C Quiet Ocean keeps package Dock chrome and long detail contained", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await initializePage(page, "ling-light", { width: 1440, height: 960 });
  const state = createChannelDockState(3, true);
  await mockDaemon(page, state);
  await page.goto("/");
  await seedImportedQuietOcean(page);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "quiet-ocean");
  await openEngineeringChannel(page);

  await page.getByRole("toolbar", { name: "Workspace task toolbar" })
    .getByRole("button", { name: "Show details" })
    .click();
  const panel = page.getByRole("complementary", { name: "Channel workspace dock" });
  await panel.getByRole("button", { name: "Plans" }).click();
  await panel.getByRole("button", { name: "Open plan detail O.25 long containment plan" }).click();
  await expect(panel.locator(".right-dock-plan-detail")).toBeVisible();
  await expect(panel.locator(".right-dock-plan-markdown")).toContainText("Long content containment evidence");

  await assertPackageDockTokens(panel);
  await assertNoHorizontalOverflow(page, [
    ".task-workbench-main",
    ".channel-side-panel-frame",
    ".channel-side-panel",
    ".right-dock-head",
    ".right-dock-body",
    ".right-dock-plan-detail",
    ".right-dock-plan-markdown",
  ]);
  await captureIfEnabled(page, "1440x960-quiet-ocean-channel-dock-plan-detail.png");

  const back = panel.getByRole("button", { name: "Back" });
  await back.click();
  await expect(panel.locator("[data-ui2-dock-page='plans']")).toBeVisible();
  await back.click();
  await expect(panel.locator("[data-ui2-dock-page]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

async function initializePage(
  page: Page,
  themeId: "ling-light" | "ling-dark",
  viewport: { readonly width: number; readonly height: number; readonly reducedMotion?: "reduce" },
): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.emulateMedia({
    colorScheme: themeId === "ling-dark" ? "dark" : "light",
    reducedMotion: viewport.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ savedThemeId }) => {
    const storedOverride = sessionStorage.getItem("ling-stack.e2eThemeSelection");
    const selection = storedOverride ? JSON.parse(storedOverride) : { mode: "fixed", themeId: savedThemeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", savedThemeId === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", savedThemeId === "ling-dark" ? "dark" : "light");
  }, { savedThemeId: themeId });
}

function createChannelDockState(planCount = 0, includeLongPlan = false): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = [channelRootThread()];
  state.proposedPlans = Array.from({ length: planCount }, (_, index) => channelPlan(index));
  if (includeLongPlan) state.proposedPlans = [longChannelPlan(), ...state.proposedPlans];
  return state;
}

function channelRootThread(): MockState["threads"][number] {
  return {
    id: "thread_channel_main_channel_engineering",
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Engineering discussion",
    objective: "Verify Channel Dock ownership.",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: "2026-07-24T01:00:00.000Z",
    updatedAt: "2026-07-24T01:00:00.000Z",
  };
}

function channelPlan(index: number): ProposedPlanArtifact {
  const number = String(index + 1).padStart(2, "0");
  return {
    id: `plan_ui2_channel_dock_${number}`,
    workspaceId: "workspace_default",
    threadId: "thread_channel_main_channel_engineering",
    channelId: "channel_engineering",
    goalId: `goal_ui2_channel_dock_${number}`,
    planGroupId: `plan_group_ui2_channel_dock_${number}`,
    version: 1,
    title: `Dock ownership plan ${number}`,
    bodyMarkdown: `## Dock ownership plan ${number}\n\nVerify launcher, page, resize, and internal scrolling.`,
    status: "draft",
    createdAt: "2026-07-24T01:00:00.000Z",
    updatedAt: "2026-07-24T01:00:00.000Z",
  };
}

function longChannelPlan(): ProposedPlanArtifact {
  return {
    ...channelPlan(98),
    id: "plan_ui2_channel_dock_long",
    goalId: "goal_ui2_channel_dock_long",
    planGroupId: "plan_group_ui2_channel_dock_long",
    title: "O.25 long containment plan",
    bodyMarkdown: [
      "## Long content containment evidence",
      "",
      "This detail intentionally carries a long operational explanation so the package Body remains the scroll owner while the Channel surface only owns outer geometry.",
      "",
      ...Array.from({ length: 18 }, (_, index) => (
        `${index + 1}. Verify Header tokens, Body tokens, return navigation, close behavior, internal scrolling, and readable wrapping across the complete Channel Dock detail surface.`
      )),
    ].join("\n"),
  };
}

async function assertProductionOwnershipContract(): Promise<void> {
  const shellPath = `${webStylesDirectory}channel-right-dock/shell.css`;
  const facadePath = `${webStylesDirectory}channel-right-dock.css`;
  const componentsPath = `${webStylesDirectory}components.css`;
  const [shell, facade, components, productionSources] = await Promise.all([
    readFile(shellPath, "utf8"),
    readFile(facadePath, "utf8"),
    readFile(componentsPath, "utf8"),
    readProductionSources(),
  ]);

  expect(facade.trimStart().startsWith('@import "./channel-right-dock/shell.css";')).toBe(true);
  for (const selector of [
    ".task-workbench-main",
    ".channel-side-panel-frame",
    ".channel-side-panel",
    ".channel-side-panel-resize-handle",
  ]) {
    expect(hasPositiveSelector(shell, selector), `${selector} focused owner`).toBe(true);
    expect(hasPositiveSelector(components, selector), `${selector} aggregate owner`).toBe(false);
  }

  for (const packageSelector of [
    ".right-dock-head",
    ".right-dock-body",
    ".right-dock-icon-button",
    ".right-dock-launcher-row",
  ]) {
    expect(shell.includes(packageSelector), `${packageSelector} must remain package-owned`).toBe(false);
  }
  expect(shell).not.toContain("--ling-bg-panel");
  expect(shell).not.toContain("--ling-border-default");

  const deadFamilies = [
    /\bchannel-side-panel-(?:head|title|actions|nav|nav-item|body)\b/u,
    /\bchannel-review-(?:panel|loading|summary|section|list|row|row-main)\b/u,
    /\bchannel-management-panel\b/u,
    /\bchannel-files\b/u,
  ];
  for (const pattern of deadFamilies) {
    const owners = productionSources
      .filter((source) => pattern.test(source.content))
      .map((source) => source.path);
    expect(owners, `${pattern.source} dead production owners`).toEqual([]);
  }
}

async function readProductionSources(): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const roots = [webStylesDirectory, packageStylesDirectory];
  const paths = (await Promise.all(roots.map((root) => collectFiles(root, new Set([".css", ".ts", ".tsx"]))))).flat();
  return Promise.all(paths.map(async (path) => ({ path, content: await readFile(path, "utf8") })));
}

async function collectFiles(directory: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectFiles(path, extensions));
    else if (extensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

function hasPositiveSelector(css: string, selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:,|\\{)`, "u").test(css);
}

async function assertRuntimeOwnerSheet(page: Page): Promise<void> {
  const owners = await page.evaluate(() => {
    const matches: Array<{ owner: string; selector: string }> = [];
    const visit = (rules: CSSRuleList, owner: string): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule && [
          ".task-workbench-main",
          ".channel-side-panel-frame",
          ".channel-side-panel",
          ".channel-side-panel-resize-handle",
        ].includes(rule.selectorText.trim())) matches.push({ owner, selector: rule.selectorText.trim() });
        if ("cssRules" in rule) {
          try { visit((rule as CSSGroupingRule).cssRules, owner); } catch { /* inaccessible branch */ }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      const ownerNode = sheet.ownerNode instanceof HTMLElement ? sheet.ownerNode : null;
      const owner = sheet.href ?? ownerNode?.dataset.viteDevId ?? ownerNode?.getAttribute("data-vite-dev-id") ?? "inline";
      try { visit(sheet.cssRules, owner); } catch { /* cross-origin stylesheet */ }
    }
    return matches;
  });
  for (const selector of [
    ".task-workbench-main",
    ".channel-side-panel-frame",
    ".channel-side-panel",
    ".channel-side-panel-resize-handle",
  ]) {
    const selectorOwners = owners.filter((entry) => entry.selector === selector).map((entry) => entry.owner);
    expect(selectorOwners, `${selector} runtime owners`).toHaveLength(1);
    expect(selectorOwners.some((owner) => owner.includes("components.css")), selector).toBe(false);
  }
}

async function assertDockGeometry(main: Locator, frame: Locator, panel: Locator, handle: Locator): Promise<void> {
  await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  const [mainBox, frameBox, panelBox, handleBox] = await Promise.all([
    main.boundingBox(),
    frame.boundingBox(),
    panel.boundingBox(),
    handle.boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  expect(Math.abs((frameBox?.width ?? 0) - (panelBox?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((frameBox?.x ?? 0) - (panelBox?.x ?? 0))).toBeLessThanOrEqual(1);
  expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual((mainBox?.x ?? 0) + (mainBox?.width ?? 0) + 1);
  expect((handleBox?.x ?? 0) + (handleBox?.width ?? 0)).toBeLessThanOrEqual((frameBox?.x ?? 0) + 1);
  expect(frameBox?.height ?? 0).toBeGreaterThan(300);
  expect(panelBox?.height ?? 0).toBeGreaterThan(300);
}

async function dragResizeHandle(page: Page, handle: Locator, deltaX: number): Promise<void> {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = (box?.x ?? 0) + Math.max(1, (box?.width ?? 0) / 2);
  const y = (box?.y ?? 0) + Math.min(90, Math.max(1, (box?.height ?? 0) - 1));
  await handle.hover({ position: { x: Math.max(1, (box?.width ?? 0) / 2), y: Math.min(90, Math.max(1, (box?.height ?? 0) - 1)) } });
  await page.mouse.down();
  await page.mouse.move(Math.max(1, x + deltaX), y, { steps: 5 });
  await page.mouse.up();
}

async function assertMinimumHitAreas(locator: Locator): Promise<void> {
  await expect(locator).not.toHaveCount(0);
  await expect.poll(() => locator.evaluateAll((elements) => elements.flatMap((element) => {
    const box = element.getBoundingClientRect();
    if (box.width >= 32 && box.height >= 32) return [];
    return [{
      height: box.height,
      label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.className,
      width: box.width,
    }];
  }))).toEqual([]);
}

async function assertFocusedControlContained(control: Locator, owner: Locator): Promise<void> {
  const [before, ownerBox] = await Promise.all([control.boundingBox(), owner.boundingBox()]);
  await control.focus();
  await expect(control).toBeFocused();
  const after = await control.boundingBox();
  expect(after).toEqual(before);
  expect(after).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect((after?.x ?? 0) >= (ownerBox?.x ?? 0) - 1).toBe(true);
  expect((after?.y ?? 0) >= (ownerBox?.y ?? 0) - 1).toBe(true);
  expect((after?.x ?? 0) + (after?.width ?? 0)).toBeLessThanOrEqual((ownerBox?.x ?? 0) + (ownerBox?.width ?? 0) + 1);
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual((ownerBox?.y ?? 0) + (ownerBox?.height ?? 0) + 1);
}

async function assertReducedMotion(locator: Locator): Promise<void> {
  const durations = await locator.evaluate((element) => getComputedStyle(element).transitionDuration
    .split(",")
    .map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 0.001 : 1)));
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.01);
}

async function assertPackageDockTokens(panel: Locator): Promise<void> {
  const snapshot = await panel.evaluate((element) => {
    const root = document.documentElement;
    const head = element.querySelector<HTMLElement>(".right-dock-head");
    const body = element.querySelector<HTMLElement>(".right-dock-body");
    const title = element.querySelector<HTMLElement>(".right-dock-page-title strong");
    if (!head || !body || !title) throw new Error("Package Dock Header/Body contract is missing");
    const resolveColor = (token: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const resolveBackground = (token: string): string => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    return {
      bodyColor: getComputedStyle(body).color,
      expectedBackground: resolveBackground("--ling-bg-panel"),
      expectedBorder: resolveColor("--ling-border-default"),
      expectedDefaultText: resolveColor("--ling-text-default"),
      expectedStrongText: resolveColor("--ling-text-strong"),
      headBorder: getComputedStyle(head).borderBottomColor,
      panelBackground: getComputedStyle(element).backgroundColor,
      panelTheme: root.dataset.uiTheme,
      titleColor: getComputedStyle(title).color,
    };
  });
  expect(snapshot.panelTheme).toBe("quiet-ocean");
  expect(snapshot.panelBackground).toBe(snapshot.expectedBackground);
  expect(snapshot.headBorder).toBe(snapshot.expectedBorder);
  expect(snapshot.bodyColor).toBe(snapshot.expectedDefaultText);
  expect(snapshot.titleColor).toBe(snapshot.expectedStrongText);
}

async function assertNoHorizontalOverflow(page: Page, selectors: readonly string[]): Promise<void> {
  await expectNoDocumentOverflow(page);
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await expect(locator).toBeVisible();
    const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, selector).toBeLessThanOrEqual(1);
  }
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1);
}

function collectBrowserSignals(page: Page): { readonly consoleErrors: string[]; readonly pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const sourceUrl = message.location().url;
    consoleErrors.push(sourceUrl ? `${message.text()} ${sourceUrl}` : message.text());
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
    path: `${evidenceDirectory}${fileName}`,
  });
}
