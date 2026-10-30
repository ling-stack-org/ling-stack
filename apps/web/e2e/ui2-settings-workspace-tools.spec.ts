import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/workspace-tools-embedded/",
  import.meta.url,
));

type WorkspaceToolView = "providers" | "teammates" | "councils";

test("Model embedded boundary preserves loading, empty, failure, and exact return", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);

  const providerGate = deferred();
  let providerMode: "hold" | "pass" | "fail" = "hold";
  await page.route(/\/providers(?:\?.*)?$/u, async (route) => {
    if (providerMode === "hold") await providerGate.promise;
    if (providerMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic provider list failure" } });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  const appNavigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await appNavigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  const surface = await openWorkspaceTool(page, "Model Workbench", "providers");
  await expect(surface.getByText("Loading providers...", { exact: true })).toBeVisible();

  providerMode = "pass";
  providerGate.resolve();
  await expect(surface.getByText("Add a model route to start using Ling.", { exact: true })).toBeVisible();
  await expectWorkspaceToolBoundary(page, surface);

  providerMode = "fail";
  await expect(surface.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  await expect(surface.locator(".inline-error")).toContainText("Synthetic provider list failure");
  await expectWorkspaceToolBoundary(page, surface);

  await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(appNavigation.locator(".channel-contains-selection").getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await expect(appNavigation.locator('[data-session-default="true"] .sidebar-branch-row')).toHaveAttribute("aria-current", "page");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Model loaded state stays dense, searchable, and contained", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPopulatedState();
  state.providers = Array.from({ length: 18 }, (_, index) => createReadyProvider(index));
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openWorkspaceTool(page, "Model Workbench", "providers");
  await expect(surface.locator(".provider-table tbody tr")).toHaveCount(18);
  await expect(surface.getByRole("heading", { name: "Model Workbench", level: 1 })).toHaveCount(0);
  await expect(surface.locator(".provider-table-shell")).toHaveCSS("overflow", "auto");
  const [toolbarBox, tableShellBox] = await Promise.all([
    page.locator(".provider-header-tools").boundingBox(),
    surface.locator(".provider-table-shell").boundingBox(),
  ]);
  expect(toolbarBox).not.toBeNull();
  expect(tableShellBox).not.toBeNull();
  expect((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0)).toBeLessThanOrEqual((tableShellBox?.y ?? 0) + 1);
  await captureEvidence(page, "1440x960-ling-light-model-loaded.png");

  const search = surface.getByLabel("Search model presets");
  await search.fill("no-model-can-match-this-query");
  await expect(surface.getByText("No model presets match the current filters", { exact: true })).toBeVisible();
  await search.fill("");
  await surface.getByLabel("Filter model presets").selectOption("ready");
  await expect(surface.locator(".provider-table tbody tr")).toHaveCount(18);

  await page.setViewportSize({ width: 980, height: 680 });
  await expectWorkspaceToolBoundary(page, surface);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Model editor uses the shared overlay and restores focus in dark mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPopulatedState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openWorkspaceTool(page, "Model Workbench", "providers");
  const trigger = page.getByRole("button", { name: "Add model" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New preset" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#ling-ui-overlay-root")).toHaveCount(1);
  await expect(page.locator("#ling-ui-overlay-root").getByRole("dialog", { name: "New preset" })).toBeVisible();
  await expect(surface).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-model-editor.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectWorkspaceToolBoundary(page, surface);
  expect(runtimeErrors).toEqual([]);
});

test("Teammate loaded state keeps role detail and explicit app exit inside one boundary", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPopulatedState();
  state.aiTeammates = Array.from({ length: 14 }, (_, index) => createReadyTeammate(index));
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openWorkspaceTool(page, "Teammate Management", "teammates");
  await expect(surface.getByLabel("Workspace teammates").locator(".teammate-draft-row")).toHaveCount(14);
  await expect(surface.getByRole("heading", { name: "AI Teammates", level: 1 })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-teammates-loaded.png");

  const roleTrigger = surface.getByLabel("Teammate templates").getByRole("button", { name: /Product Strategist/u });
  await roleTrigger.click();
  const roleDialog = page.getByRole("dialog", { name: "Role detail" });
  await expect(roleDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(roleDialog).toHaveCount(0);
  await expect(roleTrigger).toBeFocused();

  const firstTeammate = surface.locator(".teammate-draft-row").filter({ hasText: "Ling Engineer 01" });
  await firstTeammate.getByRole("button", { name: "Open chat in app" }).click();
  await expect(page.getByRole("heading", { name: "Ling Engineer 01", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("Teammate create dialog remains in the shared overlay at 1280 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, "reduce");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPopulatedState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openWorkspaceTool(page, "Teammate Management", "teammates");
  const trigger = surface.getByRole("button", { name: "New AI teammate" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create AI teammate" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#ling-ui-overlay-root")).toHaveCount(1);
  await expect(surface).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-teammate-create.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectWorkspaceToolBoundary(page, surface);
  expect(runtimeErrors).toEqual([]);
});

test("Council loaded state keeps managed members read-only and supports explicit channel exit", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPopulatedState();
  await mockDaemon(page, state);
  await page.goto("/");

  let surface = await openWorkspaceTool(page, "Council Workspace", "councils");
  await expect(surface.locator(".council-workspace-list")).toContainText("Development Council");
  await expect(surface.getByRole("heading", { name: "Council Workspace", level: 1 })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-council-loaded.png");

  await expect(surface.getByRole("button", { name: "Clone to customize" })).toBeVisible();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  surface = await expectWorkspaceToolView(page, "teammates", "Teammate Management");
  await expect(surface.getByLabel("Workspace teammates")).toBeVisible();

  await page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace" }).click();
  surface = await expectWorkspaceToolView(page, "councils", "Council Workspace");
  await surface.getByRole("tab", { name: "Channel usage" }).click();
  await surface.getByLabel("Channel usage").getByRole("button", { name: "Open channel in app" }).click();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("Council create dialog remains contained and restores focus at 1280 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPopulatedState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openWorkspaceTool(page, "Council Workspace", "councils");
  const trigger = surface.getByRole("button", { name: "Create council" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create council" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#ling-ui-overlay-root")).toHaveCount(1);
  await expect(surface).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-council-create.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectWorkspaceToolBoundary(page, surface);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { initialTheme: theme });
}

async function openWorkspaceTool(page: Page, label: string, view: WorkspaceToolView): Promise<Locator> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: label, exact: true }).click();
  return await expectWorkspaceToolView(page, view, label);
}

async function expectWorkspaceToolView(page: Page, view: WorkspaceToolView, label: string): Promise<Locator> {
  const surface = page.locator("[data-ui2-settings-workspace-tool]");
  await expect(surface).toHaveCount(1);
  await expect(surface).toHaveAttribute("data-settings-workspace-tool", view);
  await expect(surface).toHaveAttribute("data-settings-workspace-tool-label", label);
  await expect(page.locator("[data-settings-content-state]"))
    .toHaveAttribute("data-settings-content-state", "workspace-tool");
  await expect(page.locator("[data-settings-content-state]"))
    .toHaveClass(/settings-content-stack--workspace-tool/u);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: label, exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Settings sections").locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  await expect(page.locator(".settings-tool-return-row, .settings-workspace-tools")).toHaveCount(0);
  await expectWorkspaceToolBoundary(page, surface);
  return surface;
}

async function expectWorkspaceToolBoundary(page: Page, surface: Locator): Promise<void> {
  const content = page.locator("[data-settings-content-state='workspace-tool']");
  const metrics = await content.evaluate((contentElement, surfaceElement) => {
    const surfaceNode = surfaceElement as HTMLElement;
    const child = surfaceNode.firstElementChild as HTMLElement | null;
    const contentRect = contentElement.getBoundingClientRect();
    const surfaceRect = surfaceNode.getBoundingClientRect();
    const childRect = child?.getBoundingClientRect();
    return {
      contentOverflowX: getComputedStyle(contentElement).overflowX,
      contentOverflowY: getComputedStyle(contentElement).overflowY,
      surfaceOverflowX: getComputedStyle(surfaceNode).overflowX,
      surfaceOverflowY: getComputedStyle(surfaceNode).overflowY,
      surfaceWithinContent:
        surfaceRect.left >= contentRect.left - 1 &&
        surfaceRect.right <= contentRect.right + 1 &&
        surfaceRect.top >= contentRect.top - 1 &&
        surfaceRect.bottom <= contentRect.bottom + 1,
      childWithinSurface: childRect
        ? childRect.left >= surfaceRect.left - 1 && childRect.right <= surfaceRect.right + 1
        : false,
    };
  }, await surface.elementHandle());
  expect(metrics.contentOverflowX).toBe("hidden");
  expect(metrics.contentOverflowY).toBe("hidden");
  expect(metrics.surfaceOverflowX).toBe("hidden");
  expect(metrics.surfaceOverflowY).toBe("hidden");
  expect(metrics.surfaceWithinContent).toBe(true);
  expect(metrics.childWithinSurface).toBe(true);
  await expectNoPageOverflow(page);
}

function createPopulatedState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createReadyProvider(0)];
  state.aiTeammates = [createReadyTeammate(0)];
  return state;
}

function createReadyProvider(index: number): Record<string, unknown> {
  const suffix = String(index + 1).padStart(2, "0");
  return createChatProvider({
    id: index === 0 ? "provider_local" : `provider_local_${suffix}`,
    displayName: `Local Relay ${suffix}`,
    providerId: `local-relay-${suffix}`,
    model: `gpt-5.5-${suffix}`,
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
  });
}

function createReadyTeammate(index: number): Record<string, unknown> {
  const suffix = String(index + 1).padStart(2, "0");
  return createMockTeammate({
    id: index === 0 ? "teammate_builtin_engineer" : `teammate_engineer_${suffix}`,
    displayName: `Ling Engineer ${suffix}`,
    providerPresetId: "provider_local",
    updatedAt: `2026-07-${String(Math.min(index + 1, 20)).padStart(2, "0")}T00:00:00.000Z`,
  });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
