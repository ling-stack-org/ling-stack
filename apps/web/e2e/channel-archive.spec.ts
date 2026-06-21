import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, defaultRuntimePolicy } from "./support/mock-state";

test("channel branch list shows real branches without default branch chrome", async ({ page }) => {
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

  const navigation = page.getByLabel("Ling Stack navigation");
  const engineeringGroup = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  const engineeringRow = navigation.getByRole("button", { name: "Engineering" });
  await expect(engineeringRow).toBeVisible();

  await engineeringRow.click();
  await expect(engineeringGroup.getByRole("button", { name: /Main branch/ })).toHaveCount(0);
  await expect(navigation.locator(".sidebar-branch-list")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "API cleanup" })).toHaveCount(0);
  await page.mouse.move(640, 120);
  await expect.poll(async () => engineeringGroup.locator(".sidebar-row-tools").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
  await engineeringRow.hover();
  await expect.poll(async () => engineeringGroup.locator(".sidebar-row-tools").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("auto");
  await expect(engineeringGroup.getByRole("button", { name: "Create branch" })).toBeVisible();
  await engineeringGroup.getByRole("button", { name: "Create branch" }).click();
  await engineeringGroup.getByLabel("Branch name").fill("Quick split");
  await engineeringGroup.locator("form.sidebar-branch-create-form").getByRole("button", { name: "Create branch" }).click();
  await expect.poll(() => mockBranchStatus(state, "Quick split")).toBe("active");
  await expect(navigation.getByRole("button", { name: "Quick split" })).toBeVisible();
  await expect(navigation.locator(".sidebar-branch-list")).toHaveCount(1);
  await expect(engineeringGroup.getByRole("button", { name: /Main branch/ })).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  const archivedPanel = page.getByRole("region", { name: "Archived channels and branches" });
  await expect(archivedPanel).toContainText("Engineering / API cleanup");
  await expect(archivedPanel).toContainText("Engineering / Legacy split");
  await expect(archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / API cleanup" }).getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / Legacy split" }).getByRole("button", { name: "Delete" })).toBeVisible();

  await archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / API cleanup" }).getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => mockBranchStatus(state, "API cleanup")).toBe("active");
  await expect(archivedPanel).not.toContainText("Engineering / API cleanup");
  await expect(archivedPanel).toContainText("Engineering / Legacy split");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect(navigation.getByRole("button", { name: "API cleanup" })).toBeVisible();
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete branch Legacy split?");
    await dialog.accept();
  });
  await archivedPanel.locator(".archived-item-row").filter({ hasText: "Engineering / Legacy split" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mockBranchExists(state, "Legacy split")).toBe(false);
  await expect(archivedPanel).toContainText("No archived branches");

  await engineeringGroup.locator(".sidebar-row-main").click();
  await engineeringGroup.getByRole("button", { name: "Archive channel" }).click();
  await expect.poll(() => mockChannelStatus(state, "Engineering")).toBe("archived");
  await expect(navigation.getByRole("button", { name: "Engineering" })).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  await expect(archivedPanel).toContainText("Engineering");
  await expect(archivedPanel.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(archivedPanel.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("channel sidebar menu archives all active channels", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
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

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Design" })).toBeVisible();
  await navigation.getByRole("button", { name: "Channel actions" }).hover();
  await expect(navigation.getByRole("menuitem", { name: "Archive all channels" })).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Archive all channels?");
    await dialog.accept();
  });
  await navigation.getByRole("menuitem", { name: "Archive all channels" }).click();

  await expect.poll(() => mockChannelStatus(state, "Engineering")).toBe("archived");
  await expect.poll(() => mockChannelStatus(state, "Design")).toBe("archived");
  await expect(navigation.getByRole("button", { name: "Engineering" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Design" })).toHaveCount(0);
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
