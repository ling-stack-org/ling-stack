import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { createDefaultProviderTemplates } from "./support/mock-state";
import {
  createMediaMixedFixture,
  createMediaRouteControl,
  installMediaScenarioRoutes,
  openMediaJobs,
  seedImportedQuietOcean,
} from "./support/media-jobs-fixtures";
import {
  createLoadedMediaProductionFixture,
  createMediaProductionRouteControl,
  installMediaProductionScenarioRoutes,
  openMediaProduction,
} from "./support/media-production-fixtures";

const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/media-workspace-root-ownership/",
  import.meta.url,
));

test("T13-O.24-C light Production Studio owns the full-bleed Media root", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await initializePage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  await prepareProduction(page, createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 3 }));

  await expect(page.locator(".media-production-page")).toBeVisible();
  await assertMediaRootContract(page);
  await assertSameGeometry(page.locator(".workspace-generation-surface"), page.locator(".media-production-page"));

  const canvas = page.locator(".media-production-canvas-stage");
  await expect(canvas).toBeVisible();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(3);
  await expect(page.locator(".react-flow__viewport")).toBeVisible();
  await expect(page.locator(".react-flow__background")).toBeVisible();
  const firstNode = page.locator(".storyboard-scene-node").first();
  const nodeBox = await firstNode.boundingBox();
  expect(nodeBox?.width ?? 0).toBeGreaterThan(100);
  expect(nodeBox?.height ?? 0).toBeGreaterThan(60);

  const leftDock = page.locator(".media-production-dock-panel.left");
  const rightDock = page.locator(".media-production-dock-panel.right");
  await expect(leftDock).toHaveClass(/is-open/u);
  await leftDock.locator(".project-outline-scene-main").first().click();
  await expect(rightDock).toHaveClass(/is-open/u);
  await expect(rightDock.locator(".scene-inspector-tabs")).toBeVisible();
  await expect(rightDock.locator('[role="tab"][data-state="active"]')).toBeVisible();

  await assertTypedIconButtonInventory(page.locator('.media-production-page button[data-icon-only="true"]:visible'));
  await assertMinimumHitAreas(page.locator(".media-production-canvas-toolbar .ling-ui-button:visible, .media-production-dock-rail .ling-ui-button:visible"));
  await assertNoHorizontalOverflow(page, [
    ".workspace-generation-surface",
    ".media-production-page",
    ".media-production-studio",
  ]);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
  await captureIfEnabled(page, "1440x960-ling-light-production-studio-full-bleed.png");
});

test("T13-O.24-C dark Generation Tasks releases every remaining strict blanket", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await initializePage(page, "en-US", "ling-dark", { width: 1280, height: 800, reducedMotion: "reduce" });
  await prepareMediaJobs(page, createMediaMixedFixture(100));

  await expect(page.locator("[data-media-jobs-surface]")).toBeVisible();
  await assertMediaRootContract(page);
  await assertStrictBlanketRelease(page);

  await page.locator('[data-media-job-row="media_job_image_ready"]').click();
  const inspector = page.locator('[data-media-job-inspector="media_job_image_ready"]');
  await expect(inspector).toBeVisible();
  await assertCssColorToken(inspector.locator(".ling-ui-status-indicator").first(), "color", "--ling-text-muted");
  await assertCssColorToken(page.locator("[data-media-jobs-header] .ling-ui-button[data-variant=\"primary\"]"), "background", "--ling-action-accent");

  await page.getByRole("button", { name: "New generation task" }).click();
  const dialog = page.getByRole("dialog", { name: "New generation task" });
  await expect(dialog).toBeVisible();
  const textarea = dialog.locator(".ling-ui-textarea");
  await assertCssColorToken(textarea, "background", "--ling-bg-panel");
  await assertFocusContainment(textarea, dialog);
  await assertReducedMotion(page.locator("[data-media-jobs-header] .ling-ui-button, [data-media-jobs-header] .ling-ui-segmented-control-item"));
  await assertMinimumHitAreas(page.locator("[data-media-jobs-header] .ling-ui-button:visible, [role=\"dialog\"] .ling-ui-button:visible"));

  await assertNoHorizontalOverflow(page, [
    ".workspace-generation-surface",
    "[data-media-jobs-surface]",
    ".media-jobs-list-pane",
    ".media-job-inspector",
    "[role=\"dialog\"]",
  ]);
  expectUnexpectedConsoleErrors(signals.consoleErrors, ["/artifacts/artifact_preview_unavailable/content"]);
  expect(signals.pageErrors).toEqual([]);
  await captureIfEnabled(page, "1280x800-ling-dark-generation-tasks.png");
});

test("T13-O.24-C imported Quiet Ocean keeps Media Dialog primitives theme-owned", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await initializePage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  await prepareMediaJobs(page, createMediaMixedFixture(), false);
  await seedImportedQuietOcean(page);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "quiet-ocean");
  await openMediaJobs(page);

  await assertMediaRootContract(page);
  await page.locator('[data-media-job-row="media_job_image_ready"]').click();
  const status = page.locator("[data-media-job-inspector] .ling-ui-status-indicator").first();
  await assertCssColorToken(status, "color", "--ling-text-muted");

  await page.getByRole("button", { name: "New generation task" }).click();
  const dialog = page.getByRole("dialog", { name: "New generation task" });
  await expect(dialog).toBeVisible();
  await assertCssColorToken(dialog, "background", "--ling-bg-elevated");
  await assertCssColorToken(dialog.locator(".ling-ui-select").first(), "background", "--ling-bg-panel");
  await assertCssColorToken(dialog.locator(".ling-ui-textarea"), "background", "--ling-bg-panel");
  await assertCssColorToken(dialog.locator(".ling-ui-button[data-variant=\"primary\"]"), "background", "--ling-action-accent");
  await assertMinimumHitAreas(dialog.locator(".ling-ui-button:visible"));
  await assertNoHorizontalOverflow(page, [
    ".workspace-generation-surface",
    "[data-media-jobs-surface]",
    "[role=\"dialog\"]",
    ".ling-ui-dialog-body",
  ]);
  expectUnexpectedConsoleErrors(signals.consoleErrors, ["/artifacts/artifact_preview_unavailable/content"]);
  expect(signals.pageErrors).toEqual([]);
  await captureIfEnabled(page, "1440x960-quiet-ocean-media-dialog.png");
});

async function initializePage(
  page: Page,
  locale: "en-US" | "zh-CN",
  themeId: "ling-light" | "ling-dark",
  viewport: { readonly width: number; readonly height: number; readonly reducedMotion?: "reduce" },
): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  if (viewport.reducedMotion) await page.emulateMedia({ reducedMotion: viewport.reducedMotion });
  await page.addInitScript(({ savedLocale, savedTheme }) => {
    const storedOverride = sessionStorage.getItem("ling-stack.e2eThemeSelection");
    const selection = storedOverride ? JSON.parse(storedOverride) : { mode: "fixed", themeId: savedTheme };
    localStorage.setItem("ling-stack.locale", savedLocale);
    localStorage.setItem("ling-stack.themePreference", savedTheme === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, { savedLocale: locale, savedTheme: themeId });
}

async function prepareProduction(page: Page, state: MockState): Promise<void> {
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaProductionScenarioRoutes(page, state, createMediaProductionRouteControl());
  await page.goto("/");
  await openMediaProduction(page);
}

async function prepareMediaJobs(page: Page, state: MockState, navigate = true): Promise<void> {
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaScenarioRoutes(page, createMediaRouteControl());
  await page.goto("/");
  if (navigate) await openMediaJobs(page);
}

async function assertMediaRootContract(page: Page): Promise<void> {
  const root = page.locator(".workspace-generation-surface");
  await expect(root).toBeVisible();
  const snapshot = await root.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--ling-bg-app)";
    document.body.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      background: style.backgroundColor,
      expectedBackground,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
    };
  });
  expect(snapshot.padding).toEqual(["0px", "0px", "0px", "0px"]);
  expect.soft(snapshot.overflowX).toBe("hidden");
  expect.soft(snapshot.overflowY).toBe("hidden");
  expect(snapshot.background).toBe(snapshot.expectedBackground);
}

async function assertStrictBlanketRelease(page: Page): Promise<void> {
  const audit = await page.evaluate(() => {
    const selectors: string[] = [];
    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) selectors.push(rule.selectorText);
        if ("cssRules" in rule) {
          try { visit((rule as CSSGroupingRule).cssRules); } catch { /* inaccessible stylesheet branch */ }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { visit(sheet.cssRules); } catch { /* cross-origin stylesheet */ }
    }
    const darkBlankets = selectors.filter((selector) => selector.startsWith(':root[data-theme="dark"] .workspace:where('));
    const positiveRootWriters = selectors.filter((selector) => selector.trim() === ".workspace.workspace-generation-surface");
    const explicitDarkRoot = selectors.filter((selector) => /(^|,\s*):root\[data-theme="dark"\] \.workspace-generation-surface(?:,|$)/u.test(selector));
    const darkRootGroups = selectors.filter((selector) => selector.startsWith(':root[data-theme="dark"] .workspace:not(.workspace-provider-surface):where('));
    return {
      darkBlanketCount: darkBlankets.length,
      darkBlanketsMissingExclusion: darkBlankets.filter((selector) => !selector.includes(":not(.workspace-generation-surface)")),
      darkRootGroupsMissingExclusion: darkRootGroups.filter((selector) => !selector.includes(":not(.workspace-generation-surface)")),
      explicitDarkRoot,
      positiveRootWriterCount: positiveRootWriters.length,
    };
  });
  expect(audit.darkBlanketsMissingExclusion).toEqual([]);
  expect(audit.darkRootGroupsMissingExclusion).toEqual([]);
  expect(audit.explicitDarkRoot).toEqual([]);
  expect(audit.positiveRootWriterCount).toBe(1);
}

async function assertSameGeometry(outer: Locator, inner: Locator): Promise<void> {
  const [outerBox, innerBox] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(outerBox).not.toBeNull();
  expect(innerBox).not.toBeNull();
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs((outerBox?.[key] ?? 0) - (innerBox?.[key] ?? 0)), key).toBeLessThanOrEqual(1);
  }
}

async function assertCssColorToken(
  locator: Locator,
  property: "background" | "color",
  token: string,
): Promise<void> {
  await expect(locator).toBeVisible();
  const snapshot = await locator.evaluate((element, input) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    if (input.property === "background") probe.style.backgroundColor = `var(${input.token})`;
    else probe.style.color = `var(${input.token})`;
    document.body.append(probe);
    const probeStyle = getComputedStyle(probe);
    const expected = input.property === "background" ? probeStyle.backgroundColor : probeStyle.color;
    probe.remove();
    return {
      actual: input.property === "background" ? style.backgroundColor : style.color,
      expected,
    };
  }, { property, token });
  expect(snapshot.actual).toBe(snapshot.expected);
}

async function assertFocusContainment(control: Locator, owner: Locator): Promise<void> {
  const [before, ownerBox] = await Promise.all([control.boundingBox(), owner.boundingBox()]);
  await control.focus();
  await expect(control).toBeFocused();
  const after = await control.boundingBox();
  expect(before).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after).toEqual(before);
  expect((after?.y ?? 0) >= (ownerBox?.y ?? 0) - 1).toBe(true);
  expect((after?.x ?? 0) >= (ownerBox?.x ?? 0) - 1).toBe(true);
  expect((after?.x ?? 0) + (after?.width ?? 0) <= (ownerBox?.x ?? 0) + (ownerBox?.width ?? 0) + 1).toBe(true);
  expect((after?.y ?? 0) + (after?.height ?? 0) <= (ownerBox?.y ?? 0) + (ownerBox?.height ?? 0) + 1).toBe(true);
}

async function assertReducedMotion(locator: Locator): Promise<void> {
  const durations = await locator.evaluateAll((elements) => elements.flatMap((element) => getComputedStyle(element)
    .transitionDuration.split(",")
    .map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 0.001 : 1))));
  expect(durations.length).toBeGreaterThan(0);
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.01);
}

async function assertMinimumHitAreas(locator: Locator): Promise<void> {
  await expect(locator).not.toHaveCount(0);
  await expect.poll(async () => locator.evaluateAll((elements) => elements.flatMap((element) => {
    const box = element.getBoundingClientRect();
    if (box.height >= 32 && box.width >= 32) return [];
    return [{
      height: box.height,
      label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.className,
      width: box.width,
    }];
  }))).toEqual([]);
}

async function assertTypedIconButtonInventory(locator: Locator): Promise<void> {
  await expect(locator).not.toHaveCount(0);
  const violations = await locator.evaluateAll((buttons) => buttons.flatMap((button) => {
    const box = button.getBoundingClientRect();
    const ariaLabel = button.getAttribute("aria-label") ?? "";
    const title = button.getAttribute("title") ?? "";
    const iconCount = button.querySelectorAll('svg[data-ling-icon=""]').length;
    if (
      button.getAttribute("data-ling-icon-button-contract") === "typed-lucide"
      && ariaLabel.length > 0
      && title === ariaLabel
      && iconCount === 1
      && box.width >= 32
      && box.height >= 32
    ) return [];
    return [{
      ariaLabel,
      contract: button.getAttribute("data-ling-icon-button-contract"),
      height: box.height,
      iconCount,
      title,
      width: box.width,
    }];
  }));
  expect(violations).toEqual([]);
}

async function assertNoHorizontalOverflow(page: Page, selectors: readonly string[]): Promise<void> {
  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(documentOverflow).toBeLessThanOrEqual(1);
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await expect(locator).toBeVisible();
    const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow, selector).toBeLessThanOrEqual(1);
  }
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

function expectUnexpectedConsoleErrors(messages: readonly string[], expectedUrlFragments: readonly string[] = []): void {
  const unexpected = messages.filter((message) => !expectedUrlFragments.some((fragment) => message.includes(fragment)));
  expect(unexpected).toEqual([]);
}

async function captureIfEnabled(page: Page, fileName: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: `${evidenceDirectory}/${fileName}`,
  });
}
