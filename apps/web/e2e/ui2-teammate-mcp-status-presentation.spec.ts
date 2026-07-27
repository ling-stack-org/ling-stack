import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  teammateMcpServerStatusPresentation,
  teammateMcpToolEffectPresentation,
} from "../src/features/teammates/teammate-mcp-status-presentation.js";
import type { McpServer, McpToolSideEffectLevel } from "../src/types.js";
import {
  mockDaemon,
  toPublicMockMcpServer,
  type MockMcpServer,
  type MockState,
} from "./support/mock-daemon";
import {
  createBaseState,
  createMockMcpServer,
  createMockMcpTool,
  createMockTeammate,
  cwd,
} from "./support/mock-state";

test("Teammate MCP presentation keeps frozen server and side-effect semantics", () => {
  const fixture = createMcpStatusFixture();
  const expectedServerStates = [
    ["mcp_status_unknown", "needs-check", "Check needed", "neutral"],
    ["mcp_status_checking", "checking", "Checking", "info"],
    ["mcp_status_ready", "ready", "Ready", "success"],
    ["mcp_status_failed", "failed", "Unavailable", "danger"],
    ["mcp_status_disabled", "disabled", "Disabled", "neutral"],
    ["mcp_status_migration", "migration", "Credential migration required", "warning"],
    ["mcp_status_auth", "auth-blocked", "Credential needs attention", "warning"],
  ] as const;
  expect(expectedServerStates.map(([id]) => teammateMcpServerStatusPresentation(serverById(fixture.publicServers, id)))).toEqual(
    expectedServerStates.map(([, id, labelKey, tone]) => ({ id, labelKey, tone })),
  );

  const expectedEffects: ReadonlyArray<readonly [McpToolSideEffectLevel, string, string]> = [
    ["none", "No side effects", "neutral"],
    ["read", "Read", "neutral"],
    ["write", "Write", "warning"],
    ["write-network", "Write network", "warning"],
    ["external", "External action", "warning"],
    ["credential", "Credential", "danger"],
    ["deploy", "Deploy", "danger"],
  ];
  expect(expectedEffects.map(([effect]) => teammateMcpToolEffectPresentation(effect))).toEqual(
    expectedEffects.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
});

test("Ling Light renders all Teammate MCP states and seven side-effect badges without legacy roots", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const fixture = createMcpStatusFixture();
  await installMcpStatusFixture(page, fixture);
  await page.goto("/");

  const panel = await openTeammateMcpSettings(page);
  const expectedRows = [
    ["Unchecked MCP", "Check needed", "neutral"],
    ["Checking MCP", "Checking", "info"],
    ["Ready MCP", "Ready", "success"],
    ["Failed MCP", "Unavailable", "danger"],
    ["Disabled MCP", "Disabled", "neutral"],
    ["Legacy credential MCP", "Credential migration required", "warning"],
    ["Credential attention MCP with an intentionally long server identity for overflow containment", "Credential needs attention", "warning"],
  ] as const;
  for (const [name, label, tone] of expectedRows) {
    const row = mcpServer(panel, name);
    const status = row.locator(".teammate-mcp-server-status");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute("data-tone", tone);
    await expect(status).toContainText(label);
    await expect(row.locator(".teammate-mcp-count-badge")).toHaveCount(2);
    await expect(row.locator(".teammate-mcp-count-badge").first()).toHaveAttribute("data-tone", "neutral");
    await expect(row.locator(".teammate-mcp-count-badge").first()).toHaveAttribute("data-variant", "outline");
  }
  await expect(panel.locator(".status-badge")).toHaveCount(0);
  await expect(panel).not.toContainText(/needs_check|auth_blocked|write_network/iu);

  const ready = mcpServer(panel, "Ready MCP");
  await ready.getByRole("button", { name: "Show tools" }).click();
  const expectedEffects = [
    ["No side effects", "neutral"],
    ["Read", "neutral"],
    ["Write", "warning"],
    ["Write network", "warning"],
    ["External action", "warning"],
    ["Credential", "danger"],
    ["Deploy", "danger"],
  ] as const;
  const effectBadges = ready.locator(".teammate-mcp-effect");
  await expect(effectBadges).toHaveCount(7);
  for (const [index, [label, tone]] of expectedEffects.entries()) {
    const effect = effectBadges.nth(index);
    await expect(effect).toHaveText(label);
    await expect(effect).toHaveAttribute("data-tone", tone);
    await expect(effect).toHaveAttribute("data-variant", "outline");
  }

  const disabled = mcpServer(panel, "Disabled MCP");
  await disabled.getByRole("button", { name: "Show tools" }).click();
  await expect(disabled.getByLabel("Disabled read tool")).toBeDisabled();
  await expect(disabled.getByRole("button", { name: "Select all current MCP" })).toBeDisabled();
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Ling Dark keeps Teammate MCP loading, disabled controls, and long content contained", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const fixture = createMcpStatusFixture();
  await installMcpStatusFixture(page, fixture);
  let releaseSave = (): void => undefined;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route("**/teammates/teammate_ui2_mcp_status/mcp?*", async (route) => {
    if (route.request().method() === "PUT") await saveGate;
    await route.fallback();
  });
  await page.goto("/");

  const panel = await openTeammateMcpSettings(page);
  const assignmentStatus = panel.locator(".teammate-mcp-assignment-status");
  await expect(assignmentStatus).toHaveAttribute("data-tone", "neutral");
  await expect(assignmentStatus).toContainText("Explicit assignment only");
  await expect(panel.locator(".teammate-mcp-save-status")).toHaveCount(0);
  const ready = mcpServer(panel, "Ready MCP");
  await ready.getByRole("button", { name: "Show tools" }).click();
  await ready.getByLabel("Read effect tool").check();
  const save = panel.getByRole("button", { name: /Update.*authorization/ });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(save.locator(".spin")).toHaveCount(1);
  await expect(assignmentStatus).toContainText("Explicit assignment only");
  await expect(panel).not.toContainText("Saving...");
  await expect(ready.getByLabel("Read effect tool")).toBeDisabled();
  releaseSave();
  const successToast = page.locator('[data-ling-overlay="toast"][data-scope="teammate:teammate_ui2_mcp_status:mcp"]');
  await expect(successToast).toContainText("Saved");
  await expect(panel).not.toContainText("Saved");
  await expect(save).toHaveAttribute("aria-busy", "false");
  await expect(successToast).toHaveCount(0, { timeout: 5_000 });

  const longRow = mcpServer(panel, "Credential attention MCP");
  const titleMetrics = await longRow.locator(".teammate-mcp-server-title strong").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(titleMetrics.scrollWidth).toBeGreaterThanOrEqual(titleMetrics.clientWidth);
  await expect(longRow.locator(".teammate-mcp-server-status")).toHaveAttribute("data-tone", "warning");
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("MCP save failure stays in the tab until bindings change or a retry begins", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const fixture = createMcpStatusFixture();
  await installMcpStatusFixture(page, fixture);
  let saveAttempt = 0;
  let releaseRetry = (): void => undefined;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route("**/teammates/teammate_ui2_mcp_status/mcp?*", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    saveAttempt += 1;
    if (saveAttempt <= 2) {
      await route.fulfill({ status: 503, json: { error: "mcp_save_failed", message: "Synthetic MCP save failure" } });
      return;
    }
    await retryGate;
    await route.fallback();
  });
  await page.goto("/");

  const panel = await openTeammateMcpSettings(page);
  const save = panel.getByRole("button", { name: /Update.*authorization/ });
  await save.click();
  const failure = panel.locator(".teammate-mcp-save-error");
  await expect(failure).toContainText("Synthetic MCP save failure");
  await page.waitForTimeout(3_200);
  await expect(failure).toContainText("Synthetic MCP save failure");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="teammate:teammate_ui2_mcp_status:mcp"]')).toHaveCount(0);

  const ready = mcpServer(panel, "Ready MCP");
  await ready.getByRole("button", { name: "Show tools" }).click();
  await ready.getByLabel("Read effect tool").check();
  await expect(failure).toHaveCount(0);

  await save.click();
  await expect(failure).toContainText("Synthetic MCP save failure");
  await save.click();
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(failure).toHaveCount(0);
  releaseRetry();
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="teammate:teammate_ui2_mcp_status:mcp"]')).toContainText("Saved");
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("a delayed MCP save cannot update or notify after the selected teammate changes", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const fixture = createMcpStatusFixture();
  fixture.state.aiTeammates.push(createMockTeammate({
    id: "teammate_ui2_mcp_current",
    displayName: "Current MCP Teammate",
  }));
  await installMcpStatusFixture(page, fixture);
  let releaseOldSave = (): void => undefined;
  const oldSaveGate = new Promise<void>((resolve) => { releaseOldSave = resolve; });
  await page.route("**/teammates/teammate_ui2_mcp_status/mcp?*", async (route) => {
    if (route.request().method() === "PUT") await oldSaveGate;
    await route.fallback();
  });
  await page.goto("/");

  const oldPanel = await openTeammateMcpSettings(page);
  await oldPanel.getByRole("button", { name: /Update.*authorization/ }).click();
  await expect(oldPanel.getByRole("button", { name: /Update.*authorization/ })).toBeDisabled();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Current MCP Teammate", exact: true }).click();
  await expect(page.locator("[data-ui2-teammate-chat-header='true'] h1")).toHaveText("Current MCP Teammate");
  releaseOldSave();
  await page.waitForTimeout(400);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="teammate:teammate_ui2_mcp_status:mcp"]')).toHaveCount(0);

  const currentPanel = await openTeammateMcpSettings(page, "Current MCP Teammate");
  const ready = mcpServer(currentPanel, "Ready MCP");
  await ready.getByRole("button", { name: "Show tools" }).click();
  await expect(ready.getByLabel("No side effects effect tool")).not.toBeChecked();
  await expect(currentPanel.locator(".teammate-mcp-save-error")).toHaveCount(0);
  await expectNoHorizontalOverflow(currentPanel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

interface McpStatusFixture {
  readonly publicServers: readonly McpServer[];
  readonly state: MockState;
}

function createMcpStatusFixture(): McpStatusFixture {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_ui2_mcp_status",
    displayName: "MCP Status Teammate",
  })];
  const mockServers: MockMcpServer[] = [
    createMockMcpServer({ id: "mcp_status_unknown", displayName: "Unchecked MCP", serverKey: "status-unknown", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "mcp_status_checking", displayName: "Checking MCP", serverKey: "status-checking", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "mcp_status_ready", displayName: "Ready MCP", serverKey: "status-ready", status: "ready" }),
    createMockMcpServer({ id: "mcp_status_failed", displayName: "Failed MCP", serverKey: "status-failed", status: "failed", lastCheck: { ok: false, message: "Unavailable", checkedAt: "2026-07-24T00:00:00.000Z" } }),
    createMockMcpServer({ id: "mcp_status_disabled", displayName: "Disabled MCP", serverKey: "status-disabled", enabled: false, status: "disabled" }),
    createMockMcpServer({ id: "mcp_status_migration", displayName: "Legacy credential MCP", serverKey: "status-migration", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "mcp_status_auth", displayName: "Credential attention MCP with an intentionally long server identity for overflow containment", serverKey: "status-auth", status: "unknown", lastCheck: undefined }),
  ];
  state.mcpServers = mockServers;
  const effectLevels: readonly McpToolSideEffectLevel[] = ["none", "read", "write", "write-network", "external", "credential", "deploy"];
  state.mcpTools = [
    ...effectLevels.map((sideEffectLevel) => createMockMcpTool({
      id: `mcp_effect_${sideEffectLevel}`,
      serverId: "mcp_status_ready",
      name: `${sideEffectLevel.replace("-", "_")}_effect_tool`,
      sideEffectLevel,
      title: `${effectTitle(sideEffectLevel)} effect tool`,
    })),
    createMockMcpTool({
      id: "mcp_disabled_read_tool",
      serverId: "mcp_status_disabled",
      name: "disabled_read_tool",
      sideEffectLevel: "read",
      title: "Disabled read tool",
    }),
  ];
  state.teammateMcpBindings = [{
    teammateId: "teammate_ui2_mcp_status",
    serverId: "mcp_status_ready",
    mode: "selected",
    selectedToolNames: ["none_effect_tool"],
    approvalOverrides: {},
    enabled: true,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  }];

  const publicServers = mockServers.map((server) => toPublicMockMcpServer(server, state) as unknown as McpServer);
  return {
    state,
    publicServers: publicServers.map((server) => {
      if (server.id === "mcp_status_checking") return { ...server, status: { kind: "checking" } };
      if (server.id === "mcp_status_migration") return { ...server, legacySecretMigrationRequired: true };
      if (server.id === "mcp_status_auth") {
        return {
          ...server,
          secretStatuses: [{ ref: "env:MISSING_MCP_TOKEN", kind: "env", configured: false, errorCode: "secret_not_configured" }],
          statusSnapshot: {
            serverId: server.id,
            checkedAt: "2026-07-24T00:00:00.000Z",
            expiresAt: "2026-07-24T00:05:00.000Z",
            status: "failed",
            missingSecretRefs: ["env:MISSING_MCP_TOKEN"],
            authStatus: { kind: "missing", refs: ["env:MISSING_MCP_TOKEN"], missingRefs: ["env:MISSING_MCP_TOKEN"] },
          },
        };
      }
      return server;
    }),
  };
}

async function installMcpStatusFixture(page: Page, fixture: McpStatusFixture): Promise<void> {
  await mockDaemon(page, fixture.state);
  await page.route(/\/mcp\/servers(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { cwd, servers: fixture.publicServers } });
  });
}

async function openTeammateMcpSettings(page: Page, teammateName = "MCP Status Teammate"): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName, exact: true }).click();
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await expect(header).toBeVisible();
  await header.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
  await dock.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "MCP", exact: true }).click();
  const panel = page.getByLabel("MCP tool authorization");
  await expect(panel).toBeVisible();
  return panel;
}

function mcpServer(panel: Locator, name: string): Locator {
  return panel.locator(".teammate-mcp-server-row").filter({ hasText: name });
}

function serverById(servers: readonly McpServer[], id: string): McpServer {
  const server = servers.find((item) => item.id === id);
  if (!server) throw new Error(`Missing MCP server fixture: ${id}`);
  return server;
}

function effectTitle(effect: McpToolSideEffectLevel): string {
  if (effect === "none") return "No side effects";
  if (effect === "read") return "Read";
  if (effect === "write") return "Write";
  if (effect === "write-network") return "Write network";
  if (effect === "external") return "External action";
  if (effect === "credential") return "Credential";
  return "Deploy";
}

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
