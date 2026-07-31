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

test("external-tool presentation maps technical runtime states to product language", () => {
  const fixture = createStatusFixture();
  const expectedServerStates = [
    ["status_unknown", "needs-check", "Setup required", "neutral"],
    ["status_checking", "checking", "Checking", "info"],
    ["status_ready", "ready", "Available", "success"],
    ["status_failed", "failed", "Unavailable", "danger"],
    ["status_disabled", "disabled", "Not enabled", "neutral"],
    ["status_migration", "migration", "Setup required", "warning"],
    ["status_auth", "auth-blocked", "Setup required", "warning"],
  ] as const;
  expect(expectedServerStates.map(([id]) => (
    teammateMcpServerStatusPresentation(serverById(fixture.publicServers, id))
  ))).toEqual(expectedServerStates.map(([, id, labelKey, tone]) => ({ id, labelKey, tone })));

  const expectedEffects: ReadonlyArray<readonly [McpToolSideEffectLevel, string, string]> = [
    ["none", "Low risk", "neutral"],
    ["read", "Low risk", "neutral"],
    ["write", "Confirm before use", "warning"],
    ["write-network", "Confirm before use", "warning"],
    ["external", "Confirm before use", "warning"],
    ["credential", "High risk", "danger"],
    ["deploy", "High risk", "danger"],
  ];
  expect(expectedEffects.map(([effect]) => teammateMcpToolEffectPresentation(effect))).toEqual(
    expectedEffects.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
});

test("Light shows compact service states and risk groups without technical diagnostics", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtime = watchRuntime(page);
  const fixture = createStatusFixture();
  await installStatusFixture(page, fixture);
  await page.goto("/");

  const panel = await openExternalTools(page);
  const expectedRows = [
    ["Unchecked service", "Setup required", "neutral"],
    ["Checking service", "Checking", "info"],
    ["Ready service", "Available", "success"],
    ["Failed service", "Unavailable", "danger"],
    ["Disabled service", "Not enabled", "neutral"],
    ["Legacy service", "Setup required", "warning"],
    ["Account service with an intentionally long display name for overflow containment", "Setup required", "warning"],
  ] as const;
  for (const [name, label, tone] of expectedRows) {
    const row = serviceRow(panel, name);
    await expect(row.locator(".teammate-mcp-server-status")).toHaveAttribute("data-tone", tone);
    await expect(row.locator(".teammate-mcp-server-status")).toContainText(label);
  }
  await expect(panel).not.toContainText(/credential|migration|required ref|server id|transport|status_unknown/iu);

  await serviceRow(panel, "Ready service").getByRole("button", { name: "Manage Ready service" }).click();
  const drawer = page.getByRole("dialog", { name: "Ready service" });
  const badges = drawer.locator(".teammate-mcp-effect");
  await expect(badges).toHaveCount(7);
  await expect(badges.filter({ hasText: "Low risk" })).toHaveCount(2);
  await expect(badges.filter({ hasText: "Confirm before use" })).toHaveCount(3);
  await expect(badges.filter({ hasText: "High risk" })).toHaveCount(2);
  await expect(drawer).not.toContainText(/none_effect_tool|write_network_effect_tool|credential_effect_tool/iu);
  await page.keyboard.press("Escape");

  const disabledManage = serviceRow(panel, "Disabled service").getByRole("button", { name: "Manage Disabled service" });
  await disabledManage.click();
  const disabledDrawer = page.getByRole("dialog", { name: "Disabled service" });
  await expect(disabledDrawer.getByLabel("Disabled read capability")).toBeChecked();
  await expect(disabledDrawer.getByLabel("Disabled read capability")).toBeEnabled();
  await disabledDrawer.getByText("Disabled read capability", { exact: true }).click();
  await expect(disabledDrawer.getByLabel("Disabled write capability")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
});

test("save failure remains productized and a stale save cannot notify the next teammate", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtime = watchRuntime(page);
  const fixture = createStatusFixture();
  fixture.state.aiTeammates.push(createMockTeammate({
    id: "teammate_external_tools_next",
    displayName: "Next Teammate",
  }));
  await installStatusFixture(page, fixture);
  let saveAttempt = 0;
  let releaseDelayedSave = (): void => undefined;
  const delayedSave = new Promise<void>((resolve) => { releaseDelayedSave = resolve; });
  await page.route("**/teammates/teammate_external_tools_status/mcp?*", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    saveAttempt += 1;
    if (saveAttempt === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "raw_mcp_failure", message: "Synthetic raw provider failure" },
      });
      return;
    }
    await delayedSave;
    await route.fallback();
  });
  await page.goto("/");

  const panel = await openExternalTools(page);
  await serviceRow(panel, "Ready service").getByRole("button", { name: "Manage Ready service" }).click();
  const drawer = page.getByRole("dialog", { name: "Ready service" });
  await drawer.getByText("Read capability", { exact: true }).click();
  await page.keyboard.press("Escape");
  const save = page.getByRole("button", { name: /Save changes/ });
  await save.click();
  const failure = panel.locator(".teammate-mcp-save-error");
  await expect(failure).toContainText("External tool settings were not saved. Try again.");
  await expect(failure).not.toContainText(/raw_mcp_failure|provider/iu);

  await save.click();
  await expect(save).toBeDisabled();
  await page.getByLabel("Ling Stack navigation").getByRole("button", {
    name: "Next Teammate",
    exact: true,
  }).click();
  releaseDelayedSave();
  await page.waitForTimeout(300);
  await expect(page.locator(
    '[data-ling-overlay="toast"][data-scope="teammate:teammate_external_tools_status:mcp"]',
  )).toHaveCount(0);
  await expect(page.locator("[data-ui2-teammate-chat-header='true'] h1")).toHaveText("Next Teammate");
  await expectNoDocumentOverflow(page);
  expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
});

interface StatusFixture {
  readonly publicServers: readonly McpServer[];
  readonly state: MockState;
}

function createStatusFixture(): StatusFixture {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_external_tools_status",
    displayName: "External Tool Status Teammate",
  })];
  const mockServers: MockMcpServer[] = [
    createMockMcpServer({ id: "status_unknown", displayName: "Unchecked service", serverKey: "status-unknown", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "status_checking", displayName: "Checking service", serverKey: "status-checking", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "status_ready", displayName: "Ready service", serverKey: "status-ready", status: "ready" }),
    createMockMcpServer({ id: "status_failed", displayName: "Failed service", serverKey: "status-failed", status: "failed", lastCheck: { ok: false, message: "Unavailable", checkedAt: "2026-07-31T00:00:00.000Z" } }),
    createMockMcpServer({ id: "status_disabled", displayName: "Disabled service", serverKey: "status-disabled", enabled: false, status: "disabled" }),
    createMockMcpServer({ id: "status_migration", displayName: "Legacy service", serverKey: "status-migration", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "status_auth", displayName: "Account service with an intentionally long display name for overflow containment", serverKey: "status-auth", status: "unknown", lastCheck: undefined }),
  ];
  state.mcpServers = mockServers;
  const effectLevels: readonly McpToolSideEffectLevel[] = ["none", "read", "write", "write-network", "external", "credential", "deploy"];
  state.mcpTools = [
    ...effectLevels.map((sideEffectLevel) => createMockMcpTool({
      id: `effect_${sideEffectLevel}`,
      serverId: "status_ready",
      name: `${sideEffectLevel.replace("-", "_")}_effect_tool`,
      sideEffectLevel,
      title: effectTitle(sideEffectLevel),
    })),
    createMockMcpTool({ id: "disabled_read", serverId: "status_disabled", name: "disabled_read", sideEffectLevel: "read", title: "Disabled read capability" }),
    createMockMcpTool({ id: "disabled_write", serverId: "status_disabled", name: "disabled_write", sideEffectLevel: "write", title: "Disabled write capability" }),
  ];
  state.teammateMcpBindings = [
    {
      teammateId: "teammate_external_tools_status",
      serverId: "status_ready",
      mode: "selected",
      selectedToolNames: ["none_effect_tool"],
      approvalOverrides: {},
      enabled: true,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    },
    {
      teammateId: "teammate_external_tools_status",
      serverId: "status_disabled",
      mode: "selected",
      selectedToolNames: ["disabled_read"],
      approvalOverrides: {},
      enabled: true,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    },
  ];

  const publicServers = mockServers.map((server) => toPublicMockMcpServer(server, state) as unknown as McpServer);
  return {
    state,
    publicServers: publicServers.map((server) => {
      if (server.id === "status_checking") return { ...server, status: { kind: "checking" } };
      if (server.id === "status_migration") return { ...server, legacySecretMigrationRequired: true };
      if (server.id === "status_auth") {
        return {
          ...server,
          secretStatuses: [{ ref: "env:MISSING", kind: "env", configured: false, errorCode: "secret_not_configured" }],
          statusSnapshot: {
            serverId: server.id,
            checkedAt: "2026-07-31T00:00:00.000Z",
            expiresAt: "2026-07-31T00:05:00.000Z",
            status: "failed",
            missingSecretRefs: ["env:MISSING"],
            authStatus: { kind: "missing", refs: ["env:MISSING"], missingRefs: ["env:MISSING"] },
          },
        };
      }
      return server;
    }),
  };
}

async function installStatusFixture(page: Page, fixture: StatusFixture): Promise<void> {
  await mockDaemon(page, fixture.state);
  await page.route(/\/mcp\/servers(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { cwd, servers: fixture.publicServers } });
      return;
    }
    await route.fallback();
  });
}

async function openExternalTools(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", {
    name: "External Tool Status Teammate",
    exact: true,
  }).click();
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await header.getByRole("button", { name: "Show details" }).click();
  await page.getByRole("complementary", { name: "Private chat workspace dock" })
    .getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Settings sections").getByRole("button", {
    name: "Tools and permissions",
    exact: true,
  }).click();
  const panel = page.getByRole("region", { name: "External tools", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

function serviceRow(panel: Locator, name: string): Locator {
  return panel.locator(".teammate-external-tool-row").filter({ hasText: name });
}

function serverById(servers: readonly McpServer[], id: string): McpServer {
  const server = servers.find((item) => item.id === id);
  if (!server) throw new Error(`Missing external service fixture: ${id}`);
  return server;
}

function effectTitle(effect: McpToolSideEffectLevel): string {
  if (effect === "none") return "No-change capability";
  if (effect === "read") return "Read capability";
  if (effect === "write") return "Write capability";
  if (effect === "write-network") return "Network capability";
  if (effect === "external") return "External action capability";
  if (effect === "credential") return "Account capability";
  return "Deploy capability";
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
  expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  ))).toBe(true);
}

function watchRuntime(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const runtime = { consoleErrors: [] as string[], pageErrors: [] as string[] };
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      runtime.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => runtime.pageErrors.push(error.message));
  return runtime;
}
