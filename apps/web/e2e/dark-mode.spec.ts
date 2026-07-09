import { expect, type Page, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
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
});

test("main pages and workspace tools follow dark theme tokens", async ({ page }) => {
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
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await expect(page.locator(".client-window")).toBeVisible();
  await assertDarkPage(page, "channel workspace", [
    ".workspace-client-surface",
    ".client-window",
    ".task-list-panel",
    ".composer-panel",
  ]);

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "收件箱" })).toBeVisible();

  await navigation.getByRole("button", { name: "图像生成" }).click();
  await expect(page.locator(".media-jobs-page")).toBeVisible();
  await assertDarkPage(page, "generation tasks", [
    ".workspace-generation-surface",
    ".media-jobs-page",
    ".media-job-list-panel",
    ".media-job-row",
    ".media-job-detail-panel",
  ]);

  await navigation.getByRole("button", { name: "自动化" }).click();
  await expect(page.locator(".automations-inbox-page")).toBeVisible();
  await assertDarkPage(page, "automations", [
    ".workspace-automations-surface",
    ".automations-inbox-page",
    ".automations-inbox-header",
    ".automation-current-pane",
    ".automation-execution-inspector",
  ]);

  await navigation.getByRole("button", { name: "设置" }).click();
  await expect(page.getByLabel("设置分组")).toBeVisible();
  await assertDarkPage(page, "settings shell", [
    ".settings-layout",
    ".settings-section-nav",
    ".settings-content-stack",
  ]);

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
    ".council-member-row",
  ]);
  await page.getByLabel("设置分组").getByRole("button", { name: /资料|Profile/ }).click();
  await expect(page.locator(".profile-settings-surface")).toBeVisible();
  await assertDarkPage(page, "account profile settings", [
    ".profile-settings-surface",
    ".profile-settings-identity-block",
    ".profile-settings-name-row",
    ".profile-settings-section",
    ".profile-usage-summary-grid",
  ]);

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

  await page.getByLabel("设置分组").getByRole("button", { name: /队友管理|Teammate Management/ }).click();
  await expect(page.locator(".teammates-page")).toBeVisible();
  await assertDarkPage(page, "AI teammates", [
    ".workspace-settings-surface",
    ".settings-layout",
    ".teammates-page",
    ".teammate-template-panel",
    ".teammate-add-panel",
    ".teammate-draft-row",
  ]);

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

  await navigation.getByRole("button", { name: "设置" }).click();
  await page.getByLabel("设置分组").getByRole("button", { name: /MCP 工具服务/ }).click();
  await assertDarkPage(page, "MCP settings", [
    ".settings-layout",
    ".mcp-page",
    ".mcp-toolbar",
    ".mcp-server-panel",
    ".mcp-empty",
  ]);

  await page.getByLabel("设置分组").getByRole("button", { name: /Plugin Manager|插件管理/ }).click();
  await expect(page.locator(".settings-plugin-manager")).toBeVisible();
  await assertDarkPage(page, "plugin settings", [
    ".settings-layout",
    ".settings-plugin-manager",
    ".settings-meta-line",
    ".settings-plugin-row",
  ]);

  await page.getByLabel("设置分组").getByRole("button", { name: /个性化|Personalization/ }).click();
  await expect(page.locator(".personalization-settings-panel")).toBeVisible();
  await expect(page.locator(".skill-governance-settings-panel")).toBeVisible();
  await assertDarkPage(page, "personalization settings", [
    ".settings-layout",
    ".personalization-settings-panel",
    ".ling-tone-option",
    ".skill-governance-settings-panel",
    ".settings-skill-governance",
    ".settings-skill-governance-field",
    ".settings-compact-details summary",
    ".settings-skill-governance-fixed span",
  ]);

  await page.getByLabel("设置分组").getByRole("button", { name: /技能库|Skill library/ }).click();
  await expect(page.locator(".settings-skill-table")).toBeVisible();
  await assertDarkPage(page, "skill library settings", [
    ".settings-layout",
    ".settings-skill-library",
    ".settings-skill-library-stats span",
    ".settings-skill-library-toolbar",
    ".settings-skill-table-wrap",
    ".settings-skill-table",
    ".settings-skill-inspector",
    ".settings-skill-search-empty",
  ]);

  await page.getByRole("tab", { name: /待复核|Review queue/ }).click();
  await expect(page.locator(".settings-skill-review-stack")).toBeVisible();
  await assertDarkPage(page, "skill library review settings", [
    ".settings-layout",
    ".settings-skill-library",
    ".settings-skill-review-stack",
    ".settings-compact-details",
    ".settings-skill-review-queue",
    ".settings-skill-review-filters",
  ]);

  await page.getByLabel("设置分组").getByRole("button", { name: /工作看板|Work Board/ }).click();
  await expect(page.locator(".work-board-page")).toBeVisible();
  await assertDarkPage(page, "work board", [
    ".work-board-page",
    ".work-board-toolbar",
    ".work-board-list",
    ".work-item-row",
    ".work-board-detail",
  ]);

  await page.getByRole("button", { name: /打开运行诊断|Open run diagnostics/ }).first().click();
  await expect(page.getByLabel("设置分组")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.locator(".settings-run-diagnostics-panel")).toBeVisible();
  await assertDarkPage(page, "settings run diagnostics", [
    ".settings-layout",
    ".settings-run-diagnostics-panel",
    ".settings-run-diagnostics-summary",
    ".settings-run-diagnostics-list",
    ".settings-run-diagnostics-detail",
  ]);

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
  ];
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
    expect(surface.maxChannel, `${label}: ${surface.selector} should use dark background tokens`).toBeLessThanOrEqual(70);
  }
  const textSamples = await readTextSamples(page);
  expect(textSamples.length, `${label}: should expose readable text samples`).toBeGreaterThan(0);
  for (const sample of textSamples) {
    expect(sample.maxChannel, `${label}: ${sample.selector} text should not stay black in dark mode`).toBeGreaterThanOrEqual(88);
  }
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

async function readTextSamples(page: Page): Promise<Array<{
  readonly selector: string;
  readonly maxChannel: number;
}>> {
  return await page.evaluate(() => {
    const selectors = [".workspace h1", ".workspace h2", ".workspace h3", ".workspace strong", ".workspace label"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (element.textContent ?? "").trim().length > 0;
        })
        .slice(0, 4)
        .map((element) => {
          const channels = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
          return {
            selector,
            maxChannel: Math.max(...channels),
          };
        }),
    );
  });
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
