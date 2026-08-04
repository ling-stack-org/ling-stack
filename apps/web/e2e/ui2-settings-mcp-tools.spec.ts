import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon, toPublicMockMcpServer } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createMockMcpServer,
  createMockMcpTool,
  type MockMcpServer,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/mcp-tool-servers/",
  import.meta.url,
));

test("MCP and Settings domains keep failures in their owning error channels", async () => {
  const [mcpDomainSource, settingsDomainSource, rowFeedbackSource] = await Promise.all([
    readFile(new URL("../src/domains/mcp/use-mcp-domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/domains/settings/use-settings-domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/mcp/useMcpRowFeedbackController.ts", import.meta.url), "utf8"),
  ]);

  expect(mcpDomainSource).not.toContain("setErrorMessage");
  expect(settingsDomainSource).not.toContain("setErrorMessage");
  expect(mcpDomainSource).toContain('setError({ scope: "load", message });');
  expect(mcpDomainSource).toContain('setError({ scope: "mutation", message });');
  expect(settingsDomainSource).toContain('setError({ scope: "load", message });');
  expect(settingsDomainSource).toContain('setError({ scope: "mutation", message });');

  const identityStart = rowFeedbackSource.indexOf("function mcpServerConfigurationIdentity");
  const identityEnd = rowFeedbackSource.indexOf("\n}\n\nexport function useMcpRowFeedbackController", identityStart);
  expect(identityStart).toBeGreaterThanOrEqual(0);
  expect(identityEnd).toBeGreaterThan(identityStart);
  const identitySource = rowFeedbackSource.slice(identityStart, identityEnd);
  for (const key of [
    "displayName",
    "transport",
    "enabled",
    "required",
    "startupTimeoutSec",
    "toolTimeoutSec",
    "enabledTools",
    "disabledTools",
    "secretConfigured",
  ]) {
    expect(identitySource).toContain(key);
  }
  for (const runtimeKey of ["status", "statusSnapshot", "lastCheck", "updatedAt"]) {
    expect(identitySource).not.toContain(runtimeKey);
  }
  expect(rowFeedbackSource).toContain("startingIdentity !== currentIdentity");
});

test("MCP list keeps loading and refresh failure scoped while preserving authoritative rows", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.mcpServers = [createMockMcpServer({ id: "mcp_ready", displayName: "Repository tools", serverKey: "repository" })];
  state.mcpTools = [createMockMcpTool({ id: "mcp_tool_search", serverId: "mcp_ready", name: "search_repositories", title: "Search repositories" })];
  await mockDaemon(page, state);

  const initialGate = deferred();
  let listMode: "fail" | "hold" | "ok" = "hold";
  await page.route("**/mcp/servers?**", async (route) => {
    if (listMode === "hold") {
      await initialGate.promise;
      await route.fallback();
      return;
    }
    if (listMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic MCP list failure" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openMcpSettings(page);

  await expect(panel.getByLabel("Loading MCP servers")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh MCP servers" })).toHaveCount(0);
  listMode = "ok";
  initialGate.resolve();
  const readyRow = mcpRow(panel, "Repository tools");
  await expect(readyRow).toBeVisible();
  await expect(readyRow).toContainText("Ready");
  await expect(panel.getByRole("toolbar", { name: "MCP server actions" })).toContainText("Servers 1 · Ready 1 · Tools 1");
  await captureEvidence(page, "1440x960-ling-light-ready-list.png");

  listMode = "fail";
  await triggerFocusRevalidation(page);
  await expect(panel).toContainText("MCP servers could not be refreshed. The last loaded list is still shown.");
  await expect(readyRow).toBeVisible();
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("HTTP and stdio editor use progressive fields, safe refs, validation, and focus restoration", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  const saveGate = deferred();
  let holdSave = true;
  await page.route("**/mcp/servers/remote-tools?**", async (route) => {
    if (route.request().method() === "PATCH" && holdSave) await saveGate.promise;
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openMcpSettings(page);

  const addTrigger = panel.getByRole("button", { name: "Add MCP server" });
  await addTrigger.click();
  let dialog = page.getByRole("dialog", { name: "Add MCP server" });
  await expect(dialog.getByLabel("Server name")).toBeFocused();
  await expect(dialog.getByLabel("Header secret ref")).toBeHidden();
  await expect(dialog.getByLabel(/secret value/i)).toHaveCount(0);
  await dialog.getByLabel("Server name").fill("Remote tools");
  await dialog.getByLabel("Server id").fill("remote-tools");
  await dialog.getByLabel("Server URL").fill("ftp://invalid.example/mcp");
  await dialog.getByRole("button", { name: "Add server" }).click();
  await expect(dialog).toContainText("Enter a valid HTTP or HTTPS URL.");
  await dialog.getByLabel("Server URL").fill("https://example.com/a/very/long/mcp/endpoint/that/remains/in/details");
  await expect(dialog).not.toContainText("Enter a valid HTTP or HTTPS URL.");
  await dialog.getByText("Authentication", { exact: true }).click();
  await dialog.getByLabel("Header secret name").fill("Authorization");
  await dialog.getByLabel("Header secret ref").fill("env:REMOTE_MCP_TOKEN");
  await captureEvidence(page, "1440x960-ling-light-http-editor.png");
  await dialog.getByRole("button", { name: "Add server" }).click();

  const row = mcpRow(panel, "Remote tools");
  await expect(row).toBeVisible();
  expect(state.mcpServers.find((server) => server.serverKey === "remote-tools")?.secretRefs.Authorization).toBe("env:REMOTE_MCP_TOKEN");
  await row.getByRole("button", { name: "Edit" }).click();
  dialog = page.getByRole("dialog", { name: "Edit MCP server" });
  await dialog.getByLabel("Transport").selectOption("stdio");
  await expect(dialog.getByLabel("Server URL")).toHaveCount(0);
  await dialog.getByLabel("Command").fill("/opt/ling/bin/a-very-long-local-mcp-command");
  await dialog.getByLabel("Arguments").fill("--workspace /tmp/example --mode read-only");
  await dialog.getByLabel("Working directory").fill("/tmp/example/workspace");
  await dialog.getByText("Authentication", { exact: true }).click();
  await dialog.getByLabel("Env secret name").fill("LOCAL_MCP_TOKEN");
  await dialog.getByLabel("Env secret ref").fill("env:LOCAL_MCP_TOKEN");
  await dialog.getByText("Advanced settings", { exact: true }).click();
  await dialog.getByLabel("Startup timeout").fill("0");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toContainText("Enter a positive timeout.");
  await dialog.getByLabel("Startup timeout").fill("45");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("button", { name: /Save changes/ })).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  holdSave = false;
  saveGate.resolve();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.mcpServers.find((server) => server.serverKey === "remote-tools")?.transport).toBe("stdio");
  await expect.poll(() => state.mcpServers.find((server) => server.serverKey === "remote-tools")?.secretRefs.LOCAL_MCP_TOKEN).toBe("env:LOCAL_MCP_TOKEN");

  await row.getByRole("button", { name: "Edit" }).click();
  dialog = page.getByRole("dialog", { name: "Edit MCP server" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Edit" })).toBeFocused();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("status priority and folded tool metadata remain readable in dark reduced motion", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800, "reduce");
  const state = createBaseState({ approvalStatus: "pending" });
  const servers = [
    createMockMcpServer({ id: "mcp_ready", displayName: "Ready server", serverKey: "ready", url: "https://example.com/mcp", transport: "http" }),
    createMockMcpServer({ id: "mcp_failed", displayName: "Failed server", serverKey: "failed", status: "failed", lastCheck: { ok: false, message: "Raw provider failure detail", checkedAt: "2026-06-03T00:08:00.000Z" } }),
    createMockMcpServer({ id: "mcp_disabled", displayName: "Disabled server", serverKey: "disabled", enabled: false, status: "disabled" }),
    createMockMcpServer({ id: "mcp_unknown", displayName: "Unchecked server", serverKey: "unknown", status: "unknown", lastCheck: undefined }),
    createMockMcpServer({ id: "mcp_missing", displayName: "Credential server", serverKey: "missing", status: "unknown", secretNames: ["Authorization"], secretRefs: { Authorization: "env:MISSING_TOKEN" } }),
    createMockMcpServer({ id: "mcp_migration", displayName: "Legacy server", serverKey: "migration", status: "unknown" }),
  ];
  state.mcpServers = servers;
  state.mcpTools = [createMockMcpTool({
    id: "mcp_tool_long",
    serverId: "mcp_ready",
    name: "inspect_repository_history",
    title: "Inspect repository history",
    description: "Inspect repository history with a deliberately long description that stays compact in the row and becomes fully readable only after the user opens tool details.",
    inputSchema: { type: "object", properties: { repository: { type: "string" }, includeArchived: { type: "boolean" } } },
  })];
  await mockDaemon(page, state);
  await page.route("**/mcp/servers?**", async (route) => {
    const publicServers = servers.map((server) => {
      const value = publicServer(server, state);
      if (server.id === "mcp_missing") {
        return {
          ...value,
          secretConfigured: { Authorization: false },
          secretStatuses: [{ ref: "env:MISSING_TOKEN", kind: "env", configured: false, errorCode: "secret_not_configured" }],
          statusSnapshot: {
            serverId: server.id,
            checkedAt: "2026-06-03T00:08:00.000Z",
            expiresAt: "2026-06-03T00:14:00.000Z",
            status: "failed",
            missingSecretRefs: ["env:MISSING_TOKEN"],
            authStatus: { kind: "missing", refs: ["env:MISSING_TOKEN"], missingRefs: ["env:MISSING_TOKEN"] },
            message: "Missing credential",
          },
        };
      }
      if (server.id === "mcp_migration") return { ...value, legacySecretMigrationRequired: true };
      return value;
    });
    await route.fulfill({ json: { cwd: "/tmp/ling-stack", servers: publicServers } });
  });
  await page.goto("/");
  const panel = await openMcpSettings(page);

  await expect(mcpRow(panel, "Ready server")).toContainText("Ready");
  await expect(mcpRow(panel, "Failed server")).toContainText("Unavailable");
  await expect(mcpRow(panel, "Disabled server")).toContainText("Disabled");
  await expect(mcpRow(panel, "Unchecked server")).toContainText("Check needed");
  await expect(mcpRow(panel, "Credential server")).toContainText("Credential needs attention");
  await expect(mcpRow(panel, "Legacy server")).toContainText("Credential migration required");
  await expect(mcpRow(panel, "Failed server")).not.toContainText("Raw provider failure detail");

  const readyRow = mcpRow(panel, "Ready server");
  await readyRow.getByRole("button", { name: "Show details" }).click();
  const tool = readyRow.locator(".mcp-tool-row").filter({ hasText: "Inspect repository history" });
  await expect(tool).toBeVisible();
  await expect(tool.locator("small")).toContainText("deliberately long description");
  await tool.getByText("Tool details", { exact: true }).click();
  await expect(tool).toContainText("mcp.inspect_repository_history");
  await expect(tool).toContainText("includeArchived");
  await readyRow.getByText("Connection and runtime details", { exact: true }).click();
  await expect(readyRow).toContainText("https://example.com/mcp");
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-tool-details.png");
  expect(runtimeErrors).toEqual([]);
});

test("check and sync use provider-owned success toasts and persistent row failures", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  const server = createMockMcpServer({ id: "mcp_actions", displayName: "Action server", serverKey: "actions", status: "unknown", lastCheck: undefined });
  state.mcpServers = [server];
  await mockDaemon(page, state);
  const checkGate = deferred();
  let checkMode: "fail" | "hold" | "ok" = "hold";
  let syncMode: "empty" | "fail" | "ok" = "fail";
  await page.route("**/mcp/servers/*/check?**", async (route) => {
    if (checkMode === "hold") {
      await checkGate.promise;
      await route.fallback();
      return;
    }
    if (checkMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic MCP check failure" } });
      return;
    }
    await route.fallback();
  });
  await page.route("**/mcp/servers/*/sync-tools?**", async (route) => {
    if (syncMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic MCP sync failure" } });
      return;
    }
    if (syncMode === "empty") {
      const ready = { ...server, status: "ready" as const, lastCheck: { ok: true, message: "Ready", checkedAt: "2026-06-03T00:08:00.000Z" } };
      const publicReady = publicServer(ready, state);
      await route.fulfill({ json: { server: publicReady, statusSnapshot: publicReady.statusSnapshot, tools: [] } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openMcpSettings(page);
  const row = mcpRow(panel, "Action server");

  const check = row.getByRole("button", { name: /Check connection/ });
  await check.click();
  await expect(check).toHaveAttribute("aria-busy", "true");
  await expect(row.getByRole("button", { name: "Sync tool list" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Sync tool list" })).not.toHaveAttribute("aria-busy", "true");
  checkMode = "ok";
  checkGate.resolve();
  const firstCheckToast = page.locator('[data-ling-overlay="toast"][data-scope="mcp:mcp_actions:check"]');
  await expect(firstCheckToast).toHaveCount(1);
  await expect(firstCheckToast).toContainText("Connection check succeeded");
  await expect(row.locator(".settings-mcp-row-feedback")).toHaveCount(0);
  await expect(row).not.toContainText("Connection check succeeded");
  await expect(firstCheckToast).toHaveCount(0, { timeout: 5_000 });

  checkMode = "fail";
  await row.getByRole("button", { name: "Check connection" }).click();
  const rowFailure = row.locator(".settings-mcp-row-feedback");
  await expect(rowFailure).toContainText("Connection check failed");
  await page.waitForTimeout(3_200);
  await expect(rowFailure).toContainText("Connection check failed");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="mcp:mcp_actions:check"]')).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-check-failure.png");

  server.status = "failed";
  server.updatedAt = "2026-06-03T00:09:00.000Z";
  await triggerFocusRevalidation(page);
  await expect(rowFailure).toContainText("Connection check failed");

  checkMode = "ok";
  await row.getByRole("button", { name: "Check connection" }).click();
  await expect(rowFailure).toHaveCount(0);
  const retryCheckToast = page.locator('[data-ling-overlay="toast"][data-scope="mcp:mcp_actions:check"]');
  await expect(retryCheckToast).toHaveCount(1);
  await expect(retryCheckToast).toContainText("Connection check succeeded");
  await retryCheckToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(retryCheckToast).toHaveCount(0);

  await row.getByRole("button", { name: "Sync tool list" }).click();
  await expect(rowFailure).toContainText("Tool list sync failed");
  await page.waitForTimeout(3_200);
  await expect(rowFailure).toContainText("Tool list sync failed");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="mcp:mcp_actions:sync"]')).toHaveCount(0);
  syncMode = "empty";
  await row.getByRole("button", { name: "Sync tool list" }).click();
  const syncToast = page.locator('[data-ling-overlay="toast"][data-scope="mcp:mcp_actions:sync"]');
  await expect(syncToast).toHaveCount(1);
  await expect(syncToast).toContainText("Tool list synced");
  await expect(rowFailure).toHaveCount(0);
  await expect(row).not.toContainText("Tool list synced");
  await expect(row).toContainText("No tools synced");
  await syncToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(syncToast).toHaveCount(0);

  checkMode = "fail";
  await row.getByRole("button", { name: "Check connection" }).click();
  await expect(rowFailure).toContainText("Connection check failed");
  server.displayName = "Action server renamed";
  server.updatedAt = "2026-06-03T00:10:00.000Z";
  await triggerFocusRevalidation(page);
  const renamedRow = mcpRow(panel, "Action server renamed");
  await expect(renamedRow).toBeVisible();
  await expect(renamedRow.locator(".settings-mcp-row-feedback")).toHaveCount(0);

  syncMode = "fail";
  await renamedRow.getByRole("button", { name: "Sync tool list" }).click();
  await expect(renamedRow.locator(".settings-mcp-row-feedback")).toContainText("Tool list sync failed");
  state.mcpServers = [];
  await triggerFocusRevalidation(page);
  await expect(renamedRow).toHaveCount(0);
  await expect(panel.getByText("No MCP servers")).toBeVisible();
  server.displayName = "Action server restored";
  server.updatedAt = "2026-06-03T00:11:00.000Z";
  state.mcpServers = [server];
  await triggerFocusRevalidation(page);
  const restoredRow = mcpRow(panel, "Action server restored");
  await expect(restoredRow).toBeVisible();
  await expect(restoredRow.locator(".settings-mcp-row-feedback")).toHaveCount(0);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("delete confirmation supports cancel, Esc, busy safety, failure, and authoritative success", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "zh-CN", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.mcpServers = [createMockMcpServer({ id: "mcp_delete", displayName: "待删除服务", serverKey: "delete" })];
  state.mcpTools = [createMockMcpTool({ id: "mcp_tool_delete", serverId: "mcp_delete", name: "read_file", title: "读取文件" })];
  await mockDaemon(page, state);
  const deleteGate = deferred();
  let deleteMode: "fail" | "hold" | "ok" = "fail";
  await page.route("**/mcp/servers/mcp_delete?**", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    if (deleteMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic MCP delete failure" } });
      return;
    }
    if (deleteMode === "hold") await deleteGate.promise;
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openMcpSettings(page, /MCP 工具服务/);
  const row = mcpRow(panel, "待删除服务");
  const more = row.getByRole("button", { name: "更多操作" });

  await more.click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  let dialog = page.getByRole("dialog", { name: "删除 MCP 服务？" });
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(state.mcpServers).toHaveLength(1);

  await more.click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  dialog = page.getByRole("dialog", { name: "删除 MCP 服务？" });
  await dialog.getByRole("button", { name: "删除服务" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("MCP 服务删除失败");
  await dialog.getByText("错误详情", { exact: true }).click();
  await expect(dialog).toContainText("Synthetic MCP delete failure");
  await captureEvidence(page, "1280x800-ling-dark-delete-failure-zh-CN.png");

  deleteMode = "hold";
  await dialog.getByRole("button", { name: "删除服务" }).click();
  await expect(dialog.getByRole("button", { name: "删除服务" })).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  deleteMode = "ok";
  deleteGate.resolve();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(panel.getByText("没有 MCP 服务")).toBeVisible();
  expect(state.mcpServers).toHaveLength(0);
  expect(state.mcpTools).toHaveLength(0);
  await captureEvidence(page, "1280x800-ling-dark-empty.png");
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  locale: "en-US" | "zh-CN",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ locale: initialLocale, theme: initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", initialLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { locale, theme });
}

async function openMcpSettings(page: Page, sectionName: RegExp = /MCP tool servers/): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: sectionName }).click();
  const panel = page.locator("[data-ui2-mcp-tools]");
  await expect(panel).toBeVisible();
  return panel;
}

function mcpRow(panel: Locator, name: string): Locator {
  return panel.locator(".mcp-server-row").filter({ hasText: name });
}

interface PublicServerFixture extends Record<string, unknown> {
  readonly statusSnapshot?: unknown;
}

function publicServer(server: MockMcpServer, state: MockState): PublicServerFixture {
  return toPublicMockMcpServer(server, state) as PublicServerFixture;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
