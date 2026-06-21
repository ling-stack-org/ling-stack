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
    if (!sessionStorage.getItem("ling-stack.localeSwitcherInitialized")) {
      localStorage.setItem("ling-stack.locale", "en-US");
      sessionStorage.setItem("ling-stack.localeSwitcherInitialized", "true");
    }
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
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
  await expect.poll(() => state.workspaceSettings.locale).toBe("zh-CN");
  await page.locator(".task-toolbar-progress").click();
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await page.locator(".task-toolbar-panel").click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "文件");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /界面偏好/ }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect.poll(() => state.workspaceSettings.locale).toBe("en-US");
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
  await page.locator(".task-toolbar-progress").click();
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await page.locator(".task-toolbar-panel").click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Files");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);
});

test("Chinese mode localizes workspace settings, runtime policy, and teammate setup labels", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /工作区工具/ }).click();
  await page.getByRole("button", { name: "打开 AI 队友" }).click();
  await expect(page.locator(".teammates-page-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "返回工作区工具" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 队友", level: 1 })).toHaveCount(0);
  await expect(page.getByLabel("AI 队友上下文")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
  await page.getByLabel("队友模板").getByRole("button", { name: /产品策略/ }).click();
  const roleDetail = page.getByRole("dialog", { name: "角色详情" });
  await expect(roleDetail).toBeVisible();
  await expect(roleDetail.getByText("这个队友能做什么")).toBeVisible();
  await expect(roleDetail.getByText("系统提示词")).toBeHidden();
  await roleDetail.getByRole("button", { name: "关闭角色详情" }).click({ force: true });
  await expect(roleDetail).toHaveCount(0);
  await expect(page.getByText("Role", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Pick a default teammate or start blank")).toHaveCount(0);
  await expect(page.getByText("标准 · medium")).toHaveCount(0);
  await page.getByLabel("队友模板").getByRole("button", { name: "添加队友", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "创建 AI 队友" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog).toContainText("选择初始角色");
  await expect(createDialog.getByLabel("基础模型")).toBeVisible();
  await expect(createDialog).toContainText("基础信息");
  await expect(createDialog).toContainText("没有模型预设");
  await expect(createDialog.getByLabel("队友设置步骤")).toHaveCount(0);
  await expect(createDialog.getByLabel("队友预览")).toHaveCount(0);
  await expect(createDialog.getByText("系统提示词")).toHaveCount(0);
  await createDialog.getByText("高级设置").click();
  await expect(page.getByText("Project files")).toHaveCount(0);
  await expect(page.getByText("Skill pack")).toHaveCount(0);
  await expect(createDialog.getByRole("heading", { name: "加入频道" })).toBeVisible();
  await expect(createDialog.getByRole("heading", { name: "记忆" })).toBeVisible();
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
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
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
  await expect.poll(() => state.workspaceSettings.theme).toBe("light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");
  await expect.poll(() => state.workspaceSettings.theme).toBe("dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("button", { name: "System" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "system");
  await expect.poll(() => state.workspaceSettings.theme).toBe("system");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("settings interface preferences do not expose the channel protocol editor", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  const settingsPanel = page.locator(".settings-panel").filter({ hasText: "Interface preferences" });
  await expect(settingsPanel).not.toContainText("Channel protocol");
  await expect(settingsPanel.getByRole("button", { name: "Open editor" })).toHaveCount(0);
});

test("settings runtime runners show daemon readiness blockers", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Runtime runners/ }).click();
  const settingsPanel = page.locator(".runtime-runner-settings-panel");
  await expect(page.getByRole("heading", { name: "Runtime runners" })).toBeVisible();
  await expect(settingsPanel).toContainText("Pi Runner");
  await expect(settingsPanel).toContainText("readiness ready");
  await expect(settingsPanel).toContainText("Codex App Server");
  await expect(settingsPanel).toContainText("readiness blocked, 2 blockers");
  await expect(settingsPanel.getByLabel("Codex App Server readiness blockers")).toContainText("Sandbox profile has not been configured.");
  await expect(settingsPanel.getByLabel("Codex App Server readiness blockers")).toContainText("Sandbox backend has not been verified by conformance.");
  await expect(settingsPanel).not.toContainText("sandbox_profile_missing");
  await expect(settingsPanel).not.toContainText("sandbox_backend_unverified");
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
  await expect(settingsPanel.getByText("Advanced workspace policy", { exact: true })).toBeVisible();
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

test("settings permission preset cards update the effective preview", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Approval policy/ }).click();
  const settingsPanel = page.locator(".settings-panel").filter({ hasText: "Approval policy" });

  await settingsPanel.getByRole("button", { name: /Workspace collaboration/ }).click();
  await expect(settingsPanel.getByLabel("Effective permissions")).toContainText("Allows: read, grep, find, ls, edit, write");
  await expect(settingsPanel.getByLabel("Effective permissions")).toContainText("Asks: bash");
  await expect(settingsPanel.getByText("Selected preset", { exact: true })).toBeVisible();
  await expect(settingsPanel).toContainText("Workspace collaboration");

  await settingsPanel.getByRole("button", { name: /Full access/ }).click();
  await expect(settingsPanel.getByLabel("Effective permissions")).toContainText("Write scope: /");
  await expect(settingsPanel.getByLabel("Effective permissions")).toContainText("Allows: read, grep, find, ls, bash, edit, write");
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

  const bundledRow = pluginsPanel.locator(".settings-plugin-row").filter({ hasText: "bundled:cua-driver" });
  await expect(bundledRow).toContainText("bundled");
  await expect(bundledRow).toContainText("not installed");
  await expect(bundledRow.getByRole("button", { name: "Apply preset" })).toHaveCount(0);
  await bundledRow.getByRole("button", { name: "Install" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin package installed.");
  await expect(bundledRow).toContainText("installed");
  await expect(bundledRow).toContainText("mockhash1234");
  await bundledRow.getByRole("button", { name: "Runtime preview" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-runtime-preview")).toContainText("disabled");
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Runtime preview blocked.");
  await bundledRow.getByRole("button", { name: "Enable" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin enabled.");
  await bundledRow.getByRole("button", { name: "Runtime preview" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-runtime-preview")).toContainText("injectable");
  await expect(pluginsPanel.locator(".settings-plugin-runtime-preview")).toContainText("2 policy overlays");
  await bundledRow.getByRole("button", { name: "Uninstall" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin package uninstalled.");
  await expect(bundledRow).toContainText("uninstalled");
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
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /MCP tool servers/ })).toHaveClass(/active/);
  await expect(page.locator(".mcp-server-row").filter({ hasText: "Cua Driver" })).toBeVisible();
});

test("settings skill library shows read-only skill health findings", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const implementationSkill = state.skillRegistryEntries.find((item) => isRecord(item) && item.id === "implement");
  if (isRecord(implementationSkill) && isRecord(implementationSkill.definition)) {
    state.skillRegistryEntries.unshift({
      ...implementationSkill,
      id: "implement-duplicate",
      packId: "skill_pack_duplicate",
      source: "custom",
      reviewStatus: "published",
      definition: {
        ...implementationSkill.definition,
        id: "implement-duplicate",
        requiredTools: ["bash"],
      },
      visibility: {
        workspaceVisible: true,
        promotableToWorkspace: true,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
  }
  state.channelPlaybookCandidates.push({
    id: "channel_playbook_candidate_rollback",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: "Deployment rollback playbook",
    summary: "Rollback steps should stay as a channel-local operating procedure.",
    normalizedGoal: "deployment rollback",
    procedureSteps: [{ title: "Collect rollback evidence", instruction: "Summarize failed rollout evidence.", requiredTools: ["read"] }],
    validationSteps: [{ title: "Confirm rollback state", commandOrCheck: "Review deployment status.", expectedResult: "Deployment is stable." }],
    positiveTriggers: ["release rollback"],
    negativeTriggers: ["docs-only change"],
    sourceRefs: [{ type: "run", id: "run_rollback_playbook", label: "Rollback run" }],
    reason: "Seeded playbook candidate for review.",
    createdBy: "ai-draft",
    status: "draft",
    createdAt: "2026-06-20T00:32:00.000Z",
    updatedAt: "2026-06-20T00:32:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Skill Library/ }).click();
  const panel = page.locator(".settings-skill-library");
  const healthPanel = panel.getByRole("region", { name: "Skill Health" });
  await expect(panel.getByRole("heading", { name: "Skill Library" })).toBeVisible();
  await expect(healthPanel).toContainText("Duplicate clusters");
  await expect(healthPanel).toContainText("Duplicate skill cluster");
  await expect(healthPanel).toContainText("Conflicting skill triggers");
  await expect(healthPanel).toContainText("implement-duplicate");
  await expect(panel.getByRole("button", { name: "Archive" }).first()).toBeVisible();

  const candidatePanel = panel.getByRole("region", { name: "Skill Candidate Review" });
  await expect(candidatePanel).toContainText("Channel canvas protocol skill");
  await expect(candidatePanel).toContainText("No overlap");
  await expect(candidatePanel).toContainText("Draft gates clear");
  await candidatePanel.getByRole("button", { name: "Approve for draft" }).click();
  await expect(candidatePanel).toContainText("Approved for draft");
  await candidatePanel.getByRole("button", { name: "Create registry draft" }).click();
  await expect(panel.locator(".settings-skill-import-preview")).toContainText("Channel canvas protocol skill");
  await expect(panel).toContainText("Draft ready");
  await panel.getByRole("button", { name: "Publish to registry" }).click();
  await expect(panel).toContainText("Published 1 skills");
  await expect(panel).toContainText("channel-canvas-protocol-skill");
  await candidatePanel.getByRole("button", { name: "Reject candidate" }).click();
  await expect(candidatePanel).toContainText("No open skill candidates");

  const playbookPanel = panel.getByRole("region", { name: "Playbook Candidate Review" });
  await expect(playbookPanel).toContainText("Deployment rollback playbook");
  await expect(playbookPanel).toContainText("docs-only change");
  const seededPlaybook = playbookPanel.locator(".settings-skill-candidate-card").filter({ hasText: "Deployment rollback playbook" });
  await seededPlaybook.getByRole("button", { name: "Reject playbook" }).click();
  await expect.poll(() => {
    const candidate = state.channelPlaybookCandidates.find((item) => isRecord(item) && item.id === "channel_playbook_candidate_rollback");
    return isRecord(candidate) ? candidate.status : "";
  }).toBe("cancelled");
  await expect(panel).toContainText("Playbook candidate rejected");

  const clusterPanel = panel.getByRole("region", { name: "Candidate Clusters" });
  await expect(clusterPanel).toContainText("2 review · 1 blocked · 3 total");
  await expect(clusterPanel).toContainText("Channel canvas handoff protocol");
  await expect(clusterPanel).toContainText("Create channel protocol candidate");
  await clusterPanel.getByRole("button", { name: "Create protocol candidate" }).click();
  await expect.poll(() => state.channelProtocolDrafts.length).toBe(1);
  await expect.poll(() => {
    const draft = state.channelProtocolDrafts[0];
    return isRecord(draft) && isRecord(draft.proposedPatch) && Array.isArray(draft.proposedPatch.reviewRules)
      ? draft.proposedPatch.reviewRules.join("\n")
      : "";
  }).toContain("Channel canvas handoff protocol");
  await expect(panel).toContainText("Protocol candidate created");
  await expect(clusterPanel).toContainText("Release verification playbook");
  await expect(clusterPanel).toContainText("Create playbook candidate");
  await clusterPanel.getByRole("button", { name: "Create playbook candidate" }).click();
  await expect.poll(() => state.channelPlaybookCandidates.length).toBe(2);
  await expect.poll(() => {
    const candidate = state.channelPlaybookCandidates[0];
    return isRecord(candidate) && typeof candidate.title === "string" ? candidate.title : "";
  }).toContain("Release verification playbook");
  await expect(panel).toContainText("Playbook candidate created");
  await expect(playbookPanel).toContainText("Release verification playbook");
  const releasePlaybook = playbookPanel.locator(".settings-skill-candidate-card").filter({ hasText: "Release verification playbook" });
  await releasePlaybook.getByRole("button", { name: "Approve playbook" }).click();
  await expect.poll(() => {
    const candidate = state.channelPlaybookCandidates.find((item) => isRecord(item) && typeof item.title === "string" && item.title.includes("Release verification playbook"));
    return isRecord(candidate) ? candidate.status : "";
  }).toBe("active");
  await expect(panel).toContainText("Playbook activated");
  await expect(clusterPanel).toContainText("Generated skill missing gates");
  await expect(clusterPanel).toContainText("Append evidence");
});

test("settings skill library saves skill governance policy", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Skill Library/ }).click();
  const panel = page.locator(".settings-skill-library");
  const governancePanel = panel.getByRole("region", { name: "Skill Governance Policy" });
  await expect(governancePanel).toContainText("Semi-auto");
  await expect(governancePanel).toContainText("User initiated");
  await expect(governancePanel).toContainText("Explicit only");
  await expect(governancePanel).toContainText("Candidate generation options");
  await expect(governancePanel).toContainText("Create pending candidates from one stable successful observation");
  await expect(governancePanel).toContainText("How recording works");
  await expect(governancePanel).toContainText("Ling does not record background agent work automatically");
  await expect(governancePanel).toContainText("Generated candidates still require draft, publish, and binding review");

  await governancePanel.getByRole("combobox", { name: "Skill candidate generation mode" }).selectOption("approval_only");
  await governancePanel.getByRole("combobox", { name: "Skill recording mode" }).selectOption("disabled");
  await governancePanel.getByRole("button", { name: "Save governance policy" }).click();

  await expect.poll(() => {
    const policy = state.workspaceSettings.skillGovernancePolicy;
    return isRecord(policy) ? `${policy.generationMode}:${policy.recordingMode}` : "";
  }).toBe("approval_only:disabled");
  await expect(panel).toContainText("Skill governance policy saved");
  await expect(governancePanel).toContainText("Approval only");
  await expect(governancePanel).toContainText("Disabled");
});

test("settings external work status shows setup and explicit controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /External work/ }).click();
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
  await page.getByLabel("Settings sections").getByRole("button", { name: /External work/ }).click();
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
  await page.getByLabel("Settings sections").getByRole("button", { name: /External work/ }).click();
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
