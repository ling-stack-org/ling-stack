import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  createMockBundledCuaPackageRecord,
  createMockBundledCuaPlugin,
  createMockBundledRuntimePreview,
  createMockCuaPlugin,
  mockDaemon,
  type MockManagedPlugin,
} from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const domainPath = fileURLToPath(new URL("../src/domains/plugins/use-plugins-domain.ts", import.meta.url));
const controllerPath = fileURLToPath(new URL("../src/features/plugins/usePluginManagerController.ts", import.meta.url));
const pagePath = fileURLToPath(new URL("../src/features/plugins/PluginManagerPage.tsx", import.meta.url));
const appShellPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const guardPath = fileURLToPath(new URL("../scripts/check-ui2-feedback.mjs", import.meta.url));

test("T13-P.9EF.D releases Plugin generic errors and freezes explicit operation ownership", async () => {
  const [domain, controller, pluginPage, appShell, guard] = await Promise.all([
    readFile(domainPath, "utf8"),
    readFile(controllerPath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(appShellPath, "utf8"),
    readFile(guardPath, "utf8"),
  ]);

  expect(domain).not.toContain("setErrorMessage");
  expect(readHookCall(appShell, "usePluginsDomain")).not.toContain("setErrorMessage");
  expect(guard).toContain('"apps/web/src/domains/plugins/use-plugins-domain.ts",');
  expect(guard).not.toContain('["apps/web/src/domains/plugins/use-plugins-domain.ts", 15]');
  expect(domain).toContain('export const PLUGIN_DRAFT_ID = "draft";');
  expect(domain).toContain("pluginId, action, ...request");
  expect(domain).toContain("latestActionRequestsRef.current.get(pluginActionKey(action)) === action.requestId");
  expect(domain).toContain('`${action.pluginId}:${action.action}:${action.owner}`');
  expect(domain).toContain("clearPluginActionErrors({ pluginId, action });");
  expect(controller).not.toContain("pluginSnapshotFingerprint");
  expect(controller).toContain("findLatestOwnedAction");
  expect(controller).toContain('requested === "row" && candidate === "detected-connect"');
  for (const action of ["apply", "check", "validate", "install", "refresh-package", "runtime-preview", "enable", "disable", "create", "connect", "uninstall"]) {
    expect(pluginPage, `${action} must pass through the focused owner controller`).toContain(`action: "${action}"`);
  }
  expect(appShell).toContain("loadError={pluginsLoadError}");
  expect(appShell).toContain("actionErrors={pluginActionErrors}");
  expect(appShell).toContain("pendingActions={pluginPendingActions}");
});

test("T13-P.9EF.D detected connect failure belongs to its Plugin row instead of the load owner", async ({ page }) => {
  await preparePage(page);
  const detected = createMockCuaPlugin({
    setup: {
      kind: "local_binary",
      state: "detected",
      checkedAt: "2026-07-27T00:00:00.000Z",
      detectedCommand: "/usr/local/bin/cua-driver",
    },
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = [detected];
  await mockDaemon(page, state);
  await page.route("**/plugins/**", async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith("/connect")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "plugin_connect_failed", message: "Synthetic detected connect failure" },
    });
  });

  await openPluginManager(page);
  const rowFailure = pluginRow(page, detected.id).getByRole("alert");
  await expect(rowFailure).toHaveText("Recheck · failed");
  await expect(rowFailure).toHaveAttribute("title", "Synthetic detected connect failure");
  await expect(page.locator('[data-plugin-refresh-retained="true"]')).toHaveCount(0);
  await expect(failureToast(page, detected.id, "connect", "detected-connect"))
    .toContainText("Synthetic detected connect failure");
});

test("T13-P.9EF.D Plugin load failure remains on the Plugin page and never reaches Work Board", async ({ page }) => {
  await preparePage(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = [];
  await mockDaemon(page, state);
  await page.route("**/plugins?**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "plugin_catalog_unavailable", message: "Synthetic Plugin catalog failure" },
    });
  });

  await openPluginManager(page, false);
  const loadFailure = page.locator('[data-plugin-refresh-retained="true"]');
  await expect(loadFailure).toBeVisible();
  await expect(loadFailure).toContainText("Synthetic Plugin catalog failure");
  await expect(page.locator('[data-ling-overlay="toast"][data-tone="error"]')).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Work Board" }).click();
  await expect(page.getByText("Synthetic Plugin catalog failure", { exact: true })).toHaveCount(0);
  await expect(page.locator(".settings-plugin-manager")).toHaveCount(0);
});

test("T13-P.9EF.D late row failure keeps plugin identity and survives unrelated success and Toast dismissal", async ({ page }) => {
  await preparePage(page);
  const first = createReadyPlugin("built-in:owner-a", "Owner A");
  const second = createReadyPlugin("built-in:owner-b", "Owner B");
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = [first, second];
  await mockDaemon(page, state);
  let failFirstCheck = true;
  await page.route("**/plugins/**", async (route) => {
    const match = /^\/plugins\/([^/]+)\/check$/u.exec(new URL(route.request().url()).pathname);
    const pluginId = match ? decodeURIComponent(match[1] ?? "") : "";
    if (route.request().method() !== "POST" || pluginId !== first.id || !failFirstCheck) {
      await route.fallback();
      return;
    }
    failFirstCheck = false;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      status: 503,
      json: { error: "plugin_check_failed", message: "Synthetic late Owner A failure" },
    });
  });
  await openPluginManager(page);

  const firstRow = pluginRow(page, first.id);
  const secondRow = pluginRow(page, second.id);
  const firstCheck = firstRow.getByRole("button", { name: "Check" });
  await firstCheck.click();
  await expect(firstCheck).toHaveAttribute("aria-busy", "true");
  await expect(secondRow.getByRole("button", { name: "Check" })).toBeEnabled();
  await secondRow.getByRole("button", { name: "Check" }).click();
  await expect(successToast(page, second.id, "check", "row")).toBeVisible();
  await expect(secondRow.getByRole("alert")).toHaveCount(0);

  const firstFailure = firstRow.getByRole("alert");
  await expect(firstFailure).toHaveText("Check · failed");
  await expect(firstFailure).toHaveAttribute("title", "Synthetic late Owner A failure");
  await expect(secondRow.getByRole("alert")).toHaveCount(0);
  const errorToast = failureToast(page, first.id, "check", "row");
  await expect(errorToast).toContainText("Synthetic late Owner A failure");
  await errorToast.locator(".ling-ui-toast-close").click({ force: true });
  await expect(errorToast).toHaveCount(0);
  await expect(firstFailure).toBeVisible();

  await secondRow.getByRole("button", { name: "Check" }).click();
  await expect(successToast(page, second.id, "check", "row")).toBeVisible();
  await expect(firstFailure).toBeVisible();

  await firstRow.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: /Owner A/ });
  await expect(details.locator("[data-plugin-action-failure]")).toHaveCount(0);
  await details.getByRole("button", { name: "Close" }).click();
  await expect(firstFailure).toBeVisible();

  await firstRow.getByRole("button", { name: "Retry" }).click();
  await expect(firstFailure).toHaveCount(0);
  await expect(successToast(page, first.id, "check", "row")).toBeVisible();
});

test("T13-P.9EF.D Detail and draft failures stay persistent in their Drawer and Dialog owners", async ({ page }) => {
  await preparePage(page);
  const packageRecord = createMockBundledCuaPackageRecord();
  const linkedResources = [{ kind: "mcp-server" as const, id: "mcp_owner", present: true, enabled: true, displayName: "Owner MCP" }];
  const plugin = createMockBundledCuaPlugin({
    id: "bundled:owner-runtime",
    displayName: "Owner Runtime",
    status: "enabled",
    package: packageRecord,
    linkedResources,
    runtimePreview: createMockBundledRuntimePreview({ status: "injectable", packageRecord, linkedResources }),
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = [plugin];
  await mockDaemon(page, state);
  await page.route("**/plugins/**", async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith("/runtime-preview")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "plugin_preview_failed", message: "Synthetic detail preview failure" },
    });
  });
  await page.route("**/plugins?**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "plugin_create_failed", message: "Synthetic draft creation failure" },
    });
  });
  await openPluginManager(page);

  await pluginRow(page, plugin.id).getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: /Owner Runtime/ });
  await details.getByText("Runtime preview", { exact: true }).first().click();
  await details.getByRole("button", { name: "Runtime preview" }).click();
  const detailFailure = details.locator('[data-plugin-action-failure="runtime-preview"]');
  await expect(detailFailure).toContainText("Runtime preview · failed");
  await expect(detailFailure).toContainText("Synthetic detail preview failure");
  const previewToast = failureToast(page, plugin.id, "runtime-preview", "detail");
  await previewToast.locator(".ling-ui-toast-close").click({ force: true });
  await expect(detailFailure).toBeVisible();
  await details.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Add plugin" }).click();
  const create = page.getByRole("dialog", { name: "Add plugin" });
  await create.getByLabel("Plugin name").fill("Draft Owner");
  await create.getByLabel("Plugin description").fill("A draft-scoped ownership fixture.");
  await create.getByRole("textbox", { name: "Command", exact: true }).fill("node");
  await create.getByRole("button", { name: "Add plugin" }).click();
  const createFailure = create.locator('[data-plugin-action-failure="create"]');
  await expect(createFailure).toContainText("Synthetic draft creation failure");
  const createToast = failureToast(page, "draft", "create", "create");
  await expect(createToast).toContainText("Synthetic draft creation failure");
  await createToast.locator(".ling-ui-toast-close").click({ force: true });
  await expect(createFailure).toBeVisible();
  await expect(page.locator('[data-plugin-refresh-retained="true"]')).toHaveCount(0);
});

function readHookCall(source: string, hook: string): string {
  const start = source.indexOf(`${hook}({`);
  const end = source.indexOf("\n  });", start);
  expect(start, `${hook} call must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${hook} call must have a stable boundary`).toBeGreaterThan(start);
  return source.slice(start, end);
}

async function preparePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
}

async function openPluginManager(page: Page, waitForRows = true): Promise<void> {
  await page.goto("/");
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.locator(".settings-plugin-manager")).toBeVisible();
  if (waitForRows) await expect(page.locator(".plugin-table-row").first()).toBeVisible();
}

function pluginRow(page: Page, pluginId: string) {
  return page.locator(`.plugin-table-row[data-plugin-id="${pluginId}"]`);
}

function successToast(page: Page, pluginId: string, action: string, owner: string) {
  return page.locator(`[data-ling-overlay="toast"][data-tone="success"][data-scope="plugin:${pluginId}:${action}:${owner}"]`);
}

function failureToast(page: Page, pluginId: string, action: string, owner: string) {
  return page.locator(`[data-ling-overlay="toast"][data-tone="error"][data-scope="plugin:${pluginId}:${action}:${owner}"]`);
}

function createReadyPlugin(id: string, displayName: string): MockManagedPlugin {
  return {
    id,
    displayName,
    version: "1.0.0",
    sourceKind: "built-in",
    status: "enabled",
    description: `${displayName} ownership fixture.`,
    trustSummary: "Built into Ling and governed by workspace policy.",
    contributions: [],
    linkedResources: [],
    events: [],
    health: {
      pluginId: id,
      checkedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2030-07-27T00:00:00.000Z",
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
}
