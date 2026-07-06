import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockMcpServer,
  createMockMcpTool,
  createMockTeammate,
} from "./support/mock-state";

test("MCP settings creates servers without exposing secret values", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "工具接入" })).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /MCP 工具服务/ }).click();
  await expect(page.getByText("统一管理 MCP 工具服务，并按 AI 队友单独授权。").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "添加 MCP 服务" })).toBeVisible();
  await expect(page.getByText("没有 MCP 服务")).toBeVisible();

  await page.getByRole("button", { name: "添加 MCP 服务" }).click();
  const sheet = page.getByRole("dialog", { name: "添加 MCP 服务" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("服务名称").fill("GitHub MCP");
  await sheet.getByLabel("服务标识").fill("github");
  await sheet.getByLabel("传输方式").selectOption("streamable-http");
  await sheet.getByLabel("服务地址").fill("https://api.githubcopilot.com/mcp");
  await sheet.getByLabel("Header 密钥名称").fill("X-Goog-Api-Key");
  await sheet.getByLabel("Header 密钥引用").fill("env:GOOG_API_KEY");
  await sheet.getByRole("button", { name: "保存服务" }).click();

  const serverRow = page.locator(".mcp-server-row").filter({ hasText: "GitHub MCP" });
  await expect(serverRow).toBeVisible();
  await expect(serverRow).toContainText("HTTP");
  await expect(serverRow).toContainText("密钥已配置");
  await expect(page.locator("body")).not.toContainText("AQ.test-secret-token");
  await expect.poll(() => state.mcpServers.find((server) => server.serverKey === "github")?.secretRefs["X-Goog-Api-Key"]).toBe("env:GOOG_API_KEY");

  await serverRow.getByRole("button", { name: "检查连接" }).click();
  await expect(serverRow).toContainText("就绪");
  await expect(serverRow).toContainText("连接检查成功");
  await expect.poll(async () => {
    const box = await serverRow.boundingBox();
    return box?.height ?? 0;
  }).toBeLessThan(240);

  await serverRow.getByRole("button", { name: "编辑" }).click();
  const editSheet = page.getByRole("dialog", { name: "编辑 MCP 服务" });
  await expect(editSheet).toBeVisible();
  await expect(editSheet.getByText("Required for assigned teammates")).toHaveCount(0);
  await expect(editSheet.getByRole("switch", { name: "启用服务" })).toBeVisible();
  await expect(editSheet.getByLabel("Header 密钥引用")).toHaveValue("env:GOOG_API_KEY");
  await expect(editSheet.getByLabel("Header 密钥值", { exact: true })).toHaveCount(0);
  await expect(editSheet.getByRole("button", { name: /显示 Header 密钥值|隐藏 Header 密钥值/ })).toHaveCount(0);
  await editSheet.getByText("高级设置").click();
  await expect(editSheet.getByText("设为关键依赖")).toBeVisible();
  await expect(editSheet.getByText("开启后，已授权队友在该服务不可用时将停止执行，避免缺少关键工具时继续运行。")).toBeVisible();
  await editSheet.getByRole("button", { name: "保存服务" }).click();
  await expect.poll(() => state.mcpServers.find((server) => server.serverKey === "github")?.secretRefs["X-Goog-Api-Key"]).toBe("env:GOOG_API_KEY");

  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toHaveCount(0);
  await serverRow.getByRole("button", { name: "同步工具列表" }).click();
  await expect(serverRow).toContainText("工具列表已同步");
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toBeVisible();
  await serverRow.getByRole("button", { name: "收起工具" }).click();
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toHaveCount(0);
  await serverRow.getByRole("button", { name: "展开工具" }).click();
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toBeVisible();
});

test("AI teammate MCP tab groups tools by server with filters", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_engineer", displayName: "工程队友" })];
  state.mcpServers = [createMockMcpServer({ id: "mcp_github", displayName: "GitHub MCP", serverKey: "github" })];
  state.mcpTools = [
    createMockMcpTool({ id: "mcp_tool_search", serverId: "mcp_github", name: "search_repositories", title: "Search repositories" }),
    createMockMcpTool({ id: "mcp_tool_issue", serverId: "mcp_github", name: "create_issue", title: "Create issue", sideEffectLevel: "write" }),
    ...Array.from({ length: 32 }, (_, index) =>
      createMockMcpTool({
        id: `mcp_tool_extra_${index + 1}`,
        serverId: "mcp_github",
        name: `extra_tool_${index + 1}`,
        title: `Extra tool ${index + 1}`,
      })
    ),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "工程队友" }).click();
  await expect(page.getByRole("heading", { name: "工程队友", level: 1 })).toBeVisible();
  await page.getByLabel(/AI teammate private chat|AI 队友私聊/).getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("设置分组")).toBeVisible();
  const tabNames = await page.getByLabel("设置分组").getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => (button as HTMLElement).innerText.trim())
  );
  expect(tabNames).toContain("MCP");

  const settingsPanel = page.getByLabel("队友设置");
  await expect(settingsPanel).toBeVisible();
  await expect(settingsPanel).not.toContainText("MCP 工具授权");

  await page.getByLabel("设置分组").getByRole("button", { name: "MCP" }).click();
  const mcpPanel = page.getByLabel("MCP 工具授权");
  await expect(mcpPanel).toBeVisible();
  await expect(mcpPanel).toContainText("只授权这个队友确实需要的 MCP 工具");
  const githubServer = mcpPanel.locator(".teammate-mcp-server-row").filter({ hasText: "GitHub MCP" });
  await expect(githubServer).toBeVisible();
  await expect(githubServer).toContainText("34 个工具");
  await expect(githubServer).toContainText("0 个已授权");
  await expect(mcpPanel.getByLabel("Search repositories")).toHaveCount(0);
  const collapsedMcpLayout = await page.evaluate(() => {
    const pageScroller = document.scrollingElement ?? document.documentElement;
    const panel = document.querySelector(".teammate-mcp-panel");
    const serverRow = document.querySelector(".teammate-mcp-server-row");
    return {
      pageScrolls: pageScroller.scrollHeight > pageScroller.clientHeight + 2,
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : "",
      panelBorderWidth: panel ? getComputedStyle(panel).borderTopWidth : "",
      panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      serverRowHeight: serverRow ? Math.round(serverRow.getBoundingClientRect().height) : 0,
    };
  });
  expect(collapsedMcpLayout.pageScrolls).toBe(false);
  expect(collapsedMcpLayout.panelBackground).toBe("rgba(0, 0, 0, 0)");
  expect(collapsedMcpLayout.panelBorderWidth).toBe("0px");
  expect(collapsedMcpLayout.panelHeight).toBeLessThan(180);
  expect(collapsedMcpLayout.serverRowHeight).toBeLessThan(72);
  await githubServer.getByRole("button", { name: "展开工具" }).click();
  await expect(mcpPanel.getByLabel("Search repositories")).toBeVisible();
  await expect(githubServer.locator(".teammate-toggle.inline-toggle")).toHaveCount(0);
  await expect(githubServer.locator(".teammate-mcp-tool-row")).toHaveCount(34);
  await expect(githubServer.locator(".teammate-mcp-tool-check")).toHaveCount(34);
  const mcpLayout = await page.evaluate(() => {
    const pageScroller = document.scrollingElement ?? document.documentElement;
    const workspace = document.querySelector(".teammate-workspace");
    const list = document.querySelector(".teammate-mcp-server-list");
    const toolTree = document.querySelector(".teammate-mcp-tool-tree");
    const toolList = document.querySelector(".teammate-mcp-tool-list");
    const serverRow = document.querySelector(".teammate-mcp-server-row");
    const serverHeader = document.querySelector(".teammate-mcp-server-header");
    const firstTool = document.querySelector(".teammate-mcp-tool-row");
    const serverHeaderLeft = serverHeader?.getBoundingClientRect().left ?? 0;
    const firstToolLeft = firstTool?.getBoundingClientRect().left ?? 0;
    return {
      pageScrolls: pageScroller.scrollHeight > pageScroller.clientHeight + 2,
      workspaceOverflow: workspace ? getComputedStyle(workspace).overflow : "",
      listOverflowY: list ? getComputedStyle(list).overflowY : "",
      listScrolls: list ? list.scrollHeight > list.clientHeight + 2 : false,
      toolTreeBorderLeftWidth: toolTree ? getComputedStyle(toolTree).borderLeftWidth : "",
      toolIndent: Math.round(firstToolLeft - serverHeaderLeft),
      toolListOverflowY: toolList ? getComputedStyle(toolList).overflowY : "",
      toolListScrolls: toolList ? toolList.scrollHeight > toolList.clientHeight + 2 : false,
      serverRowHeight: serverRow ? Math.round(serverRow.getBoundingClientRect().height) : 0,
    };
  });
  expect(mcpLayout.pageScrolls).toBe(false);
  expect(mcpLayout.workspaceOverflow).toBe("hidden");
  expect(mcpLayout.listOverflowY).toBe("auto");
  expect(mcpLayout.toolTreeBorderLeftWidth).toBe("1px");
  expect(mcpLayout.toolIndent).toBeGreaterThanOrEqual(40);
  expect(mcpLayout.toolListOverflowY).toBe("auto");
  expect(mcpLayout.toolListScrolls).toBe(true);
  expect(mcpLayout.serverRowHeight).toBeLessThan(500);
  const checkboxLayout = await githubServer.locator(".teammate-mcp-tool-row").evaluateAll((rows) =>
    rows.slice(0, 5).map((row) => {
      const cell = row.querySelector(".teammate-mcp-tool-check");
      const checkbox = row.querySelector("input[type='checkbox']");
      const visual = row.querySelector(".teammate-mcp-tool-check-visual");
      const cellBox = cell?.getBoundingClientRect();
      const checkboxBox = checkbox?.getBoundingClientRect();
      const visualBox = visual?.getBoundingClientRect();
      const visualStyle = visual ? getComputedStyle(visual) : undefined;
      return {
        cellWidth: cellBox?.width ?? 0,
        cellHeight: cellBox?.height ?? 0,
        checkboxWidth: checkboxBox?.width ?? 0,
        checkboxHeight: checkboxBox?.height ?? 0,
        visualWidth: visualBox?.width ?? 0,
        visualHeight: visualBox?.height ?? 0,
        visualBorderWidth: visualStyle?.borderTopWidth ?? "",
        visualBackground: visualStyle?.backgroundColor ?? "",
        checkboxInsideCell: Boolean(cellBox && checkboxBox &&
          checkboxBox.left >= cellBox.left &&
          checkboxBox.top >= cellBox.top &&
          checkboxBox.right <= cellBox.right &&
          checkboxBox.bottom <= cellBox.bottom),
        visualInsideCell: Boolean(cellBox && visualBox &&
          visualBox.left >= cellBox.left &&
          visualBox.top >= cellBox.top &&
          visualBox.right <= cellBox.right &&
          visualBox.bottom <= cellBox.bottom),
      };
    })
  );
  for (const item of checkboxLayout) {
    expect(item.cellWidth).toBeGreaterThanOrEqual(24);
    expect(item.cellHeight).toBeGreaterThanOrEqual(24);
    expect(item.checkboxWidth).toBeGreaterThanOrEqual(16);
    expect(item.checkboxHeight).toBeGreaterThanOrEqual(16);
    expect(item.checkboxInsideCell).toBe(true);
    expect(item.visualWidth).toBeGreaterThanOrEqual(16);
    expect(item.visualHeight).toBeGreaterThanOrEqual(16);
    expect(item.visualBorderWidth).toBe("1px");
    expect(item.visualBackground).toBe("rgb(255, 255, 255)");
    expect(item.visualInsideCell).toBe(true);
  }
  await githubServer.getByRole("button", { name: "全选当前 MCP" }).click();
  await expect(githubServer).toContainText("34 个已授权");
  await expect(githubServer.locator(".teammate-mcp-tool-row input:checked")).toHaveCount(34);
  const selectedCheckboxLayout = await githubServer.locator(".teammate-mcp-tool-row.selected").evaluateAll((rows) =>
    rows.slice(0, 5).map((row) => {
      const cell = row.querySelector(".teammate-mcp-tool-check");
      const checkbox = row.querySelector("input[type='checkbox']");
      const visual = row.querySelector(".teammate-mcp-tool-check-visual");
      const cellBox = cell?.getBoundingClientRect();
      const checkboxBox = checkbox?.getBoundingClientRect();
      const visualBox = visual?.getBoundingClientRect();
      const visualStyle = visual ? getComputedStyle(visual) : undefined;
      const tolerance = 0.5;
      return Boolean(checkbox instanceof HTMLInputElement &&
        checkbox.checked &&
        cellBox &&
        checkboxBox &&
        visualBox &&
        checkboxBox.left >= cellBox.left - tolerance &&
        checkboxBox.top >= cellBox.top - tolerance &&
        checkboxBox.right <= cellBox.right + tolerance &&
        checkboxBox.bottom <= cellBox.bottom + tolerance &&
        visualBox.left >= cellBox.left - tolerance &&
        visualBox.top >= cellBox.top - tolerance &&
        visualBox.right <= cellBox.right + tolerance &&
        visualBox.bottom <= cellBox.bottom + tolerance &&
        visualStyle?.backgroundColor === "rgb(14, 122, 99)");
    })
  );
  expect(selectedCheckboxLayout.every(Boolean)).toBe(true);
  await githubServer.getByRole("button", { name: "清空授权" }).click();
  await expect(githubServer).toContainText("0 个已授权");
  await expect(githubServer.locator(".teammate-mcp-tool-row input:checked")).toHaveCount(0);
  await mcpPanel.getByLabel("Search repositories").check();
  await expect(githubServer).toContainText("1 个已授权");
  await githubServer.getByRole("button", { name: "全选当前 MCP" }).click();
  await expect(githubServer).toContainText("34 个已授权");
  await githubServer.getByRole("button", { name: "清空授权" }).click();
  await expect(githubServer).toContainText("0 个已授权");
  await mcpPanel.getByLabel("Search repositories").check();
  await expect(githubServer).toContainText("1 个已授权");
  await githubServer.getByRole("button", { name: "已授权" }).click();
  await expect(mcpPanel.getByLabel("Search repositories")).toBeVisible();
  await expect(mcpPanel.getByLabel("Create issue")).toHaveCount(0);
  await githubServer.getByRole("button", { name: "写入或外部动作" }).click();
  await expect(mcpPanel.getByLabel("Search repositories")).toHaveCount(0);
  await expect(mcpPanel.getByLabel("Create issue")).toBeVisible();
  await githubServer.getByRole("button", { name: "全部" }).click();
  await mcpPanel.getByRole("button", { name: "更新工具授权" }).click();

  await expect(mcpPanel).toContainText("已保存");
  await expect.poll(() =>
    state.teammateMcpBindings.some((binding) =>
      binding.teammateId === "teammate_engineer" &&
      binding.serverId === "mcp_github" &&
      binding.mode === "selected" &&
      binding.selectedToolNames.includes("search_repositories") &&
      binding.enabled
    )
  ).toBe(true);
  expect(state.teammateMcpBindings.some((binding) => binding.selectedToolNames.includes("create_issue"))).toBe(false);
});
