import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
} from "./support/runs-threads-fixture";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/run-guidance-legacy-writer/",
  import.meta.url,
));
const expectedInjected400 = /400 \(Bad Request\)/u;
const legacyGuidanceSelector = [
  ".run-guidance-actions",
  ".run-guidance-submit-row",
  ".run-guidance-row-meta",
  ".run-guidance-input",
  ".run-guidance-list",
  ".run-guidance-row",
  ".run-lineage-banner",
  ".run-guidance-row-main",
].join(", ");

test("1440x960 Ling Light keeps one Run Guidance panel through empty, queue, and cancel states", async ({ page }) => {
  await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
  const runtime = watchRuntime(page);
  const state = createRunsThreadsFixture();
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const panel = await expectRunGuidancePanelContract(page);
  await expect(panel.getByText("No guidance queued for this run", { exact: true })).toBeVisible();

  const instruction = "Queue this focused ownership check and keep its actions directly reachable.";
  const textarea = panel.getByPlaceholder("Tell this run what to do next...");
  await textarea.fill(instruction);
  await panel.getByRole("button", { name: "Queue guidance" }).click();

  const row = panel.locator(".runs-intervention-row").filter({ hasText: instruction });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Queued");
  await expect(row.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Start handling" })).toBeVisible();
  await expectButtonHitAreas(panel, 5);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await row.scrollIntoViewIfNeeded();
  await captureEvidence(page, "1440x960-ling-light-queued-actions.png");

  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toContainText("Cancelled");
  await expect(row.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expectRunGuidancePanelContract(page);
  runtime.expectOnly();
});

test("1280x800 Ling Dark contains shared Textarea focus through failure and retry with reduced motion", async ({ page }) => {
  await prepareSurface(page, { width: 1280, height: 800, theme: "dark", reducedMotion: true });
  const runtime = watchRuntime(page);
  const state = createRunsThreadsFixture();
  let failNextQueue = true;
  await installRunsThreadsFixture(page, state);
  await page.route(/\/runs\/run_ui2_failed\/interventions(?:\?|$)/u, async (route) => {
    const key = new URL(route.request().url()).searchParams.get("idempotencyKey");
    if (route.request().method() === "GET" && key) {
      await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", idempotencyKey: key,
        interventions: state.runInterventions.filter(item => item.sourceRunId === "run_ui2_failed" && item.idempotencyKey === key) } });
      return;
    }
    if (route.request().method() === "POST" && failNextQueue) {
      failNextQueue = false;
      await route.fulfill({ status: 400, json: { message: "Injected Run Guidance ownership failure" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const panel = await expectRunGuidancePanelContract(page);
  const textarea = panel.getByPlaceholder("Tell this run what to do next...");
  await textarea.fill("Retain this draft while the focused request fails, then retry it without changing geometry.");
  await expectSharedTextareaFocusContained(textarea, panel);
  await panel.getByRole("button", { name: "Queue guidance" }).click();
  await expect(panel).toContainText("Injected Run Guidance ownership failure");
  await expect(textarea).toHaveValue("Retain this draft while the focused request fails, then retry it without changing geometry.");
  await expectSharedTextareaFocusContained(textarea, panel);

  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const transitionDurations = await panel.locator(".ling-ui-inspector-section-chevron, .ling-ui-textarea")
    .evaluateAll((elements) => elements.flatMap((element) => getComputedStyle(element).transitionDuration.split(", ")));
  expect(transitionDurations.every((duration) => duration === "0s")).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectButtonHitAreas(panel, 2);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-failure-focus-reduced-motion.png");

  await panel.getByRole("button", { name: "Queue guidance" }).click();
  await expect(panel.locator(".runs-intervention-row")).toContainText("Queued");
  await expectRunGuidancePanelContract(page);
  runtime.expectOnly([expectedInjected400]);
});

test("1440x960 imported Quiet Ocean keeps long started guidance contained", async ({ page }) => {
  await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
  const runtime = watchRuntime(page);
  const state = createRunsThreadsFixture();
  await installRunsThreadsFixture(page, state);
  await page.route(/\/run-interventions\/([^/]+)\/promote(?:\?|$)/u, async (route) => {
    const interventionId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const intervention = state.runInterventions.find((item) => item.id === interventionId);
    if (!intervention) {
      await route.fulfill({ status: 404, json: { error: "run_intervention_not_found" } });
      return;
    }
    intervention.status = "started";
    intervention.updatedAt = "2026-07-24T00:00:00.000Z";
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", intervention } });
  });
  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await openMainRunHistory(page, "Failed provider repair run");

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  const panel = await expectRunGuidancePanelContract(page);
  await expectUsesSemanticToken(panel.locator(":scope > summary"), "color", "--ling-text-default");

  const longGuidance = Array.from(
    { length: 18 },
    (_, index) => `step ${index + 1} verifies long guidance remains readable inside the focused Run Detail panel`,
  ).join("; ");
  await panel.getByPlaceholder("Tell this run what to do next...").fill(longGuidance);
  await panel.getByRole("button", { name: "Queue guidance" }).click();
  const row = panel.locator(".runs-intervention-row").filter({ hasText: "step 1 verifies" });
  await expect(row).toContainText("Queued");
  await row.getByRole("button", { name: "Start handling" }).click();
  await expect(row).toContainText("Started");
  await expect(row.getByRole("button", { name: "Start handling" })).toHaveCount(0);
  await expectButtonHitAreas(panel, 3);
  await expectNoHorizontalOverflow(row);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await row.scrollIntoViewIfNeeded();
  await captureEvidence(page, "1440x960-quiet-ocean-started-long-guidance.png");
  runtime.expectOnly();
});

async function prepareSurface(page: Page, options: {
  readonly width: number;
  readonly height: number;
  readonly theme: "light" | "dark";
  readonly reducedMotion?: boolean;
}): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
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

async function expectRunGuidancePanelContract(page: Page): Promise<Locator> {
  const panels = page.locator(".run-guidance-panel");
  await expect(panels).toHaveCount(1);
  const panel = panels.first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveJSProperty("open", true);
  const style = await panel.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { display: computed.display, gap: computed.gap };
  });
  expect(style).toEqual({ display: "grid", gap: "10px" });
  await expect(panel.locator(legacyGuidanceSelector)).toHaveCount(0);
  await expect(panel.locator(".ling-ui-textarea[data-ling-control-native='true']")).toHaveCount(1);
  return panel;
}

async function expectSharedTextareaFocusContained(textarea: Locator, panel: Locator): Promise<void> {
  await expect(textarea).toHaveClass(/\bling-ui-textarea\b/u);
  await expect(textarea).toHaveAttribute("data-ling-control-native", "true");
  await textarea.scrollIntoViewIfNeeded();
  const before = await textarea.boundingBox();
  expect(before).not.toBeNull();
  await textarea.focus();
  await expect(textarea).toBeFocused();
  const geometry = await textarea.evaluate((element) => {
    const body = element.closest<HTMLElement>(".ling-ui-inspector-section-body");
    if (!body) throw new Error("Run Guidance shared Textarea body is missing");
    const controlBox = element.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      bodyBottom: bodyBox.bottom,
      bodyLeft: bodyBox.left,
      bodyRight: bodyBox.right,
      bodyTop: bodyBox.top,
      boxShadow: style.boxShadow,
      boxSizing: style.boxSizing,
      controlBottom: controlBox.bottom,
      controlHeight: controlBox.height,
      controlLeft: controlBox.left,
      controlRight: controlBox.right,
      controlTop: controlBox.top,
      controlWidth: controlBox.width,
      outlineStyle: style.outlineStyle,
    };
  });
  const after = await textarea.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(0.5);
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(0.5);
  expect(geometry.boxSizing).toBe("border-box");
  expect(geometry.outlineStyle).toBe("none");
  expect(geometry.boxShadow).toContain("inset");
  expect(geometry.controlTop).toBeGreaterThanOrEqual(geometry.bodyTop - 1);
  expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.bodyBottom + 1);
  expect(geometry.controlLeft).toBeGreaterThanOrEqual(geometry.bodyLeft - 1);
  expect(geometry.controlRight).toBeLessThanOrEqual(geometry.bodyRight + 1);
  expect(geometry.controlHeight).toBeGreaterThanOrEqual(88);
  expect(geometry.controlWidth).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(panel);
}

async function expectButtonHitAreas(panel: Locator, minimumCount: number): Promise<void> {
  const metrics = await panel.locator("button:visible").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { height: rect.height, label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "", width: rect.width };
  }));
  expect(metrics.length).toBeGreaterThanOrEqual(minimumCount);
  for (const metric of metrics) {
    expect(metric.width, `${metric.label} width`).toBeGreaterThanOrEqual(32);
    expect(metric.height, `${metric.label} height`).toBeGreaterThanOrEqual(32);
  }
}

async function expectUsesSemanticToken(
  locator: Locator,
  property: "color",
  token: "--ling-text-default",
): Promise<void> {
  await expect(locator).toBeVisible();
  const result = await locator.evaluate((element, input) => {
    const probe = document.createElement("span");
    probe.style.setProperty(input.property, `var(${input.token})`);
    document.body.append(probe);
    const actual = getComputedStyle(element).getPropertyValue(input.property);
    const expected = getComputedStyle(probe).getPropertyValue(input.property);
    probe.remove();
    return { actual, expected };
  }, { property, token });
  expect(result.actual).toBe(result.expected);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const geometry = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const measure = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? element.scrollWidth - element.clientWidth : 0;
    };
    return {
      detail: measure(".runs-detail-workspace"),
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: measure(".run-guidance-panel"),
    };
  });
  expect(metrics.detail).toBeLessThanOrEqual(1);
  expect(metrics.document).toBeLessThanOrEqual(1);
  expect(metrics.panel).toBeLessThanOrEqual(1);
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

function watchRuntime(page: Page): {
  readonly expectOnly: (allowedConsoleErrors?: readonly RegExp[]) => void;
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectOnly: (allowedConsoleErrors = []) => {
      const unexpectedConsoleErrors = consoleErrors.filter((message) => (
        !allowedConsoleErrors.some((pattern) => pattern.test(message))
      ));
      expect(unexpectedConsoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}
