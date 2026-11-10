import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";

for (const scope of ["normal", "private", "channel_root"] as const) {
test(`${scope}: a focused command keeps its keyboard owner when its virtual row scrolls offscreen`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await page.evaluate(async ({ scope }) => {
    const path = "/e2e/support/timeline-batch-window-harness.tsx";
    const harness = await import(path);
    window.batchWindowHarness = harness.mountBatchWindowFixture(scope, scope === "channel_root");
  }, { scope });
  try {
    await expect.poll(() => page.evaluate(() => window.batchWindowHarness.ready())).toBe(true);
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:1000"))).toBe("revealed");
    const root = page.locator("#batch-window-simulation");
    const trigger = root.locator('[data-feed-item-id="command:1000"] .conversation-timeline-activity-main');
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await root.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    await expect(root.locator('[data-feed-item-id="command:1"]')).toBeVisible();
    await page.screenshot({ path: info.outputPath("focused-row-after-window-scroll.png") });
    await expect(trigger).toBeFocused();
    expect(await root.locator('[data-conversation-timeline-kind="commandExecution"]').count()).toBeLessThan(60);
    await page.evaluate(() => window.batchWindowHarness.revise());
    await expect(trigger).toBeFocused();
    const first = root.locator('[data-feed-item-id="command:1"] .conversation-timeline-activity-main');
    await first.focus();
    await expect(first).toBeFocused();
    await expect(trigger).toHaveCount(0);
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:1000"))).toBe("revealed");
    await trigger.focus();
    await root.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    await expect(first).toBeVisible();
    await expect(trigger).toBeFocused();
    await root.evaluate(element => { element.tabIndex = 0; element.focus({ preventScroll: true }); });
    await expect(root).toBeFocused();
    await expect(trigger).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.batchWindowHarness.dispose());
  }
});
}

test("Chinese child lifecycle and batch groups expose localized accessible names", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/e2e/support/timeline-batch-window-harness.tsx";
    window.batchWindowHarness = (await import(path)).mountBatchWindowFixture("channel_root", true);
  });
  try {
    const root = page.locator("#batch-window-simulation");
    const header = root.locator(".conversation-timeline-sub-agent-head");
    await expect(header).toBeVisible();
    await page.screenshot({ path: info.outputPath("chinese-child-collapsed.png") });
    await expect.soft(header).toHaveAccessibleName(/Engineer.*已完成/u);
    await expect.soft(header).not.toHaveAttribute("aria-controls", /.+/u);
    await header.click();
    await expect.soft(root.locator('[data-conversation-sub-agent-group]')).toHaveAccessibleName("Engineer");
    await root.locator(".conversation-command-batch-header").click();
    await expect.soft(root.locator('[data-conversation-batch-group]')).toHaveAccessibleName("已运行 1000 个命令");
    await page.screenshot({ path: info.outputPath("chinese-child-expanded.png") });
  } finally {
    await page.evaluate(() => window.batchWindowHarness.dispose());
  }
});

test("Chinese process disclosure exposes a localized group name", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: /打开最近对话 \d+/u }).filter({ hasText: title }).click();
  await page.locator('[data-conversation-process-header]').first().click();
  await page.screenshot({ path: info.outputPath("chinese-process-expanded.png") });
  await expect(page.locator('[data-conversation-process-group]').first()).toHaveAccessibleName("执行详情");
});
