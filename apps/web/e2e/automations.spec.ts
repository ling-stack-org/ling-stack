import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
} from "./support/mock-state";

test("automations page creates, previews, runs, links runs, and controls the local scheduler", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider()];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Automations" }).click();
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Templates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manual setup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create through chat" })).toBeVisible();
  await expect(page.getByLabel("Automation scheduler status")).toContainText("Stopped");

  await page.getByRole("button", { name: "Templates" }).click();
  const templateDialog = page.getByRole("dialog", { name: "Templates" });
  await expect(templateDialog.getByRole("button", { name: /Daily Brief/ })).toBeVisible();
  await expect(templateDialog.getByRole("button", { name: /Weekly Review/ })).toBeVisible();
  await templateDialog.getByRole("button", { name: /Daily Brief/ }).click();
  await expect.poll(() => state.automationDrafts.length).toBe(1);
  await expect.poll(() => state.automations.length).toBe(0);
  await expect(page.locator(".automation-detail-panel").getByRole("heading", { name: "Draft review" })).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".automation-preview pre")).toContainText("Ship automations P0 and P1");

  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => state.automations.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Daily Brief" })).toBeVisible();
  await expect(page.getByText("No runs yet")).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".automation-preview pre")).toContainText("Ship automations P0 and P1");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => state.automationRuns.length).toBe(1);
  await expect(page.getByText("Recent automation runs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open run" })).toBeVisible();
  await page.getByRole("button", { name: "Open run" }).click();
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Automation context: Daily Brief/ })).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Automations" }).click();
  await page.getByRole("button", { name: "Daily 09:00" }).click();
  await page.getByLabel("Automation scheduler status").getByRole("button", { name: "Start" }).click();
  await expect.poll(() => state.automationSchedulerStartCalls).toBe(1);
  await expect(page.getByLabel("Automation scheduler status")).toContainText("running");
  await page.getByLabel("Automation scheduler status").getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => state.automationSchedulerStopCalls).toBe(1);
  await expect(page.getByLabel("Automation scheduler status")).toContainText("stopped");
});
