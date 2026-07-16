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

async function archivedListMetrics(page: Page): Promise<{
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly overflowY: string;
}> {
  return await page.locator(".archived-item-list").evaluate((element) => ({
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
  await expect(page.getByLabel("频道管理")).toContainText("运行模型");
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

test("settings default authorization hides internal tool policy and runner controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Default authorization/ }).click();
  const authorizationPanel = page.locator(".settings-global-approval-card");
  await expect(authorizationPanel).toBeVisible();
  await expect(authorizationPanel.getByText("Default authorization", { exact: true })).toBeVisible();
  await expect(authorizationPanel.getByText("Sandbox settings", { exact: true })).toBeVisible();
  await expect(authorizationPanel.locator(".rich-choice-select-trigger")).toHaveCount(2);
  await authorizationPanel.getByRole("button", { name: "Authorization mode: Smart authorization" }).click();
  await expect(authorizationPanel.getByRole("option", { name: /Ask first/ })).toBeVisible();
  await expect(authorizationPanel.getByRole("option", { name: /Smart authorization/ })).toBeVisible();
  await expect(authorizationPanel.getByRole("option", { name: /Always authorize/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await authorizationPanel.getByRole("button", { name: "Sandbox settings: Workspace write" }).click();
  await expect(authorizationPanel.getByRole("option", { name: /Read only/ })).toBeVisible();
  await expect(authorizationPanel.getByRole("option", { name: /Workspace write/ })).toBeVisible();
  await expect(authorizationPanel.getByRole("option", { name: /Full access/ })).toBeVisible();
  await expect(page.locator(".runtime-runner-settings-panel")).toHaveCount(0);
  await expect(page.getByText("Pi Runner", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Codex App Server", { exact: true })).toHaveCount(0);
  await expect(page.getByText("OpenClaw ACP", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Tool permission policy", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Advanced workspace policy", { exact: true })).toHaveCount(0);
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

test("settings archived items use one remembered category list with scoped search", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = Array.from({ length: 12 }, (_, index) => createArchivedConversation(index));
  state.aiTeammates = Array.from({ length: 6 }, (_, index) =>
    createMockTeammate({
      id: `teammate_archived_visual_${index}`,
      displayName: `Archived teammate ${index + 1}`,
      hidden: true,
      status: "active",
      updatedAt: archivedTimestamp(index),
    })
  );
  state.channels.push(...Array.from({ length: 12 }, (_, index) => createArchivedChannel(index)));
  state.channelBranches = Array.from({ length: 12 }, (_, index) => createArchivedBranch(index));
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  const panel = page.locator(".archived-items-settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".archived-items-rules-footer")).toHaveCount(0);
  await expect(panel.locator(".archived-items-rule-note")).toHaveCount(0);
  await expect(panel.locator(".archived-items-hint")).toHaveCount(0);
  await expect(panel.getByText("Restore and delete rules")).toHaveCount(0);
  await expect(panel.getByRole("tab")).toHaveCount(4);
  await expect(panel.locator(".settings-subnav-item small")).toHaveText(["12", "6", "12", "12"]);
  await expect(panel.getByRole("tab", { name: /Conversations 12/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("tabpanel", { name: "Conversations" })).toBeVisible();
  await expect(panel.locator(".archived-item-list")).toHaveCount(1);
  await expect(panel.locator(".archived-item-main small")).toHaveCount(0);
  await expect(panel.locator(".archived-item-main svg")).toHaveCount(0);
  await expect(panel.getByText("Parent channel archived")).toHaveCount(0);
  await expect(panel.getByText("Parent channel active")).toHaveCount(0);

  const rowLayout = await panel.locator(".archived-item-row").evaluateAll((rows) =>
    rows.map((row) => {
      const title = row.querySelector(".archived-item-main strong");
      const time = row.querySelector(".archived-item-time");
      const rowRect = row.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      const timeRect = time?.getBoundingClientRect();
      return {
        height: rowRect.height,
        centerDelta: titleRect && timeRect
          ? Math.abs((titleRect.top + titleRect.height / 2) - (timeRect.top + timeRect.height / 2))
          : 99,
      };
    })
  );
  expect(Math.max(...rowLayout.map(({ height }) => height))).toBeLessThanOrEqual(56);
  expect(Math.max(...rowLayout.map(({ centerDelta }) => centerDelta))).toBeLessThanOrEqual(2);

  await expect(panel.getByRole("button", { name: "Delete conversation" })).toHaveCount(12);
  await expect(panel.getByRole("button", { name: "Delete AI teammate" })).toHaveCount(0);

  const conversationMetrics = await archivedListMetrics(page);
  expect(conversationMetrics.overflowY).toBe("auto");
  expect(conversationMetrics.scrollHeight).toBeGreaterThan(conversationMetrics.clientHeight + 2);

  const searchInput = panel.getByRole("searchbox", { name: "Search archived items" });
  await expect(searchInput).toBeVisible();
  await searchInput.fill("does not exist");
  await expect(panel.locator(".archived-item-row")).toHaveCount(0);
  await expect(panel.getByText("No matching archived items")).toBeVisible();
  await searchInput.fill("conversation 12");
  await expect(panel.locator(".archived-item-row")).toHaveCount(1);
  await expect(panel.getByText("Archived conversation 12", { exact: true })).toBeVisible();
  await searchInput.press("Escape");
  await expect(searchInput).toHaveValue("");
  await expect(searchInput).toBeVisible();
  await expect(panel.locator(".archived-item-row")).toHaveCount(12);

  await searchInput.fill("conversation 1");
  await panel.getByRole("tab", { name: /AI Teammates 6/ }).click();
  await expect(panel.getByRole("tabpanel", { name: "AI Teammates" })).toBeVisible();
  await expect(searchInput).toHaveValue("");
  await expect(searchInput).toBeVisible();
  await expect(panel.getByRole("button", { name: "Search archived items" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Delete AI teammate" })).toHaveCount(6);
  await expect(panel.getByRole("button", { name: "Delete conversation" })).toHaveCount(0);

  for (const category of [
    { name: /Channels 12/, panel: "Channels" },
    { name: /Branches 12/, panel: "Branches" },
    { name: /Conversations 12/, panel: "Conversations" },
  ]) {
    await panel.getByRole("tab", { name: category.name }).click();
    await expect(panel.getByRole("tabpanel", { name: category.panel })).toBeVisible();
    const metrics = await archivedListMetrics(page);
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 2);
  }

  const labeledActionAlignment = await panel.locator(".archived-item-actions .compact-button:not(.compact-icon-button)").evaluateAll((buttons) =>
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
  expect(Math.max(...labeledActionAlignment)).toBeLessThanOrEqual(2);
  const iconActionAlignment = await panel.locator(".archived-delete-action").evaluateAll((buttons) =>
    buttons.slice(0, 10).map((button) => {
      const icon = button.querySelector("svg");
      const buttonRect = button.getBoundingClientRect();
      const iconRect = icon?.getBoundingClientRect();
      if (!iconRect) {
        return 99;
      }
      return Math.max(
        Math.abs((buttonRect.left + buttonRect.width / 2) - (iconRect.left + iconRect.width / 2)),
        Math.abs((buttonRect.top + buttonRect.height / 2) - (iconRect.top + iconRect.height / 2)),
      );
    })
  );
  expect(Math.max(...iconActionAlignment)).toBeLessThanOrEqual(2);

  const conversationRow = panel.locator(".archived-item-row").filter({ hasText: "Archived conversation 12" });
  let cancelledDialogMessage = "";
  page.once("dialog", async (dialog) => {
    cancelledDialogMessage = dialog.message();
    await dialog.dismiss();
  });
  await conversationRow.getByRole("button", { name: "Delete conversation" }).click();
  expect(cancelledDialogMessage).toContain("This permanently deletes messages, attachments, goals, and plans.");
  await expect(conversationRow).toBeVisible();

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await conversationRow.getByRole("button", { name: "Delete conversation" }).click();
  await expect(panel.getByText("Archived conversation 12", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: /Conversations 11/ })).toBeVisible();

  await panel.getByRole("tab", { name: /AI Teammates 6/ }).click();
  const teammateRow = panel.locator(".archived-item-row").filter({ hasText: "Archived teammate 6" });
  let teammateDialogMessage = "";
  page.once("dialog", async (dialog) => {
    teammateDialogMessage = dialog.message();
    await dialog.accept();
  });
  await teammateRow.getByRole("button", { name: "Delete AI teammate" }).click();
  expect(teammateDialogMessage).toContain("This permanently deletes private chat, attachments, avatar, memory, and private bindings.");
  await expect(panel.getByText("Archived teammate 6", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: /AI Teammates 5/ })).toBeVisible();
  await expect.poll(() => readHorizontalOverflow(page, ".archived-items-settings-panel")).toEqual([]);

  await panel.getByRole("tab", { name: /Branches 12/ }).click();
  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  await expect(panel.getByRole("tab", { name: /Branches 12/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("tabpanel", { name: "Branches" })).toBeVisible();
  await expect(panel.locator(".archived-item-list")).toHaveCount(1);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => readHorizontalOverflow(page, ".archived-items-settings-panel")).toEqual([]);
  const metrics = await archivedListMetrics(page);
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 2);
});

test("settings archived conversation delete keeps loading and product error feedback local", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const conversation = createArchivedConversation(0);
  state.threads = [conversation];
  state.aiTeammates = [];
  state.threadHardDeleteDelayMs = 350;
  state.failThreadHardDeleteForThreadIds = [conversation.id];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  const panel = page.locator(".archived-items-settings-panel");
  const row = panel.locator(".archived-item-row").filter({ hasText: conversation.title });
  const deleteButton = row.getByRole("button", { name: "Delete conversation" });
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await deleteButton.click();

  await expect(deleteButton).toBeDisabled();
  await expect(deleteButton.locator(".spin")).toBeVisible();
  await expect(panel.getByText("This conversation is still used by an automation. Update the automation before deleting it.")).toBeVisible();
  await expect(deleteButton).toBeEnabled();
  await expect(row).toBeVisible();
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
  await expect(settingsSections.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(settingsSections.getByRole("button", { name: "Plugin Manager" })).toHaveCount(0);
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
  await expect(page.locator(".settings-global-approval-card")).toContainText("Default authorization");
  await expect(page.getByRole("heading", { name: "Tool permission policy" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Execution runners" })).toHaveCount(0);
  await expect(page.getByText("Advanced workspace policy", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Effective permissions")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Default authorization|Tool permission policy|Execution runners/ })).toHaveCount(0);
  await expect(page.locator(".settings-global-approval-card").locator(".rich-choice-select-trigger")).toHaveCount(2);
  await page.locator(".settings-global-approval-card").getByRole("button", { name: "Authorization mode: Smart authorization" }).click();
  await page.locator(".settings-global-approval-card").getByRole("option", { name: /Ask first/ }).click();
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("ask");
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("workspace_write");
});

test("settings default authorization persists each supported mode without exposing advanced controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Default authorization/ }).click();
  const authorizationPanel = page.locator(".settings-global-approval-card");

  await authorizationPanel.getByRole("button", { name: "Authorization mode: Smart authorization" }).click();
  await authorizationPanel.getByRole("option", { name: /Ask first/ }).click();
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("ask");
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("workspace_write");
  await expect.poll(() => state.workspaceSettings.defaultPermissionMode).toBe("custom");
  await expect.poll(() => state.workspaceSettings.defaultPermissionPreset).toBe("custom");

  await authorizationPanel.getByRole("button", { name: "Sandbox settings: Workspace write" }).click();
  await authorizationPanel.getByRole("option", { name: /Read only/ }).click();
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("ask");
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("read_only");
  await expect.poll(() => state.workspaceSettings.defaultPermissionMode).toBe("ask_everything");
  await expect.poll(() => state.workspaceSettings.defaultPermissionPreset).toBe("read_only");

  await authorizationPanel.getByRole("button", { name: "Authorization mode: Ask first" }).click();
  await authorizationPanel.getByRole("option", { name: /Always authorize/ }).click();
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("always");
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("read_only");
  await expect.poll(() => state.workspaceSettings.defaultPermissionMode).toBe("custom");

  await authorizationPanel.getByRole("button", { name: "Sandbox settings: Read only" }).click();
  await authorizationPanel.getByRole("option", { name: /Full access/ }).click();
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("always");
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("full_access");
  await expect.poll(() => state.workspaceSettings.defaultPermissionMode).toBe("full_access");
  await expect.poll(() => state.workspaceSettings.defaultPermissionPreset).toBe("full_access");

  await expect(page.getByText("Tool permission policy", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Advanced workspace policy", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Execution runners", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Default runner", { exact: true })).toHaveCount(0);
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => readHorizontalOverflow(page, ".settings-default-authorization-section")).toEqual([]);
  }
});

test("shared select controls preserve native sizing and rich choice keyboard flow", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Default authorization/ }).click();
  const authorizationPanel = page.locator(".settings-global-approval-card");
  const authorizationTrigger = authorizationPanel.getByRole("button", { name: /Authorization mode:/ });
  await authorizationTrigger.focus();
  await page.keyboard.press("ArrowDown");
  const authorizationListbox = authorizationPanel.getByRole("listbox", { name: "Authorization mode" });
  await expect(authorizationListbox).toBeVisible();
  await expect(authorizationListbox.getByRole("option", { name: /Smart authorization/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(authorizationListbox.getByRole("option", { name: /Always authorize/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("always");
  await expect(authorizationTrigger).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(authorizationListbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(authorizationListbox).toHaveCount(0);
  await expect(authorizationTrigger).toBeFocused();

  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  const fieldSelect = page.getByLabel("AI response language");
  await expect(fieldSelect).toHaveClass(/select-control-native/);
  const fieldShell = fieldSelect.locator("xpath=..");
  await expect(fieldShell).toHaveAttribute("data-select-control", "field");
  await fieldSelect.focus();
  await expect(fieldSelect).toBeFocused();
  await fieldSelect.selectOption("zh-CN");
  await expect(fieldSelect).toHaveValue("zh-CN");
  const fieldHeight = await fieldSelect.evaluate((element) => element.getBoundingClientRect().height);
  expect(fieldHeight).toBeGreaterThanOrEqual(35);
  expect(fieldHeight).toBeLessThanOrEqual(37);

  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openChannelChatTools(page);
  const compactSelect = page.locator('select[aria-label="Saved views"]');
  await expect(compactSelect).toHaveClass(/select-control-native/);
  await expect(compactSelect.locator("xpath=..")).toHaveAttribute("data-select-control", "compact");
  const compactHeight = await compactSelect.evaluate((element) => element.getBoundingClientRect().height);
  expect(compactHeight).toBeGreaterThanOrEqual(31);
  expect(compactHeight).toBeLessThanOrEqual(33);
});

test("settings skill library keeps ownership management focused", async ({ page }) => {
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
  await expect(panel).toHaveAttribute("aria-label", "Skill library");
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Skill library/ })).toHaveClass(/active/);
  await expect(page.getByRole("tab", { name: /My skills/ })).toHaveAttribute("aria-selected", "true");
  const skillLibraryLayout = await panel.evaluate((element) => {
    const content = element.closest(".settings-content-stack");
    const body = element.querySelector(".settings-skill-library-body");
    const tableWrap = element.querySelector(".settings-skill-table-wrap");
    const drawer = element.querySelector(".settings-skill-detail-drawer");
    return {
      contentExpanded: content?.classList.contains("settings-content-stack--skill-library") ?? false,
      panelWidth: element.getBoundingClientRect().width,
      bodyHeight: body?.getBoundingClientRect().height ?? 0,
      tableWidth: tableWrap?.getBoundingClientRect().width ?? 0,
      drawerWidth: drawer?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(skillLibraryLayout.contentExpanded).toBe(true);
  expect(skillLibraryLayout.panelWidth).toBeGreaterThan(1050);
  expect(skillLibraryLayout.bodyHeight).toBeGreaterThan(40);
  expect(skillLibraryLayout.bodyHeight).toBeLessThanOrEqual(220);
  expect(skillLibraryLayout.tableWidth).toBeGreaterThanOrEqual(1000);
  expect(skillLibraryLayout.drawerWidth).toBe(0);
  await expect.poll(() => readHorizontalOverflow(page, ".settings-skill-library-body, .settings-skill-table-wrap, .settings-skill-detail-drawer")).toEqual([]);
  await expect(panel.getByRole("region", { name: "Skill Health" })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Skill Source Health" })).toHaveCount(0);
  await page.getByRole("tab", { name: /Built-in skills/ }).click();
  const reviewSkillRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" }).first();
  await expect(reviewSkillRow).not.toContainText("Source-backed");
  const inspector = panel.locator(".settings-skill-detail-drawer");
  await expect(inspector).toHaveCount(0);
  await reviewSkillRow.click();
  await expect(inspector.locator(".settings-skill-summary-card")).toBeVisible();
  await expect(inspector).toContainText("Source-backed");
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
  await expect(panel.getByRole("button", { name: "Archive source snapshot" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Rollback" })).toHaveCount(0);

  await expect(panel.getByRole("tab")).toHaveCount(3);
  await expect(panel.getByRole("tab", { name: /Review queue/ })).toHaveCount(0);
  await panel.getByRole("tab", { name: /AI evolution/ }).click();
  await expect(panel.getByRole("region", { name: "AI evolution" })).toBeVisible();
  await expect(panel).toContainText("Deployment rollback playbook");
  await expect(panel.getByRole("tab", { name: /Official skill updates/ })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-review-diagnostics")).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Skill Health" })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Official skill updates" })).toHaveCount(0);
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
