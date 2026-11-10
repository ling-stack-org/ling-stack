import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, defaultRuntimePolicy } from "./support/mock-state";

function channelComposerTextbox(scope: Page | Locator): Locator {
  return scope.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });
}

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

async function openArchivedItemsSettings(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
}

test("channel sessions retain the default and named conversations through legacy archive and restore", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelBranches = [
    {
      id: "channel_branch_restore",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      name: "API cleanup",
      status: "archived",
      createdAt: "2026-05-25T01:00:00.000Z",
      updatedAt: "2026-05-25T01:05:00.000Z",
      archivedAt: "2026-05-25T01:05:00.000Z",
    },
    {
      id: "channel_branch_delete",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      name: "Legacy split",
      status: "archived",
      createdAt: "2026-05-25T01:10:00.000Z",
      updatedAt: "2026-05-25T01:15:00.000Z",
      archivedAt: "2026-05-25T01:15:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const engineeringGroup = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  const engineeringRow = navigation.getByRole("button", { name: "Engineering", exact: true });
  await expect(engineeringRow).toBeVisible();

  await engineeringRow.click();
  await expect(engineeringGroup.getByRole("button", { name: /Main branch/ })).toHaveCount(0);
  await expect(engineeringGroup.locator('[data-session-default="true"]')).toBeVisible();
  await engineeringGroup.getByRole("button", { name: "Collapse conversations: Engineering", exact: true }).click();
  await expect(engineeringGroup.locator(".sidebar-branch-list")).toHaveCount(0);
  await engineeringGroup.getByRole("button", { name: "Expand conversations: Engineering", exact: true }).click();
  await expect(engineeringGroup.locator('[data-session-default="true"]')).toBeVisible();
  await expect(navigation.getByRole("button", { name: "API cleanup" })).toHaveCount(0);
  await page.mouse.move(640, 120);
  await expect.poll(async () => engineeringGroup.locator(".sidebar-channel-container-row .sidebar-row-tools").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("auto");
  await engineeringRow.hover();
  await expect.poll(async () => engineeringGroup.locator(".sidebar-channel-container-row .sidebar-row-tools").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("auto");
  await expect(engineeringGroup.getByRole("button", { name: "New conversation in Engineering", exact: true })).toBeVisible();
  await engineeringGroup.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Quick split");
  await channelComposerTextbox(page).fill("Branch-scoped message");
  await page.locator(".channel-composer").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => mockBranchStatus(state, "Quick split")).toBe("active");
  await expect(navigation.getByRole("button", { name: "Quick split", exact: true })).toBeVisible();
  await expect(navigation.locator(".sidebar-branch-list")).toHaveCount(1);
  await expect(engineeringGroup.getByRole("button", { name: /Main branch/ })).toHaveCount(0);
  const quickSplitBranch = state.channelBranches.find((item) => isRecord(item) && item.name === "Quick split");
  expect(isRecord(quickSplitBranch) && typeof quickSplitBranch.rootThreadId === "string").toBe(true);
  const quickSplitRootThreadId = isRecord(quickSplitBranch) && typeof quickSplitBranch.rootThreadId === "string" ? quickSplitBranch.rootThreadId : "";
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({ kind: "thread", threadId: quickSplitRootThreadId });

  await openArchivedItemsSettings(page);
  const archivedSettings = page.locator(".archived-items-settings-panel");
  await archivedSettings.getByRole("tab", { name: /Branches/ }).click();
  const archivedPanel = archivedSettings.locator(".archived-item-list");
  await expect(archivedPanel).toContainText("Engineering / API cleanup");
  await expect(archivedPanel).toContainText("Engineering / Legacy split");
  await expect(archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / API cleanup" }).getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / Legacy split" }).getByRole("button", { name: "Delete" })).toBeVisible();

  await archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / API cleanup" }).getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => mockBranchStatus(state, "API cleanup")).toBe("active");
  await expect(archivedPanel).not.toContainText("Engineering / API cleanup");
  await expect(archivedPanel).toContainText("Engineering / Legacy split");
  await page.getByRole("button", { name: "Back to app" }).click();
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(navigation.getByRole("button", { name: "API cleanup", exact: true })).toBeVisible();
  await openArchivedItemsSettings(page);

  await archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / Legacy split" }).getByRole("button", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete branch Engineering / Legacy split?" });
  await expect(deleteDialog).toContainText("This cannot be undone");
  await deleteDialog.getByRole("button", { name: "Delete branch", exact: true }).click();
  await expect.poll(() => mockBranchExists(state, "Legacy split")).toBe(false);
  await expect(archivedPanel).toContainText("No archived branches");

  await page.getByRole("button", { name: "Back to app" }).click();
  await engineeringGroup.locator(".sidebar-row-main").click();
  await engineeringGroup.getByRole("button", { name: "Channel actions: Engineering", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive channel", exact: true }).click();
  await expect.poll(() => mockChannelStatus(state, "Engineering")).toBe("archived");
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toHaveCount(0);

  await openArchivedItemsSettings(page);
  await archivedSettings.getByRole("tab", { name: /Channels/ }).click();
  const archivedChannelsPanel = archivedSettings.locator(".archived-item-list");
  await expect(archivedChannelsPanel).toContainText("Engineering");
  await expect(archivedChannelsPanel.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(archivedChannelsPanel.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("channel sidebar menu keeps create action without bulk archive", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Design", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Channel actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Archive all channels" })).toHaveCount(0);
  await expect.poll(() => mockChannelStatus(state, "Engineering")).toBe("active");
  await expect.poll(() => mockChannelStatus(state, "Design")).toBe("active");
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Design", exact: true })).toBeVisible();
});

function mockChannelStatus(state: ReturnType<typeof createBaseState>, name: string): string | undefined {
  const channel = state.channels.find((item) => isRecord(item) && item.name === name);
  return isRecord(channel) && typeof channel.status === "string" ? channel.status : undefined;
}

function mockBranchStatus(state: ReturnType<typeof createBaseState>, name: string): string | undefined {
  const branch = state.channelBranches.find((item) => isRecord(item) && item.name === name);
  return isRecord(branch) && typeof branch.status === "string" ? branch.status : undefined;
}

function mockBranchExists(state: ReturnType<typeof createBaseState>, name: string): boolean {
  return state.channelBranches.some((item) => isRecord(item) && item.name === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
