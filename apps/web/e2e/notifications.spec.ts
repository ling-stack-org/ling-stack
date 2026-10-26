import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidence = resolve("../../output/playwright/notifications");

test("daemon notification journal surfaces an in-app toast and preferences card", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState());
  await page.goto("/");

  // The bridge polls on mount; the mocked journal has one failed-run record.
  const toast = page.locator(".ling-ui-toast", { hasText: "自动化运行失败" });
  await expect(toast).toBeVisible({ timeout: 15_000 });

  // Preferences card lives in the startup diagnostics settings section.
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /^(Settings|设置)$/ }).click();
  await page.getByLabel(/^(Settings sections|设置分组)$/).getByRole("button", { name: /Startup and diagnostics|启动与诊断/u }).click();

  const card = page.locator(".notifications-preferences-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-ui2-notifications-preferences", "true");
  await expect(card.getByRole("switch", { name: "启用通知" })).toBeVisible();
  await expect(card.getByRole("combobox").first()).toBeVisible();

  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/notifications-preferences.png`, animations: "disabled", fullPage: true });
  expect(errors).toEqual([]);
});
