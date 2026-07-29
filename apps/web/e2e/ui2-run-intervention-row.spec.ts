import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
  openThreadsPage,
} from "./support/runs-threads-fixture";
import type { MockRunIntervention } from "./support/mock-daemon";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/run-intervention-row/",
  import.meta.url,
));
const sourceRunId = "run_ui2_failed";
const expectedInjected503 = /503 \(Service Unavailable\)/u;

test("1440x960 Ling Light separates queued guidance identity, status, copy and direct actions", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createRunsThreadsFixture();
  state.runInterventions = [interventionFixture({
    id: "intervention_ui2_short",
    instruction: "Inspect the selected repair path, then preserve the audit evidence.",
    status: "queued",
  })];
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const panel = page.locator(".run-guidance-panel");
  const row = panel.locator(".runs-intervention-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".ling-ui-data-row")).toHaveCount(0);
  await expect(row.locator(".runs-intervention-row-header")).toContainText("Queue guidance");
  await expect(row.locator(".runs-intervention-row-header")).toContainText("Queued");
  await expect(row.locator(".ling-ui-status-indicator-label")).toBeVisible();
  await expect(row.locator(".runs-intervention-row-instruction")).toHaveText(state.runInterventions[0].instruction);
  await expect(row.getByRole("button", { name: "Show details" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Start handling" })).toBeVisible();
  await expectButtonHitAreas(row, 2);
  await expectNoOverflow(page, row);
  await positionRowForEvidence(row);
  await captureEvidence(page, "1440x960-ling-light-queued-direct-actions.png");
  runtime.expectOnly();
});

test("1280x800 Ling Dark expands long guidance by keyboard and keeps promote failure scoped", async ({ page }) => {
  await prepareSurface(page, { height: 800, reducedMotion: true, theme: "dark", width: 1280 });
  const runtime = watchRuntime(page);
  const state = createRunsThreadsFixture();
  const longInstruction = Array.from(
    { length: 15 },
    (_, index) => `step ${index + 1} keeps long guidance readable without growing the default row`,
  ).join("; ");
  state.runInterventions = [interventionFixture({
    id: "intervention_ui2_long",
    instruction: longInstruction,
    status: "queued",
  })];
  let failNextPromote = true;
  await installRunsThreadsFixture(page, state);
  await page.route(/\/run-interventions\/intervention_ui2_long\/promote(?:\?|$)/u, async (route) => {
    if (failNextPromote) {
      failNextPromote = false;
      await route.fulfill({ status: 503, json: { message: "Injected intervention promote failure" } });
      return;
    }
    state.runInterventions[0].status = "started";
    state.runInterventions[0].continuationRunId = "run_ui2_continuation_after_retry";
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", intervention: state.runInterventions[0] } });
  });
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const row = page.locator(".runs-intervention-row");
  const copy = row.locator(".runs-intervention-row-instruction");
  const disclosure = row.getByRole("button", { name: "Show details" });
  await expect(copy).toHaveAttribute("data-collapsed", "true");
  const collapsedHeight = await copy.evaluate((element) => element.getBoundingClientRect().height);
  expect(await copy.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(row.getByRole("button", { name: "Hide details" })).toBeFocused();
  await expect(copy).not.toHaveAttribute("data-collapsed", "true");
  expect(await copy.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight);
  const expandedGeometry = await copy.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(expandedGeometry.overflowY).toBe("auto");
  expect(expandedGeometry.scrollHeight).toBeGreaterThan(expandedGeometry.clientHeight);

  await row.getByRole("button", { name: "Start handling" }).click();
  await expect(row).toContainText("Injected intervention promote failure");
  await expect(row.getByRole("button", { name: "Start handling" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expectNoOverflow(page, row);
  await positionRowForEvidence(row);
  await captureEvidence(page, "1280x800-ling-dark-long-expanded-failure.png");

  await row.getByRole("button", { name: "Start handling" }).click();
  await expect(row).toContainText("Started");
  await expect(row).toContainText("run_ui2_continuation_after_retry");
  await expect(row.getByRole("button", { name: "Start handling" })).toHaveCount(0);
  runtime.expectOnly([expectedInjected503]);
});

test("1440x960 Quiet Ocean gives Thread Evidence the same read-only intervention structure", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createRunsThreadsFixture();
  state.runInterventions = [
    interventionFixture({
      continuationRunId: "run_ui2_quiet_ocean_continuation_with_a_deliberately_long_identifier",
      id: "intervention_ui2_started",
      instruction: "Redirect completed and the authoritative continuation is now running.",
      mode: "interrupt_redirect",
      status: "started",
    }),
    interventionFixture({
      id: "intervention_ui2_failed",
      instruction: "The queued follow-up failed before a continuation was created.",
      status: "failed",
    }),
  ];
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await openThreadsPage(page);
  await page.locator(".runs-thread-list").getByRole("button", { name: /Main evidence lineage/ }).click();
  const detail = page.getByLabel("Thread detail");
  const evidence = detail.locator(".ling-ui-inspector-section").filter({ hasText: "Execution actions" });
  await evidence.locator(":scope > summary").click();

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  const rows = evidence.locator(".runs-intervention-row");
  await expect(rows).toHaveCount(2);
  const started = rows.filter({ hasText: "Redirect completed" });
  const failed = rows.filter({ hasText: "failed before" });
  await expect(started.locator(".runs-intervention-row-header")).toContainText("Stop and redirect");
  await expect(started).toContainText("Started");
  await expect(started.locator(".ling-ui-status-indicator-label")).toBeVisible();
  await started.getByRole("button", { name: "Show details" }).click();
  await expect(started).toContainText("run_ui2_quiet_ocean_continuation");
  await expect(failed).toContainText("Failed");
  await expect(rows.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(rows.getByRole("button", { name: "Start handling" })).toHaveCount(0);
  await expectUsesSemanticPanelToken(started);
  await expectNoOverflow(page, started);
  await expectNoOverflow(page, failed);
  await positionRowForEvidence(started);
  await captureEvidence(page, "1440x960-quiet-ocean-thread-read-only-states.png");
  runtime.expectOnly();
});

function interventionFixture(input: {
  readonly continuationRunId?: string;
  readonly id: string;
  readonly instruction: string;
  readonly mode?: MockRunIntervention["mode"];
  readonly status: MockRunIntervention["status"];
}): MockRunIntervention {
  return {
    continuationRunId: input.continuationRunId,
    createdAt: "2026-07-24T01:00:00.000Z",
    id: input.id,
    idempotencyKey: `ui2:${input.id}`,
    instruction: input.instruction,
    mode: input.mode ?? "queue_followup",
    requestedBy: "local-user",
    sourceRunId,
    status: input.status,
    updatedAt: "2026-07-24T01:01:00.000Z",
    workspaceId: "workspace_default",
  };
}

async function prepareSurface(page: Page, options: {
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly theme: "light" | "dark";
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

async function expectButtonHitAreas(row: Locator, minimumCount: number): Promise<void> {
  const metrics = await row.locator("button:visible").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { height: rect.height, label: button.textContent?.trim() ?? "", width: rect.width };
  }));
  expect(metrics.length).toBeGreaterThanOrEqual(minimumCount);
  for (const metric of metrics) {
    expect(metric.height, `${metric.label} height`).toBeGreaterThanOrEqual(32);
    expect(metric.width, `${metric.label} width`).toBeGreaterThanOrEqual(32);
  }
}

async function expectNoOverflow(page: Page, row: Locator): Promise<void> {
  const rowGeometry = await row.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(rowGeometry.scrollWidth).toBeLessThanOrEqual(rowGeometry.clientWidth + 1);
  const pageGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(pageGeometry.scrollWidth).toBeLessThanOrEqual(pageGeometry.clientWidth + 1);
}

async function expectUsesSemanticPanelToken(row: Locator): Promise<void> {
  const result = await row.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--ling-bg-panel)";
    document.body.append(probe);
    const actual = getComputedStyle(element).backgroundColor;
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual, expected };
  });
  expect(result.actual).toBe(result.expected);
}

async function positionRowForEvidence(row: Locator): Promise<void> {
  await row.evaluate((element) => {
    const container = element.closest<HTMLElement>(".runs-detail-sections");
    if (!container) throw new Error("Runs detail scroll owner is missing");
    const containerBox = container.getBoundingClientRect();
    const rowBox = element.getBoundingClientRect();
    container.scrollTop += rowBox.top - containerBox.top - 12;
  });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function watchRuntime(page: Page): { readonly expectOnly: (allowed?: readonly RegExp[]) => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectOnly: (allowed = []) => {
      expect(consoleErrors.filter((message) => !allowed.some((pattern) => pattern.test(message)))).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}
