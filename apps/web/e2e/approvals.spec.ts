import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
} from "./support/mock-state";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
});

test("approval inbox shows expired approvals without decision buttons", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  await expect(page.locator(".approvals-panel").getByRole("heading", { name: "Inbox" })).toBeVisible();
  const approvalRows = page.locator(".approval-list .approval-row");
  await expect(approvalRows).toContainText("expired");
  await expect(approvalRows).toContainText("expired ");
  await expect(approvalRows.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(approvalRows.getByRole("button", { name: /Deny/ })).toHaveCount(0);
});

test("review queue resolves offline local approvals and refreshes state", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  state.approvals[0] = {
    ...state.approvals[0],
    runId: undefined,
    taskId: undefined,
    channelId: "channel_offline",
    title: "Approve offline shell command",
  };
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const approvalRows = page.locator(".approval-list .approval-row").filter({ hasText: "Approve offline shell command" });
  await expect(approvalRows).toContainText("pending");
  await expect(page.locator(".review-queue-summary")).toContainText("Offline local approval");

  await approvalRows.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => state.approvals[0]?.status).toBe("denied");
  await expect(approvalRows).toHaveCount(0);
  await expect(page.locator(".approval-list")).toContainText("Inbox is clear");

  await page.locator(".review-queue-empty-state").getByRole("button", { name: "Open Work Board" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
  await expect(page.locator(".settings-tool-return-row").getByRole("button", { name: "Back to workspace tools" })).toBeVisible();
});
