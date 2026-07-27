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
  runCalls: Record<string, number>;
  cancelCalls: Record<string, number>;
  selectCalls: Record<string, number>;
  duplicateCalls: Record<string, number>;
  deleteCalls: Record<string, number>;
}

function routeControl(): InspectorRouteControl {
  return { failNextSceneUpdate: 0, sceneUpdateCalls: 0, actionDelayMs: 0, runCalls: {}, cancelCalls: {}, selectCalls: {}, duplicateCalls: {}, deleteCalls: {} };
}

async function prepare(page: Page, state: MockState, control: InspectorRouteControl): Promise<void> {
  await mockDaemon(page, state);
  await page.route("http://127.0.0.1:17891/**", async (route) => handleInspectorRoute(route, control));
  await page.goto("/");
}

async function handleInspectorRoute(route: Route, control: InspectorRouteControl): Promise<void> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "PATCH" && /^\/media-scenes\/[^/]+$/u.test(path)) {
    control.sceneUpdateCalls += 1;
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
