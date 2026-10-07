import { expect, test, type Page } from "@playwright/test";
import type { MockState } from "./support/mock-daemon";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createDefaultProviderTemplates } from "./support/mock-state";
import { isViteClientTransportError } from "./support/vite-client-console-error";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
});

test("media production creates an ordered storyboard and keeps canvas layout separate", async ({ page }) => {
  const state = createBaseState({});
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Media Production" }).click();
  await expect(page.getByRole("heading", { name: "Media Production", level: 1 })).toHaveCount(0);
  await expect(page.locator(".media-production-canvas-toolbar")).toContainText("Production studio");
  await page.locator(".media-production-empty-state").getByRole("button", { name: "New project" }).click();
  await expect(page.locator(".media-production-canvas-stage")).toBeVisible();
  await expect(page.locator(".project-scene-outline")).toBeVisible();
  const leftDock = page.locator(".media-production-dock-panel.left");
  await expect(leftDock).toHaveClass(/is-open/);
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Close projects and scenes" }).click();
  await expect(leftDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".project-scene-outline")).toBeHidden();
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  await expect(page.locator(".project-scene-outline")).toBeVisible();
  const projectSettings = page.locator("details.project-outline-settings");
  await expect(projectSettings).not.toHaveAttribute("open", "");
  await projectSettings.locator("summary").click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await projectSettings.locator("summary").click();
  await page.getByRole("button", { name: "Add scene" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(1);
  await expect(page.locator(".scene-inspector")).toBeVisible();
  const rightDock = page.locator(".media-production-dock-panel.right");
  await expect(rightDock).toHaveClass(/is-open/);
  await expect(page.locator(".media-production-canvas-stage")).toHaveAttribute("data-exclusive-docks", "true");
  await expect(leftDock).not.toHaveClass(/is-open/);
  const canvasDimensions = await page.locator(".storyboard-canvas").evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  await page.locator(".scene-inspector").getByRole("button", { name: "Close" }).click();
  await expect(rightDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".scene-inspector")).toBeHidden();
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  await expect(leftDock).toHaveClass(/is-open/);
  await expect(page.locator(".storyboard-canvas")).toHaveJSProperty("clientWidth", canvasDimensions.width);
  await expect(page.locator(".storyboard-canvas")).toHaveJSProperty("clientHeight", canvasDimensions.height);
  await page.locator(".project-outline-scene-main").click();
  await expect(leftDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".scene-inspector")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rightDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".scene-inspector")).toBeHidden();
  await page.locator(".media-production-dock-rail.right").getByRole("button", { name: "Expand" }).click();
  await expect(page.locator(".scene-inspector")).toBeVisible();
  const controls = page.locator(".react-flow__controls");
  await expect(controls).toHaveCount(1);
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".media-production-dock-panel.left.is-open")).toBe(false);
  await expect.poll(async () => {
    const [canvasBox, controlsBox] = await Promise.all([
      page.locator(".storyboard-canvas").boundingBox(),
      controls.boundingBox(),
    ]);
    return canvasBox && controlsBox ? Math.round(canvasBox.y + canvasBox.height - controlsBox.y - controlsBox.height) : 999;
  }).toBeLessThanOrEqual(20);
  const initialZoom = await storyboardZoom(page);
  await page.getByRole("button", { name: "Zoom In" }).click();
  await expect.poll(() => storyboardZoom(page)).toBeGreaterThan(initialZoom);
  await page.getByRole("button", { name: "Zoom Out" }).click();
  await expect.poll(() => storyboardZoom(page)).toBeLessThan(initialZoom * 1.1);
  await page.getByRole("button", { name: "Fit View" }).click();
  await expect.poll(() => storyboardZoom(page)).toBeLessThanOrEqual(1);

  await page.getByLabel("Prompt").fill("A quiet product reveal in a bright studio.");
  await page.getByLabel("Prompt").blur();
  await expect.poll(() => state.mediaScenes[0]?.prompt).toBe("A quiet product reveal in a bright studio.");
  const sceneSavedToast = page.locator('.ling-ui-toast[data-scope^="media-production:scene:"][data-scope$=":saved"]');
  await expect(sceneSavedToast).toContainText("Scene saved");
  await expect(page.locator(".media-production-canvas-toolbar")).not.toContainText("Saved");
  await expect(page.locator(".ling-ui-toast")).toHaveCount(0, { timeout: 4_500 });

  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(2);
  await expect(page.locator(".storyboard-sequence-edge .react-flow__edge-path")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".react-flow__controls")).toHaveCount(1);
  const miniMap = page.locator(".react-flow__minimap");
  await expect(miniMap).toHaveCount(0);
  await page.getByRole("button", { name: "Duplicate" }).click();
  await page.getByRole("button", { name: "Duplicate" }).click();
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(5);
  await expect(miniMap).toHaveCount(1);
  await expect(miniMap).toHaveCSS("border-top-width", "1px");
  await expect(miniMap.locator(".react-flow__minimap-node")).toHaveCount(5);
  const miniMapColors = await miniMap.evaluate((element) => {
    const svg = element.querySelector(".react-flow__minimap-svg");
    const mask = element.querySelector(".react-flow__minimap-mask");
    const node = element.querySelector(".react-flow__minimap-node");
    return {
      background: svg ? getComputedStyle(svg).backgroundColor : "",
      mask: mask ? getComputedStyle(mask).fill : "",
      node: node ? getComputedStyle(node).fill : "",
    };
  });
  expect(miniMapColors.mask).not.toBe(miniMapColors.background);
  expect(miniMapColors.node).not.toBe(miniMapColors.background);
  await expect.poll(() => elementsOverlap(page, ".react-flow__minimap", ".media-production-dock-panel.right.is-open")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".react-flow__minimap")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".storyboard-canvas-legend", ".react-flow__minimap")).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".react-flow__minimap")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".react-flow__minimap", ".media-production-dock-panel.right.is-open")).toBe(false);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".media-production-dock-panel.left.is-open")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".react-flow__minimap")).toBe(false);
  await expect.poll(async () => {
    const [canvasBox, controlsBox] = await Promise.all([
      page.locator(".storyboard-canvas").boundingBox(),
      controls.boundingBox(),
    ]);
    return canvasBox && controlsBox ? Math.round(canvasBox.y + canvasBox.height - controlsBox.y - controlsBox.height) : 999;
  }).toBeLessThanOrEqual(20);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(state.mediaScenes.map((scene) => scene.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  expect(state.mediaScenes[0]?.canvasPosition).not.toEqual(state.mediaScenes[1]?.canvasPosition);

  await page.locator(".scene-inspector").getByRole("button", { name: "Close" }).click();
  await panStoryboardAway(page);
  const repeatedSelectionTransform = await storyboardTransform(page);
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  await page.locator(".project-outline-scene-main").nth(1).click();
  await expect.poll(() => storyboardTransform(page)).not.toBe(repeatedSelectionTransform);
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);

  await page.locator(".scene-inspector").getByRole("button", { name: "Close" }).click();
  await panStoryboardAway(page);
  const changedSelectionTransform = await storyboardTransform(page);
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  await page.locator(".project-outline-scene-main").first().click();
  await expect.poll(() => storyboardTransform(page)).not.toBe(changedSelectionTransform);
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);

  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  await page.getByRole("button", { name: "Move scene down" }).first().click();
  await expect.poll(() => state.mediaScenes.map((scene) => scene.sortOrder)).toEqual([1, 0, 2, 3, 4]);
  const selectedOutlineScene = page.locator(".project-outline-scene.selected");
  await selectedOutlineScene.getByRole("button", { name: "Delete scene" }).click();
  const deleteDialog = page.locator('[role="dialog"][data-media-production-dialog="delete-scene"]');
  await expect(deleteDialog).toHaveCSS("position", "fixed");
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText("Permanent action");
  await deleteDialog.getByRole("button", { name: "Delete scene" }).click();
  await expect(page.locator(".project-outline-scene")).toHaveCount(4);
});

test("media production fits a distant storyboard after switching projects", async ({ page }) => {
  const state = createBaseState({});
  const timestamp = "2026-07-15T00:00:00.000Z";
  state.mediaProjects = [
    {
      id: "media_project_near",
      workspaceId: "workspace_default",
      name: "Near storyboard",
      defaultExecutionMode: "direct",
      canvasViewport: { x: 0, y: 0, zoom: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "media_project_far",
      workspaceId: "workspace_default",
      name: "Far storyboard",
      defaultExecutionMode: "direct",
      canvasViewport: { x: 0, y: 0, zoom: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  state.mediaScenes = [
    mockScene("media_scene_near", "media_project_near", { x: 80, y: 96 }, timestamp),
    mockScene("media_scene_far", "media_project_far", { x: 8_000, y: 6_000 }, timestamp),
  ];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Media Production" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(1);
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);
  await page.getByLabel("Media project").selectOption("media_project_far");
  await expect(page.locator(".storyboard-scene-node")).toContainText("media_scene_far");
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);
});

test("media production directs missing video setup to model workbench", async ({ page }) => {
  const state = createBaseState({});
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Media Production" }).click();
  await page.locator(".media-production-empty-state").getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: "Add scene" }).click();
  await expect(page.getByRole("button", { name: "Check", exact: true })).toHaveCount(0);
  await expect(page.locator(".media-production-primary-action")).toHaveAccessibleName("Configure video model");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await page.locator(".media-production-primary-action").click();
  const editor = page.getByRole("dialog", { name: "New video generation model" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Model supplier")).toHaveValue("seedance-video");
});

test("media production configures Seedance from the workbench before generating a scene", async ({ page }, testInfo) => {
  const state = createBaseState({});
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Media Production" }).click();
  await page.locator(".media-production-empty-state").getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.getByLabel("Prompt").fill("A controlled studio reveal of a compact camera.");
  await page.getByLabel("Prompt").blur();

  await page.locator(".media-production-primary-action").click();
  const editor = page.getByRole("dialog", { name: "New video generation model" });
  await expect(editor.getByLabel("Model supplier")).toHaveValue("seedance-video");
  await editor.getByLabel("API key", { exact: true }).fill("ark-media-key");
  await editor.getByRole("button", { name: "Fetch models" }).click();
  const seedanceCard = page.locator(".provider-model-card").filter({ hasText: "doubao-seedance-1-0-pro-250528" });
  await expect(seedanceCard).toBeVisible();
  await expect(page.locator(".provider-model-card")).toHaveCount(1);
  await seedanceCard.click();
  await expect(editor.getByRole("button", { name: "Import selected models (1)" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("06-video-model-configured.png"), fullPage: true });
  await editor.getByRole("button", { name: "Import selected models (1)" }).click();
  await expect(editor).toHaveCount(0);

  const seedanceRow = page.locator(".provider-row").filter({ hasText: "doubao-seedance-1-0-pro-250528" });
  await expect(seedanceRow).toBeVisible();
  await seedanceRow.getByRole("button", { name: "Check" }).click();

  await expect.poll(() => state.providers.find((provider) =>
    typeof provider === "object" && provider !== null && "model" in provider && provider.model === "doubao-seedance-1-0-pro-250528"
  )).toBeTruthy();
  const seedanceProvider = state.providers.find((provider): provider is { readonly id: string; readonly model: string } =>
    typeof provider === "object" && provider !== null && "id" in provider && typeof provider.id === "string" && "model" in provider && provider.model === "doubao-seedance-1-0-pro-250528"
  );
  if (!seedanceProvider) {
    throw new Error("Expected imported Seedance provider.");
  }
  await expect.poll(() => {
    const provider = state.providers.find((item) => typeof item === "object" && item !== null && "id" in item && item.id === seedanceProvider.id);
    return typeof provider === "object" && provider !== null && "lastCheck" in provider && provider.lastCheck && typeof provider.lastCheck === "object" && "ok" in provider.lastCheck
      ? provider.lastCheck.ok
      : false;
  }).toBe(true);
  const providerId = seedanceProvider.id;

  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Media Production" }).click();
  await page.locator(".storyboard-scene-node.selected").click();
  await page.locator(".scene-inspector").getByLabel("Default video model").selectOption(providerId);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");
  expect(state.approvals.some((approval) => approval.actionType === "media_cost" && approval.status === "pending")).toBe(false);
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBeTruthy();
  await page.getByRole("tab", { name: /^History/ }).click();
  await expect(page.locator(".scene-run-row.selected")).toContainText("Current");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await expect(page.locator(".storyboard-node-status")).toHaveText("Generated result");
  await expect(page.getByRole("button", { name: /^Preview:/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("07-video-scene-generated.png"), fullPage: true });
});

test("media production completes a configured Seedance storyboard flow", async ({ page }, testInfo) => {
  const state = createBaseState({});
  state.providers = [{
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance 视频",
    providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528",
    api: "media-job",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyRef: "env:SEEDANCE_API_KEY",
    apiKeyConfigured: true,
    headers: {},
    input: ["text"],
    compat: { mediaVendorTransport: { mode: "live" } },
    capabilities: ["video_generate"],
    enabled: true,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  }];
  await mockDaemon(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "媒体生产" }).click();
  await page.locator(".media-production-empty-state").getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加场景" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("01-storyboard-canvas.png"), fullPage: true });

  await page.getByRole("textbox", { name: "场景 1", exact: true }).fill("开场产品展示");
  await page.getByRole("textbox", { name: "场景 1", exact: true }).blur();
  await page.getByLabel("提示词").fill("晨光从产品表面掠过，镜头缓慢推进，干净的工业设计棚拍。 ");
  await page.getByLabel("提示词").blur();
  const inspector = page.locator(".scene-inspector");
  await inspector.getByLabel("默认视频模型").selectOption("provider_seedance");
  await expect(inspector.getByLabel("画面比例")).toHaveValue("16:9");
  await expect(inspector.getByLabel("视频时长")).toHaveValue("5");
  await expect(page.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("02-scene-configured.png"), fullPage: true });

  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBeTruthy();
  const firstSelectedRunId = state.mediaScenes[0]?.selectedMediaSceneRunId;
  const firstSelectedRun = state.mediaSceneRuns.find((run) => run.id === firstSelectedRunId);
  expect(firstSelectedRun).toBeTruthy();
  const firstArtifactId = state.artifactsByMediaJob[firstSelectedRun?.mediaJobId ?? ""]?.[0]?.id;
  expect(firstArtifactId).toBeTruthy();
  await page.getByRole("tab", { name: /^历史/ }).click();
  await expect(page.locator(".scene-run-row.selected")).toContainText("当前");
  await expect(page.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
  await expect(page.locator(".storyboard-node-status")).toHaveText("生成结果");
  await page.screenshot({ path: testInfo.outputPath("03-generation-complete.png"), fullPage: true });

  const previewButton = page.getByRole("button", { name: /^预览:/ });
  const runCountBeforePreview = state.mediaSceneRuns.length;
  await previewButton.click();
  const previewDialog = page.locator('[role="dialog"][data-media-production-dialog="scene-result-preview"]');
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.locator(`[data-media-preview-artifact="${firstArtifactId}"]`)).toHaveAttribute("data-media-preview-state", "error");
  await expect(previewDialog.getByText("预览不可用")).toBeVisible();
  await expect(previewDialog.getByRole("button", { name: "重试预览" })).toBeVisible();
  await expect(previewDialog.locator("video")).toHaveCount(0);
  expect(state.mediaSceneRuns).toHaveLength(runCountBeforePreview);
  expect(state.mediaScenes[0]?.selectedMediaSceneRunId).toBe(firstSelectedRunId);
  await page.keyboard.press("Escape");
  await expect(previewDialog).toHaveCount(0);
  await expect(page.locator(".media-production-dock-panel.right")).toHaveClass(/is-open/);

  await previewButton.click();
  await page.locator(".scene-result-preview-overlay").click({ position: { x: 5, y: 5 } });
  await expect(previewDialog).toHaveCount(0);
  await previewButton.click();
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();
  await expect(previewDialog).toHaveCount(0);

  await page.getByRole("button", { name: "检查", exact: true }).click();
  const generatedReview = page.locator('[role="dialog"][data-media-production-dialog="project-run-review"]');
  await expect(generatedReview.locator('[data-project-run-ready-count="0"]')).toBeVisible();
  await expect(generatedReview.locator('[data-project-run-skipped-count="1"]')).toBeVisible();
  await generatedReview.getByRole("button", { name: "关闭" }).last().click();

  state.mediaJobRunDelayMs = -1;
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.locator(".storyboard-node-status")).toHaveText("已生成 · 正在更新");
  await expect(page.locator(".scene-inspector-footer").getByRole("button")).toBeDisabled();
  await expect(previewButton).toBeVisible();
  await previewButton.click();
  await expect(previewDialog.locator(`[data-media-preview-artifact="${firstArtifactId}"]`)).toHaveAttribute("data-media-preview-state", "error");
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();

  const runningEntry = page.locator('.scene-run-entry[data-run-state="running"]').first();
  await runningEntry.getByRole("button", { name: "取消" }).click();
  await expect(page.locator('.scene-run-entry[data-run-state="cancelled"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeEnabled();

  state.mediaJobRunDelayMs = 80;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator('.scene-run-entry[data-run-state="running"]')).toHaveCount(1);
  await expect(page.locator('.scene-run-entry[data-run-state="cancelled"]')).toHaveCount(1);
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");

  await expect(page.getByRole("button", { name: "设为默认" })).toBeVisible();
  await expect(page.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
  expect(state.mediaScenes[0]?.selectedMediaSceneRunId).toBe(firstSelectedRunId);
  await previewButton.click();
  await expect(previewDialog.locator(`[data-media-preview-artifact="${firstArtifactId}"]`)).toHaveAttribute("data-media-preview-state", "error");
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();

  const latestSceneRunId = state.mediaSceneRuns[0]?.id;
  expect(latestSceneRunId).toBeTruthy();
  await page.getByRole("button", { name: "设为默认" }).click();
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBe(latestSceneRunId);
  const latestArtifactId = state.artifactsByMediaJob[state.mediaSceneRuns[0]?.mediaJobId ?? ""]?.[0]?.id;
  expect(latestArtifactId).toBeTruthy();
  await previewButton.click();
  await expect(previewDialog.locator(`[data-media-preview-artifact="${latestArtifactId}"]`)).toHaveAttribute("data-media-preview-state", "error");
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();
  await page.screenshot({ path: testInfo.outputPath("04-selected-result.png"), fullPage: true });

  await page.getByRole("radio", { name: "生成任务" }).click();
  await expect(page.locator("[data-media-jobs-header]")).toBeVisible();
  await expect(page.locator('[data-media-job-row][data-product-state="completed"]')).toHaveCount(2);
  await expect(page.locator('[data-media-job-row][data-product-state="completed"]').first()).toContainText(state.mediaProjects[0]?.name ?? "");
  await expect(page.locator('[data-media-job-row][data-product-state="completed"]').first()).toContainText("开场产品展示");
  await expect(page.locator("[data-media-job-inspector]")).toContainText("晨光从产品表面掠过");
  await expect(page.locator(`[data-media-job-inspector] [data-media-preview-artifact="${firstArtifactId}"][data-media-preview-mode="hero"]`)).toHaveAttribute("data-media-preview-state", "error");
  await page.screenshot({ path: testInfo.outputPath("05-generation-task-history.png"), fullPage: true });
});

test("media production reviews only ready scenes before ordered generation", async ({ page }) => {
  const state = createBaseState({});
  state.providers = [{
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance 视频",
    providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528",
    api: "media-job",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyRef: "env:SEEDANCE_API_KEY",
    apiKeyConfigured: true,
    headers: {},
    input: ["text"],
    compat: { mediaVendorTransport: { mode: "live" } },
    capabilities: ["video_generate"],
    enabled: true,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  }];
  await mockDaemon(page, state);
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "媒体生产" }).click();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加场景" }).click();
  await page.getByRole("button", { name: "检查", exact: true }).click();
  const review = page.locator('[role="dialog"][data-media-production-dialog="project-run-review"]');
  await expect(review.locator('[data-project-run-ready-count="0"]')).toBeVisible();
  await expect(review.locator('[data-project-run-skipped-count="1"]')).toBeVisible();
  await expect(review.getByRole("button", { name: /^运行/ })).toHaveCount(0);
  const [dialogBox, titleBox, sectionBox, closeActionBox] = await Promise.all([
    review.boundingBox(),
    review.getByRole("heading", { name: /检查/ }).boundingBox(),
    review.locator("[data-project-run-ready-count]").boundingBox(),
    review.getByRole("button", { name: "关闭" }).last().boundingBox(),
  ]);
  expect(Math.abs((titleBox?.x ?? 0) - (sectionBox?.x ?? 0))).toBeLessThanOrEqual(2);
  expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) - ((closeActionBox?.x ?? 0) + (closeActionBox?.width ?? 0))).toBeGreaterThanOrEqual(18);
  await review.getByRole("button", { name: "关闭" }).last().click();
  await page.getByLabel("提示词").fill("一束晨光掠过产品表面。 ");
  await page.getByLabel("提示词").blur();
  await page.locator(".scene-inspector").getByLabel("默认视频模型").selectOption("provider_seedance");
  await page.getByRole("button", { name: "重复" }).click();
  await page.locator(".project-outline-scene-main").nth(1).click();
  await page.getByLabel("提示词").fill("");
  await page.getByLabel("提示词").blur();
  await expect.poll(() => state.mediaScenes[1]?.prompt).toBe("");
  await expect(page.locator(".project-outline-scene")).toHaveCount(2);

  await page.getByRole("button", { name: "运行 · 1 个场景", exact: true }).click();
  const readyReview = page.locator('[role="dialog"][data-media-production-dialog="project-run-review"]');
  await expect(readyReview.locator('[data-project-run-ready-count="1"]')).toBeVisible();
  await expect(readyReview.locator('[data-project-run-skipped-count="1"]')).toBeVisible();
  await readyReview.getByRole("button", { name: "关闭" }).click();
  await expect(readyReview).toHaveCount(0);
  await expect.poll(() => state.mediaJobs).toHaveLength(0);

  await page.getByRole("button", { name: "运行 · 1 个场景", exact: true }).click();
  const projectRunRequest = page.waitForRequest((request) => request.method() === "POST"
    && /\/media-projects\/[^/]+\/run$/.test(new URL(request.url()).pathname));
  await page.locator('[role="dialog"][data-media-production-dialog="project-run-review"]').getByRole("button", { name: "运行 · 1 个场景" }).click();
  const request = await projectRunRequest;
  const submittedSceneIds = (JSON.parse(request.postData() ?? "{}") as { readonly sceneIds?: unknown }).sceneIds;
  expect(submittedSceneIds).toHaveLength(1);
  expect(submittedSceneIds).toEqual(expect.arrayContaining([expect.stringMatching(/^media_scene_/)]));
  await expect(page.locator('[role="dialog"][data-media-production-dialog="project-run-review"]')).toHaveCount(0);
});

test("media production keeps the current video when regeneration fails and preview does not change selection", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (isViteClientTransportError(message)) return;
    const url = message.location().url;
    if (url.includes("/control-plane/snapshot") || url.includes("/control-plane/stream")) return;
    consoleErrors.push(`${message.text()} ${url}`.trim());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  const state = createBaseState({});
  const timestamp = "2026-07-15T02:00:00.000Z";
  state.providers = [{
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance 视频",
    providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528",
    api: "media-job",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyRef: "env:SEEDANCE_API_KEY",
    apiKeyConfigured: true,
    headers: {},
    input: ["text"],
    compat: { mediaVendorTransport: { mode: "live" } },
    capabilities: ["video_generate"],
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.mediaProjects = [{
    id: "media_project_failure",
    workspaceId: "workspace_default",
    name: "失败保留结果",
    defaultProviderPresetId: "provider_seedance",
    defaultExecutionMode: "direct",
    canvasViewport: { x: 0, y: 0, zoom: 1 },
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.mediaScenes = [
    {
      ...mockScene("media_scene_failure", "media_project_failure", { x: 80, y: 96 }, timestamp),
      title: "保留旧结果",
      prompt: "旧结果仍应可预览。",
      providerPresetId: "provider_seedance",
      selectedMediaSceneRunId: "media_scene_run_current",
    },
    {
      ...mockScene("media_scene_second", "media_project_failure", { x: 380, y: 96 }, timestamp),
      sortOrder: 1,
      title: "第二场景",
      prompt: "第二个已生成场景。",
      providerPresetId: "provider_seedance",
      selectedMediaSceneRunId: "media_scene_run_second",
    },
  ];
  state.mediaSceneRuns = [
    mockSceneRun("media_scene_run_failed", "media_scene_failure", "media_job_failed", "2026-07-15T02:03:00.000Z"),
    mockSceneRun("media_scene_run_second", "media_scene_second", "media_job_second", "2026-07-15T02:02:00.000Z"),
    mockSceneRun("media_scene_run_current", "media_scene_failure", "media_job_current", "2026-07-15T02:01:00.000Z"),
  ];
  state.mediaJobs = [
    mockVideoJob("media_job_failed", "failed", "2026-07-15T02:03:00.000Z", "视频服务暂时不可用。"),
    mockVideoJob("media_job_second", "succeeded", "2026-07-15T02:02:00.000Z", undefined, ["artifact_second"]),
    mockVideoJob("media_job_current", "succeeded", "2026-07-15T02:01:00.000Z", undefined, ["artifact_current"]),
  ];
  state.artifactsByMediaJob.media_job_current = [mockVideoArtifact("artifact_current", "media_job_current", timestamp)];
  state.artifactsByMediaJob.media_job_second = [mockVideoArtifact("artifact_second", "media_job_second", timestamp)];
  await mockDaemon(page, state);
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "媒体生产" }).click();
  await expect(page.locator(".storyboard-scene-node.selected")).toContainText("保留旧结果");
  await expect(page.locator(".storyboard-node-status").first()).toContainText("生成结果");
  await expect(page.locator(".media-production-dock-panel.right")).not.toHaveClass(/is-open/);
  await page.locator(".storyboard-scene-node.selected").click();
  await page.getByRole("tab", { name: "生成结果", exact: true }).click();
  const latestRunIssue = page.locator(".scene-latest-run-issue");
  const technicalDetails = latestRunIssue.locator(".ling-ui-inspector-section");
  const technicalDetailsBody = technicalDetails.locator(".ling-ui-inspector-section-body");
  await expect(latestRunIssue).toBeVisible();
  await expect(technicalDetailsBody).toBeHidden();
  await technicalDetails.locator(".ling-ui-inspector-section-trigger").click();
  await expect(technicalDetailsBody).toContainText("视频服务暂时不可用");
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "预览: 第二场景" }).click();
  const previewDialog = page.locator('[role="dialog"][data-media-production-dialog="scene-result-preview"]');
  await expect(previewDialog.locator('[data-media-preview-artifact="artifact_second"]')).toBeVisible();
  await expect(page.locator(".storyboard-scene-node.selected")).toContainText("保留旧结果");
  await page.screenshot({ path: testInfo.outputPath("scene-preview-light-1440x960.png"), fullPage: true });
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("ling-stack.themePreference", "dark");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "媒体生产" }).click();
  await page.getByRole("button", { name: "预览: 第二场景" }).click();
  await expect(page.locator('[role="dialog"][data-media-production-dialog="scene-result-preview"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("scene-preview-dark-1280x800.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test("media production imports a ComfyUI workflow and runs one scene without replacing direct generation", async ({ page }) => {
  const state = createBaseState({});
  state.providers = [{
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance 视频",
    providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528",
    api: "media-job",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyRef: "env:SEEDANCE_API_KEY",
    apiKeyConfigured: true,
    headers: {},
    input: ["text"],
    compat: { mediaVendorTransport: { mode: "live" } },
    capabilities: ["video_generate"],
    enabled: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  }];
  await mockDaemon(page, state);
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "媒体生产" }).click();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加场景" }).click();
  await page.locator(".media-production-project-trigger").click();
  await page.locator(".project-outline-workflow-entry").click();
  const workflowDialog = page.getByRole("dialog", { name: "生产流程库" });
  await expect(workflowDialog).toBeVisible();
  await expect(workflowDialog.locator(".media-workflow-onboarding")).toBeVisible();
  await expect(workflowDialog.getByRole("button", { name: "导入流程" })).toHaveCount(1);
  await expect(workflowDialog.locator(".media-workflow-detail-pane")).toHaveCount(0);
  const emptyWorkflowDialogSize = await workflowDialog.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  expect(emptyWorkflowDialogSize.width).toBeLessThanOrEqual(720);
  expect(emptyWorkflowDialogSize.height).toBeLessThanOrEqual(460);
  await workflowDialog.getByRole("tab", { name: "连接" }).click();
  await expect(workflowDialog).toHaveClass(/connections-view/);
  const trustCheckbox = workflowDialog.getByRole("checkbox", { name: /信任本机或私有网络地址/ });
  const [workflowBox, trustTargetBox, actionsBox] = await Promise.all([
    workflowDialog.boundingBox(),
    trustCheckbox.locator("xpath=following-sibling::*[1]").boundingBox(),
    workflowDialog.locator(".media-workflow-detail-actions").boundingBox(),
  ]);
  const connectionLayout = {
    dialogWidth: workflowBox?.width ?? 0,
    dialogHeight: workflowBox?.height ?? 0,
    checkboxWidth: trustTargetBox?.width ?? 0,
    checkboxHeight: trustTargetBox?.height ?? 0,
    footerGap: workflowBox && actionsBox ? workflowBox.y + workflowBox.height - actionsBox.y - actionsBox.height : 999,
  };
  expect(connectionLayout.dialogWidth).toBeLessThanOrEqual(922);
  expect(connectionLayout.dialogHeight).toBeLessThanOrEqual(622);
  expect(connectionLayout.checkboxWidth).toBe(18);
  expect(connectionLayout.checkboxHeight).toBe(18);
  expect(connectionLayout.footerGap).toBeLessThanOrEqual(2);
  await expect(trustCheckbox).toBeChecked();
  await workflowDialog.getByLabel("连接名称").fill("本机 ComfyUI");
  await workflowDialog.getByLabel("ComfyUI 地址").fill("http://127.0.0.1:8188");
  await workflowDialog.getByRole("button", { name: "保存连接" }).click();
  await workflowDialog.getByRole("button", { name: "检查连接" }).click();
  await expect(workflowDialog).toContainText("连接已就绪");

  await workflowDialog.getByRole("tab", { name: "工作流", exact: true }).click();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await workflowDialog.getByRole("button", { name: "导入流程" }).first().click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "storyboard-video.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      "1": { class_type: "CLIPTextEncode", inputs: { text: "产品分镜" } },
      "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
    })),
  });
  await expect(workflowDialog).toContainText("流程映射已就绪");
  await workflowDialog.getByLabel("流程名称").fill("产品分镜流程");
  await workflowDialog.getByRole("button", { name: "导入流程" }).last().click();
  await expect(workflowDialog).toContainText("产品分镜流程");
  await workflowDialog.getByRole("button", { name: "运行测试", exact: true }).click();
  await expect(workflowDialog).toContainText(/测试已提交|测试中/);
  await expect(workflowDialog).toContainText("测试通过");
  await workflowDialog.getByRole("button", { name: "启用版本" }).click();
  await expect(workflowDialog).toContainText("当前版本");
  await workflowDialog.getByRole("button", { name: "关闭生产流程" }).click();

  await page.locator(".storyboard-scene-node.selected").click();
  const inspector = page.locator(".scene-inspector");
  await inspector.getByLabel("默认生产方式").selectOption("workflow");
  const workflowSelect = inspector.getByLabel("默认生产流程");
  await expect(workflowSelect).toBeEnabled();
  await workflowSelect.selectOption({ label: "产品分镜流程" });
  const selectedWorkflowId = await workflowSelect.inputValue();
  expect(selectedWorkflowId).not.toBe("");
  await inspector.getByLabel("提示词").fill("镜头缓慢推进，产品在柔和灯光下旋转。");
  await inspector.getByLabel("提示词").blur();
  await expect.poll(() => state.mediaScenes[0]?.executionMode).toBe("workflow");
  await expect.poll(() => state.mediaScenes[0]?.workflowDefinitionId).toBe(selectedWorkflowId);
  await expect.poll(() => state.mediaScenes[0]?.prompt).toBe("镜头缓慢推进，产品在柔和灯光下旋转。");
  await expect(inspector.getByLabel("默认视频模型")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");

  await expect.poll(() => state.mediaScenes[0]?.executionMode).toBe("workflow");
  await expect.poll(() => state.mediaJobs.some((job) => Boolean(job.workflowVersionId))).toBe(true);
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBeTruthy();
  await page.getByRole("tab", { name: /^历史/ }).click();
  await expect(page.locator(".scene-run-row.selected")).toContainText("当前");
  await expect(page.getByRole("button", { name: "运行", exact: true })).toBeEnabled();
  expect(state.providers.some((provider) => typeof provider === "object" && provider !== null && "id" in provider && provider.id === "provider_seedance")).toBe(true);
});

async function storyboardTransform(page: Page): Promise<string> {
  return page.locator(".react-flow__viewport").getAttribute("style").then((value) => value ?? "");
}

async function storyboardZoom(page: Page): Promise<number> {
  const transform = await storyboardTransform(page);
  const match = /scale\(([^)]+)\)/.exec(transform);
  return match ? Number(match[1]) : 1;
}

async function panStoryboardAway(page: Page): Promise<void> {
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) {
    throw new Error("Storyboard pane is not visible.");
  }
  const startX = box.x + box.width * 0.55;
  const startY = box.y + box.height * 0.72;
  for (let index = 0; index < 3; index += 1) {
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + Math.min(360, box.width * 0.34), startY, { steps: 8 });
    await page.mouse.up();
  }
}

async function elementsOverlap(page: Page, firstSelector: string, secondSelector: string): Promise<boolean> {
  return page.evaluate(({ firstSelector, secondSelector }) => {
    const first = document.querySelector(firstSelector);
    const second = document.querySelector(secondSelector);
    if (!first || !second) {
      return false;
    }
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    return firstRect.left < secondRect.right
      && firstRect.right > secondRect.left
      && firstRect.top < secondRect.bottom
      && firstRect.bottom > secondRect.top;
  }, { firstSelector, secondSelector });
}

async function selectedSceneIsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".storyboard-canvas");
    const node = document.querySelector(".storyboard-scene-node.selected");
    if (!canvas || !node) {
      return false;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const leftDock = document.querySelector(".media-production-dock-panel.left.is-open");
    const rightDock = document.querySelector(".media-production-dock-panel.right.is-open");
    const safeLeft = leftDock ? leftDock.getBoundingClientRect().right + 12 : canvasRect.left + 16;
    const safeRight = rightDock ? rightDock.getBoundingClientRect().left - 12 : canvasRect.right - 16;
    return nodeRect.left >= safeLeft
      && nodeRect.right <= safeRight
      && nodeRect.top >= canvasRect.top + 72
      && nodeRect.bottom <= canvasRect.bottom - 56;
  });
}

function mockScene(
  id: string,
  projectId: string,
  canvasPosition: { readonly x: number; readonly y: number },
  timestamp: string,
): MockState["mediaScenes"][number] {
  return {
    id,
    projectId,
    sortOrder: 0,
    title: id,
    prompt: "",
    executionMode: "inherit",
    workflowInputValues: {},
    ratio: "16:9",
    durationSeconds: 5,
    referenceArtifactIds: [],
    canvasPosition,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mockSceneRun(
  id: string,
  sceneId: string,
  mediaJobId: string,
  timestamp: string,
): MockState["mediaSceneRuns"][number] {
  return {
    id,
    projectId: "media_project_failure",
    sceneId,
    mediaJobId,
    providerSnapshot: { providerPresetId: "provider_seedance" },
    executionSnapshot: { kind: "provider", providerPresetId: "provider_seedance", displayName: "Seedance 视频" },
    inputSnapshot: { prompt: "场景视频" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mockVideoJob(
  id: string,
  status: MockState["mediaJobs"][number]["status"],
  timestamp: string,
  errorMessage?: string,
  artifactIds: string[] = [],
): MockState["mediaJobs"][number] {
  return {
    id,
    workspaceId: "workspace_default",
    providerPresetId: "provider_seedance",
    executionSource: { kind: "provider", providerPresetId: "provider_seedance" },
    operation: "video_generate",
    prompt: "场景视频",
    input: { ratio: "16:9", duration: 5 },
    artifactIds,
    status,
    errorMessage,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mockVideoArtifact(
  id: string,
  mediaJobId: string,
  timestamp: string,
): MockState["artifactsByMediaJob"][string][number] {
  return {
    id,
    mediaJobId,
    type: "video",
    path: `media_jobs/${mediaJobId}/${id}.mp4`,
    title: "场景视频",
    contentType: "video/mp4",
    sizeBytes: 4096,
    createdAt: timestamp,
  };
}
