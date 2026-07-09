import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createExternalWorkStatus,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";
import {
  channelEventFilterToggle,
  openChannelChatTools,
  readHorizontalOverflow,
} from "./support/test-helpers";

function archivedTimestamp(index: number): string {
  return `2026-07-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`;
}

function createArchivedConversation(index: number): MockState["threads"][number] {
  const timestamp = archivedTimestamp(index);
  return {
    id: `thread_archived_visual_${index}`,
    workspaceId: "workspace_default",
    kind: "conversation",
    teammateId: "ling_agent",
    title: `Archived conversation ${index + 1}`,
    objective: `Archived conversation ${index + 1}`,
    status: "archived",
    conversationMode: { mode: "default" },
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: timestamp,
  };
}

function createArchivedChannel(index: number): Record<string, unknown> {
  const timestamp = archivedTimestamp(index);
  return {
    id: `channel_archived_visual_${index}`,
    workspaceId: "workspace_default",
    name: `Archived channel ${index + 1}`,
    status: "archived",
    boundPath: "/tmp/ling-archived",
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createArchivedBranch(index: number): Record<string, unknown> {
  const timestamp = archivedTimestamp(index);
  return {
    id: `branch_archived_visual_${index}`,
    workspaceId: "workspace_default",
    channelId: `channel_archived_visual_${index}`,
    name: `Archived branch ${index + 1}`,
    status: "archived",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: timestamp,
  };
}

async function archivedGroupMetrics(page: Page, title: string): Promise<{
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly overflowY: string;
}> {
  return await page.locator(".archived-item-group").filter({ hasText: title }).locator(".archived-item-list").evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
}

test("language switcher toggles Chinese and English UI labels", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await expect(page.locator(".interface-settings-panel").getByRole("heading", { name: "Interface preferences" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Interface preferences" })).toHaveCount(1);
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".interface-settings-panel").getByRole("heading", { name: "界面偏好" })).toBeVisible();
  await page.getByRole("button", { name: "返回应用" }).click();
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
  await expect(page.locator(".channel-progress-popover")).toBeVisible();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await page.locator(".task-toolbar-panel").click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "频道工作区面板");
  await expect(page.locator(".channel-progress-popover")).toHaveCount(0);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /界面偏好/ }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect.poll(() => state.workspaceSettings.locale).toBe("en-US");
  await page.getByRole("button", { name: "Back to app" }).click();
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
  await expect(page.locator(".channel-progress-popover")).toBeVisible();
  await expect(page.locator(".channel-side-panel")).toHaveCount(0);
  await page.locator(".task-toolbar-panel").click();
  await expect(page.locator(".channel-side-panel")).toHaveAttribute("aria-label", "Channel workspace dock");
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
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "更多频道视图" }).click();
  await page.getByRole("menuitem", { name: "设置" }).click();
  await expect(page.getByLabel("频道管理")).toContainText("运行模型预设");
  await expect(page.getByLabel("频道运行策略")).toBeVisible();
  await expect(page.getByLabel("频道管理").getByRole("button", { name: "创建频道" })).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("设置分组").getByRole("button", { name: "个性化" })).toBeVisible();
  await expect(page.getByLabel("设置分组").getByRole("button", { name: "Personalization" })).toHaveCount(0);
  await page.getByLabel("设置分组").getByRole("button", { name: "队友管理" }).click();
  await expect(page.getByLabel("设置分组").getByRole("button", { name: "队友管理" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
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
  await page.getByLabel("工作区队友").getByRole("button", { name: "新建 AI 队友", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "创建 AI 队友" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog).toContainText("选择初始角色");
  await expect(createDialog.getByLabel("基础模型")).toBeVisible();
  await expect(createDialog).toContainText("基础信息");
  await expect(createDialog).toContainText("没有可用的聊天模型");
  await expect(createDialog.getByLabel("队友设置步骤")).toHaveCount(0);
  await expect(createDialog.getByLabel("队友预览")).toHaveCount(0);
  await expect(createDialog.getByText("系统提示词")).toHaveCount(0);
  await expect(createDialog.getByText("高级设置")).toHaveCount(0);
  await expect(createDialog.getByText("默认记忆范围")).toHaveCount(0);
  await expect(createDialog.getByRole("button", { name: "私聊摘要" })).toHaveCount(0);
  await expect(page.getByText("Project files")).toHaveCount(0);
  await expect(page.getByText("Skill pack")).toHaveCount(0);
  await expect(createDialog.getByLabel("加入频道")).toBeVisible();
});

test("theme switcher supports system, light, and dark preferences", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ling-stack.themeTestInitialized")) {
      localStorage.setItem("ling-stack.locale", "en-US");
      localStorage.removeItem("ling-stack.themePreference");
      localStorage.removeItem("ling-stack.themeBootstrapPreference");
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
  await expect(page.locator(".interface-settings-panel").getByRole("heading", { name: "Interface preferences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveAttribute("data-theme-preference", "light");
  await expect.poll(() => state.workspaceSettings.theme).toBe("light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themeBootstrapPreference"))).toBe("light");

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-theme-preference", "dark");
  await expect.poll(() => state.workspaceSettings.theme).toBe("dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themePreference"))).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themeBootstrapPreference"))).toBe("dark");
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
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ling-stack.themeBootstrapPreference"))).toBe("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("theme bootstrap cache prevents a dark first paint before React starts", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("ling-stack.themePreference");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "light");
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveAttribute("data-theme-preference", "light");
});

test("settings interface preferences do not expose the channel protocol editor", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  const settingsPanel = page.locator(".interface-settings-panel");
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
  await page.getByLabel("Settings sections").getByRole("button", { name: /Default authorization/ }).click();
  await page.getByRole("tab", { name: /Execution runners/ }).click();
  const settingsPanel = page.locator(".runtime-runner-settings-panel");
  await expect(page.getByRole("heading", { name: "Execution runners" })).toBeVisible();
  await expect(settingsPanel).toContainText("Pi Runner");
  await expect(settingsPanel).toContainText("readiness ready");
  await expect(settingsPanel).toContainText("Codex App Server");
  await expect(settingsPanel).toContainText("readiness blocked, 2 blockers");
  await settingsPanel.locator(".runtime-runner-row").filter({ hasText: "Codex App Server" }).getByText("Runner details").click();
  await expect(settingsPanel.getByLabel("Codex App Server readiness blockers")).toContainText("Sandbox profile has not been configured.");
  await expect(settingsPanel.getByLabel("Codex App Server readiness blockers")).toContainText("Sandbox backend has not been verified by conformance.");
  await expect(settingsPanel).not.toContainText("sandbox_profile_missing");
  await expect(settingsPanel).not.toContainText("sandbox_backend_unverified");
});

test("settings developer section contains startup readiness", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections.getByRole("button", { name: /Startup readiness/ })).toHaveCount(0);

  await settingsSections.getByRole("button", { name: /Startup and diagnostics/ }).click();
  const developerPanel = page.locator(".developer-settings-panel");
  await expect(developerPanel.getByRole("heading", { name: "Startup readiness" })).toBeVisible();
  await expect(developerPanel.locator(".startup-readiness-card")).toBeVisible();
  await expect(developerPanel.getByText("Startup phases")).toBeVisible();
  await expect(developerPanel).toContainText("ready");
  await expect(developerPanel.getByRole("button", { name: "Refresh" })).toBeVisible();
  await developerPanel.getByRole("button", { name: "Open Run Diagnostics" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Startup and diagnostics/ })).toHaveClass(/active/);
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.locator(".settings-run-diagnostics-panel")).toBeVisible();
  await expect(page.locator(".run-history-layout")).toHaveCount(0);
  await page.locator(".settings-run-diagnostics-panel").getByRole("button", { name: "Close run diagnostics" }).click();
  await expect(developerPanel.getByRole("heading", { name: "Startup readiness" })).toBeVisible();
});

test("settings archived items keep rules compact, lists scrollable, and actions aligned", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = Array.from({ length: 9 }, (_, index) => createArchivedConversation(index));
  state.aiTeammates = Array.from({ length: 6 }, (_, index) =>
    createMockTeammate({
      id: `teammate_archived_visual_${index}`,
      displayName: `Archived teammate ${index + 1}`,
      hidden: true,
      status: "active",
      updatedAt: archivedTimestamp(index),
    })
  );
  state.channels.push(...Array.from({ length: 6 }, (_, index) => createArchivedChannel(index)));
  state.channelBranches = Array.from({ length: 6 }, (_, index) => createArchivedBranch(index));
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  const panel = page.locator(".archived-items-settings-panel");
  await expect(panel.getByRole("heading", { name: "Archived items" })).toBeVisible();
  await expect(panel.locator(".archived-items-rules-footer")).toHaveCount(0);
  await expect(panel.locator(".archived-items-rule-note")).toHaveCount(0);
  const hint = panel.locator(".archived-items-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("Restored items return to their lists; channel and branch delete is permanent.");
  await expect(panel.getByText("Restore and delete rules")).toHaveCount(0);

  for (const title of ["Conversations", "AI Teammates", "Channels", "Branches"]) {
    const metrics = await archivedGroupMetrics(page, title);
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 2);
  }

  const actionAlignment = await panel.locator(".archived-item-actions .compact-button").evaluateAll((buttons) =>
    buttons.slice(0, 10).map((button) => {
      const icon = button.querySelector("svg");
      const label = button.querySelector(".archived-action-label");
      const iconRect = icon?.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      if (!iconRect || !labelRect) {
        return 99;
      }
      return Math.abs((iconRect.top + iconRect.height / 2) - (labelRect.top + labelRect.height / 2));
    })
  );
  expect(Math.max(...actionAlignment)).toBeLessThanOrEqual(2);
  await expect.poll(() => readHorizontalOverflow(page, ".archived-items-settings-panel")).toEqual([]);
});

test("settings configuration entries open nested tools directly", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_ready_settings",
      displayName: "Ready Relay",
      lastCheck: { ok: true, message: "ok", checkedAt: "2026-06-23T00:00:00.000Z" },
    }),
  ];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_settings_engineer", displayName: "Engineer" }),
    createMockTeammate({ id: "teammate_settings_designer", displayName: "Designer" }),
  ];
  state.workItems = [
    {
      id: "work_item_settings_review",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceType: "channel_task",
      sourceId: "task_settings_review",
      title: "Review settings screenshot",
      description: "Verify the compact workspace tools page.",
      status: "ready",
      priority: "normal",
      labels: [],
      taskId: "task_settings_review",
      artifactIds: [],
      proofArtifactIds: [],
      dependencyIds: [],
      attemptCount: 0,
      retryBudget: 1,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections.getByText("Workspace tools", { exact: true })).toBeVisible();
  await expect(settingsSections.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(settingsSections.getByText("Maintenance", { exact: true })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: /^User profile$/ })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: /Interface preferences/ })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: /Personal and interface/ })).toHaveCount(0);
  await expect(settingsSections).not.toContainText("System");
  await expect(settingsSections).not.toContainText("Extensions");
  await expect(settingsSections).not.toContainText("Model, teammates, and board shortcuts");
  await expect(settingsSections).not.toContainText("Profile, preferences, and identity");
  await expect(settingsSections.getByRole("button", { name: "Configuration overview" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Model Workbench" })).toHaveAttribute("title", "Model Workbench");
  await expect(settingsSections.getByRole("button", { name: "Teammate Management" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toHaveAttribute("title", "Council Workspace");
  await expect(settingsSections.getByRole("button", { name: "AI Councils" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toBeVisible();
  await expect(settingsSections.getByRole("button", { name: "Default authorization" })).toBeVisible();
  await expect(page.locator(".settings-page-section-head")).toHaveCount(0);
  await expect(page.locator(".settings-subnav-description")).toHaveCount(0);
  await expect(page.locator(".settings-workspace-tools")).toHaveCount(0);

  await settingsSections.getByRole("button", { name: "Council Workspace" }).click();
  await expect(settingsSections).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.locator(".council-workspace-page[aria-label='Council Workspace']")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Council Workspace", level: 1 })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Council Workspace" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.locator(".settings-workspace-tools")).toHaveCount(0);

  await settingsSections.getByRole("button", { name: "Default authorization" }).click();
  await expect(settingsSections.getByRole("button", { name: /Default authorization/ })).toHaveClass(/active/);
  await expect(page.locator(".settings-page-section-head")).toHaveCount(0);
  await expect(page.locator(".settings-subnav-description")).toHaveCount(0);
  await expect(page.locator(".settings-global-approval-card")).toHaveCount(1);
  await page.locator(".settings-global-approval-card").getByRole("button", { name: "Ask first" }).click();
  await expect.poll(() => state.workspaceSettings.defaultPermissionMode).toBe("ask_everything");
  await expect.poll(() => state.workspaceSettings.defaultPermissionPreset).toBe("read_only");
});

test("settings approval policy loads, edits, and saves tool decisions and write paths", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Default authorization/ }).click();
  await page.getByRole("tab", { name: /Tool permission policy/ }).click();
  const settingsPanel = page.locator(".settings-panel").filter({ hasText: "Tool permission policy" });
  await expect(page.getByRole("heading", { name: "Tool permission policy" })).toBeVisible();
  await expect(settingsPanel).not.toContainText("workspace_default");

  const advancedPolicy = settingsPanel.locator("details.advanced-settings").filter({ hasText: "Advanced workspace policy" });
  await expect(advancedPolicy).toBeVisible();
  await expect.poll(() => advancedPolicy.evaluate((element) => element.hasAttribute("open"))).toBe(false);
  await advancedPolicy.getByText("Advanced workspace policy", { exact: true }).click();
  const bashDecision = advancedPolicy.locator(".policy-tool-row").filter({ hasText: "bash" }).locator("select");
  await expect(bashDecision).toHaveValue("ask");
  await bashDecision.selectOption("deny");
  await advancedPolicy.getByLabel("Allowed write paths").fill(".\n/tmp/ling-stack-workspace\n  ");
  await settingsPanel.getByRole("button", { name: "Save policy" }).click();

  await expect.poll(() => {
    const toolDecisions = state.lastApprovalPolicyPatch?.toolDecisions;
    return isRecord(toolDecisions) ? toolDecisions.bash : undefined;
  }).toBe("deny");
  await expect.poll(() => state.lastApprovalPolicyPatch?.allowedWritePaths).toEqual([".", "/tmp/ling-stack-workspace"]);
  await expect.poll(() => state.approvalPolicy.toolDecisions.bash).toBe("deny");
  await expect(bashDecision).toHaveValue("deny");
  await expect(advancedPolicy.getByLabel("Allowed write paths")).toHaveValue(".\n/tmp/ling-stack-workspace");
});

test("settings permission preset cards update the effective preview", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Default authorization/ }).click();
  await page.getByRole("tab", { name: /Tool permission policy/ }).click();
  const settingsPanel = page.locator(".settings-panel").filter({ hasText: "Tool permission policy" });

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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Plugin Manager/ }).click();
  await expect(page.locator(".external-work-settings-panel")).toHaveCount(0);
  await expect(page.locator(".mcp-page")).toHaveCount(0);

  const pluginsPanel = page.locator(".settings-plugin-manager");
  await expect(pluginsPanel).toContainText("Cua Driver");
  await expect(pluginsPanel).toContainText("Trusted local");
  await expect(pluginsPanel).toContainText("Bundled");
  await expect(pluginsPanel).not.toContainText("Marketplace");

  const bundledRow = pluginsPanel.locator(".settings-plugin-row").filter({ hasText: "Bundled" });
  const bundledSummary = bundledRow.locator(".settings-plugin-row-summary");
  await expect(bundledSummary).toContainText("Bundled");
  await expect(bundledSummary).not.toContainText("not installed");
  await expect(bundledSummary).not.toContainText("Not installed");
  await expect(bundledSummary).not.toContainText("bundled:cua-driver");
  await expect(bundledSummary).not.toContainText("mockhash1234");
  await expect(bundledRow.getByRole("button", { name: "Apply preset" })).toHaveCount(0);
  await bundledRow.getByRole("button", { name: "Install" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin package installed.");
  await expect(bundledRow).toContainText("installed");
  const bundledDetails = bundledRow.locator(".settings-plugin-details");
  await bundledDetails.getByText("Details and diagnostics").click();
  await expect(bundledDetails).toContainText("bundled:cua-driver");
  await expect(bundledRow).toContainText("mockhash1234");
  await bundledRow.getByRole("button", { name: "Runtime preview" }).click();
  const runtimePreview = pluginsPanel.locator(".settings-plugin-runtime-preview");
  await expect(runtimePreview).toContainText("Runtime preview blocked.");
  await runtimePreview.getByText("Runtime preview details").click();
  await expect(runtimePreview).toContainText("Runtime disabled");
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Runtime preview blocked.");
  await bundledRow.getByRole("button", { name: "Enable" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin enabled.");
  await bundledRow.getByRole("button", { name: "Runtime preview" }).click();
  await expect(runtimePreview).toContainText("Runtime preview ready.");
  await runtimePreview.getByText("Runtime preview details").click();
  await expect(runtimePreview).toContainText("Runtime ready");
  await expect(runtimePreview).toContainText("2 policy overlays");
  await bundledRow.getByRole("button", { name: "Uninstall" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Plugin package uninstalled.");
  await expect(bundledRow).toContainText("uninstalled");
  await bundledRow.getByRole("button", { name: "Validate package" }).click();
  await expect(pluginsPanel.locator(".settings-plugin-action-notice")).toContainText("Package validation passed.");

  const cuaRow = pluginsPanel.locator(".settings-plugin-row").filter({ hasText: "Trusted local" });
  const cuaSummary = cuaRow.locator(".settings-plugin-row-summary");
  await expect(cuaSummary).toContainText("Preset ready to apply");
  await expect(cuaSummary).not.toContainText("trusted-local:cua-driver");
  await expect(cuaSummary).not.toContainText("mcp-server: Cua Driver MCP server");
  const cuaDetails = cuaRow.locator(".settings-plugin-details");
  await cuaDetails.getByText("Details and diagnostics").click();
  await expect(cuaDetails).toContainText("trusted-local:cua-driver");
  await expect(cuaDetails).toContainText("mcp-server: Cua Driver MCP server");
  await cuaRow.getByRole("button", { name: "Apply preset" }).click();
  const applyResult = pluginsPanel.locator(".settings-plugin-apply-result");
  await applyResult.getByText("Preset details").click();
  await expect(applyResult).toContainText("mcp_cua_driver");
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
  await expect(page.getByRole("tab", { name: /MCP tool servers/ })).toHaveCount(0);
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
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Personalization/ })).toBeVisible();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Skill library/ }).click();
  await expect(page.locator(".skill-governance-settings-panel")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Skill sections" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Skill Governance" })).toHaveCount(0);
  const panel = page.locator(".settings-skill-library");
  await expect(panel.getByRole("heading", { name: "Skill library" })).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Skill library/ })).toHaveClass(/active/);
  await expect(page.getByRole("tab", { name: /Skills list/ })).toHaveAttribute("aria-selected", "true");
  const skillLibraryLayout = await panel.evaluate((element) => {
    const content = element.closest(".settings-content-stack");
    const body = element.querySelector(".settings-skill-library-body");
    const tableWrap = element.querySelector(".settings-skill-table-wrap");
    const inspector = element.querySelector(".settings-skill-inspector");
    return {
      contentExpanded: content?.classList.contains("settings-content-stack--skill-library") ?? false,
      panelWidth: element.getBoundingClientRect().width,
      bodyHeight: body?.getBoundingClientRect().height ?? 0,
      tableWidth: tableWrap?.getBoundingClientRect().width ?? 0,
      inspectorWidth: inspector?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(skillLibraryLayout.contentExpanded).toBe(true);
  expect(skillLibraryLayout.panelWidth).toBeGreaterThan(1050);
  expect(skillLibraryLayout.bodyHeight).toBeGreaterThanOrEqual(500);
  expect(skillLibraryLayout.tableWidth).toBeGreaterThanOrEqual(735);
  expect(skillLibraryLayout.inspectorWidth).toBeGreaterThanOrEqual(290);
  await expect.poll(() => readHorizontalOverflow(page, ".settings-skill-library-body, .settings-skill-table-wrap, .settings-skill-inspector")).toEqual([]);
  await expect(panel.getByRole("region", { name: "Skill Health" })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Skill Source Health" })).toHaveCount(0);
  const reviewSkillRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" }).first();
  await expect(reviewSkillRow).not.toContainText("Source-backed");
  const inspector = panel.locator(".settings-skill-inspector");
  await expect(inspector).toContainText("No skill selected");
  await expect(inspector.locator(".settings-skill-summary-card")).toHaveCount(0);
  await reviewSkillRow.getByRole("button", { name: "Details" }).click();
  await expect(inspector.locator(".settings-skill-summary-card")).toBeVisible();
  await expect(inspector).toContainText("Source details are available below when you need them.");
  const sourceDetails = inspector.locator(".settings-skill-inspector-details").filter({ hasText: "Source and raw details" });
  await expect(sourceDetails).toBeVisible();
  await expect.poll(() => sourceDetails.evaluate((element) => element.hasAttribute("open"))).toBe(false);
  await sourceDetails.getByText("Source and raw details").click();
  await expect(sourceDetails).toContainText("skill_source_review_mock");
  await expect(sourceDetails).toContainText("View SKILL.md");
  await expect(panel.getByRole("button", { name: "Preview optimization" })).toHaveCount(1);
  await panel.getByRole("button", { name: "Preview optimization" }).click();
  await expect(sourceDetails).toContainText("preview_on_demand");
  await expect(sourceDetails).toContainText("Compiled tokens");
  await expect(sourceDetails).toContainText("Lazy references: 1");
  await panel.getByRole("button", { name: "Archive source snapshot" }).click();
  await expect(panel).toContainText("Source snapshot archived");
  await expect.poll(() => {
    const snapshot = state.skillSourceSnapshots.find((item) => isRecord(item) && item.id === "skill_source_review_mock");
    return isRecord(snapshot) ? snapshot.reviewStatus : "";
  }).toBe("archived");
  const archivedReviewSkillRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" }).first();
  await expect(archivedReviewSkillRow).not.toContainText("Metadata only");
  await expect(panel.locator(".settings-skill-inspector")).toContainText("Metadata only");
  await expect(panel.locator(".settings-skill-inspector")).toContainText("No published SKILL.md snapshot is attached yet.");

  await panel.getByRole("button", { name: "Sync gstack source" }).click();
  await expect(page.getByRole("tab", { name: /Source sync/ })).toHaveAttribute("aria-selected", "true");
  const sourceHealthDetails = panel.locator(".settings-skill-review-diagnostics").filter({ hasText: "Skill source health diagnostics" });
  await expect(sourceHealthDetails).toBeVisible();
  await expect.poll(() => sourceHealthDetails.evaluate((element) => element.hasAttribute("open"))).toBe(false);
  await sourceHealthDetails.getByText("Skill source health diagnostics").click();
  const sourceHealthPanel = sourceHealthDetails.getByRole("region", { name: "Skill Source Health" });
  await expect(sourceHealthPanel).toContainText("Source-backed");
  await expect(sourceHealthPanel).toContainText("Missing source");
  const sourceHealthLayout = await sourceHealthDetails.evaluate((element) => {
    const findings = element.querySelector(".settings-skill-health-findings");
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      overflow: style.overflow,
      findingsOverflowY: findings ? getComputedStyle(findings).overflowY : "",
      findingCount: findings?.querySelectorAll(".settings-skill-health-finding").length ?? 0,
      findingsScrollHeight: findings?.scrollHeight ?? 0,
      findingsClientHeight: findings?.clientHeight ?? 0,
      hidesFindingsByDefault: element.textContent?.includes("more source findings hidden by default") ?? false,
    };
  });
  expect(sourceHealthLayout.height).toBeGreaterThanOrEqual(350);
  expect(sourceHealthLayout.height).toBeLessThanOrEqual(430);
  expect(sourceHealthLayout.overflow).toBe("hidden");
  expect(sourceHealthLayout.findingsOverflowY).toBe("auto");
  expect(sourceHealthLayout.findingCount).toBeGreaterThan(0);
  expect(sourceHealthLayout.findingsScrollHeight).toBeGreaterThanOrEqual(sourceHealthLayout.findingsClientHeight);
  expect(sourceHealthLayout.hidesFindingsByDefault).toBe(false);
  await expect(panel).not.toContainText("Persona cannot grant tools");
  const sourceSyncPanel = panel.getByRole("region", { name: "gstack source sync" });
  await expect(sourceSyncPanel).toBeVisible();
  await expect(sourceSyncPanel).toContainText("Prompt before publish");
  const sourceSyncOptions = sourceSyncPanel.locator(".settings-skill-source-sync-options");
  await expect(sourceSyncOptions).toBeVisible();
  await expect(sourceSyncOptions).toContainText("Include detected roots");
  await expect(sourceSyncOptions).toContainText("Allow new skills");
  await expect(sourceSyncPanel).toContainText("Advanced source roots");
  await expect(sourceSyncPanel.getByLabel("Include detected roots")).toBeChecked();
  await expect(sourceSyncPanel.getByLabel("Allow new skills")).not.toBeChecked();
  await sourceSyncPanel.getByRole("button", { name: "Preview" }).click();
  await expect(sourceSyncPanel).toContainText("Attachable");
  await expect(sourceSyncPanel).toContainText("Drifted");
  await expect(sourceSyncPanel).toContainText("New skills");
  await expect(sourceSyncPanel).toContainText("gstack-danger-demo");
  await expect(sourceSyncPanel).toContainText("Context: 1");
  await expect(sourceSyncPanel).toContainText("Selected");
  const reviewSyncRecord = sourceSyncPanel.locator(".settings-skill-source-sync-record").filter({ hasText: "Code Review" });
  await expect(reviewSyncRecord.locator(".settings-skill-source-sync-title")).not.toContainText("sha256:review-mock");
  await expect(reviewSyncRecord.locator(".settings-skill-source-sync-meta")).not.toContainText("Drift diff");
  const reviewEvidence = reviewSyncRecord.locator(".settings-skill-source-sync-details");
  await reviewEvidence.getByText("Source evidence").click();
  await expect(reviewEvidence).toContainText("Drift diff");
  await expect(reviewEvidence).toContainText("sha256:review-mock");
  await expect(reviewEvidence).toContainText("sha256:review-sync");
  const dangerSyncRecord = sourceSyncPanel.locator(".settings-skill-source-sync-record").filter({ hasText: "gstack-danger-demo" });
  const dangerEvidence = dangerSyncRecord.locator(".settings-skill-source-sync-details");
  await dangerEvidence.getByText("Source evidence").click();
  await expect(dangerEvidence).toContainText("Manual optimization review");
  await expect(sourceSyncPanel.getByLabel("Select implement")).toBeChecked();
  await expect(sourceSyncPanel.getByLabel("Select review")).toBeChecked();
  await expect(sourceSyncPanel.getByLabel("Select gstack-design-review")).toBeDisabled();
  await sourceSyncPanel.getByRole("button", { name: "Publish selected" }).click();
  await expect(panel).toContainText("Published 2 skill sources");
  await expect.poll(() => state.skillSourceSnapshots.some((item) => isRecord(item) && item.skillId === "implement" && item.reviewStatus === "published")).toBe(true);
  await page.getByRole("tab", { name: /Skills list/ }).click();
  const implementSkillRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Implementation" }).first();
  await expect(implementSkillRow).toBeVisible();

  await page.getByRole("tab", { name: /Review queue/ }).click();
  const healthDetails = panel.locator(".settings-skill-review-diagnostics").filter({ hasText: "Skill health diagnostics" });
  await expect(healthDetails).toBeVisible();
  await expect.poll(() => healthDetails.evaluate((element) => element.hasAttribute("open"))).toBe(false);
  await healthDetails.getByText("Skill health diagnostics").click();
  const healthLayout = await healthDetails.evaluate((element) => {
    const findings = element.querySelector(".settings-skill-health-findings");
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      overflow: style.overflow,
      findingsOverflowY: findings ? getComputedStyle(findings).overflowY : "",
    };
  });
  expect(healthLayout.height).toBeGreaterThanOrEqual(250);
  expect(healthLayout.height).toBeLessThanOrEqual(370);
  expect(healthLayout.overflow).toBe("hidden");
  expect(healthLayout.findingsOverflowY).toBe("auto");
  const healthPanel = healthDetails.getByRole("region", { name: "Skill Health" });
  await expect(healthPanel).toContainText("Duplicate clusters");
  await expect(healthPanel).toContainText("Duplicate skill cluster");
  await expect(healthPanel).toContainText("Conflicting skill triggers");
  await healthPanel.getByText("Finding details").first().click();
  await expect(healthPanel).toContainText("implement-duplicate");
  const reviewQueuePanel = panel.getByRole("region", { name: "Skill review queue" });
  const reviewQueueLayout = await reviewQueuePanel.evaluate((element) => {
    const list = element.querySelector(".settings-skill-review-queue-list");
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      overflow: style.overflow,
      listOverflowY: list ? getComputedStyle(list).overflowY : "",
    };
  });
  expect(reviewQueueLayout.height).toBeGreaterThanOrEqual(175);
  expect(reviewQueueLayout.height).toBeLessThanOrEqual(250);
  expect(reviewQueueLayout.overflow).toBe("hidden");
  expect(reviewQueueLayout.listOverflowY).toBe("auto");
  await expect(reviewQueuePanel.getByRole("tab", { name: /All/ })).toHaveAttribute("aria-selected", "true");
  await expect(reviewQueuePanel.getByRole("tab", { name: /Skill candidates/ })).toBeVisible();
  await expect(reviewQueuePanel.getByRole("tab", { name: /Candidate Clusters/ })).toBeVisible();
  await expect(reviewQueuePanel.getByRole("tab", { name: /Playbooks/ })).toBeVisible();
  await reviewQueuePanel.getByRole("tab", { name: /Skill candidates/ }).click();
  await expect(reviewQueuePanel.getByRole("tab", { name: /Skill candidates/ })).toHaveAttribute("aria-selected", "true");
  await expect(reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='skill_candidates']")).toHaveCount(1);
  await expect(reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='clusters']")).toHaveCount(0);
  await expect(reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='playbooks']")).toHaveCount(0);
  await reviewQueuePanel.getByRole("tab", { name: /All/ }).click();
  const candidateCard = reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='skill_candidates']").filter({ hasText: "Channel canvas protocol skill" });
  await expect(candidateCard).toContainText("Channel canvas protocol skill");
  await expect(candidateCard).toContainText("No overlap");
  await candidateCard.getByText("Candidate details").click();
  await expect(candidateCard).toContainText("Draft gates clear");
  await candidateCard.getByRole("button", { name: "Approve for draft" }).click();
  await expect(candidateCard).toContainText("Approved for draft");
  await candidateCard.getByRole("button", { name: "Create registry draft" }).click();
  await expect(panel.locator(".settings-skill-import-preview")).toContainText("Channel canvas protocol skill");
  await panel.locator(".settings-skill-import-preview").getByText("Import evidence").click();
  await expect(panel.locator(".settings-skill-import-preview")).toContainText("Weak routing description");
  await expect(panel).toContainText("Draft ready");
  await panel.getByRole("button", { name: "Publish to registry" }).click();
  await expect(panel).toContainText("Published 1 skills");
  await expect.poll(() => state.skillRegistryEntries.some((item) => isRecord(item) && item.id === "channel-canvas-protocol-skill")).toBe(true);
  await expect(panel.locator(".settings-skill-table")).toContainText("Channel canvas protocol skill");
  await page.getByRole("tab", { name: /Review queue/ }).click();
  await candidateCard.getByRole("button", { name: "Reject candidate" }).click();
  await expect(reviewQueuePanel).not.toContainText("Channel canvas protocol skill");

  const seededPlaybook = reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='playbooks']").filter({ hasText: "Deployment rollback playbook" });
  await expect(seededPlaybook).toContainText("Deployment rollback playbook");
  await seededPlaybook.getByText("Playbook details").click();
  await expect(seededPlaybook).toContainText("docs-only change");
  await seededPlaybook.getByRole("button", { name: "Reject playbook" }).click();
  await expect.poll(() => {
    const candidate = state.channelPlaybookCandidates.find((item) => isRecord(item) && item.id === "channel_playbook_candidate_rollback");
    return isRecord(candidate) ? candidate.status : "";
  }).toBe("cancelled");
  await expect(panel).toContainText("Playbook candidate rejected");

  const clusterPanel = reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='clusters']");
  const channelProtocolCluster = clusterPanel.filter({ hasText: "Channel canvas handoff protocol" });
  await expect(channelProtocolCluster).toContainText("Channel canvas handoff protocol");
  await expect(channelProtocolCluster).toContainText("Create channel protocol candidate");
  await channelProtocolCluster.getByRole("button", { name: "Create protocol candidate" }).click();
  await expect.poll(() => state.channelProtocolDrafts.length).toBe(1);
  await expect.poll(() => {
    const draft = state.channelProtocolDrafts[0];
    return isRecord(draft) && isRecord(draft.proposedPatch) && Array.isArray(draft.proposedPatch.reviewRules)
      ? draft.proposedPatch.reviewRules.join("\n")
      : "";
  }).toContain("Channel canvas handoff protocol");
  await expect(panel).toContainText("Protocol candidate created");
  const releasePlaybookCluster = clusterPanel.filter({ hasText: "Release verification playbook" });
  await expect(releasePlaybookCluster).toContainText("Release verification playbook");
  await expect(releasePlaybookCluster).toContainText("Create playbook candidate");
  await releasePlaybookCluster.getByRole("button", { name: "Create playbook candidate" }).click();
  await expect.poll(() => state.channelPlaybookCandidates.length).toBe(2);
  await expect.poll(() => {
    const candidate = state.channelPlaybookCandidates[0];
    return isRecord(candidate) && typeof candidate.title === "string" ? candidate.title : "";
  }).toContain("Release verification playbook");
  await expect(panel).toContainText("Playbook candidate created");
  const releasePlaybook = reviewQueuePanel.locator(".settings-skill-candidate-card[data-review-kind='playbooks']").filter({ hasText: "Release verification playbook" });
  await expect(releasePlaybook).toContainText("Release verification playbook");
  await releasePlaybook.getByRole("button", { name: "Approve playbook" }).click();
  await expect.poll(() => {
    const candidate = state.channelPlaybookCandidates.find((item) => isRecord(item) && typeof item.title === "string" && item.title.includes("Release verification playbook"));
    return isRecord(candidate) ? candidate.status : "";
  }).toBe("active");
  await expect(panel).toContainText("Playbook activated");
  const blockedSkillCluster = clusterPanel.filter({ hasText: "Generated skill missing gates" });
  await expect(blockedSkillCluster).toContainText("Generated skill missing gates");
  await expect(blockedSkillCluster).toContainText("Append evidence");
});

test("settings skill governance saves policy from a separate section", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Personalization/ }).click();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Personalization/ })).toHaveClass(/active/);
  const tonePanel = page.locator(".personalization-settings-panel");
  await expect(tonePanel.getByRole("heading", { name: "Ling conversation tone" })).toBeVisible();
  await expect(tonePanel).not.toContainText("Choose how Ling replies by default in this workspace.");
  await expect(tonePanel.getByRole("radio", { name: /Pragmatic/ })).toHaveAttribute("aria-checked", "true");
  await expect(tonePanel).toContainText("Built-in");
  await expect(tonePanel.getByRole("button", { name: "Save conversation tone" })).toHaveCount(0);
  await tonePanel.getByRole("radio", { name: /Friendly/ }).click();
  await expect.poll(() => state.workspaceSettings.lingConversationTone).toBe("friendly");
  await expect(tonePanel).toContainText("Ling conversation tone applied");
  await expect(tonePanel.locator(".settings-inline-tip")).toHaveCount(0, { timeout: 3000 });
  await expect(tonePanel).toContainText("Workspace");
  const panel = page.locator(".skill-governance-settings-panel");
  await expect.poll(async () => {
    const boxes = await Promise.all([
      tonePanel.boundingBox(),
      panel.boundingBox(),
    ]);
    return boxes[0] && boxes[1] ? boxes[0].y < boxes[1].y : false;
  }).toBe(true);
  const governancePanel = panel.getByRole("region", { name: "Skill policy" });
  await expect(panel.getByRole("heading", { name: "Skill policy" })).toBeVisible();
  await expect(panel).toContainText("Control skill recording, generation, and publication policy.");
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /External work/ }).click();
  const panel = page.locator(".external-work-settings-panel");
  await expect(panel).toContainText("External work");
  await expect(panel).toContainText("openclaw/openclaw");
  await expect(panel).toContainText("configured");
  await panel.getByText("Details").first().click();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
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

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
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
