import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

test("channel branch and channel archive lifecycle is managed from sidebar and settings", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const engineeringGroup = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  const engineeringRow = navigation.getByRole("button", { name: "Engineering" });
  await expect(engineeringRow).toBeVisible();

  await engineeringRow.click();
  await expect(engineeringGroup.getByRole("button", { name: /Main branch/ })).toBeVisible();

  await engineeringRow.hover();
  await navigation.getByRole("button", { name: "Create branch" }).click();
  await navigation.getByLabel("Branch name").fill("API cleanup");
  await navigation.locator("form.sidebar-branch-create-form").getByRole("button", { name: "Create branch" }).click();

  const branchRow = navigation.getByRole("button", { name: "API cleanup" });
  const branchShell = navigation.locator(".sidebar-branch-row-shell").filter({ hasText: "API cleanup" });
  await expect(branchRow).toBeVisible();
  await branchShell.hover();
  await branchShell.getByRole("button", { name: "Archive branch" }).click();
  await expect.poll(() => mockBranchStatus(state, "API cleanup")).toBe("archived");
  await expect(branchRow).toHaveCount(0);

  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  const archivedPanel = page.getByRole("region", { name: "Archived channels and branches" });
  await expect(archivedPanel).toContainText("Engineering / API cleanup");
  await expect(archivedPanel.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(archivedPanel.getByRole("button", { name: "Delete" })).toBeVisible();

  await archivedPanel.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => mockBranchStatus(state, "API cleanup")).toBe("active");
  await expect(archivedPanel).toContainText("No archived branches");
  await expect(navigation.getByRole("button", { name: "API cleanup" })).toBeVisible();

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

function mockChannelStatus(state: ReturnType<typeof createBaseState>, name: string): string | undefined {
  const channel = state.channels.find((item) => isRecord(item) && item.name === name);
  return isRecord(channel) && typeof channel.status === "string" ? channel.status : undefined;
}

function mockBranchStatus(state: ReturnType<typeof createBaseState>, name: string): string | undefined {
  const branch = state.channelBranches.find((item) => isRecord(item) && item.name === name);
  return isRecord(branch) && typeof branch.status === "string" ? branch.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
