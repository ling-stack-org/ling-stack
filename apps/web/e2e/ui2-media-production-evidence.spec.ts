import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { createDefaultProviderTemplates, createMediaProvider } from "./support/mock-state";
import {
  createEmptyMediaProductionFixture,
  createLoadedMediaProductionFixture,
  createMediaProductionRouteControl,
  installMediaProductionScenarioRoutes,
  type MediaProductionRouteControl,
} from "./support/media-production-fixtures";
import {
  analyzePngPixels,
  decodedPngPixelHash,
  pngDimensions,
  sha256,
  visualEffectChain,
  type PngPixelAnalysis,
} from "./support/media-production-pixel";

type EvidenceTheme = "ling-light" | "ling-dark";
type FunctionId =
  | "PROD-PROJECT-001"
  | "PROD-SCENE-001"
  | "PROD-TOOLBAR-001"
  | "PROD-CANVAS-001"
  | "PROD-INSPECTOR-001"
  | "PROD-WORKFLOW-001"
  | "PROD-RUN-001"
  | "PROD-PREVIEW-001"
  | "PROD-DELETE-001";

interface EvidenceCase {
  readonly functionId: FunctionId;
  readonly filename: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly theme: EvidenceTheme;
  readonly locale: "en-US" | "zh-CN";
  readonly fixture: string;
  readonly state: string;
}

interface BrowserSignals {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

interface ScenarioRuntime {
  readonly state: MockState;
  readonly control: MediaProductionRouteControl;
  readonly routeMode?: "preview-image" | "preview-error" | "preview-video";
}

interface RenderedScenario {
  readonly owner: Locator;
  readonly canvas?: Locator;
  readonly media?: Locator;
  readonly mediaPixelHash?: string;
}

const evidenceCaseSeeds = [
  { functionId: "PROD-PROJECT-001", filename: "1440x960-ling-light-project-loaded.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_loaded", state: "project-loaded" },
  { functionId: "PROD-PROJECT-001", filename: "1280x800-ling-light-project-retry.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_initial_error", state: "project-retry" },
  { functionId: "PROD-PROJECT-001", filename: "1440x960-ling-dark-project-delete.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_project_delete", state: "project-delete" },
  { functionId: "PROD-PROJECT-001", filename: "1280x800-ling-dark-project-loading.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_initial_delay", state: "project-loading" },
  { functionId: "PROD-SCENE-001", filename: "1440x960-ling-light-scene-long-tree.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_long_list", state: "scene-long-tree" },
  { functionId: "PROD-SCENE-001", filename: "1280x800-ling-light-scene-empty.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_scene_empty", state: "scene-empty" },
  { functionId: "PROD-SCENE-001", filename: "1440x960-ling-dark-scene-editing.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_scene_editing", state: "scene-editing" },
  { functionId: "PROD-SCENE-001", filename: "1280x800-ling-dark-scene-delete.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_scene_delete", state: "scene-delete" },
  { functionId: "PROD-TOOLBAR-001", filename: "1440x960-ling-light-toolbar-ready.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_toolbar_ready", state: "toolbar-ready" },
  { functionId: "PROD-TOOLBAR-001", filename: "1280x800-ling-light-toolbar-long.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_toolbar_long", state: "toolbar-long" },
  { functionId: "PROD-TOOLBAR-001", filename: "1440x960-ling-dark-toolbar-check.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_toolbar_check", state: "toolbar-check" },
  { functionId: "PROD-TOOLBAR-001", filename: "1280x800-ling-dark-toolbar-tasks.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_toolbar_tasks", state: "toolbar-tasks" },
  { functionId: "PROD-CANVAS-001", filename: "1440x960-ling-light-canvas-100-scenes.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_canvas_100", state: "canvas-100-scenes" },
  { functionId: "PROD-CANVAS-001", filename: "1280x800-ling-light-canvas-exclusive-dock.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_canvas_exclusive", state: "canvas-exclusive-dock" },
  { functionId: "PROD-CANVAS-001", filename: "1440x960-ling-dark-canvas-far-fit.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_canvas_far", state: "canvas-far-fit" },
  { functionId: "PROD-CANVAS-001", filename: "1280x800-ling-dark-canvas-reduced-motion.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_canvas_reduced_motion", state: "canvas-reduced-motion" },
  { functionId: "PROD-INSPECTOR-001", filename: "1440x960-ling-light-inspector-direct.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_inspector_direct", state: "inspector-direct" },
  { functionId: "PROD-INSPECTOR-001", filename: "1280x800-ling-light-inspector-blocked.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_inspector_blocked", state: "inspector-blocked" },
  { functionId: "PROD-INSPECTOR-001", filename: "1440x960-ling-dark-inspector-result.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_inspector_result", state: "inspector-result" },
  { functionId: "PROD-INSPECTOR-001", filename: "1280x800-ling-dark-inspector-history.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_inspector_history", state: "inspector-history" },
  { functionId: "PROD-WORKFLOW-001", filename: "1440x960-ling-light-workflow-empty.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_workflow_empty", state: "workflow-empty" },
  { functionId: "PROD-WORKFLOW-001", filename: "1280x800-ling-light-workflow-import.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_workflow_import", state: "workflow-import" },
  { functionId: "PROD-WORKFLOW-001", filename: "1440x960-ling-dark-workflow-connection-error.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_workflow_connection_error", state: "workflow-connection-error" },
  { functionId: "PROD-WORKFLOW-001", filename: "1280x800-ling-dark-workflow-test.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_workflow_test", state: "workflow-test" },
  { functionId: "PROD-RUN-001", filename: "1440x960-ling-light-run-review.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_run_review", state: "run-review" },
  { functionId: "PROD-RUN-001", filename: "1280x800-ling-light-run-approval.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_run_approval", state: "run-approval" },
  { functionId: "PROD-RUN-001", filename: "1440x960-ling-dark-run-regenerating.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_run_regenerating", state: "run-regenerating" },
  { functionId: "PROD-RUN-001", filename: "1280x800-ling-dark-run-failed.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_run_failed", state: "run-failed" },
  { functionId: "PROD-PREVIEW-001", filename: "1440x960-ling-light-preview-image.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_preview_image", state: "preview-image" },
  { functionId: "PROD-PREVIEW-001", filename: "1280x800-ling-light-preview-error.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_preview_error", state: "preview-error" },
  { functionId: "PROD-PREVIEW-001", filename: "1440x960-ling-dark-preview-video.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_preview_video", state: "preview-video" },
  { functionId: "PROD-PREVIEW-001", filename: "1280x800-ling-dark-preview-open-task.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_preview_open_task", state: "preview-open-task" },
  { functionId: "PROD-DELETE-001", filename: "1440x960-ling-light-delete-project.png", viewport: { width: 1440, height: 960 }, theme: "ling-light", fixture: "production_delete_project", state: "delete-project" },
  { functionId: "PROD-DELETE-001", filename: "1280x800-ling-light-delete-scene.png", viewport: { width: 1280, height: 800 }, theme: "ling-light", fixture: "production_delete_scene", state: "delete-scene" },
  { functionId: "PROD-DELETE-001", filename: "1440x960-ling-dark-delete-failure.png", viewport: { width: 1440, height: 960 }, theme: "ling-dark", fixture: "production_delete_failure", state: "delete-failure" },
  { functionId: "PROD-DELETE-001", filename: "1280x800-ling-dark-delete-busy.png", viewport: { width: 1280, height: 800 }, theme: "ling-dark", fixture: "production_delete_busy", state: "delete-busy" },
] as const satisfies readonly Omit<EvidenceCase, "locale">[];

const evidenceCases: readonly EvidenceCase[] = evidenceCaseSeeds.map((scenario) => ({
  ...scenario,
  locale: scenario.theme === "ling-light" ? "en-US" : "zh-CN",
}));
assertLocaleCoverage(evidenceCases);

const evidenceDirectory = fileURLToPath(new URL("../../../docs/design/ui2.0升级/evidence/features/media-production/", import.meta.url));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
const sourceCommitOrWorktree = resolveSourceCommitOrWorktree();
const previewPixelCropInset = 8;

test.describe.configure({ mode: "serial" });

for (const scenario of evidenceCases) {
  test(`${scenario.functionId} ${scenario.filename}`, async ({ page }) => {
    const signals = collectBrowserSignals(page);
    await initializePage(page, scenario);
    const runtime = createScenarioRuntime(scenario.state);
    await prepareScenario(page, runtime, scenario);
    const rendered = await renderScenario(page, scenario, runtime);
    const measurements = await measureScenario(page, rendered);

    expect(measurements.documentOverflow).toBe(0);
    expect(measurements.ownerOverflow).toBe(0);
    expect(signals.consoleErrors).toEqual(expectedConsoleErrors(scenario));
    expect(signals.pageErrors).toEqual([]);

    if (captureEvidence) {
      await captureScenario(page, scenario, signals, measurements, rendered.mediaPixelHash ?? null);
    }
  });
}

async function initializePage(page: Page, scenario: EvidenceCase): Promise<void> {
  await page.setViewportSize(scenario.viewport);
  await page.emulateMedia({ reducedMotion: scenario.state === "canvas-reduced-motion" ? "reduce" : "no-preference" });
  await page.addInitScript(({ theme, locale }) => {
    const themeOverride = localStorage.getItem("ling-stack.evidenceThemeOverride");
    const resolvedTheme = themeOverride === "ling-light" || themeOverride === "ling-dark" ? themeOverride : theme;
    localStorage.clear();
    sessionStorage.clear();
    const selection = { mode: "fixed", themeId: resolvedTheme };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themePreference", resolvedTheme === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, { theme: scenario.theme, locale: scenario.locale });
}

function createScenarioRuntime(stateName: string): ScenarioRuntime {
  const control = createMediaProductionRouteControl();
  if (stateName === "project-loading") control.projectListDelayMs = 3_000;
  if (stateName === "project-retry") control.failNextProjectList = 2;

  if (stateName === "project-loading" || stateName === "project-retry") {
    return { state: createEmptyMediaProductionFixture(), control };
  }
  if (stateName === "project-loaded" || stateName === "project-delete" || stateName === "delete-project") {
    return { state: createLoadedMediaProductionFixture({ projectCount: 2, scenesPerProject: 3 }), control };
  }
  if (stateName === "scene-long-tree" || stateName === "canvas-100-scenes") {
    return { state: createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 100 }), control };
  }
  if (stateName === "scene-empty") {
    return { state: createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 0 }), control };
  }
  if (["scene-editing", "scene-delete", "delete-scene", "canvas-exclusive-dock", "canvas-reduced-motion"].includes(stateName)) {
    return { state: createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 3 }), control };
  }
  if (["toolbar-ready", "toolbar-long", "toolbar-check", "toolbar-tasks", "run-review"].includes(stateName)) {
    const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 3 });
    installVideoProvider(state);
    if (stateName === "toolbar-long") state.mediaProjects[0] = { ...state.mediaProjects[0]!, name: `Editorial ${"long-project-name-".repeat(24)}` };
    if (stateName === "toolbar-check") state.mediaScenes = state.mediaScenes.map((scene) => ({ ...scene, prompt: "" }));
    return { state, control };
  }
  if (stateName === "canvas-far-fit") {
    const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 100 });
    const farScene = state.mediaScenes[99]!;
    state.mediaScenes = state.mediaScenes.map((scene, index) => ({
      ...scene,
      sortOrder: 99 - index,
      title: scene.id === farScene.id ? `Far selected ${"long-title-".repeat(32)}` : scene.title,
      canvasPosition: scene.id === farScene.id ? { x: 48_000, y: -24_000 } : { x: 120 + index * 270, y: 120 + (index % 7) * 160 },
    }));
    return { state, control };
  }
  if (stateName === "inspector-direct") return { state: createInspectorFixture(false), control };
  if (stateName === "inspector-blocked") return { state: createInspectorFixture(true), control };
  if (["inspector-result", "inspector-history", "run-regenerating", "run-failed", "run-approval"].includes(stateName)) {
    return { state: createRunHistoryFixture(stateName), control };
  }
  if (["workflow-empty", "workflow-import", "workflow-connection-error", "workflow-test"].includes(stateName)) {
    return { state: createWorkflowFixture(stateName), control };
  }
  if (["preview-image", "preview-error", "preview-open-task"].includes(stateName)) {
    return {
      state: createPreviewFixture("image", stateName === "preview-open-task"),
      control,
      routeMode: stateName === "preview-error" ? "preview-error" : "preview-image",
    };
  }
  if (stateName === "preview-video") {
    return { state: createPreviewFixture("video", false), control, routeMode: "preview-video" };
  }
  if (stateName === "delete-failure") {
    control.failNextProjectDelete = 1;
    return { state: createLoadedMediaProductionFixture({ projectCount: 2, scenesPerProject: 2 }), control };
  }
  if (stateName === "delete-busy") {
    control.sceneDeleteDelayMs = 1_500;
    return { state: createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 }), control };
  }
  throw new Error(`No Media Production evidence fixture for ${stateName}`);
}

async function prepareScenario(page: Page, runtime: ScenarioRuntime, scenario: EvidenceCase): Promise<void> {
  await mockDaemon(page, runtime.state, { templates: createDefaultProviderTemplates() });
  await installMediaProductionScenarioRoutes(page, runtime.state, runtime.control);
  if (runtime.routeMode) {
    await page.route("http://127.0.0.1:17891/**", async (route) => handleEvidenceRoute(route, runtime.routeMode!));
    await page.route("**/artifacts/**/content**", async (route) => handleEvidenceRoute(route, runtime.routeMode!));
  }
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", scenario.theme);
  await expect(page.locator("html")).toHaveAttribute("lang", scenario.locale);
}

async function renderScenario(page: Page, scenario: EvidenceCase, runtime: ScenarioRuntime): Promise<RenderedScenario> {
  await openEvidenceMediaProduction(page);
  const pageOwner = page.locator(".media-production-page");

  switch (scenario.state) {
    case "project-loaded":
      await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 001");
      await expect(page.locator(".storyboard-scene-node")).toHaveCount(3);
      return { owner: pageOwner };
    case "project-retry": {
      const alert = page.getByRole("alert").filter({ hasText: /Could not load media projects|无法加载媒体项目/u });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole("button", { name: /^(Retry|重试)$/u })).toBeVisible();
      return { owner: alert };
    }
    case "project-loading":
      await expect(page.locator(".media-production-load-state")).toBeVisible();
      await expect(page.locator('[data-media-production-empty="authoritative"]')).toHaveCount(0);
      return { owner: pageOwner };
    case "project-delete":
    case "delete-project":
      return { owner: await openProjectDeleteDialog(page) };
    case "scene-long-tree":
      await expect(page.locator(".project-outline-scene")).toHaveCount(100);
      return { owner: pageOwner };
    case "scene-empty":
      await expect(page.locator(".storyboard-empty-canvas")).toBeVisible();
      await expect(page.locator(".storyboard-empty-canvas").getByRole("button", { name: /^(Add scene|添加场景)$/u })).toBeVisible();
      return { owner: pageOwner };
    case "scene-editing": {
      await openInspector(page);
      const input = page.locator(".scene-inspector").getByLabel(/^(Scene|场景) 1$/u);
      await input.fill("Editing scene title");
      await expect(input).toBeFocused();
      return { owner: pageOwner };
    }
    case "scene-delete":
    case "delete-scene":
      return { owner: await openSceneDeleteDialog(page) };
    case "toolbar-ready":
      await expect(page.locator(".media-production-primary-action")).toContainText(/Run|运行/u);
      return { owner: pageOwner };
    case "toolbar-long":
      await expect(page.locator(".media-production-project-trigger")).toHaveAttribute("title", /long-project-name/u);
      return { owner: pageOwner };
    case "toolbar-check":
      await expect(page.locator(".media-production-primary-action")).toHaveText(/^(Check|检查)$/u);
      return { owner: pageOwner };
    case "toolbar-tasks":
      await page.locator('.media-production-view-switcher [data-value="jobs"]').click();
      await expect(page.locator(".media-production-jobs-view")).toBeVisible();
      return { owner: pageOwner };
    case "canvas-100-scenes":
      await expect(page.locator(".storyboard-scene-node")).toHaveCount(100);
      return { owner: pageOwner, canvas: page.locator(".storyboard-canvas") };
    case "canvas-exclusive-dock":
      await page.locator(".project-outline-scene-main").first().click();
      await expect(page.locator(".media-production-canvas-stage")).toHaveAttribute("data-exclusive-docks", "true");
      await expect(page.locator(".media-production-dock-panel.right")).toHaveClass(/is-open/u);
      return { owner: pageOwner, canvas: page.locator(".storyboard-canvas") };
    case "canvas-far-fit":
      await page.locator(".project-outline-scene-main").first().click();
      await expect(page.locator(".storyboard-scene-node.selected")).toContainText("Far selected");
      return { owner: pageOwner, canvas: page.locator(".storyboard-canvas") };
    case "canvas-reduced-motion":
      await page.locator(".project-outline-scene-main").nth(1).click();
      await expect(page.locator(".storyboard-canvas")).toHaveAttribute("data-motion-duration", "0");
      await expect(page.locator(".react-flow__viewport")).toHaveCSS("transition-duration", "0s");
      return { owner: pageOwner, canvas: page.locator(".storyboard-canvas") };
    case "inspector-direct":
      await openInspector(page);
      await expect(page.locator(".scene-inspector").getByLabel(/^(Default video model|默认视频模型)$/u)).toBeVisible();
      return { owner: pageOwner };
    case "inspector-blocked":
      await openInspector(page);
      await expect(page.locator(".scene-inspector").getByRole("button", { name: /^(Configure video model|配置视频模型)$/u })).toBeVisible();
      return { owner: pageOwner };
    case "inspector-result":
    case "run-regenerating":
      await openInspector(page);
      await page.locator(".scene-inspector").getByRole("tab", { name: /^(Generated result|生成结果)$/u }).click();
      await expect(page.locator(".scene-result-view")).toHaveAttribute("data-result-state", "updating");
      return { owner: pageOwner };
    case "inspector-history":
      await openInspector(page);
      await page.locator(".scene-inspector").getByRole("tab", { name: /^(History|历史)/u }).click();
      await expect(page.locator(".scene-run-entry")).toHaveCount(4);
      return { owner: pageOwner };
    case "run-approval":
      await openInspector(page);
      await page.locator(".scene-inspector").getByRole("tab", { name: /^(History|历史)/u }).click();
      await expect(page.locator('[data-run-id="run_active"]')).toContainText(/Waiting for approval|等待审批/u);
      return { owner: pageOwner };
    case "run-failed":
      await openInspector(page);
      await page.locator(".scene-inspector").getByRole("tab", { name: /^(Generated result|生成结果)$/u }).click();
      await expect(page.locator(".scene-latest-run-issue")).toBeVisible();
      await page.locator(".scene-latest-run-issue .ling-ui-inspector-section-trigger").click();
      return { owner: pageOwner };
    case "workflow-empty": {
      const dialog = await openWorkflowDialog(page);
      await expect(dialog.getByText(/Import your first production workflow|导入第一个生产流程/u)).toBeVisible();
      return { owner: dialog };
    }
    case "workflow-import": {
      const dialog = await openWorkflowDialog(page);
      const chooser = page.waitForEvent("filechooser");
      await dialog.getByRole("button", { name: /^(Import workflow|导入流程)$/u }).first().click();
      await (await chooser).setFiles(validWorkflowFile());
      await expect(dialog.locator(".media-workflow-import-editor")).toBeVisible();
      return { owner: dialog };
    }
    case "workflow-connection-error": {
      const dialog = await openWorkflowDialog(page);
      await dialog.getByRole("tab", { name: /^(Connections|连接)$/u }).click();
      await dialog.getByRole("option", { name: /Evidence connection/u }).click();
      await expect(dialog.locator(".media-workflow-detail-pane .ling-ui-status-indicator")).toContainText(/Needs attention|需要关注/u);
      return { owner: dialog };
    }
    case "workflow-test": {
      const dialog = await openWorkflowDialog(page);
      await expect(dialog.getByText(/Test (queued|running)|测试已排队|测试中/u)).toBeVisible();
      return { owner: dialog };
    }
    case "run-review": {
      await page.locator(".media-production-primary-action").click();
      const dialog = page.locator('[data-media-production-dialog="project-run-review"]');
      await expect(dialog.locator('[data-project-run-ready-count="3"]')).toBeVisible();
      return { owner: dialog };
    }
    case "preview-image": {
      const image = await openPreview(page, "image");
      const mediaPixelHash = await assertImageThemeInvariant(page, scenario.theme, image);
      const finalImage = page.locator('[data-media-production-dialog="scene-result-preview"] img');
      return { owner: page.locator('[data-media-production-dialog="scene-result-preview"]'), media: finalImage, mediaPixelHash };
    }
    case "preview-error": {
      await page.getByRole("button", { name: /^(Preview|预览)[:：]/u }).click();
      const dialog = page.locator('[data-media-production-dialog="scene-result-preview"]');
      await expect(dialog.locator('[data-media-preview-state="error"]')).toBeVisible();
      return { owner: dialog };
    }
    case "preview-video": {
      const video = await openPreview(page, "video");
      await expect(video).toHaveJSProperty("autoplay", true);
      await expect(video).toHaveJSProperty("muted", true);
      await expect(video).toHaveJSProperty("controls", true);
      await expect.poll(() => video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return media.currentTime > 0 || media.ended;
      })).toBe(true);
      return { owner: page.locator('[data-media-production-dialog="scene-result-preview"]'), media: video };
    }
    case "preview-open-task": {
      const image = await openPreview(page, "image");
      await assertNeutralEffectChain(image);
      const mediaPixelHash = decodedPngPixelHash(await image.screenshot({ animations: "disabled", caret: "hide" }), 1);
      const dialog = page.locator('[data-media-production-dialog="scene-result-preview"]');
      await dialog.getByRole("button", { name: /^(Open task|打开任务)$/u }).click();
      await expect(page.locator('[data-media-job-row="job_preview"]')).toHaveAttribute("data-selected", "true");
      return { owner: page.locator(".media-production-jobs-view"), mediaPixelHash };
    }
    case "delete-failure": {
      const dialog = await openProjectDeleteDialog(page);
      await dialog.getByRole("button", { name: /^(Delete project|删除项目)$/u }).click();
      await expect(dialog.getByRole("alert")).toContainText(/Could not delete this media project|无法删除此媒体项目/u);
      return { owner: dialog };
    }
    case "delete-busy": {
      const dialog = await openSceneDeleteDialog(page);
      await dialog.getByRole("button", { name: /^(Delete scene|删除场景)$/u }).click();
      await expect(dialog).toHaveAttribute("data-busy", "true");
      return { owner: dialog };
    }
    default:
      throw new Error(`No Media Production evidence action for ${scenario.state}`);
  }
}

async function measureScenario(page: Page, rendered: RenderedScenario): Promise<{
  readonly documentOverflow: number;
  readonly ownerOverflow: number;
  readonly canvasPixel: PngPixelAnalysis | null;
}> {
  await page.waitForTimeout(50);
  const documentOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  const ownerOverflow = await rendered.owner.evaluate((element) => Math.max(0, element.scrollWidth - element.clientWidth));
  if (ownerOverflow > 0) {
    const overflowSources = await rendered.owner.evaluate((owner) => {
      const ownerBox = owner.getBoundingClientRect();
      return Array.from(owner.querySelectorAll<HTMLElement>("*"))
        .map((element) => {
          const box = element.getBoundingClientRect();
          const styles = getComputedStyle(element);
          return {
            className: element.className,
            clientWidth: element.clientWidth,
            display: styles.display,
            hidden: element.hidden,
            parentClassName: element.parentElement?.className ?? "",
            rightOverflow: Math.round(box.right - ownerBox.right),
            scrollWidth: element.scrollWidth,
            tagName: element.tagName,
            type: element instanceof HTMLInputElement ? element.type : "",
          };
        })
        .filter((entry) => entry.scrollWidth > entry.clientWidth + 1 || entry.rightOverflow > 1)
        .sort((left, right) => Math.max(right.scrollWidth - right.clientWidth, right.rightOverflow) - Math.max(left.scrollWidth - left.clientWidth, left.rightOverflow))
        .slice(0, 12);
    });
    console.log("media-production evidence overflow", JSON.stringify(overflowSources));
  }
  let canvasPixel: PngPixelAnalysis | null = null;
  if (rendered.canvas) {
    const canvasBuffer = await rendered.canvas.screenshot({ animations: "disabled", caret: "hide" });
    canvasPixel = analyzePngPixels(canvasBuffer);
    expect(canvasPixel.width).toBeGreaterThan(0);
    expect(canvasPixel.height).toBeGreaterThan(0);
    expect(canvasPixel.opaqueRatio).toBeGreaterThan(0.95);
    expect(canvasPixel.uniqueColors).toBeGreaterThanOrEqual(16);
    expect(canvasPixel.nonDominantRatio).toBeGreaterThanOrEqual(0.02);
  }
  if (rendered.media) await assertNeutralEffectChain(rendered.media);
  return { documentOverflow, ownerOverflow, canvasPixel };
}

async function captureScenario(
  page: Page,
  scenario: EvidenceCase,
  signals: BrowserSignals,
  measurements: { readonly documentOverflow: number; readonly ownerOverflow: number; readonly canvasPixel: PngPixelAnalysis | null },
  mediaPixelHash: string | null,
): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  const buffer = await page.screenshot({ animations: "disabled", caret: "hide" });
  expect(pngDimensions(buffer)).toEqual(scenario.viewport);
  const sidecar = {
    filename: scenario.filename,
    capturedAt: new Date().toISOString(),
    viewport: scenario.viewport,
    theme: scenario.theme,
    locale: await page.evaluate(() => document.documentElement.lang || "en-US"),
    fixture: scenario.fixture,
    state: scenario.state,
    functionIds: [scenario.functionId],
    sourceCommitOrWorktree: sourceCommitOrWorktree,
    consoleErrors: signals.consoleErrors.filter((message) => !expectedConsoleErrors(scenario).includes(message)),
    expectedConsoleErrors: expectedConsoleErrors(scenario),
    pageErrors: signals.pageErrors,
    documentOverflow: measurements.documentOverflow,
    ownerOverflow: measurements.ownerOverflow,
    canvasPixel: measurements.canvasPixel,
    mediaPixelHash,
    sha256: sha256(buffer),
  };
  await writeFile(`${evidenceDirectory}/${scenario.filename}`, buffer);
  await writeFile(`${evidenceDirectory}/${scenario.filename}.json`, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
}

async function handleEvidenceRoute(
  route: Route,
  mode: NonNullable<ScenarioRuntime["routeMode"]>,
): Promise<void> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (mode === "delete-failure" && request.method() === "DELETE" && /^\/media-projects\/[^/]+$/u.test(path)) {
    await route.fulfill({ status: 503, json: { error: "fixture_delete_failed" } });
    return;
  }
  if (mode === "delete-busy" && request.method() === "DELETE" && /^\/media-scenes\/[^/]+$/u.test(path)) {
    await delay(1_500);
    await route.fallback();
    return;
  }
  if (request.method() === "GET" && path === "/artifacts/artifact_preview/content") {
    if (mode === "preview-error") {
      await route.fulfill({ status: 200, contentType: "image/png", body: "not-an-image" });
      return;
    }
    if (mode === "preview-video") {
      await route.fulfill({ contentType: "video/webm", body: Buffer.from(deterministicWebmBase64, "base64") });
      return;
    }
    if (mode === "preview-image") {
      await route.fulfill({ contentType: "image/png", body: Buffer.from(deterministicOpaquePngBase64, "base64") });
      return;
    }
  }
  await route.fallback();
}

async function openEvidenceMediaProduction(page: Page): Promise<void> {
  await page
    .getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: /^(Media Production|媒体生产)$/u })
    .click();
}

async function openInspector(page: Page): Promise<void> {
  await expect(page.locator(".storyboard-scene-node").first()).toBeVisible();
  await page.locator(".storyboard-scene-node").first().click();
  await expect(page.locator(".media-production-dock-panel.right")).toHaveClass(/is-open/u);
}

async function openProjectDeleteDialog(page: Page): Promise<Locator> {
  await page.locator("details.project-outline-settings > summary").click();
  await page.getByRole("button", { name: /^(Delete project|删除项目)$/u }).click();
  const dialog = page.locator('[data-media-production-dialog="delete-project"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openSceneDeleteDialog(page: Page): Promise<Locator> {
  await page.locator(".project-outline-scene").first().getByRole("button", { name: /^(Delete scene|删除场景)$/u }).click();
  const dialog = page.locator('[data-media-production-dialog="delete-scene"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openWorkflowDialog(page: Page): Promise<Locator> {
  await page.locator(".project-outline-workflow-entry").click();
  const dialog = page.locator('[data-media-production-dialog="workflow-library"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openPreview(page: Page, kind: "image" | "video"): Promise<Locator> {
  await page.getByRole("button", { name: /^(Preview|预览)[:：]/u }).click();
  const dialog = page.locator('[data-media-production-dialog="scene-result-preview"]');
  await expect(dialog).toBeVisible();
  await waitForPreviewDialogMotion(dialog);
  const media = dialog.locator(kind === "image" ? "img" : "video");
  await expect(media).toBeVisible();
  await expect(media.locator("xpath=..")).toHaveAttribute("data-media-preview-state", "ready");
  return media;
}

async function assertImageThemeInvariant(page: Page, theme: EvidenceTheme, initialImage: Locator): Promise<string> {
  const initialEffects = await assertNeutralEffectChain(initialImage);
  const initialGeometry = await mediaGeometry(initialImage);
  const initialScreenshot = await initialImage.screenshot({ animations: "disabled", caret: "hide" });
  const initialHash = decodedPngPixelHash(initialScreenshot, previewPixelCropInset);
  const alternateTheme: EvidenceTheme = theme === "ling-light" ? "ling-dark" : "ling-light";
  await setThemeAndReload(page, alternateTheme);
  await openEvidenceMediaProduction(page);
  const alternateImage = await openPreview(page, "image");
  const alternateEffects = await assertNeutralEffectChain(alternateImage);
  const alternateScreenshot = await alternateImage.screenshot({ animations: "disabled", caret: "hide" });
  expect(await mediaGeometry(alternateImage)).toEqual(initialGeometry);
  expect(alternateEffects).toEqual(initialEffects);
  expect(pngDimensions(alternateScreenshot)).toEqual(pngDimensions(initialScreenshot));
  expect(decodedPngPixelHash(alternateScreenshot, previewPixelCropInset)).toBe(initialHash);
  await setThemeAndReload(page, theme);
  await openEvidenceMediaProduction(page);
  const restoredImage = await openPreview(page, "image");
  expect(decodedPngPixelHash(await restoredImage.screenshot({ animations: "disabled", caret: "hide" }), previewPixelCropInset)).toBe(initialHash);
  return initialHash;
}

async function setThemeAndReload(page: Page, theme: EvidenceTheme): Promise<void> {
  await page.evaluate((themeId) => {
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.evidenceThemeOverride", themeId);
    localStorage.setItem("ling-stack.themePreference", themeId === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
}

async function assertNeutralEffectChain(media: Locator) {
  await waitForPreviewDialogMotion(media.locator('xpath=ancestor::*[@data-media-production-dialog="scene-result-preview"][1]'));
  const chain = await visualEffectChain(media);
  expect(chain.length).toBeGreaterThan(1);
  expect(chain.filter((item) => item.filter !== "none" || item.opacity !== "1" || item.mixBlendMode !== "normal")).toEqual([]);
  return chain;
}

async function mediaGeometry(media: Locator): Promise<{ readonly width: number; readonly height: number; readonly x: number; readonly y: number }> {
  return media.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, x: box.x, y: box.y };
  });
}

async function waitForPreviewDialogMotion(dialog: Locator): Promise<void> {
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  await expect(dialog).toHaveCSS("opacity", "1");
}

function createInspectorFixture(blocked: boolean): MockState {
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 });
  installVideoProvider(state);
  state.mediaProjects[0] = {
    ...state.mediaProjects[0]!,
    name: "Inspector project",
    defaultProviderPresetId: blocked ? undefined : "provider_preview_video",
  };
  if (blocked) state.mediaScenes[0] = { ...state.mediaScenes[0]!, providerPresetId: "provider_removed" };
  return state;
}

function createRunHistoryFixture(stateName: string): MockState {
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 });
  installVideoProvider(state);
  state.mediaProjects[0] = { ...state.mediaProjects[0]!, name: "Run history project", defaultProviderPresetId: "provider_preview_video" };
  state.mediaScenes[0] = { ...state.mediaScenes[0]!, id: "scene_run", projectId: state.mediaProjects[0]!.id, title: "Run history scene", prompt: "A composed studio shot", selectedMediaSceneRunId: "run_current" };
  const activeStatus = stateName === "run-approval" ? "waiting_for_approval" : "running";
  state.mediaSceneRuns = [
    sceneRun("run_active", "job_active", "2026-07-23T03:00:00.000Z", state.mediaProjects[0]!.id),
    sceneRun("run_candidate", "job_candidate", "2026-07-23T02:00:00.000Z", state.mediaProjects[0]!.id),
    sceneRun("run_current", "job_current", "2026-07-23T01:00:00.000Z", state.mediaProjects[0]!.id),
    sceneRun("run_failed", "job_failed", "2026-07-23T00:00:00.000Z", state.mediaProjects[0]!.id),
  ];
  state.mediaJobs = [
    mediaJob("job_active", stateName === "run-failed" ? "failed" : activeStatus, "2026-07-23T03:00:00.000Z", stateName === "run-failed" ? "Provider rejected regeneration" : undefined),
    mediaJob("job_candidate", "succeeded", "2026-07-23T02:00:00.000Z", undefined, ["artifact_candidate"]),
    mediaJob("job_current", "succeeded", "2026-07-23T01:00:00.000Z", undefined, ["artifact_current"]),
    mediaJob("job_failed", "failed", "2026-07-23T00:00:00.000Z", "Provider rejected the previous request"),
  ];
  state.artifactsByMediaJob.job_candidate = [imageArtifact("artifact_candidate", "job_candidate")];
  state.artifactsByMediaJob.job_current = [imageArtifact("artifact_current", "job_current")];
  return state;
}

function createWorkflowFixture(stateName: string): MockState {
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 });
  const connection = workflowConnection(stateName === "workflow-connection-error");
  state.mediaWorkflowConnections = [connection];
  if (stateName === "workflow-empty" || stateName === "workflow-import" || stateName === "workflow-connection-error") {
    state.mediaWorkflows = [];
    return state;
  }
  const detail = workflowDetail();
  const version = (detail as { versions: Array<Record<string, unknown>> }).versions[0]!;
  version.testMediaJobId = "job_workflow_test";
  state.mediaWorkflows = [detail];
  state.mediaJobs = [mediaJob("job_workflow_test", "queued", "2026-07-23T04:00:00.000Z")];
  return state;
}

function createPreviewFixture(type: "image" | "video", workflow: boolean): MockState {
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 });
  installVideoProvider(state);
  state.mediaProjects[0] = { ...state.mediaProjects[0]!, id: "project_preview", name: "Preview project", defaultProviderPresetId: "provider_preview_video" };
  state.mediaScenes[0] = { ...state.mediaScenes[0]!, id: "scene_preview", projectId: "project_preview", title: "Preview scene", selectedMediaSceneRunId: "run_preview" };
  state.mediaSceneRuns = [{
    id: "run_preview",
    projectId: "project_preview",
    sceneId: "scene_preview",
    mediaJobId: "job_preview",
    providerSnapshot: workflow ? {} : { providerPresetId: "provider_preview_video" },
    executionSnapshot: workflow
      ? { kind: "workflow", workflowDefinitionId: "editorial_workflow", workflowName: "Editorial workflow" }
      : { kind: "provider", providerPresetId: "provider_preview_video" },
    inputSnapshot: { prompt: "Preview prompt" },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }];
  state.mediaJobs = [{
    ...mediaJob("job_preview", "succeeded", "2026-07-23T00:00:00.000Z", undefined, ["artifact_preview"]),
    workflowVersionId: workflow ? "editorial_workflow_v1" : undefined,
    executionSource: workflow
      ? { kind: "workflow", workflowVersionId: "editorial_workflow_v1" }
      : { kind: "provider", providerPresetId: "provider_preview_video" },
  }];
  state.artifactsByMediaJob.job_preview = [{
    id: "artifact_preview",
    mediaJobId: "job_preview",
    type,
    path: type === "video" ? "artifact_preview.webm" : "artifact_preview.png",
    title: "Preview artifact",
    contentType: type === "video" ? "video/webm" : "image/png",
    sizeBytes: 4096,
    createdAt: "2026-07-23T00:00:00.000Z",
  }];
  if (workflow) {
    state.mediaWorkflowConnections = [workflowConnection(false)];
    state.mediaWorkflows = [workflowDetail(true)];
  }
  return state;
}

function installVideoProvider(state: MockState): void {
  state.providers = [createMediaProvider({
    id: "provider_preview_video",
    kind: "seedance",
    displayName: "Preview video model",
    providerId: "seedance",
    model: "seedance-ui2",
    apiKeyRef: "env:UI2_VIDEO_KEY",
    capabilities: ["video_generate"],
    input: ["text", "image"],
    compat: { mediaVendorTransport: { mode: "live" } },
  })];
  if (state.mediaProjects[0]) state.mediaProjects[0] = { ...state.mediaProjects[0], defaultProviderPresetId: "provider_preview_video" };
}

function workflowConnection(failed: boolean): Record<string, unknown> {
  return {
    id: "evidence_connection",
    workspaceId: "workspace_default",
    name: "Evidence connection",
    adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
    authMode: "none",
    secretConfigured: false,
    networkPolicy: "trusted_private_network",
    protocolVariant: "auto",
    status: failed ? "error" : "ready",
    health: failed
      ? { ok: false, message: "Connection failed", checkedAt: "2026-07-23T00:00:00.000Z", protocolVariant: "jobs_v1" }
      : { ok: true, message: "Connected", checkedAt: "2026-07-23T00:00:00.000Z", protocolVariant: "jobs_v1" },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function workflowDetail(active = false): Record<string, unknown> {
  const version = {
    id: "editorial_workflow_v1",
    workflowDefinitionId: "editorial_workflow",
    version: 1,
    sourceFormat: "comfy_api_json",
    sourceDigest: "evidence-fixture",
    graphSnapshot: {},
    inputFields: [{ id: "prompt", label: "Prompt", kind: "text", semantic: "prompt", required: true, nodeId: "1", inputName: "text", defaultValue: "Editorial scene" }],
    outputRules: [{ nodeId: "9", artifactType: "video", collect: "first" }],
    validation: { ok: true, errors: [], warnings: [], checkedAt: "2026-07-23T00:00:00.000Z" },
    createdAt: "2026-07-23T00:00:00.000Z",
  };
  return {
    definition: {
      id: "editorial_workflow",
      workspaceId: "workspace_default",
      connectionId: "evidence_connection",
      name: "Editorial workflow",
      description: "Editorial scene generation",
      status: active ? "ready" : "draft",
      currentVersionId: active ? version.id : undefined,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    },
    currentVersion: active ? version : undefined,
    versions: [version],
  };
}

function sceneRun(id: string, mediaJobId: string, createdAt: string, projectId: string): MockState["mediaSceneRuns"][number] {
  return { id, projectId, sceneId: "scene_run", mediaJobId, providerSnapshot: { providerPresetId: "provider_preview_video" }, executionSnapshot: { kind: "provider", providerPresetId: "provider_preview_video" }, inputSnapshot: { prompt: "A composed studio shot" }, createdAt, updatedAt: createdAt };
}

function mediaJob(
  id: string,
  status: MockState["mediaJobs"][number]["status"],
  createdAt: string,
  errorMessage?: string,
  artifactIds: string[] = [],
): MockState["mediaJobs"][number] {
  return { id, workspaceId: "workspace_default", providerPresetId: "provider_preview_video", executionSource: { kind: "provider", providerPresetId: "provider_preview_video" }, operation: "video_generate", prompt: "A composed studio shot", input: { ratio: "16:9", duration: 5 }, artifactIds, status, errorMessage, createdAt, updatedAt: createdAt };
}

function imageArtifact(id: string, mediaJobId: string): MockState["artifactsByMediaJob"][string][number] {
  return { id, mediaJobId, type: "image", path: `media/${id}.svg`, title: id, contentType: "image/svg+xml", sizeBytes: 4096, createdAt: "2026-07-23T00:00:00.000Z" };
}

function validWorkflowFile(): { readonly name: string; readonly mimeType: string; readonly buffer: Buffer } {
  return {
    name: "evidence-workflow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      "1": { class_type: "CLIPTextEncode", inputs: { text: "Scene" } },
      "9": { class_type: "SaveVideo", inputs: {} },
    })),
  };
}

function collectBrowserSignals(page: Page): BrowserSignals {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(`${message.type()}:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

function expectedConsoleErrors(scenario: EvidenceCase): readonly string[] {
  return scenario.state === "delete-failure"
    ? ["error:Failed to load resource: the server responded with a status of 500 (Internal Server Error)"]
    : [];
}

function assertLocaleCoverage(cases: readonly EvidenceCase[]): void {
  const enUsCount = cases.filter((scenario) => scenario.locale === "en-US").length;
  const zhCnCount = cases.filter((scenario) => scenario.locale === "zh-CN").length;
  if (enUsCount !== 18 || zhCnCount !== 18) {
    throw new Error(`Media Production evidence locale coverage must be en-US=18 and zh-CN=18, received en-US=${enUsCount}, zh-CN=${zhCnCount}`);
  }
}

function resolveSourceCommitOrWorktree(): string {
  try {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim();
    return dirty ? `${commit}+worktree` : commit;
  } catch {
    return "unknown-worktree";
  }
}

const deterministicOpaquePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAAACXBIWXMAAAABAAAAAQBPJcTWAAACYUlEQVR4nO3VsQkCURRFQQX7swMLMBBTKzBdDLYAO7C4zS3AROTDenSmgMdNDm+7LMsGaNqtPQD4nIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYcMC3p9vo07Bz3tMpyF3fGAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhLBPw/XpcewJ/5HCZ157wlkzAwCsBQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhLBPw4TKvPQG+TiZg4JWAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGHDAn5Mp1GngDf5wBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUPYE4Q3Dsm0191vAAAAAElFTkSuQmCC";
const deterministicWebmBase64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJAEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggIq7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiEBpAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYi1ApBVa4ZFmZyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDgkLCBILqBEpqBAlW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMHNz2mPAi2PFiLUCkFVrhkWZZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMjAwMDAwMDAwAB9DtnX654EAo6GBAACAgkmDQgAB8AEWADgkHBhKAAAwYAAAEN///VkVgACjk4EAKACGAECSnABQAAADIAAAQ0Cjk4EAUACGAECSnABO4AADIAAAQ0Cjk4EAeACGAECSnABQAAADIAAAQ0Cjk4EAoACGAECSnABNQAADIAAAQ0AcU7trkbuPs4EAt4r3gQHxggGr8IED";
