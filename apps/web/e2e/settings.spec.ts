import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createExternalWorkStatus,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";
import {
  channelEventFilterToggle,
  openChannelChatTools,
} from "./support/test-helpers";

test("language switcher toggles Chinese and English UI labels", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ling-stack.locale")) {
      localStorage.setItem("ling-stack.locale", "en-US");
    }
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await expect(page.getByRole("heading", { name: "Interface preferences" })).toBeVisible();
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "界面偏好" })).toBeVisible();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "收件箱" })).toBeVisible();
  await expect(page.getByLabel("频道动态")).toBeVisible();
  await openChannelChatTools(page);
  await expect(page.getByPlaceholder("搜索动态")).toBeVisible();
  await expect(page.locator('select[aria-label="保存的视图"]')).toContainText("需要关注");
  await channelEventFilterToggle(page).click();
  await expect(page.getByLabel("动态类别").getByRole("button", { name: /全部/ })).toBeVisible();
  await expect(page.getByLabel("动态关注筛选").getByRole("button", { name: /需要关注/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "关注队列" })).toBeVisible();
  await page.locator(".message-bubble").filter({ hasText: "任务事件" }).first().getByRole("button", { name: "详情" }).click();
  const chineseDetails = page.getByRole("complementary", { name: "动态详情" });
  await expect(chineseDetails).toContainText("来源摘要");
  await expect(chineseDetails).toContainText("关联对象");
  await expect(chineseDetails).toContainText("分诊动作");
  await chineseDetails.locator(".activity-triage-section summary").click();
  await expect(chineseDetails).toContainText("创建跟进任务");
  await chineseDetails.getByLabel("关闭详情").click();
  await expect(page.getByPlaceholder("给频道发消息，或 @ 一个 AI 队友")).toBeVisible();
  await expect(page.locator(".channel-composer").getByRole("button", { name: "发送" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.locale"))).toBe("zh-CN");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /界面偏好/ }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByLabel("Channel activity")).toBeVisible();
  await openChannelChatTools(page);
  await expect(page.getByPlaceholder("Search activity")).toBeVisible();
  await expect(page.locator('select[aria-label="Saved views"]')).toContainText("Needs attention");
  await channelEventFilterToggle(page).click();
  await expect(page.getByLabel("Activity categories").getByRole("button", { name: /Messages/ })).toBeVisible();
  await expect(page.getByLabel("Activity attention filters").getByRole("button", { name: /Needs attention/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Attention queue" })).toBeVisible();
  await page.locator(".message-bubble").filter({ hasText: "Task event" }).first().getByRole("button", { name: "Details" }).click();
  const englishDetails = page.getByRole("complementary", { name: "Activity details" });
  await expect(englishDetails).toContainText("Source summary");
  await expect(englishDetails).toContainText("Related objects");
  await expect(englishDetails).toContainText("Triage actions");
  await englishDetails.locator(".activity-triage-section summary").click();
  await expect(englishDetails).toContainText("Create follow-up task");
  await expect(page.getByPlaceholder("Message this channel or @ an AI teammate")).toBeVisible();
});

test("Chinese mode localizes workspace settings, runtime policy, and teammate setup labels", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.getByLabel("任务检查器")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "任务上下文" })).toHaveCount(0);
  await expect(page.getByText("Task context")).toHaveCount(0);
  await expect(page.getByText("No task selected")).toHaveCount(0);
  await expect(page.getByText("active · serial · boundPath lock")).toHaveCount(0);
  await expect(page.getByText(/已启用 频道/)).toHaveCount(0);
  await expect(page.getByText("Daemon ready")).toHaveCount(0);
  await expect(page.getByText("本地服务已就绪")).toHaveCount(0);
  await page.locator(".channel-header-actions").getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("频道管理")).toContainText("运行模型预设");
  await expect(page.getByLabel("频道运行策略")).toBeVisible();
  await expect(page.getByLabel("频道管理").getByRole("button", { name: "创建频道" })).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI 队友" }).click();
  await expect(page.getByRole("heading", { name: "AI 队友", level: 1 })).toBeVisible();
  await expect(page.getByLabel("AI 队友上下文")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
  await page.getByLabel("队友模板").getByRole("button", { name: /产品策略/ }).click();
  const roleDetail = page.getByRole("dialog", { name: "角色详情" });
  await expect(roleDetail).toBeVisible();
  await expect(roleDetail.getByText("这个队友能做什么")).toBeVisible();
  await expect(roleDetail.getByText("系统提示词")).toBeHidden();
  await roleDetail.getByRole("button", { name: "关闭角色详情" }).click();
  await expect(page.getByText("Role", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Pick a default teammate or start blank")).toHaveCount(0);
  await expect(page.getByText("标准 · medium")).toHaveCount(0);
  await page.getByLabel("队友模板").getByRole("button", { name: "添加队友" }).click();
  const createDialog = page.getByRole("dialog", { name: "创建 AI 队友" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByText("选择角色", { exact: true })).toBeVisible();
  await expect(createDialog.getByText("选择模型", { exact: true })).toBeVisible();
  await expect(createDialog.getByText("基础信息", { exact: true })).toBeVisible();
  await expect(createDialog.getByLabel("队友设置步骤")).toHaveCount(0);
  await expect(createDialog.getByLabel("队友预览")).toHaveCount(0);
  await expect(createDialog.getByText("系统提示词")).toHaveCount(0);
  await createDialog.getByText("高级设置").click();
  await expect(page.getByText("Project files")).toHaveCount(0);
  await expect(page.getByText("Skill pack")).toHaveCount(0);
  await expect(createDialog.getByText("技能包")).toBeVisible();
});

test("theme switcher supports system, light, and dark preferences", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ling-stack.themeTestInitialized")) {
      localStorage.setItem("ling-stack.locale", "en-US");
      localStorage.removeItem("ling-stack.themePreference");
      sessionStorage.setItem("ling-stack.themeTestInitialized", "true");
    }
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "system");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await expect(page.getByRole("heading", { name: "Interface preferences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveAttribute("data-theme-preference", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBe("light");

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBe("dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("button", { name: "System" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "system");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("settings approval policy loads, edits, and saves tool decisions and write paths", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Approval policy/ }).click();
  const settingsPanel = page.locator(".settings-panel").filter({ hasText: "Approval policy" });
  await expect(page.getByRole("heading", { name: "Approval policy" })).toBeVisible();
  await expect(settingsPanel).not.toContainText("workspace_default");

  const bashDecision = settingsPanel.locator(".policy-tool-row").filter({ hasText: "bash" }).locator("select");
  await expect(bashDecision).toHaveValue("ask");
  await bashDecision.selectOption("deny");
  await settingsPanel.getByText("Advanced settings").click();
  await settingsPanel.getByLabel("Allowed write paths").fill(".\n/tmp/ling-stack-workspace\n  ");
  await settingsPanel.getByRole("button", { name: "Save policy" }).click();

  await expect.poll(() => {
    const toolDecisions = state.lastApprovalPolicyPatch?.toolDecisions;
    return isRecord(toolDecisions) ? toolDecisions.bash : undefined;
  }).toBe("deny");
  await expect.poll(() => state.lastApprovalPolicyPatch?.allowedWritePaths).toEqual([".", "/tmp/ling-stack-workspace"]);
  await expect.poll(() => state.approvalPolicy.toolDecisions.bash).toBe("deny");
  await expect(bashDecision).toHaveValue("deny");
  await expect(settingsPanel.getByLabel("Allowed write paths")).toHaveValue(".\n/tmp/ling-stack-workspace");
});

test("settings plugins page applies and controls the CUA trusted-local preset without teammate authorization", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Engineer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Plugins/ }).click();

  const pluginsPanel = page.locator(".settings-plugin-manager");
  await expect(pluginsPanel).toContainText("Cua Driver");
  await expect(pluginsPanel).toContainText("trusted local");
  await expect(pluginsPanel).toContainText("bundled:cua-driver");
  await expect(pluginsPanel).toContainText("Runs a user-installed local binary through MCP");
  await expect(pluginsPanel).not.toContainText("Marketplace");
  await expect(pluginsPanel).not.toContainText("Install");

  const bundledRow = pluginsPanel.locator(".settings-plugin-row").filter({ hasText: "bundled:cua-driver" });
  await expect(bundledRow).toContainText("bundled");
  await expect(bundledRow).toContainText("Package metadata only");
  await expect(bundledRow.getByRole("button", { name: "Apply preset" })).toHaveCount(0);
  await bundledRow.getByRole("button", { name: "Validate package" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Package validation passed.");

  const cuaRow = pluginsPanel.locator(".settings-plugin-row").filter({ hasText: "trusted-local:cua-driver" });
  await expect(cuaRow).toContainText("mcp-server: Cua Driver MCP server");
  await cuaRow.getByRole("button", { name: "Apply preset" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-apply-result")).toContainText("mcp_cua_driver");
  await expect(pluginsPanel.locator(".settings-plugin-apply-result")).toContainText("3 tools");
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Preset applied");
  await expect(cuaRow).toContainText("mcp_cua_driver");
  expect(state.mcpServers.find((server) => server.id === "mcp_cua_driver")?.enabled).toBe(true);
  expect(state.mcpTools.filter((tool) => tool.serverId === "mcp_cua_driver").map((tool) => [tool.rawName, tool.defaultApproval])).toEqual([
    ["check_permissions", "allow"],
    ["click", "ask"],
    ["list_windows", "allow"],
  ]);
  expect(state.teammateMcpBindings).toEqual([]);

  await cuaRow.getByRole("button", { name: "Check" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin check completed.");
  await expect(cuaRow).toContainText("MCP server is reachable.");

  await cuaRow.getByRole("button", { name: "Disable" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin disabled.");
  expect(state.mcpServers.find((server) => server.id === "mcp_cua_driver")?.enabled).toBe(false);
  await expect(cuaRow).toContainText("disabled");

  await cuaRow.getByRole("button", { name: "Enable" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin enabled.");
  expect(state.mcpServers.find((server) => server.id === "mcp_cua_driver")?.enabled).toBe(true);

  await pluginsPanel.getByRole("button", { name: "MCP settings" }).click();
  await expect(page.getByRole("heading", { name: "Tool Access", level: 1 })).toBeVisible();
  await expect(page.locator(".mcp-server-row").filter({ hasText: "Cua Driver" })).toBeVisible();
});

test("settings external work status shows setup and explicit controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("External work");
  await expect(panel).toContainText("openclaw/openclaw");
  await expect(panel).toContainText("configured");
  await expect(panel).toContainText("not_configured");
  await expect.poll(() => state.externalWorkPollCalls.github ?? 0).toBe(0);
  await expect.poll(() => state.externalWorkBackgroundStartCalls).toBe(0);
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(0);
  await expect.poll(() => state.externalActionExecuteCalls.external_work_action_1 ?? 0).toBe(0);

  await panel.getByRole("button", { name: "Poll once" }).click();
  await expect.poll(() => state.externalWorkPollCalls.github ?? 0).toBe(1);

  await panel.getByRole("button", { name: "Reconcile" }).click();
  await expect.poll(() => state.externalWorkReconcileCalls).toBe(1);

  await panel.getByRole("button", { name: "Start background" }).click();
  await expect.poll(() => state.externalWorkBackgroundStartCalls).toBe(1);
  await expect(panel).toContainText("running");
  await expect(panel.getByRole("button", { name: "Stop background" })).toBeVisible();

  await panel.getByRole("button", { name: "Stop background" }).click();
  await expect.poll(() => state.externalWorkBackgroundStopCalls).toBe(1);
  await expect(panel).toContainText("stopped");

  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);
  await expect(panel).toContainText("openclaw/openclaw");
});

test("settings external work token setup saves to daemon and clears the input", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({ secretStatus: "missing" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("External token");
  await expect(panel).toContainText("env:GITHUB_TOKEN");
  await expect.poll(() => state.externalWorkSecretConfigureCalls).toBe(0);
  await expect.poll(() => state.externalWorkSecretDeleteCalls).toBe(0);

  const tokenInput = panel.getByLabel("Token");
  await tokenInput.fill("test-github-token");
  await panel.getByRole("button", { name: "Save GitHub token" }).click();

  await expect.poll(() => state.externalWorkSecretConfigureCalls).toBe(1);
  await expect.poll(() => state.lastExternalWorkSecretConfigure?.channelId).toBe("channel_engineering");
  await expect.poll(() => state.lastExternalWorkSecretConfigure?.tokenLength).toBe("test-github-token".length);
  await expect(tokenInput).toHaveValue("");
  await expect(panel).toContainText("keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");
  await expect(panel).toContainText("configured");

  await panel.getByRole("button", { name: "Remove token" }).click();
  await expect.poll(() => state.externalWorkSecretDeleteCalls).toBe(1);
  await expect(panel).toContainText("missing");
  await expect(panel).toContainText("Secret is not configured: keychain:LING_STACK_GITHUB_OPENCLAW_OPENCLAW_TOKEN");
});

test("settings external work status renders invalid, missing, and Linear states", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({
    workflowValid: false,
    workflowError: "source.kind is required",
    secretStatus: "missing",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("invalid");
  await expect(panel).toContainText("source.kind is required");
  await expect(panel).toContainText("Secret is not configured");
  await expect(panel).toContainText("Create WORKFLOW.md");
  await expect(panel.getByRole("button", { name: "Poll once" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Save GitHub token" })).toBeDisabled();
  await panel.getByRole("button", { name: "Repair WORKFLOW.md" }).click();
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(1);
  await expect.poll(() => state.lastExternalWorkWorkflowConfigure?.repository).toBe("openclaw/openclaw");
  await expect(panel.getByLabel("Token")).toBeEnabled();

  state.externalWorkStatus = createExternalWorkStatus({ workflowExists: false, workflowValid: false, sourceKind: "unknown", workflowError: "WORKFLOW.md was not found" });
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel).toContainText("missing");
  await expect(panel).toContainText("WORKFLOW.md was not found");
  await panel.getByLabel("Repository").fill("https://github.com/owner/repo");
  await panel.getByRole("button", { name: "Create WORKFLOW.md" }).click();
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(2);
  await expect.poll(() => state.lastExternalWorkWorkflowConfigure?.repository).toBe("owner/repo");
  await expect(panel.getByLabel("Token")).toBeEnabled();

  state.externalWorkStatus = createExternalWorkStatus({ sourceKind: "linear" });
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel).toContainText("linear");
  await expect(panel).toContainText("ling-stack");
  await expect(panel).toContainText("unsupported");
  await expect(panel.getByRole("button", { name: "Start background" })).toHaveCount(0);

  await panel.getByRole("button", { name: "Poll once" }).click();
  await expect.poll(() => state.externalWorkPollCalls.linear ?? 0).toBe(1);
});
