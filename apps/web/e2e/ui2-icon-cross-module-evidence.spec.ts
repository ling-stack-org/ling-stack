import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
  createMockTeammate,
  cwd,
} from "./support/mock-state";
import {
  createLoadedMediaProductionFixture,
  createMediaProductionRouteControl,
  installMediaProductionScenarioRoutes,
  openMediaProduction,
} from "./support/media-production-fixtures";
import { openWorkBoardFromInbox } from "./support/open-work-board";
import { openEngineeringChannel } from "./support/test-helpers";

test.describe.configure({ timeout: 90_000 });

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/icon-system-p7-f/",
  import.meta.url,
));

const themes = [
  { height: 960, id: "light", themeId: "ling-light", width: 1440 },
  { height: 800, id: "dark", themeId: "ling-dark", width: 1280 },
] as const;

for (const theme of themes) {
  test(`T13-P.7-F ${theme.id} AI Teammate and Profile preserve typed actions and the single avatar identity budget`, async ({ page }) => {
    const signals = collectBrowserSignals(page);
    await prepareEvidencePage(page, theme);

    const teammateProfile = await openTeammateProfile(page);
    const resetProfile = page.getByLabel("Single agent settings").getByRole("button", { name: "Reset profile" });
    const changeTeammateAvatar = teammateProfile.getByRole("button", { name: "Avatar options" });
    await expectStandardIconButton(resetProfile, "Reset profile");
    await expect(resetProfile).toBeDisabled();
    await expectStandardIconButton(changeTeammateAvatar, "Avatar options");
    await expect(teammateProfile.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
    await expectNoOverflow(page, teammateProfile);
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-ai-teammate-profile.png`);

    const settingsProfile = await openSettingsProfile(page);
    const avatarIdentity = settingsProfile.getByRole("button", { name: "Change avatar" });
    await expectLegacyAvatarIdentity(avatarIdentity, "Change avatar");
    const legacyBudget = page.locator('button[data-ling-icon-button-contract="legacy-react-node"]');
    await expect(legacyBudget).toHaveCount(1);
    await expect(legacyBudget).toHaveClass(/profile-settings-avatar/u);
    await expectStandardIconButton(
      settingsProfile.getByRole("button", { name: "Edit display name" }),
      "Edit display name",
      { minimumSize: 28 },
    );
    await expectNoOverflow(page, settingsProfile);
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-settings-profile-avatar-budget.png`);
    expect(signals.consoleErrors).toEqual([]);
    expect(signals.pageErrors).toEqual([]);
  });

  test(`T13-P.7-F ${theme.id} Council and Plugin Manager expose typed Lucide utility actions`, async ({ page }) => {
    const signals = collectBrowserSignals(page);
    await prepareEvidencePage(page, theme);

    const council = await openCouncilWorkspace(page);
    await expectStandardIconButton(council.getByRole("button", { name: "Refresh councils" }), "Refresh councils");
    await expectStandardIconButton(council.getByRole("button", { name: "Create council" }).first(), "Create council");
    await expectNoOverflow(page, council);
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-council.png`);

    const plugins = await openPluginManager(page);
    await expectStandardIconButton(plugins.getByRole("button", { name: "Refresh" }), "Refresh");
    const cuaRow = plugins.locator('.plugin-table-row[data-plugin-id="trusted-local:cua-driver"]');
    await expect(cuaRow).toBeVisible();
    await expectStandardIconButton(cuaRow.getByRole("button", { name: "Check" }), "Check");
    await expectStandardIconButton(cuaRow.getByRole("button", { name: "Details" }), "Details");
    await expectNoOverflow(page, plugins);
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-plugin-manager.png`);
    expect(signals.consoleErrors).toEqual([]);
    expect(signals.pageErrors).toEqual([]);
  });

  test(`T13-P.7-F ${theme.id} Work Board Channel and Media Production cover active focus and dock icon states`, async ({ page }) => {
    const signals = collectBrowserSignals(page);
    await prepareEvidencePage(page, theme);

    const workBoard = await openWorkBoard(page);
    const filterWork = workBoard.getByRole("button", { name: "Filter work" });
    await expectStandardIconButton(filterWork, "Filter work");
    await expect(filterWork).toHaveAttribute("aria-pressed", "false");
    await filterWork.click();
    await expect(filterWork).toHaveAttribute("aria-pressed", "true");
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-work-board-active-filter.png`);
    await page.keyboard.press("Escape");
    await expect(filterWork).toHaveAttribute("aria-pressed", "false");
    await expectNoOverflow(page, workBoard);

    await page.reload();
    const channelToolbar = await openChannelToolbar(page);
    const channelActions = [
      ["Search", channelToolbar.getByRole("button", { name: "Search" })],
      ["Refresh", channelToolbar.getByRole("button", { name: "Refresh" })],
      ["Summary", channelToolbar.getByRole("button", { name: "Summary" })],
      ["Toggle bottom panel", channelToolbar.getByRole("button", { name: "Toggle bottom panel" })],
      ["Show details", channelToolbar.getByRole("button", { name: "Show details" })],
    ] as const;
    for (const [label, action] of channelActions) await expectStandardIconButton(action, label);
    await channelActions[0][1].focus();
    await page.keyboard.press("Tab");
    await expect(channelActions[1][1]).toBeFocused();
    expect(await channelActions[1][1].evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expectNoOverflow(page, page.locator(".workspace-client-surface"));
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-channel-header-utility.png`);

    await page.reload();
    const media = await openMediaProductionSurface(page);
    const leftDock = media.locator(".media-production-dock-rail.left").getByRole("button", { name: "Close projects and scenes" });
    const rightDock = media.locator(".media-production-dock-rail.right").getByRole("button", { name: "Expand" });
    await expectStandardIconButton(leftDock, "Close projects and scenes");
    await expect(leftDock).toHaveAttribute("aria-pressed", "true");
    await expectStandardIconButton(rightDock, "Expand");
    await expect(rightDock).toHaveAttribute("aria-pressed", "false");
    await media.locator(".storyboard-scene-node").first().click();
    const collapseDock = media.locator(".media-production-dock-rail.right").getByRole("button", { name: "Collapse" });
    await expectStandardIconButton(collapseDock, "Collapse");
    await expect(collapseDock).toHaveAttribute("aria-pressed", "true");
    await expectNoOverflow(page, media);
    await captureIfEnabled(page, `${theme.width}x${theme.height}-ling-${theme.id}-media-production.png`);
    expect(signals.consoleErrors).toEqual([]);
    expect(signals.pageErrors).toEqual([]);
  });
}

async function prepareEvidencePage(
  page: Page,
  theme: (typeof themes)[number],
): Promise<void> {
  await page.setViewportSize({ width: theme.width, height: theme.height });
  await page.emulateMedia({
    colorScheme: theme.id,
    reducedMotion: theme.id === "dark" ? "reduce" : "no-preference",
  });
  await page.addInitScript(({ selectedThemeId, selectedTheme, workspaceCwd }) => {
    const selection = { mode: "fixed", themeId: selectedThemeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", workspaceCwd);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", selectedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", selectedTheme);
  }, {
    selectedTheme: theme.id,
    selectedThemeId: theme.themeId,
    workspaceCwd: cwd,
  });

  const state = createEvidenceState();
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaProductionScenarioRoutes(page, state, createMediaProductionRouteControl());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme.themeId);
}

function createEvidenceState(): MockState {
  const state = createBaseState({ approvalStatus: "pending" });
  const media = createLoadedMediaProductionFixture({ projectCount: 1, scenesPerProject: 2 });
  state.mediaProjects = media.mediaProjects;
  state.mediaScenes = media.mediaScenes;
  state.mediaSceneRuns = media.mediaSceneRuns;
  state.mediaWorkflowConnections = media.mediaWorkflowConnections;
  state.mediaWorkflows = media.mediaWorkflows;
  state.mediaJobs = media.mediaJobs;
  state.artifactsByMediaJob = media.artifactsByMediaJob;
  state.providers = [createChatProvider({
    id: "provider_icon_evidence",
    providerId: "local-relay",
    displayName: "Icon Evidence Relay",
    model: "gpt-5.5",
    lastCheck: { checkedAt: "2026-07-27T00:00:00.000Z", message: "Ready", ok: true },
  })];
  state.aiTeammates = [
    createMockTeammate({
      id: "engineer",
      displayName: "Ling Engineer",
      providerPresetId: "provider_icon_evidence",
    }),
    createMockTeammate({
      id: "teammate_icon_evidence",
      displayName: "Icon Evidence Engineer",
      providerPresetId: "provider_icon_evidence",
    }),
  ];
  return state;
}

async function openTeammateProfile(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Icon Evidence Engineer" }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  if (await page.getByLabel("Private chat workspace dock").count() === 0) {
    await header.getByRole("button", { name: "Show details" }).click();
  }
  await page.getByLabel("Private chat workspace dock").getByRole("button", { name: "Settings" }).click();
  const profile = page.getByLabel("Teammate profile");
  await expect(profile).toBeVisible();
  return profile;
}

async function openSettingsProfile(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "User profile", exact: true }).click();
  const profile = page.locator("[data-ui2-settings-profile]");
  await expect(profile).toHaveAttribute("data-profile-state", "loaded");
  return profile;
}

async function openCouncilWorkspace(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace", exact: true }).click();
  const council = page.locator("[data-settings-workspace-tool='councils']");
  await expect(council.locator(".council-list-health-row").first()).toBeVisible();
  return council;
}

async function openPluginManager(page: Page): Promise<Locator> {
  const backToApp = page.getByRole("button", { name: "Back to app" });
  if (await backToApp.isVisible().catch(() => false)) await backToApp.click();
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  const plugins = page.locator(".plugin-manager-page .settings-plugin-manager");
  await expect(plugins.locator(".plugin-table-row").first()).toBeVisible();
  return plugins;
}

async function openWorkBoard(page: Page): Promise<Locator> {
  await openWorkBoardFromInbox(page);
  const workBoard = page.locator(".work-board-page");
  await expect(workBoard).toBeVisible();
  return workBoard;
}

async function openChannelToolbar(page: Page): Promise<Locator> {
  await openEngineeringChannel(page);
  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  await expect(toolbar).toBeVisible();
  return toolbar;
}

async function openMediaProductionSurface(page: Page): Promise<Locator> {
  await openMediaProduction(page);
  const media = page.locator(".media-production-page");
  await expect(media.locator(".storyboard-scene-node")).toHaveCount(2);
  return media;
}

async function expectStandardIconButton(
  button: Locator,
  label: string,
  options: { readonly minimumSize?: number } = {},
): Promise<void> {
  const minimumSize = options.minimumSize ?? 32;
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  await expect(button.locator('svg[data-ling-icon=""]')).toHaveCount(1);
  await expectMinimumRawSize(button, minimumSize);
  await expectTooltip(button, label);
}

async function expectLegacyAvatarIdentity(button: Locator, label: string): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "legacy-react-node");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  await expectMinimumRawSize(button, 32);
  await expectTooltip(button, label);
}

async function expectMinimumRawSize(button: Locator, minimumSize: number): Promise<void> {
  const size = await button.evaluate((element) => ({
    height: (element as HTMLElement).offsetHeight,
    width: (element as HTMLElement).offsetWidth,
  }));
  expect(size.width).toBeGreaterThanOrEqual(minimumSize);
  expect(size.height).toBeGreaterThanOrEqual(minimumSize);
}

async function expectTooltip(button: Locator, label: string): Promise<void> {
  const page = button.page();
  await page.mouse.move(1, 1);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await button.hover();
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

async function expectNoOverflow(page: Page, surface: Locator): Promise<void> {
  await expect(surface).toBeVisible();
  const metrics = await page.evaluate(() => ({
    documentX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    documentY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(metrics.documentX).toBeLessThanOrEqual(1);
  expect(metrics.documentY).toBeLessThanOrEqual(1);
  const surfaceOverflow = await surface.evaluate((element) => ({
    x: element.scrollWidth - element.clientWidth,
    y: element.scrollHeight - element.clientHeight,
  }));
  expect(surfaceOverflow.x).toBeLessThanOrEqual(1);
  expect(surfaceOverflow.y).toBeLessThanOrEqual(1);
}

async function captureIfEnabled(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1, 1);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: false, path: `${evidenceDirectory}${filename}` });
}

function collectBrowserSignals(page: Page): {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}
