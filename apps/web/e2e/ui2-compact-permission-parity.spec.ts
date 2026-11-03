import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, isRecord } from "./support/mock-state";
import { openEngineeringChannel, openTaskFromAttentionQueue } from "./support/test-helpers";

for (const [surface, finalMode] of [
  ["normal", "smart"], ["normal", "always"],
  ["channel", "smart"], ["channel", "always"],
  ["private", "smart"], ["private", "always"],
] as const) {
  test(`${surface} has one compact permission control and sends ${finalMode} with its sandbox`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "approved" });
    state.providers = [createChatProvider({ id: "provider_compact_permissions", model: "gpt-5.5",
      lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-10-28T00:00:00.000Z" } })];
    state.workspaceSettings = { ...state.workspaceSettings, defaultProviderPresetId: "provider_compact_permissions",
      defaultAuthorizationMode: "ask", defaultWorkspaceAccessMode: "read_only" };
    state.aiTeammates = [createMockTeammate({ id: "compact_permissions_teammate", displayName: "Compact Permissions Teammate",
      providerPresetId: "provider_compact_permissions" })];
    state.channels = state.channels.map((channel) => isRecord(channel)
      ? { ...channel, defaultProviderPresetId: "provider_compact_permissions" } : channel);
    state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
      ? { ...task, status: "todo", currentRunId: undefined } : task);
    state.runs = [];
    await mockDaemon(page, state);
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
    if (surface === "normal") await sidebar.getByRole("button", { name: "New conversation", exact: true }).click();
    else if (surface === "channel") await openEngineeringChannel(page);
    else await sidebar.getByRole("button", { name: "Compact Permissions Teammate", exact: true }).click();
    const composer = page.getByLabel(surface === "normal" ? "New conversation composer"
      : surface === "channel" ? "Channel composer" : "Private chat composer", { exact: true });
    await expect(composer).toBeVisible();
    await expect(composer.locator(".conversation-permission-trigger")).toHaveCount(1);
    await expect(composer.getByRole("button", { name: /Selected authorization mode/ })).toHaveCount(0);
    const trigger = composer.getByRole("button", { name: /Selected permission preset/ });
    await trigger.click();
    await expect(page.getByRole("menuitemradio", { name: "Request approval", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Help me approve", exact: true })).toBeVisible();
    const fullAccessOption = page.getByRole("menuitemradio", { name: "Full access permissions", exact: true });
    await expect(fullAccessOption).toBeVisible();
    await expect(fullAccessOption).toHaveAttribute("aria-description", "After confirmation, this conversation uses automatic approvals and Full Access. System permissions and Host deny rules still apply.");
    await expect(page.getByRole("menuitemradio", { name: /Read.only|Workspace write|Workspace collaboration/i })).toHaveCount(0);
    await fullAccessOption.click();
    const dialog = page.getByRole("dialog", { name: "Confirm full access" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Confirmation enables automatic approvals and Full Access for this conversation, including access outside the workspace. System permissions and Host deny rules still apply.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).last().click();
    await expect(trigger).toHaveText("Request approval");
    await trigger.click();
    await fullAccessOption.click();
    await dialog.getByRole("button", { name: "Start with full access", exact: true }).click();
    await expect(trigger).toHaveText("Full access");
    await expect(trigger).toHaveAccessibleName(/Confirmed for this conversation/);
    if (finalMode === "smart") {
      await trigger.click();
      await page.getByRole("menuitemradio", { name: "Help me approve", exact: true }).click();
      await expect(trigger).toHaveText("Help me approve");
      await expect(trigger).toHaveAttribute("title", /Read.only/i);
    }
    await expect(composer.locator(".conversation-permission-trigger")).toHaveCount(1);
    // Inspect the real adapter payload, not only the menu label. All HTTP/SSE
    // replies here are mocked; this is not packaged-client or model acceptance.
    const expectedPermissions = { authorizationMode: finalMode,
      workspaceAccessMode: finalMode === "always" ? "full_access" : "read_only",
      ...(finalMode === "always" ? { permissionConfirmation: { confirmed: true, mode: "full_access", reason: "user_confirmed_full_access" } } : {}) };
    if (surface === "channel") {
      await openTaskFromAttentionQueue(page, "Inspect workspace");
      await page.getByRole("article", { name: "Task detail", exact: true }).getByRole("button", { name: "Run", exact: true }).click();
      await expect.poll(() => state.runs[0]?.requestSnapshot).toMatchObject(expectedPermissions);
    } else {
      const request = page.waitForRequest((request) => request.method() === "POST"
        && new URL(request.url()).pathname.endsWith(surface === "normal" ? "/conversations/stream" : "/direct-messages/stream"));
      await composer.getByRole("textbox").fill(`Inspect ${surface} permission scope`);
      await composer.getByRole("button", { name: "Send", exact: true }).click();
      expect((await request).postDataJSON()).toMatchObject(expectedPermissions);
    }
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
test(`Chinese full access (${viewport}) uses a long menu label, a short trigger and explicit permission consequences`, async ({ page }, testInfo) => {
  if (viewport === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  await mockDaemon(page, createBaseState({ approvalStatus: "approved" }));
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: "新建对话", exact: true }).click();
  const trigger = page.getByLabel("新建对话输入框", { exact: true }).locator(".conversation-permission-trigger");
  await trigger.click();
  const option = page.getByRole("menuitemradio", { name: "完全访问权限", exact: true });
  await expect(option).toHaveAttribute("aria-description", "确认后，本会话同时启用自动审批和完全访问。系统权限和 Host 拒绝规则仍然有效。");
  await page.screenshot({ path: testInfo.outputPath("full-access-menu.png"), animations: "disabled" });
  await option.click();
  const dialog = page.getByRole("dialog", { name: "确认完全访问" });
  await expect(dialog.getByText("确认后，本会话同时启用自动审批和完全访问，可访问工作区外文件。系统权限和 Host 拒绝规则仍然有效。", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("full-access-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "以完全访问启动", exact: true }).click();
  await expect(trigger).toHaveText("完全访问");
  await expect(trigger).toHaveAccessibleName(/本对话已确认/);
});
}

test("the task inspector links to Settings and all three composers inherit the saved sandbox", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "settings_scope_teammate", displayName: "Settings Scope Teammate" })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openTaskFromAttentionQueue(page, "Inspect workspace");
  const task = page.getByRole("article", { name: "Task detail", exact: true });
  await task.getByText("Permissions", { exact: true }).click();
  await expect(task.getByRole("radio")).toHaveCount(0);
  await task.getByRole("button", { name: "Sandbox settings", exact: true }).click();
  const sandbox = page.locator("[data-ui2-default-authorization]").getByRole("radiogroup", { name: "Sandbox settings" });
  await sandbox.getByRole("radio", { name: "Read only", exact: true }).click();
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("read_only");
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByLabel("Channel composer", { exact: true }).getByRole("button", { name: /Selected permission preset/ }))
    .toHaveAttribute("title", /Read.only/i);
  const sidebar = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await sidebar.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.getByLabel("New conversation composer", { exact: true }).getByRole("button", { name: /Selected permission preset/ }))
    .toHaveAttribute("title", /Read.only/i);
  await sidebar.getByRole("button", { name: "Settings Scope Teammate", exact: true }).click();
  await expect(page.getByLabel("Private chat composer", { exact: true }).getByRole("button", { name: /Selected permission preset/ }))
    .toHaveAttribute("title", /Read.only/i);
});
