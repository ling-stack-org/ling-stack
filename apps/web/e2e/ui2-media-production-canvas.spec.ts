import { inflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createDefaultProviderTemplates, createMediaProvider } from "./support/mock-state";
import {
  createEmptyMediaProductionFixture,
  createLoadedMediaProductionFixture,
  createMediaProductionRouteControl,
  installMediaProductionScenarioRoutes,
  openMediaProduction,
} from "./support/media-production-fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
});

test("MP-05 toolbar keeps the no-project shell stable and keyboard-switchable", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await prepare(page, createEmptyMediaProductionFixture());
  await openMediaProduction(page);

  const toolbar = page.locator(".media-production-canvas-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator(".media-production-project-trigger")).toContainText("Projects and scenes");
  await expect(toolbar.locator(".media-production-primary-action")).toHaveCount(0);
  const studio = toolbar.locator('[data-value="studio"]');
  const jobs = toolbar.locator('[data-value="jobs"]');
  await expect(studio).toHaveAttribute("data-state", "on");
  await studio.focus();
  await page.keyboard.press("ArrowRight");
  await expect(jobs).toHaveAttribute("data-state", "on");
  await expect(jobs).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".media-production-jobs-view")).toBeVisible();
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

test("MP-05 toolbar projects configure, check, and run without duplicate actions", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 });
  state.mediaProjects[0] = {
    ...state.mediaProjects[0]!,
    name: `Editorial ${"long-project-name-".repeat(24)}`,
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page, state);
  await openMediaProduction(page);

  const toolbar = page.locator(".media-production-canvas-toolbar");
  const projectTrigger = toolbar.locator(".media-production-project-trigger");
  await expect(projectTrigger).toHaveAttribute("title", state.mediaProjects[0]!.name);
  await expect(toolbar.getByRole("button", { name: "Configure video model" })).toBeVisible();
  await expect(toolbar.locator(".media-production-primary-action")).toHaveCount(1);
  await expect.poll(() => textIsEllipsized(projectTrigger.locator(".ling-ui-button-label"))).toBe(true);
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

test("MP-05 toolbar uses check for blocked scenes and run for ready scenes", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 });
  installVideoProvider(state);
  state.mediaScenes[0] = { ...state.mediaScenes[0]!, prompt: "" };
  state.mediaScenes[1] = { ...state.mediaScenes[1]!, prompt: "Ready editorial shot" };
  await prepare(page, state);
  await openMediaProduction(page);

  const action = page.locator(".media-production-primary-action");
  await expect(action).toContainText("Run");
  await expect(action).toContainText("1 scenes");
  await expect(action).toHaveCount(1);
  await page.locator('.media-production-view-switcher [data-value="jobs"]').click();
  await expect(action).toHaveCount(0);
  await page.locator('.media-production-view-switcher [data-value="studio"]').click();
  await expect(action).toContainText("Run");
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

test("MP-05 toolbar uses check when a generation source exists but no scene is ready", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 });
  installVideoProvider(state);
  state.mediaScenes = state.mediaScenes.map((scene) => ({ ...scene, prompt: "" }));
  await prepare(page, state);
  await openMediaProduction(page);

  const action = page.locator(".media-production-primary-action");
  await expect(action).toHaveText("Check");
  await expect(action).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("MP-06 zero and one-scene canvas keep stage geometry and fixed node size", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 0 });
  await prepare(page, state);
  await openMediaProduction(page);

  const stage = page.locator(".media-production-canvas-stage");
  const empty = page.locator(".storyboard-empty-canvas");
  await expect(empty).toBeVisible();
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(0);
  const beforeDock = await stableDimensions(stage);
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Close projects and scenes" }).click();
  const afterClose = await stableDimensions(stage);
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  const afterOpen = await stableDimensions(stage);
  expect(afterClose).toEqual(beforeDock);
  expect(afterOpen).toEqual(beforeDock);

  await empty.getByRole("button", { name: "Add scene" }).click();
  const node = page.locator(".storyboard-scene-node");
  await expect(node).toHaveCount(1);
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  expect(await node.evaluate((element) => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight })))
    .toEqual({ width: 218, height: 104 });
  expect(await stableDimensions(stage)).toEqual(beforeDock);
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

test("MP-06 100 sorted scenes fit far selection into the safe area without chrome overlap", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 100 });
  const farScene = state.mediaScenes[99]!;
  state.mediaScenes = state.mediaScenes.map((scene, index) => ({
    ...scene,
    sortOrder: 99 - index,
    title: scene.id === farScene.id ? `Far selected ${"long-title-".repeat(40)}` : scene.title,
    canvasPosition: scene.id === farScene.id
      ? { x: 48_000, y: -24_000 }
      : { x: 120 + index * 270, y: 120 + (index % 7) * 160 },
  }));
  installCurrentVideoResult(state, farScene.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await prepare(page, state);
  await openMediaProduction(page);

  const stage = page.locator(".media-production-canvas-stage");
  const stageBeforeDock = await stableDimensions(stage);
  await expect(stage).toHaveAttribute("data-exclusive-docks", "false");
  await expect(page.locator(".storyboard-scene-node")).toHaveCount(100);
  await expect(page.locator(".storyboard-canvas")).toHaveAttribute("data-motion-duration", "220");
  await expect(page.locator(".react-flow__minimap")).toHaveCount(1);
  await expect.poll(() => elementsOverlap(page, ".react-flow__minimap", ".media-production-dock-panel.left.is-open")).toBe(false);
  await expect(page.locator(".storyboard-scene-node-order").first()).toHaveText("01");
  await expect(page.locator(".storyboard-scene-node").first()).toContainText("Far selected");
  const longTitle = page.locator(".storyboard-scene-node").first().locator("strong");
  await expect.poll(() => textIsEllipsized(longTitle)).toBe(true);
  const nodeSizes = await page.locator(".storyboard-scene-node").evaluateAll((elements) => elements.map((element) => ({
    width: (element as HTMLElement).offsetWidth,
    height: (element as HTMLElement).offsetHeight,
  })));
  expect(new Set(nodeSizes.map((size) => `${size.width}x${size.height}`))).toEqual(new Set(["218x104"]));

  await page.locator(".project-outline-scene-main").first().click();
  await expect(page.locator(".media-production-dock-panel.left")).toHaveClass(/is-open/);
  await expect(page.locator(".media-production-dock-panel.right")).toHaveClass(/is-open/);
  const dockDurations = await page.locator(".media-production-dock-panel.right").evaluate((element) => getComputedStyle(element)
    .transitionDuration.split(",")
    .map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 0.001 : 1)));
  expect(Math.max(...dockDurations)).toBeLessThanOrEqual(0.25);
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await expect(page.locator(".storyboard-scene-preview")).toBeVisible();
  await expect.poll(async () => {
    const snapshot = await selectedSceneSafeAreaSnapshot(page);
    return snapshot.inside ? "inside" : JSON.stringify(snapshot);
  }).toBe("inside");
  expect(await stableDimensions(stage)).toEqual(stageBeforeDock);
  await expect.poll(() => elementsOverlap(page, ".media-production-canvas-toolbar", ".media-production-dock-rail.left")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".media-production-canvas-toolbar", ".media-production-dock-rail.right")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".media-production-dock-panel.right.is-open")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".react-flow__minimap", ".media-production-dock-panel.right.is-open")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".react-flow__controls", ".react-flow__minimap")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".storyboard-canvas-legend", ".react-flow__minimap")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".storyboard-scene-preview", ".media-production-canvas-toolbar")).toBe(false);
  await expect.poll(() => elementsOverlap(page, ".storyboard-scene-preview", ".media-production-dock-panel.right.is-open")).toBe(false);

  const screenshot = await page.locator(".storyboard-canvas").screenshot();
  const pixel = analyzePng(screenshot);
  expect(pixel.width).toBeGreaterThan(0);
  expect(pixel.height).toBeGreaterThan(0);
  expect(pixel.opaqueRatio).toBeGreaterThan(0.95);
  expect(pixel.uniqueColors).toBeGreaterThanOrEqual(16);
  expect(pixel.nonDominantRatio).toBeGreaterThanOrEqual(0.02);
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

test("MP-07 reduced motion makes focus and rapid dock transitions instantaneous and state-safe", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 3 });
  const originalOrder = state.mediaScenes.map((scene) => ({ id: scene.id, sortOrder: scene.sortOrder, position: scene.canvasPosition }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await prepare(page, state);
  await openMediaProduction(page);

  await expect(page.locator(".storyboard-canvas")).toHaveAttribute("data-motion-duration", "0");
  await page.locator(".project-outline-scene-main").nth(1).click();
  await expect(page.locator(".storyboard-scene-node.selected")).toContainText("Scene 001_02");
  const stage = page.locator(".media-production-canvas-stage");
  const stableStage = await stableDimensions(stage);
  await expect(stage).toHaveAttribute("data-exclusive-docks", "true");
  const rightDock = page.locator(".media-production-dock-panel.right");
  await expect(rightDock).toHaveClass(/is-open/);
  await expect(page.locator(".react-flow__viewport")).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "Collapse" }).click();
  await page.locator(".media-production-dock-rail.left").getByRole("button", { name: "Projects and scenes" }).click();
  await page.locator(".project-outline-scene-main").nth(1).click();
  await page.keyboard.press("Escape");
  await expect(rightDock).not.toHaveClass(/is-open/);
  expect(await stableDimensions(stage)).toEqual(stableStage);
  expect(state.mediaScenes.map((scene) => ({ id: scene.id, sortOrder: scene.sortOrder, position: scene.canvasPosition }))).toEqual(originalOrder);
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

test("MP-07 Dock toggles and Storyboard preview keep the typed icon contract", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 1 });
  const scene = state.mediaScenes[0]!;
  installCurrentVideoResult(state, scene.id);
  await prepare(page, state);
  await openMediaProduction(page);

  const leftToggle = page.locator(".media-production-dock-rail.left").getByRole("button");
  await assertTypedIconButton(leftToggle, "Close projects and scenes");
  await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
  await expect(leftToggle.locator(".lucide-panel-left-close")).toBeVisible();
  await leftToggle.click();
  await assertTypedIconButton(leftToggle, "Projects and scenes");
  await expect(leftToggle).toHaveAttribute("aria-pressed", "false");
  await expect(leftToggle.locator(".lucide-panel-left-open")).toBeVisible();

  const rightToggle = page.locator(".media-production-dock-rail.right").getByRole("button");
  await assertTypedIconButton(rightToggle, "Expand");
  await expect(rightToggle).toBeEnabled();
  await expect(rightToggle).toHaveAttribute("aria-pressed", "false");
  await expect(rightToggle.locator(".lucide-panel-right-open")).toBeVisible();

  await page.locator(".storyboard-scene-node").click();
  await assertTypedIconButton(rightToggle, "Collapse");
  await expect(rightToggle).toBeEnabled();
  await expect(rightToggle).toHaveAttribute("aria-pressed", "true");
  await expect(rightToggle.locator(".lucide-panel-right-close")).toBeVisible();
  await rightToggle.click();
  await assertTypedIconButton(rightToggle, "Expand");
  await expect(rightToggle).toHaveAttribute("aria-pressed", "false");
  await expect(rightToggle.locator(".lucide-panel-right-open")).toBeVisible();

  const preview = page.locator(".storyboard-scene-preview");
  const previewLabel = `Preview: ${scene.title}`;
  await assertTypedIconButton(preview, previewLabel);
  await expect(preview.locator(".lucide-play")).toBeVisible();
  const fill = await preview.locator("svg[data-ling-icon]").evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fill: style.fill };
  });
  expect(fill.fill).not.toBe("none");
  expect(fill.fill).toBe(fill.color);
  await assertNoDocumentOverflow(page);
  expect(errors).toEqual([]);
});

async function prepare(
  page: Page,
  state: ReturnType<typeof createEmptyMediaProductionFixture>,
): Promise<void> {
  const control = createMediaProductionRouteControl();
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaProductionScenarioRoutes(page, state, control);
  await page.goto("/");
}

function installVideoProvider(state: ReturnType<typeof createEmptyMediaProductionFixture>): void {
  const providerId = "provider_ui2_video";
  state.providers = [createMediaProvider({
    id: providerId,
    kind: "seedance",
    displayName: "UI2 Video",
    providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528",
    apiKeyRef: "env:UI2_VIDEO_KEY",
    capabilities: ["video_generate"],
    input: ["text", "image"],
    compat: { mediaVendorTransport: { mode: "live" } },
  })];
  state.mediaProjects[0] = { ...state.mediaProjects[0]!, defaultProviderPresetId: providerId };
}

function installCurrentVideoResult(
  state: ReturnType<typeof createEmptyMediaProductionFixture>,
  sceneId: string,
): void {
  const timestamp = "2026-07-23T00:00:00.000Z";
  const mediaJobId = "media_job_canvas_current";
  const sceneRunId = "media_scene_run_canvas_current";
  const artifactId = "artifact_canvas_current";
  state.mediaScenes = state.mediaScenes.map((scene) => scene.id === sceneId
    ? { ...scene, selectedMediaSceneRunId: sceneRunId }
    : scene);
  state.mediaSceneRuns.push({
    id: sceneRunId,
    projectId: state.mediaProjects[0]!.id,
    sceneId,
    mediaJobId,
    providerSnapshot: { providerPresetId: "provider_canvas_video" },
    executionSnapshot: { kind: "provider", providerPresetId: "provider_canvas_video" },
    inputSnapshot: { prompt: "Far current result" },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  state.mediaJobs.push({
    id: mediaJobId,
    workspaceId: "workspace_default",
    providerPresetId: "provider_canvas_video",
    executionSource: { kind: "provider", providerPresetId: "provider_canvas_video" },
    operation: "video_generate",
    prompt: "Far current result",
    input: { ratio: "16:9", duration: 5 },
    artifactIds: [artifactId],
    status: "succeeded",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  state.artifactsByMediaJob[mediaJobId] = [{
    id: artifactId,
    mediaJobId,
    type: "video",
    path: "/tmp/far-current.webm",
    title: "Far current result",
    contentType: "video/webm",
    sizeBytes: 16,
  }];
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

async function assertNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function stableDimensions(locator: Locator): Promise<{ readonly width: number; readonly height: number }> {
  return locator.evaluate((element) => ({
    width: (element as HTMLElement).clientWidth,
    height: (element as HTMLElement).clientHeight,
  }));
}

async function textIsEllipsized(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth > element.clientWidth);
}

async function assertTypedIconButton(
  button: Locator,
  label: string,
  options: { readonly tooltip?: boolean } = {},
): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  await expect(button.locator('svg[data-ling-icon=""]')).toHaveCount(1);
  const box = await button.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  if (options.tooltip === false) return;
  await button.evaluate((element) => (element as HTMLButtonElement).blur());
  await button.page().mouse.move(0, 0);
  await expect(button.page().getByRole("tooltip")).toHaveCount(0);
  await button.page().waitForTimeout(200);
  await button.hover();
  const tooltip = button.page().getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(label);
  await button.page().mouse.move(0, 0);
  await expect(button.page().getByRole("tooltip")).toHaveCount(0);
}

async function elementsOverlap(page: Page, firstSelector: string, secondSelector: string): Promise<boolean> {
  return page.evaluate(({ firstSelector, secondSelector }) => {
    const first = document.querySelector(firstSelector);
    const second = document.querySelector(secondSelector);
    if (!first || !second) return false;
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    return firstRect.left < secondRect.right
      && firstRect.right > secondRect.left
      && firstRect.top < secondRect.bottom
      && firstRect.bottom > secondRect.top;
  }, { firstSelector, secondSelector });
}

async function selectedSceneSafeAreaSnapshot(page: Page): Promise<{
  readonly inside: boolean;
  readonly node: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  readonly safe: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".storyboard-canvas");
    const node = document.querySelector(".storyboard-scene-node.selected");
    if (!canvas || !node) {
      return {
        inside: false,
        node: { left: 0, right: 0, top: 0, bottom: 0 },
        safe: { left: 0, right: 0, top: 0, bottom: 0 },
      };
    }
    const canvasRect = canvas.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const leftDock = document.querySelector(".media-production-dock-panel.left.is-open");
    const rightDock = document.querySelector(".media-production-dock-panel.right.is-open");
    const safeLeft = leftDock ? leftDock.getBoundingClientRect().right + 12 : canvasRect.left + 16;
    const safeRight = rightDock ? rightDock.getBoundingClientRect().left - 12 : canvasRect.right - 16;
    const safeTop = canvasRect.top + 72;
    const safeBottom = canvasRect.bottom - 56;
    return {
      inside: nodeRect.left >= safeLeft
      && nodeRect.right <= safeRight
      && nodeRect.top >= safeTop
      && nodeRect.bottom <= safeBottom,
      node: { left: nodeRect.left, right: nodeRect.right, top: nodeRect.top, bottom: nodeRect.bottom },
      safe: { left: safeLeft, right: safeRight, top: safeTop, bottom: safeBottom },
    };
  });
}

function analyzePng(buffer: Buffer): {
  readonly width: number;
  readonly height: number;
  readonly uniqueColors: number;
  readonly opaqueRatio: number;
  readonly nonDominantRatio: number;
} {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported canvas PNG: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(chunks));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const pixels = Buffer.alloc(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = packed[sourceOffset] ?? 0;
    sourceOffset += 1;
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = packed[sourceOffset + column] ?? 0;
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] ?? 0 : 0;
      const up = row > 0 ? pixels[rowOffset + column - rowBytes] ?? 0 : 0;
      const upLeft = row > 0 && column >= bytesPerPixel
        ? pixels[rowOffset + column - rowBytes - bytesPerPixel] ?? 0
        : 0;
      pixels[rowOffset + column] = (encoded + pngFilterPredictor(filter, left, up, upLeft)) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  const colors = new Map<string, number>();
  let opaque = 0;
  const total = width * height;
  for (let offset = 0; offset < pixels.length; offset += bytesPerPixel) {
    const alpha = bytesPerPixel === 4 ? pixels[offset + 3] ?? 0 : 255;
    if (alpha > 0) opaque += 1;
    const color = `${pixels[offset] ?? 0},${pixels[offset + 1] ?? 0},${pixels[offset + 2] ?? 0},${alpha}`;
    colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  const dominant = Math.max(0, ...colors.values());
  return {
    width,
    height,
    uniqueColors: colors.size,
    opaqueRatio: total > 0 ? opaque / total : 0,
    nonDominantRatio: total > 0 ? (total - dominant) / total : 0,
  };
}

function pngFilterPredictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const diagonalDistance = Math.abs(estimate - upLeft);
    return leftDistance <= upDistance && leftDistance <= diagonalDistance
      ? left
      : upDistance <= diagonalDistance ? up : upLeft;
  }
  throw new Error(`Unsupported PNG row filter: ${filter}`);
}
