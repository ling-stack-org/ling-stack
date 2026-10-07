import { expect, type Page, test, type TestInfo } from "@playwright/test";
import { createMockBundledEmbeddedCuaPlugin, mockDaemon } from "./support/mock-daemon";
import { openWorkBoardFromInbox } from "./support/open-work-board";
import { openPendingStartupDiagnostics } from "./support/pending-settings-sections";
import {
  createBaseState,
  createChatProvider,
  createMediaProvider,
  createMockTeammate,
  cwd,
  type MockState,
} from "./support/mock-state";

test("theme bootstrap prefers last effective workspace theme over legacy system key", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.themePreference", "system");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "light");
  });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-selection", "fixed");
  await expect(page.locator("html")).toHaveAttribute("data-ui-presentation", "ling-standard");
});

test("main pages and workspace tools follow dark theme tokens", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createDarkThemeState();
  await mockDaemon(page, state);
  await mockAutomationReadRoutes(page);
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await assertDarkAliasConvergence(page);
  await assertAliasesTrackRuntimeThemeTokens(page);
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Engineering" }).click();
  await expect(page.locator(".client-window")).toBeVisible();
  await assertDarkPage(page, "channel workspace", [
    ".workspace-client-surface",
    ".client-window",
    ".task-list-panel",
    '[data-conversation-composer="true"][data-surface="channel"]',
  ]);
  await captureDarkEvidence(page, testInfo, "01-channel-workspace");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await expect(navigation.getByRole("button", { name: "收件箱" })).toHaveCount(0);

  await navigation.getByRole("button", { name: "媒体生产" }).click();
  await expect(page.locator(".media-production-page")).toBeVisible();
  await assertDarkPage(page, "media production studio", [
    ".workspace-generation-surface",
    ".media-production-page",
    ".media-production-canvas-toolbar",
    ".media-production-studio",
    ".media-production-empty-state",
  ]);
  await captureDarkEvidence(page, testInfo, "02-media-production");

  await page.getByRole("radio", { name: /生成任务|Generation tasks/ }).click();
  await expect(page.locator("[data-media-jobs-surface]")).toBeVisible();
  await assertDarkPage(page, "media generation tasks", [
    ".workspace-generation-surface",
    "[data-media-jobs-surface]",
    "[data-media-jobs-header]",
    ".media-jobs-list-pane",
    ".media-job-list",
    ".media-job-inspector",
  ]);
  await captureDarkEvidence(page, testInfo, "02b-media-generation-tasks");

  await navigation.getByRole("button", { name: "插件管理" }).click();
  await expect(page.locator(".plugin-manager-page .settings-plugin-manager")).toBeVisible();
  await assertDarkPage(page, "plugin manager", [
    ".workspace-plugins-surface",
    ".plugin-manager-page",
    ".settings-plugin-manager",
    ".plugin-table",
    ".plugin-table-header",
  ]);
  await captureDarkEvidence(page, testInfo, "03-plugin-manager");
  await page.locator('.plugin-table-row[data-plugin-id="trusted-local:cua-driver"]').getByRole("button", { name: "安装引导" }).click();
  await assertDarkPage(page, "Cua Driver installation guide", [
    ".cua-install-panel",
    ".cua-install-command",
  ]);
  await captureDarkEvidence(page, testInfo, "04-computer-control-install-guide");
  await page.getByRole("dialog", { name: "安装 Cua Driver" }).getByRole("button", { name: "关闭" }).click();

  await navigation.getByRole("button", { name: "自动化" }).click();
  await expect(page.locator(".automations-inbox-page")).toBeVisible();
  await assertDarkPage(page, "automations", [
    ".workspace-automations-surface",
    ".automations-inbox-page",
    ".automations-inbox-header",
    ".automation-current-pane",
    ".automation-execution-inspector",
  ]);
  await captureDarkEvidence(page, testInfo, "05-automations");

  await navigation.getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("设置分组")).toBeVisible();
  await assertDarkPage(page, "settings shell", [
    ".settings-layout",
    ".settings-section-nav",
    ".settings-content-stack",
  ]);
  await captureDarkEvidence(page, testInfo, "06-settings-shell");

  await page.getByLabel("设置分组").getByRole("button", { name: /界面偏好|Interface preferences/ }).click();
  await expect(page.locator("[data-ui2-interface-preferences]")).toBeVisible();
  await assertDarkPage(page, "interface preferences", [
    ".settings-layout",
    "[data-ui2-interface-preferences]",
    "[data-ui2-interface-theme]",
    ".settings-interface-preference-row",
    ".settings-interface-language",
  ]);
  await captureDarkEvidence(page, testInfo, "06b-settings-interface-preferences");

  await page.getByRole("button", { name: /创建主题|Create theme/ }).click();
  await expect(page.locator("[data-ui2-theme-studio]")).toBeVisible();
  await assertDarkPage(page, "quick theme studio", [
    ".settings-layout",
    "[data-ui2-theme-studio]",
    ".settings-theme-studio-input",
    ".settings-theme-studio-preview",
  ]);
  await captureDarkEvidence(page, testInfo, "06c-settings-quick-theme-studio");
  await page.getByRole("button", { name: /返回主题列表|Back to themes/ }).click();

  await page.getByLabel("设置分组").getByRole("button", { name: /外部工作|External work/ }).click();
  await expect(page.locator("[data-ui2-external-work]")).toBeVisible();
  await assertDarkPage(page, "external work settings", [
    ".settings-layout",
    "[data-ui2-external-work]",
    ".settings-external-work-header",
  ]);
  await captureDarkEvidence(page, testInfo, "06d-settings-external-work");

  await page.getByLabel("设置分组").getByRole("button", { name: /默认授权|Default authorization/ }).click();
  await expect(page.locator("[data-ui2-default-authorization]")).toBeVisible();
  await expect(page.locator(".runtime-runner-settings-panel")).toHaveCount(0);
  await assertDarkPage(page, "default authorization settings", [
    ".settings-default-authorization-section",
    ".settings-authorization-row",
    ".settings-authorization-segments",
  ]);
  await captureDarkEvidence(page, testInfo, "07-settings-default-authorization");

  await page.getByLabel("设置分组").getByRole("button", { name: /智囊团工作区|Council Workspace/ }).click();
  await expect(page.locator(".council-workspace-page")).toBeVisible();
  await assertDarkPage(page, "AI councils", [
    ".workspace-settings-surface",
    ".settings-layout",
    ".council-workspace-page",
    ".council-workspace-list",
    ".council-list-row",
    ".council-workspace-detail",
    ".council-health-strip",
    ".council-detail-tabs",
    ".council-members-row",
  ]);
  await captureDarkEvidence(page, testInfo, "08-settings-councils");
  await page.getByLabel("设置分组").getByRole("button", { name: /资料|Profile/ }).click();
  await expect(page.locator('[data-ui2-settings-profile="true"]')).toBeVisible();
  await assertDarkPage(page, "account profile settings", [
    '[data-ui2-settings-profile="true"]',
    '[data-profile-section="identity"]',
    '[data-profile-name-row="true"]',
    '[data-profile-section="usage"]',
    '[data-profile-usage-summary="true"]',
  ]);
  await captureDarkEvidence(page, testInfo, "09-settings-profile");

  await page.getByLabel("设置分组").getByRole("button", { name: /模型工作台|Model Workbench/ }).click();
  await expect(page.locator(".provider-workbench-surface")).toBeVisible();
  await assertDarkPage(page, "model workbench", [
    ".workspace-settings-surface",
    ".settings-layout",
    ".provider-workbench-surface",
    ".provider-workbench",
    ".provider-table-shell",
    ".provider-row",
  ]);
  await captureDarkEvidence(page, testInfo, "10-settings-model-workbench");

  await page.getByLabel("设置分组").getByRole("button", { name: /队友管理|Teammate Management/ }).click();
  await expect(page.locator(".teammates-page")).toBeVisible();
  await assertDarkPage(page, "AI teammates", [
    ".workspace-settings-surface",
    ".settings-layout",
    ".teammates-page",
    ".teammate-role-catalog",
    ".teammate-add-panel",
    ".teammate-draft-row",
  ]);
  await captureDarkEvidence(page, testInfo, "11-settings-teammates");

  await page.getByRole("button", { name: "返回应用" }).click();
  await navigation.getByRole("button", { name: "工程队友" }).click();
  await expect(page.getByRole("heading", { name: "工程队友", level: 1 })).toBeVisible();
  await expect(page.locator(".workspace-teammate-private-surface")).toBeVisible();
  await assertDarkPage(page, "private teammate chat", [
    ".workspace-teammate-private-surface",
    ".teammate-workspace.chat-mode",
    ".teammate-chat-header",
    ".teammate-private-chat",
    ".teammate-direct-composer",
  ]);
  await captureDarkEvidence(page, testInfo, "12-teammate-private-chat");

  await navigation.getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /MCP 工具服务/ }).click();
  await assertDarkPage(page, "MCP settings", [
    ".settings-layout",
    ".settings-mcp-page",
    ".settings-mcp-toolbar",
    ".settings-mcp-empty",
  ]);
  await captureDarkEvidence(page, testInfo, "13-settings-mcp");

  await page.getByLabel("设置分组").getByRole("button", { name: /个性化|Personalization/ }).click();
  await expect(page.locator(".personalization-settings-panel")).toHaveCount(2);
  await expect(page.locator(".personalization-settings-panel").first()).toBeVisible();
  await expect(page.locator(".personalization-settings-panel").last()).toBeVisible();
  await expect(page.locator(".skill-governance-settings-panel")).toBeVisible();
  await assertDarkPage(page, "personalization settings", [
    ".settings-layout",
    ".personalization-settings-panel",
    ".settings-personalization-tone-control",
    ".skill-governance-settings-panel",
    ".settings-skill-governance",
    ".settings-skill-governance-field",
  ]);
  await captureDarkEvidence(page, testInfo, "14-settings-personalization");

  await page.getByLabel("设置分组").getByRole("button", { name: /技能库|Skill library/ }).click();
  await page.getByRole("tab", { name: /内置技能|Built-in skills/ }).click();
  await expect(page.locator(".settings-skill-table")).toBeVisible();
  await page.locator(".settings-skill-table tbody tr").first().click();
  await expect(page.locator(".settings-skill-compact-inspector")).toBeVisible();
  await assertDarkPage(page, "skill library settings", [
    ".settings-layout",
    ".settings-skill-library",
    ".settings-skill-ownership-meta span",
    ".settings-skill-library-toolbar",
    ".settings-skill-table-wrap",
    ".settings-skill-table",
    ".settings-skill-detail-drawer",
    ".settings-skill-compact-inspector",
    ".settings-skill-summary-card",
  ]);
  await captureDarkEvidence(page, testInfo, "15-settings-skill-library");

  await expect(page.getByRole("tab", { name: /AI 进化|AI evolution/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /待复核|Review queue/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /官方技能更新|Official skill updates/ })).toHaveCount(0);

  await page.getByRole("button", { name: /返回应用|Back to app/ }).click();
  await openWorkBoardFromInbox(page);
  await expect(page.locator(".work-board-page")).toBeVisible();
  await assertDarkPage(page, "work board", [
    ".work-board-page",
    ".work-board-toolbar",
    ".work-board-list",
    ".work-item-row",
    ".work-board-detail",
  ]);
  await captureDarkEvidence(page, testInfo, "16-work-board");

  await navigation.getByRole("button", { name: /设置|Settings/ }).click();
  await openPendingStartupDiagnostics(page);
  await page.getByRole("button", { name: /打开运行诊断|Open run diagnostics/ }).first().click();
  await expect(page.getByLabel("设置分组")).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  await expect(page.locator(".settings-run-diagnostics-panel")).toBeVisible();
  await assertDarkPage(page, "settings run diagnostics", [
    ".settings-layout",
    ".settings-run-diagnostics-panel",
    ".settings-run-diagnostics-toolbar",
    ".settings-run-diagnostics-list",
    ".settings-run-diagnostics-detail",
  ]);
  await captureDarkEvidence(page, testInfo, "17-settings-run-diagnostics");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel("设置分组").getByRole("button", { name: /已归档项目|Archived items/ }).click();
  await expect(page.locator(".archived-items-settings-panel")).toBeVisible();
  await expect(page.locator(".archived-items-settings-panel").getByRole("tab")).toHaveCount(4);
  await expect(page.locator(".archived-delete-action")).toHaveCount(1);
  await assertDarkPage(page, "archived items settings", [
    ".settings-layout",
    ".archived-items-settings-panel",
    ".archived-items-toolbar",
    ".settings-subnav",
    ".archived-item-list",
    ".archived-item-row",
    ".archived-item-actions",
  ]);
  await captureDarkEvidence(page, testInfo, "18-settings-archived-items");

  await page.getByLabel("设置分组").getByRole("button", { name: /界面偏好|Interface preferences/ }).click();
  await expect(page.locator("[data-ui2-interface-preferences]")).toBeVisible();
  await assertDarkPage(page, "compact interface preferences", [
    ".settings-layout",
    "[data-ui2-interface-preferences]",
    "[data-ui2-interface-theme]",
    ".settings-interface-language",
  ]);
  await captureDarkEvidence(page, testInfo, "19-1280x800-settings-interface-preferences");

});

test("packaged Computer Control follows the same dark surface hierarchy", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
        appearance: { reportTheme() {} },
        computerControl: {
          packagedBundledCapable: true,
          platform: "macos",
          requestPermissions: async () => ({ accepted: true }),
          openPermissionSettings: async () => ({ accepted: true }),
        },
        navigation: {
          acknowledgeIntent: async () => ({ accepted: true }),
          onIntent: () => () => undefined,
        },
        daemon: {
          getStatus: async () => ({ state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true }),
          restart: async () => ({ state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true }),
        },
        computerUse: {
          reportLocale() {},
          reportSelectedDeckOwner() {},
          reportSelectedConversation() {},
          reportHostLayout() {},
          show: async () => ({ accepted: true }),
          hide: async () => ({ accepted: true }),
          stop: async () => ({ accepted: true }),
          getPreferences: async () => ({ previewAutoShow: true }),
          setAutoShow: async () => ({ accepted: true }),
          onSummaryChanged: () => () => undefined,
        },
      },
    });
  });
  const state = createDarkThemeState();
  state.managedPlugins = state.managedPlugins.filter((plugin) => plugin.id !== "trusted-local:cua-driver");
  state.managedPlugins.push(createMockBundledEmbeddedCuaPlugin({
    providerState: "included",
    platform: "darwin",
    requestedEnabled: false,
    effectiveEnabled: false,
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /电脑控制|Computer Control/ }).click();
  await expect(page.locator(".computer-control-settings")).toBeVisible();
  await assertDarkPage(page, "packaged computer control", [
    ".settings-layout",
    ".computer-control-settings",
    ".computer-control-status-card",
    ".computer-control-section",
  ]);
  await captureDarkEvidence(page, testInfo, "20-1280x800-settings-computer-control");
});

function createDarkThemeState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_local",
      displayName: "本地模型",
      model: "gpt-test",
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-06-24T00:00:00.000Z" },
    }),
    createMediaProvider({
      id: "provider_seedream",
      displayName: "图像模型",
      model: "seedream",
    }),
  ];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_engineer",
      displayName: "工程队友",
      providerPresetId: "provider_local",
    }),
    createMockTeammate({
      id: "teammate_archived_dark",
      displayName: "已归档队友",
      hidden: true,
      status: "active",
      updatedAt: "2026-06-24T00:04:00.000Z",
    }),
  ];
  state.threads.push({
    id: "thread_archived_dark",
    workspaceId: "workspace_default",
    kind: "conversation",
    teammateId: "ling_agent",
    title: "已归档会话",
    objective: "Dark mode archived conversation",
    status: "archived",
    conversationMode: { mode: "default" },
    createdAt: "2026-06-24T00:04:00.000Z",
    updatedAt: "2026-06-24T00:04:00.000Z",
    archivedAt: "2026-06-24T00:04:00.000Z",
  });
  state.channels.push({
    id: "channel_archived_dark",
    workspaceId: "workspace_default",
    name: "已归档频道",
    status: "archived",
    boundPath: cwd,
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: {},
    createdAt: "2026-06-24T00:04:00.000Z",
    updatedAt: "2026-06-24T00:04:00.000Z",
  });
  state.channelBranches.push({
    id: "branch_archived_dark",
    workspaceId: "workspace_default",
    channelId: "channel_archived_dark",
    name: "已归档分支",
    status: "archived",
    createdAt: "2026-06-24T00:04:00.000Z",
    updatedAt: "2026-06-24T00:04:00.000Z",
    archivedAt: "2026-06-24T00:04:00.000Z",
  });
  state.mediaJobs = [
    {
      id: "media_job_dark_succeeded",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Dark mode visual QA image.",
      input: {},
      artifactIds: ["artifact_media_dark"],
      status: "succeeded",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:01:00.000Z",
    },
    {
      id: "media_job_dark_failed",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Failed dark mode preview.",
      input: {},
      artifactIds: [],
      status: "failed",
      errorMessage: "Generation failed for dark mode QA.",
      createdAt: "2026-06-24T00:02:00.000Z",
      updatedAt: "2026-06-24T00:03:00.000Z",
    },
  ];
  state.artifactsByMediaJob.media_job_dark_succeeded = [
    {
      id: "artifact_media_dark",
      mediaJobId: "media_job_dark_succeeded",
      type: "image",
      path: "media_jobs/media_job_dark_succeeded/001.png",
      title: "Dark mode image",
      contentType: "image/png",
      sizeBytes: 4096,
      createdAt: "2026-06-24T00:01:00.000Z",
    },
  ];
  return state;
}

async function mockAutomationReadRoutes(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/automations") {
      await route.fulfill({ json: { cwd, automations: [], templates: [] } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/automation-drafts") {
      await route.fulfill({ json: { cwd, drafts: [], templates: [] } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: [] } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/automations/scheduler") {
      await route.fulfill({
        json: {
          cwd,
          schedulers: [{
            id: "scheduler_dark_mode",
            cwd,
            status: "running",
            startedAt: "2026-06-24T00:00:00.000Z",
            automationCount: 0,
            tickCount: 1,
            items: [],
          }],
        },
      });
      return;
    }
    await route.fallback();
  });
}

async function assertDarkPage(page: Page, label: string, selectors: readonly string[]): Promise<void> {
  for (const selector of selectors) {
    await expect(page.locator(selector).first(), `${label}: ${selector} should render`).toBeVisible();
  }
  const surfaces = await readDarkSurfaces(page, selectors);
  for (const selector of selectors) {
    expect(surfaces.some((surface) => surface.selector === selector), `${label}: ${selector} should render`).toBe(true);
  }
  for (const surface of surfaces) {
    expect(surface.maxChannel, `${label}: ${surface.selector} must not collapse to pure or legacy near-black`).toBeGreaterThanOrEqual(16);
    expect(surface.maxChannel, `${label}: ${surface.selector} should use dark background tokens`).toBeLessThanOrEqual(70);
  }
  const textSamples = await readTextSamples(page, selectors);
  expect(textSamples.length, `${label}: should expose readable text samples`).toBeGreaterThan(0);
  for (const sample of textSamples) {
    expect(sample.maxChannel, `${label}: ${sample.selector} ${sample.element} "${sample.text}" should not stay black in dark mode`).toBeGreaterThanOrEqual(88);
  }
  await assertNoUnexpectedLargeSurfaceColors(page, label);
  await assertNoDocumentHorizontalOverflow(page, label);
}

async function readDarkSurfaces(page: Page, selectors: readonly string[]): Promise<Array<{
  readonly selector: string;
  readonly maxChannel: number;
}>> {
  return await page.evaluate((inputSelectors) => {
    function effectiveBackgroundColor(element: Element): number[] {
      const color = getComputedStyle(element).backgroundColor;
      const channels = color.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const parentColor = element.parentElement ? effectiveBackgroundColor(element.parentElement) : [0, 0, 0];
      if (channels.length < 3) {
        return parentColor;
      }
      const alpha = channels.length >= 4 ? channels[3] : 1;
      if (alpha <= 0) {
        return parentColor;
      }
      if (alpha >= 1) {
        return channels.slice(0, 3);
      }
      return channels.slice(0, 3).map((channel, index) => Math.round(channel * alpha + parentColor[index] * (1 - alpha)));
    }
    return inputSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 4)
        .map((element) => {
          const channels = effectiveBackgroundColor(element);
          return {
            selector,
            maxChannel: Math.max(...channels),
          };
        }),
    );
  }, selectors);
}

async function assertDarkAliasConvergence(page: Page): Promise<void> {
  const pairs = [
    ["--app-bg", "--ling-bg-app"],
    ["--window-bg", "--ling-bg-app"],
    ["--surface-sidebar", "--ling-bg-sidebar"],
    ["--surface-panel", "--ling-bg-panel"],
    ["--surface-panel-strong", "--ling-bg-elevated"],
    ["--surface-subtle", "--ling-bg-subtle"],
    ["--surface-hover", "--ling-bg-subtle"],
    ["--surface-selected", "--ling-action-selection"],
    ["--surface-pressed", "--ling-bg-pressed"],
    ["--text-strong", "--ling-text-strong"],
    ["--text", "--ling-text-default"],
    ["--text-muted", "--ling-text-muted"],
    ["--border", "--ling-border-default"],
    ["--border-strong", "--ling-border-strong"],
    ["--accent", "--ling-action-accent"],
    ["--success-soft", "--ling-status-success-bg"],
    ["--warning-soft", "--ling-status-warning-bg"],
    ["--danger-soft", "--ling-status-danger-bg"],
    ["--info-soft", "--ling-status-info-bg"],
  ] as const;

  const values = await page.evaluate((variables) => {
    const resolveColor = (variable: string): string => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${variable})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    return variables.map(([alias, canonical]) => ({
      alias,
      canonical,
      aliasValue: resolveColor(alias),
      canonicalValue: resolveColor(canonical),
    }));
  }, pairs);

  for (const value of values) {
    expect(value.aliasValue, `${value.alias} should resolve through ${value.canonical}`).toBe(value.canonicalValue);
  }
}

async function assertAliasesTrackRuntimeThemeTokens(page: Page): Promise<void> {
  const values = await page.evaluate(() => {
    const root = document.documentElement;
    const overrides = [
      ["--ling-bg-app", "#182431", "--app-bg"],
      ["--ling-bg-panel", "#20303e", "--surface-panel"],
      ["--ling-text-default", "#c5d2df", "--text"],
    ] as const;
    const previous = overrides.map(([canonical]) => [canonical, root.style.getPropertyValue(canonical)] as const);
    const resolveColor = (variable: string, property: "backgroundColor" | "color"): string => {
      const probe = document.createElement("span");
      probe.style[property] = `var(${variable})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    try {
      for (const [canonical, value] of overrides) root.style.setProperty(canonical, value);
      return overrides.map(([canonical, , alias]) => ({
        alias,
        aliasValue: resolveColor(alias, alias === "--text" ? "color" : "backgroundColor"),
        canonical,
        canonicalValue: resolveColor(canonical, alias === "--text" ? "color" : "backgroundColor"),
      }));
    } finally {
      for (const [canonical, value] of previous) {
        if (value) root.style.setProperty(canonical, value);
        else root.style.removeProperty(canonical);
      }
    }
  });

  for (const value of values) {
    expect(value.aliasValue, `${value.alias} should remain a live binding to ${value.canonical}`).toBe(value.canonicalValue);
  }
}

async function assertNoUnexpectedLargeSurfaceColors(page: Page, label: string): Promise<void> {
  const findings = await page.evaluate(() => {
    type Rgba = readonly [number, number, number, number];
    const parseColor = (value: string): Rgba | undefined => {
      const channels = value.match(/\d+(?:\.\d+)?/g)?.map(Number);
      if (!channels || channels.length < 3) return undefined;
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
    };
    const composite = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha <= 0) return [0, 0, 0, 0];
      return [
        Math.round((foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha),
        Math.round((foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha),
        Math.round((foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha),
        alpha,
      ];
    };
    const cache = new Map<Element, Rgba>();
    const effectiveBackground = (element: Element | null): Rgba => {
      if (!element) return [17, 19, 21, 1];
      const cached = cache.get(element);
      if (cached) return cached;
      const own = parseColor(getComputedStyle(element).backgroundColor) ?? [0, 0, 0, 0];
      const resolved = own[3] >= 1 ? own : composite(own, effectiveBackground(element.parentElement));
      cache.set(element, resolved);
      return resolved;
    };
    const minimumArea = Math.max(4_500, window.innerWidth * window.innerHeight * 0.004);
    const exemptSelector = [
      "img",
      "video",
      "canvas",
      "svg",
      "button",
      "[role='button']",
      "pre",
      "code",
      "[class*='avatar']",
      "[class*='backdrop']",
      "[class*='overlay']",
      "[class*='scrim']",
      ".ling-ui-theme-option-swatch",
      ".ling-ui-theme-option-swatch *",
      ".settings-theme-studio-preview-stage",
      ".settings-theme-studio-preview-stage *",
    ].join(",");

    return Array.from(document.body.querySelectorAll("*"))
      .flatMap((element) => {
        if (element.matches(exemptSelector)) return [];
        const rect = element.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area < minimumArea || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return [];
        const own = parseColor(getComputedStyle(element).backgroundColor);
        if (!own || own[3] <= 0) return [];
        const effective = effectiveBackground(element);
        const maxChannel = Math.max(effective[0], effective[1], effective[2]);
        const opaqueNearBlack = own[3] >= 0.98 && maxChannel < 16;
        const unexpectedlyLight = maxChannel > 96;
        if (!opaqueNearBlack && !unexpectedlyLight) return [];
        const className = typeof (element as HTMLElement).className === "string"
          ? (element as HTMLElement).className.trim().split(/\s+/u).slice(0, 3).join(".")
          : "";
        return [{
          area: Math.round(area),
          effective: `rgb(${effective.slice(0, 3).join(", ")})`,
          selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className}` : ""}`,
          source: getComputedStyle(element).backgroundColor,
        }];
      })
      .slice(0, 12);
  });

  expect(findings, `${label}: large product surfaces should stay inside the dark Theme Pack hierarchy`).toEqual([]);
}

async function readTextSamples(page: Page, surfaceSelectors: readonly string[]): Promise<Array<{
  readonly selector: string;
  readonly maxChannel: number;
  readonly element: string;
  readonly text: string;
}>> {
  return await page.evaluate((selectors) => {
    const effectiveBackground = (element: Element): number[] => {
      const channels = getComputedStyle(element).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const parent = element.parentElement ? effectiveBackground(element.parentElement) : [0, 0, 0];
      if (channels.length < 3) return parent;
      const alpha = channels[3] ?? 1;
      if (alpha <= 0) return parent;
      return channels.slice(0, 3).map((channel, index) => Math.round(channel * alpha + parent[index] * (1 - alpha)));
    };
    return selectors.flatMap((surfaceSelector) =>
      Array.from(document.querySelectorAll(surfaceSelector))
        .flatMap((surface) => Array.from(surface.querySelectorAll("h1, h2, h3, strong, label, button, span")))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const hasDirectText = Array.from(element.childNodes).some((node) =>
            node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0
          );
          return rect.width > 0 && rect.height > 0
            && hasDirectText
            && Math.max(...effectiveBackground(element)) <= 70;
        })
        .slice(0, 4)
        .map((element) => {
          const channels = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
          return {
            selector: surfaceSelector,
            maxChannel: Math.max(...channels),
            element: `${element.tagName.toLowerCase()}.${String(element.className).replace(/\s+/gu, ".")}`,
            text: (element.textContent ?? "").trim().slice(0, 80),
          };
        }),
    );
  }, surfaceSelectors);
}

async function assertNoDocumentHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    return {
      scrollWidth: scrollingElement.scrollWidth,
      clientWidth: scrollingElement.clientWidth,
    };
  });
  expect(overflow.scrollWidth, `${label}: document should not horizontally overflow`).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function captureDarkEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.LING_CAPTURE_DARK_SURFACE_EVIDENCE !== "1") return;
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}
