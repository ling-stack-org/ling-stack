import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createMockBundledCuaPackageRecord,
  createMockBundledCuaPlugin,
  createMockBundledRuntimePreview,
  createMockCuaPlugin,
  mockDaemon,
  type MockManagedPlugin,
  type MockState,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { triggerFocusRevalidation } from "./support/focus-revalidation";

const evidenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/design/ui2.0升级/evidence/features/plugin-manager",
);
const browserFailures = new WeakMap<Page, string[]>();

interface PluginManagerFixture {
  readonly state: MockState;
  readonly failNextRefresh: (delayMs?: number) => void;
  readonly failNextMutation: (pluginId: string, action: string, delayMs?: number) => void;
}

test("projects four-column plugin rows, local filters, one state and stable actions", async ({ page }) => {
  const plugins = createCatalog();
  await setupPluginManager(page, plugins);
  await openPluginManager(page);

  const table = page.getByRole("table", { name: "Plugins" });
  await expect(table.locator(".plugin-table-row")).toHaveCount(3);
  await expect(table.locator(".plugin-table-source-header")).toHaveText("Source");
  await expect(pluginRow(page, "built-in:runner-ready").locator(".plugin-table-status")).toHaveCount(1);
  await expect(pluginRow(page, "built-in:runner-ready").locator(".plugin-table-status")).toHaveText("Enabled");
  await expect(pluginRow(page, "bundled:cua-driver").locator("[data-plugin-column='source']")).toHaveText("Bundled");

  const sourceFilter = page.getByLabel("Source filter");
  await sourceFilter.selectOption("bundled");
  await expect(table.locator(".plugin-table-row")).toHaveCount(1);
  await expect(table).toContainText("Desktop Bridge");

  await sourceFilter.selectOption("all");
  await page.getByLabel("Status filter").selectOption("needs-action");
  await expect(table.locator(".plugin-table-row")).toHaveCount(2);
  await expect(table).toContainText("Cua Driver");
  await expect(table).toContainText("Desktop Bridge");

  await page.getByLabel("Status filter").selectOption("all");
  await page.getByLabel("Search plugins").fill("not-a-plugin");
  await expect(page.getByText("No plugins match the current filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(table.locator(".plugin-table-row")).toHaveCount(3);

  const readyRow = pluginRow(page, "built-in:runner-ready");
  for (const label of ["Check", "Details", "More actions for Task Runner"]) {
    await expectTypedIconAction(page, readyRow.getByRole("button", { name: label }), label);
  }
  const more = readyRow.getByRole("button", { name: "More actions for Task Runner" });
  await more.focus();
  await expect(more).toBeFocused();
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Disable" })).toBeVisible();
  await page.keyboard.press("Escape");
  const restoredMore = readyRow.getByRole("button", { name: "More actions for Task Runner" });
  await expect(restoredMore).toBeFocused();
  await assertNoBrowserFailures(page);
});

test("retains the last plugin list when refresh fails and recovers through Retry", async ({ page }) => {
  const fixture = await setupPluginManager(page, createCatalog());
  await openPluginManager(page);

  fixture.failNextRefresh(300);
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  const retained = page.locator('[data-plugin-refresh-retained="true"]');
  await expect(retained).toBeVisible();
  await expect(retained).toContainText("Plugin list update failed");
  await expect(retained).toContainText("Stale · Showing 3 Plugins");
  await expect(page.locator(".plugin-table-row")).toHaveCount(3);
  acknowledgeExpectedPluginFailure(page);

  const retry = retained.getByRole("button", { name: "Retry" });
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(retained).toHaveCount(0);
  await expect(page.locator(".plugin-table-row")).toHaveCount(3);
  await assertNoBrowserFailures(page);
});

test("keeps mutation busy and failure feedback scoped to the triggering row", async ({ page }) => {
  const plugins = [
    createReadyPlugin(1, { id: "built-in:runner-ready", displayName: "Task Runner" }),
    createReadyPlugin(2, { id: "built-in:research-ready", displayName: "Research Helper" }),
  ];
  const fixture = await setupPluginManager(page, plugins);
  await openPluginManager(page);
  fixture.failNextMutation("built-in:runner-ready", "check", 400);

  const target = pluginRow(page, "built-in:runner-ready");
  const other = pluginRow(page, "built-in:research-ready");
  const check = target.getByRole("button", { name: "Check" });
  await expectTypedIconAction(page, check, "Check");
  await check.focus();
  await expect(check).toBeFocused();
  await check.click();
  await expect(check).toHaveAttribute("aria-busy", "true");
  await expect(check).toBeDisabled();
  await expect(other.getByRole("button", { name: "Check" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);

  await expect(target.getByRole("alert")).toHaveText("Check · failed");
  await expect(target.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(other.getByRole("alert")).toHaveCount(0);
  acknowledgeExpectedPluginFailure(page);
  await expect(target.getByRole("alert")).toBeVisible();

  await target.getByRole("button", { name: "Retry" }).click();
  await expect(target.getByRole("alert")).toHaveCount(0);
  await expect(target.locator(".plugin-table-status")).not.toHaveText("Needs attention");
  await assertNoBrowserFailures(page);
});

test("keeps a generic runtime mutation failure inside its detail Drawer owner", async ({ page }) => {
  const packageRecord = createMockBundledCuaPackageRecord();
  const linkedResources = [{ kind: "mcp-server" as const, id: "mcp_desktop", present: true, enabled: true, displayName: "Desktop MCP" }];
  const bundled = createMockBundledCuaPlugin({
    displayName: "Desktop Bridge",
    status: "enabled",
    package: packageRecord,
    linkedResources,
    runtimePreview: createMockBundledRuntimePreview({ status: "injectable", packageRecord, linkedResources }),
  });
  const fixture = await setupPluginManager(page, [bundled]);
  await openPluginManager(page);
  fixture.failNextMutation(bundled.id, "runtime-preview", 300);

  await pluginRow(page, bundled.id).getByRole("button", { name: "Details" }).click();
  const drawer = page.getByRole("dialog", { name: /Desktop Bridge/ });
  await drawer.getByText("Runtime preview", { exact: true }).first().click();
  await drawer.getByRole("button", { name: "Runtime preview" }).click();
  const failure = drawer.locator('[data-plugin-action-failure="runtime-preview"]');
  await expect(failure).toContainText("Runtime preview · failed");
  await expect(pluginRow(page, bundled.id).getByRole("alert")).toHaveCount(0);
  acknowledgeExpectedPluginFailure(page);
  await dismissErrorToast(page);
  await expect(failure).toBeVisible();

  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(failure).toHaveCount(0);
  await assertNoBrowserFailures(page);
});

test("keeps raw runtime and provider data folded behind product summaries", async ({ page }) => {
  const packageRecord = createMockBundledCuaPackageRecord();
  const bundled = createMockBundledCuaPlugin({
    displayName: "Desktop Bridge",
    status: "enabled",
    package: packageRecord,
    linkedResources: [{ kind: "mcp-server", id: "mcp_missing", present: false, displayName: "Desktop MCP" }],
    runtimePreview: createMockBundledRuntimePreview({
      status: "blocked",
      packageRecord,
      linkedResources: [{ kind: "mcp-server", id: "mcp_missing", present: false, displayName: "Desktop MCP" }],
    }),
  });
  await setupPluginManager(page, [bundled]);
  await openPluginManager(page);

  await pluginRow(page, bundled.id).getByRole("button", { name: "Details" }).click();
  const drawer = page.getByRole("dialog", { name: /Desktop Bridge/ });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Bundled · 0.2.0");
  await expect(drawer.locator(".plugin-detail-technical")).not.toHaveAttribute("open", "");
  await expect(drawer.getByText(packageRecord.cacheRef, { exact: true })).toBeHidden();
  await drawer.getByText("Runtime preview", { exact: true }).first().click();
  await expect(drawer.getByText("Not ready for new runs")).toBeVisible();
  await expect(drawer.getByText("Runtime preview has blockers. Open technical details to inspect.", { exact: true }).first()).toBeVisible();
  await drawer.getByText("Technical details", { exact: true }).click();
  await expect(drawer.getByText(packageRecord.cacheRef, { exact: true })).toBeVisible();
  await assertNoBrowserFailures(page);
});

test("uses a shared create dialog with field focus, transport retention and failure ownership", async ({ page }) => {
  await setupPluginManager(page, [createMockCuaPlugin()]);
  await openPluginManager(page);

  await page.getByRole("button", { name: "Add plugin" }).click();
  const dialog = page.getByRole("dialog", { name: "Add plugin" });
  await dialog.getByRole("button", { name: "Add plugin" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Plugin name is required.");
  await expect(dialog.getByLabel("Plugin name")).toBeFocused();
  await dialog.getByLabel("Plugin name").fill("Local research");
  await dialog.getByLabel("Plugin description").fill("Reads selected sources through a trusted local MCP server.");
  await dialog.getByLabel("Command").fill("npx");
  await dialog.getByLabel("Connection type").selectOption("streamable-http");
  await dialog.getByLabel("Endpoint URL").fill("https://example.com/mcp");
  await dialog.getByLabel("Connection type").selectOption("stdio");
  await expect(dialog.getByLabel("Command")).toHaveValue("npx");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await assertNoBrowserFailures(page);
});

test("confirms bundled package uninstall and retains the catalog row", async ({ page }) => {
  const packageRecord = createMockBundledCuaPackageRecord();
  const bundled = createMockBundledCuaPlugin({ displayName: "Desktop Bridge", package: packageRecord, status: "disabled" });
  await setupPluginManager(page, [bundled]);
  await openPluginManager(page);

  const row = pluginRow(page, bundled.id);
  await row.getByRole("button", { name: /More actions for Desktop Bridge/ }).click();
  await page.getByRole("menuitem", { name: "Uninstall" }).click();
  let dialog = page.getByRole("dialog", { name: "Uninstall Desktop Bridge?" });
  await expect(dialog).toContainText("past run evidence are kept");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await row.getByRole("button", { name: /More actions for Desktop Bridge/ }).click();
  await page.getByRole("menuitem", { name: "Uninstall" }).click();
  dialog = page.getByRole("dialog", { name: "Uninstall Desktop Bridge?" });
  await dialog.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pluginRow(page, bundled.id)).toBeVisible();
  await expect(pluginRow(page, bundled.id).locator(".plugin-table-status")).toHaveText("Not installed");
  await assertNoBrowserFailures(page);
});

test("renders six loading rows and keeps 100 plugins in an internal scroll owner", async ({ page }) => {
  const plugins = Array.from({ length: 100 }, (_, index) => createReadyPlugin(index + 1));
  await setupPluginManager(page, plugins, { listDelayMs: 650 });
  await openPluginManager(page, false);
  await expect(page.locator(".plugin-table-skeleton-row")).toHaveCount(6);
  await expect(page.locator(".plugin-table-row")).toHaveCount(100);

  const metrics = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".plugin-table-body");
    const table = document.querySelector<HTMLElement>(".plugin-table");
    return {
      bodyOverflow: (body?.scrollHeight ?? 0) - (body?.clientHeight ?? 0),
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableOverflowX: (table?.scrollWidth ?? 0) - (table?.clientWidth ?? 0),
    };
  });
  expect(metrics.bodyOverflow).toBeGreaterThan(0);
  expect(metrics.documentOverflowX).toBeLessThanOrEqual(1);
  expect(metrics.tableOverflowX).toBeLessThanOrEqual(1);
  await assertNoBrowserFailures(page);
});

test("keeps CUA setup and Windows repair semantics separate", async ({ page }) => {
  await setupPluginManager(page, [createMockCuaPlugin()]);
  await openPluginManager(page);
  await pluginRow(page, "trusted-local:cua-driver").getByRole("button", { name: "Installation guide" }).click();
  const guide = page.getByRole("dialog", { name: "Install Cua Driver" });
  await expect(guide).toContainText("Ling will only detect and connect the local driver");
  await guide.getByText("Use a custom executable path").click();
  await guide.getByLabel("Executable path").fill("relative/cua-driver");
  await guide.getByRole("button", { name: "Recheck" }).click();
  await expect(guide.getByRole("alert")).toContainText("absolute executable path");
  await guide.getByRole("button", { name: "Close" }).click();
  await assertNoBrowserFailures(page);
});

test("evidence: captures real Vite Plugin Manager states after functional gates", async ({ page }) => {
  const plugins = createCatalog();
  const fixture = await setupPluginManager(page, plugins);
  await page.setViewportSize({ width: 1440, height: 960 });
  await openPluginManager(page);
  await capture(page, "1440x960-ling-light-list-ready.png");

  fixture.failNextRefresh(250);
  await triggerFocusRevalidation(page);
  await expect(page.locator('[data-plugin-refresh-retained="true"]')).toBeVisible();
  acknowledgeExpectedPluginFailure(page);
  await capture(page, "1440x960-ling-light-retained-refresh-failure.png");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-plugin-refresh-retained="true"]')).toHaveCount(0);

  await page.getByLabel("Search plugins").fill("no-result-evidence");
  await expect(page.getByText("No plugins match the current filters")).toBeVisible();
  await capture(page, "1440x960-ling-light-search-no-result.png");
  await page.getByRole("button", { name: "Clear filters" }).click();

  await page.getByRole("button", { name: "Add plugin" }).click();
  await page.getByRole("dialog", { name: "Add plugin" }).getByRole("button", { name: "Add plugin" }).click();
  await expect(page.getByRole("dialog", { name: "Add plugin" }).getByRole("alert")).toBeVisible();
  await capture(page, "1440x960-ling-light-create-validation.png");
  await page.getByRole("dialog", { name: "Add plugin" }).getByRole("button", { name: "Close" }).click();

  await setTheme(page, "ling-dark");
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPluginManager(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await pluginRow(page, "bundled:cua-driver").getByRole("button", { name: "Details" }).click();
  let detail = page.getByRole("dialog", { name: /Desktop Bridge/ });
  await detail.getByText("Runtime preview", { exact: true }).first().click();
  await expect(detail.getByText("Not ready for new runs")).toBeVisible();
  await capture(page, "1280x800-ling-dark-detail-runtime-blocked.png");
  await detail.getByRole("button", { name: "Close" }).click();

  const packageRecord = createMockBundledCuaPackageRecord();
  const linkedResources = [{ kind: "mcp-server" as const, id: "mcp_desktop", present: true, enabled: true, displayName: "Desktop MCP" }];
  const bundledIndex = fixture.state.managedPlugins.findIndex((plugin) => plugin.id === "bundled:cua-driver");
  fixture.state.managedPlugins[bundledIndex] = createMockBundledCuaPlugin({
    ...fixture.state.managedPlugins[bundledIndex],
    status: "enabled",
    package: packageRecord,
    linkedResources,
    runtimePreview: createMockBundledRuntimePreview({ status: "injectable", packageRecord, linkedResources }),
  });
  await triggerFocusRevalidation(page);
  await pluginRow(page, "bundled:cua-driver").getByRole("button", { name: "Details" }).click();
  detail = page.getByRole("dialog", { name: /Desktop Bridge/ });
  await detail.getByText("Runtime preview", { exact: true }).first().click();
  fixture.failNextMutation("bundled:cua-driver", "runtime-preview", 250);
  await detail.getByRole("button", { name: "Runtime preview" }).click();
  await expect(detail.locator('[data-plugin-action-failure="runtime-preview"]')).toBeVisible();
  acknowledgeExpectedPluginFailure(page);
  await dismissErrorToast(page);
  await capture(page, "1280x800-ling-dark-detail-mutation-failure.png");
  await detail.getByRole("button", { name: "Close" }).click();

  await setTheme(page, "ling-light");
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 960 });
  await openPluginManager(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await pluginRow(page, "bundled:cua-driver").getByRole("button", { name: /More actions for Desktop Bridge/ }).click();
  await page.getByRole("menuitem", { name: "Uninstall" }).click();
  await expect(page.getByRole("dialog", { name: "Uninstall Desktop Bridge?" })).toBeVisible();
  await capture(page, "1440x960-ling-light-uninstall-confirm.png");
  await page.getByRole("dialog", { name: "Uninstall Desktop Bridge?" }).getByRole("button", { name: "Cancel" }).click();

  await setTheme(page, "ling-dark");
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPluginManager(page);
  await page.getByLabel("Status filter").selectOption("needs-action");
  await capture(page, "1280x800-ling-dark-list-needs-action.png");
  await page.getByLabel("Status filter").selectOption("all");
  await pluginRow(page, "trusted-local:cua-driver").getByRole("button", { name: "Installation guide" }).click();
  await expect(page.getByRole("dialog", { name: "Install Cua Driver" })).toBeVisible();
  await capture(page, "1280x800-ling-dark-cua-repair.png");
  await assertNoBrowserFailures(page);
});

function createCatalog(): MockManagedPlugin[] {
  const packageRecord = createMockBundledCuaPackageRecord();
  return [
    createReadyPlugin(1, { id: "built-in:runner-ready", displayName: "Task Runner" }),
    createMockBundledCuaPlugin({
      displayName: "Desktop Bridge",
      status: "enabled",
      package: packageRecord,
      linkedResources: [{ kind: "mcp-server", id: "mcp_missing", present: false, displayName: "Desktop MCP" }],
      runtimePreview: createMockBundledRuntimePreview({
        status: "blocked",
        packageRecord,
        linkedResources: [{ kind: "mcp-server", id: "mcp_missing", present: false, displayName: "Desktop MCP" }],
      }),
    }),
    createMockCuaPlugin(),
  ];
}

function createReadyPlugin(index: number, overrides: Partial<MockManagedPlugin> = {}): MockManagedPlugin {
  return {
    id: `built-in:ready-${index}`,
    displayName: `Ready Plugin ${String(index).padStart(3, "0")}`,
    version: "1.0.0",
    sourceKind: "built-in",
    status: "enabled",
    description: "A compact built-in capability used for UI 2.0 verification.",
    trustSummary: "Built into Ling and governed by the existing workspace policy.",
    contributions: [],
    linkedResources: [],
    events: [],
    health: {
      pluginId: `built-in:ready-${index}`,
      checkedAt: "2026-07-22T00:00:00.000Z",
      expiresAt: "2030-07-22T00:00:00.000Z",
      status: "ready",
    },
    actions: {
      canEnable: false,
      canDisable: true,
      canCheck: true,
      canApplyPreset: false,
      canInstall: false,
      canUninstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
    },
    ...overrides,
  };
}

async function setupPluginManager(
  page: Page,
  plugins: MockManagedPlugin[],
  options: { readonly listDelayMs?: number } = {},
): Promise<PluginManagerFixture> {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ling-stack.locale")) localStorage.setItem("ling-stack.locale", "en-US");
    if (!localStorage.getItem("ling-stack.themePreference")) localStorage.setItem("ling-stack.themePreference", "light");
  });
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
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
        status: 503,
        json: { error: "plugin_catalog_unavailable", message: "Plugin catalog is temporarily unavailable." },
      });
      return;
    }
    if (options.listDelayMs) await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-workspace", plugins: state.managedPlugins } });
  });
  await page.route("**/plugins/**", async (route) => {
    const request = route.request();
    const match = /^\/plugins\/([^/]+)\/([^/]+)$/u.exec(new URL(request.url()).pathname);
    if (!match) {
      await route.fallback();
      return;
    }
    const key = `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`;
    const delayMs = mutationFailures.get(key);
    if (delayMs === undefined) {
      await route.fallback();
      return;
    }
    mutationFailures.delete(key);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 503,
      json: { error: "plugin_action_failed", message: "Plugin action could not be completed." },
    });
  });
  return {
    state,
    failNextRefresh: (delayMs = 0) => {
      refreshFailureDelayMs = delayMs;
    },
    failNextMutation: (pluginId, action, delayMs = 0) => {
      mutationFailures.set(`${pluginId}:${action}`, delayMs);
    },
  };
}

async function openPluginManager(page: Page, waitForRows = true): Promise<void> {
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.locator(".plugin-manager-page .settings-plugin-manager")).toBeVisible();
  if (waitForRows) await expect(page.locator(".plugin-table-row").first()).toBeVisible();
}

function pluginRow(page: Page, pluginId: string) {
  return page.locator(`.plugin-table-row[data-plugin-id="${pluginId}"]`);
}

async function expectTypedIconAction(page: Page, action: Locator, label: string): Promise<void> {
  await expect(action).toHaveAttribute("data-icon-only", "true");
  await expect(action).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(action).toHaveAttribute("aria-label", label);
  await expect(action).toHaveAttribute("title", label);
  await expect(action.locator("[data-ling-icon]")).toHaveCount(1);
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(32);
  await action.hover();
  const tooltip = page.getByRole("tooltip", { name: label });
  await expect(tooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
}

async function capture(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await assertNoBrowserFailures(page);
  await page.screenshot({ path: path.join(evidenceDir, fileName) });
}

async function setTheme(page: Page, themeId: "ling-dark" | "ling-light"): Promise<void> {
  await page.evaluate((nextThemeId) => {
    const selection = JSON.stringify({ mode: "fixed", themeId: nextThemeId });
    localStorage.setItem("ling-stack.themeSelection", selection);
    localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    localStorage.setItem("ling-stack.themePreference", nextThemeId === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", nextThemeId === "ling-dark" ? "dark" : "light");
    localStorage.removeItem("ling-stack.themeBootstrapSnapshot");
  }, themeId);
}

async function assertNoBrowserFailures(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    documentOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(metrics.documentOverflowX).toBeLessThanOrEqual(1);
  expect(metrics.documentOverflowY).toBeLessThanOrEqual(1);
  expect(browserFailures.get(page) ?? []).toEqual([]);
}

function acknowledgeExpectedPluginFailure(page: Page): void {
  const failures = browserFailures.get(page) ?? [];
  const index = failures.findIndex((message) =>
    message === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)");
  expect(index).toBeGreaterThanOrEqual(0);
  failures.splice(index, 1);
}

async function dismissErrorToast(page: Page): Promise<void> {
  const toast = page.locator('.ling-ui-toast[data-tone="error"]');
  await expect(toast).toBeVisible();
  await toast.locator(".ling-ui-toast-close").click({ force: true });
  await expect(toast).toHaveCount(0);
}
