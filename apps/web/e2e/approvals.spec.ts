import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
} from "./support/mock-state";

test("approval inbox shows expired approvals without decision buttons", async ({ page }) => {
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Approval requests" })).toBeVisible();
  const approvalRows = page.getByLabel("Approval requests").locator(".approval-row");
  await expect(approvalRows).toContainText("expired");
  await expect(approvalRows).toContainText("expired ");
  await expect(approvalRows.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(approvalRows.getByRole("button", { name: /Deny/ })).toHaveCount(0);
});

test("approval inbox resolves pending approvals and refreshes state", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const approvalRows = page.getByLabel("Approval requests").locator(".approval-row");
  await expect(approvalRows).toContainText("pending");

  await approvalRows.getByRole("button", { name: "Deny" }).click();
  await expect(approvalRows).toContainText("denied");
  await expect.poll(() => state.approvals[0]?.status).toBe("denied");
});
