import { expect, test, type Page } from "@playwright/test";
import type { ProposedPlanArtifact, WorkspaceChangesResponse } from "@ling-stack/contracts";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, isRecord, type MockState } from "./support/mock-state";
import { openChannelChatTools, openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-settings-overlay-dock/",
  import.meta.url,
));

test("channel settings uses shared tabs and stable section boundaries", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openChannelSettings(page);

  const settings = page.getByRole("region", { name: "Channel settings" });
  await expect(settings).toHaveAttribute("data-ui2-channel-settings", "true");
  const tabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await expect(tabs).toHaveClass(/ling-ui-tabs-list/u);

  const sectionLabels = ["General", "Workspace", "Members", "Councils", "Health"] as const;
  for (const label of sectionLabels) {
    const tab = tabs.getByRole("tab", { name: label });
    await expect(tab).toHaveClass(/ling-ui-tabs-trigger/u);
    await tab.click();
    const panel = settings.locator("[data-channel-settings-section]:visible");
    await expect(panel).toHaveAttribute("data-channel-settings-section", label.toLowerCase());
    await expect(panel).toHaveCount(1);
  }

  await tabs.getByRole("tab", { name: "General" }).focus();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tabs.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  const notificationOptions = settings.locator(".channel-notification-option");
  await expect(notificationOptions).toHaveCount(3);
  expect(await notificationOptions.evaluateAll((options) => options.every((option) => {
    const optionBox = option.getBoundingClientRect();
    const labelBox = option.querySelector("strong")?.getBoundingClientRect();
    return Boolean(labelBox)
      && labelBox!.left >= optionBox.left - 1
      && labelBox!.right <= optionBox.right + 1
      && (option.querySelector("strong")?.scrollWidth ?? 1) <= (option.querySelector("strong")?.clientWidth ?? 0);
  }))).toBe(true);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-channel-settings-general.png");
  expect(runtimeErrors).toEqual([]);
});

test("channel settings changes only the Ling Agent model and keeps teammate model ownership", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const readyCheck = { ok: true, message: "Ready", checkedAt: "2026-07-30T00:00:00.000Z" };
  state.providers = [
    createChatProvider({ id: "provider_workspace", displayName: "Workspace Relay", model: "gpt-workspace", lastCheck: readyCheck }),
    createChatProvider({ id: "provider_ling", displayName: "Ling Relay", model: "gpt-ling", lastCheck: readyCheck }),
    createChatProvider({ id: "provider_ling_next", displayName: "Next Ling Relay", model: "gpt-ling-next", lastCheck: readyCheck }),
    createChatProvider({ id: "provider_fixed", displayName: "Fixed Relay", model: "gpt-fixed", lastCheck: readyCheck }),
  ];
  state.workspaceSettings.defaultProviderPresetId = "provider_workspace";
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: "provider_ling" }
    : channel);
  state.aiTeammates = [
    createMockTeammate({
      id: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      protectedProfile: true,
      displayName: "Ling Agent",
      modelBindingMode: "workspace_default",
    }),
    createMockTeammate({
      id: "teammate_builtin_engineer",
      displayName: "Workspace Engineer",
      modelBindingMode: "workspace_default",
    }),
    createMockTeammate({
      id: "teammate_custom_fixed",
      displayName: "Fixed Reviewer",
      modelBindingMode: "fixed",
      providerPresetId: "provider_fixed",
    }),
  ];
  state.teammateChannelMemberships = state.aiTeammates.map((teammate, index) => ({
    teammateId: String(teammate.id),
    channelId: "channel_engineering",
    isDefault: index === 0,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  }));
  await mockDaemon(page, state);
  await page.goto("/");
  await openChannelSettings(page);

  const settings = page.getByRole("region", { name: "Channel settings" });
  const lingAgentModel = settings.getByRole("combobox", { name: "Ling Agent model" });
  await expect(lingAgentModel).toHaveValue("provider_ling");
  await lingAgentModel.selectOption("provider_ling_next");
  await expect.poll(() => {
    const channel = state.channels.find((item) => isRecord(item) && item.id === "channel_engineering");
    return isRecord(channel) ? channel.defaultProviderPresetId : undefined;
  }).toBe("provider_ling_next");

  await page.getByRole("tablist", { name: "Channel settings navigation" }).getByRole("tab", { name: "Members" }).click();
  const lingRow = settings.locator(".channel-teammate-chip").filter({ hasText: "Ling Agent" });
  const workspaceRow = settings.locator(".channel-teammate-chip").filter({ hasText: "Workspace Engineer" });
  const fixedRow = settings.locator(".channel-teammate-chip").filter({ hasText: "Fixed Reviewer" });
  await expect(lingRow).toContainText("Ling Agent model · Next Ling Relay / gpt-ling-next");
  await expect(workspaceRow).toContainText("Workspace default · Workspace Relay / gpt-workspace");
  await expect(fixedRow).toContainText("Fixed model · Fixed Relay / gpt-fixed");
  await expect(settings.locator(".channel-teammate-chip").getByRole("combobox")).toHaveCount(0);
  expect(state.aiTeammates.map((teammate) => teammate.providerPresetId)).toEqual([undefined, undefined, "provider_fixed"]);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("channel rename and governance use the shared overlay layer", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.governanceNotifications = [governanceNotification()];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const more = page.getByRole("button", { name: "More channel views" });
  await more.click();
  await page.getByRole("menuitem", { name: "Rename channel" }).click();
  const rename = page.getByRole("dialog", { name: "Rename channel" });
  await expect(rename).toHaveClass(/ling-ui-dialog-content/u);
  await expect(rename.locator(".ling-ui-field")).toHaveCount(1);
  await expect(rename.getByLabel("Channel name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);
  await expect(more).toBeFocused();

  const governanceTrigger = page.getByRole("button", { name: "Review queue: 1" });
  await governanceTrigger.click();
  const governance = page.getByRole("dialog", { name: "Governance notifications" });
  await expect(governance).toHaveClass(/ling-ui-popover-content/u);
  await expect(governance.locator(".ling-ui-data-row")).toHaveCount(1);
  await expect(governance).toContainText("Memory candidate ready");
  await captureEvidence(page, "1440x960-ling-light-channel-governance-open.png");
  await page.keyboard.press("Escape");
  await expect(governance).toHaveCount(0);
  await expect(governanceTrigger).toBeFocused();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("channel dock uses shared controls across launcher and deep pages", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await expect(dock).toHaveAttribute("data-ui2-right-dock", "true");
  const launcherActions = dock.locator("[data-ui2-dock-launcher-action]");
  await expect(launcherActions).toHaveCount(6);
  expect(await launcherActions.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-ui2-dock-launcher-action"))))
    .toEqual(["review", "plans", "files", "activity", "browser", "terminal"]);
  await expect(launcherActions.first()).toHaveClass(/ling-ui-button/u);
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  await expect.poll(async () => Math.round((await page.locator(".channel-side-panel-frame").boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  await expect.poll(async () => dock.evaluate((element) => element.getBoundingClientRect().right <= globalThis.innerWidth + 1)).toBe(true);
  await captureEvidence(page, "1440x960-ling-light-channel-dock-launcher.png");

  await dock.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dock.locator("[data-ui2-dock-page='review']")).toBeVisible();
  const back = dock.getByRole("button", { name: "Back" });
  const close = dock.getByRole("button", { name: "Close" });
  await expect(back).toHaveClass(/ling-ui-button/u);
  await expect(close).toHaveClass(/ling-ui-button/u);
  await back.click();
  await expect(dock.locator("[data-ui2-dock-page]")).toHaveCount(0);
  await expect(dock.locator("[data-ui2-dock-launcher-action]")).toHaveCount(6);

  await close.click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show details" })).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("channel approval dialog, settings, and dock remain contained at 1280 in dark mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [];
  state.aiCouncils = [];
  state.threads = [channelRootThread()];
  state.proposedPlans = [channelPlanFixture()];
  await mockDaemon(page, state);
  await page.route(/\/channels\/channel_engineering(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 500,
        json: { error: "mock_channel_rename_failed", message: "Channel rename failed for evidence." },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  const approvalDialog = page.getByRole("dialog", { name: "Allow this action?" });
  await expect(approvalDialog).toBeVisible();
  await expect(approvalDialog).toHaveAttribute("data-size", "sm");
  await expect(approvalDialog).toHaveAttribute("data-dismissible", "false");
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-runtime-approval-dialog.png");
  await page.keyboard.press("Escape");
  await expect(approvalDialog).toBeVisible();
  await approvalDialog.getByRole("button", { name: "Deny" }).click();
  await expect(approvalDialog).toHaveCount(0);
  await openChannelSettings(page);

  const settings = page.getByRole("region", { name: "Channel settings" });
  const tabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await tabs.getByRole("tab", { name: "Workspace" }).click();
  await expect(settings.locator(".ling-ui-field")).not.toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-channel-settings-workspace.png");

  await tabs.getByRole("tab", { name: "Members" }).click();
  await expect(settings.getByText("Create a workspace teammate before assigning channel members.")).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-channel-settings-members-empty.png");

  await page.getByRole("button", { name: "Back to channel" }).click();
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Rename channel" }).click();
  const rename = page.getByRole("dialog", { name: "Rename channel" });
  await rename.getByLabel("Channel name").fill("Engineering evidence");
  await rename.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Channel rename failed for evidence.")).toBeVisible();
  await expect(rename).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-channel-rename-failure.png");
  await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);

  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await dock.getByRole("button", { name: "Plans" }).click();
  await expect(dock.locator("[data-ui2-dock-page='plans']")).toBeVisible();
  const geometry = await dock.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    viewportRight: element.getBoundingClientRect().right,
    viewportWidth: window.innerWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.viewportRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  await captureEvidence(page, "1280x800-ling-dark-channel-dock-plans.png");

  await dock.getByRole("button", { name: "Open plan detail Plan evidence fixture" }).click();
  const resizeHandle = page.getByRole("separator", { name: "Resize workspace dock" });
  const dockWidthBeforeResize = (await dock.boundingBox())?.width ?? 0;
  const resizeHandleBox = await resizeHandle.boundingBox();
  expect(resizeHandleBox).not.toBeNull();
  await resizeHandle.hover({ position: { x: Math.max(1, resizeHandleBox!.width / 2), y: Math.min(80, resizeHandleBox!.height - 1) } });
  await page.mouse.down();
  await page.mouse.move(Math.max(1, resizeHandleBox!.x - 120), resizeHandleBox!.y + 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThan(dockWidthBeforeResize + 70);
  await expect(dock.locator(".right-dock-plan-detail")).toContainText("Long-form implementation evidence");
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-channel-dock-plan-detail-resized.png");
  expect(runtimeErrors).toEqual([]);
});

test("channel settings exposes loading, empty, failure, and scoped busy states", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [];
  state.aiCouncils = [];
  await mockDaemon(page, state);
  await page.route(/\/channels\/channel_engineering\/team-metrics(?:\?.*)?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({
      status: 503,
      json: { error: "mock_team_metrics_failed", message: "Team metrics evidence is unavailable." },
    });
  });
  await page.route(/\/channels\/channel_engineering\/workspace\/refresh(?:\?.*)?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fallback();
  });
  await page.route(/\/channels\/channel_engineering(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 500,
        json: { error: "mock_channel_rename_failed", message: "Channel rename failed for evidence." },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openChannelSettings(page);

  const settings = page.getByRole("region", { name: "Channel settings" });
  const tabs = page.getByRole("tablist", { name: "Channel settings navigation" });
  await tabs.getByRole("tab", { name: "Health" }).click();
  await expect(settings.getByRole("status", { name: "Loading team metrics..." })).toBeVisible();
  await expect(settings.getByText("Team metrics could not be loaded")).toBeVisible();

  await tabs.getByRole("tab", { name: "General" }).click();
  const name = settings.getByLabel("Name");
  await name.fill("");
  await expect(settings.getByRole("button", { name: "Save channel" })).toBeDisabled();
  await name.fill("Engineering evidence");
  await settings.getByRole("button", { name: "Save channel" }).click();
  await expect(settings.getByText("Channel rename failed for evidence.")).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await captureEvidence(page, "1440x960-ling-light-channel-settings-general-error.png");

  await tabs.getByRole("tab", { name: "Workspace" }).click();
  const refresh = settings.getByRole("button", { name: "Check status" });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh.locator(".ling-ui-spinner")).toHaveCount(1);
  await expect(refresh).toBeEnabled();

  await tabs.getByRole("tab", { name: "Members" }).click();
  await expect(settings.getByText("Create a workspace teammate before assigning channel members.")).toBeVisible();
  await tabs.getByRole("tab", { name: "Councils" }).click();
  await expect(settings.getByText("No AI councils available")).toBeVisible();
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-channel-settings-empty-error.png");
  expect(runtimeErrors).toEqual([]);
});

test("resolved channel approval detail remains an in-feed inspector", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openChannelChatTools(page);

  const approvalBubble = page.locator(".message-bubble")
    .filter({ hasText: "Approval event" })
    .filter({ hasText: "Approval expired" });
  await approvalBubble.getByRole("button", { name: "Open approval" }).click();
  const inspector = page.locator(".conversation-detail-overlay");
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-ui2-channel-inline-detail", "true");
  await expect(inspector).toHaveAttribute("aria-label", "Approval details");
  await expect(page.getByRole("dialog", { name: "Approval details" })).toHaveCount(0);
  await inspector.getByRole("button", { name: "Close preview" }).click();
  await expect(inspector).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("channel dock reaches loaded, failure, and detail states across every launcher", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = [channelRootThread()];
  state.proposedPlans = [channelPlanFixture()];
  state.channelMessages = [channelFileReferenceMessage(), channelEvidenceMessage()];
  await mockDaemon(page, state);
  let workspaceChangesRequestCount = 0;
  await page.route(/\/workspace\/changes(?:\?.*)?$/u, async (route) => {
    workspaceChangesRequestCount += 1;
    if (workspaceChangesRequestCount > 1) {
      await route.fulfill({
        status: 503,
        json: { error: "mock_workspace_changes_failed", message: "Workspace review refresh failed." },
      });
      return;
    }
    await route.fulfill({ json: workspaceChangesFixture() });
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });

  await dock.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dock.locator(".workspace-change-file-section")).toHaveCount(2);
  await dock.getByRole("button", { name: "Changed file navigator" }).click();
  const navigator = dock.getByRole("complementary", { name: "Changed file navigator" });
  await expect(navigator).toBeVisible();
  await navigator.getByLabel("Filter files").fill("WorkspaceRightDock");
  await expect(navigator.getByRole("button", { name: /WorkspaceRightDock\.tsx/u })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-channel-dock-review-detail.png");
  await dock.locator(".workspace-change-review-toolbar").getByRole("button", { name: "Rescan changes", exact: true }).click();
  await expect(dock.getByText("Workspace review refresh failed.")).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Plans" }).click();
  const plan = dock.getByRole("button", { name: "Open plan detail Plan evidence fixture" });
  await expect(plan).toBeVisible();
  await plan.click();
  await expect(dock.locator(".right-dock-plan-detail")).toContainText("Long-form implementation evidence");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Files" }).click();
  const file = dock.getByRole("button", { name: /WorkspaceRightDock\.tsx/u });
  await expect(file).toBeVisible();
  await file.click();
  await expect(dock.locator(".right-dock-detail-list")).toContainText("WorkspaceRightDock.tsx");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Browser" }).click();
  const source = dock.getByRole("button", { name: /Ling UI 2\.0 source/u });
  await expect(source).toBeVisible();
  await source.click();
  await expect(dock.locator(".right-dock-detail-list")).toContainText("https://example.com/ling-ui2");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Activity" }).click();
  await expect(dock.getByRole("region", { name: "Channel inspector" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Terminal" }).click();
  await expect(dock.getByRole("region", { name: "Terminal session" })).toBeVisible();
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-channel-dock-deep-states.png");
  expect(runtimeErrors).toEqual([]);
});

async function openChannelSettings(page: Page): Promise<void> {
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Channel settings" })).toBeVisible();
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

function governanceNotification(): MockState["governanceNotifications"][number] {
  return {
    id: "governance_ui2_channel_overlay",
    workspaceId: "workspace_default",
    surface: { kind: "channel", channelId: "channel_engineering" },
    kind: "memory_candidate",
    severity: "action_required",
    title: "Memory candidate ready",
    summary: "A candidate from this channel is waiting for review.",
    sourceRefs: [{ type: "memory", id: "memory_candidate_ui2", label: "Memory candidate" }],
    targetRoute: {
      page: "memory_promotion_inbox",
      memoryId: "memory_candidate_ui2",
      channelId: "channel_engineering",
    },
    status: "unread",
    deliveryStatus: "pending",
    dedupeKey: "memory:memory_candidate_ui2:channel:channel_engineering",
    createdAt: "2026-07-19T03:00:00.000Z",
    updatedAt: "2026-07-19T03:01:00.000Z",
  };
}

function channelRootThread(): MockState["threads"][number] {
  return {
    id: "thread_channel_main_channel_engineering",
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Engineering discussion",
    objective: "Coordinate the channel.",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: "2026-07-19T03:00:00.000Z",
    updatedAt: "2026-07-19T03:00:00.000Z",
  };
}

function channelPlanFixture(): ProposedPlanArtifact {
  return {
    id: "plan_ui2_channel_evidence",
    workspaceId: "workspace_default",
    threadId: "thread_channel_main_channel_engineering",
    channelId: "channel_engineering",
    goalId: "goal_ui2_channel_evidence",
    planGroupId: "plan_group_ui2_channel_evidence",
    version: 1,
    title: "Plan evidence fixture",
    bodyMarkdown: "## Long-form implementation evidence\n\nVerify Settings, overlays, Dock pages, and visual containment.",
    status: "draft",
    createdAt: "2026-07-19T03:00:00.000Z",
    updatedAt: "2026-07-19T03:02:00.000Z",
  };
}

function channelEvidenceMessage(): MockState["channelMessages"][number] {
  return {
    id: "message_ui2_channel_evidence",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "thread_channel_main_channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "The UI 2.0 channel evidence is ready.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    webEvidence: {
      status: "available",
      query: "Ling UI 2.0",
      provider: {
        adapterId: "openai-responses-web-search",
        providerPresetId: "provider_ui2",
        displayName: "UI 2.0 evidence provider",
      },
      sources: [{
        url: "https://example.com/ling-ui2",
        title: "Ling UI 2.0 source",
        snippet: "Reachable browser evidence for the Dock detail state.",
      }],
      readUrls: [],
      updatedAt: "2026-07-19T03:03:00.000Z",
    },
    createdAt: "2026-07-19T03:03:00.000Z",
    updatedAt: "2026-07-19T03:03:00.000Z",
  };
}

function channelFileReferenceMessage(): MockState["channelMessages"][number] {
  return {
    id: "message_ui2_channel_file_reference",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "thread_channel_main_channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: "Review the referenced dock implementation.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [{
      path: "apps/web/src/features/workspace/right-dock/WorkspaceRightDock.tsx",
      label: "WorkspaceRightDock.tsx",
      line: 1,
    }],
    status: "ready",
    createdAt: "2026-07-19T03:02:30.000Z",
    updatedAt: "2026-07-19T03:02:30.000Z",
  };
}

function workspaceChangesFixture(): WorkspaceChangesResponse {
  const longLine = `export const channelRightDockEvidence = "${"reachable-state-".repeat(24)}";`;
  return {
    cwd: "/tmp/ling-stack-e2e",
    state: "dirty",
    repoRoot: "/tmp/ling-stack-e2e",
    branchName: "codex/ui2-channel-evidence",
    additions: 6,
    deletions: 2,
    files: [
      {
        path: "apps/web/src/features/workspace/right-dock/WorkspaceRightDock.tsx",
        kind: "modified",
        staged: false,
        unstaged: true,
        untracked: false,
        additions: 4,
        deletions: 1,
        diff: `@@ -1,2 +1,3 @@\n-old dock line\n+new dock line\n+${longLine}`,
        truncated: false,
      },
      {
        path: "apps/web/src/styles/channel-right-dock/review-details.css",
        kind: "added",
        staged: true,
        unstaged: false,
        untracked: false,
        additions: 2,
        deletions: 1,
        diff: "@@ -0,0 +1,2 @@\n+.right-dock-review-detail {\n+  min-width: 0;\n+}",
        truncated: false,
      },
    ],
    totalFileCount: 2,
    truncated: false,
    checkedAt: "2026-07-19T03:04:00.000Z",
  };
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
