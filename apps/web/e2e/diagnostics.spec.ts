import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidence = resolve("../../output/playwright/diagnostics");

test("startup diagnostics panel shows daemon doctor checks and log tail", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockDaemon(page, createBaseState());
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /^(Settings|设置)$/ }).click();
  const sections = page.getByLabel(/^(Settings sections|设置分组)$/);
  await expect(sections).toBeVisible();
  await sections.getByRole("button", { name: /Startup and diagnostics|启动与诊断/u }).click();

  const card = page.locator(".diagnostics-doctor-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-ui2-diagnostics-doctor", "true");
  await expect(card.locator(".diagnostics-doctor-check")).toHaveCount(4);
  await expect(card.locator('.diagnostics-doctor-check[data-status="ok"]')).toHaveCount(4);
  await expect(card.locator(".diagnostics-doctor-heading")).toContainText(/All checks passed|全部检查通过/u);

  const logSection = card.locator(".diagnostics-doctor-log-section");
  await logSection.locator("summary").click();
  await expect(logSection.locator(".diagnostics-doctor-log-lines")).toContainText("daemon listening on 127.0.0.1:17891");

  await expect(page.locator(".settings-startup-diagnostics")).toBeVisible();
  await mkdirIfMissing();
  await page.screenshot({ path: `${evidence}/diagnostics-healthy.png`, animations: "disabled", fullPage: true });
  expect(errors).toEqual([]);
});

async function mkdirIfMissing(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(evidence, { recursive: true });
}
