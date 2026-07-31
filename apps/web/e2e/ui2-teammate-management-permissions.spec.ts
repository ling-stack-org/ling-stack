import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, isRecord } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-permissions/",
  import.meta.url,
));

test("ordinary teammate edits its own capabilities and confirmation level without a healthy-state Settings jump", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "smart",
    defaultWorkspaceAccessMode: "workspace_write",
    defaultPermissionMode: "workspace_write",
    defaultPermissionPreset: "workspace_collaboration",
  };
  state.aiTeammates = [createMockTeammate({
    id: "teammate_permissions_editable",
    displayName: "Permission Systems Reviewer",
    allowedTools: ["read", "grep", "bash"],
    approvalProfile: {
      mode: "standard",
      risk: "high",
      requiredForTools: ["bash"],
      requiredForActions: ["git_push"],
    },
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const settings = await openTeammateSettings(page, "Permission Systems Reviewer");
  await expect(settings.getByRole("button")).toHaveCount(5);
  await expect(settings.getByRole("button", { name: "Profile", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Model", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: /^Channels\b/u })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Skills", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Tools and permissions", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: /Memory|Danger zone|MCP/u })).toHaveCount(0);

  const permissions = await openToolsAndPermissions(page, settings);
  await expect(permissions.getByRole("heading", { name: "Available capabilities" })).toBeVisible();
  await expect(permissions.getByRole("heading", { name: "Default execution scope" })).toBeVisible();
  await expect(permissions.getByText("Smart authorization", { exact: true })).toHaveCount(0);
  await expect(permissions.getByText("Workspace write", { exact: true })).toBeVisible();
  await expect(permissions.getByRole("button", { name: "Go to resolve" })).toHaveCount(0);
  await expect(permissions.getByRole("switch")).toHaveCount(7);

  const editCapability = permissions.getByRole("switch", { name: "Use capability for teammate: Edit files" });
  await expect(editCapability).not.toBeChecked();
  await editCapability.click();
  await permissions.getByRole("combobox", { name: "High-risk action confirmation" }).selectOption("strict");

  const header = page.getByLabel("Single agent settings");
  await expect(header.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await header.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Teammate permissions saved", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_permissions_editable");
    return isRecord(teammate) && isRecord(teammate.approvalProfile)
      ? { allowedTools: teammate.allowedTools, mode: teammate.approvalProfile.mode }
      : undefined;
  }).toEqual({ allowedTools: ["read", "grep", "bash", "edit"], mode: "strict" });

  await expect(permissions.getByText("Technical information", { exact: true })).toHaveCount(0);
  await expect(permissions.getByText("read, grep, bash, edit", { exact: true })).toHaveCount(0);
  await expect(permissions.getByText("Push Git changes", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-editable-tools-permissions.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("workspace deny remains authoritative and is the only state that exposes a repair route", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.approvalPolicy = {
    ...state.approvalPolicy,
    toolDecisions: {
      ...state.approvalPolicy.toolDecisions,
      bash: "deny",
      edit: "deny",
    },
  };
  state.aiTeammates = [createMockTeammate({
    id: "teammate_permissions_denied",
    displayName: "工作区限制审查员",
    allowedTools: ["read", "bash", "edit"],
    approvalProfile: { mode: "standard", risk: "medium" },
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const settings = await openTeammateSettings(page, "工作区限制审查员", chineseLabels);
  const permissions = await openToolsAndPermissions(page, settings, chineseLabels);
  await expect(permissions.getByText("工作区限制已生效", { exact: true })).toBeVisible();
  await expect(permissions).toContainText("工作区已限制：执行命令, 编辑文件");
  await expect(permissions.getByText("受工作区限制", { exact: true })).toHaveCount(2);
  await expect(permissions.getByRole("button", { name: "去处理" })).toBeVisible();
  await expect(permissions.getByText("技术信息", { exact: true })).toHaveCount(0);
  await expect(permissions.getByText("被工作区拒绝", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-workspace-deny-zh-CN.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("permission save failure stays local and preserves the current draft", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_permissions_failure",
    displayName: "Permission Failure Reviewer",
    allowedTools: ["read", "grep"],
    approvalProfile: { mode: "standard", risk: "medium" },
  })];
  await mockDaemon(page, state, { failTeammateProfileUpdates: true });
  await page.goto("/");

  const settings = await openTeammateSettings(page, "Permission Failure Reviewer");
  const permissions = await openToolsAndPermissions(page, settings);
  const commandCapability = permissions.getByRole("switch", { name: "Use capability for teammate: Run commands" });
  await commandCapability.click();
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" }).click();
  await expect(permissions.getByText("Permission changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(commandCapability).toBeChecked();
  const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_permissions_failure");
  expect(isRecord(teammate) ? teammate.allowedTools : undefined).toEqual(["read", "grep"]);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("protected Ling Agent hides teammate-owned skills and tools controls", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "ling_agent",
    kind: "system_teammate",
    systemRole: "ling_agent",
    protectedProfile: true,
    displayName: "Ling Agent",
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    approvalProfile: { mode: "none" },
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const settings = await openTeammateSettings(page, "Ling Agent", chineseLabels);
  await expect(settings.getByRole("button")).toHaveCount(3);
  await expect(settings.getByRole("button", { name: "资料", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "模型", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: /^频道/u })).toBeVisible();
  await expect(settings.getByRole("button", { name: "技能", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "工具与权限", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-ui2-teammate-permissions]" )).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

const englishLabels = {
  details: "Show details",
  dock: "Private chat workspace dock",
  settings: "Settings",
  settingsSections: "Settings sections",
  toolsAndPermissions: "Tools and permissions",
} as const;

const chineseLabels = {
  details: "显示详情",
  dock: "私聊工作区面板",
  settings: "设置",
  settingsSections: "设置分组",
  toolsAndPermissions: "工具与权限",
} as const;

type PermissionLabels = typeof englishLabels | typeof chineseLabels;

async function openTeammateSettings(
  page: Page,
  teammateName: string,
  labels: PermissionLabels = englishLabels,
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header]");
  await expect(chatHeader).toBeVisible();
  if (await page.getByLabel(labels.dock).count() === 0) {
    await chatHeader.getByRole("button", { name: labels.details }).click();
  }
  await page.getByLabel(labels.dock).getByRole("button", { name: labels.settings }).click();
  const settings = page.getByLabel(labels.settingsSections);
  await expect(settings).toBeVisible();
  return settings;
}

async function openToolsAndPermissions(
  page: Page,
  settings: Locator,
  labels: PermissionLabels = englishLabels,
): Promise<Locator> {
  await settings.getByRole("button", { name: labels.toolsAndPermissions, exact: true }).click();
  const panel = page.locator("[data-ui2-teammate-permissions]");
  await expect(panel).toBeVisible();
  return panel;
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
