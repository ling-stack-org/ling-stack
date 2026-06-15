import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
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
  await navigation.getByRole("button", { name: "AI Teammates" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["AI Teammates"], selectedRows: [] });
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(navigation).toHaveClass(/channel-left-drawer/);
  await expect(page.locator(".channel-sidebar-toolbar")).toBeVisible();
  await expect(page.locator(".channel-left-drawer .primary-nav")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".channel-left-drawer .sidebar-row.selected")).toHaveCount(0);

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
  await expect(navigation.locator(".primary-nav .nav-item").filter({ hasText: "Model Workbench" })).toHaveCount(1);
  await expect(navigation.locator(".config-grid").getByRole("button", { name: "Model Workbench" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Generation" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Settings" })).toBeVisible();

  await navigation.locator(".primary-nav .nav-item").filter({ hasText: "Model Workbench" }).click();
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: ["Model Workbench"], selectedRows: [] });
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Model Workbench context")).toHaveCount(0);
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByRole("heading", { name: "External work" })).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Generation task status")).toBeVisible();
  await expect(page.getByLabel("Run context")).toHaveCount(0);
});
