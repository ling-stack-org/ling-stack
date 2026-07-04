import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
} from "./support/mock-state";
import {
  openChannelChatTools,
} from "./support/test-helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
});

test("work board merges durable items and supports claim heartbeat", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.workItems = [
    {
      id: "work_item_inspect",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceType: "channel_task",
      sourceId: "task_inspect",
      title: "Durable inspect handoff",
      description: "Durable row overrides the derived task row.",
      status: "ready",
      priority: "high",
      labels: ["durable-ledger"],
      taskId: "task_inspect",
      artifactIds: [],
      proofArtifactIds: [],
      dependencyIds: [],
      attemptCount: 0,
      retryBudget: 2,
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const channelBoard = page.getByLabel("Channel Work Board");
  await expect(channelBoard).toContainText("Durable inspect handoff");
  await expect(channelBoard).toContainText("durable");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Configuration/ }).click();
  await page.getByRole("button", { name: "Open Work Board" }).click();
  await expect(page.locator(".work-board-settings-toolbar .settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
  await expect(page.locator(".work-board-page").getByRole("heading", { name: "Needs action" })).toHaveCount(0);
  await page.getByLabel("Work board views").getByRole("button", { name: "All active" }).click();
  await expect(page.locator(".work-board-page").getByRole("heading", { name: "All active work" })).toHaveCount(0);
  await page.getByLabel("Work board views").getByRole("button", { name: "History" }).click();
  await expect(page.locator(".work-board-page").getByRole("heading", { name: "Work history" })).toHaveCount(0);
  await page.getByLabel("Work board views").getByRole("button", { name: "Needs action" }).click();
  const durableRow = page.locator(".work-item-row").filter({ hasText: "Durable inspect handoff" });
  await expect(durableRow).toContainText("durable");
  await expect(durableRow).toContainText("Claim to handle");

  await durableRow.getByRole("button", { name: "Claim" }).click();
  await expect.poll(() => state.workItems[0]?.claim?.ownerId).toBe("web-user");
  await expect(durableRow).toContainText("claimed by web-user");
  await expect(durableRow).toContainText("Work is claimed");

  await durableRow.getByRole("button", { name: "Refresh claim" }).click();
  await expect.poll(() => state.workItems[0]?.claim?.heartbeatAt).toBe("2026-06-07T00:01:00.000Z");
  await expect(durableRow).toContainText("claimed by web-user");
});
