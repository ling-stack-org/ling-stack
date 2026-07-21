import { expect, test, type Page } from "@playwright/test";
import {
  createMockBundledEmbeddedCuaPlugin,
  createMockCuaPlugin,
  mockDaemon,
  type MockManagedPlugin,
} from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: /^(Plugin Manager|插件管理)$/ }).click();
  await expect(page.locator(".plugin-manager-page .settings-plugin-manager")).toBeVisible();
}

function pluginRow(page: Page, pluginId: string) {
  return page.locator(`.plugin-table-row[data-plugin-id="${pluginId}"]`);
}

function createTablePlugin(index: number, overrides: Partial<MockManagedPlugin> = {}): MockManagedPlugin {
  return {
    id: `built-in:table-plugin-${String(index).padStart(2, "0")}`,
    displayName: `Table Plugin ${String(index).padStart(2, "0")}`,
    version: `1.0.${index}`,
    sourceKind: "built-in",
    status: "disabled",
    trustSummary: "",
    contributions: [],
    linkedResources: [],
    events: [],
    actions: {
      canEnable: true,
      canDisable: false,
      canCheck: true,
      canApplyPreset: false,
    },
    ...overrides,
  };
}

test("Cua Driver uses one table row, global toasts, and a separate detail drawer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Engineer" })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const pluginsPanel = page.locator(".settings-plugin-manager");
  const table = page.getByRole("table", { name: "Plugins" });
  const cuaRow = pluginRow(page, "trusted-local:cua-driver");
  await expect(page.locator(".workspace-plugins-surface > .workspace-head")).toHaveCount(0);
  await expect(table.getByRole("columnheader")).toHaveText(["Plugin", "Status", "Actions"]);
  await expect(table.locator(".plugin-table-row")).toHaveCount(1);
  await expect(cuaRow).toContainText("Controls macOS apps through the local Cua Driver.");
  await expect(cuaRow.locator(".plugin-table-status")).toHaveText("Not installed");
  await expect(pluginsPanel).not.toContainText("Bundled");
  await expect(pluginsPanel.getByRole("button", { name: "MCP settings" })).toHaveCount(0);
  await expect(cuaRow.locator("details")).toHaveCount(0);
  await expect(cuaRow.locator(".meta-row")).toHaveCount(0);

  await cuaRow.getByRole("button", { name: "Installation guide" }).click();
  const installDrawer = page.getByRole("dialog", { name: "Install Cua Driver" });
  await expect(installDrawer).toBeVisible();
  await expect(installDrawer.getByRole("link", { name: "Open official guide" })).toHaveAttribute("href", "https://cua.ai/docs/cua-driver");
  await expect(installDrawer.locator("code")).toContainText("https://cua.ai/driver/install.sh");
  await installDrawer.getByRole("button", { name: "Copy install command" }).click();
  await expect(installDrawer.getByRole("status")).toContainText("Command copied");

  await installDrawer.getByText("Use a custom executable path").click();
  const commandInput = installDrawer.getByLabel("Executable path");
  await commandInput.fill("relative/cua-driver");
  await installDrawer.getByRole("button", { name: "Recheck" }).click();
  await expect(installDrawer.getByRole("alert")).toContainText("absolute executable path");

  await commandInput.fill("/Applications/Cua Driver.app/Contents/MacOS/cua-driver");
  await installDrawer.getByRole("button", { name: "Recheck" }).click();
  await expect(installDrawer).toHaveCount(0);
  await expect(cuaRow.locator(".plugin-table-status")).toHaveText("Awaiting enable");
  await expect(cuaRow.getByRole("button", { name: "Installation guide" })).toHaveCount(0);
  await expect(cuaRow.getByRole("button", { name: "Check" })).toBeVisible();
  await expect(cuaRow.getByRole("button", { name: "Enable" })).toBeVisible();
  expect(state.mcpServers).toHaveLength(1);
  expect(state.mcpServers[0].enabled).toBe(false);
  expect(state.mcpServers[0].command).toBe("/Applications/Cua Driver.app/Contents/MacOS/cua-driver");

  await cuaRow.getByRole("button", { name: "Enable" }).click();
  await expect(cuaRow.locator(".plugin-table-status")).toHaveText("Enabled");
  await expect(cuaRow).not.toContainText("Enabled and ready");
  for (const actionName of ["Check", "Disable", "Details"]) {
    const action = cuaRow.getByRole("button", { name: actionName });
    await expect(action).toHaveCSS("width", "30px");
    await expect(action.locator("span")).toHaveCount(0);
    await expect(action).toHaveAttribute("title", actionName);
  }
  await expect(page.locator(".ling-toast").filter({ hasText: "Plugin enabled." })).toBeVisible();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toHaveCount(0);
  expect(state.mcpServers[0].enabled).toBe(true);
  expect(state.mcpTools.filter((tool) => tool.serverId === "mcp_cua_driver").map((tool) => [tool.name, tool.defaultApproval])).toEqual([
    ["check_permissions", "allow"],
    ["click", "ask"],
    ["list_windows", "allow"],
  ]);

  const rowHeightBefore = await cuaRow.evaluate((element) => element.getBoundingClientRect().height);
  await cuaRow.getByRole("button", { name: "Details" }).click();
  const detailDrawer = page.getByRole("dialog", { name: "Cua Driver" });
  await expect(detailDrawer).toBeVisible();
  await expect(detailDrawer).toContainText("Trusted local");
  await expect(detailDrawer).toContainText("trusted-local:cua-driver");
  await expect(detailDrawer).toContainText("/Applications/Cua Driver.app/Contents/MacOS/cua-driver");
  await expect(detailDrawer.getByText("Last check", { exact: true })).toHaveCount(0);
  await expect(detailDrawer.getByText("Failure reason", { exact: true })).toHaveCount(0);
  await expect(detailDrawer.locator(".meta-row")).toHaveCount(0);
  await expect(detailDrawer.getByRole("button", { name: "Open MCP connection" })).toBeVisible();
  await expect(cuaRow).toHaveCSS("height", `${rowHeightBefore}px`);
  await detailDrawer.getByRole("button", { name: "Close" }).click();

  await cuaRow.getByRole("button", { name: "Disable" }).click();
  await expect(cuaRow.locator(".plugin-table-status")).toHaveText("Awaiting enable");
  await expect(page.locator(".ling-toast").filter({ hasText: "Plugin disabled." })).toBeVisible();
  expect(state.mcpServers[0].enabled).toBe(false);

  await cuaRow.getByRole("button", { name: "Details" }).click();
  await page.getByRole("dialog", { name: "Cua Driver" }).getByRole("button", { name: "Open MCP connection" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /MCP tool servers/ })).toHaveClass(/active/);
  await expect(page.locator(".mcp-server-row").filter({ hasText: "Cua Driver" })).toBeVisible();
});

test("bundled Cua Driver shows macOS permission recovery without an external install path", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  state.managedPlugins[index] = createMockBundledEmbeddedCuaPlugin({
    providerState: "permission_required",
    platform: "darwin",
    requestedEnabled: true,
    effectiveEnabled: false,
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const panel = page.locator(".settings-plugin-manager");
  const row = pluginRow(page, "trusted-local:cua-driver");
  await expect(panel.locator('.plugin-table-row[data-plugin-id*="cua-driver"]')).toHaveCount(1);
  await expect(row).toContainText("Controls macOS and Windows apps through the Cua Driver included with Ling.");
  await expect(row.locator(".plugin-table-status")).toHaveText("Permissions required");
  await expect(row.getByRole("button", { name: "Installation guide" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Install" })).toHaveCount(0);

  await row.getByRole("button", { name: "Review macOS permissions" }).click();
  const detail = page.getByRole("dialog", { name: "Cua Driver" });
  await expect(detail).toContainText("Included with Ling");
  await expect(detail).toContainText("0.8.3");
  await expect(detail).toContainText("Grant Accessibility and Screen Recording to Ling Stack in macOS System Settings, then check again.");
  await expect(detail).not.toContainText("Local driver");
  await expect(page.getByRole("dialog", { name: "Install Cua Driver" })).toHaveCount(0);
});

test("bundled Windows ready state localizes standard coverage and limitations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  state.managedPlugins[index] = createMockBundledEmbeddedCuaPlugin({
    providerState: "ready",
    platform: "win32",
    requestedEnabled: true,
    effectiveEnabled: true,
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const row = pluginRow(page, "trusted-local:cua-driver");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(row).toContainText("通过 Ling 内置的 Cua Driver 控制 macOS 和 Windows 应用。");
  await expect(row.locator(".plugin-table-status")).toHaveText("就绪");
  await expect(row.getByRole("button", { name: "安装引导" })).toHaveCount(0);
  await row.getByRole("button", { name: "详情" }).click();

  const detail = page.getByRole("dialog", { name: "Cua Driver" });
  await expect(detail).toContainText("Ling 内置");
  await expect(detail).toContainText("Windows");
  await expect(detail).toContainText("完整性覆盖范围");
  await expect(detail).toContainText("标准用户应用");
  await expect(detail).toContainText("无法向以管理员权限运行的应用发送像素输入。");
  await expect(detail).toContainText("无法向 UWP 应用发送输入。");
  const panelColor = await detail.evaluate((element) => getComputedStyle(element).backgroundColor);
  const channels = panelColor.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  expect(channels).toHaveLength(3);
  expect(Math.max(...channels)).toBeLessThanOrEqual(70);
});

test("malformed bundled Cua Driver state fails closed without external installation actions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  const malformed = createMockBundledEmbeddedCuaPlugin({
    providerState: "included",
    platform: "darwin",
    requestedEnabled: false,
    effectiveEnabled: false,
  });
  malformed.setup = {
    ...malformed.setup,
    state: "missing",
    providerState: "not_a_real_state",
    requestedEnabled: undefined,
    effectiveEnabled: undefined,
    guide: {
      documentationUrl: "https://cua.ai/docs/cua-driver",
      installCommand: "install-cua-driver",
      supportsCustomCommand: true,
    },
  } as unknown as NonNullable<MockManagedPlugin["setup"]>;
  malformed.actions = {
    ...malformed.actions,
    canEnable: true,
    canInstall: true,
  };
  state.managedPlugins[index] = malformed;
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const row = pluginRow(page, "trusted-local:cua-driver");
  await expect(row.locator(".plugin-table-status")).toHaveText("Needs attention");
  await expect(row.getByRole("button", { name: "Enable" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Installation guide" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Install" })).toHaveCount(0);
  await row.getByRole("button", { name: "Review state" }).click();

  const detail = page.getByRole("dialog", { name: "Cua Driver" });
  await expect(detail).toContainText("Included with Ling");
  await expect(detail).toContainText("Restart Ling Stack. The bundled provider state is invalid.");
  await expect(detail).not.toContainText("Local driver");
  await expect(page.getByRole("dialog", { name: "Install Cua Driver" })).toHaveCount(0);
});

test("adds disabled local command and HTTP plugins with descriptions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  await page.locator(".settings-plugin-manager-head").getByRole("button", { name: "Add plugin" }).click();
  let drawer = page.getByRole("dialog", { name: "Add plugin" });
  await drawer.getByRole("button", { name: "Add plugin" }).click();
  await expect(drawer.getByRole("alert")).toContainText("Plugin name is required.");
  await drawer.getByLabel("Plugin name").fill("Filesystem helper");
  await drawer.getByLabel("Plugin description").fill("Reads selected workspace files through a local MCP server.");
  await drawer.getByRole("textbox", { name: "Command", exact: true }).fill("npx");
  await drawer.getByLabel("Arguments (one per line)").fill("-y\n@modelcontextprotocol/server-filesystem\n/tmp/workspace");
  await drawer.getByRole("button", { name: "Add plugin" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".ling-toast").filter({ hasText: "Plugin added." })).toBeVisible();

  const commandPlugin = state.managedPlugins.find((plugin) => plugin.displayName === "Filesystem helper");
  expect(commandPlugin).toBeTruthy();
  const commandRow = pluginRow(page, commandPlugin?.id ?? "");
  await expect(commandRow).toContainText("Reads selected workspace files through a local MCP server.");
  await expect(commandRow.locator(".plugin-table-status")).toHaveText("Awaiting enable");
  expect(state.mcpServers.at(-1)?.enabled).toBe(false);
  expect(state.mcpServers.at(-1)?.command).toBe("npx");
  expect(state.mcpServers.at(-1)?.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"]);

  await commandRow.getByRole("button", { name: "Enable" }).click();
  await expect(commandRow.locator(".plugin-table-status")).toHaveText("Enabled");
  expect(state.mcpServers.find((server) => server.id === commandPlugin?.linkedResources[0]?.id)?.enabled).toBe(true);

  await page.locator(".settings-plugin-manager-head").getByRole("button", { name: "Add plugin" }).click();
  drawer = page.getByRole("dialog", { name: "Add plugin" });
  await drawer.getByLabel("Plugin name").fill("Remote search");
  await drawer.getByLabel("Plugin description").fill("Connects to the team search MCP endpoint.");
  await drawer.getByLabel("Connection type").selectOption("streamable-http");
  await drawer.getByLabel("Endpoint URL").fill("https://example.com/mcp");
  await drawer.getByRole("button", { name: "Add plugin" }).click();
  await expect(drawer).toHaveCount(0);

  const httpPlugin = state.managedPlugins.find((plugin) => plugin.displayName === "Remote search");
  expect(httpPlugin).toBeTruthy();
  await expect(pluginRow(page, httpPlugin?.id ?? "")).toContainText("Connects to the team search MCP endpoint.");
  expect(state.mcpServers.at(-1)?.transport).toBe("http");
  expect(state.mcpServers.at(-1)?.url).toBe("https://example.com/mcp");
});

test("detected Cua Driver auto-connects once and remains disabled", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const index = state.managedPlugins.findIndex((plugin) => plugin.id === "trusted-local:cua-driver");
  state.managedPlugins[index] = createMockCuaPlugin({
    setup: {
      kind: "local_binary",
      state: "detected",
      checkedAt: "2026-07-13T00:00:00.000Z",
      detectedCommand: "/opt/homebrew/bin/cua-driver",
    },
  });
  let connectCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/plugins/trusted-local%3Acua-driver/connect")) {
      connectCount += 1;
    }
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openPluginManager(page);

  const cuaRow = pluginRow(page, "trusted-local:cua-driver");
  await expect(cuaRow.locator(".plugin-table-status")).toHaveText("Awaiting enable");
  await expect(cuaRow.getByRole("button", { name: "Installation guide" })).toHaveCount(0);
  await expect.poll(() => connectCount).toBe(1);
  expect(state.mcpServers[0].enabled).toBe(false);

  await page.locator(".settings-plugin-manager").getByRole("button", { name: "Refresh" }).click();
  await expect(cuaRow.locator(".plugin-table-status")).toHaveText("Awaiting enable");
  await expect.poll(() => connectCount).toBe(1);
});

test("plugin table scrolls internally with stable rows and a fixed header", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = Array.from({ length: 30 }, (_, index) => createTablePlugin(index + 1));
  state.managedPlugins[0] = createTablePlugin(1, {
    status: "blocked",
    disabledReason: "Local plugin failed its startup check.",
    health: {
      pluginId: "built-in:table-plugin-01",
      checkedAt: "2026-07-13T01:00:00.000Z",
      expiresAt: "2026-07-13T01:05:00.000Z",
      status: "failed",
      message: "Local plugin failed its startup check.",
    },
    actions: {
      canEnable: false,
      canDisable: false,
      canCheck: true,
      canApplyPreset: false,
    },
  });
  await mockDaemon(page, state);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await openPluginManager(page);

  const tableBody = page.locator(".plugin-table-body");
  const header = page.locator(".plugin-table-header");
  const rows = page.locator(".plugin-table-row");
  const headerTop = await header.evaluate((element) => element.getBoundingClientRect().top);
  const metrics = await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>(".plugin-manager-page");
    const body = document.querySelector<HTMLElement>(".plugin-table-body");
    const table = document.querySelector<HTMLElement>(".plugin-table");
    return {
      pageOverflow: (pageElement?.scrollHeight ?? 0) - (pageElement?.clientHeight ?? 0),
      bodyOverflow: (body?.scrollHeight ?? 0) - (body?.clientHeight ?? 0),
      tableOverflowX: (table?.scrollWidth ?? 0) - (table?.clientWidth ?? 0),
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
  expect(metrics.bodyOverflow).toBeGreaterThan(0);
  expect(metrics.tableOverflowX).toBeLessThanOrEqual(1);
  expect(metrics.documentOverflowX).toBeLessThanOrEqual(1);
  await expect(rows).toHaveCount(30);

  const rowHeights = await rows.evaluateAll((elements) => elements.slice(0, 5).map((element) => element.getBoundingClientRect().height));
  for (const height of rowHeights) {
    expect(height).toBeGreaterThanOrEqual(58);
    expect(height).toBeLessThanOrEqual(64);
  }

  await tableBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(pluginRow(page, "built-in:table-plugin-30")).toBeVisible();
  expect(await header.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(headerTop, 0);

  const failedRow = pluginRow(page, "built-in:table-plugin-01");
  await failedRow.getByRole("button", { name: "Details" }).click();
  const drawer = page.getByRole("dialog", { name: "Table Plugin 01" });
  await expect(drawer.getByText("Failure reason", { exact: true })).toBeVisible();
  await expect(drawer).toContainText("Local plugin failed its startup check.");
  await expect(drawer.getByText("Last check", { exact: true })).toHaveCount(0);
});

test("plugin table and both drawers stay within desktop widths", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await openPluginManager(page);

  const cuaRow = pluginRow(page, "trusted-local:cua-driver");
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const pageElement = document.querySelector<HTMLElement>(".plugin-manager-page");
      const manager = document.querySelector<HTMLElement>(".settings-plugin-manager");
      const table = document.querySelector<HTMLElement>(".plugin-table");
      const pageRect = pageElement?.getBoundingClientRect();
      const managerRect = manager?.getBoundingClientRect();
      const tableRect = table?.getBoundingClientRect();
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tableOverflow: (table?.scrollWidth ?? 0) - (table?.clientWidth ?? 0),
        pageWidth: pageRect?.width ?? 0,
        managerWidth: managerRect?.width ?? 0,
        tableWidth: tableRect?.width ?? 0,
      };
    });
    expect(layout.documentOverflow).toBeLessThanOrEqual(1);
    expect(layout.tableOverflow).toBeLessThanOrEqual(1);
    expect(layout.managerWidth).toBeCloseTo(layout.pageWidth, 0);
    expect(layout.tableWidth).toBeCloseTo(layout.pageWidth, 0);
  }

  await cuaRow.getByRole("button", { name: "Details" }).click();
  await expect(page.locator(".plugin-detail-panel")).toBeVisible();
  await expect(page.locator(".plugin-detail-panel")).toHaveCSS("width", "440px");
  await page.getByRole("dialog", { name: "Cua Driver" }).getByRole("button", { name: "Close" }).click();

  await cuaRow.getByRole("button", { name: "Installation guide" }).click();
  await expect(page.locator(".cua-install-panel")).toBeVisible();
  const drawerLayout = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".cua-install-panel");
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelRight: panel?.getBoundingClientRect().right ?? 0,
      panelWidth: panel?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(drawerLayout.documentOverflow).toBeLessThanOrEqual(1);
  expect(drawerLayout.panelRight).toBeCloseTo(1920, 0);
  expect(drawerLayout.panelWidth).toBeLessThanOrEqual(480);
});

test("plugin table, detail drawer, and installation guide use dark theme surfaces", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await openPluginManager(page);

  const cuaRow = pluginRow(page, "trusted-local:cua-driver");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await cuaRow.getByRole("button", { name: "Details" }).click();
  await expect(page.locator(".plugin-detail-panel")).toBeVisible();
  await page.getByRole("dialog", { name: "Cua Driver" }).getByRole("button", { name: "Close" }).click();
  await cuaRow.getByRole("button", { name: "Installation guide" }).click();
  await expect(page.locator(".cua-install-panel")).toBeVisible();

  const colors = await page.evaluate(() => [
    ".plugin-manager-page",
    ".plugin-table",
    ".plugin-table-header",
    ".cua-install-panel",
    ".cua-install-command",
  ].map((selector) => {
    const element = document.querySelector(selector);
    return { selector, color: element ? getComputedStyle(element).backgroundColor : "" };
  }));
  for (const item of colors) {
    const channels = item.color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
    expect(channels).toHaveLength(3);
    expect(Math.max(...channels)).toBeLessThanOrEqual(70);
  }
});
