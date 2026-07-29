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
  "../../../docs/design/ui2.0升级/evidence/features/raw-text-controls/first-wave/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";

test.describe("T12.1c-C Teammate MCP input migration", () => {
  test("Ling Light 1440 keeps Search, filters, authorization, and busy state intact", async ({ page }) => {
    await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
    const runtime = watchRuntime(page);
    const state = createMcpState();
    await mockDaemon(page, state);
    await page.goto("/");

    const panel = await openTeammateMcpSettings(page);
    const assignmentStatus = panel.locator(".teammate-mcp-assignment-status");
    await expect(assignmentStatus).toHaveAttribute("data-tone", "neutral");
    await expect(assignmentStatus).toContainText("Explicit assignment only");
    await expect(panel.locator(".teammate-mcp-save-status")).toHaveCount(0);
    const repository = mcpServer(panel, "Repository MCP");
    await repository.getByRole("button", { name: "Show tools" }).click();

    const search = repository.getByRole("searchbox", { name: "Search tools" });
    await expect(search).toHaveAttribute("data-ling-input-native", "true");
    await search.focus();
    await expect(search).toBeFocused();
    await expectFocusedInputContained(search);

    await search.fill("Create issue");
    await expect(repository.locator(".teammate-mcp-tool-row")).toHaveCount(1);
    await expect(repository.getByLabel("Create issue")).toBeVisible();

    await search.fill("definitely-no-matching-tool");
    await expect(repository.getByText("No tools match filters", { exact: true })).toBeVisible();
    await expect(repository.locator(".teammate-mcp-tool-row")).toHaveCount(0);

    await search.fill("");
    await repository.getByLabel("Search repositories").check();
    await expect(repository).toContainText("1 authorized");
    await repository.getByRole("button", { name: "Authorized", exact: true }).click();
    await expect(repository.locator(".teammate-mcp-tool-row")).toHaveCount(1);
    await expect(repository.getByLabel("Search repositories")).toBeChecked();
    await repository.getByRole("button", { name: "All", exact: true }).click();

    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/teammates/teammate_ui2_mcp_input/mcp?*", async (route) => {
      if (route.request().method() === "PUT") {
        await saveGate;
      }
      await route.fallback();
    });
    const save = panel.getByRole("button", { name: "Update authorization" });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(repository.getByLabel("Search repositories")).toBeDisabled();
    await expect(search).toBeEnabled();
    await search.fill("issue");
    await expect(repository.getByLabel("Create issue")).toBeVisible();
    await expect(assignmentStatus).toContainText("Explicit assignment only");
    await captureEvidenceSurface(page, "1440x960-ling-light-teammate-mcp-search-busy.png");
    releaseSave?.();
    const saveToast = page.locator(
      '[data-ling-overlay="toast"][data-scope="teammate:teammate_ui2_mcp_input:mcp"]',
    );
    await expect(saveToast).toHaveCount(1);
    await expect(saveToast).toContainText("Saved");
    await expect(page.locator('[data-ling-overlay="toast"]')).toHaveCount(1);
    await expect(panel.locator(".teammate-mcp-save-status")).toHaveCount(0);
    await expect(panel.locator(".teammate-mcp-save-error")).toHaveCount(0);
    await expect(panel).not.toContainText("Saved");
    await search.fill("");
    await expect(repository.getByLabel("Search repositories")).toBeEnabled();
    await expect.poll(() => state.teammateMcpBindings[0]?.selectedToolNames).toContain("search_repositories");

    await expectToolTreeScrollBoundary(repository);
    await expectNoHorizontalOverflow(panel);
    await expectNoDocumentOverflow(page);
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });

  test("Ling Dark 1280 preserves per-server Search state, disabled tools, and reduced motion", async ({ page }) => {
    await prepareSurface(page, { height: 800, reducedMotion: "reduce", theme: "dark", width: 1280 });
    const runtime = watchRuntime(page);
    await mockDaemon(page, createMcpState());
    await page.goto("/");

    const panel = await openTeammateMcpSettings(page);
    const repository = mcpServer(panel, "Repository MCP");
    const disabled = mcpServer(panel, "Disabled deploy MCP");
    await repository.getByRole("button", { name: "Show tools" }).click();
    await disabled.getByRole("button", { name: "Show tools" }).click();

    const repositorySearch = repository.getByRole("searchbox", { name: "Search tools" });
    const disabledSearch = disabled.getByRole("searchbox", { name: "Search tools" });
    await repositorySearch.fill("repository");
    await disabledSearch.fill("deploy");
    await repository.getByRole("button", { name: "Hide tools" }).click();
    await repository.getByRole("button", { name: "Show tools" }).click();
    await expect(repositorySearch).toHaveValue("repository");
    await expect(disabledSearch).toHaveValue("deploy");

    await disabledSearch.focus();
    await expect(disabledSearch).toBeFocused();
    await expectFocusedInputContained(disabledSearch);
    await expectReducedMotion(disabledSearch);
    await expect(disabled.getByLabel("Deploy application")).toBeDisabled();
    await expect(disabled.getByRole("button", { name: "Select all current MCP" })).toBeDisabled();
    await expect(disabledSearch).toBeEnabled();

    await disabledSearch.fill("missing-disabled-tool");
    await expect(disabled.getByText("No tools match filters", { exact: true })).toBeVisible();
    await disabledSearch.fill("");
    await disabled.getByRole("button", { name: "Write or external actions" }).click();
    await expect(disabled.getByLabel("Deploy application")).toBeVisible();
    await expect(disabled.getByLabel("Read deployment status")).toHaveCount(0);
    await disabledSearch.focus();
    await expectServerRowsSeparated(panel);
    await captureEvidenceSurface(page, "1280x800-ling-dark-teammate-mcp-disabled-filter.png");

    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expectToolTreeScrollBoundary(repository);
    await expectNoHorizontalOverflow(panel);
    await expectNoDocumentOverflow(page);
    expect(runtime).toEqual({ consoleErrors: [], pageErrors: [] });
  });
});

function createMcpState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_ui2_mcp_input",
    displayName: "MCP Input Migration Teammate",
  })];
  state.mcpServers = [
    createMockMcpServer({
      id: "mcp_repository_input",
      displayName: "Repository MCP",
      serverKey: "repository-input",
    }),
    createMockMcpServer({
      id: "mcp_disabled_deploy_input",
      displayName: "Disabled deploy MCP",
      enabled: false,
      serverKey: "disabled-deploy-input",
      status: "disabled",
    }),
  ];
  state.mcpTools = [
    createMockMcpTool({
      id: "mcp_repository_search",
      serverId: "mcp_repository_input",
      name: "search_repositories",
      title: "Search repositories",
    }),
    createMockMcpTool({
      id: "mcp_repository_issue",
      serverId: "mcp_repository_input",
      name: "create_issue",
      sideEffectLevel: "write",
      title: "Create issue",
    }),
    ...Array.from({ length: 34 }, (_, index) => createMockMcpTool({
      description: `Inspect repository metadata ${index + 1}`,
      id: `mcp_repository_extra_${index + 1}`,
      name: `repository_metadata_tool_${index + 1}`,
      serverId: "mcp_repository_input",
      title: `Repository metadata ${index + 1}`,
    })),
    createMockMcpTool({
      id: "mcp_disabled_deploy",
      serverId: "mcp_disabled_deploy_input",
      name: "deploy_application",
      sideEffectLevel: "deploy",
      title: "Deploy application",
    }),
    createMockMcpTool({
      id: "mcp_disabled_status",
      serverId: "mcp_disabled_deploy_input",
      name: "read_deployment_status",
      sideEffectLevel: "read",
      title: "Read deployment status",
    }),
  ];
  return state;
}

async function openTeammateMcpSettings(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", {
    exact: true,
    name: "MCP Input Migration Teammate",
  }).click();
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await expect(header).toBeVisible();
  await header.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByLabel("Settings sections");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  const panel = page.getByLabel("MCP tool authorization");
  await expect(panel).toBeVisible();
  return panel;
}

function mcpServer(panel: Locator, name: string): Locator {
  return panel.locator(".teammate-mcp-server-row").filter({ hasText: name });
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

async function expectFocusedInputContained(input: Locator): Promise<void> {
  const geometry = await input.evaluate((element) => {
    const owner = element.parentElement;
    const inputRect = element.getBoundingClientRect();
    const ownerRect = owner?.getBoundingClientRect();
    return {
      inputBottom: inputRect.bottom,
      inputHeight: inputRect.height,
      inputTop: inputRect.top,
      ownerBottom: ownerRect?.bottom ?? 0,
      ownerHeight: ownerRect?.height ?? 0,
      ownerTop: ownerRect?.top ?? 0,
      ownerWidthOverflow: owner ? owner.scrollWidth - owner.clientWidth : Number.POSITIVE_INFINITY,
    };
  });
  expect(geometry.ownerHeight).toBe(32);
  expect(geometry.inputHeight).toBeLessThanOrEqual(geometry.ownerHeight);
  expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.ownerTop - 0.5);
  expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.ownerBottom + 0.5);
  expect(geometry.ownerWidthOverflow).toBeLessThanOrEqual(1);
}

async function expectReducedMotion(input: Locator): Promise<void> {
  const durations = await input.evaluate((element) => {
    const owner = element.parentElement;
    return owner ? getComputedStyle(owner).transitionDuration
      .split(",")
      .map((duration) => Number.parseFloat(duration)) : [Number.POSITIVE_INFINITY];
  });
  expect(durations.every((duration) => duration === 0)).toBe(true);
}

async function expectToolTreeScrollBoundary(server: Locator): Promise<void> {
  const toolList = server.locator(".teammate-mcp-tool-list");
  await expect(toolList).toBeVisible();
  const metrics = await toolList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 1);
}

async function expectServerRowsSeparated(panel: Locator): Promise<void> {
  const geometry = await panel.locator(".teammate-mcp-server-row").evaluateAll((rows) => rows.map((row) => {
    const rowRect = row.getBoundingClientRect();
    const treeRect = row.querySelector<HTMLElement>(".teammate-mcp-tool-tree")?.getBoundingClientRect();
    const titleRect = row.querySelector<HTMLElement>(".teammate-mcp-server-title")?.getBoundingClientRect();
    const summaryRect = row.querySelector<HTMLElement>(".teammate-mcp-server-summary")?.getBoundingClientRect();
    const headerCollision = Boolean(titleRect && summaryRect
      && titleRect.left < summaryRect.right
      && titleRect.right > summaryRect.left
      && titleRect.top < summaryRect.bottom
      && titleRect.bottom > summaryRect.top);
    return {
      bottom: rowRect.bottom,
      headerCollision,
      top: rowRect.top,
      treeBottom: treeRect?.bottom ?? rowRect.bottom,
      treeTop: treeRect?.top ?? rowRect.top,
    };
  }));
  expect(geometry.length).toBeGreaterThanOrEqual(2);
  for (let index = 0; index < geometry.length - 1; index += 1) {
    expect(geometry[index].headerCollision).toBe(false);
    expect(geometry[index].bottom).toBeLessThanOrEqual(geometry[index + 1].top + 0.5);
    expect(geometry[index].treeTop).toBeGreaterThanOrEqual(geometry[index].top - 0.5);
    expect(geometry[index].treeBottom).toBeLessThanOrEqual(geometry[index].bottom + 0.5);
  }
  expect(geometry.at(-1)?.headerCollision).toBe(false);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
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
