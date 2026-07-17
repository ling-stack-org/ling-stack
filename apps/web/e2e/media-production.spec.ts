import { expect, test, type Page } from "@playwright/test";
import type { MockState } from "./support/mock-daemon";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createDefaultProviderTemplates } from "./support/mock-state";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
});

test("media production creates an ordered storyboard and keeps canvas layout separate", async ({ page }) => {
  const state = createBaseState({});
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  await expect(page.getByRole("heading", { name: "Media Production", level: 1 })).toHaveCount(0);
  await expect(page.locator(".media-production-canvas-toolbar")).toContainText("Production studio");
  await page.locator(".media-production-empty-state").getByRole("button", { name: "新建项目" }).click();
  await expect(page.locator(".media-production-canvas-stage")).toBeVisible();
  await expect(page.locator(".project-scene-outline")).toBeVisible();
  const leftDock = page.locator(".media-production-dock-panel.left");
  await expect(leftDock).toHaveClass(/is-open/);
  await page.getByRole("button", { name: "关闭项目与分镜" }).click();
  await expect(leftDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".project-scene-outline")).toBeHidden();
  await page.getByRole("button", { name: "展开项目与分镜" }).click();
  await expect(page.locator(".project-scene-outline")).toBeVisible();
  const projectSettings = page.locator("details.project-outline-settings");
  await expect(projectSettings).not.toHaveAttribute("open", "");
  await projectSettings.locator("summary").click();
  await expect(page.getByLabel("项目名称")).toBeVisible();
  await projectSettings.locator("summary").click();
  await page.getByRole("button", { name: "添加第一个场景" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(1);
  await expect(page.locator(".scene-inspector")).toBeVisible();
  const rightDock = page.locator(".media-production-dock-panel.right");
  await expect(rightDock).toHaveClass(/is-open/);
  await expect(page.locator(".media-production-canvas-stage")).toHaveAttribute("data-exclusive-docks", "true");
  await expect(leftDock).not.toHaveClass(/is-open/);
  const canvasDimensions = await page.locator(".storyboard-canvas").evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  await page.getByRole("button", { name: "关闭场景检查器" }).click();
  await expect(rightDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".scene-inspector")).toBeHidden();
  await page.getByRole("button", { name: "展开项目与分镜" }).click();
  await expect(leftDock).toHaveClass(/is-open/);
  await expect(page.locator(".storyboard-canvas")).toHaveJSProperty("clientWidth", canvasDimensions.width);
  await expect(page.locator(".storyboard-canvas")).toHaveJSProperty("clientHeight", canvasDimensions.height);
  await page.locator(".project-outline-scene-main").click();
  await expect(leftDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".scene-inspector")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rightDock).not.toHaveClass(/is-open/);
  await expect(page.locator(".scene-inspector")).toBeHidden();
  await page.getByRole("button", { name: "展开场景检查器" }).click();
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

  await page.getByLabel("画面提示").fill("A quiet product reveal in a bright studio.");
  await page.getByLabel("画面提示").blur();
  await expect.poll(() => state.mediaScenes[0]?.prompt).toBe("A quiet product reveal in a bright studio.");
  await expect(page.locator(".ling-toast")).toContainText("Saved");
  await expect(page.locator(".media-production-canvas-toolbar")).not.toContainText("Saved");
  await expect(page.locator(".ling-toast")).toHaveCount(0, { timeout: 2_500 });

  await page.getByRole("button", { name: "复制场景" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(2);
  await expect(page.locator(".storyboard-sequence-edge .react-flow__edge-path")).toHaveCount(1);
  await expect(page.locator(".react-flow__controls")).toHaveCount(1);
  const miniMap = page.locator(".react-flow__minimap");
  await expect(miniMap).toHaveCount(0);
  await page.getByRole("button", { name: "复制场景" }).click();
  await page.getByRole("button", { name: "复制场景" }).click();
  await page.getByRole("button", { name: "复制场景" }).click();
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

  await page.getByRole("button", { name: "关闭场景检查器" }).click();
  await panStoryboardAway(page);
  const repeatedSelectionTransform = await storyboardTransform(page);
  await page.getByRole("button", { name: "展开项目与分镜" }).click();
  await page.locator(".project-outline-scene-main").nth(1).click();
  await expect.poll(() => storyboardTransform(page)).not.toBe(repeatedSelectionTransform);
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);

  await page.getByRole("button", { name: "关闭场景检查器" }).click();
  await panStoryboardAway(page);
  const changedSelectionTransform = await storyboardTransform(page);
  await page.getByRole("button", { name: "展开项目与分镜" }).click();
  await page.locator(".project-outline-scene-main").first().click();
  await expect.poll(() => storyboardTransform(page)).not.toBe(changedSelectionTransform);
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);

  await page.getByRole("button", { name: "展开项目与分镜" }).click();
  await page.getByRole("button", { name: "下移场景" }).first().click();
  await expect.poll(() => state.mediaScenes.map((scene) => scene.sortOrder)).toEqual([1, 0, 2, 3, 4]);
  const selectedOutlineScene = page.locator(".project-outline-scene.selected");
  await selectedOutlineScene.getByRole("button", { name: "删除场景" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除场景" });
  await expect(page.locator(".scene-delete-overlay")).toHaveCSS("position", "fixed");
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText("删除这个场景？");
  await deleteDialog.getByRole("button", { name: "删除场景" }).click();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(1);
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);
  await page.getByLabel("媒体项目").selectOption("media_project_far");
  await expect(page.locator(".storyboard-scene-node")).toContainText("media_scene_far");
  await expect.poll(() => selectedSceneIsVisible(page)).toBe(true);
});

test("media production directs missing video setup to model workbench", async ({ page }) => {
  const state = createBaseState({});
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  await page.locator(".media-production-empty-state").getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加第一个场景" }).click();
  await expect(page.getByRole("button", { name: "检查场景", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "配置视频模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成此场景" })).toBeDisabled();

  await page.getByRole("button", { name: "配置视频模型" }).click();
  await expect(page.getByLabel(/^(Settings sections|设置分组)$/).getByRole("button", { name: /^(Model Workbench|模型工作台)$/ })).toHaveClass(/active/);
  const editor = page.getByRole("dialog", { name: "New video generation model" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Model supplier")).toHaveValue("seedance-video");
});

test("media production configures Seedance from the workbench before generating a scene", async ({ page }, testInfo) => {
  const state = createBaseState({});
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  await page.locator(".media-production-empty-state").getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加第一个场景" }).click();
  await page.getByLabel("画面提示").fill("A controlled studio reveal of a compact camera.");
  await page.getByLabel("画面提示").blur();

  await page.getByRole("button", { name: "配置视频模型" }).click();
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
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  await page.locator(".storyboard-scene-node.selected").click();
  await page.locator(".scene-inspector .scene-execution-settings .select-control-native").nth(1).selectOption(providerId);
  await expect(page.getByRole("button", { name: "生成此场景" })).toBeEnabled();
  await page.getByRole("button", { name: "生成此场景" }).click();
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");
  expect(state.approvals.some((approval) => approval.actionType === "media_cost" && approval.status === "pending")).toBe(false);
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBeTruthy();
  await page.getByRole("button", { name: /^历史/ }).click();
  await expect(page.getByRole("button", { name: "当前结果", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();
  await expect(page.locator(".storyboard-node-status")).toHaveText("已生成");
  await expect(page.getByRole("button", { name: /预览当前视频/ })).toBeVisible();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "媒体生产" }).click();
  await page.locator(".media-production-empty-state").getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加第一个场景" }).click();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("01-storyboard-canvas.png"), fullPage: true });

  await page.getByLabel("场景名称").fill("开场产品展示");
  await page.getByLabel("场景名称").blur();
  await page.getByLabel("画面提示").fill("晨光从产品表面掠过，镜头缓慢推进，干净的工业设计棚拍。 ");
  await page.getByLabel("画面提示").blur();
  const inspector = page.locator(".scene-inspector");
  await inspector.getByLabel("视频模型").selectOption("provider_seedance");
  await expect(inspector.getByLabel("比例")).toHaveValue("16:9");
  await expect(inspector.getByLabel("时长")).toHaveValue("5");
  await expect(page.getByRole("button", { name: "生成此场景" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("02-scene-configured.png"), fullPage: true });

  await page.getByRole("button", { name: "生成此场景" }).click();
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBeTruthy();
  const firstSelectedRunId = state.mediaScenes[0]?.selectedMediaSceneRunId;
  const firstSelectedRun = state.mediaSceneRuns.find((run) => run.id === firstSelectedRunId);
  expect(firstSelectedRun).toBeTruthy();
  const firstArtifactId = state.artifactsByMediaJob[firstSelectedRun?.mediaJobId ?? ""]?.[0]?.id;
  expect(firstArtifactId).toBeTruthy();
  await page.getByRole("button", { name: /^历史/ }).click();
  await expect(page.getByRole("button", { name: "当前结果", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();
  await expect(page.locator(".storyboard-node-status")).toHaveText("已生成");
  await page.screenshot({ path: testInfo.outputPath("03-generation-complete.png"), fullPage: true });

  const previewButton = page.getByRole("button", { name: /预览当前视频/ });
  const runCountBeforePreview = state.mediaSceneRuns.length;
  await previewButton.click();
  const previewDialog = page.getByRole("dialog", { name: "预览当前视频" });
  const previewVideo = previewDialog.locator("video");
  await expect(previewDialog).toBeVisible();
  await expect(previewVideo).toHaveJSProperty("controls", true);
  await expect(previewVideo).toHaveAttribute("autoplay", "");
  await expect(previewVideo).toHaveJSProperty("muted", true);
  await expect(previewDialog.locator("video source")).toHaveAttribute("src", new RegExp(firstArtifactId ?? "missing"));
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

  await page.getByRole("button", { name: "检查场景", exact: true }).click();
  const generatedReview = page.getByRole("dialog", { name: "检查场景" });
  await expect(generatedReview).toContainText("当前没有可生成场景");
  await expect(generatedReview).toContainText("已生成");
  await expect(generatedReview).toContainText("按顺序生成会跳过");
  await generatedReview.locator(".create-dialog-actions .secondary-button").click();

  state.mediaJobRunDelayMs = -1;
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.locator(".storyboard-node-status")).toHaveText("重新生成中");
  await expect(page.getByRole("button", { name: "重新生成中", exact: true })).toBeDisabled();
  await expect(previewButton).toBeVisible();
  await previewButton.click();
  await expect(previewDialog.locator("video source")).toHaveAttribute("src", new RegExp(firstArtifactId ?? "missing"));
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();

  const runningRow = page.locator(".scene-run-row").filter({ hasText: "生成中" }).first();
  await runningRow.getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".scene-run-row strong").filter({ hasText: "已取消" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();

  state.mediaJobRunDelayMs = 80;
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.locator(".scene-run-row strong").filter({ hasText: "生成中" })).toHaveCount(1);
  await expect(page.locator(".scene-run-row strong").filter({ hasText: "已取消" })).toHaveCount(1);
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");

  await expect(page.getByRole("button", { name: "设为当前" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();
  expect(state.mediaScenes[0]?.selectedMediaSceneRunId).toBe(firstSelectedRunId);
  await previewButton.click();
  await expect(previewDialog.locator("video source")).toHaveAttribute("src", new RegExp(firstArtifactId ?? "missing"));
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();

  const latestSceneRunId = state.mediaSceneRuns[0]?.id;
  expect(latestSceneRunId).toBeTruthy();
  await page.getByRole("button", { name: "设为当前" }).click();
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBe(latestSceneRunId);
  const latestArtifactId = state.artifactsByMediaJob[state.mediaSceneRuns[0]?.mediaJobId ?? ""]?.[0]?.id;
  expect(latestArtifactId).toBeTruthy();
  await previewButton.click();
  await expect(previewDialog.locator("video source")).toHaveAttribute("src", new RegExp(latestArtifactId ?? "missing"));
  await previewDialog.getByRole("button", { name: "关闭预览" }).click();
  await page.screenshot({ path: testInfo.outputPath("04-selected-result.png"), fullPage: true });

  await page.getByRole("tab", { name: "生成任务" }).click();
  await expect(page.locator(".media-jobs-embedded-toolbar")).toBeVisible();
  await expect(page.locator(".media-job-row.succeeded")).toHaveCount(2);
  await expect(page.locator(".media-job-row.succeeded").first()).toContainText(`${state.mediaProjects[0]?.name} · 开场产品展示`);
  await expect(page.locator(".media-job-detail-panel")).toContainText("晨光从产品表面掠过");
  await expect(page.locator(".media-job-detail-panel video")).toBeVisible();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "媒体生产" }).click();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加第一个场景" }).click();
  await page.getByRole("button", { name: "检查场景", exact: true }).click();
  const review = page.getByRole("dialog", { name: "检查场景" });
  await expect(review).toContainText("当前没有可生成场景");
  await expect(review).toContainText("本次不提交 1 个场景");
  await expect(review.getByRole("button", { name: "生成 0 个场景" })).toHaveCount(0);
  const reviewLayout = await review.evaluate((dialog) => {
    const title = dialog.querySelector<HTMLElement>(".create-dialog-title-block");
    const section = dialog.querySelector<HTMLElement>(".project-run-review-section");
    const closeAction = dialog.querySelector<HTMLElement>(".create-dialog-actions .secondary-button");
    const dialogRect = dialog.getBoundingClientRect();
    return {
      titleLeft: title?.getBoundingClientRect().left ?? 0,
      sectionLeft: section?.getBoundingClientRect().left ?? 0,
      actionRightInset: dialogRect.right - (closeAction?.getBoundingClientRect().right ?? dialogRect.right),
    };
  });
  expect(Math.abs(reviewLayout.titleLeft - reviewLayout.sectionLeft)).toBeLessThanOrEqual(2);
  expect(reviewLayout.actionRightInset).toBeGreaterThanOrEqual(18);
  await review.locator(".create-dialog-actions .secondary-button").click();
  await page.getByLabel("画面提示").fill("一束晨光掠过产品表面。 ");
  await page.getByLabel("画面提示").blur();
  await page.locator(".scene-inspector .scene-execution-settings .select-control-native").nth(1).selectOption("provider_seedance");
  await page.getByRole("button", { name: "复制场景" }).click();
  await page.getByLabel("画面提示").fill("");
  await page.getByLabel("画面提示").blur();
  await expect(page.locator(".project-outline-scene")).toHaveCount(2);

  await page.getByRole("button", { name: "生成 1 个场景", exact: true }).click();
  const readyReview = page.getByRole("dialog", { name: "确认生成场景" });
  await expect(readyReview).toContainText("本次将提交 1 个场景");
  await expect(readyReview).toContainText("本次不提交 1 个场景");
  await readyReview.getByRole("button", { name: "关闭" }).click();
  await expect(readyReview).toHaveCount(0);
  await expect.poll(() => state.mediaJobs).toHaveLength(0);

  await page.getByRole("button", { name: "生成 1 个场景", exact: true }).click();
  const projectRunRequest = page.waitForRequest((request) => request.method() === "POST"
    && /\/media-projects\/[^/]+\/run$/.test(new URL(request.url()).pathname));
  await page.getByRole("dialog", { name: "确认生成场景" }).getByRole("button", { name: "生成 1 个场景" }).click();
  const request = await projectRunRequest;
  const submittedSceneIds = (JSON.parse(request.postData() ?? "{}") as { readonly sceneIds?: unknown }).sceneIds;
  expect(submittedSceneIds).toHaveLength(1);
  expect(submittedSceneIds).toEqual(expect.arrayContaining([expect.stringMatching(/^media_scene_/)]));
  await expect(page.getByRole("dialog", { name: "确认生成场景" })).toHaveCount(0);
});

test("media production keeps the current video when regeneration fails and preview does not change selection", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "媒体生产" }).click();
  await expect(page.locator(".storyboard-scene-node.selected")).toContainText("保留旧结果");
  await expect(page.locator(".storyboard-node-status").first()).toHaveText("已生成");
  await expect(page.locator(".media-production-dock-panel.right")).not.toHaveClass(/is-open/);
  await page.locator(".storyboard-scene-node.selected").click();
  await page.getByRole("button", { name: "结果", exact: true }).click();
  await expect(page.locator(".scene-latest-run-issue")).toContainText("生成失败");
  await expect(page.locator(".scene-latest-run-issue details p")).toBeHidden();
  await page.getByText("技术信息", { exact: true }).click();
  await expect(page.locator(".scene-latest-run-issue")).toContainText("视频服务暂时不可用");
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "预览当前视频：第二场景" }).click();
  const previewDialog = page.getByRole("dialog", { name: "预览当前视频" });
  await expect(previewDialog.locator("video source")).toHaveAttribute("src", /artifact_second/);
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
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "媒体生产" }).click();
  await page.getByRole("button", { name: "预览当前视频：第二场景" }).click();
  await expect(page.getByRole("dialog", { name: "预览当前视频" })).toBeVisible();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "媒体生产" }).click();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("button", { name: "添加第一个场景" }).click();
  await page.getByRole("button", { name: "展开项目与分镜" }).click();
  await page.locator(".project-outline-workflow-entry").click();
  const workflowDialog = page.getByRole("dialog", { name: "生产流程库" });
  await expect(workflowDialog).toBeVisible();
  await expect(workflowDialog.locator(".media-workflow-onboarding")).toBeVisible();
  await expect(workflowDialog.getByRole("button", { name: "导入流程" })).toHaveCount(1);
  await expect(workflowDialog.locator(".media-workflow-detail-pane")).toHaveCount(0);
  const emptyWorkflowDialogSize = await workflowDialog.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  expect(emptyWorkflowDialogSize.width).toBeLessThanOrEqual(720);
  expect(emptyWorkflowDialogSize.height).toBeLessThanOrEqual(460);
  await workflowDialog.getByRole("button", { name: "连接" }).click();
  await expect(workflowDialog).toHaveClass(/connections-view/);
  const trustCheckbox = workflowDialog.getByRole("checkbox", { name: /信任本机或局域网地址/ });
  const connectionLayout = await workflowDialog.evaluate((dialog) => {
    const checkbox = dialog.querySelector<HTMLInputElement>('.media-workflow-trust-row input[type="checkbox"]');
    const actions = dialog.querySelector<HTMLElement>(".media-workflow-detail-actions");
    const dialogBox = dialog.getBoundingClientRect();
    const checkboxBox = checkbox?.getBoundingClientRect();
    const actionsBox = actions?.getBoundingClientRect();
    return {
      dialogWidth: dialogBox.width,
      dialogHeight: dialogBox.height,
      checkboxWidth: checkboxBox?.width ?? 0,
      checkboxHeight: checkboxBox?.height ?? 0,
      footerGap: actionsBox ? dialogBox.bottom - actionsBox.bottom : 999,
    };
  });
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
  await expect(workflowDialog).toContainText("连接可用");

  await workflowDialog.getByRole("button", { name: "流程", exact: true }).click();
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
  await expect(workflowDialog).toContainText("节点检查通过");
  await workflowDialog.getByLabel("流程名称").fill("产品分镜流程");
  await workflowDialog.getByRole("button", { name: "导入流程" }).last().click();
  await expect(workflowDialog).toContainText("产品分镜流程");
  await workflowDialog.getByRole("button", { name: "试运行", exact: true }).click();
  await expect(workflowDialog).toContainText("试运行中");
  await expect(workflowDialog).toContainText("试运行成功，可以启用");
  await workflowDialog.getByRole("button", { name: "启用此版本" }).click();
  await expect(workflowDialog).toContainText("可用于场景");
  await workflowDialog.getByRole("button", { name: "关闭生产流程" }).click();

  await page.locator(".storyboard-scene-node.selected").click();
  const inspector = page.locator(".scene-inspector");
  await inspector.getByLabel("生产方式").selectOption("workflow");
  const workflowSelect = inspector.locator(".scene-execution-settings .select-control-native").nth(1);
  await expect(workflowSelect).toBeEnabled();
  await workflowSelect.selectOption({ label: "产品分镜流程" });
  await inspector.getByLabel("画面提示").fill("镜头缓慢推进，产品在柔和灯光下旋转。");
  await inspector.getByLabel("画面提示").blur();
  await expect(inspector.getByLabel("视频模型")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "生成此场景" })).toBeEnabled();
  await page.getByRole("button", { name: "生成此场景" }).click();
  await expect.poll(() => state.mediaJobs[0]?.status).toBe("succeeded");

  await expect.poll(() => state.mediaScenes[0]?.executionMode).toBe("workflow");
  await expect.poll(() => state.mediaJobs.some((job) => Boolean(job.workflowVersionId))).toBe(true);
  await expect.poll(() => state.mediaScenes[0]?.selectedMediaSceneRunId).toBeTruthy();
  await page.getByRole("button", { name: /^历史/ }).click();
  await expect(page.getByRole("button", { name: "当前结果", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();
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
