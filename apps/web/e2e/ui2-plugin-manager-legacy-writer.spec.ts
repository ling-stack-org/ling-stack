import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import {
  createMockCuaPlugin,
  mockDaemon,
  type MockManagedPlugin,
  type MockState,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { triggerFocusRevalidation } from "./support/focus-revalidation";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const pluginStylesDirectory = fileURLToPath(new URL("../src/styles/plugins/", import.meta.url));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/plugin-manager-legacy-writer/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
const expectedInjected503 = /503 \(Service Unavailable\)/u;
const publicFeedbackSlot = '[data-ling-inline-feedback-slot="detail"]';

interface PluginManagerFixture {
  readonly state: MockState;
  readonly failNextMutation: (pluginId: string, action: string, delayMs?: number) => void;
  readonly failNextRefresh: (delayMs?: number) => void;
}

interface SourceFile {
  readonly content: string;
  readonly path: string;
}

test("T13-O.32-D Plugin focused owner has no strict Dark blanket and uses only the public feedback slot", async () => {
  const [styles, pluginImports, feedbackCss, inlineFeedback, packageTest, productionSources, pluginStyleSources] = await Promise.all([
    readRepositoryFile("apps/web/src/styles.css"),
    readRepositoryFile("apps/web/src/styles/plugins.css"),
    readRepositoryFile("apps/web/src/styles/plugins/plugin-manager-feedback.css"),
    readRepositoryFile("packages/ui-react/src/feedback/InlineFeedback.tsx"),
    readRepositoryFile("packages/ui-react/test/primitives.test.mjs"),
    readSourceTree(webSourceDirectory),
    readSourceTree(pluginStylesDirectory),
  ]);


  const pluginRootOwners = findExactSelectorOwners(productionSources, ".workspace.workspace-plugins-surface");
  expect(pluginRootOwners).toEqual([
    "apps/web/src/styles/plugins/plugin-manager-shell.css",
  ]);
  expectImportOrder(styles, ["./styles/plugins.css", "./styles/shared/workspace-navigation-appearance.css"]);
  for (const focusedImport of [
    "plugin-manager-shell.css",
    "plugin-manager-toolbar.css",
    "plugin-manager-feedback.css",
    "plugin-manager-table.css",
    "plugin-detail-runtime.css",
    "plugin-runtime-sections.css",
    "plugin-cua-install.css",
  ]) {
    expect(pluginImports, `Plugin focused facade must load ${focusedImport}`).toContain(focusedImport);
  }

  await expectPathToBeAbsent("apps/web/src/styles/plugin-cua-health.css");
  expect(styles).not.toContain("plugin-cua-health.css");
  expect(findTokenOwners(productionSources, "settings-plugin-token")).toEqual([]);

  for (const source of pluginStyleSources) {
    expect(source.content, `${source.path} must not select a package-private InlineFeedback class`)
      .not.toContain(".ling-ui-inline-feedback-detail");
  }
  expect(countOccurrences(feedbackCss, publicFeedbackSlot), "both Plugin feedback layouts use the public detail slot")
    .toBe(2);
  expect(inlineFeedback).toContain('data-ling-inline-feedback-slot="detail"');
  expect(packageTest).toMatch(/data-ling-inline-feedback-slot=[\\]?"detail[\\]?"/u);
});

test("T13-O.32-D Light 1440 retains the list and public feedback slot through refresh failure and keyboard retry", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const fixture = await setupPluginManager(page, createReadyPlugins(24));
  await openPluginManager(page);

  const workspace = page.locator(".workspace.workspace-plugins-surface");
  const manager = page.locator(".settings-plugin-manager");
  const table = page.getByRole("table", { name: "Plugins" });
  const tableBody = page.locator(".plugin-table-body");
  await expect(page.locator(".plugin-table-row")).toHaveCount(24);
  await expect.poll(() => tableBody.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);

  fixture.failNextRefresh(200);
  await triggerFocusRevalidation(page);
  const retained = page.locator('[data-plugin-refresh-retained="true"]');
  await expect(retained).toBeVisible();
  await expect(retained).toContainText("Plugin list update failed");
  await expect(retained).toContainText("Showing 24 Plugins");
  await expect(retained.locator(publicFeedbackSlot)).toBeVisible();
  await expect(page.locator(".plugin-table-row")).toHaveCount(24);

  const retry = retained.getByRole("button", { name: "Retry" });
  await retry.focus();
  await expect(retry).toBeFocused();
  await expectContained(retry, retained);
  await expectNoOverflow(page, [workspace, manager, table, retained]);
  await captureIfEnabled(page, "1440x960-ling-light-retained-refresh-list.png");

  await page.keyboard.press("Enter");
  await expect(retained).toHaveCount(0);
  await expect(page.locator(".plugin-table-row")).toHaveCount(24);
  expectRuntime(runtime, [expectedInjected503]);
});

test("T13-O.32-D Dark 1280 keeps row failure, focus, reduced motion, and retry scoped", async ({ page }) => {
  await prepareSurface(page, { height: 800, reducedMotion: true, theme: "dark", width: 1280 });
  const runtime = watchRuntime(page);
  const plugins = createReadyPlugins(2);
  const fixture = await setupPluginManager(page, plugins);
  await openPluginManager(page);

  const target = pluginRow(page, plugins[0]?.id ?? "");
  const other = pluginRow(page, plugins[1]?.id ?? "");
  fixture.failNextMutation(plugins[0]?.id ?? "", "check", 200);
  await target.getByRole("button", { name: "Check" }).click();
  await expect(target.getByRole("alert")).toHaveText("Check · failed");
  await expect(other.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
    .toBe(true);

  const retry = target.getByRole("button", { name: "Retry" });
  await retry.focus();
  await expect(retry).toBeFocused();
  await expectContained(retry, target);
  await expectReducedMotion(target.locator(".ling-ui-button"));
  await expectNoOverflow(page, [
    page.locator(".workspace.workspace-plugins-surface"),
    page.locator(".settings-plugin-manager"),
    page.locator(".plugin-table"),
    target,
  ]);
  await captureIfEnabled(page, "1280x800-ling-dark-row-failure-focus.png");

  await page.keyboard.press("Enter");
  await expect(target.getByRole("alert")).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Check" })).toBeEnabled();
  expectRuntime(runtime, [expectedInjected503]);
});

test("T13-O.32-D Quiet Ocean 1440 keeps CUA and Create overlays theme-owned, keyboard reachable, and bounded", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  await installClipboardControl(page);
  const runtime = watchRuntime(page);
  await setupPluginManager(page, [createMockCuaPlugin()]);
  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await openPluginManagerFromShell(page);

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  const workspace = page.locator(".workspace.workspace-plugins-surface");
  const pluginPage = page.locator(".plugin-manager-page");
  const manager = page.locator(".settings-plugin-manager");
  await expectUsesToken(pluginPage, "backgroundColor", "--ling-bg-app");
  await expectUsesToken(manager, "backgroundColor", "--ling-bg-panel");

  const guideTrigger = pluginRow(page, "trusted-local:cua-driver")
    .getByRole("button", { name: "Installation guide" });
  await guideTrigger.focus();
  await page.keyboard.press("Enter");
  const guide = page.getByRole("dialog", { name: "Install Cua Driver" });
  await expect(guide).toBeVisible();
  await expect(guide.locator(`.cua-install-safety-note ${publicFeedbackSlot}`)).toBeVisible();
  const copy = guide.getByRole("button", { name: "Copy install command" });
  await expectTypedIconAction(page, copy, "Copy install command");
  await copy.focus();
  await expect(copy).toBeFocused();
  await copy.click();
  await expect(copy).toHaveAttribute("data-cua-copy-state", "copied");
  await expectTypedIconAction(page, copy, "Copy install command", false);
  const copyToast = page.locator('[data-ling-overlay="toast"][data-scope="plugin:cua:trusted-local:cua-driver:copy"]');
  await expect(copyToast).toHaveCount(1);
  await expect(copyToast).toContainText("Command copied");
  await expect(guide.getByText("Command copied", { exact: true })).toHaveCount(0);
  await expect(guide.locator(".cua-install-copy-status")).toHaveCount(0);
  await expect(guide.locator('[aria-live="polite"]')).toHaveCount(0);
  await copyToast.locator(".ling-ui-toast-close").click({ force: true });
  await expect(copyToast).toHaveCount(0);
  await focusOverlayWithoutTooltip(page, guide);
  await expect(guide).toBeVisible();
  await expectWithinViewport(page, guide);
  await expectNoOverflow(page, [workspace, manager, guide, guide.locator(".cua-install-body")]);

  const customPath = guide.getByText("Use a custom executable path", { exact: true });
  await customPath.click();
  const executable = guide.getByLabel("Executable path");
  await expect(executable).toBeVisible();
  await executable.fill(`/Applications/${"Ling-Plugin-Ownership-".repeat(10)}Cua Driver.app/Contents/MacOS/cua-driver`);
  await expectContained(executable, guide.locator(".cua-install-custom-path"));
  await focusOverlayWithoutTooltip(page, guide);
  await page.keyboard.press("Escape");
  await expect(guide).toHaveCount(0);

  const addTrigger = page.locator(".plugin-manager-header").getByRole("button", { name: "Add plugin" });
  await addTrigger.focus();
  await page.keyboard.press("Enter");
  const create = page.getByRole("dialog", { name: "Add plugin" });
  await expect(create).toBeVisible();
  const submit = create.getByRole("button", { name: "Add plugin" });
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(create.getByRole("alert")).toHaveText("Plugin name is required.");
  await expect(create.getByLabel("Plugin name")).toBeFocused();
  await expectWithinViewport(page, create);
  await expectNoOverflow(page, [workspace, manager, create]);
  await captureIfEnabled(page, "1440x960-quiet-ocean-create-validation.png");
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);
  expectRuntime(runtime);
});

test("T13-P.8C Dark 1280 keeps CUA copy failure persistent and clears it on context change, success, and close", async ({ page }) => {
  await prepareSurface(page, { height: 800, theme: "dark", width: 1280 });
  await installClipboardControl(page);
  const runtime = watchRuntime(page);
  await setupPluginManager(page, [createMockCuaPlugin()]);
  await openPluginManager(page);

  const workspace = page.locator(".workspace.workspace-plugins-surface");
  const manager = page.locator(".settings-plugin-manager");
  const openGuide = async (): Promise<Locator> => {
    await pluginRow(page, "trusted-local:cua-driver")
      .getByRole("button", { name: "Installation guide" })
      .click();
    const drawer = page.getByRole("dialog", { name: "Install Cua Driver" });
    await expect(drawer).toBeVisible();
    return drawer;
  };

  let guide = await openGuide();
  let copy = guide.getByRole("button", { name: "Copy install command" });
  await setClipboardFailure(page, true);
  await copy.click();
  const failure = guide.locator('[data-cua-copy-feedback="failure"]');
  await expect(failure).toHaveText("Copy failed");
  await expect(failure).toBeVisible();
  await page.waitForTimeout(3_100);
  await expect(failure).toBeVisible();
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="plugin:cua:trusted-local:cua-driver:copy"]'))
    .toHaveCount(0);

  await guide.getByText("Use a custom executable path", { exact: true }).click();
  const executable = guide.getByLabel("Executable path");
  await executable.fill("/opt/homebrew/bin/cua-driver");
  await expect(failure).toHaveCount(0);
  await expect(copy).toHaveAttribute("data-cua-copy-state", "idle");

  await copy.click();
  await expect(guide.locator('[data-cua-copy-feedback="failure"]')).toBeVisible();
  await setClipboardFailure(page, false);
  await copy.click();
  await expect(guide.locator('[data-cua-copy-feedback="failure"]')).toHaveCount(0);
  await expect(copy).toHaveAttribute("data-cua-copy-state", "copied");
  const copyToast = page.locator('[data-ling-overlay="toast"][data-scope="plugin:cua:trusted-local:cua-driver:copy"]');
  await expect(copyToast).toHaveCount(1);
  await expect(copyToast).toContainText("Command copied");
  await expect(guide.getByText("Command copied", { exact: true })).toHaveCount(0);
  await expect(guide.locator(".cua-install-copy-status")).toHaveCount(0);

  await setClipboardFailure(page, true);
  await copy.click();
  await expect(guide.locator('[data-cua-copy-feedback="failure"]')).toBeVisible();
  await guide.getByRole("button", { name: "Close" }).click();
  await expect(guide).toHaveCount(0);
  guide = await openGuide();
  copy = guide.getByRole("button", { name: "Copy install command" });
  await expect(guide.locator('[data-cua-copy-feedback="failure"]')).toHaveCount(0);
  await expect(copy).toHaveAttribute("data-cua-copy-state", "idle");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectWithinViewport(page, guide);
  await expectNoOverflow(page, [workspace, manager, guide, guide.locator(".cua-install-body")]);
  await guide.getByRole("button", { name: "Close" }).click();
  expectRuntime(runtime);
});

function createReadyPlugins(count: number): MockManagedPlugin[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return {
      id: `built-in:legacy-writer-${number}`,
      displayName: `Focused Plugin ${number}`,
      version: "1.0.0",
      sourceKind: "built-in",
      status: "enabled",
      description: "A focused Plugin Manager ownership fixture with stable product copy.",
      trustSummary: "Built into Ling and governed by the existing workspace policy.",
      contributions: [],
      linkedResources: [],
      events: [],
      health: {
        pluginId: `built-in:legacy-writer-${number}`,
        checkedAt: "2026-07-24T00:00:00.000Z",
        expiresAt: "2030-07-24T00:00:00.000Z",
        status: "ready",
      },
      actions: {
        canApplyPreset: false,
        canCheck: true,
        canDisable: true,
        canEnable: false,
        canInstall: false,
        canRefreshPackage: false,
        canRuntimePreview: false,
        canUninstall: false,
      },
    };
  });
}

async function setupPluginManager(
  page: Page,
  plugins: MockManagedPlugin[],
): Promise<PluginManagerFixture> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = plugins;
  let refreshFailureDelayMs: number | undefined;
  const mutationFailures = new Map<string, number>();
  await mockDaemon(page, state);
  await page.route("**/plugins?**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (refreshFailureDelayMs !== undefined) {
      const delayMs = refreshFailureDelayMs;
      refreshFailureDelayMs = undefined;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({
        json: { error: "plugin_catalog_unavailable", message: "Plugin catalog is temporarily unavailable." },
        status: 503,
      });
      return;
    }
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", plugins: state.managedPlugins } });
  });
  await page.route("**/plugins/**", async (route) => {
    const request = route.request();
    const match = /^\/plugins\/([^/]+)\/([^/]+)$/u.exec(new URL(request.url()).pathname);
    if (!match) {
      await route.fallback();
      return;
    }
    const key = `${decodeURIComponent(match[1] ?? "")}:${decodeURIComponent(match[2] ?? "")}`;
    const delayMs = mutationFailures.get(key);
    if (delayMs === undefined) {
      await route.fallback();
      return;
    }
    mutationFailures.delete(key);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      json: { error: "plugin_action_failed", message: "Plugin action could not be completed." },
      status: 503,
    });
  });
  return {
    state,
    failNextMutation: (pluginId, action, delayMs = 0) => {
      mutationFailures.set(`${pluginId}:${action}`, delayMs);
    },
    failNextRefresh: (delayMs = 0) => {
      refreshFailureDelayMs = delayMs;
    },
  };
}

async function prepareSurface(page: Page, options: {
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly theme: "dark" | "light";
  readonly width: number;
}): Promise<void> {
  await page.setViewportSize({ height: options.height, width: options.width });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript(({ theme }) => {
    if (sessionStorage.getItem("ling-stack.e2eThemeSelection")) return;
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
    sessionStorage.setItem("ling-stack.e2eThemeSelection", JSON.stringify(selection));
  }, { theme: options.theme });
}

async function installClipboardControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const controlledWindow = window as typeof window & { __lingClipboardShouldFail?: boolean };
    controlledWindow.__lingClipboardShouldFail = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          if (controlledWindow.__lingClipboardShouldFail) throw new Error("Clipboard unavailable");
        },
      },
    });
    const originalExecCommand = Document.prototype.execCommand;
    Object.defineProperty(Document.prototype, "execCommand", {
      configurable: true,
      value(command: string, ...args: readonly unknown[]) {
        if (command === "copy") return !controlledWindow.__lingClipboardShouldFail;
        return originalExecCommand.call(this, command, ...args);
      },
    });
  });
}

async function setClipboardFailure(page: Page, shouldFail: boolean): Promise<void> {
  await page.evaluate((nextValue) => {
    (window as typeof window & { __lingClipboardShouldFail?: boolean }).__lingClipboardShouldFail = nextValue;
  }, shouldFail);
}

async function openPluginManager(page: Page): Promise<void> {
  await page.goto("/");
  await openPluginManagerFromShell(page);
}

async function openPluginManagerFromShell(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.locator(".workspace.workspace-plugins-surface .settings-plugin-manager")).toBeVisible();
  await expect(page.locator(".plugin-table-row").first()).toBeVisible();
}

function pluginRow(page: Page, pluginId: string): Locator {
  return page.locator(`.plugin-table-row[data-plugin-id="${pluginId}"]`);
}

async function focusOverlayWithoutTooltip(page: Page, overlay: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await overlay.focus();
  await expect(overlay).toBeFocused();
  await expect(page.locator('[data-ling-overlay="tooltip"]')).toHaveCount(0);
}

async function expectTypedIconAction(
  page: Page,
  action: Locator,
  label: string,
  tooltip = true,
): Promise<void> {
  await expect(action).toHaveAttribute("data-icon-only", "true");
  await expect(action).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(action).toHaveAttribute("aria-label", label);
  await expect(action).toHaveAttribute("title", label);
  await expect(action.locator("[data-ling-icon]")).toHaveCount(1);
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(32);
  if (!tooltip) return;
  const tooltipOverlay = page.getByRole("tooltip", { name: label });
  await action.hover();
  await expect(tooltipOverlay).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tooltipOverlay).toHaveCount(0);
}

function watchRuntime(page: Page): { readonly consoleErrors: string[]; readonly pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const source = message.location().url;
    consoleErrors.push(source ? `${message.text()} ${source}` : message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

function expectRuntime(
  runtime: { readonly consoleErrors: string[]; readonly pageErrors: string[] },
  allowedConsoleErrors: readonly RegExp[] = [],
): void {
  const unexpected = runtime.consoleErrors.filter((message) => (
    !allowedConsoleErrors.some((pattern) => pattern.test(message))
  ));
  for (const pattern of allowedConsoleErrors) {
    expect(runtime.consoleErrors.some((message) => pattern.test(message)), `expected console signal ${pattern.source}`)
      .toBe(true);
  }
  expect(unexpected).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
}

async function expectContained(inner: Locator, owner: Locator): Promise<void> {
  const [innerBox, ownerBox] = await Promise.all([inner.boundingBox(), owner.boundingBox()]);
  expect(innerBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect((innerBox?.x ?? 0) >= (ownerBox?.x ?? 0) - 1).toBe(true);
  expect((innerBox?.y ?? 0) >= (ownerBox?.y ?? 0) - 1).toBe(true);
  expect((innerBox?.x ?? 0) + (innerBox?.width ?? 0))
    .toBeLessThanOrEqual((ownerBox?.x ?? 0) + (ownerBox?.width ?? 0) + 1);
  expect((innerBox?.y ?? 0) + (innerBox?.height ?? 0))
    .toBeLessThanOrEqual((ownerBox?.y ?? 0) + (ownerBox?.height ?? 0) + 1);
}

async function expectWithinViewport(page: Page, region: Locator): Promise<void> {
  const box = await region.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  expect((box?.y ?? 0) + (box?.height ?? Number.POSITIVE_INFINITY))
    .toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
}

async function expectNoOverflow(page: Page, regions: readonly Locator[]): Promise<void> {
  const documentOverflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(documentOverflow.x).toBeLessThanOrEqual(1);
  expect(documentOverflow.y).toBeLessThanOrEqual(1);
  for (const region of regions) {
    await expect(region).toBeVisible();
    const horizontalOverflow = await region.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
  }
}

async function expectReducedMotion(controls: Locator): Promise<void> {
  await expect(controls).not.toHaveCount(0);
  const durations = await controls.evaluateAll((elements) => elements.flatMap((element) => (
    getComputedStyle(element).transitionDuration.split(",").map((value) => {
      const duration = Number.parseFloat(value);
      return value.trim().endsWith("ms") ? duration / 1000 : duration;
    })
  )));
  expect(durations.length).toBeGreaterThan(0);
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.01);
}

async function expectUsesToken(
  locator: Locator,
  property: "backgroundColor" | "color",
  token: string,
): Promise<void> {
  const snapshot = await locator.evaluate((element, input) => {
    const probe = document.createElement("span");
    probe.style[input.property] = `var(${input.token})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe)[input.property];
    probe.remove();
    return { actual: getComputedStyle(element)[input.property], expected };
  }, { property, token });
  expect(snapshot.actual).toBe(snapshot.expected);
}

async function captureIfEnabled(page: Page, fileName: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: `${evidenceDirectory}${fileName}`,
  });
}

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(`${repositoryDirectory}${relativePath}`, "utf8");
}

async function expectPathToBeAbsent(relativePath: string): Promise<void> {
  await expect(access(`${repositoryDirectory}${relativePath}`)).rejects.toThrow();
}

async function readSourceTree(directory: string): Promise<readonly SourceFile[]> {
  const paths = await collectSourcePaths(directory);
  return Promise.all(paths.map(async (path) => ({
    content: await readFile(path, "utf8"),
    path: relative(repositoryDirectory, path),
  })));
}

async function collectSourcePaths(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<readonly string[]> => {
    const path = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return collectSourcePaths(path);
    return [".css", ".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

function extractCssSelectors(css: string): readonly string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  return Array.from(withoutComments.matchAll(/([^{}]+)\{/gu), (match) => match[1]?.trim() ?? "")
    .filter((selector) => selector.length > 0 && !selector.startsWith("@"));
}

function findExactSelectorOwners(files: readonly SourceFile[], selector: string): readonly string[] {
  return files.flatMap((file) => (
    extractCssSelectors(file.content).some((group) => (
      group.split(",").some((branch) => branch.trim() === selector)
    )) ? [file.path] : []
  ));
}

function findTokenOwners(files: readonly SourceFile[], token: string): readonly string[] {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegularExpression(token)}(?![A-Za-z0-9_-])`, "u");
  return files.flatMap((file) => pattern.test(file.content) ? [file.path] : []);
}

function countOccurrences(value: string, token: string): number {
  return value.split(token).length - 1;
}

function expectImportOrder(styles: string, imports: readonly string[]): void {
  const offsets = imports.map((entry) => styles.indexOf(entry));
  expect(offsets.every((offset) => offset >= 0), "required source-order import must exist").toBe(true);
  expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
