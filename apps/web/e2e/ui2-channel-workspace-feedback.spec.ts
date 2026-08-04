import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";
import { openEngineeringChannel } from "./support/test-helpers";

const workspaceClientSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/WorkspaceClientView.tsx",
  import.meta.url,
));
const workspacePanelSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/ChannelSettingsWorkspacePanel.tsx",
  import.meta.url,
));
const feedbackControllerSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/useChannelWorkspaceFeedback.ts",
  import.meta.url,
));
const composerDraftControllerSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/useChannelComposerDraftController.ts",
  import.meta.url,
));

test.describe.configure({ mode: "serial" });

test("T13-P.8D composer feedback delegates transient tones to Toast and keeps errors inline without a feature timer", async () => {
  const source = await readFile(composerDraftControllerSourcePath, "utf8");
  expect(source).toContain('if (tone === "error")');
  expect(source).toContain("setComposerFeedback({ id: Date.now(), tone, message })");
  expect(source).toContain('scope: `channel:${channelId || "unknown"}:composer`');
  expect(source).toContain("setMessageDraftState(nextDraft)");
  expect(source).not.toMatch(/composerFeedbackTimeoutRef|setTimeout|setInterval|2_200/u);
});

test("T13-P.8D composer info and success use global Toast while errors persist until input changes", async ({ page }) => {
  await initializePage(page, "ling-light", { width: 1440, height: 960 });
  const signals = collectBrowserSignals(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.locator(".channel-composer");
  const input = composer.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });

  await input.fill("/plan on");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect(composer.locator(".conversation-mode-chip.plan")).toHaveClass(/active/);

  await input.fill("/review apps/web");
  await composer.getByRole("button", { name: "Create task" }).click();
  const error = composer.locator(".composer-status-row.error");
  await expect(error).toContainText("Exit Plan Mode before creating implementation tasks.");
  await page.waitForTimeout(2_500);
  await expect(error).toBeVisible();

  await input.fill("/plan status");
  await expect(error).toHaveCount(0);
  await composer.getByRole("button", { name: "Apply command" }).click();
  const composerToast = page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:composer"]');
  const infoToast = composerToast.filter({ hasText: "Plan Mode is on" });
  await expect(infoToast).toHaveCount(1);
  await expect(composer.locator(".composer-status-row.info")).toHaveCount(0);

  await input.fill("/plan off");
  await composer.getByRole("button", { name: "Apply command" }).click();
  await expect(composer.locator(".conversation-mode-chip.plan")).not.toHaveClass(/active/);
  await input.fill("/goal Ship focused feedback migration");
  await composer.getByRole("button", { name: "Apply command" }).click();
  const successToast = composerToast.filter({ hasText: "Goal set" });
  await expect(successToast).toHaveCount(1);
  await expect(composer.locator(".composer-status-row.success")).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-P.6-G channel workspace success uses one scoped global Toast without a local timer", async () => {
  const [workspaceClientSource, workspacePanelSource, feedbackControllerSource] = await Promise.all([
    readFile(workspaceClientSourcePath, "utf8"),
    readFile(workspacePanelSourcePath, "utf8"),
    readFile(feedbackControllerSourcePath, "utf8"),
  ]);

  expect(workspaceClientSource).not.toContain("channelWorkspaceNotice");
  expect(workspaceClientSource).not.toContain("runChannelWorkspaceAction");
  expect(workspacePanelSource).not.toContain('InlineFeedback tone="success"');
  expect(feedbackControllerSource).toContain("scope: `channel:${channelId}:workspace-binding`");
  expect(feedbackControllerSource).toContain("durationMs: 3_000");
  expect(feedbackControllerSource).not.toMatch(/setTimeout|setInterval/u);
});

test("T13-P.6-G creates, refreshes, opens, and hands off through one global Toast", async ({ page }) => {
  await initializePage(page, "ling-light", { width: 1440, height: 960 });
  const signals = collectBrowserSignals(page);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.route(/\/channels\/channel_engineering\/workspace\/(?:create-worktree|refresh|open|handoff)(?:\?.*)?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fallback();
  });
  await page.goto("/");
  const workspace = await openChannelWorkspaceSettings(page);
  const scope = "channel:channel_engineering:workspace-binding";
  const toast = globalToast(page, scope);

  const createWorktree = workspace.getByRole("button", { name: "Create worktree" });
  const refresh = workspace.getByRole("button", { name: "Check status" });
  await createWorktree.click();
  await expect(createWorktree).toHaveAttribute("data-loading", "true");
  await expect(createWorktree.locator(".ling-ui-spinner")).toHaveCount(1);
  await expect(refresh.locator(".ling-ui-spinner")).toHaveCount(0);
  await expect(toast).toContainText("Managed worktree is ready.");
  await expect(toast).toHaveCount(1);
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='success']")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Channel settings" }).locator(`[data-scope="${scope}"]`)).toHaveCount(0);
  await captureP6FeedbackEvidence(
    page,
    "conversations/channel-workspace-feedback",
    "1440x960-ling-light-scoped-success-toast.png",
  );

  await refresh.click();
  await expect(refresh).toHaveAttribute("data-loading", "true");
  await expect(createWorktree.locator(".ling-ui-spinner")).toHaveCount(0);
  await expect(toast).toContainText("Workspace status refreshed.");
  await expect(toast).toHaveCount(1);

  const openPath = workspace.getByRole("button", { name: "Open path" });
  await openPath.click();
  await expect(openPath).toHaveAttribute("data-loading", "true");
  await expect(toast).toContainText("Opened");
  await expect(toast).toHaveCount(1);

  await workspace.getByLabel("External workspace path").fill("/tmp/ui2-channel-external");
  const handoffExternal = workspace.getByRole("button", { name: "Hand off to External" });
  await handoffExternal.click();
  await expect(handoffExternal).toHaveAttribute("data-loading", "true");
  await expect(toast).toContainText("Channel handed off to External path.");
  await expect(toast).toHaveCount(1);
  await expect(workspace.locator(".ling-ui-inline-feedback")).toHaveCount(0);

  await expectNoDocumentOverflow(page);
  await expect(toast).toHaveCount(0, { timeout: 5_000 });
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-P.6-G keeps failures in Workspace Settings until the owning recovery clears them", async ({ page }) => {
  await initializePage(page, "ling-dark", { width: 1280, height: 800, reducedMotion: "reduce" });
  const signals = collectBrowserSignals(page);
  const state = createBaseState({ approvalStatus: "pending" });
  const engineeringChannel = state.channels.find((channel) => isRecord(channel) && channel.id === "channel_engineering");
  if (!isRecord(engineeringChannel)) throw new Error("Engineering channel fixture is missing");
  state.channels.push({ ...engineeringChannel, id: "channel_research", name: "Research" });
  await mockDaemon(page, state);

  let refreshAttempts = 0;
  await page.route(/\/channels\/channel_engineering\/workspace\/refresh(?:\?.*)?$/u, async (route) => {
    refreshAttempts += 1;
    if (refreshAttempts === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "mock_workspace_refresh_failed", message: "Workspace status is temporarily unavailable." },
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fallback();
  });

  let handoffAttempts = 0;
  await page.route(/\/channels\/channel_engineering\/workspace\/handoff(?:\?.*)?$/u, async (route) => {
    handoffAttempts += 1;
    if (handoffAttempts === 1) {
      await route.fulfill({
        status: 409,
        json: { error: "mock_workspace_handoff_failed", message: "External workspace could not be reached." },
      });
      return;
    }
    await route.fallback();
  });

  let openAttempts = 0;
  await page.route(/\/channels\/channel_engineering\/workspace\/open(?:\?.*)?$/u, async (route) => {
    openAttempts += 1;
    if (openAttempts === 1) {
      await route.fulfill({
        status: 500,
        json: { error: "mock_workspace_open_failed", message: "Workspace path could not be opened." },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  let workspace = await openChannelWorkspaceSettings(page);
  const settingsTabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  const feedback = workspace.locator(".ling-ui-inline-feedback[data-tone='danger']");
  const refresh = workspace.getByRole("button", { name: "Check status" });

  await refresh.click();
  await expect(feedback).toContainText("Workspace status is temporarily unavailable.");
  await settingsTabs.getByRole("tab", { name: "General" }).click();
  await settingsTabs.getByRole("tab", { name: "Workspace" }).click();
  workspace = page.getByLabel("Channel workspace settings");
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']"))
    .toContainText("Workspace status is temporarily unavailable.");
  await page.waitForTimeout(3_200);
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']")).toBeVisible();
  await captureP6FeedbackEvidence(
    page,
    "conversations/channel-workspace-feedback",
    "1280x800-ling-dark-persistent-refresh-failure.png",
  );

  await workspace.getByRole("button", { name: "Check status" }).click();
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']")).toHaveCount(0);
  let toast = globalToast(page, "channel:channel_engineering:workspace-binding");
  await expect(toast).toContainText("Workspace status refreshed.");

  const externalPath = workspace.getByLabel("External workspace path");
  await externalPath.fill("/tmp/unreachable-channel-workspace");
  await workspace.getByRole("button", { name: "Hand off to External" }).click();
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']"))
    .toContainText("External workspace could not be reached.");
  await externalPath.fill("/tmp/recovered-channel-workspace");
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']")).toHaveCount(0);
  await workspace.getByRole("button", { name: "Hand off to External" }).click();
  await expect(toast).toContainText("Channel handed off to External path.");
  await expect(toast).toHaveCSS("animation-duration", "0.001s");

  await workspace.getByRole("button", { name: "Open path" }).click();
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']"))
    .toContainText("Workspace path could not be opened.");
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button").filter({ hasText: "Research" }).first().click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  await navigation.getByRole("button").filter({ hasText: "Engineering" }).first().click();
  workspace = await openChannelWorkspaceSettings(page);
  await expect(workspace.locator(".ling-ui-inline-feedback[data-tone='danger']")).toHaveCount(0);

  await expectNoDocumentOverflow(page);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

async function openChannelWorkspaceSettings(page: Page): Promise<Locator> {
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("region", { name: "Channel settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: "Workspace" }).click();
  const workspace = settings.getByLabel("Channel workspace settings");
  await expect(workspace).toBeVisible();
  return workspace;
}

async function initializePage(
  page: Page,
  themeId: "ling-light" | "ling-dark",
  viewport: { readonly width: number; readonly height: number; readonly reducedMotion?: "reduce" },
): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.emulateMedia({
    colorScheme: themeId === "ling-dark" ? "dark" : "light",
    reducedMotion: viewport.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ savedThemeId }) => {
    const selection = { mode: "fixed", themeId: savedThemeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", savedThemeId === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", savedThemeId === "ling-dark" ? "dark" : "light");
  }, { savedThemeId: themeId });
}

function globalToast(page: Page, scope: string): Locator {
  return page.locator(`[data-ling-overlay="toast"][data-scope="${scope}"]`);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

function collectBrowserSignals(page: Page): { readonly consoleErrors: string[]; readonly pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}
