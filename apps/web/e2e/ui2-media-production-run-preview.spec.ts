import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { createBaseState, createMediaProvider } from "./support/mock-state";
import { openMediaProduction } from "./support/media-production-fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
});

test("MP-15 project review has no submit at zero ready and only submits ready scenes once", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const emptyState = productionState({ sceneCount: 2, readySceneIds: [] });
  await prepare(page, emptyState);
  await openMediaProduction(page);

  await page.locator(".media-production-primary-action").click();
  const emptyReview = page.locator('[data-media-production-dialog="project-run-review"]');
  await expect(emptyReview).toBeVisible();
  await expect(emptyReview).not.toHaveAttribute("data-busy", "true");
  await expect(emptyReview.locator('[data-project-run-ready-count="0"]')).toBeVisible();
  await expect(emptyReview.getByRole("button", { name: /^Run/u })).toHaveCount(0);
  await emptyReview.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(emptyReview).toHaveCount(0);

  const mixedState = productionState({ sceneCount: 3, readySceneIds: ["scene_run_1", "scene_run_3"] });
  const control = runControl();
  control.failNextRun = 1;
  control.delayMs = 250;
  await prepare(page, mixedState, control);
  await openMediaProduction(page);

  const runTrigger = page.locator(".media-production-primary-action");
  await runTrigger.click();
  const review = page.locator('[data-media-production-dialog="project-run-review"]');
  await expect(review.locator('[data-project-run-ready-count="2"]')).toBeVisible();
  await expect(review.locator('[data-project-run-skipped-count="1"]')).toBeVisible();
  await assertNoHorizontalOverflow(page, review);
  const confirm = review.getByRole("button", { name: /^Run/u });
  await confirm.dblclick();
  await expect(review.getByRole("alert")).toContainText("Could not start this media project.");
  expect(control.projectRunCalls).toBe(1);
  expect(control.requestedSceneIds).toEqual([["scene_run_1", "scene_run_3"]]);

  control.delayMs = 0;
  await confirm.click();
  await expect(review).toHaveCount(0);
  expect(control.projectRunCalls).toBe(2);
  expect(control.requestedSceneIds).toEqual([
    ["scene_run_1", "scene_run_3"],
    ["scene_run_1", "scene_run_3"],
  ]);
  await expect(runTrigger).toBeFocused();
  expect(errors).toEqual([]);
});

test("MP-16 image preview retries only content, downloads safely, and preserves selection", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = previewState("image");
  state.mediaScenes[0] = {
    ...state.mediaScenes[0]!,
    title: `Preview ${"long-scene-title-".repeat(32)}`,
  };
  const control = previewControl();
  control.failNextContent = 1;
  await prepare(page, state, undefined, control);
  await openMediaProduction(page);

  const selectedBefore = await page.locator(".storyboard-scene-node.selected").getAttribute("aria-label");
  const previewTrigger = page.getByRole("button", { name: /^Preview:/u });
  await previewTrigger.click();
  const dialog = page.locator('[data-media-production-dialog="scene-result-preview"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-media-preview-state="error"]')).toBeVisible();
  await dialog.getByRole("button", { name: "Retry preview" }).click();
  await expect(dialog.locator('[data-media-preview-state="ready"]')).toBeVisible();
  expect(control.contentCalls).toBe(2);
  expect(control.sceneRunCalls).toBe(0);
  await expect(page.locator(".storyboard-scene-node.selected")).toHaveAttribute("aria-label", selectedBefore ?? "");

  const download = dialog.getByRole("link", { name: "Download" });
  await expect(download).toHaveAttribute("download", "artifact_preview.svg");
  const href = await download.getAttribute("href");
  expect(href).toBeTruthy();
  const downloadUrl = new URL(href!, page.url());
  expect([...downloadUrl.searchParams.keys()]).toEqual(["cwd"]);
  expect(downloadUrl.pathname).toBe("/artifacts/artifact_preview/content");
  expect(control.artifactAuthorizationHeaders).toEqual(["", ""]);

  await expectNeutralEffectChain(dialog.locator("img"));
  await assertNoHorizontalOverflow(page, dialog);

  await dialog.getByRole("button", { name: "Close preview" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(previewTrigger).toBeFocused();
  await expect(page.locator(".storyboard-scene-node.selected")).toHaveAttribute("aria-label", selectedBefore ?? "");
  expect(errors).toEqual([]);
});

test("MP-16 video preview exposes controls and metadata loading without autoplay", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = previewState("video");
  const control = previewControl();
  control.videoDelayMs = 100;
  await prepare(page, state, undefined, control);
  await openMediaProduction(page);

  await page.getByRole("button", { name: /^Preview:/u }).click();
  const dialog = page.locator('[data-media-production-dialog="scene-result-preview"]');
  const video = dialog.locator("video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "metadata");
  await expect(video).not.toHaveAttribute("autoplay");
  expect(await video.evaluate((element) => (element as HTMLVideoElement).autoplay)).toBe(false);
  await expect(video.locator("xpath=..")).toHaveAttribute("data-media-preview-state", "ready");
  await expectNeutralEffectChain(video);
  await dialog.getByRole("button", { name: "Close preview" }).click();
  expect(errors).toEqual([]);
});

test("MP-17 Open task closes preview, selects the current Media Job, and keeps Reuse in P10.1", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = previewState("image", { workflow: true });
  await prepare(page, state);
  await openMediaProduction(page);

  await page.getByRole("button", { name: /^Preview:/u }).click();
  const preview = page.locator('[data-media-production-dialog="scene-result-preview"]');
  await expect(preview).toHaveAttribute("data-current-media-job", "job_preview");
  await preview.getByRole("button", { name: "Open task" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator(".media-production-jobs-view")).toBeVisible();
  await expect(page.locator('[data-media-job-row="job_preview"]')).toHaveAttribute("data-selected", "true");
  const inspector = page.locator('[data-media-job-inspector="job_preview"]');
  await assertNoHorizontalOverflow(page, page.locator(".media-production-jobs-view"));
  await expect(inspector).toContainText("Editorial workflow v1");
  await expect(inspector).toContainText("Preview project");
  const reuse = inspector.getByRole("button", { name: "Reuse settings" });
  await expect(reuse).toBeVisible();
  await reuse.click();
  await expect(page.getByRole("dialog", { name: "New generation task" })).toBeVisible();
  expect(errors).toEqual([]);
});

interface RunControl {
  projectRunCalls: number;
  failNextRun: number;
  delayMs: number;
  requestedSceneIds: string[][];
}

interface PreviewControl {
  contentCalls: number;
  failNextContent: number;
  sceneRunCalls: number;
  videoDelayMs: number;
  artifactAuthorizationHeaders: string[];
}

function runControl(): RunControl {
  return { projectRunCalls: 0, failNextRun: 0, delayMs: 0, requestedSceneIds: [] };
}

function previewControl(): PreviewControl {
  return { contentCalls: 0, failNextContent: 0, sceneRunCalls: 0, videoDelayMs: 0, artifactAuthorizationHeaders: [] };
}

async function prepare(
  page: Page,
  state: MockState,
  run?: RunControl,
  preview?: PreviewControl,
): Promise<void> {
  await mockDaemon(page, state);
  await page.route("http://127.0.0.1:17891/**", async (route) => handleS4Route(route, run, preview));
  await page.goto("/");
}

async function handleS4Route(route: Route, run?: RunControl, preview?: PreviewControl): Promise<void> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (run && request.method() === "POST" && /^\/media-projects\/[^/]+\/run$/u.test(path)) {
    run.projectRunCalls += 1;
    const body = await request.postDataJSON() as { readonly sceneIds?: readonly string[] };
    run.requestedSceneIds.push([...(body.sceneIds ?? [])]);
    await delay(run.delayMs);
    if (run.failNextRun > 0) {
      run.failNextRun -= 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{" });
      return;
    }
  }
  if (preview && request.method() === "POST" && /^\/media-scenes\/[^/]+\/run$/u.test(path)) {
    preview.sceneRunCalls += 1;
  }
  if (preview && request.method() === "GET" && path === "/artifacts/artifact_preview/content") {
    preview.contentCalls += 1;
    preview.artifactAuthorizationHeaders.push(request.headers().authorization ?? "");
    if (preview.failNextContent > 0) {
      preview.failNextContent -= 1;
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: "preview unavailable" });
      return;
    }
    if (preview.videoDelayMs > 0) {
      await delay(preview.videoDelayMs);
      await route.fulfill({ contentType: "video/mp4", body: Buffer.from(tinyMp4Base64, "base64") });
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#eff0f2"/><rect x="40" y="36" width="240" height="108" rx="8" fill="#17181a"/></svg>',
    });
    return;
  }
  await route.fallback();
}

function productionState(input: { readonly sceneCount: number; readonly readySceneIds: readonly string[] }): MockState {
  const state = createBaseState({});
  installVideoProvider(state);
  state.mediaProjects = [project("project_run")];
  state.mediaScenes = Array.from({ length: input.sceneCount }, (_, index) => {
    const id = `scene_run_${index + 1}`;
    return scene(id, `Run scene ${index + 1}`, index, input.readySceneIds.includes(id) ? `Ready prompt ${index + 1}` : "");
  });
  return state;
}

function previewState(type: "image" | "video", input: { readonly workflow?: boolean } = {}): MockState {
  const state = createBaseState({});
  installVideoProvider(state);
  state.mediaProjects = [{ ...project("project_preview"), name: "Preview project" }];
  state.mediaScenes = [{ ...scene("scene_preview", "Preview scene", 0, "Preview prompt"), selectedMediaSceneRunId: "run_preview" }];
  state.mediaSceneRuns = [{
    id: "run_preview",
    projectId: "project_preview",
    sceneId: "scene_preview",
    mediaJobId: "job_preview",
    providerSnapshot: input.workflow ? {} : { providerPresetId: "provider_preview_video" },
    executionSnapshot: input.workflow
      ? { kind: "workflow", workflowDefinitionId: "editorial_workflow", workflowName: "Editorial workflow" }
      : { kind: "provider", providerPresetId: "provider_preview_video" },
    inputSnapshot: { prompt: "Preview prompt" },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }];
  state.mediaJobs = [{
    id: "job_preview",
    workspaceId: "workspace_default",
    providerPresetId: input.workflow ? undefined : "provider_preview_video",
    workflowVersionId: input.workflow ? "editorial_workflow_v1" : undefined,
    executionSource: input.workflow
      ? { kind: "workflow", workflowVersionId: "editorial_workflow_v1" }
      : { kind: "provider", providerPresetId: "provider_preview_video" },
    operation: "video_generate",
    prompt: "Preview prompt",
    input: { ratio: "16:9", duration: 5 },
    artifactIds: ["artifact_preview"],
    status: "succeeded",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }];
  state.artifactsByMediaJob.job_preview = [{
    id: "artifact_preview",
    mediaJobId: "job_preview",
    type,
    path: type === "video" ? "artifact_preview.mp4" : "artifact_preview.svg",
    title: "Preview artifact",
    contentType: type === "video" ? "video/mp4" : "image/svg+xml",
    sizeBytes: 4096,
    createdAt: "2026-07-23T00:00:00.000Z",
  }];
  if (input.workflow) {
    state.mediaWorkflowConnections = [workflowConnection()];
    state.mediaWorkflows = [workflowDetail()];
  }
  return state;
}

function project(id: string): MockState["mediaProjects"][number] {
  return {
    id,
    workspaceId: "workspace_default",
    name: "Run project",
    defaultProviderPresetId: "provider_preview_video",
    defaultExecutionMode: "direct",
    canvasViewport: { x: 0, y: 0, zoom: 1 },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function scene(id: string, title: string, sortOrder: number, prompt: string): MockState["mediaScenes"][number] {
  return {
    id,
    projectId: id.startsWith("scene_preview") ? "project_preview" : "project_run",
    sortOrder,
    title,
    prompt,
    executionMode: "inherit",
    workflowInputValues: {},
    ratio: "16:9",
    durationSeconds: 5,
    referenceArtifactIds: [],
    canvasPosition: { x: 120 + sortOrder * 280, y: 120 },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
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
}

function workflowConnection(): Record<string, unknown> {
  return {
    id: "editorial_connection",
    workspaceId: "workspace_default",
    name: "Editorial connection",
    adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
    authMode: "none",
    secretConfigured: false,
    networkPolicy: "trusted_private_network",
    protocolVariant: "auto",
    status: "ready",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function workflowDetail(): Record<string, unknown> {
  const version = {
    id: "editorial_workflow_v1",
    workflowDefinitionId: "editorial_workflow",
    version: 1,
    sourceFormat: "comfy_api_json",
    sourceDigest: "editorial-fixture",
    graphSnapshot: {},
    inputFields: [],
    outputRules: [{ nodeId: "9", artifactType: "video", collect: "first" }],
    validation: { ok: true, errors: [], warnings: [], checkedAt: "2026-07-23T00:00:00.000Z" },
    createdAt: "2026-07-23T00:00:00.000Z",
  };
  return {
    definition: {
      id: "editorial_workflow",
      workspaceId: "workspace_default",
      connectionId: "editorial_connection",
      name: "Editorial workflow",
      status: "ready",
      currentVersionId: version.id,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    },
    currentVersion: version,
    versions: [version],
  };
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

async function assertNoHorizontalOverflow(page: Page, owner: Locator): Promise<void> {
  expect(await owner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectNeutralEffectChain(media: Locator): Promise<void> {
  await expect.poll(async () => media.evaluate((element) => {
    const invalid: Array<{ filter: string; opacity: string; mixBlendMode: string }> = [];
    let current: Element | null = element;
    while (current) {
      const style = getComputedStyle(current);
      if (style.filter !== "none" || style.opacity !== "1" || style.mixBlendMode !== "normal") {
        invalid.push({ filter: style.filter, opacity: style.opacity, mixBlendMode: style.mixBlendMode });
      }
      if (current.matches('[data-media-production-dialog="scene-result-preview"]')) break;
      current = current.parentElement;
    }
    return invalid;
  })).toEqual([]);
}

const tinyMp4Base64 = [
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAL7iAAAAAAAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsUAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAONAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDAAAAAIZnJlZQAAAuVtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiJsQr/+wAAAAAgBnkF5Cv/EgQ==",
].join("");
