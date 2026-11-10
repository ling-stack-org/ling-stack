import { expect, test } from "@playwright/test";
import type { BatchWindowHarness } from "./support/timeline-batch-window-harness";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

for (const [scope, nested] of [["normal", false], ["private", false], ["channel_root", true]] as const) {
  test(`simulation ${scope} locates batch atoms through disclosure and virtual recycling`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.evaluate(async ({ scope, nested }) => {
      const path = "/e2e/support/timeline-batch-window-harness.tsx";
      const harness = await import(path);
      window.batchWindowHarness = harness.mountBatchWindowFixture(scope, nested) as BatchWindowHarness;
    }, { scope, nested });
    await expect.poll(() => page.evaluate(() => window.batchWindowHarness.ready())).toBe(true);
    const root = page.locator("#batch-window-simulation");
    const timeline = root.locator('[data-conversation-timeline="true"]');
    const last = timeline.locator('[data-feed-item-id="command:1000"]');
    await expect(last).toHaveCount(0);
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:1000"))).toBe("revealed");
    await expect(last).toBeVisible();
    await expect(last).toBeFocused();
    await expect(timeline.locator(":scope > .conversation-timeline-virtualizer")).toHaveCount(1);
    await expect(timeline.locator(".conversation-timeline-virtualizer .conversation-timeline-virtualizer")).toHaveCount(0);
    const mountedCount = () => timeline.locator('[data-conversation-timeline-kind="commandExecution"]').count();
    expect(await mountedCount()).toBeLessThan(60);
    const lastTrigger = last.locator(".conversation-timeline-activity-main");
    await lastTrigger.click();
    await expect(lastTrigger).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:1"))).toBe("revealed");
    await expect(timeline.locator('[data-feed-item-id="command:1"]')).toBeVisible();
    await expect(last).toHaveCount(0);
    await page.evaluate(() => window.batchWindowHarness.revise());
    await expect(timeline).toHaveAttribute("data-conversation-canonical-revision", "2");
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:1000"))).toBe("revealed");
    await expect(lastTrigger).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("missing-action"))).toBe("not_found");
    expect(await mountedCount()).toBeLessThan(60);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.batchWindowHarness.dispose());
  });
}
