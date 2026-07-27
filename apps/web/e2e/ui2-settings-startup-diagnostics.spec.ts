import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createVerboseRunEvents,
  type MockArtifact,
  type MockRun,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/startup-diagnostics/",
  import.meta.url,
));

test("Startup keeps initial loading stable and ready state quiet", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  const gate = deferred();
  let holdStatus = true;
  await page.route("**/startup/status?**", async (route) => {
    if (holdStatus) await gate.promise;
    await route.fallback();
  });

  await page.goto("/");
  const panel = await openStartupDiagnostics(page);
  await expect(panel.getByText("Loading startup status", { exact: true })).toBeVisible();
  await expect(panel.locator(".settings-startup-identity .ling-ui-skeleton")).toBeVisible();
  await expect(panel.locator(".startup-readiness-card, .startup-phase-row, .startup-empty")).toHaveCount(0);

  holdStatus = false;
  gate.resolve();
  await expect(panel.locator(".settings-startup-primary-state").getByText("Ready", { exact: true })).toBeVisible();
  await expect(panel.getByText("No startup diagnostics", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Refresh startup status" })).toHaveJSProperty("offsetWidth", 32);
  const technical = panel.locator("details").filter({ hasText: "Technical details" });
  await expect(technical).not.toHaveAttribute("open", "");
  await expect(panel.getByText("startup_e2e_ready", { exact: true })).toBeHidden();
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-startup-ready.png");
  expect(runtimeErrors).toEqual([]);
});

test("Startup blockers stay product-first while raw phase, code, and path remain folded", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  const longPath = `/tmp/${"nested-workspace-segment/".repeat(12)}provider.json`;
  state.startupStatus = {
    ...state.startupStatus,
    state: "degraded",
    phases: { ...state.startupStatus.phases, provider_warmup: "degraded", plugin_warmup: "failed" },
    diagnostics: [
      {
        level: "warning",
        code: "provider_warmup_delayed",
        message: "The configured model is taking longer than expected to become ready.",
        phase: "provider_warmup",
        path: longPath,
        nextAction: "Check the model in Model Workbench.",
        count: 2,
      },
      {
        level: "error",
        code: "plugin_warmup_failed",
        message: "One plugin could not finish startup checks.",
        phase: "plugin_warmup",
        nextAction: "Review the plugin status.",
      },
      {
        level: "info",
        code: "workspace_loaded",
        message: "Workspace configuration loaded.",
        phase: "workspace_store",
      },
    ],
  };
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openStartupDiagnostics(page);

  await expect(panel.locator(".settings-startup-primary-state").getByText("Degraded", { exact: true })).toBeVisible();
  const issues = panel.locator(".settings-startup-issues");
  await expect(issues.getByText("The configured model is taking longer than expected to become ready.")).toBeVisible();
  await expect(issues.getByText("Next step: Check the model in Model Workbench.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Check the model in Model Workbench." })).toHaveCount(0);
  await expect(panel.getByText("provider_warmup_delayed", { exact: true })).toBeHidden();
  await expect(panel.getByText(longPath, { exact: true })).toBeHidden();

  await panel.getByText("Technical details", { exact: true }).click();
  await expect(panel.getByText("provider_warmup_delayed", { exact: true })).toBeVisible();
  await expect(panel.getByText(longPath, { exact: true })).toBeVisible();
  await expect(panel.locator(".settings-startup-phase-row")).toHaveCount(10);
  await expectNoHorizontalOverflow(panel);
  await captureEvidence(page, "1440x960-ling-light-startup-blocker-details.png");
  expect(runtimeErrors).toEqual([]);
});

test("Startup refresh failure preserves the last snapshot as a Chinese dark stale state", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "zh-CN", 1280, 800, "reduce");
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.route("**/startup/refresh?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 503, json: { message: "模拟启动刷新失败" } });
  });
  await page.goto("/");
  const panel = await openStartupDiagnostics(page);
  await expect(panel.locator(".settings-startup-primary-state").getByText("就绪", { exact: true })).toBeVisible();

  const refresh = panel.getByRole("button", { name: "刷新启动状态" });
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(panel.getByRole("button", { name: "打开运行诊断" })).toBeEnabled();
  await expect(panel.getByText("启动状态可能已过期", { exact: true })).toBeVisible();
  await expect(panel.getByText("模拟启动刷新失败", { exact: true })).toBeHidden();
  await expect(panel.locator(".settings-startup-primary-state").getByText("就绪", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-startup-stale-zh-CN.png");
  await panel.getByText("错误详情", { exact: true }).click();
  await expect(panel.getByText("模拟启动刷新失败", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("Run Diagnostics selects detail without refreshing the list and projects events and artifacts", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  const runningRun = createRunningRun(state.runs[0]);
  state.runs = [runningRun, state.runs[0]];
  state.eventsByRun[runningRun.id] = createVerboseRunEvents(runningRun.id);
  state.artifactsByRun[runningRun.id] = createRunArtifacts(runningRun.id);
  await mockDaemon(page, state);
  let runListRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/runs") runListRequests += 1;
  });
  await page.goto("/");
  await openStartupDiagnostics(page);
  const diagnostics = await openRunDiagnostics(page);
  const countAfterOpen = runListRequests;

  await diagnostics.locator(".settings-run-row").filter({ hasText: "Build release" }).click();
  await expect(diagnostics.locator('[data-run-detail-id="run_running"]')).toBeVisible();
  await expect.poll(() => runListRequests).toBe(countAfterOpen);
  await expect(diagnostics.getByText("Events", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText(String(state.eventsByRun[runningRun.id].length), { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("Artifacts", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("2", { exact: true })).toBeVisible();
  await expect(diagnostics.locator(".settings-run-activity-row")).toHaveCount(6);
  await expect(diagnostics.getByText("Run completed", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("Approval requested", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("Artifact created", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("run_running", { exact: true })).toBeHidden();
  await expect(diagnostics.getByRole("button", { name: "Open full diagnostics in app" })).toBeVisible();
  await expect(diagnostics.locator(".secondary-button, .compact-button, .icon-button, .meta-row")).toHaveCount(0);
  await expectNoHorizontalOverflow(diagnostics);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-run-diagnostics-selected.png");

  await diagnostics.getByText("Raw run details", { exact: true }).click();
  await expect(diagnostics.getByText("run_running", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("Run Diagnostics distinguishes no-runs from a persistent folded load failure", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  await mockDaemon(page, state);
  let failRunList = false;
  await page.route("**/runs?**", async (route) => {
    if (failRunList) {
      await route.fulfill({ status: 503, json: { message: "Synthetic run list failure" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openStartupDiagnostics(page);
  const diagnostics = await openRunDiagnostics(page);
  await expect(diagnostics.getByText("No runs yet", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("Select a run to inspect diagnostics.", { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-run-diagnostics-empty.png");

  failRunList = true;
  await diagnostics.getByRole("button", { name: "Refresh run diagnostics" }).click();
  await expect(diagnostics.getByText("Run diagnostics are unavailable", { exact: true })).toBeVisible();
  await expect(diagnostics.getByText("Synthetic run list failure", { exact: true })).toBeHidden();
  await diagnostics.getByText("Error details", { exact: true }).click();
  await expect(diagnostics.getByText("Synthetic run list failure", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expectNoHorizontalOverflow(diagnostics);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-run-diagnostics-error-details.png");
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  locale: "en-US" | "zh-CN",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ initialLocale, initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", initialLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { initialLocale: locale, initialTheme: theme });
}

async function openStartupDiagnostics(page: Page): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Startup and diagnostics|启动与诊断/ }).click();
  const panel = page.locator("[data-ui2-settings-startup-diagnostics]");
  await expect(panel).toBeVisible();
  return panel;
}

async function openRunDiagnostics(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /Open Run Diagnostics|打开运行诊断/ }).click();
  const panel = page.locator("[data-ui2-settings-run-diagnostics]");
  await expect(panel).toBeVisible();
  await expect(page.getByLabel(/Settings sections|设置分组/)).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  return panel;
}

function createRunningRun(source: MockRun): MockRun {
  return {
    ...source,
    id: "run_running",
    status: "running",
    taskId: "task_build_release",
    taskSnapshot: { id: "task_build_release", title: "Build release" },
    errorMessage: undefined,
    eventLogPath: ".ling-stack/sessions/run_running.jsonl",
    createdAt: "2026-05-25T00:20:00.000Z",
    updatedAt: "2026-05-25T00:21:00.000Z",
  };
}

function createRunArtifacts(runId: string): MockArtifact[] {
  return [
    {
      id: "artifact_summary",
      runId,
      type: "markdown",
      path: `${runId}/summary.md`,
      title: "Summary",
      createdAt: "2026-05-25T00:21:00.000Z",
    },
    {
      id: "artifact_diff",
      runId,
      type: "diff",
      path: `${runId}/changes.diff`,
      title: "Changes",
      createdAt: "2026-05-25T00:21:02.000Z",
    },
  ];
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
