import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";
import {
  readSidebarSelection,
} from "./support/test-helpers";

test("sidebar selection is exclusive and conversation lists no longer live in global navigation", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await expect(navigation.getByText("Ada")).toHaveCount(0);
  await expect(navigation.getByText("Tian")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation).toHaveClass(/channel-left-drawer/);
  await expect(page.locator(".channel-sidebar-toolbar")).toBeHidden();
  await expect(page.locator(".channel-left-drawer .primary-nav")).toHaveCSS("border-bottom-width", "0px");
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Engineering"] });

  await navigation.locator('.sidebar-row:has(.avatar-initial):has-text("Designer")').click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Designer"] });
  const selectedTeammateRow = page.locator(".channel-left-drawer .sidebar-row.selected");
  await expect(selectedTeammateRow).toHaveCSS("background-color", "rgb(245, 245, 245)");
  expect(await selectedTeammateRow.evaluate((row) => getComputedStyle(row, "::before").content)).toBe("none");
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
});

test("sidebar text entries route to context-aware inspectors", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "Search or start" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Image Generation" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Automations" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Profile" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Work Board" })).toHaveCount(0);
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Account and profile/ })).toBeVisible();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Account and profile/ }).click();
  await expect(page.getByRole("heading", { name: "Ling User", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
  await page.getByLabel("Settings sections").getByRole("button", { name: /Workspace tools/ }).click();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();
  await page.getByRole("button", { name: "Open AI Teammates" }).click();
  await expect(page.locator(".teammates-page-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();

  await navigation.getByRole("button", { name: "Image Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Generation task status")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
});

test("settings workspace tools provide a clear return path from nested tool pages", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ready",
    displayName: "Ready Relay",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_settings_designer",
    displayName: "Designer",
    providerPresetId: "provider_ready",
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();

  await page.getByRole("button", { name: "Open Model Workbench" }).click();
  await expect(page.locator(".provider-workbench-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to workspace tools" }).click();
  await expect(page.getByRole("button", { name: "Open Model Workbench" })).toBeVisible();

  await page.getByRole("button", { name: "Open AI Teammates" }).click();
  await expect(page.locator(".teammates-page-header.settings-return-mode .settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toHaveCount(0);
  await page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Designer" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
  await expect(page.locator(".teammate-chat-header.has-toolbar-start .settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace tools" }).click();
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toBeVisible();

  await page.getByRole("button", { name: "Open Work Board" }).click();
  await expect(page.locator(".work-board-settings-toolbar .settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await expect(page.locator(".work-board-page").getByRole("heading", { name: "Needs action" })).toHaveCount(0);
  await page.locator(".work-board-page").getByRole("button", { name: "Back to workspace tools" }).click();
  await expect(page.getByRole("button", { name: "Open Work Board" })).toBeVisible();

  await navigation.getByRole("button", { name: "Designer" }).click();
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to workspace tools" })).toHaveCount(0);
});
