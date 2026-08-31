import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openMediaProduction } from "./support/media-production-fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
});

test("MP-08 direct source drift keeps field failure drafts and restores authority on scene switch", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = directFixture();
  state.mediaScenes[0].providerPresetId = "provider_removed";
  const control = routeControl();
  await prepare(page, state, control);
  await openInspector(page);

  const inspector = page.locator(".scene-inspector");
  await expect(inspector.getByLabel("Default video model")).toBeVisible();
  await expect(inspector.getByLabel("Default production workflow")).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Configure video model", exact: true })).toBeVisible();

  control.failNextSceneUpdate = 1;
  const title = inspector.getByLabel("Scene 1");
  await title.fill("Retained title draft");
  await title.blur();
  const titleFailure = inspector.getByRole("alert").filter({ hasText: "Could not save this scene." });
  await expect(titleFailure).toBeVisible();
  await expect(title).toHaveValue("Retained title draft");
  expect(state.mediaScenes[0].title).toBe("Direct scene A");
  await titleFailure.getByRole("button", { name: "Retry" }).click();
  await expect(titleFailure).toHaveCount(0);
  await expect.poll(() => state.mediaScenes[0].title).toBe("Retained title draft");

  control.failNextSceneUpdate = 1;
  const prompt = inspector.getByLabel("Prompt");
  await prompt.fill("A draft that must not leak across scenes");
  await page.locator(".storyboard-scene-node").nth(1).click();
  await expect(inspector.getByLabel("Prompt")).toHaveValue("Authoritative prompt B");
  await page.locator(".storyboard-scene-node").first().click();
  await expect(inspector.getByLabel("Prompt")).toHaveValue("Authoritative prompt A");
  expect(state.mediaScenes[0].prompt).toBe("Authoritative prompt A");

  await inspector.getByRole("button", { name: "Configure video model", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New video generation model" })).toBeVisible();
  expect(control.sceneUpdateCalls).toBe(3);
  expect(errors).toEqual([]);
});

test("MP-08 Run validates the visible prompt and commits it before creating a task", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = directFixture();
  state.providers = [{ ...state.providers[0], displayName: "seedance-ui2 · seedance-ui2" }];
  state.mediaScenes = [scene("scene_prompt_commit", "Prompt commit scene", "", 0)];
  const control = routeControl();
  await prepare(page, state, control);
  await openInspector(page);

  const inspector = page.locator(".scene-inspector");
  const prompt = inspector.getByLabel("Prompt");
  const run = inspector.getByRole("button", { name: "Run", exact: true });
  await expect(inspector.getByLabel("Default video model").locator('option[value="provider_video"]')).toHaveText("seedance-ui2 · example.invalid");
  await expect(page.locator("body")).not.toContainText("seedance-ui2 · seedance-ui2");
  if (process.env.LING_CAPTURE_UI2_EVIDENCE === "1") {
    await page.screenshot({ animations: "disabled", fullPage: true, path: "test-results/media-model-label.png" });
  }

  await expect(run).toBeEnabled();
  await run.click();
  await expect(prompt).toBeFocused();
  await expect(inspector.getByText("Enter a prompt before running.", { exact: true })).toBeVisible();
  expect(control.runCalls.scene_prompt_commit ?? 0).toBe(0);
  expect(state.mediaJobs).toHaveLength(0);
  expect(state.mediaSceneRuns).toHaveLength(0);

  control.failNextSceneUpdate = 1;
  await prompt.fill("Keep this draft when saving fails.");
  await run.click();
  await expect(inspector.getByRole("alert").filter({ hasText: "Could not save this scene." })).toBeVisible();
  expect(control.runCalls.scene_prompt_commit ?? 0).toBe(0);
  expect(state.mediaJobs).toHaveLength(0);

  await prompt.fill("Use the current visible prompt without requiring a blur.");
  await run.click();
  await expect.poll(() => control.runCalls.scene_prompt_commit ?? 0).toBe(1);
  expect(control.requestOrder.slice(-2)).toEqual(["patch:prompt", "run:scene_prompt_commit"]);
  expect(state.mediaScenes[0].prompt).toBe("Use the current visible prompt without requiring a blur.");
  expect(state.mediaJobs[0]?.prompt).toBe("Use the current visible prompt without requiring a blur.");
  expect(errors).toEqual([]);
});

test("MP-I2V uploads reusable images, imports generated results, and requires an explicit first-frame choice", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = directFixture();
  state.providers = [
    seedanceProvider("provider_seedance_20", "doubao-seedance-2-0-260128", "Seedance 2.0"),
    seedanceProvider("provider_seedance_15", "doubao-seedance-1-5-pro-251215", "Seedance 1.5"),
  ];
  state.mediaProjects[0].defaultProviderPresetId = "provider_seedance_20";
  state.mediaScenes = [{ ...scene("scene_i2v", "Image to video", "Camera moves around the subject", 0), providerPresetId: "provider_seedance_20" }];
  state.mediaJobs = [job("job_generated_source", "succeeded", "2026-07-23T04:00:00.000Z", undefined, ["artifact_generated_source"])];
  state.artifactsByMediaJob.job_generated_source = [artifact("artifact_generated_source", "job_generated_source")];
  const control = routeControl();
  control.assetCreateDelayMs = 180;
  await prepare(page, state, control);
  await openInspector(page);

  const inspector = page.locator(".scene-inspector");
  await expect(inspector.getByText("Image inputs", { exact: true })).toBeVisible();
  await inspector.locator(".scene-video-image-file-input").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G7sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(inspector.getByText("Uploading", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  expect(control.runCalls.scene_i2v ?? 0).toBe(0);
  await expect.poll(() => state.mediaProjectAssets).toHaveLength(1);
  await expect.poll(() => state.mediaScenes[0].videoImageInputs).toEqual([{ assetId: "media_project_asset_1", role: "reference_image" }]);
  await expect(inspector.getByText("Selected 1 of 9", { exact: true })).toBeVisible();

  await inspector.getByRole("button", { name: "Project images", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Choose project images" });
  await library.getByRole("tab", { name: "Generated images" }).click();
  await library.getByRole("button", { name: "Add to project" }).click();
  await expect.poll(() => state.mediaProjectAssets).toHaveLength(2);
  await library.getByRole("button", { name: "Use selected images" }).click();
  await expect(library).toHaveCount(0);
  await expect.poll(() => state.mediaScenes[0].videoImageInputs).toEqual([
    { assetId: "media_project_asset_1", role: "reference_image" },
    { assetId: "media_project_asset_2", role: "reference_image" },
  ]);
  const lightScreenshot = await page.screenshot({ path: "test-results/media-i2v-light-1440x1000.png", animations: "disabled", caret: "hide" });
  await test.info().attach("media-i2v-light-1440x1000", { body: lightScreenshot, contentType: "image/png" });

  await inspector.getByLabel("Default video model").selectOption("provider_seedance_15");
  await expect(inspector.getByText("Current model does not support reference images.", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await inspector.getByRole("radio", { name: "Starting frame", exact: true }).click();
  const firstFrame = page.getByRole("dialog", { name: "Choose a starting frame" });
  await expect(firstFrame).toBeVisible();
  await firstFrame.getByRole("button", { name: /artifact_generated_source/u }).click();
  await firstFrame.getByRole("button", { name: "Use selected images" }).click();
  await expect.poll(() => state.mediaScenes[0].videoImageInputs).toEqual([{ assetId: "media_project_asset_1", role: "first_frame" }]);
  await expect(inspector.getByText("Starting frame", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Upload image", exact: true })).toBeDisabled();
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-dark" }));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ mode: "fixed", themeId: "ling-dark" }));
  });
  await page.reload();
  await openInspector(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".scene-inspector").getByText("Starting frame", { exact: true })).toBeVisible();
  await page.locator(".scene-inspector-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(".scene-inspector").getByText("Image inputs", { exact: true })).toBeVisible();
  const darkScreenshot = await page.screenshot({ path: "test-results/media-i2v-dark-1280x800.png", animations: "disabled", caret: "hide" });
  await test.info().attach("media-i2v-dark-1280x800", { body: darkScreenshot, contentType: "image/png" });
  expect(errors).toEqual([]);
});

test("MP-I2V keeps delayed uploads gated across scene navigation", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = directFixture();
  state.providers = [seedanceProvider("provider_seedance_20", "doubao-seedance-2-0-260128", "Seedance 2.0")];
  state.mediaProjects[0].defaultProviderPresetId = "provider_seedance_20";
  state.mediaScenes = [
    { ...scene("scene_i2v_pending", "Pending image scene", "Move around the subject", 0), providerPresetId: "provider_seedance_20" },
    { ...scene("scene_i2v_ready", "Ready text scene", "A slow camera push", 1), providerPresetId: "provider_seedance_20" },
  ];
  const control = routeControl();
  control.assetCreateGate = deferred<void>();
  await prepare(page, state, control);
  await openInspector(page);

  const inspector = page.locator(".scene-inspector");
  await inspector.locator(".scene-video-image-file-input").setInputFiles({
    name: "delayed-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G7sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(inspector.getByText("Uploading", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await page.locator(".storyboard-scene-node").nth(1).click();
  await expect(inspector).toHaveAttribute("data-scene-id", "scene_i2v_ready");
  await expect(page.locator(".media-production-primary-action")).toContainText("1 scene");
  await page.locator(".media-production-primary-action").click();
  const review = page.locator('[data-media-production-dialog="project-run-review"]');
  await expect(review.locator('[data-project-run-ready-count="1"]')).toBeVisible();
  await expect(review.locator('[data-project-run-skipped-count="1"]')).toBeVisible();
  await expect(review.getByText("Pending image scene", { exact: true })).toBeVisible();
  await expect(review.getByText("Finish or remove pending image uploads before running.", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(control.runCalls.scene_i2v_pending ?? 0).toBe(0);

  await page.locator(".storyboard-scene-node").first().click();
  await expect(inspector).toHaveAttribute("data-scene-id", "scene_i2v_pending");
  await expect(inspector.getByText("Uploading", { exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  control.assetCreateGate.resolve();
  await expect.poll(() => state.mediaScenes[0].videoImageInputs).toEqual([
    { assetId: "media_project_asset_1", role: "reference_image" },
  ]);
  await expect(inspector.getByText("Uploading", { exact: true })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  expect(control.runCalls.scene_i2v_pending ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test("MP-I2V preserves independent uploads started from different scenes", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = directFixture();
  state.providers = [seedanceProvider("provider_seedance_20", "doubao-seedance-2-0-260128", "Seedance 2.0")];
  state.mediaProjects[0].defaultProviderPresetId = "provider_seedance_20";
  state.mediaScenes = [
    { ...scene("scene_i2v_first", "First image scene", "Move around the first subject", 0), providerPresetId: "provider_seedance_20" },
    { ...scene("scene_i2v_second", "Second image scene", "Move around the second subject", 1), providerPresetId: "provider_seedance_20" },
  ];
  const control = routeControl();
  control.assetCreateGate = deferred<void>();
  await prepare(page, state, control);
  await openInspector(page);

  const inspector = page.locator(".scene-inspector");
  await inspector.locator(".scene-video-image-file-input").setInputFiles({
    name: "first.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G7sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(inspector.getByText("Uploading", { exact: true })).toBeVisible();

  await page.locator(".storyboard-scene-node").nth(1).click();
  await expect(inspector).toHaveAttribute("data-scene-id", "scene_i2v_second");
  await inspector.locator(".scene-video-image-file-input").setInputFiles({
    name: "second.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G7sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(inspector.getByText("Uploading", { exact: true })).toBeVisible();

  control.assetCreateGate.resolve();
  await expect.poll(() => state.mediaScenes.find((item) => item.id === "scene_i2v_first")?.videoImageInputs).toHaveLength(1);
  await expect.poll(() => state.mediaScenes.find((item) => item.id === "scene_i2v_second")?.videoImageInputs).toHaveLength(1);
  await expect(inspector.getByText("Uploading", { exact: true })).toHaveCount(0);

  await page.locator(".storyboard-scene-node").first().click();
  await expect(inspector).toHaveAttribute("data-scene-id", "scene_i2v_first");
  await expect(inspector.getByText("Uploading", { exact: true })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  expect(control.runCalls.scene_i2v_first ?? 0).toBe(0);
  expect(control.runCalls.scene_i2v_second ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test("MP-09 workflow source drift exposes one repair route and never mixes direct controls", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = workflowFixture();
  const control = routeControl();
  control.actionDelayMs = 250;
  await prepare(page, state, control);
  await openInspector(page);
  const inspector = page.locator(".scene-inspector");

  await expect(inspector).toHaveAttribute("data-scene-id", "scene_workflow");
  await expect(inspector.locator(".scene-execution-settings")).toHaveAttribute("data-scene-source", "workflow");
  await expect(inspector.getByLabel("Default production workflow")).toBeVisible();
  await expect(inspector.getByLabel("Default video model")).toHaveCount(0);
  const repair = inspector.getByRole("button", { name: "Configure production workflow", exact: true });
  await expect(repair).toBeVisible();
  await repair.click();
  const workflowDialog = page.locator('[role="dialog"][data-media-production-dialog="workflow-library"]');
  await expect(workflowDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(workflowDialog).toHaveCount(0);

  await inspector.getByLabel("Default production workflow").selectOption("workflow_ready");
  await expect(inspector.getByLabel("Negative prompt")).toBeVisible();
  await expect(inspector.getByLabel("Seed")).toHaveAttribute("data-ling-input-native", "true");
  await expect(inspector.getByRole("checkbox", { name: "Use upscale" })).toBeVisible();
  await inspector.getByLabel("Negative prompt").fill("No glare or camera shake");
  await inspector.getByLabel("Negative prompt").blur();
  await expect.poll(() => state.mediaScenes[0].workflowInputValues.negative).toBe("No glare or camera shake");

  control.failNextSceneUpdate = 1;
  const reference = inspector.getByLabel("Reference image");
  await reference.selectOption("artifact_reference");
  const referenceFailure = inspector.getByRole("alert").filter({ hasText: "Could not save this scene." });
  await expect(referenceFailure).toBeVisible();
  await expect(reference).toHaveValue("artifact_reference");
  expect(state.mediaScenes[0].referenceArtifactIds).toEqual([]);
  await referenceFailure.getByRole("button", { name: "Retry" }).click();
  await expect(referenceFailure).toHaveCount(0);
  await expect.poll(() => state.mediaScenes[0].referenceArtifactIds).toEqual(["artifact_reference"]);
  await expect(inspector.getByLabel("Default video model")).toHaveCount(0);

  await inspector.getByLabel("Default production method").selectOption("direct");
  await expect(inspector.locator(".scene-execution-settings")).toHaveAttribute("data-scene-source", "direct");
  await expect(inspector.getByLabel("Default video model")).toBeVisible();
  await expect(inspector.getByLabel("Default production workflow")).toHaveCount(0);
  await expect(inspector.getByLabel("Negative prompt")).toHaveCount(0);
  await inspector.getByRole("button", { name: "Run", exact: true }).dblclick();
  await expect.poll(() => control.runCalls.scene_workflow ?? 0).toBe(1);
  expect(errors).toEqual([]);
});

test("MP-10 result and history retain the old result while cancel and select stay single-flight", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = runHistoryFixture();
  const control = routeControl();
  control.actionDelayMs = 250;
  await prepare(page, state, control);
  await openInspector(page);
  const inspector = page.locator(".scene-inspector");

  await inspector.getByRole("tab", { name: "Generated result" }).click();
  const result = inspector.locator(".scene-result-view");
  await expect(result).toHaveAttribute("data-result-state", "updating");
  await expect(result.locator('[data-media-preview-artifact="artifact_current"]')).toBeVisible();
  await expect(result.locator(".ling-ui-status-indicator")).toHaveCount(1);
  await expect(result.locator(".ling-ui-inline-feedback")).toHaveCount(0);

  await inspector.getByRole("tab", { name: /History/ }).click();
  await expect(inspector.locator(".scene-run-entry")).toHaveCount(4);
  await expect(inspector.locator(".scene-run-row .ling-ui-status-indicator")).toHaveCount(4);
  const failedRun = inspector.locator('[data-run-id="run_failed"]');
  await expect(failedRun.locator(".ling-ui-inspector-section-body")).toBeHidden();

  const activeRun = inspector.locator('[data-run-id="run_active"]');
  await expect(activeRun.locator("small")).toContainText("Jul");
  await activeRun.getByRole("button", { name: "Cancel" }).dblclick();
  await expect.poll(() => control.cancelCalls.run_active ?? 0).toBe(1);
  await expect.poll(() => state.mediaJobs.find((job) => job.id === "job_active")?.status).toBe("cancelled");

  const candidateRun = inspector.locator('[data-run-id="run_candidate"]');
  await candidateRun.getByRole("button", { name: "Set default" }).dblclick();
  await expect.poll(() => control.selectCalls.run_candidate ?? 0).toBe(1);
  await expect.poll(() => state.mediaScenes[0].selectedMediaSceneRunId).toBe("run_candidate");

  await inspector.getByRole("tab", { name: "Generated result" }).click();
  await expect(result.locator('[data-media-preview-artifact="artifact_candidate"]')).toBeVisible();
  await expect(result.locator(".scene-latest-run-issue")).toBeVisible();
  await expect(result.locator(".ling-ui-status-indicator")).toHaveCount(0);
  await expect(result.locator(".ling-ui-inline-feedback")).toHaveCount(1);
  await expect(result.locator(".scene-latest-run-issue .ling-ui-inspector-section-body")).toBeHidden();
  await result.locator(".scene-latest-run-issue .ling-ui-inspector-section-trigger").click();
  await expect(result.locator(".scene-latest-run-issue .ling-ui-inspector-section-body")).toBeVisible();
  await expect(result.locator(".scene-latest-run-issue .ling-ui-inspector-section-body")).not.toBeEmpty();
  expect(errors).toEqual([]);
});

test("MP-10 closing and reopening Inspector preserves selection, active tab, and Canvas geometry", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = runHistoryFixture();
  await prepare(page, state, routeControl());
  await openInspector(page);
  const inspector = page.locator(".scene-inspector");
  await inspector.getByRole("tab", { name: /History/ }).click();
  const canvas = page.locator(".storyboard-canvas");
  const geometry = await canvas.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
  const selectedTitle = await page.locator(".storyboard-scene-node.selected strong").innerText();

  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".media-production-dock-panel.right")).not.toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Expand" }).click();
  await expect(page.locator(".media-production-dock-panel.right")).toHaveClass(/is-open/);
  await expect(inspector.getByRole("tab", { name: /History/ })).toHaveAttribute("data-state", "active");
  await expect(inspector.locator(".scene-run-history")).toBeVisible();
  await expect(page.locator(".storyboard-scene-node.selected strong")).toHaveText(selectedTitle);
  await expect(canvas).toHaveJSProperty("clientWidth", geometry.width);
  await expect(canvas).toHaveJSProperty("clientHeight", geometry.height);
  expect(state.mediaScenes[0].id).toBe("scene_run");
  expect(errors).toEqual([]);
});

test("MP-10 Inspector duplicate, delete, and close actions keep typed busy contracts", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = directFixture();
  const control = routeControl();
  control.actionDelayMs = 500;
  await prepare(page, state, control);
  await openInspector(page);

  const inspector = page.locator(".scene-inspector");
  const duplicate = inspector.getByRole("button", { name: "Duplicate" });
  const deleteAction = inspector.getByRole("button", { name: "Delete", exact: true });
  const close = inspector.getByRole("button", { name: "Close", exact: true });
  await assertTypedIconButton(duplicate, "Duplicate");
  await assertTypedIconButton(deleteAction, "Delete");
  await assertTypedIconButton(close, "Close");

  await duplicate.click();
  await expect(duplicate).toHaveAttribute("aria-busy", "true");
  await expect(duplicate).toBeDisabled();
  await expect.poll(() => control.duplicateCalls.scene_direct_a ?? 0).toBe(1);
  await expect.poll(() => state.mediaScenes).toHaveLength(3);
  await expect(inspector).toHaveAttribute("data-scene-id", "media_scene_3");

  const deleteRequestStarted = deferred<void>();
  const releaseDeleteRequest = deferred<void>();
  await page.route(/\/media-scenes\/media_scene_3(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "DELETE") {
      deleteRequestStarted.resolve();
      await releaseDeleteRequest.promise;
    }
    await route.fallback();
  });
  const duplicateDelete = inspector.locator('.scene-inspector-actions button[data-variant="danger"]');
  await duplicateDelete.click();
  const dialog = page.locator('[data-media-production-dialog="delete-scene"]');
  const confirm = dialog.locator('button[data-variant="danger"]');
  await confirm.click();
  await deleteRequestStarted.promise;
  try {
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(confirm).toHaveAttribute("aria-busy", "true");
    await expect(confirm).toBeDisabled();
    await expect(duplicateDelete).toHaveAttribute("aria-busy", "true");
    await expect(duplicateDelete).toBeDisabled();
  } finally {
    releaseDeleteRequest.resolve();
  }
  await expect.poll(() => control.deleteCalls.media_scene_3 ?? 0).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.mediaScenes).toHaveLength(2);

  const currentClose = inspector.getByRole("button", { name: "Close", exact: true });
  await currentClose.click();
  await expect(page.locator(".media-production-dock-panel.right")).not.toHaveClass(/is-open/u);
  expect(errors).toEqual([]);
});

interface InspectorRouteControl {
  failNextSceneUpdate: number;
  sceneUpdateCalls: number;
  actionDelayMs: number;
  assetCreateDelayMs: number;
  assetCreateGate?: ReturnType<typeof deferred<void>>;
  runCalls: Record<string, number>;
  cancelCalls: Record<string, number>;
  selectCalls: Record<string, number>;
  duplicateCalls: Record<string, number>;
  deleteCalls: Record<string, number>;
  requestOrder: string[];
}

function routeControl(): InspectorRouteControl {
  return { failNextSceneUpdate: 0, sceneUpdateCalls: 0, actionDelayMs: 0, assetCreateDelayMs: 0, runCalls: {}, cancelCalls: {}, selectCalls: {}, duplicateCalls: {}, deleteCalls: {}, requestOrder: [] };
}

async function prepare(page: Page, state: MockState, control: InspectorRouteControl): Promise<void> {
  await mockDaemon(page, state);
  await page.route("http://127.0.0.1:17891/**", async (route) => handleInspectorRoute(route, control));
  await page.goto("/");
}

async function handleInspectorRoute(route: Route, control: InspectorRouteControl): Promise<void> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && /^\/media-projects\/[^/]+\/assets$/u.test(path)) {
    if (control.assetCreateGate) await control.assetCreateGate.promise;
    await delay(control.assetCreateDelayMs);
  }
  if (request.method() === "PATCH" && /^\/media-scenes\/[^/]+$/u.test(path)) {
    control.sceneUpdateCalls += 1;
    const body = await request.postDataJSON() as { readonly prompt?: unknown };
    if (typeof body.prompt === "string") control.requestOrder.push("patch:prompt");
    if (control.failNextSceneUpdate > 0) {
      control.failNextSceneUpdate -= 1;
      await route.fulfill({ json: { fixtureError: "scene_update_failed" } });
      return;
    }
  }
  const duplicateMatch = /^\/media-scenes\/([^/]+)\/duplicate$/u.exec(path);
  if (request.method() === "POST" && duplicateMatch) {
    const sceneId = decodeURIComponent(duplicateMatch[1] ?? "");
    control.duplicateCalls[sceneId] = (control.duplicateCalls[sceneId] ?? 0) + 1;
    await delay(control.actionDelayMs);
  }
  const deleteMatch = /^\/media-scenes\/([^/]+)$/u.exec(path);
  if (request.method() === "DELETE" && deleteMatch) {
    const sceneId = decodeURIComponent(deleteMatch[1] ?? "");
    control.deleteCalls[sceneId] = (control.deleteCalls[sceneId] ?? 0) + 1;
    await delay(control.actionDelayMs);
  }
  const runMatch = /^\/media-scenes\/([^/]+)\/run$/u.exec(path);
  if (request.method() === "POST" && runMatch) {
    const sceneId = decodeURIComponent(runMatch[1] ?? "");
    control.runCalls[sceneId] = (control.runCalls[sceneId] ?? 0) + 1;
    control.requestOrder.push(`run:${sceneId}`);
    await delay(control.actionDelayMs);
  }
  const cancelMatch = /^\/media-scene-runs\/([^/]+)\/cancel$/u.exec(path);
  if (request.method() === "POST" && cancelMatch) {
    const runId = decodeURIComponent(cancelMatch[1] ?? "");
    control.cancelCalls[runId] = (control.cancelCalls[runId] ?? 0) + 1;
    await delay(control.actionDelayMs);
  }
  const selectMatch = /^\/media-scenes\/[^/]+\/select-run$/u.exec(path);
  if (request.method() === "POST" && selectMatch) {
    const body = await request.postDataJSON() as { readonly mediaSceneRunId?: string };
    const runId = body.mediaSceneRunId ?? "";
    control.selectCalls[runId] = (control.selectCalls[runId] ?? 0) + 1;
    await delay(control.actionDelayMs);
  }
  await route.fallback();
}

async function openInspector(page: Page): Promise<void> {
  await openMediaProduction(page);
  await expect(page.locator(".storyboard-scene-node").first()).toBeVisible();
  await page.locator(".storyboard-scene-node").first().click();
  await expect(page.locator(".media-production-dock-panel.right")).toHaveClass(/is-open/);
}

function directFixture(): MockState {
  const state = baseProductionFixture();
  state.mediaScenes = [
    scene("scene_direct_a", "Direct scene A", "Authoritative prompt A", 0),
    scene("scene_direct_b", "Direct scene B", "Authoritative prompt B", 1),
  ];
  return state;
}

function workflowFixture(): MockState {
  const state = baseProductionFixture();
  state.mediaScenes = [{ ...scene("scene_workflow", "Workflow scene", "Workflow prompt", 0), executionMode: "workflow", workflowDefinitionId: "workflow_archived" }];
  state.mediaWorkflows = [workflow("workflow_archived", "Archived workflow", "archived"), workflow("workflow_ready", "Ready workflow", "ready")];
  state.mediaJobs = [job("job_reference", "succeeded", "2026-07-22T23:00:00.000Z", undefined, ["artifact_reference"])];
  state.artifactsByMediaJob.job_reference = [artifact("artifact_reference", "job_reference")];
  return state;
}

function runHistoryFixture(): MockState {
  const state = baseProductionFixture();
  state.mediaScenes = [{ ...scene("scene_run", "Run history scene", "A composed studio shot", 0), providerPresetId: "provider_video", selectedMediaSceneRunId: "run_current" }];
  state.mediaSceneRuns = [
    sceneRun("run_active", "job_active", "2026-07-23T03:00:00.000Z"),
    sceneRun("run_candidate", "job_candidate", "2026-07-23T02:00:00.000Z"),
    sceneRun("run_current", "job_current", "2026-07-23T01:00:00.000Z"),
    sceneRun("run_failed", "job_failed", "2026-07-23T00:00:00.000Z"),
  ];
  state.mediaJobs = [
    job("job_active", "running", "2026-07-23T03:00:00.000Z", "Cancelled regeneration"),
    job("job_candidate", "succeeded", "2026-07-23T02:00:00.000Z", undefined, ["artifact_candidate"]),
    job("job_current", "succeeded", "2026-07-23T01:00:00.000Z", undefined, ["artifact_current"]),
    job("job_failed", "failed", "2026-07-23T00:00:00.000Z", "Provider rejected the previous request"),
  ];
  state.artifactsByMediaJob.job_candidate = [artifact("artifact_candidate", "job_candidate")];
  state.artifactsByMediaJob.job_current = [artifact("artifact_current", "job_current")];
  return state;
}

function baseProductionFixture(): MockState {
  const state = createBaseState({});
  state.providers = [videoProvider()];
  state.mediaProjects = [{
    id: "project_ui2_inspector",
    workspaceId: "workspace_default",
    name: "Inspector project",
    defaultProviderPresetId: "provider_video",
    defaultExecutionMode: "direct",
    canvasViewport: { x: 0, y: 0, zoom: 1 },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }];
  return state;
}

function scene(id: string, title: string, prompt: string, sortOrder: number): MockState["mediaScenes"][number] {
  return { id, projectId: "project_ui2_inspector", sortOrder, title, prompt, executionMode: "direct", workflowInputValues: {}, ratio: "16:9", durationSeconds: 5, referenceArtifactIds: [], canvasPosition: { x: 80 + sortOrder * 300, y: 96 }, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" };
}

function videoProvider(): Record<string, unknown> {
  return { id: "provider_video", kind: "seedance", displayName: "Studio Video", providerId: "seedance", model: "seedance-ui2", api: "media-job", baseUrl: "https://example.invalid/v3", apiKeyRef: "env:VIDEO_KEY", apiKeyConfigured: true, headers: {}, input: ["text"], compat: { mediaVendorTransport: { mode: "live" } }, capabilities: ["video_generate"], enabled: true, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" };
}

function seedanceProvider(id: string, model: string, displayName: string): Record<string, unknown> {
  return { ...videoProvider(), id, model, displayName, input: ["text", "image"] };
}

function workflow(id: string, name: string, status: "ready" | "archived"): Record<string, unknown> {
  const version = { id: `${id}_version`, workflowDefinitionId: id, version: 1, sourceFormat: "comfy_api_json", sourceDigest: `${id}_digest`, graphSnapshot: {}, inputFields: [
    { id: "prompt", label: "Prompt", kind: "text", semantic: "prompt", required: true, nodeId: "1", inputName: "text" },
    { id: "negative", label: "Negative prompt", kind: "text", semantic: "negative_prompt", required: false, nodeId: "1", inputName: "negative" },
    { id: "seed", label: "Seed", kind: "number", semantic: "seed", required: false, nodeId: "2", inputName: "seed", defaultValue: 7 },
    { id: "upscale", label: "Use upscale", kind: "boolean", semantic: "custom", required: false, nodeId: "3", inputName: "enabled", defaultValue: false },
    { id: "reference", label: "Reference image", kind: "image_artifact", semantic: "reference_image", required: false, nodeId: "3", inputName: "image" },
  ], outputRules: [{ nodeId: "4", artifactType: "video", collect: "first" }], validation: { ok: true, errors: [], warnings: [], checkedAt: "2026-07-23T00:00:00.000Z" }, createdAt: "2026-07-23T00:00:00.000Z" };
  return { definition: { id, workspaceId: "workspace_default", connectionId: "connection_ready", name, status, currentVersionId: status === "ready" ? version.id : undefined, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z" }, currentVersion: status === "ready" ? version : undefined, versions: [version] };
}

function sceneRun(id: string, mediaJobId: string, createdAt: string): MockState["mediaSceneRuns"][number] {
  return { id, projectId: "project_ui2_inspector", sceneId: "scene_run", mediaJobId, providerSnapshot: { providerPresetId: "provider_video" }, executionSnapshot: { kind: "provider", providerPresetId: "provider_video", displayName: "Studio Video" }, inputSnapshot: { prompt: "A composed studio shot" }, createdAt, updatedAt: createdAt };
}

function job(id: string, status: MockState["mediaJobs"][number]["status"], createdAt: string, errorMessage?: string, artifactIds: string[] = []): MockState["mediaJobs"][number] {
  return { id, workspaceId: "workspace_default", providerPresetId: "provider_video", executionSource: { kind: "provider", providerPresetId: "provider_video" }, operation: "video_generate", prompt: "A composed studio shot", input: { ratio: "16:9", duration: 5 }, artifactIds, status, errorMessage, createdAt, updatedAt: createdAt };
}

function artifact(id: string, mediaJobId: string): MockState["artifactsByMediaJob"][string][number] {
  return { id, mediaJobId, type: "image", path: `media/${id}.svg`, title: id, contentType: "image/svg+xml", sizeBytes: 4096, createdAt: "2026-07-23T00:00:00.000Z" };
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console:${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

async function assertTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  await expect(button.locator('svg[data-ling-icon=""]')).toHaveCount(1);
  const box = await button.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  await button.evaluate((element) => (element as HTMLButtonElement).blur());
  await button.page().mouse.move(0, 0);
  await expect(button.page().getByRole("tooltip")).toHaveCount(0);
  await button.page().waitForTimeout(200);
  await button.hover();
  const tooltip = button.page().getByRole("tooltip").filter({ hasText: label });
  await expect(tooltip).toBeVisible();
  await button.page().mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve: (value?: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
