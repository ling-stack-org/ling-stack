import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-permissions/",
  import.meta.url,
));

test("ordinary teammate shows a read-only capability ceiling and workspace default preview", async ({ page }) => {
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
    id: "teammate_permissions_standard",
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

  const permissions = await openPermissions(page, "Permission Systems Reviewer");
  await expect(permissions).toContainText("Teammate capability ceiling");
  await expect(permissions).toContainText("3 of 7 tools");
  await expect(permissions).toContainText("Standard approval");
  await expect(permissions).toContainText("High risk threshold");
  await expect(permissions).toContainText("Smart authorization");
  await expect(permissions).toContainText("Workspace write");
  await expect(permissions.getByRole("checkbox")).toHaveCount(0);
  await expect(permissions.getByRole("combobox")).toHaveCount(0);
  await expect(permissions.getByRole("button", { name: /save/iu })).toHaveCount(0);
  await expect(permissions.getByText("read, grep, bash", { exact: true })).toBeHidden();
  await captureEvidence(page, "1440x960-ling-light-read-only-ceiling.png");

  await permissions.getByText("Policy details", { exact: true }).click();
  await expect(permissions.getByText("read, grep, bash", { exact: true })).toBeVisible();
  await expect(permissions.getByText("Push Git changes", { exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-policy-requirements.png");

  await permissions.getByRole("button", { name: "Open authorization settings" }).click();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Default authorization" }))
    .toHaveAttribute("aria-current", "page");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("protected Ling Agent is visibly managed without claiming approval bypass", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "zh-CN" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "ask",
    defaultWorkspaceAccessMode: "read_only",
    defaultPermissionMode: "ask_everything",
    defaultPermissionPreset: "read_only",
  };
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

  const permissions = await openPermissions(page, "Ling Agent", chineseLabels);
  await expect(permissions.getByText("由 Ling Stack 管理", { exact: true })).toBeVisible();
  await expect(permissions.getByText("无额外队友审批", { exact: true })).toBeVisible();
  await expect(permissions).toContainText("工作区授权规则仍然生效");
  await expect(permissions).toContainText("主动询问");
  await expect(permissions).toContainText("只读");
  await expect(permissions).not.toContainText("无需审批");
  await expect(permissions.getByRole("checkbox")).toHaveCount(0);
  await expect(permissions.getByRole("combobox")).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-light-protected-managed.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("legacy empty ceiling and full-access preview remain truthful in compact reduced-motion layout", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "always",
    defaultWorkspaceAccessMode: "full_access",
    defaultPermissionMode: "full_access",
    defaultPermissionPreset: "full_access",
  };
  state.aiTeammates = [createMockTeammate({
    id: "teammate_permissions_legacy_empty",
    displayName: "Legacy Empty Capability Reviewer With A Long Name",
    allowedTools: [],
    approvalProfile: {
      mode: "strict",
      risk: "critical",
      requiredForActions: ["credential_change", "provider_change", "runtime_permission_request"],
    },
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const permissions = await openPermissions(page, "Legacy Empty Capability Reviewer With A Long Name", chineseLabels);
  await expect(permissions).toContainText("0 / 7 个工具");
  await expect(permissions).toContainText("此队友未声明工具能力上限");
  await expect(permissions).toContainText("严格审批");
  await expect(permissions).toContainText("严重风险阈值");
  await expect(permissions).toContainText("始终授权");
  await expect(permissions).toContainText("完全访问");
  await permissions.getByText("策略详情", { exact: true }).click();
  await expect(permissions).toContainText("修改凭据");
  await expect(permissions).toContainText("申请运行权限");
  await captureEvidence(page, "1280x800-ling-dark-strict-details-zh-CN.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("workspace deny remains authoritative across teammate approval requirements", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "en-US" });
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
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_permissions_deny",
      displayName: "Workspace Deny Reviewer",
      allowedTools: ["read", "bash", "edit"],
      approvalProfile: { mode: "standard", risk: "medium", requiredForTools: ["bash"] },
    }),
    createMockTeammate({
      id: "teammate_permissions_low",
      displayName: "Low Risk Reviewer",
      allowedTools: ["read"],
      approvalProfile: { mode: "standard", risk: "low" },
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  let permissions = await openPermissions(page, "Workspace Deny Reviewer");
  await expect(permissions).toContainText("Workspace policy blocks Run commands, Edit files");
  await expect(permissions).toContainText("Teammate settings cannot allow them");
  await permissions.getByText("Default tool decisions", { exact: true }).click();
  await expect(permissions.getByText("Denied by workspace", { exact: true })).toHaveCount(2);
  await captureEvidence(page, "1440x960-ling-dark-workspace-deny-preview.png");

  permissions = await openPermissions(page, "Low Risk Reviewer");
  await expect(permissions).toContainText("Low risk threshold");
  await expect(permissions).not.toContainText("Workspace Deny Reviewer");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("workspace policy failure stays local and retry loads the authoritative preview", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    locale: "en-US",
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_permissions_unavailable",
    displayName: "Unavailable Policy Reviewer",
    allowedTools: ["read", "write"],
    approvalProfile: { mode: "standard", risk: "medium" },
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Unavailable Policy Reviewer" })).toBeVisible();
  let policyAttempts = 0;
  await page.route("**/approval-policy**", async (route) => {
    policyAttempts += 1;
    if (policyAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: "workspace_policy_unavailable" } });
      return;
    }
    await route.fallback();
  });

  const permissions = await openPermissions(page, "Unavailable Policy Reviewer");
  await expect(permissions.getByText("Workspace policy could not be loaded.", { exact: true })).toBeVisible();
  await expect(permissions.getByText("Default tool decisions", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-policy-error-reduced-motion.png");
  await permissions.getByRole("button", { name: "Retry" }).click();
  await expect(permissions.getByText("Workspace policy could not be loaded.", { exact: true })).toHaveCount(0);
  await expect(permissions.getByText("Default tool decisions", { exact: true })).toBeVisible();
  expect(policyAttempts).toBeGreaterThanOrEqual(2);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

const chineseLabels = {
  details: "显示详情",
  dock: "私聊工作区面板",
  settings: "设置",
  settingsSections: "设置分组",
  permissions: "权限",
} as const;

async function openPermissions(
  page: Page,
  teammateName: string,
  labels: {
    readonly details: string;
    readonly dock: string;
    readonly settings: string;
    readonly settingsSections: string;
    readonly permissions: string;
  } = {
    details: "Show details",
    dock: "Private chat workspace dock",
    settings: "Settings",
    settingsSections: "Settings sections",
    permissions: "Permissions",
  },
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header]");
  await expect(chatHeader).toBeVisible();
  if (await page.getByLabel(labels.dock).count() === 0) {
    await chatHeader.getByRole("button", { name: labels.details }).click();
  }
  await page.getByLabel(labels.dock).getByRole("button", { name: labels.settings }).click();
  await page.getByLabel(labels.settingsSections).getByRole("button", { name: labels.permissions, exact: true }).click();
  const permissions = page.locator("[data-ui2-teammate-permissions]");
  await expect(permissions).toBeVisible();
  return permissions;
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
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
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
