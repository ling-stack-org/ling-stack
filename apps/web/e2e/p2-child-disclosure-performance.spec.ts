import { expect, test } from "@playwright/test";
import { measureTranscriptDisclosure } from "./support/transcript-disclosure-performance";

test("500 factual child operations retain the existing disclosure budget and one root window", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/timeline-batch-window-harness.tsx";
    window.batchWindowHarness = (await import(path)).mountBatchWindowFixture("channel_root", true,
      { commandCount: 500, batchCommands: false });
  });
  try {
    await expect.poll(() => page.evaluate(() => window.batchWindowHarness.ready())).toBe(true);
    const root = page.locator("#batch-window-simulation");
    const timeline = root.locator('[data-conversation-timeline="true"]');
    await expect(timeline).toHaveAttribute("data-conversation-timeline-potential-row-count", "501");
    const header = root.locator(".conversation-timeline-sub-agent-head");
    await measureTranscriptDisclosure(page, header, info, { fixtureChildCount: 500, expectedRootVirtualizers: 1 });
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:500"))).toBe("revealed");
    await expect(root.locator('[data-feed-item-id="command:500"]')).toBeFocused();
    expect(await root.locator('[data-conversation-timeline-kind="commandExecution"]').count()).toBeLessThanOrEqual(48);
    expect(await page.evaluate(() => window.batchWindowHarness.reveal("command:1"))).toBe("revealed");
    await expect(root.locator('[data-feed-item-id="command:1"]')).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.batchWindowHarness.dispose());
  }
});
