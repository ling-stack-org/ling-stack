import { expect, test, type Locator, type Page } from "@playwright/test";
import { isViteClientTransportError } from "./support/vite-client-console-error";
import { mockDaemon } from "./support/mock-daemon";
import { createDefaultProviderTemplates, cwd } from "./support/mock-state";
import {
  createEmptyMediaProductionFixture,
  createLoadedMediaProductionFixture,
  createLongMediaProductionFixture,
  createMediaProductionRouteControl,
  installMediaProductionScenarioRoutes,
  openMediaProduction,
  type MediaProductionRouteControl,
} from "./support/media-production-fixtures";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
});

test("MP-01 initial loading never flashes a false empty state", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const control = createMediaProductionRouteControl();
  control.projectListDelayMs = 350;
  await prepare(page, createEmptyMediaProductionFixture(), control);

  await openMediaProduction(page);
  await expect(page.locator(".media-production-load-state")).toBeVisible();
  await expect(page.locator('[data-media-production-empty="authoritative"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
  await expect(page.locator('[data-media-production-empty="authoritative"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "New project" })).toBeVisible();
  expect(control.projectListCalls).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("MP-02 initial failure owns retry and resolves to authoritative empty", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const control = createMediaProductionRouteControl();
  // React StrictMode replays mount effects in development; fail both initial attempts.
  control.failNextProjectList = 2;
  await prepare(page, createEmptyMediaProductionFixture(), control);

  await openMediaProduction(page);
  const initialError = page.getByRole("alert").filter({ hasText: "Could not load media projects." });
  await expect(initialError).toBeVisible();
  await expect(page.locator('[data-media-production-empty="authoritative"]')).toHaveCount(0);
  await initialError.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-media-production-empty="authoritative"]')).toBeVisible();
  expect(control.projectListCalls).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test("MP-03 retained detail failure retries and stale project responses cannot commit", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 3, scenesPerProject: 1 });
  const control = createMediaProductionRouteControl();
  await prepare(page, state, control);
  await openMediaProduction(page);
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 001");

  const selector = page.getByLabel("Media project");
  control.failNextProjectDetailById.media_project_ui2_002 = 1;
  await selector.selectOption("media_project_ui2_002");
  const retainedFailure = page.getByText("Could not switch projects. Showing the last loaded project.");
  await expect(retainedFailure).toBeVisible();
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 001");
  await expect(selector).toHaveValue("media_project_ui2_001");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 002");

  control.projectDetailDelayById.media_project_ui2_003 = 350;
  await selector.selectOption("media_project_ui2_003");
  await selector.selectOption("media_project_ui2_001");
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 001");
  await page.waitForTimeout(450);
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 001");
  await expect(page.locator(".media-production-project-trigger")).not.toContainText("Editorial project 003");
  expect(control.projectDetailCalls.media_project_ui2_003).toBe(1);
  expect(control.requestedCwds.every((value) => value === cwd)).toBe(true);
  expect(errors).toEqual([]);
});

test("MP-04 project delete is single-flight, retains failure, closes on success, and repairs refresh", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 2, scenesPerProject: 2 });
  const control = createMediaProductionRouteControl();
  await prepare(page, state, control);
  await openMediaProduction(page);
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 001");

  await page.locator("details.project-outline-settings > summary").click();
  await page.getByRole("button", { name: "Delete project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete project Editorial project 001?" });
  await expect(dialog).toBeVisible();
  control.failNextProjectDelete = 1;
  control.projectDeleteDelayMs = 300;
  await dialog.getByRole("button", { name: "Delete project", exact: true }).dblclick();
  await expect(dialog.getByText("Could not delete this media project.")).toBeVisible();
  expect(control.projectDeleteCalls.media_project_ui2_001).toBe(1);

  control.projectDeleteDelayMs = 0;
  control.failNextProjectList = 1;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => control.projectDeleteCalls.media_project_ui2_001 ?? 0).toBe(2);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".media-production-project-trigger")).toContainText("Editorial project 002");
  expect(control.projectDeleteCalls.media_project_ui2_001).toBe(2);
  expect(state.mediaProjects.map((project) => project.id)).toEqual(["media_project_ui2_002"]);

  const retainedRefreshFailure = page.getByText("Could not refresh media projects. Showing the last loaded projects.");
  await expect(retainedRefreshFailure).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(retainedRefreshFailure).toHaveCount(0);
  await expect(page.getByLabel("Media project").locator("option")).toHaveCount(1);
  consumeExpectedFailedResource500(errors);
  expect(errors).toEqual([]);
});

test("MP-05 scene delete is single-flight, retains failure, and selects the successor", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 });
  const control = createMediaProductionRouteControl();
  await prepare(page, state, control);
  await openMediaProduction(page);
  await expect(page.locator(".project-outline-scene")).toHaveCount(2);

  const firstScene = page.locator(".project-outline-scene").first();
  await firstScene.getByRole("button", { name: "Delete scene" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete scene Scene 001_01?" });
  await expect(dialog).toBeVisible();
  control.failNextSceneDelete = 1;
  control.sceneDeleteDelayMs = 300;
  await dialog.getByRole("button", { name: "Delete scene", exact: true }).dblclick();
  await expect(dialog.getByText("Could not delete this scene.")).toBeVisible();
  expect(control.sceneDeleteCalls.media_scene_ui2_001_01).toBe(1);

  control.sceneDeleteDelayMs = 0;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".project-outline-scene")).toHaveCount(1);
  await expect(page.locator(".project-outline-scene.selected")).toContainText("Scene 001_02");
  expect(control.sceneDeleteCalls.media_scene_ui2_001_01).toBe(2);
  expect(state.mediaScenes.map((scene) => scene.id)).toEqual(["media_scene_ui2_001_02"]);
  consumeExpectedFailedResource500(errors);
  expect(errors).toEqual([]);
});

test("MP-06 long project inventory stays contained", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await prepare(page, createLongMediaProductionFixture());
  await openMediaProduction(page);
  await expect(page.getByLabel("Media project").locator("option")).toHaveCount(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("MP-05 project and scene icon actions preserve typed, busy, and disabled states", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const state = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 });
  const control = createMediaProductionRouteControl();
  await prepare(page, state, control);
  await installIconActionDelays(page, 500);
  const deleteRequestStarted = deferred<void>();
  const releaseDeleteRequest = deferred<void>();
  await page.route(/\/media-scenes\/media_scene_ui2_001_01(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "DELETE") {
      deleteRequestStarted.resolve();
      await releaseDeleteRequest.promise;
    }
    await route.fallback();
  });
  await openMediaProduction(page);

  const outline = page.locator(".project-scene-outline");
  const newProject = outline.getByRole("button", { name: "New project" });
  const addScene = outline.getByRole("button", { name: "Add scene" });
  await assertTypedIconButton(newProject, "New project");
  await assertTypedIconButton(addScene, "Add scene");

  const firstScene = outline.locator(".project-outline-scene").first();
  const moveUp = firstScene.getByRole("button", { name: "Move scene up" });
  const moveDown = firstScene.getByRole("button", { name: "Move scene down" });
  const deleteScene = firstScene.getByRole("button", { name: "Delete scene" });
  await assertTypedIconButton(moveUp, "Move scene up", { tooltip: false });
  await assertTypedIconButton(moveDown, "Move scene down");
  await assertTypedIconButton(deleteScene, "Delete scene");
  await expect(moveUp).toBeDisabled();
  await expect(moveDown).toBeEnabled();

  await addScene.click();
  await expect(addScene).toHaveAttribute("aria-busy", "true");
  await expect(addScene).toBeDisabled();
  await expect(outline.locator(".project-outline-scene")).toHaveCount(3);
  await expect(addScene).toBeEnabled();

  await moveDown.click();
  await expect(moveDown).toBeDisabled();
  await expect(outline.locator(".project-outline-scene").first()).toContainText("Scene 001_02");

  const sceneToDelete = outline.locator(".project-outline-scene").filter({ hasText: "Scene 001_01" });
  const deleteTrigger = sceneToDelete.locator(".project-outline-scene-delete");
  await deleteTrigger.click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete scene Scene 001_01?" });
  const confirmDelete = deleteDialog.locator('button[data-variant="danger"]');
  await confirmDelete.click();
  await deleteRequestStarted.promise;
  try {
    await expect(deleteDialog).toHaveAttribute("aria-busy", "true");
    await expect(confirmDelete).toHaveAttribute("aria-busy", "true");
    await expect(confirmDelete).toBeDisabled();
    await expect(deleteTrigger).toBeDisabled();
  } finally {
    releaseDeleteRequest.resolve();
  }
  await expect(deleteDialog).toHaveCount(0);
  await expect(outline.locator(".project-outline-scene")).toHaveCount(2);

  await newProject.click();
  await expect(newProject).toHaveAttribute("aria-busy", "true");
  await expect(newProject).toBeDisabled();
  await expect(page.getByLabel("Media project").locator("option")).toHaveCount(2);
  expect(state.mediaProjects).toHaveLength(2);
  expect(errors).toEqual([]);
});

async function prepare(
  page: Page,
  state: ReturnType<typeof createEmptyMediaProductionFixture>,
  control = createMediaProductionRouteControl(),
): Promise<void> {
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaProductionScenarioRoutes(page, state, control);
  await page.goto("/");
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isViteClientTransportError(message)) errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

function consumeExpectedFailedResource500(errors: string[]): void {
  const expected = "console:Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
  const index = errors.indexOf(expected);
  expect(index).toBeGreaterThanOrEqual(0);
  errors.splice(index, 1);
}

async function installIconActionDelays(page: Page, milliseconds: number): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const delayed = request.method() === "POST" && (
      path === "/media-projects"
      || /^\/media-projects\/[^/]+\/(?:scenes|reorder)$/u.test(path)
    );
    if (delayed) await new Promise((resolve) => setTimeout(resolve, milliseconds));
    await route.fallback();
  });
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
  const size = await button.evaluate((element) => ({
    height: (element as HTMLElement).offsetHeight,
    width: (element as HTMLElement).offsetWidth,
  }));
  expect(size.width).toBeGreaterThanOrEqual(32);
  expect(size.height).toBeGreaterThanOrEqual(32);
  if (options.tooltip === false) return;
  await button.hover();
  const tooltip = button.page().getByRole("tooltip").filter({ hasText: label });
  await expect(tooltip).toBeVisible();
  await button.page().mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
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
