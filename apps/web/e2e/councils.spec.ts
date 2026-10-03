import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";

async function openCouncilWorkspace(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace" }).click();
}

test("Council Workspace keeps no-available-member copy compact in Chinese", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_builtin_designer", displayName: "Designer", roleKey: "designer" }),
    createMockTeammate({ id: "teammate_builtin_qa", displayName: "QA", roleKey: "qa" }),
  ];
  state.aiCouncils = state.aiCouncils.map((council) =>
    council.id === "council_builtin_development" ? { ...council, source: "user" } : council
  );
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
    {
      councilId: "council_builtin_development",
      teammateId: "teammate_builtin_designer",
      slotKey: "product_design",
      label: "Product design",
      position: 1,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
    {
      councilId: "council_builtin_development",
      teammateId: "teammate_builtin_qa",
      slotKey: "verification",
      label: "Verification",
      position: 2,
      enabled: true,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
  ];

  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Council Workspace|智囊团工作区/ }).click();

  const emptyPrompt = page.locator(".council-members-candidate-empty");
  await expect(emptyPrompt).toContainText("没有可添加的队友");
  await expect(emptyPrompt).toContainText("先创建或取消隐藏队友，再添加到此智囊团。");
  const promptLayout = await emptyPrompt.evaluate((element) => {
    const title = element.querySelector(".ling-ui-empty-state-title");
    const copy = element.querySelector(".ling-ui-empty-state-copy");
    return {
      height: element.getBoundingClientRect().height,
      titleWidth: title?.getBoundingClientRect().width ?? 0,
      titleHeight: title?.getBoundingClientRect().height ?? 0,
      copyDisplay: copy ? getComputedStyle(copy).display : "",
      gridColumns: getComputedStyle(element).gridTemplateColumns,
    };
  });
  expect(promptLayout.height).toBeLessThanOrEqual(72);
  expect(promptLayout.titleWidth).toBeGreaterThan(90);
  expect(promptLayout.titleHeight).toBeLessThanOrEqual(24);
  expect(promptLayout.copyDisplay).toBe("grid");
  expect(promptLayout.gridColumns).not.toMatch(/^24px/);
});

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

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await openCouncilWorkspace(page);
  await expect(page.locator(".council-workspace-page[aria-label='Council Workspace']")).toBeVisible();
  await expect(page.locator("[data-desktop-window-titlebar-surface='true']").getByRole("heading", { name: "Council Workspace", level: 1 })).toHaveCount(1);
  await expect(page.locator(".council-workspace-page > .council-workspace-header")).toHaveCount(0);
  await expect(page.locator("[data-desktop-window-titlebar-surface='true']").getByText("Manage councils, members, health, and channel usage from one workspace.")).toHaveCount(1);
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace" })).toHaveClass(/active/);
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create council" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Refresh councils" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open AI Teammates" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clone to customize" })).toBeVisible();
  await expect(page.getByLabel("Council overview")).toHaveCount(0);
  await expect(page.getByText("Manage advisor councils")).toHaveCount(0);
  await expect(page.getByText("Health filter")).toBeHidden();
  await expect(page.locator(".council-workspace-list")).toContainText("Development Council");
  await expect(page.locator(".council-workspace-list")).not.toContainText("Engineering, design, and QA specialists");
  await expect(page.locator(".council-workspace-grid")).toHaveCSS("grid-template-columns", /286px/);
  await expect(page.getByLabel("Selected council")).not.toContainText("Engineering, design, and QA specialists");
  await expect(page.getByLabel("Council members")).toContainText("Ling Engineer");
  await expect(page.getByLabel("Council members")).toContainText("Engineer");
  await expect(page.locator(".council-health-strip")).toContainText("Health clear");
  await expect(page.getByLabel("Channel usage")).toHaveCount(0);
  await expect(page.getByLabel("Council settings")).toHaveCount(0);
  await expect(page.getByLabel("Add teammate to council")).toHaveCount(0);
  await expect(page.getByText("Built-in councils must be cloned before editing", { exact: true })).toBeVisible();
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

  const councilList = page.locator(".council-workspace-list");
  await councilList.getByRole("button", { name: "Create council" }).click();
  const createCouncilDialog = page.getByRole("dialog", { name: "Create council" });
  await expect(createCouncilDialog).toBeVisible();
  await createCouncilDialog.getByLabel("New council name").fill("Design Council");
  await createCouncilDialog.getByLabel("New council description").fill("Design review collective");
  await createCouncilDialog.getByRole("checkbox", { name: "Ling Designer" }).check();
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
  await expect(councilSettings).toContainText("Custom");
  await expect(councilSettings.getByLabel("Council boundaries")).toContainText("Reference collection");
  await expect(councilSettings.getByLabel("Council name")).toHaveValue("Design Council");
  await councilSettings.getByLabel("Council name").fill("Design Council Ops");
  await councilSettings.getByLabel("Council description").fill("Design review collective updated");
  await councilSettings.getByRole("switch", { name: "Pin council" }).click();
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

  await page.locator(".council-workspace-list").getByRole("option", { name: /Development Council/ }).click();
  await page.getByRole("tab", { name: "Council settings" }).click();
  await expect(councilSettings).toContainText("Built-in");
  await expect(councilSettings.getByLabel("Council name")).toHaveCount(0);
  await expect(councilSettings.getByRole("button", { name: "Save council settings" })).toHaveCount(0);
  await expect(councilSettings.getByRole("button", { name: "Pause council" })).toHaveCount(0);
  councilActions = page.getByLabel("Council actions");
  await expect(councilSettings.getByRole("button", { name: "Archive council" })).toHaveCount(0);
  await councilSettings.getByText("More council actions").click();
  await councilActions.getByRole("button", { name: "Clone council" }).click();
  const cloneCouncilDialog = page.getByRole("dialog", { name: "Review council clone" });
  await expect(cloneCouncilDialog).toContainText("Members and routing will be copied");
  await expect(cloneCouncilDialog).toContainText("Channel attachments will not be copied");
  await cloneCouncilDialog.getByRole("button", { name: "Clone council" }).click();
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
  await councilSettings.getByRole("button", { name: "Archive council" }).click();
  const archiveCouncilDialog = page.getByRole("dialog", { name: "Archive council" });
  await expect(archiveCouncilDialog).toContainText("Copy of Development Council");
  await archiveCouncilDialog.getByRole("button", { name: "Archive council" }).click();
  await expect.poll(() => {
    const archived = state.aiCouncils.find((item) => isRecord(item) && item.id === clonedCouncilId);
    return isRecord(archived) ? String(archived.status) : "missing";
  }).toBe("archived");
  await expect(page.locator(".council-workspace-list").getByRole("option", { name: /Copy of Development Council/ })).toHaveCount(0);

  await page.getByRole("tab", { name: "Council members" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();

  await page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await page.getByRole("tab", { name: "Channel usage" }).click();
  await page.getByLabel("Channel usage").getByRole("button", { name: "Open channel in app" }).click();
  await expect(navigation.locator(".sidebar-row-shell.selected")).toContainText("Engineering");
  expect(state.teammateChannelMemberships).toHaveLength(originalChannelMembershipCount);
});
