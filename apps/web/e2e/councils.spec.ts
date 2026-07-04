import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";

async function openCouncilWorkspace(page: Page): Promise<void> {
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open Council Workspace" }).click();
}

test("Council Workspace shows council health, members, and channel entry points", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_builtin_designer", displayName: "Ling Designer", roleKey: "designer" }),
    createMockTeammate({ id: "teammate_builtin_qa", displayName: "Ling QA", roleKey: "qa" }),
    createMockTeammate({
      id: "ling_agent",
      templateId: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      protectedProfile: true,
      displayName: "Ling Agent",
      roleKey: "custom",
    }),
  ];
  state.aiCouncilMembers = [
    {
      councilId: "council_builtin_development",
      teammateId: "teammate_builtin_engineer",
      slotKey: "implementation",
      label: "Implementation",
      position: 0,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];
  const originalChannelMembershipCount = state.teammateChannelMemberships.length;

  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await openCouncilWorkspace(page);
  await expect(page.getByRole("heading", { name: "Council Workspace", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await expect(page.getByLabel("Council overview")).toHaveCount(0);
  await expect(page.getByText("Manage advisor councils")).toHaveCount(0);
  await expect(page.getByText("Health filter")).toBeHidden();
  await expect(page.locator(".council-workspace-list")).toContainText("Development Council");
  await expect(page.locator(".council-workspace-list")).not.toContainText("Engineering, design, and QA specialists");
  await expect(page.locator(".council-workspace-grid")).toHaveCSS("grid-template-columns", /286px/);
  await expect(page.getByLabel("Selected council")).not.toContainText("Engineering, design, and QA specialists");
  await expect(page.getByLabel("Council members")).toContainText("Ling Engineer");
  await expect(page.getByLabel("Council members")).toContainText("Implementation");
  await expect(page.locator(".council-health-strip")).toContainText("Health clear");
  await expect(page.getByLabel("Channel usage")).toHaveCount(0);
  await expect(page.getByLabel("Council settings")).toHaveCount(0);
  await expect(page.getByLabel("Add teammate to council").locator("option", { hasText: "Ling Agent" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Channel usage" }).click();
  const channelUsage = page.getByLabel("Channel usage");
  await expect(channelUsage.getByLabel("Select channel for council")).toHaveValue("channel_engineering");
  await expect(channelUsage).toContainText("No AI councils attached");
  await channelUsage.getByRole("button", { name: "Attach selected council" }).click();
  await expect.poll(() => {
    const policy = state.channelCouncilPolicies.find((item) => isRecord(item) && item.channelId === "channel_engineering");
    return isRecord(policy) && Array.isArray(policy.attachedCouncilIds) ? policy.attachedCouncilIds.join(",") : "";
  }).toBe("council_builtin_development");
  await expect(channelUsage).toContainText("Development Council");
  await expect(channelUsage).toContainText("Preferred");
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);

  await page.getByRole("tab", { name: "Council members" }).click();
  await page.getByLabel("Add teammate to council").selectOption("teammate_builtin_designer");
  await page.getByRole("button", { name: "Add member" }).click();
  const designerRow = page.locator(".council-member-row").filter({ hasText: "Ling Designer" });
  await expect(designerRow).toBeVisible();
  await expect(designerRow.locator(".teammate-council-status.enabled")).toHaveCount(0);
  await expect.poll(() => state.aiCouncilMembers.filter((item) => isRecord(item) && item.councilId === "council_builtin_development").length).toBe(2);
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);

  await designerRow.getByRole("button", { name: "Disable" }).click();
  await expect(designerRow.locator(".teammate-council-status.disabled")).toContainText("Disabled");
  await expect(page.locator(".council-health-strip")).toContainText("1 info finding(s)");
  await page.getByLabel("Filter councils by health").selectOption("info");
  await expect(page.locator(".council-workspace-list")).toContainText("Development Council");
  await page.getByLabel("Filter councils by health").selectOption("all");

  await designerRow.getByLabel("Move council member up").click();
  await expect.poll(() => {
    const members = state.aiCouncilMembers
      .filter((item) => isRecord(item) && item.councilId === "council_builtin_development")
      .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
    return isRecord(members[0]) ? members[0].teammateId : "missing";
  }).toBe("teammate_builtin_designer");

  await designerRow.getByLabel("Remove council member").click();
  await expect(designerRow).toHaveCount(0);
  await expect.poll(() => state.aiCouncilMembers.some((item) => isRecord(item) && item.teammateId === "teammate_builtin_designer")).toBe(false);
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);

  const councilList = page.locator(".council-workspace-list");
  await councilList.getByRole("button", { name: "Create council" }).click();
  const createCouncilDialog = page.getByRole("dialog", { name: "Create council" });
  await expect(createCouncilDialog).toBeVisible();
  await createCouncilDialog.getByLabel("New council name").fill("Design Council");
  await createCouncilDialog.getByLabel("New council description").fill("Design review collective");
  await createCouncilDialog.getByRole("button", { name: "Create council" }).click();
  await expect.poll(() => {
    const created = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Design Council");
    return isRecord(created) ? String(created.id) : "";
  }).not.toBe("");
  await expect(createCouncilDialog).toHaveCount(0);
  await expect(page.locator(".council-workspace-list")).toContainText("Design Council");
  await expect(page.getByLabel("Selected council")).toContainText("Design Council");

  await page.getByRole("tab", { name: "Council settings" }).click();
  const councilSettings = page.getByLabel("Council settings");
  let councilActions = page.getByLabel("Council actions");
  await expect(councilSettings).toContainText("Editable for custom councils");
  await expect(councilSettings.getByLabel("Council boundaries")).toContainText("Reference collection");
  await expect(councilSettings.getByLabel("Council name")).toHaveValue("Design Council");
  await councilSettings.getByLabel("Council name").fill("Design Council Ops");
  await councilSettings.getByLabel("Council description").fill("Design review collective updated");
  await councilSettings.getByLabel("Pin council").check();
  await councilSettings.getByRole("button", { name: "Save council settings" }).click();
  await expect.poll(() => {
    const updated = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Design Council Ops");
    return isRecord(updated) ? [updated.description, updated.pinned].join(":") : "";
  }).toBe("Design review collective updated:true");
  await expect(page.getByLabel("Selected council")).toContainText("Design Council Ops");

  await councilSettings.getByRole("button", { name: "Pause council" }).click();
  await expect.poll(() => {
    const paused = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Design Council Ops");
    return isRecord(paused) ? String(paused.status) : "missing";
  }).toBe("paused");
  await expect(page.getByLabel("Selected council")).toContainText("paused");
  await councilSettings.getByRole("button", { name: "Resume council" }).click();
  await expect.poll(() => {
    const resumed = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Design Council Ops");
    return isRecord(resumed) ? String(resumed.status) : "missing";
  }).toBe("active");

  await page.locator(".council-workspace-list").getByRole("button", { name: /Development Council/ }).click();
  await page.getByRole("tab", { name: "Council settings" }).click();
  await expect(councilSettings).toContainText("Built-in councils must be cloned before editing");
  await expect(councilSettings.getByLabel("Council name")).toBeDisabled();
  await expect(councilSettings.getByRole("button", { name: "Save council settings" })).toBeDisabled();
  await expect(councilSettings.getByRole("button", { name: "Pause council" })).toBeDisabled();
  await expect(councilActions.getByRole("button", { name: "Archive council" })).toBeDisabled();
  await councilActions.getByRole("button", { name: "Clone council" }).click();
  await expect.poll(() => {
    const cloned = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Copy of Development Council");
    return isRecord(cloned) ? String(cloned.id) : "";
  }).not.toBe("");
  const clonedCouncil = state.aiCouncils.find((item) => isRecord(item) && item.displayName === "Copy of Development Council");
  const clonedCouncilId = isRecord(clonedCouncil) ? String(clonedCouncil.id) : "";
  await expect(page.locator(".council-workspace-list")).toContainText("Copy of Development Council");
  await expect.poll(() =>
    state.aiCouncilMembers.some((item) => isRecord(item) && item.councilId === clonedCouncilId && item.teammateId === "teammate_builtin_engineer")
  ).toBe(true);
  await expect.poll(() =>
    state.aiCouncilMembers.some((item) => isRecord(item) && item.councilId === clonedCouncilId && item.teammateId === "ling_agent")
  ).toBe(false);

  await page.getByRole("tab", { name: "Council settings" }).click();
  councilActions = page.getByLabel("Council actions");
  await councilActions.getByRole("button", { name: "Archive council" }).click();
  await expect.poll(() => {
    const archived = state.aiCouncils.find((item) => isRecord(item) && item.id === clonedCouncilId);
    return isRecord(archived) ? String(archived.status) : "missing";
  }).toBe("archived");
  await expect(page.locator(".council-workspace-list").getByRole("button", { name: /Copy of Development Council/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Open AI Teammates" }).click();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace tools" }).click();

  await page.getByRole("button", { name: "Open Council Workspace" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await page.getByRole("tab", { name: "Channel usage" }).click();
  await page.getByLabel("Channel usage").getByRole("button", { name: "Open channel" }).click();
  await expect(navigation.locator(".sidebar-row-shell.selected")).toContainText("Engineering");
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);
});
