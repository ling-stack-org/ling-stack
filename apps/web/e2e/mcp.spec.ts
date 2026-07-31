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
  await expect(page.getByRole("toolbar", { name: "MCP 服务操作" })).toContainText("服务 0 · 就绪 0 · 工具 0");
  await expect(page.getByRole("button", { name: "添加 MCP 服务" })).toBeVisible();
  await expect(page.getByText("没有 MCP 服务")).toBeVisible();

  await page.getByRole("button", { name: "添加 MCP 服务" }).click();
  const sheet = page.getByRole("dialog", { name: "添加 MCP 服务" });
  await sheet.getByLabel("服务名称").fill("GitHub MCP");
  await sheet.getByLabel("服务标识").fill("github");
  await sheet.getByLabel("传输方式").selectOption("streamable-http");
  await sheet.getByLabel("服务地址").fill("https://api.githubcopilot.com/mcp");
  await sheet.getByText("身份验证", { exact: true }).click();
  await sheet.getByLabel("Header 密钥名称").fill("X-Goog-Api-Key");
  await sheet.getByLabel("Header 密钥引用").fill("env:GOOG_API_KEY");
  await sheet.getByRole("button", { name: "添加服务" }).click();

  const serverRow = page.locator(".mcp-server-row").filter({ hasText: "GitHub MCP" });
  await expect(serverRow).toBeVisible();
  const createdServer = state.mcpServers.find((server) => server.serverKey === "github");
  if (!createdServer) throw new Error("Expected the GitHub MCP server fixture to be created");
  await expect(serverRow).toContainText("HTTP");
  await expect(page.locator("body")).not.toContainText("AQ.test-secret-token");
  await expect.poll(() => state.mcpServers.find((server) => server.serverKey === "github")?.secretRefs["X-Goog-Api-Key"]).toBe("env:GOOG_API_KEY");
  await serverRow.getByRole("button", { name: "显示详情" }).click();
  await serverRow.getByText("连接与运行详情", { exact: true }).click();
  await expect(serverRow).toContainText("X-Goog-Api-Key: env:GOOG_API_KEY");
  await serverRow.getByRole("button", { name: "隐藏详情" }).click();

  await serverRow.getByRole("button", { name: "检查连接" }).click();
  await expect(serverRow).toContainText("就绪");
  const checkToast = page.locator(`[data-ling-overlay="toast"][data-scope="mcp:${createdServer.id}:check"]`);
  await expect(checkToast).toContainText("连接检查成功");
  await expect(serverRow.locator(".settings-mcp-row-feedback")).toHaveCount(0);
  await checkToast.getByRole("button", { name: "关闭提示" }).click();

  await serverRow.getByRole("button", { name: "编辑" }).click();
  const editSheet = page.getByRole("dialog", { name: "编辑 MCP 服务" });
  await expect(editSheet.getByRole("switch", { name: "启用服务" })).toBeVisible();
  await expect(editSheet.getByLabel("Header 密钥引用")).toHaveValue("env:GOOG_API_KEY");
  await expect(editSheet.getByLabel("Header 密钥值", { exact: true })).toHaveCount(0);
  await editSheet.getByText("高级设置").click();
  await expect(editSheet.getByText("设为关键依赖")).toBeVisible();
  await editSheet.getByRole("button", { name: "保存修改" }).click();

  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toHaveCount(0);
  await serverRow.getByRole("button", { name: "同步工具列表" }).click();
  const syncToast = page.locator(`[data-ling-overlay="toast"][data-scope="mcp:${createdServer.id}:sync"]`);
  await expect(syncToast).toContainText("工具列表已同步");
  await expect(page.locator(".mcp-tool-row").filter({ hasText: "Search repositories" })).toBeVisible();
});

test("AI teammate exposes external tools through one compact service list and Drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_engineer", displayName: "工程队友" })];
  state.mcpServers = [createMockMcpServer({ id: "mcp_github", displayName: "GitHub 服务", serverKey: "github" })];
  state.mcpTools = [
    createMockMcpTool({ id: "mcp_tool_search", serverId: "mcp_github", name: "search_repositories", title: "搜索仓库" }),
    createMockMcpTool({ id: "mcp_tool_issue", serverId: "mcp_github", name: "create_issue", title: "创建问题", sideEffectLevel: "write" }),
    ...Array.from({ length: 32 }, (_, index) => createMockMcpTool({
      id: `mcp_tool_extra_${index + 1}`,
      serverId: "mcp_github",
      name: `extra_tool_${index + 1}`,
      title: `仓库功能 ${index + 1}`,
    })),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "工程队友" }).click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header='true']");
  await chatHeader.getByRole("button", { name: "显示详情" }).click();
  await page.getByLabel("私聊工作区面板").getByRole("button", { name: "设置" }).click();
  const settings = page.getByLabel("设置分组");
  await expect(settings.getByRole("button", { name: "工具与权限", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "MCP", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "工具与权限", exact: true }).click();

  const panel = page.getByLabel("外部工具");
  await expect(panel).toBeVisible();
  const service = panel.locator(".teammate-external-tool-row").filter({ hasText: "GitHub 服务" });
  await expect(service).toContainText("可用");
  await expect(service).toContainText("尚未允许");
  await expect(panel).not.toContainText(/MCP|search_repositories|服务标识|传输方式/iu);
  await expect(panel.getByRole("button", { name: "保存修改" })).toHaveCount(0);

  await service.getByRole("button", { name: "管理 GitHub 服务" }).click();
  const drawer = page.getByRole("dialog", { name: "GitHub 服务" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("搜索仓库")).not.toBeChecked();
  await drawer.getByText("搜索仓库", { exact: true }).click();
  await expect(drawer).toContainText("已允许 1 项");
  await drawer.getByRole("combobox", { name: "功能筛选" }).selectOption("authorized");
  await expect(drawer.getByLabel("搜索仓库")).toBeVisible();
  await expect(drawer.getByLabel("创建问题")).toHaveCount(0);
  await drawer.getByRole("combobox", { name: "功能筛选" }).selectOption("all");

  const toolListScrolls = await drawer.locator(".teammate-external-tool-list").evaluate((element) => (
    element.scrollHeight > element.clientHeight + 2
  ));
  expect(toolListScrolls).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(service).toContainText("已允许 1 项");

  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(
    '[data-ling-overlay="toast"][data-scope="teammate:teammate_engineer:mcp"]',
  )).toContainText("外部工具已保存");
  await expect.poll(() => state.teammateMcpBindings.find((binding) => (
    binding.teammateId === "teammate_engineer" && binding.serverId === "mcp_github"
  ))?.selectedToolNames).toEqual(["search_repositories"]);
});
