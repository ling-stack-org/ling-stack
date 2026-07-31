import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockMcpServer,
  createMockMcpTool,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-permissions/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";

test.describe("Teammate external-tool controls", () => {
  test("Light keeps search, filtering, draft save, and Drawer focus productized", async ({ page }) => {
    await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
    const runtime = watchRuntime(page);
    const state = createExternalToolsState();
    state.teammateMcpBindings = [{
      teammateId: "teammate_external_tools",
      serverId: "external_repository",
      mode: "selected",
      selectedToolNames: ["search_repositories"],
      approvalOverrides: {},
      enabled: true,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    }];
    await mockDaemon(page, state);
    await page.goto("/");

    const panel = await openExternalTools(page);
    const repository = serviceRow(panel, "Repository service");
    await expect(repository).toContainText("Available");
    await expect(repository).toContainText("1 allowed");
    await expect(panel).not.toContainText(/server id|transport|credential|search_repositories/iu);
    await expect(panel.getByRole("button", { name: "Save changes" })).toHaveCount(0);

    const manage = repository.getByRole("button", { name: "Manage Repository service" });
    await manage.click();
    const drawer = page.getByRole("dialog", { name: "Repository service" });
    await expect(drawer).toBeVisible();
    await expect(drawer).not.toContainText(/MCP|server id|transport|search_repositories/iu);

    const search = drawer.getByRole("searchbox", { name: "Search tools" });
    await expect(search).toHaveAttribute("data-ling-input-native", "true");
    await search.fill("Create issue");
    await expect(drawer.getByLabel("Create issue")).toBeVisible();
    await expect(drawer.getByLabel("Search repositories")).toHaveCount(0);
    await search.fill("");

    const filter = drawer.getByRole("combobox", { name: "Capability filter" });
    await filter.selectOption("authorized");
    await expect(drawer.getByLabel("Search repositories")).toBeChecked();
    await expect(drawer.getByLabel("Create issue")).toHaveCount(0);
    await filter.selectOption("all");
    await drawer.getByText("Search repositories", { exact: true }).click();
    await drawer.getByText("Create issue", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(manage).toBeFocused();
    await captureEvidenceSurface(page, "1440x960-ling-light-external-tools-list.png");

    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    await page.route("**/teammates/teammate_external_tools/mcp?*", async (route) => {
      if (route.request().method() === "PUT") await saveGate;
      await route.fallback();
    });
    const save = page.getByRole("button", { name: /Save changes/ });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute("aria-busy", "true");
    releaseSave?.();

    await expect(page.locator(
      '[data-ling-overlay="toast"][data-scope="teammate:teammate_external_tools:mcp"]',
    )).toContainText("External tools saved");
    await expect.poll(() => state.teammateMcpBindings.find((binding) => (
      binding.teammateId === "teammate_external_tools"
      && binding.serverId === "external_repository"
    ))?.selectedToolNames).toEqual(["create_issue"]);
    await expectNoHorizontalOverflow(panel);
    await expectNoDocumentOverflow(page);
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("Dark prevents new grants on a disabled service and hides the section when no service exists", async ({ page }) => {
    await prepareSurface(page, { height: 800, reducedMotion: "reduce", theme: "dark", width: 1280 });
    const runtime = watchRuntime(page);
    const state = createExternalToolsState();
    state.mcpServers = [createMockMcpServer({
      id: "external_disabled",
      displayName: "Deployment service",
      enabled: false,
      serverKey: "deployment-service",
      status: "disabled",
    })];
    state.mcpTools = [createMockMcpTool({
      id: "external_disabled_deploy",
      serverId: "external_disabled",
      name: "deploy_application",
      sideEffectLevel: "deploy",
      title: "Deploy application",
    })];
    await mockDaemon(page, state);
    await page.goto("/");

    const panel = await openExternalTools(page);
    const disabled = serviceRow(panel, "Deployment service");
    await expect(disabled).toContainText("Not enabled");
    await disabled.getByRole("button", { name: "Manage Deployment service" }).click();
    const drawer = page.getByRole("dialog", { name: "Deployment service" });
    await expect(drawer.getByLabel("Deploy application")).toBeDisabled();
    await expect(drawer).not.toContainText(/Select all|MCP/iu);
    await captureEvidenceSurface(page, "1280x800-ling-dark-external-tools-drawer.png");
    await page.keyboard.press("Escape");

    state.mcpServers = [];
    state.mcpTools = [];
    await page.reload();
    await openToolsAndPermissions(page);
    await expect(page.getByRole("region", { name: "External tools", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Tools and permissions")).toBeVisible();
    await expectNoDocumentOverflow(page);
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });
});

function createExternalToolsState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_external_tools",
    displayName: "External Tools Teammate",
  })];
  state.mcpServers = [createMockMcpServer({
    id: "external_repository",
    displayName: "Repository service",
    serverKey: "repository-service",
  })];
  state.mcpTools = [
    createMockMcpTool({
      id: "external_repository_search",
      serverId: "external_repository",
      name: "search_repositories",
      title: "Search repositories",
    }),
    createMockMcpTool({
      id: "external_repository_issue",
      serverId: "external_repository",
      name: "create_issue",
      sideEffectLevel: "write",
      title: "Create issue",
    }),
  ];
  return state;
}

async function openExternalTools(page: Page): Promise<Locator> {
  await openToolsAndPermissions(page);
  const panel = page.getByRole("region", { name: "External tools", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function openToolsAndPermissions(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", {
    exact: true,
    name: "External Tools Teammate",
  }).click();
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await expect(header).toBeVisible();
  await header.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
  await dock.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Settings sections").getByRole("button", {
    name: "Tools and permissions",
    exact: true,
  }).click();
}

function serviceRow(panel: Locator, name: string): Locator {
  return panel.locator(".teammate-external-tool-row").filter({ hasText: name });
}

async function prepareSurface(page: Page, input: {
  readonly height: number;
  readonly reducedMotion?: "no-preference" | "reduce";
  readonly theme: "light" | "dark";
  readonly width: number;
}): Promise<void> {
  await page.setViewportSize({ height: input.height, width: input.width });
  await page.emulateMedia({
    colorScheme: input.theme,
    reducedMotion: input.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ theme }) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { theme: input.theme });
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
    if (message.type() === "error") runtime.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtime.pageErrors.push(error.message));
  return runtime;
}

async function captureEvidenceSurface(page: Page, filename: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
}
